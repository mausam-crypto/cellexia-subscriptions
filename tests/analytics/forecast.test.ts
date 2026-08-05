/**
 * Unit tests for the pure forecast math in
 * app/services/analytics/forecast.server.ts: pSuccess decay, margin math,
 * CI bound ordering, week bucketing via startOfWeek, overdue-cycle collapse,
 * horizon-date capping, scenario multipliers, the survival-trend model, the
 * reliability estimator, snapshot-envelope parsing and row aggregation.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateForecastRows,
  BASE_FAILURE_RATE,
  ciBoundsCents,
  contributionFractionFor,
  DEFAULT_FORECAST_OPTIONS,
  DEFAULT_MARGIN_FRACTION,
  forecastContract,
  forecastReliability,
  marginFractionFor,
  observedRetentionFromCurve,
  parseForecastSnapshotRows,
  PHASE_FAILURE_RATES,
  SCENARIO_MULTIPLIERS,
  survivalTrendForecast,
} from "~/services/analytics/forecast.server";
import type {
  ContractForecastInput,
  ForecastAggregationContract,
  ForecastRow,
  ObservedSurvivalPoint,
  ReliabilityInput,
  SurvivalTrendForecastInput,
} from "~/services/analytics/forecast.server";
import { isoDate } from "~/lib/dates";

/** Tuesday 21 July 2026 — startOfWeek is Monday 20 July 2026. */
const NOW = new Date(Date.UTC(2026, 6, 21, 10, 0, 0));

function baseInput(overrides: Partial<ContractForecastInput> = {}): ContractForecastInput {
  return {
    nextBillingDate: new Date(Date.UTC(2026, 6, 29)), // Wed next week
    intervalWeeks: 4,
    orderValueCents: 10000,
    marginPercent: 0.7,
    churnRiskScore: 0,
    dunningPhase: "NONE",
    skipPropensity: 0,
    pausePropensity: 0,
    now: NOW,
    ...overrides,
  };
}

describe("forecastContract — week bucketing via startOfWeek", () => {
  it("buckets billing dates into Monday-start weeks relative to now", () => {
    const fc = forecastContract(baseInput());
    // Week 0 starts Monday 20 July 2026.
    expect(isoDate(fc.weeks[0].weekStart)).toBe("2026-07-20");
    // 29 July falls in the week starting Monday 27 July → weekIndex 1.
    expect(fc.cycles[0].weekIndex).toBe(1);
    // 4-week cadence: 26 Aug → weekIndex 5, 23 Sep → weekIndex 9.
    expect(fc.cycles[1].weekIndex).toBe(5);
    expect(fc.cycles[2].weekIndex).toBe(9);
    // Cycle 4 would land at weekIndex 13, outside a 13-week horizon.
    expect(fc.cycles).toHaveLength(3);
    expect(fc.weeks[1].cycleNumbers).toEqual([1]);
    expect(fc.weeks[5].cycleNumbers).toEqual([2]);
    expect(fc.weeks).toHaveLength(13);
  });

  it("clamps an overdue billing date into the current week", () => {
    const fc = forecastContract(
      baseInput({ nextBillingDate: new Date(Date.UTC(2026, 6, 11)) }),
    );
    expect(fc.cycles[0].weekIndex).toBe(0);
  });

  it("produces no cycles without a next billing date", () => {
    const fc = forecastContract(baseInput({ nextBillingDate: null }));
    expect(fc.cycles).toHaveLength(0);
    expect(fc.totalExpectedOrders).toBe(0);
    expect(fc.totalExpectedRevenueCents).toBe(0);
  });
});

