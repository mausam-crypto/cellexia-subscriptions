import type { ContractLine, SubscriptionContract, WinbackState } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { clampGrantPercentForContract } from "~/lib/billing/stacking.server";
import type { SettingsValue } from "~/lib/settings/registry.server";
import { addDaysTz } from "~/lib/dates.server";
import { buildMagicUrl } from "~/lib/magiclinks/builder.server";
import { sendNotification } from "~/lib/notifications/index.server";
import {
  contractActivate,
  setNextBillingDate as shopifySetNextBillingDate,
} from "~/lib/graphql/index.server";
import { applyDiscountGrant } from "~/lib/contracts/service.server";

/**
 * Win-back engine — staged re-acquisition of cancelled subscribers, timed to
 * the PREDICTED EMPTY DATE of their last delivery (analytics keeps
 * predictedEmptyDate fresh), not to the cancel date. Touching someone the week
 * their jar runs out converts; touching them the day they cancel annoys.
 *
 * Stages (offsets are days relative to predicted empty, from settings.winback):
 *   0 soft touch  — no offer; education / results framing        (winback_soft)
 *   1 perk        — free gift on reactivation, one-tap link      (winback_perk)
 *   2 discount    — capped % for N cycles, one-tap link      (winback_discount)
 *   3 sunset      — stop; Klaviyo suppression keys off winback.sunset
 *
 * The one-tap links are APPLY_WINBACK magic tokens; the magic route executes
 * them through reactivateFromWinback below. Customers who resubscribe
 * naturally (a new ACTIVE contract for the same email) are flipped to
 * WON_BACK by the sweep and never touched again. OPTED_OUT is always
 * respected. When a touch's moment has already passed (downtime backlog), the
 * sweep skips ahead to the stage that is relevant NOW instead of bursting
 * every stale offer in sequence.
 *
 * Idempotency: one WinbackState per contract (unique contractId); each touch
 * is deduped by event existence since the state's cancelledAt, so a crash
 * between notify and stage-advance never double-sends.
 */

type WinbackSettings = SettingsValue<"winback">;

type ContractWithLines = SubscriptionContract & { lines: ContractLine[] };

/** Reactivated subscribers get product quickly: bill 3 days out. */
const REACTIVATION_BILL_DELAY_DAYS = 3;
/** One-tap links stay valid a comfortable margin past the campaign window. */
const LINK_GRACE_DAYS = 14;

// ── Helpers ──────────────────────────────────────────────────────────────────

function contractEventBase(contract: SubscriptionContract) {
  return {
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };
}

/** Touch instant for a stage, in the shop timezone. */
function touchAtForStage(
  predictedEmpty: Date,
  stage: number,
  settings: WinbackSettings,
  tz: string,
): Date {
  const offsets = [
    settings.softTouchOffsetDays,
    settings.perkOffsetDays,
    settings.discountOffsetDays,
    settings.sunsetOffsetDays,
  ];
  const offset = offsets[Math.min(Math.max(stage, 0), 3)] ?? 0;
  return addDaysTz(predictedEmpty, offset, tz);
}

/** Has an event of `type` been logged for the contract since `since`? */
async function hasEventSince(
  contractId: string,
  type: string,
  since: Date,
): Promise<boolean> {
  const row = await prisma.subscriberEvent.findFirst({
    where: { contractId, type, createdAt: { gt: since } },
    select: { id: true },
  });
  return row !== null;
}

async function buildReactivationUrl(
  contract: SubscriptionContract,
  params: { percent: number; cycles: number; gift: boolean },
  ttlDays: number,
): Promise<string> {
  return buildMagicUrl({
    action: "APPLY_WINBACK",
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    params,
    ttlSeconds: Math.max(1, Math.round(ttlDays)) * 24 * 3600,
    maxUses: 1,
    createdVia: "KLAVIYO_FLOW",
  });
}

// ── Scheduling (called by cancelContract) ────────────────────────────────────

/**
 * Open (or restart) the win-back campaign for a cancelled contract. No-op for
 * merge-cancels (reason MERGED — an internal consolidation, the customer never
 * left), for non-cancelled contracts, when win-back is disabled, and when a
 * campaign is already ACTIVE or the customer OPTED_OUT.
 */
