import prisma from "~/db.server";
import { subDays } from "date-fns";
import { OPEN_DUNNING_STATES } from "./queries.server";

/**
 * Churn-risk scoring + predicted-empty-date computation.
 *
 * Both are derived analytics fields recomputed wholesale by scheduled jobs;
 * they are intentionally not event-logged (no canonical event type exists and
 * per-contract logging every run would flood the event log / Klaviyo outbox).
 */

/** Days without a portal.login event before a subscriber counts as disengaged. */
const LOGIN_LOOKBACK_DAYS = 120;

/** Cancelled contracts older than this are skipped by empty-date prediction (win-back has sunset by then). */
const CANCELLED_LOOKBACK_DAYS = 180;

/** Fallback when a product has no ProductCadence row. */
const DEFAULT_DAYS_TO_EMPTY = 56;

/** Skip re-writing predictedEmptyDate when it moved by less than this. */
const EMPTY_DATE_WRITE_TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6h

const DAY_MS = 86_400_000;

/**
 * Heuristic churn-risk score per ACTIVE contract, written to
 * SubscriptionContract.churnRiskScore (0..1, higher = riskier).
 *
 * Additive factors (clamped to 1):
 * - +0.25 open dunning case (OPEN / RETRYING / AWAITING_CUSTOMER / AWAITING_3DS)
 * - +0.20 skipped the last cycle (lastSkippedAt within the last intervalWeeks)
 * - +0.15 early-cycle hazard: ordersCount ≤ 2
 * - +0.10 consecutiveFailures > 0
 * - +0.15 habitual skipper: skipCount ÷ max(ordersCount, 1) ≥ 0.4
 * - +0.15 disengaged: no portal.login event in 120 days (matched on
 *   contractId, customerId or email)
 *
 * Writes are batched with one updateMany per distinct score, and skipped when
 * the stored score already matches.
 */
export async function runChurnRiskScoring(
  shopId: string,
  now: Date = new Date(),
): Promise<{ scored: number; updated: number }> {
  const loginCutoff = subDays(now, LOGIN_LOOKBACK_DAYS);

  const [contracts, openCases, logins] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, status: "ACTIVE", isDemo: false },
      select: {
        id: true,
        customerId: true,
        email: true,
        intervalWeeks: true,
        ordersCount: true,
        skipCount: true,
        consecutiveFailures: true,
        lastSkippedAt: true,
        churnRiskScore: true,
      },
    }),
    prisma.dunningCase.findMany({
      where: { contract: { shopId }, state: { in: OPEN_DUNNING_STATES } },
      select: { contractId: true },
    }),
    prisma.subscriberEvent.findMany({
      where: { shopId, type: "portal.login", createdAt: { gte: loginCutoff } },
      select: { contractId: true, customerId: true, email: true },
    }),
  ]);

  const openDunningContractIds = new Set(openCases.map((c) => c.contractId));
  const loginContractIds = new Set<string>();
  const loginCustomerIds = new Set<string>();
  const loginEmails = new Set<string>();
  for (const login of logins) {
    if (login.contractId) loginContractIds.add(login.contractId);
    if (login.customerId) loginCustomerIds.add(login.customerId);
    if (login.email) loginEmails.add(login.email.toLowerCase());
  }

  const idsByScore = new Map<number, string[]>();
  for (const contract of contracts) {
    let score = 0;

    if (openDunningContractIds.has(contract.id)) score += 0.25;

    const intervalMs = Math.max(1, contract.intervalWeeks) * 7 * DAY_MS;
    if (
      contract.lastSkippedAt &&
      now.getTime() - contract.lastSkippedAt.getTime() <= intervalMs
    ) {
      score += 0.2;
    }

    if (contract.ordersCount <= 2) score += 0.15;
    if (contract.consecutiveFailures > 0) score += 0.1;
    if (contract.skipCount / Math.max(contract.ordersCount, 1) >= 0.4) {
      score += 0.15;
    }

    const loggedIn =
      loginContractIds.has(contract.id) ||
      loginCustomerIds.has(contract.customerId) ||
      loginEmails.has(contract.email.toLowerCase());
    if (!loggedIn) score += 0.15;

    const finalScore = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
    const stored = contract.churnRiskScore;
    if (stored != null && Math.abs(stored - finalScore) < 0.0005) continue;

    const ids = idsByScore.get(finalScore) ?? [];
    ids.push(contract.id);
    idsByScore.set(finalScore, ids);
  }

  let updated = 0;
  for (const [score, ids] of idsByScore) {
    const res = await prisma.subscriptionContract.updateMany({
      where: { id: { in: ids } },
      data: { churnRiskScore: score },
    });
    updated += res.count;
  }

  return { scored: contracts.length, updated };
}

