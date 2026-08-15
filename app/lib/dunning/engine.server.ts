import { Prisma } from "@prisma/client";
import type {
  BillingAttempt,
  ContractLine,
  DunningCase,
  DunningState,
  SubscriptionContract,
} from "@prisma/client";
import prisma from "~/db.server";
import {
  logEvent,
  type EventSource,
  type LogEventInput,
} from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { addDaysTz, alignToPayday } from "~/lib/dates.server";
import { formatMoney } from "~/lib/money";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import {
  sendNotification,
  type TemplateKey,
} from "~/lib/notifications/index.server";
import { adminClientForShop } from "~/shopify.server";
import {
  type AdminClient,
  ShopifyUserError,
  contractActivate,
  contractFail,
  createBillingAttempt,
  draftUpdatePaymentMethod,
  listCustomerPaymentMethods,
  sendPaymentMethodUpdateEmail,
  withContractDraft,
} from "~/lib/graphql/index.server";
import {
  buildMitEvidence,
  hasThreeDsEvidence,
  withThreeDsOutcome,
} from "~/lib/billing/mit-evidence.server";
import {
  categorizeDeclineCode,
  structuredUserErrorCode,
  type DeclineCodeInfo,
} from "./decline-codes.server";
import { selectNextRetryOffsetDays } from "./ladder.server";
import { OURS_ONLY, isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Dunning engine — the retry ladder that turns failed renewals back into
 * revenue. Involuntary churn is the #1 profit leak; every decision here is a
 * setting (settings.dunning), every state change logs an event, and every
 * charge is idempotent.
 *
 * ## Ladder math (worked example, default settings)
 *
 * `softRetryDays: [0, 3, 7, 14]` — offsets in days FROM THE FIRST FAILURE
 * (`DunningCase.openedAt`), not from the previous retry. Index 0 is the
 * original failed charge; retries live at indexes 1+. The next retry is the
 * FIRST offset still ahead of `now` (selectNextRetryOffsetDays) — chosen by
 * TIME, not by counting failed attempts, so an admin "Retry now", the 1-hour
 * backup-card retry or an immediate payment-method-updated retry never
 * consumes a configured rung. `paydaysOfMonth: [1, 15, 25]`,
 * `paydaySnapWindowDays: 3`.
 *
 *   Mon Jan 5  — scheduled charge fails SOFT (attempt #1). Case opens (day 0).
 *                First future offset = softRetryDays[1] = 3
 *                → retry #1 scheduled Thu Jan 8 (day 3; probe Jan 8→11 finds
 *                no payday, so no snap).
 *   Thu Jan 8  — retry #1 (attempt #2) fails.
 *                First future offset = softRetryDays[2] = 7
 *                → candidate Mon Jan 12 (day 7). This is retry #2, so the
 *                backup payment method is tried first if configured (switch
 *                card, retry in 1h instead; if the backup ALSO fails the
 *                original card is restored for the remaining rungs).
 *                Otherwise payday alignment probes Jan 12 → 13 → 14 → 15 and
 *                snaps to Thu Jan 15 (payday, `paydayAligned = true`).
 *   Thu Jan 15 — retry #2 (attempt #3) fails.
 *                First future offset = softRetryDays[3] = 14
 *                → retry #3 scheduled Mon Jan 19 (day 14 from Jan 5).
 *   Mon Jan 19 — retry #3 (attempt #4) fails.
 *                No offset lies ahead of day 14
 *                → ladder exhausted → `exhaustedAction` (PAUSE: contract
 *                FAILED via subscriptionContractFail, renewals stop, portal
 *                shows the fix-payment banner; CANCEL: cancelContract with
 *                reason PAYMENT_FAILED — the cancel service schedules
 *                win-back).
 *
 * Cases are per billing cycle: a new cycle failing while an older case is
 * still open supersedes it (fresh openedAt anchor, fresh email cursors) —
 * see ensureOpenCase.
 *
 * In parallel the notification ladder (`emailLadderDays: [0, 3, 7]`) sends
 * payment_failed_1/2/3 at days 0/3/7 after the case opened and one SMS at
 * `smsDay` (8). HARD declines skip the retry ladder entirely: the customer is
 * asked to fix their card immediately, and a successful charge after the fix
 * closes the case as CUSTOMER_FIXED.
 *
 * ## Case lifecycle
 *
 *   (failure) → OPEN → RETRYING ⇄ (retries) → RECOVERED | EXHAUSTED
 *                    → AWAITING_CUSTOMER / AWAITING_3DS → RETRYING (card fixed)
 *                                                       → EXHAUSTED (timeout)
 *   Contract cancelled elsewhere at any point → CANCELLED.
 */

// ── Types & constants ────────────────────────────────────────────────────────

type DunningSettings = SettingsValue<"dunning">;

type ContractWithShop = Prisma.SubscriptionContractGetPayload<{
  include: { shop: true };
}>;

type AttemptFull = Prisma.BillingAttemptGetPayload<{
  include: { contract: { include: { shop: true; lines: true } } };
}>;

type CaseWithContract = Prisma.DunningCaseGetPayload<{
  include: { contract: { include: { shop: true; lines: true } } };
}>;

/** Structural signature of the contracts-module seam (lazy-imported to avoid cycles). */
type CancelContractFn = (
  shopDomain: string,
  contractId: string,
  reason: string,
  options?: {
    source?: string;
    actor?: string | null;
    cancelSource?: string;
    scheduleWinback?: boolean;
  },
) => Promise<unknown>;

export const OPEN_CASE_STATES: DunningState[] = [
  "OPEN",
  "RETRYING",
  "AWAITING_CUSTOMER",
  "AWAITING_3DS",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long onBillingAttemptFailed's entry claim (dunningClaimedAt) shields an
 * attempt from a second concurrent invocation. Engine work takes seconds;
 * the lease is generous so slow Shopify round trips never let a duplicate
 * in, yet short enough that a crashed run is re-drivable the same day.
 */
export const DUNNING_CLAIM_LEASE_MS = 10 * 60 * 1000;
/** After switching to the backup card, retry after this delay. */
const BACKUP_RETRY_DELAY_MS = 60 * 60 * 1000;
/** Back-off before re-firing a retry whose Shopify create call failed. */
const CREATE_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
/**
 * A case whose Shopify attempt-create keeps failing is parked (AWAITING_
 * CUSTOMER) after this many failed create calls instead of re-firing hourly
 * forever — the sweep's cancelAfterFailedDays timeout then resolves it.
 */
const CREATE_FAILURE_MAX = 24;
/** Days of update-card link validity beyond the case's cancel window. */
const UPDATE_CARD_LINK_GRACE_DAYS = 7;
const CONFIRM_3DS_TTL_SECONDS = 3 * 24 * 3600;
const CONFIRM_3DS_MAX_USES = 3;

const LADDER_EMAIL_TEMPLATES = [
  "payment_failed_1",
  "payment_failed_2",
  "payment_failed_3",
] as const;

export interface DunningSweepStats {
  /** Open cases (sweep) / candidate contracts (pre-expiry) inspected. */
  processed: number;
  retriesScheduled: number;
  emailsSent: number;
  smsSent: number;
  exhausted: number;
}

function emptyStats(): DunningSweepStats {
  return {
    processed: 0,
    retriesScheduled: 0,
    emailsSent: 0,
    smsSent: 0,
    exhausted: 0,
  };
}

// ── Small helpers ────────────────────────────────────────────────────────────

function eventBase(
  contract: SubscriptionContract,
): Pick<LogEventInput, "shopId" | "contractId" | "customerId" | "email"> {
  return {
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };
}

async function loadAttempt(attemptLocalId: string): Promise<AttemptFull | null> {
  const attempt = await prisma.billingAttempt.findUnique({
    where: { id: attemptLocalId },
    include: { contract: { include: { shop: true, lines: true } } },
  });
  if (!attempt) {
    console.error("[dunning] billing attempt not found", attemptLocalId);
  }
  return attempt;
}

/**
 * Is this contract ours to dun? The shop may run a second subscription app
 * whose contracts are mirrored here by the SUBSCRIPTION_CONTRACTS_* webhooks;
 * retrying THEIR charges, opening a case, or emailing THEIR customer about a
 * decline is never ours to do. UNKNOWN fails safe the same way.
 *
 * Logged rather than silent — a foreign contract reaching a dunning entry point
 * means a billing attempt got mirrored for someone else's contract, which is
 * worth seeing in the logs.
 */
function assertOurContract(
  contract: Pick<SubscriptionContract, "id" | "ownership">,
  where: string,
): boolean {
  if (isBillableOwnership(contract.ownership)) return true;
  console.warn(
    `[dunning] skipping ${where} for non-owned contract`,
    contract.id,
    contract.ownership,
  );
  return false;
}

/**
 * The 3DS resolution already recorded in an attempt's mitEvidence blob, or
 * null. Defensive over shape (legacy/imported attempts carry null or
 * malformed blobs) — the success path uses it to fold SUCCEEDED exactly once
 * instead of restamping resolvedAt on every settlement redrive.
 */
function threeDsResolution(evidence: Prisma.JsonValue | null): string | null {
  if (evidence == null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return null;
  }
  const threeDS = (evidence as Record<string, unknown>).threeDS;
  if (threeDS == null || typeof threeDS !== "object" || Array.isArray(threeDS)) {
    return null;
  }
  const resolution = (threeDS as Record<string, unknown>).resolution;
  return typeof resolution === "string" ? resolution : null;
}

function findOpenCase(contractId: string): Promise<DunningCase | null> {
  return prisma.dunningCase.findFirst({
    where: { contractId, state: { in: OPEN_CASE_STATES } },
    orderBy: { openedAt: "desc" },
  });
}

/**
 * Admin-initiated case transitions ("Retry now", "Mark resolved", "Cancel
 * case"), guarded the way the engine's own paths are. The conditional
 * updateMany is the whole point:
 *
 *  - `state: { in: OPEN_CASE_STATES }` — only an OPEN case may be moved. The
 *    admin acts from a page that may be minutes stale; if the recovery
 *    webhook resolved the case in between (customer fixed their card, cycle
 *    billed), an unconditional overwrite would flip a RECOVERED case back
 *    into the sweep's working set with resolvedAt/resolution still stamped —
 *    the sweep then re-bills the already-billed cycle, Shopify refuses, the
 *    case parks AWAITING_CUSTOMER, and daysOpen (measured from the ORIGINAL
 *    openedAt) cancels a paying customer within days. Re-opening a resolved
 *    case is deliberately NOT offered here; onPaymentMethodUpdated owns that
 *    (and clears resolvedAt/resolution when it does).
 *  - `contractId` — the case must belong to the contract the route loaded
 *    and authorized (shop + ownership + demo gates). A bare POST with a
 *    foreign caseId must not move somebody else's case.
 *  - Atomic — the guard and the write are one statement, so a concurrent
 *    webhook recovery cannot slip between a check and an update.
 *
 * Returns false when nothing matched (already resolved, or not this
 * contract's case) — callers refuse instead of mutating.
 */
export async function transitionOpenCase(
  caseId: string,
  contractId: string,
  to: "RETRYING" | "RECOVERED" | "CANCELLED",
  now: Date = new Date(),
): Promise<boolean> {
  const data =
    to === "RETRYING"
      ? { state: "RETRYING" as DunningState, nextRetryAt: now }
      : {
          state: to as DunningState,
          resolvedAt: now,
          resolution: to,
          nextRetryAt: null,
        };
  const result = await prisma.dunningCase.updateMany({
    where: { id: caseId, contractId, state: { in: OPEN_CASE_STATES } },
    data,
  });
  return result.count === 1;
}

/**
 * The billing cycle a case is anchored to = its trigger attempt's cycleIndex.
 * Null for legacy cases without a trigger attempt (treated as any-cycle).
 */
async function caseCycleIndex(kase: DunningCase): Promise<number | null> {
  if (!kase.triggerAttemptId) return null;
  const trigger = await prisma.billingAttempt.findUnique({
    where: { id: kase.triggerAttemptId },
    select: { cycleIndex: true },
  });
  return trigger?.cycleIndex ?? null;
}

/**
 * Reuse the contract's open case FOR THE SAME BILLING CYCLE, or open a fresh
 * one (logging dunning.case_opened). `openedAt` of a fresh case is the anchor
 * date for all retry-ladder offsets — which is exactly why a case is never
 * reused across cycles: anchoring a new cycle's ladder to an old case's
 * openedAt would compute every retry in the past and burn the whole ladder in
 * minutes. A stale open case for an older cycle is closed as SUPERSEDED
 * first (its cycle's recovery is carried forward by the new case's ladder on
 * the same contract/payment method).
 *
 * Every caller has already passed `assertOurContract` — a FOREIGN/UNKNOWN
 * contract must never open a dunning case, because a case is a promise to
 * retry the charge and email the customer about it.
 */
async function ensureOpenCase(
  attempt: AttemptFull,
  declineCategory: string,
  source: EventSource,
): Promise<DunningCase> {
  const existing = await findOpenCase(attempt.contractId);
  if (existing) {
    const existingCycle = await caseCycleIndex(existing);
    if (existingCycle == null || existingCycle === attempt.cycleIndex) {
      return existing;
    }
    // Cross-cycle: close the stale case and fall through to a fresh one with
    // a fresh openedAt anchor and fresh notification cursors.
    await prisma.dunningCase.update({
      where: { id: existing.id },
      data: {
        state: "CANCELLED",
        resolvedAt: new Date(),
        resolution: "SUPERSEDED",
        nextRetryAt: null,
      },
    });
    await logEvent({
      ...eventBase(attempt.contract),
      type: "dunning.case_superseded",
      source,
      payload: {
        dunningCaseId: existing.id,
        supersededByCycleIndex: attempt.cycleIndex,
        caseCycleIndex: existingCycle,
        openedAt: existing.openedAt.toISOString(),
      },
    });
  }

  // "One open case per contract" is a DATABASE invariant: the partial unique
  // index DunningCase_one_open_case_per_contract (migration 0008) rejects a
  // concurrent second create with P2002. Losing that race means another
  // invocation (or another failing attempt of this contract) opened the case
  // between our find and our create — reuse it instead of duplicating the
  // ladder, the failure counter and the customer's "payment failed" emails.
  // The money at stake, frozen at case-open (an estimate, never rewritten —
  // recoveredCents later holds the actual): failed attempts carry no
  // amountCents (Shopify only prices an attempt on success), and once the
  // case resolves the contract's lines may have changed, so this is the only
  // moment the at-risk amount is knowable. Priced from the contract's lines
  // + delivery, hence the contract's own currency.
  const amountAtRiskCents = estimateContractAmountCents(attempt.contract);
  let kase: DunningCase;
  try {
    kase = await prisma.dunningCase.create({
      data: {
        contractId: attempt.contractId,
        triggerAttemptId: attempt.id,
        declineCode: attempt.errorCode ?? null,
        declineCategory,
        amountAtRiskCents,
        amountAtRiskCurrencyCode:
          amountAtRiskCents != null ? attempt.contract.currencyCode : null,
        // The instrument on file when the trouble started. Recovery
        // analytics compare it with the method at resolution, and the
        // backup-card revert reads it as the durable copy of the original
        // id — the dunning.backup_used event payload alone rides logEvent's
        // never-throw contract, i.e. a lossy channel.
        originalPaymentMethodId: attempt.contract.paymentMethodId,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const winner = await findOpenCase(attempt.contractId);
      if (winner) return winner;
    }
    throw err;
  }
  await logEvent({
    ...eventBase(attempt.contract),
    type: "dunning.case_opened",
    source,
    payload: {
      dunningCaseId: kase.id,
      triggerAttemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      attemptNumber: attempt.attemptNumber,
      declineCode: attempt.errorCode ?? null,
      declineCategory,
      amountAtRiskCents: kase.amountAtRiskCents,
      currencyCode: kase.amountAtRiskCurrencyCode,
    },
  });
  return kase;
}

/** Line total + delivery — fallback when the attempt carries no amount. */
function estimateContractAmountCents(contract: {
  lines: ContractLine[];
  deliveryPriceCents: number;
}): number | null {
  if (contract.lines.length === 0) return null;
  const lineSum = contract.lines.reduce(
    (sum, line) => sum + line.currentPriceCents * line.quantity,
    0,
  );
  return lineSum + contract.deliveryPriceCents;
}

/**
 * Signed UPDATE_CARD magic link (multi-use — dunning emails get tapped often).
 * TTL covers the case's whole life: cancelAfterFailedDays + grace, so the
 * last ladder email's link is still valid on the final day of the window —
 * a customer paid on the 25th must be able to tap the day-7 email on day 25.
 */
async function buildUpdateCardUrl(
  contract: SubscriptionContract,
): Promise<string | null> {
  try {
    const settings = await getSetting(contract.shopId, "dunning");
    const ttlDays =
      settings.cancelAfterFailedDays + UPDATE_CARD_LINK_GRACE_DAYS;
    return await buildMagicUrl({
      action: "UPDATE_CARD",
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      ttlSeconds: ttlDays * 24 * 3600,
      maxUses: 5,
      createdVia: "DUNNING",
    });
  } catch (err) {
    console.error("[dunning] update-card magic link failed", contract.id, err);
    return null;
  }
}

/** Standard template vars for failure notifications. */
function failureVars(
  attempt: AttemptFull,
  info: DeclineCodeInfo,
): Record<string, unknown> {
  const contract = attempt.contract;
  const amountCents =
    attempt.amountCents ?? estimateContractAmountCents(contract);
  return {
    attempt_number: attempt.attemptNumber,
    amount:
      amountCents != null
        ? formatMoney(
            amountCents,
            attempt.currencyCode ?? contract.currencyCode,
            contract.locale,
          )
        : "",
    card_last4: contract.cardLast4 ?? "",
    decline_human: info.description,
    cycleIndex: attempt.cycleIndex,
  };
}

// ── Payment method fallback ──────────────────────────────────────────────────

/**
 * Point the Shopify contract (and the local mirror) at the stored backup
 * payment method, refreshing the mirrored card metadata so failure emails
 * describe the card actually being charged. Callers log dunning.backup_used
 * with charge context (its previousPaymentMethodId payload is what the
 * backup-failure revert path reads to restore the original card).
 *
 * Pointer semantics: paymentMethodId becomes the backup id while
 * backupPaymentMethodId keeps pointing at it — `paymentMethodId ===
 * backupPaymentMethodId` is the "currently on backup" marker fireRetry stamps
 * onto attempts as usedBackupPayment.
 */
export async function changePaymentMethodToBackup(
  contract: ContractWithShop,
): Promise<void> {
  const backupId = contract.backupPaymentMethodId;
  if (!backupId) {
    throw new Error(`Contract ${contract.id} has no backup payment method`);
  }
  const admin = await adminClientForShop(contract.shop.domain);
  await withContractDraft(admin, contract.shopifyContractId, async (draftId, run) => {
    await draftUpdatePaymentMethod(run, draftId, backupId);
  });
  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: { paymentMethodId: backupId },
  });
  // Keep the in-memory contract consistent, mirroring the revert path:
  // callers notify the customer right after the switch, and stale in-memory
  // card metadata would name the OLD (just-failed) card in the "your payment
  // method was updated" email. Callers needing the pre-switch id capture it
  // BEFORE calling (handleSoftFailure's dunning.backup_used payload does).
  contract.paymentMethodId = backupId;
  await refreshCardMirror(contract, backupId);
}

// ── Failure handling (webhook entrypoints) ───────────────────────────────────

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE → classify, open/extend the dunning
 * case and decide the next move (retry ladder / await customer / await 3DS).
 *
 * Idempotency & crash-resumability: the attempt's declineCategory is the
 * PROCESSING-COMPLETE marker and is written LAST — an attempt that is FAILED
 * with a decline category has been all the way through the engine and is
 * skipped on redelivery. A crash mid-way leaves declineCategory null, so the
 * webhook handler's unconditional re-invoke on redelivery re-drives the case/
 * retry state instead of silently losing the failure.
 *
 * Concurrency: the read-then-act guard above cannot stop two OVERLAPPING
 * invocations (the classic race: stale_attempt_sweep resolving a >2h PENDING
 * attempt while the delayed FAILURE webhook finally lands) — both would read
 * declineCategory null and run the whole engine. The attempt is therefore
 * CLAIMED atomically at entry: an updateMany stamps dunningClaimedAt, gated
 * on declineCategory still null and no live lease; only the winner proceeds.
 * The lease (DUNNING_CLAIM_LEASE_MS) is what keeps crash-resumability: a run
 * that died mid-way leaves declineCategory null and its lease expires, so a
 * redelivery after the lease re-drives the failure exactly as documented
 * above — while a same-moment duplicate loses the claim and returns.
 */
export async function onBillingAttemptFailed(
  attemptLocalId: string,
): Promise<void> {
  const attempt = await loadAttempt(attemptLocalId);
  if (!attempt) return;
  const contract = attempt.contract;
  if (!assertOurContract(contract, "attempt-failed")) return;
  const now = new Date();

  if (attempt.status === "FAILED" && attempt.declineCategory != null) {
    return; // webhook redelivery — already fully processed
  }

  // Atomic entry claim (see JSDoc): one invocation runs the engine.
  const claimed = await prisma.billingAttempt.updateMany({
    where: {
      id: attempt.id,
      declineCategory: null,
      OR: [
        { dunningClaimedAt: null },
        { dunningClaimedAt: { lt: new Date(now.getTime() - DUNNING_CLAIM_LEASE_MS) } },
      ],
    },
    data: { dunningClaimedAt: now },
  });
  if (claimed.count === 0) {
    return; // a concurrent invocation holds the claim (or processing finished)
  }

  const settings = await getSetting(contract.shopId, "dunning");
  const info = categorizeDeclineCode(attempt.errorCode);

  // A CHALLENGED attempt failing here is the 3DS outcome — fold it into the
  // stored evidence blob so the challenge history stays on the attempt.
  const wasChallenged =
    attempt.status === "CHALLENGED" || hasThreeDsEvidence(attempt.mitEvidence);
  await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "FAILED",
      completedAt: attempt.completedAt ?? now,
      ...(wasChallenged
        ? {
            mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
              challenged: true,
              resolution: "FAILED",
              resolvedAt: now.toISOString(),
            }),
          }
        : {}),
    },
  });

  // Late failure for a cycle that already succeeded (e.g. an abandoned 3DS
  // challenge expiring days after a retry recovered the cycle): record the
  // attempt outcome above, but never open/extend a case, never bump the
  // failure counter, never email a customer who already paid.
  const cycleSucceeded = await prisma.billingAttempt.findFirst({
    where: {
      contractId: contract.id,
      cycleIndex: attempt.cycleIndex,
      status: "SUCCESS",
    },
    select: { id: true },
  });
  if (cycleSucceeded) {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: { declineCategory: info.category },
    });
    await logEvent({
      ...eventBase(contract),
      type: "billing.attempt_failed",
      source: "WEBHOOK",
      payload: {
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        attemptNumber: attempt.attemptNumber,
        // outcome/superseded discriminate the overloaded event type: this is
        // a REAL decline, but for a cycle that already PAID — event-derived
        // failure features must be able to skip it (the webhook handler
        // already logged the raw failure for the attempt itself).
        outcome: "FAILED",
        superseded: true,
        reason: "cycle_already_succeeded",
      },
    });
    return;
  }

  const kase = await ensureOpenCase(attempt, info.category, "WEBHOOK");

  if (attempt.attemptNumber > 1) {
    // attemptId-keyed dedupe, the mirror of retry_succeeded's: the engine is
    // deliberately re-driven after a crash (webhook redelivery / settlement
    // redrive once the lease expires) and the event log is immutable —
    // without the check every re-drive would append another retry_failed for
    // the same attempt and permanently skew event-derived retry features.
    const alreadyLogged = await prisma.subscriberEvent.findFirst({
      where: {
        contractId: contract.id,
        type: "dunning.retry_failed",
        payload: { path: ["attemptId"], equals: attempt.id },
      },
      select: { id: true },
    });
    if (!alreadyLogged) {
      await logEvent({
        ...eventBase(contract),
        type: "dunning.retry_failed",
        source: "WEBHOOK",
        payload: {
          dunningCaseId: kase.id,
          attemptId: attempt.id,
          cycleIndex: attempt.cycleIndex,
          attemptNumber: attempt.attemptNumber,
          declineCode: attempt.errorCode ?? null,
          declineCategory: info.category,
          usedBackupPayment: attempt.usedBackupPayment,
        },
      });
    }
  }

  if (info.category === "SOFT") {
    await handleSoftFailure(attempt, kase, info, settings, now);
  } else if (info.category === "AUTH_REQUIRED") {
    await handleAuthRequiredFailure(attempt, kase, info, now);
  } else {
    await handleHardFailure(attempt, kase, info, now);
  }

  // Processing-complete marker — written last (see JSDoc) — with the failure
  // counter committing in the SAME transaction, gated on the marker still
  // being null. Every step above is re-drivable after a crash, but only the
  // run that actually stamps declineCategory moves consecutiveFailures: the
  // entry lease closed the CONCURRENT double-increment (see schema.prisma on
  // dunningClaimedAt); this closes the crash-redrive variant, where an
  // unguarded increment ahead of the marker counted the same failure twice
  // whenever the engine died between the two writes.
  await prisma.$transaction(async (tx) => {
    const marked = await tx.billingAttempt.updateMany({
      where: { id: attempt.id, declineCategory: null },
      data: { declineCategory: info.category },
    });
    if (marked.count === 1) {
      await tx.subscriptionContract.update({
        where: { id: contract.id },
        data: { consecutiveFailures: { increment: 1 } },
      });
    }
  });
}

