/**
 * Pure UI helpers of the analytics workspace (app/routes/app.analytics.tsx):
 * survival-curve display selection (keep the NEWEST cohorts under the cap),
 * calendar-month labels for the cohort heatmap, null-cell rendering,
 * reliability badge tones and the euros/percent form parsers of the Costs
 * tab.
 */
import { describe, expect, it } from "vitest";
import {
  calendarMonthLabel,
  cohortCellTitle,
  formatCohortValue,
  gradeTone,
  monthColumnLabel,
  parseEurosToCents,
  parsePercent,
  pickSurvivalCurvesForDisplay,
} from "~/routes/app.analytics";
import type { SurvivalCurve } from "~/services/analytics/metrics.server";

function curve(cohort: string, contracts = 10): SurvivalCurve {
  return { cohort, contracts, points: [], atRisk: [] };
}

/** 14 monthly cohorts, 2025-06 .. 2026-07, plus the leading "all" curve. */
function fourteenMonths(order: "asc" | "desc"): SurvivalCurve[] {
  const keys: string[] = [];
  for (const year of [2025, 2026]) {
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      if (key >= "2025-06" && key <= "2026-07") keys.push(key);
    }
  }
  if (order === "desc") keys.reverse();
  return [curve("all", 140), ...keys.map((k) => curve(k))];
}

describe("pickSurvivalCurvesForDisplay — keep the NEWEST start-month cohorts", () => {
  it("keeps the latest 8 of 14 monthly cohorts (old code kept the oldest 8)", () => {
    const { shown, totalCohorts } = pickSurvivalCurvesForDisplay(
      fourteenMonths("asc"),
      "startMonth",
      8,
    );
    // Before the fix, `curves.slice(0, 9)` on the ascending service order
    // displayed "all" + 2025-06..2026-01 and silently dropped the six newest
    // cohorts (2026-02..2026-07) — exactly the ones a merchant needs to
    // judge a recent change.
    expect(totalCohorts).toBe(14);
    expect(shown).toHaveLength(9);
    expect(shown[0].cohort).toBe("all");
    const cohorts = shown.slice(1).map((c) => c.cohort);
    expect(cohorts[0]).toBe("2026-07"); // newest first
    expect(cohorts).toContain("2026-02");
    expect(cohorts).not.toContain("2025-06"); // oldest is the one dropped now
    expect(cohorts).not.toContain("2025-11");
  });

  it("is order-independent: same result when the service sorts descending", () => {
    const asc = pickSurvivalCurvesForDisplay(fourteenMonths("asc"), "startMonth", 8);
    const desc = pickSurvivalCurvesForDisplay(
      fourteenMonths("desc"),
      "startMonth",
      8,
    );
    expect(desc.shown.map((c) => c.cohort)).toEqual(
      asc.shown.map((c) => c.cohort),
    );
    expect(desc.totalCohorts).toBe(14);
  });

  it("keeps everything when under the cap", () => {
    const curves = [curve("all"), curve("2026-06"), curve("2026-07")];
    const { shown, totalCohorts } = pickSurvivalCurvesForDisplay(
      curves,
      "startMonth",
      8,
    );
    expect(totalCohorts).toBe(2);
    expect(shown.map((c) => c.cohort)).toEqual(["all", "2026-07", "2026-06"]);
  });

  it("keeps the service order for non-chronological splits", () => {
    const curves = [
      curve("all"),
      curve("2 weeks"),
      curve("4 weeks"),
      curve("8 weeks"),
    ];
    const { shown } = pickSurvivalCurvesForDisplay(curves, "intervalWeeks", 8);
    expect(shown.map((c) => c.cohort)).toEqual([
      "all",
      "2 weeks",
      "4 weeks",
      "8 weeks",
    ]);
  });

  it("returns empty for no curves", () => {
    expect(pickSurvivalCurvesForDisplay([], "startMonth", 8)).toEqual({
      shown: [],
      totalCohorts: 0,
    });
  });
});

