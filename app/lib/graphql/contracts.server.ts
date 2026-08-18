import { decimalStringFromCents } from "~/lib/money";
import {
  type AdminClient,
  type UserError,
  centsFromMoney,
  centsFromMoneyOrZero,
  dateOrNull,
  ensureNoUserErrors,
  gql,
} from "./client.server";
import {
  type PaymentInstrument,
  type RawPaymentInstrument,
  normalizePaymentInstrument,
} from "./paymentMethods.server";

/**
 * Subscription contract reads, drafts (contract edits) and status mutations.
 *
 * The draft helpers here are shared with billingCycles.server.ts — a billing
 * cycle contract edit produces a SubscriptionDraft too, and the same
 * subscriptionDraftUpdate / subscriptionDraftLine* / subscriptionDraftCommit
 * mutations apply to it.
 *
 * This layer does not touch the local DB and does not log events — the
 * contract services module wraps these calls, persists mirrors and calls
 * logEvent().
 */

// ── Normalized shapes ────────────────────────────────────────────────────────

export interface ShopifyDeliveryAddress {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  country: string | null;
  countryCode: string | null;
  zip: string | null;
  phone: string | null;
}

export interface ShopifyContractLine {
  id: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  /**
   * Selling plan this line was subscribed under, as a GID — the ownership
   * evidence the sync uses to tell our own contracts from another
   * subscription app's. Null on contracts created without a plan (imports).
   */
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  /** Decimal string as Shopify returns it, e.g. "42.00". */
  currentPrice: string;
  currentPriceCents: number;
  currencyCode: string | null;
  pricingPolicy: {
    basePriceCents: number;
    cycleDiscounts: Array<{
      afterCycle: number;
      adjustmentType: string;
      /** Set when the adjustment is a percentage. */
      percentage: number | null;
      /** Set when the adjustment is a fixed amount / price. */
      amountCents: number | null;
      computedPriceCents: number;
    }>;
  } | null;
  imageUrl: string | null;
}

export interface ShopifyContract {
  id: string;
  status: string;
  nextBillingDate: Date | null;
  /**
   * Null when Shopify omits it — callers must fall back to their own context
   * (the existing mirror row's currencyCode, then the shop's), never to a
   * hardcoded currency: inventing e.g. "GBP" on a CHF shop would slip the
   * amounts past every "same currency only" analytics guard in the wrong
   * book. Same contract as OrderSummary.currencyCode in orders.server.ts.
   */
  currencyCode: string | null;
  billingPolicy: {
    interval: string;
    intervalCount: number;
    minCycles: number | null;
    maxCycles: number | null;
  };
  deliveryPolicy: { interval: string; intervalCount: number } | null;
  deliveryPriceCents: number;
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    locale: string | null;
  } | null;
  customerPaymentMethod: {
    id: string;
    revokedAt: Date | null;
    instrument: PaymentInstrument | null;
  } | null;
  deliveryMethod: {
    type: "SHIPPING" | "LOCAL_DELIVERY" | "PICKUP" | "UNKNOWN";
    title: string | null;
    address: ShopifyDeliveryAddress | null;
  } | null;
  lines: ShopifyContractLine[];
  originOrder: { id: string; name: string } | null;
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const CONTRACT_QUERY = `#graphql
  query CellexiaSubscriptionContract($id: ID!) {
    subscriptionContract(id: $id) {
      id
      status
      nextBillingDate
      currencyCode
      billingPolicy {
        interval
        intervalCount
        minCycles
        maxCycles
      }
      deliveryPolicy {
        interval
        intervalCount
      }
      deliveryPrice {
        amount
        currencyCode
      }
      customer {
        id
        email
        firstName
        lastName
        phone
        locale
      }
      customerPaymentMethod(showRevoked: true) {
        id
        revokedAt
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
        }
      }
      deliveryMethod {
        __typename
        ... on SubscriptionDeliveryMethodShipping {
          address {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            zip
            phone
          }
          shippingOption {
            title
          }
        }
        ... on SubscriptionDeliveryMethodLocalDelivery {
          address {
            firstName
            lastName
            company
            address1
            address2
            city
            province
            provinceCode
            country
            countryCode
            zip
            phone
          }
        }
        ... on SubscriptionDeliveryMethodPickup {
          pickupOption {
            title
          }
        }
      }
      lines(first: 50) {
        nodes {
          id
          productId
          variantId
          title
          variantTitle
          sku
          quantity
          sellingPlanId
          sellingPlanName
          currentPrice {
            amount
            currencyCode
          }
          variantImage {
            url
          }
          pricingPolicy {
            basePrice {
              amount
              currencyCode
            }
            cycleDiscounts {
              afterCycle
              adjustmentType
              adjustmentValue {
                __typename
                ... on MoneyV2 {
                  amount
                  currencyCode
                }
                ... on SellingPlanPricingPolicyPercentageValue {
                  percentage
                }
              }
              computedPrice {
                amount
                currencyCode
              }
            }
          }
        }
      }
      originOrder {
        id
        name
      }
    }
  }
`;

