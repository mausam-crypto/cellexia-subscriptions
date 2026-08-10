import prisma from "~/db.server";
import { COUNTABLE_CONTRACT } from "./queries.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import type { SettingsValue } from "~/lib/settings/registry.server";

/**
 * Self-improving churn-risk core — "as we get more subscribers it should
 * learn and become more accurate."
 *
 * Dependency-free logistic regression over historical contract snapshots.
 * Design invariants (non-negotiable, tests depend on them):
 *
 * - HONEST: the learned model only replaces the hand-tuned heuristic when it
 *   provably beats it on a time-split holdout (AUC margin
 *   `PROMOTION_AUC_MARGIN`); until then it trains in shadow and the heuristic
 *   keeps scoring. Every training decision is logged (`admin.action` /
 *   `risk_model_trained`) and every surfaced number carries its sample count.
 * - DETERMINISTIC: zero-initialized batch gradient descent (no RNG anywhere),
 *   fixed iteration count, snapshots on a fixed UTC grid, stable sort orders.
 *   Same data + same `now` → identical weights, identical decision.
 * - NO LABEL LEAKAGE: a snapshot at time T uses only signals reconstructable
 *   from data at or before T; its label is decided strictly inside
 *   (T, T + OUTCOME_WINDOW_DAYS]. See `buildRiskSnapshots` for the exact
 *   reconstruction rules and their documented approximations.
 *
 * Storage: learned weights + standardization stats + evaluation live in the
 * machine-written Setting key "riskModel" (see settings registry).
 * `app/lib/analytics/risk.server.ts` reads it to pick the live scorer.
 */

// ── Tuning constants ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Label window: churned (voluntarily or involuntarily) within this many days after the snapshot. */
export const OUTCOME_WINDOW_DAYS = 60;

/** Snapshots are taken on a fixed UTC grid this many days apart. */
export const SNAPSHOT_INTERVAL_DAYS = 28;

/** How far back the snapshot grid reaches. */
export const SNAPSHOT_LOOKBACK_DAYS = 560;

/** Fixed grid anchor (2024-01-01T00:00:00Z) — keeps snapshot times stable across runs. */
export const SNAPSHOT_EPOCH_MS = Date.UTC(2024, 0, 1);

/** Days without a portal.login before a subscriber counts as disengaged (shared with risk.server.ts). */
export const LOGIN_LOOKBACK_DAYS = 120;

/** Account age below which "never logged in" is not a signal (shared with risk.server.ts). */
export const DISENGAGED_MIN_ACCOUNT_AGE_DAYS = 30;

/** Training gate: distinct churned contracts required before any model is fit. */
export const MIN_POSITIVE_OUTCOMES = 50;

/** Training gate: distinct non-churned contracts required before any model is fit. */
export const MIN_NEGATIVE_OUTCOMES = 50;

/** The learned model must beat the heuristic's holdout AUC by at least this much to be promoted. */
export const PROMOTION_AUC_MARGIN = 0.02;

/** Newest-first share of snapshots held out for evaluation (time split). */
const HOLDOUT_FRACTION = 0.2;

/** Gradient-descent hyperparameters — fixed, so training is deterministic. */
const GD_ITERATIONS = 400;
const GD_LEARNING_RATE = 0.3;
const GD_L2_LAMBDA = 0.01;

// ── Feature space ─────────────────────────────────────────────────────────────

/**
 * Fixed, ordered feature vocabulary. Stored models record the names they were
 * trained with; risk.server.ts refuses to apply a model whose stored names do
 * not exactly match this list (a model trained on other features is not the
 * model we validated).
 */
export const RISK_FEATURE_NAMES = [
  "open_dunning",
  "skipped_last_cycle",
  "early_cycle",
  "orders_2_3",
  "orders_4_6",
  "orders_7_plus",
  "consecutive_failures",
  "skip_ratio",
  "login_recency",
  "never_logged_in",
  "acq_revenue",
  "acq_discount_pct",
  "acq_present",
] as const;

/**
 * One contract's risk signals at a point in time. Both the live scorer
 * (risk.server.ts, "now") and the snapshot builder (history, time T) produce
 * this shape, so training and serving can never diverge on semantics.
 */
