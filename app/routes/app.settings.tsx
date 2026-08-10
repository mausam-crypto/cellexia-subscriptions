import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  Link,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import {
  getAllSettings,
  getSetting,
  setSetting,
} from "~/lib/settings/settings.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import type { SettingsKey } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Admin — Settings.
 *
 * Grouped editor over the whole typed settings registry ("settings, not
 * accidents"). Each section is described declaratively (field path, type,
 * label, rationale helpText); one generic renderer draws it and one generic
 * parser rebuilds + zod-validates the section value on save. Validation
 * errors surface inline per field; every save is logged as admin.action.
 *
 * The cancel flow has its own page (app/cancel-flow) — it is intentionally
 * absent here.
 */

// ── Declarative section/field model (shared by server parser + client UI) ────

type FieldType =
  | "text"
  | "int"
  | "float"
  | "toggle"
  | "select"
  | "intList"
  | "stringList";

interface FieldDef {
  path: string; // dot-path inside the section value, e.g. "channels.email"
  label: string;
  helpText: string;
  type: FieldType;
  options?: { label: string; value: string }[];
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

interface SectionDef {
  key: string; // SettingsKey
  title: string;
  description: string;
  fields: FieldDef[];
}

const SECTION_DEFS: SectionDef[] = [
  {
    key: "discountStacking",
    title: "Offers & stacking",
    description:
      "What may combine with the subscription discount. Stacking is where margins quietly die.",
    fields: [
      {
        path: "allowPromoCodesOnFirstOrder",
        label: "Allow promo codes on the first order",
        helpText:
          "The first order is a normal checkout — codes here are a safe acquisition lever.",
        type: "toggle",
      },
      {
        path: "allowPromoCodesOnRenewals",
        label: "Allow promo codes on renewals",
        helpText:
          "Codes misbehave on recurring billing. Renewal pricing should come only from plan pricing and discount grants — keep this off.",
        type: "toggle",
      },
      {
        path: "referralCreditStacksWithSubscription",
        label: "Referral credit stacks with the subscription discount",
        helpText:
          "Referred subscribers are the cheapest acquisitions you have — usually worth the extra margin.",
        type: "toggle",
      },
      {
        path: "maxTotalDiscountPct",
        label: "Maximum total discount",
        helpText:
          "Hard ceiling across everything stacked — the gross-margin airbag against stacking bugs.",
        type: "int",
        min: 0,
        max: 90,
        suffix: "%",
      },
    ],
  },
  {
    key: "priceChangePolicy",
    title: "Price changes",
    description:
      "What happens to existing subscribers when catalog prices change.",
    fields: [
      {
        path: "mode",
        label: "Mode",
        helpText:
          "GRANDFATHER keeps churn risk at zero but freezes margin; PROPAGATE_WITH_NOTICE recovers margin at a small, honest churn cost.",
        type: "select",
        options: [
          { label: "Grandfather existing subscribers", value: "GRANDFATHER" },
          {
            label: "Propagate with advance notice",
            value: "PROPAGATE_WITH_NOTICE",
          },
        ],
      },
      {
        path: "noticeDays",
        label: "Notice period (days)",
        helpText:
          "Advance warning before a propagated price bills — surprise price hikes convert straight into cancels.",
        type: "int",
        min: 7,
        max: 90,
      },
    ],
  },
  {
    key: "stockout",
    title: "Stockouts",
    description:
      "Default behaviour when a renewal hits an out-of-stock line (per-product overrides live on the Plans page).",
    fields: [
      {
        path: "policy",
        label: "Policy",
        helpText:
          "DELAY keeps the revenue, SKIP_NOTIFY keeps the trust, SUBSTITUTE keeps the habit — pick per your restock reliability.",
        type: "select",
        options: [
          { label: "Delay the renewal", value: "DELAY" },
          { label: "Skip and notify", value: "SKIP_NOTIFY" },
          { label: "Substitute a variant", value: "SUBSTITUTE" },
        ],
      },
      {
        path: "delayDays",
        label: "Delay length (days)",
        helpText:
          "Long enough for a restock, short enough that the routine survives.",
        type: "int",
        min: 1,
        max: 30,
      },
      {
        path: "notifyCustomer",
        label: "Notify the customer",
        helpText: "Silent delays read as billing bugs — always explain.",
        type: "toggle",
      },
      {
        path: "maxDelays",
        label: "Max consecutive delays",
        helpText:
          "After this many delays the cycle is skipped instead — don't stack delays forever.",
        type: "int",
        min: 1,
        max: 5,
      },
    ],
  },
  {
    key: "dunning",
    title: "Dunning (failed payments)",
    description:
      "The retry ladder for involuntary churn — where the easiest saved revenue in the whole app lives.",
    fields: [
      {
        path: "softRetryDays",
        label: "Retry offsets (days from first failure)",
        helpText:
          "Comma-separated, e.g. 0, 3, 7, 14. Most soft declines clear within a week — front-load the early retries.",
        type: "intList",
      },
      {
        path: "paydayAlign",
        label: "Align retries to paydays",
        helpText:
          "Insufficient-funds declines recover dramatically better on payday.",
        type: "toggle",
      },
      {
        path: "paydaysOfMonth",
        label: "Paydays of month",
        helpText: "Comma-separated days 1–28, e.g. 1, 15, 25.",
        type: "intList",
      },
      {
        path: "paydaySnapWindowDays",
        label: "Payday snap window (days)",
        helpText:
          "How far forward a retry may move to reach a payday — 0 disables snapping.",
        type: "int",
        min: 0,
        max: 7,
      },
      {
        path: "emailLadderDays",
        label: "Email nudges (days from first failure)",
        helpText:
          "Comma-separated. Each email carries a one-click magic card-update link.",
        type: "intList",
      },
      {
        path: "smsDay",
        label: "SMS day",
        helpText:
          "Day of the single SMS nudge. SMS is intrusive — use exactly one, late in the ladder.",
        type: "int",
        min: 0,
        max: 60,
      },
      {
        path: "preExpiryNoticeDays",
        label: "Card-expiry notice (days before)",
        helpText:
          "Prompt a card update before it expires — prevention beats recovery every time.",
        type: "int",
        min: 7,
        max: 60,
      },
      {
        path: "backupPaymentFallback",
        label: "Try the backup card",
        helpText:
          "Charge the customer's backup payment method before burning another retry — free recovery.",
        type: "toggle",
      },
      {
        path: "exhaustedAction",
        label: "When the ladder is exhausted",
        helpText:
          "PAUSE keeps the relationship (and win-back) alive; CANCEL keeps the books clean.",
        type: "select",
        options: [
          { label: "Pause the subscription", value: "PAUSE" },
          { label: "Cancel the subscription", value: "CANCEL" },
        ],
      },
      {
        path: "cancelAfterFailedDays",
        label: "Cancel after failed (days)",
        helpText:
          "Hard stop — a contract failing this long is cancelled regardless.",
        type: "int",
        min: 7,
        max: 90,
      },
    ],
  },
  {
    key: "pause",
    title: "Pause",
    description:
      "A pause churns roughly half as often as a cancel — make it generous but bounded.",
    fields: [
      {
        path: "maxMonths",
        label: "Maximum pause (months)",
        helpText: "Longest pause a customer can pick (1–6).",
        type: "int",
        min: 1,
        max: 6,
      },
      {
        path: "resumeReminderDaysBefore",
        label: "Resume reminder (days before)",
        helpText:
          "Heads-up before auto-resume — surprise charges become chargebacks.",
        type: "int",
        min: 1,
        max: 14,
      },
    ],
  },
  {
    key: "portal",
    title: "Customer portal",
    description: "Self-serve behaviour and session security.",
    fields: [
      {
        path: "contextualPrompts",
        label: "Contextual prompts",
        helpText:
          "Smart nudges (e.g. suggest a slower cadence after repeated skips) — saves subscribers before they find the cancel button.",
        type: "toggle",
      },
      {
        path: "allowAddProducts",
        label: "Allow adding products",
        helpText:
          "Let subscribers add items to their next order — the highest-margin upsell channel you have.",
        type: "toggle",
      },
      {
        path: "otpCodeTtlMinutes",
        label: "OTP code lifetime (minutes)",
        helpText: "Login code validity (5–30).",
        type: "int",
        min: 5,
        max: 30,
      },
      {
        path: "sessionTtlDays",
        label: "Portal session lifetime (days)",
        helpText: "Longer sessions mean fewer logins and more self-serve.",
        type: "int",
        min: 1,
        max: 90,
      },
      {
        path: "magicLinkTtlDays",
        label: "Magic link lifetime (days)",
        helpText:
          "One-click action links in emails; longer converts better, slightly riskier.",
        type: "int",
        min: 1,
        max: 30,
      },
    ],
  },
  // No "buyBox" card: buy-box presentation (savings format, preselect,
  // reassurance line) is controlled where the widget actually reads it — the
  // theme-editor block settings and the Buy box designer — not from this
  // page. A card here once duplicated those as controls nothing consumed;
  // dead toggles erode trust in every live one on this page.
  {
    key: "cadence",
    title: "Cadence alerts",
    description:
      "Detect subscribers whose delivery rhythm is faster than their usage — they skip, then they cancel.",
    fields: [
      {
        path: "fastShippingSkipAlert",
        label: "Alert on heavy skipping",
        helpText:
          "Raise an alert when a subscriber skips so often the cadence is clearly too fast — fix the cadence, keep the customer.",
        type: "toggle",
      },
      {
        path: "skipRatioThreshold",
        label: "Skip ratio threshold",
        helpText:
          "Fraction of recent cycles skipped that counts as too fast, e.g. 0.5 = every other cycle.",
        type: "float",
        min: 0.1,
        max: 1,
        step: 0.05,
      },
      {
        path: "skipRatioWindowCycles",
        label: "Window (cycles)",
        helpText: "How many recent cycles the ratio considers.",
        type: "int",
        min: 2,
        max: 12,
      },
    ],
  },
  {
    key: "consolidation",
    title: "Consolidation (routine box)",
    description:
      "Merge a customer's aligned contracts into one parcel and one charge — less fatigue, lower shipping cost.",
    fields: [
      {
        path: "autoMergeAlignedContracts",
        label: "Auto-merge aligned contracts",
        helpText:
          "Contracts billing within the window are merged automatically into a single routine box.",
        type: "toggle",
      },
      {
        path: "alignmentWindowDays",
        label: "Alignment window (days)",
        helpText: "Max days apart two contracts can bill and still merge.",
        type: "int",
        min: 0,
        max: 7,
      },
    ],
  },
  {
    key: "notifications",
    title: "Notifications",
    description: "Transactional messaging around each renewal.",
    fields: [
      {
        path: "upcomingOrderDaysBefore",
        label: "Upcoming-order notice (days before)",
        helpText:
          "Forewarned customers skip or delay; surprised customers cancel and charge back.",
        type: "int",
        min: 1,
        max: 14,
      },
      {
        path: "addonSuggestionEnabled",
        label: "Suggest a one-tap add-on",
        helpText:
          "Attach an \"add it to my order\" button to the upcoming-order reminder — the cheapest AOV lift in the app. Also requires \"Allow adding products\" (portal settings).",
        type: "toggle",
      },
      {
        path: "addonSuggestionVariantId",
        label: "Add-on suggestion variant",
        helpText:
          "Variant GID (gid://shopify/ProductVariant/…) or numeric ID to suggest. Leave empty to auto-pick the top subscribable product the customer doesn't already receive.",
        type: "text",
      },
      {
        path: "channels.email",
        label: "Email channel",
        helpText: "Send transactional email (via Klaviyo events or SMTP).",
        type: "toggle",
      },
      {
        path: "channels.sms",
        label: "SMS channel",
        helpText: "Send transactional SMS where a phone number and consent exist.",
        type: "toggle",
      },
    ],
  },
  {
    key: "lifecycle",
    title: "Lifecycle & milestones",
    description:
      "Scheduled delight: gifts and perks placed exactly where churn peaks. Pair with rules on the Gifts page.",
    fields: [
      {
        path: "surpriseGiftOnCycle2",
        label: "Surprise gift on cycle 2",
        helpText:
          "An unannounced extra in the second order — lands at peak early churn.",
        type: "toggle",
      },
      {
        path: "milestoneGiftCycle",
        label: "Milestone gift order number",
        helpText:
          "The announced milestone reward (e.g. order 6) — carries subscribers through the boring middle.",
        type: "int",
        min: 2,
        max: 24,
      },
      {
        path: "anniversaryGiftDays",
        label: "Anniversary gift (days subscribed)",
        helpText: "e.g. 365 — thank your highest-LTV customers.",
        type: "int",
        min: 90,
        max: 1000,
      },
      {
        path: "rewardsUnlockDay",
        label: "Rewards unlock day",
        helpText:
          "A retention milestone dressed as a perk — gives day-60 wobblers a reason to reach day 90.",
        type: "int",
        min: 30,
        max: 365,
      },
      {
        path: "earlyCycleIncentivesEnabled",
        label: "Early-cycle incentives",
        helpText:
          "Extra nudges through cycles 1–2, where most voluntary churn happens.",
        type: "toggle",
      },
    ],
  },
  {
    key: "winback",
    title: "Win-back",
    description:
      "Touches are timed to the predicted empty date, not the cancel date — nobody resubscribes with a full jar.",
    fields: [
      {
        path: "enabled",
        label: "Win-back enabled",
        helpText: "Stage cancelled subscribers through the touch sequence below.",
        type: "toggle",
      },
      {
        path: "softTouchOffsetDays",
        label: "Soft touch (days vs empty date)",
        helpText:
          "No-offer check-in; negative = before the product runs out (e.g. -7).",
        type: "int",
        min: -90,
        max: 90,
      },
      {
        path: "perkOffsetDays",
        label: "Perk touch (days vs empty date)",
        helpText: "Free-gift offer just after the jar runs out.",
        type: "int",
        min: -90,
        max: 180,
      },
      {
        path: "discountOffsetDays",
        label: "Discount touch (days vs empty date)",
        helpText:
          "The capped discount only once the habit is truly broken — never open with money.",
        type: "int",
        min: -90,
        max: 365,
      },
      {
        path: "sunsetOffsetDays",
        label: "Sunset (days vs empty date)",
        helpText:
          "Stop touching after this — endless win-back trains people to ignore you.",
        type: "int",
        min: 0,
        max: 730,
      },
      {
        path: "discountPct",
        label: "Win-back discount",
        helpText: "Capped on purpose — 5–30%.",
        type: "int",
        min: 5,
        max: 30,
        suffix: "%",
      },
      {
        path: "discountCycles",
        label: "Discount cycles",
        helpText: "How many cycles the win-back discount lasts (1–3).",
        type: "int",
        min: 1,
        max: 3,
      },
      {
        path: "reactivationBillDelayDays",
        label: "Reactivation bill delay (days)",
        helpText:
          "A won-back subscriber's first renewal bills this many days after they reactivate — get product moving quickly.",
        type: "int",
        min: 1,
        max: 14,
      },
      {
        path: "linkGraceDays",
        label: "One-tap link grace (days)",
        helpText:
          "Reactivation links stay valid this many days past the campaign window, so a late click still works.",
        type: "int",
        min: 0,
        max: 60,
      },
    ],
  },
  {
    key: "costModel",
    title: "Costs & profit",
    description:
      "The costs subtracted from collected revenue to compute gross profit and LTGP (Analytics → Cohorts & LTGP). Nothing here changes billing — only reporting. Per-product COGS overrides live on the Plans page under \"Costs & margins\".",
    fields: [
      {
        path: "paymentFeePct",
        label: "Payment fee (percentage)",
        helpText:
          "Your processor's per-charge percentage. Shopify Payments Switzerland: Basic 2.9%, Shopify 2.7%, Advanced 2.5% for domestic cards — international cards cost more.",
        type: "float",
        min: 0,
        max: 15,
        step: 0.1,
        suffix: "%",
      },
      {
        path: "paymentFeeFixedCents",
        label: "Payment fee (fixed per charge)",
        helpText: "The fixed per-transaction fee, in cents (Shopify Payments: 30).",
        type: "int",
        min: 0,
        max: 500,
        suffix: "cents",
      },
      {
        path: "fulfillmentCostPerShipmentCents",
        label: "Fulfillment cost per shipment",
        helpText:
          "Pick, pack and packaging per parcel, in cents — what leaving the warehouse costs you before postage.",
        type: "int",
        min: 0,
        max: 100000,
        suffix: "cents",
      },
      {
        path: "shippingCostPerShipmentCents.mode",
        label: "Shipping cost model",
        helpText:
          "What YOU pay the carrier per parcel. \"Flat per parcel\" uses the amount below. \"Same as charged to customer\" assumes cost ≈ the delivery price the customer paid — with free shipping that means zero cost, which is almost certainly wrong; use flat.",
        type: "select",
        options: [
          { label: "Flat cost per parcel", value: "flat" },
          { label: "Same as charged to the customer", value: "charged" },
        ],
      },
      {
        path: "shippingCostPerShipmentCents.flatCents",
        label: "Flat shipping cost per parcel",
        helpText:
          "Your real carrier cost per parcel, in cents (e.g. 800 = CHF 8.00). Used only in flat mode.",
        type: "int",
        min: 0,
        max: 100000,
        suffix: "cents",
      },
      {
        path: "cogsFallbackPctOfPrice",
        label: "COGS fallback (% of price)",
        helpText:
          "Used ONLY for products with no cost anywhere (no Shopify \"cost per item\", no override on the Plans page). Estimated COGS is counted separately so the analytics can tell you how much of LTGP is estimated.",
        type: "float",
        min: 0,
        max: 100,
        step: 1,
        suffix: "%",
      },
    ],
  },
  {
    key: "alerts",
    title: "Alerts",
    description: "Operational monitoring — who gets told when something spikes.",
    fields: [
      {
        path: "emailTo",
        label: "Alert recipients",
        helpText: "Comma-separated internal email addresses.",
        type: "stringList",
      },
      {
        path: "failureSpikeThresholdPct",
        label: "Payment failure spike threshold",
        helpText: "Alert when the daily failure rate exceeds this percentage.",
        type: "float",
        min: 1,
        max: 100,
        suffix: "%",
      },
      {
        path: "churnSpikeThresholdPct",
        label: "Churn spike threshold",
        helpText: "Alert when daily churn exceeds this percentage.",
        type: "float",
        min: 1,
        max: 100,
        suffix: "%",
      },
      {
        path: "stuckContractHours",
        label: "Stuck contract threshold (hours)",
        helpText:
          "Alert when a contract is overdue for billing this many hours — catches scheduler faults early.",
        type: "int",
        min: 1,
        max: 168,
      },
    ],
  },
];

// ── Dot-path helpers ─────────────────────────────────────────────────────────

function getPath(value: unknown, path: string): unknown {
  let cursor: unknown = value;
  for (const part of path.split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (
      typeof cursor[key] !== "object" ||
      cursor[key] == null ||
      Array.isArray(cursor[key])
    ) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const settings = await getAllSettings(shop.id);
  return json({ settings, currencyCode: shop.currencyCode });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionData {
  intent: string;
  ok: boolean;
  section?: string;
  toast?: string;
  errors?: Record<string, string>;
}

function coerceField(field: FieldDef, raw: string | null): unknown {
  const text = raw ?? "";
  switch (field.type) {
    case "toggle":
      return text === "true";
    case "int":
    case "float": {
      const trimmed = text.trim();
      return trimmed === "" ? undefined : Number(trimmed);
    }
    case "intList":
      return text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number);
    case "stringList":
      return text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    default:
      return text;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "save-section") {
    const sectionKey = String(formData.get("section") ?? "");
    const def = SECTION_DEFS.find((s) => s.key === sectionKey);
    if (!def || !(sectionKey in settingsSchemas)) {
      return json<ActionData>(
        { intent, ok: false, toast: "Unknown settings section" },
        { status: 400 },
      );
    }
    const key = sectionKey as SettingsKey;

    const candidate: Record<string, unknown> = {};
    for (const field of def.fields) {
      const raw = formData.get(`f_${field.path}`);
      setPath(
        candidate,
        field.path,
        coerceField(field, typeof raw === "string" ? raw : null),
      );
    }

    const parsed = settingsSchemas[key].safeParse(candidate);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".") || "form";
        if (!errors[path]) errors[path] = issue.message;
      }
      return json<ActionData>(
        { intent, ok: false, section: key, errors },
        { status: 422 },
      );
    }

