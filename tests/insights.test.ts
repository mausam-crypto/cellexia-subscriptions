import { describe, expect, it, vi } from "vitest";

// insights.server.ts imports prisma via ~/db.server; deriveInsights itself is
// pure, so the DB seam is mocked out (same pattern as tokens/klaviyo tests).
vi.mock("~/db.server", () => ({ default: {} }));

import { deriveInsights, getInsights } from "~/lib/analytics/insights.server";
import type { InsightInputs } from "~/lib/analytics/insights.server";

/** One rollup day. */
function day(overrides: Partial<InsightInputs["rollups"][number]> = {}) {
  return {
    churnedVoluntary: 0,
    churnedInvoluntary: 0,
    skips: 1,
    cancels: 1,
    takeRateNum: 2,
    takeRateDen: 10,
    ...overrides,
  };
}

/**
 * A healthy, mature store: every rule should stay silent so each test's
 * perturbation isolates exactly one rule.
 */
function healthyInputs(overrides: Partial<InsightInputs> = {}): InsightInputs {
  return {
    contractsTotal: 200,
    rollups: Array.from({ length: 35 }, () => day()),
    rollupWeeks: 12,
    dunning30d: { resolved: 10, recovered: 6 }, // 60% — inside 55–70 band
    saves30d: { decided: 20, saved: 5 }, // 25% — inside 20–30 band
    costCoverage: {
      totalLines: 100,
      linesMissingCost: 0,
      coveragePct: 100,
      productsMissingCost: 0,
    },
    forecastGrade: null,
    ...overrides,
  };
}

