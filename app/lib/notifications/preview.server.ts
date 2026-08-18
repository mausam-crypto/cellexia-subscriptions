import { getSetting } from "~/lib/settings/settings.server";
import {
  renderEmail,
  TEMPLATES,
  type RenderedEmail,
  type TemplateKey,
  type TemplateVars,
} from "./templates.server";
import { normalizeEmailDesign, type EmailDesign } from "./format";

/**
 * Email preview + test-send support (v1.17.0, admin Emails pages).
 *
 * `previewSampleVars` fabricates a realistic variable set per template —
 * the same names the real send paths supply (billing reminders, dunning,
 * win-back, webhooks…), filled with obviously-sample values. Every link
 * points at example.com, which resolves nowhere: a test email in an inbox
 * can be clicked without side effects, and no magic token is ever minted
 * for a preview.
 *
 * `renderTemplatePreview` renders through the REAL pipeline (renderEmail →
 * format.ts), so the preview pane, the SMTP delivery and the Klaviyo
 * content_html property can never drift apart.
 */

const SAMPLE_LINKS: TemplateVars = {
  portal_url: "https://example.com/account",
  skip_url: "https://example.com/skip-next-order",
  delay_1w_url: "https://example.com/delay-1-week",
  delay_3w_url: "https://example.com/delay-3-weeks",
  pause_url: "https://example.com/pause",
  update_card_url: "https://example.com/update-card",
  retry_payment_url: "https://example.com/retry-payment",
  addon_url: "https://example.com/add-to-next-order",
  resume_url: "https://example.com/resume-now",
  extend_pause_url: "https://example.com/extend-pause",
  reactivate_url: "https://example.com/restart",
  restart_url: "https://example.com/restart-my-subscription",
  tracking_url: "https://example.com/track/CH1029384756",
};

const SAMPLE_COMMON: TemplateVars = {
  first_name: "Anna",
  next_date: "12 September 2026",
  next_date_iso: "2026-09-12",
  items_summary: "1× Cellexia Renewal Serum, 1× Cellexia Night Cream",
  item_count: 2,
  total_estimate: "CHF 132.00",
  total_estimate_cents: 13200,
  frequency: "every 8 weeks",
  frequency_weeks: 8,
  frequency_unit: "WEEK",
  frequency_count: 8,
  cycleIndex: 4,
};