export async function scheduleWinback(
  contract: SubscriptionContract,
): Promise<WinbackState | null> {
  if (contract.status !== "CANCELLED") return null;
  if (contract.cancelReason === "MERGED") return null;

  const settings = await getSetting(contract.shopId, "winback");
  if (!settings.enabled) return null;

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: contract.shopId },
  });
  const tz = shop.ianaTimezone;

  const cancelledAt = contract.cancelledAt ?? new Date();
  const predictedEmptyDate =
    contract.predictedEmptyDate ??
    addDaysTz(cancelledAt, Math.max(1, contract.intervalWeeks) * 7, tz);
  const nextTouchAt = addDaysTz(
    predictedEmptyDate,
    settings.softTouchOffsetDays,
    tz,
  );

  const existing = await prisma.winbackState.findUnique({
    where: { contractId: contract.id },
  });
  if (existing?.status === "ACTIVE") return existing; // already scheduled
  if (existing?.status === "OPTED_OUT") return existing; // never re-engage

  let state: WinbackState;
  if (existing) {
    // WON_BACK or SUNSET and cancelled again — restart the campaign.
    state = await prisma.winbackState.update({
      where: { id: existing.id },
      data: {
        cancelledAt,
        predictedEmptyDate,
        stage: 0,
        nextTouchAt,
        status: "ACTIVE",
        wonBackAt: null,
      },
    });
  } else {
    state = await prisma.winbackState.create({
      data: {
        contractId: contract.id,
        shopId: contract.shopId,
        cancelledAt,
        predictedEmptyDate,
        stage: 0,
        nextTouchAt,
        status: "ACTIVE",
      },
    });
  }

  // Mirror the eligibility date onto the contract (best effort).
  try {
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { winbackEligibleAt: nextTouchAt },
    });
  } catch (err) {
    console.error("[winback] winbackEligibleAt update failed", contract.id, err);
  }

  await logEvent({
    ...contractEventBase(contract),
    type: "winback.scheduled",
    source: "SYSTEM",
    actor: "winback_engine",
    payload: {
      stateId: state.id,
      predictedEmptyDate: predictedEmptyDate.toISOString(),
      nextTouchAt: nextTouchAt.toISOString(),
      restarted: existing != null,
      cancelReason: contract.cancelReason,
      cancelSource: contract.cancelSource,
    },
  });

  return state;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface WinbackSweepStats {
  scanned: number;
  wonBack: number;
  softTouches: number;
  perksOffered: number;
  discountsOffered: number;
  sunsets: number;
  errors: number;
  skipped?: string;
}

/**
 * Hourly job (winback_run): flip naturally-resubscribed states to WON_BACK,
 * then fire every due touch and advance its state machine.
 */
