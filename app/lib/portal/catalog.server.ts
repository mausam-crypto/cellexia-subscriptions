import { z } from "zod";
import prisma from "~/db.server";
import { applyDiscountPct } from "~/lib/money";
import {
  type Frequency,
  contractFrequency,
  normalizeFrequencies,
  parseConfigFrequencies,
} from "~/lib/frequency";
import {
  getSubscribableProducts,
  searchProducts,
  type AdminClient,
} from "~/lib/graphql/index.server";

/**
 * Read-side product catalog for the portal: which products can be subscribed
 * to (attached to a selling plan group), their sellable variants + prices,
 * and the ongoing subscription discount each product carries.
 *
 * A small in-process TTL cache keeps portal page loads from hammering the
 * Admin API — this is display data; the contracts service re-validates every
 * variant at mutation time.
 */

const CACHE_TTL_MS = 5 * 60_000;

export interface CatalogVariant {
  id: string;
  title: string;
  priceCents: number;
  availableForSale: boolean;
}

export interface CatalogProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  variants: CatalogVariant[];
}

interface CacheEntry {
  at: number;
  data: CatalogProduct[];
}

const catalogCache = new Map<string, CacheEntry>();

/**
 * Subscribable products with their variants, cached ~5 minutes per shop.
 * Failures degrade to an empty catalog — the portal must render regardless.
 */
export async function getPortalCatalog(
  admin: AdminClient,
  shopId: string,
): Promise<CatalogProduct[]> {
  const cached = catalogCache.get(shopId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  try {
    const [subscribable, active] = await Promise.all([
      getSubscribableProducts(admin),
      // Variant detail (titles + prices) comes from the product search read;
      // intersecting with the selling-plan-group membership gives the catalog.
      searchProducts(admin, "status:active", 50),
    ]);

    const detailById = new Map(active.map((p) => [p.id, p]));
    const data: CatalogProduct[] = [];
    for (const product of subscribable) {
      const detail = detailById.get(product.id);
      if (!detail) continue;
      const variants = detail.variants
        .filter((v) => v.availableForSale)
        .map((v) => ({
          id: v.id,
          title: v.title,
          priceCents: v.priceCents,
          availableForSale: v.availableForSale,
        }));
      if (variants.length === 0) continue;
      data.push({
        id: product.id,
        title: product.title || detail.title,
        imageUrl: product.featuredImageUrl ?? detail.featuredImageUrl,
        variants,
      });
    }

    catalogCache.set(shopId, { at: Date.now(), data });
    return data;
  } catch (err) {
    console.error("[portal] catalog fetch failed", err);
    // Serve stale data over nothing, nothing over a crash.
    return cached?.data ?? [];
  }
}

/** Catalog entry for one product, or null when it is not subscribable. */
export function catalogProduct(
  catalog: CatalogProduct[],
  productId: string,
): CatalogProduct | null {
  return catalog.find((p) => p.id === productId) ?? null;
}

// ── Ongoing discount + frequency options (from SellingPlanConfig) ────────────

const productIdsSchema = z.array(z.string());

async function activeConfigs(shopId: string) {
  return prisma.sellingPlanConfig.findMany({
    where: { shopId, active: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Config covering a product (first active match), else any active config. */
async function configForProducts(shopId: string, productIds: string[]) {
  const configs = await activeConfigs(shopId);
  for (const config of configs) {
    const parsed = productIdsSchema.safeParse(config.productIds);
    if (parsed.success && productIds.some((id) => parsed.data.includes(id))) {
      return config;
    }
  }
  return configs[0] ?? null;
}

/**
 * Ongoing-discount percentages per product id for portal price display.
 * Products without an active covering config map to 0 (no discount shown).
 */
export async function ongoingDiscountPctByProduct(
  shopId: string,
  productIds: string[],
): Promise<Map<string, number>> {
  const configs = await activeConfigs(shopId);
  const out = new Map<string, number>();
  for (const productId of productIds) {
    let pct = 0;
    for (const config of configs) {
      const parsed = productIdsSchema.safeParse(config.productIds);
      if (parsed.success && parsed.data.includes(productId)) {
        pct = config.ongoingDiscountPct;
        break;
      }
    }
    out.set(productId, pct);
  }
  return out;
}

/** A catalog price at the product's ongoing subscription discount. */
export function discountedCents(priceCents: number, pct: number): number {
  return pct > 0 ? applyDiscountPct(priceCents, pct) : priceCents;
}

const FALLBACK_FREQUENCIES: Frequency[] = [4, 6, 8, 10, 12].map((count) => ({
  unit: "WEEK",
  count,
}));

/**
 * The frequency choices offered for a contract: from the covering
 * SellingPlanConfig (multi-unit, mixable — see app/lib/frequency.ts), always
 * including the contract's current cadence, shortest first. Falls back to a
 * sane week-only default set.
 */
export async function frequencyOptionsForContract(
  shopId: string,
  contract: {
    intervalWeeks: number;
    billingIntervalUnit?: string | null;
    billingIntervalCount?: number | null;
    lines: Array<{ productId: string }>;
  },
): Promise<{ options: Frequency[]; allowChoice: boolean }> {
  const config = await configForProducts(
    shopId,
    contract.lines.map((l) => l.productId),
  );

  let options: Frequency[] = FALLBACK_FREQUENCIES;
  let allowChoice = true;
  if (config) {
    const parsed = parseConfigFrequencies(config);
    if (parsed.length > 0) options = parsed;
    allowChoice = config.allowFrequencyChoice;
  }

  return {
    options: normalizeFrequencies([...options, contractFrequency(contract)]),
    allowChoice,
  };
}
