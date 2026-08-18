import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Layout,
  Modal,
  Page,
  Popover,
  Select,
  Text,
  TextField,
  Thumbnail,
} from "@shopify/polaris";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent, contractTimeline } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  applyDiscountPct,
  centsFromDecimalString,
  decimalStringFromCents,
  formatMoney,
} from "~/lib/money";
import { shopDayStartUtc } from "~/lib/dates.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import {
  LTGP_PREDICTION_HORIZONS,
  parsePredictedLtgp,
} from "~/lib/analytics/predicted-ltgp.server";
import { sanitizeSurveyAnswers } from "~/lib/survey/shared";
import {
  recentSupportRequests,
  supportTopicLabelEn,
} from "~/lib/support/request.server";
import {
  approxWeeks,
  contractFrequency,
  frequencyLabelEn,
  frequencyToken,
  normalizeFrequencies,
  parseConfigFrequencies,
  parseFrequencyToken,
} from "~/lib/frequency";
import { buildMitEvidence } from "~/lib/billing/mit-evidence.server";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import {
  OPEN_CASE_STATES,
  categorizeDeclineCode,
  transitionOpenCase,
} from "~/lib/dunning/index.server";
import {
  addLine,
  addOneTimeAddon,
  applyDiscountGrant,
  cancelContract,
  changeFrequency,
  changeLineQuantity,
  changePaymentMethod,
  ongoingDiscountPctForProduct,
  pauseContract,
  removeLine,
  resumeContract,
  setBackupPaymentMethod,
  setLinePrice,
  setNextBillingDate,
  skipNextCycle,
  swapLineVariant,
  unskipNextCycle,
  updateDeliveryAddress,
} from "~/lib/contracts/index.server";
import {
  createBillingAttempt,
  getBillingCycleByDate,
  listCustomerPaymentMethods,
  refundOrderAmount,
  searchProducts,
  sendPaymentMethodUpdateEmail,
} from "~/lib/graphql/index.server";
import { resolveCardUpdatePath } from "~/lib/payments/cardUpdate.server";
import {
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  isBillableOwnership,
  normalizeOwnership,
} from "~/lib/ownership/shared";

/**
 * Admin — Subscriber support cockpit. Everything about one contract is
 * visible and editable here: status, items, schedule, payment & dunning,
 * address, discounts & gifts, refunds and the full compliance timeline.
 *
 * Every mutation goes through the contract/dunning service layer with
 * source ADMIN + the session user as actor, and additionally logs an
 * `admin.action` event with a human description — the full audit trail.
 */

const CANCEL_REASONS = [
  "TOO_MUCH_PRODUCT",
  "TOO_EXPENSIVE",
  "NOT_SEEING_RESULTS",
  "SHIPPING_ISSUES",
  "PAYMENT_ISSUES",
  "OTHER",
] as const;

const addressSchema = z
  .object({
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    company: z.string().nullish(),
    address1: z.string().nullish(),
    address2: z.string().nullish(),
    city: z.string().nullish(),
    provinceCode: z.string().nullish(),
    countryCode: z.string().nullish(),
    zip: z.string().nullish(),
    phone: z.string().nullish(),
  })
  .partial();

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: params.id ?? "" },
    include: {
      lines: { orderBy: { createdAt: "asc" } },
      discountGrants: { orderBy: { createdAt: "desc" } },
      giftGrants: { orderBy: { createdAt: "desc" }, take: 20 },
      billingAttempts: { orderBy: { scheduledFor: "desc" }, take: 15 },
      dunningCases: { orderBy: { openedAt: "desc" }, take: 5 },
    },
  });
  if (!contract || contract.shopId !== shop.id) {
    throw new Response("Subscriber not found", { status: 404 });
  }

  // Best-effort Shopify read — the cockpit must load even when Shopify is slow.
  let paymentMethods: Array<{
    id: string;
    label: string;
    revoked: boolean;
  }> | null = null;
  try {
    const methods = await listCustomerPaymentMethods(admin, contract.customerId);
    paymentMethods = methods.map((m) => {
      const inst = m.instrument;
      const brand = inst?.brand ?? "Card";
      const last4 = inst?.lastDigits ? ` ending ${inst.lastDigits}` : "";
      const exp =
        inst?.expiryMonth && inst?.expiryYear
          ? `, exp ${String(inst.expiryMonth).padStart(2, "0")}/${inst.expiryYear}`
          : "";
      return {
        id: m.id,
        label: `${brand}${last4}${exp}${m.revoked ? " (revoked)" : ""}`,
        revoked: m.revoked,
      };
    });
  } catch (err) {
    console.error("[admin] payment methods read failed", contract.id, err);
  }

  const pauseSettings = await getSetting(shop.id, "pause");

  // Plan lock window (support context): tells the agent why the customer
  // says they "can't cancel". Admin actions on this page are never blocked.
  const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);

  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId: shop.id, active: true },
  });
  // Everything the active configs offer plus the contract's own cadence (it
  // may predate a config edit); the week ladder only when the configs add
  // nothing, so the Select stays usable on a shop without plans.
  const merged = normalizeFrequencies([
    contractFrequency(contract),
    ...configs.flatMap((config) => parseConfigFrequencies(config)),
  ]);
  const frequencies = (
    merged.length > 1
      ? merged
      : normalizeFrequencies([
          ...merged,
          ...[2, 4, 6, 8, 10, 12].map((count) => ({
            unit: "WEEK" as const,
            count,
          })),
        ])
  ).map((f) => ({ token: frequencyToken(f), label: frequencyLabelEn(f) }));

  const events = await contractTimeline(contract.id, 200);

  // Support requests (v1.28.0, P5.1): the newest Get-help submits, read off
  // the event log (support.requested). Contained.
  const supportRequests = await recentSupportRequests(contract.id, 5);

  // Win-back episode (v1.28.0, P3.4): read-only view of the WinbackState —
  // stage, next touch, and the cancel reason the episode was stamped with
  // (migration 0028 `reason`). Contained: null renders "no episode".
  let winback: {
    status: string;
    stage: number;
    reason: string | null;
    nextTouchAt: string | null;
    predictedEmptyDate: string;
    cancelledAt: string;
    wonBackAt: string | null;
  } | null = null;
  try {
    const state = await prisma.winbackState.findUnique({
      where: { contractId: contract.id },
    });
    if (state) {
      winback = {
        status: state.status,
        stage: state.stage,
        reason: state.reason ?? null,
        nextTouchAt: state.nextTouchAt?.toISOString() ?? null,
        predictedEmptyDate: state.predictedEmptyDate.toISOString(),
        cancelledAt: state.cancelledAt.toISOString(),
        wonBackAt: state.wonBackAt?.toISOString() ?? null,
      };
    }
  } catch (err) {
    console.error("[admin] winback state read failed", contract.id, err);
  }

  // Post-purchase survey (v1.21.0): one row per contract when the thank-you
  // page survey was shown for its origin order. Read-only surface here.
  const surveyRow = await prisma.surveyResponse.findFirst({
    where: { contractId: contract.id },
  });

  // The engine's vocabulary, not a local copy — what this loader shows as
  // "the open case" must be exactly what the action's guarded transitions
  // will accept.
  const openCase =
    contract.dunningCases.find((c) => OPEN_CASE_STATES.includes(c.state)) ??
    null;

  const addressParsed = addressSchema.safeParse(contract.deliveryAddress ?? {});
  const address = addressParsed.success
    ? addressParsed.data
    : addressSchema.parse({});
  const currency = contract.currencyCode;

  return json({
    tz: shop.ianaTimezone,
    pauseMaxMonths: pauseSettings.maxMonths,
    frequencies,
    contract: {
      id: contract.id,
      name:
        [contract.firstName, contract.lastName].filter(Boolean).join(" ") ||
        contract.email,
      email: contract.email,
      phone: contract.phone,
      status: contract.status,
      // Which app manages this subscription. The support cockpit deliberately
      // opens for non-OURS contracts (the merchant must be able to look at
      // them), so it has to say loudly that nothing here applies to them.
      ownership: normalizeOwnership(contract.ownership) ?? OWNERSHIP_UNKNOWN,
      locale: contract.locale,
      isPrepaid: contract.isPrepaid,
      prepaidDeliveriesRemaining: contract.prepaidDeliveriesRemaining,
      grandfathered: contract.grandfatheredPricing,
      merged: contract.mergeGroupId != null,
      churnRiskScore: contract.churnRiskScore,
      intervalWeeks: contract.intervalWeeks,
      frequencyToken: frequencyToken(contractFrequency(contract)),
      nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
      pausedAt: contract.pausedAt?.toISOString() ?? null,
      resumeAt: contract.resumeAt?.toISOString() ?? null,
      cancelledAt: contract.cancelledAt?.toISOString() ?? null,
      cancelReason: contract.cancelReason,
      // Scheduled cancel (v1.28.0, P3.8): the customer chose the end day.
      cancelScheduledAt: contract.cancelScheduledAt?.toISOString() ?? null,
      ordersCount: contract.ordersCount,
      skipCount: contract.skipCount,
      lifetimeRevenue: formatMoney(contract.lifetimeRevenueCents, currency),
      currencyCode: currency,
      paymentMethodId: contract.paymentMethodId,
      backupPaymentMethodId: contract.backupPaymentMethodId,
      // Backup provenance (migration 0027): admin Select and the customer
      // toggle write the same column; this says who did it last.
      backupSetBy: contract.backupSetBy,
      backupSetAt: contract.backupSetAt?.toISOString() ?? null,
      paymentInstrumentType: contract.paymentInstrumentType,
      paymentMethodRevokedAt:
        contract.paymentMethodRevokedAt?.toISOString() ?? null,
      cardBrand: contract.cardBrand,
      cardLast4: contract.cardLast4,
      cardExpiry:
        contract.cardExpiryMonth && contract.cardExpiryYear
          ? `${String(contract.cardExpiryMonth).padStart(2, "0")}/${contract.cardExpiryYear}`
          : null,
      createdAt: contract.createdAt.toISOString(),
      // Plan lock window: set while SellingPlanConfig.lockDays covers this
      // contract — the portal is refusing skip/pause/change/cancel until then.
      lockedUntil: lock.locked ? (lock.until?.toISOString() ?? null) : null,
    },
    // Acquisition card (data foundation — docs/DATA_FOUNDATION.md). Captured
    // from the origin order at contract creation / by the daily backfill;
    // every field may be null on rows predating capture.
    acquisition: {
      captured: contract.acqRaw != null,
      sourceName: contract.acqSourceName,
      utm: (contract.acqUtm ?? null) as {
        source?: string | null;
        medium?: string | null;
        campaign?: string | null;
        term?: string | null;
        content?: string | null;
      } | null,
      countryCode: contract.acqCountryCode,
      city: contract.acqCity,
      provinceCode: contract.acqProvinceCode,
      deviceType: contract.acqDeviceType,
      timeToPurchaseSeconds: contract.acqTimeToPurchaseSeconds,
      unitsFirstOrder: contract.acqUnitsFirstOrder,
      orderValueBand: contract.acqOrderValueBand,
      referringSite: contract.acqReferringSite,
      landingSite: contract.acqLandingSite,
      originOrderName: contract.originOrderName,
      originOrderTotal:
        contract.originOrderTotalCents != null
          ? formatMoney(
              contract.originOrderTotalCents,
              contract.originOrderCurrencyCode ?? currency,
            )
          : null,
    },
    winback,
    supportRequests: supportRequests.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      topic: supportTopicLabelEn(r.topic),
      message: r.message,
      orderRef: r.orderRef,
      pushBackApplied: r.pushBackApplied,
      surface: r.surface,
      cancelReason: r.cancelReason,
      cancelReasonDetail: r.cancelReasonDetail,
      saveRequest: r.saveRequest,
    })),
    // Post-purchase survey card (v1.21.0). Null = never shown (order predates
    // the survey, or the shopper never saw the thank-you block).
    survey: surveyRow
      ? {
          answers: sanitizeSurveyAnswers(surveyRow.answers),
          shownAt: surveyRow.shownAt.toISOString(),
          answeredAt: surveyRow.answeredAt?.toISOString() ?? null,
          completedAt: surveyRow.completedAt?.toISOString() ?? null,
          source: surveyRow.source,
          questionSetVersion: surveyRow.questionSetVersion,
          holdout: contract.surveyHoldout === true,
        }
      : null,
    // Predicted value card (v1.21.0): the nightly predicted-LTGP output,
    // parsed defensively — null renders the honest "not scored yet" copy.
    predictedValue: (() => {
      const parsed = parsePredictedLtgp(contract.predictedLtgp);
      if (!parsed) return null;
      return {
        computedAt: contract.predictedLtgpAt?.toISOString() ?? parsed.computedAt,
        riskTilt: parsed.riskTilt,
        estimatedCosts: parsed.basis.estimatedCosts,
        horizons: LTGP_PREDICTION_HORIZONS.map(({ key, label }) => ({
          key,
          label,
          amount: formatMoney(parsed.horizons[key].cents, currency),
          grade: parsed.horizons[key].grade,
          expectedCycles: parsed.horizons[key].expectedCycles,
        })),
      };
    })(),
    address,
    lines: contract.lines.map((l) => ({
      id: l.id,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      imageUrl: l.imageUrl,
      quantity: l.quantity,
      price: formatMoney(l.currentPriceCents, currency),
      priceCents: l.currentPriceCents,
      isGift: l.isGift,
      isOneTimeAddon: l.isOneTimeAddon,
    })),
    discountGrants: contract.discountGrants.map((g) => ({
      id: g.id,
      type: g.type,
      percent: g.percent,
      cyclesTotal: g.cyclesTotal,
      cyclesRemaining: g.cyclesRemaining,
      reason: g.reason,
      grantedBy: g.grantedBy,
      createdAt: g.createdAt.toISOString(),
      active: g.cyclesRemaining > 0 && g.exhaustedAt == null,
    })),
    giftGrants: contract.giftGrants.map((g) => ({
      id: g.id,
      variantId: g.variantId,
      cycleIndex: g.cycleIndex,
      status: g.status,
      createdAt: g.createdAt.toISOString(),
    })),
    attempts: contract.billingAttempts.map((a) => ({
      id: a.id,
      cycleIndex: a.cycleIndex,
      attemptNumber: a.attemptNumber,
      status: a.status,
      scheduledFor: a.scheduledFor.toISOString(),
      completedAt: a.completedAt?.toISOString() ?? null,
      orderId: a.orderId,
      orderName: a.orderName,
      amount:
        a.amountCents != null
          ? formatMoney(a.amountCents, a.currencyCode ?? currency)
          : null,
      amountCents: a.amountCents,
      errorCode: a.errorCode,
      originatingAction: a.originatingAction,
    })),
    dunningCase: openCase
      ? {
          id: openCase.id,
          state: openCase.state,
          ladderStep: openCase.ladderStep,
          nextRetryAt: openCase.nextRetryAt?.toISOString() ?? null,
          openedAt: openCase.openedAt.toISOString(),
          declineCode: openCase.declineCode,
          declineHuman: categorizeDeclineCode(openCase.declineCode).description,
          emailsSent: openCase.emailsSent,
          smsSent: openCase.smsSent,
        }
      : null,
    paymentMethods,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      source: e.source,
      actor: e.actor,
      createdAt: e.createdAt.toISOString(),
      payloadJson: JSON.stringify(e.payload ?? {}, null, 2),
    })),
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

