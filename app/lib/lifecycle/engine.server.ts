import type { SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz } from "~/lib/dates.server";
import { sendNotification } from "~/lib/notifications/index.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Lifecycle engine — milestones, early-cycle incentives and the day-N rewards
 * unlock. This module fires events and notifications only; the emails
 * themselves live in Klaviyo flows keyed off the metrics, and the gifts
 * themselves come from GiftRules (the gift engine owns attaching them):
 *
 * - Milestone (order == settings.lifecycle.milestoneGiftCycle):
 *   lifecycle.milestone_reached + milestone_gift notification. The physical
 *   gift ships via a GiftRule with ORDER_INDEX = milestone cycle.
 * - Early-cycle incentives (orders 1–2, when enabled):
 *   lifecycle.incentive_announced with everything a Klaviyo flow needs to
 *   tease what's coming next (cycle-2 surprise gift, milestone progress).
 * - Anniversary (firstChargeAt + anniversaryGiftDays): intentionally NOT
 *   handled here — a DAYS_SUBSCRIBED GiftRule covers it in the gift engine.
 * - Rewards unlock (firstChargeAt + rewardsUnlockDay): swept periodically;
 *   lifecycle.rewards_unlocked + rewards_unlocked notification (the portal
 *   shows the rewards strip off the event).
 *
 * Everything is deduped through event existence / NotificationLog so webhook
 * replays and sweep re-runs never double-fire, and onSuccessfulCycle never
 * throws — a lifecycle perk must never fail a billing webhook.
 */

// ── Dedupe helpers ───────────────────────────────────────────────────────────

/** Has an event of `type` with payload.ordersCount == ordersCount been logged? */
async function hasOrderCountEvent(
  contractId: string,
  type: string,
  ordersCount: number,
): Promise<boolean> {
  const row = await prisma.subscriberEvent.findFirst({
    where: {
      contractId,
      type,
      payload: { path: ["ordersCount"], equals: ordersCount },
    },
    select: { id: true },
  });
  return row !== null;
}

async function hasEvent(contractId: string, type: string): Promise<boolean> {
  const row = await prisma.subscriberEvent.findFirst({
    where: { contractId, type },
    select: { id: true },
  });
  return row !== null;
}

async function resolveContract(
  contractOrId: SubscriptionContract | string,
): Promise<SubscriptionContract | null> {
  const id = typeof contractOrId === "string" ? contractOrId : contractOrId.id;
  return prisma.subscriptionContract.findUnique({ where: { id } });
}

// ── Successful-cycle hook ────────────────────────────────────────────────────

export interface SuccessfulCycleResult {
  milestoneReached: boolean;
  incentiveAnnounced: boolean;
}

/**
 * Called by the billing-success webhook after counters are bumped (it passes
 * the contract row and the new ordersCount; a local id is accepted too).
 * Never throws — failures are logged and swallowed.
 */
export async function onSuccessfulCycle(
  contractOrId: SubscriptionContract | string,
  newOrdersCount: number,
): Promise<SuccessfulCycleResult> {
  const result: SuccessfulCycleResult = {
    milestoneReached: false,
    incentiveAnnounced: false,
  };

  try {
    const contract = await resolveContract(contractOrId);
    if (!contract) return result;
    // Milestones and incentives are OUR loyalty programme — another
    // subscription app's subscriber never joined it.
    if (!isBillableOwnership(contract.ownership)) return result;

    const lifecycle = await getSetting(contract.shopId, "lifecycle");
    const eventBase = {
      shopId: contract.shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
    } as const;

    // ── Milestone (e.g. order 6) ────────────────────────────────────────────
    if (newOrdersCount === lifecycle.milestoneGiftCycle) {
      const already = await hasOrderCountEvent(
        contract.id,
        "lifecycle.milestone_reached",
        newOrdersCount,
      );
      if (!already) {
        await logEvent({
          ...eventBase,
          type: "lifecycle.milestone_reached",
          source: "SYSTEM",
          actor: "lifecycle_engine",
          payload: {
            ordersCount: newOrdersCount,
            milestoneCycle: lifecycle.milestoneGiftCycle,
            // The gift itself ships via the ORDER_INDEX GiftRule for this cycle.
            giftVia: "gift_rule_order_index",
          },
        });
        await sendNotification({
          shopId: contract.shopId,
          contractId: contract.id,
          template: "milestone_gift",
          vars: {
            cycleIndex: newOrdersCount,
            milestone_cycle: lifecycle.milestoneGiftCycle,
          },
        });
        result.milestoneReached = true;
      }
    }

    // ── Early-cycle incentives (orders 1–2) ─────────────────────────────────
    if (
      lifecycle.earlyCycleIncentivesEnabled &&
      (newOrdersCount === 1 || newOrdersCount === 2)
    ) {
      const already = await hasOrderCountEvent(
        contract.id,
        "lifecycle.incentive_announced",
        newOrdersCount,
      );
      if (!already) {
        const nextCycleIndex = newOrdersCount + 1;
        const surpriseGiftComing =
          lifecycle.surpriseGiftOnCycle2 && nextCycleIndex === 2;
        await logEvent({
          ...eventBase,
          type: "lifecycle.incentive_announced",
          source: "SYSTEM",
          actor: "lifecycle_engine",
          // Property bag for the Klaviyo flow — the email itself lives there.
          payload: {
            ordersCount: newOrdersCount,
            nextCycleIndex,
            surpriseGiftComing,
            milestoneCycle: lifecycle.milestoneGiftCycle,
            cyclesUntilMilestone: Math.max(
              0,
              lifecycle.milestoneGiftCycle - newOrdersCount,
            ),
            rewardsUnlockDay: lifecycle.rewardsUnlockDay,
          },
        });
        result.incentiveAnnounced = true;
      }
    }

    // Anniversary gifts: handled by the gift engine via DAYS_SUBSCRIBED rules
    // (settings.lifecycle.anniversaryGiftDays ↔ GiftRule.daysSubscribed) —
    // nothing to do here.
  } catch (err) {
    console.error("[lifecycle] onSuccessfulCycle failed", err);
  }

  return result;
}

