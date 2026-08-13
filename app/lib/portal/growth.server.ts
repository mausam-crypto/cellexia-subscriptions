import prisma from "~/db.server";
import { approxWeeks, type Frequency } from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Portal growth helpers (v1.20.0, `portalGrowth` settings group — every
 * consumer is merchant-toggleable, ON by default).
 *
 * The behavioral system these power (see the v1.20.0 CHANGELOG entry):
 * value-first home cards (endowment), a concession ladder at skip intent
 * (delay > slower cadence > skip — each step cheaper than the next, cancel
 * never the only alternative), momentum upsells after positive actions, and
 * two truthful nudges (repeated skips → cadence fix; predicted runout →
 * move up / add one). HONESTY RULES ARE LOAD-BEARING: every number shown to
 * a customer is computed from real captured data (money-true discounts,
 * real add-on counts, the churn model's own predicted-empty date) and every
 * reducing action stays reachable — these helpers must never fabricate a
 * claim, and copy consuming them must never hide skip or cancel.
 */

/** Toast keys after which the momentum upsell may render — POSITIVE moments
 * only. Never after a skip/delay (tone-deaf) or an add (already added). */
export const MOMENTUM_TOAST_KEYS: ReadonlySet<string> = new Set([
  "unskipped",
  "resumed",
  "address_updated",
]);

/**
 * Money the customer has verifiably NOT paid as a member: the money-true
 * discount captured on every successful renewal (BillingAttempt.discountCents,
 * settlement-frozen since migration 0016) plus the mirrored origin-order
 * discount. Pre-0016 attempts carry null and simply contribute nothing —
 * the figure may UNDER-state savings, never overstate them (the honest
 * direction for an endowment claim). Returns 0 when nothing is captured;
 * callers hide the tile rather than show "CHF 0".
 */
export async function memberSavingsCents(
  contractIds: readonly string[],
): Promise<Map<string, number>> {
  if (contractIds.length === 0) return new Map();
  const [attempts, contracts] = await Promise.all([
    prisma.billingAttempt.groupBy({
      by: ["contractId"],
      where: {
        contractId: { in: [...contractIds] },
        status: "SUCCESS",
        discountCents: { gt: 0 },
      },
      _sum: { discountCents: true },
    }),
    prisma.subscriptionContract.findMany({
      where: { id: { in: [...contractIds] } },
      select: { id: true, originOrderDiscountCents: true },
    }),
  ]);
  const savings = new Map<string, number>();
  for (const row of attempts) {
    savings.set(row.contractId, row._sum.discountCents ?? 0);
  }
  for (const contract of contracts) {
    const origin = Math.max(0, contract.originOrderDiscountCents ?? 0);
    if (origin > 0) {
      savings.set(contract.id, (savings.get(contract.id) ?? 0) + origin);
    }
  }
  return savings;
}

/**
 * Deliveries remaining until the milestone gift — the goal-gradient hook.
 * Null when the milestone system is off (cycle <= 0) or already reached
 * (>=, matching the lifecycle engine's fire condition).
 */
export function milestoneRemaining(
  ordersCount: number,
  milestoneGiftCycle: number,
): number | null {
  if (milestoneGiftCycle <= 0) return null;
  if (ordersCount >= milestoneGiftCycle) return null;
  return milestoneGiftCycle - ordersCount;
}

/**
 * The next SLOWER cadence than the current one, from the plan's offered
 * list — the concession ladder's middle option. "Slower" = strictly more
 * approx-weeks; the closest such option wins (an 8-week subscriber offered
 * 12 weeks feels pushed; offered 10 feels helped). Null when the plan
 * offers nothing slower — the ladder then simply omits the row.
 */
export function nextSlowerFrequency(
  offered: readonly Frequency[],
  current: Frequency,
): Frequency | null {
  const currentWeeks = approxWeeks(current.unit, current.count);
  let best: Frequency | null = null;
  let bestWeeks = Number.POSITIVE_INFINITY;
  for (const option of offered) {
    const weeks = approxWeeks(option.unit, option.count);
    if (weeks > currentWeeks && weeks < bestWeeks) {
      best = option;
      bestWeeks = weeks;
    }
  }
  return best;
}

/**
 * Whether the churn model predicts the customer runs OUT before the next
 * delivery arrives — the inverse of the standing "running low later? push
 * it back" prompt. True only when the gap is at least `bufferDays` (a
 * one-day overlap is noise, not a stockout at home) and the predicted
 * empty date is still ahead of `now` (an already-passed prediction reads
 * stale, not urgent).
 */
export function runsOutBeforeNextDelivery(
  predictedEmptyDate: Date | null,
  nextBillingDate: Date | null,
  now: Date,
  bufferDays = 2,
): boolean {
  if (!predictedEmptyDate || !nextBillingDate) return false;
  if (predictedEmptyDate.getTime() <= now.getTime()) return false;
  return (
    nextBillingDate.getTime() - predictedEmptyDate.getTime() >=
    bufferDays * 86_400_000
  );
}

/**
 * Skips recorded for a contract in the trailing window — the repeated-skip
 * signal behind the cadence nudge. Two skips in ~four months is a cadence
 * mismatch, not two coincidences.
 */
export async function recentSkipCount(
  contractId: string,
  now: Date,
  windowDays = 120,
): Promise<number> {
  return prisma.subscriberEvent.count({
    where: {
      contractId,
      type: "cycle.skipped",
      createdAt: { gte: new Date(now.getTime() - windowDays * 86_400_000) },
    },
  });
}

/**
 * Product ids that have genuinely been added as add-ons often enough to
 * carry a truthful "popular add-on" badge (social proof needs real proof):
 * counts REAL cycle.addon_added events over the trailing window, maps
 * variants to catalog products, and returns only products at/over the
 * threshold. An empty result means no badge anywhere — never a fabricated
 * one. Failure-contained: social proof is decoration, not plumbing.
 */
export async function popularAddonProductIds(
  shopId: string,
  variantToProduct: ReadonlyMap<string, string>,
  opts: { now?: Date; windowDays?: number; threshold?: number } = {},
): Promise<Set<string>> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 180;
  const threshold = opts.threshold ?? 3;
  try {
    const events = await prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: "cycle.addon_added",
        createdAt: { gte: new Date(now.getTime() - windowDays * 86_400_000) },
        // Demo fixtures and another app's contracts must not vote.
        contract: {
          is: { isDemo: false, ...OURS_ONLY },
        },
      },
      select: { payload: true },
      take: 1000,
    });
    const byProduct = new Map<string, number>();
    for (const event of events) {
      const variantId = (event.payload as { variantId?: unknown } | null)
        ?.variantId;
      if (typeof variantId !== "string") continue;
      const productId = variantToProduct.get(variantId);
      if (!productId) continue;
      byProduct.set(productId, (byProduct.get(productId) ?? 0) + 1);
    }
    const popular = new Set<string>();
    for (const [productId, count] of byProduct) {
      if (count >= threshold) popular.add(productId);
    }
    return popular;
  } catch (err) {
    console.error("[portal] popular add-on scan failed", err);
    return new Set();
  }
}
