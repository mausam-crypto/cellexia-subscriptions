import prisma from "~/db.server";
import { logEvent, logEventOrThrow, type EventSource } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { escapeHtml } from "~/lib/portal/layout.server";
import { formatShopDate } from "~/lib/dates.server";
import { formatMoney } from "~/lib/money";
import { getSupportChannels, type ReplyPromise, type SupportChannels } from "./channels.server";

/**
 * Support requests (v1.28.0, P5.1) — the ONE submit path behind the portal
 * Get-help form (Account page, subscription pages, the payment-issue
 * banner's "Get help") and the cancel-flow SUPPORT/EDUCATION save cards.
 *
 * What a submit does, in order, each step contained (golden rule 9 — a
 * broken mailer or alert can never turn a submitted request into an error
 * toast; the EVENT is the record of truth and is written first):
 *  1. `support.requested` event on the contract (topic, orderRef, pushBack,
 *     message, source, reason). logEvent's Klaviyo mapping forwards it as
 *     "Cellexia Support Requested" (events-map.server.ts) — nothing here
 *     enqueues Klaviyo directly.
 *  2. Optional "push my next order back 1 week" (Delivery problem only,
 *     ACTIVE contracts only) through the portal's own delay semantics
 *     (delayModeFor → delaySchedule / delayNextCycle, source CUSTOMER_PORTAL)
 *     — the service logs its canonical cycle.delayed; the outcome is stamped
 *     on the request event payload (pushBackApplied) so admin + Klaviyo see
 *     what actually happened, never what was asked.
 *  3. Admin alert SUPPORT_REQUEST, deduped per contract per shop-day (a
 *     customer who writes twice today raises one alert; the events list on
 *     the subscriber page shows every request).
 *  4. Email to the resolved support inbox (settings.support.email →
 *     Shop.contactEmail), Reply-To = the customer, through the direct
 *     mailer (never Klaviyo). No inbox ⇒ silently skipped.
 *
 * Never throws for steps 2–4; step 1 failing (DB down) DOES throw — there is
 * no request without its record.
 */

export const SUPPORT_TOPICS = ["DELIVERY", "PAYMENT", "PLAN", "OTHER"] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

export function isSupportTopic(value: unknown): value is SupportTopic {
  return (
    typeof value === "string" &&
    (SUPPORT_TOPICS as readonly string[]).includes(value)
  );
}

/** Free-text bounds shared by the form (maxlength) and the validator. */
export const SUPPORT_MESSAGE_MAX = 2000;
/** What travels into the event payload / Klaviyo properties. */
const MESSAGE_EVENT_MAX = 1000;

export interface SupportRequestContract {
  id: string;
  shopId: string;
  customerId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  status: string;
  nextBillingDate?: Date | null;
  currencyCode?: string;
  locale?: string | null;
  isDemo?: boolean;
}

export interface SubmitSupportRequestInput {
  shopId: string;
  /** myshopify domain — the contracts service key for the push-back. */
  shopDomain: string;
  contract: SupportRequestContract;
  topic: SupportTopic;
  message: string;
  /** Local BillingAttempt id (validated by the caller) or Shopify order name. */
  orderRef?: string | null;
  /** Human label for the order (order name / date) — for the email/alert. */
  orderLabel?: string | null;
  pushBack: boolean;
  /** Where the form lived. */
  surface: "portal_account" | "portal_detail" | "portal_dunning" | "cancel_flow";
  /** Cancel-flow context: the reason the customer picked, when any. */
  cancelReason?: string | null;
  cancelSessionId?: string | null;
  /** Cancel-flow context (v1.28.0, P3.7): the free-text reason detail the
   * customer typed on the survey — shown to the admin next to the request. */
  cancelReasonDetail?: string | null;
  /**
   * Concierge save (v1.28.0, P3.7): this request IS a retention save — the
   * alert carries `saveRequest: true` so the admin queue and the SLA job can
   * tell it from a plain Get-help submit.
   */
  saveRequest?: boolean;
  source?: EventSource;
  actor?: string | null;
  now?: Date;
}

