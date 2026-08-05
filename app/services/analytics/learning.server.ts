/**
 * Self-improving learning engine [analytics] — LEARNING-DATA-V2 §1.
 *
 * Day-1 heuristics (churn weights, dunning retry offsets, forecast
 * propensities, depletion usage rates) are only PRIORS. As real outcomes
 * accumulate, `runLearningJob` (jobs registry key "learning", weekly)
 * recalibrates four model domains and appends a new `ModelState` version per
 * (shop, model). Storage is append-only: the newest version wins, and callers
 * treat a missing row as "use static defaults".
 *
 * Model domains and learned-parameter shapes (paramsJson):
 * - CHURN_CALIBRATION  → `{ buckets: CalibrationBucket[] }` — maps raw churn
 *   scores to observed churn rates (10 buckets, PAV-monotone, shrunk toward
 *   the identity). Consumed by the churn scan via `applyCalibration`.
 * - DUNNING_RECOVERY   → `{ offsets: Record<category, number[]>, perCategoryN }`
 *   — up to 3 retry offset-days per decline category ranked by shrunk
 *   recovery rate. Consumed via `getLearnedDunningOffsets` (merchant
 *   overrides are NOT handled here — retention-core layers those on top).
 * - FORECAST_PROPENSITY → `{ skip, pause, churn }` — shop-level per-cycle
 *   rates shrunk toward `STATIC_PROPENSITY_PRIORS` (exported by
 *   forecast.server so both sides share one source of defaults).
 * - DEPLETION_USAGE    → `{ products: Record<productId, {multiplier, medianStretch, n}> }`
 *   — a *suggested* dailyUsage multiplier per product from realised
 *   inter-delivery stretch vs configured cadence. Stored only — the
 *   depletion engine stays informational; the Treatment admin renders the
 *   suggestion as a read-only hint.
 *
 * Every learned parameter flows through `shrinkRate` (empirical-Bayes,
 * prior weight k = 20): ~20 observations move an estimate halfway off its
 * prior, so thin data never swings parameters violently.
 *
 * Every run appends an audit entry `learning.recalibrated` per shop with
 * per-model sample sizes + quality metrics.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { logger } from "~/lib/logger.server";
import { addDays, daysBetween } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import { effectiveCancelledAt } from "~/services/analytics/cohorts.server";
import { STATIC_PROPENSITY_PRIORS } from "~/services/analytics/forecast.server";

// ───────────────────────────── Model vocabulary ────────────────────────────

export const LEARNED_MODELS = [
  "CHURN_CALIBRATION",
  "DUNNING_RECOVERY",
  "FORECAST_PROPENSITY",
  "DEPLETION_USAGE",
] as const;
export type LearnedModel = (typeof LEARNED_MODELS)[number];

/** Default empirical-Bayes prior weight — see `shrinkRate`. */
export const PRIOR_WEIGHT = 20;

/** Calibration buckets are equal-width over the [0, 1] score range. */
export const CALIBRATION_BUCKET_COUNT = 10;

/** Minimum score/outcome pairs before a CHURN_CALIBRATION version is written. */
export const MIN_CALIBRATION_PAIRS = 40;

/** Snapshot age window paired with outcomes (LEARNING-DATA-V2 §1 job step 1). */
export const CALIBRATION_SNAPSHOT_MIN_AGE_DAYS = 60;
export const CALIBRATION_SNAPSHOT_MAX_AGE_DAYS = 180;

/** A snapshot counts as churned when the contract exited within this window. */
export const CALIBRATION_OUTCOME_WINDOW_DAYS = 90;

/**
 * Degenerate-sample bounds: a pair set whose observed churn rate falls
 * outside (CALIBRATION_MIN_CHURN_RATE, CALIBRATION_MAX_CHURN_RATE) is
 * effectively single-label and must never be fitted into a live curve. The
 * canonical failure: a censored corpus where survivors' snapshots were
 * pruned away, leaving only exited contracts' final snapshots (≈100%
 * churned) — fitting it calibrates every bucket near 1, maps virtually every
 * raw score over the alert threshold, and storms the whole active base with
 * HIGH_CHURN_RISK while Brier/decile-lift on the degenerate sample still
 * look "fine".
 */
export const CALIBRATION_MAX_CHURN_RATE = 0.9;
export const CALIBRATION_MIN_CHURN_RATE = 0.02;