describe("forecastContract — overdue cycles collapse into ONE next-charge event", () => {
  it("emits a single week-0 cycle for a contract 12 weeks overdue (was 4 clamped copies)", () => {
    // 4-weekly contract in GRACE with nextBillingDate 12 weeks in the past —
    // the normal state for a contract stuck in dunning. The old code emitted
    // cycles at raw weeks -12/-8/-4/0 and clamped ALL of them into week 0,
    // producing weeks[0].cycleNumbers = [1,2,3,4] and week-0 expectedOrders
    // ≈ 2.28 — more than two full orders from a contract that can bill at
    // most once this week.
    const fc = forecastContract(
      baseInput({
        nextBillingDate: new Date(Date.UTC(2026, 3, 27)), // Mon, week0 − 12w
        dunningPhase: "GRACE",
        churnRiskScore: 0.15,
      }),
    );

    // One collapsed overdue cycle in week 0, then the regular 4-week cadence.
    expect(fc.weeks[0].cycleNumbers).toEqual([1]);
    expect(fc.cycles.map((c) => c.weekIndex)).toEqual([0, 4, 8, 12]);
    // The collapsed cycle keeps the latest missed date (27 Apr + 12w = 20 Jul).
    expect(isoDate(fc.cycles[0].billingDate)).toBe("2026-07-20");

    // The single overdue charge carries the dunning-phase recovery
    // probability: pOrder = (1 − churn·0.35) × (1 − GRACE failure rate).
    const pCancelCycle = 0.15 * 0.35;
    const expectedWeek0 = (1 - pCancelCycle) * (1 - PHASE_FAILURE_RATES.GRACE);
    expect(fc.weeks[0].expectedOrders).toBeCloseTo(expectedWeek0, 10);
    expect(fc.weeks[0].expectedOrders).toBeCloseTo(0.47375, 6);
    // Never the multi-counted ≈2.28 the bug produced.
    expect(fc.weeks[0].expectedOrders).toBeLessThan(1);
  });

  it("keeps one week-0 cycle when the overdue schedule is misaligned with the week grid", () => {
    // Dates land at raw weeks -2/+2/+6/+10: the fast-forward must NOT skip
    // past week 0 (first cycle stays the overdue one, billed this week).
    const fc = forecastContract(
      baseInput({
        nextBillingDate: new Date(Date.UTC(2026, 6, 8)), // Wed, raw week −2
        dunningPhase: "RETRYING",
      }),
    );
    expect(fc.cycles.map((c) => c.weekIndex)).toEqual([0, 2, 6, 10]);
    expect(fc.weeks[0].cycleNumbers).toEqual([1]);
    // No missed intervals to collapse — the original date is preserved.
    expect(isoDate(fc.cycles[0].billingDate)).toBe("2026-07-08");
    // Cycle 1 uses the dunning-phase failure rate.
    expect(fc.cycles[0].pOrder).toBeCloseTo(1 - PHASE_FAILURE_RATES.RETRYING, 10);
  });
});

describe("forecastContract — horizon capped by date, not cycle count", () => {
  it("fills every horizon week for a weekly contract 5 weeks overdue (tail was truncated)", () => {
    // Old code: 5 clamped overdue cycles consumed the horizon+2 cycle budget,
    // so week 0 showed 6 cycles' worth and weeks 10-12 showed ZERO.
    const fc = forecastContract(
      baseInput({
        nextBillingDate: new Date(Date.UTC(2026, 5, 15)), // Mon, week0 − 5w
        intervalWeeks: 1,
      }),
    );
    expect(fc.cycles).toHaveLength(13);
    for (let w = 0; w < 13; w++) {
      expect(fc.weeks[w].cycleNumbers).toHaveLength(1);
      expect(fc.weeks[w].expectedRevenueCents).toBeGreaterThan(0);
    }
  });

  it("fills weeks 1-12 for a weekly contract 20 weeks overdue", () => {
    const fc = forecastContract(
      baseInput({
        nextBillingDate: new Date(Date.UTC(2026, 2, 2)), // Mon, week0 − 20w
        intervalWeeks: 1,
      }),
    );
    expect(fc.cycles).toHaveLength(13);
    for (let w = 1; w <= 12; w++) {
      expect(fc.weeks[w].cycleNumbers).toHaveLength(1);
    }
    expect(fc.weeks[0].cycleNumbers).toHaveLength(1);
  });
});

describe("forecastContract — pSuccess decay", () => {
  it("decays the order probability cycle over cycle when churn risk is present", () => {
    const fc = forecastContract(baseInput({ churnRiskScore: 0.5 }));
    expect(fc.cycles.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < fc.cycles.length; i++) {
      expect(fc.cycles[i].pOrder).toBeLessThan(fc.cycles[i - 1].pOrder);
      expect(fc.cycles[i].pOrder).toBeGreaterThan(0);
    }
    // Survival entering each later cycle also strictly decreases.
    for (let i = 1; i < fc.cycles.length; i++) {
      expect(fc.cycles[i].aliveBefore).toBeLessThan(fc.cycles[i - 1].aliveBefore);
    }
  });

  it("uses the dunning-phase failure rate on the first cycle only", () => {
    const fc = forecastContract(baseInput({ dunningPhase: "RETRYING" }));
    const first = fc.cycles[0];
    const second = fc.cycles[1];
    // Cycle 1: pOrder = (1 - phaseFailure); no churn/skip/pause configured.
    expect(first.pOrder).toBeCloseTo(1 - PHASE_FAILURE_RATES.RETRYING, 10);
    // Cycle 2 reverts to the base failure rate applied to the survivors.
    expect(second.pOrder).toBeCloseTo(
      second.aliveBefore * (1 - BASE_FAILURE_RATE),
      10,
    );
  });

  it("forecasts zero for exhausted dunning", () => {
    const fc = forecastContract(baseInput({ dunningPhase: "EXHAUSTED" }));
    expect(fc.cycles).toHaveLength(0);
    expect(fc.totalExpectedOrders).toBe(0);
    expect(fc.totalExpectedRevenueCents).toBe(0);
    expect(fc.totalExpectedMarginCents).toBe(0);
    expect(fc.weeks.every((w) => w.expectedRevenueCents === 0)).toBe(true);
  });

  it("reduces expected orders for skips without killing survival", () => {
    const noSkips = forecastContract(baseInput());
    const withSkips = forecastContract(baseInput({ skipPropensity: 0.5 }));
    expect(withSkips.cycles[0].pOrder).toBeCloseTo(
      noSkips.cycles[0].pOrder * 0.5,
      10,
    );
    // Skips do not remove the subscriber: survival into cycle 2 is unchanged.
    expect(withSkips.cycles[1].aliveBefore).toBeCloseTo(
      noSkips.cycles[1].aliveBefore,
      10,
    );
    expect(withSkips.cycles[0].pSkip).toBeGreaterThan(0);
  });
});

