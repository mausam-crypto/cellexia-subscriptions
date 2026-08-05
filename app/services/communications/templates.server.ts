/**
 * Suggested Klaviyo flows — the merchant-facing blueprint for every flow that
 * should exist in Klaviyo, rendered in Settings → Integrations and documented
 * in docs/COMMUNICATIONS.md.
 *
 * Copy skeletons follow the Cellexia Continuous Treatment voice (docs/BRAND.md):
 * "treatment plan", "delivery", "routine" — never raw subscription jargon;
 * calm and premium; the reassurance "Adjust, delay or cancel online" is always
 * within reach; no countdowns or pressure tactics.
 *
 * Placeholders in {braces} map to event properties delivered with each metric
 * (see payload enrichment in klaviyo.server.ts): {portalUrl}, {firstName},
 * {cardLastDigits}, and `<field>Human` companions for date fields, e.g.
 * {nextBillingDateHuman}. In Klaviyo template syntax these become
 * `{{ event.portalUrl }}` etc.
 */
import type { LifecycleEvent } from "~/types/domain";
import { eventNameToMetric } from "./klaviyo.server";

export interface SuggestedFlow {
  /** Stable identifier for UI keys and docs cross-references. */
  key: string;
  /** Merchant-facing flow name. */
  title: string;
  /** The lifecycle event whose metric triggers the flow. */
  triggerEvent: LifecycleEvent;
  /** Klaviyo metric name to select as the flow trigger. */
  metricName: string;
  /** Plain-English description of when the metric fires. */
  whenItFires: string;
  /** Copy skeleton in the Cellexia voice. */
  copySkeleton: {
    subject: string;
    preview: string;
    body: string[];
  };
}