    // Read the outgoing value BEFORE the write so the audit event carries
    // both sides of the change — `value` alone said what the settings became
    // but never what they were, so the event log could not answer "who
    // changed the dunning ladder and from what" without replaying every save.
    const previous = await getSetting(shop.id, key);

    // parsed.data already passed the exact schema setSetting re-validates.
    await setSetting(shop.id, key, parsed.data as never, actor);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "settings_updated",
        key,
        // `value` keeps its historical meaning (the NEXT state — additive
        // rule: never repurpose an event field); `previous` is the state it
        // replaced, as getSetting resolved it (defaults included).
        value: parsed.data as Record<string, unknown>,
        previous: previous as Record<string, unknown>,
      },
    });

    return json<ActionData>({
      intent,
      ok: true,
      section: key,
      toast: `${def.title} settings saved`,
    });
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Client-side field state ──────────────────────────────────────────────────

type SectionState = Record<string, string | boolean>;

function initialSectionState(def: SectionDef, value: unknown): SectionState {
  const state: SectionState = {};
  for (const field of def.fields) {
    const raw = getPath(value, field.path);
    if (field.type === "toggle") {
      state[field.path] = Boolean(raw);
    } else if (field.type === "intList" || field.type === "stringList") {
      state[field.path] = Array.isArray(raw) ? raw.join(", ") : "";
    } else {
      state[field.path] = raw == null ? "" : String(raw);
    }
  }
  return state;
}

