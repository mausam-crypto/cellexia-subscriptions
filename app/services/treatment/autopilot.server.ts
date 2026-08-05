/**
 * Autopilot — the ONLY treatment component allowed to touch a delivery date,
 * and only inside guardrails the customer set themselves
 * (SubscriptionContract.guardrailsJson, shape AutopilotGuardrails).
 *
 * Decision logic (evaluateAutopilotAdjustment) is pure; execution
 * (applyAutopilot) goes through core's setNextBillingDate under an
 * idempotency key.
 *
 * EVENT-NAME MAPPING (the LifecycleEvent union is closed; documented per spec):
 * - Executed date moves emit "SHIPMENT_DELAYED" — ONLY for moves the
 *   autopilot actually performed, in EITHER direction, with
 *   payload.direction = "DELAY" | "BRING_FORWARD" and payload.source =
 *   "autopilot" to disambiguate. There is no BROUGHT_FORWARD event name.
 * - Confirm requests (a change is warranted but guardrails require a
 *   customer tap) emit the depletion event matching the direction:
 *   "LIKELY_EXCESS_INVENTORY" for a proposed DELAY,
 *   "LIKELY_PRODUCT_SHORTAGE" for a proposed BRING_FORWARD,
 *   with payload {proposal: "one-tap-confirm", newDate}. Klaviyo flows on
 *   those events render the one-tap confirm.
 *   (ELIGIBLE_FOR_UPGRADE, FIRST_CHARGE_APPROACHING and
 *   PRE_SHIPMENT_WINDOW_OPEN were considered and rejected — they belong to
 *   other modules' semantics.)
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import { setNextBillingDate } from "~/services/core/contracts.server";
import { commitmentStatusFor } from "~/services/retention/policy.server";
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import { addDays, addWeeks, daysBetween, isoDate } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import type { ActorType, AutopilotGuardrails } from "~/types/domain";
import type { DepletionEstimate } from "@prisma/client";

// ─────────────────────────────── Guardrails ───────────────────────────────

export const DEFAULT_GUARDRAILS: AutopilotGuardrails = {
  maxChargeCents: null,
  askBeforeAdding: true,
  minIntervalWeeks: 2,
  notifyDaysBefore: 3,
};

/** Parse a contract's guardrailsJson, filling defaults for missing keys. */
export function getGuardrails(contract: {
  guardrailsJson?: string | null;
}): AutopilotGuardrails {
  const parsed = parseJson<Partial<AutopilotGuardrails>>(
    contract.guardrailsJson ?? null,
    {},
  );
  return { ...DEFAULT_GUARDRAILS, ...parsed };
}

/** Persist guardrails on a contract (with audit). */
export async function setGuardrails(
  shop: string,
  contractId: string,
  guardrails: AutopilotGuardrails,
  actor: { actorType: ActorType; actorId?: string | null } = { actorType: "SYSTEM" },
) {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
    select: { id: true, shop: true },
  });
  if (!contract || contract.shop !== shop) {
    throw new Error(`setGuardrails: contract not found: ${contractId}`);
  }
  const updated = await prisma.subscriptionContract.update({
    where: { id: contractId },
    data: { guardrailsJson: JSON.stringify(guardrails) },
  });
  await appendAudit({
    shop,
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
    action: "AUTOPILOT_GUARDRAILS_SET",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: { guardrails: { ...guardrails } },
  });
  return updated;
}

// ─────────────────────────────── Pure decision ────────────────────────────

/** Deliver this many days before the predicted run-out. */
const RUNOUT_BUFFER_DAYS = 3;
/** Ignore adjustments smaller than this — not worth touching the schedule. */
const MIN_MOVE_DAYS = 4;
/** Below this estimate confidence the autopilot stays silent. */
const MIN_CONFIDENCE = 0.4;
/** Moves larger than this always ask the customer first. */
const MAX_AUTO_MOVE_DAYS = 28;

export interface AutopilotContractInput {
  nextBillingDate: Date | null;
  intervalWeeks: number;
  /** Expected charge for the next cycle, integer cents (null when unknown). */
  expectedChargeCents?: number | null;
}

