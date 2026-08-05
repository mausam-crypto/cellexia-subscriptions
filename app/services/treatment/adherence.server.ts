/**
 * Adherence — post-delivery check-in surveys.
 *
 * Answers feed two engines:
 * - PRODUCT_REMAINING answers become SURVEY_OVERRIDE depletion signals
 *   (the strongest calibration signal the depletion engine gets).
 * - DISCOMFORT answers route straight into a HIGH_CHURN_RISK event so the
 *   retention module can act before an IRRITATION-driven cancellation.
 *
 * Pure answer-parsing helpers are exported for unit testing.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { registerDepletionSignal } from "~/services/treatment/depletion.server";
import { addDays, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { ADHERENCE_QUESTIONS, parseJson } from "~/types/domain";
import type { AdherenceQuestion } from "~/types/domain";

/** Customer-facing questions, in Continuous Treatment voice (no ops jargon). */
export const SURVEY_QUESTIONS: Record<AdherenceQuestion, string> = {
  STARTED_USING: "Have you started using your latest delivery?",
  USAGE_FREQUENCY: "How often are you using it?",
  PRODUCT_REMAINING: "Roughly how much product do you have left?",
  DISCOMFORT: "Have you noticed any discomfort or irritation?",
  DESIRED_CHANGE: "Is there anything you would like to change about your treatment plan?",
};

/** How long after a completed charge we wait before checking in (days). */
const SURVEY_WINDOW_START_DAYS = 10;
const SURVEY_WINDOW_END_DAYS = 3;

// ─────────────────────────────── Pure helpers ─────────────────────────────

const REMAINING_PATTERNS: Array<[RegExp, number]> = [
  [/(almost|nearly)\s+(empty|out|finished|done|gone)/, 0.1],
  [/\b(empty|none|ran out|run out|finished|all gone)\b/, 0],
  [/(three[\s-]?quarters|3\/4)/, 0.75],
  [/\b(a\s+)?quarter\b|\b1\/4\b/, 0.25],
  [/\b(about\s+)?half\b|\b1\/2\b/, 0.5],
  [/\b(full|unopened|untouched)\b/, 1],
];

/**
 * Parse a free-text "how much is left" answer into a fraction 0..1.
 * Accepts phrases ("about half", "almost empty"), percents ("40%") and
 * numbers (0.3 as a fraction, 30 as a percent). Returns null when unparseable.
 */
export function parseRemainingFraction(answer: string): number | null {
  const a = answer.trim().toLowerCase();
  if (!a) return null;
  const pct = a.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return Math.min(1, Math.max(0, Number(pct[1]) / 100));
  for (const [pattern, value] of REMAINING_PATTERNS) {
    if (pattern.test(a)) return value;
  }
  const n = Number(a);
  if (Number.isFinite(n)) {
    if (n >= 0 && n <= 1) return n;
    if (n > 1 && n <= 100) return n / 100;
  }
  return null;
}

const NO_DISCOMFORT_ANSWERS = new Set([
  "no",
  "none",
  "nothing",
  "not at all",
  "no discomfort",
  "no irritation",
  "n/a",
  "na",
  "nope",
  "all good",
  "fine",
  "not really",
]);

/** True when a DISCOMFORT answer actually reports discomfort. */
export function discomfortReported(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  if (!a) return false;
  return !NO_DISCOMFORT_ANSWERS.has(a);
}

// ─────────────────────────────── Responses ────────────────────────────────

/**
 * Record a customer's survey answers. Fills the most recent unanswered
 * survey for the contract (or creates a standalone response row), then fans
 * the answers out to depletion and churn-risk signals.
 */