function parseIntListClient(text: string): number[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

function errorFor(
  errors: Record<string, string>,
  path: string,
): string | undefined {
  if (errors[path]) return errors[path];
  const nested = Object.keys(errors).find((k) => k.startsWith(`${path}.`));
  return nested ? `${errors[nested]} (entry ${nested.slice(path.length + 1)})` : undefined;
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldDef;
  value: string | boolean;
  error?: string;
  onChange: (next: string | boolean) => void;
}) {
  if (field.type === "toggle") {
    return (
      <Checkbox
        label={field.label}
        checked={Boolean(value)}
        onChange={(checked) => onChange(checked)}
        helpText={field.helpText}
      />
    );
  }
  if (field.type === "select") {
    return (
      <Select
        label={field.label}
        options={field.options ?? []}
        value={String(value)}
        onChange={(next) => onChange(next)}
        helpText={field.helpText}
        error={error}
      />
    );
  }
  const numeric = field.type === "int" || field.type === "float";
  return (
    <TextField
      label={field.label}
      autoComplete="off"
      type={numeric ? "number" : "text"}
      min={numeric ? field.min : undefined}
      max={numeric ? field.max : undefined}
      step={numeric ? (field.step ?? (field.type === "float" ? 0.01 : 1)) : undefined}
      suffix={field.suffix}
      value={String(value)}
      onChange={(next) => onChange(next)}
      helpText={field.helpText}
      error={error}
    />
  );
}

