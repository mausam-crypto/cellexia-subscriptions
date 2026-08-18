import prisma from "~/db.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatShopDate } from "~/lib/dates.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { nextCycleIndex, type NextCycleIndexContract } from "~/lib/billing/estimate.server";
import {
  buildRewardsRoadmap,
  teaserPromisedFor,
  type RewardsRoadmap,
  type RoadmapContract,
} from "~/lib/portal/growth.server";

/**
 * Rewards card of the portal (v1.29.0: shared module).
 *
 * The home page has always rendered ONE rewards card above the subscription
 * cards: the classic three-tile strip (days subscribed, milestone progress,
 * rewards unlock), or — behind portalGrowth.rewardsRoadmap — the full
 * roadmap (every rung + the day-N reward, each with a projected "around
 * {date}", plus deliveries-so-far / gifts-received tiles). Since v1.29.0 a
 * customer with exactly one subscription lands on the subscription page
 * directly (portal.singleSubscriptionOpensDetail), so that page renders the
 * SAME card through the same builder — one implementation, two callers,
 * never a drift between what the list and the detail promise.
 */

export type RewardsCardContract = RoadmapContract &
  NextCycleIndexContract & {
    status: string;
  };

export function rewardsStripHtml(params: {
  locale: string;
  daysSubscribed: number;
  maxOrders: number;
  milestoneCycle: number;
  rewardsUnlockDay: number;
  rewardsUnlocked: boolean;
  milestoneReached: boolean;
}): string {
  const {
    locale,
    daysSubscribed,
    maxOrders,
    milestoneCycle,
    rewardsUnlockDay,
    rewardsUnlocked,
    milestoneReached,
  } = params;

  const milestonePct = Math.min(
    100,
    Math.round((maxOrders / milestoneCycle) * 100),
  );
  // Concrete next-perk copy: "N more order(s) until your milestone gift".
  // Guards: milestoneReached uses >= so the cell flips to "earned" exactly AT
  // the milestone order (and remaining is only rendered when >= 1).
  const ordersRemaining = Math.max(1, milestoneCycle - maxOrders);
  const milestoneCell = milestoneReached
    ? `<div class="cxs-rewards__num">&#10003;</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.milestone_reached", { orders: milestoneCycle }))}</div>`
    : `<div class="cxs-rewards__num">${maxOrders}&thinsp;/&thinsp;${milestoneCycle}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.milestone_next", { count: ordersRemaining }))}</div><div class="cxs-progress" role="progressbar" aria-label="${escapeHtml(t(locale, "portal.a11y.progress_milestone"))}" aria-valuemin="0" aria-valuemax="${milestoneCycle}" aria-valuenow="${Math.min(maxOrders, milestoneCycle)}"><span style="width:${milestonePct}%"></span></div>`;

  const unlockPct = Math.min(
    100,
    Math.round((daysSubscribed / rewardsUnlockDay) * 100),
  );
  // rewardsUnlocked uses >= so day 90 exactly reads as unlocked, never "0 more days".
  const daysRemaining = Math.max(1, rewardsUnlockDay - daysSubscribed);
  const rewardsCell = rewardsUnlocked
    ? `<div class="cxs-rewards__num">&#10003;</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.unlocked"))}</div>`
    : `<div class="cxs-rewards__num">${daysSubscribed}&thinsp;/&thinsp;${rewardsUnlockDay}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.unlock_next", { days: daysRemaining }))}</div><div class="cxs-progress" role="progressbar" aria-label="${escapeHtml(t(locale, "portal.a11y.progress_rewards"))}" aria-valuemin="0" aria-valuemax="${rewardsUnlockDay}" aria-valuenow="${Math.min(daysSubscribed, rewardsUnlockDay)}"><span style="width:${unlockPct}%"></span></div>`;

  return `<section class="cxs-rewards">
  <h2>${escapeHtml(t(locale, "portal.rewards.title"))}</h2>
  <div class="cxs-rewards__grid">
    <div class="cxs-rewards__cell"><div class="cxs-rewards__num">${daysSubscribed}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.days_subscribed"))}</div></div>
    <div class="cxs-rewards__cell">${milestoneCell}</div>
    <div class="cxs-rewards__cell">${rewardsCell}</div>
  </div>
</section>`;
}