export interface RiskFeatureInput {
  openDunning: boolean;
  /** A cycle.skipped within one billing interval before the snapshot. */
  skippedLastCycle: boolean;
  ordersCount: number;
  consecutiveFailures: number;
  skipCount: number;
  /** Days since the last portal.login within LOGIN_LOOKBACK_DAYS; null = none observed. */
  daysSinceLogin: number | null;
  /** Days since arrival (firstChargeAt ?? createdAt). */
  accountAgeDays: number;
  intervalWeeks: number;
  /**
   * Optional acquisition signals (migration 0006, backfilled over time) —
   * absent/null is encoded explicitly via the acq_present feature, so a
   * partially backfilled book cannot skew the model.
   */
  acqRevenueCents?: number | null;
  acqDiscountPct?: number | null;
}

/**
 * Derive the optional acquisition features from the origin-order money fields
 * (originOrderTotalCents is the amount as charged, i.e. net of discounts).
 */
export function acquisitionSignals(row: {
  originOrderTotalCents?: number | null;
  originOrderDiscountCents?: number | null;
}): { acqRevenueCents: number | null; acqDiscountPct: number | null } {
  const total = row.originOrderTotalCents;
  if (total == null || !Number.isFinite(total)) {
    return { acqRevenueCents: null, acqDiscountPct: null };
  }
  const discount = row.originOrderDiscountCents ?? 0;
  const gross = total + Math.max(0, discount);
  return {
    acqRevenueCents: total,
    acqDiscountPct: gross > 0 ? (Math.max(0, discount) / gross) * 100 : 0,
  };
}

/** Raw (unstandardized) feature vector, aligned with RISK_FEATURE_NAMES. */
export function extractFeatures(input: RiskFeatureInput): number[] {
  const intervalDays = Math.max(1, input.intervalWeeks) * 7;
  const earlyCycle =
    input.ordersCount <= 2 && input.accountAgeDays > intervalDays ? 1 : 0;
  const orders = input.ordersCount;
  const skipRatio = Math.min(1, input.skipCount / Math.max(orders, 1));
  const loginRecency =
    input.daysSinceLogin == null
      ? 0
      : Math.max(0, LOGIN_LOOKBACK_DAYS - input.daysSinceLogin) /
        LOGIN_LOOKBACK_DAYS;
  const neverLoggedIn =
    input.daysSinceLogin == null &&
    input.accountAgeDays >= DISENGAGED_MIN_ACCOUNT_AGE_DAYS
      ? 1
      : 0;
  const acqPresent = input.acqRevenueCents != null ? 1 : 0;

  return [
    input.openDunning ? 1 : 0,
    input.skippedLastCycle ? 1 : 0,
    earlyCycle,
    orders >= 2 && orders <= 3 ? 1 : 0,
    orders >= 4 && orders <= 6 ? 1 : 0,
    orders >= 7 ? 1 : 0,
    Math.min(5, Math.max(0, input.consecutiveFailures)),
    skipRatio,
    loginRecency,
    neverLoggedIn,
    acqPresent ? (input.acqRevenueCents ?? 0) / 100 : 0,
    acqPresent ? (input.acqDiscountPct ?? 0) : 0,
    acqPresent,
  ];
}

/**
 * The hand-tuned heuristic, extracted as a pure function so the live scorer
 * (risk.server.ts) and the holdout evaluation score with byte-identical
 * logic. Weights are unchanged from the original implementation.
 */
export function heuristicRiskScore(input: RiskFeatureInput): number {
  let score = 0;
  const intervalDays = Math.max(1, input.intervalWeeks) * 7;

  if (input.openDunning) score += 0.25;
  if (input.skippedLastCycle) score += 0.2;
  if (input.ordersCount <= 2 && input.accountAgeDays > intervalDays) {
    score += 0.15;
  }
  if (input.consecutiveFailures > 0) score += 0.1;
  if (input.skipCount / Math.max(input.ordersCount, 1) >= 0.4) score += 0.15;
  if (
    input.daysSinceLogin == null &&
    input.accountAgeDays >= DISENGAGED_MIN_ACCOUNT_AGE_DAYS
  ) {
    score += 0.15;
  }

  return Math.min(1, Math.max(0, score));
}

// ── Logistic regression (pure, deterministic) ─────────────────────────────────

export interface TrainedLogisticModel {
  featureNames: string[];
  /** Per-feature training-set means (standardization). */
  means: number[];
  /** Per-feature training-set standard deviations, floored at 1e-6. */
  stds: number[];
  /** Weights over standardized features. */
  weights: number[];
  intercept: number;
}