// ── Preview strips ───────────────────────────────────────────────────────────

function DunningLadderPreview({ state }: { state: SectionState }) {
  const retries = parseIntListClient(String(state["softRetryDays"] ?? ""));
  const emails = parseIntListClient(String(state["emailLadderDays"] ?? ""));
  const smsDay = Number(String(state["smsDay"] ?? ""));
  const events = new Map<number, string[]>();
  const push = (day: number, label: string) => {
    const list = events.get(day) ?? [];
    list.push(label);
    events.set(day, list);
  };
  for (const day of retries) push(day, "Retry");
  for (const day of emails) push(day, "Email");
  if (Number.isFinite(smsDay)) push(smsDay, "SMS");
  const days = [...events.keys()].sort((a, b) => a - b);

  return (
    <Box
      background="bg-surface-secondary"
      borderRadius="200"
      padding="300"
    >
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" fontWeight="medium">
          Ladder preview (days from first failure)
        </Text>
        <InlineStack gap="200" wrap>
          {days.map((day) => (
            <Box
              key={day}
              background="bg-surface"
              borderColor="border"
              borderWidth="025"
              borderRadius="200"
              padding="200"
            >
              <BlockStack gap="100" inlineAlign="center">
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {`Day ${day}`}
                </Text>
                <InlineStack gap="100">
                  {(events.get(day) ?? []).map((label, i) => (
                    <Badge
                      key={`${day}-${label}-${i}`}
                      tone={
                        label === "Retry"
                          ? "attention"
                          : label === "SMS"
                            ? "warning"
                            : "info"
                      }
                    >
                      {label}
                    </Badge>
                  ))}
                </InlineStack>
              </BlockStack>
            </Box>
          ))}
        </InlineStack>
        <Text as="p" tone="subdued" variant="bodySm">
          {state["paydayAlign"]
            ? `Retries snap forward up to ${String(state["paydaySnapWindowDays"] ?? "0")} day(s) to reach a payday (${String(state["paydaysOfMonth"] ?? "")}).`
            : "Payday alignment is off — retries run exactly on the offsets above."}
        </Text>
      </BlockStack>
    </Box>
  );
}