const CONTRACT_GIDS_QUERY = `#graphql
  query CellexiaSubscriptionContractGids($first: Int!, $cursor: String) {
    subscriptionContracts(first: $first, after: $cursor) {
      edges {
        node {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// The three draft mutations (contractUpdate → draftUpdate → draftCommit) all
// return SubscriptionDraftUserError, which exposes `code`
// (SubscriptionDraftErrorCode: CUSTOMER_MISMATCH, MISSING_CUSTOMER_PAYMENT_METHOD,
// STALE_CONTRACT, HAS_FUTURE_EDITS, …). It is selected so the portal's
// paymentMethodErrorToast mapping (v1.28.0) matches on the structured code
// instead of message text.
const CONTRACT_UPDATE_MUTATION = `#graphql
  mutation CellexiaSubscriptionContractUpdate($contractId: ID!) {
    subscriptionContractUpdate(contractId: $contractId) {
      draft {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DRAFT_COMMIT_MUTATION = `#graphql
  mutation CellexiaSubscriptionDraftCommit($draftId: ID!) {
    subscriptionDraftCommit(draftId: $draftId) {
      contract {
        id
        status
        nextBillingDate
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DRAFT_UPDATE_MUTATION = `#graphql
  mutation CellexiaSubscriptionDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draftId, input: $input) {
      draft {
        id
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const DRAFT_LINE_ADD_MUTATION = `#graphql
  mutation CellexiaSubscriptionDraftLineAdd($draftId: ID!, $input: SubscriptionLineInput!) {
    subscriptionDraftLineAdd(draftId: $draftId, input: $input) {
      lineAdded {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_LINE_UPDATE_MUTATION = `#graphql
  mutation CellexiaSubscriptionDraftLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
    subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
      lineUpdated {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_LINE_REMOVE_MUTATION = `#graphql
  mutation CellexiaSubscriptionDraftLineRemove($draftId: ID!, $lineId: ID!) {
    subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) {
      lineRemoved {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_LINES_QUERY = `#graphql
  query CellexiaSubscriptionDraftLines($draftId: ID!) {
    subscriptionDraft(id: $draftId) {
      id
      lines(first: 100) {
        nodes {
          id
          variantId
          quantity
        }
      }
    }
  }
`;

const CONTRACT_NOTE_QUERY = `#graphql
  query CellexiaSubscriptionContractNote($id: ID!) {
    subscriptionContract(id: $id) {
      id
      note
      customAttributes {
        key
        value
      }
    }
  }
`;

const SET_NEXT_BILLING_DATE_MUTATION = `#graphql
  mutation CellexiaSetNextBillingDate($contractId: ID!, $date: DateTime!) {
    subscriptionContractSetNextBillingDate(contractId: $contractId, date: $date) {
      contract {
        id
        nextBillingDate
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const ATOMIC_CREATE_MUTATION = `#graphql
  mutation CellexiaSubscriptionContractAtomicCreate($input: SubscriptionContractAtomicCreateInput!) {
    subscriptionContractAtomicCreate(input: $input) {
      contract {
        id
        status
        nextBillingDate
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function statusMutationDocument(mutationName: string): string {
  return `#graphql
  mutation Cellexia${mutationName[0]!.toUpperCase()}${mutationName.slice(1)}($subscriptionContractId: ID!) {
    ${mutationName}(subscriptionContractId: $subscriptionContractId) {
      contract {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;
}

// ── Raw response shapes ──────────────────────────────────────────────────────

interface RawMoney {
  amount?: string | null;
  currencyCode?: string | null;
}

interface RawAddress {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  countryCode?: string | null;
  zip?: string | null;
  phone?: string | null;
}

interface RawCycleDiscount {
  afterCycle?: number | null;
  adjustmentType?: string | null;
  adjustmentValue?: {
    __typename?: string | null;
    amount?: string | null;
    currencyCode?: string | null;
    percentage?: number | null;
  } | null;
  computedPrice?: RawMoney | null;
}

interface RawLine {
  id: string;
  productId?: string | null;
  variantId?: string | null;
  title?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
  quantity?: number | null;
  sellingPlanId?: string | null;
  sellingPlanName?: string | null;
  currentPrice?: RawMoney | null;
  variantImage?: { url?: string | null } | null;
  pricingPolicy?: {
    basePrice?: RawMoney | null;
    cycleDiscounts?: RawCycleDiscount[] | null;
  } | null;
}

interface RawContract {
  id: string;
  status?: string | null;
  nextBillingDate?: string | null;
  currencyCode?: string | null;
  billingPolicy?: {
    interval?: string | null;
    intervalCount?: number | null;
    minCycles?: number | null;
    maxCycles?: number | null;
  } | null;
  deliveryPolicy?: {
    interval?: string | null;
    intervalCount?: number | null;
  } | null;
  deliveryPrice?: RawMoney | null;
  customer?: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    phone?: string | null;
    locale?: string | null;
  } | null;
  customerPaymentMethod?: {
    id: string;
    revokedAt?: string | null;
    instrument?: RawPaymentInstrument | null;
  } | null;
  deliveryMethod?: {
    __typename?: string | null;
    address?: RawAddress | null;
    shippingOption?: { title?: string | null } | null;
    pickupOption?: { title?: string | null } | null;
  } | null;
  lines?: { nodes?: RawLine[] | null } | null;
  originOrder?: { id: string; name?: string | null } | null;
}

interface ContractQueryResponse {
  subscriptionContract?: RawContract | null;
}

interface ContractGidsResponse {
  subscriptionContracts?: {
    edges?: Array<{ node?: { id: string } | null }> | null;
    pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
  } | null;
}

interface DraftPayload {
  draft?: { id: string } | null;
  userErrors?: UserError[];
}

interface ContractUpdateResponse {
  subscriptionContractUpdate?: DraftPayload | null;
}

interface DraftCommitResponse {
  subscriptionDraftCommit?: {
    contract?: { id: string; status?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface DraftUpdateResponse {
  subscriptionDraftUpdate?: DraftPayload | null;
}

interface DraftLineAddResponse {
  subscriptionDraftLineAdd?: {
    lineAdded?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

interface DraftLineUpdateResponse {
  subscriptionDraftLineUpdate?: {
    lineUpdated?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

interface DraftLineRemoveResponse {
  subscriptionDraftLineRemove?: {
    lineRemoved?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

interface ContractNoteResponse {
  subscriptionContract?: {
    id: string;
    note?: string | null;
    customAttributes?: Array<{ key: string; value?: string | null }> | null;
  } | null;
}

interface DraftLinesResponse {
  subscriptionDraft?: {
    id: string;
    lines?: {
      nodes?: Array<{
        id: string;
        variantId?: string | null;
        quantity?: number | null;
      }>;
    } | null;
  } | null;
}

interface StatusMutationPayload {
  contract?: { id: string; status?: string | null } | null;
  userErrors?: UserError[];
}

interface SetNextBillingDateResponse {
  subscriptionContractSetNextBillingDate?: {
    contract?: { id: string; nextBillingDate?: string | null } | null;
    userErrors?: UserError[];
  } | null;
}

interface AtomicCreateResponse {
  subscriptionContractAtomicCreate?: {
    contract?: {
      id: string;
      status?: string | null;
      nextBillingDate?: string | null;
    } | null;
    userErrors?: UserError[];
  } | null;
}

// ── Normalization ────────────────────────────────────────────────────────────

function normalizeAddress(raw: RawAddress | null | undefined): ShopifyDeliveryAddress | null {
  if (!raw) return null;
  return {
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    company: raw.company ?? null,
    address1: raw.address1 ?? null,
    address2: raw.address2 ?? null,
    city: raw.city ?? null,
    province: raw.province ?? null,
    provinceCode: raw.provinceCode ?? null,
    country: raw.country ?? null,
    countryCode: raw.countryCode ?? null,
    zip: raw.zip ?? null,
    phone: raw.phone ?? null,
  };
}

function normalizeDeliveryMethod(
  raw: RawContract["deliveryMethod"],
): ShopifyContract["deliveryMethod"] {
  if (!raw) return null;
  const type =
    raw.__typename === "SubscriptionDeliveryMethodShipping"
      ? "SHIPPING"
      : raw.__typename === "SubscriptionDeliveryMethodLocalDelivery"
        ? "LOCAL_DELIVERY"
        : raw.__typename === "SubscriptionDeliveryMethodPickup"
          ? "PICKUP"
          : "UNKNOWN";
  return {
    type,
    title: raw.shippingOption?.title ?? raw.pickupOption?.title ?? null,
    address: normalizeAddress(raw.address),
  };
}

function normalizeLine(raw: RawLine): ShopifyContractLine {
  const pricingPolicy = raw.pricingPolicy
    ? {
        basePriceCents: centsFromMoneyOrZero(raw.pricingPolicy.basePrice),
        cycleDiscounts: (raw.pricingPolicy.cycleDiscounts ?? []).map((d) => ({
          afterCycle: d.afterCycle ?? 0,
          adjustmentType: d.adjustmentType ?? "PERCENTAGE",
          percentage:
            d.adjustmentValue?.percentage != null
              ? d.adjustmentValue.percentage
              : null,
          amountCents:
            d.adjustmentValue?.amount != null
              ? centsFromMoney(d.adjustmentValue.amount)
              : null,
          computedPriceCents: centsFromMoneyOrZero(d.computedPrice),
        })),
      }
    : null;

  return {
    id: raw.id,
    productId: raw.productId ?? null,
    variantId: raw.variantId ?? null,
    title: raw.title ?? "",
    variantTitle: raw.variantTitle ?? null,
    sku: raw.sku ?? null,
    quantity: raw.quantity ?? 1,
    sellingPlanId: raw.sellingPlanId ?? null,
    sellingPlanName: raw.sellingPlanName ?? null,
    currentPrice:
      typeof raw.currentPrice?.amount === "string"
        ? raw.currentPrice.amount
        : decimalStringFromCents(centsFromMoneyOrZero(raw.currentPrice)),
    currentPriceCents: centsFromMoneyOrZero(raw.currentPrice),
    currencyCode: raw.currentPrice?.currencyCode ?? null,
    pricingPolicy,
    imageUrl: raw.variantImage?.url ?? null,
  };
}

function normalizeContract(raw: RawContract): ShopifyContract {
  return {
    id: raw.id,
    status: raw.status ?? "ACTIVE",
    nextBillingDate: dateOrNull(raw.nextBillingDate),
    currencyCode: raw.currencyCode ?? null,
    billingPolicy: {
      interval: raw.billingPolicy?.interval ?? "WEEK",
      intervalCount: raw.billingPolicy?.intervalCount ?? 1,
      minCycles: raw.billingPolicy?.minCycles ?? null,
      maxCycles: raw.billingPolicy?.maxCycles ?? null,
    },
    deliveryPolicy: raw.deliveryPolicy
      ? {
          interval: raw.deliveryPolicy.interval ?? "WEEK",
          intervalCount: raw.deliveryPolicy.intervalCount ?? 1,
        }
      : null,
    deliveryPriceCents: centsFromMoneyOrZero(raw.deliveryPrice),
    customer: raw.customer
      ? {
          id: raw.customer.id,
          email: raw.customer.email ?? null,
          firstName: raw.customer.firstName ?? null,
          lastName: raw.customer.lastName ?? null,
          phone: raw.customer.phone ?? null,
          locale: raw.customer.locale ?? null,
        }
      : null,
    customerPaymentMethod: raw.customerPaymentMethod
      ? {
          id: raw.customerPaymentMethod.id,
          revokedAt: dateOrNull(raw.customerPaymentMethod.revokedAt),
          instrument: normalizePaymentInstrument(
            raw.customerPaymentMethod.instrument,
          ),
        }
      : null,
    deliveryMethod: normalizeDeliveryMethod(raw.deliveryMethod),
    lines: (raw.lines?.nodes ?? []).map(normalizeLine),
    originOrder: raw.originOrder
      ? { id: raw.originOrder.id, name: raw.originOrder.name ?? "" }
      : null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Fetch and normalize one contract. Throws if the GID does not resolve. */
export async function getContract(
  admin: AdminClient,
  contractGid: string,
): Promise<ShopifyContract> {
  const data = await gql<ContractQueryResponse>(admin, CONTRACT_QUERY, {
    id: contractGid,
  });
  const raw = data.subscriptionContract;
  if (!raw) {
    throw new Error(`Subscription contract not found on Shopify: ${contractGid}`);
  }
  return normalizeContract(raw);
}

export interface ContractGidsPage {
  gids: string[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Paginated contract GID listing for backfills / full sync jobs. */
export async function listContractGids(
  admin: AdminClient,
  options: { cursor?: string | null; first?: number } = {},
): Promise<ContractGidsPage> {
  const data = await gql<ContractGidsResponse>(admin, CONTRACT_GIDS_QUERY, {
    first: options.first ?? 100,
    cursor: options.cursor ?? null,
  });
  const connection = data.subscriptionContracts;
  return {
    gids: (connection?.edges ?? [])
      .map((e) => e?.node?.id)
      .filter((id): id is string => Boolean(id)),
    hasNextPage: connection?.pageInfo?.hasNextPage ?? false,
    endCursor: connection?.pageInfo?.endCursor ?? null,
  };
}

// ── Drafts (contract edits) ──────────────────────────────────────────────────

/** Executes one GraphQL document against the current draft's admin client. */
export type DraftRunner = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/**
 * Commit a subscription draft (works for both contract-update drafts and
 * billing-cycle contract-edit drafts). `fallbackContractId` is returned when
 * Shopify omits the contract in the payload (billing-cycle edits).
 */
export async function commitSubscriptionDraft(
  admin: AdminClient,
  draftId: string,
  fallbackContractId?: string,
): Promise<{ contractId: string }> {
  const data = await gql<DraftCommitResponse>(admin, DRAFT_COMMIT_MUTATION, {
    draftId,
  });
  ensureNoUserErrors("subscriptionDraftCommit", data.subscriptionDraftCommit);
  const contractId =
    data.subscriptionDraftCommit?.contract?.id ?? fallbackContractId;
  if (!contractId) {
    throw new Error("subscriptionDraftCommit returned no contract id");
  }
  return { contractId };
}

/**
 * Open a contract-edit draft, run `ops` against it, then commit.
 * The whole edit is applied atomically at commit — nothing changes on the
 * contract until subscriptionDraftCommit succeeds.
 */
export async function withContractDraft(
  admin: AdminClient,
  contractGid: string,
  ops: (draftId: string, run: DraftRunner) => Promise<void>,
): Promise<{ contractId: string }> {
  const data = await gql<ContractUpdateResponse>(
    admin,
    CONTRACT_UPDATE_MUTATION,
    { contractId: contractGid },
  );
  ensureNoUserErrors(
    "subscriptionContractUpdate",
    data.subscriptionContractUpdate,
  );
  const draftId = data.subscriptionContractUpdate?.draft?.id;
  if (!draftId) {
    throw new Error("subscriptionContractUpdate returned no draft");
  }

  const run: DraftRunner = (query, variables) => gql(admin, query, variables);
  await ops(draftId, run);

  return commitSubscriptionDraft(admin, draftId, contractGid);
}

async function runDraftUpdate(
  run: DraftRunner,
  draftId: string,
  input: Record<string, unknown>,
): Promise<void> {
  const data = await run<DraftUpdateResponse>(DRAFT_UPDATE_MUTATION, {
    draftId,
    input,
  });
  ensureNoUserErrors("subscriptionDraftUpdate", data.subscriptionDraftUpdate);
}

export async function draftSetNextBillingDate(
  run: DraftRunner,
  draftId: string,
  date: Date,
): Promise<void> {
  await runDraftUpdate(run, draftId, { nextBillingDate: date.toISOString() });
}

export interface RecurringPolicyInput {
  interval?: "DAY" | "WEEK" | "MONTH" | "YEAR";
  intervalCount: number;
}

export async function draftUpdateBillingPolicy(
  run: DraftRunner,
  draftId: string,
  policy: RecurringPolicyInput,
): Promise<void> {
  await runDraftUpdate(run, draftId, {
    billingPolicy: {
      interval: policy.interval ?? "WEEK",
      intervalCount: policy.intervalCount,
    },
  });
}

export async function draftUpdateDeliveryPolicy(
  run: DraftRunner,
  draftId: string,
  policy: RecurringPolicyInput,
): Promise<void> {
  await runDraftUpdate(run, draftId, {
    deliveryPolicy: {
      interval: policy.interval ?? "WEEK",
      intervalCount: policy.intervalCount,
    },
  });
}

/** MailingAddressInput shape for shipping delivery methods. */
export interface DeliveryAddressInput {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  /** ISO 3166-1 alpha-2, e.g. "GB". */
  countryCode?: string | null;
  zip?: string | null;
  phone?: string | null;
}

export async function draftUpdateAddress(
  run: DraftRunner,
  draftId: string,
  address: DeliveryAddressInput,
): Promise<void> {
  await runDraftUpdate(run, draftId, {
    deliveryMethod: { shipping: { address } },
  });
}

export async function draftUpdatePaymentMethod(
  run: DraftRunner,
  draftId: string,
  paymentMethodGid: string,
): Promise<void> {
  await runDraftUpdate(run, draftId, { paymentMethodId: paymentMethodGid });
}

/**
 * Contract note + custom attributes (v1.28.0, P2.8 delivery instructions).
 * `SubscriptionDraftInput.note` is "the note field that will be applied to
 * the generated orders" and `customAttributes` (AttributeInput[]) are stored
 * on the contract itself — both verified present on the pinned Admin API
 * version (2025-01). `note: null` / `[]` clear them.
 */
export async function draftUpdateNote(
  run: DraftRunner,
  draftId: string,
  note: string | null,
  customAttributes?: Array<{ key: string; value: string }>,
): Promise<void> {
  const input: Record<string, unknown> = { note };
  if (customAttributes) input.customAttributes = customAttributes;
  await runDraftUpdate(run, draftId, input);
}

// ── Draft line ops ───────────────────────────────────────────────────────────

export interface LineCycleDiscountInput {
  afterCycle: number;
  adjustmentType: "PERCENTAGE" | "FIXED_AMOUNT" | "PRICE";
  adjustmentValue: { percentage?: number; amountCents?: number };
  computedPriceCents: number;
}

export interface LinePricingPolicyInput {
  basePriceCents: number;
  cycleDiscounts: LineCycleDiscountInput[];
}

function pricingPolicyToApi(policy: LinePricingPolicyInput): Record<string, unknown> {
  return {
    basePrice: decimalStringFromCents(policy.basePriceCents),
    cycleDiscounts: policy.cycleDiscounts.map((d) => ({
      afterCycle: d.afterCycle,
      adjustmentType: d.adjustmentType,
      adjustmentValue:
        d.adjustmentValue.percentage != null
          ? { percentage: d.adjustmentValue.percentage }
          : {
              fixedValue: decimalStringFromCents(
                d.adjustmentValue.amountCents ?? 0,
              ),
            },
      computedPrice: decimalStringFromCents(d.computedPriceCents),
    })),
  };
}

export interface DraftLineAddInput {
  productVariantId: string;
  quantity: number;
  currentPriceCents: number;
  sellingPlanId?: string | null;
  sellingPlanName?: string | null;
  pricingPolicy?: LinePricingPolicyInput | null;
}

/** Add a line to the draft. Returns the new Shopify line GID (or null). */
export async function draftLineAdd(
  run: DraftRunner,
  draftId: string,
  line: DraftLineAddInput,
): Promise<string | null> {
  const input: Record<string, unknown> = {
    productVariantId: line.productVariantId,
    quantity: line.quantity,
    currentPrice: decimalStringFromCents(line.currentPriceCents),
  };
  if (line.sellingPlanId != null) input.sellingPlanId = line.sellingPlanId;
  if (line.sellingPlanName != null) input.sellingPlanName = line.sellingPlanName;
  if (line.pricingPolicy) input.pricingPolicy = pricingPolicyToApi(line.pricingPolicy);

  const data = await run<DraftLineAddResponse>(DRAFT_LINE_ADD_MUTATION, {
    draftId,
    input,
  });
  ensureNoUserErrors("subscriptionDraftLineAdd", data.subscriptionDraftLineAdd);
  return data.subscriptionDraftLineAdd?.lineAdded?.id ?? null;
}

export interface DraftLineUpdateInput {
  productVariantId?: string;
  quantity?: number;
  currentPriceCents?: number;
  sellingPlanId?: string | null;
  sellingPlanName?: string | null;
  pricingPolicy?: LinePricingPolicyInput | null;
}

export async function draftLineUpdate(
  run: DraftRunner,
  draftId: string,
  lineId: string,
  patch: DraftLineUpdateInput,
): Promise<string | null> {
  const input: Record<string, unknown> = {};
  if (patch.productVariantId != null) input.productVariantId = patch.productVariantId;
  if (patch.quantity != null) input.quantity = patch.quantity;
  if (patch.currentPriceCents != null) {
    input.currentPrice = decimalStringFromCents(patch.currentPriceCents);
  }
  if (patch.sellingPlanId != null) input.sellingPlanId = patch.sellingPlanId;
  if (patch.sellingPlanName != null) input.sellingPlanName = patch.sellingPlanName;
  if (patch.pricingPolicy) input.pricingPolicy = pricingPolicyToApi(patch.pricingPolicy);

  const data = await run<DraftLineUpdateResponse>(DRAFT_LINE_UPDATE_MUTATION, {
    draftId,
    lineId,
    input,
  });
  ensureNoUserErrors(
    "subscriptionDraftLineUpdate",
    data.subscriptionDraftLineUpdate,
  );
  return data.subscriptionDraftLineUpdate?.lineUpdated?.id ?? null;
}

export async function draftLineRemove(
  run: DraftRunner,
  draftId: string,
  lineId: string,
): Promise<string | null> {
  const data = await run<DraftLineRemoveResponse>(DRAFT_LINE_REMOVE_MUTATION, {
    draftId,
    lineId,
  });
  ensureNoUserErrors(
    "subscriptionDraftLineRemove",
    data.subscriptionDraftLineRemove,
  );
  return data.subscriptionDraftLineRemove?.lineRemoved?.id ?? null;
}

export interface DraftLine {
  id: string;
  variantId: string | null;
  quantity: number;
}

/**
 * The lines currently on an open draft (contract-update OR billing-cycle
 * contract-edit). Per-cycle line edits (v1.28.0, P2.5) read this before
 * removing / updating a line on a cycle draft: a line the cycle edit itself
 * re-added (an unskip after a skip) carries a cycle-scoped id, not the
 * contract line's, so the caller resolves the target by id-then-variant.
 */
export async function draftLines(
  run: DraftRunner,
  draftId: string,
): Promise<DraftLine[]> {
  const data = await run<DraftLinesResponse>(DRAFT_LINES_QUERY, { draftId });
  const nodes = data.subscriptionDraft?.lines?.nodes ?? [];
  return nodes.map((n) => ({
    id: n.id,
    variantId: n.variantId ?? null,
    quantity: n.quantity ?? 0,
  }));
}

/**
 * The contract's current Shopify `note` and `customAttributes` (v1.28.0
 * review fix): the delivery-instructions writer merges into these instead of
 * replacing the whole list — checkout notes / attributes copied onto the
 * contract by Shopify (or written by another app) survive our save and clear.
 */
export async function getContractNoteAndAttributes(
  admin: AdminClient,
  contractGid: string,
): Promise<{
  note: string | null;
  customAttributes: Array<{ key: string; value: string }>;
}> {
  const data = await gql<ContractNoteResponse>(admin, CONTRACT_NOTE_QUERY, {
    id: contractGid,
  });
  const c = data.subscriptionContract;
  return {
    note: c?.note ?? null,
    customAttributes: (c?.customAttributes ?? []).map((a) => ({
      key: a.key,
      value: a.value ?? "",
    })),
  };
}

// ── Status mutations ─────────────────────────────────────────────────────────

export interface ContractStatusResult {
  id: string;
  status: string | null;
}

async function runStatusMutation(
  admin: AdminClient,
  mutationName:
    | "subscriptionContractActivate"
    | "subscriptionContractPause"
    | "subscriptionContractCancel"
    | "subscriptionContractFail"
    | "subscriptionContractExpire",
  contractGid: string,
): Promise<ContractStatusResult> {
  const data = await gql<Record<string, StatusMutationPayload | null>>(
    admin,
    statusMutationDocument(mutationName),
    { subscriptionContractId: contractGid },
  );
  const payload = data[mutationName] ?? null;
  ensureNoUserErrors(mutationName, payload);
  return {
    id: payload?.contract?.id ?? contractGid,
    status: payload?.contract?.status ?? null,
  };
}

export function contractActivate(
  admin: AdminClient,
  contractGid: string,
): Promise<ContractStatusResult> {
  return runStatusMutation(admin, "subscriptionContractActivate", contractGid);
}

export function contractPause(
  admin: AdminClient,
  contractGid: string,
): Promise<ContractStatusResult> {
  return runStatusMutation(admin, "subscriptionContractPause", contractGid);
}

export function contractCancel(
  admin: AdminClient,
  contractGid: string,
): Promise<ContractStatusResult> {
  return runStatusMutation(admin, "subscriptionContractCancel", contractGid);
}

export function contractFail(
  admin: AdminClient,
  contractGid: string,
): Promise<ContractStatusResult> {
  return runStatusMutation(admin, "subscriptionContractFail", contractGid);
}

export function contractExpire(
  admin: AdminClient,
  contractGid: string,
): Promise<ContractStatusResult> {
  return runStatusMutation(admin, "subscriptionContractExpire", contractGid);
}

// ── Next billing date / import ───────────────────────────────────────────────

export async function setNextBillingDate(
  admin: AdminClient,
  contractGid: string,
  date: Date,
): Promise<{ contractId: string; nextBillingDate: Date | null }> {
  const data = await gql<SetNextBillingDateResponse>(
    admin,
    SET_NEXT_BILLING_DATE_MUTATION,
    { contractId: contractGid, date: date.toISOString() },
  );
  ensureNoUserErrors(
    "subscriptionContractSetNextBillingDate",
    data.subscriptionContractSetNextBillingDate,
  );
  const payload = data.subscriptionContractSetNextBillingDate;
  return {
    contractId: payload?.contract?.id ?? contractGid,
    nextBillingDate: dateOrNull(payload?.contract?.nextBillingDate),
  };
}

/**
 * Input for subscriptionContractAtomicCreate (import path). `contract` is a
 * SubscriptionDraftInput (billingPolicy, deliveryPolicy, deliveryMethod,
 * deliveryPrice, paymentMethodId, ...); `lines` are SubscriptionAtomicLineInput
 * rows with decimal-string `currentPrice`.
 */
export interface AtomicCreateContractInput {
  customerId: string;
  nextBillingDate: Date | string;
  currencyCode: string;
  contract: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
  discountCodes?: string[];
}

export async function atomicCreateContract(
  admin: AdminClient,
  input: AtomicCreateContractInput,
): Promise<{ contractId: string; status: string | null; nextBillingDate: Date | null }> {
  const apiInput: Record<string, unknown> = {
    customerId: input.customerId,
    nextBillingDate:
      input.nextBillingDate instanceof Date
        ? input.nextBillingDate.toISOString()
        : input.nextBillingDate,
    currencyCode: input.currencyCode,
    contract: input.contract,
    lines: input.lines,
  };
  if (input.discountCodes && input.discountCodes.length > 0) {
    apiInput.discountCodes = input.discountCodes;
  }

  const data = await gql<AtomicCreateResponse>(admin, ATOMIC_CREATE_MUTATION, {
    input: apiInput,
  });
  ensureNoUserErrors(
    "subscriptionContractAtomicCreate",
    data.subscriptionContractAtomicCreate,
  );
  const contract = data.subscriptionContractAtomicCreate?.contract;
  if (!contract?.id) {
    throw new Error("subscriptionContractAtomicCreate returned no contract");
  }
  return {
    contractId: contract.id,
    status: contract.status ?? null,
    nextBillingDate: dateOrNull(contract.nextBillingDate),
  };
}