describe("forecastContract — scenario multipliers", () => {
  it("exports the exact contract multipliers", () => {
    expect(SCENARIO_MULTIPLIERS.BASE).toEqual({ churnSkip: 1, addOns: 1 });
    expect(SCENARIO_MULTIPLIERS.CONSERVATIVE).toEqual({
      churnSkip: 1.35,
      addOns: 0.5,
    });
    expect(SCENARIO_MULTIPLIERS.OPTIMISTIC).toEqual({
      churnSkip: 0.75,
      addOns: 1.15,
    });
  });

  it("scales the churn hazard by the scenario multiplier", () => {
    const base = forecastContract(baseInput({ churnRiskScore: 0.4 }));
    const conservative = forecastContract(
      baseInput({ churnRiskScore: 0.4, scenario: "CONSERVATIVE" }),
    );
    const optimistic = forecastContract(
      baseInput({ churnRiskScore: 0.4, scenario: "OPTIMISTIC" }),
    );
    expect(base.cycles[0].pCancel).toBeCloseTo(0.4 * 0.35, 10);
    expect(conservative.cycles[0].pCancel).toBeCloseTo(0.4 * 0.35 * 1.35, 10);
    expect(optimistic.cycles[0].pCancel).toBeCloseTo(0.4 * 0.35 * 0.75, 10);
  });

  it("scales the skip propensity by the scenario multiplier", () => {
    const base = forecastContract(baseInput({ skipPropensity: 0.4 }));
    const conservative = forecastContract(
      baseInput({ skipPropensity: 0.4, scenario: "CONSERVATIVE" }),
    );
    // pSkip event = (1 − pFail) × skipPropensity when churn/pause are 0.
    expect(base.cycles[0].pSkip).toBeCloseTo((1 - 0.04) * 0.4, 10);
    expect(conservative.cycles[0].pSkip).toBeCloseTo((1 - 0.04) * 0.54, 10);
  });

  it("orders scenario revenue conservative < base < optimistic under churn", () => {
    const conservative = forecastContract(
      baseInput({ churnRiskScore: 0.5, scenario: "CONSERVATIVE" }),
    );
    const base = forecastContract(baseInput({ churnRiskScore: 0.5 }));
    const optimistic = forecastContract(
      baseInput({ churnRiskScore: 0.5, scenario: "OPTIMISTIC" }),
    );
    expect(conservative.totalExpectedRevenueCents).toBeLessThan(
      base.totalExpectedRevenueCents,
    );
    expect(base.totalExpectedRevenueCents).toBeLessThan(
      optimistic.totalExpectedRevenueCents,
    );
  });
});

describe("forecastContract — revenue and margin math", () => {
  it("computes expected revenue and margin per week", () => {
    // 52-week cadence → exactly one cycle in the horizon.
    const fc = forecastContract(
      baseInput({
        intervalWeeks: 52,
        nextBillingDate: new Date(Date.UTC(2026, 6, 22)),
      }),
    );
    expect(fc.cycles).toHaveLength(1);
    const pOrder = fc.cycles[0].pOrder;
    expect(pOrder).toBeCloseTo(1 - BASE_FAILURE_RATE, 10);
    const week = fc.weeks[fc.cycles[0].weekIndex];
    expect(week.expectedRevenueCents).toBe(Math.round(pOrder * 10000));
    expect(week.expectedMarginCents).toBe(Math.round(pOrder * 10000 * 0.7));
    expect(fc.totalExpectedRevenueCents).toBe(week.expectedRevenueCents);
    expect(fc.totalExpectedMarginCents).toBe(week.expectedMarginCents);
  });

  it("keeps totals equal to the sum of the weekly values", () => {
    const fc = forecastContract(baseInput({ churnRiskScore: 0.3 }));
    const revenueSum = fc.weeks.reduce((s, w) => s + w.expectedRevenueCents, 0);
    const marginSum = fc.weeks.reduce((s, w) => s + w.expectedMarginCents, 0);
    const ordersSum = fc.weeks.reduce((s, w) => s + w.expectedOrders, 0);
    expect(fc.totalExpectedRevenueCents).toBe(revenueSum);
    expect(fc.totalExpectedMarginCents).toBe(marginSum);
    expect(fc.totalExpectedOrders).toBeCloseTo(ordersSum, 10);
  });

  it("clamps out-of-range inputs instead of producing nonsense", () => {
    const fc = forecastContract(
      baseInput({ churnRiskScore: 5, marginPercent: 2, skipPropensity: -1 }),
    );
    for (const cycle of fc.cycles) {
      expect(cycle.pOrder).toBeGreaterThanOrEqual(0);
      expect(cycle.pOrder).toBeLessThanOrEqual(1);
    }
    for (const week of fc.weeks) {
      expect(week.expectedMarginCents).toBeLessThanOrEqual(
        week.expectedRevenueCents,
      );
    }
  });
});

