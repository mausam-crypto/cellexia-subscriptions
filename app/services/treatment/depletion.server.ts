/**
 * Depletion engine — predicts when a subscriber runs out of product and turns
 * behavioural signals (delays, skips, extra purchases, survey answers,
 * deliveries) into an evolving per-contract-line usage estimate.
 *
 * IMPORTANT (spec): depletion estimates are INFORMATIONAL ONLY. They feed
 * lifecycle events, incentives and dashboards — they NEVER auto-change a
 * contract's delivery frequency. The only module that may move a date is the
 * autopilot (autopilot.server.ts), and only inside guardrails the customer
 * set themselves.
 *
 * Pure math (predictRunOutDate / updateEstimateFromSignal) is exported
 * separately from the Prisma I/O so it is unit-testable
 * (tests/treatment/depletion.test.ts).
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { addDays, daysBetween, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { parseJson } from "~/types/domain";
import type { DepletionSignal, LifecycleEvent } from "~/types/domain";

// ─────────────────────────────── Tunables ─────────────────────────────────

/** Run-out later than nextDelivery + this many days ⇒ LIKELY_EXCESS_INVENTORY. */
export const EXCESS_THRESHOLD_DAYS = 21;
/** Run-out earlier than nextDelivery − this many days ⇒ LIKELY_PRODUCT_SHORTAGE. */
export const SHORTAGE_THRESHOLD_DAYS = 7;

const MIN_CONFIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;
/** A direct survey answer is the strongest signal we get. */
const SURVEY_CONFIDENCE = 0.9;
const SIGNAL_LOG_LIMIT = 50;
/** Don't re-nudge the same contract about the same direction within this window. */
const NUDGE_COOLDOWN_DAYS = 14;

/**
 * Behavioural multipliers applied to estimatedDailyUsage:
 * - EARLY_DELAY (customer pushed the delivery out early)      → usage ×0.85 (−15%)
 * - BROUGHT_FORWARD (customer pulled the delivery in)          → usage ×1.15 (+15%)
 * - REPEATED_SKIPS (skipping cycle after cycle)                → usage ×0.75 (−25%)
 * - EXTRA_ONE_TIME_PURCHASE (bought more outside the plan)     → usage ×1.20 (+20%)
 */
export const SIGNAL_USAGE_MULTIPLIERS: Partial<Record<DepletionSignal, number>> = {
  EARLY_DELAY: 0.85,
  BROUGHT_FORWARD: 1.15,
  REPEATED_SKIPS: 0.75,
  EXTRA_ONE_TIME_PURCHASE: 1.2,
};

// ─────────────────────────────── Pure math ────────────────────────────────

export interface RunOutInput {
  deliveredAt: Date;
  /** Units delivered (bottles/jars) — or content units when unitContents is omitted. */
  unitsDelivered: number;
  /** Estimated consumption per day, in content units (ml/g/…). Must be > 0. */
  dailyUsage: number;
  /** Contents per unit (ml/g). Defaults to 1, i.e. unitsDelivered is already in content units. */
  unitContents?: number;
}

/**
 * predictedRunOutAt = deliveredAt + (unitsDelivered × unitContents / dailyUsage) days.
 * Guards against non-positive dailyUsage — callers must skip lines without a
 * usable usage estimate rather than divide by zero.
 */
export function predictRunOutDate(input: RunOutInput): Date {
  const unitContents = input.unitContents ?? 1;
  if (!Number.isFinite(input.dailyUsage) || input.dailyUsage <= 0) {
    throw new RangeError("predictRunOutDate: dailyUsage must be > 0");
  }
  if (!Number.isFinite(input.unitsDelivered) || input.unitsDelivered < 0) {
    throw new RangeError("predictRunOutDate: unitsDelivered must be >= 0");
  }
  if (!Number.isFinite(unitContents) || unitContents <= 0) {
    throw new RangeError("predictRunOutDate: unitContents must be > 0");
  }
  const days = (input.unitsDelivered * unitContents) / input.dailyUsage;
  return addDays(input.deliveredAt, days);
}

export interface EstimateState {
  /** Content units (ml/g) consumed per day. */
  estimatedDailyUsage: number;
  /** 0..1 — how much we trust the current estimate. */
  confidence: number;
  /** Content units on hand as of `anchorAt` (null when unknown). */
  unitsOnHand: number | null;
  lastDeliveryAt: Date | null;
  /** Moment `unitsOnHand` was last known (defaults to lastDeliveryAt). */
  anchorAt?: Date | null;
}