export interface SubmitSupportRequestResult {
  eventLogged: true;
  /** The push-back was asked for AND applied. */
  pushBackApplied: boolean;
  /** The push-back was asked for but refused/failed (customer told so). */
  pushBackFailed: boolean;
  alertRaised: boolean;
  emailSent: boolean;
  /** The reply promise as resolved at submit time (supportReplyPromise phrases it). */
  replyWithin: ReplyPromise;
  channels: SupportChannels;
}

/**
 * Per-customer support budget, shared by EVERY surface that can submit a
 * request (portal `POST /api/support` and the cancel-flow SUPPORT/EDUCATION
 * save cards). Insert-then-count on the same `portal.mutation_attempt` rows
 * the portal dispatcher uses (payload.action "support"): the attempt is
 * recorded FIRST so a concurrent burst always sees at least its own row.
 * Both budgets apply — the general portal.mutationsPerHour and the stricter
 * settings.support.requestsPerHour. Attempt rows carry no contractId (clean
 * timelines) and the type is unmapped in the Klaviyo event map.
 *
 * `recordAttempt: false` when the caller already inserted this request's
 * general attempt row (the portal dispatcher does so before dispatching).
 */
export async function supportBudgetExceeded(input: {
  shopId: string;
  customerId: string;
  email: string;
  recordAttempt: boolean;
  now?: Date;
}): Promise<boolean> {
  const since = new Date((input.now ?? new Date()).getTime() - 3600_000);
  if (input.recordAttempt) {
    await logEvent({
      shopId: input.shopId,
      customerId: input.customerId,
      email: input.email,
      type: "portal.mutation_attempt",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: { action: "support" },
    });
  }
  const [portalSettings, supportSettings] = await Promise.all([
    getSetting(input.shopId, "portal"),
    getSetting(input.shopId, "support"),
  ]);
  const base = {
    shopId: input.shopId,
    customerId: input.customerId,
    source: "CUSTOMER_PORTAL" as const,
    type: "portal.mutation_attempt",
    createdAt: { gte: since },
  };
  const [recentAll, recentSupport] = await Promise.all([
    prisma.subscriberEvent.count({ where: base }),
    prisma.subscriberEvent.count({
      where: { ...base, payload: { path: ["action"], equals: "support" } },
    }),
  ]);
  // Strictly greater: the counts include the attempt just inserted.
  return (
    recentAll > portalSettings.mutationsPerHour ||
    recentSupport > supportSettings.requestsPerHour
  );
}

/** Trim, collapse CR/LF runs, cap length. Empty ⇒ "". */
export function normalizeSupportMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\r\n?/g, "\n").trim().slice(0, SUPPORT_MESSAGE_MAX);
}

/**
 * The last N billed cycles of a contract, newest first — the order picker's
 * source. Local mirror only (BillingAttempt SUCCESS rows); what the mirror
 * lacks (older imports, other-app history) is simply not offered. Contained.
 */
export async function recentOrdersForPicker(
  contractId: string,
  limit = 5,
): Promise<
  Array<{ id: string; orderName: string | null; at: Date; amountCents: number | null }>