describe("survivalTrendForecast", () => {
  function trendInput(
    overrides: Partial<SurvivalTrendForecastInput> = {},
  ): SurvivalTrendForecastInput {
    return {
      nextBillingDate: new Date(Date.UTC(2026, 6, 29)),
      intervalWeeks: 4,
      orderValueCents: 10000,
      marginPercent: 0.7,
      retentionByCycle: [0.8, 0.75],
      voluntaryExitShare: 0.6,
      now: NOW,
      ...overrides,
    };
  }

  it("applies realised per-cycle retention to the schedule", () => {
    const fc = survivalTrendForecast(trendInput());
    expect(fc.cycles.map((c) => c.weekIndex)).toEqual([1, 5, 9]);

    // Cycle 1: retention 0.8.
    expect(fc.cycles[0].aliveBefore).toBeCloseTo(1, 10);
    expect(fc.cycles[0].pOrder).toBeCloseTo(0.8, 10);
    // Cycle 2: retention 0.75 on the survivors.
    expect(fc.cycles[1].aliveBefore).toBeCloseTo(0.8, 10);
    expect(fc.cycles[1].pOrder).toBeCloseTo(0.6, 10);
    // Cycle 3 reuses the last observed retention (0.75).
    expect(fc.cycles[2].aliveBefore).toBeCloseTo(0.6, 10);
    expect(fc.cycles[2].pOrder).toBeCloseTo(0.45, 10);

    expect(fc.totalExpectedOrders).toBeCloseTo(1.85, 10);
    expect(fc.weeks[1].expectedRevenueCents).toBe(8000);
    expect(fc.weeks[1].expectedMarginCents).toBe(5600);
  });

  it("splits exits into voluntary vs payment failure by the observed share", () => {
    const fc = survivalTrendForecast(trendInput());
    // Cycle 1 exit hazard = 0.2, split 60/40.
    expect(fc.cycles[0].pCancel).toBeCloseTo(0.12, 10);
    expect(fc.cycles[0].pFailedPayment).toBeCloseTo(0.08, 10);
    // Skips/pauses are folded into observed retention.
    expect(fc.cycles[0].pSkip).toBe(0);
    expect(fc.cycles[0].pPause).toBe(0);
  });

  it("applies the scenario multiplier to the exit hazard", () => {
    const conservative = survivalTrendForecast(
      trendInput({ scenario: "CONSERVATIVE" }),
    );
    const optimistic = survivalTrendForecast(
      trendInput({ scenario: "OPTIMISTIC" }),
    );
    // hazard 0.2 → ×1.35 = 0.27 → retention 0.73; ×0.75 = 0.15 → 0.85.
    expect(conservative.cycles[0].pOrder).toBeCloseTo(0.73, 10);
    expect(optimistic.cycles[0].pOrder).toBeCloseTo(0.85, 10);
  });

  it("collapses overdue cycles into a single week-0 charge like the contract model", () => {
    const fc = survivalTrendForecast(
      trendInput({ nextBillingDate: new Date(Date.UTC(2026, 3, 27)) }),
    );
    expect(fc.weeks[0].cycleNumbers).toEqual([1]);
    expect(fc.cycles.map((c) => c.weekIndex)).toEqual([0, 4, 8, 12]);
  });

  it("returns an empty forecast without retention data or billing date", () => {
    expect(
      survivalTrendForecast(trendInput({ retentionByCycle: [] })).cycles,
    ).toHaveLength(0);
    expect(
      survivalTrendForecast(trendInput({ nextBillingDate: null })).cycles,
    ).toHaveLength(0);
  });
});

