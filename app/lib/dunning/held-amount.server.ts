import {
  estimateNextCharge,
  type EstimateContractLike,
} from "~/lib/billing/estimate.server";

/**
 * The money a held order is worth — ONE figure for every dunning surface
 * (v1.28.0 audit fix).
 *
 * `estimateNextCharge` is THE next-order estimate (Stage B): it applies the
 * live DiscountGrant / the parked `cycle_discount_applied` marker of the
 * failed cycle and the per-line "not this time" / one-order quantity edits.
 * The hero, the items card, the home card and the reminder all print its
 * total. Dunning used to price the held order from the mirror's plan sum
 * (Σ currentPriceCents × quantity + delivery — the mirror never carries the
 * grant, which lives on the Shopify billing-cycle draft), so a save-flow /
 * win-back discounted contract read "We couldn't take €49.00" in the banner
 * next to "Order total €44.10" in the items card, and every payment_failed_*
 * / parked email repeated the undiscounted figure. Dunning cohorts are
 * exactly the ones carrying save grants.
 *
 * Contained: any failure inside the estimate falls back to the plan sum —
 * the same arithmetic dunning used before — so a case always opens and an
 * email always has an amount. Never throws.
 */
export async function estimateHeldAmountCents(
  shop: { id: string; ianaTimezone: string } | string,
  contract: EstimateContractLike,
): Promise<number | null> {
  if (contract.lines.length === 0) return null;
  try {
    const est = await estimateNextCharge(shop, contract, {
      includeScheduledGifts: false,
    });
    if (Number.isFinite(est.totalCents)) return est.totalCents;
  } catch (err) {
    console.error("[dunning] held-amount estimate failed", contract.id, err);
  }
  return planSumCents(contract);
}

/** Σ currentPriceCents × quantity + delivery — the pre-estimate fallback. */
export function planSumCents(contract: {
  lines: Array<{ currentPriceCents: number; quantity: number; isGift?: boolean }>;
  deliveryPriceCents: number;
}): number | null {
  if (contract.lines.length === 0) return null;
  const lineSum = contract.lines.reduce(
    (sum, line) => sum + (line.isGift ? 0 : line.currentPriceCents * line.quantity),
    0,
  );
  return lineSum + contract.deliveryPriceCents;
}
