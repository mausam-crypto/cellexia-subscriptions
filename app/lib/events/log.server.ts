import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";

export type EventSource =
  | "SYSTEM"
  | "WEBHOOK"
  | "ADMIN"
  | "CUSTOMER_PORTAL"
  | "MAGIC_LINK"
  | "SCHEDULER"
  | "KLAVIYO";

export interface LogEventInput {
  shopId: string;
  type: string; // dot-namespaced, e.g. "contract.created", "cycle.skipped", "dunning.retry_scheduled"
  source: EventSource;
  contractId?: string | null;
  customerId?: string | null;
  email?: string | null;
  actor?: string | null; // admin email, "customer", "system"
  payload?: Record<string, unknown>;
}

export interface LogEventOptions {
  /**
   * Caller's open transaction: the SubscriberEvent insert rides it, so the
   * event commits or rolls back WITH the mutation it records instead of in a
   * separate best-effort write. The Klaviyo enqueue still happens after the
   * insert, outside the transaction, best-effort — callers that need the
   * event to be truly atomic with their state change should pair `tx` with
   * `logEventOrThrow` (a swallowed insert failure inside an open Postgres
   * transaction leaves that transaction aborted anyway, so there is nothing
   * useful to contain).
   */
  tx?: Prisma.TransactionClient;
}

// ── Swallowed-write accounting ───────────────────────────────────────────────
//
// logEvent's never-throw contract means a failed SubscriberEvent insert is a
// PERMANENT, otherwise-invisible loss: the surrounding operation still reports
// success, the webhook receipt is stamped PROCESSED, and Shopify's retry train
// ends. That matters because several numbers and guards have the event log as
// their ONLY source:
//  - rollup refundedCents (refund_recorded events), takeRateDen
//    (checkout.subscribable), skips/savesOffered/savesAccepted/addonsAttached
//    (rollup.server.ts event counters);
//  - winback touch dedupe (hasEventSince), lifecycle dedupe
//    (hasOrderCountEvent/hasEvent), the stockout delay cap (stockout.delayed
//    count), the portal mutation rate limit (insert-then-count), and the
//    plan-drift daily API budget gate (system.plan_group_drift_check).
// The counter below is the operator-visibility half of the fix: every
// swallowed failure is counted in-process and the alert scan raises/refreshes
// a deduped EVENT_WRITE_FAILURES alert from it (alerts.server.ts). In-process
// is deliberate — the DB just refused a write, so durable accounting of the
// failure cannot ride the same DB on the same path; the alert check pairs the
// count with `processStartedAt` so a restart (which resets it) is never read
// as recovery. Sole-source WRITERS should move to `tx`/`logEventOrThrow` (the
// discounts.server.ts marker pattern) — the counter is the safety net, not
// the fix.

const processStartedAt = new Date().toISOString();

const writeFailures = {
  count: 0,
  lastAt: null as Date | null,
  lastType: null as string | null,
};

export interface EventWriteFailureStats {
  /** Swallowed SubscriberEvent insert failures since this process started. */
  count: number;
  lastAt: Date | null;
  /** Event type of the most recently lost write (triage pointer, not a log). */
  lastType: string | null;
  /** Identifies the counting process — a restart resets the counter. */
  processStartedAt: string;
}

/** Snapshot of the swallowed-write counter (read by the alert scan). */
export function getEventWriteFailureStats(): EventWriteFailureStats {
  return { ...writeFailures, processStartedAt };
}

async function writeEvent(
  db: Prisma.TransactionClient,
  input: LogEventInput,
): Promise<void> {
  await db.subscriberEvent.create({
    data: {
      shopId: input.shopId,
      contractId: input.contractId ?? null,
      customerId: input.customerId ?? null,
      email: input.email ?? null,
      type: input.type,
      source: input.source,
      actor: input.actor ?? null,
      payload: (input.payload ?? {}) as object,
    },
  });
}

async function enqueueKlaviyo(input: LogEventInput): Promise<void> {
  try {
    // Klaviyo mapping lives in the Klaviyo module; lazy import avoids cycles.
    const { enqueueKlaviyoForEvent } = await import(
      "~/lib/klaviyo/events-map.server"
    );
    await enqueueKlaviyoForEvent(input);
  } catch (err) {
    console.error("[events] klaviyo enqueue failed", input.type, err);
  }
}

function sendConfirmations(input: LogEventInput): void {
  // Confirmation emails for app-sent state-change moments (v1.17.0): fires
  // only for the templates the merchant flipped to sender "app" on the
  // Emails page. DELIBERATELY not awaited — logEvent runs inside portal
  // actions and webhook handlers, and an email delivery (SMTP round-trip)
  // must never sit on those response paths; the bridge contains every
  // failure internally and the mailer fails fast on a hung transport.
  import("~/lib/notifications/confirmations.server")
    .then(({ maybeSendConfirmationForEvent }) =>
      maybeSendConfirmationForEvent(input),
    )
    .catch((err) => {
      console.error("[events] confirmation send failed", input.type, err);
    });
}

/**
 * Single funnel for every subscriber-affecting event. Writes the immutable
 * event log (timeline + audit + compliance) and forwards to the Klaviyo outbox
 * for event types that power flows/segments.
 *
 * Never throws — an analytics write must never break a billing operation.
 * Swallowed insert failures are counted (see above) and surface as the
 * EVENT_WRITE_FAILURES alert. Callers whose event IS load-bearing state
 * (markers, counters, dedupe guards) should pass their transaction and use
 * `logEventOrThrow` instead of relying on this containment.
 */
export async function logEvent(
  input: LogEventInput,
  opts: LogEventOptions = {},
): Promise<void> {
  try {
    await writeEvent(opts.tx ?? prisma, input);
  } catch (err) {
    writeFailures.count += 1;
    writeFailures.lastAt = new Date();
    writeFailures.lastType = input.type;
    console.error("[events] failed to write event log", input.type, err);
  }

  await enqueueKlaviyo(input);
  sendConfirmations(input);
}

/**
 * `logEvent` without the containment: the SubscriberEvent insert failure
 * propagates to the caller (and is NOT counted as a swallowed loss — the
 * caller sees it and owns the recovery). For event writes that are themselves
 * state — dedupe markers, rate-limit rows, budget gates — where a silent miss
 * decouples the marker from the action it guards. The Klaviyo enqueue only
 * runs after a successful insert, preserving audit-log-before-Klaviyo: the
 * outbox can never receive an event the local log refused.
 */
export async function logEventOrThrow(
  input: LogEventInput,
  opts: LogEventOptions = {},
): Promise<void> {
  await writeEvent(opts.tx ?? prisma, input);
  await enqueueKlaviyo(input);
  sendConfirmations(input);
}

/** Timeline for one contract, newest first. */
export async function contractTimeline(contractId: string, limit = 200) {
  return prisma.subscriberEvent.findMany({
    where: { contractId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
