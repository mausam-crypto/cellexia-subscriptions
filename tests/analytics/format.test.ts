/**
 * Unit tests for the client-safe formatting helpers in
 * app/components/charts/format.ts (ANALYTICS-V2 §3), including regressions
 * for two shipped display bugs:
 *
 * - Duplicate integer axis labels: the old chart default
 *   `String(Math.round(v))` rendered the tick pair [0, 0.45] as "0"/"0" and
 *   labelled 0.6-unit bars "1".
 * - UTC week-label drift: `new Date("2026-08-03")` is UTC midnight Monday,
 *   which Intl renders as Sunday 2 August on servers west of UTC.
 */
import { describe, expect, it } from "vitest";
import {
  fmtDateLabel,
  fmtDelta,
  fmtMoney,
  fmtNumber,
  fmtPct,
} from "~/components/charts/format";

describe("fmtMoney", () => {
  it("formats cents with decimals when they matter", () => {
    expect(fmtMoney(3840, "EUR")).toBe("€38.40");
    expect(fmtMoney(9601, "EUR")).toBe("€96.01");
  });

  it("drops decimals for whole amounts (readable axis ticks)", () => {
    expect(fmtMoney(4900, "EUR")).toBe("€49");
    expect(fmtMoney(0, "EUR")).toBe("€0");
    expect(fmtMoney(2_000_000, "EUR")).toBe("€20,000");
  });

  it("handles negatives and rounding of fractional cents", () => {
    expect(fmtMoney(-1240, "EUR")).toBe("-€12.40");
    expect(fmtMoney(1239.6, "EUR")).toBe("€12.40");
  });

  it("never throws on a broken currency code", () => {
    expect(fmtMoney(4900, "NOT_A_CODE")).toContain("49");
  });
});

describe("fmtPct", () => {
  it("formats fractions 0..1 as percentages", () => {
    expect(fmtPct(0.05)).toBe("5.0%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(0.1234, 2)).toBe("12.34%");
    expect(fmtPct(0.75, 0)).toBe("75%");
  });

  it("treats non-finite input as zero", () => {
    expect(fmtPct(Number.NaN)).toBe("0.0%");
  });
});

describe("fmtNumber — fraction-aware axis/value formatter", () => {
  it("REGRESSION: the old integer default produced duplicate tick labels", () => {
    // Old BarChart default with max = 0.9 -> ticks [0, 0.45, 0.9]:
    const oldDefault = (v: number) => String(Math.round(v));
    expect(oldDefault(0)).toBe("0");
    expect(oldDefault(0.45)).toBe("0"); // duplicate of the 0 gridline
    expect(oldDefault(0.9)).toBe("1");
    // New formatter keeps them distinct:
    expect(fmtNumber(0)).toBe("0");
    expect(fmtNumber(0.45)).toBe("0.5");
    expect(fmtNumber(0.9)).toBe("0.9");
  });

  it("REGRESSION: fractional bar labels no longer contradict the ops table", () => {
    const oldDefault = (v: number) => String(Math.round(v));
    expect(oldDefault(0.4)).toBe("0"); // bar showed "0" for 0.4 units
    expect(oldDefault(0.6)).toBe("1"); // bar showed "1" for 0.6 units
    expect(fmtNumber(0.4)).toBe("0.4");
    expect(fmtNumber(0.6)).toBe("0.6");
  });

  it("keeps integers and large magnitudes as whole numbers", () => {
    expect(fmtNumber(12)).toBe("12");
    expect(fmtNumber(1234)).toBe("1234");
    expect(fmtNumber(37.6)).toBe("38");
    expect(fmtNumber(0)).toBe("0");
  });

  it("adds a second decimal only for very small magnitudes", () => {
    expect(fmtNumber(3.25)).toBe("3.3");
    expect(fmtNumber(0.09)).toBe("0.09");
  });

  it("treats non-finite input as zero", () => {
    expect(fmtNumber(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("fmtDelta", () => {
  it("formats rate deltas in signed percentage points", () => {
    expect(fmtDelta(0.021, "rate")).toBe("+2.1 pp");
    expect(fmtDelta(-0.021, "rate")).toBe("-2.1 pp");
  });

  it("formats money deltas via fmtMoney", () => {
    expect(fmtDelta(1240, "cents", "EUR")).toBe("+€12.40");
    expect(fmtDelta(-1240, "cents", "EUR")).toBe("-€12.40");
    expect(fmtDelta(500, "cents", "EUR")).toBe("+€5");
  });

  it("formats count and decimal deltas with signs", () => {
    expect(fmtDelta(3, "count")).toBe("+3");
    expect(fmtDelta(-140, "count")).toBe("-140");
    expect(fmtDelta(-0.5, "decimal")).toBe("-0.50");
    expect(fmtDelta(1.25, "decimal")).toBe("+1.25");
  });
});

describe("fmtDateLabel — no timezone drift", () => {
  it("REGRESSION: Date-parsing an ISO day drifts a day west of UTC", () => {
    // The old label pipeline: humanDate(new Date("2026-08-03")) — UTC
    // midnight Monday formatted in the server's local zone. Simulated here
    // with an explicit UTC-negative zone:
    const drifted = new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "America/New_York",
    }).format(new Date("2026-08-03"));
    expect(drifted).toBe("2 Aug"); // Sunday — the wrong label

    // The fix formats from the string itself; no Date, no zone, no drift.
    expect(fmtDateLabel("2026-08-03")).toBe("3 Aug");
  });

  it("labels every month correctly straight from the string", () => {
    expect(fmtDateLabel("2026-01-05")).toBe("5 Jan");
    expect(fmtDateLabel("2026-07-27")).toBe("27 Jul");
    expect(fmtDateLabel("2026-10-19")).toBe("19 Oct");
    expect(fmtDateLabel("2026-12-07")).toBe("7 Dec");
  });

  it("accepts full ISO timestamps (uses the date part)", () => {
    expect(fmtDateLabel("2026-08-03T00:00:00.000Z")).toBe("3 Aug");
  });

  it("returns unrecognised input untouched", () => {
    expect(fmtDateLabel("not-a-date")).toBe("not-a-date");
    expect(fmtDateLabel("2026-13-40")).toBe("2026-13-40");
  });
});
