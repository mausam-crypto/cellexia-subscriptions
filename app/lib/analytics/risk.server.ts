import prisma from "~/db.server";
import { subDays } from "date-fns";
import { COUNTABLE_CONTRACT, OPEN_DUNNING_STATES } from "./queries.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  DISENGAGED_MIN_ACCOUNT_AGE_DAYS,
  LOGIN_LOOKBACK_DAYS,
  MIN_NEGATIVE_OUTCOMES,
  MIN_POSITIVE_OUTCOMES,
  RISK_FEATURE_NAMES,
  acquisitionSignals,
  extractFeatures,
  heuristicRiskScore,
  predictProbability,
  type RiskFeatureInput,
} from "./learning.server";

/**
 * Churn-risk scoring + predicted-empty-date computation.
 *
 * Both are derived analytics fields recomputed wholesale by scheduled jobs;
 * they are intentionally not event-logged (no canonical event type exists and
 * per-contract logging every run would flood the event log / Klaviyo outbox).
 *
 * Scoring is self-improving: when the nightly risk_learning_run job has
 * PROMOTED a learned model (it beat the heuristic on a time-split holdout —
 * see learning.server.ts), churnRiskScore is that model's churn probability;
 * otherwise the hand-tuned heuristic below scores. Both paths build the same
 * RiskFeatureInput, so training and serving semantics cannot diverge.
 */

/** Cancelled contracts older than this are skipped by empty-date prediction (win-back has sunset by then). */
const CANCELLED_LOOKBACK_DAYS = 180;

/** Fallback when a product has no ProductCadence row. */
const DEFAULT_DAYS_TO_EMPTY = 56;

/** Skip re-writing predictedEmptyDate when it moved by less than this. */
const EMPTY_DATE_WRITE_TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * How far back successful charges feed the observed-consumption blend. ~18
 * months covers ≥6 inter-charge gaps at the longest common cadence (8-week
 * intervals with occasional skips) while keeping the fetch bounded.
 */
const OBSERVED_GAP_LOOKBACK_DAYS = 540;

/**
 * Shrinkage prior for the observed-consumption blend: the merchant/default
 * cadence estimate counts as this many pseudo-observations, so one odd gap
 * cannot yank the prediction but a steady demonstrated rhythm overrides the
 * guess. observedWeight = gaps / (gaps + PRIOR): 1 gap → 20% observed,
 * 4 gaps → 50%, 12 gaps → 75%.
 */
const OBSERVED_GAP_PRIOR_STRENGTH = 4;

/** Observed gaps outside this band are artifacts (same-day double settlement / year-long dormancy), not consumption. */
const OBSERVED_GAP_MIN_DAYS = 1;
const OBSERVED_GAP_MAX_DAYS = 365;

const DAY_MS = 86_400_000;

/**
 * Churn-risk score per ACTIVE contract, written to
 * SubscriptionContract.churnRiskScore (0..1, higher = riskier).
 *
 * Two scorers, one field:
 * - "learned": the promoted logistic model's churn probability — used ONLY
 *   when the riskModel setting says a trained model beat the heuristic on a
 *   time-split holdout AND its stored featureNames exactly match the current
 *   RISK_FEATURE_NAMES (a model trained on other features is never applied).
 * - "heuristic" (default): additive factors, clamped to 1 — the exact
 *   pre-learning behavior (see heuristicRiskScore in learning.server.ts):
 *   +0.25 open dunning case (OPEN / RETRYING / AWAITING_CUSTOMER / AWAITING_3DS);
 *   +0.20 skipped the last cycle; +0.15 early-cycle hazard (ordersCount ≤ 2,
 *   only once the account is older than one billing interval); +0.10
 *   consecutiveFailures > 0; +0.15 habitual skipper (skip ratio ≥ 0.4);
 *   +0.15 disengaged (no portal.login in 120 days, matched on contractId,
 *   customerId or email; accounts ≥ 30 days old only).
 *
 * Contracts that left ACTIVE keep no stale score: any non-ACTIVE contract
 * with a non-zero score is reset to 0 so risk segments never surface
 * paused/cancelled contracts on last-known numbers.
 *
 * Writes are batched with one updateMany per distinct score, and skipped when
 * the stored score already matches.
 */