/**
 * PURE — observed churn rate of a calibration pair set plus whether it is
 * too single-label to trust (see the bounds above). Empty input is
 * degenerate by definition.
 */
export function degenerateCalibrationSample(
  pairs: Array<{ churned: boolean }>,
): { degenerate: boolean; churnedRate: number } {
  if (pairs.length === 0) return { degenerate: true, churnedRate: 0 };
  const churnedRate = pairs.filter((p) => p.churned).length / pairs.length;
  return {
    degenerate:
      churnedRate > CALIBRATION_MAX_CHURN_RATE ||
      churnedRate < CALIBRATION_MIN_CHURN_RATE,
    churnedRate,
  };
}

/** Categories with fewer retry episodes than this keep the static strategy. */
export const MIN_RETRY_EPISODES_PER_CATEGORY = 30;

/** At most this many learned retry offsets per decline category. */
export const MAX_LEARNED_RETRY_OFFSETS = 3;

/** Trailing observation window for FORECAST_PROPENSITY rates. */
export const PROPENSITY_WINDOW_DAYS = 180;

/**
 * Minimum completed cycles before a FORECAST_PROPENSITY version is written.
 * Below the k = 20 prior weight the priors dominate the blend anyway, so a
 * version would only add churn to the version history.
 */
export const MIN_PROPENSITY_CYCLES = 20;

/** Minimum observed inter-delivery intervals per product for a suggestion. */
export const MIN_DEPLETION_INTERVALS = 5;

/** Sanity band for the suggested dailyUsage multiplier. */
export const DEPLETION_MULTIPLIER_MIN = 0.25;
export const DEPLETION_MULTIPLIER_MAX = 4;

// ───────────────────────────── Learned param shapes ────────────────────────

export interface CalibrationBucket {
  lo: number;
  hi: number;
  /** Raw observed churn rate in the bucket (0 when the bucket is empty). */
  observed: number;
  /** Number of score/outcome pairs that landed in the bucket. */
  n: number;
  /** Shrunk + PAV-monotone churn estimate for the bucket. */
  calibrated: number;
}

export interface ChurnCalibrationParams {
  buckets: CalibrationBucket[];
}

export interface DunningRecoveryParams {
  /** Learned retry offset-days per decline category, ascending. */
  offsets: Record<string, number[]>;
  /** Episode observations per category (including under-minN categories). */
  perCategoryN: Record<string, number>;
}

export interface ForecastPropensityParams {
  skip: number;
  pause: number;
  churn: number;
}

export interface DepletionUsageSuggestion {
  /** Suggested multiplier on the configured dailyUsage (1 = as configured). */
  multiplier: number;
  /** Median realised inter-delivery gap ÷ configured cadence. */
  medianStretch: number;
  /** Number of realised delivery intervals observed. */
  n: number;
}

export interface DepletionUsageParams {
  products: Record<string, DepletionUsageSuggestion>;
}

// ───────────────────────────── Pure math ────────────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * PURE — empirical-Bayes blend `(observed*n + prior*k) / (n + k)`.
 *
 * The k = 20 prior weight means ~20 observations move the estimate halfway
 * off the prior; thin data never swings parameters violently. `n <= 0`
 * returns the prior unchanged.
 */
export function shrinkRate(
  observed: number,
  n: number,
  prior: number,
  k = PRIOR_WEIGHT,
): number {
  const weight = Number.isFinite(n) ? Math.max(0, n) : 0;
  const priorWeight = Number.isFinite(k) ? Math.max(0, k) : 0;
  if (weight + priorWeight === 0) return prior;
  // Zero observations must return the prior EXACTLY — the blended form is
  // mathematically identical but float error ((p·k)/k ≠ p) would make
  // "no data yet" look like a learned change downstream.
  if (weight === 0) return prior;
  const obs = Number.isFinite(observed) ? observed : prior;
  return (obs * weight + prior * priorWeight) / (weight + priorWeight);
}

/**
 * PURE — fit 10 equal-width calibration buckets over [0, 1].
 *
 * Per bucket the observed churn rate is shrunk toward the bucket midpoint
 * (identity prior — an empty bucket calibrates to its own midpoint, i.e. "the
 * score is already calibrated there"), then monotone non-decreasing order is
 * enforced with the pool-adjacent-violators algorithm (weights n + priorWeight
 * so heavily observed buckets win pooling disputes).
 */