function CostModelPreview({
  state,
  currencyCode,
}: {
  state: SectionState;
  currencyCode: string;
}) {
  const money = (cents: number): string => {
    try {
      return new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
      }).format(cents / 100);
    } catch {
      return `${(cents / 100).toFixed(2)} ${currencyCode}`;
    }
  };

  const feePct = Number(String(state["paymentFeePct"] ?? "0")) || 0;
  const feeFixed = Number(String(state["paymentFeeFixedCents"] ?? "0")) || 0;
  const fulfillment =
    Number(String(state["fulfillmentCostPerShipmentCents"] ?? "0")) || 0;
  const shippingMode = String(state["shippingCostPerShipmentCents.mode"] ?? "flat");
  const shippingFlat =
    Number(String(state["shippingCostPerShipmentCents.flatCents"] ?? "0")) || 0;
  const fallbackPct = Number(String(state["cogsFallbackPctOfPrice"] ?? "0")) || 0;

  // Worked example: one CHF 89.00 renewal with product cost CHF 24.00 known.
  const exampleRevenue = 8900;
  const exampleCogs = 2400;
  const fees = Math.round((exampleRevenue * feePct) / 100) + feeFixed;
  const shipping = shippingMode === "charged" ? 0 : shippingFlat;
  const perShipment = fulfillment + shipping;
  const profit = exampleRevenue - exampleCogs - perShipment - fees;

  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="300">
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" fontWeight="medium">
          Worked example — one {money(exampleRevenue)} renewal, product cost{" "}
          {money(exampleCogs)}
        </Text>
        <Text as="p" variant="bodySm">
          {`Gross profit = ${money(exampleRevenue)} collected − ${money(exampleCogs)} product cost − ${money(perShipment)} fulfillment & shipping${
            shippingMode === "charged"
              ? " (shipping ≈ what the customer paid; 0 in this free-shipping example)"
              : ""
          } − ${money(fees)} payment fees = `}
          <Text as="span" fontWeight="semibold">
            {money(profit)}
          </Text>
          {" per cycle."}
        </Text>
        <Text as="p" tone="subdued" variant="bodySm">
          {`LTGP accumulates this per subscriber, month by month, net of refunds. Products with no known cost are estimated at ${fallbackPct}% of price and flagged in the analytics as estimated.`}
        </Text>
      </BlockStack>
    </Box>
  );
}

