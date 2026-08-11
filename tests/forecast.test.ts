import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  default: {
    dailyRollup: { findMany: vi.fn() },
    subscriptionContract: {
      count: vi.fn(),
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    shop: { findUnique: vi.fn() },
    // Self-improvement plumbing (v1.5.0): the forecastModelHistory setting
    // and the event log recordForecastAccuracyWeek writes through.
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    subscriberEvent: { create: vi.fn() },
  },
}));

// logEvent lazy-imports the Klaviyo mapper, which would drag the real Shopify
// session storage into the graph — stub it (admin.action is unmapped anyway).
vi.mock("~/lib/klaviyo/events-map.server", () => ({
  enqueueKlaviyoForEvent: vi.fn(async (): Promise<void> => {}),
}));

import prisma from "~/db.server";
import {
  FORECAST_HISTORY_WEEKS,
  FORECAST_MODELS,
  HISTORY_WEEKS,
  blendForecasts,
  chooseModel,
  cohortActivesForecast,
  computeAccuracy,
  decidedCycleSurvival,
  exponentiallyWeightedError,
  getForecast,
  historyErrorAsOf,
  materializeWeeklyGrid,
  naiveForecast,
  predictionIntervals,
  recordForecastAccuracyWeek,
  residualSigma,
  seasonalForecast,
  trendForecast,
  walkForwardBacktest,
  type ForecastModelHistoryWeek,
  type ForecastModelKey,
  type ForecastModelReport,
  type WeeklyObservation,
} from "~/lib/analytics/forecast.server";

