import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { COUNTABLE_CONTRACT } from "./queries.server";

/**
 * The analytics cost model — the ONE place per-line COGS, per-shipment
 * fulfillment/shipping cost and payment fees are resolved.
 *
 * Both gross-profit surfaces (DailyRollup.estGrossProfitCents and
 * CohortCell.grossProfitCents) consume these helpers, so the two can never
 * disagree by construction again. The shared formula is:
 *
 *   gross profit = revenue collected (net of refunds)
 *                − COGS (resolved per line, see resolveLineCogs)
 *                − fulfillment + shipping cost per shipment
 *                − payment processing fees per charge
 *
 * COGS resolution order per billed line (first known value wins):
 *   1. ContractLine.unitCostCents        — synced from Shopify inventoryItem cost
 *   2. ProductCadence.unitCostCentsOverride — merchant-entered override
 *      (variant-level row first, then the product-level row)
 *   3. costModel.cogsFallbackPctOfPrice × line price — ESTIMATED; every use is
 *      counted (estimatedCogsCents) so coverage can be reported honestly.
 *
 * Settings live under the "costModel" key (app/lib/settings/registry.server.ts)
 * and are edited on the Settings page ("Costs & profit" section); per-product
 * overrides are edited on the Plans page ("Costs & margins" section).
 */

export type CostModelSettings = SettingsValue<"costModel">;

/** How a line's COGS value was obtained. */
export type CogsSource = "SHOPIFY" | "OVERRIDE" | "ESTIMATED";

/** Line shape the cost resolution needs (subset of ContractLine). */
export interface LineForCogs {
  productId: string;
  variantId: string;
  quantity: number;
  currentPriceCents: number;
  unitCostCents: number | null;
  isGift: boolean;
}

/** Merchant COGS overrides, pre-indexed for O(1) per-line lookup. */
export interface CogsOverrides {
  /** `${productId}|${variantId}` → cents (variant-level rows). */
  byVariant: ReadonlyMap<string, number>;
  /** productId → cents (product-level rows, variantId null). */
  byProduct: ReadonlyMap<string, number>;
}

/** Everything cost resolution needs, loaded once per computation run. */
export interface CostContext {
  costModel: CostModelSettings;
  overrides: CogsOverrides;
}

export const EMPTY_OVERRIDES: CogsOverrides = {
  byVariant: new Map(),
  byProduct: new Map(),
};

/** Load the cost model + per-product overrides for a shop (one settings read + one query). */
export async function loadCostContext(shopId: string): Promise<CostContext> {
  const [costModel, overrideRows] = await Promise.all([
    getSetting(shopId, "costModel"),
    prisma.productCadence.findMany({
      where: { shopId, unitCostCentsOverride: { not: null } },
      select: { productId: true, variantId: true, unitCostCentsOverride: true },
    }),
  ]);

  const byVariant = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const row of overrideRows) {
    if (row.unitCostCentsOverride == null) continue;
    if (row.variantId) {
      byVariant.set(`${row.productId}|${row.variantId}`, row.unitCostCentsOverride);
    } else {
      byProduct.set(row.productId, row.unitCostCentsOverride);
    }
  }
  return { costModel, overrides: { byVariant, byProduct } };
}

export interface ResolvedLineCogs {
  /** Per-UNIT cost in cents (multiply by quantity for the line total). */
  unitCostCents: number;
  source: CogsSource;
  /** True when the value came from the percentage-of-price fallback. */
  estimated: boolean;
}

/**
 * Resolve one line's per-unit COGS: synced Shopify cost → merchant override
 * (variant row, then product row) → percentage-of-price estimate.
 *
 * Exported for tests — this is the resolution order the whole analytics
 * module depends on.
 */
export function resolveLineCogs(
  line: Pick<LineForCogs, "productId" | "variantId" | "currentPriceCents" | "unitCostCents">,
  ctx: CostContext,
): ResolvedLineCogs {
  if (line.unitCostCents != null) {
    return { unitCostCents: line.unitCostCents, source: "SHOPIFY", estimated: false };
  }
  const override =
    ctx.overrides.byVariant.get(`${line.productId}|${line.variantId}`) ??
    ctx.overrides.byProduct.get(line.productId);
  if (override != null) {
    return { unitCostCents: override, source: "OVERRIDE", estimated: false };
  }
  return {
    unitCostCents: Math.round(
      (line.currentPriceCents * ctx.costModel.cogsFallbackPctOfPrice) / 100,
    ),
    source: "ESTIMATED",
    estimated: true,
  };
}

export interface PerCycleCosts {
  /** Total COGS of the cycle's lines (known + estimated), in cents. */
  cogsCents: number;
  /** Portion of cogsCents that came from the percentage fallback. */
  estimatedCogsCents: number;
  /** Lines whose COGS had to be estimated (no Shopify cost, no override). */
  linesEstimated: number;
}

/**
 * COGS for one billed cycle, resolved per line through resolveLineCogs.
 * `includeGifts: false` excludes gift lines so callers that account gift COGS
 * separately (via GiftGrant → GiftRule.unitCostCents) do not double count.
 *
 * Note: a zero-priced gift line under the fallback estimates 0 anyway, but the
 * exclusion keeps the accounting explicit.
 */
