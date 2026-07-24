import type {
  BillingAttempt,
  ContractLine,
  DunningCase,
  DunningState,
  Prisma,
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
  type DeclineCodeInfo,
} from "./decline-codes.server";

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
 * original failed charge; retries live at indexes 1+. `paydaysOfMonth:
 * [1, 15, 25]`, `paydaySnapWindowDays: 3`.
 *
 *   Mon Jan 5  — scheduled charge fails SOFT (attempt #1). Case opens (day 0).
 *                priorFailures = 0 → next offset = softRetryDays[1] = 3
 *                → retry #1 scheduled Thu Jan 8 (day 3; probe Jan 8→11 finds
 *                no payday, so no snap).
 *   Thu Jan 8  — retry #1 (attempt #2) fails.
 *                priorFailures = 1 → next offset = softRetryDays[2] = 7
 *                → candidate Mon Jan 12 (day 7). This is retry #2, so the
 *                backup payment method is tried first if configured (switch
 *                card, retry in 1h instead). Otherwise payday alignment
 *                probes Jan 12 → 13 → 14 → 15 and snaps to Thu Jan 15
 *                (payday, `paydayAligned = true`).
 *   Thu Jan 15 — retry #2 (attempt #3) fails.
 *                priorFailures = 2 → next offset = softRetryDays[3] = 14
 *                → retry #3 scheduled Mon Jan 19 (day 14 from Jan 5).
 *   Mon Jan 19 — retry #3 (attempt #4) fails.
 *                priorFailures = 3 → softRetryDays[4] is undefined
 *                → ladder exhausted → `exhaustedAction` (PAUSE: contract
 *                FAILED via subscriptionContractFail, renewals stop, portal
 *                shows the fix-payment banner; CANCEL: cancelContract with
 *                reason PAYMENT_FAILED — the cancel service schedules
 *                win-back).
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

const OPEN_CASE_STATES: DunningState[] = [
  "OPEN",
  "RETRYING",
  "AWAITING_CUSTOMER",
  "AWAITING_3DS",
];

const DAY_MS = 24 * 60 * 60 * 1000;
/** After switching to the backup card, retry after this delay. */
const BACKUP_RETRY_DELAY_MS = 60 * 60 * 1000;
/** Back-off before re-firing a retry whose Shopify create call failed. */
const CREATE_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const UPDATE_CARD_LINK_TTL_SECONDS = 14 * 24 * 3600;
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

function findOpenCase(contractId: string): Promise<DunningCase | null> {
  return prisma.dunningCase.findFirst({
    where: { contractId, state: { in: OPEN_CASE_STATES } },
    orderBy: { openedAt: "desc" },
  });
}

/**
 * Reuse the contract's open case or open a fresh one (logging
 * dunning.case_opened). `openedAt` of a fresh case is the anchor date for all
 * retry-ladder offsets.
 */
