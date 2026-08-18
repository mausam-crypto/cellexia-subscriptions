import type { CancelSession, Prisma, Shop } from "@prisma/client";
import { z } from "zod";
import prisma from "~/db.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import {
  grantDiscountCents,
  loadParkedCycleDiscount,
  nextCycleIndex,
} from "~/lib/billing/estimate.server";
import { getActiveDiscountForCycle } from "~/lib/billing/discounts.server";
import {
  isPreparingOrder,
  resolveChargeTiming,
} from "~/lib/billing/timing.server";
import { addDaysTz, addIntervalTz, shopDayStartUtc } from "~/lib/dates.server";
import { delayModeFor, type DelayMode } from "~/lib/portal/schedule.server";
import {
  approxWeeks,
  contractFrequency,
  FREQUENCY_COUNT_LIMITS,
  type Frequency,
  type FrequencyUnit,
  sameFrequency,
} from "~/lib/frequency";
import { adminClientForShop } from "~/shopify.server";
import { gql, type AdminClient } from "~/lib/graphql/client.server";
import {
  getBillingCycleByDate,
  getBillingCycleByIndex,
} from "~/lib/graphql/billingCycles.server";
import {
  CycleLineEditError,
  applyDiscountGrant,
  cancelContract,
  changeFrequency,
  changeLineQuantity,
  delayNextCycle,
  delaySchedule,
  extendPause,
  pauseContract,
  skipLineThisCycle,
  skipNextCycle,
  swapLineVariant,
} from "~/lib/contracts/service.server";
import { pauseExtendChoices } from "~/lib/portal/flex.server";
import { getPortalCatalog } from "~/lib/portal/catalog.server";
import {
  ongoingDiscountPctForProduct,
  swapPriceCentsSync,
  type LocalContractWithLines,
} from "~/lib/contracts/shared.server";
import { resolveLockState } from "~/lib/contracts/lock.server";
import {
  CANCEL_SCHEDULED,
  FINAL_DISCOUNT,
  LOCK_BLOCKED_SAVES,
  MAX_DOWNSIZE_OPTIONS,
  MAX_SWAP_OPTIONS,
  SAVED_PENDING,
  SESSION_FRESH_MINUTES,
  copyVariantFor,
  mergeSavesShown,
  reasonConfig,
  savesOrderFor,
  type CancelReason,
  type SaveKind,
} from "./config.server";
import { pickGiftForContract } from "~/lib/gifts/picker.server";
import { settingOverride } from "~/lib/experiments/index.server";
import type { ReplyPromise } from "~/lib/support/channels.server";

/**
 * Cancel-flow engine: CancelSession lifecycle, reason-matched save offers,
 * save execution (through the contract services — never raw Shopify calls),
 * final-offer eligibility and the terminal cancel.
 *
 * Event discipline: every state mutation logs a canonical `cancel.*` event.
 * One deliberate exception — DISCOUNT and FINAL_DISCOUNT accepts do NOT log
 * their own `cancel.save_accepted` / `cancel.final_offer_accepted`, because
 * `applyDiscountGrant` already logs exactly that event for grant types
 * SAVE_OFFER / SAVE_OFFER_FINAL; double-logging would double-count saves in
 * the daily rollups and fire Klaviyo flows twice.
 *
 * Psychology (see config.server.ts for the full rationale): offers are gated
 * behind a recorded reason, capped at settings.cancelFlow.maxSavesShown, and
 * the final discount is a genuinely-once offer enforced by
 * settings.cancelFlow.finalOfferCooldownDays plus a show-once event check.
 *
 * Discount stacking: every discount offer (reason-matched and final) is
 * clamped so plan ongoing discount + grant stays within
 * settings.discountStacking.maxTotalDiscountPct (~/lib/billing/stacking.server);
 * zero-headroom contracts never see a discount card, so the flow never
 * promises a percent applyDiscountGrant would refuse.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type CancelChannel = "PORTAL" | "ADMIN" | "MAGIC_LINK";

export interface SwapOption {
  variantId: string;
  title: string;
  /** Unit price the swap WILL apply — from the service's swapPriceCentsFor
   * (v1.28.0), so the card and the executed swap can never disagree. */
  displayPriceCents: number;
  imageUrl: string | null;
}

/**
 * One cheaper configuration on a DOWNSIZE card (v1.28.0). Exactly one of
 * `quantity` (fewer units of the same variant) or `variantId` (a smaller
 * size of the same product / a cheaper product from the catalog group) is
 * set; `newTotalCents` is the contract's recurring per-order subtotal after
 * accepting, computed with the same pricing helper the swap applies.
 */
export interface DownsizeOption {
  mode: "QUANTITY" | "VARIANT" | "PRODUCT";
  quantity?: number;
  variantId?: string;
  title: string;
  imageUrl: string | null;
  /** Unit price of the option (per unit of the line after accepting). */
  unitPriceCents: number;
  newTotalCents: number;
}

/** JSON-serializable offer shapes (dates as ISO strings) — persisted verbatim
 * into CancelSession.savesShown, so keep them stable. */
export type SaveOffer =
  | {
      /**
       * "Push my next order to {predicted empty date}" (v1.28.0, P3.3): the
       * churn model's run-out day lies AFTER the next charge, so the fitted
       * fix for "too much product" is one delivery timed to it. `days` is
       * the whole shop-tz days the next order moves; `mode` is the portal's
       * delay semantics at offer time (portal.delayReanchors) — re-derived
       * at accept, the card only promises the date.
       */
      kind: "DELAY";
      currentNextDate: string;
      newNextDate: string;
      days: number;
      mode: DelayMode;
    }
  | {
      kind: "SKIP";
      currentNextDate: string | null;
      newNextDate: string | null;
      /**
       * Per-line "Skip just {product}" (v1.28.0, P2.5): on TOO_MUCH_PRODUCT
       * with several recurring products, the card also offers leaving ONE
       * product out of the next order (skipLineThisCycle) — the rest ships.
       * Absent on single-line contracts / other reasons / older sessions.
       */
      lines?: Array<{ lineId: string; title: string }>;
    }
  | {
      kind: "FREQUENCY";
      currentWeeks: number;
      suggestedWeeks: number;
      /** Exact cadence (v1.8.0) — absent on offers persisted before it; the
       * week fields above stay populated as approximations either way. */
      currentUnit?: FrequencyUnit;
      currentCount?: number;
      suggestedUnit?: FrequencyUnit;
      suggestedCount?: number;
      estNextDate: string | null;
      /**
       * Set when the contract was PAUSED at offer time (v1.28.0): the card
       * reads "resume later, at a slower cadence" — the hold runs to this
       * day, the slower cadence applies from the first order after it.
       */
      pausedResumeAt?: string;
    }
  | { kind: "PAUSE"; months: number; resumeDate: string }
  | {
      /**
       * Pause exit ramp inside the cancel flow (v1.28.0, P2.6 review fix):
       * offered INSTEAD of PAUSE when the contract is already PAUSED — a
       * one-tap "pause for N months" on a paused contract was a no-op the
       * flow still recorded as a save. Choices mirror the portal's
       * "need a little longer?" controls (portal.pauseExtendChoicesWeeks,
       * clamped from the pause start like extendPause).
       */
      kind: "EXTEND_PAUSE";
      currentResumeAt: string;
      choices: Array<{ weeks: number; resumeAt: string }>;
    }
  | {
      kind: "DISCOUNT";
      percent: number;
      cycles: number;
      estSavingsCentsPerCycle: number;
      currencyCode: string;
    }
  | {
      kind: "SWAP";
      lineId: string;
      lineTitle: string;
      options: SwapOption[];
    }
  | {
      kind: "GIFT";
      variantId: string;
      title: string;
      imageUrl: string | null;
      retailCents: number;
      currencyCode: string;
    }
  | {
      kind: "DOWNSIZE";
      lineId: string;
      lineTitle: string;
      /** Recurring per-order subtotal today (same base as every option's
       * newTotalCents) — the "was" figure. PLAN prices: a live DiscountGrant
       * is not folded in (it is temporary and rides whatever the lines are);
       * when one is live its percent / cycles left ride along so the card can
       * say so next to the figures (review fix — the hero shows the
       * discounted estimate, the card must not look like it contradicts it). */
      currentTotalCents: number;
      currencyCode: string;
      options: DownsizeOption[];
      discountPercent?: number;
      discountCyclesRemaining?: number;
    }
  | { kind: "EDUCATION" }
  | { kind: "SUPPORT" }
  | { kind: "FINAL_DISCOUNT"; percent: number; cycles: number };

export interface SaveConfirmation {
  kind: SaveKind | typeof FINAL_DISCOUNT;
  contract: LocalContractWithLines;
  /** DISCOUNT / FINAL_DISCOUNT */
  percent?: number;
  cycles?: number;
  /** PAUSE */
  months?: number;
  resumeAt?: string | null;
  /** SKIP / FREQUENCY */
  nextBillingDate?: string | null;
  /** Week approximation of `frequency` — kept for existing consumers. */
  weeks?: number;
  frequency?: Frequency;
  /** SWAP */
  swappedTitle?: string;
  /** SKIP, per-line variant (P2.5): the product left out of the next order. */
  skippedLineTitle?: string;
  /** GIFT */
  giftTitle?: string;
  /** DOWNSIZE — the accepted option (mode + new per-order subtotal). */
  downsize?: {
    mode: DownsizeOption["mode"];
    title: string;
    quantity?: number;
    newTotalCents: number;
    currencyCode: string;
  };
  /**
   * SUPPORT concierge save (v1.28.0, P3.7): whether the next order was held
   * (moved by cancelFlow.conciergeHoldDays) and the reply promise
   * (support.replyWithin*, phrased by supportReplyPromise) — the saved page
   * states exactly what happened.
   */
  concierge?: {
    holdApplied: boolean;
    holdDays: number;
    replyWithin: ReplyPromise;
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface SessionContext {
  session: CancelSession;
  contract: LocalContractWithLines;
  shop: Shop;
}

async function loadSessionContext(sessionId: string): Promise<SessionContext> {
  const session = await prisma.cancelSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) throw new Error(`Cancel session not found: ${sessionId}`);
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: session.contractId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Contract not found for cancel session ${sessionId}`);
  }
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: contract.shopId },
  });
  return { session, contract, shop };
}

function channelSource(channel: string): EventSource {
  switch (channel) {
    case "ADMIN":
      return "ADMIN";
    case "MAGIC_LINK":
      return "MAGIC_LINK";
    default:
      return "CUSTOMER_PORTAL";
  }
}

function identity(contract: LocalContractWithLines) {
  return {
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function savesShownArray(session: CancelSession): SaveOffer[] {
  const raw = session.savesShown;
  return Array.isArray(raw) ? (raw as unknown as SaveOffer[]) : [];
}

/** Sum of non-gift recurring line prices for one cycle, in cents. */
function cycleSubtotalCents(contract: LocalContractWithLines): number {
  return contract.lines
    .filter((l) => !l.isGift && !l.isOneTimeAddon)
    .reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0);
}

// ── Session lifecycle ────────────────────────────────────────────────────────

/**
 * Start a cancel session. Any un-completed session for the contract is marked
 * ABANDONED first (a fresh flow always speaks for itself) — each one logs the
 * terminal `cancel.aborted` event so the event stream always closes every
 * session — then the new row is created and `cancel.flow_started` is logged
 * with the A/B copy variant so analytics can split outcomes by copy.
 *
 * Reason carry-over: when the customer completed a session minutes ago (e.g.
 * accepted a save, then tapped "I still want to cancel"), the new session is
 * seeded with that session's reason/detail so a quick path to confirm records
 * the true reason instead of OTHER, and analytics keep the right bucket.
 */
export async function startCancelSession(
  contractLocalId: string,
  channel: CancelChannel,
  actor?: string | null,
): Promise<CancelSession> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Contract not found: ${contractLocalId}`);
  }

  const staleSessions = await prisma.cancelSession.findMany({
    where: { contractId: contract.id, outcome: null },
    select: { id: true, reason: true, startedAt: true },
  });
  const stale = await prisma.cancelSession.updateMany({
    where: { contractId: contract.id, outcome: null },
    data: { outcome: "ABANDONED", completedAt: new Date() },
  });
  for (const s of staleSessions) {
    await logEvent({
      ...identity(contract),
      type: "cancel.aborted",
      source: channelSource(channel),
      actor: actor ?? (channel === "ADMIN" ? null : "customer"),
      payload: {
        sessionId: s.id,
        reason: s.reason,
        abortedBy: "new_flow_started",
      },
    });
  }

  const freshness = await sessionFreshMinutes(contract.shopId);
  const seedCutoff = new Date(Date.now() - freshness * 60_000);
  const recent = await prisma.cancelSession.findFirst({
    where: {
      contractId: contract.id,
      reason: { not: null },
      startedAt: { gte: seedCutoff },
    },
    orderBy: { startedAt: "desc" },
    select: { reason: true, reasonDetail: true },
  });

  const session = await prisma.cancelSession.create({
    data: {
      contractId: contract.id,
      channel,
      ...(recent
        ? { reason: recent.reason, reasonDetail: recent.reasonDetail }
        : {}),
    },
  });

  await logEvent({
    ...identity(contract),
    type: "cancel.flow_started",
    source: channelSource(channel),
    actor: actor ?? (channel === "ADMIN" ? null : "customer"),
    payload: {
      sessionId: session.id,
      channel,
      abandonedPriorSessions: stale.count,
      ...(recent ? { seededReason: recent.reason } : {}),
      copyVariant: copyVariantFor(contract.id),
    },
  });

  return session;
}

