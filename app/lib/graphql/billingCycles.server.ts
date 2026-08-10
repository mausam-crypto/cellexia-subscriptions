import {
  type AdminClient,
  type UserError,
  dateOrNull,
  ensureNoUserErrors,
  gql,
} from "./client.server";
import {
  type DraftRunner,
  commitSubscriptionDraft,
} from "./contracts.server";

/**
 * Billing cycle reads and per-cycle mutations.
 *
 * Everything here targets a single cycle and never mutates the contract:
 * skip/unskip, schedule edits (date moves for delays/stockouts) and
 * billing-cycle contract edits (one-time add-ons, gifts, per-cycle
 * DiscountGrant pricing). Charging happens via subscriptionBillingAttemptCreate
 * with the caller's idempotency key ("{contractId}:{cycleIndex}:{attemptNumber}"
 * per the golden rules) — results arrive via SUBSCRIPTION_BILLING_ATTEMPTS_*
 * webhooks, never synchronously.
 */

// ── Selectors ────────────────────────────────────────────────────────────────

export type BillingCycleSelector = { index: number } | { date: Date };

function selectorToApi(selector: BillingCycleSelector): Record<string, unknown> {
  if ("index" in selector) return { index: selector.index };
  return { date: selector.date.toISOString() };
}

function billingCycleInput(
  contractGid: string,
  selector: BillingCycleSelector,
): Record<string, unknown> {
  return { contractId: contractGid, selector: selectorToApi(selector) };
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const BILLING_CYCLE_QUERY = `#graphql
  query CellexiaBillingCycle($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycle(billingCycleInput: $billingCycleInput) {
      cycleIndex
      billingAttemptExpectedDate
      skipped
      edited
      status
    }
  }
`;

const CYCLE_SKIP_MUTATION = `#graphql
  mutation CellexiaBillingCycleSkip($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleSkip(billingCycleInput: $billingCycleInput) {
      billingCycle {
        cycleIndex
        skipped
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CYCLE_UNSKIP_MUTATION = `#graphql
  mutation CellexiaBillingCycleUnskip($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleUnskip(billingCycleInput: $billingCycleInput) {
      billingCycle {
        cycleIndex
        skipped
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CYCLE_SCHEDULE_EDIT_MUTATION = `#graphql
  mutation CellexiaBillingCycleScheduleEdit($billingCycleInput: SubscriptionBillingCycleInput!, $input: SubscriptionBillingCycleScheduleEditInput!) {
    subscriptionBillingCycleScheduleEdit(billingCycleInput: $billingCycleInput, input: $input) {
      billingCycle {
        cycleIndex
        billingAttemptExpectedDate
        skipped
        edited
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CYCLE_CONTRACT_EDIT_MUTATION = `#graphql
  mutation CellexiaBillingCycleContractEdit($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleContractEdit(billingCycleInput: $billingCycleInput) {
      draft {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const BILLING_ATTEMPT_CREATE_MUTATION = `#graphql
  mutation CellexiaBillingAttemptCreate($subscriptionContractId: ID!, $subscriptionBillingAttemptInput: SubscriptionBillingAttemptInput!) {
    subscriptionBillingAttemptCreate(
      subscriptionContractId: $subscriptionContractId
      subscriptionBillingAttemptInput: $subscriptionBillingAttemptInput
    ) {
      subscriptionBillingAttempt {
        id
        ready
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawBillingCycle {
  cycleIndex?: number | null;
  billingAttemptExpectedDate?: string | null;
  skipped?: boolean | null;
  edited?: boolean | null;
  status?: string | null;
}

interface BillingCycleQueryResponse {
  subscriptionBillingCycle?: RawBillingCycle | null;
}

interface CycleSkipResponse {
  subscriptionBillingCycleSkip?: {
    billingCycle?: RawBillingCycle | null;
    userErrors?: UserError[];
  } | null;
}

interface CycleUnskipResponse {
  subscriptionBillingCycleUnskip?: {
    billingCycle?: RawBillingCycle | null;
    userErrors?: UserError[];
  } | null;
}

interface CycleScheduleEditResponse {
  subscriptionBillingCycleScheduleEdit?: {
    billingCycle?: RawBillingCycle | null;
    userErrors?: UserError[];
  } | null;
}

interface CycleContractEditResponse {
  subscriptionBillingCycleContractEdit?: {
    draft?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

interface BillingAttemptCreateResponse {
  subscriptionBillingAttemptCreate?: {
    subscriptionBillingAttempt?: { id: string; ready?: boolean | null } | null;
    userErrors?: UserError[];
  } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ShopifyBillingCycle {
  cycleIndex: number;
  billingAttemptExpectedDate: Date | null;
  skipped: boolean;
  edited: boolean;
  /** BILLED | UNBILLED when Shopify returns it. */
  status: string | null;
}

function normalizeCycle(raw: RawBillingCycle | null | undefined): ShopifyBillingCycle | null {
  if (!raw) return null;
  return {
    cycleIndex: raw.cycleIndex ?? 0,
    billingAttemptExpectedDate: dateOrNull(raw.billingAttemptExpectedDate),
    skipped: raw.skipped ?? false,
    edited: raw.edited ?? false,
    status: raw.status ?? null,
  };
}

async function getBillingCycle(
  admin: AdminClient,
  contractGid: string,
  selector: BillingCycleSelector,
): Promise<ShopifyBillingCycle | null> {
  const data = await gql<BillingCycleQueryResponse>(admin, BILLING_CYCLE_QUERY, {
    billingCycleInput: billingCycleInput(contractGid, selector),
  });
  return normalizeCycle(data.subscriptionBillingCycle);
}

/** The cycle whose billing window contains `date`. */
export function getBillingCycleByDate(
  admin: AdminClient,
  contractGid: string,
  date: Date,
): Promise<ShopifyBillingCycle | null> {
  return getBillingCycle(admin, contractGid, { date });
}

export function getBillingCycleByIndex(
  admin: AdminClient,
  contractGid: string,
  index: number,
): Promise<ShopifyBillingCycle | null> {
  return getBillingCycle(admin, contractGid, { index });
}

/** Mark one cycle skipped (customer "skip next" — contract stays untouched). */
export async function skipBillingCycle(
  admin: AdminClient,
  contractGid: string,
  selector: BillingCycleSelector,
): Promise<ShopifyBillingCycle | null> {
  const data = await gql<CycleSkipResponse>(admin, CYCLE_SKIP_MUTATION, {
    billingCycleInput: billingCycleInput(contractGid, selector),
  });
  ensureNoUserErrors(
    "subscriptionBillingCycleSkip",
    data.subscriptionBillingCycleSkip,
  );
  return normalizeCycle(data.subscriptionBillingCycleSkip?.billingCycle);
}

export async function unskipBillingCycle(
  admin: AdminClient,
  contractGid: string,
  selector: BillingCycleSelector,
): Promise<ShopifyBillingCycle | null> {
  const data = await gql<CycleUnskipResponse>(admin, CYCLE_UNSKIP_MUTATION, {
    billingCycleInput: billingCycleInput(contractGid, selector),
  });
  ensureNoUserErrors(
    "subscriptionBillingCycleUnskip",
    data.subscriptionBillingCycleUnskip,
  );
  return normalizeCycle(data.subscriptionBillingCycleUnskip?.billingCycle);
}

/**
 * Move one cycle's billing date (delay / stockout push) without changing the
 * contract cadence. Always MERCHANT_INITIATED — this app is the merchant's.
 */
export async function scheduleEditBillingCycle(
  admin: AdminClient,
  contractGid: string,
  selector: BillingCycleSelector,
  edit: { billingDate: Date },
): Promise<ShopifyBillingCycle | null> {
  const data = await gql<CycleScheduleEditResponse>(
    admin,
    CYCLE_SCHEDULE_EDIT_MUTATION,
    {
      billingCycleInput: billingCycleInput(contractGid, selector),
      input: {
        billingDate: edit.billingDate.toISOString(),
        reason: "MERCHANT_INITIATED",
      },
    },
  );
  ensureNoUserErrors(
    "subscriptionBillingCycleScheduleEdit",
    data.subscriptionBillingCycleScheduleEdit,
  );
  return normalizeCycle(data.subscriptionBillingCycleScheduleEdit?.billingCycle);
}

/**
 * Open a billing-cycle contract-edit draft (changes apply to this one cycle
 * only — one-time add-ons, gifts, per-cycle discount pricing), run `ops`
 * with the shared draft line helpers, then commit.
 */
export async function withBillingCycleEdit(
  admin: AdminClient,
  contractGid: string,
  selector: BillingCycleSelector,
  ops: (draftId: string, run: DraftRunner) => Promise<void>,
): Promise<{ contractId: string }> {
  const data = await gql<CycleContractEditResponse>(
    admin,
    CYCLE_CONTRACT_EDIT_MUTATION,
    { billingCycleInput: billingCycleInput(contractGid, selector) },
  );
  ensureNoUserErrors(
    "subscriptionBillingCycleContractEdit",
    data.subscriptionBillingCycleContractEdit,
  );
  const draftId = data.subscriptionBillingCycleContractEdit?.draft?.id;
  if (!draftId) {
    throw new Error("subscriptionBillingCycleContractEdit returned no draft");
  }

  const run: DraftRunner = (query, variables) => gql(admin, query, variables);
  await ops(draftId, run);

  return commitSubscriptionDraft(admin, draftId, contractGid);
}

// ── Billing attempts ─────────────────────────────────────────────────────────

export interface CreateBillingAttemptOptions {
  /** "{contractId}:{cycleIndex}:{attemptNumber}" — Shopify dedupes on it. */
  idempotencyKey: string;
  originTime?: Date;
  cycleIndex?: number;
}

/**
 * Kick off a charge for a contract. Fire-and-forget: the outcome arrives via
 * SUBSCRIPTION_BILLING_ATTEMPTS_{SUCCESS,FAILURE,CHALLENGED} webhooks.
 */
export async function createBillingAttempt(
  admin: AdminClient,
  contractGid: string,
  options: CreateBillingAttemptOptions,
): Promise<{ attemptId: string; ready: boolean }> {
  const input: Record<string, unknown> = {
    idempotencyKey: options.idempotencyKey,
  };
  if (options.originTime) input.originTime = options.originTime.toISOString();
  if (options.cycleIndex != null) {
    input.billingCycleSelector = { index: options.cycleIndex };
  }

  const data = await gql<BillingAttemptCreateResponse>(
    admin,
    BILLING_ATTEMPT_CREATE_MUTATION,
    {
      subscriptionContractId: contractGid,
      subscriptionBillingAttemptInput: input,
    },
  );
  ensureNoUserErrors(
    "subscriptionBillingAttemptCreate",
    data.subscriptionBillingAttemptCreate,
  );
  const attempt = data.subscriptionBillingAttemptCreate?.subscriptionBillingAttempt;
  if (!attempt?.id) {
    throw new Error("subscriptionBillingAttemptCreate returned no attempt");
  }
  return { attemptId: attempt.id, ready: attempt.ready ?? false };
}