export interface AutopilotDepletionInput {
  predictedRunOutAt: Date | null;
  confidence: number;
  lastDeliveryAt?: Date | null;
}

export type AutopilotDirection = "DELAY" | "BRING_FORWARD";

export type AutopilotProposal =
  | { action: "MOVE_DATE"; newDate: Date; direction: AutopilotDirection }
  | {
      action: "CONFIRM_REQUEST";
      newDate: Date;
      direction: AutopilotDirection;
      reason: string;
    };

/**
 * Pure: given the contract schedule, the depletion estimate and the
 * customer's guardrails, propose either a silent date move, a one-tap
 * confirm request, or nothing.
 *
 * Guardrails respected:
 * - minIntervalWeeks: never schedule sooner than that after the last delivery
 * - notifyDaysBefore: never move to a date the customer can't be told about
 *   in time
 * - maxChargeCents: charges above the cap always require confirmation
 */
export function evaluateAutopilotAdjustment(
  contract: AutopilotContractInput,
  depletion: AutopilotDepletionInput,
  guardrails: AutopilotGuardrails,
  now: Date = new Date(),
): AutopilotProposal | null {
  if (!contract.nextBillingDate || !depletion.predictedRunOutAt) return null;
  if (depletion.confidence < MIN_CONFIDENCE) return null;

  // Aim to deliver shortly before the product runs out.
  let desired = addDays(depletion.predictedRunOutAt, -RUNOUT_BUFFER_DAYS);

  // Guardrail: keep at least minIntervalWeeks since the last delivery.
  if (guardrails.minIntervalWeeks != null && depletion.lastDeliveryAt) {
    const earliest = addWeeks(depletion.lastDeliveryAt, guardrails.minIntervalWeeks);
    if (desired.getTime() < earliest.getTime()) desired = earliest;
  }

  // Guardrail: the customer must get notifyDaysBefore days of notice.
  const earliestNotice = addDays(now, guardrails.notifyDaysBefore);
  if (desired.getTime() < earliestNotice.getTime()) desired = earliestNotice;

  const moveDays = daysBetween(contract.nextBillingDate, desired);
  if (Math.abs(moveDays) < MIN_MOVE_DAYS) return null;

  const direction: AutopilotDirection = moveDays > 0 ? "DELAY" : "BRING_FORWARD";

  // Guardrail: charges above the customer's cap always require a tap.
  if (
    guardrails.maxChargeCents != null &&
    contract.expectedChargeCents != null &&
    contract.expectedChargeCents > guardrails.maxChargeCents
  ) {
    return {
      action: "CONFIRM_REQUEST",
      newDate: desired,
      direction,
      reason: "charge-above-guardrail",
    };
  }

  // Large swings are proposed, never silently executed.
  if (Math.abs(moveDays) > MAX_AUTO_MOVE_DAYS) {
    return {
      action: "CONFIRM_REQUEST",
      newDate: desired,
      direction,
      reason: "large-move",
    };
  }

  return { action: "MOVE_DATE", newDate: desired, direction };
}

// ─────────────────────────────── Execution ────────────────────────────────

/**
 * Evaluate and execute the autopilot for one contract:
 * - MOVE_DATE within guardrails → core setNextBillingDate under an
 *   idempotency key, audit, emit SHIPMENT_DELAYED (see mapping above).
 * - CONFIRM_REQUEST → emit the direction-matching depletion event with a
 *   one-tap-confirm payload; no schedule change.
 * Returns the proposal that was acted on, or null when nothing was needed.
 */