/** settings.cancelFlow.sessionFreshMinutes with the constant as fallback. */
async function sessionFreshMinutes(shopId: string): Promise<number> {
  try {
    return (await getSetting(shopId, "cancelFlow")).sessionFreshMinutes;
  } catch {
    return SESSION_FRESH_MINUTES;
  }
}

/**
 * The contract's current in-progress session, or null. Sessions older than
 * settings.cancelFlow.sessionFreshMinutes are ignored (the next start
 * abandons them), so a refresh reuses the session but a returning visitor
 * gets a fresh flow.
 */
export async function getActiveSession(
  contractLocalId: string,
): Promise<CancelSession | null> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    select: { shopId: true },
  });
  const freshness = contract
    ? await sessionFreshMinutes(contract.shopId)
    : SESSION_FRESH_MINUTES;
  const cutoff = new Date(Date.now() - freshness * 60_000);
  return prisma.cancelSession.findFirst({
    where: {
      contractId: contractLocalId,
      outcome: null,
      startedAt: { gte: cutoff },
    },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Hourly job (cancel_session_gc): close open sessions older than the
 * freshness window as ABANDONED and emit the documented `cancel.aborted`
 * terminal event — a customer who walks away mid-flow and never returns must
 * still produce a terminal event for the funnel (ARCHITECTURE.md vocabulary).
 */
export async function closeStaleCancelSessions(
  now: Date = new Date(),
): Promise<{ closed: number }> {
  const stale = await prisma.cancelSession.findMany({
    where: { outcome: null },
    select: {
      id: true,
      reason: true,
      startedAt: true,
      contract: {
        select: {
          id: true,
          shopId: true,
          customerId: true,
          email: true,
        },
      },
    },
    take: 500,
  });

  let closed = 0;
  for (const s of stale) {
    const freshness = await sessionFreshMinutes(s.contract.shopId);
    if (now.getTime() - s.startedAt.getTime() < freshness * 60_000) continue;
    // Guarded update: only close if still open (races with a returning
    // customer resolve in the customer's favor).
    const updated = await prisma.cancelSession.updateMany({
      where: { id: s.id, outcome: null },
      data: { outcome: "ABANDONED", completedAt: now },
    });
    if (updated.count === 0) continue;
    closed += 1;
    await logEvent({
      shopId: s.contract.shopId,
      contractId: s.contract.id,
      customerId: s.contract.customerId,
      email: s.contract.email,
      type: "cancel.aborted",
      source: "SYSTEM",
      actor: "cancel_session_gc",
      payload: {
        sessionId: s.id,
        reason: s.reason,
        abortedBy: "stale_session_gc",
        ageMinutes: Math.round(
          (now.getTime() - s.startedAt.getTime()) / 60_000,
        ),
      },
    });
  }
  return { closed };
}

/** Latest completed-with-a-save session (drives the "saved" confirmation page). */
export async function getLatestSavedSession(
  contractLocalId: string,
): Promise<CancelSession | null> {
  // SAVED_PENDING (v1.28.0, P3.7): the concierge request went out — the
  // saved page must render for it too (with its own copy).
  return prisma.cancelSession.findFirst({
    where: { contractId: contractLocalId, outcome: { in: ["SAVED", SAVED_PENDING] } },
    orderBy: { startedAt: "desc" },
  });
}

/**
 * Record the survey answer. Logs `cancel.reason_given` only when the answer
 * actually changed (double-submits stay silent).
 */
export async function recordReason(
  sessionId: string,
  reason: CancelReason,
  detail?: string | null,
): Promise<CancelSession> {
  if (!reasonConfig(reason)) {
    throw new Error(`Unknown cancel reason: ${reason}`);
  }
  const { session, contract } = await loadSessionContext(sessionId);
  const trimmedDetail = detail?.trim().slice(0, 1000) || null;

  const changed =
    session.reason !== reason || session.reasonDetail !== trimmedDetail;

  const updated = await prisma.cancelSession.update({
    where: { id: session.id },
    data: { reason, reasonDetail: trimmedDetail },
  });

  if (changed) {
    await logEvent({
      ...identity(contract),
      type: "cancel.reason_given",
      source: channelSource(session.channel),
      actor: "customer",
      payload: {
        sessionId: session.id,
        reason,
        hasDetail: trimmedDetail != null,
        ...(trimmedDetail ? { detail: trimmedDetail.slice(0, 500) } : {}),
      },
    });
  }

  return updated;
}

// ── Offer construction ───────────────────────────────────────────────────────

const SWAP_SIBLINGS_QUERY = `#graphql
  query CellexiaCancelSwapSiblings($id: ID!) {
    product(id: $id) {
      id
      title
      variants(first: 20) {
        nodes {
          id
          title
          availableForSale
          price
          image { url }
        }
      }
    }
  }
`;

interface SwapSiblingsResponse {
  product?: {
    id?: string | null;
    title?: string | null;
    variants?: {
      nodes?: Array<{
        id?: string | null;
        title?: string | null;
        availableForSale?: boolean | null;
        price?: string | null;
        image?: { url?: string | null } | null;
      } | null> | null;
    } | null;
  } | null;
}

function centsFromPrice(price: string | null | undefined): number | null {
  if (price == null || price === "") return null;
  const cents = Math.round(parseFloat(price) * 100);
  return Number.isNaN(cents) ? null : cents;
}

/**
 * Sibling variants of the line's product (other sizes/formulas), each priced
 * with the service's `swapPriceCentsFor` — the exact unit price the swap
 * applies (grandfathered same-product swaps keep the line price; otherwise
 * the plan's ongoing discount / proportional ratio) — capped in the
 * merchant's variant order, then sorted by price ascending for display
 * (v1.28.0). Before v1.28.0 the card showed a proportional-ratio price the
 * executed swap could differ from.
 */
async function fetchSwapOptions(
  admin: AdminClient,
  shopId: string,
  contract: { grandfatheredPricing: boolean },
  line: LocalContractWithLines["lines"][number],
): Promise<SwapOption[]> {
  const siblings = await fetchSiblingVariants(admin, line);
  const priceFor = swapPricer(shopId, contract);
  const options: SwapOption[] = [];
  for (const node of siblings) {
    if (node.variantId === line.variantId) continue;
    options.push({
      variantId: node.variantId,
      title: node.title || line.title,
      displayPriceCents: await priceFor(line, {
        productId: line.productId,
        priceCents: node.priceCents,
      }),
      imageUrl: node.imageUrl,
    });
  }
  // The SHOWN set is the merchant's variant order (Shopify order — the
  // stronger / pricier formulas a results-driven swap needs stay on the
  // card); the cap applies before the display sort so sorting can never
  // drop them (review fix). Display: price ascending.
  const shown = options.slice(0, MAX_SWAP_OPTIONS);
  shown.sort((a, b) => a.displayPriceCents - b.displayPriceCents);
  return shown;
}

interface SiblingVariant {
  variantId: string;
  title: string;
  priceCents: number;
  imageUrl: string | null;
}

/** Available-for-sale variants of the line's product (catalog prices). */
async function fetchSiblingVariants(
  admin: AdminClient,
  line: LocalContractWithLines["lines"][number],
): Promise<SiblingVariant[]> {
  const data = await gql<SwapSiblingsResponse>(admin, SWAP_SIBLINGS_QUERY, {
    id: line.productId,
  });
  const nodes = data.product?.variants?.nodes ?? [];
  const out: SiblingVariant[] = [];
  for (const node of nodes) {
    if (!node?.id) continue;
    if (node.availableForSale === false) continue;
    const priceCents = centsFromPrice(node.price);
    if (priceCents == null) continue;
    out.push({
      variantId: node.id,
      title: node.title || data.product?.title || line.title,
      priceCents,
      imageUrl: node.image?.url ?? null,
    });
  }
  return out;
}

/**
 * Per-render swap pricer: the ongoing percent is resolved ONCE per product
 * (Map cache) and priced with the pure rule — the same number
 * `swapPriceCentsFor` returns, without one SellingPlanConfig query per
 * candidate variant (review fix).
 */
function swapPricer(shopId: string, contract: { grandfatheredPricing: boolean }) {
  const pctCache = new Map<string, number | null>();
  return async (
    line: Pick<
      LocalContractWithLines["lines"][number],
      "productId" | "currentPriceCents" | "compareAtPriceCents"
    >,
    variant: { productId: string | null; priceCents: number },
  ): Promise<number> => {
    const key = variant.productId ?? "";
    let pct = pctCache.get(key);
    if (pct === undefined) {
      pct = await ongoingDiscountPctForProduct(shopId, variant.productId);
      pctCache.set(key, pct);
    }
    return swapPriceCentsSync(contract, line, variant, pct);
  };
}

/** Saves that edit the cycle being billed — refused while "preparing". */
const PREPARING_BLOCKED_SAVES = new Set<SaveKind>([
  "DELAY",
  "SKIP",
  "FREQUENCY",
  "DOWNSIZE",
]);

/** The recurring line the DOWNSIZE card acts on: the biggest lever (highest
 * line total) among non-gift, non-add-on lines. */
function downsizeTargetLine(
  contract: LocalContractWithLines,
): LocalContractWithLines["lines"][number] | null {
  const recurring = contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon);
  if (recurring.length === 0) return null;
  return recurring.reduce((best, l) =>
    l.currentPriceCents * l.quantity > best.currentPriceCents * best.quantity
      ? l
      : best,
  );
}

/**
 * Cheaper configurations for the DOWNSIZE save (v1.28.0), in this order:
 *   (a) fewer units — quantity − 1 when quantity > 1;
 *   (b) a smaller size / cheaper variant of the SAME product, priced with the
 *       swap helper, ordered by price ascending, only strictly cheaper ones;
 *   (c) a cheaper product from the same catalog group (the products the
 *       line's SellingPlanConfig covers; without a covering config, the
 *       subscribable portal catalog), cheapest available variant per
 *       product, priced with the swap helper, ascending.
 * Every option carries the concrete new recurring per-order subtotal
 * (Σ non-gift recurring lines with this line replaced), so the card can only
 * ever promise a total the accept path produces. Capped at
 * MAX_DOWNSIZE_OPTIONS. Contained: any Shopify/catalog hiccup yields fewer
 * options, never a thrown error — the cancel flow must render regardless.
 */
export async function buildDownsizeOptions(
  shopId: string,
  shopDomain: string,
  contract: LocalContractWithLines,
  line: LocalContractWithLines["lines"][number],
): Promise<DownsizeOption[]> {
  const subtotal = cycleSubtotalCents(contract);
  const lineTotal = line.currentPriceCents * line.quantity;
  const rest = subtotal - lineTotal;
  const options: DownsizeOption[] = [];
  const priceFor = swapPricer(shopId, contract);

  // (a) fewer units — only when changeLineQuantity can act (a line without
  // a mirrored Shopify line id would throw at accept; never promise it).
  if (line.quantity > 1 && line.shopifyLineId) {
    const quantity = line.quantity - 1;
    options.push({
      mode: "QUANTITY",
      quantity,
      title: line.title,
      imageUrl: line.imageUrl,
      unitPriceCents: line.currentPriceCents,
      newTotalCents: rest + line.currentPriceCents * quantity,
    });
  }
  if (options.length >= MAX_DOWNSIZE_OPTIONS) return options;

  let admin: AdminClient | null = null;
  try {
    admin = await adminClientForShop(shopDomain);
  } catch (err) {
    console.error("[cancel] downsize: admin client unavailable", contract.id, err);
    return options;
  }

  // (b) smaller size / cheaper variant of the same product
  try {
    const siblings = await fetchSiblingVariants(admin, line);
    const cheaper: DownsizeOption[] = [];
    for (const v of siblings) {
      if (v.variantId === line.variantId) continue;
      const unit = await priceFor(line, {
        productId: line.productId,
        priceCents: v.priceCents,
      });
      if (unit >= line.currentPriceCents) continue;
      cheaper.push({
        mode: "VARIANT",
        variantId: v.variantId,
        title: v.title,
        imageUrl: v.imageUrl,
        unitPriceCents: unit,
        newTotalCents: rest + unit * line.quantity,
      });
    }
    cheaper.sort((a, b) => a.unitPriceCents - b.unitPriceCents);
    for (const o of cheaper) {
      if (options.length >= MAX_DOWNSIZE_OPTIONS) break;
      options.push(o);
    }
  } catch (err) {
    console.error("[cancel] downsize: sibling variants read failed", contract.id, err);
  }
  if (options.length >= MAX_DOWNSIZE_OPTIONS) return options;

  // (c) cheaper product from the same catalog group
  try {
    const catalog = await getPortalCatalog(admin, shopId);
    const group = await catalogGroupProductIds(shopId, line.productId);
    const cheaper: DownsizeOption[] = [];
    for (const product of catalog) {
      if (product.id === line.productId) continue;
      if (group != null && !group.has(product.id)) continue;
      let best: DownsizeOption | null = null;
      for (const v of product.variants) {
        if (!v.availableForSale) continue;
        const unit = await priceFor(line, {
          productId: product.id,
          priceCents: v.priceCents,
        });
        if (unit >= line.currentPriceCents) continue;
        if (best && best.unitPriceCents <= unit) continue;
        best = {
          mode: "PRODUCT",
          variantId: v.id,
          title:
            v.title && v.title !== "Default Title"
              ? `${product.title} — ${v.title}`
              : product.title,
          imageUrl: product.imageUrl,
          unitPriceCents: unit,
          newTotalCents: rest + unit * line.quantity,
        };
      }
      if (best) cheaper.push(best);
    }
    cheaper.sort((a, b) => a.unitPriceCents - b.unitPriceCents);
    for (const o of cheaper) {
      if (options.length >= MAX_DOWNSIZE_OPTIONS) break;
      options.push(o);
    }
  } catch (err) {
    console.error("[cancel] downsize: catalog read failed", contract.id, err);
  }
  return options;
}

const productIdsSchema = z.array(z.string());

/**
 * Product ids sharing the line's SellingPlanConfig ("catalog group"); null
 * when no active config covers the product — the caller then treats the whole
 * subscribable catalog as the group. Contained.
 */
async function catalogGroupProductIds(
  shopId: string,
  productId: string,
): Promise<Set<string> | null> {
  try {
    const configs = await prisma.sellingPlanConfig.findMany({
      where: { shopId, active: true },
      orderBy: { createdAt: "asc" },
    });
    for (const config of configs) {
      const parsed = productIdsSchema.safeParse(config.productIds);
      if (parsed.success && parsed.data.includes(productId)) {
        return new Set(parsed.data);
      }
    }
    return null;
  } catch (err) {
    console.error("[cancel] downsize: selling plan config read failed", err);
    return null;
  }
}

/**
 * Map the reason's SaveKind order to concrete, ready-to-render offers using
 * settings.cancelFlow + the contract's real state. Inapplicable kinds are
 * skipped (e.g. PAUSE for an already-paused contract, SWAP with no siblings)
 * and at most settings.cancelFlow.maxSavesShown offers are returned,
 * preserving order.
 *
 * EDUCATION deliberately carries no URLs here: the routine-guide link
 * resolves from settings.portal.routineGuideUrl / howToUseUrl / faqUrl at
 * render time (education.server.ts — v1.28.0 P4.4, the same URLs the
 * portal's routine card shows; nothing configured ⇒ no button); the
 * consultation / support contact resolves from settings.support at render
 * time (getSupportChannels — v1.28.0, no more hard-coded mailto:).
 */
export async function getSavesForReason(
  shopId: string,
  reason: CancelReason,
  contract: LocalContractWithLines,
): Promise<SaveOffer[]> {
  const cfg = reasonConfig(reason);
  if (!cfg) return [];

  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const cancelFlow = await getSetting(shopId, "cancelFlow");
  const pauseSettings = await getSetting(shopId, "pause");
  const tz = shop.ianaTimezone;
  const isActive = contract.status === "ACTIVE";
  // Preparing-your-order window (v1.28.0 review fix — parity with the portal
  // dispatcher): once the charge moment has passed or an attempt is in
  // flight, saves that edit the cycle being billed (SKIP / FREQUENCY /
  // DOWNSIZE) are neither offered nor accepted. Contained (false on failure).
  const preparing = isActive
    ? await isPreparingOrder(
        contract,
        await resolveChargeTiming(shopId, tz),
      )
    : false;

  // Plan lock window (v1.28.0, P3.8): a locked contract walks the flow only
  // to schedule its cancellation — the reducing saves are neither offered
  // nor accepted (LOCK_BLOCKED_SAVES); the additive ones still are.
  // Contained: a failed rules read treats the contract as unlocked, exactly
  // like the portal (accept re-checks).
  let locked = false;
  try {
    locked = (await resolveLockState(shopId, contract, tz)).locked;
  } catch (err) {
    console.error("[cancel] lock state read failed for offers", contract.id, err);
  }

  const offers: SaveOffer[] = [];
  // PAUSED cancellers (v1.28.0): the exit ramp + "resume later, slower"
  // lead whatever the reason — see PAUSED_SAVES_LEAD.
  for (const kind of savesOrderFor(cfg, contract.status)) {
    if (offers.length >= cancelFlow.maxSavesShown) break;
    if (preparing && PREPARING_BLOCKED_SAVES.has(kind)) continue;
    if (locked && LOCK_BLOCKED_SAVES.has(kind)) continue;
    switch (kind) {
      case "DELAY": {
        // "Push my next order to {predicted empty date}" (P3.3): only when
        // the churn model has a run-out day AFTER the next charge (shop-tz
        // days) and within cancelFlow.delaySaveMaxDays. The date on the
        // card is the exact day the delay will set (whole-day move through
        // the portal's own delay semantics — re-anchor or this order only).
        const delayOn =
          (cancelFlow as { delaySaveEnabled?: boolean }).delaySaveEnabled !== false;
        if (!delayOn || !isActive || !contract.nextBillingDate) break;
        const predicted = contract.predictedEmptyDate;
        if (!predicted || Number.isNaN(predicted.getTime())) break;
        const nextDay = shopDayStartUtc(contract.nextBillingDate, tz);
        const emptyDay = shopDayStartUtc(predicted, tz);
        const days = Math.round((emptyDay.getTime() - nextDay.getTime()) / 86_400_000);
        const maxDays =
          (cancelFlow as { delaySaveMaxDays?: number }).delaySaveMaxDays ?? 42;
        if (days < 1 || days > maxDays) break;
        let mode: DelayMode = "once";
        try {
          mode = delayModeFor(await getSetting(shopId, "portal"), null);
        } catch (err) {
          console.error("[cancel] DELAY offer: portal settings read failed", contract.id, err);
        }
        offers.push({
          kind: "DELAY",
          currentNextDate: contract.nextBillingDate.toISOString(),
          newNextDate: addDaysTz(contract.nextBillingDate, days, tz).toISOString(),
          days,
          mode,
        });
        break;
      }
      case "SKIP": {
        if (!isActive || !contract.nextBillingDate) break;
        // The card promises an exact date, so preview what accepting actually
        // does: skipNextCycle prefers Shopify's own post-skip date, and for a
        // MONTH cadence anchored on the 29th–31st a local calendar step
        // clamps (Feb 28 + 1 month = Mar 28) where Shopify keeps the anchor
        // (Mar 31). Ask Shopify for the cycle after the current one; the
        // local unit advance stays as the contained fallback (a preview must
        // never break the cancel flow).
        const f = contractFrequency(contract);
        let newNextDate = addIntervalTz(
          contract.nextBillingDate,
          f.unit,
          f.count,
          tz,
        );
        try {
          const admin = await adminClientForShop(shop.domain);
          const current = await getBillingCycleByDate(
            admin,
            contract.shopifyContractId,
            contract.nextBillingDate,
          );
          const following = current
            ? await getBillingCycleByIndex(
                admin,
                contract.shopifyContractId,
                current.cycleIndex + 1,
              )
            : null;
          if (following?.billingAttemptExpectedDate) {
            newNextDate = following.billingAttemptExpectedDate;
          }
        } catch (err) {
          console.error(
            "[cancel] SKIP preview cycle read failed, using local estimate",
            contract.id,
            err,
          );
        }
        // Per-line option (P2.5): "too much product" on a multi-product
        // subscription — the customer may only have too much of ONE thing.
        // Honours the merchant switch (portal.perLineCycleEdits) like the
        // portal does, and never offers a line already "not this time" for
        // the upcoming cycle (review fix — accepting it threw LAST_LINE /
        // no-op'd instead of saving anything).
        let skippableLines: typeof contract.lines = [];
        if (reason === "TOO_MUCH_PRODUCT") {
          const portalSettings = await getSetting(shopId, "portal");
          const perLineOn =
            (portalSettings as { perLineCycleEdits?: boolean }).perLineCycleEdits !==
            false;
          if (perLineOn) {
            let upcoming: number | null = null;
            try {
              upcoming = await nextCycleIndex(contract);
            } catch (err) {
              console.error("[cancel] SKIP per-line: cycle hint failed", contract.id, err);
            }
            skippableLines = contract.lines.filter(
              (l) =>
                !l.isGift &&
                !l.isOneTimeAddon &&
                l.shopifyLineId &&
                (upcoming == null || l.skippedCycleIndex !== upcoming),
            );
          }
        }
        offers.push({
          kind: "SKIP",
          currentNextDate: contract.nextBillingDate.toISOString(),
          newNextDate: newNextDate.toISOString(),
          ...(skippableLines.length >= 2
            ? {
                lines: skippableLines.map((l) => ({
                  lineId: l.id,
                  title: l.title,
                })),
              }
            : {}),
        });
        break;
      }
      case "FREQUENCY": {
        // ACTIVE, or PAUSED (v1.28.0 — "resume later with a slower cadence":
        // the hold stands, nothing is charged before it ends, the slower
        // cadence applies from the first order after it; the card says so).
        const pausedResume =
          contract.status === "PAUSED" && contract.resumeAt ? contract.resumeAt : null;
        if (!isActive && !pausedResume) break;
        // The settings knob stays "+weeks" and applies to WEEK cadences
        // directly; DAY/MONTH cadences translate it (×7 days, ≈÷4 months,
        // min 1) so the suggestion stays in the contract's own unit. Past
        // the unit ceiling (WEEK keeps the 52 service ceiling) the card is
        // dropped, as the 52-week cap always did.
        const current = contractFrequency(contract);
        const delta = cancelFlow.frequencySuggestDeltaWeeks;
        const addedCount =
          current.unit === "WEEK"
            ? delta
            : current.unit === "DAY"
              ? delta * 7
              : Math.max(1, Math.round(delta / 4));
        const suggested: Frequency = {
          unit: current.unit,
          count: current.count + addedCount,
        };
        const ceiling =
          current.unit === "WEEK"
            ? 52
            : FREQUENCY_COUNT_LIMITS[current.unit].max;
        if (suggested.count > ceiling) break;
        offers.push({
          kind: "FREQUENCY",
          currentWeeks: approxWeeks(current.unit, current.count),
          suggestedWeeks: approxWeeks(suggested.unit, suggested.count),
          currentUnit: current.unit,
          currentCount: current.count,
          suggestedUnit: suggested.unit,
          suggestedCount: suggested.count,
          // Advanced by the ADDED slack only — the next order still arrives,
          // just later; the full new cadence starts after it. PAUSED: the
          // first order is the resume day itself (resumeContract bills ON it).
          estNextDate: pausedResume
            ? pausedResume.toISOString()
            : contract.nextBillingDate
              ? addIntervalTz(
                  contract.nextBillingDate,
                  suggested.unit,
                  addedCount,
                  tz,
                ).toISOString()
              : null,
          ...(pausedResume ? { pausedResumeAt: pausedResume.toISOString() } : {}),
        });
        break;
      }
      case "PAUSE": {
        if (contract.status === "PAUSED") {
          // Already on hold: the honest offer is the exit ramp — push the
          // resume day back, never a no-op "pause" recorded as a save.
          const choices = await pausedExtendChoices(shopId, contract, tz);
          if (contract.resumeAt && choices.length > 0) {
            offers.push({
              kind: "EXTEND_PAUSE",
              currentResumeAt: contract.resumeAt.toISOString(),
              choices: choices.map((c) => ({
                weeks: c.weeks,
                resumeAt: c.resumeAt.toISOString(),
              })),
            });
          }
          break;
        }
        if (contract.status !== "ACTIVE") break; // not an offer
        const months = Math.min(
          cancelFlow.pauseSuggestMonths,
          pauseSettings.maxMonths,
        );
        offers.push({
          kind: "PAUSE",
          months,
          resumeDate: addDaysTz(new Date(), months * 30, tz).toISOString(),
        });
        break;
      }
      case "DISCOUNT": {
        if (cancelFlow.reasonOfferPctDefault <= 0) break;
        // Anti-farming cooldown: a customer who already took the reason-offer
        // discount recently never sees the card again until the cooldown
        // elapses — otherwise re-walking the flow every ~2 cycles farms a
        // permanent discount (the exact behavior the module exists to avoid).
        if (await reasonOfferOnCooldown(shopId, contract, cancelFlow)) break;
        // Stacking cap: only offer what applyDiscountGrant will actually
        // grant on top of the plan's ongoing discount — never a percent the
        // cap would then quietly reduce.
        const clamp = await clampGrantPercentForContract(
          shopId,
          contract.lines,
          cancelFlow.reasonOfferPctDefault,
        );
        if (clamp.percent < 1) break; // no headroom → no discount card
        // The sweep's arithmetic (grantDiscountCents: per unit price ×
        // quantity, as applyGrantToCycle edits the cycle) — never a third
        // rounding of the same percent.
        offers.push({
          kind: "DISCOUNT",
          percent: clamp.percent,
          cycles: cancelFlow.reasonOfferCyclesDefault,
          estSavingsCentsPerCycle: grantDiscountCents(
            contract.lines.filter((l) => !l.isGift && !l.isOneTimeAddon),
            clamp.percent,
          ),
          currencyCode: contract.currencyCode,
        });
        break;
      }
      case "SWAP": {
        const line = contract.lines.find(
          (l) => !l.isGift && !l.isOneTimeAddon,
        );
        if (!line) break;
        try {
          const admin = await adminClientForShop(shop.domain);
          const options = await fetchSwapOptions(admin, shopId, contract, line);
          if (options.length === 0) break;
          offers.push({
            kind: "SWAP",
            lineId: line.id,
            lineTitle: line.title,
            options,
          });
        } catch (err) {
          // A Shopify hiccup must never block the cancel flow — skip the card.
          console.error(
            "[cancel] swap options fetch failed",
            contract.id,
            err,
          );
        }
        break;
      }
      case "DOWNSIZE": {
        // A cheaper configuration (v1.28.0) — a lower ARPU beats zero, and
        // unlike DISCOUNT it reprices nothing and trains nobody. Rendered
        // only when a genuinely cheaper option exists (the card must never
        // be an empty promise); every option's total comes from the same
        // pricing helper the accept path applies.
        if (!cancelFlow.downsizeSaveEnabled) break;
        if (!isActive) break;
        const line = downsizeTargetLine(contract);
        if (!line) break;
        const options = await buildDownsizeOptions(
          shopId,
          shop.domain,
          contract,
          line,
        );
        if (options.length === 0) break;
        // Live grant (or the applied one dunning is retrying) — disclosed on
        // the card, never silently omitted next to plan-price figures.
        let discount: { percent: number; cyclesRemaining: number } | null = null;
        try {
          const grant = await getActiveDiscountForCycle(contract.id);
          if (grant && grant.percent > 0 && grant.cyclesRemaining > 0) {
            discount = { percent: grant.percent, cyclesRemaining: grant.cyclesRemaining };
          }
          const parked = await loadParkedCycleDiscount(contract.id);
          if (parked) discount = { percent: parked.percent, cyclesRemaining: parked.cyclesRemaining };
        } catch (err) {
          console.error("[cancel] downsize: grant read failed", contract.id, err);
        }
        offers.push({
          kind: "DOWNSIZE",
          lineId: line.id,
          lineTitle: line.title,
          currentTotalCents: cycleSubtotalCents(contract),
          currencyCode: contract.currencyCode,
          options,
          ...(discount
            ? {
                discountPercent: discount.percent,
                discountCyclesRemaining: discount.cyclesRemaining,
              }
            : {}),
        });
        break;
      }
      case "GIFT": {
        // A free product on the next delivery — COGS instead of face-value
        // margin (OFFER_PLAYBOOK §2), picked per customer so it is always
        // something they don't have. Gated like DISCOUNT: a per-CUSTOMER
        // cooldown (re-walking the flow must not farm free products) and a
        // Shopify hiccup skips the card, never blocks the flow.
        if (!cancelFlow.giftSaveEnabled) break;
        if (await giftSaveOnCooldown(shopId, contract, cancelFlow)) break;
        try {
          const admin = await adminClientForShop(shop.domain);
          const pick = await pickGiftForContract({
            shopId,
            admin,
            contract,
          });
          if (!pick || pick.exhausted) break; // a repeat is no save sweetener
          offers.push({
            kind: "GIFT",
            variantId: pick.variantId,
            title: pick.label,
            imageUrl: pick.imageUrl,
            retailCents: pick.retailCents,
            currencyCode: contract.currencyCode,
          });
        } catch (err) {
          console.error(
            "[cancel] GIFT save pick failed, skipping card",
            contract.id,
            err,
          );
        }
        break;
      }
      case "EDUCATION": {
        offers.push({ kind: "EDUCATION" });
        break;
      }
      case "SUPPORT": {
        offers.push({ kind: "SUPPORT" });
        break;
      }
    }
  }
  return offers;
}

/**
 * Contract ids sharing this customer's email. Cooldowns are per PERSON
 * (v1.24.0): cancelling and re-subscribing on a fresh contract must not
 * reset the anti-farming clocks — the per-contract versions did exactly
 * that.
 */
async function contractIdsForCustomer(
  shopId: string,
  email: string,
): Promise<string[]> {
  const rows = await prisma.subscriptionContract.findMany({
    where: { shopId, email, isDemo: false },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Has a SAVE_FLOW gift been granted to this CUSTOMER within the cooldown? */
async function giftSaveOnCooldown(
  shopId: string,
  contract: { id: string; email: string },
  cancelFlow: { giftSaveCooldownDays: number },
): Promise<boolean> {
  if (cancelFlow.giftSaveCooldownDays <= 0) return false;
  const cutoff = new Date(
    Date.now() - cancelFlow.giftSaveCooldownDays * 24 * 3600_000,
  );
  const ids = await contractIdsForCustomer(shopId, contract.email);
  const prior = await prisma.giftGrant.findFirst({
    where: {
      contractId: { in: ids.length > 0 ? ids : [contract.id] },
      source: "SAVE_FLOW",
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });
  return prior != null;
}

/** Has a SAVE_OFFER grant been created for this CUSTOMER within the cooldown?
 * Per person (v1.24.0), not per contract — cancelling and re-subscribing on a
 * fresh contract must not reset the anti-farming clock. */
async function reasonOfferOnCooldown(
  shopId: string,
  contract: { id: string; email: string },
  cancelFlow: { reasonOfferCooldownDays: number },
): Promise<boolean> {
  if (cancelFlow.reasonOfferCooldownDays <= 0) return false;
  const cutoff = new Date(
    Date.now() - cancelFlow.reasonOfferCooldownDays * 24 * 3600_000,
  );
  const ids = await contractIdsForCustomer(shopId, contract.email);
  const prior = await prisma.discountGrant.findFirst({
    where: {
      contractId: { in: ids.length > 0 ? ids : [contract.id] },
      type: "SAVE_OFFER",
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });
  return prior != null;
}

/**
 * Persist the offers presented on step 3 and log `cancel.save_shown`.
 * Idempotent: re-rendering the same offer set (page refresh, back-navigation)
 * neither re-writes nor re-logs, and an already-recorded FINAL_DISCOUNT
 * marker is always preserved. The event payload carries each offer's
 * parameters so save-rate-by-offer is analyzable from the stream alone.
 */
export async function recordSaveShown(
  sessionId: string,
  saves: SaveOffer[],
): Promise<void> {
  const { session, contract } = await loadSessionContext(sessionId);
  const existing = savesShownArray(session);
  const { merged, changed } = mergeSavesShown(existing, saves);
  if (!changed) return;

  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { savesShown: asJson(merged) },
  });

  await logEvent({
    ...identity(contract),
    type: "cancel.save_shown",
    source: channelSource(session.channel),
    actor: "customer",
    payload: {
      sessionId: session.id,
      reason: session.reason,
      kinds: saves.map((s) => s.kind),
      offers: saves.map((s) => offerSummary(s)),
    },
  });
}

/** Compact, JSON-safe offer descriptor for event payloads. */
function offerSummary(offer: SaveOffer): Record<string, unknown> {
  switch (offer.kind) {
    case "DISCOUNT":
      return { kind: offer.kind, percent: offer.percent, cycles: offer.cycles };
    case "FINAL_DISCOUNT":
      return { kind: offer.kind, percent: offer.percent, cycles: offer.cycles };
    case "FREQUENCY":
      return {
        kind: offer.kind,
        suggestedWeeks: offer.suggestedWeeks,
        ...(offer.suggestedUnit != null
          ? {
              suggestedUnit: offer.suggestedUnit,
              suggestedCount: offer.suggestedCount,
            }
          : {}),
      };
    case "PAUSE":
      return { kind: offer.kind, months: offer.months };
    case "DELAY":
      return {
        kind: offer.kind,
        days: offer.days,
        newNextDate: offer.newNextDate,
        mode: offer.mode,
      };
    case "GIFT":
      return { kind: offer.kind, variantId: offer.variantId, title: offer.title };
    case "DOWNSIZE":
      return {
        kind: offer.kind,
        lineId: offer.lineId,
        currentTotalCents: offer.currentTotalCents,
        options: offer.options.map((o) => ({
          mode: o.mode,
          ...(o.quantity != null ? { quantity: o.quantity } : {}),
          ...(o.variantId ? { variantId: o.variantId } : {}),
          newTotalCents: o.newTotalCents,
        })),
      };
    default:
      return { kind: offer.kind };
  }
}

/**
 * Append the final offer to the presented list and log
 * `cancel.final_offer_shown` (once per session).
 */
export async function recordFinalOfferShown(
  sessionId: string,
): Promise<{ percent: number; cycles: number }> {
  const { session, contract } = await loadSessionContext(sessionId);
  const shown = savesShownArray(session);
  // Already shown: return exactly what savesShown recorded, so a page
  // refresh renders the same number the customer first saw (and the same
  // number acceptFinalOffer's re-clamp will grant).
  const prior = shown.find(
    (s): s is Extract<SaveOffer, { kind: "FINAL_DISCOUNT" }> =>
      s.kind === FINAL_DISCOUNT,
  );
  if (prior) return { percent: prior.percent, cycles: prior.cycles };

  const cancelFlow = await getSetting(contract.shopId, "cancelFlow");
  // Experiment overlay first (final_offer_depth — deterministic per
  // customer, frozen at this exposure), then the stacking cap: present the
  // percent that will actually be granted.
  const finalPct = await settingOverride({
    shopId: contract.shopId,
    email: contract.email,
    contractId: contract.id,
    path: "cancelFlow.finalOfferPct",
    current: cancelFlow.finalOfferPct,
  });
  const clamp = await clampGrantPercentForContract(
    contract.shopId,
    contract.lines,
    finalPct,
  );
  shown.push({
    kind: "FINAL_DISCOUNT",
    percent: clamp.percent,
    cycles: cancelFlow.finalOfferCycles,
  });

  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { savesShown: asJson(shown) },
  });

  await logEvent({
    ...identity(contract),
    type: "cancel.final_offer_shown",
    source: channelSource(session.channel),
    actor: "customer",
    payload: {
      sessionId: session.id,
      reason: session.reason,
      percent: clamp.percent,
      ...(clamp.clamped
        ? { requestedPercent: clamp.requestedPercent, clampedByStackingCap: true }
        : {}),
      cycles: cancelFlow.finalOfferCycles,
    },
  });

  return { percent: clamp.percent, cycles: cancelFlow.finalOfferCycles };
}

/** Has the step-4 final offer already been presented in this session? */
export function hasSeenFinalOffer(session: CancelSession): boolean {
  return savesShownArray(session).some((s) => s.kind === FINAL_DISCOUNT);
}

// ── Accepting saves ──────────────────────────────────────────────────────────

export interface AcceptSaveParams {
  /** FREQUENCY: exact new cadence — preferred over `weeks`. */
  frequency?: Frequency;
  /** FREQUENCY: new interval in weeks (legacy form field, mapped to WEEK).
   *  EXTEND_PAUSE: the offered choice's week count (must match a choice). */
  weeks?: number;
  /** PAUSE: months to pause. */
  months?: number;
  /** SWAP / DOWNSIZE */
  lineId?: string;
  variantId?: string;
  /** DOWNSIZE (fewer units): the new quantity — must equal the shown option. */
  quantity?: number;
  /**
   * EDUCATION / SUPPORT (v1.28.0, P5.1): the submitted Get-help form. These
   * two saves USED to close the session as SAVED on a bare "I'll keep it"
   * button next to a dead mailto: — a click nobody acted on counted as a
   * save. Now the save IS the request: without a submitted message the
   * accept is refused (analytics truth), and the request lands exactly like
   * a portal Get-help submit (support.requested event, SUPPORT_REQUEST
   * alert, Klaviyo, merchant email), tagged with the cancel reason/session.
   */
  support?: { topic: "DELIVERY" | "PAYMENT" | "PLAN" | "OTHER"; message: string };
}

/**
 * Execute an accepted save through the contract services, close the session
 * as SAVED, stamp contract.savedAt and return a confirmation payload for the
 * "saved" page. Idempotent: re-accepting the same kind on a closed session
 * rebuilds the confirmation without re-executing.
 */
/**
 * The extend choices a PAUSED contract may take right now — the same rule the
 * portal's pause banner uses (portal.pauseExtendChoicesWeeks, clamped from
 * the pause start by pause.maxMonths). Empty when not paused / no resume day.
 */
async function pausedExtendChoices(
  shopId: string,
  contract: LocalContractWithLines,
  tz: string,
): Promise<Array<{ weeks: number; resumeAt: Date }>> {
  if (contract.status !== "PAUSED" || !contract.resumeAt) return [];
  const [portalSettings, pauseSettings] = await Promise.all([
    getSetting(shopId, "portal"),
    getSetting(shopId, "pause"),
  ]);
  return pauseExtendChoices({
    resumeAt: contract.resumeAt,
    pausedAt: contract.pausedAt,
    weeks: (portalSettings as { pauseExtendChoicesWeeks?: unknown[] })
      .pauseExtendChoicesWeeks,
    maxMonths: pauseSettings.maxMonths,
    tz,
  });
}

export async function acceptSave(
  sessionId: string,
  saveKind: SaveKind,
  params: AcceptSaveParams = {},
  actor: string | null = "customer",
): Promise<SaveConfirmation> {
  const { session, contract, shop } = await loadSessionContext(sessionId);
  const source = channelSource(session.channel);
  const opts = { source, actor };
  // Concierge save (P3.7): the SUPPORT request is recorded, the subscription
  // stands, but a human still has to answer — the session closes as
  // SAVED_PENDING, distinct from SAVED for analytics (promoted by the
  // concierge job once the merchant resolves the alert; see
  // scheduled.server.ts).
  const closedOutcome = saveKind === "SUPPORT" ? SAVED_PENDING : "SAVED";

  if (
    (session.outcome === "SAVED" || session.outcome === SAVED_PENDING) &&
    session.saveAccepted === saveKind
  ) {
    return buildConfirmation(saveKind, contract, shop, params);
  }
  if (session.outcome != null) {
    throw new Error(
      `Cancel session ${session.id} already completed (${session.outcome})`,
    );
  }

  // Offer-gating is enforced, not just presented: a save can only be accepted
  // if it was actually offered in this session. PAUSE is exempt — it is the
  // flow's own always-available default alternative (step-1 one-tap pause runs
  // before anything is recorded). Everything else (notably DISCOUNT) must
  // appear in savesShown, so a crafted POST with a kind the reason never
  // unlocks is refused instead of executed.
  if (saveKind !== "PAUSE" && saveKind !== "EXTEND_PAUSE") {
    const shownKinds = savesShownArray(session).map((s) => s.kind);
    if (!shownKinds.includes(saveKind)) {
      throw new Error(
        `Save ${saveKind} was never offered in cancel session ${session.id}`,
      );
    }
  }

  // ── Claim the session BEFORE executing anything ────────────────────────────
  // Two concurrent submissions (saves page in one tab, confirm page in
  // another — back-button navigation makes this common) can both pass the
  // outcome==null read above. The FIRST write must therefore be an atomic
  // outcome-null claim: exactly one submission wins and executes its Shopify
  // mutation; the loser re-reads and takes the idempotent replay path. On any
  // execution failure the claim is reverted so the session is never left
  // closed as SAVED with no save behind it.
  const now = new Date();
  const claimed = await prisma.cancelSession.updateMany({
    where: { id: session.id, outcome: null },
    data: { outcome: closedOutcome, saveAccepted: saveKind, completedAt: now },
  });
  if (claimed.count === 0) {
    const settled = await prisma.cancelSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    if (
      (settled.outcome === "SAVED" || settled.outcome === SAVED_PENDING) &&
      settled.saveAccepted === saveKind
    ) {
      return buildConfirmation(saveKind, contract, shop, params);
    }
    throw new Error(
      `Cancel session ${session.id} already completed (${settled.outcome})`,
    );
  }

  let updated: LocalContractWithLines = contract;
  let swappedTitle: string | undefined;
  let skippedLineTitle: string | undefined;
  let discountPercent: number | undefined;
  let discountCycles: number | undefined;
  let giftTitle: string | undefined;
  let downsize: SaveConfirmation["downsize"];
  let concierge: SaveConfirmation["concierge"];

  try {
    // Plan lock window backstop (P3.8): the reducing saves are refused on a
    // locked contract however the POST was crafted — same set the offer
    // path hides. Customer channels only (ADMIN acts through its own tools).
    if (source !== "ADMIN" && LOCK_BLOCKED_SAVES.has(saveKind)) {
      const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
      if (lock.locked) {
        throw new Error(
          `Save ${saveKind} refused for contract ${contract.id}: inside the plan lock window until ${lock.until?.toISOString()}`,
        );
      }
    }
    // The contract can be cancelled outside this session (admin, Shopify-side
    // cancel mirrored by webhook) between the loader read and the claim —
    // never execute a save (or grant a discount) on a cancelled contract.
    const current = await prisma.subscriptionContract.findUniqueOrThrow({
      where: { id: contract.id },
      select: { status: true },
    });
    if (current.status === "CANCELLED") {
      throw new Error(
        `Contract ${contract.id} is cancelled — save ${saveKind} refused`,
      );
    }
    // A "pause" on an already-PAUSED contract changes nothing (pauseContract
    // returns early) — it must never close the session as SAVED (review
    // fix: analytics truth; the exit ramp is EXTEND_PAUSE).
    if (saveKind === "PAUSE" && current.status === "PAUSED") {
      throw new Error(
        `Contract ${contract.id} is already paused — save PAUSE refused (use EXTEND_PAUSE)`,
      );
    }
    if (saveKind === "EXTEND_PAUSE" && current.status !== "PAUSED") {
      throw new Error(
        `Contract ${contract.id} is not paused — save EXTEND_PAUSE refused`,
      );
    }

    await executeSaveKind();
  } catch (err) {
    // Revert the claim (only this call can have set it) so the session stays
    // open for a retry instead of recording a save that never executed.
    await prisma.cancelSession
      .update({
        where: { id: session.id },
        data: { outcome: null, saveAccepted: null, completedAt: null },
      })
      .catch((revertErr) => {
        console.error(
          "[cancel] acceptSave claim revert failed",
          session.id,
          revertErr,
        );
      });
    throw err;
  }

  async function executeSaveKind(): Promise<void> {
    // Same preparing gate at accept time (a card rendered before the charge
    // moment can be submitted after it) — refuse rather than edit the cycle
    // Shopify is billing.
    if (PREPARING_BLOCKED_SAVES.has(saveKind)) {
      const preparing = await isPreparingOrder(
        contract,
        await resolveChargeTiming(shop.id, shop.ianaTimezone),
      );
      if (preparing) {
        throw new Error(
          `Save ${saveKind} refused for contract ${contract.id}: the order is being prepared`,
        );
      }
    }
    switch (saveKind) {
    case "DELAY": {
      // Value-gating like every dated save: the day count comes from the
      // offer this session actually showed (savesShown is the record) — a
      // crafted POST cannot pick its own delay through the card. The mode
      // is re-derived from the merchant's CURRENT delay semantics; the card
      // only ever promised the date, which both modes set identically.
      const shownDelay = savesShownArray(session).find(
        (s): s is Extract<SaveOffer, { kind: "DELAY" }> => s.kind === "DELAY",
      );
      if (!shownDelay || shownDelay.days < 1) {
        throw new Error(
          `DELAY save was never offered in cancel session ${session.id}`,
        );
      }
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      if ((cancelFlow as { delaySaveEnabled?: boolean }).delaySaveEnabled === false) {
        throw new Error(
          `Delay save disabled for contract ${contract.id} (cancelFlow.delaySaveEnabled)`,
        );
      }
      // The next order must still be the one the card was computed on —
      // otherwise "+N days" lands on a different day than promised.
      if (
        !contract.nextBillingDate ||
        contract.nextBillingDate.toISOString() !== shownDelay.currentNextDate
      ) {
        throw new Error(
          `DELAY save refused for contract ${contract.id}: the next order moved since the offer`,
        );
      }
      const mode = delayModeFor(await getSetting(shop.id, "portal"), null);
      updated =
        mode === "reanchor"
          ? await delaySchedule(shop.domain, contract.id, { days: shownDelay.days }, opts)
          : await delayNextCycle(shop.domain, contract.id, { days: shownDelay.days }, opts);
      break;
    }
    case "SKIP": {
      // Per-line variant (P2.5): the accepted lineId must be one the SKIP
      // card actually offered (savesShown is the record) — otherwise a
      // crafted POST could target any line through the whole-order card.
      if (params.lineId) {
        const shownSkip = savesShownArray(session).find(
          (s): s is Extract<SaveOffer, { kind: "SKIP" }> => s.kind === "SKIP",
        );
        const offeredLine = shownSkip?.lines?.find(
          (l) => l.lineId === params.lineId,
        );
        if (!offeredLine) {
          throw new Error(
            `SKIP lineId ${String(params.lineId)} was not offered in cancel session ${session.id}`,
          );
        }
        try {
          updated = await skipLineThisCycle(
            shop.domain,
            contract.id,
            offeredLine.lineId,
            opts,
          );
          skippedLineTitle = offeredLine.title;
          break;
        } catch (err) {
          // Every other line is already "not this time": leaving this one
          // out would empty the order — the honest save is the whole-order
          // skip the portal points at too (review fix; the saved page reads
          // the cleared per-line flags and shows the whole-order copy).
          if (!(err instanceof CycleLineEditError && err.code === "LAST_LINE")) {
            throw err;
          }
        }
      }
      updated = await skipNextCycle(shop.domain, contract.id, opts);
      break;
    }
    case "EXTEND_PAUSE": {
      const choices = await pausedExtendChoices(shop.id, contract, shop.ianaTimezone);
      const choice = choices.find((c) => c.weeks === params.weeks);
      if (!choice) {
        throw new Error(
          `EXTEND_PAUSE weeks ${String(params.weeks)} is not an offered choice for contract ${contract.id}`,
        );
      }
      updated = await extendPause(shop.domain, contract.id, choice.resumeAt, opts);
      break;
    }
    case "FREQUENCY": {
      // Exact cadence preferred; bare weeks (already-rendered pages in the
      // transition window) map to WEEK.
      const freq: Frequency | null =
        params.frequency ??
        (params.weeks != null ? { unit: "WEEK", count: params.weeks } : null);
      // Offer-gating extends to the VALUE, not just the kind: the accepted
      // cadence must equal the suggestion this session actually showed
      // (savesShown is the record). Otherwise a crafted POST could pick any
      // in-limits cadence — including 1-day billing — through a card that
      // offered "slow down", which is neither the offer nor a choice the
      // portal's own frequency action would allow.
      const shownFrequency = savesShownArray(session).find(
        (s): s is Extract<SaveOffer, { kind: "FREQUENCY" }> =>
          s.kind === "FREQUENCY",
      );
      const offered: Frequency | null = shownFrequency
        ? shownFrequency.suggestedUnit != null &&
          shownFrequency.suggestedCount != null
          ? {
              unit: shownFrequency.suggestedUnit,
              count: shownFrequency.suggestedCount,
            }
          : // Offers persisted before v1.8.0 recorded only the week count.
            { unit: "WEEK", count: shownFrequency.suggestedWeeks }
        : null;
      if (!freq || !offered || !sameFrequency(freq, offered)) {
        throw new Error(
          `Frequency ${JSON.stringify(params.frequency ?? params.weeks ?? null)} was not the offered cadence in cancel session ${session.id}`,
        );
      }
      updated = await changeFrequency(shop.domain, contract.id, freq, opts);
      break;
    }
    case "PAUSE": {
      const months =
        params.months ??
        (await getSetting(shop.id, "cancelFlow")).pauseSuggestMonths;
      if (!Number.isInteger(months) || months < 1 || months > 6) {
        throw new Error(`Invalid pause months: ${String(params.months)}`);
      }
      updated = await pauseContract(shop.domain, contract.id, months, opts);
      break;
    }
    case "DISCOUNT": {
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      // Cooldown mirror of the getSavesForReason gate: a card the flow would
      // no longer show cannot be accepted from a stale/tampered form either.
      if (await reasonOfferOnCooldown(shop.id, contract, cancelFlow)) {
        throw new Error(
          `Discount save unavailable for contract ${contract.id}: a SAVE_OFFER grant exists within reasonOfferCooldownDays`,
        );
      }
      // Stacking cap: grant (and confirm) exactly what the cap allows. A
      // zero-headroom contract never saw the DISCOUNT card, so an accept for
      // it is a stale/tampered request — refuse rather than close as SAVED
      // with no grant behind it.
      const clamp = await clampGrantPercentForContract(
        shop.id,
        contract.lines,
        cancelFlow.reasonOfferPctDefault,
      );
      if (clamp.percent < 1) {
        throw new Error(
          `Discount save unavailable for contract ${contract.id}: no headroom under discountStacking.maxTotalDiscountPct`,
        );
      }
      discountPercent = clamp.percent;
      discountCycles = cancelFlow.reasonOfferCyclesDefault;
      // applyDiscountGrant logs `cancel.save_accepted` for type SAVE_OFFER —
      // the engine does not log a second one (see module JSDoc). The session
      // id rides along so event-stream analytics can join the accept to its
      // session/copyVariant without a DB-side CancelSession join.
      updated = await applyDiscountGrant(
        shop.domain,
        contract.id,
        {
          type: "SAVE_OFFER",
          percent: discountPercent,
          cycles: discountCycles,
          grantedBy: "cancel_flow",
          reason: session.reason,
          context: { sessionId: session.id },
        },
        opts,
      );
      break;
    }
    case "SWAP": {
      const { lineId, variantId } = params;
      if (!lineId || !variantId) {
        throw new Error("SWAP save requires lineId and variantId");
      }
      const line = contract.lines.find((l) => l.id === lineId);
      if (!line || line.isGift) {
        throw new Error(`Swap line ${lineId} not on contract ${contract.id}`);
      }
      // Value-gating like DOWNSIZE: the accepted variant must be one the
      // card actually showed for this line (savesShown is the record) — a
      // crafted POST cannot swap to an unshown or cross-product variant
      // through the save.
      const shownSwap = savesShownArray(session).find(
        (s): s is Extract<SaveOffer, { kind: "SWAP" }> => s.kind === "SWAP",
      );
      if (
        !shownSwap ||
        shownSwap.lineId !== lineId ||
        !shownSwap.options.some((o) => o.variantId === variantId)
      ) {
        throw new Error(
          `SWAP option ${variantId} was not offered for line ${lineId} in cancel session ${session.id}`,
        );
      }
      updated = await swapLineVariant(
        shop.domain,
        contract.id,
        lineId,
        variantId,
        opts,
      );
      swappedTitle =
        updated.lines.find((l) => l.id === lineId)?.title ?? line.title;
      break;
    }
    case "DOWNSIZE": {
      // Value-gating like FREQUENCY/GIFT: the accepted option must be one
      // the card actually showed (savesShown is the record) — a crafted
      // POST cannot pick an arbitrary quantity or variant through it.
      const shown = savesShownArray(session).find(
        (s): s is Extract<SaveOffer, { kind: "DOWNSIZE" }> =>
          s.kind === "DOWNSIZE",
      );
      if (!shown) {
        throw new Error(
          `DOWNSIZE save was never offered in cancel session ${session.id}`,
        );
      }
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      if (!cancelFlow.downsizeSaveEnabled) {
        throw new Error(
          `Downsize save disabled for contract ${contract.id} (cancelFlow.downsizeSaveEnabled)`,
        );
      }
      const { lineId } = params;
      if (!lineId || lineId !== shown.lineId) {
        throw new Error(
          `DOWNSIZE lineId ${String(lineId)} was not the offered line in cancel session ${session.id}`,
        );
      }
      const line = contract.lines.find((l) => l.id === lineId);
      if (!line) {
        throw new Error(`Downsize line ${lineId} not on contract ${contract.id}`);
      }
      const option = shown.options.find((o) =>
        params.quantity != null
          ? o.mode === "QUANTITY" && o.quantity === params.quantity
          : params.variantId != null && o.variantId === params.variantId,
      );
      if (!option) {
        throw new Error(
          `DOWNSIZE option ${JSON.stringify({ quantity: params.quantity ?? null, variantId: params.variantId ?? null })} was not offered in cancel session ${session.id}`,
        );
      }
      if (option.mode === "QUANTITY") {
        updated = await changeLineQuantity(
          shop.domain,
          contract.id,
          lineId,
          option.quantity as number,
          opts,
        );
      } else {
        updated = await swapLineVariant(
          shop.domain,
          contract.id,
          lineId,
          option.variantId as string,
          opts,
        );
      }
      downsize = {
        mode: option.mode,
        title: option.title,
        quantity: option.quantity,
        newTotalCents: option.newTotalCents,
        currencyCode: shown.currencyCode,
      };
      break;
    }
    case "GIFT": {
      // The accepted product is exactly the one the card showed — savesShown
      // is the record (the FREQUENCY value-gating pattern). Re-picking here
      // could resolve a different product than the customer said yes to.
      const shownGift = savesShownArray(session).find(
        (s): s is Extract<SaveOffer, { kind: "GIFT" }> => s.kind === "GIFT",
      );
      if (!shownGift) {
        throw new Error(
          `GIFT save was never offered in cancel session ${session.id}`,
        );
      }
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
      // Gate mirrors of the offer path — a card the flow would no longer
      // show cannot be accepted from a stale/tampered form.
      if (!cancelFlow.giftSaveEnabled) {
        throw new Error(
          `Gift save disabled for contract ${contract.id} (cancelFlow.giftSaveEnabled)`,
        );
      }
      if (await giftSaveOnCooldown(shop.id, contract, cancelFlow)) {
        throw new Error(
          `Gift save unavailable for contract ${contract.id}: a SAVE_FLOW gift exists within giftSaveCooldownDays`,
        );
      }

      // The grant rides the next chargeable cycle; a cycle read failure
      // falls back to order space and the gift engine's re-anchoring repairs
      // it pre-charge.
      let cycleIndex = contract.ordersCount + 1;
      if (contract.nextBillingDate) {
        try {
          const admin = await adminClientForShop(shop.domain);
          const cycle = await getBillingCycleByDate(
            admin,
            contract.shopifyContractId,
            contract.nextBillingDate,
          );
          if (cycle) cycleIndex = cycle.cycleIndex;
        } catch (err) {
          console.error(
            "[cancel] gift save cycle read failed — ordersCount fallback",
            contract.id,
            err,
          );
        }
      }

      const priorOnCycle = await prisma.giftGrant.findFirst({
        where: {
          contractId: contract.id,
          cycleIndex,
          variantId: shownGift.variantId,
        },
        select: { id: true },
      });
      if (!priorOnCycle) {
        // COGS stamp from the pool's merchant override; the analytics chain
        // (grant → rule → variant override → 0) covers the rest.
        const gifts = await getSetting(shop.id, "gifts");
        const poolEntry = gifts.pool.find(
          (p) => p.variantId === shownGift.variantId,
        );
        const grant = await prisma.giftGrant.create({
          data: {
            contractId: contract.id,
            ruleId: null,
            cycleIndex,
            variantId: shownGift.variantId,
            status: "SCHEDULED",
            unitCostCents:
              poolEntry && poolEntry.unitCostCents > 0
                ? poolEntry.unitCostCents
                : null,
            source: "SAVE_FLOW",
          },
        });
        await logEvent({
          ...identity(contract),
          type: "lifecycle.gift_scheduled",
          source,
          actor: "cancel_flow",
          payload: {
            grantId: grant.id,
            ruleId: null,
            ruleName: "Cancel-flow gift save",
            trigger: "SAVE_FLOW",
            cycleIndex,
            variantId: shownGift.variantId,
            variantTitle: shownGift.title,
            sessionId: session.id,
          },
        });
      }
      giftTitle = shownGift.title;
      break;
    }
    case "EDUCATION":
    case "SUPPORT": {
      // Nothing to mutate on the contract — the customer keeps subscribing.
      // The save is the submitted request (see AcceptSaveParams.support): a
      // bare accept — the pre-v1.28.0 "stay" button beside a mailto: nobody
      // could act on — is refused so SAVED means something happened.
      const message = params.support?.message?.trim() ?? "";
      if (!message) {
        throw new Error(
          `${saveKind} save for contract ${contract.id} requires a submitted support request`,
        );
      }
      // NOT wrapped: submitSupportRequest contains every downstream step
      // (alert, email, push-back) itself and only throws when the
      // `support.requested` record of truth could not be written. A save
      // whose request was never recorded is not a save (SAVED means a
      // request was submitted) — so the throw propagates to the claim-revert
      // path above, exactly like every other save kind, and the customer
      // gets the saves page back with the error to retry.
      const { submitSupportRequest } = await import(
        "~/lib/support/request.server"
      );
      const result = await submitSupportRequest({
        shopId: shop.id,
        shopDomain: shop.domain,
        contract,
        topic:
          params.support?.topic ??
          (saveKind === "SUPPORT"
            ? conciergeTopicForReason(session.reason)
            : "OTHER"),
        message,
        pushBack: false,
        surface: "cancel_flow",
        cancelReason: session.reason ?? null,
        cancelReasonDetail: session.reasonDetail ?? null,
        cancelSessionId: session.id,
        // Concierge save (P3.7): the alert carries the save flag so the
        // admin queue and the SLA job can tell a retention request from a
        // plain Get-help submit.
        saveRequest: saveKind === "SUPPORT",
        source,
        actor: actor ?? "customer",
      });
      if (saveKind === "SUPPORT") {
        // Concierge HOLD (P3.7): move the next order by
        // cancelFlow.conciergeHoldDays so nothing charges while a human
        // answers — only when the charge is more than 48h away (a same-week
        // order is already in motion), the contract is ACTIVE and not
        // locked. Contained: the request IS the save; a failed hold is
        // reported on the saved page, never a reverted save.
        const hold = await applyConciergeHold(shop, contract, opts);
        if (hold.updated) updated = hold.updated;
        concierge = {
          holdApplied: hold.applied,
          holdDays: hold.days,
          replyWithin: result.replyWithin,
        };
      }
      break;
    }
    }
  }

  // The session itself was already closed by the winning claim above.
  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: { savedAt: now },
  });

  if (saveKind !== "DISCOUNT") {
    await logEvent({
      ...identity(contract),
      type: "cancel.save_accepted",
      source,
      actor,
      payload: {
        sessionId: session.id,
        reason: session.reason,
        saveKind,
        ...(params.weeks ? { weeks: params.weeks } : {}),
        // Exact cadence rides alongside — `weeks` stays the approximation
        // (Klaviyo flows key on it).
        ...(params.frequency
          ? {
              weeks: approxWeeks(params.frequency.unit, params.frequency.count),
              unit: params.frequency.unit,
              count: params.frequency.count,
            }
          : {}),
        ...(params.months ? { months: params.months } : {}),
        ...(params.variantId ? { variantId: params.variantId } : {}),
        ...(skippedLineTitle
          ? { lineId: params.lineId, skippedLineTitle, perLine: true }
          : {}),
        ...(giftTitle ? { giftTitle } : {}),
        ...(downsize
          ? {
              downsizeMode: downsize.mode,
              ...(downsize.quantity != null
                ? { quantity: downsize.quantity }
                : {}),
              newTotalCents: downsize.newTotalCents,
            }
          : {}),
        ...(concierge
          ? {
              // Distinct from a full save in the stream too (P3.7): the
              // outcome is pending until the merchant answers.
              pending: true,
              holdApplied: concierge.holdApplied,
              holdDays: concierge.holdDays,
              replyWithin: concierge.replyWithin,
            }
          : {}),
      },
    });
  }

  return buildConfirmation(saveKind, updated, shop, {
    ...params,
    percent: discountPercent,
    cycles: discountCycles,
    swappedTitle,
    skippedLineTitle,
    giftTitle,
    downsize,
    concierge,
  });
}