> {
  try {
    const rows = await prisma.billingAttempt.findMany({
      where: { contractId, status: "SUCCESS" },
      orderBy: [{ completedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        orderName: true,
        completedAt: true,
        createdAt: true,
        amountCents: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      orderName: r.orderName,
      at: r.completedAt ?? r.createdAt,
      amountCents: r.amountCents,
    }));
  } catch (err) {
    console.error("[support] recent orders read failed", contractId, err);
    return [];
  }
}

/** Display label for a picker row ("#1042 · 3 Aug 2026 · CHF 49.00"). */
export function orderPickerLabel(
  row: { orderName: string | null; at: Date; amountCents: number | null },
  tz: string,
  locale: string,
  currencyCode: string,
): string {
  const parts = [
    row.orderName ?? null,
    formatShopDate(row.at, tz, locale),
    row.amountCents != null ? formatMoney(row.amountCents, currencyCode, locale) : null,
  ].filter((p): p is string => !!p);
  return parts.join(" · ");
}

/**
 * Resolves the caller-supplied order ref against the contract's own billed
 * cycles: a valid BillingAttempt id ⇒ its label; anything else ⇒ null (the
 * request still goes through, just without an order attached — never an
 * error for the customer).
 */
export async function resolveOrderRef(
  contractId: string,
  raw: unknown,
  tz: string,
  locale: string,
  currencyCode: string,
): Promise<{ orderRef: string; orderLabel: string } | null> {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  const rows = await recentOrdersForPicker(contractId, 5);
  const hit = rows.find((r) => r.id === raw);
  if (!hit) return null;
  return {
    orderRef: hit.orderName ?? hit.id,
    orderLabel: orderPickerLabel(hit, tz, locale, currencyCode),
  };
}

const TOPIC_LABEL_EN: Record<SupportTopic, string> = {
  DELIVERY: "Delivery problem",
  PAYMENT: "Payment",
  PLAN: "Change my plan",
  OTHER: "Something else",
};

/** Admin-facing English label (alerts, merchant email, subscriber page). */
export function supportTopicLabelEn(topic: string): string {
  return isSupportTopic(topic) ? TOPIC_LABEL_EN[topic] : topic;
}

async function applyPushBack(
  input: SubmitSupportRequestInput,
): Promise<{ applied: boolean; mode: "once" | "reanchor" | null }> {
  if (input.contract.status !== "ACTIVE") return { applied: false, mode: null };
  try {
    const [{ delayModeFor }, service, portalSettings] = await Promise.all([
      import("~/lib/portal/schedule.server"),
      import("~/lib/contracts/service.server"),
      getSetting(input.shopId, "portal"),
    ]);
    // The SAME decision the "Delay 1 week" button makes (P2.2): re-anchor
    // when the setting says so, one-cycle delay otherwise.
    const mode = delayModeFor(portalSettings, null);
    const opts = {
      source: input.source ?? ("CUSTOMER_PORTAL" as const),
      actor: input.actor ?? "customer",
    };
    if (mode === "reanchor") {
      await service.delaySchedule(input.shopDomain, input.contract.id, { weeks: 1 }, opts);
    } else {
      await service.delayNextCycle(input.shopDomain, input.contract.id, { weeks: 1 }, opts);
    }
    return { applied: true, mode };
  } catch (err) {
    console.error("[support] push-back delay failed", input.contract.id, err);
    return { applied: false, mode: null };
  }
}

async function raiseSupportAlert(
  input: SubmitSupportRequestInput,
  now: Date,
  extra: {
    orderLabel: string | null;
    pushBackApplied: boolean;
    /** The reply promise the customer READ (v1.29.0) — the SLA job judges against it. */
    replyWithin?: ReplyPromise;
  },
): Promise<boolean> {
  try {
    const { raiseAlert } = await import("~/lib/analytics/alerts.server");
    const who =
      [input.contract.firstName, input.contract.lastName].filter(Boolean).join(" ") ||
      input.contract.email;
    const bits = [
      `${supportTopicLabelEn(input.topic)} from ${who} (${input.contract.email})`,
      extra.orderLabel ? `order ${extra.orderLabel}` : null,
      extra.pushBackApplied ? "next order pushed back 1 week" : null,
      input.saveRequest ? "SAVE REQUEST — the customer stays if you answer" : null,
      input.cancelReason ? `during cancel flow (${input.cancelReason})` : null,
      input.cancelReasonDetail ? `they wrote: “${input.cancelReasonDetail.slice(0, 120)}”` : null,
    ].filter(Boolean);
    const excerpt = input.message.length > 160 ? `${input.message.slice(0, 157)}…` : input.message;
    // One per contract per shop-day: dedupe key = contractId within the
    // current UTC day (a shop-tz day would need the tz here; the day
    // boundary only decides whether a SECOND alert appears, never whether
    // the request is recorded).
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return await raiseAlert({
      shopId: input.shopId,
      type: "SUPPORT_REQUEST",
      severity: "WARNING",
      message: `Support request — ${bits.join(" · ")}${excerpt ? `: “${excerpt}”` : ""}`,
      context: {
        contractId: input.contract.id,
        subscriberUrl: `/app/subscribers/${input.contract.id}`,
        topic: input.topic,
        orderRef: input.orderRef ?? null,
        pushBack: input.pushBack,
        pushBackApplied: extra.pushBackApplied,
        surface: input.surface,
        ...(input.cancelReason ? { cancelReason: input.cancelReason } : {}),
        ...(input.cancelReasonDetail
          ? { cancelReasonDetail: input.cancelReasonDetail.slice(0, 500) }
          : {}),
        ...(input.cancelSessionId ? { cancelSessionId: input.cancelSessionId } : {}),
        ...(input.saveRequest ? { saveRequest: true } : {}),
        // The promise as it stood when the customer read it: the breach job
        // measures THIS, not the setting at tick time (a merchant editing the
        // promise must not silence or invent breaches for open requests).
        ...(extra.replyWithin ? { replyWithin: extra.replyWithin } : {}),
      },
      // A concierge save request (P3.7) dedupes on its cancel session, never
      // on the day: an earlier plain Get-help submit the same day must not
      // swallow the alert the SLA job and the admin queue key on.
      dedupe:
        input.saveRequest && input.cancelSessionId
          ? { key: "cancelSessionId", value: input.cancelSessionId, since: dayStart }
          : { key: "contractId", value: input.contract.id, since: dayStart },
    });
  } catch (err) {
    console.error("[support] alert raise failed", input.contract.id, err);
    return false;
  }
}

async function emailMerchant(
  input: SubmitSupportRequestInput,
  channels: SupportChannels,
  extra: { orderLabel: string | null; pushBackApplied: boolean },
): Promise<boolean> {
  if (!channels.email) return false;
  try {
    const { sendEmail } = await import("~/lib/notifications/mailer.server");
    const who =
      [input.contract.firstName, input.contract.lastName].filter(Boolean).join(" ") ||
      input.contract.email;
    const rows: Array<[string, string]> = [
      ["Topic", supportTopicLabelEn(input.topic)],
      ["From", `${who} <${input.contract.email}>`],
      ["Subscription", input.contract.id],
      ...(extra.orderLabel ? ([["Order", extra.orderLabel]] as Array<[string, string]>) : []),
      ...(input.pushBack
        ? ([
            [
              "Push next order back 1 week",
              extra.pushBackApplied ? "applied" : "requested — NOT applied",
            ],
          ] as Array<[string, string]>)
        : []),
      ...(input.cancelReason
        ? ([["Cancel flow", `reason ${input.cancelReason}`]] as Array<[string, string]>)
        : []),
      ...(input.cancelReasonDetail
        ? ([["They wrote on the survey", input.cancelReasonDetail]] as Array<[string, string]>)
        : []),
      ...(input.saveRequest
        ? ([
            [
              "Save request",
              "yes — this customer was about to cancel and stays if you answer",
            ],
          ] as Array<[string, string]>)
        : []),
      ["Where", input.surface],
    ];
    const table = rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
      )
      .join("");
    const message = input.message
      ? `<p style="white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px;margin:16px 0">${escapeHtml(input.message)}</p>`
      : `<p style="color:#666">(no message)</p>`;
    const subscriberUrl = `/app/subscribers/${input.contract.id}`;
    await sendEmail({
      shopId: input.shopId,
      to: channels.email,
      replyTo: input.contract.email,
      subject: `[Support] ${supportTopicLabelEn(input.topic)} — ${who}`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#222"><p>A subscriber asked for help through the subscription portal. Reply to this email to answer them directly.</p><table style="border-collapse:collapse">${table}</table>${message}<p style="color:#666;font-size:12px">Subscriber page: ${escapeHtml(subscriberUrl)} (inside the Cellexia app)</p></div>`,
    });
    return true;
  } catch (err) {
    console.error("[support] merchant email failed", input.contract.id, err);
    return false;
  }
}