/**
 * L2-regularized logistic regression via batch gradient descent on
 * standardized features. Deterministic: weights start at zero (no RNG), the
 * iteration count and learning rate are fixed, and rows are consumed in the
 * caller's order. The intercept is not regularized.
 *
 * Returns null when rows are empty, rows disagree on width, or labels are
 * single-class (nothing to separate).
 */
export function trainLogisticRegression(
  rows: number[][],
  labels: number[],
  opts?: {
    featureNames?: string[];
    iterations?: number;
    learningRate?: number;
    l2Lambda?: number;
  },
): TrainedLogisticModel | null {
  const n = rows.length;
  if (n === 0 || labels.length !== n) return null;
  const width = rows[0].length;
  for (const row of rows) if (row.length !== width) return null;
  let positives = 0;
  for (const y of labels) if (y === 1) positives += 1;
  if (positives === 0 || positives === n) return null;

  const iterations = opts?.iterations ?? GD_ITERATIONS;
  const learningRate = opts?.learningRate ?? GD_LEARNING_RATE;
  const l2 = opts?.l2Lambda ?? GD_L2_LAMBDA;

  // Standardize on the training set.
  const means = new Array<number>(width).fill(0);
  const stds = new Array<number>(width).fill(0);
  for (let j = 0; j < width; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += rows[i][j];
    means[j] = sum / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) {
      const d = rows[i][j] - means[j];
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / n);
    stds[j] = std < 1e-6 ? 1 : std;
  }
  const X = rows.map((row) => row.map((v, j) => (v - means[j]) / stds[j]));

  const weights = new Array<number>(width).fill(0);
  let intercept = 0;
  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Array<number>(width).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = intercept;
      for (let j = 0; j < width; j++) z += weights[j] * X[i][j];
      const err = sigmoid(z) - labels[i];
      for (let j = 0; j < width; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }
    for (let j = 0; j < width; j++) {
      weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
    }
    intercept -= learningRate * (gradB / n);
  }

  return {
    featureNames: opts?.featureNames ?? [...RISK_FEATURE_NAMES],
    means,
    stds,
    weights,
    intercept,
  };
}

