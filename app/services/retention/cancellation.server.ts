/**
 * [retention] Cancellation-flow orchestration.
 *
 * Session lifecycle:
 *   startCancellationSession → submitReason → getOffersForSession →
 *   (acceptOffer → SAVED)  |  (finalizeCancellation → CANCELLED)
 *   |  (expireCancellationSessionsJob → ABANDONED after 48h)
 *
 * Integrity rules encoded here:
 *  - The portal collects the customer's ACTUAL choice (delay weeks, pause
 *    days/date, swap target, …) and passes it as `chosenParams`; the service
 *    validates it strictly against the params the offer advertised and
 *    executes exactly what was promised — never a hidden default.
 *  - Session resolution is compare-and-set (updateMany on IN_PROGRESS):
 *    concurrent accepts / accept+finalize races cannot both execute.
 *  - Monetary offers re-check the cross-session one-paid-save window at
 *    accept time, not just at presentation time.
 *  - EDUCATION acceptance never resolves a session as SAVED on its own — it
 *    is recorded on the session and the flow stays open (the decline path
 *    remains visible), so save-rate analytics are not inflated by clicks
 *    that changed nothing.
 *
 * All state changes are audited with a CUSTOMER actor; contract mutations are
 * executed through services/core/contracts.server and wrapped in
 * withIdempotency so a double-submitted portal form can never double-fire.
 */
