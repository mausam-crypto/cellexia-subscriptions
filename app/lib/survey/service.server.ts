/**
 * Post-purchase survey service (v1.21.0).
 *
 * Owns the SurveyResponse lifecycle: impression/answer writes from the
 * checkout UI extension (via app/routes/api.survey.tsx), linking rows to
 * their SubscriptionContract mirror, the deterministic intervention-holdout
 * assignment, and the one-shot `survey.answered` event emission that feeds
 * Klaviyo and the subscriber timeline.
 *
 * Rows are keyed by ORDER, not contract: the thank-you page renders (and the
 * shopper starts tapping) while the SUBSCRIPTION_CONTRACTS_CREATE webhook is
 * still in flight, so either side can arrive first. Linking runs from three
 * places, all funneling through linkSurveyForContract:
 *   1. the survey endpoint, when the mirror already exists at write time;
 *   2. the contract-create webhook tail (+ its catch-up branch) — mirroring
 *      the acquisition-pickup pattern in handlers.server.ts;
 *   3. the daily survey_link_sweep job, for stragglers either side dropped.
 *
 * Golden rules honored here: linking only ever attaches to countable OURS
 * contracts (the other subscription app's orders can render the survey too —
 * their rows simply stay unlinked); every failure is contained by callers
 * (survey must never break a webhook or a checkout page); the survey.answered
 * event is deduped on its own existence per orderId (the per-event-family
 * idempotency convention from handlers.server.ts).
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { SubscriptionContract, SurveyResponse } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  SURVEY_QUESTION_SET_VERSION,
  isCompleteSurvey,
  sanitizeSurveyAnswers,
  type SurveyAnswers,
  type SurveySource,
} from "./shared";

export const SURVEY_ANSWERED_EVENT = "survey.answered";

/**
 * Deterministic holdout assignment — no RNG, so re-running any code path
 * yields the same verdict and the assignment is auditable from the contract
 * id alone. First 8 hex chars of sha256("survey-holdout:" + contractId) as an
 * integer, uniform over 0..9999 after the modulo, compared against pct×100
 * (holdoutPct supports decimals like 12.5).
 */
export function surveyHoldoutForContract(
  contractId: string,
  holdoutPct: number,
): boolean {
  if (!(holdoutPct > 0)) return false;
  const digest = createHash("sha256")
    .update(`survey-holdout:${contractId}`)
    .digest("hex");
  const bucket = parseInt(digest.slice(0, 8), 16) % 10000;
  return bucket < Math.round(holdoutPct * 100);
}

export interface SurveyWriteInput {
  orderId: string; // gid://shopify/Order/...
  source: SurveySource;
  locale?: string | null;
  customerId?: string | null; // session token sub claim, when logged in
  /** null = impression only (no answer tapped yet) */
  answer?: { question: string; option: string } | null;
}

export interface SurveyWriteResult {
  response: SurveyResponse;
  linked: boolean;
}

/**
 * Upsert one impression or answer write — RACE-SAFE on the create side.
 *
 * The impression beacon (render) and the first tap land within milliseconds
 * of each other on every order, so create-vs-create is the COMMON case, not
 * an edge: both writers see no row, both insert, and the orderId unique
 * constraint kills the loser with P2002. A naive check-then-create surfaced
 * that as a 500 the fail-quiet extension swallowed — the first (highest
 * signal) answer silently dropped. The loser therefore re-reads the winner's
 * row and MERGES into it instead, so both arrival orders converge on
 * impression metadata + the answer.
 *
 * Two further rules close the remaining windows:
 * - an impression against an EXISTING row never rewrites `answers` (its
 *   read-merge-write would clobber a tap that committed in between); it
 *   only fills customerId when absent.
 * - answer merges stay last-write-wins PER QUESTION: each write carries one
 *   {question, option} and taps are sequential in the UI, so concurrent
 *   answer-vs-answer writes on different questions do not occur from one
 *   shopper's device.
 */