describe("observedRetentionFromCurve", () => {
  function rebillPoint(
    threshold: number,
    remainingPercent: number,
    voluntary: number,
    payment: number,
    atRisk?: number,
  ): ObservedSurvivalPoint {
    return {
      kind: "REBILL",
      threshold,
      remainingPercent,
      voluntaryExitPercent: voluntary,
      paymentFailureExitPercent: payment,
      eligible: atRisk ?? 40,
      atRisk,
    };
  }

  const dayPoint: ObservedSurvivalPoint = {
    kind: "DAYS",
    threshold: 90,
    remainingPercent: 10,
    voluntaryExitPercent: 80,
    paymentFailureExitPercent: 10,
    eligible: 100,
  };

  it("derives per-cycle retention from the rebill checkpoints", () => {
    const observed = observedRetentionFromCurve([
      rebillPoint(1, 80, 12, 8),
      rebillPoint(2, 60, 25, 15),
      rebillPoint(3, 45, 33, 22),
      dayPoint, // DAYS checkpoints must be ignored
    ]);
    expect(observed).not.toBeNull();
    expect(observed!.observedCycles).toBe(3);
    expect(observed!.retentionByCycle[0]).toBeCloseTo(0.8, 10);
    expect(observed!.retentionByCycle[1]).toBeCloseTo(0.75, 10);
    expect(observed!.retentionByCycle[2]).toBeCloseTo(0.75, 10);
    // Voluntary share from the deepest usable point: 33 / (33 + 22).
    expect(observed!.voluntaryExitShare).toBeCloseTo(0.6, 10);
  });

  it("returns null when fewer than 2 completed cycles are observable", () => {
    // Only rebill 1 has at-risk contracts → not enough history for a trend.
    expect(
      observedRetentionFromCurve([
        rebillPoint(1, 80, 10, 10, 40),
        rebillPoint(2, 60, 20, 20, 0),
        rebillPoint(3, 45, 30, 25, 0),
      ]),
    ).toBeNull();
    expect(observedRetentionFromCurve([])).toBeNull();
  });

  it("stops the observable prefix at a null (not-yet-observable) checkpoint", () => {
    const unobserved: ObservedSurvivalPoint = {
      kind: "REBILL",
      threshold: 2,
      remainingPercent: null,
      voluntaryExitPercent: null,
      paymentFailureExitPercent: null,
      eligible: 0,
    };
    expect(
      observedRetentionFromCurve([rebillPoint(1, 80, 10, 10), unobserved]),
    ).toBeNull();
    const observed = observedRetentionFromCurve([
      rebillPoint(1, 80, 10, 10),
      rebillPoint(2, 60, 20, 20),
      { ...unobserved, threshold: 3 },
    ]);
    expect(observed).not.toBeNull();
    expect(observed!.observedCycles).toBe(2);
    expect(observed!.retentionByCycle).toHaveLength(2);
  });

  it("falls back to eligible when the additive atRisk field is absent", () => {
    const p1 = rebillPoint(1, 80, 10, 10);
    const p2 = { ...rebillPoint(2, 60, 20, 20), eligible: 0 };
    expect(observedRetentionFromCurve([p1, p2])).toBeNull();
    expect(
      observedRetentionFromCurve([p1, { ...p2, eligible: 5 }]),
    ).not.toBeNull();
  });

  it("defaults the voluntary share to 1 when no exits are observed", () => {
    const observed = observedRetentionFromCurve([
      rebillPoint(1, 100, 0, 0),
      rebillPoint(2, 100, 0, 0),
    ]);
    expect(observed!.voluntaryExitShare).toBe(1);
    expect(observed!.retentionByCycle).toEqual([1, 1]);
  });

  it("clamps a dead curve to zero retention without dividing by zero", () => {
    const observed = observedRetentionFromCurve([
      rebillPoint(1, 0, 90, 10),
      rebillPoint(2, 0, 90, 10),
    ]);
    expect(observed!.retentionByCycle).toEqual([0, 0]);
  });
});