/** Per-template extras — the vars its copy (and real send path) references. */
const SAMPLE_BY_TEMPLATE: Partial<Record<TemplateKey, TemplateVars>> = {
  upcoming_order: {
    discount_percent: 20,
    addon_title: "Cellexia Eye Contour",
    addon_price_formatted: "CHF 42.00",
    card_label: "Visa ····4242",
    payment_line: "Payment method: Visa ····4242",
    card_expiry_warning: "",
    edit_cutoff: "12 September 2026, 00:00",
    edit_cutoff_iso: "2026-09-11T22:00:00.000Z",
    edit_cutoff_line: "You can make changes until 12 September 2026, 00:00.",
    following_date: "7 November 2026",
    following_date_iso: "2026-11-07",
  },
  resume_reminder: {
    resume_date: "12 September 2026",
    resume_date_iso: "2026-09-12",
  },
  // v1.28.0 (P2.6): the pause confirmation quotes the exact resume day via
  // the contract snapshot's resume_line (empty for an external pause).
  pause_confirmed: {
    resume_date: "12 September 2026",
    resume_date_iso: "2026-09-12",
    resume_line: "Deliveries resume on 12 September 2026.",
  },
  // v1.28.0 (P3.8): scheduled cancel on a locked contract — the exact end
  // date + the one-tap KEEP link.
  cancel_scheduled: {
    cancel_date: "30 September 2026",
    cancel_date_iso: "2026-09-30",
    keep_url: "https://example.com/keep-my-subscription",
    cta_url: "https://example.com/keep-my-subscription",
  },
  cancel_upcoming: {
    cancel_date: "30 September 2026",
    cancel_date_iso: "2026-09-30",
    keep_url: "https://example.com/keep-my-subscription",
    cta_url: "https://example.com/keep-my-subscription",
  },
  order_confirmed: { order_name: "#2148", amount: "CHF 132.00" },
  order_shipped: { order_name: "#2148", tracking_number: "CH1029384756" },
  payment_method_updated: {
    card_brand: "Visa",
    card_last4: "4242",
    card_label: "Visa ····4242",
    previous_card_label: "Visa ····0000",
    change_line:
      "Thank you — your subscription now uses Visa ····4242, and everything is set for your next order.",
    next_line: "Your next order of CHF 132.00 is scheduled for 12 September 2026.",
    amount: "CHF 132.00",
    cta_url: "https://example.com/account",
  },
  // v1.28.0 (P1.8): a newer card on the account while a payment is on hold.
  new_card_detected: {
    card_label: "Mastercard ····8210",
    current_card_label: "Visa ····4242",
    intro_line:
      "We noticed a new card on your account — Mastercard ····8210 — while a payment for your subscription is on hold. Switching to it retries that payment straight away.",
    backup_line:
      "Prefer to keep Visa ····4242? Set the new card as your backup instead, and we'll only use it if a payment fails: https://example.com/set-as-backup",
    use_url: "https://example.com/use-new-card",
    backup_url: "https://example.com/set-as-backup",
    cta_url: "https://example.com/use-new-card",
  },
  payment_failed_1: {
    amount: "CHF 132.00",
    decline_human: "the card was declined",
    decline_code: "generic_decline",
    attempt_number: 1,
    days_since_failure: 0,
    card_last4: "4242",
    cta_url: "https://example.com/update-card",
    cta_label: "Review or update card",
  },
  payment_failed_2: {
    amount: "CHF 132.00",
    decline_human: "the card was declined",
    days_since_failure: 3,
    card_last4: "4242",
    cta_url: "https://example.com/update-card",
    cta_label: "Review or update card",
    other_cards_block:
      "Or switch in one tap: [Use my card Mastercard ····8888 instead](https://example.com/use-method)\n\n",
  },
  payment_failed_3: {
    amount: "CHF 132.00",
    decline_human: "the card was declined",
    days_since_failure: 7,
    card_last4: "4242",
    cta_url: "https://example.com/update-card",
    cta_label: "Review or update card",
    other_cards_block:
      "Or switch in one tap: [Use my card Mastercard ····8888 instead](https://example.com/use-method)\n\n",
  },
  payment_failed_parked: {
    amount: "CHF 132.00",
    decline_human: "the card was declined",
    days_since_failure: 37,
    card_last4: "4242",
    cta_url: "https://example.com/update-card",
    cta_label: "Update my card",
    skip_resume_url: "https://example.com/skip-and-continue",
    resume_date: "3 October 2026",
    // The "ways to continue" block is composed by the touch (live card:
    // three exits; hard-dead card: update-only) — the sample shows the
    // three-exit variant with its links resolved.
    ways_intro:
      "Whichever suits you takes one tap:\n\n1. **Update your card** (or pick another one from your account):",
    ways_more:
      "2. **Retry with the same card** — sorted it with your bank? [Retry the payment now](https://example.com/retry-payment).\n\n3. **Skip that order and simply continue** from 3 October 2026: [Skip it and continue](https://example.com/skip-and-continue) — nothing is charged today.",
  },
  payment_failed_sms: { amount: "CHF 132.00" },
  threeds_action_sms: {
    amount: "CHF 132.00",
    confirm_url: "https://example.com/confirm-payment",
  },
  card_expiring: {
    card_brand: "Visa",
    card_last4: "4242",
    expiry: "10/2026",
    cta_url: "https://example.com/update-card",
    cta_label: "Update card",
  },
  threeds_action: {
    amount: "CHF 132.00",
    cta_url: "https://example.com/confirm-payment",
    cta_label: "Confirm payment",
  },
  gift_announcement: {
    gift_title: "Cellexia Travel Set",
    rule_name: "Loyalty gift",
    gift_image_line: "[image:Cellexia Travel Set](https://example.com/travel-set.jpg)",
    gift_worth_line: "A €39 product — yours free.",
    gift_date_line: "It arrives with your delivery on 12 September 2026.",
  },
  gift_teaser: {},
  routine_checkin: {
    week: 5,
    phase_title: "Settling into the rhythm",
    phase_body:
      "By now the routine is part of your day. Many people say this is when it starts to feel automatic — keep going, consistency is what makes the difference.",
    next_phase_line: "From week 9: When people start to notice",
    expectation_line:
      "You told us you were hoping to see something within a few weeks. Many people find it takes a couple of months to settle in, so week 5 is right on track.",
    checkin_great_url: "https://example.com/checkin-great",
    checkin_unsure_url: "https://example.com/checkin-unsure",
    cta_url: "https://example.com/account",
  },
  cancel_intent_followup: {
    reason: "TOO_MUCH_PRODUCT",
    step: "saves",
    reason_line: "You mentioned you have more product than you need right now.",
    options_block:
      "- Skip my next order: https://example.com/skip-next-order\n- Push my next order back 3 weeks: https://example.com/delay-3-weeks\n- Switch to every 12 weeks: https://example.com/set-frequency\n- Make my next order smaller: https://example.com/subscription",
    support_line: "Rather talk it through? Reach us at https://example.com/account#cxs-support — a real person reads every message.",
    set_frequency_url: "https://example.com/set-frequency",
    manage_url: "https://example.com/subscription",
    support_url: "https://example.com/account#cxs-support",
    cancel_url: "https://example.com/cancel",
    cta_url: "https://example.com/subscription",
  },
  subscription_started: {
    product: "Cellexia Renewal Serum",
    order_name: "#2148",
    first_order_line: "Your first order #2148 is placed and being prepared.",
    next_line:
      "Your next order of about CHF 132.00 is scheduled for 12 September 2026 (every 8 weeks).",
    amount: "CHF 132.00",
    edit_cutoff: "12 September 2026, 00:00",
    edit_cutoff_iso: "2026-09-11T22:00:00.000Z",
    changes_line: "You can change, skip or delay it until 12 September 2026, 00:00.",
    support_email: "hello@example.com",
    support_line: "Questions? Write to us at hello@example.com — we're happy to help.",
    cta_url: "https://example.com/account",
  },
  milestone_gift: {
    milestone_cycle: 6,
    gift_line: "To say thank you, this delivery includes a free Cellexia Night Cream — on us.",
  },
  rewards_unlocked: {
    rewards_unlock_day: 90,
    gift_line: "To celebrate, a free Cellexia Renewal Serum rides along in your next delivery.",
    gift_image_line: "[image:Cellexia Renewal Serum](https://example.com/serum.jpg)",
  },
  winback_soft: { predicted_empty_date: "2026-09-20" },
  winback_perk: {
    cta_url: "https://example.com/restart",
    gift: "true",
    gift_title: "Cellexia Night Cream",
    gift_image_line: "[image:Cellexia Night Cream](https://example.com/night-cream.jpg)",
    gift_worth_line: "A €42 product — yours free.",
  },
  winback_discount: {
    cta_url: "https://example.com/restart", discount_pct: 20, discount_cycles: 2 },
  price_change_notice: {
    product_title: "Cellexia Renewal Serum",
    old_price: "CHF 64.00",
    new_price: "CHF 68.00",
    change_count: 1,
    effective_date: "1 October 2026",
  },
  stockout_delay: { product_title: "Cellexia Renewal Serum", delay_days: 7 },
  stockout_skip: { product_title: "Cellexia Renewal Serum" },
  stockout_substitute: {
    product_title: "Cellexia Renewal Serum",
    substitute_title: "Cellexia Renewal Serum — new formula",
  },
  otp_code: { code: "482913", minutes: 10 },
  admin_alert: {
    severity: "CRITICAL",
    alertType: "BILLING_STALLED",
    message: "Sample alert: the billing run has not completed for 2 hours.",
  },
  import_summary: {
    filename: "subscribers.csv",
    total_rows: 250,
    succeeded: 248,
    failed: 2,
  },
};

