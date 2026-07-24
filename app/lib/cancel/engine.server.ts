import type { CancelSession, Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { addDaysTz, addWeeksTz } from "~/lib/dates.server";
import { adminClientForShop } from "~/shopify.server";
import { gql, type AdminClient } from "~/lib/graphql/client.server";
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
  FREQUENCY_SUGGEST_DELTA_WEEKS,
  MAX_SAVES_SHOWN,
  MAX_SWAP_OPTIONS,
  PAUSE_SUGGEST_MONTHS,
  SESSION_FRESH_MINUTES,
  copyVariantFor,
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
 * behind a recorded reason, capped at MAX_SAVES_SHOWN, and the final discount
 * is a genuinely-once offer enforced by settings.cancelFlow.finalOfferCooldownDays.
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
  weeks?: number;
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
 * ABANDONED first (a fresh flow always speaks for itself), then the new row
 * is created and `cancel.flow_started` is logged with the A/B copy variant so
 * analytics can split outcomes by copy.
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

  const stale = await prisma.cancelSession.updateMany({
    where: { contractId: contract.id, outcome: null },
    data: { outcome: "ABANDONED", completedAt: new Date() },
  });

  const session = await prisma.cancelSession.create({
    data: { contractId: contract.id, channel },
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
      copyVariant: copyVariantFor(contract.id),
    },
  });

  return session;
}

/**
 * The contract's current in-progress session, or null. Sessions older than
 * SESSION_FRESH_MINUTES are ignored (the next start abandons them), so a
 * refresh reuses the session but a returning visitor gets a fresh flow.
 */
