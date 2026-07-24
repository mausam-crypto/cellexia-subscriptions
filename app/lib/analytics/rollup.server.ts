import prisma from "~/db.server";
import { toZonedTime, format as formatTz } from "date-fns-tz";
import { shopDayStartUtc, addDaysTz } from "~/lib/dates.server";
import {
  OPEN_DUNNING_STATES,
  computeMrrCents,
  perCycleCogsCents,
  perCycleDiscountCents,
  requireShopById,
} from "./queries.server";

/**
 * Daily rollup — one DailyRollup row per shop-timezone calendar day.
 *
 * The row's `date` is the synthetic UTC midnight of the shop-tz day
 * ("2026-07-23" → 2026-07-23T00:00:00Z) so the (shopId, date) key is stable
 * across DST shifts; the metric windows themselves use the real UTC instants
 * of shop-tz midnight → next midnight.
 */

/**
 * Non-canonical event type the storefront/webhooks layer may emit once per
 * checkout that contained a subscribable product. Feeds takeRateDen; until it
 * is emitted the denominator stays 0 and takeRatePct reads as unknown.
 */
const CHECKOUT_SUBSCRIBABLE_EVENT = "checkout.subscribable";

const COUNTED_EVENT_TYPES = [
  "cycle.skipped",
  "cancel.save_shown",
  "cancel.save_accepted",
  "cycle.addon_added",
  CHECKOUT_SUBSCRIBABLE_EVENT,
];

/**
 * Compute and upsert the DailyRollup for the shop-tz day containing `dayUtc`.
 *
 * Metric formulas:
 * - activeSubscribers / pausedSubscribers / prepaidActive: live status counts
 *   at compute time (snapshot semantics — re-running an old day re-snapshots).
 * - newSubscribers: contracts with createdAt in the day window.
 * - churnedVoluntary: cancelledAt in day AND cancelSource CUSTOMER or ADMIN.
 * - churnedInvoluntary: cancelledAt in day AND cancelSource DUNNING.
 * - cancels: all contracts with cancelledAt in day (any source, incl. SYSTEM/null).
 * - mrrCents: see computeMrrCents (Σ ACTIVE cycle totals × 4.345/intervalWeeks).
 * - chargedCents: Σ BillingAttempt.amountCents where SUCCESS, completedAt in day.
 * - discountCents: per successful attempt, Σ non-gift lines of
 *   max(0, compareAt − current) × qty where compareAt is known. This is the
 *   simple estimate the spec asks for; per-cycle DiscountGrant extras are
 *   already reflected in the (lower) charged amount and are not re-derived.
 *   Lines are read as they exist now — a close mirror of what was billed.
 * - giftCogsCents: GiftGrants flipped to ADDED in day × their rule's unitCostCents.
 * - estGrossProfitCents = chargedCents − line COGS of billed cycles (non-gift
 *   lines, unitCostCents × qty) − giftCogsCents. discountCents is NOT subtracted:
 *   chargedCents is already net of every discount, so subtracting it again would
 *   double count. It is stored alongside for reporting.
 * - failedAttempts: FAILED attempts with completedAt in day.
 * - recoveredCents: Σ DunningCase.recoveredCents resolved RECOVERED in day.
 * - openDunningCases: snapshot count of open-state cases.
 * - skips / savesOffered / savesAccepted / addonsAttached: SubscriberEvent
 *   counts (cycle.skipped / cancel.save_shown / cancel.save_accepted /
 *   cycle.addon_added) in the day window.
 * - takeRateNum: newSubscribers (subscription checkouts that became contracts).
 * - takeRateDen: "checkout.subscribable" events in day (see const above).
 *
 * Derived analytics writes are intentionally not event-logged: no canonical
 * event type exists for recomputation and per-day logging would flood the
 * Klaviyo outbox. Idempotent: upserts on (shopId, date).
 */