/**
 * SOFT: schedule the next rung of the retry ladder (offsets from the first
 * failure = case.openedAt, payday-aligned), trying the backup card before
 * retry #2+, or exhaust when the ladder has no rungs left. When the failed
 * attempt was already the backup card, the contract is pointed back at the
 * original instrument first — the remaining payday-aligned rungs must charge
 * the card most likely to recover (the original), not hammer a dead backup.
 */
async function handleSoftFailure(
  attempt: AttemptFull,
  kase: DunningCase,
  info: DeclineCodeInfo,
  settings: DunningSettings,
  now: Date,
): Promise<void> {
  const contract = attempt.contract;
  const tz = contract.shop.ianaTimezone;

  // One-way-backup fix: the backup was tried and failed too — restore the
  // original card for the rest of the ladder before scheduling anything.
  if (attempt.usedBackupPayment) {
    await revertToOriginalPaymentMethod(contract, kase, attempt.cycleIndex);
  }

  // Retries already burned this cycle (context for the event payload; rung
  // selection itself is time-anchored and doesn't depend on this count).
  const priorFailures = await prisma.billingAttempt.count({
    where: {
      contractId: contract.id,
      cycleIndex: attempt.cycleIndex,
      status: "FAILED",
      id: { not: attempt.id },
    },
  });
  const nextOffsetDays = selectNextRetryOffsetDays(
    settings.softRetryDays,
    kase.openedAt,
    now,
    tz,
  );

  if (nextOffsetDays === undefined) {
    await prisma.dunningCase.update({
      where: { id: kase.id },
      data: {
        declineCode: attempt.errorCode ?? kase.declineCode,
        declineCategory: "SOFT",
      },
    });
    await exhaustCase(kase, contract, "WEBHOOK");
    return;
  }

  const retryNumber = priorFailures + 1; // the retry we are about to schedule
  let viaBackup = false;
  let paydayAligned = false;
  let nextRetryAt: Date;

  // Backup payment fallback: before scheduling retry #2+, switch to the backup
  // card (if configured and not yet tried this cycle) and retry almost
  // immediately — a different instrument beats waiting out the ladder.
  if (
    retryNumber >= 2 &&
    settings.backupPaymentFallback &&
    contract.backupPaymentMethodId &&
    contract.backupPaymentMethodId !== contract.paymentMethodId
  ) {
    const backupTried =
      (await prisma.billingAttempt.count({
        where: {
          contractId: contract.id,
          cycleIndex: attempt.cycleIndex,
          usedBackupPayment: true,
        },
      })) > 0;
    if (!backupTried) {
      try {
        // The id being replaced must survive somewhere durable BEFORE the
        // switch: both contract pointers are equal afterwards ("on backup"),
        // so the case column is what the revert reads. Cases opened before
        // the column existed (null) get it stamped here with the precise
        // pre-switch instrument; newer cases already carry their case-open
        // snapshot from ensureOpenCase.
        const previousPaymentMethodId = contract.paymentMethodId;
        if (kase.originalPaymentMethodId == null && previousPaymentMethodId) {
          await prisma.dunningCase.update({
            where: { id: kase.id },
            data: { originalPaymentMethodId: previousPaymentMethodId },
          });
          kase.originalPaymentMethodId = previousPaymentMethodId;
        }
        // The switch syncs the in-memory contract onto the backup card
        // (pointer + card mirror) — the event payload below must carry the
        // id captured BEFORE it.
        await changePaymentMethodToBackup(contract);
        viaBackup = true;
        await logEvent({
          ...eventBase(contract),
          type: "dunning.backup_used",
          source: "WEBHOOK",
          payload: {
            dunningCaseId: kase.id,
            cycleIndex: attempt.cycleIndex,
            backupPaymentMethodId: contract.backupPaymentMethodId,
            previousPaymentMethodId,
          },
        });
        // The instrument the renewals charge just changed — tell the customer
        // (trust: never silently bill a different card).
        await notifyPaymentMethodChanged(contract);
      } catch (err) {
        // Switch failed — fall back to the normal ladder on the original card.
        console.error(
          "[dunning] backup payment switch failed",
          contract.id,
          err,
        );
      }
    }
  }

  if (viaBackup) {
    nextRetryAt = new Date(now.getTime() + BACKUP_RETRY_DELAY_MS);
  } else {
    const candidate = addDaysTz(kase.openedAt, nextOffsetDays, tz);
    let aligned = candidate;
    if (settings.paydayAlign) {
      aligned = alignToPayday(
        candidate,
        tz,
        settings.paydaysOfMonth,
        settings.paydaySnapWindowDays,
      );
      paydayAligned = aligned.getTime() !== candidate.getTime();
    }
    nextRetryAt = aligned;
  }

  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "RETRYING",
      nextRetryAt,
      paydayAligned,
      declineCode: attempt.errorCode ?? kase.declineCode,
      declineCategory: "SOFT",
    },
  });
  await logEvent({
    ...eventBase(contract),
    type: "dunning.retry_scheduled",
    source: "WEBHOOK",
    payload: {
      dunningCaseId: kase.id,
      cycleIndex: attempt.cycleIndex,
      retryNumber,
      offsetDays: viaBackup ? null : nextOffsetDays,
      nextRetryAt: nextRetryAt.toISOString(),
      paydayAligned,
      viaBackup,
      declineCode: attempt.errorCode ?? null,
      declineHuman: info.description,
    },
  });
}

