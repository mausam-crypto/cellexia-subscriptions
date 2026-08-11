import { decimalStringFromCents } from "~/lib/money";
import {
  type AdminClient,
  type UserError,
  centsFromMoneyOrZero,
  dateOrNull,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Order reads and money-back operations (goodwill refunds from save flows /
 * admin, best-effort cancel for stockout policies), plus order editing
 * (orderEditBegin → staged changes → orderEditCommit) — used to attach the
 * plan-configured first-order gift to a subscription's origin (checkout)
 * order as a zero-priced line.
 *
 * Refunds go through suggestedRefund first so the created refund reuses the
 * original payment gateway/parent transactions — required for card refunds.
 */

// ── GraphQL documents ────────────────────────────────────────────────────────

const ORDER_SUMMARY_QUERY = `#graphql
  query CellexiaOrderSummary($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      processedAt
      displayFinancialStatus
      displayFulfillmentStatus
      currentTotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentSubtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentTotalDiscountsSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      currentTotalTaxSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalShippingPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        id
        email
      }
    }
  }
`;

const SUGGESTED_REFUND_QUERY = `#graphql
  query CellexiaSuggestedRefund($id: ID!) {
    order(id: $id) {
      id
      suggestedRefund(suggestFullRefund: true) {
        amountSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        suggestedTransactions {
          gateway
          amountSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          maximumRefundableSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          parentTransaction {
            id
          }
        }
      }
    }
  }
`;

const REFUND_CREATE_MUTATION = `#graphql
  mutation CellexiaRefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet {
          shopMoney {
            amount
            currencyCode
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_CANCEL_MUTATION = `#graphql
  mutation CellexiaOrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: $refund
      restock: $restock
      notifyCustomer: $notifyCustomer
      staffNote: $staffNote
    ) {
      job {
        id
        done
      }
      orderCancelUserErrors {
        field
        message
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawMoneyBag {
  shopMoney?: { amount?: string | null; currencyCode?: string | null } | null;
}

interface OrderSummaryResponse {
  order?: {
    id: string;
    name?: string | null;
    createdAt?: string | null;
    processedAt?: string | null;
    displayFinancialStatus?: string | null;
    displayFulfillmentStatus?: string | null;
    currentTotalPriceSet?: RawMoneyBag | null;
    currentSubtotalPriceSet?: RawMoneyBag | null;
    currentTotalDiscountsSet?: RawMoneyBag | null;
    currentTotalTaxSet?: RawMoneyBag | null;
    totalShippingPriceSet?: RawMoneyBag | null;
    totalRefundedSet?: RawMoneyBag | null;
    customer?: { id?: string | null; email?: string | null } | null;
  } | null;
}

interface SuggestedRefundResponse {
  order?: {
    id: string;
    suggestedRefund?: {
      amountSet?: RawMoneyBag | null;
      suggestedTransactions?: Array<{
        gateway?: string | null;
        amountSet?: RawMoneyBag | null;
        maximumRefundableSet?: RawMoneyBag | null;
        parentTransaction?: { id?: string | null } | null;
      }> | null;
    } | null;
  } | null;
}

interface RefundCreateResponse {
  refundCreate?: {
    refund?: {
      id: string;
      totalRefundedSet?: RawMoneyBag | null;
    } | null;
    userErrors?: UserError[];
  } | null;
}

interface OrderCancelResponse {
  orderCancel?: {
    job?: { id?: string | null; done?: boolean | null } | null;
    orderCancelUserErrors?: UserError[];
  } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface OrderSummary {
  id: string;
  name: string;
  createdAt: Date | null;
  /**
   * When the order was processed (payment taken) — the instant origin-order
   * revenue is booked on. Falls back to createdAt at the consumer when null.
   */
  processedAt: Date | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  /**
   * Null when Shopify omits the money set — callers must fall back to their
   * own context (the contract's currencyCode), never to a hardcoded currency:
   * inventing e.g. "GBP" on a CHF shop would slip the amount past every
   * "same currency only" analytics guard in the wrong book.
   */
  currencyCode: string | null;
  totalCents: number;
  subtotalCents: number;
  discountsCents: number;
  taxCents: number;
  shippingCents: number;
  refundedCents: number;
  customerId: string | null;
  customerEmail: string | null;
}

/**
 * The Admin API answered `order: null` for a well-formed query: the order was
 * deleted, GDPR-erased, or is older than the 60-day order-access horizon and
 * the app lacks the read_all_orders scope (not requested in shopify.app.toml —
 * it needs Shopify approval). A CONCLUSIVE "not fetchable right now", distinct
 * from transport/throttle errors, which `gql` throws as plain errors. The
 * origin_order_backfill keys its terminal marker off this type — matching a
 * message string would silently break on the next reword.
 */
export class OrderNotFoundError extends Error {
  constructor(orderGid: string) {
    super(`Order not found on Shopify: ${orderGid}`);
    this.name = "OrderNotFoundError";
  }
}

/** Normalized money summary for one order. Throws if the GID is unknown. */
export async function getOrderSummary(
  admin: AdminClient,
  orderGid: string,
): Promise<OrderSummary> {
  const data = await gql<OrderSummaryResponse>(admin, ORDER_SUMMARY_QUERY, {
    id: orderGid,
  });
  const order = data.order;
  if (!order) {
    throw new OrderNotFoundError(orderGid);
  }
  return {
    id: order.id,
    name: order.name ?? "",
    createdAt: dateOrNull(order.createdAt),
    processedAt: dateOrNull(order.processedAt),
    financialStatus: order.displayFinancialStatus ?? null,
    fulfillmentStatus: order.displayFulfillmentStatus ?? null,
    currencyCode: order.currentTotalPriceSet?.shopMoney?.currencyCode ?? null,
    totalCents: centsFromMoneyOrZero(order.currentTotalPriceSet?.shopMoney),
    subtotalCents: centsFromMoneyOrZero(order.currentSubtotalPriceSet?.shopMoney),
    discountsCents: centsFromMoneyOrZero(order.currentTotalDiscountsSet?.shopMoney),
    taxCents: centsFromMoneyOrZero(order.currentTotalTaxSet?.shopMoney),
    shippingCents: centsFromMoneyOrZero(order.totalShippingPriceSet?.shopMoney),
    refundedCents: centsFromMoneyOrZero(order.totalRefundedSet?.shopMoney),
    customerId: order.customer?.id ?? null,
    customerEmail: order.customer?.email ?? null,
  };
}

const REFUND_SHOP_MONEY_QUERY = `#graphql
  query CellexiaRefundShopMoney($id: ID!) {
    refund(id: $id) {
      id
      totalRefundedSet {
        shopMoney {
          amount
          currencyCode
        }
        presentmentMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

interface RefundShopMoneyResponse {
  refund: {
    id: string;
    totalRefundedSet: {
      shopMoney: { amount: string; currencyCode: string } | null;
      presentmentMoney: { amount: string; currencyCode: string } | null;
    } | null;
  } | null;
}

export interface RefundShopMoney {
  amountCents: number;
  currencyCode: string | null;
}

/**
 * One refund's total in SHOP currency (v1.16.0 — the Markets conversion
 * read). REST REFUNDS_CREATE payloads denominate their transactions in the
 * order's PAYMENT (presentment) currency; when that disagrees with the
 * mirrored shopMoney totals the webhook handler used to skip the refund
 * entirely (refund_skipped_currency_mismatch). This read fetches Shopify's
 * own shop-currency figure for the refund so the handler can net it
 * properly instead. Returns null when the refund cannot be read (deleted,
 * outside the access horizon, transport error is thrown by gql as usual) or
 * carries no shop money — callers fall back to the skip-and-log behavior.
 */
export async function getRefundShopMoney(
  admin: AdminClient,
  refundGid: string,
): Promise<RefundShopMoney | null> {
  const data = await gql<RefundShopMoneyResponse>(
    admin,
    REFUND_SHOP_MONEY_QUERY,
    { id: refundGid },
  );
  const shopMoney = data.refund?.totalRefundedSet?.shopMoney;
  if (!shopMoney) return null;
  const amountCents = centsFromMoneyOrZero(shopMoney);
  if (amountCents <= 0) return null;
  return { amountCents, currencyCode: shopMoney.currencyCode ?? null };
}

export interface RefundResult {
  refundId: string;
  refundedCents: number;
}

/**
 * Refund `amountCents` against an order's original payment transactions.
 *
 * Queries suggestedRefund to discover refundable parent transactions and
 * their gateways, allocates the requested amount across them (largest-first
 * capped at each transaction's maximum refundable), then issues refundCreate
 * with kind REFUND transactions. Throws when the order cannot absorb the
 * requested amount.
 */
export async function refundOrderAmount(
  admin: AdminClient,
  orderGid: string,
  amountCents: number,
  currencyCode: string,
  reason?: string,
): Promise<RefundResult> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`refundOrderAmount: invalid amountCents ${amountCents}`);
  }

  const data = await gql<SuggestedRefundResponse>(
    admin,
    SUGGESTED_REFUND_QUERY,
    { id: orderGid },
  );
  const order = data.order;
  if (!order) {
    throw new Error(`Order not found on Shopify: ${orderGid}`);
  }

  const suggested = (order.suggestedRefund?.suggestedTransactions ?? [])
    .map((t) => ({
      gateway: t.gateway ?? null,
      parentId: t.parentTransaction?.id ?? null,
      refundableCents:
        centsFromMoneyOrZero(t.maximumRefundableSet?.shopMoney) ||
        centsFromMoneyOrZero(t.amountSet?.shopMoney),
    }))
    .filter((t) => t.parentId != null && t.refundableCents > 0)
    .sort((a, b) => b.refundableCents - a.refundableCents);

  if (suggested.length === 0) {
    throw new Error(
      `refundOrderAmount: no refundable transactions on ${orderGid}`,
    );
  }

  const transactions: Array<Record<string, unknown>> = [];
  let remaining = amountCents;
  for (const txn of suggested) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, txn.refundableCents);
    transactions.push({
      orderId: orderGid,
      parentId: txn.parentId,
      gateway: txn.gateway ?? "",
      kind: "REFUND",
      amount: decimalStringFromCents(take),
    });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error(
      `refundOrderAmount: order ${orderGid} can only refund ` +
        `${decimalStringFromCents(amountCents - remaining)} ${currencyCode} ` +
        `of the requested ${decimalStringFromCents(amountCents)} ${currencyCode}`,
    );
  }

  const result = await gql<RefundCreateResponse>(admin, REFUND_CREATE_MUTATION, {
    input: {
      orderId: orderGid,
      note: reason ?? "Cellexia subscription refund",
      notify: false,
      transactions,
    },
  });
  ensureNoUserErrors("refundCreate", result.refundCreate);
  const refund = result.refundCreate?.refund;
  if (!refund?.id) {
    throw new Error("refundCreate returned no refund");
  }
  return {
    refundId: refund.id,
    refundedCents:
      centsFromMoneyOrZero(refund.totalRefundedSet?.shopMoney) || amountCents,
  };
}

export interface CancelOrderResult {
  ok: boolean;
  jobId: string | null;
  error: string | null;
}

/**
 * Best-effort order cancel (no refund here — pair with refundOrderAmount when
 * money must move). Never throws: cancellation is an optimisation, not a
 * correctness requirement, so failures are reported, not raised.
 */
export async function cancelOrder(
  admin: AdminClient,
  orderGid: string,
  options: { staffNote?: string; notifyCustomer?: boolean; restock?: boolean } = {},
): Promise<CancelOrderResult> {
  try {
    const data = await gql<OrderCancelResponse>(admin, ORDER_CANCEL_MUTATION, {
      orderId: orderGid,
      reason: "OTHER",
      refund: false,
      restock: options.restock ?? true,
      notifyCustomer: options.notifyCustomer ?? false,
      staffNote: options.staffNote ?? null,
    });
    const payload = data.orderCancel;
    const errors = payload?.orderCancelUserErrors ?? [];
    if (errors.length > 0) {
      return {
        ok: false,
        jobId: null,
        error: errors.map((e) => e.message).join("; "),
      };
    }
    return { ok: true, jobId: payload?.job?.id ?? null, error: null };
  } catch (err) {
    return {
      ok: false,
      jobId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Order editing ────────────────────────────────────────────────────────────
//
// Staged-change model: orderEditBegin opens a CalculatedOrder session, the
// add/quantity/discount mutations stage changes against it, and nothing
// touches the real order until orderEditCommit. An uncommitted session is
// simply abandoned — Shopify discards it — so a mid-flight failure never
// half-edits an order.

const ORDER_EDIT_BEGIN_MUTATION = `#graphql
  mutation CellexiaOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_ADD_VARIANT_MUTATION = `#graphql
  mutation CellexiaOrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
    orderEditAddVariant(
      id: $id
      variantId: $variantId
      quantity: $quantity
      allowDuplicates: true
    ) {
      calculatedLineItem {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_SET_QUANTITY_MUTATION = `#graphql
  mutation CellexiaOrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
    orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
      calculatedLineItem {
        id
        quantity
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_ADD_LINE_ITEM_DISCOUNT_MUTATION = `#graphql
  mutation CellexiaOrderEditAddLineItemDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
    orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
      calculatedLineItem {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ORDER_EDIT_COMMIT_MUTATION = `#graphql
  mutation CellexiaOrderEditCommit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface OrderEditBeginResponse {
  orderEditBegin?: {
    calculatedOrder?: { id?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface OrderEditAddVariantResponse {
  orderEditAddVariant?: {
    calculatedLineItem?: { id?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface OrderEditSetQuantityResponse {
  orderEditSetQuantity?: {
    calculatedLineItem?: { id?: string | null; quantity?: number | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface OrderEditAddLineItemDiscountResponse {
  orderEditAddLineItemDiscount?: {
    calculatedLineItem?: { id?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface OrderEditCommitResponse {
  orderEditCommit?: {
    order?: { id?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

/** Open an edit session on an order. Returns the CalculatedOrder GID. */
export async function orderEditBegin(
  admin: AdminClient,
  orderGid: string,
): Promise<string> {
  const data = await gql<OrderEditBeginResponse>(
    admin,
    ORDER_EDIT_BEGIN_MUTATION,
    { id: orderGid },
  );
  ensureNoUserErrors("orderEditBegin", data.orderEditBegin);
  const calculatedOrderId = data.orderEditBegin?.calculatedOrder?.id;
  if (!calculatedOrderId) {
    throw new Error(`orderEditBegin returned no calculated order for ${orderGid}`);
  }
  return calculatedOrderId;
}

/**
 * Stage adding a variant (allowDuplicates, so a gift can coexist with a paid
 * line of the same variant). Returns the CalculatedLineItem GID of the added
 * line — the handle the discount/quantity mutations need.
 */
export async function orderEditAddVariant(
  admin: AdminClient,
  calculatedOrderGid: string,
  variantGid: string,
  quantity: number,
): Promise<string> {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`orderEditAddVariant: invalid quantity ${quantity}`);
  }
  const data = await gql<OrderEditAddVariantResponse>(
    admin,
    ORDER_EDIT_ADD_VARIANT_MUTATION,
    { id: calculatedOrderGid, variantId: variantGid, quantity },
  );
  ensureNoUserErrors("orderEditAddVariant", data.orderEditAddVariant);
  const lineItemId = data.orderEditAddVariant?.calculatedLineItem?.id;
  if (!lineItemId) {
    throw new Error(
      `orderEditAddVariant returned no calculated line item for ${variantGid}`,
    );
  }
  return lineItemId;
}

/** Stage a quantity change on a calculated line item. */
export async function orderEditSetQuantity(
  admin: AdminClient,
  calculatedOrderGid: string,
  calculatedLineItemGid: string,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error(`orderEditSetQuantity: invalid quantity ${quantity}`);
  }
  const data = await gql<OrderEditSetQuantityResponse>(
    admin,
    ORDER_EDIT_SET_QUANTITY_MUTATION,
    { id: calculatedOrderGid, lineItemId: calculatedLineItemGid, quantity },
  );
  ensureNoUserErrors("orderEditSetQuantity", data.orderEditSetQuantity);
}

/**
 * Stage a discount on a calculated line item. `percentValue` 100 makes the
 * line free — the mechanism behind zero-priced gift lines on order edits.
 */
export async function orderEditAddLineItemDiscount(
  admin: AdminClient,
  calculatedOrderGid: string,
  calculatedLineItemGid: string,
  discount: { percentValue: number; description?: string },
): Promise<void> {
  if (
    !Number.isFinite(discount.percentValue) ||
    discount.percentValue < 0 ||
    discount.percentValue > 100
  ) {
    throw new Error(
      `orderEditAddLineItemDiscount: invalid percentValue ${discount.percentValue}`,
    );
  }
  const data = await gql<OrderEditAddLineItemDiscountResponse>(
    admin,
    ORDER_EDIT_ADD_LINE_ITEM_DISCOUNT_MUTATION,
    {
      id: calculatedOrderGid,
      lineItemId: calculatedLineItemGid,
      discount: {
        percentValue: discount.percentValue,
        description: discount.description ?? null,
      },
    },
  );
  ensureNoUserErrors(
    "orderEditAddLineItemDiscount",
    data.orderEditAddLineItemDiscount,
  );
}

/** Commit the staged changes. Returns the (real) order GID. */
export async function orderEditCommit(
  admin: AdminClient,
  calculatedOrderGid: string,
  options: { notifyCustomer?: boolean; staffNote?: string } = {},
): Promise<string> {
  const data = await gql<OrderEditCommitResponse>(
    admin,
    ORDER_EDIT_COMMIT_MUTATION,
    {
      id: calculatedOrderGid,
      notifyCustomer: options.notifyCustomer ?? false,
      staffNote: options.staffNote ?? null,
    },
  );
  ensureNoUserErrors("orderEditCommit", data.orderEditCommit);
  const orderId = data.orderEditCommit?.order?.id;
  if (!orderId) {
    throw new Error("orderEditCommit returned no order");
  }
  return orderId;
}

export interface AddGiftToOrderResult {
  /** GID of the edited (real) order. */
  orderId: string;
  /** CalculatedLineItem GID the gift was staged as (audit reference). */
  calculatedLineItemId: string;
}

/**
 * Add `variantGid` to an existing order as a FREE line: one edit session that
 * stages the variant at `quantity` with a 100% line discount, then commits.
 * Throws on any userError; a failure before commit leaves the order untouched
 * (the uncommitted session is discarded by Shopify).
 */
export async function addFreeGiftToOrder(
  admin: AdminClient,
  orderGid: string,
  variantGid: string,
  options: {
    quantity?: number;
    discountDescription?: string;
    staffNote?: string;
    notifyCustomer?: boolean;
  } = {},
): Promise<AddGiftToOrderResult> {
  const quantity = options.quantity ?? 1;
  const calculatedOrderId = await orderEditBegin(admin, orderGid);
  const calculatedLineItemId = await orderEditAddVariant(
    admin,
    calculatedOrderId,
    variantGid,
    quantity,
  );
  await orderEditAddLineItemDiscount(admin, calculatedOrderId, calculatedLineItemId, {
    percentValue: 100,
    description: options.discountDescription ?? "Subscription gift",
  });
  const orderId = await orderEditCommit(admin, calculatedOrderId, {
    notifyCustomer: options.notifyCustomer ?? false,
    staffNote: options.staffNote,
  });
  return { orderId, calculatedLineItemId };
}
