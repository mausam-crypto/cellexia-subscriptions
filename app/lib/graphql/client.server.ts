import { centsFromDecimalString } from "~/lib/money";

/**
 * Shared Admin GraphQL plumbing for the app/lib/graphql layer.
 *
 * Every module in this layer talks to Shopify through `gql()` and validates
 * mutation payloads with `ensureNoUserErrors()`. `AdminClient` is structural
 * on purpose so both `authenticate.admin(request).admin` (request context)
 * and `adminClientForShop(shopDomain)` (background jobs) satisfy it without
 * casts.
 */

export type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export interface UserError {
  field?: string[] | null;
  message: string;
  /**
   * Structured error code, present only when the mutation's userError type
   * exposes one AND the query selected it (e.g. BillingAttemptUserError's
   * `code` on subscriptionBillingAttemptCreate — consumed by
   * structuredUserErrorCode so attempt-create refusals keep Shopify's own
   * taxonomy instead of collapsing to UNKNOWN_DECLINE). Selecting `code` on
   * a userError type that lacks the field is a GraphQL error, so it is added
   * per-mutation, never blanket.
   */
  code?: string | null;
}

/** Thrown whenever a mutation payload carries non-empty `userErrors`. */
export class ShopifyUserError extends Error {
  errors: Array<{ field?: string[] | null; message: string; code?: string | null }>;

  constructor(payloadPath: string, errors: UserError[]) {
    const detail = errors
      .map((e) => {
        const field = (e.field ?? []).join(".");
        return field ? `${field}: ${e.message}` : e.message;
      })
      .join("; ");
    super(`Shopify userErrors at ${payloadPath}: ${detail}`);
    this.name = "ShopifyUserError";
    this.errors = errors;
  }
}

interface GraphqlResponseBody<T> {
  data?: T | null;
  errors?: Array<{ message?: string; path?: Array<string | number> }> | null;
}

/**
 * Execute a query/mutation and return `data`.
 *
 * Throws a plain Error on transport failures, top-level GraphQL errors
 * (malformed query, throttling, missing scope) or an empty data payload.
 * Does NOT inspect `userErrors` — mutation callers do that per payload via
 * `ensureNoUserErrors()`.
 */
export async function gql<T>(
  admin: AdminClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const response = await admin.graphql(
    query,
    variables ? { variables } : undefined,
  );
  const body = (await response.json()) as GraphqlResponseBody<T>;

  if (body.errors && body.errors.length > 0) {
    const messages = body.errors
      .map((e) => e.message ?? "unknown GraphQL error")
      .join("; ");
    throw new Error(`Shopify GraphQL error: ${messages}`);
  }
  if (body.data == null) {
    throw new Error("Shopify GraphQL error: response contained no data");
  }
  return body.data;
}

/**
 * Assert a mutation payload exists and carries no userErrors.
 * `payloadPath` names the mutation for error messages,
 * e.g. "subscriptionDraftCommit".
 */
export function ensureNoUserErrors(
  payloadPath: string,
  obj: { userErrors?: UserError[] | null } | null | undefined,
): void {
  if (!obj) {
    throw new Error(`Shopify GraphQL error: missing payload for ${payloadPath}`);
  }
  const errors = obj.userErrors ?? [];
  if (errors.length > 0) {
    throw new ShopifyUserError(payloadPath, errors);
  }
}

/** Money shape at the API boundary (MoneyV2 or bare decimal string). */
export interface ShopifyMoney {
  amount?: string | number | null;
  currencyCode?: string | null;
}

/** MoneyV2 / decimal string -> integer cents; null- and NaN-safe. */
export function centsFromMoney(
  money: ShopifyMoney | string | null | undefined,
): number | null {
  if (money == null) return null;
  const amount = typeof money === "string" ? money : money.amount;
  if (amount == null || amount === "") return null;
  const cents = centsFromDecimalString(amount);
  return Number.isNaN(cents) ? null : cents;
}

export function centsFromMoneyOrZero(
  money: ShopifyMoney | string | null | undefined,
): number {
  return centsFromMoney(money) ?? 0;
}

/** DateTime string -> Date; null-safe against absent or malformed values. */
export function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
