import { describe, expect, it } from "vitest";
import {
  DECLINE_CODES,
  DECLINE_CODE_TABLE,
  UNKNOWN_DECLINE,
  categorizeDeclineCode,
  type CustomerAction,
  type DeclineCategory,
} from "~/lib/dunning/decline-codes.server";

/**
 * Expected classification for every documented code. This table is a
 * deliberate change-detector: adding, removing or re-classifying a code in
 * the taxonomy must be mirrored here, so a silent category flip (the kind
 * that kills recoverable subscriptions or retries hopeless ones) can't land
 * unnoticed.
 */
const EXPECTED: Record<
  string,
  { category: DeclineCategory; retryable: boolean; customerAction: CustomerAction }
> = {
  // Soft
  INSUFFICIENT_FUNDS: { category: "SOFT", retryable: true, customerAction: "NONE" },
  PAYMENT_METHOD_DECLINED: { category: "SOFT", retryable: true, customerAction: "NONE" },
  PROCESSING_ERROR: { category: "SOFT", retryable: true, customerAction: "NONE" },
  UNEXPECTED_ERROR: { category: "SOFT", retryable: true, customerAction: "NONE" },
  TRANSIENT_ERROR: { category: "SOFT", retryable: true, customerAction: "NONE" },
  PAYPAL_ERROR_GENERAL: { category: "SOFT", retryable: true, customerAction: "NONE" },
  INSUFFICIENT_INVENTORY: { category: "SOFT", retryable: true, customerAction: "NONE" },
  INVENTORY_ALLOCATIONS_NOT_FOUND: { category: "SOFT", retryable: true, customerAction: "NONE" },
  // Hard — customer must act
  EXPIRED_PAYMENT_METHOD: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  INVALID_PAYMENT_METHOD: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  PAYMENT_METHOD_NOT_FOUND: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  PAYMENT_METHOD_INCOMPATIBLE: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  CARD_NUMBER_INCORRECT: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  BUYER_CANCELED_PAYMENT_METHOD: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  INVALID_CUSTOMER_BILLING_AGREEMENT: { category: "HARD", retryable: false, customerAction: "UPDATE_CARD" },
  // Hard — merchant must act (never nag the customer)
  AMOUNT_TOO_SMALL: { category: "HARD", retryable: false, customerAction: "NONE" },
  FRAUD_SUSPECTED: { category: "HARD", retryable: false, customerAction: "NONE" },
  TEST_MODE: { category: "HARD", retryable: false, customerAction: "NONE" },
  PAYMENT_PROVIDER_IS_NOT_ENABLED: { category: "HARD", retryable: false, customerAction: "NONE" },
  INVALID_SHIPPING_ADDRESS: { category: "HARD", retryable: false, customerAction: "NONE" },
  CUSTOMER_INVALID: { category: "HARD", retryable: false, customerAction: "NONE" },
  CUSTOMER_NOT_FOUND: { category: "HARD", retryable: false, customerAction: "NONE" },
  // 3-D Secure
  AUTHENTICATION_ERROR: { category: "AUTH_REQUIRED", retryable: false, customerAction: "AUTHENTICATE" },
};

describe("documented decline codes", () => {
  it("the taxonomy contains exactly the expected codes", () => {
    const actual = Object.keys(DECLINE_CODES).sort();
    const expected = Object.keys(EXPECTED).sort();
    const missing = expected.filter((c) => !actual.includes(c));
    const undocumented = actual.filter((c) => !expected.includes(c));
    expect(missing, `codes missing from DECLINE_CODES: ${missing.join(", ")}`).toEqual([]);
    expect(
      undocumented,
      `codes present but not covered by this test: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  for (const [code, exp] of Object.entries(EXPECTED)) {
    it(`${code} → ${exp.category} / ${exp.customerAction} / retryable=${exp.retryable}`, () => {
      const info = categorizeDeclineCode(code);
      expect(info.category).toBe(exp.category);
      expect(info.retryable).toBe(exp.retryable);
      expect(info.customerAction).toBe(exp.customerAction);
      expect(info.description.length).toBeGreaterThan(0);
    });
  }

  it("classification is case-insensitive and whitespace-tolerant", () => {
    expect(categorizeDeclineCode("insufficient_funds").category).toBe("SOFT");
    expect(categorizeDeclineCode("  Expired_Payment_Method  ").category).toBe("HARD");
    expect(categorizeDeclineCode("authentication_error").customerAction).toBe("AUTHENTICATE");
  });

  it("structural invariants hold for every entry", () => {
    for (const row of DECLINE_CODE_TABLE) {
      // Only soft declines are retryable — retryable is derived, never mixed.
      expect(row.retryable, `${row.code} retryable`).toBe(row.category === "SOFT");
      // Soft declines never demand a customer action.
      if (row.category === "SOFT") {
        expect(row.customerAction, `${row.code} customerAction`).toBe("NONE");
      }
      // 3DS always demands authentication.
      if (row.category === "AUTH_REQUIRED") {
        expect(row.customerAction, `${row.code} customerAction`).toBe("AUTHENTICATE");
      }
      expect(row.description.length, `${row.code} description`).toBeGreaterThan(0);
    }
  });

  it("DECLINE_CODE_TABLE is a faithful flattening of DECLINE_CODES", () => {
    expect(DECLINE_CODE_TABLE.length).toBe(Object.keys(DECLINE_CODES).length);
    for (const row of DECLINE_CODE_TABLE) {
      expect(DECLINE_CODES[row.code]).toEqual({
        category: row.category,
        retryable: row.retryable,
        customerAction: row.customerAction,
        description: row.description,
      });
    }
  });
});

describe("unknown codes", () => {
  it("an unrecognized code defaults to SOFT / retryable", () => {
    const info = categorizeDeclineCode("SOME_BRAND_NEW_CODE");
    expect(info).toEqual(UNKNOWN_DECLINE);
    expect(info.category).toBe("SOFT");
    expect(info.retryable).toBe(true);
    expect(info.customerAction).toBe("NONE");
  });

  it("null / undefined / empty / whitespace codes default to SOFT retryable", () => {
    expect(categorizeDeclineCode(null)).toEqual(UNKNOWN_DECLINE);
    expect(categorizeDeclineCode(undefined)).toEqual(UNKNOWN_DECLINE);
    expect(categorizeDeclineCode("")).toEqual(UNKNOWN_DECLINE);
    expect(categorizeDeclineCode("   ")).toEqual(UNKNOWN_DECLINE);
  });
});

describe("FRAUD_SUSPECTED", () => {
  it("is never retryable and never asks the customer to act", () => {
    const info = categorizeDeclineCode("FRAUD_SUSPECTED");
    expect(info.retryable).toBe(false);
    expect(info.category).toBe("HARD");
    // Manual merchant review — the engine must not email the customer either.
    expect(info.customerAction).toBe("NONE");
  });
});