async function ensureOpenCase(
  attempt: AttemptFull,
  declineCategory: string,
  source: EventSource,
): Promise<DunningCase> {
  const existing = await findOpenCase(attempt.contractId);
  if (existing) return existing;

  const kase = await prisma.dunningCase.create({
    data: {
      contractId: attempt.contractId,
      triggerAttemptId: attempt.id,
      declineCode: attempt.errorCode ?? null,
      declineCategory,
    },
  });
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

/** Signed UPDATE_CARD magic link (multi-use — dunning emails get tapped often). */
async function buildUpdateCardUrl(
  contract: SubscriptionContract,
): Promise<string | null> {
  try {
    return await buildMagicUrl({
      action: "UPDATE_CARD",
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      ttlSeconds: UPDATE_CARD_LINK_TTL_SECONDS,
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
 * payment method. Callers log dunning.backup_used with charge context.
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
}

// ── Failure handling (webhook entrypoints) ───────────────────────────────────

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE → classify, open/extend the dunning
 * case and decide the next move (retry ladder / await customer / await 3DS).
 * Idempotent under webhook redelivery: an attempt that is already FAILED with
 * a decline category has been through the engine and is skipped.
 */
export async function onBillingAttemptFailed(
  attemptLocalId: string,
): Promise<void> {
  const attempt = await loadAttempt(attemptLocalId);
  if (!attempt) return;
  const contract = attempt.contract;
  const now = new Date();

  if (attempt.status === "FAILED" && attempt.declineCategory != null) {
    return; // webhook redelivery — already processed
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
      declineCategory: info.category,
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

  const kase = await ensureOpenCase(attempt, info.category, "WEBHOOK");

  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: { consecutiveFailures: { increment: 1 } },
  });

  if (attempt.attemptNumber > 1) {
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

  if (info.category === "SOFT") {
    await handleSoftFailure(attempt, kase, info, settings, now);
  } else if (info.category === "AUTH_REQUIRED") {
    await handleAuthRequiredFailure(attempt, kase, info, now);
  } else {
    await handleHardFailure(attempt, kase, info, now);
  }
}

/**
 * SOFT: schedule the next rung of the retry ladder (offsets from the first
 * failure = case.openedAt, payday-aligned), trying the backup card before
 * retry #2+, or exhaust when the ladder has no rungs left.
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

  // Retries already burned this cycle (this attempt excluded — it was just
  // marked FAILED above, so exclude by id to keep the count stable across
  // redeliveries).
  const priorFailures = await prisma.billingAttempt.count({
    where: {
      contractId: contract.id,
      cycleIndex: attempt.cycleIndex,
      status: "FAILED",
      id: { not: attempt.id },
    },
  });
  const nextOffsetDays = settings.softRetryDays.at(priorFailures + 1);

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
            previousPaymentMethodId: contract.paymentMethodId,
          },
        });
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
  const result = await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template: "payment_failed_1",
    vars: {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  });
  if (result.status !== "FAILED") {
    // Counts as email #1 of the ladder so the sweep doesn't double-send day 0.
    await prisma.dunningCase.update({
      where: { id: kase.id },
      data: { emailsSent: Math.max(1, kase.emailsSent), lastNotifiedAt: now },
    });
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
  const result = await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template: "threeds_action",
    vars: {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  });
  if (result.status !== "FAILED") {
    await prisma.dunningCase.update({
      where: { id: kase.id },
      data: { emailsSent: Math.max(1, kase.emailsSent), lastNotifiedAt: now },
    });
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
      notificationStatus: result.status,
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
  const now = new Date();

  const existing = await findOpenCase(contract.id);
  if (attempt.status === "CHALLENGED" && existing?.state === "AWAITING_3DS") {
    return; // webhook redelivery — link already sent
  }

  await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "CHALLENGED",
      declineCategory: "AUTH_REQUIRED",
      // Fold the 3DS challenge into the stored-credential evidence blob.
      mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
        challenged: true,
        redirectIssued: redirectUrl != null,
        challengedAt: now.toISOString(),
        resolution: "PENDING_CUSTOMER_ACTION",
      }),
    },
  });

  const kase =
    existing ?? (await ensureOpenCase(attempt, "AUTH_REQUIRED", "WEBHOOK"));
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
  const result = await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template: "threeds_action",
    vars: {
      ...failureVars(attempt, info),
      ...(ctaUrl ? { cta_url: ctaUrl } : {}),
    },
  });
  if (result.status !== "FAILED") {
    await prisma.dunningCase.update({
      where: { id: kase.id },
      data: { emailsSent: Math.max(1, kase.emailsSent), lastNotifiedAt: now },
    });
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
      notificationStatus: result.status,
    },
  });
}

/**
 * SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS → close any open case as recovered,
 * reset the failure counter and reactivate a FAILED contract.
 */
export async function onBillingAttemptSucceeded(
  attemptLocalId: string,
): Promise<void> {
  const attempt = await loadAttempt(attemptLocalId);
  if (!attempt) return;
  const contract = attempt.contract;
  const now = new Date();

  if (attempt.status !== "SUCCESS") {
    // A CHALLENGED attempt succeeding means the customer passed 3DS — fold
    // the outcome into the stored evidence blob.
    const wasChallenged =
      attempt.status === "CHALLENGED" || hasThreeDsEvidence(attempt.mitEvidence);
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "SUCCESS",
        completedAt: attempt.completedAt ?? now,
        ...(wasChallenged
          ? {
              mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
                challenged: true,
                resolution: "SUCCEEDED",
                resolvedAt: now.toISOString(),
              }),
            }
          : {}),
      },
    });
  }

  const kase = await findOpenCase(contract.id);
  let resolution: string | null = null;
  if (kase) {
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
        cycleIndex: attempt.cycleIndex,
        attemptNumber: attempt.attemptNumber,
        usedBackupPayment: attempt.usedBackupPayment,
        daysOpen: Math.floor((now.getTime() - kase.openedAt.getTime()) / DAY_MS),
      },
    });
  }
  if (attempt.attemptNumber > 1) {
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
      emailsSent: kase.emailsSent,
      smsSent: kase.smsSent,
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
    where: { state: { in: OPEN_CASE_STATES } },
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
    try {
      const settings = await dunningSettings(kase.contract.shopId);
      const daysOpen = Math.floor(
        (now.getTime() - kase.openedAt.getTime()) / DAY_MS,
      );
      if (daysOpen < settings.cancelAfterFailedDays) continue;
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

      // Email rung N is due when daysSinceOpen >= emailLadderDays[N] and
      // exactly N emails have gone out (emailsSent is the cursor).
      const rung = kase.emailsSent;
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
          await prisma.dunningCase.update({
            where: { id: kase.id },
            data: { emailsSent: rung + 1, lastNotifiedAt: now },
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

  const lastFailed = await prisma.billingAttempt.findFirst({
    where: { contractId: contract.id, status: "FAILED" },
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
  const cycleIndex = lastFailed.cycleIndex;

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

/** One rung of the notification ladder (email payment_failed_1/2/3 or the SMS). */
async function sendLadderNotification(
  kase: CaseWithContract,
  info: DeclineCodeInfo,
  daysSinceOpen: number,
  channel: "EMAIL" | "SMS",
  rung: number,
): Promise<"SENT" | "SUPPRESSED" | "FAILED"> {
  const contract = kase.contract;
  const lastFailed = await prisma.billingAttempt.findFirst({
    where: { contractId: contract.id, status: "FAILED" },
    orderBy: [{ cycleIndex: "desc" }, { attemptNumber: "desc" }],
  });
  const amountCents =
    lastFailed?.amountCents ?? estimateContractAmountCents(contract);
  const ctaUrl = await buildUpdateCardUrl(contract);

  const template: TemplateKey =
    channel === "SMS"
      ? "payment_failed_sms"
      : LADDER_EMAIL_TEMPLATES[
          Math.min(rung, LADDER_EMAIL_TEMPLATES.length - 1)
        ];

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

      // Shopify's own hosted card-update email — belt and braces, best-effort.
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

      if (result.status === "SENT") {
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