// ── Predicted empty dates ─────────────────────────────────────────────────────

/**
 * predictedEmptyDate per contract, written to
 * SubscriptionContract.predictedEmptyDate.
 *
 * Formula: anchor + maxDays where
 * - anchor = latest successful BillingAttempt.completedAt
 *   ?? firstChargeAt ?? now (the last time product shipped);
 * - maxDays = max over non-gift lines of
 *   (ProductCadence.estDaysToEmpty for the variant, falling back to the
 *   product-level row, else 56) × max(1, quantity) — quantity > 1 means the
 *   customer has proportionally more supply.
 *
 * Covers ACTIVE and PAUSED contracts plus contracts cancelled in the last 180
 * days (win-back touches are timed to this date). Also used by contextual
 * portal prompts and fast-shipping detection.
 */
export async function runPredictedEmptyDates(
  shopId: string,
  now: Date = new Date(),
): Promise<{ scanned: number; updated: number }> {
  const [contracts, cadences, lastSuccessGroups] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        isDemo: false,
        OR: [
          { status: { in: ["ACTIVE", "PAUSED"] } },
          {
            status: "CANCELLED",
            cancelledAt: { gte: subDays(now, CANCELLED_LOOKBACK_DAYS) },
          },
        ],
      },
      select: {
        id: true,
        firstChargeAt: true,
        predictedEmptyDate: true,
        lines: {
          select: {
            productId: true,
            variantId: true,
            quantity: true,
            isGift: true,
          },
        },
      },
    }),
    prisma.productCadence.findMany({
      where: { shopId },
      select: { productId: true, variantId: true, estDaysToEmpty: true },
    }),
    prisma.billingAttempt.groupBy({
      by: ["contractId"],
      where: {
        contract: { shopId },
        status: "SUCCESS",
        completedAt: { not: null },
      },
      _max: { completedAt: true },
    }),
  ]);

  // Variant-level cadence rows override product-level rows.
  const cadenceByVariant = new Map<string, number>();
  const cadenceByProduct = new Map<string, number>();
  for (const cadence of cadences) {
    if (cadence.variantId) {
      cadenceByVariant.set(
        `${cadence.productId}|${cadence.variantId}`,
        cadence.estDaysToEmpty,
      );
    } else {
      cadenceByProduct.set(cadence.productId, cadence.estDaysToEmpty);
    }
  }
  const lastSuccessByContract = new Map<string, Date>();
  for (const g of lastSuccessGroups) {
    if (g._max.completedAt) {
      lastSuccessByContract.set(g.contractId, g._max.completedAt);
    }
  }

  const updates: { id: string; predictedEmptyDate: Date }[] = [];
  for (const contract of contracts) {
    const supplyLines = contract.lines.filter((l) => !l.isGift);
    if (supplyLines.length === 0) continue;

    let maxDays = 0;
    for (const line of supplyLines) {
      const estDays =
        cadenceByVariant.get(`${line.productId}|${line.variantId}`) ??
        cadenceByProduct.get(line.productId) ??
        DEFAULT_DAYS_TO_EMPTY;
      maxDays = Math.max(maxDays, estDays * Math.max(1, line.quantity));
    }

    const anchor =
      lastSuccessByContract.get(contract.id) ?? contract.firstChargeAt ?? now;
    const predicted = new Date(anchor.getTime() + maxDays * DAY_MS);

    const stored = contract.predictedEmptyDate;
    if (
      stored &&
      Math.abs(stored.getTime() - predicted.getTime()) <
        EMPTY_DATE_WRITE_TOLERANCE_MS
    ) {
      continue;
    }
    updates.push({ id: contract.id, predictedEmptyDate: predicted });
  }

  // Chunked transactions keep write batches bounded.
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((u) =>
        prisma.subscriptionContract.update({
          where: { id: u.id },
          data: { predictedEmptyDate: u.predictedEmptyDate },
        }),
      ),
    );
  }

  return { scanned: contracts.length, updated: updates.length };
}