export async function runDailyRollup(shopId: string, dayUtc: Date) {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;

  const dayStart = shopDayStartUtc(dayUtc, tz);
  const dayEnd = addDaysTz(dayStart, 1, tz);
  const dayKey = new Date(
    `${formatTz(toZonedTime(dayUtc, tz), "yyyy-MM-dd", { timeZone: tz })}T00:00:00.000Z`,
  );
  const window = { gte: dayStart, lt: dayEnd };

  const [
    statusGroups,
    prepaidActive,
    newSubscribers,
    churnGroups,
    mrrCents,
    successfulAttempts,
    giftGrants,
    failedAttempts,
    recoveredAgg,
    openDunningCases,
    eventGroups,
  ] = await Promise.all([
    prisma.subscriptionContract.groupBy({
      by: ["status"],
      where: { shopId, isDemo: false },
      _count: { _all: true },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", isDemo: false, isPrepaid: true },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, isDemo: false, createdAt: window },
    }),
    prisma.subscriptionContract.groupBy({
      by: ["cancelSource"],
      where: { shopId, isDemo: false, cancelledAt: window },
      _count: { _all: true },
    }),
    computeMrrCents(shopId),
    prisma.billingAttempt.findMany({
      where: { contract: { shopId }, status: "SUCCESS", completedAt: window },
      select: {
        amountCents: true,
        contract: {
          select: {
            lines: {
              select: {
                quantity: true,
                currentPriceCents: true,
                compareAtPriceCents: true,
                unitCostCents: true,
                isGift: true,
              },
            },
          },
        },
      },
    }),
    prisma.giftGrant.findMany({
      where: { contract: { shopId }, status: "ADDED", addedAt: window },
      select: { rule: { select: { unitCostCents: true } } },
    }),
    prisma.billingAttempt.count({
      where: { contract: { shopId }, status: "FAILED", completedAt: window },
    }),
    prisma.dunningCase.aggregate({
      where: {
        contract: { shopId },
        resolution: "RECOVERED",
        resolvedAt: window,
      },
      _sum: { recoveredCents: true },
    }),
    prisma.dunningCase.count({
      where: { contract: { shopId }, state: { in: OPEN_DUNNING_STATES } },
    }),
    prisma.subscriberEvent.groupBy({
      by: ["type"],
      where: { shopId, createdAt: window, type: { in: COUNTED_EVENT_TYPES } },
      _count: { _all: true },
    }),
  ]);

  const statusCount = (status: string) =>
    statusGroups.find((g) => g.status === status)?._count._all ?? 0;
  const eventCount = (type: string) =>
    eventGroups.find((g) => g.type === type)?._count._all ?? 0;

  let churnedVoluntary = 0;
  let churnedInvoluntary = 0;
  let cancels = 0;
  for (const g of churnGroups) {
    cancels += g._count._all;
    if (g.cancelSource === "CUSTOMER" || g.cancelSource === "ADMIN") {
      churnedVoluntary += g._count._all;
    } else if (g.cancelSource === "DUNNING") {
      churnedInvoluntary += g._count._all;
    }
    // SYSTEM / null sources count in `cancels` but in neither churn column.
  }

  let chargedCents = 0;
  let discountCents = 0;
  let billedCogsCents = 0;
  for (const attempt of successfulAttempts) {
    chargedCents += attempt.amountCents ?? 0;
    discountCents += perCycleDiscountCents(attempt.contract.lines);
    // Gift-line COGS is excluded here — it is accounted via giftCogsCents.
    billedCogsCents += perCycleCogsCents(attempt.contract.lines, {
      includeGifts: false,
    });
  }

  const giftCogsCents = giftGrants.reduce(
    (sum, g) => sum + (g.rule?.unitCostCents ?? 0),
    0,
  );

  const estGrossProfitCents = chargedCents - billedCogsCents - giftCogsCents;

  const data = {
    activeSubscribers: statusCount("ACTIVE"),
    pausedSubscribers: statusCount("PAUSED"),
    newSubscribers,
    churnedVoluntary,
    churnedInvoluntary,
    mrrCents,
    chargedCents,
    discountCents,
    giftCogsCents,
    estGrossProfitCents,
    failedAttempts,
    recoveredCents: recoveredAgg._sum.recoveredCents ?? 0,
    openDunningCases,
    skips: eventCount("cycle.skipped"),
    cancels,
    savesOffered: eventCount("cancel.save_shown"),
    savesAccepted: eventCount("cancel.save_accepted"),
    addonsAttached: eventCount("cycle.addon_added"),
    takeRateNum: newSubscribers,
    takeRateDen: eventCount(CHECKOUT_SUBSCRIBABLE_EVENT),
    prepaidActive,
  };

  return prisma.dailyRollup.upsert({
    where: { shopId_date: { shopId, date: dayKey } },
    create: { shopId, date: dayKey, ...data },
    update: data,
  });
}
