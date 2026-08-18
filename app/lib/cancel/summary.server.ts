import type { Shop } from "@prisma/client";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { contractFrequency } from "~/lib/frequency";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import {
  memberSavingsCents,
  milestoneRemaining,
  projectOrderDate,
} from "~/lib/portal/growth.server";
import { getActiveDiscountForCycle } from "~/lib/billing/discounts.server";
import { loadParkedCycleDiscount } from "~/lib/billing/estimate.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";

/**
 * Loss-aversion summary for step 1 ("before you go") and the confirm page.
 *
 * Psychology: people weigh losses ~2x heavier than equivalent gains, so the
 * intro page frames the subscription as things the customer ALREADY OWNS and
 * would lose — the subscriber price (a concrete £/year number), progress
 * toward the NEXT milestone gift, unlocked rewards, and tenure. Every number
 * is computed from real contract data; nothing is invented, which is both
 * more persuasive and a compliance requirement (no fabricated claims).
 *
 * Money-true & ladder-aware (v1.28.0):
 * - the milestone countdown uses the SAME `milestoneRemaining` the portal
 *   rewards strip uses (lifecycle.milestoneGiftCycle + milestoneLadder), so
 *   past the base rung it re-anchors to the next rung instead of repeating a
 *   stale "milestone (order 6)" line; null when every rung is behind them;
 * - `memberSavingsCents` is the captured figure the portal value tiles show
 *   (settlement-frozen BillingAttempt.discountCents + origin-order discount);
 * - the live DiscountGrant (cycles left) and shipped gifts are read from the
 *   rows themselves; a grandfathered contract surfaces its locked price.
 * Every extra read is contained (a failed read hides that line, never the
 * page) and every consumer hides zero/unknown values — nothing shown that the
 * data does not prove.
 *
 * A line only counts toward `perCycleSavingsCents` when Shopify gives us a
 * compare-at price higher than the subscriber price; gift and one-time lines
 * never count.
 */

export interface RetentionSummary {
  currencyCode: string;
  /** What the subscriber price saves vs one-time prices, per delivery. */
  perCycleSavingsCents: number;
  /** The per-delivery saving annualized over the contract's exact cadence
   * (WEEK 52/count, MONTH 12/count, DAY 365.25/count cycles per year). */
  annualSavingsCents: number;
  daysSubscribed: number;
  ordersCount: number;
  /** settings.lifecycle.milestoneGiftCycle — the BASE rung (kept for
   * existing consumers; the copy uses nextMilestoneCycle). */
  milestoneCycle: number;
  /** The next milestone rung ahead of the subscriber (base or ladder), null
   * when the milestone system is off or every rung is behind them. */
  nextMilestoneCycle: number | null;
  /** Orders still needed to reach `nextMilestoneCycle`; 0 = none ahead. */
  ordersToMilestone: number;
  /**
   * Projected calendar moment `nextMilestoneCycle` bills (v1.28.0, P4.3 —
   * the rewards roadmap's schedule math); null when unknowable / none ahead.
   */
  nextMilestoneAt: Date | null;
  rewardsUnlocked: boolean;
  rewardsUnlockDay: number;
  /** Days until rewards unlock; 0 when already unlocked. */
  daysToRewards: number;
  /**
   * The date a "your next delivery is scheduled for {date}" line may name:
   * the mirror's nextBillingDate ONLY for an ACTIVE contract with no open
   * dunning case. A PAUSED contract keeps a stale (often past) nextBillingDate
   * — its paused note owns the date (resumeAt); a held (open case) or FAILED
   * contract has no scheduled delivery. Null = say nothing.
   */
  nextBillingDate: Date | null;
  /** Captured member savings (portal value-tile figure); 0 = none/unknown. */
  memberSavingsCents: number;
  /** Live DiscountGrant still covering upcoming orders (null = none). */
  discountPercent: number | null;
  discountCyclesRemaining: number | null;
  /** Free gifts that actually shipped on this contract; 0 = none/unknown. */
  giftsReceived: number;
  /** contract.grandfatheredPricing — the price is locked against catalog
   * price changes; `lockedPriceCents` is the recurring per-order subtotal. */
  lockedPrice: boolean;
  lockedPriceCents: number;
}