export async function submitSupportRequest(
  input: SubmitSupportRequestInput,
): Promise<SubmitSupportRequestResult> {
  const now = input.now ?? new Date();
  const source: EventSource = input.source ?? "CUSTOMER_PORTAL";
  const actor = input.actor ?? "customer";
  const wantsPushBack = input.pushBack && input.topic === "DELIVERY";

  // 2 (before 1 only in ORDER OF SIDE EFFECT, so the record can state the
  // outcome truthfully): the push-back through the portal's delay semantics.
  const push = wantsPushBack
    ? await applyPushBack(input)
    : { applied: false, mode: null as "once" | "reanchor" | null };

  // 1. The record of truth. Throws if it cannot be written.
  await logEventOrThrow({
    shopId: input.shopId,
    contractId: input.contract.id,
    customerId: input.contract.customerId,
    email: input.contract.email,
    type: "support.requested",
    source,
    actor,
    payload: {
      topic: input.topic,
      contractId: input.contract.id,
      orderRef: input.orderRef ?? null,
      pushBack: wantsPushBack,
      pushBackApplied: push.applied,
      ...(push.mode ? { pushBackMode: push.mode } : {}),
      message: input.message.slice(0, MESSAGE_EVENT_MAX),
      surface: input.surface,
      ...(input.cancelReason ? { cancelReason: input.cancelReason } : {}),
      ...(input.cancelSessionId ? { cancelSessionId: input.cancelSessionId } : {}),
      ...(input.cancelReasonDetail
        ? { cancelReasonDetail: input.cancelReasonDetail.slice(0, MESSAGE_EVENT_MAX) }
        : {}),
      ...(input.saveRequest ? { saveRequest: true } : {}),
    },
  });

  const channels = await getSupportChannels(input.shopId);
  const extra = {
    orderLabel: input.orderLabel ?? null,
    pushBackApplied: push.applied,
    replyWithin: channels.replyWithin,
  };

  // 3 + 4: demo fixtures never page the merchant.
  let alertRaised = false;
  let emailSent = false;
  if (!input.contract.isDemo) {
    alertRaised = await raiseSupportAlert(input, now, extra);
    emailSent = await emailMerchant(input, channels, extra);
  }

  return {
    eventLogged: true,
    pushBackApplied: push.applied,
    pushBackFailed: wantsPushBack && !push.applied,
    alertRaised,
    emailSent,
    replyWithin: channels.replyWithin,
    channels,
  };
}

