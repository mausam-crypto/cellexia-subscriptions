/**
 * Offer eligibility — which products may join a Continuous Treatment Plan,
 * and which cart lines widget F (cart conversion) may offer to convert.
 *
 * Reads ProductMeta (per-product subscribability flags) and SellingPlanConfig
 * (a shop needs at least one active plan config for any treatment offer to be
 * purchasable).
 */
import prisma from "~/db.server";
import { normalizeProductId } from "~/services/offers/widgets.server";

export interface CartLineInput {
  productId: string;
  variantId?: string;
  quantity: number;
  /** Present when the line is already on a selling plan. */
  sellingPlanId?: string | null;
}

export interface CartConversionEligibility {
  eligible: boolean;
  /** Product ids (as supplied) of one-time lines that can be converted. */
  convertibleProductIds: string[];
}

/** True when the shop has at least one active selling plan configuration. */
async function shopHasActivePlanConfig(shop: string): Promise<boolean> {
  const config = await prisma.sellingPlanConfig.findFirst({
    where: { shop, active: true },
    select: { id: true },
  });
  return config !== null;
}

/**
 * A product is subscribable when its ProductMeta row exists, is active and
 * flagged subscribable, AND the shop has an active SellingPlanConfig.
 * Unknown products (no ProductMeta row yet) are treated as NOT subscribable —
 * safe default until the product sync has run.
 */
export async function isProductSubscribable(
  shop: string,
  productId: string,
): Promise<boolean> {
  const tail = normalizeProductId(productId);
  const meta = await prisma.productMeta.findFirst({
    where: {
      shop,
      OR: [
        { shopifyProductId: productId },
        { shopifyProductId: `gid://shopify/Product/${tail}` },
        { shopifyProductId: tail },
      ],
    },
    select: { subscribable: true, active: true },
  });
  if (!meta || !meta.active || !meta.subscribable) return false;
  return shopHasActivePlanConfig(shop);
}

/**
 * Cart-conversion (widget F) eligibility: at least one line without a selling
 * plan whose product is subscribable.
 */
export async function eligibleForCartConversion(
  shop: string,
  lineItems: CartLineInput[],
): Promise<CartConversionEligibility> {
  const oneTimeLines = lineItems.filter((line) => !line.sellingPlanId);
  if (oneTimeLines.length === 0) {
    return { eligible: false, convertibleProductIds: [] };
  }
  if (!(await shopHasActivePlanConfig(shop))) {
    return { eligible: false, convertibleProductIds: [] };
  }

  // Deduplicate products before hitting the database.
  const byNormalized = new Map<string, string>();
  for (const line of oneTimeLines) {
    const key = normalizeProductId(line.productId);
    if (!byNormalized.has(key)) byNormalized.set(key, line.productId);
  }

  const convertible: string[] = [];
  for (const [, originalId] of byNormalized) {
    if (await isProductSubscribable(shop, originalId)) {
      convertible.push(originalId);
    }
  }
  return { eligible: convertible.length > 0, convertibleProductIds: convertible };
}