/**
 * The Get-help topic the concierge (SUPPORT) card prefills from the cancel
 * reason (P3.7): shipping problems are a delivery topic, price / quantity
 * objections a plan conversation, everything else "something else". Pure —
 * the pages render it, the accept path uses it as the fallback topic.
 */
export function conciergeTopicForReason(
  reason: string | null | undefined,
): "DELIVERY" | "PAYMENT" | "PLAN" | "OTHER" {
  switch (reason) {
    case "SHIPPING_ISSUES":
      return "DELIVERY";
    case "TOO_EXPENSIVE":
    case "TOO_MUCH_PRODUCT":
      return "PLAN";
    default:
      return "OTHER";
  }
}

/** Fallback minimum lead time (hours) before the charge for the concierge
 * hold to apply — the merchant value is cancelFlow.conciergeHoldMinLeadHours
 * (golden rule 7); this only covers an unreadable settings row. */
export const CONCIERGE_HOLD_MIN_LEAD_HOURS_DEFAULT = 48;

/**
 * Whether the concierge hold WOULD apply right now (P3.7) — the SUPPORT card
 * promises the hold only when this says so, and the accept path applies it
 * under the same rule: cancelFlow.conciergeHoldDays > 0, ACTIVE, a next
 * order more than cancelFlow.conciergeHoldMinLeadHours away, not inside the
 * plan lock window (a hold is a schedule reduction). Pure apart from the
 * lock read; contained to false.
 */