export async function runChurnRiskScoring(
  shopId: string,
  now: Date = new Date(),
): Promise<{ scored: number; updated: number; scorer: "heuristic" | "learned" }> {
  const loginCutoff = subDays(now, LOGIN_LOOKBACK_DAYS);

  const [contracts, openCases, logins] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, status: "ACTIVE", ...COUNTABLE_CONTRACT },
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
        createdAt: true,
        firstChargeAt: true,
        originOrderTotalCents: true,
        originOrderDiscountCents: true,
      },
    }),
    prisma.dunningCase.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        state: { in: OPEN_DUNNING_STATES },
      },
      select: { contractId: true },
    }),
    prisma.subscriberEvent.findMany({
      where: { shopId, type: "portal.login", createdAt: { gte: loginCutoff } },
      select: {
        contractId: true,
        customerId: true,
        email: true,
        createdAt: true,
      },
    }),
    // Stale-score hygiene: contracts no longer ACTIVE are out of the risk
    // universe — zero their scores so nothing segments on dead data.
    prisma.subscriptionContract.updateMany({
      where: {
        shopId,
        status: { not: "ACTIVE" },
        churnRiskScore: { not: 0 },
      },
      data: { churnRiskScore: 0 },
    }),
  ]);

  const learnedModel = await loadPromotedModel(shopId);

  const openDunningContractIds = new Set(openCases.map((c) => c.contractId));
  // Latest login instant per matching key (contractId / customerId / email) —
  // the heuristic only needs "logged in within the lookback", the learned
  // model also uses how recently.
  const loginByContract = new Map<string, number>();
  const loginByCustomer = new Map<string, number>();
  const loginByEmail = new Map<string, number>();
  const noteLogin = (map: Map<string, number>, key: string, at: number) => {
    const prev = map.get(key);
    if (prev == null || at > prev) map.set(key, at);
  };
  for (const login of logins) {
    const at = login.createdAt.getTime();
    if (login.contractId) noteLogin(loginByContract, login.contractId, at);
    if (login.customerId) noteLogin(loginByCustomer, login.customerId, at);
    if (login.email) noteLogin(loginByEmail, login.email.toLowerCase(), at);
  }

  const idsByScore = new Map<number, string[]>();
  for (const contract of contracts) {
    const intervalMs = Math.max(1, contract.intervalWeeks) * 7 * DAY_MS;

    // Account age from real arrival (firstChargeAt backfills the origin-order
    // date for imported books; createdAt is only the mirror-creation instant).
    const accountAgeMs =
      now.getTime() - (contract.firstChargeAt ?? contract.createdAt).getTime();

    const loginCandidates = [
      loginByContract.get(contract.id),
      loginByCustomer.get(contract.customerId),
      loginByEmail.get(contract.email.toLowerCase()),
    ].filter((v): v is number => v != null);
    const lastLoginAt =
      loginCandidates.length > 0 ? Math.max(...loginCandidates) : null;

    const acq = acquisitionSignals(contract);
    const input: RiskFeatureInput = {
      openDunning: openDunningContractIds.has(contract.id),
      skippedLastCycle:
        contract.lastSkippedAt != null &&
        now.getTime() - contract.lastSkippedAt.getTime() <= intervalMs,
      ordersCount: contract.ordersCount,
      consecutiveFailures: contract.consecutiveFailures,
      skipCount: contract.skipCount,
      daysSinceLogin:
        lastLoginAt == null ? null : (now.getTime() - lastLoginAt) / DAY_MS,
      accountAgeDays: accountAgeMs / DAY_MS,
      intervalWeeks: contract.intervalWeeks,
      acqRevenueCents: acq.acqRevenueCents,
      acqDiscountPct: acq.acqDiscountPct,
    };

    const score = learnedModel
      ? predictProbability(learnedModel, extractFeatures(input))
      : heuristicRiskScore(input);

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

  return {
    scored: contracts.length,
    updated,
    scorer: learnedModel ? "learned" : "heuristic",
  };
}

// ── Learned-model plumbing ────────────────────────────────────────────────────

interface PromotedModel {
  means: number[];
  stds: number[];
  weights: number[];
  intercept: number;
}

/**
 * The promoted learned model, or null when the heuristic should score.
 * Failure-contained (golden rule 9): any read/shape problem means heuristic.
 */
async function loadPromotedModel(shopId: string): Promise<PromotedModel | null> {
  try {
    const stored = await getSetting(shopId, "riskModel");
    if (!stored.promoted || stored.mode !== "learned") return null;
    const names = stored.featureNames;
    if (
      names.length !== RISK_FEATURE_NAMES.length ||
      names.some((name, i) => name !== RISK_FEATURE_NAMES[i]) ||
      stored.weights.length !== names.length ||
      stored.means.length !== names.length ||
      stored.stds.length !== names.length
    ) {
      // Trained against a different feature space (or corrupted) — the
      // validation that promoted it no longer applies. Fail safe: heuristic.
      return null;
    }
    return {
      means: stored.means,
      stds: stored.stds,
      weights: stored.weights,
      intercept: stored.intercept,
    };
  } catch (err) {
    console.error("[risk] riskModel setting read failed; using heuristic", err);
    return null;
  }
}

