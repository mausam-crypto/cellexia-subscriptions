import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import type { LogEventInput } from "~/lib/events/log.server";
import {
  buildActionLinkBundle,
  buildPortalUrl,
} from "~/lib/magiclinks/builder.server";
import { formatShopDate } from "~/lib/dates.server";
import { t } from "~/lib/i18n/i18n.server";
import { contractFrequency } from "~/lib/frequency";
import { formatMoney } from "~/lib/money";
import { enqueue } from "./outbox.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * Maps canonical internal event types to customer-facing Klaviyo metrics and
 * enqueues them in the outbox. Called by logEvent() for every event; anything
 * not in the map (admin-only / plumbing events) is silently ignored.
 *
 * Never throws into the caller — a Klaviyo mapping failure must never break
 * billing, webhooks or portal actions.
 *
 * NOTE: `notification.*` events are always skipped here. The notifications
 * router (app/lib/notifications/send.server.ts) enqueues its own metrics
 * directly — e.g. "Cellexia Upcoming Order" — and then logs notification.sent,
 * so mapping those events again would double-fire.
 */

/** internal event type → Klaviyo metric name */
const EVENT_METRIC_MAP: Record<string, string> = {
  "contract.created": "Cellexia Subscription Started",
  "contract.cancelled": "Cellexia Subscription Cancelled",
  "contract.paused": "Cellexia Subscription Paused",
  "contract.resumed": "Cellexia Subscription Resumed",
  "cycle.skipped": "Cellexia Order Skipped",
  "cycle.unskipped": "Cellexia Order Unskipped",
  "cycle.delayed": "Cellexia Order Delayed",
  "contract.frequency_changed": "Cellexia Frequency Changed",
  "contract.line_swapped": "Cellexia Product Swapped",
  "cycle.addon_added": "Cellexia Add-on Added",
  // v1.28.0 (P2.5) — per-line "not this time" / one-order quantity tweak.
  "cycle.line_skipped": "Cellexia Product Skipped Once",
  "cycle.line_unskipped": "Cellexia Product Skip Undone",
  "cycle.line_quantity_set": "Cellexia Product Quantity Once",
  // v1.28.0 (P2.6 / P2.7) — pause exit ramp + "already out" rush. Analytics
  // / segmentation metrics only (no notification template rides them, so no
  // cellexia_send verdict): the paused-until confirmation itself travels on
  // "Cellexia Subscription Paused" (contract.paused, until:true).
  "contract.pause_extended": "Cellexia Pause Extended",
  "cycle.rushed": "Cellexia Order Rushed",
  "billing.attempt_failed": "Cellexia Payment Failed",
  "dunning.recovered": "Cellexia Payment Recovered",
  "dunning.card_expiring_notice": "Cellexia Card Expiring",
  "dunning.threeds_link_sent": "Cellexia 3DS Action Required",
  // v1.28.0 — the canonical "card behind the subscription changed" moment
  // (webhook mirror, portal/admin change, backup promotion, engine swap).
  // Shares its metric with the router's payment_method_updated template;
  // the outbox graft supersedes this content-less twin exactly like
  // billing.attempt_failed × payment_failed_1. Properties carry
  // card_updated_by (customer | merchant | system) for segmentation.
  "contract.payment_method_updated": "Cellexia Payment Method Updated",
  "cancel.save_accepted": "Cellexia Cancel Save Accepted",
  "cancel.final_offer_accepted": "Cellexia Final Offer Accepted",
  "winback.soft_touch": "Cellexia Winback Soft Touch",
  "winback.perk_offered": "Cellexia Winback Perk",
  "winback.discount_offered": "Cellexia Winback Discount",
  "winback.reactivated": "Cellexia Winback Reactivated",
  // The campaign's terminal signal — the winback engine promises "Klaviyo
  // suppression keys off winback.sunset", so it must actually cross the feed
  // boundary (a merchant filtering on this metric otherwise builds a segment
  // that never populates). Ownership/demo sunsets are refused below like
  // every other event; the customer opt-out travels as its own event.
  "winback.sunset": "Cellexia Winback Sunset",
  "winback.opted_out": "Cellexia Winback Opted Out",
  "lifecycle.milestone_reached": "Cellexia Milestone Reached",
  "lifecycle.rewards_unlocked": "Cellexia Rewards Unlocked",
  "lifecycle.gift_scheduled": "Cellexia Gift Scheduled",
  "lifecycle.incentive_announced": "Cellexia Incentive Announced",
  // v1.28.0 (P4.1) — the routine check-in email's one-tap answer
  // (great | unsure); segmentation metric only, no template rides it.
  "lifecycle.checkin_answered": "Cellexia Routine Check-in Answered",
  "contract.price_propagated": "Cellexia Price Change Notice",
  "stockout.delayed": "Cellexia Stockout Delay",
  // Post-purchase survey (v1.21.0). Analytics/segmentation metric ONLY — no
  // notification template, so it never enters the guided-flow specs or the
  // KLAVIYO_FLOW_COVERAGE check (the "Cellexia Subscription Started"
  // family). Properties carry the flattened answer keys plus survey_holdout;
  // merchant-built flows triggered on this metric MUST filter
  // survey_holdout equals false, or the untreated comparison group the
  // holdout exists for is silently contaminated. No cellexia_send stamp:
  // canonical non-confirmation events stay verdict-absent (the frozen-flag
  // lesson pinned by tests/outbox-graft-verdict.test.ts).
  "survey.answered": "Cellexia Survey Answered",
  // Support request (v1.28.0, P5.1) — the portal Get-help form / cancel-flow
  // support cards. Segmentation + merchant-side helpdesk flows only; no
  // notification template rides this metric, so no cellexia_send verdict.
  // Properties are the event payload verbatim (camelCase, see
  // request.server.ts): topic, contractId, orderRef, pushBack,
  // pushBackApplied, pushBackMode?, message (truncated), surface,
  // cancelReason?, cancelSessionId? — plus the contract snapshot. Person-
  // typed (never a dual-writer metric): enqueued with dedupe OFF so two
  // distinct requests inside the 120 s window both reach Klaviyo.
  "support.requested": "Cellexia Support Requested",
};