export async function conciergeHoldPlan(
  shopId: string,
  contract: LocalContractWithLines,
  tz: string,
  now: Date = new Date(),
): Promise<{ days: number; applies: boolean; newNextDate: Date | null }> {
  let days = 0;
  let minLeadHours = CONCIERGE_HOLD_MIN_LEAD_HOURS_DEFAULT;
  try {
    const cf = (await getSetting(shopId, "cancelFlow")) as {
      conciergeHoldDays?: number;
      conciergeHoldMinLeadHours?: number;
    };
    days = cf.conciergeHoldDays ?? 0;
    minLeadHours = cf.conciergeHoldMinLeadHours ?? CONCIERGE_HOLD_MIN_LEAD_HOURS_DEFAULT;
  } catch (err) {
    console.error("[cancel] concierge hold: settings read failed", contract.id, err);
  }
  if (days <= 0 || contract.status !== "ACTIVE" || !contract.nextBillingDate) {
    return { days, applies: false, newNextDate: null };
  }
  if (contract.nextBillingDate.getTime() - now.getTime() <= minLeadHours * 3600_000) {
    return { days, applies: false, newNextDate: null };
  }
  try {
    if ((await resolveLockState(shopId, contract, tz, now)).locked) {
      return { days, applies: false, newNextDate: null };
    }
  } catch (err) {
    console.error("[cancel] concierge hold: lock read failed", contract.id, err);
    return { days, applies: false, newNextDate: null };
  }
  return {
    days,
    applies: true,
    newNextDate: addDaysTz(contract.nextBillingDate, days, tz),
  };
}