const db = prisma as unknown as {
  dailyRollup: { findMany: ReturnType<typeof vi.fn> };
  subscriptionContract: {
    count: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  shop: { findUnique: ReturnType<typeof vi.fn> };
  setting: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  subscriberEvent: { create: ReturnType<typeof vi.fn> };
};

// ── naive model ───────────────────────────────────────────────────────────────

describe("naiveForecast", () => {
  it("returns null on an empty series", () => {
    expect(naiveForecast([], 4)).toBeNull();
  });

  it("carries the last value forward (flat series)", () => {
    expect(naiveForecast([5, 5, 5], 3)).toEqual([5, 5, 5]);
  });

  it("uses only the LAST value of a noisy series", () => {
    expect(naiveForecast([10, 40, 7], 2)).toEqual([7, 7]);
  });

  it("clamps a negative last value at 0", () => {
    expect(naiveForecast([-5], 2)).toEqual([0, 0]);
  });
});

// ── trend model (Holt) ────────────────────────────────────────────────────────

describe("trendForecast", () => {
  it("returns null below 2 observations", () => {
    expect(trendForecast([], 4)).toBeNull();
    expect(trendForecast([10], 4)).toBeNull();
  });

  it("continues a perfectly linear series exactly (correct init)", () => {
    // level=10, trend = mean of first 3 diffs = 10; smoothing keeps both exact.
    expect(trendForecast([10, 20, 30, 40, 50], 4)).toEqual([60, 70, 80, 90]);
  });

  it("is flat on a flat series", () => {
    expect(trendForecast([7, 7, 7, 7], 3)).toEqual([7, 7, 7]);
  });

  it("damping shrinks the projected growth (phi 0.9)", () => {
    const undamped = trendForecast([10, 20, 30, 40, 50], 12)!;
    const damped = trendForecast([10, 20, 30, 40, 50], 12, { damped: true })!;
    // h=1: 50 + 0.9·10 = 59
    expect(damped[0]).toBe(59);
    for (let i = 0; i < 12; i++) expect(damped[i]).toBeLessThanOrEqual(undamped[i]);
    expect(damped[11]).toBeLessThan(undamped[11]);
  });

  it("clamps a collapsing trend at 0 (no negative forecasts)", () => {
    expect(trendForecast([100, 50, 0], 4)).toEqual([0, 0, 0, 0]);
  });

  it("2-point audit case: pure fn extrapolates linearly, so the registry demands 5 weeks", () => {
    // Two rollup weeks 1000 → 1500 used to reach 7500 by week 14 on the
    // dashboard. The pure function still shows why that was dangerous …
    expect(trendForecast([1000, 1500], 12)![11]).toBe(7500);
    // … which is exactly why getForecast never runs "trend" below 5 weeks.
    const trend = FORECAST_MODELS.find((m) => m.key === "trend")!;
    expect(trend.minWeeksRequired).toBeGreaterThanOrEqual(5);
    // And the damped variant converges instead of doubling forever.
    const damped = trendForecast([1000, 1500], 12, { damped: true })!;
    expect(damped[11]).toBeLessThan(7500);
  });
});

// ── seasonal model ────────────────────────────────────────────────────────────

describe("seasonalForecast", () => {
  const pattern = [100, 110, 95, 95];
  const sixteenWeeks = [...pattern, ...pattern, ...pattern, ...pattern];

  it("refuses below 16 weeks of data", () => {
    expect(seasonalForecast(sixteenWeeks.slice(0, 15), 4)).toBeNull();
    expect(seasonalForecast([], 4)).toBeNull();
  });

  it("continues a stable week-of-month pattern exactly", () => {
    expect(seasonalForecast(sixteenWeeks, 8)).toEqual([
      100, 110, 95, 95, 100, 110, 95, 95,
    ]);
  });
});

// ── cohort model ──────────────────────────────────────────────────────────────

describe("cohortActivesForecast", () => {
  it("decays the base by the weekly retention derived from cycle survival", () => {
    // survival 0.25 over a 2-week interval → weekly retention 0.5.
    expect(
      cohortActivesForecast({
        activeBase: 100,
        avgCycleSurvival: 0.25,
        avgIntervalWeeks: 2,
        weeklyNewSubscribers: 0,
        horizon: 4,
      }),
    ).toEqual([50, 25, 13, 6]);
  });

  it("reaches steady state when inflow balances churn", () => {
    expect(
      cohortActivesForecast({
        activeBase: 100,
        avgCycleSurvival: 0.9,
        avgIntervalWeeks: 1,
        weeklyNewSubscribers: 10,
        horizon: 6,
      }),
    ).toEqual([100, 100, 100, 100, 100, 100]);
  });

  it("grows linearly from zero with perfect retention", () => {
    expect(
      cohortActivesForecast({
        activeBase: 0,
        avgCycleSurvival: 1,
        avgIntervalWeeks: 4,
        weeklyNewSubscribers: 5,
        horizon: 4,
      }),
    ).toEqual([5, 10, 15, 20]);
  });

  // ── Heterogeneous per-cycle decay (FR-6a) ──────────────────────────────────

  it("uniform per-cycle ratios reproduce the homogeneous model exactly", () => {
    const base = {
      activeBase: 100,
      avgCycleSurvival: 0.25,
      avgIntervalWeeks: 2,
      weeklyNewSubscribers: 0,
      horizon: 4,
    };
    expect(
      cohortActivesForecast({
        ...base,
        perCycleSurvival: [0.25, 0.25, 0.25],
        cycleDistribution: [50, 30, 20],
      }),
    ).toEqual(cohortActivesForecast(base));
  });

  it("early-cycle-heavy books churn faster than mature books under the same hazard curve", () => {
    // Hazard curve: cycle 1 survives 50%, later cycles 95% — the shape every
    // subscription book actually has. The blended average threw this away.
    const shared = {
      activeBase: 100,
      avgCycleSurvival: 0.8,
      avgIntervalWeeks: 1,
      weeklyNewSubscribers: 0,
      horizon: 6,
      perCycleSurvival: [0.5, 0.95, 0.95],
    };
    const young = cohortActivesForecast({
      ...shared,
      cycleDistribution: [100, 0, 0],
    });
    const mature = cohortActivesForecast({
      ...shared,
      cycleDistribution: [0, 0, 100],
    });
    for (let i = 0; i < 6; i++) expect(young[i]).toBeLessThan(mature[i]);
    // Homogeneous decay (blended 0.8) sits between the two — it under-churns
    // the young book and over-churns the mature one.
    const blended = cohortActivesForecast({
      ...shared,
      perCycleSurvival: undefined,
      cycleDistribution: undefined,
    });
    expect(young[0]).toBeLessThan(blended[0]);
    expect(mature[0]).toBeGreaterThan(blended[0]);
  });

  it("buckets advance one cycle in lockstep at each interval boundary (hand-computed)", () => {
    // interval 2 weeks, cycle-1 survival 0.25 (weekly 0.5), cycle-2+ survival
    // 1. Weeks 1–2 decay the base at 0.5/week (still cycle 1); the boundary
    // after week 2 advances it into cycle 2, where nothing churns.
    expect(
      cohortActivesForecast({
        activeBase: 100,
        avgCycleSurvival: 0.9,
        avgIntervalWeeks: 2,
        weeklyNewSubscribers: 0,
        horizon: 4,
        perCycleSurvival: [0.25, 1],
        cycleDistribution: [100, 0],
      }),
    ).toEqual([50, 25, 25, 25]);
  });

  it("inflow joins at cycle 1 and faces the early-cycle hazard", () => {
    // No base; 10 arrivals/week; cycle-1 weekly retention 0.5. Week 1: 10.
    // Week 2: the boundary (interval 1) advances survivors to cycle 2
    // (retention 1), so 10·0.5 + 10 = 15; week 3: 15·(survivors advance) …
    // steady growth toward the mature plateau, never the naive 10·h line.
    const out = cohortActivesForecast({
      activeBase: 0,
      avgCycleSurvival: 0.9,
      avgIntervalWeeks: 1,
      weeklyNewSubscribers: 10,
      horizon: 3,
      perCycleSurvival: [0.5, 1],
      cycleDistribution: [1, 0],
    });
    expect(out).toEqual([10, 15, 20]);
  });

  it("cycles beyond the observed curve reuse its LAST ratio, not the blended average", () => {
    // Distribution deeper than the curve clamps into the tail bucket; the
    // tail keeps the last observed (mature) hazard.
    const out = cohortActivesForecast({
      activeBase: 100,
      avgCycleSurvival: 0.5, // blended — must NOT drive the tail
      avgIntervalWeeks: 1,
      weeklyNewSubscribers: 0,
      horizon: 2,
      perCycleSurvival: [0.5, 1],
      cycleDistribution: [0, 0, 0, 100],
    });
    expect(out).toEqual([100, 100]);
  });
});

// ── censoring-corrected survival (the audit fix) ──────────────────────────────

describe("decidedCycleSurvival", () => {
  it("young launch book: censored actives do NOT read as churn (audit scenario)", () => {
    // 3 weeks after launch: 100 contracts, 60 billed once, 10 twice, nobody
    // cancelled. The old ratio estimate produced ~0.17 per-cycle survival and
    // a projected 77% collapse. Decided transitions: only the 10 that reached
    // cycle 2 — far below the minimum, so the conservative default applies.
    const estimate = decidedCycleSurvival([
      { ordersCount: 0, status: "ACTIVE", count: 40 },
      { ordersCount: 1, status: "ACTIVE", count: 50 },
      { ordersCount: 2, status: "ACTIVE", count: 10 },
    ]);
    expect(estimate.insufficientData).toBe(true);
    expect(estimate.decidedTransitions).toBe(10);
    expect(estimate.avgCycleSurvival).toBe(0.9);
    // The one decided ratio that exists is 100% survival, not 17%.
    expect(estimate.perCycle).toEqual([
      { cycle: 1, survivors: 10, churned: 0, atRisk: 10, ratio: 1 },
    ]);
  });

  it("computes per-cycle ratios over decided transitions only", () => {
    const estimate = decidedCycleSurvival([
      { ordersCount: 1, status: "CANCELLED", count: 60 },
      { ordersCount: 2, status: "ACTIVE", count: 100 },
      { ordersCount: 2, status: "CANCELLED", count: 40 },
    ]);
    // Transition 1→2: 140 reached cycle 2, 60 died at cycle 1 → 0.7.
    // Transition 2→3: 0 reached cycle 3, 40 died at cycle 2 → 0.
    expect(estimate.perCycle).toEqual([
      { cycle: 1, survivors: 140, churned: 60, atRisk: 200, ratio: 0.7 },
      { cycle: 2, survivors: 0, churned: 40, atRisk: 40, ratio: 0 },
    ]);
    expect(estimate.decidedTransitions).toBe(240);
    expect(estimate.insufficientData).toBe(false);
    expect(estimate.avgCycleSurvival).toBeCloseTo(140 / 240, 6);
  });

  it("adding censored (still-active, not yet due) contracts changes nothing", () => {
    const base = decidedCycleSurvival([
      { ordersCount: 1, status: "CANCELLED", count: 60 },
      { ordersCount: 2, status: "ACTIVE", count: 100 },
      { ordersCount: 2, status: "CANCELLED", count: 40 },
    ]);
    const withCensored = decidedCycleSurvival([
      { ordersCount: 1, status: "CANCELLED", count: 60 },
      { ordersCount: 1, status: "ACTIVE", count: 500 }, // censored at cycle 1
      { ordersCount: 2, status: "ACTIVE", count: 100 },
      { ordersCount: 2, status: "CANCELLED", count: 40 },
    ]);
    expect(withCensored.avgCycleSurvival).toBeCloseTo(base.avgCycleSurvival, 10);
    expect(withCensored.perCycle[0].ratio).toBe(0.7);
  });

  it("FAILED contracts churn at their cycle — payment churn is not censored (audit fix)", () => {
    // 70 reached cycle 2; 30 cancelled and 20 dunning-exhausted (status
    // FAILED, no cancelledAt under the default exhaustedAction PAUSE) died at
    // cycle 1. Counting only CANCELLED read 70/100 = 0.70; the true decided
    // survival is 70/120 ≈ 0.583 — the bias was exactly the involuntary
    // share, and it fed both the cohort model and the merchant-visible
    // per-cycle survival number.
    const estimate = decidedCycleSurvival([
      { ordersCount: 2, status: "ACTIVE", count: 70 },
      { ordersCount: 1, status: "CANCELLED", count: 30 },
      { ordersCount: 1, status: "FAILED", count: 20 },
    ]);
    expect(estimate.decidedTransitions).toBe(120);
    expect(estimate.avgCycleSurvival).toBeCloseTo(70 / 120, 6);
    expect(estimate.perCycle[0]).toEqual({
      cycle: 1,
      survivors: 70,
      churned: 50,
      atRisk: 120,
      ratio: 0.5833,
    });
  });

  it("EXPIRED contracts churn too — a completed bounded plan leaves the base", () => {
    // Same terminal set as survival.server.ts: EXPIRED is voluntary by the
    // shared classification, but for decay purposes it is a death.
    const withExpired = decidedCycleSurvival([
      { ordersCount: 2, status: "ACTIVE", count: 90 },
      { ordersCount: 1, status: "EXPIRED", count: 30 },
    ]);
    expect(withExpired.decidedTransitions).toBe(120);
    expect(withExpired.avgCycleSurvival).toBeCloseTo(90 / 120, 6);
  });

  it("a FAILED contract's own history still counts it as a survivor of earlier cycles", () => {
    // Failed at cycle 3: it reached cycles 1–3 (survivor of 1→2 and 2→3) and
    // churned the 3→4 transition.
    const estimate = decidedCycleSurvival(
      [
        { ordersCount: 4, status: "ACTIVE", count: 10 },
        { ordersCount: 3, status: "FAILED", count: 10 },
      ],
      { minDecided: 5 },
    );
    expect(estimate.perCycle).toEqual([
      { cycle: 1, survivors: 20, churned: 0, atRisk: 20, ratio: 1 },
      { cycle: 2, survivors: 20, churned: 0, atRisk: 20, ratio: 1 },
      { cycle: 3, survivors: 10, churned: 10, atRisk: 20, ratio: 0.5 },
    ]);
  });

  it("honours the minDecided override", () => {
    const estimate = decidedCycleSurvival(
      [
        { ordersCount: 1, status: "ACTIVE", count: 50 },
        { ordersCount: 2, status: "ACTIVE", count: 10 },
      ],
      { minDecided: 5 },
    );
    expect(estimate.insufficientData).toBe(false);
    expect(estimate.avgCycleSurvival).toBe(1);
  });

  it("falls back to the default on an empty book", () => {
    const estimate = decidedCycleSurvival([]);
    expect(estimate.avgCycleSurvival).toBe(0.9);
    expect(estimate.insufficientData).toBe(true);
    expect(estimate.decidedTransitions).toBe(0);
    expect(estimate.perCycle).toEqual([]);
  });
});

// ── walk-forward backtest ─────────────────────────────────────────────────────

describe("walkForwardBacktest", () => {
  it("perfect model on a flat series: zero error, zero bias", () => {
    const report = walkForwardBacktest([10, 10, 10, 10], naiveForecast, {
      minTrain: 1,
    });
    expect(report.mape).toBe(0);
    expect(report.bias).toBe(0);
    expect(report.oneStepResiduals).toEqual([0, 0, 0]);
    expect(report.points).toBe(6); // folds of horizon 3 + 2 + 1
  });

  it("computes MAPE and signed bias by hand-checkable folds", () => {
    // naive on [10, 20, 40]:
    // k=1 → preds [10,10] vs [20,40]: APEs 0.5, 0.75
    // k=2 → pred  [20]    vs [40]:    APE  0.5
    const report = walkForwardBacktest([10, 20, 40], naiveForecast, {
      minTrain: 1,
    });
    expect(report.mape).toBeCloseTo((0.5 + 0.75 + 0.5) / 3, 6);
    expect(report.bias).toBeCloseTo(-(0.5 + 0.75 + 0.5) / 3, 6); // under-forecasts
    expect(report.oneStepResiduals).toEqual([-10, -20]);
    expect(report.points).toBe(3);
  });

  it("respects minTrain (skips folds below a model's data requirement)", () => {
    const report = walkForwardBacktest([10, 20, 40], naiveForecast, {
      minTrain: 2,
    });
    expect(report.mape).toBeCloseTo(0.5, 6);
    expect(report.points).toBe(1);
  });

  it("a forecaster that refuses (null) contributes nothing", () => {
    const refusing = () => null;
    const report = walkForwardBacktest([10, 20, 30, 40], refusing, { minTrain: 1 });
    expect(report.mape).toBeNull();
    expect(report.bias).toBeNull();
    expect(report.points).toBe(0);
  });

  it("skips zero actuals for percentage metrics but keeps their residuals", () => {
    const report = walkForwardBacktest([0, 0, 10], naiveForecast, { minTrain: 1 });
    expect(report.mape).toBe(1); // both scored points miss 10 by 100%
    expect(report.oneStepResiduals).toEqual([0, -10]);
  });

  it("latestOneStepApe is the FINAL fold's one-step error — NOT the fold-overlapping average", () => {
    // Flat for five weeks, then a jump the model could not have seen. The
    // newest complete week's true out-of-sample error is |100−200|/200 = 0.5;
    // the backtest AVERAGE dilutes that single miss across 14 scored points
    // (2.0/14 ≈ 0.143). Recording the average as "this week's error" is what
    // made consecutive recorded weeks near-perfectly correlated — the
    // hindsight-leak audit's secondary finding.
    const report = walkForwardBacktest(
      [100, 100, 100, 100, 100, 200],
      naiveForecast,
      { minTrain: 1, maxHorizon: 4 },
    );
    expect(report.latestOneStepApe).toBeCloseTo(0.5, 10);
    expect(report.mape).toBeCloseTo(2 / 14, 10);
    expect(report.latestOneStepApe).not.toBeCloseTo(report.mape!, 2);
  });

  it("latestOneStepApe is null when the newest actual is 0 or the final train window is refused", () => {
    // Newest actual 0: the percentage error is undefined — never fabricated.
    expect(
      walkForwardBacktest([100, 100, 0], naiveForecast, { minTrain: 1 })
        .latestOneStepApe,
    ).toBeNull();
    // A forecaster that refuses every window measures nothing.
    expect(
      walkForwardBacktest([10, 20, 30], () => null, { minTrain: 1 })
        .latestOneStepApe,
    ).toBeNull();
    // No folds at all (series shorter than minTrain + 1).
    expect(
      walkForwardBacktest([10], naiveForecast, { minTrain: 1 }).latestOneStepApe,
    ).toBeNull();
  });
});

// ── model selection ───────────────────────────────────────────────────────────

function report(
  key: ForecastModelKey,
  available: boolean,
  mape: number | null,
): ForecastModelReport {
  return {
    key,
    label: key,
    available,
    minWeeksRequired: 1,
    backtestMape: mape,
    backtestBias: null,
    recommended: false,
  };
}

describe("chooseModel", () => {
  it("auto picks the lowest backtest MAPE among available models", () => {
    const reports = [report("naive", true, 0.2), report("trend", true, 0.1)];
    expect(chooseModel(reports, "auto")).toBe("trend");
  });

  it("ties keep the earlier (simpler) model", () => {
    const reports = [report("naive", true, 0.1), report("trend", true, 0.1)];
    expect(chooseModel(reports, "auto")).toBe("naive");
  });

  it("honours an explicitly requested available model even if not the best", () => {
    const reports = [report("naive", true, 0.2), report("trend", true, 0.1)];
    expect(chooseModel(reports, "naive")).toBe("naive");
  });

  it("falls back to auto when the requested model is unavailable", () => {
    const reports = [
      report("naive", true, 0.2),
      report("trend", true, 0.1),
      report("seasonal", false, null),
    ];
    expect(chooseModel(reports, "seasonal")).toBe("trend");
  });

  it("defaults to naive when nothing is backtestable", () => {
    const reports = [report("naive", true, null), report("cohort", true, null)];
    expect(chooseModel(reports, "auto")).toBe("naive");
  });

  it("falls back to any available model when even naive is unavailable", () => {
    const reports = [report("naive", false, null), report("cohort", true, null)];
    expect(chooseModel(reports, "auto")).toBe("cohort");
  });
});

// ── accuracy grade ────────────────────────────────────────────────────────────

describe("computeAccuracy", () => {
  it("under 6 weeks is capped at D no matter how good the backtest looks", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 4,
      activeSubscribers: 500,
      backtestMape: 0.05,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("D");
    expect(acc.reasons.join(" ")).toContain("directional at best");
  });

  it("6–11 weeks caps at C — a good backtest cannot climb above the cap", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 8,
      activeSubscribers: 100,
      backtestMape: 0.05,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("C");
  });

  it("12–25 weeks caps at B", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 20,
      activeSubscribers: 100,
      backtestMape: 0.15,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("B");
  });

  it("26+ weeks with a reliable backtest reaches A", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 30,
      activeSubscribers: 100,
      backtestMape: 0.05,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("A");
    expect(acc.label).toBe("High confidence");
    expect(acc.reasons.join(" ")).toContain("reliable");
  });

  it("a bad backtest (>25% MAPE) costs one grade", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 30,
      activeSubscribers: 100,
      backtestMape: 0.3,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("B");
    expect(acc.reasons.join(" ")).toContain("wide margin");
  });

  it("a small base (<30 actives) costs one grade", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 30,
      activeSubscribers: 10,
      backtestMape: 0.15,
      volatility: 0.02,
    });
    expect(acc.grade).toBe("B");
    expect(acc.reasons.join(" ")).toContain("small-number noise");
  });

  it("downgrades stack (small base + bad backtest + volatility)", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 30,
      activeSubscribers: 10,
      backtestMape: 0.3,
      volatility: 0.2,
    });
    expect(acc.grade).toBe("D");
  });

  it("no backtest available is stated as a reason, not silently ignored", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 30,
      activeSubscribers: 100,
      backtestMape: null,
      volatility: null,
    });
    expect(acc.reasons.join(" ")).toContain("Not enough history to backtest");
  });

  it("zero weeks gets the live-numbers explanation", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 0,
      activeSubscribers: 5,
      backtestMape: null,
      volatility: null,
    });
    expect(acc.grade).toBe("D");
    expect(acc.reasons[0]).toContain("No weekly rollup history yet");
  });

  it("appends caller-supplied extra reasons", () => {
    const acc = computeAccuracy({
      weeksOfHistory: 10,
      activeSubscribers: 100,
      backtestMape: 0.15,
      volatility: null,
      extraReasons: ["2 missing weeks were filled."],
    });
    expect(acc.reasons[acc.reasons.length - 1]).toBe("2 missing weeks were filled.");
  });
});