export async function buildRetentionSummary(
  shop: Shop,
  contract: LocalContractWithLines,
): Promise<RetentionSummary> {
  const lifecycle = await getSetting(shop.id, "lifecycle");

  let perCycleSavingsCents = 0;
  let recurringSubtotalCents = 0;
  for (const line of contract.lines) {
    if (line.isGift || line.isOneTimeAddon) continue;
    recurringSubtotalCents += line.currentPriceCents * line.quantity;
    const compareAt = line.compareAtPriceCents;
    if (compareAt != null && compareAt > line.currentPriceCents) {
      perCycleSavingsCents += (compareAt - line.currentPriceCents) * line.quantity;
    }
  }

  // Exact-unit cycle math — never the intervalWeeks approximation (a monthly
  // contract is 12 cycles/year, not 52/4=13). contractFrequency degrades a
  // missing unit mirror to {WEEK, intervalWeeks}, i.e. 52/intervalWeeks.
  const freq = contractFrequency(contract);
  const cyclesPerYear =
    freq.unit === "MONTH"
      ? 12 / freq.count
      : freq.unit === "DAY"
        ? 365.25 / freq.count
        : 52 / freq.count;
  const annualSavingsCents = Math.round(perCycleSavingsCents * cyclesPerYear);

  const since = contract.firstChargeAt ?? contract.createdAt;
  const daysSubscribed = Math.max(
    0,
    Math.floor((Date.now() - since.getTime()) / 86_400_000),
  );

  // Ladder-aware milestone countdown — the portal rewards strip's own logic.
  const ladder: readonly number[] = Array.isArray(lifecycle.milestoneLadder)
    ? lifecycle.milestoneLadder
    : [];
  const remaining = milestoneRemaining(
    contract.ordersCount,
    lifecycle.milestoneGiftCycle,
    ladder,
  );
  const ordersToMilestone = remaining ?? 0;
  const nextMilestoneCycle =
    remaining == null ? null : contract.ordersCount + remaining;
  let nextMilestoneAt: Date | null = null;
  if (nextMilestoneCycle != null) {
    try {
      nextMilestoneAt = projectOrderDate(contract, nextMilestoneCycle, shop.ianaTimezone);
    } catch (err) {
      console.error("[cancel] retention summary: milestone date projection failed", contract.id, err);
    }
  }

  const rewardsUnlocked = daysSubscribed >= lifecycle.rewardsUnlockDay;
  const daysToRewards = rewardsUnlocked
    ? 0
    : lifecycle.rewardsUnlockDay - daysSubscribed;

  // ── Money-true extras (each contained) ─────────────────────────────────────
  let memberSavings = 0;
  try {
    memberSavings = (await memberSavingsCents([contract.id])).get(contract.id) ?? 0;
  } catch (err) {
    console.error("[cancel] retention summary: member savings read failed", contract.id, err);
  }

  let discountPercent: number | null = null;
  let discountCyclesRemaining: number | null = null;
  try {
    const grant = await getActiveDiscountForCycle(contract.id);
    if (grant && grant.percent > 0 && grant.cyclesRemaining > 0) {
      discountPercent = grant.percent;
      discountCyclesRemaining = grant.cyclesRemaining;
    }
    // Dunning parity (v1.28.0 review): while a failed / challenged / expired
    // attempt parks the current cycle, that cycle already carries the applied
    // grant (consumed pre-charge) — the marker is the truth, as in the
    // estimate.
    const parked = await loadParkedCycleDiscount(contract.id);
    if (parked) {
      discountPercent = parked.percent;
      discountCyclesRemaining = parked.cyclesRemaining;
    }
  } catch (err) {
    console.error("[cancel] retention summary: discount grant read failed", contract.id, err);
  }

  let giftsReceived = 0;
  try {
    // A gift counts once it actually shipped: the SHIPPED status, or the
    // settlement stamp on grants later flipped REMOVED by mirror hygiene.
    giftsReceived = await prisma.giftGrant.count({
      where: {
        contractId: contract.id,
        OR: [{ status: "SHIPPED" }, { shippedAt: { not: null } }],
      },
    });
  } catch (err) {
    console.error("[cancel] retention summary: gift count read failed", contract.id, err);
  }

  // "Next delivery scheduled for" is only true for a healthy ACTIVE contract
  // (see the field doc). Contained: a failed case read keeps the date for an
  // ACTIVE contract (the pre-fix behaviour), never blocks the flow.
  let nextBillingDate: Date | null = null;
  if (contract.status === "ACTIVE" && contract.nextBillingDate) {
    nextBillingDate = contract.nextBillingDate;
    try {
      const openCase = await prisma.dunningCase.findFirst({
        where: { contractId: contract.id, state: { in: OPEN_CASE_STATES } },
        select: { id: true },
      });
      if (openCase) nextBillingDate = null;
    } catch (err) {
      console.error("[cancel] retention summary: dunning case read failed", contract.id, err);
    }
  }

  return {
    currencyCode: contract.currencyCode,
    perCycleSavingsCents,
    annualSavingsCents,
    daysSubscribed,
    ordersCount: contract.ordersCount,
    milestoneCycle: lifecycle.milestoneGiftCycle,
    nextMilestoneCycle,
    ordersToMilestone,
    nextMilestoneAt,
    rewardsUnlocked,
    rewardsUnlockDay: lifecycle.rewardsUnlockDay,
    daysToRewards,
    nextBillingDate,
    memberSavingsCents: Math.max(0, memberSavings),
    discountPercent,
    discountCyclesRemaining,
    giftsReceived,
    lockedPrice: contract.grandfatheredPricing === true && recurringSubtotalCents > 0,
    lockedPriceCents: recurringSubtotalCents,
  };
}

