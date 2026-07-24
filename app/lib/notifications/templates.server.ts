import { t } from "~/lib/i18n/i18n.server";

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
}

export type TemplateVars = Record<string, string | number>;

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanize(template: string): string {
  const words = template.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Renders a branded transactional email for direct SMTP delivery.
 * Subject/body copy comes from the i18n catalog at
 * `email.{template}.subject` / `email.{template}.body`; `\n` becomes `<br>`
 * and a single `{cta}` placeholder (or, failing that, the end of the body)
 * receives a button built from `vars.cta_url` / `vars.cta_label`.
 *
 * If catalog keys are missing (locale files not yet shipped) it degrades to a
 * generic subject and a plain listing of the variables, so critical mail
 * (OTP codes, admin alerts) still carries its payload.
 */
export function renderEmail(
  template: TemplateKey,
  locale: string | null | undefined,
  vars: TemplateVars = {},
): RenderedEmail {
  const def = TEMPLATES[template];
  const subjectKey = `${def.i18nKey}.subject`;
  const bodyKey = `${def.i18nKey}.body`;

  let subject = t(locale, subjectKey, vars);
  if (subject === subjectKey) subject = `Cellexia — ${humanize(template)}`;

  let bodyText = t(locale, bodyKey, vars);
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

  const button = ctaUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td style="border-radius:6px;background:#1a1a1a;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 28px;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#faf8f5;text-decoration:none;letter-spacing:0.02em;">${escapeHtml(ctaLabel)}</a></td></tr></table>`
    : "";

  // Escape first, then re-introduce structural HTML (<br> and the button).
  let bodyHtml = escapeHtml(bodyText).replaceAll("\n", "<br>");
  if (bodyHtml.includes("{cta}")) {
    bodyHtml = bodyHtml.replace("{cta}", button);
  } else if (button) {
    bodyHtml = `${bodyHtml}${button}`;
  }

  const html = `<div style="margin:0;padding:0;background:#faf8f5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;">
          <tr>
            <td align="center" style="padding:8px 0 28px;font-family:Georgia,'Times New Roman',serif;font-size:22px;letter-spacing:0.35em;color:#1a1a1a;">C E L L E X I A</td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid #ece7df;border-radius:8px;padding:36px 40px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#1a1a1a;">${bodyHtml}</td>
          </tr>
          <tr>
            <td align="center" style="padding:24px 8px 0;font-family:Georgia,'Times New Roman',serif;font-size:12px;line-height:1.6;color:#8a837a;">Cellexia — skincare that keeps its promises.<br>You are receiving this email about your Cellexia subscription.</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`;

  return { subject, html };
}