export const SUGGESTED_FLOWS: SuggestedFlow[] = [
  {
    key: "welcome",
    title: "Treatment plan welcome",
    triggerEvent: "SUBSCRIPTION_STARTED",
    metricName: eventNameToMetric("SUBSCRIPTION_STARTED"),
    whenItFires:
      "When a new Continuous Treatment Plan is created (subscription contract created).",
    copySkeleton: {
      subject: "Welcome to your Continuous Treatment Plan",
      preview: "Your routine is set — here's what happens next.",
      body: [
        "Hello {firstName}, your Cellexia Continuous Treatment Plan is now active.",
        "Your first delivery is on its way. From here, your routine arrives on your schedule — no reordering, no interruptions.",
        "Consistency is where results come from. We'll take care of the timing so you can focus on the ritual.",
        "Manage everything at {portalUrl}. Adjust, delay or cancel online.",
      ],
    },
  },
  {
    key: "first-charge-approaching",
    title: "First charge approaching",
    triggerEvent: "FIRST_CHARGE_APPROACHING",
    metricName: eventNameToMetric("FIRST_CHARGE_APPROACHING"),
    whenItFires:
      "A few days before the plan's next scheduled charge (pre-billing scheduler).",
    copySkeleton: {
      subject: "Your next Cellexia delivery is coming up",
      preview: "Scheduled for {nextBillingDateHuman} — adjust anytime.",
      body: [
        "Hello {firstName}, a quick note before your next delivery.",
        "Your next treatment delivery is scheduled for {nextBillingDateHuman}.",
        "Need a different date, a slower rhythm, or a change to your routine? It takes a moment: {portalUrl}.",
        "Adjust, delay or cancel online — no calls, no waiting.",
      ],
    },
  },
  {
    key: "charge-completed",
    title: "Delivery confirmed",
    triggerEvent: "CHARGE_COMPLETED",
    metricName: eventNameToMetric("CHARGE_COMPLETED"),
    whenItFires:
      "When a recurring charge succeeds and the delivery order is created.",
    copySkeleton: {
      subject: "Your Cellexia delivery is confirmed",
      preview: "Your routine continues, uninterrupted.",
      body: [
        "Thank you, {firstName} — your delivery is confirmed and being prepared.",
        "Your treatment plan continues uninterrupted; there is nothing you need to do.",
        "Review your routine or upcoming deliveries at {portalUrl}.",
      ],
    },
  },
  {
    key: "charge-failed-recovery",
    title: "Payment recovery sequence",
    triggerEvent: "CHARGE_FAILED",
    metricName: eventNameToMetric("CHARGE_FAILED"),
    whenItFires:
      "When a recurring charge fails. Build as a 3-email sequence; exit the flow when 'Cellexia Charge Completed' is received.",
    copySkeleton: {
      subject: "A small hiccup with your payment",
      preview: "Your treatment plan is safe — this takes a minute to fix.",
      body: [
        "Email 1 (right away): Hello {firstName}, we couldn't process the payment for your next delivery. Your treatment plan is safe and nothing has been lost.",
        "Email 1: Update your payment details in under a minute at {portalUrl} — we will also retry automatically.",
        "Email 2 (day 3, if unresolved): Your next delivery is still reserved for you. A quick card update keeps your routine on schedule: {portalUrl}.",
        "Email 3 (day 7, if unresolved): We'll hold your plan a little longer. If now isn't the right time, you can also delay or pause — adjust, delay or cancel online.",
      ],
    },
  },
  {
    key: "card-expiring",
    title: "Card expiring (pre-dunning)",
    triggerEvent: "CARD_EXPIRING",
    metricName: eventNameToMetric("CARD_EXPIRING"),
    whenItFires:
      "When the stored card expires before the plan's next scheduled charge (pre-dunning scan).",
    copySkeleton: {
      subject: "Your card expires before your next delivery",
      preview: "One minute now keeps your routine uninterrupted.",
      body: [
        "Hello {firstName}, a gentle heads-up.",
        "Your next treatment delivery is scheduled for {nextBillingDateHuman}. The card ending in {cardLastDigits} expires this month.",
        "Updating your card takes a minute: {portalUrl}. Your routine continues without interruption.",
      ],
    },
  },
  {
    key: "pre-shipment-window",
    title: "Pre-shipment add-on window",
    triggerEvent: "PRE_SHIPMENT_WINDOW_OPEN",
    metricName: eventNameToMetric("PRE_SHIPMENT_WINDOW_OPEN"),
    whenItFires:
      "3–7 days before a delivery is billed, when the add-on window opens.",
    copySkeleton: {
      subject: "Your next delivery is being prepared",
      preview: "Add to it with no extra shipping.",
      body: [
        "Your next Cellexia delivery is being prepared. Add any of these products with no additional shipping.",
        "These pair well with your current routine — loop over the event's `candidates` array (each entry has `title` and `priceCents`), e.g. {% for item in event.candidates %}.",
        "Add them in one tap before your delivery is billed on {nextBillingDateHuman}: {portalUrl}. No pressure — your delivery ships either way.",
      ],
    },
  },
  {
    key: "pause-ending",
    title: "Pause ending reminder",
    triggerEvent: "PAUSE_ENDING",
    metricName: eventNameToMetric("PAUSE_ENDING"),
    whenItFires: "A few days before a paused treatment plan resumes.",
    copySkeleton: {
      subject: "Your treatment plan resumes soon",
      preview: "Your pause ends on {resumeDateHuman}.",
      body: [
        "Hello {firstName}, your pause ends on {resumeDateHuman} and your next delivery will follow shortly after.",
        "Ready to continue? You don't need to do anything.",
        "Need more time or a lighter rhythm? Adjust, delay or cancel online: {portalUrl}.",
      ],
    },
  },
  {
    key: "milestone",
    title: "Milestone celebration",
    triggerEvent: "TREATMENT_MILESTONE",
    metricName: eventNameToMetric("TREATMENT_MILESTONE"),
    whenItFires:
      "When a treatment milestone is reached (first month, 90 days, six deliveries, one year).",
    copySkeleton: {
      subject: "A milestone in your treatment",
      preview: "Consistency is paying off.",
      body: [
        "Congratulations, {firstName} — you've reached {milestone} of continuous treatment.",
        "Skin responds to rhythm, and you've kept yours beautifully.",
        "A small thank-you is waiting on your account: {portalUrl}.",
      ],
    },
  },
  {
    key: "cancellation-saved",
    title: "Cancellation saved (plan adjusted)",
    triggerEvent: "CANCELLATION_SAVED",
    metricName: eventNameToMetric("CANCELLATION_SAVED"),
    whenItFires:
      "When a customer accepts a save offer in the cancellation flow and keeps their plan.",
    copySkeleton: {
      subject: "Your treatment plan has been updated",
      preview: "Your new arrangement is in place.",
      body: [
        "Thank you, {firstName} — we've adjusted your plan as requested and your routine continues on the new arrangement.",
        "Review the details, or fine-tune further, at {portalUrl}.",
        "Adjust, delay or cancel online whenever you need.",
      ],
    },
  },
  {
    key: "cancellation-completed",
    title: "Cancellation completed",
    triggerEvent: "CANCELLATION_COMPLETED",
    metricName: eventNameToMetric("CANCELLATION_COMPLETED"),
    whenItFires: "When a cancellation is finalized.",
    copySkeleton: {
      subject: "Your treatment plan is cancelled",
      preview: "Thank you for the time with us.",
      body: [
        "Your Continuous Treatment Plan is now cancelled, {firstName}. No further deliveries or charges will be made.",
        "Thank you for the time you spent with Cellexia — skin keeps its own calendar, and yours may bring you back.",
        "If you return, your routine and history will be waiting: {portalUrl}.",
      ],
    },
  },
  {
    key: "magic-link",
    title: "Secure sign-in link",
    triggerEvent: "MAGIC_LINK_REQUESTED",
    metricName: eventNameToMetric("MAGIC_LINK_REQUESTED"),
    whenItFires:
      "When a customer requests a portal sign-in link. Time-critical — send immediately, no delay steps.",
    copySkeleton: {
      subject: "Your secure sign-in link",
      preview: "Valid for 30 minutes.",
      body: [
        "Sign in securely to manage your treatment plan: {link}.",
        "The link works once and expires in 30 minutes.",
        "If you didn't request this, you can safely ignore this email — your account remains secure.",
      ],
    },
  },
  {
    key: "churn-risk-outreach",
    title: "Proactive check-in (high churn risk)",
    triggerEvent: "HIGH_CHURN_RISK",
    metricName: eventNameToMetric("HIGH_CHURN_RISK"),
    whenItFires:
      "When the churn model flags a plan as high risk (daily scan). Consider a generous flow filter (e.g. once per 60 days).",
    copySkeleton: {
      subject: "How is your routine feeling?",
      preview: "A small adjustment can make all the difference.",
      body: [
        "Hello {firstName}, a routine should fit your life — not the other way around.",
        "If deliveries are arriving too often, or something isn't working for your skin, we can adjust it in a minute: {portalUrl}.",
        "A slower rhythm, different products, a short pause — adjust, delay or cancel online. We're here to make it fit.",
      ],
    },
  },
  {
    key: "excess-inventory",
    title: "Excess inventory nudge",
    triggerEvent: "LIKELY_EXCESS_INVENTORY",
    metricName: eventNameToMetric("LIKELY_EXCESS_INVENTORY"),
    whenItFires:
      "When the depletion engine estimates deliveries are outpacing actual usage.",
    copySkeleton: {
      subject: "Building up more product than you need?",
      preview: "One tap moves your next delivery back.",
      body: [
        "It looks like your current schedule may be sending product too quickly. Your next delivery can move back in one tap — and your price protection stays.",
        "Prefer a slower rhythm overall? Switch your delivery cadence at {portalUrl}.",
        "Adjust, delay or cancel online — your plan should match your pace.",
      ],
    },
  },
  {
    key: "back-in-stock",
    title: "Back in stock",
    triggerEvent: "PRODUCT_BACK_IN_STOCK",
    metricName: eventNameToMetric("PRODUCT_BACK_IN_STOCK"),
    whenItFires:
      "When a previously out-of-stock product in a customer's routine becomes available again.",
    copySkeleton: {
      subject: "{title} is back",
      preview: "Available again for your routine.",
      body: [
        "Good news, {firstName} — {title} is available again.",
        "Add it back to your routine or your next delivery at {portalUrl}.",
      ],
    },
  },
  {
    key: "anniversary",
    title: "Anniversary celebration",
    triggerEvent: "SUBSCRIBER_ANNIVERSARY",
    metricName: eventNameToMetric("SUBSCRIBER_ANNIVERSARY"),
    whenItFires: "On the treatment plan's yearly anniversary.",
    copySkeleton: {
      subject: "A year of continuous care",
      preview: "Thank you for trusting your skin to Cellexia.",
      body: [
        "One year ago you began your Continuous Treatment Plan, {firstName}. That kind of consistency is rare — and your skin knows it.",
        "A thank-you from us is on your account: {portalUrl}.",
      ],
    },
  },
];
