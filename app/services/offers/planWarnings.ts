/**
 * Pure plan-configuration guards shared by the admin plans route and unit
 * tests. No Prisma/Shopify imports — safe to load in vitest and on any surface.
 */

/** Structural plan entry from SellingPlanConfig.plansJson. */
export interface PlanWarningInput {
  name: string;
  intervalWeeks: number;
  percentOff: number;
  /** Committed Treatment Plan: minimum deliveries (meaningful when >= 2). */
  minDeliveries?: number;
  /** Committed Treatment Plan marker. */
  committed?: boolean;
}

/**
 * PURE — a plan entry belongs to the committed track when it is explicitly
 * marked committed or carries a meaningful minimum-deliveries commitment.
 */
export function isCommittedPlan(plan: PlanWarningInput): boolean {
  return (
    plan.committed === true ||
    (typeof plan.minDeliveries === "number" && plan.minDeliveries >= 2)
  );
}

/**
 * PURE — misconfiguration guard: a longer interval must never carry a smaller
 * discount. Widget B maps higher quantities to longer cadences, so a weaker
 * discount on a longer interval silently charges MORE per unit to customers
 * who commit to more product. Returns a warning message, or null when sane.
 *
 * The check runs SEPARATELY for the committed track and the standard track:
 * committed plans legitimately discount more than standard plans at the same
 * interval (that extra discount is the price of the commitment), so
 * monotonicity is only meaningful within each track.
 */
export function discountMonotonicityWarning(
  plans: PlanWarningInput[],
): string | null {
  const tracks: PlanWarningInput[][] = [
    plans.filter((p) => !isCommittedPlan(p)),
    plans.filter((p) => isCommittedPlan(p)),
  ];
  for (const track of tracks) {
    const sorted = [...track].sort((a, b) => a.intervalWeeks - b.intervalWeeks);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].percentOff < sorted[i - 1].percentOff) {
        return (
          `"${sorted[i].name}" (every ${sorted[i].intervalWeeks} weeks, ` +
          `${sorted[i].percentOff}% off) discounts less than ` +
          `"${sorted[i - 1].name}" (every ${sorted[i - 1].intervalWeeks} weeks, ` +
          `${sorted[i - 1].percentOff}% off). Widget B maps larger quantities ` +
          `to longer cadences, so customers choosing more units would pay more ` +
          `per unit. Keep discounts equal or increasing with interval length.`
        );
      }
    }
  }
  return null;
}
