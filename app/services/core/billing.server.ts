/**
 * Billing attempts — creation (idempotent, key
 * "bill:<contractId>:<cycle>[:<attempt>]") and outcome recording from
 * webhooks.
 */
import type { BillingAttempt, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  type AdminGraphql,
  assertNoUserErrors,
  runGraphql,
} from "~/services/core/shopifyClient.server";
import { billingIdempotencyKey } from "~/services/core/pure";
import { SUBSCRIPTION_BILLING_ATTEMPT_CREATE_MUTATION } from "~/graphql/billing";
import { categorizeDeclineCode } from "~/services/retention/dunning.server";
import type { BillingAttemptStatus } from "~/types/domain";
import { logger } from "~/lib/logger.server";

export interface CreateBillingAttemptOptions {
  originTime?: Date;
  billingCycleIndex: number;
  /** Distinguishes deliberate re-attempts for the same unpaid cycle. */
  attempt?: string | number;
}

/**
 * PURE — is a newly recorded attempt a retry of a still-unpaid cycle?
 * True only when the contract's most recent prior attempt exists and left the
 * cycle unpaid (FAILURE or CHALLENGED). A prior SUCCESS means the new attempt
 * is the next cycle's routine charge — NOT a retry (counting those made
 * paymentRecoveryRate explode past 100%).
 */
export function isRetryAfter(
  prior: { status: string } | null | undefined,
): boolean {
  return (
    prior != null && (prior.status === "FAILURE" || prior.status === "CHALLENGED")
  );
}

/** PURE — FAILURE and CHALLENGED are one failure family (3DS delivers both). */
export function isFailureState(status: string): boolean {
  return status === "FAILURE" || status === "CHALLENGED";
}

/**
 * PURE — how an incoming webhook outcome relates to the stored attempt state.
 *
 * - `alreadyTerminal`: this outcome was already counted (same status, second
 *   member of the failure family, or a late failure-family webhook arriving
 *   AFTER the attempt succeeded) — counters and dunning must not move.
 * - `downgradesSuccess`: the stored attempt is SUCCESS and the incoming
 *   outcome is FAILURE/CHALLENGED. Shopify delivers webhooks unordered and
 *   at-least-once; the 3DS flow emits CHALLENGED and SUCCESS as separate
 *   webhooks, so a delayed CHALLENGED can land after the customer already
 *   paid. SUCCESS is terminal: the paid row must never be mutated, or dunning
 *   opens an episode (and can re-bill) against a fully paid cycle.
 */
export function resolveOutcomeTransition(
  storedStatus: string | null | undefined,
  incomingStatus: string,
): { alreadyTerminal: boolean; downgradesSuccess: boolean } {
  if (storedStatus == null) {
    return { alreadyTerminal: false, downgradesSuccess: false };
  }
  const downgradesSuccess =
    storedStatus === "SUCCESS" && isFailureState(incomingStatus);
  const alreadyTerminal =
    storedStatus === incomingStatus ||
    (isFailureState(storedStatus) && isFailureState(incomingStatus)) ||
    downgradesSuccess;
  return { alreadyTerminal, downgradesSuccess };
}