/** Churn probability (0..1) for a RAW feature vector under a trained model. */
export function predictProbability(
  model: Pick<TrainedLogisticModel, "means" | "stds" | "weights" | "intercept">,
  rawFeatures: number[],
): number {
  let z = model.intercept;
  const width = Math.min(model.weights.length, rawFeatures.length);
  for (let j = 0; j < width; j++) {
    z += model.weights[j] * ((rawFeatures[j] - model.means[j]) / model.stds[j]);
  }
  return sigmoid(z);
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

// ── Evaluation (pure) ─────────────────────────────────────────────────────────

/**
 * Rank-based AUC (Mann-Whitney U with average ranks for ties). Null when a
 * class is absent — an AUC over one class is undefined, and "undefined" must
 * never silently become "good enough to promote".
 */
export function rankAuc(scores: number[], labels: number[]): number | null {
  const n = scores.length;
  if (n === 0 || labels.length !== n) return null;
  let nPos = 0;
  for (const y of labels) if (y === 1) nPos += 1;
  const nNeg = n - nPos;
  if (nPos === 0 || nNeg === 0) return null;

  const order = scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => a.score - b.score || a.i - b.i);
  const ranks = new Array<number>(n).fill(0);
  let k = 0;
  while (k < n) {
    let j = k;
    while (j + 1 < n && order[j + 1].score === order[k].score) j += 1;
    const avgRank = (k + 1 + (j + 1)) / 2;
    for (let m = k; m <= j; m++) ranks[order[m].i] = avgRank;
    k = j + 1;
  }

  let posRankSum = 0;
  for (let i = 0; i < n; i++) if (labels[i] === 1) posRankSum += ranks[i];
  return (posRankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Share of true churners among the top-scored decile (min 1 row). This is the
 * operative metric for the merchant: "if I act on the riskiest 10%, how often
 * am I right?". Deterministic tie-break by index.
 */
export function precisionAtTopDecile(
  scores: number[],
  labels: number[],
): number | null {
  const n = scores.length;
  if (n === 0 || labels.length !== n) return null;
  const take = Math.max(1, Math.floor(n / 10));
  const order = scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, take);
  let hits = 0;
  for (const { i } of order) if (labels[i] === 1) hits += 1;
  return hits / take;
}

// ── Snapshot reconstruction (pure) ────────────────────────────────────────────

export interface SnapshotContractRow {
  id: string;
  intervalWeeks: number;
  ordersCount: number;
  skipCount: number;
  createdAt: Date;
  firstChargeAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  failedAt: Date | null;
  customerId: string | null;
  email: string | null;
  originOrderTotalCents?: number | null;
  originOrderDiscountCents?: number | null;
}

export interface SnapshotEventRow {
  contractId: string | null;
  customerId: string | null;
  email: string | null;
  type: string;
  createdAt: Date;
}

export interface RiskSnapshot {
  contractId: string;
  snapshotAt: Date;
  input: RiskFeatureInput;
  /** 1 = churned (voluntary or involuntary) within OUTCOME_WINDOW_DAYS after snapshotAt. */
  label: 0 | 1;
}

/** Event types the snapshot reconstruction consumes. */
export const SNAPSHOT_EVENT_TYPES = [
  "portal.login",
  "cycle.skipped",
  "cycle.unskipped",
  "billing.attempt_succeeded",
  "billing.attempt_failed",
  "dunning.case_opened",
  "dunning.recovered",
  "dunning.exhausted",
  "contract.paused",
  "contract.resumed",
  // Reactivation after a dunning-exhausted FAILED episode (dunning engine /
  // win-back) — closes the historical dead span the exhausted event opened.
  "contract.activated",
] as const;

/**
 * Rebuild per-contract risk snapshots on the fixed UTC grid.
 *
 * How label leakage is avoided (the load-bearing part):
 *
 * - Snapshot times T lie on a fixed grid (SNAPSHOT_EPOCH_MS +
 *   k·SNAPSHOT_INTERVAL_DAYS) and only qualify when T + OUTCOME_WINDOW_DAYS
 *   ≤ now — undecided outcomes are excluded entirely, never guessed.
 * - Every feature at T is derived exclusively from events with
 *   createdAt ≤ T, or from current counters walked BACKWARD through post-T
 *   events (ordersCount/skipCount at T = today's value minus what happened
 *   after T) — arithmetic that reconstructs the past value exactly, using
 *   post-T events only to subtract, never to signal.
 * - The label reads cancelledAt/failedAt strictly inside (T, T+60d];
 *   contracts already churned at T produce no snapshot at T.
 * - INVOLUNTARY EPISODES SURVIVE RECOVERY: failedAt is a LIVE-state column —
 *   every recovery path (dunning reactivation, admin resume, win-back)
 *   nulls it, so a won-back contract's historical FAILED span would read
 *   label 0 and even yield feature rows sampled while it was dead
 *   (teaching the model that dunning-heavy profiles end well whenever the
 *   win-back succeeded, and disagreeing forever with the rollup, which
 *   counted the contract churnedInvoluntary on its failedAt day). The
 *   episode is therefore reconstructed from the event log, which recovery
 *   never rewrites: a dunning.exhausted event inside (T, T+60d] labels 1
 *   exactly like a live failedAt, and grid times between an exhaustion and
 *   the next recovery signal (billing.attempt_succeeded, contract.resumed,
 *   contract.activated — all ≤ T) produce no snapshot, mirroring the
 *   failedMs skip for the still-failed case.
 *
 * IMPORT BOUNDARY (the other load-bearing part): a contract produces
 * snapshots only at grid times ≥ its mirror row's createdAt — the moment this
 * app started observing it. Arrival (firstChargeAt ?? createdAt) is
 * deliberately NOT that boundary: sync backfills firstChargeAt to the ORIGIN
 * order's historical date, so an imported book (import passthrough) arrives
 * with arrivals 1–2 years before install. Grid times in that pre-install span
 * have no SubscriberEvent log and an ordersCount walk-back that bottoms out
 * at 0 — every such row would read "zero orders, never logged in, no
 * dunning, old account": fabricated, identical across contracts, inflating
 * the "trained on N outcomes" counts and letting the promotion gate be
 * cleared against a degenerate heuristic baseline instead of the documented
 * honest comparison. The clamp also structurally removes the false churn
 * labels sync stamps on imported cancelled contracts (cancelledAt = sync
 * time ≤ mirror createdAt ⇒ no eligible grid time survives). accountAgeDays
 * still uses true arrival — the age is real even when history is not
 * reconstructable.
 *
 * Documented approximations: consecutive-failure streaks and dunning-case
 * state are rebuilt from the fetched event window, so a streak/case that
 * started more than LOGIN_LOOKBACK_DAYS before the oldest snapshot can be
 * missed (dunning ladders resolve within ~30 days, so in practice none are);
 * pause state at T relies on contract.paused/resumed events existing for the
 * pause. Consolidation merges (cancelReason MERGED) are never labeled churn.
 * For imported contracts, ordersCount at T counts app-era charges only —
 * pre-install order history is not mirrored, so their cycle-position features
 * ramp from the install date.
 */
export function buildRiskSnapshots(input: {
  contracts: SnapshotContractRow[];
  events: SnapshotEventRow[];
  now: Date;
}): RiskSnapshot[] {
  const nowMs = input.now.getTime();
  const gridTimes: number[] = [];
  const windowStart = nowMs - SNAPSHOT_LOOKBACK_DAYS * DAY_MS;
  const firstIdx = Math.ceil(
    (windowStart - SNAPSHOT_EPOCH_MS) / (SNAPSHOT_INTERVAL_DAYS * DAY_MS),
  );
  for (let k = Math.max(0, firstIdx); ; k++) {
    const t = SNAPSHOT_EPOCH_MS + k * SNAPSHOT_INTERVAL_DAYS * DAY_MS;
    if (t + OUTCOME_WINDOW_DAYS * DAY_MS > nowMs) break;
    gridTimes.push(t);
  }
  if (gridTimes.length === 0) return [];

  // Index events per contract (non-login types), plus login events matched by
  // contractId OR customerId OR email — the same matching the live scorer uses.
  const byContract = new Map<string, SnapshotEventRow[]>();
  const loginsByCustomer = new Map<string, number[]>();
  const loginsByEmail = new Map<string, number[]>();
  const sortedEvents = [...input.events].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.type.localeCompare(b.type),
  );
  for (const event of sortedEvents) {
    if (event.contractId) {
      const list = byContract.get(event.contractId) ?? [];
      list.push(event);
      byContract.set(event.contractId, list);
    }
    if (event.type === "portal.login") {
      const t = event.createdAt.getTime();
      if (event.customerId) {
        const list = loginsByCustomer.get(event.customerId) ?? [];
        list.push(t);
        loginsByCustomer.set(event.customerId, list);
      }
      if (event.email) {
        const key = event.email.toLowerCase();
        const list = loginsByEmail.get(key) ?? [];
        list.push(t);
        loginsByEmail.set(key, list);
      }
    }
  }

  const latestAtOrBefore = (times: number[] | undefined, t: number): number | null => {
    if (!times) return null;
    let latest: number | null = null;
    for (const time of times) {
      if (time <= t && (latest == null || time > latest)) latest = time;
    }
    return latest;
  };

  const snapshots: RiskSnapshot[] = [];
  const contracts = [...input.contracts].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  for (const contract of contracts) {
    const events = byContract.get(contract.id) ?? [];
    // Involuntary-churn episodes, reconstructed from the log because recovery
    // clears failedAt (see doc block). Times, oldest first, of every
    // dunning.exhausted this contract logged.
    const exhaustedTimes = events
      .filter((event) => event.type === "dunning.exhausted")
      .map((event) => event.createdAt.getTime());
    const arrivalMs = (contract.firstChargeAt ?? contract.createdAt).getTime();
    // Observation starts when the mirror row was born (see IMPORT BOUNDARY in
    // the doc block): before that instant no event log and no counters exist,
    // so features "reconstructed" there would be fabrications.
    const observedFromMs = Math.max(arrivalMs, contract.createdAt.getTime());
    const cancelledMs = contract.cancelledAt?.getTime() ?? null;
    const failedMs = contract.failedAt?.getTime() ?? null;
    const acq = acquisitionSignals(contract);
    const intervalMs = Math.max(1, contract.intervalWeeks) * 7 * DAY_MS;

    for (const t of gridTimes) {
      if (observedFromMs > t) continue;
      if (cancelledMs != null && cancelledMs <= t) continue;
      if (failedMs != null && failedMs <= t) continue;

      // Paused at T? Last pause/resume event at or before T decides.
      let paused = false;
      // State walked strictly over events ≤ T.
      let successesAfter = 0;
      let skipsAfter = 0;
      let unskipsAfter = 0;
      let failureStreak = 0;
      let dunningOpen = false;
      // Inside a historical FAILED span at T? Set by dunning.exhausted,
      // cleared by any recovery signal — the event-log stand-in for the
      // failedMs skip once recovery has nulled the column.
      let involuntaryDead = false;
      let lastSkipMs: number | null = null;
      let lastContractLoginMs: number | null = null;
      for (const event of events) {
        const eMs = event.createdAt.getTime();
        if (eMs > t) {
          if (event.type === "billing.attempt_succeeded") successesAfter += 1;
          else if (event.type === "cycle.skipped") skipsAfter += 1;
          else if (event.type === "cycle.unskipped") unskipsAfter += 1;
          continue;
        }
        switch (event.type) {
          case "billing.attempt_succeeded":
            failureStreak = 0;
            involuntaryDead = false;
            break;
          case "billing.attempt_failed":
            failureStreak += 1;
            break;
          case "dunning.case_opened":
            dunningOpen = true;
            break;
          case "dunning.recovered":
            dunningOpen = false;
            break;
          case "dunning.exhausted":
            dunningOpen = false;
            involuntaryDead = true;
            break;
          case "contract.paused":
            paused = true;
            break;
          case "contract.resumed":
            paused = false;
            involuntaryDead = false;
            break;
          case "contract.activated":
            involuntaryDead = false;
            break;
          case "cycle.skipped":
            lastSkipMs = eMs;
            break;
          case "portal.login":
            lastContractLoginMs = eMs;
            break;
          default:
            break;
        }
      }
      if (paused) continue;
      // Dead at T (exhausted, not yet recovered): no feature row — exactly as
      // the failedMs skip above treats a contract whose failedAt is still set.
      if (involuntaryDead) continue;

      const ordersAtT = Math.max(0, contract.ordersCount - successesAfter);
      const skipsAtT = Math.max(
        0,
        contract.skipCount - skipsAfter + unskipsAfter,
      );

      const loginCandidates = [
        lastContractLoginMs,
        contract.customerId
          ? latestAtOrBefore(loginsByCustomer.get(contract.customerId), t)
          : null,
        contract.email
          ? latestAtOrBefore(loginsByEmail.get(contract.email.toLowerCase()), t)
          : null,
      ].filter((v): v is number => v != null);
      const lastLoginMs =
        loginCandidates.length > 0 ? Math.max(...loginCandidates) : null;
      const daysSinceLogin =
        lastLoginMs != null && t - lastLoginMs <= LOGIN_LOOKBACK_DAYS * DAY_MS
          ? (t - lastLoginMs) / DAY_MS
          : null;

      const windowEnd = t + OUTCOME_WINDOW_DAYS * DAY_MS;
      const inWindow = (v: number | null): boolean =>
        v != null && v > t && v <= windowEnd;
      // Voluntary churn = a cancel inside the window (consolidation merges
      // are not churn — the customer stayed); involuntary churn = entered
      // FAILED, read from BOTH the live column and the dunning.exhausted
      // events: recovery nulls failedAt, and without the event leg every
      // won-back contract's churn window would silently read label 0.
      const voluntaryOrInvoluntary =
        (inWindow(cancelledMs) && contract.cancelReason !== "MERGED") ||
        inWindow(failedMs) ||
        exhaustedTimes.some((exhaustedMs) => inWindow(exhaustedMs));

      snapshots.push({
        contractId: contract.id,
        snapshotAt: new Date(t),
        input: {
          openDunning: dunningOpen,
          skippedLastCycle: lastSkipMs != null && t - lastSkipMs <= intervalMs,
          ordersCount: ordersAtT,
          consecutiveFailures: failureStreak,
          skipCount: skipsAtT,
          daysSinceLogin,
          accountAgeDays: (t - arrivalMs) / DAY_MS,
          intervalWeeks: contract.intervalWeeks,
          acqRevenueCents: acq.acqRevenueCents,
          acqDiscountPct: acq.acqDiscountPct,
        },
        label: voluntaryOrInvoluntary ? 1 : 0,
      });
    }
  }

  // Oldest first, contractId tie-break — the deterministic time-split order.
  snapshots.sort(
    (a, b) =>
      a.snapshotAt.getTime() - b.snapshotAt.getTime() ||
      a.contractId.localeCompare(b.contractId),
  );
  return snapshots;
}