/**
 * Event types whose every occurrence is a distinct customer act — enqueued
 * with the outbox dedupe OFF (see enqueueKlaviyoForEvent). Only add person-
 * typed events that never carry a cellexia_send verdict / content twin.
 */
export const NO_DEDUPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "support.requested",
]);

/** Event types whose flows need one-tap action links (dunning family). */
const LINK_BUNDLE_TYPES = new Set([
  "billing.attempt_failed",
  "dunning.card_expiring_notice",
  "dunning.threeds_link_sent",
]);

/**
 * Enqueued events MAY carry this property as the string "true"/"false"
 * (v1.18.0). The auto-created Klaviyo flows (guided setup,
 * app/lib/klaviyo/flows.server.ts) trigger-filter on `equals "true"`, and
 * the property's meaning is STRICT — when present, it is a VERDICT:
 *  - "true"  = this event carries the app-rendered email (content_subject
 *              + content_html) and deserves delivery — the router's EMAIL
 *              enqueues, and person-initiated + enabled + non-app-sent
 *              confirmation events;
 *  - "false" = this event must never trigger the email flow — gated
 *              confirmation moments (merge-cancels, system transitions,
 *              disabled/app-sent templates), SMS enqueues (content_text
 *              only — an email flow would render blank), and setup SEED
 *              events (which is what makes metric seeding safe even with
 *              every flow live).
 *
 * ABSENT = "no opinion": canonical non-confirmation events (contract
 * lifecycle, billing.attempt_failed, winback.*, …) deliberately do NOT
 * stamp the property — several share a metric with a router template, and
 * the router's content-carrying leg supersedes them via the outbox dedupe
 * graft. Absent fails the flows' `equals "true"` filter exactly like
 * "false", so delivery behavior is identical — but the outbox merge rule
 * can now tell a superseder-expected default (absent) from an explicit
 * verdict (present) and will never freeze a dual-writer metric's flag at
 * "false" after content arrived (the v1.18.0 pre-release defect: milestone
 * / rewards / hard-decline payment-failed emails silently never sending).
 * Flows without the filter behave exactly as before.
 */