/**
 * Restore the original payment method after the backup card ALSO failed. The
 * switch keeps both pointers equal (paymentMethodId = backupPaymentMethodId
 * marks "on backup"), so the original id must come from elsewhere: the case's
 * originalPaymentMethodId column first (stamped at case-open and refreshed at
 * switch time for pre-column cases — a real column, durable by construction),
 * then the dunning.backup_used event payload for legacy cases predating the
 * column. The event alone used to be the ONLY copy, and it rides logEvent's
 * never-throw contract — one swallowed insert stranded every remaining ladder
 * rung on the dead backup card. Best-effort: a failure here leaves the ladder
 * on the backup card, which is the old behavior.
 */
async function revertToOriginalPaymentMethod(
  contract: ContractWithShop,
  kase: DunningCase,
  cycleIndex: number,
): Promise<void> {
  try {
    if (contract.paymentMethodId !== contract.backupPaymentMethodId) {
      return; // not on the backup — nothing to revert
    }
    let originalId =
      kase.originalPaymentMethodId !== contract.paymentMethodId
        ? kase.originalPaymentMethodId
        : null;
    if (!originalId) {
      const switchEvent = await prisma.subscriberEvent.findFirst({
        where: {
          contractId: contract.id,
          type: "dunning.backup_used",
          createdAt: { gte: kase.openedAt },
        },
        orderBy: { createdAt: "desc" },
        select: { payload: true },
      });
      const payload = (switchEvent?.payload ?? {}) as Record<string, unknown>;
      originalId =
        typeof payload.previousPaymentMethodId === "string"
          ? payload.previousPaymentMethodId
          : null;
    }
    if (!originalId || originalId === contract.paymentMethodId) return;

    const admin = await adminClientForShop(contract.shop.domain);
    await withContractDraft(
      admin,
      contract.shopifyContractId,
      async (draftId, run) => {
        await draftUpdatePaymentMethod(run, draftId, originalId);
      },
    );
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { paymentMethodId: originalId },
    });
    await refreshCardMirror(contract, originalId);
    // Keep the in-memory contract consistent for the rest of this handler.
    contract.paymentMethodId = originalId;
    await logEvent({
      ...eventBase(contract),
      type: "dunning.backup_reverted",
      source: "WEBHOOK",
      payload: {
        dunningCaseId: kase.id,
        cycleIndex,
        restoredPaymentMethodId: originalId,
        failedBackupPaymentMethodId: contract.backupPaymentMethodId,
      },
    });
  } catch (err) {
    console.error("[dunning] backup revert failed", contract.id, err);
  }
}

