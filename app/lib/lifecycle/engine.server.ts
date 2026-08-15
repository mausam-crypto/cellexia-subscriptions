import type { Shop, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz } from "~/lib/dates.server";
import { sendNotification } from "~/lib/notifications/index.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";
import { giftEmailLines } from "~/lib/gifts/emailLines.server";
import { t } from "~/lib/i18n/i18n.server";

// Shopify-touching dependencies stay LAZY: this module is imported by the
// billing-success webhook path, and tests exercise it without a Shopify
// session — the admin client, cycle reads and the picker are only pulled in
// by the code paths that actually need them (grantRewardsGift, teaser gate).
const shopifyDeps = async () => {
  const [{ adminClientForShop }, { getBillingCycleByDate }, { pickGiftForContract }] =
    await Promise.all([
      import("~/shopify.server"),
      import("~/lib/graphql/billingCycles.server"),
      import("~/lib/gifts/picker.server"),
    ]);
  return { adminClientForShop, getBillingCycleByDate, pickGiftForContract };
};

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

/**
 * The full milestone sequence: the base milestoneGiftCycle plus every ladder
 * rung after it, ascending and deduped. The goal-gradient hook must never
 * exhaust — there is always a next rung (portal/growth.server.ts shows the
 * countdown to it).
 */