export async function recordSurveyWrite(
  shopId: string,
  input: SurveyWriteInput,
): Promise<SurveyWriteResult> {
  const now = new Date();
  let existing = await prisma.surveyResponse.findUnique({
    where: { orderId: input.orderId },
  });

  let row: SurveyResponse | null = null;
  if (!existing) {
    try {
      row = await prisma.surveyResponse.create({
        data: {
          shopId,
          orderId: input.orderId,
          source: input.source,
          locale: input.locale ?? null,
          customerId: input.customerId ?? null,
          questionSetVersion: SURVEY_QUESTION_SET_VERSION,
          answers: input.answer
            ? sanitizeSurveyAnswers({ [input.answer.question]: input.answer.option })
            : undefined,
          answeredAt: input.answer ? now : null,
        },
      });
    } catch (err) {
      // Unique-violation = a concurrent writer created the row between our
      // read and insert. Fall through to the merge path against THEIR row —
      // anything else is a real failure and must surface.
      if (
        !(
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        )
      ) {
        throw err;
      }
      existing = await prisma.surveyResponse.findUnique({
        where: { orderId: input.orderId },
      });
      if (!existing) throw err; // row vanished — genuinely broken, surface it
    }
  }

  if (!row && existing) {
    if (!input.answer) {
      // Impression on an existing row: fill-only. Rewriting `answers` from a
      // pre-tap read would clobber a concurrently committed answer.
      row =
        existing.customerId === null && input.customerId
          ? await prisma.surveyResponse.update({
              where: { id: existing.id },
              data: { customerId: input.customerId },
            })
          : existing;
    } else {
      const merged: SurveyAnswers = sanitizeSurveyAnswers(existing.answers);
      Object.assign(
        merged,
        sanitizeSurveyAnswers({ [input.answer.question]: input.answer.option }),
      );
      const complete = isCompleteSurvey(merged);
      row = await prisma.surveyResponse.update({
        where: { id: existing.id },
        data: {
          answers: merged,
          // Keep the earliest customerId we ever saw; fill if absent.
          customerId: existing.customerId ?? input.customerId ?? null,
          answeredAt: existing.answeredAt ?? now,
          completedAt: existing.completedAt ?? (complete ? now : null),
        },
      });
    }
  }
  if (!row) {
    // Unreachable by construction (create succeeded, or existing was set) —
    // typed narrow for the compiler.
    throw new Error(`survey write resolved no row for ${input.orderId}`);
  }

  // Link immediately when the mirror already exists (the common case for
  // answers, since the webhook usually wins the race against human taps).
  let linked = row.contractId !== null;
  if (!linked) {
    const contract = await prisma.subscriptionContract.findFirst({
      where: {
        shopId,
        originOrderId: input.orderId,
        isDemo: false,
        ...OURS_ONLY,
      },
    });
    if (contract) {
      row = await linkSurveyForContract(row, contract);
      linked = row.contractId !== null;
    }
  } else if (row.contractId) {
    // Already linked — a newly completed survey may still owe its event.
    await maybeEmitAnswered(row);
  }

  return { response: row, linked };
}

/**
 * Attach a survey row to its contract: stamp contractId/linkedAt, assign the
 * intervention holdout (once, atomically — never reshuffled), then emit the
 * survey.answered event if the row has answers. Idempotent; safe to call
 * from racing paths.
 */
export async function linkSurveyForContract(
  response: SurveyResponse,
  contract: SubscriptionContract,
): Promise<SurveyResponse> {
  // Atomic claim so two racing linkers (endpoint + webhook) converge.
  await prisma.surveyResponse.updateMany({
    where: { id: response.id, contractId: null },
    data: {
      contractId: contract.id,
      linkedAt: new Date(),
      customerId: response.customerId ?? contract.customerId,
    },
  });

  if (contract.surveyHoldout === null) {
    const surveySettings = await getSetting(contract.shopId, "survey");
    const holdout = surveyHoldoutForContract(
      contract.id,
      surveySettings.holdoutPct,
    );
    // Null-claim: only the first assignment ever writes, so a later
    // holdoutPct change never reshuffles an assigned contract.
    await prisma.subscriptionContract.updateMany({
      where: { id: contract.id, surveyHoldout: null },
      data: { surveyHoldout: holdout },
    });
  }

  const fresh = await prisma.surveyResponse.findUnique({
    where: { id: response.id },
  });
  if (fresh?.contractId) await maybeEmitAnswered(fresh);
  return fresh ?? response;
}

