import {
  type AdminClient,
  type UserError,
  dateOrNull,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Customer payment methods: listing (with card expiry for pre-expiry dunning
 * notices), Shopify-hosted card-update URL (for magic links), and the
 * Shopify-hosted update email fallback.
 */

// ── Instrument normalization (shared with contracts.server.ts) ───────────────

export interface RawPaymentInstrument {
  __typename?: string | null;
  brand?: string | null;
  lastDigits?: string | null;
  expiryMonth?: number | null;
  expiryYear?: number | null;
  expiresSoon?: boolean | null;
  paypalAccountEmail?: string | null;
}

export interface PaymentInstrument {
  type: "CREDIT_CARD" | "SHOP_PAY" | "PAYPAL" | "UNKNOWN";
  brand: string | null;
  lastDigits: string | null;
  expiryMonth: number | null;
  expiryYear: number | null;
  expiresSoon: boolean | null;
}

export function normalizePaymentInstrument(
  raw: RawPaymentInstrument | null | undefined,
): PaymentInstrument | null {
  if (!raw) return null;
  switch (raw.__typename) {
    case "CustomerCreditCard":
      return {
        type: "CREDIT_CARD",
        brand: raw.brand ?? null,
        lastDigits: raw.lastDigits ?? null,
        expiryMonth: raw.expiryMonth ?? null,
        expiryYear: raw.expiryYear ?? null,
        expiresSoon: raw.expiresSoon ?? null,
      };
    case "CustomerShopPayAgreement":
      return {
        type: "SHOP_PAY",
        brand: "Shop Pay",
        lastDigits: raw.lastDigits ?? null,
        expiryMonth: raw.expiryMonth ?? null,
        expiryYear: raw.expiryYear ?? null,
        expiresSoon: raw.expiresSoon ?? null,
      };
    case "CustomerPaypalBillingAgreement":
      return {
        type: "PAYPAL",
        brand: "PayPal",
        lastDigits: null,
        expiryMonth: null,
        expiryYear: null,
        expiresSoon: null,
      };
    default:
      return {
        type: "UNKNOWN",
        brand: raw.brand ?? null,
        lastDigits: raw.lastDigits ?? null,
        expiryMonth: raw.expiryMonth ?? null,
        expiryYear: raw.expiryYear ?? null,
        expiresSoon: raw.expiresSoon ?? null,
      };
  }
}

/** Inline selection set for CustomerPaymentMethodInstrument unions. */
const INSTRUMENT_SELECTION = `
        instrument {
          __typename
          ... on CustomerCreditCard {
            brand
            lastDigits
            expiryMonth
            expiryYear
            expiresSoon
          }
          ... on CustomerShopPayAgreement {
            lastDigits
            expiryMonth
            expiryYear
            expiresSoon
          }
          ... on CustomerPaypalBillingAgreement {
            paypalAccountEmail
          }
        }`;

// ── GraphQL documents ────────────────────────────────────────────────────────

const PAYMENT_METHODS_QUERY = `#graphql
  query CellexiaCustomerPaymentMethods($customerId: ID!) {
    customer(id: $customerId) {
      id
      paymentMethods(first: 25, showRevoked: true) {
        nodes {
          id
          revokedAt
          revokedReason
${INSTRUMENT_SELECTION}
        }
      }
    }
  }
`;

const GET_UPDATE_URL_MUTATION = `#graphql
  mutation CellexiaPaymentMethodGetUpdateUrl($customerPaymentMethodId: ID!) {
    customerPaymentMethodGetUpdateUrl(customerPaymentMethodId: $customerPaymentMethodId) {
      updatePaymentMethodUrl
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const SEND_UPDATE_EMAIL_MUTATION = `#graphql
  mutation CellexiaPaymentMethodSendUpdateEmail($customerPaymentMethodId: ID!) {
    customerPaymentMethodSendUpdateEmail(customerPaymentMethodId: $customerPaymentMethodId) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawPaymentMethodNode {
  id: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
  instrument?: RawPaymentInstrument | null;
}

interface PaymentMethodsResponse {
  customer?: {
    id: string;
    paymentMethods?: { nodes?: RawPaymentMethodNode[] | null } | null;
  } | null;
}

interface GetUpdateUrlResponse {
  customerPaymentMethodGetUpdateUrl?: {
    updatePaymentMethodUrl?: string | null;
    userErrors?: UserError[];
  } | null;
}

interface SendUpdateEmailResponse {
  customerPaymentMethodSendUpdateEmail?: {
    customer?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CustomerPaymentMethodSummary {
  id: string;
  revoked: boolean;
  revokedAt: Date | null;
  revokedReason: string | null;
  instrument: PaymentInstrument | null;
}

/**
 * All payment methods on a customer, including revoked ones (dunning needs
 * to see a revoked card to explain *why* the charge cannot succeed).
 */
export async function listCustomerPaymentMethods(
  admin: AdminClient,
  customerGid: string,
): Promise<CustomerPaymentMethodSummary[]> {
  const data = await gql<PaymentMethodsResponse>(admin, PAYMENT_METHODS_QUERY, {
    customerId: customerGid,
  });
  const nodes = data.customer?.paymentMethods?.nodes ?? [];
  return nodes.map((node) => ({
    id: node.id,
    revoked: node.revokedAt != null,
    revokedAt: dateOrNull(node.revokedAt),
    revokedReason: node.revokedReason ?? null,
    instrument: normalizePaymentInstrument(node.instrument),
  }));
}

/**
 * Shopify-hosted secure card-update URL for this payment method. Per the
 * Admin API reference this mutation "currently only supports Shop Pay":
 * card instruments come back as userError code INVALID_INSTRUMENT, surfaced
 * on the thrown ShopifyUserError (`code` is selected below) so
 * `resolveCardUpdatePath` (app/lib/payments/cardUpdate.server.ts) can fall
 * back to `sendPaymentMethodUpdateEmail`. Callers should go through the
 * resolver rather than calling this directly.
 */
export async function getPaymentMethodUpdateUrl(
  admin: AdminClient,
  paymentMethodGid: string,
): Promise<string> {
  const data = await gql<GetUpdateUrlResponse>(admin, GET_UPDATE_URL_MUTATION, {
    customerPaymentMethodId: paymentMethodGid,
  });
  ensureNoUserErrors(
    "customerPaymentMethodGetUpdateUrl",
    data.customerPaymentMethodGetUpdateUrl,
  );
  const url = data.customerPaymentMethodGetUpdateUrl?.updatePaymentMethodUrl;
  if (!url) {
    throw new Error(
      "customerPaymentMethodGetUpdateUrl returned no updatePaymentMethodUrl",
    );
  }
  return url;
}

/**
 * Ask Shopify to email the customer its own card-update link. Fallback for
 * when the app's own notification channels are unavailable.
 */
export async function sendPaymentMethodUpdateEmail(
  admin: AdminClient,
  paymentMethodGid: string,
): Promise<void> {
  const data = await gql<SendUpdateEmailResponse>(
    admin,
    SEND_UPDATE_EMAIL_MUTATION,
    { customerPaymentMethodId: paymentMethodGid },
  );
  ensureNoUserErrors(
    "customerPaymentMethodSendUpdateEmail",
    data.customerPaymentMethodSendUpdateEmail,
  );
}