export async function runWinbackSweep(now: Date): Promise<WinbackSweepStats> {
  const stats: WinbackSweepStats = {
    scanned: 0,
    wonBack: 0,
    softTouches: 0,
    perksOffered: 0,
    discountsOffered: 0,
    sunsets: 0,
    errors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const settings = await getSetting(shop.id, "winback");
  if (!settings.enabled) {
    stats.skipped = "disabled";
    return stats;
  }
  const tz = shop.ianaTimezone;

  const states = await prisma.winbackState.findMany({
    where: { shopId: shop.id, status: "ACTIVE" },
    orderBy: { nextTouchAt: "asc" },
    take: 500,
  });

  for (const state of states) {
    stats.scanned += 1;
    try {
      const contract = await prisma.subscriptionContract.findUnique({
        where: { id: state.contractId },
        include: { lines: true },
      });
      if (!contract) {
        // Orphaned state (contract purged) — close it so it stops sweeping.
        await prisma.winbackState.update({
          where: { id: state.id },
          data: { status: "SUNSET", nextTouchAt: null },
        });
        stats.errors += 1;
        console.error("[winback] state without contract sunset", state.id);
        continue;
      }

      // ── Natural win-back: same contract reactivated, or a new ACTIVE
      //    contract for the same email since the cancel. ────────────────────
      let naturalContractId: string | null = null;
      if (contract.status === "ACTIVE") {
        naturalContractId = contract.id;
      } else {
        const resubscribed = await prisma.subscriptionContract.findFirst({
          where: {
            shopId: shop.id,
            email: contract.email,
            status: "ACTIVE",
            isDemo: false,
            id: { not: contract.id },
            createdAt: { gt: state.cancelledAt },
          },
          select: { id: true },
        });
        naturalContractId = resubscribed?.id ?? null;
      }
      if (naturalContractId) {
        await prisma.winbackState.update({
          where: { id: state.id },
          data: { status: "WON_BACK", wonBackAt: now, nextTouchAt: null },
        });
        await logEvent({
          ...contractEventBase(contract),
          type: "winback.reactivated",
          source: "SYSTEM",
          actor: "winback_engine",
          payload: {
            stateId: state.id,
            natural: true,
            reactivatedContractId: naturalContractId,
            stage: state.stage,
          },
        });
        stats.wonBack += 1;
        continue;
      }

      if (!state.nextTouchAt || state.nextTouchAt.getTime() > now.getTime()) {
        continue; // not due yet
      }

      await processDueTouch(tz, settings, state, contract, now, stats);
    } catch (err) {
      stats.errors += 1;
      console.error("[winback] sweep failed for state", state.id, err);
    }
  }

  return stats;
}

async function processDueTouch(
  tz: string,
  settings: WinbackSettings,
  state: WinbackState,
  contract: ContractWithLines,
  now: Date,
  stats: WinbackSweepStats,
): Promise<void> {
  const predictedEmpty = state.predictedEmptyDate;

  // Skip ahead past touches whose moment has already gone: a subscriber whose
  // whole window elapsed during downtime gets the offer that is relevant NOW
  // (or goes straight to sunset), never a burst of stale emails.
  let stage = state.stage;
  while (
    stage < 3 &&
    touchAtForStage(predictedEmpty, stage + 1, settings, tz).getTime() <=
      now.getTime()
  ) {
    stage += 1;
  }

  const eventBase = contractEventBase(contract);
  const since = state.cancelledAt;

  if (stage >= 3) {
    // ── Sunset: stop touching; Klaviyo suppression keys off the event. ──────
    await prisma.winbackState.update({
      where: { id: state.id },
      data: { stage: 3, status: "SUNSET", nextTouchAt: null },
    });
    await logEvent({
      ...eventBase,
      type: "winback.sunset",
      source: "SYSTEM",
      actor: "winback_engine",
      payload: {
        stateId: state.id,
        predictedEmptyDate: predictedEmpty.toISOString(),
        stagesSkipped: 3 - state.stage,
      },
    });
    stats.sunsets += 1;
    return;
  }

  if (stage === 0) {
    // ── Soft touch: no offer — education / results framing. ─────────────────
    const already = await hasEventSince(contract.id, "winback.soft_touch", since);
    if (!already) {
      await sendNotification({
        shopId: contract.shopId,
        contractId: contract.id,
        template: "winback_soft",
        vars: {
          predicted_empty_date: predictedEmpty.toISOString(),
          stage: 0,
        },
      });
      await logEvent({
        ...eventBase,
        type: "winback.soft_touch",
        source: "SYSTEM",
        actor: "winback_engine",
        payload: {
          stateId: state.id,
          predictedEmptyDate: predictedEmpty.toISOString(),
        },
      });
      stats.softTouches += 1;
    }
    await prisma.winbackState.update({
      where: { id: state.id },
      data: {
        stage: 1,
        nextTouchAt: touchAtForStage(predictedEmpty, 1, settings, tz),
      },
    });
    return;
  }

  if (stage === 1) {
    // ── Perk: free gift on reactivation (no discount). ──────────────────────
    const already = await hasEventSince(
      contract.id,
      "winback.perk_offered",
      since,
    );
    if (!already) {
      const ttlDays =
        Math.max(0, settings.sunsetOffsetDays - settings.perkOffsetDays) +
        LINK_GRACE_DAYS;
      const reactivateUrl = await buildReactivationUrl(
        contract,
        { percent: 0, cycles: 0, gift: true },
        ttlDays,
      );
      await sendNotification({
        shopId: contract.shopId,
        contractId: contract.id,
        template: "winback_perk",
        vars: {
          reactivate_url: reactivateUrl,
          cta_url: reactivateUrl,
          gift: "true",
          stage: 1,
        },
      });
      await logEvent({
        ...eventBase,
        type: "winback.perk_offered",
        source: "SYSTEM",
        actor: "winback_engine",
        payload: {
          stateId: state.id,
          gift: true,
          predictedEmptyDate: predictedEmpty.toISOString(),
        },
      });
      stats.perksOffered += 1;
    }
    await prisma.winbackState.update({
      where: { id: state.id },
      data: {
        stage: 2,
        nextTouchAt: touchAtForStage(predictedEmpty, 2, settings, tz),
      },
    });
    return;
  }

  // ── Discount: capped % for N cycles — the last card we play. ──────────────
  const already = await hasEventSince(
    contract.id,
    "winback.discount_offered",
    since,
  );
  if (!already) {
    // Stacking cap: offer only what applyDiscountGrant will grant on top of
    // the plan's ongoing discount. Zero headroom → skip the discount touch
    // entirely (a 0% offer is worse than none) and advance to sunset timing.
    const clamp = await clampGrantPercentForContract(
      contract.shopId,
      contract.lines,
      settings.discountPct,
    );
    const percent = clamp.percent;
    const cycles = settings.discountCycles;
    if (percent >= 1) {
      const ttlDays =
        Math.max(0, settings.sunsetOffsetDays - settings.discountOffsetDays) +
        LINK_GRACE_DAYS;
      const reactivateUrl = await buildReactivationUrl(
        contract,
        { percent, cycles, gift: false },
        ttlDays,
      );
      await sendNotification({
        shopId: contract.shopId,
        contractId: contract.id,
        template: "winback_discount",
        vars: {
          reactivate_url: reactivateUrl,
          cta_url: reactivateUrl,
          discount_pct: percent,
          discount_cycles: cycles,
          stage: 2,
        },
      });
      await logEvent({
        ...eventBase,
        type: "winback.discount_offered",
        source: "SYSTEM",
        actor: "winback_engine",
        payload: {
          stateId: state.id,
          percent,
          ...(clamp.clamped
            ? {
                requestedPercent: clamp.requestedPercent,
                clampedByStackingCap: true,
              }
            : {}),
          cycles,
          predictedEmptyDate: predictedEmpty.toISOString(),
        },
      });
      stats.discountsOffered += 1;
    }
  }
  await prisma.winbackState.update({
    where: { id: state.id },
    data: {
      stage: 3,
      nextTouchAt: touchAtForStage(predictedEmpty, 3, settings, tz),
    },
  });
}

// ── Reactivation (magic-link executor) ───────────────────────────────────────

export interface ReactivateFromWinbackInput {
  /** Discount percent to grant (capped at settings.winback.discountPct). */
  percent?: number;
  /** Cycles the discount lasts; defaults to settings.winback.discountCycles. */
  cycles?: number;
  /** Grant the reactivation gift (from the cycle-2 surprise rule) next cycle. */
  gift?: boolean;
}

export interface ReactivateOptions {
  source?: EventSource;
  actor?: string | null;
}

/**
 * Reactivate a CANCELLED contract from an APPLY_WINBACK magic link (or the
 * admin): subscriptionContractActivate + next billing date in 3 days, then
 * the promised incentive — a WINBACK DiscountGrant (percent > 0) and/or a
 * SCHEDULED GiftGrant for the next cycle (the gift engine attaches it
 * pre-charge). Marks the WinbackState WON_BACK and logs winback.reactivated +
 * contract.activated. Returns the updated local contract (with lines) for the
 * magic-link result page. Idempotent: an already-ACTIVE contract just settles
 * the win-back bookkeeping.
 */
export async function reactivateFromWinback(
  contractLocalId: string,
  input: ReactivateFromWinbackInput = {},
  options?: ReactivateOptions,
) {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Subscription contract not found: ${contractLocalId}`);
  }
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: contract.shopId },
  });
  const source: EventSource = options?.source ?? "MAGIC_LINK";
  const actor = options?.actor ?? "customer";

  const settleWonBack = async () => {
    const state = await prisma.winbackState.findUnique({
      where: { contractId: contract.id },
    });
    if (state && state.status !== "WON_BACK") {
      await prisma.winbackState.update({
        where: { id: state.id },
        data: { status: "WON_BACK", wonBackAt: new Date(), nextTouchAt: null },
      });
    }
    return state;
  };

  if (contract.status === "ACTIVE") {
    // Link replay / double click after a successful reactivation.
    await settleWonBack();
    return prisma.subscriptionContract.findUniqueOrThrow({
      where: { id: contract.id },
      include: { lines: true },
    });
  }
  if (contract.status !== "CANCELLED") {
    throw new Error(
      `Contract ${contract.id} is ${contract.status} — win-back reactivation requires CANCELLED`,
    );
  }

  const settings = await getSetting(shop.id, "winback");
  const admin = await adminClientForShop(shop.domain);

  // ── 1. Reactivate on Shopify, bill soon. ───────────────────────────────────
  await contractActivate(admin, contract.shopifyContractId);

  const targetNext = addDaysTz(
    new Date(),
    REACTIVATION_BILL_DELAY_DAYS,
    shop.ianaTimezone,
  );
  let effectiveNext = targetNext;
  try {
    const dateResult = await shopifySetNextBillingDate(
      admin,
      contract.shopifyContractId,
      targetNext,
    );
    effectiveNext = dateResult.nextBillingDate ?? targetNext;
  } catch (err) {
    // The contract IS active again — a date failure must not undo that. The
    // scheduler bills on whatever date Shopify kept.
    console.error("[winback] setNextBillingDate failed", contract.id, err);
  }

  await prisma.subscriptionContract.update({
    where: { id: contract.id },
    data: {
      status: "ACTIVE",
      cancelledAt: null,
      cancelReason: null,
      cancelSource: null,
      failedAt: null,
      nextBillingDate: effectiveNext,
      winbackEligibleAt: null,
    },
  });

  // ── 2. Promised incentives. ────────────────────────────────────────────────
  // Cap at settings.winback.discountPct, then clamp against the discount-
  // stacking cap (plan ongoing discount + grant ≤ maxTotalDiscountPct) — the
  // same clamp used when the offer was sent, re-read here in case settings
  // changed between send and click. applyDiscountGrant enforces it again.
  const requestedPercent = Math.max(0, Math.floor(input.percent ?? 0));
  const stackingClamp = await clampGrantPercentForContract(
    shop.id,
    contract.lines,
    Math.min(requestedPercent, settings.discountPct),
  );
  const percent = stackingClamp.percent;
  const cycles = Math.max(1, Math.floor(input.cycles ?? settings.discountCycles));

  if (percent > 0) {
    try {
      await applyDiscountGrant(
        shop.domain,
        contract.id,
        {
          type: "WINBACK",
          percent,
          cycles,
          grantedBy: "winback_engine",
          reason: "winback_reactivation",
        },
        { source, actor },
      );
    } catch (err) {
      console.error("[winback] discount grant failed", contract.id, err);
    }
  }

  let giftGranted = false;
  if (input.gift) {
    try {
      giftGranted = await grantReactivationGift(shop.id, contract, source);
    } catch (err) {
      console.error("[winback] reactivation gift failed", contract.id, err);
    }
  }

  // ── 3. Bookkeeping + events. ───────────────────────────────────────────────
  const state = await settleWonBack();

  await logEvent({
    ...contractEventBase(contract),
    type: "winback.reactivated",
    source,
    actor,
    payload: {
      stateId: state?.id ?? null,
      natural: false,
      percent,
      cycles: percent > 0 ? cycles : 0,
      gift: giftGranted,
      nextBillingDate: effectiveNext.toISOString(),
    },
  });
  await logEvent({
    ...contractEventBase(contract),
    type: "contract.activated",
    source,
    actor,
    payload: {
      reason: "winback_reactivation",
      nextBillingDate: effectiveNext.toISOString(),
    },
  });

  return prisma.subscriptionContract.findUniqueOrThrow({
    where: { id: contract.id },
    include: { lines: true },
  });
}

/**
 * Grant the reactivation gift for the NEXT cycle, using the cycle-2 surprise
 * rule's variant when such a rule exists (gifts need a real variant — nothing
 * to grant without one). The gift engine attaches the SCHEDULED grant to the
 * cycle pre-charge. Returns true when a grant exists after the call.
 */
async function grantReactivationGift(
  shopId: string,
  contract: SubscriptionContract,
  source: EventSource,
): Promise<boolean> {
  const rule = await prisma.giftRule.findFirst({
    where: { shopId, active: true, trigger: "ORDER_INDEX", orderIndex: 2 },
    orderBy: { createdAt: "asc" },
  });
  if (!rule) return false;

  const cycleIndex = contract.ordersCount + 1;
  const existing = await prisma.giftGrant.findFirst({
    where: { contractId: contract.id, cycleIndex, variantId: rule.variantId },
    select: { id: true },
  });
  if (existing) return true; // already granted (link replay)

  const grant = await prisma.giftGrant.create({
    data: {
      contractId: contract.id,
      ruleId: rule.id,
      cycleIndex,
      variantId: rule.variantId,
      status: "SCHEDULED",
    },
  });

  await logEvent({
    ...contractEventBase(contract),
    type: "lifecycle.gift_scheduled",
    source,
    actor: "winback_engine",
    payload: {
      grantId: grant.id,
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: "WINBACK_REACTIVATION",
      cycleIndex,
      variantId: rule.variantId,
      variantTitle: rule.variantTitle,
    },
  });

  return true;
}
