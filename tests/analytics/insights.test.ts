/**
 * Unit tests for the pure dashboard helpers in
 * app/services/analytics/insights.server.ts (ANALYTICS-V2 §3):
 *
 * - buildInsights: every trigger (biggest mover, churn composition, best
 *   configuration, costs-unset, low reliability), business-direction tones,
 *   importance order and the max-5 cap.
 * - reconstructActiveCount: the honest replacement for the point-in-time
 *   delta tiles that were structurally "Steady".
 * - aggregateForecastWeeks: dense week axis (zero weeks no longer vanish).
 * - measurableSurvival: 0/0 checkpoints dropped instead of rendered as 0%.
 */
import { describe, expect, it } from "vitest";
import {
  aggregateForecastWeeks,
  buildInsights,
  extractForecastRows,
  measurableSurvival,
  reconstructActiveCount,
} from "~/services/analytics/insights.server";
import type {
  ContractStateRow,
  ForecastRowLike,
  InsightExtras,
} from "~/services/analytics/insights.server";
import type { ExecutiveMetrics } from "~/services/analytics/metrics.server";
import type { BestConfiguration } from "~/services/analytics/cohorts.server";

// ───────────────────────────── Fixtures ────────────────────────────────────

function metrics(overrides: Partial<ExecutiveMetrics> = {}): ExecutiveMetrics {
  const base = {
    from: "2026-05-03T00:00:00.000Z",
    to: "2026-08-01T00:00:00.000Z",
    currencyCode: "EUR",
    activeSubscribers: 200,
    newSubscriptions: 30,
    netGrowth: 10,
    activeSubscriptionRevenueCents: 2_000_000,
    recurringGrossProfitCents: 1_400_000,
    contributionCents: 1_100_000,
    subscriberAovCents: 9_600,
    grossMarginLtvCents: 42_000,
    paidOrdersPerSubscriber: 3.2,
    voluntaryChurnRate: 0.04,
    involuntaryChurnRate: 0.01,
    pauseRate: 0.02,
    reactivationRate: 0.5,
    skipRate: 0.08,
    productAdditionRate: 0.05,
    oneTimeToSubscriptionRate: 0.03,
    subscriptionToRoutineRate: 0.25,
    paymentRecoveryRate: 0.4,
    attachRate: 0.5,
    widgetConversionRate: 0.05,
    counts: {
      subscribersAtRangeStart: 200,
      voluntaryCancellations: 8,
      involuntaryCancellations: 2,
      pausesStarted: 4,
      pausesEnded: 2,
      ordersSkipped: 12,
      chargesCompleted: 140,
      chargesFailed: 5,
      retriesRecovered: 2,
      productsAdded: 10,
      widgetImpressions: 4000,
      widgetConversions: 200,
    },
  };
  return {
    ...base,
    ...overrides,
    counts: { ...base.counts, ...(overrides.counts ?? {}) },
  } as ExecutiveMetrics;
}

function extras(
  over: {
    configured?: boolean;
    grade?: "LOW" | "MODERATE" | "HIGH";
    reasons?: string[];
    bestConfig?: BestConfiguration;
  } = {},
): InsightExtras {
  return {
    reliability: {
      grade: over.grade ?? "HIGH",
      score: over.grade === "LOW" ? 20 : 85,
      expectedErrorBand: over.grade === "LOW" ? "±50%" : "±12%",
      reasons: over.reasons ?? [],
    },
    costModel: {
      defaultMarginFraction: 0.7,
      shippingPerDeliveryCents: 350,
      fulfillmentPerDeliveryCents: 120,
      paymentFeeFraction: 0.019,
      paymentFeeFixedCents: 30,
      configured: over.configured ?? true,
    },
    bestConfig: over.bestConfig,
  };
}

const BEST_CONFIG: BestConfiguration = {
  source: "klaviyo",
  offer: "10-20%",
  product: "Cell Renewal Serum",
  cadenceWeeks: 4,
  contracts: 18,
  matureContracts: 6,
  avgContribution12mCents: 21_400,
  totalContribution12mCents: 385_200,
};

// ───────────────────────────── buildInsights ───────────────────────────────

