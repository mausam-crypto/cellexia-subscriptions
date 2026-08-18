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
   * Confirmation moments (v1.17.0): the internal event type whose logging
   * triggers this template. Historically these were flow-owned — the event
   * log fires the canonical state-change metric and the merchant's Klaviyo
   * flow sends the email; that remains the default. When the merchant flips
   * the template's sender to "app" on the Emails page, the confirmation
   * bridge (confirmations.server.ts) sends it directly on this event, with
   * the in-app copy and full preview. Absent = router-sent or system mail.
   */
  confirmationEvent?: string;
  /**
   * Declared for future use — no code path fires this template today, so
   * the Emails page shows it read-only instead of dead controls.
   */
  dormant?: boolean;
  group: "reminders" | "orders" | "payments" | "lifecycle" | "winback" | "system";
}

const BUNDLE_LINKS = [
  "skip_url",
  "delay_1w_url",
  "delay_3w_url",
  "pause_url",
  "update_card_url",
  "retry_payment_url",
  "portal_url",
] as const;
const BUNDLE_WITH_ADDON = [...BUNDLE_LINKS, "addon_url"] as const;
/** resume_reminder (v1.28.0, P2.6): + one-tap resume + "need longer?" page. */
const RESUME_REMINDER_LINKS = [
  ...BUNDLE_WITH_ADDON,
  "resume_url",
  "extend_pause_url",
] as const;
const PORTAL_ONLY = ["portal_url"] as const;
/** new_card_detected (v1.28.0, P1.8): one-tap use-it + set-as-backup links. */
const NEW_CARD_LINKS = ["portal_url", "use_url", "backup_url"] as const;
/** cancel_confirmed / winback_soft (v1.28.0, P3.2): + the signed one-tap restart link. */
const RESTART_LINKS = ["portal_url", "restart_url"] as const;
/** cancel_scheduled / cancel_upcoming (v1.28.0, P3.8): + the one-tap KEEP link. */
const KEEP_LINKS = ["portal_url", "keep_url"] as const;
/** routine_checkin (v1.28.0, P4.1): the two one-tap answers. */
const CHECKIN_LINKS = ["portal_url", "checkin_great_url", "checkin_unsure_url"] as const;
/**
 * cancel_intent_followup (v1.28.0, P3.6): the reason-matched one-tap saves
 * (each empty when not applicable — the body reads them through the
 * pre-composed `options_block`), the support line and the plain cancel link.
 */
