import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  COUNTABLE_CONTRACT,
  computeMrrCents,
  originPaymentCountsOnce,
  requireShopById,
  shopDayLabelUtc,
  shopWeekStartKey,
  utcWeekStartKey,
} from "./queries.server";
import {
  churnEndOf,
  computeCohortRows,
  summarizeLtgp,
  ymIndex,
  ymKey,
  type CohortRowData,
  type LtgpSummary,
} from "./cohorts.server";
import {
  FORECAST_MODELS,
  blendForecasts,
  chooseModel,
  cohortActivesForecast,
  computeAccuracy,
  decidedCycleSurvival,
  naiveForecast,
  predictionIntervals,
  residualSigma,
  seasonalForecast,
  trendForecast,
  walkForwardBacktest,
  type Forecaster,
  type ForecastAccuracy,
  type ForecastBandPoint,
  type ForecastMetricSeries,
  type ForecastModelChoice,
  type ForecastModelKey,
  type ForecastModelReport,
  HISTORY_WEEKS,
} from "./forecast.server";

/**
 * Segment views — the filtered analytics surfaces (v1.15.0).
 *
 * The persisted derivation tables (DailyRollup, CohortCell) are shop-level;
 * when the analytics page carries an active segment (segments.server.ts),
 * every view here is computed LIVE from source data over the segment's
 * contract-id list instead — the same formulas, the same COUNTABLE
 * population rule, never persisted. Golden rule 9 applies: these are
 * read-only derivations whose failures the route contains.
 *
 * Honesty rules, disclosed on the page wherever they apply:
 * - Cohorts/LTGP run the IDENTICAL engine as the nightly triangle
 *   (computeCohortRows with a contract-id filter), so a segment's LTGP and
 *   the whole-book LTGP are always comparable figures.
 * - The churn series classifies exactly like the rollup: voluntary =
 *   CUSTOMER/ADMIN/EXTERNAL cancels + EXPIRED completions, involuntary =
 *   DUNNING cancels + FAILED entries; SYSTEM/merge cancels count in neither.
 * - The forecast's weekly history is RECONSTRUCTED from contract and order
 *   records (no per-segment rollups exist): active counts derive from
 *   arrival/churn timestamps and therefore ignore pause windows, refunds
 *   net on the charge week rather than the refund week, and per-segment MRR
 *   history is not reconstructable at all (prices change silently), so
 *   segment forecasts cover actives + collected revenue only. The accuracy
 *   grade carries these caveats as reasons and is capped below "A".
 */

// ── Cohorts / LTGP ───────────────────────────────────────────────────────────

export interface SegmentCohortData {
  rows: CohortRowData[];
  ltgp: LtgpSummary;
}

/**
 * The cohort triangle + LTGP summary for a segment population, computed live
 * through the identical engine the nightly job persists with.
 */
export async function getSegmentCohortData(
  shopId: string,
  contractIds: readonly string[],
  now: Date = new Date(),
): Promise<SegmentCohortData> {
  const shop = await requireShopById(shopId);
  const rows = await computeCohortRows(shopId, now, { contractIds });
  const nowIdx = ymIndex(ymKey(now, shop.ianaTimezone));
  return { rows, ltgp: summarizeLtgp(rows, nowIdx) };
}

// ── Weekly churn series ──────────────────────────────────────────────────────

export interface SegmentChurnSeries {
  /** Monday "yyyy-MM-dd" shop-tz week keys, oldest first. */
  weeks: string[];
  newSubscribers: number[];
  churnedVoluntary: number[];
  churnedInvoluntary: number[];
}

/**
 * Weekly arrivals vs churn for a segment over the trailing `weekCount`
 * shop-timezone weeks, live from contract timestamps. Classification matches
 * the daily rollup exactly (see module doc).
 */