export interface DepletionSignalMeta {
  /** SURVEY_OVERRIDE: product remaining reported by the customer, in content units. */
  reportedUnitsRemaining?: number;
  /** DELIVERY_RECEIVED: content units added (quantity × unitContents). */
  unitsAdded?: number;
  /** DELIVERY_RECEIVED: when the delivery landed (defaults to now). */
  deliveredAt?: Date;
  /** Clock injection so the function stays pure and testable. */
  now?: Date;
  /** Callers may attach extra context (e.g. orderId) — logged verbatim. */
  [key: string]: unknown;
}

export interface EstimateUpdate {
  estimatedDailyUsage: number;
  confidence: number;
  unitsOnHand: number | null;
  lastDeliveryAt: Date | null;
  /** Moment the returned `unitsOnHand` refers to — anchor for run-out prediction. */
  anchorAt: Date;
  /** Human-readable description for the signal log. */
  adjustment: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Fold one behavioural signal into an estimate. Pure — no I/O.
 *
 * - EARLY_DELAY / BROUGHT_FORWARD / REPEATED_SKIPS / EXTRA_ONE_TIME_PURCHASE
 *   scale estimatedDailyUsage by the documented multiplier and slightly lower
 *   confidence (behavioural inference is indirect evidence).
 * - SURVEY_OVERRIDE sets unitsOnHand directly from the reported remaining
 *   amount and, when enough history exists, recalibrates daily usage from
 *   actual consumption. Confidence jumps to 0.9.
 * - DELIVERY_RECEIVED adds the delivered content units to the (decayed)
 *   carry-over on hand and advances lastDeliveryAt.
 */
export function updateEstimateFromSignal(
  state: EstimateState,
  signal: DepletionSignal,
  meta: DepletionSignalMeta = {},
): EstimateUpdate {
  const now = meta.now ?? new Date();
  const prevAnchor = state.anchorAt ?? state.lastDeliveryAt ?? null;

  if (signal === "SURVEY_OVERRIDE") {
    const reported = meta.reportedUnitsRemaining;
    if (reported == null || !Number.isFinite(reported) || reported < 0) {
      throw new Error("SURVEY_OVERRIDE requires meta.reportedUnitsRemaining >= 0");
    }
    let usage = state.estimatedDailyUsage;
    if (state.unitsOnHand != null && prevAnchor) {
      const elapsedDays = daysBetween(prevAnchor, now);
      const consumed = state.unitsOnHand - reported;
      if (elapsedDays >= 1 && consumed > 0) {
        usage = consumed / elapsedDays;
      }
    }
    const recalibrated = usage !== state.estimatedDailyUsage;
    return {
      estimatedDailyUsage: usage,
      confidence: SURVEY_CONFIDENCE,
      unitsOnHand: reported,
      lastDeliveryAt: state.lastDeliveryAt,
      anchorAt: now,
      adjustment: `SURVEY_OVERRIDE: units on hand set to ${reported}${
        recalibrated ? `; daily usage recalibrated to ${usage.toFixed(2)}` : ""
      }`,
    };
  }

  if (signal === "DELIVERY_RECEIVED") {
    const deliveredAt = meta.deliveredAt ?? now;
    const added = meta.unitsAdded ?? 0;
    let carried = 0;
    if (state.unitsOnHand != null && prevAnchor) {
      const elapsedDays = Math.max(0, daysBetween(prevAnchor, deliveredAt));
      carried = Math.max(0, state.unitsOnHand - elapsedDays * state.estimatedDailyUsage);
    }
    return {
      estimatedDailyUsage: state.estimatedDailyUsage,
      confidence: clamp(state.confidence + 0.05, MIN_CONFIDENCE, MAX_CONFIDENCE),
      unitsOnHand: carried + added,
      lastDeliveryAt: deliveredAt,
      anchorAt: deliveredAt,
      adjustment: `DELIVERY_RECEIVED: +${added} content units on hand (carry-over ${carried.toFixed(1)})`,
    };
  }

  const multiplier = SIGNAL_USAGE_MULTIPLIERS[signal];
  if (multiplier == null) {
    throw new Error(`updateEstimateFromSignal: unhandled signal ${signal}`);
  }
  return {
    estimatedDailyUsage: state.estimatedDailyUsage * multiplier,
    confidence: clamp(state.confidence - 0.05, MIN_CONFIDENCE, MAX_CONFIDENCE),
    unitsOnHand: state.unitsOnHand,
    lastDeliveryAt: state.lastDeliveryAt,
    anchorAt: prevAnchor ?? now,
    adjustment: `${signal}: daily usage ×${multiplier}`,
  };
}

// ─────────────────────────────── Persistence ──────────────────────────────

interface SignalLogEntry {
  at: string;
  signal: DepletionSignal;
  adjustment: string;
}

function lastLogAt(signalsJson: string | null | undefined): Date | null {
  const log = parseJson<SignalLogEntry[]>(signalsJson, []);
  if (log.length === 0) return null;
  const at = new Date(log[log.length - 1].at);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Persist a depletion signal against a contract line: fold it into the
 * estimate, recompute predictedRunOutAt and append to the signal log.
 */
export async function registerDepletionSignal(
  shop: string,
  contractLineId: string,
  signal: DepletionSignal,
  meta: DepletionSignalMeta = {},
) {
  const line = await prisma.contractLine.findUnique({
    where: { id: contractLineId },
    include: { contract: true, depletion: true },
  });
  if (!line || line.contract.shop !== shop) {
    throw new Error(`registerDepletionSignal: contract line not found: ${contractLineId}`);
  }
  const productMeta = await prisma.productMeta.findUnique({
    where: { shop_shopifyProductId: { shop, shopifyProductId: line.shopifyProductId } },
  });
  const unitContents = productMeta?.unitContents ?? 1;
  const existing = line.depletion;

  const state: EstimateState = {
    estimatedDailyUsage: existing?.estimatedDailyUsage ?? productMeta?.defaultDailyUsage ?? 1,
    confidence: existing?.confidence ?? 0.5,
    unitsOnHand: existing?.unitsOnHand ?? null,
    lastDeliveryAt: existing?.lastDeliveryAt ?? null,
    anchorAt: lastLogAt(existing?.signalsJson) ?? existing?.lastDeliveryAt ?? null,
  };

  const effectiveMeta: DepletionSignalMeta = { ...meta };
  if (signal === "DELIVERY_RECEIVED" && effectiveMeta.unitsAdded == null) {
    effectiveMeta.unitsAdded = line.quantity * unitContents;
  }

  const updated = updateEstimateFromSignal(state, signal, effectiveMeta);

  const predictedRunOutAt =
    updated.unitsOnHand != null && updated.estimatedDailyUsage > 0
      ? predictRunOutDate({
          deliveredAt: updated.anchorAt,
          unitsDelivered: updated.unitsOnHand,
          dailyUsage: updated.estimatedDailyUsage,
        })
      : existing?.predictedRunOutAt ?? null;

  const log = parseJson<SignalLogEntry[]>(existing?.signalsJson, []);
  log.push({ at: updated.anchorAt.toISOString(), signal, adjustment: updated.adjustment });
  const signalsJson = JSON.stringify(log.slice(-SIGNAL_LOG_LIMIT));

  const data = {
    estimatedDailyUsage: updated.estimatedDailyUsage,
    confidence: updated.confidence,
    unitsOnHand: updated.unitsOnHand,
    lastDeliveryAt: updated.lastDeliveryAt,
    predictedRunOutAt,
    signalsJson,
  };
  const estimate = await prisma.depletionEstimate.upsert({
    where: { contractLineId },
    create: { contractLineId, ...data },
    update: data,
  });

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "DEPLETION_SIGNAL",
    subjectType: "ContractLine",
    subjectId: contractLineId,
    payload: {
      signal,
      adjustment: updated.adjustment,
      predictedRunOutAt: predictedRunOutAt ? predictedRunOutAt.toISOString() : null,
    },
  });

