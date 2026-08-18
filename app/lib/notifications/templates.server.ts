import { t } from "~/lib/i18n/i18n.server";
import {
  DEFAULT_EMAIL_DESIGN,
  formatEmailBody,
  renderEmailShell,
  type EmailDesign,
} from "./format";

/**
 * Notification template registry.
 *
 * Every customer/admin-facing notification the app can produce is declared
 * here. `klaviyoMetric` is the metric the router enqueues so a Klaviyo flow
 * owns delivery + branding; templates with an empty metric are direct-SMTP
 * only (OTP codes and admin mail must never route through a marketing tool).
 *
 * Several confirmation templates intentionally reuse the canonical metric
 * fired automatically by the event log (e.g. skip_confirmed → "Cellexia Order
 * Skipped") — the outbox's short dedupe window collapses the two paths into a
 * single Klaviyo event, so there is exactly one metric per customer moment.
 *
 * `critical: true` → additionally delivered via direct SMTP so it still
 * arrives if Klaviyo is down/misconfigured, and it bypasses channel toggles.
 */

export type NotificationChannel = "EMAIL" | "SMS";

export interface NotificationTemplate {
  channel: NotificationChannel;
  /** Klaviyo metric enqueued for this template; "" = never sent to Klaviyo. */
  klaviyoMetric: string;
  /** Base i18n key; subject/body live at `{i18nKey}.subject` / `{i18nKey}.body`. */
  i18nKey: string;
  /** Critical mail is also sent via direct SMTP (and OTP is SMTP-only). */
  critical: boolean;
  /**
   * i18n key for the default CTA button label (v1.24.0). Falls back to
   * email.cta.manage — the button must read in the CUSTOMER's language, so
   * callers stopped needing to pass cta_label at all. A caller-provided
   * vars.cta_label still wins.
   */
  ctaLabelKey?: string;
}