/**
 * The concrete, money-true loss lines for the intro list and the confirm
 * page (v1.28.0) — ordered biggest anchor first. Pure: renders only what
 * the summary proves (zero/unknown values produce no line). Returned as
 * i18n keys + vars so pages.server can localize them; the two pages share
 * this ledger so the intro and the confirm never disagree.
 */
export interface RetentionLossLine {
  key: string;
  vars: Record<string, string | number>;
}

export function retentionLossLines(
  summary: RetentionSummary,
  fmtMoney: (cents: number) => string,
  /** "intro" = the full endowment ledger (what you have); "confirm" = only
   * what cancelling actually FORFEITS (tenure, gifts already received and
   * savings already banked are facts, not losses — they stay off it). */
  mode: "intro" | "confirm" = "intro",
): RetentionLossLine[] {
  const lines: RetentionLossLine[] = [];
  const intro = mode === "intro";
  if (summary.lockedPrice && summary.lockedPriceCents > 0) {
    lines.push({
      key: "cancel.intro.locked_price_line",
      vars: { price: fmtMoney(summary.lockedPriceCents) },
    });
  }
  if (summary.annualSavingsCents > 0) {
    lines.push({
      key: "cancel.intro.savings_line",
      vars: {
        annualSavings: fmtMoney(summary.annualSavingsCents),
        perCycleSavings: fmtMoney(summary.perCycleSavingsCents),
      },
    });
  }
  if (intro && summary.memberSavingsCents > 0) {
    lines.push({
      key: "cancel.intro.member_savings_line",
      vars: { saved: fmtMoney(summary.memberSavingsCents) },
    });
  }
  if (
    summary.discountPercent != null &&
    summary.discountPercent > 0 &&
    summary.discountCyclesRemaining != null &&
    summary.discountCyclesRemaining > 0
  ) {
    lines.push({
      key:
        summary.discountCyclesRemaining === 1
          ? "cancel.intro.discount_line_one"
          : "cancel.intro.discount_line",
      vars: {
        percent: summary.discountPercent,
        count: summary.discountCyclesRemaining,
      },
    });
  }
  if (summary.nextMilestoneCycle != null && summary.ordersToMilestone > 0) {
    lines.push({
      key: "cancel.intro.milestone_line",
      vars: {
        ordersLeft: summary.ordersToMilestone,
        milestoneCycle: summary.nextMilestoneCycle,
      },
    });
  }
  if (intro && summary.giftsReceived > 0) {
    lines.push({
      key:
        summary.giftsReceived === 1
          ? "cancel.intro.gifts_line_one"
          : "cancel.intro.gifts_line",
      vars: { count: summary.giftsReceived },
    });
  }
  if (summary.rewardsUnlocked) {
    lines.push({ key: "cancel.intro.rewards_unlocked", vars: {} });
  } else if (summary.daysToRewards > 0) {
    lines.push({
      key: "cancel.intro.rewards_countdown",
      vars: { days: summary.daysToRewards },
    });
  }
  if (intro && summary.daysSubscribed > 0) {
    lines.push({
      key: "cancel.intro.days_line",
      vars: { days: summary.daysSubscribed },
    });
  }
  return lines;
}