// ── Rewards unlock sweep ─────────────────────────────────────────────────────

/**
 * Grace window (days) for catching unlocks the sweep missed: the target is
 * "crossed within the last day", but downtime must not permanently skip a
 * subscriber — the event-existence dedupe makes the wider window safe.
 */
const REWARDS_LOOKBACK_DAYS = 3;

export interface RewardsUnlockStats {
  scanned: number;
  unlocked: number;
  errors: number;
  skipped?: string;
}

/**
 * Day-N rewards unlock (a retention milestone dressed as a perk): contracts
 * whose firstChargeAt + settings.lifecycle.rewardsUnlockDay crossed within the
 * look-back window and that have no lifecycle.rewards_unlocked event yet get
 * the event + the rewards_unlocked notification. The portal's rewards strip
 * keys off the event.
 */
export async function runRewardsUnlock(now: Date): Promise<RewardsUnlockStats> {
  const stats: RewardsUnlockStats = { scanned: 0, unlocked: 0, errors: 0 };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;
  const lifecycle = await getSetting(shop.id, "lifecycle");

  // unlockAt = firstChargeAt + rewardsUnlockDay ∈ (now − lookback, now]
  //   ⇔ firstChargeAt ∈ (now − rewardsUnlockDay − lookback, now − rewardsUnlockDay]
  const windowEnd = addDaysTz(now, -lifecycle.rewardsUnlockDay, tz);
  const windowStart = addDaysTz(windowEnd, -REWARDS_LOOKBACK_DAYS, tz);

  const candidates = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      ...OURS_ONLY,
      isDemo: false, // the admin-preview fixture must never unlock rewards
      status: { in: ["ACTIVE", "PAUSED"] },
      firstChargeAt: { gt: windowStart, lte: windowEnd },
    },
  });

  for (const contract of candidates) {
    stats.scanned += 1;
    try {
      if (await hasEvent(contract.id, "lifecycle.rewards_unlocked")) continue;

      const unlockAt = contract.firstChargeAt
        ? addDaysTz(contract.firstChargeAt, lifecycle.rewardsUnlockDay, tz)
        : now;

      await logEvent({
        shopId: shop.id,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "lifecycle.rewards_unlocked",
        source: "SYSTEM",
        actor: "lifecycle_engine",
        payload: {
          rewardsUnlockDay: lifecycle.rewardsUnlockDay,
          unlockedAt: unlockAt.toISOString(),
          firstChargeAt: contract.firstChargeAt?.toISOString() ?? null,
          ordersCount: contract.ordersCount,
        },
      });
      await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "rewards_unlocked",
        vars: { rewards_unlock_day: lifecycle.rewardsUnlockDay },
      });
      stats.unlocked += 1;
    } catch (err) {
      stats.errors += 1;
      console.error("[lifecycle] rewards unlock failed", contract.id, err);
    }
  }

  return stats;
}

// ── Periodic sweep (jobs entry point) ────────────────────────────────────────

export interface LifecycleSweepStats {
  rewards: RewardsUnlockStats;
}

/**
 * Everything lifecycle that runs on a clock, in one call for the job runner
 * (a daily `lifecycle_run` job should call this; see module notes). Today
 * that is the rewards unlock; future periodic lifecycle checks join here.
 */
export async function runLifecycleSweep(now: Date): Promise<LifecycleSweepStats> {
  const rewards = await runRewardsUnlock(now);
  return { rewards };
}