/**
 * Best-effort mirror refresh of card metadata for the given method — DB row
 * AND the in-memory contract, so notifications sent later in the same handler
 * (notifyPaymentMethodChanged, failure emails) describe the card actually
 * being charged rather than the instrument that just failed. A failed refresh
 * leaves both untouched (the old behavior).
 */
async function refreshCardMirror(
  contract: ContractWithShop,
  paymentMethodId: string,
): Promise<void> {
  try {
    const admin = await adminClientForShop(contract.shop.domain);
    const methods = await listCustomerPaymentMethods(admin, contract.customerId);
    const method = methods.find((m) => m.id === paymentMethodId);
    if (!method?.instrument) return;
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        cardBrand: method.instrument.brand,
        cardLast4: method.instrument.lastDigits,
        cardExpiryMonth: method.instrument.expiryMonth,
        cardExpiryYear: method.instrument.expiryYear,
      },
    });
    contract.cardBrand = method.instrument.brand;
    contract.cardLast4 = method.instrument.lastDigits;
    contract.cardExpiryMonth = method.instrument.expiryMonth;
    contract.cardExpiryYear = method.instrument.expiryYear;
  } catch (err) {
    console.error("[dunning] card mirror refresh failed", contract.id, err);
  }
}

/**
 * Notify the customer that renewals now charge a different stored card. Reads
 * the contract's mirrored card fields, so it must run AFTER
 * changePaymentMethodToBackup (which syncs the in-memory contract via
 * refreshCardMirror) — the whole point of this email is naming the card
 * actually being charged, never the one that just failed.
 */
async function notifyPaymentMethodChanged(
  contract: ContractWithShop,
): Promise<void> {
  try {
    await sendNotification({
      shopId: contract.shopId,
      contractId: contract.id,
      template: "payment_method_updated",
      vars: {
        card_brand: contract.cardBrand ?? "",
        card_last4: contract.cardLast4 ?? "",
        via_backup: true,
      },
    });
  } catch (err) {
    console.error(
      "[dunning] payment-method-changed notification failed",
      contract.id,
      err,
    );
  }
}

/**
 * Send one webhook-driven dunning notification AT MOST ONCE per dedupe key.
 *
 * Same persistent-dedupe pattern as the sweep ladder (sendLadderNotification)
 * and the pre-expiry notices: the key is stamped into the notification vars
 * (`dunning_dedupe`), lands in NotificationLog with the SENT row, and is
 * checked before any send. The emailsSent/lastNotifiedAt cursor on the case
 * is only committed AFTER the send, so a crash between the send and the
 * cursor write used to leave a window where the webhook redelivery (or the
 * day-0 ladder rung) sent the same "payment failed" email twice. With the
 * log check, re-entry finds the SENT row and returns "DUPLICATE" — the
 * caller advances the cursor without emailing the customer again.
 *
 * A SUPPRESSED or FAILED send writes no SENT row, so those retry naturally.
 */
async function sendCaseNotificationOnce(
  contract: { id: string; shopId: string },
  template: TemplateKey,
  dedupeKey: string,
  vars: Record<string, unknown>,
): Promise<"SENT" | "SUPPRESSED" | "FAILED" | "DUPLICATE"> {
  const alreadySent = await prisma.notificationLog.findFirst({
    where: {
      contractId: contract.id,
      template,
      status: "SENT",
      payload: { path: ["vars", "dunning_dedupe"], equals: dedupeKey },
    },
    select: { id: true },
  });
  if (alreadySent) return "DUPLICATE";

  const result = await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template,
    vars: { ...vars, dunning_dedupe: dedupeKey },
  });
  return result.status;
}

/**
 * Commit the case-side bookkeeping of a webhook-path notification.
 *
 * ladderCursor is the notification-ladder RUNG CURSOR (migration 0016) and
 * emailsSent is a TRUE sent-count. The two used to be one column: emailsSent
 * doubled as the cursor via Math.max(1, …) writes, which silently dropped
 * every challenge email beyond the first from the count while the
 * dunning.exhausted payload and the failed-payments queue presented it as
 * "emails sent". Pre-0016 cases carry ladderCursor null: the cursor READ
 * falls back to emailsSent (its historical meaning) and the first write here
 * initializes the column.
 *
 * Every webhook-path notice consumes rung 0 — the day-0 "payment failed"
 * slot — so the sweep ladder continues from rung 1, exactly the old
 * Math.max behavior. Counting is exactly-once via an optimistic pin on
 * (ladderCursor, emailsSent) as read:
 *  - SENT always counts (a fresh email really went out — including a second
 *    challenge email later in the case, the send the old write dropped);
 *  - DUPLICATE with rung 0 unconsumed is the crash-replay whose counter
 *    increment died with the cursor write — counted now;
 *  - DUPLICATE after the cursor moved was already counted by whichever path
 *    sent it, and a concurrent writer that advanced the pin first turns
 *    this write into a no-op instead of a double count;
 *  - SUPPRESSED consumes the rung without counting (nothing was sent).
 * NotificationLog remains the ground truth a drifted counter can be audited
 * against.
 */
async function commitCaseNotificationCursor(
  kase: DunningCase,
  status: "SENT" | "SUPPRESSED" | "DUPLICATE",
  now: Date,
): Promise<void> {
  const cursor = kase.ladderCursor ?? kase.emailsSent;
  const counted = status === "SENT" || (status === "DUPLICATE" && cursor === 0);
  await prisma.dunningCase.updateMany({
    where: {
      id: kase.id,
      ladderCursor: kase.ladderCursor,
      emailsSent: kase.emailsSent,
    },
    data: {
      ladderCursor: Math.max(1, cursor),
      ...(counted ? { emailsSent: { increment: 1 } } : {}),
      lastNotifiedAt: now,
    },
  });
}

/**
 * HARD: no automatic retry can succeed. Park the case on the customer
 * (AWAITING_CUSTOMER) and — when there is something they can actually fix —
 * notify immediately with a one-tap update-card link. Manual-review declines
 * (fraud, test mode, amount-too-small) never email the customer.
 */
async function handleHardFailure(
  attempt: AttemptFull,
  kase: DunningCase,
  info: DeclineCodeInfo,
  now: Date,
): Promise<void> {
  const contract = attempt.contract;

  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "AWAITING_CUSTOMER",
      nextRetryAt: null,
      declineCode: attempt.errorCode ?? kase.declineCode,
      declineCategory: "HARD",
    },
  });
  await logEvent({
    ...eventBase(contract),
    type: "dunning.awaiting_customer",
    source: "WEBHOOK",
    payload: {
      dunningCaseId: kase.id,
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      declineCode: attempt.errorCode ?? null,
      customerAction: info.customerAction,
      manualReview: info.customerAction === "NONE",
      declineHuman: info.description,
    },
  });

  if (info.customerAction === "NONE") return; // nothing the customer can fix

  const ctaUrl = await buildUpdateCardUrl(contract);
  // Counts as email #1 of the ladder, so it deliberately shares the ladder's
  // rung-0 dedupe key (`{caseId}:EMAIL:0`, same template) — whichever of the
  // webhook path and the day-0 sweep rung sends first, the other sees the
  // SENT row and only advances the cursor. Closes the crash window between
  // the send below and the cursor write (webhook redelivery re-enters here).
  const status = await sendCaseNotificationOnce(
    contract,
    "payment_failed_1",
    `${kase.id}:EMAIL:0`,
    {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  );
  if (status !== "FAILED") {
    await commitCaseNotificationCursor(kase, status, now);
  }
}

/**
 * AUTH_REQUIRED failure (no challenge webhook yet): park on AWAITING_3DS and
 * send threeds_action with the update-card fallback link. The real 3DS
 * confirmation link is sent by onBillingAttemptChallenged when Shopify
 * delivers the redirect URL.
 */