export const TEMPLATES = {
  upcoming_order: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Upcoming Order",
    i18nKey: "email.upcoming_order",
    critical: false,
  },
  order_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Order Confirmed",
    i18nKey: "email.order_confirmed",
    critical: false,
  },
  order_shipped: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Order Shipped",
    i18nKey: "email.order_shipped",
    critical: false,
  },
  skip_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Order Skipped",
    i18nKey: "email.skip_confirmed",
    critical: false,
  },
  unskip_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Order Unskipped",
    i18nKey: "email.unskip_confirmed",
    critical: false,
  },
  delay_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Order Delayed",
    i18nKey: "email.delay_confirmed",
    critical: false,
  },
  pause_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Subscription Paused",
    i18nKey: "email.pause_confirmed",
    critical: false,
  },
  resume_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Subscription Resumed",
    i18nKey: "email.resume_confirmed",
    critical: false,
  },
  resume_reminder: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Resume Reminder",
    i18nKey: "email.resume_reminder",
    critical: false,
  },
  swap_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Product Swapped",
    i18nKey: "email.swap_confirmed",
    critical: false,
  },
  frequency_changed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Frequency Changed",
    i18nKey: "email.frequency_changed",
    critical: false,
  },
  quantity_changed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Quantity Changed",
    i18nKey: "email.quantity_changed",
    critical: false,
  },
  address_updated: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Address Updated",
    i18nKey: "email.address_updated",
    critical: false,
  },
  cancel_confirmed: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Subscription Cancelled",
    i18nKey: "email.cancel_confirmed",
    critical: false,
  },
  // v1.28.0 (P3.8) — scheduled cancel on a locked contract: sent the moment
  // the customer schedules it (states the exact end date; nothing else
  // changes until then) with a one-tap KEEP link.
  cancel_scheduled: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Cancellation Scheduled",
    i18nKey: "email.cancel_scheduled",
    critical: false,
    ctaLabelKey: "email.cta.keep_subscription",
  },
  // v1.28.0 (P3.8) — N days before the scheduled moment (settings.
  // cancelFlow.scheduledCancelNoticeDays): the last honest reminder with
  // the one-tap KEEP link; the hourly job then cancels as promised.
  cancel_upcoming: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Cancellation Upcoming",
    i18nKey: "email.cancel_upcoming",
    critical: false,
    ctaLabelKey: "email.cta.keep_subscription",
  },
  payment_method_updated: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Method Updated",
    i18nKey: "email.payment_method_updated",
    critical: false,
    ctaLabelKey: "email.cta.back_to_subscription",
  },
  // v1.28.0 (P1.8) — a NEW vaulted method appeared on the account of a
  // subscriber in payment trouble (held payment / expiring card) whose own
  // card is still live: "use it for this subscription?" with the one-tap
  // USE_METHOD link as the button and a SET_BACKUP line. When the primary is
  // dead (removed / expired) the webhook switches instead and the closed
  // loop rides payment_method_updated (reason new_method).
  new_card_detected: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia New Card Detected",
    i18nKey: "email.new_card_detected",
    critical: false,
    ctaLabelKey: "email.cta.use_new_card",
  },
  payment_failed_1: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_1",
    critical: false,
    ctaLabelKey: "email.cta.update_card",
  },
  payment_failed_2: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_2",
    critical: false,
    ctaLabelKey: "email.cta.update_card",
  },
  payment_failed_3: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_3",
    critical: false,
    ctaLabelKey: "email.cta.update_card",
  },
  // v1.28.0 (P1.9) — post-exhaustion touches: N days after the ladder gave
  // up (settings.dunning.postExhaustionTouchDays) while the contract is
  // still FAILED, the three ways back: update the card / retry / skip the
  // held order and continue (SKIP_FAILED_CYCLE one-tap). Its own metric —
  // the ladder flow must not re-fire on a parked contract.
  payment_failed_parked: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Parked",
    i18nKey: "email.payment_failed_parked",
    critical: false,
    ctaLabelKey: "email.cta.update_card",
  },
  payment_failed_sms: {
    channel: "SMS",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "sms.payment_failed_sms",
    critical: false,
  },
  card_expiring: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Card Expiring",
    i18nKey: "email.card_expiring",
    critical: false,
    ctaLabelKey: "email.cta.update_card",
  },
  threeds_action: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia 3DS Action Required",
    i18nKey: "email.threeds_action",
    critical: true,
    ctaLabelKey: "email.cta.confirm_payment",
  },
  // v1.28.0 — the day-0 SMS leg of a 3-D Secure challenge (P1.6). Rides the
  // same metric as threeds_action so a merchant's SMS flow keys off the one
  // 3DS moment; the outbox tells the legs apart by content shape (SMS =
  // content_text without content_subject). Not critical: SMS has no direct
  // transport, and the critical EMAIL twin already guarantees delivery.
  threeds_action_sms: {
    channel: "SMS",
    klaviyoMetric: "Cellexia 3DS Action Required",
    i18nKey: "sms.threeds_action_sms",
    critical: false,
  },
  gift_announcement: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Gift Scheduled",
    i18nKey: "email.gift_announcement",
    critical: false,
  },
  gift_teaser: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Gift Teaser",
    i18nKey: "email.gift_teaser",
    critical: false,
  },
  // v1.28.0 — the welcome email (P4.5 / P5.2): sent once per genuinely new
  // contract from the create-webhook path (subscription-started.server.ts),
  // never for imports/backfills. Rides the CANONICAL contract.created metric
  // ("Cellexia Subscription Started", events-map) rather than a second one:
  // the outbox graft supersedes the content-less canonical leg with this
  // content-carrying leg exactly like billing.attempt_failed × payment_failed_1,
  // so a merchant's existing onboarding flow on that metric keeps working and
  // the auto-created flow (cellexia_send = "true") delivers this email.
  subscription_started: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Subscription Started",
    i18nKey: "email.subscription_started",
    critical: false,
    ctaLabelKey: "email.cta.manage_mine",
  },
  // v1.28.0 (P4.1) — the week-N routine check-in: the results-timeline
  // phase copy for the customer's routine week + two one-tap answers
  // (CHECKIN great / unsure). Sent once per contract by the lifecycle
  // sweep at lifecycle.resultsTimeline.checkinWeek; gated by the timeline
  // toggle and the results_timeline holdout arm.
  routine_checkin: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Routine Check-in",
    i18nKey: "email.routine_checkin",
    critical: false,
    ctaLabelKey: "email.cta.manage_mine",
  },
  // v1.28.0 (P3.6) — abandoned cancel-intent follow-up: the customer opened
  // the cancel flow and walked away undecided; 12–24h later (settings.
  // cancelFlow.intentFollowupHours) ONE email with reason-matched one-tap
  // saves (skip / delay / slower cadence via SET_FREQUENCY), "talk to us"
  // and a plain link to the cancel page (honesty — cancelling stays one
  // tap away). Sent by the cancel_intent_followup_run job; never inside the
  // pre-charge buffer, never twice per customer per cooldown.
  cancel_intent_followup: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Cancel Intent",
    i18nKey: "email.cancel_intent_followup",
    critical: false,
    ctaLabelKey: "email.cta.manage_mine",
  },
  milestone_gift: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Milestone Reached",
    i18nKey: "email.milestone_gift",
    critical: false,
  },
  rewards_unlocked: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Rewards Unlocked",
    i18nKey: "email.rewards_unlocked",
    critical: false,
  },
  winback_soft: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Winback Soft Touch",
    i18nKey: "email.winback_soft",
    critical: false,
    ctaLabelKey: "email.cta.reactivate",
  },
  winback_perk: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Winback Perk",
    i18nKey: "email.winback_perk",
    critical: false,
    ctaLabelKey: "email.cta.reactivate",
  },
  winback_discount: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Winback Discount",
    i18nKey: "email.winback_discount",
    critical: false,
    ctaLabelKey: "email.cta.reactivate",
  },
  price_change_notice: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Price Change Notice",
    i18nKey: "email.price_change_notice",
    critical: false,
  },
  stockout_delay: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Stockout Delay",
    i18nKey: "email.stockout_delay",
    critical: false,
  },
  stockout_skip: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Stockout Skip",
    i18nKey: "email.stockout_skip",
    critical: false,
  },
  stockout_substitute: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Stockout Substitute",
    i18nKey: "email.stockout_substitute",
    critical: false,
  },
  otp_code: {
    channel: "EMAIL",
    klaviyoMetric: "", // security-sensitive — direct SMTP only, never Klaviyo
    i18nKey: "email.otp_code",
    critical: true,
  },
  admin_alert: {
    channel: "EMAIL",
    klaviyoMetric: "", // merchant-facing — direct SMTP only
    i18nKey: "email.admin_alert",
    critical: true,
  },
  import_summary: {
    channel: "EMAIL",
    klaviyoMetric: "", // merchant-facing — direct SMTP only
    i18nKey: "email.import_summary",
    critical: true,
  },
} as const satisfies Record<string, NotificationTemplate>;

