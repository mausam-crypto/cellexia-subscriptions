import type { CancelSession, Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { addDaysTz, addIntervalTz } from "~/lib/dates.server";
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
  applyDiscountGrant,
  cancelContract,
  changeFrequency,
  pauseContract,
  skipNextCycle,
  swapLineVariant,
} from "~/lib/contracts/service.server";
import type { LocalContractWithLines } from "~/lib/contracts/shared.server";
import {
  FINAL_DISCOUNT,
  MAX_SWAP_OPTIONS,
  SESSION_FRESH_MINUTES,
  copyVariantFor,
  mergeSavesShown,
  reasonConfig,
  type CancelReason,
  type SaveKind,
} from "./config.server";

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
  displayPriceCents: number;
  imageUrl: string | null;
}

/** JSON-serializable offer shapes (dates as ISO strings) — persisted verbatim
 * into CancelSession.savesShown, so keep them stable. */
export type SaveOffer =
  | { kind: "SKIP"; currentNextDate: string | null; newNextDate: string | null }
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
    }
  | { kind: "PAUSE"; months: number; resumeDate: string }
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
  return prisma.cancelSession.findFirst({
    where: { contractId: contractLocalId, outcome: "SAVED" },
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
 * Sibling variants of the line's product (other sizes/formulas), priced for
 * display at the line's proportional subscriber discount. The authoritative
 * price is computed by swapLineVariant when the swap executes.
 */
async function fetchSwapOptions(
  admin: AdminClient,
  line: LocalContractWithLines["lines"][number],
): Promise<SwapOption[]> {
  const data = await gql<SwapSiblingsResponse>(admin, SWAP_SIBLINGS_QUERY, {
    id: line.productId,
  });
  const nodes = data.product?.variants?.nodes ?? [];
  const ratio =
    line.compareAtPriceCents && line.compareAtPriceCents > 0
      ? line.currentPriceCents / line.compareAtPriceCents
      : 1;

  const options: SwapOption[] = [];
  for (const node of nodes) {
    if (!node?.id || node.id === line.variantId) continue;
    if (node.availableForSale === false) continue;
    const baseCents = centsFromPrice(node.price);
    if (baseCents == null) continue;
    options.push({
      variantId: node.id,
      title: node.title || data.product?.title || line.title,
      displayPriceCents: Math.round(baseCents * ratio),
      imageUrl: node.image?.url ?? null,
    });
    if (options.length >= MAX_SWAP_OPTIONS) break;
  }
  return options;
}

/**
 * Map the reason's SaveKind order to concrete, ready-to-render offers using
 * settings.cancelFlow + the contract's real state. Inapplicable kinds are
 * skipped (e.g. PAUSE for an already-paused contract, SWAP with no siblings)
 * and at most settings.cancelFlow.maxSavesShown offers are returned,
 * preserving order.
 *
 * EDUCATION deliberately carries no URLs here: the routine-guide link and the
 * consultation contact are i18n-keyed copy (`cancel.saves.education.guide_url`
 * / `.consult_url`, defaulting to /pages/routine-guide and a mailto:) so
 * operators can retarget them per locale without a settings-registry change.
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

  const offers: SaveOffer[] = [];
  for (const kind of cfg.savesOrder) {
    if (offers.length >= cancelFlow.maxSavesShown) break;
    switch (kind) {
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
        offers.push({
          kind: "SKIP",
          currentNextDate: contract.nextBillingDate.toISOString(),
          newNextDate: newNextDate.toISOString(),
        });
        break;
      }
      case "FREQUENCY": {
        if (!isActive) break;
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
          // just later; the full new cadence starts after it.
          estNextDate: contract.nextBillingDate
            ? addIntervalTz(
                contract.nextBillingDate,
                suggested.unit,
                addedCount,
                tz,
              ).toISOString()
            : null,
        });
        break;
      }
      case "PAUSE": {
        if (contract.status !== "ACTIVE") break; // already paused → not an offer
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
        if (await reasonOfferOnCooldown(shopId, contract.id, cancelFlow)) break;
        // Stacking cap: only offer what applyDiscountGrant will actually
        // grant on top of the plan's ongoing discount — never a percent the
        // cap would then quietly reduce.
        const clamp = await clampGrantPercentForContract(
          shopId,
          contract.lines,
          cancelFlow.reasonOfferPctDefault,
        );
        if (clamp.percent < 1) break; // no headroom → no discount card
        const subtotal = cycleSubtotalCents(contract);
        offers.push({
          kind: "DISCOUNT",
          percent: clamp.percent,
          cycles: cancelFlow.reasonOfferCyclesDefault,
          estSavingsCentsPerCycle: Math.round(
            (subtotal * clamp.percent) / 100,
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
          const options = await fetchSwapOptions(admin, line);
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

/** Has a SAVE_OFFER grant been created for the contract within the cooldown? */
async function reasonOfferOnCooldown(
  shopId: string,
  contractLocalId: string,
  cancelFlow: { reasonOfferCooldownDays: number },
): Promise<boolean> {
  if (cancelFlow.reasonOfferCooldownDays <= 0) return false;
  const cutoff = new Date(
    Date.now() - cancelFlow.reasonOfferCooldownDays * 24 * 3600_000,
  );
  const prior = await prisma.discountGrant.findFirst({
    where: {
      contractId: contractLocalId,
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
    default:
      return { kind: offer.kind };
  }
}

/**
 * Append the final offer to the presented list and log
 * `cancel.final_offer_shown` (once per session).
 */
export async function recordFinalOfferShown(sessionId: string): Promise<void> {
  const { session, contract } = await loadSessionContext(sessionId);
  const shown = savesShownArray(session);
  if (shown.some((s) => s.kind === FINAL_DISCOUNT)) return;

  const cancelFlow = await getSetting(contract.shopId, "cancelFlow");
  // Stacking cap: present the percent that will actually be granted.
  const clamp = await clampGrantPercentForContract(
    contract.shopId,
    contract.lines,
    cancelFlow.finalOfferPct,
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
}

/** Has the step-4 final offer already been presented in this session? */
export function hasSeenFinalOffer(session: CancelSession): boolean {
  return savesShownArray(session).some((s) => s.kind === FINAL_DISCOUNT);
}

// ── Accepting saves ──────────────────────────────────────────────────────────

export interface AcceptSaveParams {
  /** FREQUENCY: exact new cadence — preferred over `weeks`. */
  frequency?: Frequency;
  /** FREQUENCY: new interval in weeks (legacy form field, mapped to WEEK). */
  weeks?: number;
  /** PAUSE: months to pause. */
  months?: number;
  /** SWAP */
  lineId?: string;
  variantId?: string;
}

/**
 * Execute an accepted save through the contract services, close the session
 * as SAVED, stamp contract.savedAt and return a confirmation payload for the
 * "saved" page. Idempotent: re-accepting the same kind on a closed session
 * rebuilds the confirmation without re-executing.
 */
export async function acceptSave(
  sessionId: string,
  saveKind: SaveKind,
  params: AcceptSaveParams = {},
  actor: string | null = "customer",
): Promise<SaveConfirmation> {
  const { session, contract, shop } = await loadSessionContext(sessionId);
  const source = channelSource(session.channel);
  const opts = { source, actor };

  if (session.outcome === "SAVED" && session.saveAccepted === saveKind) {
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
  if (saveKind !== "PAUSE") {
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
    data: { outcome: "SAVED", saveAccepted: saveKind, completedAt: now },
  });
  if (claimed.count === 0) {
    const settled = await prisma.cancelSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    if (settled.outcome === "SAVED" && settled.saveAccepted === saveKind) {
      return buildConfirmation(saveKind, contract, shop, params);
    }
    throw new Error(
      `Cancel session ${session.id} already completed (${settled.outcome})`,
    );
  }

  let updated: LocalContractWithLines = contract;
  let swappedTitle: string | undefined;
  let discountPercent: number | undefined;
  let discountCycles: number | undefined;

  try {
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
    switch (saveKind) {
    case "SKIP": {
      updated = await skipNextCycle(shop.domain, contract.id, opts);
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
      if (await reasonOfferOnCooldown(shop.id, contract.id, cancelFlow)) {
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
      if (!line) {
        throw new Error(`Swap line ${lineId} not on contract ${contract.id}`);
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
    case "EDUCATION":
    case "SUPPORT": {
      // Nothing to mutate on the contract — the customer keeps subscribing
      // and gets pointed at the routine guide / support channel.
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
      },
    });
  }

  return buildConfirmation(saveKind, updated, shop, {
    ...params,
    percent: discountPercent,
    cycles: discountCycles,
    swappedTitle,
  });
}

function buildConfirmation(
  kind: SaveKind | typeof FINAL_DISCOUNT,
  contract: LocalContractWithLines,
  _shop: Shop,
  extras: AcceptSaveParams & {
    percent?: number;
    cycles?: number;
    swappedTitle?: string;
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

  const priorFinalSave = await prisma.cancelSession.findFirst({
    where: {
      contractId: contractLocalId,
      saveAccepted: { in: [FINAL_DISCOUNT] },
      completedAt: { gte: cutoff },
    },
    select: { id: true },
  });
  if (priorFinalSave) return false;

  const priorGrant = await prisma.discountGrant.findFirst({
    where: {
      contractId: contractLocalId,
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
      contractId: contractLocalId,
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
  // Stacking cap: grant (and confirm) exactly what the cap allows on top of
  // the plan's ongoing discount — the same clamp recordFinalOfferShown used.
  const clamp = await clampGrantPercentForContract(
    shop.id,
    contract.lines,
    cancelFlow.finalOfferPct,
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