export async function getSegmentChurnSeries(
  shopId: string,
  contractIds: readonly string[],
  opts: { weekCount?: number; now?: Date } = {},
): Promise<SegmentChurnSeries> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const now = opts.now ?? new Date();
  const weekCount = Math.min(52, Math.max(1, opts.weekCount ?? 12));

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId, ...COUNTABLE_CONTRACT, id: { in: [...contractIds] } },
    select: {
      createdAt: true,
      firstChargeAt: true,
      status: true,
      cancelledAt: true,
      cancelSource: true,
      cancelReason: true,
      failedAt: true,
      expiredAt: true,
    },
  });

  const thisWeekKey = shopWeekStartKey(now, tz);
  const weeks: string[] = [];
  {
    // Walk back weekCount Mondays from the current week's Monday, inclusive.
    const anchor = new Date(`${thisWeekKey}T00:00:00.000Z`);
    for (let i = weekCount - 1; i >= 0; i--) {
      weeks.push(
        new Date(anchor.getTime() - i * 7 * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
    }
  }
  const weekIndex = new Map(weeks.map((w, i) => [w, i]));
  const newSubscribers = new Array<number>(weekCount).fill(0);
  const churnedVoluntary = new Array<number>(weekCount).fill(0);
  const churnedInvoluntary = new Array<number>(weekCount).fill(0);

  const bump = (series: number[], instant: Date | null | undefined): void => {
    if (!instant) return;
    const idx = weekIndex.get(shopWeekStartKey(instant, tz));
    if (idx != null) series[idx] += 1;
  };

  for (const contract of contracts) {
    bump(newSubscribers, contract.firstChargeAt ?? contract.createdAt);
    if (contract.cancelledAt && contract.cancelReason !== "MERGED") {
      if (contract.cancelSource === "DUNNING") {
        bump(churnedInvoluntary, contract.cancelledAt);
      } else if (
        contract.cancelSource === "CUSTOMER" ||
        contract.cancelSource === "ADMIN" ||
        contract.cancelSource === "EXTERNAL"
      ) {
        bump(churnedVoluntary, contract.cancelledAt);
      }
      // SYSTEM / null: counted in neither churn column (the rollup rule).
    }
    if (contract.status === "FAILED") bump(churnedInvoluntary, contract.failedAt);
    if (contract.status === "EXPIRED") bump(churnedVoluntary, contract.expiredAt);
  }

  return { weeks, newSubscribers, churnedVoluntary, churnedInvoluntary };
}

// ── Headline numbers ─────────────────────────────────────────────────────────

export interface SegmentHeadline {
  /** Countable contracts in the segment, all statuses, all time. */
  totalContracts: number;
  activeSubscribers: number;
  /** MRR of the segment's ACTIVE shop-currency contracts (computeMrrCents). */
  mrrCents: number;
}

export async function getSegmentHeadline(
  shopId: string,
  contractIds: readonly string[],
  shopCurrencyCode?: string,
): Promise<SegmentHeadline> {
  const [activeSubscribers, mrrCents] = await Promise.all([
    prisma.subscriptionContract.count({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        status: "ACTIVE",
        id: { in: [...contractIds] },
      },
    }),
    computeMrrCents(shopId, shopCurrencyCode, { contractIds }),
  ]);
  return { totalContracts: contractIds.length, activeSubscribers, mrrCents };
}

// ── Segment forecast (reconstructed weekly history) ──────────────────────────

export interface SegmentForecast {
  horizonWeeks: number;
  selectedModel: ForecastModelKey;
  accuracy: ForecastAccuracy;
  models: Array<
    Pick<
      ForecastModelReport,
      "key" | "label" | "available" | "minWeeksRequired" | "backtestMape" | "backtestBias" | "recommended"
    >
  >;
  series: {
    activeSubscribers: ForecastMetricSeries;
    netRevenueCents: ForecastMetricSeries;
  };
  /** Weeks of reconstructed history the models consumed. */
  weeksOfHistory: number;
}

/** Empty-but-valid forecast for a segment with no history at all. */
function emptySegmentForecast(horizonWeeks: number): SegmentForecast {
  return {
    horizonWeeks,
    selectedModel: "naive",
    accuracy: {
      grade: "D",
      label: "Very low confidence — directional only",
      reasons: [
        "No billing history in this segment yet — nothing to project from.",
      ],
    },
    models: FORECAST_MODELS.map((m) => ({
      key: m.key,
      label: m.label,
      available: false,
      minWeeksRequired: m.minWeeksRequired,
      backtestMape: null,
      backtestBias: null,
      recommended: m.key === "naive",
    })),
    series: {
      activeSubscribers: { history: [], forecast: [], filledWeeks: [] },
      netRevenueCents: { history: [], forecast: [], filledWeeks: [] },
    },
    weeksOfHistory: 0,
  };
}