async function handleAuthRequiredFailure(
  attempt: AttemptFull,
  kase: DunningCase,
  info: DeclineCodeInfo,
  now: Date,
): Promise<void> {
  const contract = attempt.contract;

  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "AWAITING_3DS",
      nextRetryAt: null,
      declineCode: attempt.errorCode ?? kase.declineCode,
      declineCategory: "AUTH_REQUIRED",
    },
  });

  const ctaUrl = await buildUpdateCardUrl(contract);
  // One fallback notice per case: webhook redelivery (or a crash after the
  // send but before the cursor write below) re-enters here — the dedupe key
  // turns the re-entry into a cursor advance, not a second email. The REAL
  // 3DS link sent by onBillingAttemptChallenged uses a different key: that
  // second threeds_action send is intentional.
  const status = await sendCaseNotificationOnce(
    contract,
    "threeds_action",
    `${kase.id}:THREEDS:fallback`,
    {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  );
  if (status !== "FAILED") {
    await commitCaseNotificationCursor(kase, status, now);
  }
  await logEvent({
    ...eventBase(contract),
    type: "dunning.threeds_link_sent",
    source: "WEBHOOK",
    payload: {
      dunningCaseId: kase.id,
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      fallback: true, // update-card link only; real 3DS url arrives on CHALLENGED
      notificationStatus: status,
    },
  });
}

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_CHALLENGED → the bank wants 3-D Secure.
 * Time-critical: build a CONFIRM_3DS magic link around the redirect URL and
 * notify instantly (threeds_action is a critical template — Klaviyo AND
 * direct SMTP).
 */
export async function onBillingAttemptChallenged(
  attemptLocalId: string,
  redirectUrl?: string,
): Promise<void> {
  const attempt = await loadAttempt(attemptLocalId);
  if (!attempt) return;
  const contract = attempt.contract;
  if (!assertOurContract(contract, "attempt-challenged")) return;
  const now = new Date();

  // Late challenge for a cycle that already succeeded (same guard as the
  // failure path): a stale/replayed CHALLENGED must never open a case or
  // email a 3DS link to a customer whose charge already went through.
  const cycleSucceeded = await prisma.billingAttempt.findFirst({
    where: {
      contractId: contract.id,
      cycleIndex: attempt.cycleIndex,
      status: "SUCCESS",
    },
    select: { id: true },
  });
  if (cycleSucceeded) {
    await logEvent({
      ...eventBase(contract),
      type: "billing.attempt_challenged",
      source: "WEBHOOK",
      payload: {
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        attemptNumber: attempt.attemptNumber,
        superseded: true,
        reason: "cycle_already_succeeded",
      },
    });
    return;
  }

  // Cycle scoping, mirroring the failure path (ensureOpenCase): an open case
  // is only REUSED when it is anchored to THIS attempt's billing cycle
  // (legacy cases without a trigger attempt count as any-cycle). A challenge
  // on cycle N must never hijack an open case for an older cycle M — flipping
  // that case to AWAITING_3DS with nextRetryAt null would silently cancel
  // cycle M's scheduled retry, and the case's stale openedAt anchor would let
  // the sweep's cancelAfterFailedDays timeout exhaust it while the customer
  // is mid-3DS on cycle N (with the 3DS success then closing the case
  // CUSTOMER_FIXED and stranding cycle M behind the scheduler's b2 guard).
  // A cross-cycle case instead falls through to ensureOpenCase below, which
  // supersedes it (dunning.case_superseded) and opens a fresh cycle-anchored
  // case with a fresh openedAt — exactly like a cross-cycle failure.
  const existing = await findOpenCase(contract.id);
  const existingCycle = existing ? await caseCycleIndex(existing) : null;
  const sameCycleCase =
    existing && (existingCycle == null || existingCycle === attempt.cycleIndex)
      ? existing
      : null;
  if (attempt.status === "CHALLENGED" && sameCycleCase?.state === "AWAITING_3DS") {
    return; // webhook redelivery — link already sent
  }

  // Guarded like the callers' claims: only a PENDING or already-CHALLENGED
  // attempt may (re)enter CHALLENGED — a settled attempt is never resurrected.
  //
  // The ATTEMPT's declineCategory is deliberately NOT written here: that
  // column is onBillingAttemptFailed's written-LAST "processing complete"
  // marker (its early-return guard and atomic entry claim both key on it).
  // Stamping AUTH_REQUIRED at challenge time made every challenged attempt's
  // later FAILURE webhook look like an already-processed redelivery — the
  // engine never ran, no retry ladder was scheduled for recoverable post-3DS
  // declines, consecutiveFailures never moved, and the settlement_redrive
  // FAILED arm (declineCategory-NULL filter) could not repair the row either;
  // the cycle just sat held until cancelAfterFailedDays exhausted the case.
  // The CASE's declineCategory (below) and the mitEvidence fold carry the
  // challenge state; the attempt column stays null until the failure engine
  // has truly finished.
  const claimed = await prisma.billingAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["PENDING", "CHALLENGED"] } },
    data: {
      status: "CHALLENGED",
      // Fold the 3DS challenge into the stored-credential evidence blob.
      mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
        challenged: true,
        redirectIssued: redirectUrl != null,
        challengedAt: now.toISOString(),
        resolution: "PENDING_CUSTOMER_ACTION",
      }),
    },
  });
  if (claimed.count === 0) return; // settled concurrently — nothing to dun

  const kase =
    sameCycleCase ?? (await ensureOpenCase(attempt, "AUTH_REQUIRED", "WEBHOOK"));
  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "AWAITING_3DS",
      nextRetryAt: null,
      declineCategory: "AUTH_REQUIRED",
    },
  });

  let ctaUrl: string | null = null;
  try {
    ctaUrl = await buildMagicUrl({
      action: "CONFIRM_3DS",
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      params: { redirectUrl: redirectUrl ?? null },
      ttlSeconds: CONFIRM_3DS_TTL_SECONDS,
      maxUses: CONFIRM_3DS_MAX_USES,
      createdVia: "DUNNING",
    });
  } catch (err) {
    console.error("[dunning] CONFIRM_3DS magic link failed", contract.id, err);
    ctaUrl = await buildUpdateCardUrl(contract);
  }

  const info = categorizeDeclineCode("AUTHENTICATION_ERROR");
  // Keyed per ATTEMPT: a redelivered CHALLENGED webhook (the early-return
  // guard above misses the crash-after-send-before-cursor-write replay,
  // because attempt/case state was already committed before the send) finds
  // the SENT row and only advances the cursor — while a NEW attempt being
  // challenged later in the same case still sends its own fresh link.
  const status = await sendCaseNotificationOnce(
    contract,
    "threeds_action",
    `${kase.id}:THREEDS:challenge:${attempt.id}`,
    {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  );
  if (status !== "FAILED") {
    // Attempt-keyed dedupe means a SECOND challenge later in the case sends
    // a real fresh email — the count-every-SENT rule in the commit helper is
    // what finally counts it.
    await commitCaseNotificationCursor(kase, status, now);
  }

  await logEvent({
    ...eventBase(contract),
    type: "billing.attempt_challenged",
    source: "WEBHOOK",
    payload: {
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      attemptNumber: attempt.attemptNumber,
      hasRedirectUrl: redirectUrl != null,
    },
  });
  await logEvent({
    ...eventBase(contract),
    type: "dunning.threeds_link_sent",
    source: "WEBHOOK",
    payload: {
      dunningCaseId: kase.id,
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      fallback: false,
      maxUses: CONFIRM_3DS_MAX_USES,
      ttlDays: CONFIRM_3DS_TTL_SECONDS / 86400,
      notificationStatus: status,
    },
  });
}

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS → close the matching open case as
 * recovered, reset the failure counter and reactivate a FAILED contract.
 *
 * Cycle scoping: a success only resolves a case anchored to the SAME billing
 * cycle. A newer cycle succeeding while an older cycle's case still has a
 * scheduled retry leaves that case alone (the old cycle's revenue is still
 * being chased — closing it would book the ordinary renewal as "recovered"
 * and cancel the pending retry, silently losing a full cycle). An awaiting
 * (no-scheduled-retry) case is closed as CUSTOMER_FIXED with no recovered
 * amount: the instrument clearly works again, but no failed cycle's money
 * was actually collected.
 */
export async function onBillingAttemptSucceeded(
  attemptLocalId: string,
): Promise<void> {
  const attempt = await loadAttempt(attemptLocalId);
  if (!attempt) return;
  const contract = attempt.contract;
  if (!assertOurContract(contract, "attempt-succeeded")) return;
  const now = new Date();

  // A CHALLENGED attempt succeeding means the customer passed 3DS — fold the
  // outcome into the stored evidence blob REGARDLESS of the attempt's current
  // status: every live call path reaches this hook only AFTER a claim
  // transaction already stamped SUCCESS (finishSuccessSettlement runs
  // post-claim, and neither claim writer touches mitEvidence), so a fold
  // gated on status !== "SUCCESS" would never run and every passed challenge
  // stayed frozen at PENDING_CUSTOMER_ACTION — breaking the mit-evidence
  // contract ("the challenge/resolution path folds the 3DS outcome back into
  // it") on exactly the charges that DID authenticate. An already-SUCCEEDED
  // resolution is left untouched so settlement redrives never restamp
  // resolvedAt; a recorded FAILED is overwritten — the settled SUCCESS is
  // Shopify's final answer for the attempt.
  const wasChallenged =
    attempt.status === "CHALLENGED" || hasThreeDsEvidence(attempt.mitEvidence);
  const foldedEvidence =
    wasChallenged && threeDsResolution(attempt.mitEvidence) !== "SUCCEEDED"
      ? withThreeDsOutcome(attempt.mitEvidence, {
          challenged: true,
          resolution: "SUCCEEDED",
          resolvedAt: now.toISOString(),
        })
      : null;
  if (attempt.status !== "SUCCESS") {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "SUCCESS",
        completedAt: attempt.completedAt ?? now,
        ...(foldedEvidence ? { mitEvidence: foldedEvidence } : {}),
      },
    });
  } else if (foldedEvidence) {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: { mitEvidence: foldedEvidence },
    });
  }

  let kase = await findOpenCase(contract.id);
  let resolution: string | null = null;
  if (kase) {
    const kaseCycle = await caseCycleIndex(kase);
    const sameCycle = kaseCycle == null || kaseCycle === attempt.cycleIndex;
    if (sameCycle) {
      const retriesForCycle = await prisma.billingAttempt.count({
        where: {
          contractId: contract.id,
          cycleIndex: attempt.cycleIndex,
          originatingAction: "DUNNING_RETRY",
        },
      });
      resolution =
        attempt.attemptNumber > 1 || retriesForCycle > 0
          ? "RECOVERED"
          : "CUSTOMER_FIXED";
      await prisma.dunningCase.update({
        where: { id: kase.id },
        data: {
          state: "RECOVERED",
          resolvedAt: now,
          resolution,
          recoveredAttemptId: attempt.id,
          recoveredCents: attempt.amountCents,
          nextRetryAt: null,
        },
      });
    } else if (kase.state === "RETRYING" && kase.nextRetryAt != null) {
      // Different (older) cycle with a live retry schedule: leave the case
      // open — its own retry outcome decides recovery. Never book this
      // cycle's ordinary renewal as recovered money for that one.
      kase = null;
    } else {
      // Awaiting the customer with no scheduled retry: the newer cycle
      // charging proves the payment method is fixed. Close without claiming
      // recovered revenue (the old cycle was never collected).
      resolution = "CUSTOMER_FIXED";
      await prisma.dunningCase.update({
        where: { id: kase.id },
        data: {
          state: "RECOVERED",
          resolvedAt: now,
          resolution,
          recoveredAttemptId: attempt.id,
          recoveredCents: null,
          nextRetryAt: null,
        },
      });
    }
  }

  if (contract.consecutiveFailures !== 0) {
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { consecutiveFailures: 0 },
    });
  }

  if (contract.status === "FAILED") {
    try {
      const admin = await adminClientForShop(contract.shop.domain);
      await contractActivate(admin, contract.shopifyContractId);
      await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { status: "ACTIVE", failedAt: null },
      });
      await logEvent({
        ...eventBase(contract),
        type: "contract.activated",
        source: "WEBHOOK",
        payload: { reason: "dunning_recovered", attemptId: attempt.id },
      });
    } catch (err) {
      console.error(
        "[dunning] reactivation after recovery failed",
        contract.id,
        err,
      );
    }
  }

  if (kase) {
    await logEvent({
      ...eventBase(contract),
      type: "dunning.recovered",
      source: "WEBHOOK",
      payload: {
        dunningCaseId: kase.id,
        resolution,
        recoveredAttemptId: attempt.id,
        recoveredCents: attempt.amountCents,
        currencyCode: attempt.currencyCode ?? contract.currencyCode,
        cycleIndex: attempt.cycleIndex,
        attemptNumber: attempt.attemptNumber,
        usedBackupPayment: attempt.usedBackupPayment,
        daysOpen: Math.floor((now.getTime() - kase.openedAt.getTime()) / DAY_MS),
      },
    });
  }
  if (attempt.attemptNumber > 1) {
    // attemptId-keyed dedupe: the success settlement re-drives this hook when
    // a crash separated the claim from the settledAt marker (see
    // finishSuccessSettlement in webhooks/handlers.server.ts). The case
    // update above is naturally guarded by findOpenCase; this event is not —
    // without the check a redrive would double-log the retry recovery.
    const alreadyLogged = await prisma.subscriberEvent.findFirst({
      where: {
        contractId: contract.id,
        type: "dunning.retry_succeeded",
        payload: { path: ["attemptId"], equals: attempt.id },
      },
      select: { id: true },
    });
    if (!alreadyLogged) {
      await logEvent({
        ...eventBase(contract),
        type: "dunning.retry_succeeded",
        source: "WEBHOOK",
        payload: {
          attemptId: attempt.id,
          cycleIndex: attempt.cycleIndex,
          attemptNumber: attempt.attemptNumber,
          usedBackupPayment: attempt.usedBackupPayment,
        },
      });
    }
  }
}