/**
 * Time split: train on the older rows, evaluate on the newest rest. The
 * holdout targets ~holdoutFraction of ROWS, but the boundary is a snapshot
 * TIME, never a row index — two guarantees keep the promotion gate honest:
 *
 * - GROUPED BY TIME: every row whose snapshotAt equals or follows the
 *   boundary time goes to the holdout. Rows sharing a timestamp can never
 *   straddle the split, so a shop-wide shock at one grid time (e.g. a PSP
 *   outage opening dunning cases everywhere) lands entirely on one side and
 *   cannot be memorized in train and rewarded in holdout.
 * - PURGED: train rows whose outcome window (snapshotAt,
 *   snapshotAt + outcomeWindowDays] reaches past the boundary are dropped.
 *   Their labels are decided by the same period the holdout is scored on;
 *   keeping them would leak the holdout's label period into training.
 *
 * Rows must be sorted oldest-first (buildRiskSnapshots' output order).
 * Deterministic: pure index/time arithmetic, no RNG.
 */
export function splitByTime<T extends { snapshotAt: Date }>(
  sortedOldestFirst: T[],
  holdoutFraction = HOLDOUT_FRACTION,
  outcomeWindowDays = OUTCOME_WINDOW_DAYS,
): { train: T[]; holdout: T[] } {
  const n = sortedOldestFirst.length;
  if (n === 0) return { train: [], holdout: [] };
  const targetSize = Math.min(n, Math.max(0, Math.round(n * holdoutFraction)));
  if (targetSize === 0) return { train: [...sortedOldestFirst], holdout: [] };

  // Boundary = snapshot time of the row at the naive split index, then widen
  // the holdout leftward so no timestamp is split across the boundary.
  let splitAt = n - targetSize;
  const boundaryMs = sortedOldestFirst[splitAt].snapshotAt.getTime();
  while (
    splitAt > 0 &&
    sortedOldestFirst[splitAt - 1].snapshotAt.getTime() === boundaryMs
  ) {
    splitAt -= 1;
  }

  const windowMs = outcomeWindowDays * DAY_MS;
  return {
    train: sortedOldestFirst
      .slice(0, splitAt)
      .filter((row) => row.snapshotAt.getTime() + windowMs <= boundaryMs),
    holdout: sortedOldestFirst.slice(splitAt),
  };
}

