import prisma from "~/db.server";
import { toZonedTime, format as formatTz } from "date-fns-tz";
import { shopDayStartUtc, addDaysTz } from "~/lib/dates.server";
import {
  COUNTABLE_CONTRACT,
  OPEN_DUNNING_STATES,
  computeMrrCents,
  contractTaxCountry,
  originPaymentCountsOnce,
  perCycleDiscountCents,
  requireShopById,
  shopDayLabelUtc,
  utcDayKey,
} from "./queries.server";
import {
  loadCostContext,
  parseChargeCostSnapshot,
  paymentFeeCents,
  perCycleLineCosts,
  perShipmentCostCents,
  resolveChargeVat,
} from "./costs.server";
import { getSetting } from "~/lib/settings/settings.server";

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
  "cancel.final_offer_shown",
  "cancel.final_offer_accepted",
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
 *   LATE-BACKFILL REPAIR (same family as the origin-money late capture
 *   below): a contract counted via the null-firstChargeAt arm whose
 *   firstChargeAt is backfilled LATER by a webhook sync moves to its real
 *   (earlier) arrival day. The writer (contracts/sync.server.ts) re-upserts
 *   both affected day labels when it backfills firstChargeAt — in backfill
 *   mode, so an existing row's snapshots survive (see the upsert below).
 *   RESIDUAL, accepted: an arrival day that predates the shop's first rollup
 *   row is never synthesized (no pre-analytics history), so such arrivals
 *   stay visible only in cohorts (full recompute) and the dashboard weekly
 *   series (live query); the rollup/takeRateNum under-reads exactly those.
 * - churnedVoluntary: cancelledAt in day AND cancelSource CUSTOMER, ADMIN or
 *   EXTERNAL (a Shopify-side cancel first observed by the sync — somebody
 *   chose it, the same non-DUNNING-is-voluntary rule survival applies),
 *   PLUS contracts that entered status EXPIRED in day (expiredAt in window,
 *   stamped since migration 0016). EXPIRED = billingMaxCycles ran out — the
 *   subscriber signed up for a bounded plan and completed it, a scheduled end
 *   rather than a payment failure, so all three retention surfaces (rollup,
 *   cohort activeRemaining, survival curves) classify it as VOLUNTARY churn.
 *   Contracts that expired before 0016 carry no expiredAt and stay uncounted
 *   (the instant was never recorded and cannot be reconstructed).
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
 *   REFUND EXCLUSION (v1.16.0, analytics.excludeRefundedPayments — ON by
 *   default): payments with ANY recorded refund (attempt.refundedCents /
 *   originOrderRefundedCents > 0, partial or full) are dropped from
 *   chargedCents and every derived cost column, instead of the off-mode
 *   netting. Because a refund usually lands days after its charge, the job
 *   runner additionally re-upserts the CHARGE days of recently recorded
 *   refunds in flow-columns-only mode (runner.server.ts repair pass —
 *   snapshots survive, exactly like the firstChargeAt-backfill repair
 *   above), so the ledger converges on excluding the payment even when the
 *   charge day had already closed.
 * - refundedCents: Σ refund amounts RECORDED in day (admin.action events with
 *   payload.action "refund_recorded", written by the REFUNDS_CREATE webhook —
 *   renewal AND origin-order refunds alike). Attributed to the refund day,
 *   not the charge day, so closed rollup days are never rewritten. Scoped
 *   through the contract relation with COUNTABLE_CONTRACT (the writer already
 *   guards ownership, but the read-side join keeps refunds consistent with
 *   chargedCents if a contract is later reclassified and the day recomputed).
 *   Currency guard mirrors chargedCents: a refund whose payload.currencyCode
 *   differs from the shop currency is excluded (its matching charge was never
 *   summed either) and counted into excludedForeignCurrencyCents; a payload
 *   with no currencyCode passes — mismatch must be provable (the writer has
 *   stamped currencyCode on every refund_recorded payload it emits; this is
 *   legacy tolerance). No over-refund clamp: refunds book on their recorded
 *   day with no join back to the charge, so a refund exceeding the mirrored
 *   total books in full here while the cohort surface clamps at the captured
 *   amount — in that (anomalous) case the day ledger reads lower than the
 *   cohort month by the excess. Accepted divergence: clamping here would
 *   require cross-day charge state the day-scoped recompute cannot see.
 *   Under refund exclusion the column keeps being written (disclosure: how
 *   much was refunded that day) but no longer participates in
 *   estGrossProfitCents — the excluded charges never entered chargedCents,
 *   so subtracting their refunds too would double-drop the money.
 * - discountCents: per successful attempt, the money-true discountCents
 *   captured onto the attempt at settlement (migration 0016) when present;
 *   attempts settled before 0016 fall back to the mirror-line estimate —
 *   Σ non-gift lines of max(0, compareAt − current) × qty where compareAt is
 *   known, lines read as they exist now. Per-cycle DiscountGrant extras are
 *   already reflected in the (lower) charged amount and are not re-derived.
 *   Origin payments add their mirrored order-level discount total
 *   (originOrderDiscountCents) instead — money-true, no estimation.
 * - billed COGS: per successful attempt, PREFER the cost basis frozen into
 *   BillingAttempt.costSnapshot at settlement (migration 0016) — history must
 *   not be repriced by later cost-setting edits. Attempts with no parseable
 *   snapshot (pre-0016) keep the live shared cost model
 *   (app/lib/analytics/costs.server.ts): synced Shopify cost → merchant
 *   override → cogsFallbackPctOfPrice estimate. estimatedCogsCents stores the
 *   estimated share (COGS-coverage stat). Prepaid charges multiply line COGS
 *   by deliveries-per-charge (one charge ships N deliveries).
 * - shippingCostCents: from the same stored snapshot (shipping + fulfillment
 *   legs) when present, else merchant-side fulfillment + carrier cost per
 *   shipment from the cost model × shipments (prepaid: deliveries-per-charge).
 *   This is what the MERCHANT pays — customer-paid delivery stays inside
 *   chargedCents as revenue and is never used as a cost.
 * - feesCents: payment processing fees per successful charge, always computed
 *   at read time on the charged amount (never snapshotted — they derive from
 *   amountCents, which the attempt row already keeps immutable).
 * - vatCents (migration 0019): VAT booked against the day's charges while
 *   the costModel.vat setting is enabled (0 otherwise). Per charge —
 *   attempt or origin payment — a flat percentage of the charged amount,
 *   amount × rate/100 (v1.16.0, merchant-defined: VAT is an expense that is
 *   a straight percentage of revenue; captured order tax keeps being
 *   collected but no longer drives the deduction), at the contract's tax
 *   country rate (contractTaxCountry: delivery address, else acquisition
 *   country, else the default rate) — resolveChargeVat in costs.server.ts.
 *   Like fees, VAT computes at read time on the charged amount, so this day
 *   ledger books each charge's FULL tax on its charge day and deliberately
 *   does NOT credit VAT back on a later refund's recorded day — the cohort
 *   surface nets refunds per charge and carries the refund-adjusted VAT
 *   (same family of accepted day-ledger divergence as the over-refund rule
 *   above). estimatedVatCents mirrors the rate-derived share — since
 *   v1.16.0 every non-zero deduction (all VAT is modeled from configured
 *   rates; the estimatedCogsCents disclosure pattern).
 * - giftCogsCents: GiftGrants ATTACHED in day (addedAt in window) × their
 *   rule's unitCostCents (fallback: the merchant's per-product COGS override
 *   for the gift variant when the rule is gone). Status filter accepts the
 *   whole shipped lifecycle — ADDED, SHIPPED, and REMOVED-after-ship
 *   (shippedAt set): settlement flips ADDED→SHIPPED the day the cycle bills
 *   and daily mirror hygiene flips SHIPPED→REMOVED, so filtering on the
 *   transient ADDED alone erased every pre-charge-attached gift's COGS from
 *   the trailing recompute. Supersede-retired grants (REMOVED with no
 *   shippedAt — never shipped) stay excluded.
 * - estGrossProfitCents = chargedCents − refundedCents − billedCogs −
 *   giftCogsCents − shippingCostCents − feesCents − vatCents — the SAME
 *   formula the cohort cells use, so the two gross-profit surfaces
 *   reconcile. discountCents is NOT subtracted: chargedCents is already net
 *   of every discount. It is stored alongside for reporting.
 * - failedAttempts: FAILED attempts with completedAt in day.
 * - recoveredCents: Σ DunningCase.recoveredCents over cases resolved in day
 *   that carry money (recoveredCents non-null). THE "recovered" definition —
 *   money actually collected on a case that had a failure, regardless of
 *   resolution kind: the engine stamps recoveredCents on RECOVERED and on
 *   same-cycle CUSTOMER_FIXED (attempt #1 succeeds after e.g. a 3DS
 *   challenge — real money), and null on cross-cycle CUSTOMER_FIXED closes
 *   (the old cycle was never collected). getDashboardStats'
 *   recoveredThisMonthCents applies the SAME predicate, so the two surfaces
 *   labelled "recovered" reconcile. Currency guard through the recovered
 *   attempt (DunningCase stores no currency of its own): a recovery charged
 *   in a non-shop currency is excluded, mirroring chargedCents; an unprovable
 *   currency (no recoveredAttemptId / attempt without currencyCode) counts —
 *   mismatch must be provable. Not added to excludedForeignCurrencyCents:
 *   that column audits the revenue surface, and a foreign recovery's money is
 *   already counted there via its (excluded) attempt.
 * - openDunningCases: snapshot count of open-state cases.
 * - skips / savesOffered / savesAccepted / addonsAttached: SubscriberEvent
 *   counts in the day window, joined to COUNTABLE contracts only (see
 *   CONTRACT_EVENT_TYPES) — demo-portal interactions never count.
 *   savesOffered/savesAccepted fold the step-4 final offer in
 *   (cancel.save_shown + cancel.final_offer_shown / cancel.save_accepted +
 *   cancel.final_offer_accepted): the cancel engine logs the final offer
 *   under its own event types, and the CancelSession-based cancel-flow page
 *   counts FINAL saves — the daily ledger must agree with it.
 * - takeRateNum: newSubscribers (subscription checkouts that became
 *   contracts). UNIT MISMATCH, documented: the numerator counts CONTRACTS
 *   while takeRateDen counts ORDERS — a multi-selling-plan checkout creates
 *   several contracts against one denominator event, so per-day ratios can
 *   exceed 100%. The two sides also book on different clocks (den at event
 *   log time, num on firstChargeAt), so range sums, not single days, are the
 *   meaningful read (getFunnelMetrics sums both over the range).
 * - takeRateDen: "checkout.subscribable" events in day (see const above) —
 *   contract-less by nature, counted without the ownership join.
 * - excludedForeignCurrencyCents (migration 0016): Σ money the currency
 *   guards dropped from this row — foreign-presentment attempts, origin
 *   totals and refund events. Raw foreign cents (possibly mixed currencies) —
 *   an audit signal that the day's totals are incomplete and by roughly how
 *   much, never money math. Zero on single-currency shops.
 * - snapshotFabricated (migration 0016): true when the row was CREATED by a
 *   gap backfill (opts.backfill) — the point-in-time snapshot columns
 *   (activeSubscribers, pausedSubscribers, mrrCents, openDunningCases,
 *   prepaidActive) cannot be reconstructed for a past day, so they are left
 *   at 0 instead of stamping TODAY's book onto yesterday's row; flow columns
 *   recompute from source exactly as on a normal run. The forecast treats
 *   fabricated days as carry-forward-filled, not observed. When a backfill
 *   run lands on a day that ALREADY has a row (a repair re-upsert), the
 *   existing snapshots and flag are preserved — only flow columns update.
 *
 * Every contract-relation filter spreads COUNTABLE_CONTRACT (ours + non-demo)
 * so demo fixtures and foreign-app contracts can never leak into any metric.
 *
 * Derived analytics writes are intentionally not event-logged: no canonical
 * event type exists for recomputation and per-day logging would flood the
 * Klaviyo outbox. Idempotent: upserts on (shopId, date).
 */