describe("deriveInsights", () => {
  it("returns no insights for a healthy mature store", () => {
    expect(deriveInsights(healthyInputs())).toEqual([]);
  });

  it("returns only the welcome insight when there are no contracts", () => {
    const out = deriveInsights(healthyInputs({ contractsTotal: 0 }));
    expect(out).toHaveLength(1);
    expect(out[0].tone).toBe("neutral");
    expect(out[0].headline).toMatch(/welcome/i);
    expect(out[0].actionUrl).toBe("/app/plans");
  });

  it("flags a churn spike vs the 4-week baseline with evidence and routes voluntary churn to the cancel flow", () => {
    const rollups = [
      ...Array.from({ length: 28 }, () => day({ churnedVoluntary: 1 })), // 7/week baseline
      ...Array.from({ length: 7 }, () => day({ churnedVoluntary: 2 })), // 14 this week
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    const spike = out.find((i) => i.headline.match(/churn spiked/i));
    expect(spike).toBeDefined();
    expect(spike!.tone).toBe("warning");
    expect(spike!.detail).toContain("14 subscribers churned");
    expect(spike!.detail).toContain("7"); // the baseline appears as evidence
    expect(spike!.actionUrl).toBe("/app/cancel-flow");
  });

  it("routes an involuntary-led churn spike to dunning", () => {
    const rollups = [
      ...Array.from({ length: 28 }, () => day()),
      ...Array.from({ length: 7 }, () => day({ churnedInvoluntary: 1 })),
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    const spike = out.find((i) => i.headline.match(/churn spiked/i));
    expect(spike).toBeDefined();
    expect(spike!.actionUrl).toBe("/app/dunning");
  });

  it("stays silent on tiny churn numbers (below the spike minimum)", () => {
    const rollups = [
      ...Array.from({ length: 28 }, () => day()),
      ...Array.from({ length: 7 }, (_, i) => day({ churnedVoluntary: i === 0 ? 2 : 0 })),
    ];
    expect(deriveInsights(healthyInputs({ rollups }))).toEqual([]);
  });

  it("warns when dunning recovery is below 55% with the case counts as evidence", () => {
    const out = deriveInsights(
      healthyInputs({ dunning30d: { resolved: 10, recovered: 3 } }),
    );
    const insight = out.find((i) => i.headline.match(/dunning/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("warning");
    expect(insight!.detail).toContain("3 of 10");
    expect(insight!.actionUrl).toBe("/app/dunning");
  });

  it("celebrates dunning recovery above 70%", () => {
    const out = deriveInsights(
      healthyInputs({ dunning30d: { resolved: 10, recovered: 8 } }),
    );
    const insight = out.find((i) => i.headline.match(/dunning/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("positive");
  });

  it("ignores dunning below the minimum sample size", () => {
    const out = deriveInsights(
      healthyInputs({ dunning30d: { resolved: 2, recovered: 0 } }),
    );
    expect(out.find((i) => i.headline.match(/dunning/i))).toBeUndefined();
  });

  it("warns when the save rate is under the 20% band floor", () => {
    const out = deriveInsights(
      healthyInputs({ saves30d: { decided: 20, saved: 2 } }),
    );
    const insight = out.find((i) => i.headline.match(/save offers/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("warning");
    expect(insight!.detail).toContain("2 of 20");
    expect(insight!.actionUrl).toBe("/app/cancel-flow");
  });

  it("notes (neutral, not alarming) a save rate above the 30% band ceiling", () => {
    const out = deriveInsights(
      healthyInputs({ saves30d: { decided: 20, saved: 10 } }),
    );
    const insight = out.find((i) => i.headline.match(/save rate/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("neutral");
  });

  it("warns about estimated margins when cost coverage is below 80%", () => {
    const out = deriveInsights(
      healthyInputs({
        costCoverage: {
          totalLines: 100,
          linesMissingCost: 40,
          coveragePct: 60,
          productsMissingCost: 3,
        },
      }),
    );
    const insight = out.find((i) => i.headline.match(/margins/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("warning");
    expect(insight!.detail).toContain("40 of 100");
    expect(insight!.detail).toContain("3 products");
  });

  it("stays silent on cost coverage when no lines exist at all", () => {
    const out = deriveInsights(
      healthyInputs({
        costCoverage: {
          totalLines: 0,
          linesMissingCost: 0,
          coveragePct: 100,
          productsMissingCost: 0,
        },
      }),
    );
    expect(out.find((i) => i.headline.match(/margins/i))).toBeUndefined();
  });

  it("reports a >2-point take-rate gain as positive with both weeks as evidence", () => {
    const rollups = [
      ...Array.from({ length: 21 }, () => day()),
      ...Array.from({ length: 7 }, () => day({ takeRateNum: 2, takeRateDen: 10 })), // 20%
      ...Array.from({ length: 7 }, () => day({ takeRateNum: 3, takeRateDen: 10 })), // 30%
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    const insight = out.find((i) => i.headline.match(/take rate/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("positive");
    expect(insight!.detail).toContain("21/70");
    expect(insight!.detail).toContain("14/70");
  });

  it("reports a >2-point take-rate drop as a warning linking to the buy box", () => {
    const rollups = [
      ...Array.from({ length: 21 }, () => day()),
      ...Array.from({ length: 7 }, () => day({ takeRateNum: 3, takeRateDen: 10 })),
      ...Array.from({ length: 7 }, () => day({ takeRateNum: 2, takeRateDen: 10 })),
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    const insight = out.find((i) => i.headline.match(/take rate/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("warning");
    expect(insight!.actionUrl).toBe("/app/buy-box");
  });

  it("ignores take-rate noise when the checkout denominator is too small", () => {
    const rollups = [
      ...Array.from({ length: 28 }, () => day({ takeRateNum: 1, takeRateDen: 2 })),
      ...Array.from({ length: 7 }, () => day({ takeRateNum: 0, takeRateDen: 2 })),
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    expect(out.find((i) => i.headline.match(/take rate/i))).toBeUndefined();
  });

  it("warns when the skip:cancel ratio deteriorates sharply", () => {
    const rollups = [
      ...Array.from({ length: 7 }, () => day()),
      ...Array.from({ length: 14 }, () => day({ skips: 5, cancels: 1 })), // 5:1
      ...Array.from({ length: 14 }, () => day({ skips: 1, cancels: 1 })), // 1:1
    ];
    const out = deriveInsights(healthyInputs({ rollups }));
    const insight = out.find((i) => i.headline.match(/skipping/i));
    expect(insight).toBeDefined();
    expect(insight!.tone).toBe("warning");
    expect(insight!.actionUrl).toBe("/app/plans");
  });

  it("adds the calibration note for young stores and grade-D forecasts", () => {
    const young = deriveInsights(healthyInputs({ rollupWeeks: 2 }));
    const note = young.find((i) => i.headline.match(/calibrating/i));
    expect(note).toBeDefined();
    expect(note!.tone).toBe("neutral");
    expect(note!.detail).toContain("2 weeks");

    const gradeD = deriveInsights(healthyInputs({ forecastGrade: "D" }));
    expect(gradeD.find((i) => i.headline.match(/calibrating/i))).toBeDefined();
  });

  it("caps output at 5 insights, most important first", () => {
    const rollups = [
      // churn spike + take-rate drop + skip deterioration all at once
      ...Array.from({ length: 7 }, () => day()),
      ...Array.from({ length: 14 }, () =>
        day({ skips: 5, cancels: 1, takeRateNum: 3, takeRateDen: 10 }),
      ),
      ...Array.from({ length: 14 }, () =>
        day({ skips: 1, cancels: 1, churnedVoluntary: 1, takeRateNum: 2, takeRateDen: 10 }),
      ),
    ];
    const out = deriveInsights(
      healthyInputs({
        rollups,
        rollupWeeks: 2,
        dunning30d: { resolved: 10, recovered: 3 },
        saves30d: { decided: 20, saved: 2 },
        costCoverage: {
          totalLines: 100,
          linesMissingCost: 90,
          coveragePct: 10,
          productsMissingCost: 4,
        },
      }),
    );
    expect(out.length).toBe(5);
    expect(out[0].headline).toMatch(/churn spiked/i);
  });

  it("no rule throws on completely empty tables (contracts exist, zero rollup rows)", () => {
    // A store whose rollup job has never run: contracts exist but every
    // aggregate is empty. Every slice below is [], every sum 0 — no rule may
    // throw, and only the calibration note (0 weeks of history) may fire.
    const out = deriveInsights(
      healthyInputs({
        rollups: [],
        rollupWeeks: 0,
        dunning30d: { resolved: 0, recovered: 0 },
        saves30d: { decided: 0, saved: 0 },
        costCoverage: {
          totalLines: 0,
          linesMissingCost: 0,
          coveragePct: 100,
          productsMissingCost: 0,
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].headline).toMatch(/calibrating/i);
    expect(out[0].detail).toContain("0 weeks");
    expect(out[0].detail).not.toContain("NaN");
  });

  it("never divides by zero on an all-zero book", () => {
    const rollups = Array.from({ length: 35 }, () =>
      day({ skips: 0, cancels: 0, takeRateNum: 0, takeRateDen: 0 }),
    );
    const out = deriveInsights(
      healthyInputs({
        rollups,
        dunning30d: { resolved: 0, recovered: 0 },
        saves30d: { decided: 0, saved: 0 },
        costCoverage: {
          totalLines: 0,
          linesMissingCost: 0,
          coveragePct: 100,
          productsMissingCost: 0,
        },
      }),
    );
    for (const insight of out) {
      expect(insight.detail).not.toContain("NaN");
      expect(insight.detail).not.toContain("Infinity");
    }
  });
});

describe("getInsights error containment", () => {
  it("returns [] instead of throwing when the database layer is unavailable", async () => {
    // ~/db.server is mocked as {} above, so the FIRST query getInsights makes
    // explodes with a TypeError. The architecture rule (analytics failures are
    // contained) demands the page loader still gets a usable empty list.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(getInsights("shop_1")).resolves.toEqual([]);
    expect(errorSpy).toHaveBeenCalled(); // the failure is logged, not swallowed silently
    errorSpy.mockRestore();
  });
});