/** The full sample variable set a template renders its preview from. */
export function previewSampleVars(template: TemplateKey): TemplateVars {
  return {
    ...SAMPLE_COMMON,
    ...SAMPLE_LINKS,
    ...(SAMPLE_BY_TEMPLATE[template] ?? {}),
  };
}

export interface PreviewInput {
  template: TemplateKey;
  locale?: string | null;
  /** Draft override copy — empty strings fall back to the built-in copy. */
  subject?: string;
  body?: string;
  /** Draft design — omitted = the shop's saved design. */
  design?: EmailDesign;
  shopId?: string;
}

export interface TemplatePreview extends RenderedEmail {
  /** Sample values, for the editor's placeholder helper. */
  sampleVars: TemplateVars;
  channel: "EMAIL" | "SMS";
}

/** Renders a template exactly as a real send would, from sample data. */
export async function renderTemplatePreview(
  input: PreviewInput,
): Promise<TemplatePreview> {
  let design = input.design;
  if (!design && input.shopId) {
    try {
      design = normalizeEmailDesign(
        await getSetting(input.shopId, "emailDesign"),
      );
    } catch {
      design = undefined;
    }
  }
  const sampleVars = previewSampleVars(input.template);
  const rendered = renderEmail(
    input.template,
    input.locale ?? "en",
    sampleVars,
    {
      subject: input.subject ?? "",
      body: input.body ?? "",
    },
    design ? design : undefined,
  );
  return {
    ...rendered,
    sampleVars,
    channel: TEMPLATES[input.template].channel,
  };
}