export function milestoneCycles(lifecycle: {
  milestoneGiftCycle: number;
  milestoneLadder: number[];
}): number[] {
  const all = new Set<number>([
    lifecycle.milestoneGiftCycle,
    ...lifecycle.milestoneLadder,
  ]);
  return [...all].sort((a, b) => a - b);
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

    // ── Milestone (base cycle, e.g. order 6, plus every ladder rung) ────────
    if (milestoneCycles(lifecycle).includes(newOrdersCount)) {
      const already = await hasOrderCountEvent(
        contract.id,
        "lifecycle.milestone_reached",
        newOrdersCount,
      );
      if (!already) {
        // Truth gate for the email copy: the gift sentence only renders when
        // a gift actually rode along (the base cycle's ORDER_INDEX rule or a
        // ladder grant — both created pre-charge by the gift engine). A
        // milestone with no grant still gets its celebration email, just
        // without promising a product that never shipped. Scoping: cycle 0
        // excluded (the first-order gift is terminally ADDED there forever)
        // and both legs are recency-bounded — the SHIPPED leg is the normal
        // match (the settlement flip ran moments ago), the recent-ADDED leg
        // is the missed-flip safety net.
        const shippedSince = new Date(Date.now() - 3 * 86_400_000);
        const milestoneGift = await prisma.giftGrant.findFirst({
          where: {
            contractId: contract.id,
            cycleIndex: { gte: 1 },
            OR: [
              { status: "SHIPPED", shippedAt: { gte: shippedSince } },
              { status: "ADDED", addedAt: { gte: shippedSince } },
            ],
          },
          orderBy: { createdAt: "desc" },
          include: { rule: true },
        });
        // The rule's title describes its FALLBACK variant — trust it only
        // when the grant actually carries that variant. A dynamically picked
        // grant gets the truthful generic sentence instead of naming a
        // product that isn't in the box.
        const giftTitle =
          milestoneGift &&
          milestoneGift.variantId === milestoneGift.rule?.variantId
            ? (milestoneGift.rule?.variantTitle ??
              milestoneGift.rule?.name ??
              null)
            : null;
        await logEvent({
          ...eventBase,
          type: "lifecycle.milestone_reached",
          source: "SYSTEM",
          actor: "lifecycle_engine",
          payload: {
            ordersCount: newOrdersCount,
            milestoneCycle: newOrdersCount,
            nextMilestoneCycle:
              milestoneCycles(lifecycle).find((c) => c > newOrdersCount) ??
              null,
            // The gift itself ships via the ORDER_INDEX GiftRule (base) or
            // the engine's ladder grant for this cycle.
            giftVia: "gift_rule_order_index",
            giftGranted: milestoneGift != null,
          },
        });
        // {gift_line} is the body's whole gift sentence — localized here,
        // empty when nothing shipped, so the email can never promise a
        // product the box doesn't carry.
        const giftLine = milestoneGift
          ? giftTitle
            ? t(contract.locale, "email.milestone_gift.gift_line", {
                gift_title: giftTitle,
              })
            : t(contract.locale, "email.milestone_gift.gift_line_generic")
          : "";
        await sendNotification({
          shopId: contract.shopId,
          contractId: contract.id,
          template: "milestone_gift",
          vars: {
            cycleIndex: newOrdersCount,
            milestone_cycle: newOrdersCount,
            gift_line: giftLine,
            ...(giftTitle ? { gift_title: giftTitle } : {}),
            ...(milestoneGift ? { gift_granted: "true" } : {}),
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
        // The teaser truth gate: "a surprise is coming in your next box" may
        // only be said when the cycle-2 surprise will actually happen — the
        // setting is on AND an active ORDER_INDEX=2 rule exists to produce
        // the grant (the setting alone ships nothing; see
        // suggestSurpriseGiftRule). Holdout-arm customers (gift2 experiment)
        // get no grant, so they get no teaser either.
        let surpriseGiftComing =
          lifecycle.surpriseGiftOnCycle2 && nextCycleIndex === 2;
        if (surpriseGiftComing) {
          const cycle2Rule = await prisma.giftRule.findFirst({
            where: {
              shopId: contract.shopId,
              active: true,
              trigger: "ORDER_INDEX",
              orderIndex: 2,
            },
            select: { id: true },
          });
          surpriseGiftComing = cycle2Rule != null;
        }
        if (surpriseGiftComing) {
          const { surpriseGiftArmFor } = await import(
            "~/lib/experiments/index.server"
          );
          const arm = await surpriseGiftArmFor(contract);
          surpriseGiftComing = arm !== "no_gift";
        }
        const nextMilestone =
          milestoneCycles(lifecycle).find((c) => c > newOrdersCount) ?? null;
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
            cyclesUntilMilestone:
              nextMilestone == null
                ? 0
                : Math.max(0, nextMilestone - newOrdersCount),
            rewardsUnlockDay: lifecycle.rewardsUnlockDay,
          },
        });
        // The teaser email itself (v1.24.0) — before this template existed
        // the anticipation mechanic silently reached no one (the canonical
        // event has no default flow). Deduped per teased cycle.
        if (surpriseGiftComing) {
          const { hasSentForCycle } = await import(
            "~/lib/notifications/index.server"
          );
          const teased = await hasSentForCycle(
            contract.id,
            "gift_teaser",
            nextCycleIndex,
          );
          if (!teased) {
            await sendNotification({
              shopId: contract.shopId,
              contractId: contract.id,
              template: "gift_teaser",
              vars: { cycleIndex: nextCycleIndex },
            });
          }
        }
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
 * Minimum grace window (days) for catching unlocks the sweep missed: the
 * target is "crossed within the last day", but downtime must not permanently
 * skip a subscriber — the event-existence dedupe makes a wider window safe.
 * A fixed window only protects outages shorter than itself, so the actual
 * lookback stretches to cover the gap since the job's last SUCCESS (see
 * rewardsLookbackDays); this floor is also the fallback when no run history
 * exists at all (fresh install), where a wide window would instead fire
 * "just unlocked!" notifications at an entire imported base whose day-N
 * passed long ago.
 */
const REWARDS_LOOKBACK_MIN_DAYS = 3;

/**
 * Days of firstChargeAt history to scan, derived from the lifecycle_run
 * job's own last SUCCESS (the JobRun log): gap since that run + 1 day of
 * slack, floored at REWARDS_LOOKBACK_MIN_DAYS. An outage of any length —
 * including a full undeploy — then widens the window to exactly the missed
 * stretch, and the hasEvent dedupe keeps the wider scan idempotent. The
 * current run's own row is RUNNING while this executes, so the newest
 * SUCCESS is genuinely the previous completed run.
 */
async function rewardsLookbackDays(now: Date): Promise<number> {
  try {
    const lastSuccess = await prisma.jobRun.findFirst({
      where: { jobName: "lifecycle_run", status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (!lastSuccess) return REWARDS_LOOKBACK_MIN_DAYS;
    const gapDays = Math.ceil(
      Math.max(0, now.getTime() - lastSuccess.startedAt.getTime()) / 86_400_000,
    );
    return Math.max(REWARDS_LOOKBACK_MIN_DAYS, gapDays + 1);
  } catch (err) {
    // History unavailable — the floor still covers the common case.
    console.error("[lifecycle] rewards lookback derivation failed", err);
    return REWARDS_LOOKBACK_MIN_DAYS;
  }
}

export interface RewardsUnlockStats {
  scanned: number;
  unlocked: number;
  /** Rewards gifts granted alongside the unlock (rewardsGiftEnabled). */
  giftsGranted: number;
  errors: number;
  skipped?: string;
}

interface RewardsGiftInfo {
  /** Null on the crash-recovery reuse path (grant exists, pick data gone) —
   * the email then celebrates without naming the product. */
  title: string | null;
  imageUrl: string | null;
  retailCents: number | null;
  cycleIndex: number;
}

/**
 * The REAL reward behind "rewards unlocked" (v1.24.0): a dynamically picked
 * free product on the customer's next cycle. Idempotent by the source-scoped
 * grant (one REWARDS grant per contract, ever — the unlock itself fires
 * once); a crash between grant and event re-enters here and reuses the
 * existing grant. Returns null — and the caller's email then omits the
 * product promise — when the pool yields nothing, the cycle is already
 * gifted (gifts.maxGiftsPerCycle), or Shopify can't be read. Never throws.
 */
async function grantRewardsGift(
  shop: Shop,
  admin: AdminClient,
  contract: SubscriptionContract,
): Promise<RewardsGiftInfo | null> {
  try {
    const prior = await prisma.giftGrant.findFirst({
      where: { contractId: contract.id, source: "REWARDS" },
    });
    if (prior) {
      return {
        title: null,
        imageUrl: null,
        retailCents: null,
        cycleIndex: prior.cycleIndex,
      };
    }

    const { getBillingCycleByDate, pickGiftForContract } = await shopifyDeps();

    let cycleIndex = contract.ordersCount + 1;
    if (contract.nextBillingDate) {
      try {
        const cycle = await getBillingCycleByDate(
          admin,
          contract.shopifyContractId,
          contract.nextBillingDate,
        );
        if (cycle) cycleIndex = cycle.cycleIndex;
      } catch (err) {
        console.error(
          "[lifecycle] rewards cycle read failed — ordersCount fallback",
          contract.id,
          err,
        );
      }
    }

    const gifts = await getSetting(shop.id, "gifts");
    const onCycle = await prisma.giftGrant.findMany({
      where: {
        contractId: contract.id,
        cycleIndex,
        status: { in: ["SCHEDULED", "ADDED"] },
      },
      select: { variantId: true },
    });
    if (onCycle.length >= gifts.maxGiftsPerCycle) return null;

    const pick = await pickGiftForContract({
      shopId: shop.id,
      admin,
      contract,
      excludeVariantIds: onCycle.map((g) => g.variantId),
    });
    if (!pick) return null;

    const grant = await prisma.giftGrant.create({
      data: {
        contractId: contract.id,
        ruleId: null,
        cycleIndex,
        variantId: pick.variantId,
        status: "SCHEDULED",
        unitCostCents: pick.unitCostCents,
        source: "REWARDS",
      },
    });
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "lifecycle.gift_scheduled",
      source: "SYSTEM",
      actor: "lifecycle_engine",
      payload: {
        grantId: grant.id,
        ruleId: null,
        ruleName: "Rewards unlock gift",
        trigger: "REWARDS_UNLOCK",
        cycleIndex,
        variantId: pick.variantId,
        variantTitle: pick.label,
        announceInAdvance: true,
      },
    });

    return {
      title: pick.label,
      imageUrl: pick.imageUrl,
      retailCents: pick.retailCents,
      cycleIndex,
    };
  } catch (err) {
    console.error("[lifecycle] rewards gift grant failed", contract.id, err);
    return null;
  }
}

/**
 * Day-N rewards unlock (a retention milestone dressed as a perk): contracts
 * whose firstChargeAt + settings.lifecycle.rewardsUnlockDay crossed within the
 * look-back window and that have no lifecycle.rewards_unlocked event yet get
 * the event + the rewards_unlocked notification. The portal's rewards strip
 * keys off the event.
 */
export async function runRewardsUnlock(now: Date): Promise<RewardsUnlockStats> {
  const stats: RewardsUnlockStats = {
    scanned: 0,
    unlocked: 0,
    giftsGranted: 0,
    errors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;
  const lifecycle = await getSetting(shop.id, "lifecycle");

  // One admin client for the whole sweep — only needed when the unlock
  // carries a real gift. A client failure downgrades the sweep to
  // email-without-product, never blocks it.
  let admin: AdminClient | null = null;
  if (lifecycle.rewardsGiftEnabled) {
    try {
      const { adminClientForShop } = await shopifyDeps();
      admin = await adminClientForShop(shop.domain);
    } catch (err) {
      console.error("[lifecycle] admin client for rewards gifts failed", err);
    }
  }

  // unlockAt = firstChargeAt + rewardsUnlockDay ∈ (now − lookback, now]
  //   ⇔ firstChargeAt ∈ (now − rewardsUnlockDay − lookback, now − rewardsUnlockDay]
  const lookbackDays = await rewardsLookbackDays(now);
  const windowEnd = addDaysTz(now, -lifecycle.rewardsUnlockDay, tz);
  const windowStart = addDaysTz(windowEnd, -lookbackDays, tz);

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

      // Grant the real reward BEFORE the event/email so both only ever
      // describe a grant that exists — the unlock email's product sentence
      // renders solely off these vars (truth gate).
      let rewardGift: RewardsGiftInfo | null = null;
      if (admin && lifecycle.rewardsGiftEnabled) {
        rewardGift = await grantRewardsGift(shop, admin, contract);
        if (rewardGift) stats.giftsGranted += 1;
      }

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
          giftGranted: rewardGift != null,
          giftTitle: rewardGift?.title ?? null,
        },
      });
      // {gift_line}/{gift_image_line} are the body's gift slots — localized
      // sentences when a reward grant exists, empty otherwise (truth gate).
      const giftLine = rewardGift?.title
        ? t(contract.locale, "email.rewards_unlocked.gift_line", {
            gift_title: rewardGift.title,
          })
        : "";
      const giftImageLine =
        rewardGift?.title && rewardGift.imageUrl
          ? giftEmailLines({
              locale: contract.locale,
              title: rewardGift.title,
              imageUrl: rewardGift.imageUrl,
            }).gift_image_line
          : "";
      await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "rewards_unlocked",
        vars: {
          rewards_unlock_day: lifecycle.rewardsUnlockDay,
          gift_line: giftLine,
          gift_image_line: giftImageLine,
          ...(rewardGift?.title
            ? { gift_title: rewardGift.title, gift_granted: "true" }
            : {}),
        },
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
