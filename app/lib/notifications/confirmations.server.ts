import prisma from "~/db.server";
import type { LogEventInput } from "~/lib/events/log.server";
import type { TemplateKey } from "./templates.server";

/**
 * Confirmation bridge (v1.17.0).
 *
 * The state-change confirmation emails (skip, delay, pause, cancel, …) were
 * historically "flow-owned": the event log fires a canonical Klaviyo metric
 * (events-map.server.ts) and the merchant's Klaviyo flow sends the email.
 * That stays the DEFAULT. But when the merchant flips a confirmation's
 * sender to "app" on the Emails page, this bridge — called by logEvent()
 * right next to the Klaviyo enqueue — sends the confirmation directly, so
 * the app can own every customer email without any Klaviyo flow existing.
 *
 * Rules:
 * - Fires ONLY for sender === "app" — an explicit merchant choice. "auto"
 *   keeps the historical owner (the flow), so upgrades change nothing.
 * - Fires only for moments a PERSON initiated (see the provenance gate):
 *   the copy says "as requested", so system-driven transitions — a
 *   consolidation merge-cancel, a stockout skip, a dunning cancel, the
 *   pause auto-resume — must never claim the customer asked for them.
 *   Those moments have their own messaging where messaging is due.
 * - The canonical state-change metric still fires independently (segments,
 *   analytics and any remaining flows are untouched); with sender "app" the
 *   router does not enqueue a second delivery metric, so there is no
 *   double-event and no double-email from OUR side. The Emails page warns
 *   the merchant to switch off a flow email before flipping a sender.
 * - One send per contract + template per dedupe window, enforced by an
 *   ATOMIC claim (a transient CLAIMED NotificationLog row) rather than
 *   check-then-act: the same customer moment can be logged twice within
 *   milliseconds (portal action + webhook sync race), and a confirmation
 *   must not arrive twice. Windows are per event type: the two types the
 *   webhook diff can double-log get 10 minutes; the service-only types get
 *   60 seconds, so a second DISTINCT action (swap A→B, then B→C minutes
 *   later) still confirms.
 * - Never throws — logEvent's containment contract extends here; the
 *   router's own gates (setup mode, ownership, demo fixture, channel
 *   toggles, enabled:false) all still apply inside sendNotification.
 */

export const CONFIRMATION_TEMPLATE_BY_EVENT: Record<string, TemplateKey> = {
  "cycle.skipped": "skip_confirmed",
  "cycle.unskipped": "unskip_confirmed",
  "cycle.delayed": "delay_confirmed",
  "contract.paused": "pause_confirmed",
  "contract.resumed": "resume_confirmed",
  "contract.line_swapped": "swap_confirmed",
  "contract.frequency_changed": "frequency_changed",
  "contract.cancelled": "cancel_confirmed",
};

/**
 * Only these two types can be logged twice for ONE moment (contract service
 * + the webhook status diff both record them when the race lands wrong), so
 * only they need the long window. Everything else is service-logged exactly
 * once per action; the short window merely absorbs accidental double
 * submission without eating a genuine second action.
 */
const LONG_WINDOW_TYPES = new Set(["contract.paused", "contract.cancelled"]);
const LONG_WINDOW_MS = 10 * 60 * 1000;
const SHORT_WINDOW_MS = 60 * 1000;

/** Transient claim rows carry this status; never SENT semantics. */
const CLAIM_STATUS = "CLAIMED";

/**
 * Provenance gate: does this event describe an action a person took?
 *
 * - SYSTEM / SCHEDULER events are automatic transitions (consolidation
 *   merge-cancels, stockout evaluation, auto-resume, dunning) — excluded.
 * - cycle.skipped carries `initiator` (CUSTOMER | ADMIN | STOCKOUT):
 *   only CUSTOMER skips may claim "as requested" (stockout skips have the
 *   stockout_skip template; ADMIN bulk skips are merchant ops).
 * - contract.cancelled carries `reason` and `cancelSource`: a MERGED cancel
 *   is bookkeeping (the customer never left — mailing them "your
 *   subscription is cancelled" would be actively harmful), and DUNNING /
 *   SYSTEM cancels have their own messaging. A webhook-observed cancel
 *   without a cancelSource (Shopify-admin cancel) is a real cancellation
 *   and does send.
 */