function WinbackTimelinePreview({ state }: { state: SectionState }) {
  const entries: Array<{ day: number; label: string }> = [
    {
      day: Number(String(state["softTouchOffsetDays"] ?? "0")),
      label: "Soft touch",
    },
    { day: 0, label: "Predicted empty" },
    { day: Number(String(state["perkOffsetDays"] ?? "0")), label: "Perk" },
    {
      day: Number(String(state["discountOffsetDays"] ?? "0")),
      label: `Discount ${String(state["discountPct"] ?? "")}% × ${String(state["discountCycles"] ?? "")}`,
    },
    { day: Number(String(state["sunsetOffsetDays"] ?? "0")), label: "Sunset" },
  ]
    .filter((e) => Number.isFinite(e.day))
    .sort((a, b) => a.day - b.day);

  return (
    <Box background="bg-surface-secondary" borderRadius="200" padding="300">
      <BlockStack gap="200">
        <Text as="p" variant="bodySm" fontWeight="medium">
          Timeline preview (days relative to predicted empty date)
        </Text>
        <InlineStack gap="200" wrap>
          {entries.map((entry, i) => (
            <Box
              key={`${entry.label}-${i}`}
              background="bg-surface"
              borderColor="border"
              borderWidth="025"
              borderRadius="200"
              padding="200"
            >
              <BlockStack gap="050" inlineAlign="center">
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {entry.day > 0 ? `+${entry.day}d` : `${entry.day}d`}
                </Text>
                <Text as="span" variant="bodySm" tone="subdued">
                  {entry.label}
                </Text>
              </BlockStack>
            </Box>
          ))}
        </InlineStack>
      </BlockStack>
    </Box>
  );
}