export async function recordSurveyResponse(
  shop: string,
  contractId: string,
  answers: Partial<Record<AdherenceQuestion, string>>,
) {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
    include: { lines: true },
  });
  if (!contract || contract.shop !== shop) {
    throw new Error(`recordSurveyResponse: contract not found: ${contractId}`);
  }

  // Only accept known question keys.
  const clean: Partial<Record<AdherenceQuestion, string>> = {};
  for (const q of ADHERENCE_QUESTIONS) {
    const v = answers[q];
    if (typeof v === "string" && v.trim() !== "") clean[q] = v.trim();
  }

  const now = new Date();
  const open = await prisma.adherenceSurvey.findFirst({
    where: { contractId, respondedAt: null },
    orderBy: { sentAt: "desc" },
  });

  const survey = open
    ? await prisma.adherenceSurvey.update({
        where: { id: open.id },
        data: {
          answersJson: JSON.stringify({
            ...parseJson<Record<string, string>>(open.answersJson, {}),
            ...clean,
          }),
          respondedAt: now,
        },
      })
    : await prisma.adherenceSurvey.create({
        data: {
          shop,
          contractId,
          shopifyCustomerId: contract.shopifyCustomerId,
          answersJson: JSON.stringify(clean),
          sentAt: now,
          respondedAt: now,
        },
      });

  // PRODUCT_REMAINING → SURVEY_OVERRIDE depletion signal per line.
  const remainingAnswer = clean.PRODUCT_REMAINING;
  if (remainingAnswer != null) {
    const fraction = parseRemainingFraction(remainingAnswer);
    if (fraction != null && contract.lines.length > 0) {
      const metas = await prisma.productMeta.findMany({
        where: {
          shop,
          shopifyProductId: { in: contract.lines.map((l) => l.shopifyProductId) },
        },
        select: { shopifyProductId: true, unitContents: true },
      });
      const contentsByProduct = new Map(
        metas.map((m) => [m.shopifyProductId, m.unitContents ?? 1]),
      );
      for (const line of contract.lines) {
        const unitContents = contentsByProduct.get(line.shopifyProductId) ?? 1;
        // Approximation: the reported fraction applies to each product in the plan.
        const reportedUnitsRemaining = fraction * line.quantity * unitContents;
        await registerDepletionSignal(shop, line.id, "SURVEY_OVERRIDE", {
          reportedUnitsRemaining,
          now,
        });
      }
    }
  }

  // DISCOMFORT → HIGH_CHURN_RISK so retention can reach out before an
  // IRRITATION-driven cancellation starts.
  const discomfortAnswer = clean.DISCOMFORT;
  if (discomfortAnswer != null && discomfortReported(discomfortAnswer)) {
    await emitLifecycleEvent({
      shop,
      name: "HIGH_CHURN_RISK",
      contractId,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: {
        source: "adherence-survey",
        question: "DISCOMFORT",
        answer: discomfortAnswer,
        suggestedCancelReason: "IRRITATION",
        surveyId: survey.id,
      },
      dedupeKey: `survey-discomfort:${survey.id}`,
    });
  }

  await appendAudit({
    shop,
    actorType: "CUSTOMER",
    actorId: contract.shopifyCustomerId,
    action: "ADHERENCE_SURVEY_RESPONDED",
    subjectType: "AdherenceSurvey",
    subjectId: survey.id,
    payload: { answeredQuestions: Object.keys(clean) },
  });

  return survey;
}

// ─────────────────────────────── Send job ─────────────────────────────────

/**
 * Find contracts with a recent CHARGE_COMPLETED (the delivery has landed and
 * had a few days of use) that have no survey since that charge, create the
 * survey row, and emit the check-in event carrying the questions.
 *
 * EVENT-NAME MAPPING: the closed LifecycleEvent union has no dedicated
 * "survey sent" event, so the check-in reuses TREATMENT_MILESTONE with
 * payload.kind = "ADHERENCE_CHECK_IN". Milestone reward notifications use
 * payload.kind = "MILESTONE" (see milestones.server.ts) so Klaviyo flows and
 * analytics consumers can branch/filter on payload.kind.
 */
export async function sendPostDeliverySurveysJob(
  shop?: string,
): Promise<{ sent: number }> {
  const now = new Date();
  const events = await prisma.analyticsEvent.findMany({
    where: {
      name: "CHARGE_COMPLETED",
      occurredAt: {
        gte: addDays(now, -SURVEY_WINDOW_START_DAYS),
        lte: addDays(now, -SURVEY_WINDOW_END_DAYS),
      },
      ...(shop ? { shop } : {}),
    },
    orderBy: { occurredAt: "asc" },
  });

  let sent = 0;
  const handledContracts = new Set<string>();

  for (const event of events) {
    const contractId = event.contractId;
    if (!contractId || handledContracts.has(contractId)) continue;
    handledContracts.add(contractId);

    const contract = await prisma.subscriptionContract.findUnique({
      where: { id: contractId },
    });
    if (!contract || contract.status !== "ACTIVE") continue;

    const existing = await prisma.adherenceSurvey.findFirst({
      where: { contractId, sentAt: { gte: event.occurredAt } },
      select: { id: true },
    });
    if (existing) continue;

    const survey = await prisma.adherenceSurvey.create({
      data: {
        shop: contract.shop,
        contractId,
        shopifyCustomerId: contract.shopifyCustomerId,
        answersJson: "{}",
        sentAt: now,
      },
    });

    await emitLifecycleEvent({
      shop: contract.shop,
      name: "TREATMENT_MILESTONE",
      contractId,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: {
        kind: "ADHERENCE_CHECK_IN",
        surveyId: survey.id,
        questions: SURVEY_QUESTIONS,
        deliveryChargedAt: event.occurredAt.toISOString(),
        // Voice note for templates: a caring check-in, never a chase.
        intro:
          "A quick check-in on your treatment plan — tell us how it's going and we'll fine-tune your deliveries. Adjust, delay or cancel online.",
      },
      dedupeKey: `adherence-survey:${contractId}:${isoDate(event.occurredAt)}`,
    });

    await appendAudit({
      shop: contract.shop,
      actorType: "SYSTEM",
      action: "ADHERENCE_SURVEY_SENT",
      subjectType: "AdherenceSurvey",
      subjectId: survey.id,
      payload: { contractId, deliveryChargedAt: event.occurredAt.toISOString() },
    });
    sent += 1;
  }

  logger.info("post-delivery surveys sent", { shop: shop ?? "all", sent });
  return { sent };
}
