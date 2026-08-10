import type { Shop } from "@prisma/client";
import { getSetting } from "~/lib/settings/settings.server";
import { contractFrequency } from "~/lib/frequency";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";

/**
 * Loss-aversion summary for step 1 ("before you go").
 *
 * Psychology: people weigh losses ~2x heavier than equivalent gains, so the
 * intro page frames the subscription as things the customer ALREADY OWNS and
 * would lose — the subscriber price (a concrete £/year number), progress
 * toward the milestone gift, unlocked rewards, and tenure. Every number is
 * computed from real contract data; nothing is invented, which is both more
 * persuasive and a compliance requirement (no fabricated claims).
 *
 * A line only counts toward savings when Shopify gives us a compare-at price
 * higher than the subscriber price; gift and one-time lines never count.
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
  /** settings.lifecycle.milestoneGiftCycle (e.g. order 6 gift). */
  milestoneCycle: number;
  /** Orders still needed to reach the milestone gift; 0 = reached. */
  ordersToMilestone: number;
  rewardsUnlocked: boolean;
  rewardsUnlockDay: number;
  /** Days until rewards unlock; 0 when already unlocked. */
  daysToRewards: number;
  nextBillingDate: Date | null;
}

export async function buildRetentionSummary(
  shop: Shop,
  contract: LocalContractWithLines,
): Promise<RetentionSummary> {
  const lifecycle = await getSetting(shop.id, "lifecycle");

  let perCycleSavingsCents = 0;
  for (const line of contract.lines) {
    if (line.isGift || line.isOneTimeAddon) continue;
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

  const ordersToMilestone = Math.max(
    0,
    lifecycle.milestoneGiftCycle - contract.ordersCount,
  );
  const rewardsUnlocked = daysSubscribed >= lifecycle.rewardsUnlockDay;
  const daysToRewards = rewardsUnlocked
    ? 0
    : lifecycle.rewardsUnlockDay - daysSubscribed;

  return {
    currencyCode: contract.currencyCode,
    perCycleSavingsCents,
    annualSavingsCents,
    daysSubscribed,
    ordersCount: contract.ordersCount,
    milestoneCycle: lifecycle.milestoneGiftCycle,
    ordersToMilestone,
    rewardsUnlocked,
    rewardsUnlockDay: lifecycle.rewardsUnlockDay,
    daysToRewards,
    nextBillingDate: contract.nextBillingDate,
  };
}
