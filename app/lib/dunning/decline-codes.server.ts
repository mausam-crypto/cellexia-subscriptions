/**
 * Decline-code taxonomy for Shopify subscription billing attempts.
 *
 * Every failed billing attempt carries a processing error code
 * (SubscriptionBillingAttemptErrorCode). The dunning engine's first decision —
 * retry automatically, ask the customer to fix their card, or ask them to
 * authenticate — hangs entirely on this classification, so it lives in one
 * table that is also exported for unit tests and the admin dunning UI.
 *
 * Categories:
 *  - SOFT           → transient bank-side decline; the retry ladder will very
 *                     often recover it without bothering the customer.
 *  - HARD           → retrying can never succeed; either the customer must act
 *                     (customerAction UPDATE_CARD) or the merchant must
 *                     (customerAction NONE — fraud review, test mode, config).
 *  - AUTH_REQUIRED  → the bank demands 3-D Secure; the customer must
 *                     authenticate via the challenge link before any charge
 *                     can complete.
 *
 * Unknown or missing codes are conservatively treated as SOFT/retryable — a
 * false "hard" would silently kill a recoverable subscription, while a false
 * "soft" merely costs a few harmless retries.
 */

export type DeclineCategory = "SOFT" | "HARD" | "AUTH_REQUIRED";

export type CustomerAction = "NONE" | "UPDATE_CARD" | "AUTHENTICATE";

export interface DeclineCodeInfo {
  category: DeclineCategory;
  /** May the automatic retry ladder attempt this charge again? */
  retryable: boolean;
  /** What (if anything) the customer must do before the charge can succeed. */
  customerAction: CustomerAction;
  /** Human-readable explanation — shown in admin and as `decline_human` in emails. */
  description: string;
}

/**
 * Classification table for Shopify billing-attempt processing error codes
 * (Admin GraphQL 2025-01). Keys are the upper-cased enum values as delivered
 * in the SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE webhook / attempt payload.
 */
export const DECLINE_CODES: Readonly<Record<string, DeclineCodeInfo>> = {
  // ── Soft declines: transient, the retry ladder handles them ────────────────
  INSUFFICIENT_FUNDS: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "The card was declined for insufficient funds. This is usually temporary — we retry automatically, aligned to likely paydays.",
  },
  PAYMENT_METHOD_DECLINED: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "The bank declined the charge without giving a specific reason. Often temporary — we retry automatically.",
  },
  PROCESSING_ERROR: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "A processing error occurred at the payment provider. Safe to retry automatically.",
  },
  UNEXPECTED_ERROR: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "An unexpected error occurred while processing the payment. Safe to retry automatically.",
  },

  // ── Hard declines: retrying cannot succeed ─────────────────────────────────
  AMOUNT_TOO_SMALL: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "The order total is below the payment provider's minimum chargeable amount. Retrying cannot succeed — the order contents must change.",
  },
  EXPIRED_PAYMENT_METHOD: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The card on file has expired. A new card or expiry date is needed before we can charge again.",
  },
  INVALID_PAYMENT_METHOD: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The payment method on file is invalid. A new payment method is needed before we can charge again.",
  },
  PAYMENT_METHOD_NOT_FOUND: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "No payment method is on file for this subscription. One must be added before we can charge again.",
  },
  PAYMENT_METHOD_INCOMPATIBLE: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The payment method on file cannot be used for subscriptions. A compatible card is needed before we can charge again.",
  },
  FRAUD_SUSPECTED: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "The payment provider flagged this charge as possibly fraudulent. Never retried automatically — requires manual review by the merchant.",
  },
  CARD_NUMBER_INCORRECT: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The stored card number is incorrect. The card must be re-entered before we can charge again.",
  },
  TEST_MODE: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "The charge hit a payment provider running in test mode — no real charge is possible. Check the store's payment settings.",
  },
  BUYER_CANCELED_PAYMENT_METHOD: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The customer revoked this payment method (for example a cancelled PayPal billing agreement). A new payment method is needed.",
  },

  // ── 3-D Secure ─────────────────────────────────────────────────────────────
  AUTHENTICATION_ERROR: {
    category: "AUTH_REQUIRED",
    retryable: false,
    customerAction: "AUTHENTICATE",
    description:
      "The customer's bank requires 3-D Secure authentication. The customer must confirm the payment via the secure link before it can complete.",
  },

  // ── Supplemental codes seen in the wild (defensive coverage) ───────────────
  TRANSIENT_ERROR: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "A temporary error occurred at the payment provider. Safe to retry automatically.",
  },
  PAYPAL_ERROR_GENERAL: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "PayPal returned a generic error for this charge. Often temporary — we retry automatically.",
  },
  INVALID_CUSTOMER_BILLING_AGREEMENT: {
    category: "HARD",
    retryable: false,
    customerAction: "UPDATE_CARD",
    description:
      "The customer's billing agreement is no longer valid. A new payment method is needed before we can charge again.",
  },
  PAYMENT_PROVIDER_IS_NOT_ENABLED: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "The payment provider is not enabled on the store. Retrying cannot succeed — check the store's payment settings.",
  },
  INSUFFICIENT_INVENTORY: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "One or more items were out of stock when the charge ran. Retried automatically; the stockout policy may also delay or substitute.",
  },
  INVENTORY_ALLOCATIONS_NOT_FOUND: {
    category: "SOFT",
    retryable: true,
    customerAction: "NONE",
    description:
      "Shopify could not allocate inventory for this charge. Usually transient — retried automatically.",
  },
  INVALID_SHIPPING_ADDRESS: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "The delivery address on the subscription is invalid. The address must be corrected before we can charge again.",
  },
  CUSTOMER_INVALID: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "Shopify reports the customer record as invalid for this charge. Requires manual review by the merchant.",
  },
  CUSTOMER_NOT_FOUND: {
    category: "HARD",
    retryable: false,
    customerAction: "NONE",
    description:
      "Shopify could not find the customer for this contract. Requires manual review by the merchant.",
  },
};