export function fitCalibrationBuckets(
  pairs: Array<{ score: number; churned: boolean }>,
  priorWeight = PRIOR_WEIGHT,
): CalibrationBucket[] {
  const count = CALIBRATION_BUCKET_COUNT;
  const totals = Array.from({ length: count }, () => ({ n: 0, churned: 0 }));

  for (const pair of pairs) {
    const score = clamp01(pair.score);
    // score = 1 belongs to the last bucket, not an out-of-range 11th.
    const idx = Math.min(count - 1, Math.floor(score * count));
    totals[idx].n += 1;
    if (pair.churned) totals[idx].churned += 1;
  }

  interface PavBlock {
    value: number;
    weight: number;
    span: number; // buckets pooled into this block
  }

  const shrunk = totals.map((t, i) => {
    const lo = i / count;
    const hi = (i + 1) / count;
    const midpoint = (lo + hi) / 2;
    const observed = t.n > 0 ? t.churned / t.n : 0;
    return {
      lo,
      hi,
      observed,
      n: t.n,
      raw: shrinkRate(observed, t.n, midpoint, priorWeight),
      weight: t.n + Math.max(0, priorWeight),
    };
  });

  // Pool-adjacent-violators: merge any block whose value exceeds its
  // successor's into a weighted mean until the sequence is non-decreasing.
  const blocks: PavBlock[] = [];
  for (const bucket of shrunk) {
    let current: PavBlock = { value: bucket.raw, weight: bucket.weight, span: 1 };
    while (
      blocks.length > 0 &&
      blocks[blocks.length - 1].value > current.value + 1e-12
    ) {
      const prev = blocks.pop() as PavBlock;
      current = {
        value:
          (prev.value * prev.weight + current.value * current.weight) /
          (prev.weight + current.weight),
        weight: prev.weight + current.weight,
        span: prev.span + current.span,
      };
    }
    blocks.push(current);
  }

  const calibrated: number[] = [];
  for (const block of blocks) {
    for (let i = 0; i < block.span; i++) calibrated.push(clamp01(block.value));
  }

  return shrunk.map((bucket, i) => ({
    lo: bucket.lo,
    hi: bucket.hi,
    observed: bucket.observed,
    n: bucket.n,
    calibrated: calibrated[i],
  }));
}

/**
 * PURE — map a raw score through the learned calibration curve.
 *
 * `null`/empty buckets leave the score unchanged (callers without a learned
 * model keep raw scores). Otherwise the score is clamped to [0, 1] and
 * linearly interpolated across bucket midpoints: at or below the first
 * bucket's midpoint the first calibrated value applies, at or above the last
 * midpoint the last, and in between the two neighbouring buckets' calibrated
 * values are blended by distance.
 */
export function applyCalibration(
  score: number,
  buckets: CalibrationBucket[] | null,
): number {
  if (!buckets || buckets.length === 0) return score;
  const sorted = [...buckets].sort((a, b) => a.lo - b.lo);
  const s = clamp01(score);

  const mid = (b: CalibrationBucket): number => (b.lo + b.hi) / 2;

  if (s <= mid(sorted[0])) return clamp01(sorted[0].calibrated);
  const last = sorted[sorted.length - 1];
  if (s >= mid(last)) return clamp01(last.calibrated);

  for (let i = 0; i < sorted.length - 1; i++) {
    const m0 = mid(sorted[i]);
    const m1 = mid(sorted[i + 1]);
    if (s >= m0 && s <= m1) {
      if (m1 === m0) return clamp01(sorted[i].calibrated);
      const t = (s - m0) / (m1 - m0);
      return clamp01(
        sorted[i].calibrated + t * (sorted[i + 1].calibrated - sorted[i].calibrated),
      );
    }
  }
  return clamp01(last.calibrated); // unreachable with well-formed buckets
}

/**
 * PURE — mean squared error between predicted scores and observed outcomes.
 * 0 = perfect, 0.25 = coin-flip scores, 1 = perfectly wrong. Empty input → 0.
 */
export function brierScore(
  pairs: Array<{ score: number; churned: boolean }>,
): number {
  if (pairs.length === 0) return 0;
  let sum = 0;
  for (const pair of pairs) {
    const diff = clamp01(pair.score) - (pair.churned ? 1 : 0);
    sum += diff * diff;
  }
  return sum / pairs.length;
}

/**
 * PURE — top-decile observed churn ÷ overall observed churn. A useful model
 * ranks churners into the top decile (lift > 1); 1 = no better than random.
 * Returns 1 when the input is empty or no churn was observed at all (lift is
 * undefined there — neutral is the honest answer).
 */