// ── prediction intervals ──────────────────────────────────────────────────────

describe("residualSigma / predictionIntervals", () => {
  it("residualSigma: null when empty, 0 when constant, exact stdev otherwise", () => {
    expect(residualSigma([])).toBeNull();
    expect(residualSigma([2, 2, 2])).toBe(0);
    expect(residualSigma([1, -1, 1, -1])).toBe(1);
  });

  it("bands are ±1.28σ√h around the point forecast", () => {
    const { lo, hi } = predictionIntervals([100, 100], 10, "A");
    expect(lo[0]).toBe(87); // 100 − 12.8
    expect(hi[0]).toBe(113);
    expect(lo[1]).toBe(82); // 100 − 12.8·√2 ≈ 100 − 18.1
    expect(hi[1]).toBe(118);
  });

  it("the lower bound is clamped at 0", () => {
    const { lo, hi } = predictionIntervals([5], 10, "D");
    expect(lo[0]).toBe(0);
    expect(hi[0]).toBe(33); // 5 + 1.28·10·2.2 ≈ 33.2 → widened by grade D
  });

  it("worse grades widen the band", () => {
    const a = predictionIntervals([1000], 50, "A");
    const d = predictionIntervals([1000], 50, "D");
    expect(d.hi[0]).toBeGreaterThan(a.hi[0]);
    expect(d.lo[0]).toBeLessThan(a.lo[0]);
  });
});

// ── weekly grid materialization ───────────────────────────────────────────────

function week(
  mrrCents: number,
  activeSubscribers: number,
  netRevenueCents = 0,
  newSubscribers = 0,
): WeeklyObservation {
  return { mrrCents, activeSubscribers, netRevenueCents, newSubscribers };
}

describe("materializeWeeklyGrid", () => {
  it("returns an empty grid for no observations", () => {
    const grid = materializeWeeklyGrid(new Map());
    expect(grid.weeks).toEqual([]);
    expect(grid.filledWeeks).toEqual([]);
  });

  it("passes contiguous weeks through untouched", () => {
    const grid = materializeWeeklyGrid(
      new Map([
        ["2026-06-01", week(100, 10)],
        ["2026-06-08", week(110, 11)],
      ]),
    );
    expect(grid.weeks).toEqual(["2026-06-01", "2026-06-08"]);
    expect(grid.filledWeeks).toEqual([]);
    expect(grid.mrrCents).toEqual([100, 110]);
  });

  it("fills gaps by carrying the last snapshot forward (audit fix)", () => {
    const grid = materializeWeeklyGrid(
      new Map([
        ["2026-06-01", week(100, 10, 500, 5)],
        ["2026-06-15", week(130, 13, 800, 8)],
      ]),
    );
    expect(grid.weeks).toEqual(["2026-06-01", "2026-06-08", "2026-06-15"]);
    expect(grid.filledWeeks).toEqual(["2026-06-08"]);
    expect(grid.mrrCents).toEqual([100, 100, 130]);
    expect(grid.activeSubscribers).toEqual([10, 10, 13]);
    expect(grid.newSubscribers).toEqual([5, 5, 8]);
  });

  it("exposes the churn split and paused snapshot for future models (FR-6c)", () => {
    // No model consumes these yet — the grid carries them so a future
    // outflow/pause model starts with history from day one.
    const grid = materializeWeeklyGrid(
      new Map([
        [
          "2026-06-01",
          {
            ...week(100, 10, 500, 5),
            churnedVoluntary: 2,
            churnedInvoluntary: 1,
            pausedSubscribers: 4,
          },
        ],
        ["2026-06-08", week(110, 11)],
      ]),
    );
    expect(grid.churnedVoluntary).toEqual([2, 0]);
    expect(grid.churnedInvoluntary).toEqual([1, 0]);
    expect(grid.pausedSubscribers).toEqual([4, 0]);
  });

  it("a snapshotFabricated week keeps its real flows, carries snapshots forward and is annotated", () => {
    const grid = materializeWeeklyGrid(
      new Map([
        ["2026-06-01", week(100, 10, 500, 5)],
        [
          "2026-06-08",
          { ...week(0, 0, 700, 7), snapshotFabricated: true },
        ],
        ["2026-06-15", week(130, 13, 800, 8)],
      ]),
    );
    expect(grid.filledWeeks).toEqual(["2026-06-08"]);
    expect(grid.mrrCents).toEqual([100, 100, 130]); // snapshot carried, not 0
    expect(grid.activeSubscribers).toEqual([10, 10, 13]);
    expect(grid.netRevenueCents).toEqual([500, 700, 800]); // flows stay real
    expect(grid.newSubscribers).toEqual([5, 7, 8]);
  });
});

