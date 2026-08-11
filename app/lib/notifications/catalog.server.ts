import type { SettingsKey } from "~/lib/settings/registry.server";
import { TEMPLATES, type TemplateKey } from "./templates.server";

/**
 * Email catalog — the merchant-facing descriptor of every message the app
 * sends, powering the admin Emails tab (v1.16.0).
 *
 * TEMPLATES (templates.server.ts) stays the single source of truth for the
 * mechanical facts (channel, metric, critical, i18n key); this module adds
 * the HUMAN facts — what triggers each message, when it goes out, which
 * timing setting owns the schedule, and which one-click action links ride
 * its Klaviyo event. tests/emails-tab.test.ts pins that every TemplateKey
 * has a descriptor, so a new template cannot ship without appearing in the
 * catalog.
 *
 * `timing` points INTO the existing settings registry (settings own every
 * schedule — golden rule 7); the Emails tab edits those exact paths through
 * the same setSetting + settings_updated audit pipeline the Settings page
 * uses. `kind` tells the tab how to coerce the form value.
 */

export interface CatalogTiming {
  /** Settings group that owns the knob. */
  settingsKey: SettingsKey;
  /** Dot-path inside the group's value. */
  path: string;
  /** Short label rendered next to the input. */
  label: string;
  kind: "int" | "intList";
  min?: number;
  max?: number;
  /** Rendered as a suffix, e.g. "days before". */
  suffix?: string;
}

export interface EmailCatalogEntry {
  template: TemplateKey;
  /** Merchant-facing name. */
  title: string;
  /** One-sentence trigger description. */
  trigger: string;
  /** Which job/webhook sends it (operational context). */
  sentBy: string;
  timing: CatalogTiming | null;
  /** One-click magic-link properties available to this message's flow. */
  links: readonly string[];
  /**
   * Whether subject/body customization applies. Critical system mail
   * (otp_code, admin_alert, import_summary) keeps its built-in copy, and
   * SMS carries no subject/body HTML.
   */
  customizable: boolean;
  /** Whether the merchant may disable it (critical templates: never). */
  disableable: boolean;
  /**
   * True for the confirmation moments the router never sends itself: their
   * customer email comes from the Klaviyo flow on the state-change metric
   * the event log fires automatically (cycle.skipped → "Cellexia Order
   * Skipped", …). Content, timing and on/off live in that flow — an in-app
   * override could never reach it, so the Emails tab shows these read-only
   * instead of dead controls.
   */
  flowOwned?: boolean;
  group: "reminders" | "orders" | "payments" | "lifecycle" | "winback" | "system";
}

const BUNDLE_LINKS = [
  "skip_url",
  "delay_1w_url",
  "delay_3w_url",
  "pause_url",
  "update_card_url",
  "portal_url",
] as const;
const BUNDLE_WITH_ADDON = [...BUNDLE_LINKS, "addon_url"] as const;
const PORTAL_ONLY = ["portal_url"] as const;