/**
 * One-shot survey.answered emission. Fires when a row is linked AND either
 * complete or being flushed by the sweep (partial answers from abandoners
 * still carry signal — the sweep emits them once the row is stale). Deduped
 * on event existence per orderId, the handlers.server.ts convention.
 */
export async function maybeEmitAnswered(
  response: SurveyResponse,
  opts: { allowPartial?: boolean } = {},
): Promise<boolean> {
  if (!response.contractId || !response.answeredAt) return false;
  const answers = sanitizeSurveyAnswers(response.answers);
  const complete = isCompleteSurvey(answers);
  if (!complete && !opts.allowPartial) return false;

  const already = await prisma.subscriberEvent.findFirst({
    where: {
      shopId: response.shopId,
      type: SURVEY_ANSWERED_EVENT,
      payload: { path: ["orderId"], equals: response.orderId },
    },
    select: { id: true },
  });
  if (already) return false;

  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: response.contractId },
  });
  if (!contract) return false;

  await logEvent({
    shopId: response.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: SURVEY_ANSWERED_EVENT,
    source: "SYSTEM",
    actor: "customer",
    payload: {
      orderId: response.orderId,
      question_set_version: response.questionSetVersion,
      survey_planned_duration: answers.plannedDuration ?? null,
      survey_motive: answers.motive ?? null,
      survey_expected_speed: answers.expectedSpeed ?? null,
      survey_routine: answers.routine ?? null,
      survey_completed: complete,
      // Flows filter on this: holdout contracts must be EXCLUDED from
      // survey-triggered sends so answer-segment churn stays measurable.
      survey_holdout: contract.surveyHoldout === true,
    },
  });
  return true;
}

/**
 * Daily sweep: links stragglers (rows whose contract mirror arrived without
 * either side completing the link) and flushes partial-answer emissions for
 * rows stale for over an hour. Capped per run, oldest first; idempotent.
 */
export async function runSurveyLinkSweep(
  shopId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const CAP = 200;
  const STALE_MS = 60 * 60 * 1000;
  let linked = 0;
  let emitted = 0;

  const unlinked = await prisma.surveyResponse.findMany({
    where: { shopId, contractId: null },
    orderBy: { createdAt: "asc" },
    take: CAP,
  });
  for (const row of unlinked) {
    const contract = await prisma.subscriptionContract.findFirst({
      where: {
        shopId,
        originOrderId: row.orderId,
        isDemo: false,
        ...OURS_ONLY,
      },
    });
    if (!contract) continue;
    await linkSurveyForContract(row, contract);
    linked += 1;
  }

  // Linked, answered, stale, still without an emitted event (partials).
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const pending = await prisma.surveyResponse.findMany({
    where: {
      shopId,
      contractId: { not: null },
      answeredAt: { not: null, lt: staleBefore },
    },
    orderBy: { answeredAt: "asc" },
    take: CAP,
  });
  for (const row of pending) {
    if (await maybeEmitAnswered(row, { allowPartial: true })) emitted += 1;
  }

  return { scanned: unlinked.length + pending.length, linked, emitted };
}

export interface SurveyOrderStatus {
  enabled: boolean;
  answered: SurveyAnswers;
  completed: boolean;
}

/** Status read for the extension: is the survey on, what did this order already answer. */
export async function getSurveyOrderStatus(
  shopId: string,
  orderId: string,
): Promise<SurveyOrderStatus> {
  const settings = await getSetting(shopId, "survey");
  const row = await prisma.surveyResponse.findUnique({
    where: { orderId },
  });
  const answers = row ? sanitizeSurveyAnswers(row.answers) : {};
  return {
    enabled: settings.enabled,
    answered: answers,
    completed: Boolean(row?.completedAt),
  };
}