export async function runDailyRollup(
  shopId: string,
  dayUtc: Date,
  opts: { backfill?: boolean } = {},
) {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  // Gap backfill of a missed past day: snapshot columns are point-in-time
  // reads and would report the CURRENT book, not that day's — skip them (they
  // stay 0) and flag the row instead of fabricating history silently.
  const backfill = opts.backfill === true;

  const dayStart = shopDayStartUtc(dayUtc, tz);
  const dayEnd = addDaysTz(dayStart, 1, tz);
  const dayKey = new Date(
    `${formatTz(toZonedTime(dayUtc, tz), "yyyy-MM-dd", { timeZone: tz })}T00:00:00.000Z`,
  );
  const window = { gte: dayStart, lt: dayEnd };

  const costCtx = await loadCostContext(shopId);
  // Data-accuracy option (v1.16.0, ON by default): drop fully AND partially
  // refunded payments from the ledger entirely — see the analytics settings
  // doc (registry.server.ts) and the estGrossProfitCents note below.
  const { excludeRefundedPayments } = await getSetting(shopId, "analytics");

  const [
    statusGroups,
    prepaidActive,
    newSubscribers,
    churnGroups,
    failedInDay,
    expiredInDay,
    mrrCents,
    successfulAttempts,
    originContracts,
    refundEvents,
    giftGrants,
    failedAttempts,
    recoveredCases,
    openDunningCases,
    eventGroups,
    checkoutEvents,
  ] = await Promise.all([
    // Snapshot columns (see doc): unreconstructable on a backfilled past day.
    backfill
      ? []
      : prisma.subscriptionContract.groupBy({
          by: ["status"],
          where: { shopId, ...COUNTABLE_CONTRACT },
          _count: { _all: true },
        }),
    backfill
      ? 0
      : prisma.subscriptionContract.count({
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
    // Completed bounded plans (status EXPIRED, expiredAt stamped since 0016)
    // — voluntary churn: the shared EXPIRED classification all three
    // retention surfaces apply (see churnedVoluntary doc above).
    prisma.subscriptionContract.count({
      where: { shopId, ...COUNTABLE_CONTRACT, status: "EXPIRED", expiredAt: window },
    }),
    backfill ? 0 : computeMrrCents(shopId, shop.currencyCode),
    prisma.billingAttempt.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "SUCCESS",
        completedAt: window,
      },
      select: {
        amountCents: true,
        refundedCents: true,
        currencyCode: true,
        discountCents: true,
        taxCents: true,
        costSnapshot: true,
        contract: {
          select: {
            deliveryPriceCents: true,
            isPrepaid: true,
            prepaidDeliveriesPerCharge: true,
            deliveryAddress: true,
            acqCountryCode: true,
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
        originOrderTaxCents: true,
        originOrderRefundedCents: true,
        originOrderProcessedAt: true,
        originOrderCurrencyCode: true,
        deliveryPriceCents: true,
        isPrepaid: true,
        prepaidDeliveriesPerCharge: true,
        deliveryAddress: true,
        acqCountryCode: true,
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
    // Gift lifecycle (see giftCogsCents doc): a grant's status is transient
    // (ADDED → SHIPPED at settlement → REMOVED by daily mirror hygiene), so
    // the filter keys on the durable facts — attached in-day, and either not
    // yet cleared or provably shipped (shippedAt survives the REMOVED flip).
    prisma.giftGrant.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        addedAt: window,
        OR: [
          { status: { in: ["ADDED", "SHIPPED"] } },
          { shippedAt: { not: null } },
        ],
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
    // Money-carrying resolutions only (see recoveredCents doc) — the currency
    // guard joins through recoveredAttemptId below, after the fetch.
    prisma.dunningCase.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        recoveredCents: { not: null },
        resolvedAt: window,
      },
      select: { recoveredCents: true, recoveredAttemptId: true },
    }),
    backfill
      ? 0
      : prisma.dunningCase.count({
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

  // Voluntary churn: CUSTOMER/ADMIN/EXTERNAL cancels + completed bounded
  // plans (EXPIRED — the shared classification, see doc above). EXTERNAL is
  // the Shopify-admin/other-surface cancel the sync stamps when no engine
  // path claimed the cancel first — somebody chose it, so it is voluntary
  // (the same non-DUNNING-is-voluntary rule the survival curves apply);
  // before the EXTERNAL stamp existed these were collected as SYSTEM and
  // structurally invisible to both churn columns.
  let churnedVoluntary = expiredInDay;
  let churnedInvoluntary = failedInDay;
  let cancels = 0;
  for (const g of churnGroups) {
    cancels += g._count._all;
    if (
      g.cancelSource === "CUSTOMER" ||
      g.cancelSource === "ADMIN" ||
      g.cancelSource === "EXTERNAL"
    ) {
      churnedVoluntary += g._count._all;
    } else if (g.cancelSource === "DUNNING") {
      churnedInvoluntary += g._count._all;
    }
    // SYSTEM / null sources count in `cancels` but in neither churn column
    // (consolidation merges and pre-EXTERNAL history — not attributable).
  }

  let chargedCents = 0;
  let discountCents = 0;
  let billedCogsCents = 0;
  let estimatedCogsCents = 0;
  let shippingCostCents = 0;
  let feesCents = 0;
  let vatCents = 0;
  let estimatedVatCents = 0;
  // Audit counter (migration 0016): every cent a currency guard silently
  // drops below is accumulated here so the exclusion is visible and sizeable.
  let excludedForeignCurrencyCents = 0;
  for (const attempt of successfulAttempts) {
    // Refund exclusion (v1.16.0, ON by default): a payment with ANY recorded
    // refund leaves the ledger whole — revenue, costs, fees and VAT alike.
    // Checked before the currency audit: this money is out of the data
    // entirely, so it is not "otherwise-countable" foreign cents either.
    if (excludeRefundedPayments && attempt.refundedCents > 0) {
      continue;
    }
    // Currency guard: cents are only additive within one currency. Attempts in
    // another presentment currency are excluded rather than summed raw.
    if (attempt.currencyCode && attempt.currencyCode !== shop.currencyCode) {
      excludedForeignCurrencyCents += Math.max(0, attempt.amountCents ?? 0);
      continue;
    }
    const amount = attempt.amountCents ?? 0;
    chargedCents += amount;
    // Money-true captured discount (0016) when present; pre-0016 attempts
    // fall back to the mirror-line estimate.
    discountCents =
      discountCents +
      (attempt.discountCents ?? perCycleDiscountCents(attempt.contract.lines));
    // Cost basis: the settlement-frozen snapshot when present (history stays
    // priced as charged); live cost model for pre-0016 attempts. Fees always
    // compute on the charged amount at read time.
    const snapshot = parseChargeCostSnapshot(attempt.costSnapshot);
    if (snapshot) {
      billedCogsCents += snapshot.cogsCents;
      estimatedCogsCents += snapshot.estimatedCogsCents;
      shippingCostCents +=
        snapshot.shippingCostCents + snapshot.fulfillmentCostCents;
    } else {
      const deliveries = attempt.contract.isPrepaid
        ? Math.max(1, attempt.contract.prepaidDeliveriesPerCharge ?? 1)
        : 1;
      // Gift-line COGS is excluded here — it is accounted via giftCogsCents.
      const costs = perCycleLineCosts(attempt.contract.lines, costCtx, {
        includeGifts: false,
      });
      billedCogsCents += costs.cogsCents * deliveries;
      estimatedCogsCents += costs.estimatedCogsCents * deliveries;
      shippingCostCents +=
        perShipmentCostCents(
          costCtx.costModel,
          attempt.contract.deliveryPriceCents,
        ) * deliveries;
    }
    feesCents += paymentFeeCents(amount, costCtx.costModel);
    // VAT on the charged amount (see vatCents doc): captured order tax wins,
    // country-rate estimate otherwise; day ledger books the full charge-day
    // tax, refund credits live on the cohort surface.
    const vat = resolveChargeVat(
      {
        netAmountCents: amount,
        grossAmountCents: amount,
        capturedTaxCents: attempt.taxCents,
        countryCode: contractTaxCountry(attempt.contract),
      },
      costCtx.costModel,
    );
    vatCents += vat.vatCents;
    if (vat.estimated) estimatedVatCents += vat.vatCents;
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
    // Refund exclusion, mirroring the attempt loop above: a refunded origin
    // payment (any amount) leaves the ledger entirely.
    if (
      excludeRefundedPayments &&
      Math.max(0, contract.originOrderRefundedCents) > 0
    ) {
      continue;
    }
    if (
      !originPaymentCountsOnce(contract, originAttemptOrderIds, shop.currencyCode)
    ) {
      // Of countsOnce's exclusion reasons, only the currency guard silently
      // drops money — audit it. (The query already requires a captured total;
      // an attempt-claimed order's money is accounted through the attempt,
      // including its own exclusion accounting when that attempt is foreign.)
      if (
        contract.originOrderCurrencyCode != null &&
        contract.originOrderCurrencyCode !== shop.currencyCode &&
        !(
          contract.originOrderId != null &&
          originAttemptOrderIds.has(contract.originOrderId)
        )
      ) {
        excludedForeignCurrencyCents += Math.max(
          0,
          contract.originOrderTotalCents ?? 0,
        );
      }
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
    const vat = resolveChargeVat(
      {
        netAmountCents: amount,
        grossAmountCents: amount,
        capturedTaxCents: contract.originOrderTaxCents,
        countryCode: contractTaxCountry(contract),
      },
      costCtx.costModel,
    );
    vatCents += vat.vatCents;
    if (vat.estimated) estimatedVatCents += vat.vatCents;
  }

  let refundedCents = 0;
  for (const event of refundEvents) {
    const payload = event.payload as {
      amountCents?: unknown;
      currencyCode?: unknown;
    } | null;
    if (typeof payload?.amountCents !== "number" || payload.amountCents <= 0) {
      continue;
    }
    // Currency guard, mirroring the attempt guard above: a foreign-presentment
    // refund must never be subtracted from shop-currency revenue its matching
    // charge was excluded from. A payload without currencyCode passes —
    // mismatch must be provable (legacy tolerance; the writer stamps it).
    if (
      typeof payload.currencyCode === "string" &&
      payload.currencyCode !== shop.currencyCode
    ) {
      excludedForeignCurrencyCents += Math.round(payload.amountCents);
      continue;
    }
    refundedCents += Math.round(payload.amountCents);
  }

  // Recovered money, currency-guarded through the recovering attempt (the
  // case row itself stores no currency — see recoveredCents doc). Unprovable
  // currency counts; a provably foreign recovery is excluded like any other
  // foreign-presentment cents.
  let recoveredCents = 0;
  {
    const recoveredAttemptIds = recoveredCases
      .map((c) => c.recoveredAttemptId)
      .filter((id): id is string => id != null);
    const recoveredAttempts = recoveredAttemptIds.length
      ? await prisma.billingAttempt.findMany({
          where: { id: { in: recoveredAttemptIds } },
          select: { id: true, currencyCode: true },
        })
      : [];
    const currencyByAttemptId = new Map(
      recoveredAttempts.map((a) => [a.id, a.currencyCode]),
    );
    for (const kase of recoveredCases) {
      const currency = kase.recoveredAttemptId
        ? currencyByAttemptId.get(kase.recoveredAttemptId)
        : null;
      if (currency != null && currency !== shop.currencyCode) continue;
      recoveredCents += kase.recoveredCents ?? 0;
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

  // Under refund exclusion the refunded payments never entered chargedCents
  // (nor any cost column), so subtracting the day's recorded refunds AGAIN
  // would drop the money twice — refundedCents stays written as disclosure
  // but leaves the profit formula. getForecast applies the same rule to its
  // weekly net revenue; the three surfaces move in lockstep behind the flag.
  const estGrossProfitCents =
    chargedCents -
    (excludeRefundedPayments ? 0 : refundedCents) -
    billedCogsCents -
    giftCogsCents -
    shippingCostCents -
    feesCents -
    vatCents;

  // Flow columns recompute from source identically in both modes; the
  // point-in-time snapshot columns (and the fabrication flag that describes
  // them) are kept separate so backfill mode can leave an EXISTING row's
  // snapshots alone below.
  const flowData = {
    newSubscribers,
    churnedVoluntary,
    churnedInvoluntary,
    chargedCents,
    refundedCents,
    discountCents,
    giftCogsCents,
    shippingCostCents,
    feesCents,
    vatCents,
    estimatedVatCents,
    estimatedCogsCents,
    estGrossProfitCents,
    failedAttempts,
    recoveredCents,
    skips: eventCount("cycle.skipped"),
    cancels,
    // Final offers fold in — the daily save ledger counts every save surface
    // the cancel flow has (see savesOffered doc above).
    savesOffered:
      eventCount("cancel.save_shown") + eventCount("cancel.final_offer_shown"),
    savesAccepted:
      eventCount("cancel.save_accepted") +
      eventCount("cancel.final_offer_accepted"),
    addonsAttached: eventCount("cycle.addon_added"),
    takeRateNum: newSubscribers,
    takeRateDen: checkoutEvents,
    excludedForeignCurrencyCents,
  };
  const snapshotData = {
    activeSubscribers: statusCount("ACTIVE"),
    pausedSubscribers: statusCount("PAUSED"),
    mrrCents,
    openDunningCases,
    prepaidActive,
    snapshotFabricated: backfill,
  };

  return prisma.dailyRollup.upsert({
    where: { shopId_date: { shopId, date: dayKey } },
    create: { shopId, date: dayKey, ...flowData, ...snapshotData },
    // Backfill mode never overwrites an existing row's snapshots: its own
    // snapshot values are fabricated zeros, and a row that already exists
    // holds either REAL point-in-time history (zeroing it would destroy what
    // can never be recomputed and falsely flag the day fabricated) or an
    // earlier fabrication (flag already true). Callers may therefore pass
    // backfill for a repair re-upsert without first checking row existence —
    // flow columns recompute, snapshots stay what they were.
    update: backfill ? flowData : { ...flowData, ...snapshotData },
  });
}

/**
 * Refund repair (v1.16.0): re-upsert, in flow-columns-only (backfill) mode,
 * every rollup day whose figures depend on refund state — the CHARGE days of
 * refunded payments (attempt.refundedCents / originOrderRefundedCents > 0)
 * and, when `includeRefundRecordedDays` is set, the days refunds were
 * RECORDED on (their estGrossProfitCents participation differs between the
 * netting and exclusion modes). Candidates derive from STATE, not from a
 * recent-events window, so re-running is idempotent and progress can never
 * be starved by an event window aging out; days run oldest-first for
 * deterministic coverage under a cap.
 *
 * Two callers:
 * - the nightly rollup job (exclusion mode only): `since` = the standing
 *   90-day backfill window, so a refund landing after its charge day closed
 *   still removes the payment. A refund recorded more than 90 days after
 *   its charge leaves that charge day out of repair scope — the same
 *   standing window the gap backfill applies; the cohort triangle (full
 *   recompute) remains the truth for such tails.
 * - the analytics settings save (`since` null = ALL history, both refund
 *   kinds): flipping excludeRefundedPayments re-interprets what every
 *   refund-affected day means, in BOTH directions, so the toggle rewrites
 *   them under the new mode — keeping the day ledger and the
 *   rollup-fed forecast in lockstep with the freshly recomputed cohorts.
 *
 * Days before the shop's first rollup are never synthesized (the standing
 * backfill rule); `skipAfter` lets the nightly job exclude the trailing
 * window its live pass already recomputed.
 */
export async function repairRefundAffectedRollupDays(
  shopId: string,
  opts: {
    since?: Date | null;
    /** Exclusive upper bound — instants at/after it are someone else's pass. */
    skipAfter?: Date | null;
    cap?: number;
    includeRefundRecordedDays?: boolean;
  } = {},
): Promise<number> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const oldest = await prisma.dailyRollup.findFirst({
    where: { shopId },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  if (!oldest) return 0;

  const since = opts.since ?? null;
  const [refundedAttempts, refundedOrigins] = await Promise.all([
    prisma.billingAttempt.findMany({
      where: {
        contract: { shopId },
        status: "SUCCESS",
        refundedCents: { gt: 0 },
        completedAt: since ? { gte: since } : { not: null },
      },
      select: { completedAt: true },
    }),
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        originOrderRefundedCents: { gt: 0 },
        originOrderProcessedAt: since ? { gte: since } : { not: null },
      },
      select: { originOrderProcessedAt: true },
    }),
  ]);
  const instants: Date[] = [];
  for (const a of refundedAttempts) {
    if (a.completedAt) instants.push(a.completedAt);
  }
  for (const c of refundedOrigins) {
    if (c.originOrderProcessedAt) instants.push(c.originOrderProcessedAt);
  }
  if (opts.includeRefundRecordedDays) {
    const events = await prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: "admin.action",
        payload: { path: ["action"], equals: "refund_recorded" },
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      select: { createdAt: true },
    });
    for (const e of events) instants.push(e.createdAt);
  }

  const byKey = new Map<string, Date>();
  for (const instant of instants) {
    if (opts.skipAfter && instant >= opts.skipAfter) continue;
    const label = shopDayLabelUtc(instant, tz);
    if (label < oldest.date) continue;
    const key = utcDayKey(label);
    if (!byKey.has(key)) byKey.set(key, instant);
  }
  const days = [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, instant]) => instant);

  let repaired = 0;
  for (const instant of days.slice(0, opts.cap ?? days.length)) {
    await runDailyRollup(shopId, instant, { backfill: true });
    repaired += 1;
  }
  return repaired;
}