export function decileLift(
  pairs: Array<{ score: number; churned: boolean }>,
): number {
  if (pairs.length === 0) return 1;
  const overall = pairs.filter((p) => p.churned).length / pairs.length;
  if (overall === 0) return 1;
  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  const topCount = Math.max(1, Math.floor(sorted.length / 10));
  const top = sorted.slice(0, topCount);
  const topRate = top.filter((p) => p.churned).length / top.length;
  return topRate / overall;
}

/**
 * PURE — per decline category, pick up to MAX_LEARNED_RETRY_OFFSETS
 * offset-days ranked by recovery rate shrunk toward the category's overall
 * recovery rate (so a lucky 1-for-1 offset cannot outrank a solid 20-for-40
 * one). Categories with fewer than `minN` episodes are omitted entirely —
 * callers keep the static strategy for those. Returned offsets are ascending
 * (retry schedules run chronologically).
 */
export function bestRetryOffsets(
  episodes: Array<{ category: string; offsetDays: number; recovered: boolean }>,
  minN = MIN_RETRY_EPISODES_PER_CATEGORY,
): Record<string, number[]> {
  const byCategory = new Map<
    string,
    { total: number; recovered: number; byOffset: Map<number, { n: number; recovered: number }> }
  >();

  for (const episode of episodes) {
    if (
      !Number.isFinite(episode.offsetDays) ||
      episode.offsetDays < 0 ||
      !episode.category
    ) {
      continue;
    }
    const offset = Math.round(episode.offsetDays);
    let cat = byCategory.get(episode.category);
    if (!cat) {
      cat = { total: 0, recovered: 0, byOffset: new Map() };
      byCategory.set(episode.category, cat);
    }
    cat.total += 1;
    if (episode.recovered) cat.recovered += 1;
    let slot = cat.byOffset.get(offset);
    if (!slot) {
      slot = { n: 0, recovered: 0 };
      cat.byOffset.set(offset, slot);
    }
    slot.n += 1;
    if (episode.recovered) slot.recovered += 1;
  }

  const result: Record<string, number[]> = {};
  for (const [category, cat] of byCategory) {
    if (cat.total < minN) continue;
    const categoryRate = cat.total > 0 ? cat.recovered / cat.total : 0;
    const ranked = [...cat.byOffset.entries()]
      .map(([offsetDays, slot]) => ({
        offsetDays,
        shrunk: shrinkRate(slot.recovered / slot.n, slot.n, categoryRate),
      }))
      .sort((a, b) => b.shrunk - a.shrunk || a.offsetDays - b.offsetDays);
    result[category] = ranked
      .slice(0, MAX_LEARNED_RETRY_OFFSETS)
      .map((r) => r.offsetDays)
      .sort((a, b) => a - b);
  }
  return result;
}

/**
 * PURE — shop-level per-cycle skip/pause/churn rates, each shrunk toward its
 * prior via `shrinkRate`. Zero observations returns the priors unchanged.
 *
 * Denominator conventions match the consumers in forecast.server:
 * - skip/pause use OPPORTUNITY denominators (successful cycles + events) —
 *   a skipped or paused cycle produces no SUCCESS billing attempt, so the
 *   event itself is one of the opportunities. This is the same convention as
 *   the per-contract rates the prior blends with
 *   (skips / (successfulOrders + skips), forecast.server per-contract path).
 * - churn stays on the completed-cycle denominator — it is a per-completed-
 *   cycle hazard matching the CHURN_HAZARD_SCALE domain of the prior.
 */
export function learnedPropensities(
  observed: { cycles: number; skips: number; pauses: number; churns: number },
  priors: { skip: number; pause: number; churn: number },
): { skip: number; pause: number; churn: number } {
  const cycles = Math.max(0, observed.cycles);
  const skips = Math.max(0, observed.skips);
  const pauses = Math.max(0, observed.pauses);
  const skipDenom = cycles + skips;
  const pauseDenom = cycles + pauses;
  return {
    skip: clamp01(
      shrinkRate(
        skipDenom > 0 ? clamp01(skips / skipDenom) : 0,
        skipDenom,
        priors.skip,
      ),
    ),
    pause: clamp01(
      shrinkRate(
        pauseDenom > 0 ? clamp01(pauses / pauseDenom) : 0,
        pauseDenom,
        priors.pause,
      ),
    ),
    churn: clamp01(
      shrinkRate(
        cycles > 0 ? clamp01(observed.churns / cycles) : 0,
        cycles,
        priors.churn,
      ),
    ),
  };
}