  return estimate;
}

// ─────────────────────────────── Scan job ─────────────────────────────────

/**
 * Recompute predictedRunOutAt for every line of every ACTIVE contract and
 * compare against the next delivery:
 * - run-out more than EXCESS_THRESHOLD_DAYS after the next delivery
 *   ⇒ emit LIKELY_EXCESS_INVENTORY (nudge: offer to delay).
 * - run-out more than SHORTAGE_THRESHOLD_DAYS before the next delivery
 *   ⇒ emit LIKELY_PRODUCT_SHORTAGE (nudge: offer to bring forward / top up).
 *
 * At most one nudge per contract per direction per NUDGE_COOLDOWN_DAYS.
 * Never changes the schedule itself — informational only.
 */
export async function runDepletionScanJob(
  shop?: string,
): Promise<{ scannedLines: number; excess: number; shortage: number }> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: { status: "ACTIVE", ...(shop ? { shop } : {}) },
    include: { lines: { include: { depletion: true } } },
  });

  const counters = { scannedLines: 0, excess: 0, shortage: 0 };
  const now = new Date();
  const metaCache = new Map<string, { unitContents: number | null } | null>();

  const metaFor = async (contractShop: string, productId: string) => {
    const key = `${contractShop}|${productId}`;
    if (!metaCache.has(key)) {
      const meta = await prisma.productMeta.findUnique({
        where: { shop_shopifyProductId: { shop: contractShop, shopifyProductId: productId } },
        select: { unitContents: true },
      });
      metaCache.set(key, meta);
    }
    return metaCache.get(key) ?? null;
  };

  for (const contract of contracts) {
    const nextDelivery = contract.nextDeliveryDate ?? contract.nextBillingDate;
    for (const line of contract.lines) {
      const est = line.depletion;
      if (!est || est.estimatedDailyUsage <= 0) continue;
      counters.scannedLines += 1;

      const anchor = lastLogAt(est.signalsJson) ?? est.lastDeliveryAt;
      let runOut: Date;
      if (est.unitsOnHand != null && anchor) {
        runOut = predictRunOutDate({
          deliveredAt: anchor,
          unitsDelivered: est.unitsOnHand,
          dailyUsage: est.estimatedDailyUsage,
        });
      } else if (est.lastDeliveryAt) {
        const meta = await metaFor(contract.shop, line.shopifyProductId);
        runOut = predictRunOutDate({
          deliveredAt: est.lastDeliveryAt,
          unitsDelivered: line.quantity,
          dailyUsage: est.estimatedDailyUsage,
          unitContents: meta?.unitContents ?? 1,
        });
      } else {
        continue; // nothing to anchor a prediction on yet
      }

      if (!est.predictedRunOutAt || est.predictedRunOutAt.getTime() !== runOut.getTime()) {
        await prisma.depletionEstimate.update({
          where: { id: est.id },
          data: { predictedRunOutAt: runOut },
        });
      }

      if (!nextDelivery) continue;
      // gapDays > 0: product outlasts the next delivery date.
      const gapDays = daysBetween(nextDelivery, runOut);
      let name: LifecycleEvent | null = null;
      if (gapDays > EXCESS_THRESHOLD_DAYS) name = "LIKELY_EXCESS_INVENTORY";
      else if (gapDays < -SHORTAGE_THRESHOLD_DAYS) name = "LIKELY_PRODUCT_SHORTAGE";
      if (!name) continue;

      // Scan runs daily — suppress repeats within the cooldown window.
      const recent = await prisma.analyticsEvent.findFirst({
        where: {
          shop: contract.shop,
          name,
          contractId: contract.id,
          occurredAt: { gte: addDays(now, -NUDGE_COOLDOWN_DAYS) },
        },
        select: { id: true },
      });
      if (recent) continue;

      await emitLifecycleEvent({
        shop: contract.shop,
        name,
        contractId: contract.id,
        shopifyCustomerId: contract.shopifyCustomerId,
        email: contract.customerEmail,
        payload: {
          contractLineId: line.id,
          shopifyProductId: line.shopifyProductId,
          title: line.title,
          predictedRunOutAt: runOut.toISOString(),
          nextDeliveryAt: nextDelivery.toISOString(),
          gapDays,
          // Informational nudge only — the customer stays in control.
          suggestion:
            name === "LIKELY_EXCESS_INVENTORY"
              ? "You seem well stocked — you can delay your next delivery in a few clicks. Adjust, delay or cancel online."
              : "You may run low before your next delivery — bring it forward or add a top-up whenever it suits you. Adjust, delay or cancel online.",
        },
        dedupeKey: `depletion:${name}:${line.id}:${isoDate(nextDelivery)}`,
      });
      if (name === "LIKELY_EXCESS_INVENTORY") counters.excess += 1;
      else counters.shortage += 1;
    }
  }

  logger.info("depletion scan complete", { shop: shop ?? "all", ...counters });
  return counters;
}