describe("forecastReliability", () => {
  function relInput(overrides: Partial<ReliabilityInput> = {}): ReliabilityInput {
    return {
      activeContracts: 50,
      monthsOfHistory: 12,
      completedCycles: 100,
      productsWithCosts: 10,
      productsTotal: 10,
      cancelledObserved: 25,
      ...overrides,
    };
  }

  it("grades a well-fed shop HIGH with a ±12% band", () => {
    const r = forecastReliability(relInput());
    expect(r.grade).toBe("HIGH");
    expect(r.expectedErrorBand).toBe("±12%");
    expect(r.score).toBe(100);
    expect(r.reasons).toHaveLength(1);
  });

  it("boundary: 14 actives is LOW, 15 actives is MODERATE", () => {
    const low = forecastReliability(relInput({ activeContracts: 14 }));
    expect(low.grade).toBe("LOW");
    expect(low.expectedErrorBand).toBe("±50%");
    expect(
      low.reasons.some((reason) => reason.includes("Only 14 active contracts")),
    ).toBe(true);

    // 15 actives clears the LOW bar but not the ≥40 HIGH bar.
    const moderate = forecastReliability(relInput({ activeContracts: 15 }));
    expect(moderate.grade).toBe("MODERATE");
    expect(moderate.expectedErrorBand).toBe("±25%");
  });

  it("boundary: 2 months of history is LOW, 3 months is MODERATE", () => {
    const two = forecastReliability(
      relInput({ monthsOfHistory: 2, activeContracts: 20 }),
    );
    expect(two.grade).toBe("LOW");
    const three = forecastReliability(
      relInput({ monthsOfHistory: 3, activeContracts: 20 }),
    );
    expect(three.grade).toBe("MODERATE");
    // Under 2 months is the hard-LOW guarantee.
    expect(
      forecastReliability(relInput({ monthsOfHistory: 1.9 })).grade,
    ).toBe("LOW");
  });

  it("boundary: cost coverage 59% blocks HIGH, 60% allows it", () => {
    const below = forecastReliability(
      relInput({
        activeContracts: 40,
        monthsOfHistory: 6,
        completedCycles: 60,
        cancelledObserved: 10,
        productsWithCosts: 59,
        productsTotal: 100,
      }),
    );
    expect(below.grade).toBe("MODERATE");
    const at = forecastReliability(
      relInput({
        activeContracts: 40,
        monthsOfHistory: 6,
        completedCycles: 60,
        cancelledObserved: 10,
        productsWithCosts: 60,
        productsTotal: 100,
      }),
    );
    expect(at.grade).toBe("HIGH");
  });

  it("boundary: 9 observed cancellations block HIGH", () => {
    const r = forecastReliability(relInput({ cancelledObserved: 9 }));
    expect(r.grade).toBe("MODERATE");
  });

  it("boundary: fewer than 30 completed cycles blocks MODERATE", () => {
    const r = forecastReliability(
      relInput({ activeContracts: 20, completedCycles: 29 }),
    );
    expect(r.grade).toBe("LOW");
    expect(
      forecastReliability(relInput({ activeContracts: 20, completedCycles: 30 }))
        .grade,
    ).toBe("MODERATE");
  });

  it("phrases the history reason in plain weeks", () => {
    // 0.92 months ≈ 4 weeks of history.
    const r = forecastReliability(
      relInput({ monthsOfHistory: 0.92, activeContracts: 20 }),
    );
    expect(r.reasons).toContain(
      "Only 4 weeks of billing history — treat weeks 5+ as directional.",
    );
  });

  it("phrases the cost-coverage reason in plain language", () => {
    const r = forecastReliability(
      relInput({ productsWithCosts: 3, productsTotal: 9 }),
    );
    expect(r.reasons).toContain(
      "3 of 9 products have real cost data; profit lines use the default margin.",
    );
    const none = forecastReliability(
      relInput({ productsWithCosts: 0, productsTotal: 0 }),
    );
    expect(none.reasons).toContain(
      "No product cost data yet; profit lines use the default margin.",
    );
  });

  it("keeps the score inside 0-100 and monotone with input quality", () => {
    const empty = forecastReliability({
      activeContracts: 0,
      monthsOfHistory: 0,
      completedCycles: 0,
      productsWithCosts: 0,
      productsTotal: 0,
      cancelledObserved: 0,
    });
    expect(empty.grade).toBe("LOW");
    expect(empty.score).toBe(0);
    expect(empty.reasons.length).toBeGreaterThanOrEqual(3);
    expect(
      empty.reasons.includes(
        "No billing history yet — the forecast is a template, not a measurement.",
      ),
    ).toBe(true);

    const mid = forecastReliability(relInput({ activeContracts: 20 }));
    expect(mid.score).toBeGreaterThan(empty.score);
    expect(mid.score).toBeLessThanOrEqual(100);
  });
});