async function applyConciergeHold(
  shop: Shop,
  contract: LocalContractWithLines,
  opts: { source: EventSource; actor: string | null },
): Promise<{ applied: boolean; days: number; updated: LocalContractWithLines | null }> {
  const plan = await conciergeHoldPlan(shop.id, contract, shop.ianaTimezone);
  if (!plan.applies) return { applied: false, days: plan.days, updated: null };
  try {
    // Always a ONE-cycle hold (mode "once"), whatever portal.delayReanchors
    // says: the customer is told "we'll hold your next order until {date}
    // while we sort it out" — a temporary hold, never a permanent shift of
    // every later order (that would be a re-anchor the copy never promised).
    const updated = await delayNextCycle(shop.domain, contract.id, { days: plan.days }, opts);
    return { applied: true, days: plan.days, updated };
  } catch (err) {
    console.error("[cancel] concierge hold failed", contract.id, err);
    return { applied: false, days: plan.days, updated: null };
  }
}

function buildConfirmation(
  kind: SaveKind | typeof FINAL_DISCOUNT,
  contract: LocalContractWithLines,
  _shop: Shop,
  extras: AcceptSaveParams & {
    percent?: number;
    cycles?: number;
    swappedTitle?: string;
    skippedLineTitle?: string;
    giftTitle?: string;
    downsize?: SaveConfirmation["downsize"];
    concierge?: SaveConfirmation["concierge"];
  } = {},
): SaveConfirmation {
  // Exact cadence for the confirmation page's localized phrase; `weeks`
  // stays populated as its approximation for existing consumers.
  const frequency =
    extras.frequency ??
    (extras.weeks != null
      ? { unit: "WEEK" as const, count: extras.weeks }
      : contractFrequency(contract));
  return {
    kind,
    contract,
    percent: extras.percent,
    cycles: extras.cycles,
    months: extras.months,
    resumeAt: contract.resumeAt?.toISOString() ?? null,
    nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
    weeks: approxWeeks(frequency.unit, frequency.count),
    frequency,
    swappedTitle: extras.swappedTitle,
    skippedLineTitle: extras.skippedLineTitle,
    giftTitle: extras.giftTitle,
    downsize: extras.downsize,
    concierge: extras.concierge,
  };
}

