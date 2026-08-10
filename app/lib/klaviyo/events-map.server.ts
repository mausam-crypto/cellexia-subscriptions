import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import type { LogEventInput } from "~/lib/events/log.server";
import {
  buildActionLinkBundle,
  buildPortalUrl,
} from "~/lib/magiclinks/builder.server";
import { formatShopDate } from "~/lib/dates.server";
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
  "billing.attempt_failed": "Cellexia Payment Failed",
  "dunning.recovered": "Cellexia Payment Recovered",
  "dunning.card_expiring_notice": "Cellexia Card Expiring",
  "dunning.threeds_link_sent": "Cellexia 3DS Action Required",
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
  "contract.price_propagated": "Cellexia Price Change Notice",
  "stockout.delayed": "Cellexia Stockout Delay",
};

/** Event types whose flows need one-tap action links (dunning family). */
const LINK_BUNDLE_TYPES = new Set([
  "billing.attempt_failed",
  "dunning.card_expiring_notice",
  "dunning.threeds_link_sent",
]);

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

    if (contract) {
      const shop = await prisma.shop.findUnique({
        where: { id: contract.shopId },
      });
      const tz = shop?.ianaTimezone ?? "Europe/London";

      Object.assign(
        properties,
        await contractSnapshotProperties(contract, tz),
      );

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

    await enqueue(event.shopId, {
      eventName: metric,
      email,
      phone,
      profileAttrs,
      properties,
    });
  } catch (err) {
    console.error("[klaviyo] event mapping failed", event.type, err);
  }
}

/** Exposed for docs/tests: metric fired for a given internal event type. */
export function metricForEventType(type: string): string | undefined {
  return EVENT_METRIC_MAP[type];
}