export async function getActiveSession(
  contractLocalId: string,
): Promise<CancelSession | null> {
  const cutoff = new Date(Date.now() - SESSION_FRESH_MINUTES * 60_000);
  return prisma.cancelSession.findFirst({
    where: {
      contractId: contractLocalId,
      outcome: null,
      startedAt: { gte: cutoff },
    },
    orderBy: { startedAt: "desc" },
  });
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
 * and at most MAX_SAVES_SHOWN offers are returned, preserving order.
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
    if (offers.length >= MAX_SAVES_SHOWN) break;
    switch (kind) {
      case "SKIP": {
        if (!isActive || !contract.nextBillingDate) break;
        offers.push({
          kind: "SKIP",
          currentNextDate: contract.nextBillingDate.toISOString(),
          newNextDate: addWeeksTz(
            contract.nextBillingDate,
            contract.intervalWeeks,
            tz,
          ).toISOString(),
        });
        break;
      }
      case "FREQUENCY": {
        if (!isActive) break;
        const suggestedWeeks =
          contract.intervalWeeks + FREQUENCY_SUGGEST_DELTA_WEEKS;
        if (suggestedWeeks > 52) break;
        offers.push({
          kind: "FREQUENCY",
          currentWeeks: contract.intervalWeeks,
          suggestedWeeks,
          estNextDate: contract.nextBillingDate
            ? addWeeksTz(
                contract.nextBillingDate,
                FREQUENCY_SUGGEST_DELTA_WEEKS,
                tz,
              ).toISOString()
            : null,
        });
        break;
      }
      case "PAUSE": {
        if (contract.status !== "ACTIVE") break; // already paused → not an offer
        const months = Math.min(PAUSE_SUGGEST_MONTHS, pauseSettings.maxMonths);
        offers.push({
          kind: "PAUSE",
          months,
          resumeDate: addDaysTz(new Date(), months * 30, tz).toISOString(),
        });
        break;
      }
      case "DISCOUNT": {
        if (cancelFlow.reasonOfferPctDefault <= 0) break;
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

/**
 * Persist the offers presented on step 3 and log `cancel.save_shown`.
 * Idempotent: re-rendering the same offer set (page refresh) neither
 * re-writes nor re-logs.
 */
export async function recordSaveShown(
  sessionId: string,
  saves: SaveOffer[],
): Promise<void> {
  const { session, contract } = await loadSessionContext(sessionId);
  const existing = savesShownArray(session);
  const existingKinds = existing.map((s) => s.kind).join(",");
  const newKinds = saves.map((s) => s.kind).join(",");
  if (existing.length > 0 && existingKinds === newKinds) return;

  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { savesShown: asJson(saves) },
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
    },
  });
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
  /** FREQUENCY: new interval in weeks. */
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

  let updated: LocalContractWithLines = contract;
  let swappedTitle: string | undefined;
  let discountPercent: number | undefined;
  let discountCycles: number | undefined;

  switch (saveKind) {
    case "SKIP": {
      updated = await skipNextCycle(shop.domain, contract.id, opts);
      break;
    }
    case "FREQUENCY": {
      const weeks = params.weeks;
      if (!weeks || !Number.isInteger(weeks) || weeks < 1 || weeks > 52) {
        throw new Error(`Invalid frequency weeks: ${String(params.weeks)}`);
      }
      updated = await changeFrequency(shop.domain, contract.id, weeks, opts);
      break;
    }
    case "PAUSE": {
      const months = params.months ?? PAUSE_SUGGEST_MONTHS;
      if (!Number.isInteger(months) || months < 1 || months > 6) {
        throw new Error(`Invalid pause months: ${String(params.months)}`);
      }
      updated = await pauseContract(shop.domain, contract.id, months, opts);
      break;
    }
    case "DISCOUNT": {
      const cancelFlow = await getSetting(shop.id, "cancelFlow");
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
      // the engine does not log a second one (see module JSDoc).
      updated = await applyDiscountGrant(
        shop.domain,
        contract.id,
        {
          type: "SAVE_OFFER",
          percent: discountPercent,
          cycles: discountCycles,
          grantedBy: "cancel_flow",
          reason: session.reason,
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

  const now = new Date();
  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { outcome: "SAVED", saveAccepted: saveKind, completedAt: now },
  });
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
  return {
    kind,
    contract,
    percent: extras.percent,
    cycles: extras.cycles,
    months: extras.months,
    resumeAt: contract.resumeAt?.toISOString() ?? null,
    nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
    weeks: extras.weeks ?? contract.intervalWeeks,
    swappedTitle: extras.swappedTitle,
  };
}

// ── Final offer ──────────────────────────────────────────────────────────────

/**
 * The final offer is genuinely one-time: not eligible when the flow is
 * disabled, the pct is 0 (or the discount-stacking cap leaves it no
 * headroom), a FINAL_DISCOUNT save was accepted within the cooldown, or a
 * SAVE_OFFER_FINAL grant was created within the cooldown. This is what lets
 * the copy honestly say "we only offer this once".
 */
export async function eligibleForFinalOffer(
  contractLocalId: string,
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
  return priorGrant == null;
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
  if (!(await eligibleForFinalOffer(contract.id))) {
    throw new Error(
      `Contract ${contract.id} is not eligible for the final offer`,
    );
  }

  const updated = await applyDiscountGrant(
    shop.domain,
    contract.id,
    {
      type: "SAVE_OFFER_FINAL",
      percent: clamp.percent,
      cycles: cancelFlow.finalOfferCycles,
      grantedBy: "cancel_flow",
      reason: session.reason,
    },
    { source: channelSource(session.channel), actor },
  );

  const now = new Date();
  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { outcome: "SAVED", saveAccepted: FINAL_DISCOUNT, completedAt: now },
  });
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

  const reason = session.reason ?? "OTHER";
  const source = channelSource(session.channel);

  const updated = await cancelContract(shop.domain, contract.id, reason, {
    source,
    actor,
    cancelSource: "CUSTOMER",
  });

  await prisma.cancelSession.update({
    where: { id: session.id },
    data: { outcome: "CANCELLED", completedAt: new Date() },
  });

  await logEvent({
    ...identity(contract),
    type: "cancel.completed",
    source,
    actor,
    payload: {
      sessionId: session.id,
      reason,
      savesShownCount: savesShownArray(session).length,
    },
  });

  return updated;
}