/** Stdev of week-over-week fractional changes (the accuracy input). */
function weeklyVolatility(series: number[]): number | null {
  const changes: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] !== 0) {
      changes.push((series[i] - series[i - 1]) / Math.abs(series[i - 1]));
    }
  }
  if (changes.length === 0) return null;
  const m = changes.reduce((s, c) => s + c, 0) / changes.length;
  const variance =
    changes.reduce((s, c) => s + (c - m) * (c - m), 0) / changes.length;
  return Math.sqrt(variance);
}

const SEGMENT_FORECAST_CAVEATS = [
  "Filtered view — weekly history is reconstructed from contract and order records for this segment: active counts derive from arrival/churn dates and ignore pause windows, and refunded payments are excluded entirely (netted on their charge week when the exclude-refunded analytics option is off).",
  "Per-segment MRR history cannot be reconstructed (past prices are not recorded), so this forecast covers subscribers and collected revenue only.",
];

/**
 * Forecast for a segment population over a reconstructed weekly history —
 * the same pure models the shop-level forecast runs (naive / damped trend /
 * seasonal / cohort survival build-up / blend), selected by walk-forward
 * backtest. Deliberately NOT getForecast: per-segment rollups do not exist,
 * the persisted model-error history was measured against the shop-level
 * series (weighting a different series with it would be miscalibrated), and
 * recordForecastAccuracyWeek stays shop-level — nothing here writes.
 *
 * The accuracy grade carries the reconstruction caveats as reasons and is
 * capped at "B": reconstructed history must never claim the top grade.
 */