import { createHash } from "node:crypto";
import type { CancellationSession, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { addDays, isoDate } from "~/lib/dates";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import {
  KeepOneLineError,
  applyAccountCredit,
  cancelContract,
  delayByWeeks,
  getVariantInfo,
  pauseUntil,
  removeLineFromContract,
  skipNextShipment,
  swapLineVariant,
  switchCadence,
  updateLineQuantity,
} from "~/services/core/contracts.server";
import {
  getCostModel,
  metaByProductId,
  orderContribution,
} from "~/services/analytics/costModel.server";
import {
  buildOffersForReason,
  maxRationalSaveCostCents,
  orderValueCents,
} from "~/services/retention/saveOffers.server";
import type { SaveOfferContext } from "~/services/retention/saveOffers.server";
import { CANCEL_REASONS, parseJson } from "~/types/domain";
import type {
  CancelReason,
  ContractLineSummary,
  SaveOffer,
  SaveOfferType,
} from "~/types/domain";

// ─────────────────────────── Economics heuristic ──────────────────────────

/**
 * Analytics-style estimate of what a save may rationally cost.
 *
 * Heuristic (documented so analytics can later replace it with real survival
 * curves — the shape of the output stays the same):
 *  - avg order value    = totalRevenueCents / successfulOrders, falling back
 *                         to the current line total for brand-new contracts.
 *  - expected remaining = TYPICAL_LIFETIME_ORDERS (9 deliveries observed for
 *                         continuous-treatment subscribers) minus deliveries
 *                         already made, clamped to [2, 12]: even long-tenured
 *                         savers are worth ~2 more orders, and nobody is
 *                         assumed to be worth more than 12.
 *  - margin             = the contract's per-order contribution fraction from
 *                         the shop cost model (analytics/costModel.server:
 *                         COGS, shipping, fulfillment and payment fees —
 *                         orderContribution), clamped to [0, 1]. Fallback
 *                         0.70 only for garbage input.
 *  - pRetain            = probability a presented save actually retains.
 *                         Base save-rate 0.35, reduced by churn risk
 *                         (an already-disengaged subscriber is harder to
 *                         save): clamp(0.35 − 0.2 × churnRisk, 0.10, 0.35).
 *  - expectedFutureContributionCents = avgOrderValue × margin × remaining.
 *  - maxSaveCostCents   = floor(pRetain × expectedFutureContribution).
 */
export interface RetentionEconomicsInput {
  totalRevenueCents: number;
  successfulOrders: number;
  currentOrderValueCents: number;
  /** Value-weighted gross margin of the lines, 0..1. */
  avgGrossMargin: number;
  churnRiskScore: number | null;
}

export interface RetentionEconomics {
  avgOrderValueCents: number;
  expectedRemainingOrders: number;
  expectedFutureContributionCents: number;
  pRetain: number;
  maxSaveCostCents: number;
}

const TYPICAL_LIFETIME_ORDERS = 9;
const DEFAULT_GROSS_MARGIN = 0.7;
const BASE_SAVE_RATE = 0.35;

export function estimateRetentionEconomics(
  input: RetentionEconomicsInput,
): RetentionEconomics {
  const avgOrderValueCents =
    input.successfulOrders > 0
      ? Math.round(input.totalRevenueCents / input.successfulOrders)
      : Math.max(0, input.currentOrderValueCents);

  const expectedRemainingOrders = Math.min(
    12,
    Math.max(2, TYPICAL_LIFETIME_ORDERS - input.successfulOrders),
  );

  // 0 is a legitimate margin (a shop whose cost model says orders contribute
  // nothing must not pay for saves); the default only covers garbage input.
  const margin =
    input.avgGrossMargin >= 0 && input.avgGrossMargin <= 1
      ? input.avgGrossMargin
      : DEFAULT_GROSS_MARGIN;

  const expectedFutureContributionCents = Math.round(
    avgOrderValueCents * margin * expectedRemainingOrders,
  );

  const churn = input.churnRiskScore ?? 0.5;
  const pRetain = Math.min(
    BASE_SAVE_RATE,
    Math.max(0.1, BASE_SAVE_RATE - 0.2 * churn),
  );

  return {
    avgOrderValueCents,
    expectedRemainingOrders,
    expectedFutureContributionCents,
    pRetain,
    maxSaveCostCents: maxRationalSaveCostCents(
      pRetain,
      expectedFutureContributionCents,
    ),
  };
}

// ─────────────────────────── Internal loaders ─────────────────────────────

type ContractWithLines = NonNullable<
  Awaited<ReturnType<typeof loadContractWithLines>>
>;

async function loadContractWithLines(shop: string, contractId: string) {
  return prisma.subscriptionContract.findFirst({
    where: { id: contractId, shop },
    include: { lines: true },
  });
}

function toLineSummaries(contract: ContractWithLines): ContractLineSummary[] {
  return contract.lines.map((l) => ({
    id: l.id,
    shopifyProductId: l.shopifyProductId,
    shopifyVariantId: l.shopifyVariantId,
    title: l.title,
    quantity: l.quantity,
    currentPriceCents: l.currentPriceCents,
  }));
}

async function economicsForContract(
  contract: ContractWithLines,
): Promise<RetentionEconomics> {
  const lines = toLineSummaries(contract);
  // Margin source: the shop cost model (ANALYTICS-V2) — full per-order
  // contribution (COGS + shipping + fulfillment + payment fees), never a
  // locally computed product-margin average.
  const [model, metaMap] = await Promise.all([
    getCostModel(contract.shop),
    metaByProductId(
      contract.shop,
      lines.map((l) => l.shopifyProductId),
    ),
  ]);
  const contribution = orderContribution(
    {
      lines: lines.map((l) => ({
        priceCents: l.currentPriceCents,
        quantity: l.quantity,
        meta: metaMap.get(l.shopifyProductId) ?? null,
      })),
    },
    model,
  );
  // A negative contribution means saves are worth nothing — clamp to 0 so
  // maxSaveCostCents collapses to 0 rather than falling back to the default.
  const avgGrossMargin = Math.min(
    1,
    Math.max(0, contribution.contributionFraction),
  );

  return estimateRetentionEconomics({
    totalRevenueCents: contract.totalRevenueCents,
    successfulOrders: contract.successfulOrders,
    currentOrderValueCents: orderValueCents(toLineSummaries(contract)),
    avgGrossMargin,
    churnRiskScore: contract.churnRiskScore,
  });
}

// ─────────────────────────── Contract exports ─────────────────────────────

/**
 * A fresh Back-button resubmit within this window reuses the live session
 * instead of minting a duplicate (which would re-fire CANCELLATION_STARTED
 * automations for one human attempt).
 */
const SESSION_REUSE_WINDOW_MS = 60 * 60 * 1000;

export async function startCancellationSession(
  shop: string,
  contractId: string,
): Promise<CancellationSession> {
  const contract = await loadContractWithLines(shop, contractId);
  if (!contract) {
    throw new Error(`startCancellationSession: contract ${contractId} not found`);
  }

  // Reuse a young live session (Back-button / double submit): one human
  // attempt = one session = one CANCELLATION_STARTED emission.
  const existing = await prisma.cancellationSession.findFirst({
    where: { shop, contractId: contract.id, outcome: "IN_PROGRESS" },
    orderBy: { startedAt: "desc" },
  });
  if (
    existing &&
    existing.startedAt.getTime() > Date.now() - SESSION_REUSE_WINDOW_MS
  ) {
    return existing;
  }

  // Lazily sweep older zombies for this contract to ABANDONED so the funnel
  // report stays honest and stale offersJson can never be accepted later.
  await prisma.cancellationSession.updateMany({
    where: { shop, contractId: contract.id, outcome: "IN_PROGRESS" },
    data: { outcome: "ABANDONED", resolvedAt: new Date() },
  });

  const economics = await economicsForContract(contract);

  const session = await prisma.cancellationSession.create({
    data: {
      shop,
      contractId: contract.id,
      maxSaveCostCents: economics.maxSaveCostCents,
    },
  });

  await appendAudit({
    shop,
    actorType: "CUSTOMER",
    actorId: contract.shopifyCustomerId,
    action: "CANCELLATION_STARTED",
    subjectType: "CancellationSession",
    subjectId: session.id,
    payload: {
      contractId: contract.id,
      maxSaveCostCents: economics.maxSaveCostCents,
      pRetain: economics.pRetain,
      expectedFutureContributionCents:
        economics.expectedFutureContributionCents,
    },
  });

  await emitLifecycleEvent({
    shop,
    name: "CANCELLATION_STARTED",
    contractId: contract.id,
    shopifyCustomerId: contract.shopifyCustomerId,
    email: contract.customerEmail,
    payload: { sessionId: session.id },
    dedupeKey: `cancel-start:${session.id}`,
  });

  return session;
}

export async function submitReason(
  sessionId: string,
  reason: CancelReason,
  detail?: string,
): Promise<CancellationSession> {
  if (!CANCEL_REASONS.includes(reason)) {
    throw new Error(`submitReason: unknown reason ${String(reason)}`);
  }
  const session = await prisma.cancellationSession.update({
    where: { id: sessionId },
    data: { reason, reasonDetail: detail ?? null },
  });

  await appendAudit({
    shop: session.shop,
    actorType: "CUSTOMER",
    action: "CANCELLATION_REASON_SUBMITTED",
    subjectType: "CancellationSession",
    subjectId: session.id,
    payload: { reason, hasDetail: Boolean(detail) },
  });

  return session;
}

/** Days of predicted surplus beyond the next billing date that count as excess. */
const EXCESS_THRESHOLD_DAYS = 7;

/** Offer types that cost real money — limited to one save per contract per window. */
const MONETARY_OFFER_TYPES: readonly SaveOfferType[] = [
  "ACCOUNT_CREDIT",
  "TEMPORARY_DISCOUNT",
  "FREE_GIFT",
];

/** A paid save within this window suppresses further monetary offers. */
const RECENT_PAID_SAVE_WINDOW_DAYS = 30;

/**
 * Cross-session guard: has this contract collected a PAID concession in the
 * last RECENT_PAID_SAVE_WINDOW_DAYS (excluding the given session)? Checked at
 * offer presentation AND re-checked at accept time — per-session idempotency
 * keys cannot enforce a cross-session limit, and a stale tab holding an old
 * offers page must not be able to stack concessions.
 */
export async function hasRecentPaidSave(
  contractId: string,
  excludeSessionId?: string,
): Promise<boolean> {
  const recent = await prisma.cancellationSession.findFirst({
    where: {
      contractId,
      ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      outcome: "SAVED",
      saveCostCents: { gt: 0 },
      resolvedAt: { gte: addDays(new Date(), -RECENT_PAID_SAVE_WINDOW_DAYS) },
    },
  });
  return recent != null;
}

/**
 * PURE — carry a recorded EDUCATION acknowledgement forward when offers are
 * recomputed. getOffersForSession rebuilds offers from scratch on every
 * IN_PROGRESS load, but the EDUCATION redirect keeps the session IN_PROGRESS
 * by design — without this merge the very next loader run would rebuild the
 * EDUCATION offer WITHOUT the accepted flag, re-showing the card (breaking
 * the "not shown twice" invariant) and wiping the recorded reaction details,
 * while re-submissions are silently swallowed by the cancel-edu idempotency
 * key and the care-followup dedupe key.
 *
 * When the rebuilt list contains NO EDUCATION offer (reasons share one
 * session and some reasons build none — e.g. TOO_EXPENSIVE after
 * IRRITATION), the accepted offer is APPENDED rather than dropped: dropping
 * it would wipe the ack and details on a reason switch, re-showing the card
 * on the way back. Carrying it is inert — buildOfferViews skips accepted
 * EDUCATION offers and EDUCATION_ACK never mutates the contract — and the
 * existing merge re-applies the ack onto a fresh card when the reason
 * switches back.
 */
export function preserveEducationAck(
  previous: SaveOffer[],
  next: SaveOffer[],
): SaveOffer[] {
  const prevEducation = previous.find((o) => o.type === "EDUCATION");
  const prevParams = prevEducation?.params as
    | Record<string, unknown>
    | undefined;
  if (!prevEducation || !prevParams || prevParams.accepted !== true) {
    return next;
  }
  if (!next.some((o) => o.type === "EDUCATION")) {
    return [...next, prevEducation];
  }
  return next.map((o) =>
    o.type === "EDUCATION"
      ? {
          ...o,
          params: {
            ...o.params,
            accepted: true,
            ...(prevParams.acceptedAt != null
              ? { acceptedAt: prevParams.acceptedAt }
              : {}),
            ...(prevParams.details != null
              ? { details: prevParams.details }
              : {}),
          },
        }
      : o,
  );
}

export async function getOffersForSession(
  sessionId: string,
): Promise<SaveOffer[]> {
  const session = await prisma.cancellationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  if (session.outcome !== "IN_PROGRESS") {
    // Resolved sessions get the offers exactly as presented — never
    // recomputed or re-persisted after resolution.
    return parseJson<SaveOffer[]>(session.offersJson, []);
  }
  if (!session.reason) {
    throw new Error("getOffersForSession: submitReason must be called first");
  }
  const reason = session.reason as CancelReason;

  const contract = await prisma.subscriptionContract.findUniqueOrThrow({
    where: { id: session.contractId },
    include: { lines: { include: { depletion: true } } },
  });

  const lines: ContractLineSummary[] = contract.lines.map((l) => ({
    id: l.id,
    shopifyProductId: l.shopifyProductId,
    shopifyVariantId: l.shopifyVariantId,
    title: l.title,
    quantity: l.quantity,
    currentPriceCents: l.currentPriceCents,
  }));

  // Depletion excess flag: any line predicted to run out comfortably after
  // the next billing date means product is stacking up at home.
  const excessCutoff = addDays(
    contract.nextBillingDate ?? new Date(),
    EXCESS_THRESHOLD_DAYS,
  );
  const hasExcessInventory = contract.lines.some(
    (l) =>
      l.depletion?.predictedRunOutAt != null &&
      l.depletion.predictedRunOutAt.getTime() > excessCutoff.getTime(),
  );

  // Swap candidates: active, subscribable products addressing the same
  // concerns as the current lines, excluding what the customer already has.
  const currentProductIds = lines.map((l) => l.shopifyProductId);
  const currentMetas = await prisma.productMeta.findMany({
    where: { shop: session.shop, shopifyProductId: { in: currentProductIds } },
    select: { concern: true },
  });
  const concerns = [
    ...new Set(currentMetas.map((m) => m.concern).filter((c): c is string => !!c)),
  ];
  const swapMetas = await prisma.productMeta.findMany({
    where: {
      shop: session.shop,
      active: true,
      subscribable: true,
      shopifyProductId: { notIn: currentProductIds },
      ...(concerns.length > 0 ? { concern: { in: concerns } } : {}),
    },
    orderBy: [{ heroRank: "asc" }],
    take: 5,
    select: { shopifyProductId: true },
  });

  // Complimentary-gift fulfilment target: only a merchant-configured variant
  // makes FREE_GIFT presentable (the fulfilment engine places it as a
  // zero-priced NEXT_ONLY add-on — no config means no gift offer, ever).
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const rawGift = settingsObj.retentionGiftVariantGid;
  const giftVariantGid =
    typeof rawGift === "string" &&
    rawGift.startsWith("gid://shopify/ProductVariant/")
      ? rawGift
      : null;

  const economics = await economicsForContract(contract);
  const ctx: SaveOfferContext = {
    expectedFutureContributionCents: economics.expectedFutureContributionCents,
    pRetain: economics.pRetain,
    lines,
    intervalWeeks: contract.intervalWeeks,
    hasExcessInventory,
    alternatives: {
      productSwapCandidates: swapMetas.map((m) => m.shopifyProductId),
    },
    giftVariantGid,
  };

  // Cross-session guard: a contract that already collected a paid concession
  // recently must not be able to farm monetary offers by minting new
  // sessions — per-session idempotency keys cannot enforce this limit.
  const recentPaidSave = await hasRecentPaidSave(session.contractId, session.id);

  // Build reason-specific offers, then re-apply the ceiling stored at session
  // start (the number the merchant saw and the flow committed to).
  const cap = session.maxSaveCostCents ?? economics.maxSaveCostCents;
  const rebuilt = buildOffersForReason(reason, ctx).filter(
    (o) =>
      o.costCents <= cap &&
      (!recentPaidSave || !MONETARY_OFFER_TYPES.includes(o.type)),
  );

  // An EDUCATION acknowledgement already recorded on this session survives
  // the recompute — the card stays hidden and the details stay recorded.
  const offers = preserveEducationAck(
    parseJson<SaveOffer[]>(session.offersJson, []),
    rebuilt,
  );

  // Only persist (and audit) when the offers actually changed: a plain page
  // refresh must not spam CANCELLATION_OFFERS_PRESENTED audit rows.
  const serialized = JSON.stringify(offers);
  if (serialized !== session.offersJson) {
    await prisma.cancellationSession.update({
      where: { id: session.id },
      data: { offersJson: serialized },
    });

    await appendAudit({
      shop: session.shop,
      actorType: "CUSTOMER",
      actorId: contract.shopifyCustomerId,
      action: "CANCELLATION_OFFERS_PRESENTED",
      subjectType: "CancellationSession",
      subjectId: session.id,
      payload: {
        reason,
        offerTypes: offers.map((o) => o.type),
        capCents: cap,
        hasExcessInventory,
      },
    });
  }

  return offers;
}

// ─────────────────────────── Choice validation (pure) ─────────────────────

/**
 * The customer's chosen parameters did not match what the offer advertised.
 * Routes surface this as a friendly "please pick one of the options" message,
 * never a 500.
 */
export class OfferChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferChoiceError";
  }
}