function isPersonInitiated(event: LogEventInput): boolean {
  if (event.source === "SYSTEM" || event.source === "SCHEDULER") return false;
  const payload = event.payload ?? {};
  if (event.type === "cycle.skipped") {
    const initiator = payload.initiator;
    if (typeof initiator === "string" && initiator !== "CUSTOMER") return false;
  }
  if (event.type === "contract.cancelled") {
    if (payload.reason === "MERGED") return false;
    const cancelSource = payload.cancelSource;
    if (
      typeof cancelSource === "string" &&
      cancelSource !== "CUSTOMER" &&
      cancelSource !== "ADMIN"
    ) {
      return false;
    }
  }
  return true;
}

/** Scalars from the event payload become copy placeholders ({weeks}, …). */
function scalarVars(
  payload: Record<string, unknown> | undefined,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (typeof v === "string" || typeof v === "number") out[k] = v;
    else if (typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/**
 * Entry point called from logEvent() for every internal event; anything not
 * in the confirmation map returns immediately (notification.* included, so
 * the bridge can never recurse through its own sends).
 */
export async function maybeSendConfirmationForEvent(
  event: LogEventInput,
): Promise<void> {
  try {
    const template = CONFIRMATION_TEMPLATE_BY_EVENT[event.type];
    if (!template || !event.contractId) return;
    if (!isPersonInitiated(event)) return;

    // Lazy imports keep the events↔notifications module graph acyclic.
    const { getSetting } = await import("~/lib/settings/settings.server");
    const emails = await getSetting(event.shopId, "emails");
    const override = emails.templates[template];
    if (!override || override.sender !== "app") return;
    if (override.enabled === false) return;

    // ── Atomic claim (dedupe without check-then-act) ────────────────────
    // Create our claim FIRST, then look at every claim/send in the window:
    // if anything is earlier than ours (an already-SENT confirmation, or a
    // rival claim from the racing duplicate logEvent), we back off and
    // delete our claim. Exactly one invocation survives; ties resolve
    // deterministically on (createdAt, id). The claim row is deleted after
    // the send, so the activity log never accumulates markers — a crash
    // strands one at worst, and it expires with the window.
    const windowMs = LONG_WINDOW_TYPES.has(event.type)
      ? LONG_WINDOW_MS
      : SHORT_WINDOW_MS;
    const cutoff = new Date(Date.now() - windowMs);
    const claim = await prisma.notificationLog.create({
      data: {
        shopId: event.shopId,
        contractId: event.contractId,
        channel: "EMAIL",
        template,
        status: CLAIM_STATUS,
        payload: { reason: "confirmation_claim", eventType: event.type },
      },
    });
    const rivals = await prisma.notificationLog.findMany({
      where: {
        contractId: event.contractId,
        template,
        status: { in: [CLAIM_STATUS, "SENT"] },
        createdAt: { gte: cutoff },
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const winner = rivals[0];
    if (!winner || winner.id !== claim.id) {
      await prisma.notificationLog
        .delete({ where: { id: claim.id } })
        .catch(() => {});
      return;
    }

    try {
      const { sendNotification } = await import("./send.server");
      await sendNotification({
        shopId: event.shopId,
        contractId: event.contractId,
        template,
        email: event.email ?? undefined,
        vars: scalarVars(event.payload),
      });
    } finally {
      await prisma.notificationLog
        .delete({ where: { id: claim.id } })
        .catch(() => {});
    }
  } catch (err) {
    console.error("[notifications] confirmation bridge failed", event.type, err);
  }
}
