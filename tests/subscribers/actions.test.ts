/**
 * [subscribers] — unit tests for the pure CS-console helpers.
 * These exercise parsing/validation and display decision logic only (no I/O).
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_DUNNING_PHASES,
  auditActionFor,
  cadenceLabel,
  churnBand,
  churnBandTone,
  churnScoreRange,
  CS_INTENTS,
  DESTRUCTIVE_INTENTS,
  dunningTone,
  humanizeEnum,
  linesSummary,
  MAX_ACCOUNT_CREDIT_CENTS,
  MAX_DELAY_WEEKS,
  MAX_LINE_QUANTITY,
  nextBillingRange,
  normalizeVariantGid,
  parseConsoleAction,
  parseIsoDate,
  parseSubscriberFilters,
  qualityTone,
  scoreOutOf100,
  statusTone,
  successMessage,
  truncate,
} from "~/services/subscribers/actions";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function fd(entries: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) value.forEach((v) => form.append(key, v));
    else form.append(key, value);
  }
  return form;
}

function expectOk(result: ReturnType<typeof parseConsoleAction>) {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.action;
}

function expectFail(result: ReturnType<typeof parseConsoleAction>): string {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.action)}`);
  return result.error;
}

describe("parseConsoleAction", () => {
  it("rejects unknown intents", () => {
    expect(expectFail(parseConsoleAction(fd({ intent: "DO_MAGIC" })))).toMatch(/unknown/i);
    expect(expectFail(parseConsoleAction(fd({})))).toMatch(/unknown/i);
  });

  it("requires explicit confirmation on destructive intents", () => {
    for (const intent of DESTRUCTIVE_INTENTS) {
      const result = parseConsoleAction(fd({ intent }), { now: NOW });
      expect(expectFail(result)).toMatch(/confirmation/i);
    }
  });

  describe("CHANGE_QUANTITY", () => {
    it("parses a valid quantity change", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "CHANGE_QUANTITY", lineId: "line_1", quantity: "3" })),
      );
      expect(action).toEqual({ intent: "CHANGE_QUANTITY", lineId: "line_1", quantity: 3 });
    });

    it("rejects missing line, non-integer, zero and over-cap quantities", () => {
      expect(
        parseConsoleAction(fd({ intent: "CHANGE_QUANTITY", quantity: "3" })).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "CHANGE_QUANTITY", lineId: "l", quantity: "2.5" })).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "CHANGE_QUANTITY", lineId: "l", quantity: "0" })).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(
          fd({ intent: "CHANGE_QUANTITY", lineId: "l", quantity: String(MAX_LINE_QUANTITY + 1) }),
        ).ok,
      ).toBe(false);
    });
  });

  describe("CHANGE_VARIANT / ADD_PRODUCT", () => {
    it("normalises numeric variant ids to GIDs", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "CHANGE_VARIANT", lineId: "l1", variantGid: "42" })),
      );
      expect(action).toEqual({
        intent: "CHANGE_VARIANT",
        lineId: "l1",
        variantGid: "gid://shopify/ProductVariant/42",
      });
    });

    it("rejects malformed variant references", () => {
      expect(
        parseConsoleAction(
          fd({ intent: "CHANGE_VARIANT", lineId: "l1", variantGid: "gid://shopify/Product/42" }),
        ).ok,
      ).toBe(false);
    });

    it("parses ADD_PRODUCT with a price override in cents", () => {
      const action = expectOk(
        parseConsoleAction(
          fd({ intent: "ADD_PRODUCT", variantGid: "77", quantity: "2", price: "12.50" }),
        ),
      );
      expect(action).toEqual({
        intent: "ADD_PRODUCT",
        variantGid: "gid://shopify/ProductVariant/77",
        quantity: 2,
        priceCents: 1250,
      });
    });

    it("defaults ADD_PRODUCT quantity to 1 and omits price when blank", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "ADD_PRODUCT", variantGid: "77" })),
      );
      expect(action).toEqual({
        intent: "ADD_PRODUCT",
        variantGid: "gid://shopify/ProductVariant/77",
        quantity: 1,
      });
    });

    it("rejects a zero price override", () => {
      expect(
        parseConsoleAction(fd({ intent: "ADD_PRODUCT", variantGid: "77", price: "0" })).ok,
      ).toBe(false);
    });
  });

  describe("REMOVE_PRODUCT", () => {
    it("parses with confirm + lineId", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "REMOVE_PRODUCT", lineId: "l9", confirm: "yes" })),
      );
      expect(action).toEqual({ intent: "REMOVE_PRODUCT", lineId: "l9" });
    });
  });

  describe("dates (CHANGE_BILLING_DATE / BRING_FORWARD)", () => {
    it("accepts a future calendar date at UTC midnight", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "CHANGE_BILLING_DATE", date: "2026-08-01" }), {
          now: NOW,
        }),
      );
      expect(action).toEqual({
        intent: "CHANGE_BILLING_DATE",
        date: new Date("2026-08-01T00:00:00.000Z"),
      });
    });

    it("rejects past dates and garbage", () => {
      expect(
        parseConsoleAction(fd({ intent: "CHANGE_BILLING_DATE", date: "2026-07-20" }), {
          now: NOW,
        }).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "BRING_FORWARD", date: "not-a-date" }), { now: NOW })
          .ok,
      ).toBe(false);
    });
  });

  describe("DELAY_WEEKS", () => {
    it("accepts 1..MAX_DELAY_WEEKS", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "DELAY_WEEKS", weeks: "4" }), { now: NOW }),
      );
      expect(action).toEqual({ intent: "DELAY_WEEKS", weeks: 4 });
    });

    it("rejects zero and over-cap delays", () => {
      expect(parseConsoleAction(fd({ intent: "DELAY_WEEKS", weeks: "0" })).ok).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "DELAY_WEEKS", weeks: String(MAX_DELAY_WEEKS + 1) })).ok,
      ).toBe(false);
    });
  });

  describe("PAUSE_UNTIL", () => {
    it("computes the resume date from a 30/60/90 preset", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "PAUSE_UNTIL", pauseDays: "60" }), { now: NOW }),
      );
      expect(action).toEqual({
        intent: "PAUSE_UNTIL",
        resumeDate: new Date("2026-09-19T12:00:00.000Z"),
      });
    });

    it("prefers an explicit future resume date", () => {
      const action = expectOk(
        parseConsoleAction(
          fd({ intent: "PAUSE_UNTIL", resumeDate: "2026-10-01", pauseDays: "30" }),
          { now: NOW },
        ),
      );
      expect(action).toEqual({
        intent: "PAUSE_UNTIL",
        resumeDate: new Date("2026-10-01T00:00:00.000Z"),
      });
    });

    it("rejects non-preset day counts and past resume dates", () => {
      expect(
        parseConsoleAction(fd({ intent: "PAUSE_UNTIL", pauseDays: "45" }), { now: NOW }).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "PAUSE_UNTIL", resumeDate: "2026-01-01" }), {
          now: NOW,
        }).ok,
      ).toBe(false);
    });
  });

  describe("SWITCH_CADENCE", () => {
    it("accepts a sane interval", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "SWITCH_CADENCE", intervalWeeks: "8" })),
      );
      expect(action).toEqual({ intent: "SWITCH_CADENCE", intervalWeeks: 8 });
    });

    it("rejects out-of-range intervals", () => {
      expect(
        parseConsoleAction(fd({ intent: "SWITCH_CADENCE", intervalWeeks: "0" })).ok,
      ).toBe(false);
      expect(
        parseConsoleAction(fd({ intent: "SWITCH_CADENCE", intervalWeeks: "52" })).ok,
      ).toBe(false);
    });
  });

  describe("CHANGE_ADDRESS", () => {
    const base = {
      intent: "CHANGE_ADDRESS",
      address1: "12 Rue de la Paix",
      city: "Paris",
      zip: "75002",
      countryCode: "fr",
    };

    it("builds a normalised address (country upper-cased, optionals included)", () => {
      const action = expectOk(
        parseConsoleAction(fd({ ...base, firstName: "Anna", phone: "+33 6 00 00 00 00" })),
      );
      expect(action).toEqual({
        intent: "CHANGE_ADDRESS",
        address: {
          address1: "12 Rue de la Paix",
          city: "Paris",
          zip: "75002",
          countryCode: "FR",
          firstName: "Anna",
          phone: "+33 6 00 00 00 00",
        },
      });
    });

    it("rejects missing required fields and bad country codes", () => {
      expect(parseConsoleAction(fd({ ...base, city: "" })).ok).toBe(false);
      expect(parseConsoleAction(fd({ ...base, countryCode: "FRA" })).ok).toBe(false);
    });
  });

  describe("APPLY_CREDIT", () => {
    it("converts a decimal amount to integer cents", () => {
      const action = expectOk(parseConsoleAction(fd({ intent: "APPLY_CREDIT", amount: "12.50" })));
      expect(action).toEqual({ intent: "APPLY_CREDIT", amountCents: 1250 });
    });

    it("rejects zero, garbage and over-cap amounts", () => {
      expect(parseConsoleAction(fd({ intent: "APPLY_CREDIT", amount: "0" })).ok).toBe(false);
      expect(parseConsoleAction(fd({ intent: "APPLY_CREDIT", amount: "abc" })).ok).toBe(false);
      expect(
        parseConsoleAction(
          fd({ intent: "APPLY_CREDIT", amount: String(MAX_ACCOUNT_CREDIT_CENTS / 100 + 1) }),
        ).ok,
      ).toBe(false);
    });
  });

  describe("CANCEL", () => {
    it("requires a valid reason and confirmation", () => {
      const action = expectOk(
        parseConsoleAction(fd({ intent: "CANCEL", reason: "TOO_EXPENSIVE", confirm: "yes" })),
      );
      expect(action).toEqual({ intent: "CANCEL", reason: "TOO_EXPENSIVE" });
      expect(
        parseConsoleAction(fd({ intent: "CANCEL", reason: "BAD_REASON", confirm: "yes" })).ok,
      ).toBe(false);
      expect(parseConsoleAction(fd({ intent: "CANCEL", reason: "TOO_EXPENSIVE" })).ok).toBe(
        false,
      );
    });
  });

  describe("MERGE_CONTRACTS", () => {
    it("rejects merging a plan into itself", () => {
      const result = parseConsoleAction(
        fd({ intent: "MERGE_CONTRACTS", targetContractId: "c1", confirm: "yes" }),
        { selfContractId: "c1" },
      );
      expect(result.ok).toBe(false);
    });

    it("parses a valid merge target", () => {
      const action = expectOk(
        parseConsoleAction(
          fd({ intent: "MERGE_CONTRACTS", targetContractId: "c2", confirm: "yes" }),
          { selfContractId: "c1" },
        ),
      );
      expect(action).toEqual({ intent: "MERGE_CONTRACTS", targetContractId: "c2" });
    });
  });

  describe("SPLIT_SHIPMENT", () => {
    it("requires at least one selected line", () => {
      expect(
        parseConsoleAction(fd({ intent: "SPLIT_SHIPMENT", confirm: "yes" }), {
          totalLineCount: 3,
        }).ok,
      ).toBe(false);
    });

    it("must leave at least one line in the original plan", () => {
      const result = parseConsoleAction(
        fd({ intent: "SPLIT_SHIPMENT", lineIds: ["a", "b"], confirm: "yes" }),
        { totalLineCount: 2 },
      );
      expect(result.ok).toBe(false);
    });

    it("parses and dedupes a valid subset", () => {
      const action = expectOk(
        parseConsoleAction(
          fd({ intent: "SPLIT_SHIPMENT", lineIds: ["a", "a", "b"], confirm: "yes" }),
          { totalLineCount: 3 },
        ),
      );
      expect(action).toEqual({ intent: "SPLIT_SHIPMENT", lineIds: ["a", "b"] });
    });
  });
});

describe("normalizeVariantGid / parseIsoDate", () => {
  it("passes through valid GIDs and rejects everything else", () => {
    expect(normalizeVariantGid("gid://shopify/ProductVariant/9")).toBe(
      "gid://shopify/ProductVariant/9",
    );
    expect(normalizeVariantGid("9")).toBe("gid://shopify/ProductVariant/9");
    expect(normalizeVariantGid("gid://shopify/Product/9")).toBeNull();
    expect(normalizeVariantGid(null)).toBeNull();
    expect(normalizeVariantGid("  ")).toBeNull();
  });

  it("parses calendar dates as UTC midnight and rejects invalid input", () => {
    expect(parseIsoDate("2026-08-01")).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(parseIsoDate("2026-08-01T09:30:00.000Z")).toEqual(
      new Date("2026-08-01T09:30:00.000Z"),
    );
    expect(parseIsoDate("31/12/2026")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });
});

describe("churn banding and score display", () => {
  it("bands scores on a 0-1 scale", () => {
    expect(churnBand(null)).toBe("UNSCORED");
    expect(churnBand(undefined)).toBe("UNSCORED");
    expect(churnBand(0.1)).toBe("LOW");
    expect(churnBand(0.4)).toBe("MEDIUM");
    expect(churnBand(0.69)).toBe("MEDIUM");
    expect(churnBand(0.7)).toBe("HIGH");
  });

  it("tolerates 0-100 scale inputs", () => {
    expect(churnBand(85)).toBe("HIGH");
    expect(churnBand(45)).toBe("MEDIUM");
  });

  it("produces Prisma-ready ranges per band", () => {
    expect(churnScoreRange("LOW")).toEqual({ lt: 0.4 });
    expect(churnScoreRange("MEDIUM")).toEqual({ gte: 0.4, lt: 0.7 });
    expect(churnScoreRange("HIGH")).toEqual({ gte: 0.7 });
  });

  it("normalises scores for display", () => {
    expect(scoreOutOf100(0.825)).toBe(83);
    expect(scoreOutOf100(1)).toBe(100);
    expect(scoreOutOf100(82.5)).toBe(83);
  });

  it("maps bands and scores to badge tones", () => {
    expect(churnBandTone("HIGH")).toBe("critical");
    expect(churnBandTone("MEDIUM")).toBe("attention");
    expect(churnBandTone("LOW")).toBe("success");
    expect(churnBandTone("UNSCORED")).toBeUndefined();
    expect(qualityTone(0.9)).toBe("success");
    expect(qualityTone(0.5)).toBe("attention");
    expect(qualityTone(0.1)).toBe("critical");
    expect(qualityTone(null)).toBeUndefined();
  });
});

describe("status and dunning tones", () => {
  it("maps contract statuses", () => {
    expect(statusTone("ACTIVE")).toBe("success");
    expect(statusTone("PAUSED")).toBe("attention");
    expect(statusTone("CANCELLED")).toBe("critical");
    expect(statusTone("FAILED")).toBe("warning");
  });

  it("maps dunning phases and defines active recovery phases", () => {
    expect(dunningTone("RESOLVED")).toBe("success");
    expect(dunningTone("FINAL_NOTICE")).toBe("critical");
    expect(dunningTone("NONE")).toBeUndefined();
    expect(ACTIVE_DUNNING_PHASES).toEqual([
      "PRE_DUNNING",
      "RETRYING",
      "GRACE",
      "FINAL_NOTICE",
    ]);
  });
});

describe("nextBillingRange", () => {
  it("builds the expected date windows", () => {
    expect(nextBillingRange("OVERDUE", NOW)).toEqual({ lt: NOW });
    expect(nextBillingRange("NEXT_7_DAYS", NOW)).toEqual({
      gte: NOW,
      lt: new Date("2026-07-28T12:00:00.000Z"),
    });
    expect(nextBillingRange("NEXT_30_DAYS", NOW)).toEqual({
      gte: NOW,
      lt: new Date("2026-08-20T12:00:00.000Z"),
    });
  });
});

describe("parseSubscriberFilters", () => {
  it("keeps valid values and drops invalid ones", () => {
    const filters = parseSubscriberFilters(
      new URLSearchParams(
        "status=ACTIVE&band=HIGH&phase=RETRYING&window=NEXT_7_DAYS&email=+anna%40x.com+&page=3",
      ),
    );
    expect(filters).toEqual({
      status: "ACTIVE",
      churnBand: "HIGH",
      dunningPhase: "RETRYING",
      window: "NEXT_7_DAYS",
      email: "anna@x.com",
      page: 3,
    });
  });

  it("falls back safely on garbage", () => {
    const filters = parseSubscriberFilters(
      new URLSearchParams("status=NOPE&band=EXTREME&phase=YELLING&window=SOON&page=-2"),
    );
    expect(filters).toEqual({
      status: null,
      churnBand: null,
      dunningPhase: null,
      window: null,
      email: null,
      page: 1,
    });
    expect(parseSubscriberFilters(new URLSearchParams("page=2.5")).page).toBe(1);
  });
});

describe("display helpers", () => {
  it("humanizes enum-like strings", () => {
    expect(humanizeEnum("TOO_MUCH_PRODUCT")).toBe("Too much product");
    expect(humanizeEnum("ACTIVE")).toBe("Active");
  });

  it("labels cadences", () => {
    expect(cadenceLabel(1)).toBe("Every week");
    expect(cadenceLabel(4)).toBe("Every 4 weeks");
  });

  it("summarises lines with an overflow suffix", () => {
    expect(linesSummary([])).toBe("No products");
    expect(
      linesSummary([
        { title: "Serum", quantity: 2 },
        { title: "Cream", quantity: 1 },
      ]),
    ).toBe("2× Serum · 1× Cream");
    expect(
      linesSummary(
        [
          { title: "A", quantity: 1 },
          { title: "B", quantity: 1 },
          { title: "C", quantity: 1 },
          { title: "D", quantity: 1 },
        ],
        2,
      ),
    ).toBe("1× A · 1× B +2 more");
  });

  it("truncates long payload previews", () => {
    expect(truncate("short")).toBe("short");
    const long = "x".repeat(200);
    expect(truncate(long, 50)).toHaveLength(50);
    expect(truncate(long, 50).endsWith("…")).toBe(true);
  });
});

describe("audit + toast copy", () => {
  it("prefixes audit actions with CS_", () => {
    expect(auditActionFor("SKIP_SHIPMENT")).toBe("CS_SKIP_SHIPMENT");
  });

  it("covers every intent with a success message", () => {
    for (const intent of CS_INTENTS) {
      const result = parseConsoleAction(
        fd({
          intent,
          confirm: "yes",
          lineId: "l1",
          quantity: "2",
          variantGid: "42",
          date: "2099-01-01",
          weeks: "2",
          pauseDays: "30",
          intervalWeeks: "4",
          address1: "1 Main St",
          city: "Paris",
          zip: "75001",
          countryCode: "FR",
          amount: "5.00",
          reason: "TOO_EXPENSIVE",
          targetContractId: "c2",
          lineIds: "l1",
        }),
        { now: NOW, selfContractId: "c1", totalLineCount: 2 },
      );
      const action = expectOk(result);
      expect(successMessage(action).length).toBeGreaterThan(0);
    }
  });

  it("pluralises the delay message", () => {
    expect(successMessage({ intent: "DELAY_WEEKS", weeks: 1 })).toContain("1 week.");
    expect(successMessage({ intent: "DELAY_WEEKS", weeks: 3 })).toContain("3 weeks.");
  });
});
