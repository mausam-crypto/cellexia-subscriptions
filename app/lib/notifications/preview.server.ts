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
  addon_url: "https://example.com/add-to-next-order",
  reactivate_url: "https://example.com/restart",
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
  },
  resume_reminder: {
    resume_date: "12 September 2026",
    resume_date_iso: "2026-09-12",
  },
  order_confirmed: { order_name: "#2148", amount: "CHF 132.00" },
  order_shipped: { order_name: "#2148", tracking_number: "CH1029384756" },
  payment_method_updated: { card_brand: "Visa", card_last4: "4242" },
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
  },
  payment_failed_3: {
    amount: "CHF 132.00",
    decline_human: "the card was declined",
    days_since_failure: 7,
    card_last4: "4242",
    cta_url: "https://example.com/update-card",
    cta_label: "Review or update card",
  },
  payment_failed_sms: { amount: "CHF 132.00" },
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