/** Conservative fallback for unknown/missing codes: soft, retryable. */
export const UNKNOWN_DECLINE: DeclineCodeInfo = {
  category: "SOFT",
  retryable: true,
  customerAction: "NONE",
  description:
    "Unrecognized decline code — treated as a temporary (soft) failure and retried on the standard ladder.",
};

/**
 * Ordered rows for the admin dunning UI and table-driven tests.
 * Same data as DECLINE_CODES, flattened with the code included.
 */
export const DECLINE_CODE_TABLE: ReadonlyArray<{ code: string } & DeclineCodeInfo> =
  Object.entries(DECLINE_CODES).map(([code, info]) => ({ code, ...info }));

/**
 * Classify a Shopify billing-attempt processing error code.
 * Case-insensitive; unknown, empty and missing codes fall back to
 * UNKNOWN_DECLINE (SOFT/retryable — never kill a recoverable subscription
 * on an unrecognized code).
 */
export function categorizeDeclineCode(
  code: string | null | undefined,
): DeclineCodeInfo {
  if (!code) return UNKNOWN_DECLINE;
  const normalized = code.trim().toUpperCase();
  if (!normalized) return UNKNOWN_DECLINE;
  return DECLINE_CODES[normalized] ?? UNKNOWN_DECLINE;
}

/**
 * The machine-readable `code` of the first userError that carries one, from
 * a refused mutation's userErrors array (attempt-create refusals reach the
 * billing scheduler and the dunning retry engine as ShopifyUserError).
 *
 * Shopify's BillingAttemptUserError exposes `code` alongside field/message;
 * the GraphQL layer adopts it in its selections additively, so this reads
 * the key structurally and returns null for payloads that don't carry it —
 * refusal ingest is live the moment the selection is extended, and a
 * refused row keeps its structured reason instead of collapsing into the
 * UNKNOWN/SOFT bucket that categorizeDeclineCode(null) yields.
 */
export function structuredUserErrorCode(
  errors: ReadonlyArray<object> | null | undefined,
): string | null {
  for (const err of errors ?? []) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.trim() !== "") {
      return code.trim().toUpperCase();
    }
  }
  return null;
}
