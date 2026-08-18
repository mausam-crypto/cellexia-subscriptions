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
import {
  decodeCountryRates,
  encodeCountryRates,
} from "~/lib/settings/country-rates";
import { logEvent } from "~/lib/events/log.server";
import { verifyMailer } from "~/lib/notifications/mailer.server";
import {
  probeKlaviyoKey,
  resolveKlaviyoAuth,
} from "~/lib/klaviyo/client.server";
import { encryptSecret } from "~/lib/crypto/secrets.server";

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
  | "stringList"
  /**
   * Record of ISO country code → percentage, edited as "CH:8.1, DE:19".
   * Encoded/decoded by encodeCountryRates/decodeCountryRates; malformed
   * entries survive coercion verbatim so the zod schema rejects them with a
   * per-entry message instead of being silently dropped.
   */
  | "countryRates"
  /**
   * Write-only credential. The loader never ships the stored value (only a
   * "where does the effective value come from" hint); a blank submit keeps
   * what is stored, the clear checkbox removes it, and a typed value is
   * encrypted before it touches the Setting table or the audit log.
   */
  | "secret";

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
      {
        path: "customerRetryCooldownMinutes",
        label: "Customer “Retry now” cooldown (minutes)",
        helpText:
          "How long a subscriber must wait between two self-service payment retries (portal, email link, SMS RETRY). Each retry is a real charge attempt.",
        type: "int",
        min: 5,
        max: 1440,
      },
      {
        path: "postExhaustionTouchDays",
        label: "Post-exhaustion touches (days after the last retry)",
        helpText:
          "Comma-separated, e.g. 7, 21. After the retry ladder is exhausted, a subscription on hold gets a “fix your payment” nudge on each of these days. Empty = none.",
        type: "intList",
      },
      {
        path: "newMethodDetection",
        label: "Notice a new card on the account",
        helpText:
          "When a subscriber in payment trouble (held payment, removed or expiring card) saves a new payment method on their account, tell them it can be used for the subscription in one tap.",
        type: "toggle",
      },
      {
        path: "newMethodAutoSwitch",
        label: "Move to the new card automatically",
        helpText:
          "When the subscription's own card has been removed or has expired and a new method appears, switch to it right away and confirm by email — otherwise the subscriber is only asked.",
        type: "toggle",
      },
    ],
  },
  {
    key: "billing",
    title: "Billing timing",
    description:
      "When renewals are charged. The same instant is the customer's edit cut-off everywhere (portal, reminder emails).",
    fields: [
      {
        path: "chargeHourLocal",
        label: "Charge hour (shop time)",
        helpText:
          "Hour of the shop day when renewals are charged; customers can make changes until that moment — with 0 (the previous behaviour, first run after midnight) changes close at the end of the previous day. A later hour gives customers who read the reminder in the morning a real window to skip or edit before the charge. Careful when LOWERING it during the day: renewals due today are billed at the next run, before the cut-off already shown in reminder emails and the portal — lower it at the end of the shop day (or right after the current hour has passed).",
        type: "int",
        min: 0,
        max: 23,
      },
      {
        path: "preparingWindowHours",
        label: "\"Preparing your order\" window (hours)",
        helpText:
          "How long after the charge hour an unbilled renewal that no charge attempt has claimed yet still shows as being prepared (skip / delay / date / frequency closed). After that the controls come back so a renewal billing cannot process never locks the customer out; the stuck-contract alert flags such cases.",
        type: "int",
        min: 1,
        max: 72,
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
        path: "friendlyLockMessaging",
        label: "Friendly commitment-period messaging",
        helpText:
          "On by default. While a plan's lock window runs, the portal shows a warm “welcome period” progress card (day X of Y, what stays available) instead of a plain restriction notice, and the blocked-action toast, email-link page and SMS reply use matching reassuring copy with the unlock date. The lock itself is unchanged either way. The friendly copy says the customer's welcome price is being protected — if you set a lock window on a plan with no intro offer, turn this off.",
        type: "toggle",
      },
      {
        path: "routineGuideUrl",
        label: "Routine guide URL",
        helpText:
          "Store page with the routine guide, e.g. /pages/routine-guide or a full https:// link. Shown in the portal's routine card and as the cancel flow's “Read the routine guide” button. Blank hides it.",
        type: "text",
      },
      {
        path: "howToUseUrl",
        label: "How-to-use URL",
        helpText:
          "Page explaining how to use the products (usage, order, frequency). Shown as “How to use {product}” on each subscription page. Blank hides it.",
        type: "text",
      },
      {
        path: "faqUrl",
        label: "FAQ URL",
        helpText:
          "Your subscription FAQ page. Blank hides the FAQ link; when all three URLs are blank the routine card is not shown at all.",
        type: "text",
      },
      {
        path: "delayReanchors",
        label: "Delay moves the whole schedule",
        helpText:
          "When a customer delays, move the whole schedule (on) or only the next order (off). On: the delayed date becomes the anchor every later order follows. Off: one late delivery, then the original rhythm resumes.",
        type: "toggle",
      },
      {
        path: "perLineCycleEdits",
        label: "Per-product “Not this time” and “Just this order” quantity",
        helpText:
          "On: each recurring product on the subscription page gets a “Not this time” link (skip only that product from the next order) and a one-order quantity tweak next to the permanent quantity. Off: only whole-order skip and permanent quantity changes are offered.",
        type: "toggle",
      },
      {
        path: "dunningBannerEventHours",
        label: "Payment-issue banner event window (hours)",
        helpText:
          "The portal logs one “payment issue banner shown” event per dunning case per this many hours — a measurement window, not a display setting.",
        type: "int",
        min: 1,
        max: 168,
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
      {
        path: "deliveryInstructionsMaxChars",
        label: "Delivery instructions max length",
        helpText:
          "Longest delivery note a subscriber can save (50–1000 characters). It is written to the Shopify contract note and copied onto every renewal order for your fulfilment team.",
        type: "int",
        min: 50,
        max: 1000,
      },
      {
        path: "pauseExtendChoicesWeeks",
        label: "Pause extension choices (weeks)",
        helpText:
          "Comma-separated, e.g. 2, 4. The “need a little longer?” options offered in the resume reminder and on a paused subscription. Each is still capped by the maximum pause.",
        type: "intList",
      },
      {
        path: "deliveriesProcessingMaxDays",
        label: "Deliveries: “being prepared” window (days)",
        helpText:
          "In “Your deliveries”, a charged order with no shipment mirrored for longer than this reads “see the order page” instead of “being prepared” — the app will not claim an old order is still in preparation.",
        type: "int",
        min: 3,
        max: 120,
      },
      {
        path: "deliveriesInTransitMaxDays",
        label: "Deliveries: “on its way” window (days)",
        helpText:
          "The “Your order is on its way — Track” banner and the home-card line show only while the newest shipped order is at most this many days past shipping and has no delivered signal.",
        type: "int",
        min: 2,
        max: 60,
      },
      {
        path: "paymentMethodsList",
        label: "List the customer's other payment methods",
        helpText:
          "On: the subscription page lists the other cards saved on the customer's Shopify account with “Use for this subscription” and “Set as backup”, and the second/third payment-failed emails offer “Use my card ····1234 instead” links when at least two methods exist. Off: only the single-card update path is offered.",
        type: "toggle",
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
        path: "welcomeHealMaxDays",
        label: "Late welcome window (days)",
        helpText:
          "A brand-new subscription is sometimes proven ours only a little after checkout (the mirror first lands as \"not proven ours\", so the welcome email is held back). If ownership resolves within this many days of the subscription's creation, the welcome email is still sent; older subscriptions are never welcomed late. 0 turns the late send off.",
        type: "int",
        min: 0,
        max: 30,
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
    key: "tagging",
    title: "Shopify tags",
    description:
      "Mirror subscription state onto Shopify tags — the hook for theme logic, Shopify Flow, segments and other apps. Saving this card starts a background re-apply of the customer tag across the whole subscriber base (a summary lands in the Audit log), so a rename or a late enable doesn't wait for the nightly pass.",
    fields: [
      {
        path: "customerTagEnabled",
        label: "Tag subscribers",
        helpText:
          "Tag the customer while they have a live subscription; the tag is removed automatically when their last subscription ends (cancelled, expired or payment-failed). Turning this off stops tag management — tags already applied stay.",
        type: "toggle",
      },
      {
        path: "customerTag",
        label: "Subscriber tag",
        helpText:
          "Renaming swaps the tag on current subscribers when you save. No commas — Shopify treats them as tag separators.",
        type: "text",
      },
      {
        path: "orderTagsEnabled",
        label: "Tag subscription orders",
        helpText:
          "Tag each subscription order as it is created — the checkout order and every renewal. Applied going forward only; past orders keep whatever they have.",
        type: "toggle",
      },
      {
        path: "firstOrderTag",
        label: "First-order tag",
        helpText: "Applied to the checkout order that started the subscription.",
        type: "text",
      },
      {
        path: "repeatOrderTag",
        label: "Repeat-order tag",
        helpText: "Applied to every renewal order billed by the app.",
        type: "text",
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
      {
        path: "milestoneLadder",
        label: "Milestone ladder (order numbers)",
        helpText:
          "Milestones AFTER the base milestone, e.g. 12, 18, 24 — the goal-gradient hook never exhausts. Each rung ships a dynamically picked gift from the pool (Gifts page) and is announced in advance.",
        type: "intList",
      },
      {
        path: "rewardsGiftEnabled",
        label: "Real gift with the rewards unlock",
        helpText:
          "Puts a dynamically picked free product behind the day-90 'rewards unlocked' email — without it the email is copy with nothing behind it.",
        type: "toggle",
      },
      {
        path: "resultsTimeline.enabled",
        label: "Results timeline content",
        helpText:
          "The phase content behind “Week N of your routine” on the portal, the cancel flow's education save and the week-N check-in email. Off: none of the three shows timeline copy. The Portal growth → results timeline toggle switches the same three surfaces off too (and records no experiment exposure while off).",
        type: "toggle",
      },
      {
        path: "resultsTimeline.checkinWeek",
        label: "Check-in email week",
        helpText:
          "The routine week the one-time “how is it going?” email goes out (default 4 — the last week of phase 1, so the email leads with the getting-started copy and points to phase 2 “from week 5”; set 5 to lead with phase 2). One tap answers Great / Not sure yet and lands on the subscription page.",
        type: "int",
        min: 1,
        max: 52,
      },
      {
        path: "resultsTimeline.expectationLine",
        label: "Expectation line from the survey",
        helpText:
          "When the customer's post-purchase survey said they hoped to see something within days / weeks / a month or two, the timeline card, the check-in email and the cancel flow's education copy add one sentence naming the routine's real horizon (“week N is right on track”). Generic wording, no claims; never shown to the survey holdout group.",
        type: "toggle",
      },
      {
        path: "resultsTimeline.phases.0.fromWeek",
        label: "Phase 1 (getting started) — starts after week",
        helpText:
          "Routine weeks completed when this phase begins (0 = from day one). Must increase phase to phase.",
        type: "int",
        min: 0,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.0.toWeek",
        label: "Phase 1 (getting started) — ends at week",
        helpText:
          "Shown for reference — derived from the next phase's “starts after week” on save (empty on the last, open-ended phase). Move a boundary by editing the next phase's start week.",
        type: "int",
        min: 1,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.0.title",
        label: "Phase 1 (getting started) — title",
        helpText:
          "Leave empty to use the built-in translated title.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.0.body",
        label: "Phase 1 (getting started) — text",
        helpText:
          "Leave empty for the built-in translated text (generic, no claims). Whatever you write here is shown verbatim in every language — keep it honest: 'many people notice…', never a medical or efficacy claim.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.1.fromWeek",
        label: "Phase 2 (settling in) — starts after week",
        helpText:
          "Routine weeks completed when this phase begins (0 = from day one). Must increase phase to phase.",
        type: "int",
        min: 0,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.1.toWeek",
        label: "Phase 2 (settling in) — ends at week",
        helpText:
          "Shown for reference — derived from the next phase's “starts after week” on save (empty on the last, open-ended phase). Move a boundary by editing the next phase's start week.",
        type: "int",
        min: 1,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.1.title",
        label: "Phase 2 (settling in) — title",
        helpText:
          "Leave empty to use the built-in translated title.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.1.body",
        label: "Phase 2 (settling in) — text",
        helpText:
          "Leave empty for the built-in translated text (generic, no claims). Whatever you write here is shown verbatim in every language — keep it honest: 'many people notice…', never a medical or efficacy claim.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.2.fromWeek",
        label: "Phase 3 (noticing) — starts after week",
        helpText:
          "Routine weeks completed when this phase begins (0 = from day one). Must increase phase to phase.",
        type: "int",
        min: 0,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.2.toWeek",
        label: "Phase 3 (noticing) — ends at week",
        helpText:
          "Shown for reference — derived from the next phase's “starts after week” on save (empty on the last, open-ended phase). Move a boundary by editing the next phase's start week.",
        type: "int",
        min: 1,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.2.title",
        label: "Phase 3 (noticing) — title",
        helpText:
          "Leave empty to use the built-in translated title.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.2.body",
        label: "Phase 3 (noticing) — text",
        helpText:
          "Leave empty for the built-in translated text (generic, no claims). Whatever you write here is shown verbatim in every language — keep it honest: 'many people notice…', never a medical or efficacy claim.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.3.fromWeek",
        label: "Phase 4 (part of the routine) — starts after week",
        helpText:
          "Routine weeks completed when this phase begins (0 = from day one). Must increase phase to phase.",
        type: "int",
        min: 0,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.3.toWeek",
        label: "Phase 4 (part of the routine) — ends at week",
        helpText:
          "Shown for reference — derived from the next phase's “starts after week” on save (empty on the last, open-ended phase). Move a boundary by editing the next phase's start week.",
        type: "int",
        min: 1,
        max: 520,
      },
      {
        path: "resultsTimeline.phases.3.title",
        label: "Phase 4 (part of the routine) — title",
        helpText:
          "Leave empty to use the built-in translated title.",
        type: "text",
      },
      {
        path: "resultsTimeline.phases.3.body",
        label: "Phase 4 (part of the routine) — text",
        helpText:
          "Leave empty for the built-in translated text (generic, no claims). Whatever you write here is shown verbatim in every language — keep it honest: 'many people notice…', never a medical or efficacy claim.",
        type: "text",
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
      {
        path: "restartLinkTtlDays",
        label: "One-tap restart link lifetime (days)",
        helpText:
          "The signed 'restart my subscription' link in the cancellation confirmation and the soft-touch email stays valid this long (single use; it applies whatever win-back offer is current when tapped).",
        type: "int",
        min: 1,
        max: 365,
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
      {
        path: "vat.enabled",
        label: "Subtract VAT / sales tax from gross profit",
        helpText:
          "On by default. Analytics subtract VAT as a flat percentage of each charge — the country rate below (or the default rate) times the charged amount, like any other expense. Reporting only — billing and checkout taxes are untouched. The cohort history recomputes nightly with VAT included; closed daily-rollup days keep their pre-VAT figures.",
        type: "toggle",
      },
      {
        path: "vat.defaultRatePct",
        label: "Default VAT rate",
        helpText:
          "Applied when a charge's country has no rate below (or the country is unknown). VAT is a straight percentage of revenue — a 20% rate on a £100.00 charge subtracts £20.00.",
        type: "float",
        min: 0,
        max: 50,
        step: 0.1,
        suffix: "%",
      },
      {
        path: "vat.countryRatesPct",
        label: "VAT rates by country",
        helpText:
          "Comma-separated ISO country code : rate pairs, e.g. \"CH:8.1, DE:19, FR:20\". The charge's country comes from the subscription's delivery address (falling back to the first order's shipping country); countries not listed use the default rate above.",
        type: "countryRates",
      },
    ],
  },
  {
    key: "portalGrowth",
    title: "Portal growth",
    description:
      "Behavioral-design levers on the customer portal — each reframes or reorders existing controls to grow lifetime gross profit; none removes a customer capability (skip, delay, pause and cancel always stay within two taps).",
    fields: [
      {
        path: "homeValueCard",
        label: "Value-first subscription cards",
        helpText:
          "The subscriptions list leads with member value (real captured savings, milestone proximity) and an add-products button instead of one-tap skip/delay — a skip button on every visit is an advertisement for skipping. Skip and delay stay on the Manage page.",
        type: "toggle",
      },
      {
        path: "addonUpsell",
        label: "Add-a-product emphasis",
        helpText:
          "Opens the add-a-product section expanded, leads with the one-time “try it in the next delivery” (low commitment converts, and a used trial sells itself), frames add-ons as riding a delivery that is already coming, and badges genuinely popular add-ons (real add counts, never invented).",
        type: "toggle",
      },
      {
        path: "postActionUpsell",
        label: "Post-action add-on offer",
        helpText:
          "After a positive action (unskip, resume, address update) the success moment offers one add-on at the member price — never after a skip.",
        type: "toggle",
      },
      {
        path: "concessionLadder",
        label: "Skip alternatives ladder",
        helpText:
          "The schedule card orders the quick actions: delay first (nothing is lost), the plan's next-slower cadence second (keeps price and rewards), skip last — still one tap, with its concrete consequence date. Converts skip intent into cheaper concessions without hiding anything.",
        type: "toggle",
      },
      {
        path: "cadenceNudge",
        label: "Repeated-skip cadence suggestion",
        helpText:
          "Two or more skips in the last 120 days suggests the plan's next-slower delivery cadence — a cadence mismatch fixed beats repeated skips and the cancellation they often precede.",
        type: "toggle",
      },
      {
        path: "runoutPrompt",
        label: "Running-out prompt",
        helpText:
          "When the churn model predicts the customer runs out BEFORE the next delivery, offer to move it up or add one more unit — the inverse of the standing “running low later?” prompt. Once the predicted-empty day has passed, the same prompt offers to send the next order tomorrow.",
        type: "toggle",
      },
      {
        path: "supplyMeter",
        label: "Days-of-supply meter",
        helpText:
          "Shows “about N days of product left” on the subscription page from the churn model's predicted-empty date — labelled as an estimate. Hidden when there is no prediction.",
        type: "toggle",
      },
      {
        path: "resultsTimeline",
        label: "“Week N of your routine” card",
        helpText:
          "Progress card on the subscription page (and a line on the home card) with the phase copy for the customer's routine week — content from Lifecycle → results timeline. Off switches the whole surface set off: the card, the week-N check-in email and the cancel flow's phase-aware education copy (no experiment exposure is recorded while off). Also the results_timeline experiment's decision point: the holdout group never sees it, so its retention effect stays measurable (Experiments page).",
        type: "toggle",
      },
      {
        path: "rewardsRoadmap",
        label: "Rewards roadmap",
        helpText:
          "Turns the home rewards strip into the full ladder — every milestone order and the rewards unlock with a projected “around {date}” — plus deliveries-so-far and gifts-received tiles. Names a gift only when the pick is fixed and committed; otherwise “a free product”. Off: the classic three-tile strip.",
        type: "toggle",
      },
      {
        path: "onboardingCard",
        label: "First-cycle “What happens next” card",
        helpText:
          "Shown on the subscription page until the second order has billed: first order date/status, next order date and change cut-off, how to make changes, and the routine guide links.",
        type: "toggle",
      },
      {
        path: "deliveriesList",
        label: "“Your deliveries” (Account tab, subscription page, on-its-way banner)",
        helpText:
          "Lists the customer's subscription orders from the app's own order mirror (last 10 on the Account tab, last 5 on the subscription page) — date, order number, amount, shipped/delivered status and Track / View order links to Shopify's order-status page (which also carries the receipt) — plus the “Your order is on its way — Track” banner and the home-card line while a parcel is in transit. Needs the fulfillment webhooks deployed to show tracking.",
        type: "toggle",
      },
    ],
  },
  {
    key: "analytics",
    title: "Analytics data",
    description:
      "Accuracy options applied to every analytics view — revenue, gross profit, LTGP, cohorts, forecasts and segment views. All figures are reported in the store currency.",
    fields: [
      {
        path: "excludeRefundedPayments",
        label: "Exclude refunded payments",
        helpText:
          "On by default. Payments with ANY refund — full or partial — are removed from the analytics entirely, revenue and costs alike (a refunded rebill is usually a surprise renewal that got cancelled: noise, not revenue). Turn off to instead net refunds against revenue while keeping the payment's costs. Saving recomputes the cohort history AND rewrites every refund-affected day of the daily ledger under the new mode immediately; the nightly job keeps repairing new refunds' charge days within its 90-day window.",
        type: "toggle",
      },
    ],
  },
  {
    key: "survey",
    title: "Post-purchase survey",
    description:
      "The four-question survey new subscribers answer on the order confirmation page. Answers attach to the subscription, feed the churn-risk score and the predicted-LTGP forecast, and route onboarding flows in Klaviyo.",
    fields: [
      {
        path: "enabled",
        label: "Show the survey",
        helpText:
          "On by default. Off stops the survey from rendering and refuses new answers; answers already collected are kept and keep feeding analytics.",
        type: "toggle",
      },
      {
        path: "holdoutPct",
        label: "Intervention holdout",
        helpText:
          "Percentage of surveyed subscribers deterministically held out of survey-triggered Klaviyo flows (the survey_holdout event property is true for them — filter them out in the flow). Without this untreated comparison group you cannot tell whether answer-triggered flows save customers or those customers would have stayed anyway. Changing it only affects future subscribers; assigned holdouts are never reshuffled.",
        type: "float",
        min: 0,
        max: 50,
        suffix: "%",
      },
      {
        path: "writesPerHour",
        label: "Write rate cap",
        helpText:
          "Abuse ceiling on survey submissions per hour across the whole store. The default is far above any real order volume — raise it only if a promotion makes legitimate submissions hit the cap (the audit log shows refusals).",
        type: "int",
        min: 100,
        max: 20000,
        suffix: "/hour",
      },
    ],
  },
  {
    key: "support",
    title: "Support channels",
    description:
      "Where customers reach a human — the portal's Get-help card (Account, every subscription page, the payment-issue banner), the cancel-flow support cards and the Reply-To of every email the app sends. Empty channels are hidden, never shown as dead links. Requests submitted through the form land as a SUPPORT_REQUEST alert, a Klaviyo “Cellexia Support Requested” event and (when an email is set) a message to that inbox.",
    fields: [
      {
        path: "email",
        label: "Support email",
        helpText:
          "Blank = the store's contact email from Shopify. Also the default Reply-To for every email the app sends itself, so a customer who hits Reply reaches you. Klaviyo-delivered flows take the Reply-To only when the app creates them — for flows that already exist, change the sender in Klaviyo (or delete and recreate the flow from the guided setup).",
        type: "text",
      },
      {
        path: "replyTo",
        label: "Reply-To override",
        helpText:
          "Only if replies should land somewhere other than the support email (e.g. a helpdesk intake address). Blank = the support email. Same Klaviyo caveat as above: applies to flows the app creates after you set it.",
        type: "text",
      },
      {
        path: "whatsapp",
        label: "WhatsApp number",
        helpText:
          "International format, e.g. +41791234567. Blank hides the WhatsApp button.",
        type: "text",
      },
      {
        path: "chatUrl",
        label: "Live chat URL",
        helpText:
          "https:// link that opens your chat (Gorgias, Crisp, Intercom…). Blank hides the chat button.",
        type: "text",
      },
      {
        path: "hoursNote",
        label: "Hours note",
        helpText:
          "Shown under the channels, e.g. “Mon–Fri 9:00–17:00 CET”. Free text; blank hides it.",
        type: "text",
      },
      {
        path: "slaBusinessDays",
        label: "Reply promise (business days)",
        helpText:
          "The confirmation says “we'll get back to you within N business day(s)”. Set only what the team keeps.",
        type: "int",
        min: 1,
        max: 30,
      },
      {
        path: "requestsPerHour",
        label: "Requests per hour",
        helpText:
          "Get-help submits accepted per customer per rolling hour (spam guard). The general portal limit still applies on top.",
        type: "int",
        min: 1,
        max: 50,
        suffix: "/hour",
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
  {
    key: "mailTransport",
    title: "Email delivery (SMTP)",
    description:
      "Direct transactional email — OTP login codes, 3DS confirmation links and admin alerts ride this transport alone, even with Klaviyo connected. Values saved here override the server environment variables; blank fields fall back to them. Changes apply on the next email sent — no restart needed.",
    fields: [
      {
        path: "provider",
        label: "Transport",
        helpText:
          "“Use environment variables” keeps the server-configured (MAIL_PROVIDER) behavior. Console only logs emails to the server output — in production that means nobody receives OTP codes or payment-recovery mail.",
        type: "select",
        options: [
          { label: "Use environment variables (default)", value: "" },
          { label: "SMTP", value: "smtp" },
          { label: "Console — log only, no delivery", value: "console" },
        ],
      },
      {
        path: "from",
        label: "From address",
        helpText:
          "e.g. “Cellexia <care@your-store-domain.com>” — use a domain your SMTP provider is verified to send for (SPF/DKIM). Blank = the MAIL_FROM environment variable, then the support email.",
        type: "text",
      },
      {
        path: "smtpHost",
        label: "SMTP host",
        helpText:
          "e.g. smtp.postmarkapp.com. Blank = the SMTP_HOST environment variable.",
        type: "text",
      },
      {
        path: "smtpPort",
        label: "SMTP port",
        helpText:
          "587 for STARTTLS, 465 for implicit TLS. 0 = the SMTP_PORT environment variable (default 587).",
        type: "int",
        min: 0,
        max: 65535,
      },
      {
        path: "smtpUser",
        label: "SMTP username",
        helpText: "Blank = the SMTP_USER environment variable.",
        type: "text",
      },
      {
        path: "smtpPass",
        label: "SMTP password",
        helpText:
          "Stored encrypted; never displayed again. Leave blank to keep the saved value. With nothing saved, the SMTP_PASS environment variable applies.",
        type: "secret",
      },
      {
        path: "smtpSecure",
        label: "TLS mode",
        helpText:
          "Auto: implicit TLS on port 465, STARTTLS otherwise (or whatever the SMTP_SECURE environment variable says).",
        type: "select",
        options: [
          { label: "Auto", value: "auto" },
          { label: "Always (implicit TLS)", value: "always" },
          { label: "Never (STARTTLS / plain)", value: "never" },
        ],
      },
    ],
  },
  {
    key: "klaviyo",
    title: "Klaviyo connection",
    description:
      "Server-side connection for lifecycle flows — Klaviyo owns delivery, branding and timing (docs/KLAVIYO_SETUP.md). Queued events start flushing on the next scheduler tick after a key is saved (a minute on standard installs); events older than 24 hours are dropped, never fired late. Without a key, lifecycle email falls back to direct SMTP and SMS is not sent.",
    fields: [
      {
        path: "privateApiKey",
        label: "Private API key",
        helpText:
          "pk_… private key with the Events: Full scope (Klaviyo → Account → Settings → API keys). Stored encrypted; never displayed again. Leave blank to keep the saved value; with nothing saved, the KLAVIYO_PRIVATE_API_KEY environment variable applies. Use “Test key” before saving — a wrong key kills queued events within a minute.",
        type: "secret",
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

  // Secret fields are write-only: the stored blobs (even encrypted) never
  // reach the browser. The UI only learns where the EFFECTIVE value comes
  // from, to phrase its placeholder and offer the clear checkbox.
  const secretsState: Record<string, "settings" | "env" | "none"> = {
    "mailTransport.smtpPass": settings.mailTransport.smtpPass
      ? "settings"
      : process.env.SMTP_PASS
        ? "env"
        : "none",
    "klaviyo.privateApiKey": settings.klaviyo.privateApiKey
      ? "settings"
      : process.env.KLAVIYO_PRIVATE_API_KEY
        ? "env"
        : "none",
  };
  settings.mailTransport = { ...settings.mailTransport, smtpPass: "" };
  settings.klaviyo = { ...settings.klaviyo, privateApiKey: "" };

  return json({ settings, currencyCode: shop.currencyCode, secretsState });
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
    case "countryRates":
      return decodeCountryRates(text);
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
    const secretFields = def.fields.filter((f) => f.type === "secret");

    // Read the outgoing value BEFORE the write so the audit event carries
    // both sides of the change — `value` alone said what the settings became
    // but never what they were, so the event log could not answer "who
    // changed the dunning ladder and from what" without replaying every save.
    // Sections with secret fields also need it before PARSING: a blank secret
    // submit means "keep what is stored".
    const previous = await getSetting(shop.id, key);

    const candidate: Record<string, unknown> = {};
    for (const field of def.fields) {
      if (field.type === "secret") continue;
      const raw = formData.get(`f_${field.path}`);
      setPath(
        candidate,
        field.path,
        coerceField(field, typeof raw === "string" ? raw : null),
      );
    }
    // Secret merge: typed value → encrypted; blank → keep stored; clear
    // checkbox → "". The markers (never the values) go into the audit event.
    const secretAudit: Record<string, { previous: string; value: string }> = {};
    for (const field of secretFields) {
      const raw = formData.get(`f_${field.path}`);
      const typed = (typeof raw === "string" ? raw : "").trim();
      const clear =
        String(formData.get(`f_${field.path}__clear`) ?? "") === "true";
      const prior = String(getPath(previous, field.path) ?? "");
      const next = clear ? "" : typed === "" ? prior : encryptSecret(typed);
      setPath(candidate, field.path, next);
      secretAudit[field.path] = {
        previous: prior ? "(set)" : "(not set)",
        value:
          next === ""
            ? prior
              ? "(cleared)"
              : "(not set)"
            : next === prior
              ? "(unchanged)"
              : "(updated)",
      };
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

    // parsed.data already passed the exact schema setSetting re-validates.
    await setSetting(shop.id, key, parsed.data as never, actor);

    // Redact secret fields from BOTH sides of the audit payload: the event
    // lands in append-only SubscriberEvent rows that the Audit page renders
    // and exports as CSV — a credential there would be visible forever.
    const auditValue = JSON.parse(
      JSON.stringify(parsed.data),
    ) as Record<string, unknown>;
    const auditPrevious = JSON.parse(
      JSON.stringify(previous),
    ) as Record<string, unknown>;
    for (const [path, markers] of Object.entries(secretAudit)) {
      setPath(auditValue, path, markers.value);
      setPath(auditPrevious, path, markers.previous);
    }
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
        value: auditValue,
        previous: auditPrevious,
      },
    });

    // Analytics data options reshape every persisted derived table — kick an
    // immediate recompute so the merchant sees the toggle's effect without
    // waiting a night: the full cohort triangle, then EVERY refund-affected
    // rollup day across all history in flow-columns-only mode (a toggle
    // re-interprets what those days mean in BOTH directions — netting ↔
    // exclusion — and the nightly repair pass only runs under exclusion and
    // only inside its 90-day window), then the live trailing window. This
    // keeps the day ledger and the rollup-fed forecast in lockstep with the
    // recomputed cohorts after a flip. Contained (golden rule 9): analytics
    // failures never fail a settings save — the nightly jobs recompute
    // regardless.
    if (key === "analytics") {
      try {
        const { runCohortComputation } = await import(
          "~/lib/analytics/cohorts.server"
        );
        const { repairRefundAffectedRollupDays, runDailyRollup } = await import(
          "~/lib/analytics/rollup.server"
        );
        const { addDaysTz } = await import("~/lib/dates.server");
        const now = new Date();
        await runCohortComputation(shop.id, now);
        await repairRefundAffectedRollupDays(shop.id, {
          includeRefundRecordedDays: true,
          // Belt against a pathological book — ~2 years of daily refunds.
          cap: 730,
        });
        for (let daysAgo = 2; daysAgo >= 0; daysAgo--) {
          await runDailyRollup(shop.id, addDaysTz(now, -daysAgo, shop.ianaTimezone));
        }
      } catch (error) {
        console.warn("[settings] analytics recompute after save failed", error);
      }
    }

    // Saving the tagging card reconciles the subscriber tag across the whole
    // base (everyone with a live owned contract + everyone the ledger says is
    // tagged) so a toggle-on, a rename or a post-go-live enable takes effect
    // now instead of at the next daily full_sync_reconcile. DELIBERATELY not
    // awaited (the sendConfirmations pattern): the sweep is a sequential
    // Shopify write per changed customer and could hold this POST for
    // minutes on a large base — the save must return immediately. The sweep
    // contains every failure internally, logs one admin.action
    // (subscriber_tags_reconciled) summary event when it finishes, and the
    // per-sync recompute + daily reconcile converge anyone it missed.
    if (key === "tagging") {
      import("~/lib/tagging/tags.server")
        .then(({ reconcileAllSubscriberTags }) =>
          reconcileAllSubscriberTags(shop.id, actor),
        )
        .catch((error) => {
          console.warn(
            "[settings] subscriber tag reconcile after save failed",
            error,
          );
        });
    }

    return json<ActionData>({
      intent,
      ok: true,
      section: key,
      toast: `${def.title} settings saved`,
    });
  }

  if (intent === "test-mailer") {
    // Verifies the EFFECTIVE saved transport (Settings layer + env fallback)
    // with a real SMTP round-trip — save first, then test.
    const status = await verifyMailer(shop.id);
    // transport.verify() never checks the sender: when the From is the
    // support email standing in for a missing From address, say so — a
    // relay that verifies senders (SES, SendGrid, Postmark…) would reject
    // every send while the connection test stays green.
    const fromNote =
      status.fromFallback === "support_email"
        ? ` — no From address is set, so mail is sent as ${status.from} (your support email); make sure your provider allows sending as that address, or set a From address above`
        : "";
    return json<ActionData>({
      intent,
      ok: status.ok,
      toast: status.ok
        ? status.provider === "smtp"
          ? `SMTP verified (${status.source === "settings" ? "Settings" : "environment"} configuration)${fromNote}`
          : "Console transport active — emails are logged, not delivered"
        : `Mail transport failed: ${status.error ?? "verification failed"}`,
    });
  }

  if (intent === "test-klaviyo") {
    // Tests the key typed in the form when present (so it can be validated
    // BEFORE saving — a wrong saved key dead-letters queued events within a
    // minute), otherwise the effective saved/env key.
    const typed = String(formData.get("key") ?? "").trim();
    const keyToTest = typed || (await resolveKlaviyoAuth(shop.id)).apiKey || "";
    if (!keyToTest) {
      return json<ActionData>({
        intent,
        ok: false,
        toast:
          "No Klaviyo key to test — enter one above or set KLAVIYO_PRIVATE_API_KEY",
      });
    }
    const probe = await probeKlaviyoKey(keyToTest);
    return json<ActionData>({ intent, ok: probe.ok, toast: probe.detail });
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
    } else if (field.type === "countryRates") {
      state[field.path] = encodeCountryRates(raw);
    } else if (field.type === "secret") {
      // The loader redacts secrets, so this is always "" — typed here means
      // "replace"; the companion __clear key means "remove the saved value".
      state[field.path] = "";
      state[`${field.path}__clear`] = false;
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
  placeholder,
}: {
  field: FieldDef;
  value: string | boolean;
  error?: string;
  onChange: (next: string | boolean) => void;
  placeholder?: string;
}) {
  if (field.type === "secret") {
    return (
      <TextField
        label={field.label}
        autoComplete="new-password"
        type="password"
        value={String(value)}
        onChange={(next) => onChange(next)}
        placeholder={placeholder}
        helpText={field.helpText}
        error={error}
      />
    );
  }
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
  const vatEnabled = state["vat.enabled"] === true;
  const vatRatePct = Number(String(state["vat.defaultRatePct"] ?? "0")) || 0;

  // Worked example: one CHF 89.00 renewal with product cost CHF 24.00 known.
  const exampleRevenue = 8900;
  const exampleCogs = 2400;
  const fees = Math.round((exampleRevenue * feePct) / 100) + feeFixed;
  const shipping = shippingMode === "charged" ? 0 : shippingFlat;
  const perShipment = fulfillment + shipping;
  // VAT is a flat percentage of revenue (rate/100) — the same formula the
  // engine applies to every charge (see the field help text).
  const vat = vatEnabled
    ? Math.round((exampleRevenue * vatRatePct) / 100)
    : 0;
  const profit = exampleRevenue - exampleCogs - perShipment - fees - vat;

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
          } − ${money(fees)} payment fees${
            vatEnabled
              ? ` − ${money(vat)} VAT (${vatRatePct}% of the charge)`
              : ""
          } = `}
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
  secretsState,
  extraActions,
}: {
  def: SectionDef;
  initialValue: unknown;
  errors: Record<string, string>;
  saving: boolean;
  onSave: (def: SectionDef, state: SectionState) => void;
  preview?: (state: SectionState) => ReactNode;
  /** Per "<sectionKey>.<fieldPath>": where the effective secret comes from. */
  secretsState?: Record<string, "settings" | "env" | "none">;
  /** Extra footer buttons (e.g. test-connection) rendered beside Save. */
  extraActions?: (state: SectionState) => ReactNode;
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
          {def.fields.map((field) => {
            const secretSource =
              field.type === "secret"
                ? (secretsState?.[`${def.key}.${field.path}`] ?? "none")
                : undefined;
            return (
              <BlockStack key={field.path} gap="200">
                <FieldInput
                  field={field}
                  value={state[field.path] ?? ""}
                  error={errorFor(errors, field.path)}
                  onChange={(next) => setField(field.path, next)}
                  placeholder={
                    secretSource === "settings"
                      ? "•••••••• saved — leave blank to keep"
                      : secretSource === "env"
                        ? "Using environment variable — enter a value to override"
                        : secretSource === "none"
                          ? "Not set"
                          : undefined
                  }
                />
                {secretSource === "settings" ? (
                  <Checkbox
                    label="Remove the saved value (fall back to the environment variable, if any)"
                    checked={Boolean(state[`${field.path}__clear`])}
                    onChange={(checked) =>
                      setField(`${field.path}__clear`, checked)
                    }
                  />
                ) : null}
              </BlockStack>
            );
          })}
        </BlockStack>
        {preview ? preview(state) : null}
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200">
            {extraActions ? extraActions(state) : null}
          </InlineStack>
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
  const { settings, currencyCode, secretsState } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  // Bumped per section on every SUCCESSFUL save; used in the section's React
  // key so it remounts and re-initializes from the freshly revalidated
  // loader data. Load-bearing for secret fields: without the remount the
  // typed plaintext would linger in client state (re-encrypted and audited
  // "(updated)" on every later save of the section) and a used clear
  // checkbox would keep sending __clear=true after its own checkbox
  // unmounted — silently discarding the next credential typed into the same
  // page. Failed saves don't bump, so 422 corrections keep their input.
  const [saveGeneration, setSaveGeneration] = useState<Record<string, number>>(
    {},
  );

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (
      actionData.intent === "save-section" &&
      actionData.ok &&
      actionData.section
    ) {
      const section = actionData.section;
      setSaveGeneration((prev) => ({
        ...prev,
        [section]: (prev[section] ?? 0) + 1,
      }));
    }
  }, [actionData, shopify]);

  const savingSection =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "save-section"
      ? String(navigation.formData.get("section") ?? "")
      : null;
  const runningIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("intent") ?? "")
      : "";

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
      if (field.type === "secret") {
        fd.set(
          `f_${field.path}__clear`,
          String(Boolean(state[`${field.path}__clear`])),
        );
      }
    }
    submit(fd, { method: "post" });
  };

  const handleTest = (intent: string, extra?: Record<string, string>) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
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
                key={`${def.key}:${saveGeneration[def.key] ?? 0}`}
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
                secretsState={secretsState}
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
                extraActions={
                  def.key === "mailTransport"
                    ? () => (
                        <Button
                          loading={runningIntent === "test-mailer"}
                          onClick={() => handleTest("test-mailer")}
                        >
                          Test saved transport
                        </Button>
                      )
                    : def.key === "klaviyo"
                      ? (state) => (
                          <Button
                            loading={runningIntent === "test-klaviyo"}
                            onClick={() =>
                              handleTest("test-klaviyo", {
                                key: String(state["privateApiKey"] ?? ""),
                              })
                            }
                          >
                            Test key
                          </Button>
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
