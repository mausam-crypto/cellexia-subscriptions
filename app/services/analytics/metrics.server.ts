/**
 * Executive metrics [analytics].
 *
 * `getExecutiveMetrics(shop, range)` computes the full Continuous Treatment
 * KPI set from the local mirror (SubscriptionContract, BillingAttempt,
 * AnalyticsEvent, CancellationSession, AddOnItem, ProductMeta). Exact formulas
 * are documented in docs/ANALYTICS.md.
 *
 * Per the cross-service contract this module also re-exports
 * `getSurvivalCurves` (survival.server) and `getCohortTable` (cohorts.server).
 */
import prisma from "~/db.server";
import { parseJson } from "~/types/domain";
import {
  orderContribution,
  parseCostModel,
  productCogsCents,
} from "~/services/analytics/costModel.server";
import type { ProductCostMeta } from "~/services/analytics/costModel.server";

// Cross-service contract re-exports (ARCHITECTURE.md).
export { getSurvivalCurves } from "~/services/analytics/survival.server";
export type {
  SurvivalCurve,
  SurvivalPoint,
  SurvivalCohortBy,
} from "~/services/analytics/survival.server";
export { getCohortTable } from "~/services/analytics/cohorts.server";
export type {
  CohortTable,
  CohortRow,
  CohortDimension,
  CohortMetric,
} from "~/services/analytics/cohorts.server";

// ───────────────────────────── Types ───────────────────────────────────────

export interface MetricsRange {
  from: Date;
  to: Date;
}

export interface ExecutiveMetrics {
  /** ISO timestamps of the range the rate metrics cover. */
  from: string;
  to: string;
  currencyCode: string;

  // Base & growth
  activeSubscribers: number;
  newSubscriptions: number;
  netGrowth: number;

  // Money (integer cents; per billing cycle for the recurring figures).
  // Cost semantics (ANALYTICS-V2): gross profit = revenue − COGS;
  // contribution = revenue − COGS − shipping − fulfillment − payment fees
  // (full LTGP formula via costModel.orderContribution).
  activeSubscriptionRevenueCents: number;
  /** Gross profit per cycle (revenue − COGS). */
  grossProfitCents: number;
  /** Back-compat alias of grossProfitCents (same value, older tile key). */
  recurringGrossProfitCents: number;
  contributionCents: number;
  subscriberAovCents: number;
  grossMarginLtvCents: number;
  paidOrdersPerSubscriber: number;
  /** True once the merchant saved the cost model — UIs banner while false. */
  costConfigured: boolean;

  // Behaviour rates (fractions 0..1)
  voluntaryChurnRate: number;
  involuntaryChurnRate: number;
  pauseRate: number;
  reactivationRate: number;
  skipRate: number;
  productAdditionRate: number;
  oneTimeToSubscriptionRate: number;
  subscriptionToRoutineRate: number;
  paymentRecoveryRate: number;
  attachRate: number;
  widgetConversionRate: number;

  /** Raw counts backing the rates (for drill-down displays). */
  counts: {
    subscribersAtRangeStart: number;
    voluntaryCancellations: number;
    involuntaryCancellations: number;
    pausesStarted: number;
    pausesEnded: number;
    ordersSkipped: number;
    chargesCompleted: number;
    chargesFailed: number;
    retriesRecovered: number;
    productsAdded: number;
    widgetImpressions: number;
    widgetConversions: number;
  };
}

// ───────────────────────────── Pure helpers ────────────────────────────────

