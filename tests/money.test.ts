import { describe, expect, it } from "vitest";
import {
  applyDiscountPct,
  centsFromDecimalString,
  decimalStringFromCents,
  discountAmount,
  formatMoney,
} from "~/lib/money";

describe("cents conversions", () => {
  it("parses Shopify decimal strings to integer cents", () => {
    expect(centsFromDecimalString("12.34")).toBe(1234);
    expect(centsFromDecimalString("0.01")).toBe(1);
    expect(centsFromDecimalString("0.10")).toBe(10);
    expect(centsFromDecimalString("0")).toBe(0);
    // Classic float trap: 19.99 * 100 === 1998.9999999999998
    expect(centsFromDecimalString("19.99")).toBe(1999);
    expect(centsFromDecimalString("58.02")).toBe(5802);
    expect(centsFromDecimalString("1000000.00")).toBe(100_000_000);
  });

  it("accepts numeric input as well as strings", () => {
    expect(centsFromDecimalString(19.99)).toBe(1999);
    expect(centsFromDecimalString(0)).toBe(0);
    expect(centsFromDecimalString(42)).toBe(4200);
  });

  it("renders integer cents as a 2-decimal string", () => {
    expect(decimalStringFromCents(1234)).toBe("12.34");
    expect(decimalStringFromCents(1)).toBe("0.01");
    expect(decimalStringFromCents(0)).toBe("0.00");
    expect(decimalStringFromCents(100)).toBe("1.00");
    expect(decimalStringFromCents(1999)).toBe("19.99");
  });

  it("cents → string → cents round-trips exactly", () => {
    const samples = [0, 1, 5, 10, 99, 100, 101, 999, 1999, 12345, 999_999, 100_000_001];
    for (const cents of samples) {
      expect(
        centsFromDecimalString(decimalStringFromCents(cents)),
        `round-trip of ${cents} cents`,
      ).toBe(cents);
    }
  });

  it("string → cents → string round-trips canonical 2-decimal strings", () => {
    const samples = ["0.01", "0.99", "10.10", "19.99", "45.00", "123.45"];
    for (const s of samples) {
      expect(decimalStringFromCents(centsFromDecimalString(s))).toBe(s);
    }
  });
});

describe("applyDiscountPct rounding", () => {
  it("0% is the identity", () => {
    expect(applyDiscountPct(0, 0)).toBe(0);
    expect(applyDiscountPct(1, 0)).toBe(1);
    expect(applyDiscountPct(1999, 0)).toBe(1999);
  });

  it("100% always yields zero", () => {
    expect(applyDiscountPct(0, 100)).toBe(0);
    expect(applyDiscountPct(1, 100)).toBe(0);
    expect(applyDiscountPct(999, 100)).toBe(0);
    expect(applyDiscountPct(123_456, 100)).toBe(0);
  });

  it("odd-cent amounts round to the nearest cent (half rounds up)", () => {
    // 999 * 90% = 899.1 → 899
    expect(applyDiscountPct(999, 10)).toBe(899);
    // 105 * 50% = 52.5 → Math.round → 53
    expect(applyDiscountPct(105, 50)).toBe(53);
    // 1 * 50% = 0.5 → 1 (rounds up, never negative-surprises the customer... of margin)
    expect(applyDiscountPct(1, 50)).toBe(1);
    // 1234 * 67% = 826.78 → 827
    expect(applyDiscountPct(1234, 33)).toBe(827);
    // 999 * 85% = 849.15 → 849
    expect(applyDiscountPct(999, 15)).toBe(849);
  });

  it("result is always an integer number of cents", () => {
    for (const cents of [1, 33, 101, 999, 12345]) {
      for (const pct of [0, 1, 7, 10, 15, 25, 33, 50, 99, 100]) {
        const out = applyDiscountPct(cents, pct);
        expect(Number.isInteger(out), `${cents} @ ${pct}%`).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(cents);
      }
    }
  });

  it("discountAmount + discounted price reconstitute the original", () => {
    for (const cents of [1, 105, 999, 1999, 12345]) {
      for (const pct of [0, 10, 15, 33, 50, 100]) {
        expect(applyDiscountPct(cents, pct) + discountAmount(cents, pct)).toBe(
          cents,
        );
      }
    }
  });

  it("discountAmount examples", () => {
    expect(discountAmount(999, 10)).toBe(100); // 999 - 899
    expect(discountAmount(105, 50)).toBe(52); // 105 - 53
    expect(discountAmount(1000, 0)).toBe(0);
    expect(discountAmount(1000, 100)).toBe(1000);
  });
});

describe("formatMoney locales (smoke)", () => {
  it("formats GBP for en", () => {
    const s = formatMoney(123_456, "GBP", "en");
    expect(s).toContain("£");
    expect(s).toContain("1,234.56");
  });

  it("formats EUR for de (comma decimals, dot grouping)", () => {
    const s = formatMoney(123_456, "EUR", "de");
    expect(s).toContain("€");
    expect(s).toContain("1.234,56");
  });

  it("defaults the locale to en", () => {
    expect(formatMoney(4999, "USD")).toContain("49.99");
  });

  it("zero-decimal currencies still render (JPY)", () => {
    // 500 internal cents = ¥5 — conversion at the boundary is /100 regardless.
    const s = formatMoney(500, "JPY", "en");
    expect(s).toContain("5");
    expect(s).toMatch(/¥|JP¥/);
  });

  it("zero and negative amounts format without throwing", () => {
    expect(formatMoney(0, "GBP", "en")).toContain("0.00");
    expect(formatMoney(-1999, "GBP", "en")).toContain("19.99");
  });
});