// ───────────────────────────── ModelState access ───────────────────────────

export interface ModelStateRecord {
  shop: string;
  model: LearnedModel;
  version: number;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  sampleSize: number;
  computedAt: Date;
}

/**
 * Newest ModelState version for (shop, model), parsed — or null when the
 * model has never been trained (callers must fall back to static defaults).
 */
export async function getModelState(
  shop: string,
  model: LearnedModel,
): Promise<ModelStateRecord | null> {
  const row = await prisma.modelState.findFirst({
    where: { shop, model },
    orderBy: { version: "desc" },
  });
  if (!row) return null;
  return {
    shop: row.shop,
    model,
    version: row.version,
    params: parseJson<Record<string, unknown>>(row.paramsJson, {}),
    metrics: parseJson<Record<string, unknown>>(row.metricsJson, {}),
    sampleSize: row.sampleSize,
    computedAt: row.computedAt,
  };
}

/**
 * Learned retry offsets (days after failure, ascending) for a decline
 * category, or null when nothing has been learned for it — callers keep the
 * static strategy. Merchant overrides (settingsJson.dunningOverrides) are NOT
 * resolved here; retention-core layers merchant > learned > static.
 */
export async function getLearnedDunningOffsets(
  shop: string,
  category: string,
): Promise<number[] | null> {
  const state = await getModelState(shop, "DUNNING_RECOVERY");
  if (!state) return null;
  const offsets = (state.params as Partial<DunningRecoveryParams>).offsets?.[
    category
  ];
  if (!Array.isArray(offsets)) return null;
  const clean = offsets.filter(
    (d): d is number => typeof d === "number" && Number.isFinite(d) && d >= 0,
  );
  return clean.length > 0 ? clean : null;
}

/** Append the next version for (shop, model); unique(shop, model, version) races retry. */
async function writeModelVersion(
  shop: string,
  model: LearnedModel,
  params: Record<string, unknown>,
  metrics: Record<string, unknown>,
  sampleSize: number,
): Promise<{ version: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await prisma.modelState.findFirst({
      where: { shop, model },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;
    try {
      await prisma.modelState.create({
        data: {
          shop,
          model,
          version,
          paramsJson: JSON.stringify(params),
          metricsJson: JSON.stringify(metrics),
          sampleSize,
        },
      });
      return { version };
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "P2002") throw e;
    }
  }
  throw new Error(`writeModelVersion: could not allocate a version for ${shop}/${model}`);
}

// ───────────────────────────── Episode reconstruction ──────────────────────

interface AttemptRow {
  contractId: string;
  status: string;
  isRetry: boolean;
  occurredAt: Date;
  declineCategory: string | null;
}

export interface RetryEpisodeObservation {
  category: string;
  offsetDays: number;
  recovered: boolean;
}

/**
 * PURE — reconstruct failure→retry episodes from a contract-ordered billing
 * attempt history. A non-retry FAILURE/CHALLENGED opens an episode (category
 * pinned to that first failure); each subsequent retry row records
 * offsetDays from the episode start and whether it recovered. A SUCCESS —
 * retry or routine cycle — closes the open episode. PENDING rows must be
 * excluded by the caller (outcome unknown).
 */
export function buildRetryEpisodes(
  attempts: AttemptRow[],
): RetryEpisodeObservation[] {
  const byContract = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    const rows = byContract.get(attempt.contractId);
    if (rows) rows.push(attempt);
    else byContract.set(attempt.contractId, [attempt]);
  }

  const observations: RetryEpisodeObservation[] = [];
  for (const rows of byContract.values()) {
    rows.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    let episode: { startAt: Date; category: string } | null = null;
    for (const attempt of rows) {
      const failed =
        attempt.status === "FAILURE" || attempt.status === "CHALLENGED";
      if (attempt.isRetry && episode) {
        observations.push({
          category: episode.category,
          offsetDays: Math.max(0, daysBetween(episode.startAt, attempt.occurredAt)),
          recovered: attempt.status === "SUCCESS",
        });
        if (attempt.status === "SUCCESS") episode = null;
      } else if (failed && !attempt.isRetry) {
        episode = {
          startAt: attempt.occurredAt,
          category: attempt.declineCategory ?? "GENERIC_DECLINE",
        };
      } else if (attempt.status === "SUCCESS") {
        // A routine successful cycle means the episode resolved out-of-band.
        episode = null;
      }
    }
  }
  return observations;
}

