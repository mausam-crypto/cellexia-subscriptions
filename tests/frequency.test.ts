import { describe, expect, it } from "vitest";
import {
  FREQUENCY_COUNT_LIMITS,
  type Frequency,
  approxDays,
  approxWeeks,
  contractFrequency,
  frequencyInputText,
  frequencyLabelEn,
  frequencyPhraseKey,
  frequencyRangeError,
  frequencyToken,
  normalizeFrequencies,
  parseConfigDefaultFrequency,
  parseConfigFrequencies,
  parseFrequencyInput,
  parseFrequencyToken,
  planOptionValue,
  sameFrequency,
} from "~/lib/frequency";
import { addIntervalTz } from "~/lib/dates.server";

const f = (unit: Frequency["unit"], count: number): Frequency => ({
  unit,
  count,
});

// ── planOptionValue: the selling-plan reconcile-key contract ─────────────────

describe("planOptionValue (Shopify plan name, option value AND reconcile key)", () => {
  it("keeps WEEK byte-identical to the pre-v1.8.0 format — ALWAYS plural", () => {
    /* This exact string has been the plan reconcile key since v1.0.0: the
       sync matches existing Shopify plans by option value, so any change to
       the WEEK format — including fixing the count-1 grammar — would delete
       and recreate every live week plan under new GIDs (allow-list churn on
       a live storefront). Deliberately ungrammatical, deliberately pinned. */
    expect(planOptionValue(f("WEEK", 8))).toBe("Every 8 weeks");
    expect(planOptionValue(f("WEEK", 1))).toBe("Every 1 weeks");
  });

  it("gives DAY and MONTH plans (new in v1.8.0) grammatical singular/plural", () => {
    expect(planOptionValue(f("DAY", 10))).toBe("Every 10 days");
    expect(planOptionValue(f("DAY", 1))).toBe("Every 1 day");
    expect(planOptionValue(f("MONTH", 1))).toBe("Every 1 month");
    expect(planOptionValue(f("MONTH", 3))).toBe("Every 3 months");
  });

  it("stays parseable by the buy box: a lowercase unit noun and one number", () => {
    /* The storefront widget extracts count + unit by scanning the option
       value for 'day'/'week'/'month' and the first numeric token — every
       string this function can produce must satisfy that. */
    for (const freq of [
      f("DAY", 1),
      f("DAY", 90),
      f("WEEK", 1),
      f("WEEK", 26),
      f("MONTH", 1),
      f("MONTH", 12),
    ]) {
      const value = planOptionValue(freq).toLowerCase();
      expect(value).toContain(freq.unit.toLowerCase());
      const firstNumber = value.split(" ").find((t) => /^\d+$/.test(t));
      expect(Number(firstNumber)).toBe(freq.count);
    }
  });

  it("frequencyLabelEn is the same string (admin shows what checkout shows)", () => {
    expect(frequencyLabelEn(f("MONTH", 2))).toBe(planOptionValue(f("MONTH", 2)));
  });
});

// ── Admin text input ─────────────────────────────────────────────────────────

describe("parseFrequencyInput (admin comma-token grammar)", () => {
  it("keeps the pre-v1.8.0 format working: bare integers are weeks", () => {
    expect(parseFrequencyInput("8")).toEqual(f("WEEK", 8));
    expect(parseFrequencyInput(" 12 ")).toEqual(f("WEEK", 12));
  });

  it("accepts unit suffixes, with and without spacing, case-insensitively", () => {
    expect(parseFrequencyInput("10d")).toEqual(f("DAY", 10));
    expect(parseFrequencyInput("10 days")).toEqual(f("DAY", 10));
    expect(parseFrequencyInput("1 day")).toEqual(f("DAY", 1));
    expect(parseFrequencyInput("2w")).toEqual(f("WEEK", 2));
    expect(parseFrequencyInput("2 WEEKS")).toEqual(f("WEEK", 2));
    expect(parseFrequencyInput("6wk")).toEqual(f("WEEK", 6));
    expect(parseFrequencyInput("1m")).toEqual(f("MONTH", 1));
    expect(parseFrequencyInput("1mo")).toEqual(f("MONTH", 1));
    expect(parseFrequencyInput("3 months")).toEqual(f("MONTH", 3));
  });

  it("rejects everything else", () => {
    for (const bad of ["", "d", "0", "0d", "-3", "8x", "week 2", "1.5m", "8 8"]) {
      expect(parseFrequencyInput(bad), bad).toBeNull();
    }
  });

  it("round-trips through frequencyInputText", () => {
    const list = [f("DAY", 10), f("WEEK", 8), f("MONTH", 1)];
    const parsed = frequencyInputText(list)
      .split(",")
      .map((s) => parseFrequencyInput(s.trim()));
    expect(parsed).toEqual(list);
  });
});

// ── Tokens ───────────────────────────────────────────────────────────────────