export function perCycleLineCosts(
  lines: LineForCogs[],
  ctx: CostContext,
  opts: { includeGifts: boolean },
): PerCycleCosts {
  let cogsCents = 0;
  let estimatedCogsCents = 0;
  let linesEstimated = 0;
  for (const line of lines) {
    if (line.isGift && !opts.includeGifts) continue;
    const resolved = resolveLineCogs(line, ctx);
    const lineTotal = resolved.unitCostCents * line.quantity;
    cogsCents += lineTotal;
    if (resolved.estimated) {
      estimatedCogsCents += lineTotal;
      linesEstimated += 1;
    }
  }
  return { cogsCents, estimatedCogsCents, linesEstimated };
}

/** Payment processing fee for one successful charge, per the cost model. */
export function paymentFeeCents(
  amountCents: number,
  costModel: CostModelSettings,
): number {
  if (amountCents <= 0) return 0;
  return (
    Math.round((amountCents * costModel.paymentFeePct) / 100) +
    costModel.paymentFeeFixedCents
  );
}

/**
 * Fulfillment + shipping cost the MERCHANT pays for one shipment.
 *
 * `deliveryChargedCents` is what the customer paid for delivery on that
 * contract — used only in "charged" mode (cost ≈ pass-through). It is NEVER
 * subtracted from revenue elsewhere: customer-paid delivery is already inside
 * the charged amount, i.e. it is revenue, not a cost.
 */
export function perShipmentCostCents(
  costModel: CostModelSettings,
  deliveryChargedCents: number,
): number {
  const shipping =
    costModel.shippingCostPerShipmentCents.mode === "charged"
      ? Math.max(0, deliveryChargedCents)
      : costModel.shippingCostPerShipmentCents.flatCents;
  return costModel.fulfillmentCostPerShipmentCents + shipping;
}

// ── Coverage reporting ────────────────────────────────────────────────────────

export interface CostCoverageProduct {
  productId: string;
  variantId: string;
  title: string;
}

export interface CostCoverage {
  /** Non-gift lines on countable contracts with a known (non-estimated) COGS, ÷ all such lines, ×100. */
  linesWithKnownCogsPct: number;
  /** Same but weighted by line revenue (price × quantity), ×100. */
  revenueWithKnownCogsPct: number;
  /** Distinct products/variants currently billed with NO known cost — set them on the Plans page. */
  productsMissingCogs: CostCoverageProduct[];
  /** Denominator context: how many non-gift lines were examined. */
  totalLines: number;
  // ── Presentation conveniences (derived from the fields above) ──────────────
  /** Lines whose COGS had to be estimated (totalLines − known lines). */
  linesMissingCost: number;
  /** Alias of linesWithKnownCogsPct (0–100) for banner copy. */
  coveragePct: number;
  /** productsMissingCogs.length — how many products need a cost set. */
  productsMissingCost: number;
  /** First few missing-product titles for banner copy. */
  sampleProductTitles: string[];
}

/**
 * How much of the currently-billed book has a KNOWN cost (Shopify inventory
 * cost or merchant override) versus the percentage estimate. Powers the
 * "LTGP is partly estimated" banner on the analytics page and the coverage
 * badges on the Plans page.
 *
 * Scope: lines of ACTIVE + PAUSED countable contracts (ours, non-demo) — the
 * book whose future LTGP the merchant is pricing decisions against.
 */
export async function getCostCoverage(shopId: string): Promise<CostCoverage> {
  const [ctx, contracts] = await Promise.all([
    loadCostContext(shopId),
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        status: { in: ["ACTIVE", "PAUSED"] },
        ...COUNTABLE_CONTRACT,
      },
      select: {
        lines: {
          select: {
            productId: true,
            variantId: true,
            title: true,
            quantity: true,
            currentPriceCents: true,
            unitCostCents: true,
            isGift: true,
          },
        },
      },
    }),
  ]);

  let totalLines = 0;
  let knownLines = 0;
  let totalRevenue = 0;
  let knownRevenue = 0;
  const missing = new Map<string, CostCoverageProduct>();

  for (const contract of contracts) {
    for (const line of contract.lines) {
      if (line.isGift) continue;
      totalLines += 1;
      const lineRevenue = line.currentPriceCents * line.quantity;
      totalRevenue += lineRevenue;
      const resolved = resolveLineCogs(line, ctx);
      if (resolved.estimated) {
        const key = `${line.productId}|${line.variantId}`;
        if (!missing.has(key)) {
          missing.set(key, {
            productId: line.productId,
            variantId: line.variantId,
            title: line.title,
          });
        }
      } else {
        knownLines += 1;
        knownRevenue += lineRevenue;
      }
    }
  }

  const pct = (num: number, den: number): number =>
    den > 0 ? Math.round((num / den) * 1000) / 10 : 100;

  const productsMissingCogs = [...missing.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const linesWithKnownCogsPct = pct(knownLines, totalLines);

  return {
    linesWithKnownCogsPct,
    revenueWithKnownCogsPct: pct(knownRevenue, totalRevenue),
    productsMissingCogs,
    totalLines,
    linesMissingCost: totalLines - knownLines,
    coveragePct: linesWithKnownCogsPct,
    productsMissingCost: productsMissingCogs.length,
    sampleProductTitles: productsMissingCogs.slice(0, 5).map((p) => p.title),
  };
}