export interface RiskModelStatus {
  mode: "heuristic" | "learned";
  /** ISO instant of the last training run (null before the first). */
  trainedAt: string | null;
  /** Decided churn outcomes (distinct contracts) the last run had available. */
  samples: number;
  /** How many of those outcomes were churns. */
  positives: number;
  /** Holdout AUC of the learned model (also present while it shadows). */
  auc: number | null;
  /** ISO instant the next nightly training is expected (null before the first run). */
  nextRetrain: string | null;
  /** Decided outcomes needed before a model can train at all. */
  outcomesNeeded: number;
}

/**
 * Status for the admin UI chip — honesty invariant: learned mode is always
 * presented WITH its sample count and holdout AUC ("learned model, AUC 0.74,
 * trained on 412 outcomes"), heuristic mode says when learning will kick in.
 */
export async function getRiskModelStatus(shopId: string): Promise<RiskModelStatus> {
  let stored;
  try {
    stored = await getSetting(shopId, "riskModel");
  } catch {
    stored = null;
  }

  let nextRetrain: string | null = null;
  try {
    const lastRun = await prisma.jobRun.findFirst({
      where: { jobName: "risk_learning_run", status: "SUCCESS" },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    });
    if (lastRun) {
      nextRetrain = new Date(lastRun.startedAt.getTime() + DAY_MS).toISOString();
    }
  } catch {
    nextRetrain = null;
  }

  if (!stored) {
    return {
      mode: "heuristic",
      trainedAt: null,
      samples: 0,
      positives: 0,
      auc: null,
      nextRetrain,
      outcomesNeeded: MIN_POSITIVE_OUTCOMES + MIN_NEGATIVE_OUTCOMES,
    };
  }

  return {
    mode: stored.promoted && stored.mode === "learned" ? "learned" : "heuristic",
    trainedAt: stored.trainedAt,
    samples: stored.positiveCount + stored.negativeCount,
    positives: stored.positiveCount,
    auc: stored.evaluation?.aucLearned ?? null,
    nextRetrain,
    outcomesNeeded: MIN_POSITIVE_OUTCOMES + MIN_NEGATIVE_OUTCOMES,
  };
}

// ── Predicted empty dates ─────────────────────────────────────────────────────

/**
 * Blend the cadence-derived days-to-empty (the merchant's guess, or the
 * 56-day default) with the contract's OWN demonstrated consumption rhythm —
 * the learning loop the cadence estimate never had: estDaysToEmpty is
 * written only by the Plans-page form and nothing ever calibrated it from
 * observed behavior, so every un-tuned product ran win-back on an arbitrary
 * 56-day clock forever.
 *
 * The observation is the contract's real inter-charge gaps (successful
 * settlements): skips, merchant delays and date pushes all lengthen the gap,
 * so it already encodes "net of skips/delays" — a subscriber who skips every
 * other cycle demonstrably consumes at half speed, and their win-back/
 * replenishment touches should fire accordingly later. Gaps outside
 * [OBSERVED_GAP_MIN_DAYS, OBSERVED_GAP_MAX_DAYS] are dropped as artifacts
 * (same-day double settlements, dormant re-awakenings).
 *
 * Shrinkage, not replacement: observedWeight = gaps / (gaps +
 * OBSERVED_GAP_PRIOR_STRENGTH), so sparse histories stay close to the
 * cadence prior (0 gaps = exactly the pre-blend behavior) and rich histories
 * are dominated by demonstrated rhythm. Deterministic — same inputs, same
 * date, no RNG.
 */
export function blendedDaysToEmpty(opts: {
  /** Cadence-derived days (MIN over supply lines × quantity) — the prior. */
  cadenceDays: number;
  /** The contract's inter-charge gaps in days, any order. */
  observedGapsDays: number[];
}): number {
  const usable = opts.observedGapsDays.filter(
    (gap) =>
      Number.isFinite(gap) &&
      gap >= OBSERVED_GAP_MIN_DAYS &&
      gap <= OBSERVED_GAP_MAX_DAYS,
  );
  if (usable.length === 0) return opts.cadenceDays;
  const observedMean = usable.reduce((s, gap) => s + gap, 0) / usable.length;
  const observedWeight =
    usable.length / (usable.length + OBSERVED_GAP_PRIOR_STRENGTH);
  return (
    observedWeight * observedMean + (1 - observedWeight) * opts.cadenceDays
  );
}