describe("frequencyToken (form-value format)", () => {
  it("round-trips", () => {
    for (const freq of [f("DAY", 10), f("WEEK", 8), f("MONTH", 12)]) {
      expect(parseFrequencyToken(frequencyToken(freq))).toEqual(freq);
    }
  });

  it("rejects malformed and hostile tokens", () => {
    for (const bad of ["", "8", "WEEK:8", "8:week", "8:YEAR", "08x:WEEK", "8:WEEK:1", "<img>:WEEK"]) {
      expect(parseFrequencyToken(bad), bad).toBeNull();
    }
  });
});

// ── Ordering, dedupe, approximation ──────────────────────────────────────────

describe("normalizeFrequencies", () => {
  it("dedupes exact pairs and sorts shortest cadence first across units", () => {
    expect(
      normalizeFrequencies([
        f("MONTH", 1),
        f("WEEK", 2),
        f("WEEK", 2),
        f("DAY", 10),
        f("WEEK", 6),
      ]),
    ).toEqual([f("DAY", 10), f("WEEK", 2), f("MONTH", 1), f("WEEK", 6)]);
  });

  it("keeps equivalent durations in different units, finer unit first", () => {
    // 7 days and 1 week are distinct selling plans with distinct names.
    expect(normalizeFrequencies([f("WEEK", 1), f("DAY", 7)])).toEqual([
      f("DAY", 7),
      f("WEEK", 1),
    ]);
  });
});

describe("approxWeeks (the intervalWeeks lingua franca — scheduling display only)", () => {
  it("matches the contract-mirror math used since v1.4.0", () => {
    expect(approxWeeks("WEEK", 8)).toBe(8);
    expect(approxWeeks("MONTH", 1)).toBe(4);
    expect(approxWeeks("MONTH", 3)).toBe(12);
    expect(approxWeeks("DAY", 10)).toBe(2);
    expect(approxWeeks("DAY", 7)).toBe(1);
    expect(approxWeeks("DAY", 1)).toBe(1);
    expect(approxWeeks("YEAR", 1)).toBe(52);
    expect(approxWeeks("FORTNIGHT", 3)).toBe(3); // unknown unit: count through
    expect(approxWeeks("WEEK", 0)).toBe(1); // floor at one
  });

  it("approxDays orders mixed units for display", () => {
    expect(approxDays("DAY", 10)).toBeLessThan(approxDays("WEEK", 2));
    expect(approxDays("WEEK", 4)).toBeLessThan(approxDays("MONTH", 1));
  });
});

// ── Config parsing fallback chain ────────────────────────────────────────────

describe("parseConfigFrequencies (new column first, legacy weeks fallback)", () => {
  it("prefers the multi-unit column when coherent with the week projection", () => {
    // approxWeeks projection of [10d, 1mo] is {2, 4} — matches the stored
    // legacy set a v1.8.0 save would have written alongside.
    expect(
      parseConfigFrequencies({
        frequencies: [f("DAY", 10), f("MONTH", 1)],
        defaultFrequency: f("MONTH", 1),
        frequenciesWeeks: [2, 4],
        defaultFrequencyWeeks: 4,
      }),
    ).toEqual([f("DAY", 10), f("MONTH", 1)]);
  });

  it("prefers the LEGACY columns when they drifted — a rollback-window edit", () => {
    /* Only a pre-v1.8.0 build (which cannot see the Json columns) writes the
       week columns WITHOUT the projection staying in sync. Drift therefore
       means the merchant edited the plan while rolled back, and rolling
       forward must honor that newer edit instead of silently reverting to
       the stale multi-unit list. */
    expect(
      parseConfigFrequencies({
        frequencies: [f("DAY", 10), f("MONTH", 1)],
        defaultFrequency: f("MONTH", 1),
        frequenciesWeeks: [4, 6],
        defaultFrequencyWeeks: 6,
      }),
    ).toEqual([f("WEEK", 4), f("WEEK", 6)]);
  });

  it("falls back to legacy week ints on NULL (pre-v1.8.0 rows)", () => {
    expect(
      parseConfigFrequencies({
        frequencies: null,
        defaultFrequency: null,
        frequenciesWeeks: [4, 8],
        defaultFrequencyWeeks: 8,
      }),
    ).toEqual([f("WEEK", 4), f("WEEK", 8)]);
  });

  it("falls back through malformed Json without crashing", () => {
    expect(
      parseConfigFrequencies({
        frequencies: [{ unit: "FORTNIGHT", count: 2 }],
        defaultFrequency: "8",
        frequenciesWeeks: "not-an-array",
        defaultFrequencyWeeks: 6,
      }),
    ).toEqual([f("WEEK", 6)]);
  });

  it("parseConfigDefaultFrequency has the same coherence chain", () => {
    expect(
      parseConfigDefaultFrequency({
        defaultFrequency: f("DAY", 10),
        defaultFrequencyWeeks: 2, // approxWeeks(DAY,10) — coherent
      }),
    ).toEqual(f("DAY", 10));
    expect(
      parseConfigDefaultFrequency({
        defaultFrequency: f("DAY", 10),
        defaultFrequencyWeeks: 8, // drifted: rollback-era edit wins
      }),
    ).toEqual(f("WEEK", 8));
    expect(
      parseConfigDefaultFrequency({ defaultFrequency: null, defaultFrequencyWeeks: 8 }),
    ).toEqual(f("WEEK", 8));
  });
});