// ── getForecast (mocked prisma) ───────────────────────────────────────────────

function rollupRow(
  dayKey: string,
  mrrCents: number,
  activeSubscribers: number,
  chargedCents = 0,
  newSubscribers = 5,
  extra?: Partial<{
    refundedCents: number;
    churnedVoluntary: number;
    churnedInvoluntary: number;
    pausedSubscribers: number;
    snapshotFabricated: boolean;
  }>,
) {
  return {
    date: new Date(`${dayKey}T00:00:00.000Z`),
    mrrCents,
    activeSubscribers,
    chargedCents,
    newSubscribers,
    refundedCents: 0,
    churnedVoluntary: 0,
    churnedInvoluntary: 0,
    pausedSubscribers: 0,
    snapshotFabricated: false,
    ...extra,
  };
}

/** Young launch book: nobody cancelled yet, most waiting on their 2nd cycle. */
const YOUNG_BOOK_GROUPS = [
  { ordersCount: 0, status: "ACTIVE", _count: { _all: 40 } },
  { ordersCount: 1, status: "ACTIVE", _count: { _all: 50 } },
  { ordersCount: 2, status: "ACTIVE", _count: { _all: 10 } },
];

// A Wednesday in the week AFTER the last fixture rollup ("2026-07-06"), so
// every fixture week is complete: the in-progress calendar week is excluded
// from the series (partial-week audit fix), and these fixtures pin the
// complete-week behavior. MID_LAST_WEEK below pins the exclusion itself.
const NOW = new Date("2026-07-15T12:00:00.000Z");

function mockShop(opts?: {
  rollups?: ReturnType<typeof rollupRow>[];
  activeCount?: number;
  intervalWeeks?: number | null;
  groups?: typeof YOUNG_BOOK_GROUPS;
  /** Shop IANA timezone — the label space DailyRollup rows live in. */
  timezone?: string;
}) {
  // getForecast loads the Shop row for its ianaTimezone: every week-bucketing
  // decision is made in the shop-local label space of DailyRollup.
  db.shop.findUnique.mockResolvedValue({
    id: "shop1",
    ianaTimezone: opts?.timezone ?? "UTC",
    currencyCode: "CHF",
  });
  db.dailyRollup.findMany.mockResolvedValue(
    opts?.rollups ?? [
      rollupRow("2026-06-01", 100_000, 100, 20_000),
      rollupRow("2026-06-08", 110_000, 110, 22_000),
      rollupRow("2026-06-15", 120_000, 120, 24_000),
      // 2026-06-22 missing — rollup job downtime
      rollupRow("2026-06-29", 140_000, 140, 28_000),
      rollupRow("2026-07-06", 150_000, 240, 30_000),
    ],
  );
  db.subscriptionContract.count.mockResolvedValue(opts?.activeCount ?? 252);
  db.subscriptionContract.aggregate.mockResolvedValue({
    _avg: { intervalWeeks: opts?.intervalWeeks === undefined ? 8 : opts.intervalWeeks },
  });
  db.subscriptionContract.groupBy.mockResolvedValue(opts?.groups ?? YOUNG_BOOK_GROUPS);
}