export const CELLEXIA_SEND_PROPERTY = "cellexia_send";

/**
 * Read-only view of the auto-mapped state-change metrics, for the admin
 * Emails catalog (v1.16.0). The map itself stays private — the catalog must
 * never become a second writer of the event→metric contract.
 */
export function eventMetricEntries(): Array<{
  eventType: string;
  metric: string;
}> {
  return Object.entries(EVENT_METRIC_MAP).map(([eventType, metric]) => ({
    eventType,
    metric,
  }));
}

export type ContractWithLines = Prisma.SubscriptionContractGetPayload<{
  include: { lines: true };
}>;

function payloadNumber(
  payload: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const v = payload?.[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function payloadString(
  payload: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const v = payload?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Profile attributes synced to Klaviyo on every contract-scoped event.
 * These power the standing segments (Active Subscribers, At-risk, ...) with
 * simple property conditions instead of fragile metric-count logic.
 */
export function contractProfileAttrs(
  contract: ContractWithLines,
): Record<string, unknown> {
  // cellexia_interval_weeks stays the week approximation (additive property
  // contract); unit/count are the exact cadence, WEEK/intervalWeeks when the
  // contract has no mirror columns yet.
  const freq = contractFrequency(contract);
  const attrs: Record<string, unknown> = {
    cellexia_subscription_status: contract.status,
    cellexia_orders_count: contract.ordersCount,
    cellexia_interval_weeks: contract.intervalWeeks,
    cellexia_interval_unit: freq.unit,
    cellexia_interval_count: freq.count,
  };
  if (contract.firstName) attrs.first_name = contract.firstName;
  if (contract.lastName) attrs.last_name = contract.lastName;
  if (contract.nextBillingDate) {
    attrs.cellexia_next_billing_date = contract.nextBillingDate.toISOString();
  }
  if (contract.churnRiskScore != null) {
    attrs.cellexia_churn_risk = contract.churnRiskScore;
  }
  // Acquisition attributes (data foundation, migration 0006) — only when
  // captured, so profiles never carry explicit "unknown"s. Powers
  // source-level and geo-level segmentation in Klaviyo.
  if (contract.acqSourceName) {
    attrs.cellexia_acq_source = contract.acqSourceName;
  }
  if (contract.acqCountryCode) {
    attrs.cellexia_acq_country = contract.acqCountryCode;
  }
  return attrs;
}

/**
 * Standard contract snapshot merged into every contract-scoped Klaviyo event.
 * Also used by the notifications router so both paths emit identical shapes.
 */
export async function contractSnapshotProperties(
  contract: ContractWithLines,
  tz: string,
): Promise<Record<string, unknown>> {
  const activeLines = contract.lines.filter((l) => !l.isGift);
  // interval_weeks stays the week approximation (additive property contract);
  // unit/count are the exact cadence, WEEK/intervalWeeks when no mirror.
  const freq = contractFrequency(contract);
  const props: Record<string, unknown> = {
    contract_id: contract.id,
    shopify_contract_id: contract.shopifyContractId,
    contract_status: contract.status,
    // v1.18.0 — the editor has always advertised {first_name} as a copy
    // placeholder; putting it in the snapshot makes it actually resolve in
    // BOTH content pipelines (router + confirmation events) instead of
    // relying on the profile attributes flows can't interpolate from.
    ...(contract.firstName ? { first_name: contract.firstName } : {}),
    ...(contract.lastName ? { last_name: contract.lastName } : {}),
    interval_weeks: contract.intervalWeeks,
    interval_unit: freq.unit,
    interval_count: freq.count,
    orders_count: contract.ordersCount,
    currency: contract.currencyCode,
    is_prepaid: contract.isPrepaid,
    item_titles: activeLines.map((l) => l.title),
    items: contract.lines.map((l) => ({
      title: l.title,
      variant_title: l.variantTitle ?? null,
      quantity: l.quantity,
      is_gift: l.isGift,
      is_one_time_addon: l.isOneTimeAddon,
    })),
  };
  if (contract.nextBillingDate) {
    props.next_billing_date = contract.nextBillingDate.toISOString();
    props.next_billing_date_formatted = formatShopDate(
      contract.nextBillingDate,
      tz,
      contract.locale,
    );
  }
  // Pause exit ramp (v1.28.0, P2.6): a PAUSED contract's exact resume day,
  // so the pause confirmation (and any flow) can quote the date the hold
  // ends. `resume_line` is the ready sentence — empty when there is no
  // scheduled resume (an external pause), so copy never shows a bare
  // placeholder.
  if (contract.status === "PAUSED" && contract.resumeAt) {
    const resumeDate = formatShopDate(contract.resumeAt, tz, contract.locale);
    props.resume_date = resumeDate;
    props.resume_date_iso = contract.resumeAt.toISOString();
    props.resume_line = t(contract.locale, "email.pause_confirmed.resume_line", {
      resume_date: resumeDate,
    });
  } else {
    props.resume_line = "";
  }
  try {
    props.portal_url = await buildPortalUrl(contract.shopId);
  } catch (err) {
    console.error("[klaviyo] portal URL build failed", contract.id, err);
  }
  return props;
}

async function dunningContextProperties(
  event: LogEventInput,
  contract: ContractWithLines,
): Promise<Record<string, unknown>> {
  const payload = event.payload;
  const props: Record<string, unknown> = {};

  const attemptNumber = payloadNumber(
    payload,
    "attemptNumber",
    "attempt_number",
  );
  if (attemptNumber !== undefined) props.attempt_number = attemptNumber;

  const amountCents = payloadNumber(payload, "amountCents", "amount_cents");
  if (amountCents !== undefined) {
    props.amount_cents = amountCents;
    props.amount_formatted = formatMoney(
      amountCents,
      contract.currencyCode,
      contract.locale,
    );
  }

  const errorCode = payloadString(payload, "errorCode", "error_code");
  if (errorCode) props.decline_code = errorCode;
  const declineCategory = payloadString(
    payload,
    "declineCategory",
    "decline_category",
  );
  if (declineCategory) props.decline_category = declineCategory;

  // 3DS challenge URL travels in the event payload.
  const redirectUrl = payloadString(
    payload,
    "redirectUrl",
    "redirect_url",
    "url",
  );
  if (redirectUrl) props.threeds_url = redirectUrl;

  try {
    const openCase = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, resolvedAt: null },
      orderBy: { openedAt: "desc" },
    });
    if (openCase) {
      props.dunning_state = openCase.state;
      props.dunning_ladder_step = openCase.ladderStep;
      if (props.attempt_number === undefined) {
        props.attempt_number = openCase.ladderStep + 1;
      }
      if (openCase.nextRetryAt) {
        props.next_retry_at = openCase.nextRetryAt.toISOString();
      }
      if (openCase.declineCategory && !props.decline_category) {
        props.decline_category = openCase.declineCategory;
      }
    }
  } catch (err) {
    console.error("[klaviyo] dunning context lookup failed", contract.id, err);
  }

  // Card metadata helps flows say "your Visa ending 4242".
  if (contract.cardBrand) props.card_brand = contract.cardBrand;
  if (contract.cardLast4) props.card_last4 = contract.cardLast4;
  if (contract.cardExpiryMonth && contract.cardExpiryYear) {
    props.card_expiry = `${String(contract.cardExpiryMonth).padStart(2, "0")}/${contract.cardExpiryYear}`;
  }

  return props;
}