describe("calendarMonthLabel — M0 is the cohort's own calendar month", () => {
  it("maps offsets to calendar months, UTC-pinned", () => {
    expect(calendarMonthLabel("2026-03", 0)).toBe("Mar 2026");
    expect(calendarMonthLabel("2026-03", 2)).toBe("May 2026");
  });

  it("rolls over year boundaries", () => {
    expect(calendarMonthLabel("2025-11", 3)).toBe("Feb 2026");
    expect(calendarMonthLabel("2025-12", 1)).toBe("Jan 2026");
  });

  it("returns null for non start-month cohort keys", () => {
    expect(calendarMonthLabel("unknown", 1)).toBeNull();
    expect(calendarMonthLabel("Renewal Serum", 0)).toBeNull();
    expect(calendarMonthLabel("2026-13", 0)).toBeNull();
    expect(calendarMonthLabel("2026-3", 0)).toBeNull();
  });
});

describe("cohort heatmap cell rendering", () => {
  it("labels only M0 as the cohort month", () => {
    expect(monthColumnLabel("M0", 0)).toBe("M0 · cohort month");
    expect(monthColumnLabel("M3", 3)).toBe("M3");
  });

  it("renders null cells as an em dash, never 0", () => {
    expect(formatCohortValue("retention", null, "EUR")).toBe("—");
    expect(formatCohortValue("ltvCents", null, "EUR")).toBe("—");
    expect(formatCohortValue("subscribers", null, "EUR")).toBe("—");
  });

  it("renders subscriber counts as plain integers", () => {
    expect(formatCohortValue("subscribers", 12, "EUR")).toBe("12");
  });

  it("hover titles carry the cohort key, offset and calendar month", () => {
    const title = cohortCellTitle("retention", "2026-03", 2, 0.78, "EUR");
    expect(title).toContain("2026-03");
    expect(title).toContain("M2 (May 2026)");
    const noData = cohortCellTitle("retention", "2026-07", 11, null, "EUR");
    expect(noData).toContain("no data");
    expect(noData).not.toContain("0%");
  });
});

describe("gradeTone — reliability badge tones", () => {
  it("maps grades to business-correct tones", () => {
    expect(gradeTone("LOW")).toBe("critical");
    expect(gradeTone("MODERATE")).toBe("attention");
    expect(gradeTone("HIGH")).toBe("success");
  });
});

describe("Costs tab parsers — euros/percent in the UI, cents/fractions at rest", () => {
  it("parses euro amounts (dot or comma) to integer cents", () => {
    expect(parseEurosToCents("12.50")).toEqual({ ok: true, cents: 1250 });
    expect(parseEurosToCents("12,50")).toEqual({ ok: true, cents: 1250 });
    expect(parseEurosToCents("0")).toEqual({ ok: true, cents: 0 });
    expect(parseEurosToCents("4.9")).toEqual({ ok: true, cents: 490 });
  });

  it("treats empty as clear and rejects malformed or negative euros", () => {
    expect(parseEurosToCents("")).toEqual({ ok: true, cents: null });
    expect(parseEurosToCents("  ")).toEqual({ ok: true, cents: null });
    expect(parseEurosToCents("-3")).toEqual({ ok: false, cents: null });
    expect(parseEurosToCents("abc")).toEqual({ ok: false, cents: null });
    expect(parseEurosToCents("1e3")).toEqual({ ok: false, cents: null });
    expect(parseEurosToCents("12.50 EUR")).toEqual({ ok: false, cents: null });
  });

  it("parses percents 0-100 with decimals", () => {
    expect(parsePercent("72")).toEqual({ ok: true, percent: 72 });
    expect(parsePercent("1.9")).toEqual({ ok: true, percent: 1.9 });
    expect(parsePercent("1,9")).toEqual({ ok: true, percent: 1.9 });
    expect(parsePercent("0")).toEqual({ ok: true, percent: 0 });
    expect(parsePercent("100")).toEqual({ ok: true, percent: 100 });
  });

  it("rejects out-of-range or malformed percents instead of clamping", () => {
    // The old treatment-page path let "72" through as a FRACTION and clamp01
    // silently turned it into 100% margin; here percent inputs are validated
    // 0-100 and converted to a fraction (72 → 0.72) at the call site.
    expect(parsePercent("150")).toEqual({ ok: false, percent: null });
    expect(parsePercent("-5")).toEqual({ ok: false, percent: null });
    expect(parsePercent("72%")).toEqual({ ok: false, percent: null });
    expect(parsePercent("")).toEqual({ ok: true, percent: null });
  });
});