/** Division that returns 0 instead of NaN/Infinity on empty denominators. */
export function safeRate(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export type WidgetEventKind = "IMPRESSION" | "SELECTION" | "CONVERSION" | "OTHER";

/** PURE — classify a WIDGET_* telemetry event name. */
export function classifyWidgetEvent(name: string): WidgetEventKind {
  const upper = name.toUpperCase();
  if (!upper.startsWith("WIDGET_")) return "OTHER";
  // "SHOWN" covers widget E's nudge_shown impression event.
  if (
    upper.includes("IMPRESSION") ||
    upper.includes("VIEW") ||
    upper.includes("SHOWN")
  ) {
    return "IMPRESSION";
  }
  if (
    upper.includes("CONVERSION") ||
    upper.includes("CONVERT") ||
    upper.includes("ADD_TO_CART") ||
    upper.includes("PURCHASE")
  ) {
    return "CONVERSION";
  }
  if (upper.includes("SELECT")) return "SELECTION";
  return "OTHER";
}

/** PURE — does a widget telemetry payload represent a subscription selection? */
export function isSubscriptionSelection(
  payload: Record<string, unknown>,
): boolean {
  if (
    payload.sellingPlanId ||
    payload.selling_plan_id ||
    payload.sellingPlan ||
    payload.selling_plan
  ) {
    return true;
  }
  if (payload.subscription === true || payload.isSubscription === true) {
    return true;
  }
  const selection =
    payload.selection ?? payload.purchaseType ?? payload.purchase_type ?? payload.plan;
  return typeof selection === "string" && selection.toUpperCase().includes("SUBSCRI");
}

/** PURE — widget type carried in a telemetry payload, if any. */
export function widgetTypeOf(payload: Record<string, unknown>): string | null {
  const t = payload.widgetType ?? payload.widget_type ?? payload.widget;
  return typeof t === "string" ? t : null;
}

interface LineLike {
  shopifyProductId: string;
  quantity: number;
  currentPriceCents: number;
}

/** Fallback when a contract has no priced lines to weight (matches the cost
 *  model's unconfigured default margin). */
const FALLBACK_MARGIN_FRACTION = 0.7;

/** PURE — value-weighted blended fraction across a contract's lines. */
export function blendedFraction(
  lines: LineLike[],
  metaByProduct: Map<string, ProductCostMeta>,
  fractionFor: (
    priceCents: number,
    meta: ProductCostMeta | null | undefined,
  ) => number,
): number {
  let value = 0;
  let weighted = 0;
  for (const line of lines) {
    const lineValue = line.currentPriceCents * line.quantity;
    value += lineValue;
    weighted +=
      lineValue *
      fractionFor(line.currentPriceCents, metaByProduct.get(line.shopifyProductId));
  }
  return value > 0 ? weighted / value : FALLBACK_MARGIN_FRACTION;
}

// ───────────────────────────── Main computation ────────────────────────────

export async function getExecutiveMetrics(
  shop: string,
  range: MetricsRange,
): Promise<ExecutiveMetrics> {
  const { from, to } = range;

  const [settings, contracts, metas, eventCounts, attempts, successAttemptsToDate] =
    await Promise.all([
      prisma.shopSettings.findUnique({ where: { shop } }),
      prisma.subscriptionContract.findMany({
        where: { shop },
        include: { lines: true, dunningState: true },
      }),
      prisma.productMeta.findMany({ where: { shop } }),
      prisma.analyticsEvent.groupBy({
        by: ["name"],
        where: { shop, occurredAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),
      prisma.billingAttempt.findMany({
        where: { shop, occurredAt: { gte: from, lte: to } },
        select: { status: true, isRetry: true, amountCents: true },
      }),
      // As-of-`to` numerator for paidOrdersPerSubscriber: every
      // successfulOrders increment writes exactly one SUCCESS attempt row, so
      // this counts orders that existed by the window end — no look-ahead.
      prisma.billingAttempt.count({
        where: { shop, status: "SUCCESS", occurredAt: { lte: to } },
      }),
    ]);

  // The cost model — the single source of every profit figure below.
  const costModel = parseCostModel(settings?.settingsJson);

  const metaByProduct = new Map<string, ProductCostMeta>(
    metas.map((m) => [
      m.shopifyProductId,
      { grossMarginPercent: m.grossMarginPercent, unitCostCents: m.unitCostCents },
    ]),
  );
  const eventCount = new Map<string, number>(
    eventCounts.map((row) => [row.name, row._count._all]),
  );
  const countOf = (name: string): number => eventCount.get(name) ?? 0;

  // ── Base & growth ─────────────────────────────────────────────────────
  const active = contracts.filter((c) => c.status === "ACTIVE");
  const activeSubscribers = active.length;
  const newSubscriptions = contracts.filter(
    (c) => c.createdAt >= from && c.createdAt <= to,
  ).length;
  // MERGED sources are consolidations, not churn — the customer and their
  // revenue continue on the target contract.
  const cancelledInRange = contracts.filter(
    (c) =>
      c.cancelledAt != null &&
      c.cancelledAt >= from &&
      c.cancelledAt <= to &&
      c.cancelReason !== "MERGED",
  );
  const netGrowth = newSubscriptions - cancelledInRange.length;

  // Approximate subscriber base at the start of the range (created before
  // `from` and not yet cancelled at `from`).
  const subscribersAtRangeStart = contracts.filter(
    (c) =>
      c.createdAt <= from && (c.cancelledAt == null || c.cancelledAt > from),
  ).length;

  // ── Recurring money per cycle (all profit via costModel) ─────────────
  // One orderContribution per ACTIVE contract per cycle: per-delivery
  // shipping/fulfillment and the per-charge payment fee apply once per
  // contract cycle, COGS per line.
  let activeSubscriptionRevenueCents = 0;
  let grossProfitCents = 0;
  let contributionCents = 0;
  let routineContracts = 0;
  for (const contract of active) {
    const oc = orderContribution(
      {
        lines: contract.lines.map((line) => ({
          priceCents: line.currentPriceCents,
          quantity: line.quantity,
          meta: metaByProduct.get(line.shopifyProductId) ?? null,
        })),
      },
      costModel,
    );
    activeSubscriptionRevenueCents += oc.revenueCents;
    grossProfitCents += oc.revenueCents - oc.cogsCents;
    contributionCents += oc.contributionCents;

    const distinctProducts = new Set(
      contract.lines.map((line) => line.shopifyProductId),
    );
    if (distinctProducts.size >= 2) routineContracts++;
  }
  grossProfitCents = Math.round(grossProfitCents);
  contributionCents = Math.round(contributionCents);
  const recurringGrossProfitCents = grossProfitCents;

  // ── AOV & recovery from billing attempts ──────────────────────────────
  const successAmounts = attempts.filter(
    (a) => a.status === "SUCCESS" && a.amountCents != null,
  );
  const chargesCompletedAttempts = attempts.filter(
    (a) => a.status === "SUCCESS",
  ).length;
  const chargesFailed = attempts.filter((a) => a.status === "FAILURE").length;
  const retriesRecovered = attempts.filter(
    (a) => a.status === "SUCCESS" && a.isRetry,
  ).length;

  let subscriberAovCents = Math.round(
    safeRate(
      successAmounts.reduce((sum, a) => sum + (a.amountCents ?? 0), 0),
      successAmounts.length,
    ),
  );
  if (subscriberAovCents === 0 && activeSubscribers > 0) {
    // Fallback ONLY before any billing history exists at all (lifetime, not
    // just this range): a shop with history but an off-billing range shows 0
    // ("no charges in range"), never a silently different AOV definition.
    const everBilled = await prisma.billingAttempt.findFirst({
      where: { shop, status: "SUCCESS", amountCents: { not: null } },
      select: { id: true },
    });
    if (!everBilled) {
      subscriberAovCents = Math.round(
        activeSubscriptionRevenueCents / activeSubscribers,
      );
    }
  }

  // Capped at 1 (defense-in-depth): a recovery rate above 100% is impossible
  // and historically leaked to the UI when isRetry was over-flagged.
  const paymentRecoveryRate = Math.min(
    1,
    safeRate(retriesRecovered, chargesFailed),
  );

  // ── LTV & order depth ─────────────────────────────────────────────────
  // Gross-margin fraction of a line under the cost model: 1 − COGS/price.
  const grossMarginFractionFor = (
    priceCents: number,
    meta: ProductCostMeta | null | undefined,
  ): number => {
    if (priceCents <= 0) return costModel.defaultMarginFraction;
    const cogs = productCogsCents(
      { priceCents, quantity: 1 },
      meta ?? null,
      costModel,
    );
    return Math.min(1, Math.max(0, (priceCents - cogs) / priceCents));
  };

  const billedContracts = contracts.filter((c) => c.successfulOrders > 0);
  let grossMarginLtvCents = 0;
  if (billedContracts.length > 0) {
    let total = 0;
    for (const contract of billedContracts) {
      total +=
        contract.totalRevenueCents *
        blendedFraction(contract.lines, metaByProduct, grossMarginFractionFor);
    }
    grossMarginLtvCents = Math.round(total / billedContracts.length);
  }

  // Numerator is the as-of-`to` SUCCESS attempt count (see the Promise.all),
  // NOT today's lifetime successfulOrders counters — the previous-period call
  // must not be credited with orders that happened after its window.
  const contractsToDate = contracts.filter((c) => c.createdAt <= to);
  const paidOrdersPerSubscriber = safeRate(
    successAttemptsToDate,
    contractsToDate.length,
  );

  // ── Churn / pause / skip behaviour ────────────────────────────────────
  const voluntaryCancellations = countOf("CANCELLATION_COMPLETED");
  const involuntaryCancellations = cancelledInRange.filter(
    (c) =>
      c.dunningState?.phase === "EXHAUSTED" ||
      (c.cancelReason ?? "").toUpperCase().includes("PAYMENT"),
  ).length;
  // PAUSE_STARTED is customer behaviour only — dunning grace pauses emit
  // DUNNING_PAUSE_STARTED and are deliberately not counted here.
  const pausesStarted = countOf("PAUSE_STARTED");
  // PAUSE_ENDED = an actual resume (emitted by resumeContract).
  // PAUSE_ENDING is the "pause ends soon" reminder and would count reminders
  // sent, not reactivations.
  const pausesEnded = countOf("PAUSE_ENDED");
  const ordersSkipped = countOf("ORDER_SKIPPED");
  const chargesCompletedEvents = countOf("CHARGE_COMPLETED");
  const productsAdded = countOf("PRODUCT_ADDED");
  const chargesCompleted = Math.max(
    chargesCompletedEvents,
    chargesCompletedAttempts,
  );

  const churnDenominator = Math.max(subscribersAtRangeStart, newSubscriptions);
  const voluntaryChurnRate = safeRate(voluntaryCancellations, churnDenominator);
  const involuntaryChurnRate = safeRate(
    involuntaryCancellations,
    churnDenominator,
  );
  const pauseRate = safeRate(pausesStarted, churnDenominator);
  const reactivationRate = safeRate(pausesEnded, pausesStarted);
  const skipRate = safeRate(ordersSkipped, ordersSkipped + chargesCompleted);
  const productAdditionRate = safeRate(
    productsAdded,
    Math.max(activeSubscribers, 1),
  );
  const subscriptionToRoutineRate = safeRate(
    routineContracts,
    activeSubscribers,
  );

  // ── Widget telemetry (WIDGET_* events written by the offers module) ───
  // Totals come EXACTLY from the unbounded groupBy above — never from a
  // row-capped sample, which on busy shops truncated impressions and
  // conversions independently and made the rates non-deterministic.
  let widgetImpressions = 0;
  let widgetConversions = 0;
  for (const [name, count] of eventCount) {
    const kind = classifyWidgetEvent(name);
    if (kind === "IMPRESSION") widgetImpressions += count;
    else if (kind === "CONVERSION") widgetConversions += count;
  }

  // Payload-dependent splits still need the rows; cursor-paginate the full
  // range in batches so no event is ever dropped.
  let subscriptionConversions = 0;
  let postOneTimeImpressions = 0;
  let postOneTimeConversions = 0;
  const WIDGET_PAGE_SIZE = 10_000;
  let widgetCursorId: string | null = null;
  for (;;) {
    const batch: Array<{ id: string; name: string; payloadJson: string }> =
      await prisma.analyticsEvent.findMany({
        where: {
          shop,
          occurredAt: { gte: from, lte: to },
          name: { startsWith: "WIDGET_" },
        },
        select: { id: true, name: true, payloadJson: true },
        orderBy: { id: "asc" },
        take: WIDGET_PAGE_SIZE,
        ...(widgetCursorId ? { cursor: { id: widgetCursorId }, skip: 1 } : {}),
      });
    for (const event of batch) {
      const kind = classifyWidgetEvent(event.name);
      if (kind !== "IMPRESSION" && kind !== "CONVERSION") continue;
      const payload = parseJson<Record<string, unknown>>(event.payloadJson, {});
      const widgetType = widgetTypeOf(payload);
      if (kind === "IMPRESSION") {
        if (widgetType === "POST_ONE_TIME") postOneTimeImpressions++;
      } else {
        if (isSubscriptionSelection(payload)) subscriptionConversions++;
        if (widgetType === "POST_ONE_TIME") postOneTimeConversions++;
      }
    }
    if (batch.length < WIDGET_PAGE_SIZE) break;
    widgetCursorId = batch[batch.length - 1].id;
  }

  const widgetConversionRate = safeRate(widgetConversions, widgetImpressions);
  const attachRate = safeRate(subscriptionConversions, widgetConversions);
  const oneTimeToSubscriptionRate = safeRate(
    postOneTimeConversions,
    postOneTimeImpressions,
  );

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    currencyCode:
      settings?.currencyCode ?? active[0]?.currencyCode ?? "EUR",
    activeSubscribers,
    newSubscriptions,
    netGrowth,
    activeSubscriptionRevenueCents,
    grossProfitCents,
    recurringGrossProfitCents,
    contributionCents,
    subscriberAovCents,
    grossMarginLtvCents,
    paidOrdersPerSubscriber,
    costConfigured: costModel.configured,
    voluntaryChurnRate,
    involuntaryChurnRate,
    pauseRate,
    reactivationRate,
    skipRate,
    productAdditionRate,
    oneTimeToSubscriptionRate,
    subscriptionToRoutineRate,
    paymentRecoveryRate,
    attachRate,
    widgetConversionRate,
    counts: {
      subscribersAtRangeStart,
      voluntaryCancellations,
      involuntaryCancellations,
      pausesStarted,
      pausesEnded,
      ordersSkipped,
      chargesCompleted,
      chargesFailed,
      retriesRecovered,
      productsAdded,
      widgetImpressions,
      widgetConversions,
    },
  };
}