/**
 * CUSTOMERS_PAYMENT_METHOD webhooks → the customer fixed their card. Cases
 * waiting on them (AWAITING_CUSTOMER / AWAITING_3DS) get an immediate retry.
 * A contract that was already FAILED by an exhausted PAUSE ladder gets its
 * newest EXHAUSTED case reopened so the retry → success path can reactivate it.
 */
export async function onPaymentMethodUpdated(
  contractLocalId: string,
): Promise<void> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { shop: true },
  });
  if (!contract) {
    console.error("[dunning] contract not found", contractLocalId);
    return;
  }
  if (!assertOurContract(contract, "payment-method-updated")) return;
  const now = new Date();

  let kase = await findOpenCase(contract.id);
  let reopened = false;
  if (!kase && contract.status === "FAILED") {
    const exhausted = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, state: "EXHAUSTED" },
      orderBy: { openedAt: "desc" },
    });
    if (exhausted) {
      kase = exhausted;
      reopened = true;
    }
  }
  if (!kase) return;
  if (
    !reopened &&
    kase.state !== "AWAITING_CUSTOMER" &&
    kase.state !== "AWAITING_3DS"
  ) {
    return; // RETRYING cases already have a schedule; recovery closes the rest
  }

  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "RETRYING",
      nextRetryAt: now,
      ...(reopened ? { resolvedAt: null, resolution: null } : {}),
    },
  });
  await logEvent({
    ...eventBase(contract),
    type: "dunning.retry_scheduled",
    source: "WEBHOOK",
    payload: {
      dunningCaseId: kase.id,
      trigger: "payment_method_updated",
      immediate: true,
      reopened,
      nextRetryAt: now.toISOString(),
    },
  });
}

// ── Exhaustion ───────────────────────────────────────────────────────────────

/**
 * The ladder has no rungs left (or an awaiting case timed out). Per
 * settings.dunning.exhaustedAction:
 *  - PAUSE  → subscriptionContractFail + local FAILED: renewals stop and the
 *             portal shows the fix-payment banner; onPaymentMethodUpdated can
 *             still resurrect the case later.
 *  - CANCEL → cancelContract(reason PAYMENT_FAILED, source DUNNING) via the
 *             contracts service, which also schedules win-back.
 */
export async function exhaustCase(
  kase: DunningCase,
  contract: ContractWithShop,
  source: EventSource = "SCHEDULER",
): Promise<void> {
  const settings = await getSetting(contract.shopId, "dunning");
  const now = new Date();

  if (settings.exhaustedAction === "CANCEL") {
    // Lazy import: the contracts service is a sibling module; loading it at
    // call time keeps the module graphs decoupled.
    const contractsService = (await import(
      "~/lib/contracts/service.server"
    )) as unknown as { cancelContract: CancelContractFn };
    await contractsService.cancelContract(
      contract.shop.domain,
      contract.id,
      "PAYMENT_FAILED",
      { source, cancelSource: "DUNNING" },
    );
    // cancelContract mirrors status locally, logs contract.cancelled and
    // schedules win-back — nothing more to do here.
  } else if (contract.status !== "FAILED") {
    const admin = await adminClientForShop(contract.shop.domain);
    await contractFail(admin, contract.shopifyContractId);
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { status: "FAILED", failedAt: now },
    });
    await logEvent({
      ...eventBase(contract),
      type: "contract.failed",
      source,
      payload: { reason: "dunning_exhausted", dunningCaseId: kase.id },
    });
  }

  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: {
      state: "EXHAUSTED",
      resolvedAt: now,
      resolution: "EXHAUSTED",
      nextRetryAt: null,
    },
  });
  await logEvent({
    ...eventBase(contract),
    type: "dunning.exhausted",
    source,
    payload: {
      dunningCaseId: kase.id,
      action: settings.exhaustedAction,
      declineCode: kase.declineCode,
      declineCategory: kase.declineCategory,
      ladderStep: kase.ladderStep,
      // emailsSent is the TRUE sent-count and ladderCursor the notification
      // rung position (they used to be one conflated column — see
      // commitCaseNotificationCursor). ladderCursor null = pre-0016 case
      // whose emailsSent still carries the old cursor meaning.
      emailsSent: kase.emailsSent,
      ladderCursor: kase.ladderCursor,
      smsSent: kase.smsSent,
      // The money this exhaustion walks away from (case-open estimate).
      amountAtRiskCents: kase.amountAtRiskCents,
      currencyCode: kase.amountAtRiskCurrencyCode,
      openedAt: kase.openedAt.toISOString(),
      daysOpen: Math.floor((now.getTime() - kase.openedAt.getTime()) / DAY_MS),
    },
  });
}

// ── Sweep (jobs entrypoint) ──────────────────────────────────────────────────

/**
 * Periodic dunning sweep. Phases (order matters):
 *  (d) auto-close cases whose contract was cancelled/expired elsewhere;
 *  (a) fire due retries (RETRYING with nextRetryAt <= now) as new
 *      BillingAttempts with strict idempotency keys;
 *  (c) exhaust AWAITING_CUSTOMER / AWAITING_3DS cases older than
 *      settings.cancelAfterFailedDays;
 *  (b) advance the notification ladder (emails at emailLadderDays offsets,
 *      one SMS at smsDay).
 * Every phase is per-case fault-isolated: one bad case never blocks the rest.
 */
