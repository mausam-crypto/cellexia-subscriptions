import type { ContractLine, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";
import { pickGiftForContract } from "~/lib/gifts/picker.server";
import type { AdminClient } from "~/lib/graphql/index.server";
import type { EventSource } from "~/lib/events/log.server";
import {
  reactivateFromWinback,
  type ReactivateFromWinbackInput,
} from "./engine.server";

/**
 * One-tap restart + win-back offer parity (v1.28.0, P3.2 / P3.5).
 *
 * `restart_url` — a signed, single-use APPLY_WINBACK magic link carrying
 * `{ percent: 0, gift: false, restart: true }`, minted into cancel_confirmed
 * and winback_soft (the two win-back moments that carry NO offer of their
 * own). It lives settings.winback.restartLinkTtlDays (default 60). It does
 * not promise anything: what a tap grants is re-derived at tap time by
 * `deriveCurrentWinbackOffer` — the same rules and link TTLs the emailed
 * perk / discount legs use — so a customer restarting from any door
 * (cancel email, soft-touch email, portal card, portal landing) gets exactly
 * the offer the win-back engine currently stands behind, never less, never
 * an offer it will not honour.
 *
 * Offer derivation (server-side only — the form is never trusted):
 *   - the contract must be CANCELLED with a WinbackState (a campaign that
 *     actually ran); offers are read from the engine's own events since the
 *     state's cancelledAt — `winback.discount_offered {percent, cycles}` and
 *     `winback.perk_offered {giftTitle}` — newest first;
 *   - each offer expires exactly when its emailed one-tap link does:
 *     offeredAt + (sunsetOffsetDays − stageOffsetDays + linkGraceDays) days;
 *   - a discount is re-clamped against settings.winback.discountPct and the
 *     stacking cap (zero headroom = no discount offer);
 *   - a gift is only an offer when a gift can still be granted (dynamic pick
 *     when an admin client is available, else the ORDER_INDEX=2 fallback
 *     rule) — the same truth gate the perk email applies before sending.
 * Every read is contained: any failure resolves to "no offer", which is the
 * pre-1.28 behaviour (plain restart) — never a blocked restart.
 */

type WinbackSettings = SettingsValue<"winback">;
type ContractWithLines = SubscriptionContract & { lines: ContractLine[] };

export {
  RESTART_LINK_PARAMS,
  RESTART_LINK_TTL_DEFAULT_DAYS,
  buildRestartUrl,
  restartLinkTtlDays,
  restartLinkVars,
} from "./links.server";

// ── Current-offer derivation ─────────────────────────────────────────────────

export type WinbackOfferKind = "DISCOUNT" | "GIFT";

export interface WinbackOffer {
  kind: WinbackOfferKind;
  /** Discount percent after the settings cap + stacking clamp (0 for GIFT). */
  percent: number;
  /** Cycles the discount lasts (0 for GIFT). */
  cycles: number;
  gift: boolean;
  /** Human title of the gift the tap would grant (GIFT only, best effort). */
  giftTitle: string | null;
  /** When the engine made the offer (the emailed touch). */
  offeredAt: Date;
  /** When the emailed one-tap link for this offer dies — the offer with it. */
  expiresAt: Date;
  /** Win-back stage the offer came from (1 perk, 2 discount). */
  stage: number;
}

export interface DeriveOfferOptions {
  now?: Date;
  /** Admin client for the dynamic gift pick; without it only the ORDER_INDEX=2 rule vouches for a gift. */
  admin?: AdminClient | null;
  settings?: WinbackSettings;
}

function offerTtlDays(settings: WinbackSettings, stageOffsetDays: number): number {
  return (
    Math.max(0, settings.sunsetOffsetDays - stageOffsetDays) +
    settings.linkGraceDays
  );
}

/** Same arithmetic as the engine's `ttlSeconds` (whole days). */
export function offerExpiresAt(
  offeredAt: Date,
  settings: WinbackSettings,
  stage: 1 | 2,
): Date {
  const days = offerTtlDays(
    settings,
    stage === 1 ? settings.perkOffsetDays : settings.discountOffsetDays,
  );
  return new Date(
    offeredAt.getTime() + Math.max(1, Math.round(days)) * 24 * 3600 * 1000,
  );
}

async function giftTitleForOffer(
  contract: ContractWithLines,
  admin: AdminClient | null | undefined,
  payloadTitle: string | null,
): Promise<string | null> {
  if (admin) {
    try {
      const pick = await pickGiftForContract({
        shopId: contract.shopId,
        admin,
        contract,
      });
      if (pick) return pick.label;
    } catch (err) {
      console.error("[winback] offer gift preview failed", contract.id, err);
    }
  }
  const rule = await prisma.giftRule.findFirst({
    where: {
      shopId: contract.shopId,
      active: true,
      trigger: "ORDER_INDEX",
      orderIndex: 2,
    },
    orderBy: { createdAt: "asc" },
  });
  if (rule) return rule.variantTitle ?? rule.name ?? payloadTitle;
  return null;
}

/**
 * The offer the win-back engine currently stands behind for this contract,
 * or null (plain restart). See the module note for the rules.
 */
export async function deriveCurrentWinbackOffer(
  contract: ContractWithLines,
  opts: DeriveOfferOptions = {},
): Promise<WinbackOffer | null> {
  try {
    if (contract.status !== "CANCELLED") return null;
    if (!isBillableOwnership(contract.ownership) || contract.isDemo) return null;
    const now = opts.now ?? new Date();
    const settings =
      opts.settings ?? (await getSetting(contract.shopId, "winback"));

    const state = await prisma.winbackState.findUnique({
      where: { contractId: contract.id },
    });
    if (!state) return null;

    const events = await prisma.subscriberEvent.findMany({
      where: {
        contractId: contract.id,
        type: { in: ["winback.discount_offered", "winback.perk_offered"] },
        createdAt: { gt: state.cancelledAt },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    for (const ev of events) {
      const payload = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "winback.discount_offered") {
        const expiresAt = offerExpiresAt(ev.createdAt, settings, 2);
        if (expiresAt.getTime() <= now.getTime()) continue;
        const offered =
          typeof payload.percent === "number" && Number.isFinite(payload.percent)
            ? Math.floor(payload.percent)
            : 0;
        const requested = Math.min(Math.max(0, offered), settings.discountPct);
        if (requested < 1) continue;
        const clamp = await clampGrantPercentForContract(
          contract.shopId,
          contract.lines,
          requested,
        );
        if (clamp.percent < 1) continue;
        const cycles =
          typeof payload.cycles === "number" && Number.isFinite(payload.cycles)
            ? Math.max(1, Math.floor(payload.cycles))
            : settings.discountCycles;
        return {
          kind: "DISCOUNT",
          percent: clamp.percent,
          cycles,
          gift: false,
          giftTitle: null,
          offeredAt: ev.createdAt,
          expiresAt,
          stage: 2,
        };
      }
      if (ev.type === "winback.perk_offered") {
        const expiresAt = offerExpiresAt(ev.createdAt, settings, 1);
        if (expiresAt.getTime() <= now.getTime()) continue;
        const payloadTitle =
          typeof payload.giftTitle === "string" ? payload.giftTitle : null;
        const giftTitle = await giftTitleForOffer(contract, opts.admin, payloadTitle);
        if (!giftTitle) continue; // nothing to grant — never promise it
        return {
          kind: "GIFT",
          percent: 0,
          cycles: 0,
          gift: true,
          giftTitle,
          offeredAt: ev.createdAt,
          expiresAt,
          stage: 1,
        };
      }
    }
    return null;
  } catch (err) {
    console.error("[winback] offer derivation failed", contract.id, err);
    return null;
  }
}

/** reactivateFromWinback input for an offer (plain restart when null). */
export function offerToReactivateInput(
  offer: WinbackOffer | null,
): ReactivateFromWinbackInput {
  if (!offer) return { percent: 0, gift: false };
  return offer.kind === "DISCOUNT"
    ? { percent: offer.percent, cycles: offer.cycles, gift: false }
    : { percent: 0, gift: true };
}

/**
 * Restart a CANCELLED contract applying the CURRENT offer (parity across
 * every restart door). Returns the offer that was applied (null = plain
 * restart) and the updated contract.
 */
export async function reactivateWithCurrentOffer(
  contract: ContractWithLines,
  opts: {
    source: EventSource;
    actor?: string | null;
    admin?: AdminClient | null;
    now?: Date;
  },
): Promise<{
  offer: WinbackOffer | null;
  contract: Awaited<ReturnType<typeof reactivateFromWinback>>;
}> {
  const offer = await deriveCurrentWinbackOffer(contract, {
    admin: opts.admin,
    now: opts.now,
  });
  const updated = await reactivateFromWinback(
    contract.id,
    offerToReactivateInput(offer),
    { source: opts.source, actor: opts.actor },
  );
  return { offer, contract: updated };
}