/**
 * Rewards roadmap (v1.28.0, P4.3 — portalGrowth.rewardsRoadmap): every
 * milestone rung + the day-N reward as a list with a projected "around
 * {date}" each, and two tiles (deliveries so far / gifts received) from
 * local data. Gift NAMES only when the roadmap builder proved the pick is
 * committed; "a free product" when a gift will ship but the pick is dynamic;
 * nothing at all when no gift is behind a rung. Holdout-safe by
 * construction: the "surprise" row exists only when the teaser was sent.
 */
export function rewardsRoadmapHtml(params: {
  locale: string;
  tz: string;
  roadmap: RewardsRoadmap;
  daysSubscribed: number;
}): string {
  const { locale, tz, roadmap } = params;
  const giftText = (row: RewardsRoadmap["rows"][number]): string => {
    if (row.gift.kind === "named") {
      return t(locale, "portal.roadmap.gift_named", { title: row.gift.title });
    }
    if (row.gift.kind === "generic") return t(locale, "portal.roadmap.gift_generic");
    return "";
  };
  const items = roadmap.rows
    .map((row) => {
      const label =
        row.kind === "surprise"
          ? t(locale, "portal.roadmap.surprise", { order: row.orderNumber ?? 2 })
          : row.kind === "milestone"
            ? t(locale, "portal.roadmap.milestone", { order: row.orderNumber ?? 0 })
            : t(locale, "portal.roadmap.rewards");
      const when = row.reached
        ? t(locale, "portal.roadmap.reached")
        : row.aroundDate
          ? t(locale, "portal.roadmap.around", {
              date: formatShopDate(row.aroundDate, tz, locale),
            })
          : "";
      const gift = row.kind === "surprise" ? "" : giftText(row);
      const meta = [when, gift].filter(Boolean).join(" · ");
      const mark = row.reached ? "&#10003;" : "&#9675;";
      return `<li class="cxs-roadmap__row${row.reached ? " cxs-roadmap__row--done" : ""}"><span class="cxs-roadmap__mark" aria-hidden="true">${mark}</span><span class="cxs-roadmap__label">${escapeHtml(label)}</span>${meta ? `<span class="cxs-muted cxs-small cxs-roadmap__meta">${escapeHtml(meta)}</span>` : ""}</li>`;
    })
    .join("");
  return `<section class="cxs-rewards cxs-roadmap">
  <h2>${escapeHtml(t(locale, "portal.rewards.title"))}</h2>
  <div class="cxs-rewards__grid">
    <div class="cxs-rewards__cell"><div class="cxs-rewards__num">${params.daysSubscribed}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.rewards.days_subscribed"))}</div></div>
    <div class="cxs-rewards__cell"><div class="cxs-rewards__num">${roadmap.deliveriesSoFar}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.roadmap.deliveries_so_far"))}</div></div>
    <div class="cxs-rewards__cell"><div class="cxs-rewards__num">${roadmap.giftsReceived}</div><div class="cxs-muted cxs-small">${escapeHtml(t(locale, "portal.roadmap.gifts_received"))}</div></div>
  </div>
  <ul class="cxs-roadmap__list" aria-label="${escapeHtml(t(locale, "portal.roadmap.list_label"))}">${items}</ul>
</section>`;
}

/**
 * THE rewards card for a customer's contracts (home: all of them; single
 * mode on the subscription page: the one). Days subscribed from the oldest
 * start; the roadmap anchored on the primary contract (the ACTIVE / PAUSED
 * one furthest along, else the first); the classic strip when the roadmap is
 * off or fails (contained). Empty string when there is no contract.
 */