export const EMAIL_CATALOG: Record<TemplateKey, Omit<EmailCatalogEntry, "template">> = {
  upcoming_order: {
    title: "Upcoming order reminder",
    trigger:
      "Before each renewal charge — the churn-critical heads-up with one-click skip, delay and add-a-product actions.",
    sentBy: "reminders job (hourly), once per billing cycle",
    timing: {
      settingsKey: "notifications",
      path: "upcomingOrderDaysBefore",
      label: "Send",
      kind: "int",
      min: 1,
      max: 14,
      suffix: "days before the charge",
    },
    links: BUNDLE_WITH_ADDON,
    customizable: true,
    disableable: true,
    group: "reminders",
  },
  resume_reminder: {
    title: "Pause ending reminder",
    trigger:
      "Before a paused subscription auto-resumes, with one-click delay and add-a-product actions.",
    sentBy: "pause auto-resume job (hourly), once per pause",
    timing: {
      settingsKey: "pause",
      path: "resumeReminderDaysBefore",
      label: "Send",
      kind: "int",
      min: 1,
      max: 14,
      suffix: "days before the resume",
    },
    links: BUNDLE_WITH_ADDON,
    customizable: true,
    disableable: true,
    group: "reminders",
  },
  order_confirmed: {
    title: "Renewal order confirmed",
    trigger: "A renewal charge succeeded and its order was created.",
    sentBy: "billing success webhook, once per cycle",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  order_shipped: {
    title: "Renewal order shipped",
    trigger:
      "A renewal order was fulfilled (first orders are excluded — Shopify already emails those).",
    sentBy: "fulfillment webhook, once per cycle",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  skip_confirmed: {
    title: "Skip confirmed",
    trigger:
      'The customer skipped their next order (portal, email link or SMS) — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (cycle.skipped metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  unskip_confirmed: {
    title: "Unskip confirmed",
    trigger:
      'The customer restored a previously skipped order — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (cycle.unskipped metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  delay_confirmed: {
    title: "Delay confirmed",
    trigger:
      'The customer delayed their next order — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (cycle.delayed metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  pause_confirmed: {
    title: "Pause confirmed",
    trigger:
      'The subscription was paused — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (contract.paused metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  resume_confirmed: {
    title: "Resume confirmed",
    trigger:
      'The subscription resumed (customer action or auto-resume) — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (contract.resumed metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  swap_confirmed: {
    title: "Product swap confirmed",
    trigger:
      'The customer swapped a product variant — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (contract.line_swapped metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  frequency_changed: {
    title: "Frequency change confirmed",
    trigger:
      'The customer changed their delivery frequency — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (contract.frequency_changed metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  quantity_changed: {
    title: "Quantity change confirmed",
    trigger:
      "The customer changed a line's quantity. No metric fires for this moment today — the template is declared for future use only.",
    sentBy: 'nothing today (declared for future use)',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  address_updated: {
    title: "Address updated",
    trigger:
      'The delivery address changed. No metric fires for this moment today — the template is declared for future use only.',
    sentBy: 'nothing today (declared for future use)',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  cancel_confirmed: {
    title: "Cancellation confirmed",
    trigger:
      'The subscription was cancelled — your Klaviyo flow on the state-change metric sends the confirmation.',
    sentBy: 'your Klaviyo flow (contract.cancelled metric) — copy and on/off live in the flow',
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    flowOwned: true,
    group: "orders",
  },
  payment_method_updated: {
    title: "Payment method updated",
    trigger:
      "Renewals switched to the backup card after repeated failures on the primary.",
    sentBy: "dunning engine",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  payment_failed_1: {
    title: "Payment failed — first notice",
    trigger:
      "A renewal charge failed (sent on the failure day, with a secure update-card link).",
    sentBy: "billing failure webhook + dunning sweep (10 min)",
    timing: {
      settingsKey: "dunning",
      path: "emailLadderDays",
      label: "Email ladder",
      kind: "intList",
      suffix: "days after the failure (first / second / third notice)",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  payment_failed_2: {
    title: "Payment failed — second notice",
    trigger: "The payment is still failing after the first notice.",
    sentBy: "dunning sweep (10 min)",
    timing: {
      settingsKey: "dunning",
      path: "emailLadderDays",
      label: "Email ladder",
      kind: "intList",
      suffix: "days after the failure (first / second / third notice)",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  payment_failed_3: {
    title: "Payment failed — final notice",
    trigger: "The payment is still failing after the second notice.",
    sentBy: "dunning sweep (10 min)",
    timing: {
      settingsKey: "dunning",
      path: "emailLadderDays",
      label: "Email ladder",
      kind: "intList",
      suffix: "days after the failure (first / second / third notice)",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  payment_failed_sms: {
    title: "Payment failed — SMS",
    trigger: "One SMS late in the dunning ladder (Klaviyo SMS consent applies).",
    sentBy: "dunning sweep (10 min), once per case",
    timing: {
      settingsKey: "dunning",
      path: "smsDay",
      label: "Send",
      kind: "int",
      min: 0,
      max: 60,
      suffix: "days after the failure",
    },
    links: BUNDLE_LINKS,
    customizable: false,
    disableable: true,
    group: "payments",
  },
  card_expiring: {
    title: "Card expiring soon",
    trigger:
      "The card on file approaches its expiry month (also triggers Shopify's own hosted update email).",
    sentBy: "pre-expiry job (daily), once per card + expiry",
    timing: {
      settingsKey: "dunning",
      path: "preExpiryNoticeDays",
      label: "Send",
      kind: "int",
      min: 7,
      max: 60,
      suffix: "days before expiry",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  threeds_action: {
    title: "Bank verification required (3-D Secure)",
    trigger:
      "The bank requires authentication to complete a renewal charge — critical, also sent via direct email.",
    sentBy: "billing challenge webhook, immediately",
    timing: null,
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: false,
    group: "payments",
  },
  gift_announcement: {
    title: "Gift announcement",
    trigger: "A configured gift will be added to the customer's upcoming order.",
    sentBy: "gifts job (daily), once per cycle",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  milestone_gift: {
    title: "Milestone reached",
    trigger: "The customer reached the configured milestone cycle.",
    sentBy: "billing success hook",
    timing: {
      settingsKey: "lifecycle",
      path: "milestoneGiftCycle",
      label: "At order number",
      kind: "int",
      min: 1,
      max: 60,
    },
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  rewards_unlocked: {
    title: "Rewards unlocked",
    trigger: "The customer's rewards unlock after the configured tenure.",
    sentBy: "lifecycle job (daily)",
    timing: {
      settingsKey: "lifecycle",
      path: "rewardsUnlockDay",
      label: "After",
      kind: "int",
      min: 1,
      max: 720,
      suffix: "days subscribed",
    },
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  winback_soft: {
    title: "Win-back — soft touch",
    trigger:
      "A cancelled subscriber's supply is predicted to run low — the gentle first touch.",
    sentBy: "win-back job (hourly)",
    timing: {
      settingsKey: "winback",
      path: "softTouchOffsetDays",
      label: "Send",
      kind: "int",
      min: -60,
      max: 365,
      suffix: "days after the predicted empty date (negative = before)",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "winback",
  },
  winback_perk: {
    title: "Win-back — perk offer",
    trigger: "The second win-back touch, carrying a one-click reactivation perk.",
    sentBy: "win-back job (hourly)",
    timing: {
      settingsKey: "winback",
      path: "perkOffsetDays",
      label: "Send",
      kind: "int",
      min: -60,
      max: 365,
      suffix: "days after the predicted empty date",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "winback",
  },
  winback_discount: {
    title: "Win-back — discount offer",
    trigger: "The final win-back touch, carrying a one-click discount reactivation.",
    sentBy: "win-back job (hourly)",
    timing: {
      settingsKey: "winback",
      path: "discountOffsetDays",
      label: "Send",
      kind: "int",
      min: -60,
      max: 365,
      suffix: "days after the predicted empty date",
    },
    links: BUNDLE_LINKS,
    customizable: true,
    disableable: true,
    group: "winback",
  },
  price_change_notice: {
    title: "Price change notice",
    trigger:
      "A propagated price change approaches — the legally required advance notice.",
    sentBy: "price-change batch run",
    timing: {
      settingsKey: "priceChangePolicy",
      path: "noticeDays",
      label: "Notice period",
      kind: "int",
      min: 7,
      max: 90,
      suffix: "days before the new price applies",
    },
    links: PORTAL_ONLY,
    customizable: true,
    disableable: false,
    group: "orders",
  },
  stockout_delay: {
    title: "Order delayed (out of stock)",
    trigger: "A renewal was delayed because an item is out of stock.",
    sentBy: "renewal stockout evaluation",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  stockout_skip: {
    title: "Order skipped (out of stock)",
    trigger: "A renewal was skipped because an item is out of stock.",
    sentBy: "renewal stockout evaluation",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  stockout_substitute: {
    title: "Product substituted (out of stock)",
    trigger: "An out-of-stock item was substituted on a renewal.",
    sentBy: "renewal stockout evaluation",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  otp_code: {
    title: "Portal login code",
    trigger:
      "A customer requests a login code for the subscription portal — security mail, never via Klaviyo.",
    sentBy: "portal login, immediately",
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    group: "system",
  },
  admin_alert: {
    title: "Admin alert",
    trigger: "A critical operational alert for the merchant (you), not customers.",
    sentBy: "alert scans (15 min)",
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    group: "system",
  },
  import_summary: {
    title: "Import summary",
    trigger: "A subscriber CSV import finished — merchant-facing report.",
    sentBy: "import runs",
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    group: "system",
  },
};

/** Catalog as a stable, serializable list (template key attached per row). */
export function emailCatalogEntries(): EmailCatalogEntry[] {
  return (Object.keys(TEMPLATES) as TemplateKey[]).map((template) => ({
    template,
    ...EMAIL_CATALOG[template],
  }));
}
