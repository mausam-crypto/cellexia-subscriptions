import type { ContractLine } from "@prisma/client";
import { getSetting } from "~/lib/settings/settings.server";
import { ongoingDiscountPctForProduct } from "~/lib/contracts/shared.server";

/**
 * Discount-stacking enforcement — settings.discountStacking.maxTotalDiscountPct.
 *
 * A subscriber's total recurring discount is the plan's baked-in ongoing
 * discount (SellingPlanConfig.ongoingDiscountPct) plus at most ONE live
 * DiscountGrant (grants never stack with each other — best-of selection in
 * app/lib/billing/discounts.server.ts). This module enforces the cap on that
 * SUM at grant-creation time:
 *
 *  - `applyDiscountGrant` (app/lib/contracts/service.server.ts) clamps every
 *    new grant to the headroom left under the cap — the single hard gate no
 *    grant can bypass;
 *  - the cancel + win-back engines run the same clamp when BUILDING offers,
 *    so a customer is never shown a percent the cap would then reduce.
 *
 * The pure math lives in `clampGrantPercent` (unit-tested without a DB in
 * tests/discount-stacking.test.ts); `clampGrantPercentForContract` resolves
 * the setting + the contract's plan discount and applies it.
 */

export interface StackingClamp {
  /** The grant percent actually allowed (0 when there is no headroom). */
  percent: number;
  /** What was asked for, normalized to a non-negative integer. */
  requestedPercent: number;
  /** True when the cap reduced the requested percent. */
  clamped: boolean;
  /** Plan ongoing discount pct the contract already enjoys. */
  ongoingDiscountPct: number;
  /** The configured cap (settings.discountStacking.maxTotalDiscountPct). */
  maxTotalDiscountPct: number;
  /** Room left under the cap: max(0, maxTotalDiscountPct - ongoingDiscountPct). */
  headroomPct: number;
}

/** The line fields needed to resolve a contract's plan ongoing discount. */
export type StackableLine = Pick<ContractLine, "productId" | "isGift">;

/** Percents are integers 0–100 everywhere; junk input degrades to 0, not NaN. */
function normalizePct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.floor(value)));
}

/**
 * Pure clamp: the largest grant percent such that
 * `ongoingDiscountPct + percent <= maxTotalDiscountPct`.
 */
export function clampGrantPercent(
  requestedPercent: number,
  ongoingDiscountPct: number,
  maxTotalDiscountPct: number,
): StackingClamp {
  const requested = normalizePct(requestedPercent);
  const ongoing = normalizePct(ongoingDiscountPct);
  const cap = normalizePct(maxTotalDiscountPct);
  const headroomPct = Math.max(0, cap - ongoing);
  const percent = Math.min(requested, headroomPct);
  return {
    percent,
    requestedPercent: requested,
    clamped: percent < requested,
    ongoingDiscountPct: ongoing,
    maxTotalDiscountPct: cap,
    headroomPct,
  };
}

/**
 * The plan ongoing discount pct a contract already enjoys: the highest
 * SellingPlanConfig.ongoingDiscountPct across its non-gift lines' products
 * (the deepest baked-in discount determines how much room the cap leaves).
 * 0 when no active config covers any line.
 */
export async function contractOngoingDiscountPct(
  shopId: string,
  lines: StackableLine[],
): Promise<number> {
  const productIds = [
    ...new Set(
      lines.filter((l) => !l.isGift && l.productId).map((l) => l.productId),
    ),
  ];
  let max = 0;
  for (const productId of productIds) {
    const pct = await ongoingDiscountPctForProduct(shopId, productId);
    if (pct != null && pct > max) max = pct;
  }
  return max;
}

/**
 * Clamp a requested grant percent for a specific contract against
 * settings.discountStacking.maxTotalDiscountPct. Reads the setting fresh on
 * every call (a policy decision, never cached — golden rule 7).
 */
export async function clampGrantPercentForContract(
  shopId: string,
  lines: StackableLine[],
  requestedPercent: number,
): Promise<StackingClamp> {
  const stacking = await getSetting(shopId, "discountStacking");
  const ongoing = await contractOngoingDiscountPct(shopId, lines);
  return clampGrantPercent(
    requestedPercent,
    ongoing,
    stacking.maxTotalDiscountPct,
  );
}