// ── Section card ─────────────────────────────────────────────────────────────

function SettingsSection({
  def,
  initialValue,
  errors,
  saving,
  onSave,
  preview,
}: {
  def: SectionDef;
  initialValue: unknown;
  errors: Record<string, string>;
  saving: boolean;
  onSave: (def: SectionDef, state: SectionState) => void;
  preview?: (state: SectionState) => ReactNode;
}) {
  const [state, setState] = useState<SectionState>(() =>
    initialSectionState(def, initialValue),
  );

  const setField = (path: string, value: string | boolean) =>
    setState((prev) => ({ ...prev, [path]: value }));

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            {def.title}
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            {def.description}
          </Text>
        </BlockStack>
        <Divider />
        <BlockStack gap="300">
          {def.fields.map((field) => (
            <FieldInput
              key={field.path}
              field={field}
              value={state[field.path] ?? ""}
              error={errorFor(errors, field.path)}
              onChange={(next) => setField(field.path, next)}
            />
          ))}
        </BlockStack>
        {preview ? preview(state) : null}
        <InlineStack align="end">
          <Button
            variant="primary"
            loading={saving}
            onClick={() => onSave(def, state)}
          >
            {`Save ${def.title.toLowerCase()}`}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { settings, currencyCode } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
  }, [actionData, shopify]);

  const savingSection =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save-section"
      ? String(navigation.formData.get("section") ?? "")
      : null;

  const handleSave = (def: SectionDef, state: SectionState) => {
    const fd = new FormData();
    fd.set("intent", "save-section");
    fd.set("section", def.key);
    for (const field of def.fields) {
      const value = state[field.path];
      fd.set(
        `f_${field.path}`,
        field.type === "toggle" ? String(Boolean(value)) : String(value ?? ""),
      );
    }
    submit(fd, { method: "post" });
  };

  const settingsRecord = settings as Record<string, unknown>;

  return (
    <Page
      title="Settings"
      subtitle="Every operational behaviour is a setting, not an accident. Each save is validated and logged."
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued" variant="bodySm">
              Looking for the cancel-save flow? It has its own page:{" "}
              <Link url="/app/cancel-flow">Cancel flow</Link>.
            </Text>
            {SECTION_DEFS.map((def) => (
              <SettingsSection
                key={def.key}
                def={def}
                initialValue={settingsRecord[def.key]}
                errors={
                  actionData &&
                  !actionData.ok &&
                  actionData.section === def.key
                    ? (actionData.errors ?? {})
                    : {}
                }
                saving={savingSection === def.key}
                onSave={handleSave}
                preview={
                  def.key === "dunning"
                    ? (state) => <DunningLadderPreview state={state} />
                    : def.key === "winback"
                      ? (state) => <WinbackTimelinePreview state={state} />
                      : def.key === "costModel"
                        ? (state) => (
                            <CostModelPreview
                              state={state}
                              currencyCode={currencyCode}
                            />
                          )
                        : undefined
                }
              />
            ))}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