const INTENT_FOLLOWUP_LINKS = [
  "portal_url",
  "skip_url",
  "delay_3w_url",
  "set_frequency_url",
  "pause_url",
  "manage_url",
  "support_url",
  "cancel_url",
] as const;

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
      "Before a paused subscription auto-resumes, with one-click resume-now, need-longer (pick a new date), delay and add-a-product actions.",
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
    links: RESUME_REMINDER_LINKS,
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
      "The customer skipped their next order (portal, email link or SMS).",
    sentBy: "confirmation bridge on cycle.skipped (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "cycle.skipped",
    group: "orders",
  },
  unskip_confirmed: {
    title: "Unskip confirmed",
    trigger: "The customer restored a previously skipped order.",
    sentBy: "confirmation bridge on cycle.unskipped (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "cycle.unskipped",
    group: "orders",
  },
  delay_confirmed: {
    title: "Delay confirmed",
    trigger: "The customer delayed their next order.",
    sentBy: "confirmation bridge on cycle.delayed (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "cycle.delayed",
    group: "orders",
  },
  pause_confirmed: {
    title: "Pause confirmed",
    trigger: "The subscription was paused.",
    sentBy: "confirmation bridge on contract.paused (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "contract.paused",
    group: "orders",
  },
  resume_confirmed: {
    title: "Resume confirmed",
    trigger: "The subscription resumed (customer action or auto-resume).",
    sentBy: "confirmation bridge on contract.resumed (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "contract.resumed",
    group: "orders",
  },
  swap_confirmed: {
    title: "Product swap confirmed",
    trigger: "The customer swapped a product variant.",
    sentBy:
      "confirmation bridge on contract.line_swapped (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "contract.line_swapped",
    group: "orders",
  },
  frequency_changed: {
    title: "Frequency change confirmed",
    trigger: "The customer changed their delivery frequency.",
    sentBy:
      "confirmation bridge on contract.frequency_changed (or your Klaviyo flow)",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    confirmationEvent: "contract.frequency_changed",
    group: "orders",
  },
  quantity_changed: {
    title: "Quantity change confirmed",
    trigger:
      "The customer changed a line's quantity. No event fires for this moment today — the template is declared for future use only.",
    sentBy: "nothing today (declared for future use)",
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    dormant: true,
    group: "orders",
  },
  address_updated: {
    title: "Address updated",
    trigger:
      "The delivery address changed. No event fires for this moment today — the template is declared for future use only.",
    sentBy: "nothing today (declared for future use)",
    timing: null,
    links: [],
    customizable: false,
    disableable: false,
    dormant: true,
    group: "orders",
  },
  cancel_confirmed: {
    title: "Cancellation confirmed",
    trigger: "The subscription was cancelled.",
    sentBy: "confirmation bridge on contract.cancelled (or your Klaviyo flow)",
    timing: null,
    links: RESTART_LINKS,
    customizable: true,
    disableable: true,
    confirmationEvent: "contract.cancelled",
    group: "orders",
  },
  cancel_scheduled: {
    title: "Cancellation scheduled",
    trigger:
      "A subscriber inside a plan's commitment period scheduled their cancellation for the day the period ends (Cancel flow → scheduled cancel). States the exact end date — deliveries and charges continue as agreed until then — with a one-tap \"keep my subscription\" link.",
    sentBy: "cancel flow, the moment the customer schedules it",
    timing: null,
    links: KEEP_LINKS,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  cancel_upcoming: {
    title: "Cancellation upcoming",
    trigger:
      "A scheduled cancellation is a few days away (Cancel flow → notice days before the scheduled cancel). The last reminder with the one-tap \"keep my subscription\" link; the hourly job then cancels exactly at the scheduled moment. Sent once per scheduling.",
    sentBy: "scheduled-cancel job (hourly)",
    timing: {
      settingsKey: "cancelFlow",
      path: "scheduledCancelNoticeDays",
      label: "Send",
      kind: "int",
      min: 1,
      max: 14,
      suffix: "days before the scheduled cancellation",
    },
    links: KEEP_LINKS,
    customizable: true,
    disableable: true,
    group: "orders",
  },
  payment_method_updated: {
    title: "Payment method updated",
    trigger:
      "The card behind the subscription changed — the customer updated or switched it, a removed card's backup took over, or renewals moved to the backup card after failures on the primary. One notice per card per 24 hours.",
    sentBy:
      "payment-method webhooks, portal/admin card changes and the dunning engine",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "payments",
  },
  new_card_detected: {
    title: "New card on the account",
    trigger:
      "A subscriber in payment trouble (held payment, or a card about to expire) saved a NEW payment method on their account while the subscription's own card is still live — the moment to offer it: “use it for this subscription” in one tap, or set it as the backup. When the subscription's card had been removed or had expired, the app switches to the new method instead and confirms through “Payment method updated”. Once per new method.",
    sentBy: "payment-method webhooks, immediately",
    timing: null,
    links: NEW_CARD_LINKS,
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
  payment_failed_parked: {
    title: "Subscription on hold — ways to continue",
    trigger:
      "The retry ladder gave up and the subscription is on hold (FAILED); sent at each offset while it stays on hold and no newer payment issue opened.",
    sentBy: "dunning sweep (10 min), once per offset",
    timing: {
      settingsKey: "dunning",
      path: "postExhaustionTouchDays",
      label: "Send",
      kind: "intList",
      suffix: "days after the ladder gave up (each offset = one email)",
    },
    links: [...BUNDLE_LINKS, "skip_resume_url"],
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
  threeds_action_sms: {
    title: "Bank verification required — SMS",
    trigger:
      "The same 3-D Secure moment as the email, as a short text with the secure confirmation link (Klaviyo SMS consent applies; only when the subscriber has a phone number).",
    sentBy: "billing challenge webhook, immediately, once per challenged attempt",
    timing: null,
    links: PORTAL_ONLY,
    customizable: false,
    disableable: true,
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
  gift_teaser: {
    title: "Gift teaser",
    trigger:
      "The first order billed and the cycle-2 surprise gift is coming — teases it without spoiling what it is.",
    sentBy: "billing-success hook, once per contract",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  subscription_started: {
    title: "Welcome — subscription started",
    trigger:
      "A new subscription was created at checkout: what happens next (first order, next charge date, the change/skip cut-off) and where to manage it. Never sent for imported or backfilled subscriptions.",
    sentBy: "subscription-created webhook, once per subscription",
    timing: null,
    links: PORTAL_ONLY,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  routine_checkin: {
    title: "Routine check-in (week N)",
    trigger:
      "The customer reaches the configured routine week (Lifecycle → results timeline → check-in week, default 4): where they are in the routine, what many people notice in this phase, one sentence resetting a fast survey expectation when known, and two one-tap answers (Great / Not sure yet). Not sent to the results-timeline holdout group, nor when Portal growth → results timeline is off.",
    sentBy: "lifecycle sweep (daily), once per subscription",
    timing: null,
    links: CHECKIN_LINKS,
    customizable: true,
    disableable: true,
    group: "lifecycle",
  },
  cancel_intent_followup: {
    title: "Cancel intent — follow-up",
    trigger:
      "The customer opened the cancel flow and left without deciding (the session closed as walked-away). Sent once, 12–24 hours later (Cancel flow → intent follow-up hours), with the saves that match the reason they gave — skip / delay / a slower cadence as one-tap links, a smaller order via the portal — plus \"talk to us\" and a plain link back to the cancel page. Never inside the pre-charge buffer, never more than once per customer per cooldown, never after a save, a pause or a cancellation.",
    sentBy: "cancel-intent job (hourly), once per walked-away session",
    timing: {
      settingsKey: "cancelFlow",
      path: "intentFollowupHours",
      label: "Send",
      kind: "int",
      min: 1,
      max: 72,
      suffix: "hours after the session closes",
    },
    links: INTENT_FOLLOWUP_LINKS,
    customizable: true,
    disableable: true,
    group: "winback",
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
    links: RESTART_LINKS,
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
    links: PORTAL_ONLY,
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
    links: PORTAL_ONLY,
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