/**
 * Entry point called from logEvent() for every internal event.
 * Enqueues at most one Klaviyo event; skips everything unmapped.
 */
export async function enqueueKlaviyoForEvent(
  event: LogEventInput,
): Promise<void> {
  try {
    // SETUP gate: while the shop is not live, no Klaviyo event is enqueued at
    // all — flows must never fire from setup-mode noise. Lazy import keeps
    // the launch↔klaviyo module graph acyclic; the outer catch keeps a failed
    // mode read from ever throwing into the caller.
    {
      const { isSetupMode } = await import("~/lib/launch/launch.server");
      if (await isSetupMode(event.shopId)) return;
    }

    // Notification-trigger metrics are enqueued directly by the notifications
    // module; see module note above.
    if (event.type.startsWith("notification.")) return;

    const metric = EVENT_METRIC_MAP[event.type];
    if (!metric) return; // admin-only / plumbing event

    let contract: ContractWithLines | null = null;
    if (event.contractId) {
      contract = await prisma.subscriptionContract.findUnique({
        where: { id: event.contractId },
        include: { lines: true },
      });
      // Demo contracts are local-only preview fixtures — never sync them (or
      // their fake profiles) into Klaviyo.
      if (contract?.isDemo) return;
      // Contracts belonging to another subscription app on the same shop are
      // mirrored here by the SUBSCRIPTION_CONTRACTS_* webhooks. Their
      // subscribers never opted into OUR flows, and the other app is already
      // messaging them — never enqueue an event (or a profile) for them.
      // UNKNOWN fails safe the same way.
      if (contract && !isBillableOwnership(contract.ownership)) return;
    }

    const email = event.email ?? contract?.email ?? null;
    const phone = contract?.phone ?? null;
    if (!email && !phone) return; // nobody to target

    // Start from the raw event payload so per-event context (weeks delayed,
    // old/new frequency, gift variant, ...) flows straight into Klaviyo.
    const properties: Record<string, unknown> = {
      ...(event.payload ?? {}),
      event_type: event.type,
    };

    const profileAttrs: Record<string, unknown> = contract
      ? contractProfileAttrs(contract)
      : {};
    // Keep the profile's dunning flag current for the "Dunning open" segment.
    if (event.type === "billing.attempt_failed") {
      profileAttrs.cellexia_dunning_open = true;
    } else if (event.type === "dunning.recovered") {
      profileAttrs.cellexia_dunning_open = false;
    }

    // ── cellexia_send verdict + confirmation content (v1.18.0) ─────────────
    // Canonical NON-confirmation events stamp NOTHING (absent = "no
    // opinion"): they exist for segments/analytics, and delivery rides the
    // notifications router's enqueue, which carries the rendered content
    // and stamps its own "true". Several canonical types share a metric
    // with router templates (billing.attempt_failed → "Cellexia Payment
    // Failed", lifecycle.*, winback.*, …); when the two legs collide inside
    // the 120s dedupe window the graft supersedes the flag on the surviving
    // row, and an ABSENT default is what makes that supersession safe —
    // stamping "false" here once froze dual-writer metrics silent forever
    // (the pre-release defect). Outside the window the canonical leg
    // simply fails the flows' `equals "true"` filter, same as before.
    //
    // Confirmation moments DO get an explicit verdict — "true" only when:
    // person-initiated (the SAME provenance gate the app-sent bridge uses,
    // with the contract mirror as fallback for webhook-diff twins that
    // carry no cancelSource), enabled in-app, NOT app-sent (the bridge
    // owns delivery then — one email, never two), and the content actually
    // rendered. A verdict, once written, is protected from graft flips.
    let cellexiaSend = false;
    let confirmationTemplate: string | null = null;
    try {
      const { CONFIRMATION_TEMPLATE_BY_EVENT, isPersonInitiated } = await import(
        "~/lib/notifications/confirmations.server"
      );
      confirmationTemplate = CONFIRMATION_TEMPLATE_BY_EVENT[event.type] ?? null;
      if (confirmationTemplate) {
        cellexiaSend = isPersonInitiated(event, contract);
        if (cellexiaSend) {
          const { getSetting } = await import("~/lib/settings/settings.server");
          const emails = await getSetting(event.shopId, "emails");
          const override = emails.templates[confirmationTemplate];
          if (override?.enabled === false || override?.sender === "app") {
            cellexiaSend = false;
          }
        }
      }
    } catch (err) {
      // Fail SAFE: without a verdict, no auto-flow sends.
      cellexiaSend = false;
      console.error("[klaviyo] cellexia_send resolution failed", event.type, err);
    }

    if (contract) {
      const shop = await prisma.shop.findUnique({
        where: { id: contract.shopId },
      });
      const tz = shop?.ianaTimezone ?? "Europe/London";

      Object.assign(
        properties,
        await contractSnapshotProperties(contract, tz),
      );

      // Cancellation (v1.28.0, P3.2): the signed one-tap `restart_url` rides
      // on the metric so a Klaviyo-rendered cancel_confirmed (auto-created
      // flow or the merchant's own) can offer a login-free restart. Minted
      // BEFORE the confirmation render below so {restart_url} resolves in
      // the content. Contained: {} on failure / MERGED / foreign / demo.
      if (event.type === "contract.cancelled") {
        try {
          const { restartLinkVars } = await import("~/lib/winback/links.server");
          Object.assign(
            properties,
            await restartLinkVars(contract, { createdVia: "KLAVIYO_FLOW" }),
          );
        } catch (err) {
          console.error("[klaviyo] restart link failed", contract.id, err);
        }
        // Never a literal {restart_url} in a Klaviyo-rendered body: degrade
        // to the portal link when the mint failed.
        if (
          typeof properties.restart_url !== "string" &&
          typeof properties.portal_url === "string"
        ) {
          properties.restart_url = properties.portal_url;
        }
      }

      if (confirmationTemplate && cellexiaSend) {
        try {
          const { renderEmail } = await import(
            "~/lib/notifications/templates.server"
          );
          const { normalizeEmailDesign } = await import(
            "~/lib/notifications/format"
          );
          const { getSetting } = await import("~/lib/settings/settings.server");
          const [emails, design] = await Promise.all([
            getSetting(event.shopId, "emails"),
            getSetting(event.shopId, "emailDesign"),
          ]);
          const override = emails.templates[confirmationTemplate] ?? null;
          const contentVars: Record<string, string | number> = {};
          for (const [k, v] of Object.entries(properties)) {
            if (typeof v === "string" || typeof v === "number") contentVars[k] = v;
          }
          const content = renderEmail(
            confirmationTemplate as Parameters<typeof renderEmail>[0],
            contract.locale,
            contentVars,
            override ? { subject: override.subject, body: override.body } : null,
            normalizeEmailDesign(design),
          );
          properties.content_subject = content.subject;
          properties.content_html = content.html;
          properties.content_text = content.text;
        } catch (err) {
          // No content = an auto-created flow would send an EMPTY email —
          // flip the verdict so it sends nothing instead.
          cellexiaSend = false;
          console.error(
            "[klaviyo] confirmation content render failed",
            event.type,
            err,
          );
        }
      }

      if (LINK_BUNDLE_TYPES.has(event.type)) {
        Object.assign(
          properties,
          await dunningContextProperties(event, contract),
        );
        try {
          const bundle = await buildActionLinkBundle({
            contractId: contract.id,
            customerId: contract.customerId,
            email: email ?? undefined,
            createdVia: "KLAVIYO_FLOW",
          });
          Object.assign(properties, bundle);
        } catch (err) {
          console.error(
            "[klaviyo] action link bundle failed",
            contract.id,
            err,
          );
        }
      }
    }

    // Verdicts only — non-confirmation canonical events stay unstamped
    // (see the property's contract above).
    if (confirmationTemplate) {
      properties[CELLEXIA_SEND_PROPERTY] = cellexiaSend ? "true" : "false";
    }

    await enqueue(
      event.shopId,
      {
        eventName: metric,
        email,
        phone,
        profileAttrs,
        properties,
      },
      // The outbox dedupe collapses same shop+metric+email+contract rows
      // inside 120 s regardless of properties — right for dual-writer
      // metrics, wrong for a customer typing two different support requests
      // (a delivery problem, then a plan question) whose second topic /
      // message would silently never reach Klaviyo.
      NO_DEDUPE_EVENT_TYPES.has(event.type) ? { dedupe: false } : {},
    );
  } catch (err) {
    console.error("[klaviyo] event mapping failed", event.type, err);
  }
}

/** Exposed for docs/tests: metric fired for a given internal event type. */
export function metricForEventType(type: string): string | undefined {
  return EVENT_METRIC_MAP[type];
}