/**
 * PURE — whether accepting this EDUCATION offer records a care follow-up
 * (an audit row + ops-feed event that someone will personally act on). True
 * only when the offer collects details or routes to customer care. The
 * acknowledgement path below and the portal's confirmation banner both use
 * this single predicate, so the flow never promises outreach it did not
 * actually record.
 */
export function educationCareFollowUp(
  params: Record<string, unknown> | null | undefined,
): boolean {
  return params?.collectDetails === true || params?.route === "CUSTOMER_CARE";
}

/** Exactly what executeOffer will do — resolved and validated up front. */
export type OfferExecutionPlan =
  | {
      kind: "EDUCATION_ACK";
      details: string | null;
      collectDetails: boolean;
      route: string | null;
    }
  | { kind: "SKIP_NEXT" }
  | { kind: "DELAY_WEEKS"; weeks: number }
  | { kind: "SWITCH_CADENCE"; intervalWeeks: number }
  | { kind: "CHANGE_QUANTITY"; lineId: string; quantity: number }
  | { kind: "PRODUCT_SWAP"; lineId: string; newVariantGid: string }
  | { kind: "REMOVE_LINE"; lineId: string }
  | { kind: "PAUSE_UNTIL"; resumeDate: Date }
  | { kind: "ACCOUNT_CREDIT"; amountCents: number }
  | { kind: "TEMPORARY_DISCOUNT"; amountCents: number }
  | { kind: "FREE_GIFT"; variantGid: string };