describe("getForecast", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("materializes gap weeks, anchors on the last snapshot and returns both shapes", async () => {
    mockShop();
    const result = await getForecast("shop1", { model: "naive", now: NOW });

    expect(result.selectedModel).toBe("naive");
    expect(result.horizonWeeks).toBe(12);

    // Gap week materialized and annotated; value carried forward.
    expect(result.historyWeeks).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
      "2026-07-06",
    ]);
    expect(result.series.mrrCents.filledWeeks).toEqual(["2026-06-22"]);
    expect(result.series.mrrCents.history[3]).toEqual({
      weekStartIso: "2026-06-22",
      value: 120_000,
    });

    // Projection is anchored at the LAST OBSERVED snapshot (240), never the
    // live count (252) — the audit's step-at-the-divider fix.
    expect(result.series.activeSubscribers.forecast).toHaveLength(12);
    for (const point of result.series.activeSubscribers.forecast) {
      expect(point.value).toBe(240);
    }
    expect(result.series.mrrCents.forecast[0]).toMatchObject({
      weekStartIso: "2026-07-13",
      value: 150_000,
    });

    // Bands: lo ≤ value ≤ hi, lo never negative, non-degenerate width.
    for (const point of result.series.mrrCents.forecast) {
      expect(point.lo).toBeGreaterThanOrEqual(0);
      expect(point.lo).toBeLessThanOrEqual(point.value);
      expect(point.hi).toBeGreaterThan(point.value);
    }

    // Legacy v1 fields stay consistent with the v2 series.
    expect(result.projectedWeeks[0]).toBe("2026-07-13");
    expect(result.projectedMrrCents).toEqual(
      result.series.mrrCents.forecast.map((p) => p.value),
    );
    expect(result.projectedActiveSubscribers).toEqual(
      result.series.activeSubscribers.forecast.map((p) => p.value),
    );
    expect(result.historyMrrCents[3]).toBe(120_000);

    // Censoring fix: the young book gets the conservative default survival,
    // not the 0.17 churn-catastrophe artifact.
    expect(result.model.avgCycleSurvival).toBe(0.9);
    expect(result.model.weeklyRetention).toBeCloseTo(Math.pow(0.9, 1 / 8), 3);

    // Accuracy honesty: 5 observed weeks → D, with the gap called out.
    expect(result.accuracy.grade).toBe("D");
    expect(result.accuracy.reasons.join(" ")).toContain("5 weeks of history");
    expect(result.accuracy.reasons.join(" ")).toContain("1 missing week");

    // Model registry: all five reported (blend joined in v1.5.0), seasonal
    // refuses at 6 weeks, exactly one recommendation.
    expect(result.models.map((m) => m.key)).toEqual([
      "naive",
      "trend",
      "seasonal",
      "cohort",
      "blend",
    ]);
    const seasonal = result.models.find((m) => m.key === "seasonal")!;
    expect(seasonal.available).toBe(false);
    expect(seasonal.backtestMape).toBeNull();
    expect(result.models.filter((m) => m.recommended)).toHaveLength(1);
  });

  it("falls back to auto with an explanation when the requested model refuses", async () => {
    mockShop();
    const result = await getForecast("shop1", { model: "seasonal", now: NOW });
    expect(result.selectedModel).not.toBe("seasonal");
    const recommended = result.models.find((m) => m.recommended)!;
    expect(result.selectedModel).toBe(recommended.key);
    expect(result.accuracy.reasons.join(" ")).toContain('"seasonal"');
  });

  it("clamps the horizon to 1..52 weeks", async () => {
    mockShop();
    const short = await getForecast("shop1", {
      model: "naive",
      horizonWeeks: 0,
      now: NOW,
    });
    expect(short.series.mrrCents.forecast).toHaveLength(1);
    expect(short.horizonWeeks).toBe(1);

    mockShop();
    const long = await getForecast("shop1", {
      model: "naive",
      horizonWeeks: 100,
      now: NOW,
    });
    expect(long.horizonWeeks).toBe(52);
    expect(long.series.mrrCents.forecast).toHaveLength(52);
  });

  it("accepts the legacy (shopId, Date) call signature", async () => {
    mockShop();
    const result = await getForecast("shop1", NOW);
    expect(result.historyWeeks).toHaveLength(6);
    expect(result.series.mrrCents.forecast).toHaveLength(12);
  });

  it("no rollup history: one synthetic live-anchored week, naive model, grade D", async () => {
    mockShop({ rollups: [], activeCount: 3, intervalWeeks: null, groups: [] });
    db.shop.findUnique.mockResolvedValue({
      id: "shop1",
      ianaTimezone: "UTC",
      currencyCode: "CHF",
    });
    db.subscriptionContract.findMany.mockResolvedValue([
      {
        intervalWeeks: 4,
        deliveryPriceCents: 0,
        currencyCode: "CHF",
        lines: [{ quantity: 1, currentPriceCents: 8000, isOneTimeAddon: false }],
      },
    ]);

    const result = await getForecast("shop1", { now: NOW });
    // live MRR = round(8000 · 4.345 / 4) = 8690, anchored on this week's Monday.
    expect(result.historyWeeks).toEqual(["2026-07-13"]);
    expect(result.series.mrrCents.history).toEqual([
      { weekStartIso: "2026-07-13", value: 8690 },
    ]);
    expect(result.series.activeSubscribers.history[0].value).toBe(3);

    expect(result.selectedModel).toBe("naive");
    for (const point of result.series.mrrCents.forecast) {
      expect(point.value).toBe(8690);
      expect(point.lo).toBeGreaterThanOrEqual(0);
    }
    expect(result.accuracy.grade).toBe("D");
    expect(result.accuracy.reasons[0]).toContain("No weekly rollup history yet");
  });

  // ── Partial-week exclusion (audit fix): only COMPLETE calendar weeks enter
  //    the series ────────────────────────────────────────────────────────────
  const MID_LAST_WEEK = new Date("2026-07-08T12:00:00.000Z"); // Wed of the 07-06 week

  it("excludes the in-progress week — a partial bucket never anchors the forecast", async () => {
    mockShop(); // last fixture row 2026-07-06 = Monday of NOW's week here
    const result = await getForecast("shop1", { model: "naive", now: MID_LAST_WEEK });

    // The current week's lone Monday rollup (150k MRR / 240 actives / 30k
    // charged-in-one-day) is NOT an observation; the series ends on the last
    // complete week.
    expect(result.historyWeeks).toEqual([
      "2026-06-01",
      "2026-06-08",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
    ]);
    expect(result.historyMrrCents.at(-1)).toBe(140_000);

    // The projection starts AT the excluded in-progress week, anchored on the
    // last complete snapshot — the current week is a forecast point, not a
    // fake actual.
    expect(result.series.mrrCents.forecast[0]).toMatchObject({
      weekStartIso: "2026-07-06",
      value: 140_000,
    });
    for (const point of result.series.activeSubscribers.forecast) {
      expect(point.value).toBe(140);
    }
  });

  it("the flow-metric horizon anchors on a full week's revenue, never the days elapsed so far", async () => {
    // Shop bills ~10 000/week. On Wednesday only Mon+Tue have rolled up
    // (2×1400 = 2800) — the audit's 72%-under-forecast scenario.
    mockShop({
      rollups: [
        rollupRow("2026-06-01", 100_000, 100, 10_000),
        rollupRow("2026-06-08", 100_000, 100, 10_000),
        rollupRow("2026-06-15", 100_000, 100, 10_000),
        rollupRow("2026-06-22", 100_000, 100, 10_000),
        rollupRow("2026-06-29", 100_000, 100, 10_000),
        rollupRow("2026-07-06", 100_000, 100, 1_400), // Mon of the current week
        rollupRow("2026-07-07", 100_000, 100, 1_400), // Tue
      ],
    });
    const result = await getForecast("shop1", { model: "naive", now: MID_LAST_WEEK });
    expect(result.series.netRevenueCents.history.at(-1)).toEqual({
      weekStartIso: "2026-06-29",
      value: 10_000,
    });
    for (const point of result.series.netRevenueCents.forecast) {
      expect(point.value).toBe(10_000); // not 2 800
    }
  });

  // ── Net revenue vs refunds. Netting (charged − refunded) is the OFF-mode of
  //    the v1.16.0 exclude-refunded option; under the shipped DEFAULT the
  //    rollup's chargedCents already excludes refunded payments, so the
  //    forecast must read charged alone or the money is dropped twice. ──────
  const REFUND_WEEK_ROLLUPS = () => [
    rollupRow("2026-06-01", 100_000, 100, 20_000),
    // Two rollup days in one week: 22 000 charged, 5 000 refunded.
    rollupRow("2026-06-08", 110_000, 110, 12_000, 5, { refundedCents: 3_000 }),
    rollupRow("2026-06-10", 110_000, 110, 10_000, 0, { refundedCents: 2_000 }),
    rollupRow("2026-06-15", 120_000, 120, 24_000),
    rollupRow("2026-06-22", 130_000, 130, 26_000),
    rollupRow("2026-06-29", 140_000, 140, 28_000),
    rollupRow("2026-07-06", 150_000, 240, 30_000),
  ];

  /** Store an analytics-settings row; other keys keep falling back to defaults. */
  function mockAnalyticsSetting(excludeRefundedPayments: boolean) {
    db.setting.findUnique.mockImplementation(
      async (args: { where: { shopId_key: { key: string } } }) =>
        args.where.shopId_key.key === "analytics"
          ? { value: { excludeRefundedPayments } }
          : null,
    );
  }

  it("subtracts refundedCents from the weekly series when exclusion is OFF (netting mode)", async () => {
    mockShop({ rollups: REFUND_WEEK_ROLLUPS() });
    mockAnalyticsSetting(false);
    const result = await getForecast("shop1", { model: "naive", now: NOW });
    expect(result.series.netRevenueCents.history[1]).toEqual({
      weekStartIso: "2026-06-08",
      value: 17_000, // 22 000 charged − 5 000 refunded, NOT gross 22 000
    });
    // Un-refunded weeks are untouched.
    expect(result.series.netRevenueCents.history[0].value).toBe(20_000);
  });

  it("reads charged alone under refund exclusion (the default) — no double subtraction", async () => {
    // No stored analytics row (the upgrade case): the zod default applies.
    mockShop({ rollups: REFUND_WEEK_ROLLUPS() });
    const result = await getForecast("shop1", { model: "naive", now: NOW });
    expect(result.series.netRevenueCents.history[1]).toEqual({
      weekStartIso: "2026-06-08",
      // The rollup already dropped refunded payments from chargedCents;
      // subtracting the recorded 5 000 again would double-count the refund.
      value: 22_000,
    });
  });

  it("a refund-heavier-than-charges week clamps at 0 instead of going negative", async () => {
    mockShop({
      rollups: [
        rollupRow("2026-06-22", 130_000, 130, 26_000),
        // Refunds recorded this week exceed its charges (they net charges of
        // PRIOR weeks — refunds book on their recorded day).
        rollupRow("2026-06-29", 140_000, 140, 1_000, 5, { refundedCents: 9_000 }),
        rollupRow("2026-07-06", 150_000, 240, 30_000),
      ],
    });
    mockAnalyticsSetting(false); // netting mode — the only mode that subtracts
    const result = await getForecast("shop1", { model: "naive", now: NOW });
    const clamped = result.series.netRevenueCents.history.find(
      (p) => p.weekStartIso === "2026-06-29",
    )!;
    expect(clamped.value).toBe(0);
    for (const p of result.series.netRevenueCents.history) {
      expect(p.value).toBeGreaterThanOrEqual(0);
    }
  });

  // ── Gap-backfilled weeks (FR-3 / I1): snapshotFabricated rows carry real
  //    flows but zeroed snapshots — never observed history ───────────────────
  it("a week of backfilled rollups is annotated and its snapshots carried forward", async () => {
    mockShop({
      rollups: [
        rollupRow("2026-06-01", 100_000, 100, 20_000),
        rollupRow("2026-06-08", 110_000, 110, 22_000),
        // The whole 06-15 week was gap-backfilled: flow columns recomputed
        // from source, snapshot columns left at 0 (I1).
        rollupRow("2026-06-15", 0, 0, 24_000, 5, { snapshotFabricated: true }),
        rollupRow("2026-06-29", 140_000, 140, 28_000),
        rollupRow("2026-07-06", 150_000, 240, 30_000),
      ],
    });
    const result = await getForecast("shop1", { model: "naive", now: NOW });

    // Annotated exactly like a missing week (the honesty reason fires for
    // both); the wholly-absent 06-22 week is annotated alongside.
    expect(result.series.mrrCents.filledWeeks).toEqual([
      "2026-06-15",
      "2026-06-22",
    ]);
    expect(result.accuracy.reasons.join(" ")).toContain("2 missing weeks");

    // Snapshots carried forward — the backfill's zeros never chart as a
    // collapse — while the week's REAL flow total stays its own.
    expect(result.series.mrrCents.history[2]).toEqual({
      weekStartIso: "2026-06-15",
      value: 110_000,
    });
    expect(result.series.activeSubscribers.history[2].value).toBe(110);
    expect(result.series.netRevenueCents.history[2].value).toBe(24_000);
  });

  it("a week with a real rollup next to backfilled ones keeps the real snapshot and is NOT annotated", async () => {
    mockShop({
      rollups: [
        rollupRow("2026-06-01", 100_000, 100, 20_000),
        // Mixed week: Monday backfilled, Wednesday real — the real row is
        // the week's snapshot and the week counts as observed.
        rollupRow("2026-06-08", 0, 0, 10_000, 5, { snapshotFabricated: true }),
        rollupRow("2026-06-10", 112_000, 112, 12_000, 0),
        rollupRow("2026-06-15", 120_000, 120, 24_000),
        rollupRow("2026-06-22", 130_000, 130, 26_000),
        rollupRow("2026-06-29", 140_000, 140, 28_000),
        rollupRow("2026-07-06", 150_000, 240, 30_000),
      ],
    });
    const result = await getForecast("shop1", { model: "naive", now: NOW });
    expect(result.series.mrrCents.filledWeeks).toEqual([]);
    expect(result.series.mrrCents.history[1]).toEqual({
      weekStartIso: "2026-06-08",
      value: 112_000,
    });
    expect(result.series.netRevenueCents.history[1].value).toBe(22_000);
  });

  it("is deterministic within a week — Tuesday and Saturday agree given the same data", async () => {
    mockShop();
    const tuesday = await getForecast("shop1", {
      model: "naive",
      now: new Date("2026-07-07T09:00:00.000Z"),
    });
    mockShop();
    const saturday = await getForecast("shop1", {
      model: "naive",
      now: new Date("2026-07-11T21:00:00.000Z"),
    });
    expect(tuesday.historyWeeks).toEqual(saturday.historyWeeks);
    expect(tuesday.projectedMrrCents).toEqual(saturday.projectedMrrCents);
    expect(tuesday.projectedActiveSubscribers).toEqual(
      saturday.projectedActiveSubscribers,
    );
  });

  it("drops the leading week truncated by the mid-week history cutoff", async () => {
    // subWeeks(2026-07-08T12:00, HISTORY_WEEKS=78) = 2025-01-08T12:00 (a
    // Wednesday), so the 2025-01-06 week's rollups start mid-week — a
    // truncated flow bucket that must not enter the series (nor drag 70
    // carried-forward fill weeks in).
    mockShop({
      rollups: [
        rollupRow("2025-01-09", 90_000, 90, 4_000),
        rollupRow("2026-06-01", 100_000, 100, 20_000),
        rollupRow("2026-06-08", 110_000, 110, 22_000),
        rollupRow("2026-06-15", 120_000, 120, 24_000),
        rollupRow("2026-06-22", 130_000, 130, 26_000),
        rollupRow("2026-06-29", 140_000, 140, 28_000),
      ],
    });
    const result = await getForecast("shop1", { model: "naive", now: MID_LAST_WEEK });
    expect(result.historyWeeks[0]).toBe("2026-06-01");
    expect(result.historyWeeks).toHaveLength(5);
    expect(result.series.mrrCents.filledWeeks).toEqual([]);
  });

  it("HISTORY_WEEKS spans at least a full year — collected annual seasonality is readable (FR-6)", () => {
    // 26 weeks made every rollup beyond six months structurally unreadable:
    // two years of collected history could never inform any model. The
    // constant is pinned ≥ 52 so a future annual-seasonal model has a full
    // year plus margin in view.
    expect(HISTORY_WEEKS).toBeGreaterThanOrEqual(52);
  });

  // ── Shop-timezone label space (regression): DailyRollup rows are labeled by
  //    the SHOP-LOCAL calendar day, so "the current week" must be keyed off
  //    the shop-local date — during the hours when the shop-local and UTC
  //    dates disagree, keying off UTC excluded the WRONG bucket. ─────────────
  describe("shop-local week boundary (rollup label space)", () => {
    it("UTC+ shop just past local Monday midnight: the completed week survives, the 2-hour bucket is dropped", async () => {
      // Europe/Zurich (UTC+2 in August). now = Sunday 22:30 UTC = shop-local
      // Monday 00:30. rollup_run has already stamped a today-so-far row
      // labeled 2026-08-10 carrying ~2 hours of charges. UTC keying computed
      // currentWeekKey = 2026-08-03 and deleted the just-COMPLETED week,
      // leaving the 1-day 08-10 bucket as the newest "complete" week — naive
      // anchored the whole netRevenue horizon on 2 hours of money.
      mockShop({
        timezone: "Europe/Zurich",
        rollups: [
          rollupRow("2026-07-06", 100_000, 100, 10_000),
          rollupRow("2026-07-13", 100_000, 100, 10_000),
          rollupRow("2026-07-20", 100_000, 100, 10_000),
          rollupRow("2026-07-27", 100_000, 100, 10_000),
          rollupRow("2026-08-03", 100_000, 100, 10_000), // completed at local midnight
          rollupRow("2026-08-10", 100_000, 100, 90), // today so far: 2h of charges
        ],
      });
      const result = await getForecast("shop1", {
        model: "naive",
        now: new Date("2026-08-09T22:30:00.000Z"),
      });

      // The just-completed 08-03 week is the newest observation…
      expect(result.historyWeeks).toEqual([
        "2026-07-06",
        "2026-07-13",
        "2026-07-20",
        "2026-07-27",
        "2026-08-03",
      ]);
      // …and the in-progress 08-10 bucket never enters the series.
      expect(result.series.netRevenueCents.history.at(-1)).toEqual({
        weekStartIso: "2026-08-03",
        value: 10_000,
      });
      expect(result.series.netRevenueCents.forecast[0]).toMatchObject({
        weekStartIso: "2026-08-10",
        value: 10_000, // a full week's revenue, not the 90-cent partial
      });
    });

    it("UTC− shop still in local Sunday evening: the in-progress bucket is dropped, not retained", async () => {
      // America/Los_Angeles (UTC−7 in August). now = Monday 03:00 UTC = shop
      // Sunday 20:00 — the shop-local 08-03 week is STILL in progress. UTC
      // keying computed currentWeekKey = 2026-08-10, so the delete was a
      // no-op and the partial 08-03 bucket survived as a fake actual.
      mockShop({
        timezone: "America/Los_Angeles",
        rollups: [
          rollupRow("2026-07-06", 100_000, 100, 10_000),
          rollupRow("2026-07-13", 100_000, 100, 10_000),
          rollupRow("2026-07-20", 100_000, 100, 10_000),
          rollupRow("2026-07-27", 100_000, 100, 10_000),
          rollupRow("2026-08-03", 100_000, 100, 1_400), // Mon of the in-progress week
          rollupRow("2026-08-09", 100_000, 100, 1_400), // today so far (local Sunday)
        ],
      });
      const result = await getForecast("shop1", {
        model: "naive",
        now: new Date("2026-08-10T03:00:00.000Z"),
      });

      expect(result.historyWeeks).toEqual([
        "2026-07-06",
        "2026-07-13",
        "2026-07-20",
        "2026-07-27",
      ]);
      expect(result.series.netRevenueCents.history.at(-1)).toEqual({
        weekStartIso: "2026-07-27",
        value: 10_000,
      });
      // The projection starts AT the still-in-progress week.
      expect(result.series.netRevenueCents.forecast[0]).toMatchObject({
        weekStartIso: "2026-08-03",
        value: 10_000,
      });
    });
  });
});