// ── Nightly orchestration ─────────────────────────────────────────────────────

type RiskModelSetting = SettingsValue<"riskModel">;

export interface RiskLearningRunResult {
  snapshots: number;
  /** Distinct contracts with a decided outcome (positive = churned at least once in a window). */
  outcomes: number;
  positives: number;
  negatives: number;
  trained: boolean;
  promoted: boolean;
  aucLearned: number | null;
  aucHeuristic: number | null;
  reason: string;
}

/**
 * Nightly job body (risk_learning_run): rebuild snapshots from history,
 * train, evaluate on the newest 20% (time split), and promote only when the
 * learned model beats the heuristic's AUC on the SAME holdout by
 * PROMOTION_AUC_MARGIN. The decision — either way — is persisted to the
 * "riskModel" setting and logged as admin.action/risk_model_trained.
 */
export async function runRiskLearning(
  shopId: string,
  now: Date = new Date(),
): Promise<RiskLearningRunResult> {
  const eventCutoff = new Date(
    now.getTime() - (SNAPSHOT_LOOKBACK_DAYS + LOGIN_LOOKBACK_DAYS) * DAY_MS,
  );

  const [contracts, events] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, ...COUNTABLE_CONTRACT },
      select: {
        id: true,
        intervalWeeks: true,
        ordersCount: true,
        skipCount: true,
        createdAt: true,
        firstChargeAt: true,
        cancelledAt: true,
        cancelReason: true,
        failedAt: true,
        customerId: true,
        email: true,
        originOrderTotalCents: true,
        originOrderDiscountCents: true,
      },
    }),
    prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: { in: [...SNAPSHOT_EVENT_TYPES] },
        createdAt: { gte: eventCutoff },
      },
      select: {
        contractId: true,
        customerId: true,
        email: true,
        type: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const snapshots = buildRiskSnapshots({ contracts, events, now });

  const positiveContracts = new Set<string>();
  const contractsSeen = new Set<string>();
  for (const s of snapshots) {
    contractsSeen.add(s.contractId);
    if (s.label === 1) positiveContracts.add(s.contractId);
  }
  const positives = positiveContracts.size;
  const negatives = contractsSeen.size - positives;

  const previous = await getSetting(shopId, "riskModel");

  const finish = async (
    value: RiskModelSetting,
    result: RiskLearningRunResult,
  ): Promise<RiskLearningRunResult> => {
    await setSetting(shopId, "riskModel", value, "system:risk_learning_run");
    await logEvent({
      shopId,
      type: "admin.action",
      source: "SYSTEM",
      actor: "system",
      payload: {
        action: "risk_model_trained",
        auc: result.aucLearned,
        samples: result.outcomes,
        promoted: result.promoted,
        trained: result.trained,
        positives: result.positives,
        negatives: result.negatives,
        aucHeuristic: result.aucHeuristic,
        snapshots: result.snapshots,
        reason: result.reason,
      },
    });
    return result;
  };

  const base: RiskLearningRunResult = {
    snapshots: snapshots.length,
    outcomes: positives + negatives,
    positives,
    negatives,
    trained: false,
    promoted: false,
    aucLearned: null,
    aucHeuristic: null,
    reason: "",
  };

  if (positives < MIN_POSITIVE_OUTCOMES || negatives < MIN_NEGATIVE_OUTCOMES) {
    // Not enough decided outcomes: the heuristic stays, and the system says so.
    return finish(
      {
        ...defaultRiskModelValue(),
        sampleCount: snapshots.length,
        positiveCount: positives,
        negativeCount: negatives,
      },
      {
        ...base,
        reason: `insufficient_outcomes (need ${MIN_POSITIVE_OUTCOMES}+/${MIN_NEGATIVE_OUTCOMES}−, have ${positives}+/${negatives}−)`,
      },
    );
  }

  const { train, holdout } = splitByTime(snapshots);
  const trainX = train.map((s) => extractFeatures(s.input));
  const trainY = train.map((s) => s.label);
  const model = trainLogisticRegression(trainX, trainY);

  if (!model || holdout.length === 0) {
    return finish(
      {
        ...defaultRiskModelValue(),
        sampleCount: snapshots.length,
        positiveCount: positives,
        negativeCount: negatives,
      },
      { ...base, reason: model ? "empty_holdout" : "degenerate_training_set" },
    );
  }

  const holdoutY = holdout.map((s) => s.label);
  const learnedScores = holdout.map((s) =>
    predictProbability(model, extractFeatures(s.input)),
  );
  const heuristicScores = holdout.map((s) => heuristicRiskScore(s.input));
  const aucLearned = rankAuc(learnedScores, holdoutY);
  const aucHeuristic = rankAuc(heuristicScores, holdoutY);
  const precisionLearned = precisionAtTopDecile(learnedScores, holdoutY);
  const precisionHeuristic = precisionAtTopDecile(heuristicScores, holdoutY);

  const promoted =
    aucLearned != null &&
    aucHeuristic != null &&
    aucLearned - aucHeuristic >= PROMOTION_AUC_MARGIN;

  const value: RiskModelSetting = {
    version: 1,
    mode: promoted ? "learned" : "heuristic",
    trainedAt: now.toISOString(),
    sampleCount: snapshots.length,
    positiveCount: positives,
    negativeCount: negatives,
    featureNames: [...model.featureNames],
    means: model.means.map(round6),
    stds: model.stds.map(round6),
    weights: model.weights.map(round6),
    intercept: round6(model.intercept),
    evaluation: {
      holdoutSize: holdout.length,
      holdoutPositives: holdoutY.reduce<number>((sum, y) => sum + y, 0),
      aucLearned: aucLearned == null ? null : round4(aucLearned),
      aucHeuristic: aucHeuristic == null ? null : round4(aucHeuristic),
      precisionAtTopDecile:
        precisionLearned == null ? null : round4(precisionLearned),
      heuristicPrecisionAtTopDecile:
        precisionHeuristic == null ? null : round4(precisionHeuristic),
    },
    promoted,
  };

  const reason = promoted
    ? "promoted"
    : aucLearned == null || aucHeuristic == null
      ? "holdout_single_class — shadow"
      : `below_margin (learned ${round4(aucLearned)} vs heuristic ${round4(aucHeuristic)}, needs +${PROMOTION_AUC_MARGIN}) — shadow`;

  // Log demotions distinctly visible in the payload: a previously promoted
  // model that no longer clears the bar reverts to the heuristic.
  const demoted = previous.promoted && !promoted;

  return finish(value, {
    ...base,
    trained: true,
    promoted,
    aucLearned: aucLearned == null ? null : round4(aucLearned),
    aucHeuristic: aucHeuristic == null ? null : round4(aucHeuristic),
    reason: demoted ? `${reason} (demoted)` : reason,
  });
}

/** Fresh default "riskModel" value (mirrors the registry default). */
export function defaultRiskModelValue(): RiskModelSetting {
  return {
    version: 1,
    mode: "heuristic",
    trainedAt: null,
    sampleCount: 0,
    positiveCount: 0,
    negativeCount: 0,
    featureNames: [],
    means: [],
    stds: [],
    weights: [],
    intercept: 0,
    evaluation: null,
    promoted: false,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