describe("parseForecastSnapshotRows", () => {
  const sampleRow: ForecastRow = {
    weekStart: "2026-07-27",
    sku: "1234",
    title: "Serum",
    market: "FR",
    contractedUnits: 3,
    probabilityAdjustedUnits: 2.7,
    expectedSkips: 0.1,
    expectedPauses: 0.05,
    expectedCancellations: 0.12,
    expectedFailedPayments: 0.08,
    expectedAddOnUnits: 0.5,
    revenueCents: 12000,
    marginCents: 8000,
    ciLowCents: 9000,
    ciHighCents: 15000,
  };

  it("treats a legacy bare-array snapshot as rows with default meta", () => {
    const parsed = parseForecastSnapshotRows(JSON.stringify([sampleRow]));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].sku).toBe("1234");
    expect(parsed.meta.options).toEqual(DEFAULT_FORECAST_OPTIONS);
    expect(parsed.meta.computedAt).toBeNull();
    expect(parsed.meta.reliability).toBeNull();
  });

  it("reads the V2 envelope with options, computedAt and reliability", () => {
    const reliability = {
      grade: "LOW" as const,
      score: 10,
      expectedErrorBand: "±50%",
      reasons: ["Only 3 active contracts — treat every number as a rough guide."],
    };
    const parsed = parseForecastSnapshotRows(
      JSON.stringify({
        rows: [sampleRow],
        meta: {
          options: {
            model: "SURVIVAL_TREND",
            scenario: "CONSERVATIVE",
            horizonWeeks: 26,
          },
          computedAt: "2026-08-01T03:00:00.000Z",
          reliability,
        },
      }),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.meta.options.model).toBe("SURVIVAL_TREND");
    expect(parsed.meta.options.scenario).toBe("CONSERVATIVE");
    expect(parsed.meta.options.horizonWeeks).toBe(26);
    expect(parsed.meta.computedAt).toBe("2026-08-01T03:00:00.000Z");
    expect(parsed.meta.reliability).toEqual(reliability);
  });

  it("fills missing envelope options from the defaults", () => {
    const parsed = parseForecastSnapshotRows(
      JSON.stringify({
        rows: [],
        meta: { options: { scenario: "OPTIMISTIC" } },
      }),
    );
    expect(parsed.meta.options.model).toBe("CONTRACT");
    expect(parsed.meta.options.scenario).toBe("OPTIMISTIC");
    expect(parsed.meta.options.horizonWeeks).toBe(13);
    expect(parsed.meta.computedAt).toBeNull();
  });

  it("returns empty rows for garbage input", () => {
    expect(parseForecastSnapshotRows("not json").rows).toEqual([]);
    expect(parseForecastSnapshotRows(null).rows).toEqual([]);
    expect(parseForecastSnapshotRows(JSON.stringify({ nope: 1 })).rows).toEqual(
      [],
    );
  });
});

describe("aggregateForecastRows", () => {
  const WEEK0 = new Date(Date.UTC(2026, 6, 20));

  function contractInput(
    overrides: Partial<ForecastAggregationContract> = {},
  ): ForecastAggregationContract {
    return {
      forecast: forecastContract(baseInput()),
      market: "FR",
      contributionFraction: 0.7,
      lines: [{ sku: "L1", title: "Serum", quantity: 1, unitPriceCents: 5000 }],
      addOns: [],
      ...overrides,
    };
  }

  it("counts scheduled RECURRING add-on units as contracted volume", () => {
    // Bug regression: the ops table compared Expected units (incl. add-ons)
    // against Contracted units that EXCLUDED add-ons, so a SKU sold only as a
    // recurring add-on showed contractedUnits = 0 with expected units ≈ 1.92.
    const rows = aggregateForecastRows(
      [
        contractInput({
          addOns: [
            {
              sku: "A1",
              title: "Booster",
              quantity: 2,
              priceCents: 2000,
              mode: "RECURRING",
              remainingDeliveries: null,
              contributionFraction: 0.6,
            },
          ],
        }),
      ],
      WEEK0,
    );

    const addOnWeek1 = rows.find(
      (r) => r.sku === "A1" && r.weekStart === "2026-07-27",
    );
    expect(addOnWeek1).toBeDefined();
    // The wrong number was 0; scheduled add-on units are contracted volume.
    expect(addOnWeek1!.contractedUnits).toBe(2);
    // pOrder cycle 1 = 0.96 → expected add-on units 2 × 0.96.
    expect(addOnWeek1!.expectedAddOnUnits).toBeCloseTo(1.92, 10);
    expect(addOnWeek1!.revenueCents).toBe(Math.round(0.96 * 4000));
    expect(addOnWeek1!.marginCents).toBe(Math.round(0.96 * 4000 * 0.6));
    // Expected never exceeds contracted for the add-on SKU.
    expect(
      addOnWeek1!.expectedAddOnUnits + addOnWeek1!.probabilityAdjustedUnits,
    ).toBeLessThanOrEqual(addOnWeek1!.contractedUnits);
    // A RECURRING add-on ships with every cycle (weeks 1, 5, 9).
    expect(rows.filter((r) => r.sku === "A1").map((r) => r.weekStart)).toEqual([
      "2026-07-27",
      "2026-08-24",
      "2026-09-21",
    ]);
  });

  it("applies NEXT_ONLY and N_DELIVERIES add-on windows", () => {
    const rows = aggregateForecastRows(
      [
        contractInput({
          addOns: [
            {
              sku: "AN",
              title: "Sample",
              quantity: 1,
              priceCents: 1000,
              mode: "NEXT_ONLY",
              remainingDeliveries: null,
              contributionFraction: 0.5,
            },
            {
              sku: "AD",
              title: "Duo",
              quantity: 1,
              priceCents: 1500,
              mode: "N_DELIVERIES",
              remainingDeliveries: 2,
              contributionFraction: 0.5,
            },
          ],
        }),
      ],
      WEEK0,
    );
    expect(rows.filter((r) => r.sku === "AN").map((r) => r.weekStart)).toEqual([
      "2026-07-27",
    ]);
    expect(rows.filter((r) => r.sku === "AD").map((r) => r.weekStart)).toEqual([
      "2026-07-27",
      "2026-08-24",
    ]);
    for (const row of rows.filter((r) => r.sku === "AN" || r.sku === "AD")) {
      expect(row.contractedUnits).toBe(1);
    }
  });

  it("scales expected add-on take-up (not contracted units) by the scenario", () => {
    const rows = aggregateForecastRows(
      [
        contractInput({
          addOns: [
            {
              sku: "A1",
              title: "Booster",
              quantity: 2,
              priceCents: 2000,
              mode: "RECURRING",
              remainingDeliveries: null,
              contributionFraction: 0.6,
            },
          ],
        }),
      ],
      WEEK0,
      "CONSERVATIVE",
    );
    const addOnWeek1 = rows.find(
      (r) => r.sku === "A1" && r.weekStart === "2026-07-27",
    );
    // Take-up halves (0.96 × 0.5) while scheduled volume stays put.
    expect(addOnWeek1!.expectedAddOnUnits).toBeCloseTo(0.96, 10);
    expect(addOnWeek1!.contractedUnits).toBe(2);
  });

  it("aggregates subscription lines with the order-level contribution fraction", () => {
    const rows = aggregateForecastRows([contractInput()], WEEK0);
    const lineWeek1 = rows.find(
      (r) => r.sku === "L1" && r.weekStart === "2026-07-27",
    );
    expect(lineWeek1).toBeDefined();
    expect(lineWeek1!.contractedUnits).toBe(1);
    expect(lineWeek1!.probabilityAdjustedUnits).toBeCloseTo(0.96, 10);
    expect(lineWeek1!.revenueCents).toBe(Math.round(0.96 * 5000));
    expect(lineWeek1!.marginCents).toBe(Math.round(0.96 * 5000 * 0.7));
    // CI bounds bracket the expectation.
    for (const row of rows) {
      expect(row.ciLowCents).toBeLessThanOrEqual(row.revenueCents);
      expect(row.ciHighCents).toBeGreaterThanOrEqual(row.revenueCents);
    }
    // Rows are sorted by weekStart, then SKU, then market.
    const sorted = [...rows].sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) ||
        a.sku.localeCompare(b.sku) ||
        a.market.localeCompare(b.market),
    );
    expect(rows).toEqual(sorted);
  });
});

