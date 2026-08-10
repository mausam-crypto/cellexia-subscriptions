import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-4 — getInsights ↔ forecastGrade wiring.
 *
 * InsightInputs.forecastGrade and rule 7's grade-D leg existed from day one,
 * but getInsights never populated the field and both loaders dropped the
 * grade they already held — the leg was production-dead, testable only
 * through the pure deriveInsights. These tests exercise the WIRING: the
 * production wrapper must reach deriveInsights with a real grade, whether
 * supplied by the caller or computed by getInsights itself, and a broken
 * forecast must degrade to "no grade", never to zero insights.
 *
 * (tests/insights.test.ts mocks ~/db.server as {} to pin error containment;
 * this file needs working table mocks, hence the separate module graph.)
 */

const mocks = vi.hoisted(() => ({
  getForecast: vi.fn(),
  getCostCoverage: vi.fn(),
  shopFindUnique: vi.fn(),
  contractCount: vi.fn(),
  contractFindMany: vi.fn(),
  rollupFindMany: vi.fn(),
  rollupFindFirst: vi.fn(),
  dunningGroupBy: vi.fn(),
  cancelSessionGroupBy: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    subscriptionContract: {
      count: mocks.contractCount,
      findMany: mocks.contractFindMany,
    },
    dailyRollup: {
      findMany: mocks.rollupFindMany,
      findFirst: mocks.rollupFindFirst,
    },
    dunningCase: { groupBy: mocks.dunningGroupBy },
    cancelSession: { groupBy: mocks.cancelSessionGroupBy },
  },
}));

// Only getForecast is stubbed — the rest of forecast.server (types, pure
// functions) stays real so insights.server's imports resolve.
vi.mock("~/lib/analytics/forecast.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/analytics/forecast.server")>();
  return { ...actual, getForecast: mocks.getForecast };
});

vi.mock("~/lib/analytics/costs.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/lib/analytics/costs.server")>();
  return { ...actual, getCostCoverage: mocks.getCostCoverage };
});

import { getInsights } from "~/lib/analytics/insights.server";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "UTC",
    currencyCode: "CHF",
  });
  // A mature, otherwise-healthy store: 8 whole weeks of rollups on record,
  // no rollup rows in the trailing window (every volume rule stays silent),
  // full cost coverage — the ONLY insight that can fire is rule 7, and past
  // FORECAST_MATURITY_WEEKS its only remaining trigger is the grade-D leg.
  mocks.contractCount.mockResolvedValue(200);
  mocks.contractFindMany.mockResolvedValue([]); // no EXPIRED contracts in window
  mocks.rollupFindMany.mockResolvedValue([]);
  mocks.rollupFindFirst.mockResolvedValue({
    date: new Date(new Date("2026-08-01T00:00:00.000Z").getTime() - 49 * DAY),
  });
  mocks.dunningGroupBy.mockResolvedValue([]);
  mocks.cancelSessionGroupBy.mockResolvedValue([]);
  mocks.getCostCoverage.mockResolvedValue({
    totalLines: 100,
    linesWithKnownCogsPct: 100,
    productsMissingCogs: [],
  });
});

describe("getInsights — forecastGrade wiring (FR-4)", () => {
  it("computes the grade itself when the caller supplies none — the grade-D leg finally fires", async () => {
    mocks.getForecast.mockResolvedValue({ accuracy: { grade: "D" } });

    const out = await getInsights("shop_1", NOW);
    expect(mocks.getForecast).toHaveBeenCalledWith("shop_1", { now: NOW });
    const note = out.find((i) => i.headline.match(/calibrating/i));
    expect(note).toBeDefined();
    expect(note!.tone).toBe("neutral");
  });

  it("a non-D grade on a mature store produces no calibration note", async () => {
    mocks.getForecast.mockResolvedValue({ accuracy: { grade: "B" } });
    expect(await getInsights("shop_1", NOW)).toEqual([]);
  });

  it("a caller-supplied grade wins and skips the duplicate forecast computation", async () => {
    const out = await getInsights("shop_1", NOW, { forecastGrade: "D" });
    expect(out.find((i) => i.headline.match(/calibrating/i))).toBeDefined();
    expect(mocks.getForecast).not.toHaveBeenCalled();

    const quiet = await getInsights("shop_1", NOW, { forecastGrade: "A" });
    expect(quiet).toEqual([]);
    expect(mocks.getForecast).not.toHaveBeenCalled();
  });

  it("an explicit null grade means 'known unknown' — no fetch, no grade-D leg", async () => {
    const out = await getInsights("shop_1", NOW, { forecastGrade: null });
    expect(out).toEqual([]);
    expect(mocks.getForecast).not.toHaveBeenCalled();
  });

  it("buckets same-day EXPIRED completions out of the churn-spike rule (scheduled churn cannot alarm)", async () => {
    // Seven rollup days whose churnedVoluntary is entirely a bounded-plan
    // cohort completing on schedule (the rollup's shared EXPIRED-is-voluntary
    // classification). The wrapper must bucket the expiredAt instants into
    // the same shop-tz labels and rule 1 must subtract them.
    const labels = [26, 27, 28, 29, 30, 31].map(
      (d) => `2026-07-${d}`,
    );
    labels.push("2026-08-01");
    mocks.rollupFindMany.mockResolvedValue(
      labels.map((label) => ({
        date: new Date(`${label}T00:00:00.000Z`),
        churnedVoluntary: 1,
        churnedInvoluntary: 0,
        skips: 0,
        takeRateNum: 0,
        takeRateDen: 0,
      })),
    );
    mocks.contractFindMany.mockResolvedValue(
      labels.map((label) => ({ expiredAt: new Date(`${label}T10:00:00.000Z`) })),
    );

    const quiet = await getInsights("shop_1", NOW, { forecastGrade: null });
    expect(quiet.find((i) => i.headline.match(/churn spiked/i))).toBeUndefined();

    // Control: the SAME churn columns with no expiry rows DO spike — the
    // silence above is the subtraction, not a dead rule.
    mocks.contractFindMany.mockResolvedValue([]);
    const loud = await getInsights("shop_1", NOW, { forecastGrade: null });
    expect(loud.find((i) => i.headline.match(/churn spiked/i))).toBeDefined();
  });

  it("a broken forecast degrades to no grade — other insights still return", async () => {
    mocks.getForecast.mockRejectedValue(new Error("forecast exploded"));
    // Give one unrelated rule something to say so "insights survive" is
    // observable, not vacuous.
    mocks.dunningGroupBy.mockResolvedValue([
      { resolution: "RECOVERED", _count: { _all: 3 } },
      { resolution: "EXHAUSTED", _count: { _all: 7 } },
    ]);

    const out = await getInsights("shop_1", NOW);
    expect(out.find((i) => i.headline.match(/dunning/i))).toBeDefined();
    expect(out.find((i) => i.headline.match(/calibrating/i))).toBeUndefined();
  });
});