/** Bounded custom pause window (days from now) when a resume date is chosen. */
export const CUSTOM_PAUSE_MIN_DAYS = 1;
export const CUSTOM_PAUSE_MAX_DAYS = 180;

/** Advertised percent for TEMPORARY_DISCOUNT when the offer omits it. */
export const DEFAULT_TEMPORARY_DISCOUNT_PERCENT = 15;

/**
 * PURE — the one-cycle credit that honours a "percentOff your next delivery"
 * promise against the LIVE order value, capped by the session's save budget.
 * The offer card promises a PERCENTAGE, but execution applies a fixed-amount
 * credit — recomputing at accept time keeps the two aligned when the
 * contract's composition changed between presentation and accept (a stale
 * fixed amount over-credits a shrunk order and under-credits a grown one).
 */
export function liveDiscountAmountCents(
  liveOrderValueCents: number,
  percentOff: number,
  capCents: number | null,
): number {
  const percent =
    Number.isFinite(percentOff) && percentOff > 0
      ? percentOff
      : DEFAULT_TEMPORARY_DISCOUNT_PERCENT;
  const amount = Math.round((Math.max(0, liveOrderValueCents) * percent) / 100);
  return capCents != null ? Math.min(amount, capCents) : amount;
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function numberOptions(raw: unknown): number[] {
  return Array.isArray(raw)
    ? raw
        .map((v) => asFiniteNumber(v))
        .filter((v): v is number => v != null)
    : [];
}

/**
 * PURE — resolve an accepted offer plus the customer's `chosenParams` into a
 * concrete execution plan, validating every choice STRICTLY against the
 * params the offer advertised (persisted in the session's offersJson):
 *  - delay weeks must be one of delayWeeksOptions;
 *  - pause days must be one of daysOptions, or a custom resume date
 *    1..180 days out only when customResumeDateAllowed;
 *  - new cadence must be one of intervalWeeksOptions;
 *  - removed line must be one of lineOptions;
 *  - a PRODUCT_SWAP REQUIRES a chosen line + variant (executing it without a
 *    target was the old silent no-op bug — refuse instead);
 *  - EDUCATION is an acknowledgement, never a structural change — it maps to
 *    EDUCATION_ACK and the caller must NOT resolve the session as SAVED.
 * Offers that advertise no choices execute their advertised default.
 */
export function resolveOfferExecution(
  offer: SaveOffer,
  chosen: Record<string, unknown> | undefined,
  now: Date = new Date(),
): OfferExecutionPlan {
  const params = offer.params as Record<string, unknown>;

  switch (offer.type) {
    case "EDUCATION": {
      const collectDetails = params.collectDetails === true;
      const rawDetails =
        typeof chosen?.details === "string" ? chosen.details.trim() : "";
      if (collectDetails && rawDetails.length === 0) {
        throw new OfferChoiceError(
          "Please tell us what you experienced so our care team can review it with you.",
        );
      }
      return {
        kind: "EDUCATION_ACK",
        details: rawDetails.length > 0 ? rawDetails.slice(0, 2000) : null,
        collectDetails,
        route: typeof params.route === "string" ? params.route : null,
      };
    }

    case "CHANGE_DELIVERY_DATE": {
      if (params.action === "SKIP_NEXT") return { kind: "SKIP_NEXT" };
      const options = numberOptions(params.delayWeeksOptions);
      const fallback = asFiniteNumber(params.defaultDelayWeeks) ?? 4;
      const weeks = asFiniteNumber(chosen?.delayWeeks) ?? fallback;
      if (options.length > 0 ? !options.includes(weeks) : weeks !== fallback) {
        throw new OfferChoiceError(
          "Please choose one of the delay options offered.",
        );
      }
      return { kind: "DELAY_WEEKS", weeks };
    }

    case "CHANGE_FREQUENCY": {
      const options = numberOptions(params.intervalWeeksOptions);
      const fallback = asFiniteNumber(params.defaultIntervalWeeks);
      const intervalWeeks = asFiniteNumber(chosen?.intervalWeeks) ?? fallback;
      if (
        intervalWeeks == null ||
        intervalWeeks < 1 ||
        (options.length > 0
          ? !options.includes(intervalWeeks)
          : intervalWeeks !== fallback)
      ) {
        throw new OfferChoiceError(
          "Please choose one of the delivery rhythms offered.",
        );
      }
      return { kind: "SWITCH_CADENCE", intervalWeeks };
    }

    case "CHANGE_QUANTITY": {
      const lineId = typeof params.lineId === "string" ? params.lineId : "";
      const current = asFiniteNumber(params.currentQuantity);
      const fallback = asFiniteNumber(params.defaultQuantity);
      const quantity = asFiniteNumber(chosen?.quantity) ?? fallback;
      if (!lineId || quantity == null || fallback == null) {
        throw new OfferChoiceError("This offer is missing its quantity details.");
      }
      const withinAdvertised =
        current != null
          ? Number.isInteger(quantity) && quantity >= 1 && quantity < current
          : quantity === fallback;
      if (!withinAdvertised) {
        throw new OfferChoiceError(
          "Please choose a smaller amount than you receive today.",
        );
      }
      return { kind: "CHANGE_QUANTITY", lineId, quantity };
    }

    case "PRODUCT_SWAP": {
      // The old executor silently no-opped (and recorded a save!) when no
      // variant was chosen. A swap without a target is not a swap.
      const lineId = typeof chosen?.lineId === "string" ? chosen.lineId : "";
      const newVariantGid =
        typeof chosen?.newVariantGid === "string" ? chosen.newVariantGid : "";
      if (!lineId || !newVariantGid.startsWith("gid://shopify/ProductVariant/")) {
        throw new OfferChoiceError(
          "Please pick the product to change and its replacement first.",
        );
      }
      return { kind: "PRODUCT_SWAP", lineId, newVariantGid };
    }

    case "REMOVE_ITEM": {
      const suggested =
        typeof params.suggestedLineId === "string" ? params.suggestedLineId : "";
      const optionIds = Array.isArray(params.lineOptions)
        ? (params.lineOptions as Array<Record<string, unknown>>)
            .map((o) => (typeof o.lineId === "string" ? o.lineId : ""))
            .filter(Boolean)
        : [];
      const allowed = new Set([...optionIds, ...(suggested ? [suggested] : [])]);
      const lineId =
        (typeof chosen?.lineId === "string" && chosen.lineId) || suggested;
      if (!lineId || !allowed.has(lineId)) {
        throw new OfferChoiceError(
          "Please choose which product to remove from your plan.",
        );
      }
      return { kind: "REMOVE_LINE", lineId };
    }

    case "TEMPORARY_PAUSE": {
      const customAllowed = params.customResumeDateAllowed === true;
      const rawDate =
        typeof chosen?.resumeDate === "string" ? chosen.resumeDate.trim() : "";
      if (rawDate) {
        if (!customAllowed) {
          throw new OfferChoiceError(
            "Please choose one of the pause lengths offered.",
          );
        }
        const parsed = new Date(rawDate);
        if (Number.isNaN(parsed.getTime())) {
          throw new OfferChoiceError("That resume date could not be read.");
        }
        // CALENDAR-granularity bounds, matching what the portal advertises:
        // the date input's min is isoDate(now + 1 day) ("tomorrow"), but a
        // "YYYY-MM-DD" value parses to UTC midnight, which is < now + 24h at
        // almost every moment of the day — an instant comparison would refuse
        // the very minimum date the picker itself offered.
        const parsedIso = isoDate(parsed);
        if (
          parsedIso < isoDate(addDays(now, CUSTOM_PAUSE_MIN_DAYS)) ||
          parsedIso > isoDate(addDays(now, CUSTOM_PAUSE_MAX_DAYS))
        ) {
          throw new OfferChoiceError(
            "Please pick a resume date between tomorrow and six months from now.",
          );
        }
        return { kind: "PAUSE_UNTIL", resumeDate: parsed };
      }
      const options = numberOptions(params.daysOptions);
      const fallback = asFiniteNumber(params.defaultDays) ?? 30;
      const days = asFiniteNumber(chosen?.days) ?? fallback;
      if (options.length > 0 ? !options.includes(days) : days !== fallback) {
        throw new OfferChoiceError(
          "Please choose one of the pause lengths offered.",
        );
      }
      return {
        kind: "PAUSE_UNTIL",
        resumeDate: addDays(now, Math.min(Math.max(days, 1), 180)),
      };
    }

    case "ACCOUNT_CREDIT": {
      const amountCents = asFiniteNumber(params.amountCents);
      if (amountCents == null || amountCents <= 0) {
        throw new Error("acceptOffer: ACCOUNT_CREDIT missing amountCents");
      }
      return { kind: "ACCOUNT_CREDIT", amountCents: Math.round(amountCents) };
    }

    case "TEMPORARY_DISCOUNT": {
      const amountCents = asFiniteNumber(params.estimatedCostCents);
      if (amountCents == null || amountCents <= 0) {
        throw new Error("acceptOffer: TEMPORARY_DISCOUNT missing estimatedCostCents");
      }
      return { kind: "TEMPORARY_DISCOUNT", amountCents: Math.round(amountCents) };
    }

    case "FREE_GIFT": {
      // No configured gift variant = an unfulfillable promise. Refuse loudly
      // (stale pre-config sessions must not resolve SAVED with phantom cost).
      const variantGid =
        typeof params.variantGid === "string" ? params.variantGid : "";
      if (!variantGid.startsWith("gid://shopify/ProductVariant/")) {
        throw new Error(
          "acceptOffer: FREE_GIFT has no configured gift variant to fulfil",
        );
      }
      return { kind: "FREE_GIFT", variantGid };
    }

    case "PERMANENT_DISCOUNT":
      // Never generated by buildOffersForReason; refuse rather than guess.
      throw new Error("acceptOffer: PERMANENT_DISCOUNT is not an automated offer");

    default: {
      const exhaustive: never = offer.type;
      throw new Error(`acceptOffer: unknown offer type ${String(exhaustive)}`);
    }
  }
}

// ─────────────────────────── Offer execution (I/O) ────────────────────────

/** Execute the structural/monetary action behind an accepted offer. */
async function executeOffer(
  graphql: AdminGraphql,
  shop: string,
  contract: SubscriptionContract,
  sessionId: string,
  offer: SaveOffer,
  plan: OfferExecutionPlan,
): Promise<void> {
  switch (plan.kind) {
    case "EDUCATION_ACK":
      // Never reaches executeOffer — acceptOffer records the acknowledgement
      // without resolving the session. Guard against regressions.
      throw new Error("executeOffer: EDUCATION never executes a contract change");
    case "SKIP_NEXT":
      await skipNextShipment(graphql, shop, contract.id, {
        source: "SAVE_OFFER",
      });
      return;
    case "DELAY_WEEKS":
      await delayByWeeks(graphql, shop, contract.id, plan.weeks, {
        source: "SAVE_OFFER",
      });
      return;
    case "SWITCH_CADENCE":
      await switchCadence(graphql, shop, contract.id, plan.intervalWeeks);
      return;
    case "CHANGE_QUANTITY": {
      // Re-validate against the LIVE line, not the currentQuantity that was
      // snapshotted into the offer at presentation: the customer may have
      // reduced the line via /portal/treatment while the offers tab sat open,
      // and "receive a little less" must never INCREASE what they receive.
      const line = await prisma.contractLine.findFirst({
        where: { id: plan.lineId, contractId: contract.id },
      });
      if (!line) {
        throw new OfferChoiceError(
          "That product is no longer part of this plan.",
        );
      }
      if (plan.quantity >= line.quantity) {
        throw new OfferChoiceError(
          "Please choose a smaller amount than you receive today.",
        );
      }
      await updateLineQuantity(
        graphql,
        shop,
        contract.id,
        plan.lineId,
        plan.quantity,
      );
      return;
    }
    case "PRODUCT_SWAP": {
      // Execute EXACTLY what was advertised: the chosen line must belong to
      // this contract and the chosen variant must belong to one of the
      // candidate products presented with the offer.
      const line = await prisma.contractLine.findFirst({
        where: { id: plan.lineId, contractId: contract.id },
      });
      if (!line) {
        throw new OfferChoiceError(
          "That product is no longer part of this plan.",
        );
      }
      const candidates = Array.isArray(offer.params.candidates)
        ? (offer.params.candidates as unknown[]).map(String)
        : [];
      const variant = await getVariantInfo(graphql, plan.newVariantGid);
      if (!candidates.includes(variant.productId)) {
        throw new OfferChoiceError(
          "Please choose one of the suggested alternatives.",
        );
      }
      await swapLineVariant(
        graphql,
        shop,
        contract.id,
        plan.lineId,
        plan.newVariantGid,
      );
      return;
    }
    case "REMOVE_LINE":
      // keepOne enforces the "a treatment plan keeps at least one product"
      // invariant against the LIVE line count on Shopify — the advertised
      // lineOptions were snapshotted at presentation, and a stale offers tab
      // must not be able to empty a plan another tab already shrank to one
      // line (a dead but still-billed contract).
      try {
        await removeLineFromContract(graphql, shop, contract.id, plan.lineId, {
          keepOne: true,
        });
      } catch (e) {
        if (e instanceof KeepOneLineError) {
          throw new OfferChoiceError(
            "That's the only product left on your plan — a pause or swap might suit better.",
          );
        }
        throw e;
      }
      return;
    case "PAUSE_UNTIL":
      await pauseUntil(graphql, shop, contract.id, plan.resumeDate);
      return;
    case "ACCOUNT_CREDIT":
    case "TEMPORARY_DISCOUNT":
      await applyAccountCredit(graphql, shop, contract.id, plan.amountCents);
      return;
    case "FREE_GIFT": {
      // Fulfilment contract: a zero-priced NEXT_ONLY AddOnItem with source
      // RETENTION_GIFT — the add-on engine (offers/addOnFulfillment.server)
      // places it on the next delivery at 0 cents and removes it after.
      const variant = await getVariantInfo(graphql, plan.variantGid);
      await prisma.addOnItem.create({
        data: {
          contractId: contract.id,
          shopifyProductId: variant.productId,
          shopifyVariantId: plan.variantGid,
          title: variant.title,
          quantity: 1,
          priceCents: 0,
          mode: "NEXT_ONLY",
          source: "RETENTION_GIFT",
        },
      });
      await emitLifecycleEvent({
        shop,
        name: "PRODUCT_ADDED",
        contractId: contract.id,
        shopifyCustomerId: contract.shopifyCustomerId,
        email: contract.customerEmail,
        payload: {
          variantId: plan.variantGid,
          productTitle: variant.title,
          quantity: 1,
          priceCents: 0,
          gift: true,
        },
        dedupeKey: `retention-gift:${sessionId}`,
      });
      return;
    }
    default: {
      const exhaustive: never = plan;
      throw new Error(`executeOffer: unknown plan ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ─────────────────────────── Accept / finalize ────────────────────────────

export async function acceptOffer(
  graphql: AdminGraphql,
  sessionId: string,
  offerType: SaveOfferType,
  chosenParams?: Record<string, unknown>,
): Promise<CancellationSession> {
  const session = await prisma.cancellationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  if (session.outcome === "SAVED" && session.savedByOffer === offerType) {
    // Replayed accept (double submit / stale tab): already done.
    return session;
  }
  if (session.outcome !== "IN_PROGRESS") {
    throw new Error(
      `acceptOffer: session ${sessionId} already resolved (${session.outcome})`,
    );
  }
  const offers = parseJson<SaveOffer[]>(session.offersJson, []);
  const offer = offers.find((o) => o.type === offerType);
  if (!offer) {
    throw new Error(
      `acceptOffer: offer ${offerType} was not presented in session ${sessionId}`,
    );
  }
  const contract = await prisma.subscriptionContract.findUniqueOrThrow({
    where: { id: session.contractId },
  });

  // Validate the customer's choice against the ADVERTISED params before any
  // state change — a mismatch is a friendly re-pick, never a hidden default.
  const plan = resolveOfferExecution(offer, chosenParams, new Date());

  // EDUCATION acknowledgement: record it on the session and keep the flow
  // open. No structural change happened, so nothing was "saved" yet — the
  // decline path stays visible and analytics stay honest.
  if (plan.kind === "EDUCATION_ACK") {
    // Keyed on the REPORT CONTENT, not just the session: should any other
    // path ever wipe the recorded ack, a re-submitted (different) care
    // report must not replay the completed session-scoped key — which would
    // persist nothing yet still redirect to "our care team is on it".
    // Identical double-submits still replay harmlessly.
    const detailsHash = createHash("sha256")
      .update(plan.details ?? "")
      .digest("hex");
    await withIdempotency(
      `cancel-edu:${sessionId}:${detailsHash}`,
      "retention.educationAck",
      async () => {
        const updatedOffers = offers.map((o) =>
          o.type === "EDUCATION"
            ? {
                ...o,
                params: {
                  ...o.params,
                  accepted: true,
                  acceptedAt: new Date().toISOString(),
                  ...(plan.details ? { details: plan.details } : {}),
                },
              }
            : o,
        );
        await prisma.cancellationSession.update({
          where: { id: session.id },
          data: { offersJson: JSON.stringify(updatedOffers) },
        });

        const careFollowUp = educationCareFollowUp(offer.params);
        await appendAudit({
          shop: session.shop,
          actorType: "CUSTOMER",
          actorId: contract.shopifyCustomerId,
          action: careFollowUp
            ? "CARE_FOLLOWUP_REQUESTED"
            : "CANCELLATION_EDUCATION_ACKNOWLEDGED",
          subjectType: "CancellationSession",
          subjectId: session.id,
          payload: {
            reason: session.reason,
            route: plan.route,
            hasDetails: plan.details != null,
          },
        });

        if (careFollowUp) {
          // Direct analytics write (PORTAL_*/WIDGET_* pattern) so the care
          // team's ops feed actually receives the reported reaction — an
          // adverse-reaction report must never be silently dropped.
          try {
            await prisma.analyticsEvent.create({
              data: {
                shop: session.shop,
                name: "CARE_FOLLOWUP_REQUESTED",
                contractId: contract.id,
                shopifyCustomerId: contract.shopifyCustomerId,
                payloadJson: JSON.stringify({
                  sessionId: session.id,
                  reason: session.reason,
                  details: plan.details,
                }),
                // Same content hash as the idempotency key: without it a
                // NEW report after an ack wipe would be acked in offersJson
                // but never reach the care team's ops feed.
                dedupeKey: `care-followup:${session.id}:${detailsHash}`,
              },
            });
          } catch (e) {
            // Unique dedupeKey collision on replay — already recorded.
            logger.info("care follow-up event already recorded", {
              sessionId: session.id,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return { acknowledged: true };
      },
    );
    return prisma.cancellationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
  }

  // Accept-time re-check of the one-paid-save window: presentation-time
  // filtering cannot protect against offers accepted from a stale tab after
  // a sibling session already collected a paid concession.
  if (
    MONETARY_OFFER_TYPES.includes(offerType) &&
    (await hasRecentPaidSave(session.contractId, session.id))
  ) {
    throw new OfferChoiceError(
      "A thank-you benefit was applied to this plan recently — this offer is no longer available.",
    );
  }

  // TEMPORARY_DISCOUNT promises a PERCENT but executes a fixed credit:
  // recompute the amount from the LIVE lines so the applied credit, the
  // recorded save cost and the saved-view confirmation all honour the
  // advertised percent even when the plan changed since presentation.
  let executionPlan: OfferExecutionPlan = plan;
  let saveCostCents = offer.costCents;
  let recomputedOffersJson: string | null = null;
  if (plan.kind === "TEMPORARY_DISCOUNT") {
    const withLines = await loadContractWithLines(
      session.shop,
      session.contractId,
    );
    if (!withLines) {
      throw new Error(
        `acceptOffer: contract ${session.contractId} not found for ${session.shop}`,
      );
    }
    const percentOff =
      asFiniteNumber((offer.params as Record<string, unknown>).percentOff) ??
      DEFAULT_TEMPORARY_DISCOUNT_PERCENT;
    const amountCents = liveDiscountAmountCents(
      orderValueCents(toLineSummaries(withLines)),
      percentOff,
      session.maxSaveCostCents,
    );
    if (amountCents <= 0) {
      throw new OfferChoiceError(
        "This offer no longer applies to your plan — the other options are still available.",
      );
    }
    executionPlan = { kind: "TEMPORARY_DISCOUNT", amountCents };
    saveCostCents = amountCents;
    if (amountCents !== offer.costCents) {
      // Keep the persisted offer truthful too: the saved-view confirmation
      // quotes params.estimatedCostCents, which must match the applied credit.
      recomputedOffersJson = JSON.stringify(
        offers.map((o) =>
          o.type === "TEMPORARY_DISCOUNT"
            ? {
                ...o,
                costCents: amountCents,
                params: { ...o.params, estimatedCostCents: amountCents },
              }
            : o,
        ),
      );
    }
  }

  // Compare-and-set claim BEFORE side effects: exactly one concurrent accept
  // (or finalize) can win. Losers see the already-resolved session.
  const claimed = await prisma.cancellationSession.updateMany({
    where: { id: session.id, outcome: "IN_PROGRESS" },
    data: {
      outcome: "SAVED",
      savedByOffer: offerType,
      saveCostCents,
      resolvedAt: new Date(),
      ...(recomputedOffersJson != null
        ? { offersJson: recomputedOffersJson }
        : {}),
    },
  });
  if (claimed.count === 0) {
    const fresh = await prisma.cancellationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    if (fresh.outcome === "SAVED" && fresh.savedByOffer === offerType) {
      return fresh;
    }
    throw new Error(
      `acceptOffer: session ${sessionId} already resolved (${fresh.outcome})`,
    );
  }

  // The idempotent block contains ONLY the concession itself: its result row
  // is completed the moment the contract mutation lands, so a later
  // bookkeeping blip can neither release the key nor trigger the
  // compensating revert — a retry after such a blip would otherwise
  // re-execute the concession (double credit, two skipped cycles, an 8-week
  // delay from one accepted 4-week offer).
  try {
    await withIdempotency(
      `cancel-save:${sessionId}:${offerType}`,
      "retention.acceptOffer",
      async () => {
        await executeOffer(
          graphql,
          session.shop,
          contract,
          session.id,
          offer,
          executionPlan,
        );
        return { saved: true, offerType };
      },
    );
  } catch (e) {
    // Execution itself failed after the claim (pre-commit): release it so
    // the customer can retry (mirrors withIdempotency's release-on-error).
    try {
      await prisma.cancellationSession.updateMany({
        where: { id: session.id, outcome: "SAVED", savedByOffer: offerType },
        data: {
          outcome: "IN_PROGRESS",
          savedByOffer: null,
          saveCostCents: null,
          resolvedAt: null,
        },
      });
    } catch (revertError) {
      logger.error("acceptOffer: failed to release claimed session", {
        sessionId: session.id,
        error: String(revertError),
      });
    }
    throw e;
  }

  // Bookkeeping AFTER the committed concession, best-effort: an audit/event
  // failure must never undo a save that already landed on Shopify. Both
  // carry dedupe keys, so a rare partial replay cannot double-notify.
  try {
    await appendAudit({
      shop: session.shop,
      actorType: "CUSTOMER",
      actorId: contract.shopifyCustomerId,
      action: "CANCELLATION_SAVED",
      subjectType: "CancellationSession",
      subjectId: session.id,
      payload: {
        offerType,
        saveCostCents,
        reason: session.reason,
        plan: plan.kind,
      },
    });

    await emitLifecycleEvent({
      shop: session.shop,
      name: "CANCELLATION_SAVED",
      contractId: contract.id,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: {
        sessionId: session.id,
        offerType,
        saveCostCents,
        reason: session.reason,
      },
      dedupeKey: `cancel-saved:${session.id}`,
    });
  } catch (bookkeepingError) {
    logger.error("acceptOffer: bookkeeping failed after executed save offer", {
      sessionId: session.id,
      offerType,
      error: String(bookkeepingError),
    });
  }

  return prisma.cancellationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
}

export async function finalizeCancellation(
  graphql: AdminGraphql,
  sessionId: string,
): Promise<CancellationSession> {
  const session = await prisma.cancellationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
  if (session.outcome === "CANCELLED") {
    // Replayed finalize (double submit / stale tab): already done.
    return session;
  }
  if (session.outcome !== "IN_PROGRESS") {
    throw new Error(
      `finalizeCancellation: session ${sessionId} already resolved (${session.outcome})`,
    );
  }
  const contract = await prisma.subscriptionContract.findUniqueOrThrow({
    where: { id: session.contractId },
  });

  // Compare-and-set claim: a finalize racing an accept (two tabs) must not
  // both execute — whoever claims IN_PROGRESS first wins.
  const claimed = await prisma.cancellationSession.updateMany({
    where: { id: session.id, outcome: "IN_PROGRESS" },
    data: { outcome: "CANCELLED", resolvedAt: new Date() },
  });
  if (claimed.count === 0) {
    const fresh = await prisma.cancellationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    if (fresh.outcome === "CANCELLED") return fresh;
    throw new Error(
      `finalizeCancellation: session ${sessionId} already resolved (${fresh.outcome})`,
    );
  }

  // Only the Shopify cancel lives inside the idempotent block (result stored
  // the moment it commits): a later audit/event blip must not revert the
  // session to IN_PROGRESS while the plan is already cancelled on Shopify —
  // that would wedge the funnel report and make every retry error against
  // the already-cancelled contract.
  try {
    await withIdempotency(
      `cancel-final:${sessionId}`,
      "retention.finalizeCancellation",
      async () => {
        // emitEvent: false — the richer emission below (sessionId payload,
        // stable dedupe key) is the single CANCELLATION_COMPLETED event.
        await cancelContract(
          graphql,
          session.shop,
          contract.id,
          (session.reason as CancelReason | null) ?? "OTHER",
          "CUSTOMER",
          { emitEvent: false },
        );
        return { cancelled: true };
      },
    );
  } catch (e) {
    try {
      await prisma.cancellationSession.updateMany({
        where: { id: session.id, outcome: "CANCELLED" },
        data: { outcome: "IN_PROGRESS", resolvedAt: null },
      });
    } catch (revertError) {
      logger.error("finalizeCancellation: failed to release claimed session", {
        sessionId: session.id,
        error: String(revertError),
      });
    }
    throw e;
  }

  // Bookkeeping AFTER the committed cancel, best-effort (dedupe keys make a
  // rare partial replay safe).
  try {
    await appendAudit({
      shop: session.shop,
      actorType: "CUSTOMER",
      actorId: contract.shopifyCustomerId,
      action: "CANCELLATION_COMPLETED",
      subjectType: "CancellationSession",
      subjectId: session.id,
      payload: {
        reason: session.reason,
        offersPresented: parseJson<SaveOffer[]>(session.offersJson, []).length,
      },
    });

    await emitLifecycleEvent({
      shop: session.shop,
      name: "CANCELLATION_COMPLETED",
      contractId: contract.id,
      shopifyCustomerId: contract.shopifyCustomerId,
      email: contract.customerEmail,
      payload: { sessionId: session.id, reason: session.reason },
      dedupeKey: `cancel-completed:${session.id}`,
    });
  } catch (bookkeepingError) {
    logger.error(
      "finalizeCancellation: bookkeeping failed after committed cancel",
      { sessionId: session.id, error: String(bookkeepingError) },
    );
  }

  return prisma.cancellationSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
}

/**
 * Housekeeping (jobs registry "expire-cancel-sessions", daily): a session the
 * customer walked away from is itself a save — but left IN_PROGRESS it wedges
 * the funnel report and lets concessions stack across stale sessions. Mark
 * anything IN_PROGRESS older than 48h as ABANDONED.
 */
export async function expireCancellationSessionsJob(
  shop?: string,
): Promise<{ expired: number }> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const result = await prisma.cancellationSession.updateMany({
    where: {
      ...(shop ? { shop } : {}),
      outcome: "IN_PROGRESS",
      startedAt: { lt: cutoff },
    },
    data: { outcome: "ABANDONED", resolvedAt: new Date() },
  });
  if (result.count > 0) {
    logger.info("cancellation sessions expired", {
      shop: shop ?? "all",
      expired: result.count,
    });
  }
  return { expired: result.count };
}