// ── Final offer ──────────────────────────────────────────────────────────────

/**
 * The final offer is genuinely one-time: not eligible when the flow is
 * disabled, the pct is 0 (or the discount-stacking cap leaves it no
 * headroom), a FINAL_DISCOUNT save was accepted within the cooldown, a
 * SAVE_OFFER_FINAL grant was created within the cooldown, OR the offer was
 * already SHOWN within the cooldown (a decliner is not re-shown the same
 * "final" offer on every subsequent flow — that would teach customers the
 * flow bluffs). `excludeSessionId` exempts the current session's own
 * final_offer_shown event so a page refresh / accept after showing still
 * passes.
 */
export async function eligibleForFinalOffer(
  contractLocalId: string,
  opts?: { excludeSessionId?: string },
): Promise<boolean> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) return false;

  const cancelFlow = await getSetting(contract.shopId, "cancelFlow");
  if (!cancelFlow.enabled || cancelFlow.finalOfferPct <= 0) return false;

  // Stacking cap: an offer that would clamp to 0% is never shown.
  const clamp = await clampGrantPercentForContract(
    contract.shopId,
    contract.lines,
    cancelFlow.finalOfferPct,
  );
  if (clamp.percent < 1) return false;

  const cutoff = new Date(
    Date.now() - cancelFlow.finalOfferCooldownDays * 24 * 3600_000,
  );

  // Per PERSON (v1.24.0): the cooldown queries cover every contract on this
  // customer's email — a cancel-and-resubscribe must not mint a fresh
  // "genuinely once" final offer.
  const customerIds = await contractIdsForCustomer(
    contract.shopId,
    contract.email,
  );
  const idScope = customerIds.length > 0 ? customerIds : [contractLocalId];

  const priorFinalSave = await prisma.cancelSession.findFirst({
    where: {
      contractId: { in: idScope },
      saveAccepted: { in: [FINAL_DISCOUNT] },
      completedAt: { gte: cutoff },
    },
    select: { id: true },
  });
  if (priorFinalSave) return false;

  const priorGrant = await prisma.discountGrant.findFirst({
    where: {
      contractId: { in: idScope },
      type: "SAVE_OFFER_FINAL",
      createdAt: { gte: cutoff },
    },
    select: { id: true },
  });
  if (priorGrant) return false;

  // Show-once enforcement: any prior flow's final_offer_shown within the
  // cooldown blocks another showing (the current session's own event is
  // exempted so refresh/accept still work after recordFinalOfferShown).
  const priorShown = await prisma.subscriberEvent.findFirst({
    where: {
      contractId: { in: idScope },
      type: "cancel.final_offer_shown",
      createdAt: { gte: cutoff },
      ...(opts?.excludeSessionId
        ? {
            NOT: {
              payload: {
                path: ["sessionId"],
                equals: opts.excludeSessionId,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return priorShown == null;
}

/**
 * Accept the step-4 deeper offer: SAVE_OFFER_FINAL grant at settings
 * finalOfferPct × finalOfferCycles. `applyDiscountGrant` logs
 * `cancel.final_offer_accepted`; the session closes as SAVED/FINAL_DISCOUNT.
 */
export async function acceptFinalOffer(
  sessionId: string,
  actor: string | null = "customer",
): Promise<SaveConfirmation> {
  const { session, contract, shop } = await loadSessionContext(sessionId);
  const cancelFlow = await getSetting(shop.id, "cancelFlow");
  // Same experiment overlay as recordFinalOfferShown (deterministic per
  // customer, so show and accept always resolve the same depth), then the
  // stacking cap: grant (and confirm) exactly what the cap allows on top of
  // the plan's ongoing discount.
  const finalPct = await settingOverride({
    shopId: shop.id,
    email: contract.email,
    contractId: contract.id,
    path: "cancelFlow.finalOfferPct",
    current: cancelFlow.finalOfferPct,
  });
  const clamp = await clampGrantPercentForContract(
    shop.id,
    contract.lines,
    finalPct,
  );

  if (session.outcome === "SAVED" && session.saveAccepted === FINAL_DISCOUNT) {
    return buildConfirmation(FINAL_DISCOUNT, contract, shop, {
      percent: clamp.percent,
      cycles: cancelFlow.finalOfferCycles,
    });
  }
  if (session.outcome != null) {
    throw new Error(
      `Cancel session ${session.id} already completed (${session.outcome})`,
    );
  }
  if (
    !(await eligibleForFinalOffer(contract.id, {
      excludeSessionId: session.id,
    }))
  ) {
    throw new Error(
      `Contract ${contract.id} is not eligible for the final offer`,
    );
  }

  // Atomic outcome-null claim BEFORE the Shopify mutation — same race as
  // acceptSave: a concurrent confirm (or rival accept) must not execute
  // alongside this one and have the last session write win.
  const now = new Date();
  const claimed = await prisma.cancelSession.updateMany({
    where: { id: session.id, outcome: null },
    data: { outcome: "SAVED", saveAccepted: FINAL_DISCOUNT, completedAt: now },
  });
  if (claimed.count === 0) {
    const settled = await prisma.cancelSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    if (settled.outcome === "SAVED" && settled.saveAccepted === FINAL_DISCOUNT) {
      return buildConfirmation(FINAL_DISCOUNT, contract, shop, {
        percent: clamp.percent,
        cycles: cancelFlow.finalOfferCycles,
      });
    }
    throw new Error(
      `Cancel session ${session.id} already completed (${settled.outcome})`,
    );
  }

  let updated: LocalContractWithLines;
  try {
    // Re-check inside the claimed section: never grant onto a contract that
    // was cancelled through another path while this request was in flight.
    const current = await prisma.subscriptionContract.findUniqueOrThrow({
      where: { id: contract.id },
      select: { status: true },
    });
    if (current.status === "CANCELLED") {
      throw new Error(
        `Contract ${contract.id} is cancelled — final offer refused`,
      );
    }

    updated = await applyDiscountGrant(
      shop.domain,
      contract.id,
      {
        type: "SAVE_OFFER_FINAL",
        percent: clamp.percent,
        cycles: cancelFlow.finalOfferCycles,
        grantedBy: "cancel_flow",
        reason: session.reason,
        context: { sessionId: session.id },
      },
      { source: channelSource(session.channel), actor },
    );
  } catch (err) {
    // Revert the claim so the session stays open instead of recording a save
    // whose grant never happened.
    await prisma.cancelSession
      .update({
        where: { id: session.id },
        data: { outcome: null, saveAccepted: null, completedAt: null },
      })
      .catch((revertErr) => {
        console.error(
          "[cancel] acceptFinalOffer claim revert failed",
          session.id,
          revertErr,
        );
      });
    throw err;
  }

  // The session itself was already closed by the winning claim above.
  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: { savedAt: now },
  });

  return buildConfirmation(FINAL_DISCOUNT, updated, shop, {
    percent: clamp.percent,
    cycles: cancelFlow.finalOfferCycles,
  });
}

// ── Terminal cancel ──────────────────────────────────────────────────────────

/**
 * Complete the cancellation: cancelContract (source CUSTOMER — win-back
 * auto-schedules inside the service), close the session as CANCELLED and log
 * `cancel.completed`. Idempotent for an already-cancelled session/contract.
 */
export async function completeCancel(
  sessionId: string,
  actor: string | null = "customer",
): Promise<LocalContractWithLines> {
  const { session, contract, shop } = await loadSessionContext(sessionId);

  if (session.outcome === "CANCELLED" && contract.status === "CANCELLED") {
    return contract;
  }
  if (session.outcome != null && session.outcome !== "CANCELLED") {
    throw new Error(
      `Cancel session ${session.id} already completed (${session.outcome})`,
    );
  }

  // Reason fallback: a quick re-entry (deep link, "I still want to cancel")
  // may run on a session without a recorded reason even though the customer
  // stated one minutes earlier — prefer the most recent stated reason over
  // the meaningless OTHER bucket (7-day lookback keeps it honest).
  let reason = session.reason;
  if (reason == null) {
    const recent = await prisma.cancelSession.findFirst({
      where: {
        contractId: contract.id,
        reason: { not: null },
        startedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
      },
      orderBy: { startedAt: "desc" },
      select: { reason: true },
    });
    reason = recent?.reason ?? null;
  }
  reason = reason ?? "OTHER";
  const source = channelSource(session.channel);

  // ── Plan lock window backstop ──────────────────────────────────────────────
  // requireCancelContext already turns locked contracts away at the route, so
  // this is unreachable through today's flow — it exists for any future
  // caller built on the engine directly. Customer channels only: an ADMIN
  // channel cancel keeps working (support must always be able to release a
  // subscriber). Placed BEFORE the atomic session claim, matching the
  // engine's refuse-early pattern, so a refusal never leaves a claimed
  // session to revert.
  if (source !== "ADMIN") {
    const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
    if (lock.locked) {
      throw new Error(
        `Contract ${contract.id} is inside its plan lock window until ${lock.until?.toISOString()}`,
      );
    }
  }

  // ── Claim the session BEFORE the Shopify mutation ──────────────────────────
  // Same race as acceptSave/acceptFinalOffer: the confirm page in one tab and
  // the saves page in another can submit concurrently, and both pass the
  // outcome==null read above. The FIRST write is therefore an atomic
  // outcome-null claim — exactly one closure wins the session. Without it, a
  // save-accept and this cancel could BOTH execute their Shopify mutations
  // with the last session write deciding what the customer and the retention
  // analytics see. A session already claimed CANCELLED while the contract is
  // still live (hard crash between claim and mutation) skips the claim and
  // re-drives the cancel — the recovery path idempotent cancelContract makes
  // safe.
  const claimedHere = session.outcome == null;
  if (claimedHere) {
    // The resolved reason rides the claim: the cancel-flow analytics read
    // reasons from CancelSession rows, and a fallback reason that reached
    // only the cancel.completed event left exactly the decided cancellers
    // (re-entry sessions, deep links) with a null-reason row the loader's
    // histogram drops. One write keeps row and event telling the same story.
    const claimed = await prisma.cancelSession.updateMany({
      where: { id: session.id, outcome: null },
      data: { outcome: "CANCELLED", completedAt: new Date(), reason },
    });
    if (claimed.count === 0) {
      const settled = await prisma.cancelSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      if (settled.outcome !== "CANCELLED") {
        // A concurrent save won the session: that save is real — this cancel
        // must not run on top of it.
        throw new Error(
          `Cancel session ${session.id} already completed (${settled.outcome})`,
        );
      }
      // A rival confirm submission won the claim and owns the mutation plus
      // the cancel.completed event — report the mirror instead of
      // double-executing.
      return prisma.subscriptionContract.findUniqueOrThrow({
        where: { id: contract.id },
        include: { lines: true },
      });
    }
  }

  let updated: LocalContractWithLines;
  try {
    updated = await cancelContract(shop.domain, contract.id, reason, {
      source,
      actor,
      cancelSource: "CUSTOMER",
    });
  } catch (err) {
    if (claimedHere) {
      // Revert the claim (only this call can have set it) so the session
      // stays open for a retry instead of recording a cancel that never
      // reached Shopify. The reason reverts to its pre-claim value too — a
      // fallback written by the claim must not masquerade as customer-stated
      // on a session that is open again.
      await prisma.cancelSession
        .update({
          where: { id: session.id },
          data: { outcome: null, completedAt: null, reason: session.reason },
        })
        .catch((revertErr) => {
          console.error(
            "[cancel] completeCancel claim revert failed",
            session.id,
            revertErr,
          );
        });
    }
    throw err;
  }

  const shown = savesShownArray(session);
  await logEvent({
    ...identity(contract),
    type: "cancel.completed",
    source,
    actor,
    payload: {
      sessionId: session.id,
      reason,
      savesShownCount: shown.length,
      // Every offer the customer declined by completing the cancel — makes
      // decline-rate-by-offer computable from the event stream alone.
      savesShownKinds: shown.map((s) => s.kind),
    },
  });

  return updated;
}

// ── Scheduled cancel (plan lock window) ──────────────────────────────────────

/**
 * Locked contract (v1.28.0, P3.8): instead of turning the customer away, the
 * flow lets them SCHEDULE the cancellation for the unlock moment
 * (`SubscriptionContract.cancelScheduledAt` = lock.until, shop-tz midnight
 * of the displayed unlock date). The contract stays ACTIVE and bills as its
 * plan says until then; the hourly `cancel_scheduled_run` job (see
 * scheduled.server.ts) completes the cancel through the normal service path
 * with source CUSTOMER_PORTAL and the reason recorded here, and the billing
 * sweep refuses to bill past the scheduled moment. The session closes as
 * CANCEL_SCHEDULED while the schedule stands (the funnel sees the
 * customer's decision honestly); it settles to SAVED/saveAccepted KEEP when
 * the customer keeps (`keepScheduledCancel`) or CANCELLED when the job
 * executes it. Logs `cancel.scheduled`; the cancel_scheduled email is sent
 * contained.
 *
 * Refuses when the contract is NOT locked (an unlocked contract cancels
 * immediately — the generic "cancel after next delivery" is out of scope) or
 * when the session already closed.
 */
export async function scheduleCancel(
  sessionId: string,
  actor: string | null = "customer",
): Promise<{ contract: LocalContractWithLines; scheduledAt: Date }> {
  const { session, contract, shop } = await loadSessionContext(sessionId);
  const source = channelSource(session.channel);

  if (session.outcome === CANCEL_SCHEDULED && contract.cancelScheduledAt) {
    return { contract, scheduledAt: contract.cancelScheduledAt };
  }
  if (session.outcome != null) {
    throw new Error(
      `Cancel session ${session.id} already completed (${session.outcome})`,
    );
  }
  if (contract.status === "CANCELLED") {
    throw new Error(`Contract ${contract.id} is already cancelled`);
  }
  const cancelFlow = await getSetting(shop.id, "cancelFlow");
  if ((cancelFlow as { scheduledCancelEnabled?: boolean }).scheduledCancelEnabled === false) {
    throw new Error(
      `Scheduled cancel disabled for contract ${contract.id} (cancelFlow.scheduledCancelEnabled)`,
    );
  }
  const lock = await resolveLockState(shop.id, contract, shop.ianaTimezone);
  if (!lock.locked || !lock.until) {
    throw new Error(
      `Contract ${contract.id} is not inside a plan lock window — cancel immediately instead`,
    );
  }
  const scheduledAt = lock.until;

  // Reason: the session's own, else the most recent stated one (7 days),
  // else OTHER — the same fallback completeCancel applies, written onto the
  // session so the job cancels with the customer's real reason.
  let reason = session.reason;
  if (reason == null) {
    const recent = await prisma.cancelSession.findFirst({
      where: {
        contractId: contract.id,
        reason: { not: null },
        startedAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
      },
      orderBy: { startedAt: "desc" },
      select: { reason: true },
    });
    reason = recent?.reason ?? null;
  }
  reason = reason ?? "OTHER";

  const claimed = await prisma.cancelSession.updateMany({
    where: { id: session.id, outcome: null },
    data: { outcome: CANCEL_SCHEDULED, completedAt: new Date(), reason },
  });
  if (claimed.count === 0) {
    const settled = await prisma.cancelSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    if (settled.outcome === CANCEL_SCHEDULED) {
      const fresh = await prisma.subscriptionContract.findUniqueOrThrow({
        where: { id: contract.id },
        include: { lines: true },
      });
      return { contract: fresh, scheduledAt: fresh.cancelScheduledAt ?? scheduledAt };
    }
    throw new Error(
      `Cancel session ${session.id} already completed (${settled.outcome})`,
    );
  }

  let updated: LocalContractWithLines;
  try {
    updated = await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { cancelScheduledAt: scheduledAt },
      include: { lines: true },
    });
  } catch (err) {
    await prisma.cancelSession
      .update({
        where: { id: session.id },
        data: { outcome: null, completedAt: null, reason: session.reason },
      })
      .catch((revertErr) => {
        console.error("[cancel] scheduleCancel claim revert failed", session.id, revertErr);
      });
    throw err;
  }

  const shown = savesShownArray(session);
  await logEvent({
    ...identity(contract),
    type: "cancel.scheduled",
    source,
    actor,
    payload: {
      sessionId: session.id,
      reason,
      scheduledAt: scheduledAt.toISOString(),
      lockDays: lock.lockDays,
      savesShownCount: shown.length,
      savesShownKinds: shown.map((s) => s.kind),
    },
  });

  // Confirmation email — contained (golden rule 9).
  try {
    const { sendCancelScheduledEmail } = await import("./scheduled.server");
    await sendCancelScheduledEmail(shop, updated, scheduledAt);
  } catch (err) {
    console.error("[cancel] cancel_scheduled email failed", contract.id, err);
  }

  return { contract: updated, scheduledAt };
}

/**
 * Keep the subscription (v1.28.0, P3.8): clear a scheduled cancellation.
 * Atomic (only rows whose cancelScheduledAt is set flip), so the hourly job
 * — which re-reads under its lock right before cancelling — can never
 * cancel a contract the customer just kept. Portal "Keep my subscription",
 * the KEEP magic verb and admin all route here. Returns whether anything
 * was scheduled. Logs `cancel.schedule_kept`.
 */
export async function keepScheduledCancel(
  contractLocalId: string,
  options: { source: EventSource; actor?: string | null },
): Promise<boolean> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    select: {
      id: true,
      shopId: true,
      customerId: true,
      email: true,
      cancelScheduledAt: true,
    },
  });
  if (!contract || !contract.cancelScheduledAt) return false;
  const cleared = await prisma.subscriptionContract.updateMany({
    where: { id: contract.id, cancelScheduledAt: { not: null } },
    data: { cancelScheduledAt: null },
  });
  if (cleared.count === 0) return false;
  // The scheduling session's terminal outcome: a kept schedule is a save
  // (saveAccepted "KEEP") — kept and executed schedules must be
  // distinguishable at the session level (admin funnel, insights). Contained.
  try {
    const scheduled = await prisma.cancelSession.findFirst({
      where: { contractId: contract.id, outcome: CANCEL_SCHEDULED },
      orderBy: { completedAt: "desc" },
      select: { id: true },
    });
    if (scheduled) {
      // Guarded claim (updateMany on the current outcome), never a plain
      // update — the closure-race contract of this module.
      await prisma.cancelSession.updateMany({
        where: { id: scheduled.id, outcome: CANCEL_SCHEDULED },
        data: { outcome: "SAVED", saveAccepted: "KEEP", completedAt: new Date() },
      });
    }
  } catch (err) {
    console.error("[cancel] keep: session close failed", contract.id, err);
  }
  await logEvent({
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "cancel.schedule_kept",
    source: options.source,
    actor: options.actor ?? "customer",
    payload: { previousScheduledAt: contract.cancelScheduledAt.toISOString() },
  });
  return true;
}