// ───────────────────────────── Learning job ────────────────────────────────

export interface LearningModelRunSummary {
  n: number;
  written: boolean;
  version: number | null;
  metrics: Record<string, unknown>;
}

export interface LearningShopResult {
  shop: string;
  models: Record<LearnedModel, LearningModelRunSummary>;
}

export interface LearningJobResult {
  shops: number;
  results: LearningShopResult[];
}

function isDunningPause(payloadJson: string): boolean {
  const payload = parseJson<Record<string, unknown>>(payloadJson, {});
  return Boolean(payload.dunning);
}

async function learnShop(shop: string, now: Date): Promise<LearningShopResult> {
  const windowStart = addDays(now, -PROPENSITY_WINDOW_DAYS);

  const [contracts, attempts, snapshots, events] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shop },
      select: {
        id: true,
        status: true,
        cancelledAt: true,
        cancelReason: true,
        updatedAt: true,
        intervalWeeks: true,
        lines: { select: { shopifyProductId: true } },
      },
    }),
    prisma.billingAttempt.findMany({
      where: { shop, status: { in: ["SUCCESS", "FAILURE", "CHALLENGED"] } },
      orderBy: { occurredAt: "asc" },
      select: {
        contractId: true,
        status: true,
        isRetry: true,
        occurredAt: true,
        declineCategory: true,
      },
    }),
    prisma.scoreSnapshot.findMany({
      where: {
        shop,
        kind: "CHURN_RISK",
        computedAt: {
          gte: addDays(now, -CALIBRATION_SNAPSHOT_MAX_AGE_DAYS),
          lte: addDays(now, -CALIBRATION_SNAPSHOT_MIN_AGE_DAYS),
        },
      },
      select: { contractId: true, value: true, factorsJson: true, computedAt: true },
    }),
    prisma.analyticsEvent.findMany({
      where: {
        shop,
        name: { in: ["ORDER_SKIPPED", "PAUSE_STARTED"] },
        occurredAt: { gte: windowStart },
      },
      select: { name: true, payloadJson: true },
    }),
  ]);

  // A merge is consolidation, not churn (cohorts.server / survival.server
  // semantics): merged contracts never count as exits — their merge date is
  // tracked separately so calibration can censor unresolved outcome windows.
  const exitAtByContract = new Map<string, Date | null>();
  const mergedAtByContract = new Map<string, Date>();
  for (const contract of contracts) {
    const exitAt = effectiveCancelledAt(contract);
    if (contract.cancelReason === "MERGED") {
      exitAtByContract.set(contract.id, null);
      if (exitAt) mergedAtByContract.set(contract.id, exitAt);
    } else {
      exitAtByContract.set(contract.id, exitAt);
    }
  }

  // ── 1. CHURN_CALIBRATION ──────────────────────────────────────────────
  // Pairs train on the RAW score (factorsJson.raw) — the domain
  // applyCalibration is applied to in the churn scan. snapshot.value stores
  // the CALIBRATED score, so training on it would fit each version on the
  // previous version's outputs (a feedback loop). `value` remains the legacy
  // fallback: pre-calibration snapshots wrote value == raw.
  const pairs: Array<{ score: number; churned: boolean }> = [];
  for (const snapshot of snapshots) {
    const mergedAt = mergedAtByContract.get(snapshot.contractId);
    if (mergedAt != null) {
      // Keep the pair (as churned = false) only when the full outcome window
      // elapsed before the merge; otherwise the outcome is censored — the
      // customer kept subscribing on the target contract, so neither
      // "churned" nor "retained for 90 days" is observable here.
      const windowCompletedBeforeMerge =
        mergedAt.getTime() > snapshot.computedAt.getTime() &&
        daysBetween(snapshot.computedAt, mergedAt) >
          CALIBRATION_OUTCOME_WINDOW_DAYS;
      if (!windowCompletedBeforeMerge) continue;
    }
    const exitAt = exitAtByContract.get(snapshot.contractId) ?? null;
    const churned =
      exitAt != null &&
      exitAt.getTime() >= snapshot.computedAt.getTime() &&
      daysBetween(snapshot.computedAt, exitAt) <= CALIBRATION_OUTCOME_WINDOW_DAYS;
    const raw = Number(
      parseJson<Record<string, unknown>>(snapshot.factorsJson, {}).raw,
    );
    pairs.push({
      score: clamp01(Number.isFinite(raw) ? raw : snapshot.value),
      churned,
    });
  }

  let churnSummary: LearningModelRunSummary = {
    n: pairs.length,
    written: false,
    version: null,
    metrics: {},
  };
  if (pairs.length >= MIN_CALIBRATION_PAIRS) {
    const { degenerate, churnedRate } = degenerateCalibrationSample(pairs);
    if (degenerate) {
      // A censored/single-label corpus must never become the live curve —
      // record the skip (metrics land in the learning.recalibrated audit
      // entry) and keep the previous version / static defaults in force.
      churnSummary = {
        n: pairs.length,
        written: false,
        version: null,
        metrics: {
          skipped: "degenerate_sample",
          churnedRate: round4(churnedRate),
          n: pairs.length,
        },
      };
      logger.warn("churn calibration skipped: degenerate sample", {
        shop,
        churnedRate: round4(churnedRate),
        pairs: pairs.length,
      });
    } else {
      const buckets = fitCalibrationBuckets(pairs);
      const metrics = {
        brier: round4(brierScore(pairs)),
        decileLift: round4(decileLift(pairs)),
        n: pairs.length,
      };
      const { version } = await writeModelVersion(
        shop,
        "CHURN_CALIBRATION",
        { buckets } satisfies ChurnCalibrationParams,
        metrics,
        pairs.length,
      );
      churnSummary = { n: pairs.length, written: true, version, metrics };
    }
  }

  // ── 2. DUNNING_RECOVERY ───────────────────────────────────────────────
  const episodes = buildRetryEpisodes(attempts);
  const perCategoryN: Record<string, number> = {};
  for (const episode of episodes) {
    perCategoryN[episode.category] = (perCategoryN[episode.category] ?? 0) + 1;
  }
  const offsets = bestRetryOffsets(episodes);

  let dunningSummary: LearningModelRunSummary = {
    n: episodes.length,
    written: false,
    version: null,
    metrics: { perCategoryN },
  };
  if (Object.keys(offsets).length > 0) {
    const metrics = { perCategoryN, episodes: episodes.length };
    const { version } = await writeModelVersion(
      shop,
      "DUNNING_RECOVERY",
      { offsets, perCategoryN } satisfies DunningRecoveryParams,
      metrics,
      episodes.length,
    );
    dunningSummary = { n: episodes.length, written: true, version, metrics };
  }

  // ── 3. FORECAST_PROPENSITY ────────────────────────────────────────────
  const cycles = attempts.filter(
    (a) => a.status === "SUCCESS" && a.occurredAt >= windowStart,
  ).length;
  const skips = events.filter((e) => e.name === "ORDER_SKIPPED").length;
  const pauses = events.filter(
    (e) => e.name === "PAUSE_STARTED" && !isDunningPause(e.payloadJson),
  ).length;
  // The learned churn propensity must stay on the VOLUNTARY per-cycle scale
  // of STATIC_PROPENSITY_PRIORS.churn: forecastContract models involuntary
  // loss separately (pFail × FAILURE_LOSS_SHARE), so payment-failure exits
  // here would be double-counted. The cancelReason test mirrors
  // metrics.server's involuntary check; MERGED is consolidation, not churn.
  let churns = 0;
  for (const contract of contracts) {
    const reason = (contract.cancelReason ?? "").toUpperCase();
    if (reason === "MERGED" || reason.includes("PAYMENT")) continue;
    const exitAt = exitAtByContract.get(contract.id) ?? null;
    if (exitAt != null && exitAt >= windowStart && exitAt <= now) churns += 1;
  }

  let propensitySummary: LearningModelRunSummary = {
    n: cycles,
    written: false,
    version: null,
    metrics: { cycles, skips, pauses, churns },
  };
  if (cycles >= MIN_PROPENSITY_CYCLES) {
    const params = learnedPropensities(
      { cycles, skips, pauses, churns },
      STATIC_PROPENSITY_PRIORS,
    );
    // Canonical metrics shape for BOTH branches: `cycles` names the sample
    // (the summary's `n` field already carries the sample size separately).
    const metrics = {
      cycles,
      skips,
      pauses,
      churns,
      windowDays: PROPENSITY_WINDOW_DAYS,
    };
    const { version } = await writeModelVersion(
      shop,
      "FORECAST_PROPENSITY",
      { ...params } satisfies ForecastPropensityParams,
      metrics,
      cycles,
    );
    propensitySummary = { n: cycles, written: true, version, metrics };
  }

  // ── 4. DEPLETION_USAGE ────────────────────────────────────────────────
  const successByContract = new Map<string, Date[]>();
  for (const attempt of attempts) {
    if (attempt.status !== "SUCCESS") continue;
    const dates = successByContract.get(attempt.contractId);
    if (dates) dates.push(attempt.occurredAt);
    else successByContract.set(attempt.contractId, [attempt.occurredAt]);
  }

  const stretchesByProduct = new Map<string, number[]>();
  for (const contract of contracts) {
    if (contract.intervalWeeks <= 0 || contract.lines.length === 0) continue;
    const dates = successByContract.get(contract.id) ?? [];
    if (dates.length < 2) continue;
    const cadenceDays = contract.intervalWeeks * 7;
    const stretches: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const gapDays =
        (dates[i].getTime() - dates[i - 1].getTime()) / 86_400_000;
      if (gapDays < 1) continue; // same-day noise (re-billed cycle)
      stretches.push(gapDays / cadenceDays);
    }
    if (stretches.length === 0) continue;
    for (const productId of new Set(
      contract.lines.map((line) => line.shopifyProductId),
    )) {
      const bucket = stretchesByProduct.get(productId);
      if (bucket) bucket.push(...stretches);
      else stretchesByProduct.set(productId, [...stretches]);
    }
  }

  const products: Record<string, DepletionUsageSuggestion> = {};
  let usageObservations = 0;
  for (const [productId, stretches] of stretchesByProduct) {
    if (stretches.length < MIN_DEPLETION_INTERVALS) continue;
    const medianStretch = median(stretches);
    if (!(medianStretch > 0)) continue;
    const multiplier = round2(
      Math.min(
        DEPLETION_MULTIPLIER_MAX,
        Math.max(DEPLETION_MULTIPLIER_MIN, 1 / medianStretch),
      ),
    );
    products[productId] = {
      multiplier,
      medianStretch: round2(medianStretch),
      n: stretches.length,
    };
    usageObservations += stretches.length;
  }

  let depletionSummary: LearningModelRunSummary = {
    n: usageObservations,
    written: false,
    version: null,
    metrics: { products: Object.keys(products).length },
  };
  if (Object.keys(products).length > 0) {
    const metrics = {
      products: Object.keys(products).length,
      observations: usageObservations,
    };
    const { version } = await writeModelVersion(
      shop,
      "DEPLETION_USAGE",
      { products } satisfies DepletionUsageParams,
      metrics,
      usageObservations,
    );
    depletionSummary = {
      n: usageObservations,
      written: true,
      version,
      metrics,
    };
  }

  const models: Record<LearnedModel, LearningModelRunSummary> = {
    CHURN_CALIBRATION: churnSummary,
    DUNNING_RECOVERY: dunningSummary,
    FORECAST_PROPENSITY: propensitySummary,
    DEPLETION_USAGE: depletionSummary,
  };

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "learning.recalibrated",
    subjectType: "ModelState",
    payload: {
      models: Object.fromEntries(
        LEARNED_MODELS.map((model) => [
          model,
          {
            n: models[model].n,
            written: models[model].written,
            version: models[model].version,
            metrics: models[model].metrics,
          },
        ]),
      ),
    },
  });

  return { shop, models };
}

/**
 * Weekly recalibration over the four model domains (jobs registry key
 * "learning"). Writes a new append-only ModelState version per (shop, model)
 * whenever the domain's minimum sample size is met; shops below the gates
 * keep their static defaults untouched. Every run appends the
 * `learning.recalibrated` audit entry per shop with per-model n + metrics.
 */
export async function runLearningJob(shop?: string): Promise<LearningJobResult> {
  const now = new Date();
  const shops = shop
    ? [shop]
    : (
        await prisma.subscriptionContract.findMany({
          distinct: ["shop"],
          select: { shop: true },
        })
      ).map((row) => row.shop);

  const results: LearningShopResult[] = [];
  for (const shopDomain of shops) {
    const result = await learnShop(shopDomain, now);
    results.push(result);
    logger.info("learning recalibrated", {
      shop: shopDomain,
      written: LEARNED_MODELS.filter((m) => result.models[m].written),
    });
  }
  return { shops: shops.length, results };
}