export async function runDunningSweep(
  now: Date = new Date(),
): Promise<DunningSweepStats> {
  const stats = emptyStats();
  const settingsCache = new Map<string, DunningSettings>();
  const adminCache = new Map<string, AdminClient>();

  const dunningSettings = async (shopId: string): Promise<DunningSettings> => {
    const cached = settingsCache.get(shopId);
    if (cached) return cached;
    const settings = await getSetting(shopId, "dunning");
    settingsCache.set(shopId, settings);
    return settings;
  };
  const adminFor = async (domain: string): Promise<AdminClient> => {
    const cached = adminCache.get(domain);
    if (cached) return cached;
    const admin = await adminClientForShop(domain);
    adminCache.set(domain, admin);
    return admin;
  };

  const openCases = await prisma.dunningCase.findMany({
    // `contract: OURS_ONLY` — a case can only exist for one of our contracts
    // (ensureOpenCase is gated), but a shop that upgraded before the ownership
    // column existed can carry legacy cases on contracts later reclassified as
    // another app's. The sweep retries charges and emails customers, so it
    // re-checks rather than trusting the case row.
    where: { state: { in: OPEN_CASE_STATES }, contract: { ...OURS_ONLY } },
    include: { contract: { include: { shop: true, lines: true } } },
    orderBy: { openedAt: "asc" },
  });
  stats.processed = openCases.length;
  const closed = new Set<string>();

  // (d) Auto-close: the contract died elsewhere (voluntary cancel, expiry).
  // The contract.cancelled event was already logged by whoever cancelled it.
  for (const kase of openCases) {
    if (
      kase.contract.status !== "CANCELLED" &&
      kase.contract.status !== "EXPIRED"
    ) {
      continue;
    }
    try {
      await prisma.dunningCase.update({
        where: { id: kase.id },
        data: {
          state: "CANCELLED",
          resolvedAt: now,
          resolution: "CANCELLED",
          nextRetryAt: null,
        },
      });
      closed.add(kase.id);
    } catch (err) {
      console.error("[dunning] sweep auto-close failed", kase.id, err);
    }
  }

  // (a) Fire due retries.
  for (const kase of openCases) {
    if (closed.has(kase.id)) continue;
    if (kase.state !== "RETRYING") continue;
    if (!kase.nextRetryAt || kase.nextRetryAt > now) continue;
    if (kase.contract.status === "PAUSED") continue; // resume re-enters billing
    try {
      await fireRetry(kase, now, adminFor, stats);
    } catch (err) {
      console.error("[dunning] sweep retry failed", kase.id, err);
    }
  }

  // (c) Exhaust awaiting cases the customer never fixed.
  for (const kase of openCases) {
    if (closed.has(kase.id)) continue;
    if (kase.state !== "AWAITING_CUSTOMER" && kase.state !== "AWAITING_3DS") {
      continue;
    }
    // A customer who chose "pause instead" (the ladder emails' pause link,
    // v1.24.0) froze the whole dunning clock, not just retries and emails —
    // exhausting a paused contract to FAILED would punish exactly the
    // customer who took the soft landing we offered. The case parks; after
    // resume the window continues from where it stood.
    if (kase.contract.status === "PAUSED") continue;
    try {
      const settings = await dunningSettings(kase.contract.shopId);
      const daysOpen = Math.floor(
        (now.getTime() - kase.openedAt.getTime()) / DAY_MS,
      );
      if (daysOpen < settings.cancelAfterFailedDays) continue;
      if (kase.state === "AWAITING_3DS") {
        // A 3DS outcome only ever arrives by webhook (the CONFIRM_3DS magic
        // link just redirects to the bank), so a lost SUCCESS webhook would
        // leave this case to time out here — failing or cancelling a
        // contract whose charge actually went through, with the paid cycle
        // never recorded. One last Shopify re-check before the irreversible
        // step: a resolved outcome re-enters the engine through the normal
        // hooks (a success settles the attempt and closes the case as
        // recovered; a failure reschedules or exhausts it with the REAL
        // decline code), so either way this sweep pass no longer owns the
        // case. Only an unresolved re-check falls through to the timeout.
        const outcome = await recheckAwaiting3ds(kase);
        if (outcome === "SUCCESS" || outcome === "FAILED") {
          closed.add(kase.id);
          continue;
        }
      }
      await exhaustCase(kase, kase.contract, "SCHEDULER");
      closed.add(kase.id);
      stats.exhausted += 1;
    } catch (err) {
      console.error("[dunning] sweep exhaustion failed", kase.id, err);
    }
  }

  // (b) Notification ladder.
  for (const kase of openCases) {
    if (closed.has(kase.id)) continue;
    const contract = kase.contract;
    if (contract.status !== "ACTIVE" && contract.status !== "FAILED") continue;

    const info = categorizeDeclineCode(kase.declineCode);
    if (kase.declineCategory === "HARD" && info.customerAction === "NONE") {
      continue; // manual-review declines (fraud/test/config): never nag the customer
    }

    try {
      const settings = await dunningSettings(contract.shopId);
      const daysSinceOpen = Math.floor(
        (now.getTime() - kase.openedAt.getTime()) / DAY_MS,
      );

      // Email rung N is due when daysSinceOpen >= emailLadderDays[N] and the
      // rung cursor sits at N. ladderCursor is that cursor (migration 0016);
      // pre-0016 cases carry null and fall back to emailsSent, which WAS the
      // cursor before it became a true sent-count — the advance below
      // initializes the column. (Cursor/count split: see
      // commitCaseNotificationCursor.)
      const rung = kase.ladderCursor ?? kase.emailsSent;
      const dueDay = settings.emailLadderDays.at(rung);
      if (dueDay !== undefined && daysSinceOpen >= dueDay) {
        const status = await sendLadderNotification(
          kase,
          info,
          daysSinceOpen,
          "EMAIL",
          rung,
        );
        if (status === "SENT") stats.emailsSent += 1;
        if (status !== "FAILED") {
          // SENT advances; SUPPRESSED (channel off) also advances so a
          // disabled channel doesn't spam retries; FAILED retries next sweep.
          // The sent-count increments exactly-once via the same optimistic
          // pin the webhook paths use: only the writer that moves the cursor
          // off rung N counts rung N's email (a DUPLICATE here is the
          // crash-replay whose count died with the cursor write; SUPPRESSED
          // sent nothing).
          await prisma.dunningCase.updateMany({
            where: {
              id: kase.id,
              ladderCursor: kase.ladderCursor,
              emailsSent: kase.emailsSent,
            },
            data: {
              ladderCursor: rung + 1,
              ...(status !== "SUPPRESSED"
                ? { emailsSent: { increment: 1 } }
                : {}),
              lastNotifiedAt: now,
            },
          });
        }
      }

      // Single SMS at smsDay.
      if (
        kase.smsSent === 0 &&
        daysSinceOpen >= settings.smsDay &&
        contract.phone
      ) {
        const status = await sendLadderNotification(
          kase,
          info,
          daysSinceOpen,
          "SMS",
          0,
        );
        if (status === "SENT") stats.smsSent += 1;
        if (status !== "FAILED") {
          await prisma.dunningCase.update({
            where: { id: kase.id },
            data: { smsSent: 1, lastNotifiedAt: now },
          });
        }
      }
    } catch (err) {
      console.error("[dunning] sweep notification failed", kase.id, err);
    }
  }

  return stats;
}

/**
 * Pre-exhaustion Shopify re-check for an AWAITING_3DS case (sweep phase (c)):
 * find the case's newest in-flight CHALLENGED attempt and resolve it through
 * the billing module's status-guarded re-query lane. Returns what the
 * re-check ESTABLISHED — "SUCCESS"/"FAILED" mean the attempt was settled and
 * the corresponding engine hook has already run; null means nothing new
 * (no challenged attempt left, Shopify had no outcome, or the re-check
 * itself failed) and the caller's timeout stands. Contained: a re-check
 * failure must never block the exhaust sweep.
 */
async function recheckAwaiting3ds(
  kase: CaseWithContract,
): Promise<"SUCCESS" | "FAILED" | null> {
  try {
    const cycleIndex = await caseCycleIndex(kase);
    const challenged = await prisma.billingAttempt.findFirst({
      where: {
        contractId: kase.contractId,
        status: "CHALLENGED",
        shopifyAttemptId: { not: null },
        ...(cycleIndex != null ? { cycleIndex } : {}),
      },
      orderBy: [{ cycleIndex: "desc" }, { attemptNumber: "desc" }],
      select: { id: true },
    });
    if (!challenged) return null;
    // Lazy import: the billing module lazy-imports this engine everywhere —
    // same seam, opposite direction, keeps the module graphs acyclic.
    const { recheckAttemptOutcome } = await import(
      "~/lib/billing/scheduler.server"
    );
    const outcome = await recheckAttemptOutcome(challenged.id);
    return outcome === "SUCCESS" || outcome === "FAILED" ? outcome : null;
  } catch (err) {
    console.error("[dunning] pre-exhaustion 3DS re-check failed", kase.id, err);
    return null;
  }
}

/**
 * Create + fire one dunning retry. Crash-safe: a PENDING retry row without a
 * Shopify attempt id is reused with its original idempotency key, so even if
 * the process died mid-flight (or Shopify errored after accepting the call) a
 * re-fire can never double charge — Shopify dedupes on the key.
 */
