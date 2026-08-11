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
  payment_method_updated: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Method Updated",
    i18nKey: "email.payment_method_updated",
    critical: false,
  },
  payment_failed_1: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_1",
    critical: false,
  },
  payment_failed_2: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_2",
    critical: false,
  },
  payment_failed_3: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Payment Failed",
    i18nKey: "email.payment_failed_3",
    critical: false,
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
  },
  threeds_action: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia 3DS Action Required",
    i18nKey: "email.threeds_action",
    critical: true,
  },
  gift_announcement: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Gift Scheduled",
    i18nKey: "email.gift_announcement",
    critical: false,
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
  },
  winback_perk: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Winback Perk",
    i18nKey: "email.winback_perk",
    critical: false,
  },
  winback_discount: {
    channel: "EMAIL",
    klaviyoMetric: "Cellexia Winback Discount",
    i18nKey: "email.winback_discount",
    critical: false,
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
  const ctaLabel =
    typeof vars.cta_label === "string" && vars.cta_label
      ? vars.cta_label
      : "Manage subscription";

  const body = formatEmailBody(bodyText, { design, ctaUrl, ctaLabel });

  return {
    subject,
    html: renderEmailShell(body.html, design),
    text: body.text,
  };
}