interface ActionResponse {
  ok: boolean;
  intent: string;
  message?: string;
  error?: string;
  loginUrl?: string;
  updateUrl?: string;
  results?: Array<{
    id: string;
    title: string;
    status: string | null;
    imageUrl: string | null;
    ongoingPct: number | null;
    variants: Array<{
      id: string;
      title: string;
      sku: string | null;
      price: string;
      priceCents: number;
      discounted: string | null;
      available: boolean;
    }>;
  }>;
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function int(formData: FormData, key: string, fallback = 0): number {
  const n = parseInt(str(formData, key), 10);
  return Number.isInteger(n) ? n : fallback;
}

/**
 * Intents that neither charge, contact, nor modify anything — the only ones a
 * contract this app does not own may reach. Everything else is refused for a
 * FOREIGN or UNKNOWN contract by requireOwnedContract() below.
 */
const OWNERSHIP_EXEMPT_INTENTS = new Set(["searchProducts"]);

/**
 * The server-side ownership gate for this page.
 *
 * The cockpit deliberately OPENS for a contract another subscription app owns
 * (the merchant must be able to look at what is on their store, and support
 * questions arrive about those subscriptions too), and it says so in a banner.
 * What it must never do is ACT on one. "Charge now" and "Retry now" call
 * Shopify's billingAttemptCreate — on another app's contract that is the
 * duplicate charge this whole ownership column exists to prevent, one click
 * away, and no warning copy is a control. Pause / cancel / edit lines / change
 * the date write straight to Shopify behind the owning app's back, and the
 * customer-facing ones (card-update email, portal link) contact a subscriber
 * who is not ours to contact.
 *
 * A warning banner enforced nothing: the buttons were live, and a POST to this
 * route did not even need the UI. This is the enforcement, in the same place
 * the contract is loaded, so it covers every intent by default — a new intent
 * is refused unless it is explicitly listed as read-only above.
 *
 * The escape hatch is deliberate and one-way: claim the subscription on the
 * Subscribers page (UNKNOWN → OURS, never FOREIGN → OURS). Positively
 * identified as another app's means "cancel it there and re-import here" —
 * two apps must never bill the same subscription.
 */
function ownershipRefusal(
  intent: string,
  ownership: string,
): string | null {
  if (OWNERSHIP_EXEMPT_INTENTS.has(intent)) return null;
  if (isBillableOwnership(ownership)) return null;
  return ownership === OWNERSHIP_FOREIGN
    ? "This subscription is managed by another subscription app, so Cellexia will not act on it — charging, editing or emailing it here would collide with the app that owns it. Cancel it in that app and re-create it in Cellexia to take it over."
    : "This subscription has not been attributed to Cellexia, so it is treated as not ours and no action is taken on it. If it is yours, claim it on the Subscribers page first (Subscribers → select → “Claim as Cellexia's”).";
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = str(formData, "intent");
  const opts = { source: "ADMIN" as const, actor };

  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: params.id ?? "" },
    include: { lines: true },
  });
  if (!contract || contract.shopId !== shop.id) {
    return json<ActionResponse>({ ok: false, intent, error: "Subscriber not found" });
  }
  const refusal = ownershipRefusal(intent, contract.ownership);
  if (refusal) {
    console.warn(
      "[admin] refused",
      intent,
      "on non-owned contract",
      contract.id,
      contract.ownership,
    );
    return json<ActionResponse>({ ok: false, intent, error: refusal });
  }
  const contractId = contract.id;

  const adminLog = async (
    description: string,
    payload: Record<string, unknown> = {},
  ) => {
    await logEvent({
      shopId: shop.id,
      contractId,
      customerId: contract.customerId,
      email: contract.email,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: { description, ...payload },
    });
  };

  const ok = (message: string, extra: Partial<ActionResponse> = {}) =>
    json<ActionResponse>({ ok: true, intent, message, ...extra });

  try {
    switch (intent) {
      // ── Quick actions ───────────────────────────────────────────────────
      case "pause": {
        const months = Math.max(1, int(formData, "months", 1));
        // reason ADMIN → SubscriptionContract.pausedReason (migration 0016):
        // the cockpit pause is the merchant's decision, and retention
        // analytics splits pause causes the way cancelSource splits cancels.
        await pauseContract(shop.domain, contractId, months, {
          ...opts,
          reason: "ADMIN",
        });
        await adminLog(`Paused subscription for ${months} month(s)`, {
          action: "pause",
          months,
        });
        return ok(`Paused for ${months} month(s)`);
      }
      case "resume": {
        await resumeContract(shop.domain, contractId, opts);
        await adminLog("Resumed subscription (next charge in ~3 days)", {
          action: "resume",
        });
        return ok("Subscription resumed");
      }
      case "keepScheduled": {
        // Clear a scheduled cancel (v1.28.0, P3.8) on the customer's behalf
        // — the same atomic path the portal Keep button and KEEP link use.
        const { keepScheduledCancel } = await import("~/lib/cancel/engine.server");
        const kept = await keepScheduledCancel(contractId, opts);
        if (!kept) return ok("Nothing was scheduled");
        await adminLog("Cleared the scheduled cancellation (kept)", {
          action: "keepScheduled",
        });
        return ok("Scheduled cancellation cleared — the subscription continues");
      }
      case "cancel": {
        const reason = str(formData, "reason") || "OTHER";
        await cancelContract(shop.domain, contractId, reason, {
          ...opts,
          cancelSource: "ADMIN",
        });
        await adminLog(`Cancelled subscription (reason: ${reason})`, {
          action: "cancel",
          reason,
        });
        return ok("Subscription cancelled");
      }
      case "chargeNow": {
        if (!contract.nextBillingDate) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "Contract has no next billing date to charge against",
          });
        }
        const cycle = await getBillingCycleByDate(
          admin,
          contract.shopifyContractId,
          contract.nextBillingDate,
        );
        if (!cycle) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "Could not resolve the contract's current billing cycle on Shopify",
          });
        }
        const now = new Date();
        // Crash-safe reuse: a PENDING manual row without a Shopify attempt id
        // keeps its idempotency key, so a re-fire can never double charge.
        let row = await prisma.billingAttempt.findFirst({
          where: {
            contractId,
            cycleIndex: cycle.cycleIndex,
            status: "PENDING",
            originatingAction: "ADMIN_MANUAL",
            shopifyAttemptId: null,
          },
          orderBy: { attemptNumber: "desc" },
        });
        if (!row) {
          const attempts = await prisma.billingAttempt.count({
            where: { contractId, cycleIndex: cycle.cycleIndex },
          });
          row = await prisma.billingAttempt.create({
            data: {
              contractId,
              idempotencyKey: `${contractId}:${cycle.cycleIndex}:manual-${attempts + 1}`,
              cycleIndex: cycle.cycleIndex,
              attemptNumber: attempts + 1,
              status: "PENDING",
              scheduledFor: now,
              originatingAction: "ADMIN_MANUAL",
              // Stored-credential/MIT compliance evidence — every attempt
              // carries it, manual admin charges included.
              mitEvidence: buildMitEvidence({
                consentOrder: contract.originOrderId,
                originatingAction: "ADMIN_MANUAL",
                timestamp: now,
                initiatedBy: actor,
              }),
            },
          });
        }
        const created = await createBillingAttempt(
          admin,
          contract.shopifyContractId,
          {
            idempotencyKey: row.idempotencyKey,
            originTime: now,
            cycleIndex: cycle.cycleIndex,
          },
        );
        await prisma.billingAttempt.update({
          where: { id: row.id },
          data: { shopifyAttemptId: created.attemptId, startedAt: now },
        });
        await logEvent({
          shopId: shop.id,
          contractId,
          customerId: contract.customerId,
          email: contract.email,
          type: "billing.attempt_started",
          source: "ADMIN",
          actor,
          payload: {
            attemptId: row.id,
            shopifyAttemptId: created.attemptId,
            cycleIndex: cycle.cycleIndex,
            attemptNumber: row.attemptNumber,
            idempotencyKey: row.idempotencyKey,
            originatingAction: "ADMIN_MANUAL",
          },
        });
        await adminLog("Manually charged the current billing cycle", {
          action: "charge_now",
          cycleIndex: cycle.cycleIndex,
          idempotencyKey: row.idempotencyKey,
        });
        return ok("Charge started — the result arrives via webhook shortly");
      }
      case "sendCardEmail": {
        if (!contract.paymentMethodId) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "No payment method on file for this contract",
          });
        }
        await sendPaymentMethodUpdateEmail(admin, contract.paymentMethodId);
        await adminLog("Sent Shopify's card-update email to the customer", {
          action: "send_card_update_email",
          paymentMethodId: contract.paymentMethodId,
        });
        return ok("Card-update email sent");
      }
      case "portalLink": {
        const portal = await getSetting(shop.id, "portal");
        const loginUrl = await buildMagicUrl({
          action: "LOGIN",
          contractId,
          customerId: contract.customerId,
          email: contract.email,
          ttlSeconds: portal.magicLinkTtlDays * 24 * 3600,
          maxUses: 3,
          createdVia: "ADMIN",
        });
        await adminLog("Generated a portal login magic link for the customer", {
          action: "portal_login_link",
          ttlDays: portal.magicLinkTtlDays,
        });
        return ok("Login link created", { loginUrl });
      }

      // ── Items ───────────────────────────────────────────────────────────
      case "setQuantity": {
        const lineId = str(formData, "lineId");
        const quantity = int(formData, "quantity");
        await changeLineQuantity(shop.domain, contractId, lineId, quantity, opts);
        await adminLog(`Changed line quantity to ${quantity}`, {
          action: "set_quantity",
          lineId,
          quantity,
        });
        return ok("Quantity updated");
      }
      case "setLinePrice": {
        const lineId = str(formData, "lineId");
        const priceStr = str(formData, "price");
        const priceCents = centsFromDecimalString(priceStr);
        if (!priceStr || !Number.isInteger(priceCents) || priceCents < 0) {
          return json<ActionResponse>({ ok: false, intent, error: "Invalid price" });
        }
        const line = contract.lines.find((l) => l.id === lineId);
        await setLinePrice(shop.domain, contractId, lineId, priceCents, opts);
        await adminLog(
          `Set the unit price of "${line?.title ?? lineId}" to ${formatMoney(priceCents, contract.currencyCode)}`,
          {
            action: "set_line_price",
            lineId,
            oldPriceCents: line?.currentPriceCents ?? null,
            newPriceCents: priceCents,
          },
        );
        return ok("Line price updated");
      }
      case "swapLine": {
        const lineId = str(formData, "lineId");
        const variantId = str(formData, "variantId");
        await swapLineVariant(shop.domain, contractId, lineId, variantId, opts);
        await adminLog("Swapped a line to a different variant", {
          action: "swap_line",
          lineId,
          newVariantId: variantId,
        });
        return ok("Product swapped");
      }
      case "removeLine": {
        const lineId = str(formData, "lineId");
        await removeLine(shop.domain, contractId, lineId, opts);
        await adminLog("Removed a line from the subscription", {
          action: "remove_line",
          lineId,
        });
        return ok("Line removed");
      }
      case "addProduct": {
        const variantId = str(formData, "variantId");
        const quantity = Math.max(1, int(formData, "quantity", 1));
        await addLine(
          shop.domain,
          contractId,
          variantId,
          quantity,
          { addedVia: "ADMIN" },
          opts,
        );
        await adminLog("Added a recurring product to the subscription", {
          action: "add_product",
          variantId,
          quantity,
        });
        return ok("Product added");
      }
      case "addAddon": {
        const variantId = str(formData, "variantId");
        const quantity = Math.max(1, int(formData, "quantity", 1));
        await addOneTimeAddon(
          shop.domain,
          contractId,
          variantId,
          quantity,
          { addedVia: "ADMIN" },
          opts,
        );
        await adminLog("Added a one-time add-on to the next order", {
          action: "add_one_time_addon",
          variantId,
          quantity,
        });
        return ok("One-time add-on staged for the next order");
      }

      // ── Schedule ────────────────────────────────────────────────────────
      case "skipNext": {
        // ADMIN initiator: a cockpit skip counts in merchantSkipCount, not in
        // the customer's skip behavior (skipCount / lastSkippedAt) — the
        // risk/win-back models must only see skips the customer chose.
        await skipNextCycle(shop.domain, contractId, {
          ...opts,
          initiator: "ADMIN",
        });
        await adminLog("Skipped the next billing cycle", { action: "skip_next" });
        return ok("Next cycle skipped");
      }
      case "unskipNext": {
        await unskipNextCycle(shop.domain, contractId, opts);
        await adminLog("Un-skipped the upcoming billing cycle", {
          action: "unskip_next",
        });
        return ok("Cycle restored");
      }
      case "setFrequency": {
        // Token field ("10:DAY") from the current UI; the bare "weeks"
        // integer keeps a stale pre-v1.8.0 tab working (bare weeks = WEEK).
        const weeks = int(formData, "weeks");
        const freq =
          parseFrequencyToken(str(formData, "frequency")) ??
          (weeks >= 1 ? { unit: "WEEK" as const, count: weeks } : null);
        if (!freq) {
          return json<ActionResponse>({ ok: false, intent, error: "Invalid frequency" });
        }
        const label = frequencyLabelEn(freq).toLowerCase();
        await changeFrequency(shop.domain, contractId, freq, opts);
        await adminLog(`Changed delivery frequency to ${label}`, {
          action: "set_frequency",
          // Week approximation stays first for anything built on it.
          weeks: approxWeeks(freq.unit, freq.count),
          unit: freq.unit,
          count: freq.count,
        });
        return ok(`Frequency set to ${label}`);
      }
      case "setNextDate": {
        const dateStr = str(formData, "date"); // YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          return json<ActionResponse>({ ok: false, intent, error: "Invalid date" });
        }
        const target = shopDayStartUtc(
          new Date(`${dateStr}T12:00:00Z`),
          shop.ianaTimezone,
        );
        await setNextBillingDate(shop.domain, contractId, target, opts);
        await adminLog(`Moved the next billing date to ${dateStr}`, {
          action: "set_next_date",
          date: dateStr,
        });
        return ok("Next billing date updated");
      }

      // ── Payment & dunning ───────────────────────────────────────────────
      case "setBackup": {
        const paymentMethodId = str(formData, "paymentMethodId") || null;
        // Contract-service seam (v1.28.0): validates ≠ primary and ∈ the
        // customer's live methods, records backupSetBy ADMIN, logs
        // contract.backup_payment_set|cleared.
        await setBackupPaymentMethod(shop.domain, contractId, paymentMethodId, {
          ...opts,
          setBy: "ADMIN",
        });
        await adminLog(
          paymentMethodId
            ? "Set a backup payment method for dunning fallback"
            : "Cleared the backup payment method",
          { action: "set_backup_payment", paymentMethodId },
        );
        return ok(paymentMethodId ? "Backup method set" : "Backup method cleared");
      }
      case "openUpdateUrl": {
        const pmId = str(formData, "paymentMethodId") || contract.paymentMethodId;
        if (!pmId) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "No payment method on file",
          });
        }
        // ONE server-side decision (app/lib/payments/cardUpdate.server.ts):
        // Shop Pay → hosted secure page (opened in a new tab); cards /
        // PayPal → Shopify emails the customer its own 48h update link.
        const path = await resolveCardUpdatePath({
          admin,
          contract: { ...contract, paymentMethodId: pmId },
          source: "ADMIN",
          actor,
        });
        if (path.kind === "redirect") {
          await adminLog("Fetched the secure card-update URL", {
            action: "open_card_update_url",
            paymentMethodId: pmId,
          });
          return ok("Card-update URL ready", { updateUrl: path.url });
        }
        if (path.kind === "email_sent") {
          await adminLog("Shopify emailed the customer a secure card-update link", {
            action: "open_card_update_url",
            channel: "shopify_email",
            paymentMethodId: pmId,
          });
          return ok(
            "Shopify emailed the customer a secure link to update this payment method (valid 48 hours) — the hosted page only supports Shop Pay.",
          );
        }
        return json<ActionResponse>({
          ok: false,
          intent,
          error:
            path.reason === "payment_method_revoked"
              ? "This payment method was removed from the customer's account — they need to add a new one."
              : path.reason === "no_payment_method"
                ? "No payment method on file"
                : "Shopify refused both card-update paths — see server logs",
        });
      }
      case "makePrimary": {
        const pmId = str(formData, "paymentMethodId");
        if (!pmId) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "No payment method selected",
          });
        }
        // Contract-service seam (v1.28.0): validates ∈ the customer's live
        // methods, Shopify draft update, mirror refresh, pointer rules,
        // contract.payment_method_updated {trigger:'admin'}, dunning poke.
        await changePaymentMethod(shop.domain, contractId, pmId, {
          ...opts,
          trigger: "admin",
        });
        await adminLog("Made a vaulted payment method the primary", {
          action: "make_primary_payment_method",
          paymentMethodId: pmId,
        });
        return ok("Primary payment method updated");
      }
      case "dunningRetryNow": {
        const caseId = str(formData, "caseId");
        const now = new Date();
        // Guarded + atomic + scoped (transitionOpenCase): the caseId comes
        // from the form, so it MUST be pinned to this contract — a bare POST
        // could otherwise move any case in the database. And only an
        // OPEN-state case may be scheduled: a stale cockpit's "Retry now"
        // after a webhook recovery would re-bill the already-paid cycle.
        const claimed = await transitionOpenCase(caseId, contractId, "RETRYING", now);
        if (!claimed) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error:
              "Dunning case not found or already resolved — refresh the page",
          });
        }
        await logEvent({
          shopId: shop.id,
          contractId,
          customerId: contract.customerId,
          email: contract.email,
          type: "dunning.retry_scheduled",
          source: "ADMIN",
          actor,
          payload: {
            dunningCaseId: caseId,
            trigger: "admin_retry_now",
            immediate: true,
            nextRetryAt: now.toISOString(),
          },
        });
        await adminLog("Scheduled an immediate dunning retry", {
          action: "dunning_retry_now",
          dunningCaseId: caseId,
        });
        return ok("Retry scheduled — the next sweep fires it within a minute");
      }
      case "dunningResolve": {
        const caseId = str(formData, "caseId");
        const now = new Date();
        // Scoped to THIS contract and guarded on an open state — otherwise a
        // bare POST could resolve any case in the database while the
        // consecutiveFailures reset below lands on this contract.
        const claimed = await transitionOpenCase(caseId, contractId, "RECOVERED", now);
        if (!claimed) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error:
              "Dunning case not found or already resolved — refresh the page",
          });
        }
        await prisma.subscriptionContract.update({
          where: { id: contractId },
          data: { consecutiveFailures: 0 },
        });
        await logEvent({
          shopId: shop.id,
          contractId,
          customerId: contract.customerId,
          email: contract.email,
          type: "dunning.recovered",
          source: "ADMIN",
          actor,
          payload: { dunningCaseId: caseId, resolution: "RECOVERED", manual: true },
        });
        await adminLog("Manually marked the dunning case resolved", {
          action: "dunning_mark_resolved",
          dunningCaseId: caseId,
        });
        return ok("Dunning case marked resolved");
      }
      case "dunningCancelCase": {
        const caseId = str(formData, "caseId");
        // Same scope + open-state guard as the other dunning intents: a case
        // the webhook already resolved keeps its real resolution.
        const claimed = await transitionOpenCase(caseId, contractId, "CANCELLED");
        if (!claimed) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error:
              "Dunning case not found or already resolved — refresh the page",
          });
        }
        await adminLog("Moved the dunning case to cancelled (no more retries)", {
          action: "dunning_cancel_case",
          dunningCaseId: caseId,
        });
        return ok("Dunning case cancelled");
      }

      // ── Address ─────────────────────────────────────────────────────────
      case "updateAddress": {
        const address = {
          firstName: str(formData, "firstName") || null,
          lastName: str(formData, "lastName") || null,
          company: str(formData, "company") || null,
          address1: str(formData, "address1") || null,
          address2: str(formData, "address2") || null,
          city: str(formData, "city") || null,
          provinceCode: str(formData, "provinceCode") || null,
          countryCode: str(formData, "countryCode") || null,
          zip: str(formData, "zip") || null,
          phone: str(formData, "phone") || null,
        };
        await updateDeliveryAddress(shop.domain, contractId, address, opts);
        await adminLog("Updated the delivery address", {
          action: "update_address",
          city: address.city,
          zip: address.zip,
          countryCode: address.countryCode,
        });
        return ok("Address updated");
      }

      // ── Discounts & gifts ───────────────────────────────────────────────
      case "grantDiscount": {
        const percent = int(formData, "percent");
        const cycles = int(formData, "cycles");
        const reason = str(formData, "reason") || null;
        await applyDiscountGrant(
          shop.domain,
          contractId,
          { type: "MANUAL", percent, cycles, grantedBy: actor, reason },
          opts,
        );
        await adminLog(
          `Granted a ${percent}% discount for ${cycles} cycle(s)`,
          { action: "grant_discount", percent, cycles, reason },
        );
        return ok("Discount granted");
      }
      case "revokeGrant": {
        const grantId = str(formData, "grantId");
        const grant = await prisma.discountGrant.findFirst({
          where: { id: grantId, contractId },
        });
        if (!grant) {
          return json<ActionResponse>({ ok: false, intent, error: "Grant not found" });
        }
        await prisma.discountGrant.update({
          where: { id: grant.id },
          data: { cyclesRemaining: 0, exhaustedAt: new Date() },
        });
        await adminLog(
          `Revoked a ${grant.percent}% discount grant (${grant.cyclesRemaining} cycle(s) were remaining)`,
          {
            action: "revoke_discount_grant",
            grantId: grant.id,
            percent: grant.percent,
            cyclesRemaining: grant.cyclesRemaining,
          },
        );
        return ok("Discount grant revoked");
      }
      case "addGift": {
        const variantId = str(formData, "variantId");
        const cycleIndex = int(formData, "cycleIndex", contract.ordersCount + 1);
        if (!variantId) {
          return json<ActionResponse>({ ok: false, intent, error: "Pick a gift variant" });
        }
        const gift = await prisma.giftGrant.create({
          data: { contractId, variantId, cycleIndex, status: "SCHEDULED" },
        });
        await logEvent({
          shopId: shop.id,
          contractId,
          customerId: contract.customerId,
          email: contract.email,
          type: "lifecycle.gift_scheduled",
          source: "ADMIN",
          actor,
          payload: { giftGrantId: gift.id, variantId, cycleIndex, manual: true },
        });
        await adminLog(`Scheduled a manual gift for cycle ${cycleIndex}`, {
          action: "add_manual_gift",
          giftGrantId: gift.id,
          variantId,
          cycleIndex,
        });
        return ok(`Gift scheduled for cycle ${cycleIndex}`);
      }

      // ── Refunds ─────────────────────────────────────────────────────────
      case "refund": {
        const attemptId = str(formData, "attemptId");
        const amountStr = str(formData, "amount");
        const attempt = await prisma.billingAttempt.findFirst({
          where: { id: attemptId, contractId },
        });
        if (!attempt || !attempt.orderId) {
          return json<ActionResponse>({
            ok: false,
            intent,
            error: "No refundable order on that attempt",
          });
        }
        const amountCents = centsFromDecimalString(amountStr);
        if (!Number.isInteger(amountCents) || amountCents <= 0) {
          return json<ActionResponse>({ ok: false, intent, error: "Invalid amount" });
        }
        const currency = attempt.currencyCode ?? contract.currencyCode;
        const result = await refundOrderAmount(
          admin,
          attempt.orderId,
          amountCents,
          currency,
          `Cellexia admin refund by ${actor}`,
        );
        await adminLog(
          `Refunded ${formatMoney(amountCents, currency)} on order ${attempt.orderName ?? attempt.orderId}`,
          {
            action: "refund",
            attemptId,
            orderId: attempt.orderId,
            orderName: attempt.orderName,
            amountCents,
            currencyCode: currency,
            refundId: result.refundId,
          },
        );
        return ok(`Refunded ${formatMoney(amountCents, currency)}`);
      }

      // ── Product search (picker modal) ───────────────────────────────────
      case "searchProducts": {
        const q = str(formData, "q");
        if (!q) return json<ActionResponse>({ ok: true, intent, results: [] });
        const found = await searchProducts(admin, q, 10);
        const results: NonNullable<ActionResponse["results"]> = [];
        for (const product of found) {
          const pct = await ongoingDiscountPctForProduct(shop.id, product.id);
          results.push({
            id: product.id,
            title: product.title,
            status: product.status,
            imageUrl: product.featuredImageUrl,
            ongoingPct: pct,
            variants: product.variants.map((v) => ({
              id: v.id,
              title: v.title,
              sku: v.sku,
              price: formatMoney(v.priceCents, contract.currencyCode),
              priceCents: v.priceCents,
              discounted:
                pct != null
                  ? formatMoney(
                      applyDiscountPct(v.priceCents, pct),
                      contract.currencyCode,
                    )
                  : null,
              available: v.availableForSale,
            })),
          });
        }
        return json<ActionResponse>({ ok: true, intent, results });
      }

      default:
        return json<ActionResponse>({ ok: false, intent, error: `Unknown intent: ${intent}` });
    }
  } catch (err) {
    console.error("[admin] subscriber action failed", intent, contractId, err);
    return json<ActionResponse>({ ok: false, intent, error: errMessage(err) });
  }
};

