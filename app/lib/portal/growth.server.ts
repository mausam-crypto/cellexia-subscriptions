import prisma from "~/db.server";
import { addDaysTz, addIntervalTz } from "~/lib/dates.server";
import { approxWeeks, contractFrequency, type Frequency } from "~/lib/frequency";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getSetting } from "~/lib/settings/settings.server";

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
 * Deliveries remaining until the NEXT milestone gift — the goal-gradient
 * hook. Ladder-aware since v1.24.0: past the base milestone the countdown
 * re-anchors to the next ladder rung (12, 18, ...), so the hook never
 * exhausts while rungs remain. Null when the milestone system is off
 * (cycle <= 0) or every rung is behind the subscriber (matching the
 * lifecycle engine's fire condition on each rung).
 */
export function milestoneRemaining(
  ordersCount: number,
  milestoneGiftCycle: number,
  milestoneLadder: readonly number[] = [],
): number | null {
  if (milestoneGiftCycle <= 0) return null;
  const rungs = [...new Set([milestoneGiftCycle, ...milestoneLadder])].sort(
    (a, b) => a - b,
  );
  const next = rungs.find((c) => c > ordersCount);
  return next == null ? null : next - ordersCount;
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

// ── Rewards roadmap (v1.28.0, P4.3) ──────────────────────────────────────────

/** Contract fields the roadmap math reads (a LocalContract satisfies it). */
export interface RoadmapContract {
  id: string;
  ordersCount: number;
  nextBillingDate: Date | null;
  firstChargeAt: Date | null;
  createdAt: Date;
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
}

export type RoadmapGiftLabel =
  /** The exact product is committed (FIXED rule variant / scheduled grant). */
  | { kind: "named"; title: string }
  /** A gift will ship but the pick is dynamic — "a free product". */
  | { kind: "generic" }
  /** No gift is behind this rung — a milestone only, never a promise. */
  | { kind: "none" };

export interface RoadmapRow {
  kind: "surprise" | "milestone" | "rewards";
  /** Order number for milestone / surprise rows. */
  orderNumber: number | null;
  /** Reached already (✓) — the engine's own >= rules. */
  reached: boolean;
  /** Projected calendar moment ("around {date}"); null when unknowable. */
  aroundDate: Date | null;
  gift: RoadmapGiftLabel;
}

export interface RewardsRoadmap {
  rows: RoadmapRow[];
  /** Successful deliveries so far (local ordersCount — the billed truth). */
  deliveriesSoFar: number;
  /** Free gifts that actually shipped (SHIPPED, or the settlement stamp). */
  giftsReceived: number;
}

/**
 * The calendar moment order `orderNumber` is expected to bill: the SAME
 * schedule math the gift engine uses to date a rung (order-number space,
 * intervals from the next billing date, shop timezone). Null when the
 * contract has no next date or the order is already behind it.
 */
export function projectOrderDate(
  contract: RoadmapContract,
  orderNumber: number,
  tz: string,
): Date | null {
  if (!contract.nextBillingDate) return null;
  const upcoming = contract.ordersCount + 1;
  const delta = orderNumber - upcoming;
  if (delta < 0) return null;
  if (delta === 0) return contract.nextBillingDate;
  const freq = contractFrequency(contract);
  return addIntervalTz(contract.nextBillingDate, freq.unit, freq.count, tz, delta);
}

/**
 * Build the roadmap. Truth gates (load-bearing):
 *  - a gift is NAMED only when the pick is deterministic and committed: the
 *    base milestone's ORDER_INDEX rule is FIXED with a variant title, or a
 *    SCHEDULED/ADDED grant already sits on the upcoming cycle for that rung
 *    (title from its own scheduling event);
 *  - a ladder rung says "a free product" only when the engine can actually
 *    grant one (a non-empty gift pool, or the base rule as its fallback);
 *  - the day-N reward says "a free product" only with rewardsGiftEnabled;
 *  - the cycle-2 surprise appears ONLY when the teaser email was actually
 *    sent for this contract (`teaserPromised`) — holdout arms never got one,
 *    and even treatment arms are told nothing the teaser did not already say;
 *    a base rung ON order 2 (milestoneGiftCycle 2) is the same gift2 slice
 *    and follows the same rule (no teaser ⇒ no promise; never a duplicate
 *    row next to the surprise row);
 *  - REACHED rows are labelled from EVIDENCE of a grant, never from config:
 *    the day-N row from a source REWARDS GiftGrant, a milestone rung from
 *    its lifecycle.milestone_reached event's `giftGranted` (the engine's own
 *    truth gate for the milestone email) — a reached rung whose box carried
 *    no gift reads "reached" with no product, exactly like the email.
 * Every read is contained: a failed lookup degrades to the generic / none
 * label, never to a bolder promise.
 */
export async function buildRewardsRoadmap(input: {
  shopId: string;
  tz: string;
  contract: RoadmapContract;
  lifecycle: {
    milestoneGiftCycle: number;
    milestoneLadder: readonly number[];
    rewardsUnlockDay: number;
    rewardsGiftEnabled?: boolean;
  };
  now?: Date;
  /** gift_teaser SENT for cycle 2 (the caller checks the NotificationLog). */
  teaserPromised?: boolean;
  /** Shopify cycle index of the upcoming order, when the caller knows it. */
  upcomingCycleIndex?: number | null;
  /** lifecycle.rewards_unlocked already logged for this customer. */
  rewardsUnlockedEvent?: boolean;
}): Promise<RewardsRoadmap> {
  const { contract, lifecycle, tz } = input;
  const now = input.now ?? new Date();
  const rows: RoadmapRow[] = [];

  // Reads (each contained).
  let baseRule: { selection: string; variantTitle: string | null; variantId: string } | null = null;
  let poolSize = 0;
  let giftsReceived = 0;
  let scheduledTitle: string | null = null;
  let scheduledOnUpcoming = false;
  let rewardsGrant = false;
  /** ordersCount → giftGranted from lifecycle.milestone_reached (reached rungs). */
  const milestoneGranted = new Map<number, boolean>();
  try {
    baseRule = await prisma.giftRule.findFirst({
      where: {
        shopId: input.shopId,
        active: true,
        trigger: "ORDER_INDEX",
        orderIndex: lifecycle.milestoneGiftCycle,
      },
      select: { selection: true, variantTitle: true, variantId: true },
    });
  } catch (err) {
    console.error("[portal] roadmap: base milestone rule read failed", err);
  }
  try {
    const gifts = (await getSetting(input.shopId, "gifts")) as { pool?: unknown[] };
    poolSize = Array.isArray(gifts.pool) ? gifts.pool.length : 0;
  } catch (err) {
    console.error("[portal] roadmap: gifts settings read failed", err);
  }
  try {
    giftsReceived = await prisma.giftGrant.count({
      where: {
        contractId: contract.id,
        OR: [{ status: "SHIPPED" }, { shippedAt: { not: null } }],
      },
    });
  } catch (err) {
    console.error("[portal] roadmap: gift count failed", err);
  }
  try {
    const rewards = await prisma.giftGrant.findFirst({
      where: { contractId: contract.id, source: "REWARDS" },
      select: { id: true },
    });
    rewardsGrant = rewards != null;
  } catch (err) {
    console.error("[portal] roadmap: rewards grant read failed", err);
  }
  if (contract.ordersCount > 0) {
    try {
      const events = await prisma.subscriberEvent.findMany({
        where: { contractId: contract.id, type: "lifecycle.milestone_reached" },
        select: { payload: true },
      });
      for (const ev of events) {
        const p = ev.payload as { ordersCount?: unknown; giftGranted?: unknown } | null;
        const n = typeof p?.ordersCount === "number" ? p.ordersCount : null;
        if (n != null && !milestoneGranted.get(n)) {
          milestoneGranted.set(n, p?.giftGranted === true);
        }
      }
    } catch (err) {
      console.error("[portal] roadmap: milestone events read failed", err);
    }
  }
  if (input.upcomingCycleIndex != null) {
    try {
      const grant = await prisma.giftGrant.findFirst({
        where: {
          contractId: contract.id,
          cycleIndex: input.upcomingCycleIndex,
          status: { in: ["SCHEDULED", "ADDED"] },
          source: { in: ["RULE", "LADDER"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (grant) {
        scheduledOnUpcoming = true;
        const ev = await prisma.subscriberEvent.findFirst({
          where: {
            contractId: contract.id,
            type: "lifecycle.gift_scheduled",
            payload: { path: ["grantId"], equals: grant.id },
          },
          select: { payload: true },
        });
        const title = (ev?.payload as { variantTitle?: unknown } | null)?.variantTitle;
        scheduledTitle = typeof title === "string" && title.trim() ? title.trim() : null;
      }
    } catch (err) {
      console.error("[portal] roadmap: scheduled grant read failed", err);
    }
  }

  // Cycle-2 surprise — only what the teaser already promised.
  const surpriseRow = input.teaserPromised === true && contract.ordersCount < 2;
  if (surpriseRow) {
    rows.push({
      kind: "surprise",
      orderNumber: 2,
      reached: false,
      aroundDate: projectOrderDate(contract, 2, tz),
      gift: { kind: "generic" },
    });
  }

  // Milestone rungs — the base cycle + every ladder rung, ascending.
  const rungs = [...new Set([lifecycle.milestoneGiftCycle, ...lifecycle.milestoneLadder])]
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const upcomingOrder = contract.ordersCount + 1;
  for (const rung of rungs) {
    const isBase = rung === lifecycle.milestoneGiftCycle;
    const reached = contract.ordersCount >= rung;
    // Order 2 is the gift2 experiment's slice: the surprise row (teaser
    // gated) already covers it; without a teaser nothing is promised.
    if (rung === 2 && !reached) {
      if (surpriseRow) continue;
      rows.push({
        kind: "milestone",
        orderNumber: rung,
        reached: false,
        aroundDate: projectOrderDate(contract, rung, tz),
        gift: { kind: "none" },
      });
      continue;
    }
    let gift: RoadmapGiftLabel;
    if (reached) {
      // Evidence only: the engine's milestone event says whether a gift rode
      // along. No event / no grant ⇒ no product claim.
      gift = milestoneGranted.get(rung) === true ? { kind: "generic" } : { kind: "none" };
    } else if (rung === upcomingOrder && scheduledOnUpcoming) {
      gift = scheduledTitle ? { kind: "named", title: scheduledTitle } : { kind: "generic" };
    } else if (isBase) {
      gift = !baseRule
        ? { kind: "none" }
        : baseRule.selection === "FIXED" && baseRule.variantTitle
          ? { kind: "named", title: baseRule.variantTitle }
          : { kind: "generic" };
    } else {
      gift = poolSize > 0 || baseRule ? { kind: "generic" } : { kind: "none" };
    }
    rows.push({
      kind: "milestone",
      orderNumber: rung,
      reached,
      aroundDate: reached ? null : projectOrderDate(contract, rung, tz),
      gift,
    });
  }

  // Day-N rewards unlock.
  const start = contract.firstChargeAt ?? contract.createdAt;
  const unlockAt = addDaysTz(start, lifecycle.rewardsUnlockDay, tz);
  const unlocked = input.rewardsUnlockedEvent === true || unlockAt.getTime() <= now.getTime();
  rows.push({
    kind: "rewards",
    orderNumber: null,
    reached: unlocked,
    aroundDate: unlocked ? null : unlockAt,
    // Reached: only an actual REWARDS grant is a gift (the sweep is
    // best-effort — empty pool / no admin client ⇒ no grant, and the email
    // already omitted the product line). Ahead: the config prediction.
    gift: unlocked
      ? rewardsGrant
        ? { kind: "generic" }
        : { kind: "none" }
      : lifecycle.rewardsGiftEnabled !== false
        ? { kind: "generic" }
        : { kind: "none" },
  });

  return {
    rows: sortRoadmapRows(rows),
    deliveriesSoFar: Math.max(0, contract.ordersCount),
    giftsReceived,
  };
}

/**
 * Chronological order (v1.29.0): reached rows first (their build order kept —
 * they no longer carry a date), then every upcoming row by its projected
 * `aroundDate` ascending, undated rows last. Stable, so the day-N reward
 * lands between the milestone rungs it actually falls between instead of
 * always trailing the 2029 rungs. Pure — exported for the pinning test.
 */
export function sortRoadmapRows(rows: RoadmapRow[]): RoadmapRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (a.row.reached !== b.row.reached) return a.row.reached ? -1 : 1;
      const at = a.row.aroundDate?.getTime() ?? Number.POSITIVE_INFINITY;
      const bt = b.row.aroundDate?.getTime() ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at < bt ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Was the cycle-2 teaser actually SENT for this contract? The only source
 * of a "surprise" row (holdout arms never receive one). Contained.
 */
export async function teaserPromisedFor(contractId: string): Promise<boolean> {
  try {
    const row = await prisma.notificationLog.findFirst({
      where: {
        contractId,
        template: "gift_teaser",
        status: "SENT",
        payload: { path: ["cycleIndex"], equals: 2 },
      },
      select: { id: true },
    });
    return row != null;
  } catch (err) {
    console.error("[portal] roadmap: teaser lookup failed", contractId, err);
    return false;
  }
}