describe("buildInsights", () => {
  it("returns no insights for a quiet, fully-configured, reliable period", () => {
    const m = metrics();
    expect(buildInsights(m, metrics(), extras())).toEqual([]);
  });

  it("flags the biggest mover with a POSITIVE tone when voluntary churn falls (business direction, not sign)", () => {
    const current = metrics({ voluntaryChurnRate: 0.03 });
    const previous = metrics({ voluntaryChurnRate: 0.07 });
    const insights = buildInsights(current, previous, extras());
    expect(insights).toHaveLength(1);
    expect(insights[0].tone).toBe("positive");
    expect(insights[0].headline).toContain("Voluntary churn");
    expect(insights[0].headline).toContain("improved by 4.0 pp");
    expect(insights[0].detail).toContain("3.0%");
    expect(insights[0].detail).toContain("7.0%");
  });

  it("flags a worsening mover with a warning tone", () => {
    const current = metrics({ skipRate: 0.15 });
    const previous = metrics({ skipRate: 0.08 });
    const insights = buildInsights(current, previous, extras());
    expect(insights[0].tone).toBe("warning");
    expect(insights[0].headline).toContain("Skip rate worsened by 7.0 pp");
  });

  it("picks the LARGEST move when several rates changed", () => {
    const current = metrics({
      voluntaryChurnRate: 0.03, // -1 pp
      widgetConversionRate: 0.11, // +6 pp — biggest
    });
    const previous = metrics({ voluntaryChurnRate: 0.04 });
    const insights = buildInsights(current, previous, extras());
    expect(insights[0].headline).toContain("Widget conversion improved");
  });

  it("ignores rate moves below half a percentage point", () => {
    const current = metrics({ skipRate: 0.084 });
    expect(buildInsights(current, metrics(), extras())).toEqual([]);
  });

  it("warns when payment failures dominate churn, linking to dunning", () => {
    const current = metrics({
      voluntaryChurnRate: 0.01,
      involuntaryChurnRate: 0.03,
    });
    const previous = metrics({
      voluntaryChurnRate: 0.01,
      involuntaryChurnRate: 0.03,
    });
    const insights = buildInsights(current, previous, extras());
    const composition = insights.find((i) => i.linkTo === "/app/dunning");
    expect(composition).toBeDefined();
    expect(composition?.tone).toBe("warning");
    expect(composition?.headline).toContain("75%");
  });

  it("warns when the churn mix SHIFTS toward payment failures even below dominance", () => {
    // Current: 40% involuntary share; previous: 10% — a 30 pp shift.
    const current = metrics({
      voluntaryChurnRate: 0.06,
      involuntaryChurnRate: 0.04,
    });
    const previous = metrics({
      voluntaryChurnRate: 0.09,
      involuntaryChurnRate: 0.01,
    });
    const insights = buildInsights(current, previous, extras());
    const composition = insights.find((i) => i.linkTo === "/app/dunning");
    expect(composition).toBeDefined();
    expect(composition?.headline).toContain("shifting toward payment failures");
    expect(composition?.detail).toContain("40%");
    expect(composition?.detail).toContain("10%");
  });

  it("celebrates the best configuration with money formatted from cents", () => {
    const m = metrics();
    const insights = buildInsights(m, m, extras({ bestConfig: BEST_CONFIG }));
    expect(insights).toHaveLength(1);
    expect(insights[0].tone).toBe("positive");
    expect(insights[0].headline).toContain("klaviyo");
    expect(insights[0].headline).toContain("Cell Renewal Serum");
    expect(insights[0].detail).toContain("€214");
    expect(insights[0].linkTo).toBe("/app/analytics?tab=cohorts");
  });

  it("warns when the cost model is not configured, linking to the costs tab", () => {
    const m = metrics();
    const insights = buildInsights(m, m, extras({ configured: false }));
    expect(insights).toHaveLength(1);
    expect(insights[0].tone).toBe("warning");
    expect(insights[0].linkTo).toBe("/app/analytics?tab=costs");
    expect(insights[0].headline).toContain("default margins");
  });

  it("adds a neutral note when forecast reliability is LOW, surfacing the first reason", () => {
    const m = metrics();
    const insights = buildInsights(
      m,
      m,
      extras({ grade: "LOW", reasons: ["Only 4 weeks of billing history."] }),
    );
    expect(insights).toHaveLength(1);
    expect(insights[0].tone).toBe("neutral");
    expect(insights[0].headline).toContain("±50%");
    expect(insights[0].detail).toBe("Only 4 weeks of billing history.");
  });

  it("caps at five insights, ordered by importance", () => {
    const current = metrics({
      skipRate: 0.15, // biggest mover (worsened)
      voluntaryChurnRate: 0.01,
      involuntaryChurnRate: 0.03, // dominance -> composition warning
    });
    const previous = metrics({
      voluntaryChurnRate: 0.01,
      involuntaryChurnRate: 0.03,
    });
    const insights = buildInsights(
      current,
      previous,
      extras({ configured: false, grade: "LOW", bestConfig: BEST_CONFIG }),
    );
    expect(insights).toHaveLength(5);
    expect(insights[0].headline).toContain("Skip rate");
    expect(insights[1].linkTo).toBe("/app/dunning");
    expect(insights[2].linkTo).toBe("/app/analytics?tab=cohorts");
    expect(insights[3].linkTo).toBe("/app/analytics?tab=costs");
    expect(insights[4].headline.toLowerCase()).toContain("reliability");
  });
});