export type TemplateKey = keyof typeof TEMPLATES;

export function isTemplateKey(key: string): key is TemplateKey {
  return key in TEMPLATES;
}

// ── Email rendering ───────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  html: string;
  /** Plain-text form of the body (v1.16.0) — feeds SMS flows/content_text. */
  text: string;
}

/** Merchant-edited copy from the `emails` setting (empty string = built-in). */
export interface EmailContentOverride {
  subject?: string;
  body?: string;
}

export type TemplateVars = Record<string, string | number>;

/**
 * `{var}` interpolation for merchant-edited copy — the same placeholder
 * syntax the i18n catalog uses (t() interpolates its own strings; override
 * strings never pass through t(), so they need this twin). Unknown
 * placeholders are left visible rather than swallowed: a typo'd
 * `{delay_1w_ur}` in the editor should be seen, not silently vanish.
 * `{cta}` is deliberately not interpolated here — the html assembly below
 * owns it.
 */
export function interpolateVars(text: string, vars: TemplateVars): string {
  return text.replace(/\{([a-z0-9_]+)\}/gi, (match, key: string) => {
    if (key === "cta") return match;
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}

function humanize(template: string): string {
  const words = template.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Renders a branded transactional email for direct SMTP delivery.
 * Subject/body copy comes from the merchant's override (the `emails`
 * setting, non-empty values only — v1.16.0) or the i18n catalog at
 * `email.{template}.subject` / `email.{template}.body`. Since v1.17.0 the
 * body supports the markdown-lite formatting vocabulary and the shell is
 * driven by the merchant's brand kit (the `emailDesign` setting; defaults
 * render the historical shell) — both via ./format. A single `{cta}`
 * placeholder (or, failing that, the end of the body) receives a button
 * built from `vars.cta_url` / `vars.cta_label`.
 *
 * If catalog keys are missing (locale files not yet shipped) it degrades to a
 * generic subject and a plain listing of the variables, so critical mail
 * (OTP codes, admin alerts) still carries its payload.
 *
 * The same rendering feeds the Klaviyo event's content properties
 * (content_subject / content_html / content_text — send.server.ts), so
 * whatever the merchant writes in the Emails tab is what BOTH delivery
 * shapes carry.
 */
export function renderEmail(
  template: TemplateKey,
  locale: string | null | undefined,
  vars: TemplateVars = {},
  override?: EmailContentOverride | null,
  design: EmailDesign = DEFAULT_EMAIL_DESIGN,
): RenderedEmail {
  const def = TEMPLATES[template];
  const subjectKey = `${def.i18nKey}.subject`;
  const bodyKey = `${def.i18nKey}.body`;

  const overrideSubject = override?.subject?.trim() || null;
  const overrideBody = override?.body?.trim() || null;

  let subject = overrideSubject
    ? interpolateVars(overrideSubject, vars)
    : t(locale, subjectKey, vars);
  if (subject === subjectKey) subject = `Cellexia — ${humanize(template)}`;

  let bodyText = overrideBody
    ? interpolateVars(overrideBody, vars)
    : t(locale, bodyKey, vars);
  if (bodyText === bodyKey) {
    // Catalog fallback: never send an empty critical email.
    bodyText = Object.entries(vars)
      .filter(([k]) => k !== "cta_url" && k !== "cta_label")
      .map(([k, v]) => `${humanize(k)}: ${v}`)
      .join("\n");
  }

  const ctaUrl = typeof vars.cta_url === "string" ? vars.cta_url : undefined;
  // Button label: caller override → the template's localized intent label
  // (update my card / confirm my payment / restart my subscription) → the
  // localized generic manage label → English as the very last resort.
  // Widen: the `as const` union only carries ctaLabelKey on entries that set
  // it; the interface says it is optional everywhere.
  const ctaLabelKey =
    (def as NotificationTemplate).ctaLabelKey ?? "email.cta.manage";
  const localizedCta = t(locale, ctaLabelKey);
  const ctaLabel =
    typeof vars.cta_label === "string" && vars.cta_label
      ? vars.cta_label
      : localizedCta !== ctaLabelKey
        ? localizedCta
        : "Manage subscription";

  const body = formatEmailBody(bodyText, { design, ctaUrl, ctaLabel });

  return {
    subject,
    html: renderEmailShell(body.html, design),
    text: body.text,
  };
}