// ── Self-improvement (v1.5.0): weighted history, blend, persisted accuracy ────

describe("exponentiallyWeightedError", () => {
  /** Contiguous Monday keys starting 2026-06-01 — errors[i] is week i. */
  const weekly = (errors: Array<number | null | undefined>) =>
    errors.map((error, i) => ({
      weekStartIso: new Date(Date.UTC(2026, 5, 1) + i * 7 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      error,
    }));

  it("null on empty or all-null history — the caller falls back to the backtest", () => {
    expect(exponentiallyWeightedError([])).toBeNull();
    expect(exponentiallyWeightedError(weekly([null, undefined, null]))).toBeNull();
  });

  it("a single measured week is returned verbatim", () => {
    expect(exponentiallyWeightedError(weekly([0.25]))).toBe(0.25);
  });

  it("recent weeks weigh more than old ones (hand-computed, decay 0.85)", () => {
    // [old 0.5, new 0.1]: (0.85·0.5 + 1·0.1) / 1.85 = 0.28378…
    expect(exponentiallyWeightedError(weekly([0.5, 0.1]))).toBeCloseTo(
      0.525 / 1.85,
      10,
    );
    // The plain mean would be 0.3 — the EW mean leans toward the newer 0.1.
    expect(exponentiallyWeightedError(weekly([0.5, 0.1]))!).toBeLessThan(0.3);
    // Order matters: the mirrored series leans the other way.
    expect(exponentiallyWeightedError(weekly([0.1, 0.5]))!).toBeGreaterThan(0.3);
  });

  it("null gaps carry no weight but their weeks still count toward the decay", () => {
    // [0.4, null, 0.2] on contiguous weeks: weights 0.85², —, 1.
    expect(exponentiallyWeightedError(weekly([0.4, null, 0.2]))).toBeCloseTo(
      (0.7225 * 0.4 + 0.2) / 1.7225,
      10,
    );
  });

  it("decays by CALENDAR distance, not array position — history holes cannot compress time", () => {
    // Two entries, but the older one is 10 calendar weeks before the newer
    // (a 9-week recording outage between them). Positional decay would give
    // it weight 0.85¹ as if it were last week's error; calendar decay gives
    // 0.85¹⁰ — stale performance barely counts.
    const holey = [
      { weekStartIso: "2026-03-23", error: 0.5 },
      { weekStartIso: "2026-06-01", error: 0.1 },
    ];
    const d10 = Math.pow(0.85, 10);
    expect(exponentiallyWeightedError(holey)).toBeCloseTo(
      (d10 * 0.5 + 0.1) / (d10 + 1),
      10,
    );
    // …and therefore sits far closer to the recent error than the positional
    // weighting's 0.284 would.
    expect(exponentiallyWeightedError(holey)!).toBeLessThan(0.19);
  });

  it("a recently-better model beats a formerly-better one — the learning signal", () => {
    // Model A was bad, got good. Model B was good, got bad. Same plain mean.
    const recentlyGood = exponentiallyWeightedError(weekly([0.4, 0.3, 0.1, 0.05]))!;
    const recentlyBad = exponentiallyWeightedError(weekly([0.05, 0.1, 0.3, 0.4]))!;
    expect(recentlyGood).toBeLessThan(recentlyBad);
  });
});

describe("blendForecasts", () => {
  it("weights candidates by inverse error (hand-computed, ε = 0.01)", () => {
    // Errors 0.09 and 0.19 → weights 1/0.1 = 10 and 1/0.2 = 5.
    // Blend = (10·100 + 5·200) / 15 = 133.33 → 133.
    expect(
      blendForecasts(
        [
          { points: [100], error: 0.09 },
          { points: [200], error: 0.19 },
        ],
        1,
      ),
    ).toEqual([133]);
  });

  it("a lower-error candidate pulls the blend toward itself across the horizon", () => {
    const blend = blendForecasts(
      [
        { points: [100, 100], error: 0.01 },
        { points: [500, 500], error: 0.5 },
      ],
      2,
    )!;
    for (const v of blend) {
      expect(v).toBeGreaterThan(100);
      expect(v).toBeLessThan(300); // far closer to the accurate model
    }
  });

  it("candidates without history get the mean known error's weight", () => {
    // Known error 0.09 stands in for the unknown → equal weights → midpoint.
    expect(
      blendForecasts(
        [
          { points: [100], error: 0.09 },
          { points: [300], error: null },
        ],
        1,
      ),
    ).toEqual([200]);
  });

  it("no history at all → equal weights (graceful pre-history behavior)", () => {
    expect(
      blendForecasts(
        [
          { points: [100], error: null },
          { points: [300], error: null },
        ],
        1,
      ),
    ).toEqual([200]);
  });

  it("null without candidates; clamps at 0; missing horizon points read as 0", () => {
    expect(blendForecasts([], 4)).toBeNull();
    expect(
      blendForecasts([{ points: [-50], error: null }], 1),
    ).toEqual([0]);
    expect(
      blendForecasts([{ points: [100], error: null }], 2),
    ).toEqual([100, 0]);
  });
});

describe("historyErrorAsOf (fold-aware blend weights — the hindsight-leak guard)", () => {
  const entry = (
    weekStartIso: string,
    trendError: number,
  ): ForecastModelHistoryWeek => ({
    weekStartIso,
    recordedAt: `${weekStartIso}T02:00:00.000Z`,
    errors: { trend: trendError },
  });
  // Oldest first, as getForecast keeps priorWeeks.
  const history = [
    entry("2026-06-01", 0.5),
    entry("2026-06-08", 0.3),
    entry("2026-06-15", 0.01),
  ];

  it("only entries recorded no later than the fold's first evaluated week contribute", () => {
    // A fold evaluated on the week of 06-08 may use the 06-01 entry AND the
    // 06-08 entry (recorded during 06-08, it only encodes actuals of earlier
    // weeks) — but never the 06-15 entry, which was measured AFTER the fold's
    // evaluation week. Hand-computed EW (decay 0.85) over [0.5, 0.3]:
    // (0.85·0.5 + 1·0.3) / 1.85 = 0.72500 / 1.85 ≈ 0.39189.
    expect(historyErrorAsOf(history, "trend", "2026-06-08")).toBeCloseTo(
      0.39189,
      4,
    );
  });

  it("a live forward forecast (null restriction) uses the full history", () => {
    // EW over [0.5, 0.3, 0.01]:
    // (0.7225·0.5 + 0.85·0.3 + 1·0.01) / 2.5725 ≈ 0.24344.
    expect(historyErrorAsOf(history, "trend", null)).toBeCloseTo(0.24344, 4);
  });

  it("no usable entries → null (blend falls back to equal weights downstream)", () => {
    expect(historyErrorAsOf(history, "trend", "2026-05-01")).toBeNull();
    expect(historyErrorAsOf(history, "naive", null)).toBeNull(); // key never measured
    expect(historyErrorAsOf([], "trend", null)).toBeNull();
  });
});

describe("chooseModel with recorded history (recentWeightedMape)", () => {
  function weightedReport(
    key: ForecastModelKey,
    backtestMape: number | null,
    recentWeightedMape: number | null,
  ): ForecastModelReport {
    return {
      key,
      label: key,
      available: true,
      minWeeksRequired: 1,
      backtestMape,
      backtestBias: null,
      recentWeightedMape,
      recommended: false,
    };
  }

  it("ranks on the weighted history, not this week's backtest alone", () => {
    // naive looks great TODAY (0.05) but has been bad for weeks (0.4);
    // trend looks mediocre today (0.3) but has been consistently good (0.1).
    const reports = [
      weightedReport("naive", 0.05, 0.4),
      weightedReport("trend", 0.3, 0.1),
    ];
    expect(chooseModel(reports, "auto")).toBe("trend");
  });

  it("a model without history falls back to its backtest for the ranking", () => {
    const reports = [
      weightedReport("naive", 0.2, null), // ranks on 0.2
      weightedReport("trend", 0.5, 0.3), // ranks on 0.3
    ];
    expect(chooseModel(reports, "auto")).toBe("naive");
  });

  it("an explicit request still wins over the history ranking", () => {
    const reports = [
      weightedReport("naive", 0.05, 0.4),
      weightedReport("trend", 0.3, 0.1),
    ];
    expect(chooseModel(reports, "naive")).toBe("naive");
  });
});

describe("getForecast with persisted accuracy history", () => {
  /** Six flat weekly snapshots — every model that runs forecasts perfectly. */
  const FLAT_ROLLUPS = [
    rollupRow("2026-06-01", 100_000, 100, 20_000),
    rollupRow("2026-06-08", 100_000, 100, 20_000),
    rollupRow("2026-06-15", 100_000, 100, 20_000),
    rollupRow("2026-06-22", 100_000, 100, 20_000),
    rollupRow("2026-06-29", 100_000, 100, 20_000),
    rollupRow("2026-07-06", 100_000, 100, 20_000),
  ];

  /** Recorded history: trend has been beating naive for weeks. */
  const TREND_BEATS_NAIVE: ForecastModelHistoryWeek[] = [
    "2026-06-15",
    "2026-06-22",
    "2026-06-29",
  ].map((weekStartIso) => ({
    weekStartIso,
    recordedAt: `${weekStartIso}T02:00:00.000Z`,
    errors: { naive: 0.5, trend: 0.01, seasonal: null, cohort: 0.3, blend: 0.2 },
  }));

  function mockHistory(weeks: ForecastModelHistoryWeek[] | null) {
    db.setting.findUnique.mockImplementation(
      async (args: { where: { shopId_key: { key: string } } }) => {
        if (args.where.shopId_key.key !== "forecastModelHistory") return null;
        return weeks == null ? null : { value: { version: 1, weeks } };
      },
    );
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("auto-selection prefers the recently-better model on synthetic history", async () => {
    mockShop({ rollups: FLAT_ROLLUPS });
    mockHistory(TREND_BEATS_NAIVE);

    const result = await getForecast("shop1", { now: NOW });

    // This week's backtest says the models TIE (flat series, both perfect) —
    // pre-history that tie kept naive. The recorded weeks break it: trend has
    // been better recently, so auto now selects trend.
    const naive = result.models.find((m) => m.key === "naive")!;
    const trend = result.models.find((m) => m.key === "trend")!;
    expect(naive.backtestMape).toBe(0);
    expect(result.selectedModel).toBe("trend");
    expect(trend.recommended).toBe(true);
    expect(trend.recentWeightedMape!).toBeLessThan(naive.recentWeightedMape!);

    // The audit trail is surfaced…
    expect(result.modelHistory).toEqual({
      weeksRecorded: 3,
      latestWeek: "2026-06-29",
    });
    const reasons = result.accuracy.reasons.join(" ");
    expect(reasons).toContain("calibrated against 3 recorded weeks");
    // …including the plain-language proof the learning works: a beat streak.
    expect(reasons).toContain("3 straight recorded weeks");
  });

  it("an entry recorded earlier in the CURRENT week is superseded, never double-counted", async () => {
    mockShop({ rollups: FLAT_ROLLUPS });
    // A poisoned current-week entry that would flip the ranking if trusted:
    // naive suddenly "perfect", trend "terrible". It must be ignored — the
    // live backtest stands in for the current week.
    mockHistory([
      ...TREND_BEATS_NAIVE,
      {
        weekStartIso: "2026-07-13", // NOW's week
        recordedAt: "2026-07-13T02:00:00.000Z",
        errors: { naive: 0.0001, trend: 0.9, seasonal: null, cohort: 0.9, blend: 0.9 },
      },
    ]);

    const result = await getForecast("shop1", { now: NOW });
    expect(result.selectedModel).toBe("trend");
    // Prior-week count excludes the current week from the calibration note.
    expect(result.accuracy.reasons.join(" ")).toContain(
      "calibrated against 3 recorded weeks",
    );
  });

  it("degrades gracefully with EMPTY history — pre-history behavior exactly", async () => {
    mockShop({ rollups: FLAT_ROLLUPS });
    mockHistory(null); // nothing stored

    const result = await getForecast("shop1", { now: NOW });
    // Tie on a flat series keeps the earlier (simpler) model: naive.
    expect(result.selectedModel).toBe("naive");
    expect(result.modelHistory).toEqual({ weeksRecorded: 0, latestWeek: null });
    // With no history the weighted metric IS the backtest.
    for (const report of result.models) {
      if (report.available) {
        expect(report.recentWeightedMape).toBe(report.backtestMape);
      }
    }
    expect(result.accuracy.reasons.join(" ")).not.toContain("calibrated against");
  });

  it("a broken history read is contained — the forecast still returns", async () => {
    mockShop({ rollups: FLAT_ROLLUPS });
    db.setting.findUnique.mockRejectedValue(new Error("db exploded"));
    const result = await getForecast("shop1", { now: NOW });
    expect(result.selectedModel).toBe("naive");
    expect(result.series.mrrCents.forecast).toHaveLength(12);
  });

  it("an entry recorded AFTER a fold's evaluation weeks cannot re-weight that fold (hindsight-leak regression)", async () => {
    // A poisoned entry claims cohort was near-perfect and naive/trend
    // terrible. On the FLAT fixture the truth is the opposite: naive and
    // trend are exact, cohort drifts (decay + inflow). If the entry may
    // re-weight folds evaluated BEFORE it was recorded — the original leak —
    // blend's whole backtest goes cohort-heavy no matter where the entry
    // sits in the history, so both runs below score identically. Fold-aware
    // weighting instead confines the poison to folds evaluated on or after
    // its week: recorded in the NEWEST complete week it can only touch the
    // final fold, recorded before every fold it legitimately dominates all
    // of them — and blend's backtest error must be strictly lower in the
    // first case.
    const poison = (weekStartIso: string): ForecastModelHistoryWeek => ({
      weekStartIso,
      recordedAt: `${weekStartIso}T02:00:00.000Z`,
      errors: { naive: 5, trend: 5, seasonal: null, cohort: 0.0001, blend: 0.5 },
    });

    mockShop({ rollups: FLAT_ROLLUPS });
    mockHistory([poison("2026-07-06")]); // newest complete week
    const late = await getForecast("shop1", { now: NOW });
    const blendLate = late.models.find((m) => m.key === "blend")!;

    mockShop({ rollups: FLAT_ROLLUPS });
    mockHistory([poison("2026-06-01")]); // before every fold's evaluation weeks
    const early = await getForecast("shop1", { now: NOW });
    const blendEarly = early.models.find((m) => m.key === "blend")!;

    // Cohort genuinely errs on the flat series, so a cohort-dominated blend
    // is measurably worse — the leak would have hidden exactly this.
    expect(blendEarly.backtestMape!).toBeGreaterThan(0);
    expect(blendLate.backtestMape!).toBeLessThan(blendEarly.backtestMape!);
  });
});

describe("recordForecastAccuracyWeek", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.subscriberEvent.create.mockResolvedValue({});
    db.setting.upsert.mockResolvedValue({});
  });

  function upsertedHistory(): {
    weeks: ForecastModelHistoryWeek[];
  } {
    const call = db.setting.upsert.mock.calls.at(-1)![0] as {
      create: { value: { weeks: ForecastModelHistoryWeek[] } };
    };
    return call.create.value;
  }

  it("persists one entry for the current ISO week with per-model errors", async () => {
    mockShop();
    db.setting.findUnique.mockResolvedValue(null);

    const result = await recordForecastAccuracyWeek("shop1", NOW);
    expect(result.recorded).toBe(true);
    expect(result.weekStartIso).toBe("2026-07-13");
    expect(result.weeksRetained).toBe(1);

    const stored = upsertedHistory();
    expect(stored.weeks).toHaveLength(1);
    const entry = stored.weeks[0];
    expect(entry.weekStartIso).toBe("2026-07-13");
    // Every registered model has a slot; unavailable ones are null, not 0.
    expect(Object.keys(entry.errors).sort()).toEqual(
      ["blend", "cohort", "naive", "seasonal", "trend"].sort(),
    );
    expect(entry.errors.seasonal).toBeNull(); // needs 16 weeks, fixture has 6
    expect(typeof entry.errors.naive).toBe("number");
  });

  it("keys the entry to the SHOP-LOCAL week — a UTC+ shop past local midnight never overwrites the completed week", async () => {
    // Europe/Zurich, Sunday 22:30 UTC = shop-local Monday 00:30: the shop is
    // already in the NEW week. UTC keying stamped weekStartIso = 2026-08-03 —
    // overwriting the just-completed week's history entry with errors
    // measured against the new week's grid, an entry never rewritten once UTC
    // caught up (it poisoned the "auto" ranking for 26 weeks).
    mockShop({
      timezone: "Europe/Zurich",
      rollups: [
        rollupRow("2026-07-06", 100_000, 100, 10_000),
        rollupRow("2026-07-13", 100_000, 100, 10_000),
        rollupRow("2026-07-20", 100_000, 100, 10_000),
        rollupRow("2026-07-27", 100_000, 100, 10_000),
        rollupRow("2026-08-03", 100_000, 100, 10_000),
      ],
    });
    db.setting.findUnique.mockResolvedValue(null);

    const result = await recordForecastAccuracyWeek(
      "shop1",
      new Date("2026-08-09T22:30:00.000Z"),
    );
    expect(result.weekStartIso).toBe("2026-08-10"); // NOT 2026-08-03
    expect(upsertedHistory().weeks.map((w) => w.weekStartIso)).toEqual([
      "2026-08-10",
    ]);
  });

  it("re-running inside the same week is idempotent when nothing changed", async () => {
    mockShop();
    db.setting.findUnique.mockResolvedValue(null);
    await recordForecastAccuracyWeek("shop1", NOW);
    const firstWrite = upsertedHistory();

    // Second run, same week: the stored entry now matches what this run
    // measures → no rewrite, recorded: false.
    mockShop();
    db.setting.findUnique.mockResolvedValue({
      value: { version: 1, weeks: firstWrite.weeks },
    });
    const rerun = await recordForecastAccuracyWeek("shop1", NOW);
    expect(rerun.recorded).toBe(false);
    expect(db.setting.upsert).toHaveBeenCalledTimes(1); // only the first run wrote
  });

  it("records the newest complete week's TRUE out-of-sample error, never the backtest average", async () => {
    // Flat for five weeks, then a doubling in the newest complete week. A
    // real-time naive forecast standing one week earlier misses that week by
    // 50% — THAT is the week's honest error. The walk-forward average
    // (≈ 0.143 here) dilutes the miss across overlapping folds; recording it
    // weekly is what made the history entries near-perfectly correlated and
    // the beat-streak tautological (hindsight-leak audit, secondary finding).
    const JUMP_ROLLUPS = [
      rollupRow("2026-06-01", 100_000, 100, 20_000),
      rollupRow("2026-06-08", 100_000, 100, 20_000),
      rollupRow("2026-06-15", 100_000, 100, 20_000),
      rollupRow("2026-06-22", 100_000, 100, 20_000),
      rollupRow("2026-06-29", 100_000, 100, 20_000),
      rollupRow("2026-07-06", 200_000, 200, 40_000),
    ];
    mockShop({ rollups: JUMP_ROLLUPS });
    db.setting.findUnique.mockResolvedValue(null);

    await recordForecastAccuracyWeek("shop1", NOW);
    const entry = upsertedHistory().weeks[0];

    // |100k − 200k| / 200k = 0.5 on both refereed metrics (MRR + actives).
    expect(entry.errors.naive).toBeCloseTo(0.5, 4);

    // The same run's backtest AVERAGE is a very different number — proof the
    // recorded value is the single holdout week, not the fold average.
    mockShop({ rollups: JUMP_ROLLUPS });
    db.setting.findUnique.mockResolvedValue(null);
    const forecast = await getForecast("shop1", { now: NOW });
    const naive = forecast.models.find((m) => m.key === "naive")!;
    expect(naive.holdoutMape).toBeCloseTo(0.5, 4);
    expect(entry.errors.naive).toBe(naive.holdoutMape);
    expect(naive.backtestMape!).toBeLessThan(0.2);
    expect(entry.errors.naive).not.toBeCloseTo(naive.backtestMape!, 2);
  });

  it("caps the rolling history at FORECAST_HISTORY_WEEKS, dropping the oldest", async () => {
    const old: ForecastModelHistoryWeek[] = Array.from(
      { length: FORECAST_HISTORY_WEEKS },
      (_, i) => ({
        weekStartIso: `2025-${String(1 + Math.floor(i / 4)).padStart(2, "0")}-${String(
          1 + (i % 4) * 7,
        ).padStart(2, "0")}`,
        recordedAt: "2025-01-01T00:00:00.000Z",
        errors: { naive: 0.1 },
      }),
    );
    mockShop();
    db.setting.findUnique.mockResolvedValue({
      value: { version: 1, weeks: old },
    });

    const result = await recordForecastAccuracyWeek("shop1", NOW);
    expect(result.weeksRetained).toBe(FORECAST_HISTORY_WEEKS);
    const stored = upsertedHistory();
    expect(stored.weeks).toHaveLength(FORECAST_HISTORY_WEEKS);
    // The newest entry is in; the oldest recorded week fell off.
    expect(stored.weeks.at(-1)!.weekStartIso).toBe("2026-07-13");
    expect(
      stored.weeks.some((w) => w.weekStartIso === old[0].weekStartIso),
    ).toBe(false);
  });
});