describe("ciBoundsCents", () => {
  it("orders bounds low <= expected <= high", () => {
    const { ciLowCents, ciHighCents } = ciBoundsCents(1000, 40000);
    // sd = 200 → half width round(1.96 * 200) = 392.
    expect(ciLowCents).toBe(608);
    expect(ciHighCents).toBe(1392);
    expect(ciLowCents).toBeLessThanOrEqual(1000);
    expect(ciHighCents).toBeGreaterThanOrEqual(1000);
  });

  it("collapses to the expectation at zero variance", () => {
    const { ciLowCents, ciHighCents } = ciBoundsCents(777, 0);
    expect(ciLowCents).toBe(777);
    expect(ciHighCents).toBe(777);
  });

  it("never goes below zero", () => {
    const { ciLowCents, ciHighCents } = ciBoundsCents(100, 100000000);
    expect(ciLowCents).toBe(0);
    expect(ciHighCents).toBeGreaterThan(100);
  });

  it("treats negative variance as zero", () => {
    const { ciLowCents, ciHighCents } = ciBoundsCents(500, -50);
    expect(ciLowCents).toBe(500);
    expect(ciHighCents).toBe(500);
  });
});

describe("margin helpers", () => {
  it("prefers grossMarginPercent for gross margin", () => {
    expect(
      marginFractionFor(10000, { grossMarginPercent: 0.78, unitCostCents: 2500 }),
    ).toBe(0.78);
  });

  it("derives gross margin from unit cost when no percent is set", () => {
    expect(
      marginFractionFor(10000, { grossMarginPercent: null, unitCostCents: 2500 }),
    ).toBeCloseTo(0.75, 10);
  });

  it("falls back to the default margin fraction", () => {
    expect(marginFractionFor(10000, null)).toBe(DEFAULT_MARGIN_FRACTION);
    expect(
      marginFractionFor(0, { grossMarginPercent: null, unitCostCents: 2500 }),
    ).toBe(DEFAULT_MARGIN_FRACTION);
  });

  it("prefers unit cost for contribution", () => {
    expect(
      contributionFractionFor(10000, {
        grossMarginPercent: 0.9,
        unitCostCents: 2500,
      }),
    ).toBeCloseTo(0.75, 10);
    expect(
      contributionFractionFor(10000, {
        grossMarginPercent: 0.9,
        unitCostCents: null,
      }),
    ).toBe(0.9);
    expect(contributionFractionFor(10000, null)).toBe(DEFAULT_MARGIN_FRACTION);
  });
});