export async function rewardsSectionHtml(input: {
  shopId: string;
  tz: string;
  locale: string;
  customerId: string;
  contracts: RewardsCardContract[];
  lifecycle: {
    milestoneGiftCycle: number;
    milestoneLadder: readonly number[];
    rewardsUnlockDay: number;
    rewardsGiftEnabled?: boolean;
  };
  growth: { rewardsRoadmap: boolean };
  now?: Date;
}): Promise<string> {
  const { contracts, lifecycle, growth, locale, tz } = input;
  if (contracts.length === 0) return "";
  const now = input.now ?? new Date();

  // ── Rewards strip: days subscribed, milestone + rewards unlock ─────────
  const startTimes = contracts.map((c) =>
    (c.firstChargeAt ?? c.createdAt).getTime(),
  );
  const daysSubscribed = Math.max(
    0,
    Math.floor((now.getTime() - Math.min(...startTimes)) / 86_400_000),
  );
  const maxOrders = Math.max(...contracts.map((c) => c.ordersCount), 0);

  const [rewardsEvent, milestoneGrant] = await Promise.all([
    prisma.subscriberEvent.findFirst({
      where: {
        shopId: input.shopId,
        customerId: input.customerId,
        type: "lifecycle.rewards_unlocked",
      },
      select: { id: true },
    }),
    prisma.giftGrant.findFirst({
      where: {
        contractId: { in: contracts.map((c) => c.id) },
        status: { in: ["ADDED", "SHIPPED"] },
        rule: {
          is: {
            trigger: "ORDER_INDEX",
            orderIndex: lifecycle.milestoneGiftCycle,
          },
        },
      },
      select: { id: true },
    }),
  ]);

  // Rewards roadmap (v1.28.0, P4.3, portalGrowth.rewardsRoadmap): the
  // strip becomes the full ladder with projected dates, anchored on the
  // customer's primary contract (the ACTIVE one furthest along — rung
  // dates are per contract). Off, or the roadmap failing: the classic
  // three-tile strip.
  let roadmapHtml = "";
  if (growth.rewardsRoadmap) {
    const primary =
      [...contracts]
        .filter((c) => c.status === "ACTIVE" || c.status === "PAUSED")
        .sort((a, b) => b.ordersCount - a.ordersCount)[0] ?? contracts[0];
    try {
      // The upcoming Shopify cycle index (THE hint every per-cycle read
      // uses) lets the builder name a rung whose gift is already
      // SCHEDULED/ADDED on the next order; contained — null keeps the
      // config-based label.
      let upcomingCycleIndex: number | null = null;
      try {
        upcomingCycleIndex = await nextCycleIndex(primary);
      } catch (err) {
        console.error("[portal] roadmap: upcoming cycle index failed", primary.id, err);
      }
      const roadmap = await buildRewardsRoadmap({
        shopId: input.shopId,
        tz,
        contract: primary,
        lifecycle,
        now,
        teaserPromised: await teaserPromisedFor(primary.id),
        rewardsUnlockedEvent: rewardsEvent !== null,
        upcomingCycleIndex,
      });
      roadmapHtml = rewardsRoadmapHtml({
        locale,
        tz,
        roadmap,
        daysSubscribed,
      });
    } catch (err) {
      console.error("[portal] rewards roadmap failed", err);
    }
  }
  return roadmapHtml || rewardsStripHtml({
    locale,
    daysSubscribed,
    maxOrders,
    milestoneCycle: lifecycle.milestoneGiftCycle,
    rewardsUnlockDay: lifecycle.rewardsUnlockDay,
    rewardsUnlocked:
      rewardsEvent !== null || daysSubscribed >= lifecycle.rewardsUnlockDay,
    milestoneReached:
      milestoneGrant !== null || maxOrders >= lifecycle.milestoneGiftCycle,
  });
}