export async function createBillingAttempt(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
  options: CreateBillingAttemptOptions,
): Promise<BillingAttempt> {
  const contract = await prisma.subscriptionContract.findFirstOrThrow({
    where: { id: contractId, shop },
  });
  const key = billingIdempotencyKey(
    contractId,
    options.billingCycleIndex,
    options.attempt,
  );

  const { result } = await withIdempotency(key, "billing-attempt", async () => {
    const priorAttempts = await prisma.billingAttempt.count({
      where: { contractId },
    });

    const data = await runGraphql<{
      subscriptionBillingAttemptCreate: {
        subscriptionBillingAttempt: {
          id: string;
          ready: boolean;
          idempotencyKey: string;
        } | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    }>(graphql, SUBSCRIPTION_BILLING_ATTEMPT_CREATE_MUTATION, {
      subscriptionContractId: contract.shopifyContractId,
      subscriptionBillingAttemptInput: {
        idempotencyKey: key,
        ...(options.originTime
          ? { originTime: options.originTime.toISOString() }
          : {}),
      },
    });
    assertNoUserErrors(
      "subscriptionBillingAttemptCreate",
      data.subscriptionBillingAttemptCreate.userErrors,
    );
    const remote = data.subscriptionBillingAttemptCreate.subscriptionBillingAttempt;

    const attempt = await prisma.billingAttempt.create({
      data: {
        shop,
        contractId,
        shopifyBillingAttemptId: remote?.id ?? null,
        idempotencyKey: key,
        status: "PENDING" satisfies BillingAttemptStatus,
        attemptNumber: priorAttempts + 1,
        // The attempt suffix is present exactly on the dunning RETRY path —
        // that, not "any prior attempt exists", is what makes this a retry.
        isRetry: options.attempt != null,
      },
    });

    await appendAudit({
      shop,
      actorType: "SYSTEM",
      action: "BILLING_ATTEMPT_CREATED",
      subjectType: "SubscriptionContract",
      subjectId: contractId,
      payload: {
        billingCycleIndex: options.billingCycleIndex,
        idempotencyKey: key,
        shopifyBillingAttemptId: remote?.id ?? null,
      },
    });
    logger.info("billing attempt created", { shop, contractId, key });
    return attempt;
  });
  return result;
}

export interface BillingAttemptOutcome {
  status: BillingAttemptStatus; // SUCCESS | FAILURE | CHALLENGED
  errorCode?: string | null;
  orderId?: string | null;
  amountCents?: number | null;
  /** Shopify's idempotency_key from the webhook — matches rows we created. */
  idempotencyKey?: string | null;
  /** gid of the contract, for attempts we did not originate (auto-billing). */
  shopifyContractId?: string | null;
}

/**
 * Record the outcome of a billing attempt (called from webhook handlers).
 * Upserts the BillingAttempt row and maintains the contract's running totals.
 */
export async function recordAttemptOutcome(
  shop: string,
  shopifyBillingAttemptId: string,
  outcome: BillingAttemptOutcome,
): Promise<{
  attempt: BillingAttempt;
  contract: SubscriptionContract | null;
  /** True when this outcome had already been counted (webhook replay, or a
   *  CHALLENGED→FAILURE second delivery for the same attempt). */
  replayed: boolean;
}> {
  // CHALLENGED means the charge hit a 3DS/SCA challenge — the webhook carries
  // no decline code, so sniffing the (null) code would misfile every
  // challenged attempt as GENERIC_DECLINE and run the wrong recovery strategy.
  const declineCategory =
    outcome.status === "SUCCESS"
      ? null
      : outcome.status === "CHALLENGED"
        ? "AUTHENTICATION_REQUIRED"
        : categorizeDeclineCode(outcome.errorCode ?? null);

  let attempt = await prisma.billingAttempt.findFirst({
    where: {
      shop,
      OR: [
        { shopifyBillingAttemptId },
        ...(outcome.idempotencyKey
          ? [{ idempotencyKey: outcome.idempotencyKey }]
          : []),
      ],
    },
  });

  // CHALLENGED and FAILURE are one failure family: the standard 3DS flow
  // delivers CHALLENGED and then FAILURE for the same attempt (different
  // webhookIds), and counting both would double failedAttempts/dunning.
  // SUCCESS is terminal: a delayed failure-family webhook must never
  // downgrade a paid attempt (see resolveOutcomeTransition).
  const { alreadyTerminal, downgradesSuccess } = resolveOutcomeTransition(
    attempt?.status,
    outcome.status,
  );

  if (attempt && downgradesSuccess) {
    // Leave the paid row exactly as recorded (status, orderId, amount); the
    // audit entry below still records the late webhook with replayed: true.
    logger.info("late failure webhook ignored for paid attempt", {
      shop,
      shopifyBillingAttemptId,
      storedStatus: attempt.status,
      incomingStatus: outcome.status,
    });
  } else if (attempt) {
    attempt = await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        shopifyBillingAttemptId,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        declineCategory,
        orderId: outcome.orderId ?? null,
        amountCents: outcome.amountCents ?? attempt.amountCents,
        occurredAt: new Date(),
      },
    });
  } else {
    // Attempt we did not originate (e.g. Shopify auto-billing).
    if (!outcome.shopifyContractId) {
      throw new Error(
        `Unknown billing attempt ${shopifyBillingAttemptId} and no contract id to attach it to`,
      );
    }
    const contract = await prisma.subscriptionContract.findUnique({
      where: { shopifyContractId: outcome.shopifyContractId },
    });
    if (!contract) {
      throw new Error(
        `No local contract for ${outcome.shopifyContractId} — sync before recording outcomes`,
      );
    }
    const priorAttempts = await prisma.billingAttempt.count({
      where: { contractId: contract.id },
    });
    // A Shopify auto-billing attempt is a retry only when the previous
    // attempt of the (necessarily still-unpaid) cycle failed — a prior
    // SUCCESS means this is just the next routine renewal.
    const mostRecentPrior = await prisma.billingAttempt.findFirst({
      where: { contractId: contract.id },
      orderBy: { occurredAt: "desc" },
      select: { status: true },
    });
    attempt = await prisma.billingAttempt.create({
      data: {
        shop,
        contractId: contract.id,
        shopifyBillingAttemptId,
        idempotencyKey: `ext:${shopifyBillingAttemptId}`,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        declineCategory,
        orderId: outcome.orderId ?? null,
        amountCents: outcome.amountCents ?? null,
        attemptNumber: priorAttempts + 1,
        isRetry: isRetryAfter(mostRecentPrior),
      },
    });
  }

  let contract: SubscriptionContract | null = null;
  if (!alreadyTerminal) {
    if (outcome.status === "SUCCESS") {
      contract = await prisma.subscriptionContract.update({
        where: { id: attempt.contractId },
        data: {
          successfulOrders: { increment: 1 },
          totalRevenueCents: { increment: outcome.amountCents ?? 0 },
        },
      });
    } else if (outcome.status === "FAILURE" || outcome.status === "CHALLENGED") {
      contract = await prisma.subscriptionContract.update({
        where: { id: attempt.contractId },
        data: { failedAttempts: { increment: 1 } },
      });
    }
  } else {
    contract = await prisma.subscriptionContract.findUnique({
      where: { id: attempt.contractId },
    });
  }

  await appendAudit({
    shop,
    actorType: "WEBHOOK",
    action: "BILLING_OUTCOME_RECORDED",
    subjectType: "BillingAttempt",
    subjectId: attempt.id,
    payload: {
      shopifyBillingAttemptId,
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      declineCategory,
      orderId: outcome.orderId ?? null,
      amountCents: outcome.amountCents ?? null,
      replayed: alreadyTerminal,
    },
  });

  return { attempt, contract, replayed: alreadyTerminal };
}