export async function getSegmentForecast(
  shopId: string,
  contractIds: readonly string[],
  opts: {
    model?: ForecastModelChoice;
    horizonWeeks?: number;
    now?: Date;
  } = {},
): Promise<SegmentForecast> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const now = opts.now ?? new Date();
  const horizonWeeks = Math.min(52, Math.max(1, opts.horizonWeeks ?? 12));
  const requested: ForecastModelChoice = opts.model ?? "auto";

  if (contractIds.length === 0) return emptySegmentForecast(horizonWeeks);

  // Refund exclusion (v1.16.0, ON by default): drop refunded payments from
  // the reconstructed revenue series entirely — the same rule the cohort
  // triangle and the rollup apply, so segment and whole-book figures agree.
  const { excludeRefundedPayments } = await getSetting(shopId, "analytics");

  const ids = [...contractIds];
  const [contracts, attempts, survivalGroups, intervalAgg] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, ...COUNTABLE_CONTRACT, id: { in: ids } },
      select: {
        id: true,
        createdAt: true,
        firstChargeAt: true,
        status: true,
        cancelledAt: true,
        failedAt: true,
        expiredAt: true,
        originOrderId: true,
        originOrderTotalCents: true,
        originOrderRefundedCents: true,
        originOrderProcessedAt: true,
        originOrderCurrencyCode: true,
      },
    }),
    prisma.billingAttempt.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        contractId: { in: ids },
        status: "SUCCESS",
        completedAt: { not: null },
      },
      select: {
        orderId: true,
        amountCents: true,
        refundedCents: true,
        currencyCode: true,
        completedAt: true,
      },
    }),
    prisma.subscriptionContract.groupBy({
      by: ["ordersCount", "status"],
      where: { shopId, ...COUNTABLE_CONTRACT, id: { in: ids } },
      _count: { _all: true },
    }),
    prisma.subscriptionContract.aggregate({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        status: "ACTIVE",
        id: { in: ids },
      },
      _avg: { intervalWeeks: true },
    }),
  ]);

  // ── Reconstruct the weekly grid (Monday keys in the rollup label space) ──
  const weekKeyOf = (instant: Date): string =>
    utcWeekStartKey(shopDayLabelUtc(instant, tz));
  const currentWeekKey = weekKeyOf(now);

  const successfulAttemptOrderIds = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.orderId) successfulAttemptOrderIds.add(attempt.orderId);
  }
  // Shop-wide claim set (the computeCohortRows rule): an origin order can be
  // claimed by a successful attempt on a contract OUTSIDE this segment, and
  // the double-count guard must still suppress the origin mirror then.
  {
    const originOrderIds = contracts
      .map((c) => c.originOrderId)
      .filter((id): id is string => id != null);
    if (originOrderIds.length > 0) {
      const claimedByAttempts = await prisma.billingAttempt.findMany({
        where: {
          status: "SUCCESS",
          orderId: { in: originOrderIds },
          contract: { shopId, ...COUNTABLE_CONTRACT },
        },
        select: { orderId: true },
      });
      for (const attempt of claimedByAttempts) {
        if (attempt.orderId) successfulAttemptOrderIds.add(attempt.orderId);
      }
    }
  }

  // Revenue + arrivals per week.
  const revenueByWeek = new Map<string, number>();
  const arrivalsByWeek = new Map<string, number>();
  const addTo = (map: Map<string, number>, key: string, value: number): void => {
    map.set(key, (map.get(key) ?? 0) + value);
  };

  for (const attempt of attempts) {
    if (!attempt.completedAt) continue;
    // Refund exclusion: the payment leaves the series whole (see above).
    if (excludeRefundedPayments && attempt.refundedCents > 0) continue;
    if (attempt.currencyCode && attempt.currencyCode !== shop.currencyCode) {
      continue; // the same currency guard every shop-currency aggregate applies
    }
    const amount = attempt.amountCents ?? 0;
    const refunded = Math.min(attempt.refundedCents, Math.max(amount, 0));
    addTo(revenueByWeek, weekKeyOf(attempt.completedAt), amount - refunded);
  }
  for (const contract of contracts) {
    if (
      !(
        excludeRefundedPayments &&
        Math.max(0, contract.originOrderRefundedCents) > 0
      ) &&
      originPaymentCountsOnce(contract, successfulAttemptOrderIds, shop.currencyCode) &&
      contract.originOrderProcessedAt
    ) {
      const amount = contract.originOrderTotalCents ?? 0;
      const refunded = Math.min(
        Math.max(0, contract.originOrderRefundedCents),
        Math.max(amount, 0),
      );
      addTo(
        revenueByWeek,
        weekKeyOf(contract.originOrderProcessedAt),
        amount - refunded,
      );
    }
    const arrival = contract.firstChargeAt ?? contract.createdAt;
    if (arrival) addTo(arrivalsByWeek, weekKeyOf(arrival), 1);
  }

  // Week range: first observation → last COMPLETE week, capped at the same
  // history window the shop-level forecast reads.
  const observedKeys = [...revenueByWeek.keys(), ...arrivalsByWeek.keys()]
    .filter((k) => k < currentWeekKey)
    .sort();
  if (observedKeys.length === 0) return emptySegmentForecast(horizonWeeks);

  const lastKey = observedKeys[observedKeys.length - 1];
  let firstKey = observedKeys[0];
  {
    const span =
      (new Date(`${lastKey}T00:00:00.000Z`).getTime() -
        new Date(`${firstKey}T00:00:00.000Z`).getTime()) /
        (7 * 86_400_000) +
      1;
    if (span > HISTORY_WEEKS) {
      firstKey = new Date(
        new Date(`${lastKey}T00:00:00.000Z`).getTime() -
          (HISTORY_WEEKS - 1) * 7 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10);
    }
  }

  const weeks: string[] = [];
  for (
    let t = new Date(`${firstKey}T00:00:00.000Z`).getTime();
    t <= new Date(`${lastKey}T00:00:00.000Z`).getTime();
    t += 7 * 86_400_000
  ) {
    weeks.push(new Date(t).toISOString().slice(0, 10));
  }

  // Active counts per week, reconstructed in the same label space: active in
  // week W ⇔ arrived in some week ≤ W and churn-ended (churnEndOf — the
  // cohort rule) in some week > W. Ignores pause windows (disclosed).
  const activesSeries = weeks.map((week) => {
    let count = 0;
    for (const contract of contracts) {
      const arrival = contract.firstChargeAt ?? contract.createdAt;
      if (!arrival || weekKeyOf(arrival) > week) continue;
      const end = churnEndOf(contract);
      if (end != null && weekKeyOf(end) <= week) continue;
      count += 1;
    }
    return count;
  });
  const revenueSeries = weeks.map((week) =>
    Math.max(0, revenueByWeek.get(week) ?? 0),
  );
  const arrivalsSeries = weeks.map((week) => arrivalsByWeek.get(week) ?? 0);

  // ── Cohort-model ingredients (segment population, decided transitions) ──
  const survival = decidedCycleSurvival(
    survivalGroups.map((g) => ({
      ordersCount: g.ordersCount,
      status: g.status,
      count: g._count._all,
    })),
  );
  const avgIntervalWeeks = Math.max(1, intervalAgg._avg.intervalWeeks ?? 8);

  const cohortActivesForecaster: Forecaster = (train, horizon) => {
    if (train.length === 0) return null;
    // Inflow from the last 4 weeks WITHIN the train window (arrivalsSeries is
    // index-aligned with the metric series) — a backtest fold must never see
    // the arrival run rate of its own evaluation weeks (the shop-level
    // forecaster's inflowAt(train.length) rule).
    const window = arrivalsSeries.slice(
      Math.max(0, train.length - 4),
      train.length,
    );
    const inflow =
      window.reduce((s, v) => s + v, 0) / Math.max(1, window.length);
    return cohortActivesForecast({
      activeBase: train[train.length - 1],
      avgCycleSurvival: survival.avgCycleSurvival,
      avgIntervalWeeks,
      weeklyNewSubscribers: inflow,
      horizon,
    });
  };

  // Money leg of the cohort model: projected actives × recent per-active
  // weekly revenue (the shop-level cohortMoneyForecaster's approximation).
  // The actives window is truncated to the revenue train length so a
  // backtest fold can never read actives from its own evaluation weeks.
  const cohortMoneyForecaster: Forecaster = (train, horizon) => {
    const activesWindow = activesSeries.slice(0, train.length);
    if (train.length === 0 || activesWindow.length === 0) return null;
    const tail = Math.min(4, train.length);
    let revenueSum = 0;
    let activeSum = 0;
    for (let i = 0; i < tail; i++) {
      revenueSum += train[train.length - 1 - i];
      activeSum += activesWindow[Math.max(0, activesWindow.length - 1 - i)];
    }
    if (activeSum <= 0) return null;
    const perActive = revenueSum / activeSum;
    const actives = cohortActivesForecaster(activesWindow, horizon);
    if (!actives) return null;
    return actives.map((a) => Math.max(0, Math.round(a * perActive)));
  };

  // ── Run + referee the models on the actives + revenue series ──────────────
  const baseForecasters: Record<
    Exclude<ForecastModelKey, "blend">,
    { actives: Forecaster; revenue: Forecaster }
  > = {
    naive: { actives: naiveForecast, revenue: naiveForecast },
    trend: {
      actives: (s, h) => trendForecast(s, h, { damped: true }),
      revenue: (s, h) => trendForecast(s, h, { damped: true }),
    },
    seasonal: { actives: seasonalForecast, revenue: seasonalForecast },
    cohort: { actives: cohortActivesForecaster, revenue: cohortMoneyForecaster },
  };

  // Segment blend = the EQUAL-WEIGHT mean of the available base models. The
  // shop-level blend weights by the persisted weekly error history, which
  // does not exist per segment, and weighting by this run's own full-series
  // backtest would leak evaluation weeks into the folds. Equal weights make
  // the same function backtestable and forecastable — the reported error is
  // the blend's OWN walk-forward error, never a mean of other models'.
  const blendForecasterFor =
    (metric: "actives" | "revenue"): Forecaster =>
    (train, horizon) => {
      const candidates = (["naive", "trend", "seasonal", "cohort"] as const)
        .map((key) => baseForecasters[key][metric](train, horizon))
        .filter((points): points is number[] => points != null);
      if (candidates.length < 2) return null;
      return blendForecasts(
        candidates.map((points) => ({ points, error: null })),
        horizon,
      );
    };

  const forecasterFor = (
    key: ForecastModelKey,
    metric: "actives" | "revenue",
  ): Forecaster =>
    key === "blend"
      ? blendForecasterFor(metric)
      : baseForecasters[key][metric];

  const backtests = new Map<
    ForecastModelKey,
    { mape: number | null; bias: number | null; residuals: Record<string, number[]> }
  >();
  const meanOf = (values: number[]): number | null =>
    values.length > 0
      ? values.reduce((s, v) => s + v, 0) / values.length
      : null;

  for (const model of FORECAST_MODELS) {
    const minTrain = Math.max(2, model.minWeeksRequired);
    const activesReport = walkForwardBacktest(
      activesSeries,
      forecasterFor(model.key, "actives"),
      { minTrain },
    );
    const revenueReport = walkForwardBacktest(
      revenueSeries,
      forecasterFor(model.key, "revenue"),
      { minTrain },
    );
    const mapes = [activesReport.mape, revenueReport.mape].filter(
      (m): m is number => m != null,
    );
    const biases = [activesReport.bias, revenueReport.bias].filter(
      (b): b is number => b != null,
    );
    backtests.set(model.key, {
      mape: meanOf(mapes),
      bias: meanOf(biases),
      residuals: {
        actives: activesReport.oneStepResiduals,
        revenue: revenueReport.oneStepResiduals,
      },
    });
  }

  const isAvailable = (key: ForecastModelKey): boolean => {
    const spec = FORECAST_MODELS.find((m) => m.key === key);
    if (!spec || activesSeries.length < spec.minWeeksRequired) return false;
    // A model is only offered when it can actually produce a forecast on the
    // full series — chooseModel must never select a null-returning model.
    return forecasterFor(key, "actives")(activesSeries, 1) != null;
  };

  const reports: ForecastModelReport[] = FORECAST_MODELS.map((model) => {
    const backtest = backtests.get(model.key);
    return {
      key: model.key,
      label: model.label,
      available: isAvailable(model.key),
      minWeeksRequired: model.minWeeksRequired,
      backtestMape: backtest?.mape ?? null,
      backtestBias: backtest?.bias ?? null,
      recommended: false,
    };
  });

  const selectedModel = chooseModel(reports, requested);
  for (const report of reports) {
    report.recommended = report.key === chooseModel(reports, "auto");
  }

  const forecastWith = (
    key: ForecastModelKey,
    series: number[],
    metric: "actives" | "revenue",
  ): number[] | null => forecasterFor(key, metric)(series, horizonWeeks);

  // ── Accuracy (capped below "A" — reconstructed history, see module doc) ──
  const accuracy = computeAccuracy({
    weeksOfHistory: weeks.length,
    activeSubscribers: activesSeries[activesSeries.length - 1] ?? 0,
    backtestMape: backtests.get(selectedModel)?.mape ?? null,
    volatility: weeklyVolatility(activesSeries),
    extraReasons: SEGMENT_FORECAST_CAVEATS,
  });
  if (accuracy.grade === "A") {
    accuracy.grade = "B";
    accuracy.label = "Moderate confidence";
    accuracy.reasons.push(
      "Grade capped at B for filtered views — reconstructed history never earns the top grade.",
    );
  }

  // ── Assemble the two metric series with bands ────────────────────────────
  const buildSeries = (
    series: number[],
    metric: "actives" | "revenue",
  ): ForecastMetricSeries => {
    const history = weeks.map((weekStartIso, i) => ({
      weekStartIso,
      value: series[i],
    }));
    const points =
      forecastWith(selectedModel, series, metric) ??
      naiveForecast(series, horizonWeeks) ??
      new Array<number>(horizonWeeks).fill(0);
    // Unconditional floor (the getForecast rule): never tighter than 3% of
    // the current level or 1 unit — a constant reconstructed series yields
    // all-zero residuals, and a zero-width band would claim perfect
    // certainty on an explicitly caveated history.
    const sigmaBase =
      residualSigma(backtests.get(selectedModel)?.residuals[metric] ?? []) ?? 0;
    const sigma = Math.max(
      sigmaBase,
      0.03 * Math.abs(series[series.length - 1] ?? 0),
      1,
    );
    const bands = predictionIntervals(points, sigma, accuracy.grade);
    const forecast: ForecastBandPoint[] = points.map((value, h) => ({
      weekStartIso: new Date(
        new Date(`${lastKey}T00:00:00.000Z`).getTime() +
          (h + 1) * 7 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      value,
      lo: bands.lo[h],
      hi: bands.hi[h],
    }));
    return { history, forecast, filledWeeks: [] };
  };

  return {
    horizonWeeks,
    selectedModel,
    accuracy,
    models: reports,
    series: {
      activeSubscribers: buildSeries(activesSeries, "actives"),
      netRevenueCents: buildSeries(revenueSeries, "revenue"),
    },
    weeksOfHistory: weeks.length,
  };
}