// ── Contract cadence resolution ──────────────────────────────────────────────

describe("contractFrequency (every cadence display goes through this)", () => {
  it("uses the exact mirror when valid", () => {
    expect(
      contractFrequency({
        intervalWeeks: 4,
        billingIntervalUnit: "MONTH",
        billingIntervalCount: 1,
      }),
    ).toEqual(f("MONTH", 1));
  });

  it("falls back to intervalWeeks on NULL mirror (pre-v1.4.0 rows)", () => {
    expect(
      contractFrequency({ intervalWeeks: 6, billingIntervalUnit: null, billingIntervalCount: null }),
    ).toEqual(f("WEEK", 6));
  });

  it("degrades YEAR (not plan-offerable) to the week approximation", () => {
    expect(
      contractFrequency({
        intervalWeeks: 52,
        billingIntervalUnit: "YEAR",
        billingIntervalCount: 1,
      }),
    ).toEqual(f("WEEK", 52));
  });
});

// ── Limits + phrase keys ─────────────────────────────────────────────────────

describe("frequencyRangeError", () => {
  it("enforces the per-unit authoring limits", () => {
    expect(frequencyRangeError(f("DAY", 90))).toBeNull();
    expect(frequencyRangeError(f("DAY", 91))).toMatch(/1 and 90/);
    expect(frequencyRangeError(f("WEEK", 26))).toBeNull();
    expect(frequencyRangeError(f("WEEK", 27))).toMatch(/1 and 26/);
    expect(frequencyRangeError(f("MONTH", 12))).toBeNull();
    expect(frequencyRangeError(f("MONTH", 13))).toMatch(/1 and 12/);
    expect(FREQUENCY_COUNT_LIMITS.WEEK.max).toBe(26);
  });
});

describe("frequencyPhraseKey (i18n key family contract)", () => {
  it("selects the one/other form per count and lowercases the unit", () => {
    expect(frequencyPhraseKey("every", f("MONTH", 1))).toEqual({
      key: "freq.every.month.one",
      vars: { count: 1 },
    });
    expect(frequencyPhraseKey("option", f("DAY", 10))).toEqual({
      key: "freq.option.day.other",
      vars: { count: 10 },
    });
  });
});

describe("sameFrequency", () => {
  it("compares unit AND count — 7 days is not 1 week", () => {
    expect(sameFrequency(f("DAY", 7), f("DAY", 7))).toBe(true);
    expect(sameFrequency(f("DAY", 7), f("WEEK", 1))).toBe(false);
  });
});

// ── addIntervalTz (calendar-exact advancement) ───────────────────────────────

describe("addIntervalTz", () => {
  const LONDON = "Europe/London";
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: LONDON,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  it("advances MONTH by calendar months with month-end clamping", () => {
    // Jan 31 + 1 month = Feb 28 (2026 is not a leap year) — the same clamp
    // Shopify applies walking a MONTH billing policy.
    const base = new Date("2026-01-31T09:00:00Z");
    expect(day(addIntervalTz(base, "MONTH", 1, LONDON))).toBe("2026-02-28");
    expect(day(addIntervalTz(base, "MONTH", 3, LONDON))).toBe("2026-04-30");
  });

  it("advances DAY and WEEK exactly", () => {
    const base = new Date("2026-08-01T09:00:00Z");
    expect(day(addIntervalTz(base, "DAY", 10, LONDON))).toBe("2026-08-11");
    expect(day(addIntervalTz(base, "WEEK", 2, LONDON))).toBe("2026-08-15");
  });

  it("steps multiple intervals, and backwards with intervals = -1", () => {
    const base = new Date("2026-08-01T09:00:00Z");
    expect(day(addIntervalTz(base, "MONTH", 1, LONDON, 2))).toBe("2026-10-01");
    expect(day(addIntervalTz(base, "WEEK", 2, LONDON, -1))).toBe("2026-07-18");
  });

  it("keeps local wall-clock time across the October DST fall-back", () => {
    // Sat 24 Oct 2026 09:00 BST + 10 days crosses the Oct 25 fall-back.
    const base = new Date("2026-10-15T08:00:00Z"); // 09:00 London (BST)
    const advanced = addIntervalTz(base, "DAY", 10, LONDON);
    expect(day(advanced)).toBe("2026-10-25");
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: LONDON,
        hour: "2-digit",
        minute: "2-digit",
      }).format(advanced),
    ).toBe("09:00");
  });
});
