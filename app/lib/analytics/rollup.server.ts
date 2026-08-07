import prisma from "~/db.server";
import { toZonedTime, format as formatTz } from "date-fns-tz";
import { shopDayStartUtc, addDaysTz } from "~/lib/dates.server";
import {
  COUNTABLE_CONTRACT,
  OPEN_DUNNING_STATES,
  computeMrrCents,
  originPaymentCountsOnce,
  perCycleDiscountCents,
  requireShopById,
} from "./queries.server";
import {
  loadCostContext,
  paymentFeeCents,
  perCycleLineCosts,
  perShipmentCostCents,
} from "./costs.server";

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

/**
 * Contract-scoped counted events. Every emitter attaches the contract
 * (identity()/eventIdentity()), so these are counted THROUGH the contract
 * relation with COUNTABLE_CONTRACT — a demo-portal cancel-flow or skip
 * interaction (demo contract) or a foreign contract's event can never inflate
 * the rollup columns. checkout.subscribable is deliberately NOT here: it fires
 * before any contract exists, carries no contractId, and is counted separately
 * without the join.
 */
const CONTRACT_EVENT_TYPES = [
  "cycle.skipped",
  "cancel.save_shown",
  "cancel.save_accepted",
  "cycle.addon_added",
];

/**
 * Compute and upsert the DailyRollup for the shop-tz day containing `dayUtc`.
 *
 * Metric formulas:
 * - activeSubscribers / pausedSubscribers / prepaidActive: live status counts
 *   at compute time (snapshot semantics — re-running an old day re-snapshots).
 * - newSubscribers: contracts whose ARRIVAL (firstChargeAt ?? createdAt) falls
 *   in the day window. createdAt alone is the local mirror-creation instant,
 *   so imports/backfills would register fake signup spikes on import day;
 *   firstChargeAt is backfilled from the origin order's real date.
 * - churnedVoluntary: cancelledAt in day AND cancelSource CUSTOMER or ADMIN.
 * - churnedInvoluntary: cancelledAt in day AND cancelSource DUNNING, PLUS
 *   contracts that entered status FAILED in day (failedAt in window). With the
 *   default dunning setting (exhaustedAction PAUSE) an exhausted ladder leaves
 *   the contract FAILED with no cancelledAt at all — without the failedAt leg,
 *   payment churn would be structurally invisible. A FAILED contract that is
 *   later cancelled counts once here (its failedAt day) and in `cancels` on
 *   its cancelledAt day, but never twice in the involuntary column.
 * - cancels: all contracts with cancelledAt in day (any source, incl. SYSTEM/null).
 * - mrrCents: see computeMrrCents (Σ ACTIVE cycle totals × cyclesPerMonth from
 *   the exact billing cadence, shop-currency contracts only).
 * - chargedCents: Σ BillingAttempt.amountCents where SUCCESS, completedAt in
 *   day, currencyCode = shop currency (or unset), PLUS origin (checkout)
 *   payments — SubscriptionContract.originOrderTotalCents of countable
 *   contracts whose originOrderProcessedAt falls in the day (migration 0006).
 *   Mixed-currency attempts/origin totals are excluded rather than summed
 *   raw, and an origin order that somehow also has a successful
 *   BillingAttempt counts ONCE (the attempt wins — originPaymentCountsOnce
 *   in queries.server.ts is the single precedence rule both revenue surfaces
 *   share). Origin payments are booked on the day they PROCESSED: captured on
 *   the create webhook that is today (inside the trailing recompute window);
 *   a LATE capture (origin_order_backfill) whose processed day has already
 *   left the recompute/backfill window stays out of that closed rollup row —
 *   closed days keep their snapshots — while the cohort triangle, which
 *   recomputes from source, always includes it.
 * - refundedCents: Σ refund amounts RECORDED in day (admin.action events with
 *   payload.action "refund_recorded", written by the REFUNDS_CREATE webhook —
 *   renewal AND origin-order refunds alike). Attributed to the refund day,
 *   not the charge day, so closed rollup days are never rewritten. Scoped
 *   through the contract relation with COUNTABLE_CONTRACT (the writer already
 *   guards ownership, but the read-side join keeps refunds consistent with
 *   chargedCents if a contract is later reclassified and the day recomputed).
 * - discountCents: per successful attempt, Σ non-gift lines of
 *   max(0, compareAt − current) × qty where compareAt is known. This is the
 *   simple estimate the spec asks for; per-cycle DiscountGrant extras are
 *   already reflected in the (lower) charged amount and are not re-derived.
 *   Lines are read as they exist now — a close mirror of what was billed.
 *   Origin payments add their mirrored order-level discount total
 *   (originOrderDiscountCents) instead — money-true, no estimation.
 * - billed COGS: per successful attempt via the shared cost model
 *   (app/lib/analytics/costs.server.ts): synced Shopify cost → merchant
 *   override → cogsFallbackPctOfPrice estimate. estimatedCogsCents stores the
 *   estimated share (COGS-coverage stat). Prepaid charges multiply line COGS
 *   by deliveries-per-charge (one charge ships N deliveries).
 * - shippingCostCents: merchant-side fulfillment + carrier cost per shipment
 *   from the cost model × shipments (prepaid: deliveries-per-charge). This is
 *   what the MERCHANT pays — customer-paid delivery stays inside chargedCents
 *   as revenue and is never used as a cost.
 * - feesCents: payment processing fees per successful charge (cost model).
 * - giftCogsCents: GiftGrants flipped to ADDED in day × their rule's
 *   unitCostCents (fallback: the merchant's per-product COGS override for the
 *   gift variant when the rule is gone).
 * - estGrossProfitCents = chargedCents − refundedCents − billedCogs −
 *   giftCogsCents − shippingCostCents − feesCents — the SAME formula the
 *   cohort cells use, so the two gross-profit surfaces reconcile.
 *   discountCents is NOT subtracted: chargedCents is already net of every
 *   discount. It is stored alongside for reporting.
 * - failedAttempts: FAILED attempts with completedAt in day.
 * - recoveredCents: Σ DunningCase.recoveredCents resolved RECOVERED in day.
 * - openDunningCases: snapshot count of open-state cases.
 * - skips / savesOffered / savesAccepted / addonsAttached: SubscriberEvent
 *   counts (cycle.skipped / cancel.save_shown / cancel.save_accepted /
 *   cycle.addon_added) in the day window, joined to COUNTABLE contracts only
 *   (see CONTRACT_EVENT_TYPES) — demo-portal interactions never count.
 * - takeRateNum: newSubscribers (subscription checkouts that became contracts).
 * - takeRateDen: "checkout.subscribable" events in day (see const above) —
 *   contract-less by nature, counted without the ownership join.
 *
 * Every contract-relation filter spreads COUNTABLE_CONTRACT (ours + non-demo)
 * so demo fixtures and foreign-app contracts can never leak into any metric.
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

  const costCtx = await loadCostContext(shopId);

  const [
    statusGroups,
    prepaidActive,
    newSubscribers,
    churnGroups,
    failedInDay,
    mrrCents,
    successfulAttempts,
    originContracts,
    refundEvents,
    giftGrants,
    failedAttempts,
    recoveredAgg,
    openDunningCases,
    eventGroups,
    checkoutEvents,
  ] = await Promise.all([
    prisma.subscriptionContract.groupBy({
      by: ["status"],
      where: { shopId, ...COUNTABLE_CONTRACT },
      _count: { _all: true },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", ...COUNTABLE_CONTRACT, isPrepaid: true },
    }),
    prisma.subscriptionContract.count({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        OR: [
          { firstChargeAt: window },
          { firstChargeAt: null, createdAt: window },
        ],
      },
    }),
    prisma.subscriptionContract.groupBy({
      by: ["cancelSource"],
      where: { shopId, ...COUNTABLE_CONTRACT, cancelledAt: window },
      _count: { _all: true },
    }),
    // Dunning-exhausted contracts (status FAILED, never cancelled) — the
    // involuntary churn the cancelSource column cannot see.
    prisma.subscriptionContract.count({
      where: { shopId, ...COUNTABLE_CONTRACT, status: "FAILED", failedAt: window },
    }),
    computeMrrCents(shopId, shop.currencyCode),
    prisma.billingAttempt.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "SUCCESS",
        completedAt: window,
      },
      select: {
        amountCents: true,
        currencyCode: true,
        contract: {
          select: {
            deliveryPriceCents: true,
            isPrepaid: true,
            prepaidDeliveriesPerCharge: true,
            lines: {
              select: {
                productId: true,
                variantId: true,
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
    // Origin (checkout) payments booked in the day window (migration 0006):
    // countable contracts whose captured origin payment PROCESSED in-day.
    // Accumulated below with the same cost model as billed cycles, guarded
    // against double counting by originPaymentCountsOnce.
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        originOrderTotalCents: { not: null },
        originOrderProcessedAt: window,
      },
      select: {
        id: true,
        originOrderId: true,
        originOrderTotalCents: true,
        originOrderDiscountCents: true,
        originOrderProcessedAt: true,
        originOrderCurrencyCode: true,
        deliveryPriceCents: true,
        isPrepaid: true,
        prepaidDeliveriesPerCharge: true,
        lines: {
          select: {
            productId: true,
            variantId: true,
            quantity: true,
            currentPriceCents: true,
            compareAtPriceCents: true,
            unitCostCents: true,
            isGift: true,
          },
        },
      },
    }),
    // Refunds recorded in the window (REFUNDS_CREATE webhook → admin.action
    // event with payload.action "refund_recorded" + amountCents). The writer
    // always attaches the refunded attempt's contract, so the COUNTABLE join
    // mirrors the chargedCents scoping exactly.
    prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: "admin.action",
        createdAt: window,
        payload: { path: ["action"], equals: "refund_recorded" },
        contract: { is: { ...COUNTABLE_CONTRACT } },
      },
      select: { payload: true },
    }),
    prisma.giftGrant.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "ADDED",
        addedAt: window,
      },
      select: { variantId: true, rule: { select: { unitCostCents: true } } },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "FAILED",
        completedAt: window,
      },
    }),
    prisma.dunningCase.aggregate({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        resolution: "RECOVERED",
        resolvedAt: window,
      },
      _sum: { recoveredCents: true },
    }),
    prisma.dunningCase.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        state: { in: OPEN_DUNNING_STATES },
      },
    }),
    prisma.subscriberEvent.groupBy({
      by: ["type"],
      where: {
        shopId,
        createdAt: window,
        type: { in: CONTRACT_EVENT_TYPES },
        contract: { is: { ...COUNTABLE_CONTRACT } },
      },
      _count: { _all: true },
    }),
    // Take-rate denominator: checkout events precede any contract, so no
    // ownership join is possible (or needed — the demo portal never emits them).
    prisma.subscriberEvent.count({
      where: { shopId, createdAt: window, type: CHECKOUT_SUBSCRIBABLE_EVENT },
    }),
  ]);

  const statusCount = (status: string) =>
    statusGroups.find((g) => g.status === status)?._count._all ?? 0;
  const eventCount = (type: string) =>
    eventGroups.find((g) => g.type === type)?._count._all ?? 0;

  let churnedVoluntary = 0;
  let churnedInvoluntary = failedInDay;
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
  let estimatedCogsCents = 0;
  let shippingCostCents = 0;
  let feesCents = 0;
  for (const attempt of successfulAttempts) {
    // Currency guard: cents are only additive within one currency. Attempts in
    // another presentment currency are excluded rather than summed raw.
    if (attempt.currencyCode && attempt.currencyCode !== shop.currencyCode) {
      continue;
    }
    const amount = attempt.amountCents ?? 0;
    const deliveries = attempt.contract.isPrepaid
      ? Math.max(1, attempt.contract.prepaidDeliveriesPerCharge ?? 1)
      : 1;
    chargedCents += amount;
    discountCents += perCycleDiscountCents(attempt.contract.lines);
    // Gift-line COGS is excluded here — it is accounted via giftCogsCents.
    const costs = perCycleLineCosts(attempt.contract.lines, costCtx, {
      includeGifts: false,
    });
    billedCogsCents += costs.cogsCents * deliveries;
    estimatedCogsCents += costs.estimatedCogsCents * deliveries;
    shippingCostCents +=
      perShipmentCostCents(costCtx.costModel, attempt.contract.deliveryPriceCents) *
      deliveries;
    feesCents += paymentFeeCents(amount, costCtx.costModel);
  }

  // ── Origin (checkout) payments booked on their processed day ───────────────
  // Double-count guard: an origin order that ALSO produced a successful
  // BillingAttempt (should not exist, but nothing structurally prevents it)
  // must count ONCE — originPaymentCountsOnce skips the origin mirror when a
  // successful attempt claims the same order id. The lookup is scoped to the
  // exact origin order ids in-day, so it costs nothing on a normal day.
  let originAttemptOrderIds = new Set<string>();
  const inDayOriginOrderIds = originContracts
    .map((c) => c.originOrderId)
    .filter((id): id is string => id != null);
  if (inDayOriginOrderIds.length > 0) {
    const claimedByAttempts = await prisma.billingAttempt.findMany({
      where: {
        status: "SUCCESS",
        orderId: { in: inDayOriginOrderIds },
        contract: { shopId, ...COUNTABLE_CONTRACT },
      },
      select: { orderId: true },
    });
    originAttemptOrderIds = new Set(
      claimedByAttempts
        .map((a) => a.orderId)
        .filter((id): id is string => id != null),
    );
  }

  for (const contract of originContracts) {
    if (
      !originPaymentCountsOnce(contract, originAttemptOrderIds, shop.currencyCode)
    ) {
      continue;
    }
    const amount = contract.originOrderTotalCents ?? 0;
    const deliveries = contract.isPrepaid
      ? Math.max(1, contract.prepaidDeliveriesPerCharge ?? 1)
      : 1;
    chargedCents += amount;
    // Order-level discount total mirrored from Shopify (already money-true —
    // no per-line estimation needed for the origin payment).
    discountCents += Math.max(0, contract.originOrderDiscountCents ?? 0);
    // COGS approximation (documented): the contract's CURRENT lines stand in
    // for the origin order's lines — same approximation billed cycles accept.
    const costs = perCycleLineCosts(contract.lines, costCtx, {
      includeGifts: false,
    });
    billedCogsCents += costs.cogsCents * deliveries;
    estimatedCogsCents += costs.estimatedCogsCents * deliveries;
    shippingCostCents +=
      perShipmentCostCents(costCtx.costModel, contract.deliveryPriceCents) *
      deliveries;
    feesCents += paymentFeeCents(amount, costCtx.costModel);
  }

  let refundedCents = 0;
  for (const event of refundEvents) {
    const payload = event.payload as { amountCents?: unknown } | null;
    if (typeof payload?.amountCents === "number" && payload.amountCents > 0) {
      refundedCents += Math.round(payload.amountCents);
    }
  }

  // Gift COGS: the rule's cost, else the merchant's per-product override for
  // the gifted variant (rule deleted / manual grant), else 0.
  const overrideByVariant = new Map<string, number>();
  for (const [key, cents] of costCtx.overrides.byVariant) {
    overrideByVariant.set(key.split("|")[1] ?? key, cents);
  }
  const giftCogsCents = giftGrants.reduce(
    (sum, g) =>
      sum + (g.rule?.unitCostCents ?? overrideByVariant.get(g.variantId) ?? 0),
    0,
  );

  const estGrossProfitCents =
    chargedCents -
    refundedCents -
    billedCogsCents -
    giftCogsCents -
    shippingCostCents -
    feesCents;

  const data = {
    activeSubscribers: statusCount("ACTIVE"),
    pausedSubscribers: statusCount("PAUSED"),
    newSubscribers,
    churnedVoluntary,
    churnedInvoluntary,
    mrrCents,
    chargedCents,
    refundedCents,
    discountCents,
    giftCogsCents,
    shippingCostCents,
    feesCents,
    estimatedCogsCents,
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
    takeRateDen: checkoutEvents,
    prepaidActive,
  };

  return prisma.dailyRollup.upsert({
    where: { shopId_date: { shopId, date: dayKey } },
    create: { shopId, date: dayKey, ...data },
    update: data,
  });
}