// ── Component ────────────────────────────────────────────────────────────────

type PickerMode = "add" | "addon" | "swap" | "gift";

function statusTone(
  status: string,
): "success" | "attention" | "critical" | "info" | undefined {
  switch (status) {
    case "ACTIVE":
      return "success";
    case "PAUSED":
      return "attention";
    case "FAILED":
      return "critical";
    case "EXPIRED":
      return "info";
    default:
      return undefined;
  }
}

function categoryTone(
  category: string,
): "success" | "attention" | "critical" | "info" | "warning" | "new" {
  switch (category) {
    case "dunning":
      return "warning";
    case "cancel":
      return "critical";
    case "billing":
      return "success";
    case "admin":
      return "attention";
    case "magic":
    case "portal":
      return "new";
    default:
      return "info";
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return formatDate(iso);
}

/**
 * Admin-facing labels for the survey card. Keys mirror the frozen instrument
 * (app/lib/survey/shared.ts); an unknown stored key renders as itself rather
 * than crashing the card (forward compatibility across instrument versions).
 */
const SURVEY_CARD_ROWS: Array<{
  key: "plannedDuration" | "motive" | "expectedSpeed" | "routine";
  label: string;
  options: Record<string, string>;
}> = [
  {
    key: "plannedDuration",
    label: "Planned duration",
    options: {
      trying: "Trying it out",
      few_months: "A few months",
      six_months_plus: "Six months or more",
      permanent: "Permanent part of routine",
    },
  },
  {
    key: "motive",
    label: "Motive",
    options: {
      fast_wrinkles: "Fast wrinkle reduction",
      prevention: "Long-term prevention",
      daily_care: "Daily care",
      occasion: "Upcoming occasion",
    },
  },
  {
    key: "expectedSpeed",
    label: "Expected results",
    options: {
      days: "Within days",
      weeks: "Within weeks",
      one_two_months: "In 1–2 months",
      three_months_plus: "3+ months",
      not_sure: "Not sure",
    },
  },
  {
    key: "routine",
    label: "Current routine",
    options: {
      full: "Full routine (AM+PM)",
      most_days: "A few products, most days",
      on_off: "On and off",
      minimal: "Minimal",
    },
  },
];

/** "browse-to-buy" latency for the Acquisition card: 90s → "2m", 2d → "2 days". */
function humanizeSeconds(seconds: number): string {
  if (seconds < 60) return "under a minute";
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

const EVENT_CATEGORIES = [
  "all",
  "contract",
  "cycle",
  "billing",
  "dunning",
  "cancel",
  "winback",
  "lifecycle",
  "notification",
  "portal",
  "magic",
  "admin",
  "stockout",
  "alert",
] as const;

export default function SubscriberDetailPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const searchFetcher = useFetcher<typeof action>();
  const linkFetcher = useFetcher<typeof action>();
  const urlFetcher = useFetcher<typeof action>();

  const c = data.contract;
  const busy = fetcher.state !== "idle";

  // Modals & local state
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseMonths, setPauseMonths] = useState("1");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState<string>(CANCEL_REASONS[0]);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const [priceEditLineId, setPriceEditLineId] = useState<string | null>(null);
  const [priceEditValue, setPriceEditValue] = useState("");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<PickerMode>("add");
  const [pickerLineId, setPickerLineId] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [giftCycle, setGiftCycle] = useState(String(c.ordersCount + 1));

  const [nextDate, setNextDate] = useState(
    c.nextBillingDate ? c.nextBillingDate.slice(0, 10) : "",
  );
  const [frequency, setFrequency] = useState(c.frequencyToken);
  const [backupMethod, setBackupMethod] = useState(c.backupPaymentMethodId ?? "");

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantPercent, setGrantPercent] = useState("10");
  const [grantCycles, setGrantCycles] = useState("2");
  const [grantReason, setGrantReason] = useState("");

  const [refundAttemptId, setRefundAttemptId] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState("");

  const [dunningCancelOpen, setDunningCancelOpen] = useState(false);

  const [address, setAddress] = useState({
    firstName: data.address.firstName ?? "",
    lastName: data.address.lastName ?? "",
    company: data.address.company ?? "",
    address1: data.address.address1 ?? "",
    address2: data.address.address2 ?? "",
    city: data.address.city ?? "",
    provinceCode: data.address.provinceCode ?? "",
    countryCode: data.address.countryCode ?? "",
    zip: data.address.zip ?? "",
    phone: data.address.phone ?? "",
  });

  const [timelineCategory, setTimelineCategory] = useState<string>("all");
  const [activePayloadId, setActivePayloadId] = useState<string | null>(null);

  const openedUrlRef = useRef<string | null>(null);
  useEffect(() => {
    const url = urlFetcher.data?.updateUrl;
    if (urlFetcher.state === "idle" && url && openedUrlRef.current !== url) {
      openedUrlRef.current = url;
      window.open(url, "_blank", "noopener");
    }
  }, [urlFetcher.state, urlFetcher.data]);

  const submit = (intent: string, fields: Record<string, string> = {}) => {
    fetcher.submit({ intent, ...fields }, { method: "post" });
  };

  const filteredEvents = useMemo(
    () =>
      timelineCategory === "all"
        ? data.events
        : data.events.filter((e) => e.type.startsWith(`${timelineCategory}.`)),
    [data.events, timelineCategory],
  );

  const refundAttempt =
    data.attempts.find((a) => a.id === refundAttemptId) ?? null;

  const pickVariant = (variantId: string) => {
    if (pickerMode === "swap" && pickerLineId) {
      submit("swapLine", { lineId: pickerLineId, variantId });
    } else if (pickerMode === "addon") {
      submit("addAddon", { variantId, quantity: "1" });
    } else if (pickerMode === "gift") {
      submit("addGift", { variantId, cycleIndex: giftCycle });
    } else {
      submit("addProduct", { variantId, quantity: "1" });
    }
    setPickerOpen(false);
  };

  const openPicker = (mode: PickerMode, lineId?: string) => {
    setPickerMode(mode);
    setPickerLineId(lineId ?? null);
    setPickerQuery("");
    setPickerOpen(true);
  };

  const lastResult = fetcher.data;

  return (
    <Page
      title={c.name}
      subtitle={`${c.email}${c.phone ? ` · ${c.phone}` : ""}`}
      backAction={{ content: "Subscribers", url: "/app/subscribers" }}
      titleMetadata={
        <InlineStack gap="200">
          <Badge tone={statusTone(c.status)}>{c.status}</Badge>
          {c.isPrepaid ? (
            <Badge tone="info">{`Prepaid${c.prepaidDeliveriesRemaining != null ? ` (${c.prepaidDeliveriesRemaining} left)` : ""}`}</Badge>
          ) : null}
          {c.grandfathered ? <Badge tone="attention">Grandfathered</Badge> : null}
          {c.lockedUntil ? (
            <Badge tone="info">{`Locked until ${new Date(c.lockedUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}</Badge>
          ) : null}
          {c.cancelScheduledAt ? (
            <Badge tone="warning">{`Cancels ${new Date(c.cancelScheduledAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}</Badge>
          ) : null}
          {c.merged ? <Badge tone="new">Merged box</Badge> : null}
          {c.ownership === OWNERSHIP_FOREIGN ? (
            <Badge tone="warning">Another app</Badge>
          ) : null}
          {c.ownership === OWNERSHIP_UNKNOWN ? (
            <Badge tone="attention">Unattributed</Badge>
          ) : null}
          <Badge tone={(c.churnRiskScore ?? 0) >= 0.66 ? "critical" : (c.churnRiskScore ?? 0) >= 0.33 ? "warning" : "success"}>
            {`Risk ${(c.churnRiskScore ?? 0).toFixed(2)}`}
          </Badge>
        </InlineStack>
      }
    >
      <BlockStack gap="400">
        {lastResult && !lastResult.ok && lastResult.error ? (
          <Banner tone="critical" title="Action failed">
            <p>{lastResult.error}</p>
          </Banner>
        ) : null}
        {lastResult && lastResult.ok && lastResult.message ? (
          <Banner tone="success">
            <p>{lastResult.message}</p>
          </Banner>
        ) : null}

        {/* This subscription is not Cellexia's. The cockpit still opens — the
            merchant must be able to look, and support questions arrive about
            these subscriptions too — but every support action below is REFUSED
            server-side (see ownershipRefusal in the action): charging, editing
            or emailing another app's contract collides with the app that owns
            it, and "Charge now" on it is precisely the duplicate charge the
            ownership column exists to prevent. */}
        {c.ownership !== OWNERSHIP_OURS ? (
          <Banner
            tone="warning"
            title={
              c.ownership === OWNERSHIP_FOREIGN
                ? "This subscription is managed by another app"
                : "This subscription could not be attributed to any app"
            }
          >
            <BlockStack gap="200">
              <p>
                {c.ownership === OWNERSHIP_FOREIGN
                  ? "It was created by another subscription app on this store. Cellexia will never bill it, email its customer, run dunning or win-back on it, or include it in analytics — and it does not appear in the Cellexia customer portal."
                  : "None of its lines carry a selling plan, so Cellexia cannot prove it is ours. It is treated as not ours: never billed, never emailed, excluded from analytics and from the customer portal."}
              </p>
              <p>
                {c.ownership === OWNERSHIP_FOREIGN
                  ? "To move this customer to Cellexia, cancel the subscription in the other app first, then re-create it here — never leave both apps billing the same subscription."
                  : "If it is in fact yours (e.g. imported after cancelling it in another app), claim it from the Subscribers list."}
              </p>
              <p>
                {c.ownership === OWNERSHIP_FOREIGN
                  ? "The support actions on this page are disabled for it: pausing, cancelling, editing items, changing the schedule, charging now and the customer emails all refuse, because they would act on a subscription another app is billing."
                  : "The support actions on this page refuse until it is claimed — Cellexia does not charge, email or edit a subscription it cannot prove is its own."}
              </p>
            </BlockStack>
          </Banner>
        ) : null}

        {/* Quick actions */}
        <Card>
          <InlineStack gap="200" wrap>
            {c.status === "PAUSED" || c.status === "FAILED" ? (
              <Button loading={busy} onClick={() => submit("resume")}>
                Resume
              </Button>
            ) : (
              <Button
                disabled={c.status !== "ACTIVE"}
                onClick={() => setPauseOpen(true)}
              >
                Pause
              </Button>
            )}
            {c.cancelScheduledAt && c.status !== "CANCELLED" ? (
              <Button loading={busy} onClick={() => submit("keepScheduled")}>
                Keep (clear scheduled cancel)
              </Button>
            ) : null}
            <Button
              tone="critical"
              disabled={c.status === "CANCELLED"}
              onClick={() => setCancelOpen(true)}
            >
              {c.cancelScheduledAt ? "Cancel now" : "Cancel"}
            </Button>
            <Button
              variant="primary"
              disabled={c.status === "CANCELLED"}
              onClick={() => setChargeOpen(true)}
            >
              Charge now
            </Button>
            <Button loading={busy && fetcher.formData?.get("intent") === "sendCardEmail"} onClick={() => submit("sendCardEmail")}>
              Send card-update email
            </Button>
            <Button
              loading={linkFetcher.state !== "idle"}
              onClick={() => {
                setCopied(false);
                setLinkOpen(true);
                linkFetcher.submit({ intent: "portalLink" }, { method: "post" });
              }}
            >
              Portal login link
            </Button>
          </InlineStack>
        </Card>

        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* Items */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Items
                    </Text>
                    <ButtonGroup>
                      <Button onClick={() => openPicker("add")}>Add product</Button>
                      <Button onClick={() => openPicker("addon")}>
                        One-time add-on
                      </Button>
                    </ButtonGroup>
                  </InlineStack>
                  <Divider />
                  {data.lines.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No items on this subscription.
                    </Text>
                  ) : (
                    data.lines.map((line) => (
                      <Box key={line.id} paddingBlockEnd="200">
                        <InlineStack gap="300" blockAlign="center" wrap={false}>
                          <Thumbnail
                            source={line.imageUrl ?? ""}
                            alt={line.title}
                            size="small"
                          />
                          <Box width="100%">
                            <BlockStack gap="050">
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="span" fontWeight="semibold">
                                  {line.title}
                                </Text>
                                {line.isGift ? <Badge tone="new">Gift</Badge> : null}
                                {line.isOneTimeAddon ? (
                                  <Badge tone="info">One-time</Badge>
                                ) : null}
                              </InlineStack>
                              <Text as="span" variant="bodySm" tone="subdued">
                                {[line.variantTitle, line.sku]
                                  .filter(Boolean)
                                  .join(" · ") || " "}
                              </Text>
                            </BlockStack>
                          </Box>
                          <Popover
                            active={priceEditLineId === line.id}
                            onClose={() => setPriceEditLineId(null)}
                            activator={
                              <Button
                                variant="plain"
                                disabled={busy || line.isOneTimeAddon}
                                accessibilityLabel={`Edit unit price for ${line.title}`}
                                onClick={() => {
                                  setPriceEditValue(
                                    decimalStringFromCents(line.priceCents),
                                  );
                                  setPriceEditLineId(
                                    priceEditLineId === line.id ? null : line.id,
                                  );
                                }}
                              >
                                {line.price}
                              </Button>
                            }
                          >
                            <Box padding="300" minWidth="240px">
                              <BlockStack gap="200">
                                <TextField
                                  label={`Unit price (${c.currencyCode})`}
                                  type="number"
                                  value={priceEditValue}
                                  onChange={setPriceEditValue}
                                  min={0}
                                  step={0.01}
                                  autoComplete="off"
                                  helpText="Overrides the recurring price for this line on all future cycles."
                                />
                                <InlineStack gap="200">
                                  <Button
                                    size="slim"
                                    variant="primary"
                                    disabled={busy || !priceEditValue}
                                    onClick={() => {
                                      submit("setLinePrice", {
                                        lineId: line.id,
                                        price: priceEditValue,
                                      });
                                      setPriceEditLineId(null);
                                    }}
                                  >
                                    Save price
                                  </Button>
                                  <Button
                                    size="slim"
                                    onClick={() => setPriceEditLineId(null)}
                                  >
                                    Cancel
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Box>
                          </Popover>
                          <InlineStack gap="100" blockAlign="center" wrap={false}>
                            <Button
                              size="micro"
                              disabled={busy || line.quantity <= 1 || line.isOneTimeAddon}
                              onClick={() =>
                                submit("setQuantity", {
                                  lineId: line.id,
                                  quantity: String(line.quantity - 1),
                                })
                              }
                              accessibilityLabel="Decrease quantity"
                            >
                              −
                            </Button>
                            <Text as="span">{line.quantity}</Text>
                            <Button
                              size="micro"
                              disabled={busy || line.isOneTimeAddon}
                              onClick={() =>
                                submit("setQuantity", {
                                  lineId: line.id,
                                  quantity: String(line.quantity + 1),
                                })
                              }
                              accessibilityLabel="Increase quantity"
                            >
                              +
                            </Button>
                          </InlineStack>
                          <ButtonGroup>
                            <Button
                              size="slim"
                              disabled={busy || line.isOneTimeAddon}
                              onClick={() => openPicker("swap", line.id)}
                            >
                              Swap
                            </Button>
                            <Button
                              size="slim"
                              tone="critical"
                              disabled={busy}
                              onClick={() =>
                                submit("removeLine", { lineId: line.id })
                              }
                            >
                              Remove
                            </Button>
                          </ButtonGroup>
                        </InlineStack>
                      </Box>
                    ))
                  )}
                </BlockStack>
              </Card>

              {/* Schedule */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Schedule
                  </Text>
                  <InlineStack gap="400" blockAlign="end" wrap>
                    <TextField
                      label="Next billing date"
                      type="date"
                      value={nextDate}
                      onChange={setNextDate}
                      autoComplete="off"
                    />
                    <Button
                      disabled={busy || !nextDate}
                      onClick={() => submit("setNextDate", { date: nextDate })}
                    >
                      Save date
                    </Button>
                    <Select
                      label="Frequency"
                      options={data.frequencies.map((f) => ({
                        label: f.label,
                        value: f.token,
                      }))}
                      value={frequency}
                      onChange={setFrequency}
                    />
                    <Button
                      disabled={busy || frequency === c.frequencyToken}
                      onClick={() => submit("setFrequency", { frequency })}
                    >
                      Save frequency
                    </Button>
                  </InlineStack>
                  <InlineStack gap="200">
                    <Button disabled={busy || c.status !== "ACTIVE"} onClick={() => submit("skipNext")}>
                      Skip next cycle
                    </Button>
                    <Button disabled={busy} onClick={() => submit("unskipNext")}>
                      Un-skip
                    </Button>
                    <Text as="span" tone="subdued">
                      {`Skipped ${c.skipCount} time(s) so far · ${c.ordersCount} orders billed · ${c.lifetimeRevenue} lifetime`}
                    </Text>
                  </InlineStack>
                  {c.status === "PAUSED" && c.resumeAt ? (
                    <Banner tone="info">
                      <p>Paused — auto-resumes on {formatDate(c.resumeAt)}.</p>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Discounts & gifts */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Discounts and gifts
                    </Text>
                    <ButtonGroup>
                      <Button onClick={() => setGrantOpen(true)}>Grant discount</Button>
                      <Button onClick={() => openPicker("gift")}>Add gift</Button>
                    </ButtonGroup>
                  </InlineStack>
                  <Divider />
                  {data.discountGrants.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No discount grants.
                    </Text>
                  ) : (
                    data.discountGrants.map((g) => (
                      <InlineStack
                        key={g.id}
                        align="space-between"
                        blockAlign="center"
                      >
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone={g.active ? "success" : undefined}>
                            {`${g.percent}% · ${g.cyclesRemaining}/${g.cyclesTotal} cycles left`}
                          </Badge>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {`${g.type}${g.reason ? ` · ${g.reason}` : ""}${g.grantedBy ? ` · by ${g.grantedBy}` : ""}`}
                          </Text>
                        </InlineStack>
                        {g.active ? (
                          <Button
                            size="slim"
                            tone="critical"
                            disabled={busy}
                            onClick={() => submit("revokeGrant", { grantId: g.id })}
                          >
                            Revoke
                          </Button>
                        ) : null}
                      </InlineStack>
                    ))
                  )}
                  {data.giftGrants.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Gifts
                      </Text>
                      {data.giftGrants.map((g) => (
                        <InlineStack key={g.id} gap="200" blockAlign="center">
                          <Badge
                            tone={
                              g.status === "ADDED" || g.status === "SHIPPED"
                                ? "success"
                                : g.status === "SCHEDULED"
                                  ? "info"
                                  : undefined
                            }
                          >
                            {g.status}
                          </Badge>
                          <Text as="span" variant="bodySm">
                            {`Cycle ${g.cycleIndex} · ${g.variantId}`}
                          </Text>
                        </InlineStack>
                      ))}
                    </>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Refunds */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Recent charges and refunds
                  </Text>
                  <Divider />
                  {data.attempts.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No billing attempts yet.
                    </Text>
                  ) : (
                    data.attempts.map((a) => (
                      <InlineStack key={a.id} align="space-between" blockAlign="center">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge
                            tone={
                              a.status === "SUCCESS"
                                ? "success"
                                : a.status === "FAILED"
                                  ? "critical"
                                  : a.status === "PENDING"
                                    ? "attention"
                                    : "info"
                            }
                          >
                            {a.status}
                          </Badge>
                          <Text as="span" variant="bodySm">
                            {`Cycle ${a.cycleIndex} · attempt ${a.attemptNumber} · ${formatDate(a.scheduledFor)}`}
                            {a.orderName ? ` · ${a.orderName}` : ""}
                            {a.amount ? ` · ${a.amount}` : ""}
                            {a.errorCode ? ` · ${a.errorCode}` : ""}
                          </Text>
                        </InlineStack>
                        {a.status === "SUCCESS" && a.orderId ? (
                          <Button
                            size="slim"
                            onClick={() => {
                              setRefundAttemptId(a.id);
                              setRefundAmount(
                                a.amountCents != null
                                  ? decimalStringFromCents(a.amountCents)
                                  : "",
                              );
                            }}
                          >
                            Refund
                          </Button>
                        ) : null}
                      </InlineStack>
                    ))
                  )}
                </BlockStack>
              </Card>

              {/* Timeline */}
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Timeline
                    </Text>
                    <Box minWidth="200px">
                      <Select
                        label="Category"
                        labelHidden
                        options={EVENT_CATEGORIES.map((cat) => ({
                          label: cat === "all" ? "All events" : cat,
                          value: cat,
                        }))}
                        value={timelineCategory}
                        onChange={setTimelineCategory}
                      />
                    </Box>
                  </InlineStack>
                  <Divider />
                  {filteredEvents.length === 0 ? (
                    <Text as="p" tone="subdued">
                      No events in this category.
                    </Text>
                  ) : (
                    filteredEvents.map((e) => {
                      const category = e.type.split(".")[0] ?? "other";
                      return (
                        <InlineStack
                          key={e.id}
                          gap="200"
                          blockAlign="center"
                          wrap={false}
                        >
                          <Box minWidth="96px">
                            <Badge tone={categoryTone(category)}>{category}</Badge>
                          </Box>
                          <Box width="100%">
                            <Text as="span" variant="bodySm">
                              {e.type}
                              {e.actor ? ` · ${e.actor}` : ""}
                              {` · ${e.source}`}
                            </Text>
                          </Box>
                          <Box minWidth="80px">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {timeAgo(e.createdAt)}
                            </Text>
                          </Box>
                          <Popover
                            active={activePayloadId === e.id}
                            onClose={() => setActivePayloadId(null)}
                            activator={
                              <Button
                                size="micro"
                                variant="plain"
                                onClick={() =>
                                  setActivePayloadId(
                                    activePayloadId === e.id ? null : e.id,
                                  )
                                }
                              >
                                Payload
                              </Button>
                            }
                          >
                            <Box padding="300" maxWidth="420px">
                              <pre
                                style={{
                                  margin: 0,
                                  fontSize: 11,
                                  whiteSpace: "pre-wrap",
                                  wordBreak: "break-word",
                                }}
                              >
                                {e.payloadJson}
                              </pre>
                            </Box>
                          </Popover>
                        </InlineStack>
                      );
                    })
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              {/* Payment */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Payment
                  </Text>
                  <Text as="p">
                    {c.cardBrand || c.cardLast4
                      ? `${c.cardBrand ?? "Card"}${c.cardLast4 ? ` ending ${c.cardLast4}` : ""}${c.cardExpiry ? ` · exp ${c.cardExpiry}` : ""}${c.paymentInstrumentType ? ` · ${c.paymentInstrumentType}` : ""}`
                      : "No card details on the mirror."}
                  </Text>
                  {c.paymentMethodRevokedAt ? (
                    <Badge tone="critical">
                      {`Payment method removed ${timeAgo(c.paymentMethodRevokedAt)}`}
                    </Badge>
                  ) : null}
                  <Button
                    loading={urlFetcher.state !== "idle"}
                    onClick={() =>
                      urlFetcher.submit({ intent: "openUpdateUrl" }, { method: "post" })
                    }
                  >
                    Open secure card-update page
                  </Button>
                  {urlFetcher.state === "idle" && urlFetcher.data && !urlFetcher.data.updateUrl ? (
                    <Banner tone={urlFetcher.data.ok ? "info" : "critical"}>
                      <p>{urlFetcher.data.ok ? urlFetcher.data.message : urlFetcher.data.error}</p>
                    </Banner>
                  ) : null}
                  {data.paymentMethods ? (
                    <>
                      <Divider />
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingSm">
                          Methods on the customer's account
                        </Text>
                        {data.paymentMethods
                          .filter((m) => !m.revoked)
                          .map((m) => (
                            <InlineStack key={m.id} gap="200" blockAlign="center" wrap>
                              <Text as="span" variant="bodySm">
                                {m.label}
                              </Text>
                              {m.id === c.paymentMethodId ? (
                                <Badge tone="success">Primary</Badge>
                              ) : (
                                <Button
                                  size="slim"
                                  disabled={busy}
                                  onClick={() =>
                                    submit("makePrimary", { paymentMethodId: m.id })
                                  }
                                >
                                  Make primary
                                </Button>
                              )}
                              {m.id === c.backupPaymentMethodId ? (
                                <Badge tone="info">Backup</Badge>
                              ) : null}
                            </InlineStack>
                          ))}
                      </BlockStack>
                      {c.backupPaymentMethodId && c.backupSetBy && c.backupSetAt ? (
                        <Badge tone="info">
                          {`Backup set by ${c.backupSetBy.toLowerCase()} on ${formatDate(c.backupSetAt)}`}
                        </Badge>
                      ) : null}
                      <Select
                        label="Backup payment method"
                        options={[
                          { label: "None", value: "" },
                          ...data.paymentMethods
                            .filter((m) => !m.revoked)
                            .map((m) => ({ label: m.label, value: m.id })),
                        ]}
                        value={backupMethod}
                        onChange={setBackupMethod}
                        helpText="Tried automatically when a renewal fails on the primary card."
                      />
                      <Button
                        disabled={busy || backupMethod === (c.backupPaymentMethodId ?? "")}
                        onClick={() =>
                          submit("setBackup", { paymentMethodId: backupMethod })
                        }
                      >
                        Save backup method
                      </Button>
                    </>
                  ) : (
                    <Text as="p" tone="subdued">
                      Payment methods could not be loaded from Shopify.
                    </Text>
                  )}

                  {data.dunningCase ? (
                    <>
                      <Divider />
                      <BlockStack gap="200">
                        <InlineStack gap="200" blockAlign="center">
                          <Badge tone="warning">{data.dunningCase.state}</Badge>
                          <Text as="span" variant="bodySm">
                            {`Ladder step ${data.dunningCase.ladderStep} · ${data.dunningCase.emailsSent} emails · ${data.dunningCase.smsSent} SMS`}
                          </Text>
                        </InlineStack>
                        <Text as="p" variant="bodySm">
                          {data.dunningCase.declineHuman}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {`Opened ${timeAgo(data.dunningCase.openedAt)}${data.dunningCase.nextRetryAt ? ` · next retry ${formatDate(data.dunningCase.nextRetryAt)}` : ""}`}
                        </Text>
                        <ButtonGroup>
                          <Button
                            size="slim"
                            disabled={busy}
                            onClick={() =>
                              submit("dunningRetryNow", {
                                caseId: data.dunningCase!.id,
                              })
                            }
                          >
                            Retry now
                          </Button>
                          <Button
                            size="slim"
                            disabled={busy}
                            onClick={() =>
                              submit("dunningResolve", {
                                caseId: data.dunningCase!.id,
                              })
                            }
                          >
                            Mark resolved
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            disabled={busy}
                            onClick={() => setDunningCancelOpen(true)}
                          >
                            Move to cancelled
                          </Button>
                        </ButtonGroup>
                      </BlockStack>
                    </>
                  ) : null}
                </BlockStack>
              </Card>

              {/* Acquisition (data foundation — docs/DATA_FOUNDATION.md) */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Acquisition
                  </Text>
                  {!data.acquisition.captured &&
                  data.acquisition.timeToPurchaseSeconds == null ? (
                    <Text as="p" tone="subdued">
                      No acquisition data captured for this subscription. It is
                      collected automatically from the first (checkout) order
                      of new subscriptions; older and imported contracts have
                      none to collect.
                    </Text>
                  ) : (
                    <BlockStack gap="150">
                      {data.acquisition.originOrderName ||
                      data.acquisition.originOrderTotal ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            First order:
                          </Text>{" "}
                          {[
                            data.acquisition.originOrderName,
                            data.acquisition.originOrderTotal,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </Text>
                      ) : null}
                      {data.acquisition.sourceName ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            Source:
                          </Text>{" "}
                          {data.acquisition.sourceName}
                        </Text>
                      ) : null}
                      {data.acquisition.utm ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            UTM:
                          </Text>{" "}
                          {[
                            data.acquisition.utm.source,
                            data.acquisition.utm.medium,
                            data.acquisition.utm.campaign,
                          ]
                            .filter(Boolean)
                            .join(" / ") || "—"}
                        </Text>
                      ) : null}
                      {data.acquisition.countryCode || data.acquisition.city ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            Location:
                          </Text>{" "}
                          {[
                            data.acquisition.city,
                            data.acquisition.provinceCode,
                            data.acquisition.countryCode,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </Text>
                      ) : null}
                      {data.acquisition.deviceType ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            Device:
                          </Text>{" "}
                          {data.acquisition.deviceType}
                        </Text>
                      ) : null}
                      {data.acquisition.timeToPurchaseSeconds != null ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            Account to first order:
                          </Text>{" "}
                          {humanizeSeconds(
                            data.acquisition.timeToPurchaseSeconds,
                          )}
                        </Text>
                      ) : null}
                      {data.acquisition.unitsFirstOrder != null ? (
                        <Text as="p" variant="bodySm">
                          <Text as="span" fontWeight="semibold">
                            Units in first order:
                          </Text>{" "}
                          {data.acquisition.unitsFirstOrder}
                        </Text>
                      ) : null}
                      {data.acquisition.landingSite ? (
                        <Text as="p" variant="bodySm" tone="subdued" breakWord>
                          Landed on {data.acquisition.landingSite}
                          {data.acquisition.referringSite
                            ? ` (from ${data.acquisition.referringSite})`
                            : ""}
                        </Text>
                      ) : null}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Support requests (v1.28.0, P5.1) */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Support requests
                  </Text>
                  {data.supportRequests.length === 0 ? (
                    <Text as="p" tone="subdued">
                      None yet. Requests from the portal's Get-help form and
                      the cancel-flow support cards land here (and as a
                      SUPPORT_REQUEST alert).
                    </Text>
                  ) : (
                    <BlockStack gap="300">
                      {data.supportRequests.map((r) => (
                        <BlockStack gap="100" key={r.id}>
                          <InlineStack gap="200" blockAlign="center">
                            <Badge>{r.topic}</Badge>
                            {r.saveRequest ? (
                              <Badge tone="attention">Save request</Badge>
                            ) : null}
                            <Text as="span" variant="bodySm" tone="subdued">
                              {timeAgo(r.createdAt)}
                              {r.orderRef ? ` · order ${r.orderRef}` : ""}
                              {r.cancelReason ? ` · cancel flow (${r.cancelReason})` : ""}
                              {r.pushBackApplied ? " · next order pushed back 1 week" : ""}
                            </Text>
                          </InlineStack>
                          <Text as="p" variant="bodySm">
                            {r.message || "(no message)"}
                          </Text>
                          {r.cancelReasonDetail && r.cancelReasonDetail !== r.message ? (
                            <Text as="p" variant="bodySm" tone="subdued">
                              On the cancel survey they wrote: “{r.cancelReasonDetail}”
                            </Text>
                          ) : null}
                        </BlockStack>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Win-back episode (v1.28.0, P3.4) — read-only */}
              {data.winback ? (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Win-back
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Badge>{data.winback.status}</Badge>
                      <Text as="span" variant="bodySm" tone="subdued">
                        stage {data.winback.stage}
                        {data.winback.nextTouchAt
                          ? ` · next touch ${new Date(data.winback.nextTouchAt).toLocaleDateString("en-GB", { timeZone: data.tz })}`
                          : ""}
                      </Text>
                    </InlineStack>
                    <Text as="p" variant="bodySm">
                      Cancel reason:{" "}
                      {data.winback.reason ?? "not recorded (episode opened before v1.28.0)"}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Timed to the predicted empty date{" "}
                      {new Date(data.winback.predictedEmptyDate).toLocaleDateString("en-GB", { timeZone: data.tz })}
                      {data.winback.wonBackAt
                        ? ` · won back ${new Date(data.winback.wonBackAt).toLocaleDateString("en-GB", { timeZone: data.tz })}`
                        : ""}
                    </Text>
                  </BlockStack>
                </Card>
              ) : null}

              {/* Post-purchase survey (v1.21.0) */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Survey
                  </Text>
                  {data.survey == null ? (
                    <Text as="p" tone="subdued">
                      No post-purchase survey for this subscription. It is
                      shown on the order confirmation page of new subscription
                      orders; older contracts predate it.
                    </Text>
                  ) : data.survey.answeredAt == null ? (
                    <Text as="p" tone="subdued">
                      Shown on the confirmation page but not answered —
                      skipping the survey is itself a churn signal the risk
                      score already reflects.
                    </Text>
                  ) : (
                    <BlockStack gap="150">
                      {SURVEY_CARD_ROWS.map(({ key, label, options }) => {
                        const answer = data.survey?.answers?.[key];
                        return (
                          <Text as="p" variant="bodySm" key={key}>
                            <Text as="span" fontWeight="semibold">
                              {label}:
                            </Text>{" "}
                            {answer ? (options[answer] ?? answer) : "—"}
                          </Text>
                        );
                      })}
                      {!data.survey.completedAt ? (
                        <Text as="p" variant="bodySm" tone="subdued">
                          Partially answered — missing answers are shown as —.
                        </Text>
                      ) : null}
                      {data.survey.holdout ? (
                        <InlineStack gap="200">
                          <Badge tone="attention">Holdout</Badge>
                          <Text as="p" variant="bodySm" tone="subdued">
                            Excluded from survey-triggered flows (untreated
                            comparison group).
                          </Text>
                        </InlineStack>
                      ) : null}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Predicted value (v1.21.0) */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Predicted value
                  </Text>
                  {data.predictedValue == null ? (
                    <Text as="p" tone="subdued">
                      Not scored yet. Predicted lifetime gross profit is
                      computed nightly for active subscriptions once the
                      analytics jobs have run.
                    </Text>
                  ) : (
                    <BlockStack gap="150">
                      {data.predictedValue.horizons.map((h) => (
                        <InlineStack
                          key={h.key}
                          align="space-between"
                          blockAlign="center"
                        >
                          <Text as="p" variant="bodySm">
                            <Text as="span" fontWeight="semibold">
                              {h.label}:
                            </Text>{" "}
                            {h.amount}
                          </Text>
                          <Badge
                            tone={
                              h.grade === "A" || h.grade === "B"
                                ? "success"
                                : h.grade === "C"
                                  ? "attention"
                                  : "warning"
                            }
                          >
                            {`Grade ${h.grade}`}
                          </Badge>
                        </InlineStack>
                      ))}
                      <Text as="p" variant="bodySm" tone="subdued">
                        Expected cumulative gross profit from subscription
                        start, given the store&apos;s retention curve and this
                        subscriber&apos;s risk score
                        {data.predictedValue.riskTilt !== 1
                          ? ` (risk tilt ×${data.predictedValue.riskTilt})`
                          : ""}
                        . Grades reflect how much history backs each horizon —
                        long horizons on a young store are directional only.
                        {data.predictedValue.estimatedCosts
                          ? " Partly estimated costs (COGS fallback or flat VAT) are included."
                          : ""}
                      </Text>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>

              {/* Address */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Delivery address
                  </Text>
                  <InlineStack gap="200">
                    <Box width="48%">
                      <TextField
                        label="First name"
                        value={address.firstName}
                        onChange={(v) => setAddress({ ...address, firstName: v })}
                        autoComplete="off"
                      />
                    </Box>
                    <Box width="48%">
                      <TextField
                        label="Last name"
                        value={address.lastName}
                        onChange={(v) => setAddress({ ...address, lastName: v })}
                        autoComplete="off"
                      />
                    </Box>
                  </InlineStack>
                  <TextField
                    label="Company"
                    value={address.company}
                    onChange={(v) => setAddress({ ...address, company: v })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Address line 1"
                    value={address.address1}
                    onChange={(v) => setAddress({ ...address, address1: v })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Address line 2"
                    value={address.address2}
                    onChange={(v) => setAddress({ ...address, address2: v })}
                    autoComplete="off"
                  />
                  <InlineStack gap="200">
                    <Box width="48%">
                      <TextField
                        label="City"
                        value={address.city}
                        onChange={(v) => setAddress({ ...address, city: v })}
                        autoComplete="off"
                      />
                    </Box>
                    <Box width="48%">
                      <TextField
                        label="Postcode"
                        value={address.zip}
                        onChange={(v) => setAddress({ ...address, zip: v })}
                        autoComplete="off"
                      />
                    </Box>
                  </InlineStack>
                  <InlineStack gap="200">
                    <Box width="48%">
                      <TextField
                        label="Province code"
                        value={address.provinceCode}
                        onChange={(v) => setAddress({ ...address, provinceCode: v })}
                        autoComplete="off"
                      />
                    </Box>
                    <Box width="48%">
                      <TextField
                        label="Country code"
                        value={address.countryCode}
                        onChange={(v) => setAddress({ ...address, countryCode: v })}
                        autoComplete="off"
                        placeholder="GB"
                      />
                    </Box>
                  </InlineStack>
                  <TextField
                    label="Phone"
                    value={address.phone}
                    onChange={(v) => setAddress({ ...address, phone: v })}
                    autoComplete="off"
                  />
                  <Button
                    variant="primary"
                    loading={busy && fetcher.formData?.get("intent") === "updateAddress"}
                    onClick={() => submit("updateAddress", address)}
                  >
                    Save address
                  </Button>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {/* ── Modals ─────────────────────────────────────────────────────────── */}

      <Modal
        open={pauseOpen}
        onClose={() => setPauseOpen(false)}
        title="Pause subscription"
        primaryAction={{
          content: "Pause",
          loading: busy,
          onAction: () => {
            submit("pause", { months: pauseMonths });
            setPauseOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPauseOpen(false) }]}
      >
        <Modal.Section>
          <Select
            label="Pause for"
            options={Array.from({ length: data.pauseMaxMonths }, (_, i) => ({
              label: `${i + 1} month${i > 0 ? "s" : ""}`,
              value: String(i + 1),
            }))}
            value={pauseMonths}
            onChange={setPauseMonths}
          />
        </Modal.Section>
      </Modal>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancel subscription"
        primaryAction={{
          content: "Cancel subscription",
          destructive: true,
          loading: busy,
          onAction: () => {
            submit("cancel", { reason: cancelReason });
            setCancelOpen(false);
          },
        }}
        secondaryActions={[{ content: "Keep subscription", onAction: () => setCancelOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              This cancels the Shopify contract immediately. Win-back messaging
              will be scheduled automatically.
            </Text>
            <Select
              label="Cancellation reason"
              options={CANCEL_REASONS.map((r) => ({ label: r, value: r }))}
              value={cancelReason}
              onChange={setCancelReason}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={chargeOpen}
        onClose={() => setChargeOpen(false)}
        title="Charge now"
        primaryAction={{
          content: "Charge the card now",
          destructive: true,
          loading: busy,
          onAction: () => {
            submit("chargeNow");
            setChargeOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setChargeOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            This immediately bills the current cycle against the card on file
            (idempotent — a duplicate click can never double charge). The
            outcome arrives via webhook and shows in the timeline.
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={dunningCancelOpen}
        onClose={() => setDunningCancelOpen(false)}
        title="Cancel dunning case"
        primaryAction={{
          content: "Move case to cancelled",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (data.dunningCase) {
              submit("dunningCancelCase", { caseId: data.dunningCase.id });
            }
            setDunningCancelOpen(false);
          },
        }}
        secondaryActions={[{ content: "Keep case open", onAction: () => setDunningCancelOpen(false) }]}
      >
        <Modal.Section>
          <Text as="p">
            Stops all further automatic retries and reminders for this failed
            payment. The contract itself is not cancelled.
          </Text>
        </Modal.Section>
      </Modal>

      <Modal
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title="Portal login link"
        secondaryActions={[{ content: "Close", onAction: () => setLinkOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {linkFetcher.state !== "idle" ? (
              <Text as="p" tone="subdued">
                Generating link…
              </Text>
            ) : linkFetcher.data?.loginUrl ? (
              <>
                <TextField
                  label="One-tap login link"
                  value={linkFetcher.data.loginUrl}
                  readOnly
                  autoComplete="off"
                  multiline={2}
                />
                <InlineStack gap="200">
                  <Button
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        linkFetcher.data?.loginUrl ?? "",
                      );
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  Signs the customer straight into their portal — share it only
                  with the account owner.
                </Text>
              </>
            ) : (
              <Text as="p" tone="critical">
                {linkFetcher.data?.error ?? "Link could not be generated."}
              </Text>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title="Grant discount"
        primaryAction={{
          content: "Grant",
          loading: busy,
          onAction: () => {
            submit("grantDiscount", {
              percent: grantPercent,
              cycles: grantCycles,
              reason: grantReason,
            });
            setGrantOpen(false);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setGrantOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Percent"
              type="number"
              value={grantPercent}
              onChange={setGrantPercent}
              suffix="%"
              min={1}
              max={90}
              autoComplete="off"
            />
            <TextField
              label="Cycles"
              type="number"
              value={grantCycles}
              onChange={setGrantCycles}
              min={1}
              max={12}
              autoComplete="off"
            />
            <TextField
              label="Reason (internal)"
              value={grantReason}
              onChange={setGrantReason}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={refundAttempt != null}
        onClose={() => setRefundAttemptId(null)}
        title={`Refund ${refundAttempt?.orderName ?? "order"}`}
        primaryAction={{
          content: "Refund",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (refundAttempt) {
              submit("refund", {
                attemptId: refundAttempt.id,
                amount: refundAmount,
              });
            }
            setRefundAttemptId(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setRefundAttemptId(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              Refunds against the original payment transaction(s). Charged
              amount: {refundAttempt?.amount ?? "unknown"}.
            </Text>
            <TextField
              label={`Amount (${c.currencyCode})`}
              type="number"
              value={refundAmount}
              onChange={setRefundAmount}
              autoComplete="off"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={
          pickerMode === "swap"
            ? "Swap to a different product"
            : pickerMode === "addon"
              ? "Add a one-time add-on to the next order"
              : pickerMode === "gift"
                ? "Add a manual gift"
                : "Add a product"
        }
        secondaryActions={[{ content: "Close", onAction: () => setPickerOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {pickerMode === "gift" ? (
              <TextField
                label="Ship with billing cycle"
                type="number"
                value={giftCycle}
                onChange={setGiftCycle}
                autoComplete="off"
                helpText={`Next cycle is approximately ${c.ordersCount + 1}.`}
              />
            ) : null}
            <InlineStack gap="200" blockAlign="end">
              <Box width="70%">
                <TextField
                  label="Search products"
                  value={pickerQuery}
                  onChange={setPickerQuery}
                  autoComplete="off"
                  placeholder="Search by title"
                />
              </Box>
              <Button
                loading={searchFetcher.state !== "idle"}
                onClick={() =>
                  searchFetcher.submit(
                    { intent: "searchProducts", q: pickerQuery },
                    { method: "post" },
                  )
                }
              >
                Search
              </Button>
            </InlineStack>
            {(searchFetcher.data?.results ?? []).map((product) => (
              <Box key={product.id} paddingBlockStart="200">
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center">
                    <Thumbnail
                      source={product.imageUrl ?? ""}
                      alt={product.title}
                      size="small"
                    />
                    <BlockStack gap="050">
                      <Text as="span" fontWeight="semibold">
                        {product.title}
                      </Text>
                      {product.ongoingPct != null && pickerMode !== "gift" ? (
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`Ongoing subscription discount: ${product.ongoingPct}%`}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </InlineStack>
                  {product.variants.map((v) => (
                    <InlineStack key={v.id} align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm">
                        {v.title || "Default"}
                        {v.sku ? ` · ${v.sku}` : ""}
                        {" · "}
                        {pickerMode === "gift"
                          ? "free gift"
                          : v.discounted
                            ? `${v.discounted} (was ${v.price})`
                            : v.price}
                        {!v.available ? " · out of stock" : ""}
                      </Text>
                      <Button
                        size="slim"
                        disabled={busy}
                        onClick={() => pickVariant(v.id)}
                      >
                        Select
                      </Button>
                    </InlineStack>
                  ))}
                  <Divider />
                </BlockStack>
              </Box>
            ))}
            {searchFetcher.data && (searchFetcher.data.results ?? []).length === 0 ? (
              <Text as="p" tone="subdued">
                No products found.
              </Text>
            ) : null}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