/**
 * Newest support requests of a contract (admin subscriber page). Contained.
 */
export async function recentSupportRequests(
  contractId: string,
  limit = 5,
): Promise<
  Array<{
    id: string;
    createdAt: Date;
    topic: string;
    message: string;
    orderRef: string | null;
    pushBackApplied: boolean;
    surface: string | null;
    cancelReason: string | null;
    /** v1.28.0 (P3.7): the survey free text + the concierge-save flag. */
    cancelReasonDetail: string | null;
    saveRequest: boolean;
  }>
> {
  try {
    const rows = await prisma.subscriberEvent.findMany({
      where: { contractId, type: "support.requested" },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, payload: true },
    });
    return rows.map((r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        createdAt: r.createdAt,
        topic: typeof p.topic === "string" ? p.topic : "OTHER",
        message: typeof p.message === "string" ? p.message : "",
        orderRef: typeof p.orderRef === "string" ? p.orderRef : null,
        pushBackApplied: p.pushBackApplied === true,
        surface: typeof p.surface === "string" ? p.surface : null,
        cancelReason: typeof p.cancelReason === "string" ? p.cancelReason : null,
        cancelReasonDetail:
          typeof p.cancelReasonDetail === "string" ? p.cancelReasonDetail : null,
        saveRequest: p.saveRequest === true,
      };
    });
  } catch (err) {
    console.error("[support] recent requests read failed", contractId, err);
    return [];
  }
}