/**
 * predictedEmptyDate per contract, written to
 * SubscriptionContract.predictedEmptyDate.
 *
 * Formula: anchor + blendedDaysToEmpty({ cadenceDays: minDays, observedGaps })
 * where
 * - anchor = latest successful BillingAttempt.completedAt
 *   ?? firstChargeAt ?? now (the last time product shipped);
 * - minDays = MIN over non-gift lines of
 *   (ProductCadence.estDaysToEmpty for the variant, falling back to the
 *   product-level row, else 56) × max(1, quantity) — quantity > 1 means the
 *   customer has proportionally more supply;
 * - observedGaps = the contract's inter-charge gaps over the last
 *   OBSERVED_GAP_LOOKBACK_DAYS (see blendedDaysToEmpty — the self-improving
 *   half of the prediction).
 *
 * MIN, not max: this date times win-back touches and replenishment prompts,
 * and the operative moment is when the FIRST product runs out — a cleanser
 * (30d) + cream (90d) subscriber starts rebuying cleanser elsewhere on day
 * 30, not day 90. Max would fire every touch two months late.
 *
 * Contracts whose only lines are gifts (no supply lines) get their stale
 * prediction CLEARED rather than skipped — a leftover date from a removed
 * product must not keep timing win-back.
 *
 * Covers ACTIVE and PAUSED contracts plus contracts cancelled in the last 180
 * days (win-back touches are timed to this date). Also used by contextual
 * portal prompts and fast-shipping detection.
 */
export async function runPredictedEmptyDates(
  shopId: string,
  now: Date = new Date(),
): Promise<{ scanned: number; updated: number }> {
  const [contracts, cadences, lastSuccessGroups, recentSuccesses] =
    await Promise.all([
      prisma.subscriptionContract.findMany({
        where: {
          shopId,
          ...COUNTABLE_CONTRACT,
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
          contract: { shopId, ...COUNTABLE_CONTRACT },
          status: "SUCCESS",
          completedAt: { not: null },
        },
        _max: { completedAt: true },
      }),
      // Inter-charge gaps for the observed-consumption blend. Windowed
      // (bounded fetch) and separate from the anchor groupBy above, which
      // deliberately has NO window — a contract whose last success predates
      // the lookback must keep its true anchor.
      prisma.billingAttempt.findMany({
        where: {
          contract: { shopId, ...COUNTABLE_CONTRACT },
          status: "SUCCESS",
          completedAt: { gte: subDays(now, OBSERVED_GAP_LOOKBACK_DAYS) },
        },
        select: { contractId: true, completedAt: true },
        orderBy: { completedAt: "asc" },
      }),
    ]);

  // Variant-level cadence rows override product-level rows. NOTE: no writer
  // creates variant rows yet (the Plans page always saves variantId: null),
  // so this lookup is dormant by design — it stays so a future variant-level
  // cadence editor (30ml vs 100ml sizes) becomes live without engine changes.
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
  // Per-contract inter-charge gaps in days (rows arrive completedAt-ascending;
  // artifact filtering happens inside blendedDaysToEmpty).
  const gapsByContract = new Map<string, number[]>();
  const lastSeenSuccess = new Map<string, number>();
  for (const attempt of recentSuccesses) {
    if (!attempt.completedAt) continue;
    const at = attempt.completedAt.getTime();
    const prev = lastSeenSuccess.get(attempt.contractId);
    if (prev != null) {
      const gaps = gapsByContract.get(attempt.contractId) ?? [];
      gaps.push((at - prev) / DAY_MS);
      gapsByContract.set(attempt.contractId, gaps);
    }
    lastSeenSuccess.set(attempt.contractId, at);
  }

  const updates: { id: string; predictedEmptyDate: Date | null }[] = [];
  for (const contract of contracts) {
    const supplyLines = contract.lines.filter((l) => !l.isGift);
    if (supplyLines.length === 0) {
      // Nothing replenishable ships — a stale prediction from removed lines
      // must not keep steering win-back/prompt timing.
      if (contract.predictedEmptyDate != null) {
        updates.push({ id: contract.id, predictedEmptyDate: null });
      }
      continue;
    }

    let minDays = Number.POSITIVE_INFINITY;
    for (const line of supplyLines) {
      const estDays =
        cadenceByVariant.get(`${line.productId}|${line.variantId}`) ??
        cadenceByProduct.get(line.productId) ??
        DEFAULT_DAYS_TO_EMPTY;
      minDays = Math.min(minDays, estDays * Math.max(1, line.quantity));
    }

    // Cadence prior blended with the contract's demonstrated reorder rhythm
    // (see blendedDaysToEmpty) — the observed gap bounds the binding
    // (first-empty) line's effective supply: the subscriber tolerated that
    // spacing between deliveries without running out or leaving.
    const days = blendedDaysToEmpty({
      cadenceDays: minDays,
      observedGapsDays: gapsByContract.get(contract.id) ?? [],
    });

    const anchor =
      lastSuccessByContract.get(contract.id) ?? contract.firstChargeAt ?? now;
    const predicted = new Date(anchor.getTime() + days * DAY_MS);

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