// ─────────────────────── reconstructActiveCount ────────────────────────────

describe("reconstructActiveCount — honest point-in-time deltas", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const from = new Date("2026-05-03T00:00:00.000Z"); // 90 days before

  function row(over: Partial<ContractStateRow> = {}): ContractStateRow {
    return {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      cancelledAt: null,
      status: "ACTIVE",
      pausedUntil: null,
      ...over,
    };
  }

  it("shows the collapse the old dashboard hid behind 'Steady' (400 -> 260)", () => {
    const rows: ContractStateRow[] = [
      ...Array.from({ length: 260 }, () => row()),
      ...Array.from({ length: 140 }, () =>
        row({
          status: "CANCELLED",
          cancelledAt: new Date("2026-06-15T00:00:00.000Z"),
        }),
      ),
    ];
    // The bug: current === previous for point-in-time tiles, delta exactly 0,
    // "Steady" rendered while 35% of the base was lost.
    const atFrom = reconstructActiveCount(rows, from, now);
    const atNow = reconstructActiveCount(rows, now, now);
    expect(atFrom).toBe(400);
    expect(atNow).toBe(260);
    expect(atNow - atFrom).toBe(-140); // not 0
  });

  it("counts contracts created mid-window only at the later checkpoint", () => {
    const rows = [row({ createdAt: new Date("2026-06-01T00:00:00.000Z") })];
    expect(reconstructActiveCount(rows, from, now)).toBe(0);
    expect(reconstructActiveCount(rows, now, now)).toBe(1);
  });

  it("treats a cancellation exactly at the checkpoint as already gone", () => {
    const rows = [row({ status: "CANCELLED", cancelledAt: from })];
    expect(reconstructActiveCount(rows, from, now)).toBe(0);
  });

  it("excludes currently-paused contracts at 'now' but counts them in the past (pause start unknown)", () => {
    const rows = [
      row({
        status: "PAUSED",
        pausedUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ];
    expect(reconstructActiveCount(rows, from, now)).toBe(1);
    expect(reconstructActiveCount(rows, now, now)).toBe(0);
  });

  it("still excludes at 'now' when pausedUntil is overdue (status says paused)", () => {
    const rows = [
      row({
        status: "PAUSED",
        pausedUntil: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ];
    expect(reconstructActiveCount(rows, now, now)).toBe(0);
  });

  it("censors terminal contracts with no cancelledAt at EVERY checkpoint (unknown death date cannot fabricate a delta)", () => {
    const rows = [
      row({ status: "EXPIRED" }),
      row({ status: "CANCELLED" }),
      row({ status: "FAILED" }),
    ];
    expect(reconstructActiveCount(rows, from, now)).toBe(0);
    expect(reconstructActiveCount(rows, now, now)).toBe(0);
  });

  it("accepts ISO strings for dates (serialized rows)", () => {
    const rows: ContractStateRow[] = [
      {
        createdAt: "2026-01-01T00:00:00.000Z",
        cancelledAt: "2026-06-15T00:00:00.000Z",
        status: "CANCELLED",
        pausedUntil: null,
      },
    ];
    expect(reconstructActiveCount(rows, from, now)).toBe(1);
    expect(reconstructActiveCount(rows, now, now)).toBe(0);
  });
});

// ─────────────────────── aggregateForecastWeeks ─────────────────────────────

describe("aggregateForecastWeeks — dense week axis", () => {
  // Snapshot computed Sat 2026-08-01 -> week 0 is Mon 2026-07-27.
  const computedAt = new Date("2026-08-01T06:00:00.000Z");

  function forecastRow(
    weekStart: string,
    revenueCents: number,
    units = 1.92,
  ): ForecastRowLike {
    return {
      weekStart,
      revenueCents,
      marginCents: Math.round(revenueCents * 0.7),
      probabilityAdjustedUnits: units,
      expectedAddOnUnits: 0,
    };
  }

  // A monthly-cadence shop bills in only 3 of 13 weeks.
  const sparseRows = [
    forecastRow("2026-08-03", 3840),
    forecastRow("2026-08-31", 3763, 1.88),
    forecastRow("2026-09-28", 3687, 1.84),
  ];

  it("emits one point per horizon week — zero weeks no longer vanish", () => {
    // The bug: only weeks present in rowsJson produced points, so the chart
    // showed 3 adjacent ~full-cycle points reading as that revenue EVERY week.
    const distinctRowWeeks = new Set(sparseRows.map((r) => r.weekStart)).size;
    expect(distinctRowWeeks).toBe(3); // what the old chart rendered

    const weeks = aggregateForecastWeeks(sparseRows, computedAt, 13);
    expect(weeks).toHaveLength(13); // the full horizon
    expect(weeks[0].weekStart).toBe("2026-07-27");
    expect(weeks[12].weekStart).toBe("2026-10-19");

    const billed = weeks.filter((w) => w.revenueCents > 0);
    const zero = weeks.filter((w) => w.revenueCents === 0);
    expect(billed).toHaveLength(3);
    expect(zero).toHaveLength(10);
    expect(weeks.find((w) => w.weekStart === "2026-08-10")).toMatchObject({
      revenueCents: 0,
      marginCents: 0,
      units: 0,
    });
  });

  it("accumulates multiple rows in the same week and rounds units to 1 dp", () => {
    const weeks = aggregateForecastWeeks(
      [forecastRow("2026-08-03", 1000, 0.4), forecastRow("2026-08-03", 500, 0.25)],
      computedAt,
      13,
    );
    const week = weeks.find((w) => w.weekStart === "2026-08-03");
    expect(week).toMatchObject({ revenueCents: 1500, units: 0.7 });
  });

  it("keeps rows outside the seeded horizon instead of dropping them", () => {
    const weeks = aggregateForecastWeeks(
      [...sparseRows, forecastRow("2026-12-07", 999)],
      computedAt,
      13,
    );
    expect(weeks).toHaveLength(14);
    expect(weeks[13].weekStart).toBe("2026-12-07");
  });

  it("orders weeks ascending by ISO date", () => {
    const weeks = aggregateForecastWeeks(sparseRows, computedAt, 13);
    const sorted = [...weeks.map((w) => w.weekStart)].sort();
    expect(weeks.map((w) => w.weekStart)).toEqual(sorted);
  });
});

describe("extractForecastRows — tolerant of both snapshot shapes", () => {
  const rows = [
    {
      weekStart: "2026-08-03",
      revenueCents: 1,
      marginCents: 1,
      probabilityAdjustedUnits: 1,
      expectedAddOnUnits: 0,
    },
  ];

  it("accepts the V1 bare-array shape", () => {
    expect(extractForecastRows(rows)).toEqual(rows);
  });

  it("accepts the V2 {meta, rows} shape", () => {
    expect(extractForecastRows({ meta: { options: {} }, rows })).toEqual(rows);
  });

  it("returns [] for null / malformed payloads", () => {
    expect(extractForecastRows(null)).toEqual([]);
    expect(extractForecastRows("garbage")).toEqual([]);
    expect(extractForecastRows({ rows: "nope" })).toEqual([]);
  });
});

// ───────────────────────── measurableSurvival ──────────────────────────────

describe("measurableSurvival — 0/0 checkpoints are no-data, not 0%", () => {
  const point = (eligible: number, remainingPercent: number) => ({
    label: `${eligible}/${remainingPercent}`,
    eligible,
    remainingPercent,
    voluntaryExitPercent: 0,
    paymentFailureExitPercent: 0,
  });

  it("drops the fabricated 0% points a young shop used to see", () => {
    // 5-week-old shop: only Rebill 1 is measurable; the old dashboard drew
    // Rebill 2..365 days at 0.0% remaining — total churn out of thin air.
    const curve = {
      cohort: "all",
      contracts: 40,
      points: [
        point(40, 100),
        point(0, 0),
        point(0, 0),
        point(0, 0),
        point(0, 0),
        point(0, 0),
      ],
    };
    const measurable = measurableSurvival(curve);
    expect(measurable?.points).toHaveLength(1);
    expect(measurable?.points[0].remainingPercent).toBe(100);
    expect(
      measurable?.points.some((p) => p.eligible === 0),
    ).toBe(false);
  });

  it("returns null when NO checkpoint is measurable (brand-new shop)", () => {
    const curve = {
      cohort: "all",
      contracts: 0,
      points: [point(0, 0), point(0, 0)],
    };
    expect(measurableSurvival(curve)).toBeNull();
  });

  it("passes a fully-measurable curve through unchanged", () => {
    const curve = {
      cohort: "all",
      contracts: 100,
      points: [point(100, 92), point(80, 84)],
    };
    expect(measurableSurvival(curve)?.points).toHaveLength(2);
  });

  it("returns null for a missing curve", () => {
    expect(measurableSurvival(null)).toBeNull();
    expect(measurableSurvival(undefined)).toBeNull();
  });
});