async function fireRetry(
  kase: CaseWithContract,
  now: Date,
  adminFor: (domain: string) => Promise<AdminClient>,
  stats: DunningSweepStats,
): Promise<void> {
  const contract = kase.contract;

  // The case's own cycle first (trigger attempt); newest failed attempt as a
  // legacy fallback for cases without one.
  const anchoredCycle = await caseCycleIndex(kase);
  const lastFailed = await prisma.billingAttempt.findFirst({
    where: {
      contractId: contract.id,
      status: "FAILED",
      ...(anchoredCycle != null ? { cycleIndex: anchoredCycle } : {}),
    },
    orderBy: [{ cycleIndex: "desc" }, { attemptNumber: "desc" }],
  });
  if (!lastFailed) {
    // Data integrity edge: a RETRYING case must have a failed attempt behind it.
    console.error(
      "[dunning] RETRYING case has no failed attempt; closing",
      kase.id,
    );
    await prisma.dunningCase.update({
      where: { id: kase.id },
      data: {
        state: "CANCELLED",
        resolvedAt: now,
        resolution: "CANCELLED",
        nextRetryAt: null,
      },
    });
    return;
  }
  const cycleIndex = anchoredCycle ?? lastFailed.cycleIndex;

  let attemptRow: BillingAttempt | null = await prisma.billingAttempt.findFirst({
    where: {
      contractId: contract.id,
      cycleIndex,
      status: "PENDING",
      originatingAction: "DUNNING_RETRY",
      shopifyAttemptId: null,
    },
    orderBy: { attemptNumber: "desc" },
  });
  if (!attemptRow) {
    const priors = await prisma.billingAttempt.count({
      where: { contractId: contract.id, cycleIndex },
    });
    const attemptNumber = priors + 1;
    attemptRow = await prisma.billingAttempt.create({
      data: {
        contractId: contract.id,
        idempotencyKey: `${contract.id}:${cycleIndex}:${attemptNumber}`,
        cycleIndex,
        attemptNumber,
        status: "PENDING",
        scheduledFor: kase.nextRetryAt ?? now,
        originatingAction: "DUNNING_RETRY",
        usedBackupPayment:
          contract.backupPaymentMethodId != null &&
          contract.paymentMethodId === contract.backupPaymentMethodId,
        // Stored-credential/MIT compliance evidence — every attempt carries it.
        mitEvidence: buildMitEvidence({
          consentOrder: contract.originOrderId,
          originatingAction: "DUNNING_RETRY",
          timestamp: now,
        }),
      },
    });
  }
  const row = attemptRow;

  const admin = await adminFor(contract.shop.domain);
  const create = () =>
    createBillingAttempt(admin, contract.shopifyContractId, {
      idempotencyKey: row.idempotencyKey,
      originTime: now,
      cycleIndex,
    });

  let shopifyAttemptId: string;
  try {
    shopifyAttemptId = (await create()).attemptId;
  } catch (err) {
    if (err instanceof ShopifyUserError && contract.status === "FAILED") {
      // Shopify refuses attempts on FAILED contracts — reactivate, then charge.
      await contractActivate(admin, contract.shopifyContractId);
      await prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: { status: "ACTIVE", failedAt: null },
      });
      await logEvent({
        ...eventBase(contract),
        type: "contract.activated",
        source: "SCHEDULER",
        payload: { reason: "dunning_retry_reactivation", dunningCaseId: kase.id },
      });
      shopifyAttemptId = (await create()).attemptId;
    } else {
      // A ShopifyUserError outside the FAILED-contract branch is a permanent
      // refusal (cycle already billed, contract config, permissions) — hourly
      // re-fires can never succeed. Likewise a transient error that has
      // already failed CREATE_FAILURE_MAX times is treated as permanent.
      // Either way: park the case on AWAITING_CUSTOMER (the sweep's
      // cancelAfterFailedDays timeout resolves it), expire the un-started
      // PENDING row so it stops blocking the contract's regular billing, and
      // never loop forever.
      const priorCreateFailures = await prisma.subscriberEvent.count({
        where: {
          contractId: contract.id,
          type: "dunning.retry_scheduled",
          createdAt: { gte: kase.openedAt },
          AND: [
            { payload: { path: ["reason"], equals: "attempt_create_failed" } },
            { payload: { path: ["dunningCaseId"], equals: kase.id } },
          ],
        },
      });
      const refusalCode =
        err instanceof ShopifyUserError
          ? structuredUserErrorCode(err.errors)
          : null;
      const permanent =
        err instanceof ShopifyUserError ||
        priorCreateFailures + 1 >= CREATE_FAILURE_MAX;

      if (permanent) {
        // The refusal reason must survive on the terminal row itself, not
        // only in the event payload below: a bare EXPIRED row reads as an
        // unknown outcome in every analytics surface, and
        // categorizeDeclineCode(null) files it under UNKNOWN/SOFT.
        await prisma.billingAttempt.updateMany({
          where: { id: row.id, shopifyAttemptId: null, startedAt: null },
          data: {
            status: "EXPIRED",
            completedAt: now,
            errorCode: refusalCode,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        await prisma.dunningCase.update({
          where: { id: kase.id },
          data: { state: "AWAITING_CUSTOMER", nextRetryAt: null },
        });
        await logEvent({
          ...eventBase(contract),
          type: "dunning.awaiting_customer",
          source: "SCHEDULER",
          payload: {
            dunningCaseId: kase.id,
            cycleIndex,
            reason: "attempt_create_failed_permanently",
            createFailures: priorCreateFailures + 1,
            errorCode: refusalCode,
            error: err instanceof Error ? err.message : String(err),
          },
        });
        return;
      }

      // Transient — back off an hour and re-fire with the SAME idempotency key
      // (the PENDING row is reused), so a double charge is impossible even if
      // Shopify actually accepted this call.
      const backoffUntil = new Date(now.getTime() + CREATE_FAILURE_BACKOFF_MS);
      await prisma.dunningCase.update({
        where: { id: kase.id },
        data: { nextRetryAt: backoffUntil },
      });
      await logEvent({
        ...eventBase(contract),
        type: "dunning.retry_scheduled",
        source: "SCHEDULER",
        payload: {
          dunningCaseId: kase.id,
          cycleIndex,
          rescheduled: true,
          reason: "attempt_create_failed",
          error: err instanceof Error ? err.message : String(err),
          nextRetryAt: backoffUntil.toISOString(),
          idempotencyKey: row.idempotencyKey,
        },
      });
      return;
    }
  }

  await prisma.billingAttempt.update({
    where: { id: row.id },
    data: { shopifyAttemptId, startedAt: now },
  });
  await prisma.dunningCase.update({
    where: { id: kase.id },
    data: { ladderStep: { increment: 1 }, nextRetryAt: null },
  });
  await logEvent({
    ...eventBase(contract),
    type: "billing.attempt_started",
    source: "SCHEDULER",
    payload: {
      attemptId: row.id,
      shopifyAttemptId,
      dunningCaseId: kase.id,
      cycleIndex,
      attemptNumber: row.attemptNumber,
      idempotencyKey: row.idempotencyKey,
      originatingAction: "DUNNING_RETRY",
      usedBackupPayment: row.usedBackupPayment,
      paydayAligned: kase.paydayAligned,
    },
  });
  stats.retriesScheduled += 1;
}

/**
 * One rung of the notification ladder (email payment_failed_1/2/3 or the SMS).
 *
 * Persistent dedupe: each rung carries a `dunning_dedupe` var
 * (`{caseId}:{channel}:{rung}`) checked against NotificationLog before
 * sending. The emailsSent/smsSent cursor is only committed AFTER the send, so
 * a crash between send and cursor write (or a second sweep instance racing a
 * slow one past its lock lease) re-enters here — the log check turns that
 * re-entry into a cursor-advance instead of a duplicate "payment failed"
 * email to an already-anxious customer.
 */
async function sendLadderNotification(
  kase: CaseWithContract,
  info: DeclineCodeInfo,
  daysSinceOpen: number,
  channel: "EMAIL" | "SMS",
  rung: number,
): Promise<"SENT" | "SUPPRESSED" | "FAILED" | "DUPLICATE"> {
  const contract = kase.contract;
  const dedupeKey = `${kase.id}:${channel}:${rung}`;

  const template: TemplateKey =
    channel === "SMS"
      ? "payment_failed_sms"
      : LADDER_EMAIL_TEMPLATES[
          Math.min(rung, LADDER_EMAIL_TEMPLATES.length - 1)
        ];

  const alreadySent = await prisma.notificationLog.findFirst({
    where: {
      contractId: contract.id,
      template,
      status: "SENT",
      payload: { path: ["vars", "dunning_dedupe"], equals: dedupeKey },
    },
    select: { id: true },
  });
  if (alreadySent) return "DUPLICATE";

  const lastFailed = await prisma.billingAttempt.findFirst({
    where: { contractId: contract.id, status: "FAILED" },
    orderBy: [{ cycleIndex: "desc" }, { attemptNumber: "desc" }],
  });
  const amountCents =
    lastFailed?.amountCents ?? estimateContractAmountCents(contract);
  const ctaUrl = await buildUpdateCardUrl(contract);

  const vars: Record<string, unknown> = {
    attempt_number: lastFailed?.attemptNumber ?? 1,
    amount:
      amountCents != null
        ? formatMoney(
            amountCents,
            lastFailed?.currencyCode ?? contract.currencyCode,
            contract.locale,
          )
        : "",
    card_last4: contract.cardLast4 ?? "",
    decline_human: info.description,
    days_since_failure: daysSinceOpen,
    dunning_dedupe: dedupeKey,
  };
  if (lastFailed) vars.cycleIndex = lastFailed.cycleIndex;
  if (ctaUrl) vars.cta_url = ctaUrl;

  const result = await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template,
    vars,
  });
  return result.status;
}

// ── Pre-expiry notices (jobs entrypoint) ─────────────────────────────────────

/**
 * Cards expire at the end of their expiry month. Within
 * settings.dunning.preExpiryNoticeDays of that moment, send exactly one
 * card_expiring notice per card per expiry (deduped in NotificationLog on
 * `card_expiring:{last4}:{expYYYYMM}` per customer email), with a one-tap
 * update-card magic link, plus Shopify's own hosted update email best-effort.
 * Already-expired cards are left to the failure path (EXPIRED_PAYMENT_METHOD).
 */
export async function runPreExpiryNotices(
  now: Date = new Date(),
): Promise<DunningSweepStats> {
  const stats = emptyStats();
  const settingsCache = new Map<string, DunningSettings>();
  const adminCache = new Map<string, AdminClient>();

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      ...OURS_ONLY, // never warn another app's subscriber about their card
      isDemo: false, // the portal-preview fixture carries a fake 12/{Y+1} visa
      status: "ACTIVE",
      cardExpiryMonth: { not: null },
      cardExpiryYear: { not: null },
    },
    include: { shop: true },
  });

  for (const contract of contracts) {
    stats.processed += 1;
    try {
      const expMonth = contract.cardExpiryMonth;
      const expYear = contract.cardExpiryYear;
      if (expMonth == null || expYear == null) continue;

      let settings = settingsCache.get(contract.shopId);
      if (!settings) {
        settings = await getSetting(contract.shopId, "dunning");
        settingsCache.set(contract.shopId, settings);
      }
      const tz = contract.shop.ianaTimezone;

      // The card works through the last day of its expiry month; expiry moment
      // ~ first instant of the following month (UTC midnight is close enough
      // for a multi-week notice window; the offset itself is tz-anchored).
      const expiresAt = new Date(Date.UTC(expYear, expMonth, 1));
      const noticeFrom = addDaysTz(expiresAt, -settings.preExpiryNoticeDays, tz);
      if (now < noticeFrom || now >= expiresAt) continue;

      const mm = String(expMonth).padStart(2, "0");
      const last4 = contract.cardLast4 ?? "unknown";
      const dedupeKey = `card_expiring:${last4}:${expYear}${mm}`;

      const alreadySent = await prisma.notificationLog.findFirst({
        where: {
          template: "card_expiring",
          status: "SENT",
          email: contract.email,
          payload: { path: ["vars", "dedupe_key"], equals: dedupeKey },
        },
        select: { id: true },
      });
      if (alreadySent) continue;

      const ctaUrl = await buildUpdateCardUrl(contract);
      const result = await sendNotification({
        shopId: contract.shopId,
        contractId: contract.id,
        template: "card_expiring",
        vars: {
          card_brand: contract.cardBrand ?? "",
          card_last4: contract.cardLast4 ?? "",
          expiry: `${mm}/${expYear}`,
          dedupe_key: dedupeKey,
          ...(ctaUrl ? { cta_url: ctaUrl } : {}),
        },
      });

      if (result.status === "SENT") {
        // Shopify's own hosted card-update email — belt and braces,
        // best-effort. Strictly INSIDE the SENT branch: only a SENT result
        // writes the NotificationLog row that makes `alreadySent` true next
        // run, so firing this on SUPPRESSED/FAILED results would email the
        // customer from Shopify EVERY DAY of the notice window.
        if (contract.paymentMethodId) {
          try {
            let admin = adminCache.get(contract.shop.domain);
            if (!admin) {
              admin = await adminClientForShop(contract.shop.domain);
              adminCache.set(contract.shop.domain, admin);
            }
            await sendPaymentMethodUpdateEmail(admin, contract.paymentMethodId);
          } catch (err) {
            console.error(
              "[dunning] Shopify update-email fallback failed",
              contract.id,
              err,
            );
          }
        }

        stats.emailsSent += 1;
        await logEvent({
          ...eventBase(contract),
          type: "dunning.card_expiring_notice",
          source: "SCHEDULER",
          payload: {
            dedupeKey,
            cardLast4: contract.cardLast4,
            cardBrand: contract.cardBrand,
            expiry: `${mm}/${expYear}`,
            noticeDaysBeforeExpiry: settings.preExpiryNoticeDays,
          },
        });
      }
    } catch (err) {
      console.error("[dunning] pre-expiry notice failed", contract.id, err);
    }
  }

  return stats;
}