export async function applyAutopilot(
  graphql: AdminGraphql,
  shop: string,
  contractId: string,
): Promise<AutopilotProposal | null> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractId },
    include: { lines: { include: { depletion: true } } },
  });
  if (!contract || contract.shop !== shop) {
    throw new Error(`applyAutopilot: contract not found: ${contractId}`);
  }
  if (!contract.autopilotEnabled || contract.status !== "ACTIVE") return null;

  // Committed plans keep their schedule fixed until the commitment is met —
  // autopilot never moves dates during that phase (same rule as the portal's
  // schedule gate; CS can still act through the console).
  const commitment = await commitmentStatusFor(shop, {
    id: contract.id,
    successfulOrders: contract.successfulOrders,
  });
  if (commitment.committed && !commitment.met) return null;

  // The binding constraint is the line that runs out first.
  const estimates = contract.lines
    .map((line) => line.depletion)
    .filter(
      (d): d is DepletionEstimate => d != null && d.predictedRunOutAt != null,
    )
    .sort(
      (a, b) =>
        (a.predictedRunOutAt as Date).getTime() -
        (b.predictedRunOutAt as Date).getTime(),
    );
  const binding = estimates[0];
  if (!binding) return null;

  const expectedChargeCents = contract.lines.reduce(
    (sum, line) => sum + line.currentPriceCents * line.quantity,
    0,
  );
  const guardrails = getGuardrails(contract);

  const proposal = evaluateAutopilotAdjustment(
    {
      nextBillingDate: contract.nextBillingDate,
      intervalWeeks: contract.intervalWeeks,
      expectedChargeCents,
    },
    {
      predictedRunOutAt: binding.predictedRunOutAt,
      confidence: binding.confidence,
      lastDeliveryAt: binding.lastDeliveryAt,
    },
    guardrails,
  );
  if (!proposal) return null;

  const newDateIso = isoDate(proposal.newDate);

  if (proposal.action === "MOVE_DATE") {
    const previous = contract.nextBillingDate;
    await withIdempotency(
      `autopilot:move:${contractId}:${newDateIso}`,
      "autopilot",
      async () => {
        await setNextBillingDate(graphql, shop, contractId, proposal.newDate);
        return { movedTo: newDateIso };
      },
    );
    await appendAudit({
      shop,
      actorType: "SYSTEM",
      action: "AUTOPILOT_MOVE_DATE",
      subjectType: "SubscriptionContract",
      subjectId: contractId,
      payload: {
        direction: proposal.direction,
        from: previous ? previous.toISOString() : null,
        to: proposal.newDate.toISOString(),
        guardrails: { ...guardrails },
      },
    });
    // SHIPMENT_DELAYED is emitted ONLY for actually-executed moves (mapping
    // documented at the top of this file); payload.direction disambiguates.
    await emitLifecycleEvent({
      shop,
      name: "SHIPMENT_DELAYED",
      contractId,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: {
        source: "autopilot",
        direction: proposal.direction,
        previousDate: previous ? previous.toISOString() : null,
        newDate: proposal.newDate.toISOString(),
        note: "We fine-tuned your next delivery to match how you're using your treatment. Adjust, delay or cancel online.",
      },
      dedupeKey: `autopilot:move:${contractId}:${newDateIso}`,
    });
    return proposal;
  }

  // CONFIRM_REQUEST — no change; ask the customer with a one-tap confirm.
  // DELAY proposals mean the product outlasts the schedule (excess);
  // BRING_FORWARD proposals mean it runs out early (shortage).
  const eventName =
    proposal.direction === "DELAY"
      ? "LIKELY_EXCESS_INVENTORY"
      : "LIKELY_PRODUCT_SHORTAGE";
  await emitLifecycleEvent({
    shop,
    name: eventName,
    contractId,
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail,
    payload: {
      proposal: "one-tap-confirm",
      direction: proposal.direction,
      reason: proposal.reason,
      newDate: proposal.newDate.toISOString(),
      currentDate: contract.nextBillingDate
        ? contract.nextBillingDate.toISOString()
        : null,
      note: "Based on how you're using your treatment we suggest a new delivery date — confirm in one tap, or leave things as they are.",
    },
    dedupeKey: `autopilot:confirm:${contractId}:${newDateIso}`,
  });
  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "AUTOPILOT_CONFIRM_REQUESTED",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: {
      direction: proposal.direction,
      reason: proposal.reason,
      newDate: proposal.newDate.toISOString(),
    },
  });
  return proposal;
}
