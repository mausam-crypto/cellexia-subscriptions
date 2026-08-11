import prisma from "~/db.server";
import { subWeeks } from "date-fns";
import {
  computeMrrCents,
  requireShopById,
  shopDayLabelUtc,
  utcDayKey,
  utcWeekStartKey,
} from "./queries.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { defaultFor } from "~/lib/settings/registry.server";
import { logEvent } from "~/lib/events/log.server";

/**
 * Forecasting v2 — model choice + honesty.
 *
 * Four candidate models are fit over weekly series derived from DailyRollup
 * (active subscribers, MRR, net revenue — chargedCents minus refundedCents,
 * so the series matches the "net of refunds" the analytics page promises).
 * Every model is a pure exported function so it can be unit-tested without a
 * database:
 *
 * - "naive":    last observed value carried forward. Always available; the
 *               honest default when history is too short for anything else.
 * - "trend":    Holt linear exponential smoothing with correct initialization
 *               (level = first observation, trend = average of the first
 *               differences) and optional damping (phi) so short histories
 *               cannot extrapolate to the moon.
 * - "seasonal": seasonal-naive with an additive week-of-month (period 4)
 *               adjustment. Refuses to run below 16 weeks of history.
 * - "cohort":   bottom-up — the current active base decayed by the empirical
 *               per-cycle survival (censoring-corrected, see
 *               `decidedCycleSurvival`; each cycle bucket decays by its OWN
 *               hazard when enough transitions back it) plus the
 *               new-subscriber run rate of the last 4 weeks; converted to
 *               money via the current per-active value.
 *
 * Model selection ("auto") is a walk-forward backtest: train on weeks [0..k],
 * predict k+1..k+4, roll forward; the available model with the lowest mean
 * absolute percentage error wins. The backtest error also drives the
 * prediction intervals (±1.28σ of one-step residuals, widened by horizon and
 * by accuracy grade) and the accuracy grade itself — the client-facing
 * honesty signal ("A".."D" with plain-language reasons).
 *
 * Censoring fix (audit): per-cycle survival is estimated only over DECIDED
 * transitions — a contract counts toward the cycle n→n+1 ratio only if it
 * either reached cycle n+1 (survived) or ended terminally at exactly cycle n
 * (churned: CANCELLED, payment-FAILED, or EXPIRED — the same terminal set
 * survival.server.ts uses, so the two survival surfaces cannot disagree
 * about whether a book decays). ACTIVE/PAUSED contracts still waiting for
 * their next billing are censored and excluded, so a young book no longer
 * reads as a churn catastrophe. Below `MIN_DECIDED_TRANSITIONS` decided
 * transitions the estimate falls back to `DEFAULT_CYCLE_SURVIVAL` and is
 * flagged.
 *
 * Gap fix (audit): the weekly grid is fully materialized between the first
 * and last observed week. Missing weeks (rollup job downtime) are filled by
 * carrying the last snapshot forward and reported in `filledWeeks`, so Holt
 * never mistakes a 4-week gap for a single explosive week. Weeks whose only
 * rollup rows were written by a gap backfill (DailyRollup.snapshotFabricated
 * — their point-in-time columns are 0 by design, flow columns real) are
 * treated the same way: snapshots carried forward, week annotated, never
 * counted as observed.
 *
 * Continuity fix (audit): projections are anchored at the LAST OBSERVED
 * weekly snapshot. The live active count is used only in the no-history
 * fallback, so the chart no longer shows a step at the forecast divider.
 *
 * Self-improvement (v1.5.0): each week, recordForecastAccuracyWeek (nightly
 * risk_learning_run tick) persists every model's TRUE out-of-sample error for
 * the newest complete week — the one-step APE of a forecast trained strictly
 * on the weeks before it (`BacktestReport.latestOneStepApe`) — into the
 * machine-written Setting "forecastModelHistory" (rolling 26 weeks). Earlier
 * versions recorded the full walk-forward backtest average instead; because
 * consecutive 26-week averages share ~25 folds, week-over-week entries were
 * almost perfectly correlated, which made the "recent weeks weigh more"
 * ranking and the beat-streak reason near-tautological. One independent
 * holdout error per week is what makes them honest. "auto" ranks models by
 * the exponentially weighted error over that history — recent CALENDAR weeks
 * weigh more (decay keys on each entry's weekStartIso, never its array
 * position, so a hole from a recording outage discounts by real elapsed
 * time) — so a model that has been winning lately keeps the job even through
 * one noisy week. A fifth model, "blend", averages the available models
 * weighted by inverse recorded error, restricted per backtest fold to
 * entries recorded no later than the fold's first evaluated week (see
 * historyErrorAsOf) — so neither blend's live forecast nor any fold of its
 * own backtest ever uses knowledge of the weeks it is scored on. With no
 * recorded history everything degrades to the previous behavior.
 */

// ── Tuning constants ──────────────────────────────────────────────────────────

const HOLT_ALPHA = 0.5;
const HOLT_BETA = 0.3;
/** Damping factor applied to the Holt trend for short histories. */
const HOLT_PHI = 0.9;
/** Histories shorter than this get a damped trend. */
const DAMP_BELOW_WEEKS = 8;
/**
 * Rollup weeks the models may read. 26 made every collected week beyond six
 * months structurally unreadable — a shop could hold two years of daily
 * rollups and no model could ever learn annual seasonality from them. 78
 * (18 months) keeps a full year plus margin in view for a future
 * annual-seasonal model while staying bounded: ~550 rollup rows of small
 * integer columns per read, and the walk-forward backtest stays
 * O(weeks × models × horizon) — trivial at this size. Deliberately NOT
 * unbounded: cost must stay predictable, and the backtest referee scores
 * over the whole window, so unlimited ancient-regime data would dilute it.
 */
export const HISTORY_WEEKS = 78;
const DEFAULT_HORIZON_WEEKS = 12;
const MAX_HORIZON_WEEKS = 52;
/** Used when the book is too young to estimate per-cycle survival. */
const DEFAULT_CYCLE_SURVIVAL = 0.9;
/** Fallback average billing interval (the default plan frequency). */
const DEFAULT_INTERVAL_WEEKS = 8;
/** Per-cycle survival ratios beyond this cycle are too thin to trust. */
const MAX_SURVIVAL_RATIO_CYCLES = 12;
/** Minimum decided (uncensored) transitions before the empirical survival is trusted. */
const MIN_DECIDED_TRANSITIONS = 30;
/**
 * Minimum decided transitions at ONE cycle before that cycle's own hazard
 * (rather than the blended average) decays its bucket in the cohort model —
 * a per-cycle version of MIN_DECIDED_TRANSITIONS, lower because each ratio
 * only steers its own bucket, not the whole projection.
 */
const MIN_DECIDED_PER_CYCLE = 10;
/** Walk-forward backtest predicts up to this many weeks ahead per fold. */
const BACKTEST_MAX_HORIZON = 4;
/** z for the ~80% prediction interval. */
const INTERVAL_Z = 1.28;
/** Interval width multiplier per accuracy grade — worse grade, wider band. */
const GRADE_BAND_MULT: Record<AccuracyGrade, number> = {
  A: 1,
  B: 1.3,
  C: 1.7,
  D: 2.2,
};

const WEEK_MS = 7 * 86_400_000;

/** Rolling cap on persisted weekly model-error history. */
export const FORECAST_HISTORY_WEEKS = 26;
/** Per-week decay for the exponentially weighted error (newest week weight 1). */
export const FORECAST_EW_DECAY = 0.85;
/** Additive epsilon for inverse-error blend weights (avoids 1/0 on a perfect week). */
const BLEND_EPSILON = 0.01;

// ── Public types ──────────────────────────────────────────────────────────────

export type ForecastModelKey = "naive" | "trend" | "seasonal" | "cohort" | "blend";
export type ForecastModelChoice = ForecastModelKey | "auto";
export type AccuracyGrade = "A" | "B" | "C" | "D";

export interface ForecastPoint {
  /** Monday "yyyy-MM-dd" in the UTC label space of DailyRollup. */
  weekStartIso: string;
  value: number;
}

export interface ForecastBandPoint extends ForecastPoint {
  /** Lower prediction bound (~80% interval), clamped at 0. */
  lo: number;
  /** Upper prediction bound (~80% interval). */
  hi: number;
}

export interface ForecastMetricSeries {
  /** Observed weekly points, oldest first, gaps filled (see filledWeeks). */
  history: ForecastPoint[];
  /** Projected weekly points after the last observed week, with bands. */
  forecast: ForecastBandPoint[];
  /** Week keys in `history` that were carry-forward filled (no rollup rows). */
  filledWeeks: string[];
}

export interface ForecastModelReport {
  key: ForecastModelKey;
  label: string;
  available: boolean;
  minWeeksRequired: number;
  /** Mean walk-forward MAPE across MRR + actives (fraction, e.g. 0.08), null when not backtestable. */
  backtestMape: number | null;
  /** Mean signed walk-forward error fraction; >0 means the model over-forecasts. */
  backtestBias: number | null;
  /**
   * Exponentially weighted error over the persisted weekly history plus this
   * run's backtest (recent weeks weigh more) — what "auto" actually ranks on.
   * Equals backtestMape when no history has been recorded yet; null when the
   * model has never produced a measurable error. Optional so pre-history
   * report shapes remain valid.
   */
  recentWeightedMape?: number | null;
  /**
   * The model's true out-of-sample error for the newest complete week: mean
   * of the final backtest fold's one-step APE across MRR + actives (the same
   * two metrics `backtestMape` referees on). This — not the fold-overlapping
   * backtest average — is what recordForecastAccuracyWeek persists as the
   * week's error, so consecutive recorded weeks are independent measurements.
   * Null when unmeasurable this week. Optional so pre-v1.6 report shapes
   * remain valid.
   */
  holdoutMape?: number | null;
  /** True for the model "auto" would pick. */
  recommended: boolean;
}

/** One persisted week of per-model backtest error (Setting "forecastModelHistory"). */
export interface ForecastModelHistoryWeek {
  weekStartIso: string;
  recordedAt: string;
  /** Model key → that week's mean backtest MAPE (fraction); null = unavailable. */
  errors: Record<string, number | null>;
}

export interface ForecastAccuracy {
  grade: AccuracyGrade;
  label: string;
  /** Plain sentences explaining the grade — render these next to projections. */
  reasons: string[];
}

/** @deprecated Legacy v1 shape kept so existing routes compile; prefer ForecastResult.series/models/accuracy. */
export interface ForecastSeries {
  historyWeeks: string[];
  historyMrrCents: number[];
  historyActiveSubscribers: number[];
  projectedWeeks: string[];
  projectedMrrCents: number[];
  projectedActiveSubscribers: number[];
  model: {
    alpha: number;
    beta: number;
    avgCycleSurvival: number;
    weeklyRetention: number;
    avgIntervalWeeks: number;
  };
}

export interface ForecastResult extends ForecastSeries {
  series: {
    activeSubscribers: ForecastMetricSeries;
    mrrCents: ForecastMetricSeries;
    netRevenueCents: ForecastMetricSeries;
  };
  models: ForecastModelReport[];
  accuracy: ForecastAccuracy;
  /** The model that actually produced `series.*.forecast`. */
  selectedModel: ForecastModelKey;
  horizonWeeks: number;
  /** Persisted accuracy-history summary (the self-improvement audit trail). */
  modelHistory: {
    /** Weeks of per-model error history on record (0 = pre-history behavior). */
    weeksRecorded: number;
    /** Newest recorded week key, or null. */
    latestWeek: string | null;
  };
}

export interface GetForecastOptions {
  model?: ForecastModelChoice;
  /** Default 12, clamped to 1..52. */
  horizonWeeks?: number;
  now?: Date;
}

export const FORECAST_MODELS: ReadonlyArray<{
  key: ForecastModelKey;
  label: string;
  minWeeksRequired: number;
}> = [
  { key: "naive", label: "Last value carried forward", minWeeksRequired: 1 },
  { key: "trend", label: "Damped trend (Holt)", minWeeksRequired: 5 },
  { key: "seasonal", label: "Week-of-month seasonal", minWeeksRequired: 16 },
  { key: "cohort", label: "Cohort survival build-up", minWeeksRequired: 2 },
  { key: "blend", label: "Blend (weighted mix of the models above)", minWeeksRequired: 2 },
];

/** The models "blend" mixes (everything except itself). */
const BLEND_BASE_KEYS: ReadonlyArray<Exclude<ForecastModelKey, "blend">> = [
  "naive",
  "trend",
  "seasonal",
  "cohort",
];

// ── Pure model functions ──────────────────────────────────────────────────────

/**
 * Naive model: the last observed value carried forward. Returns null on an
 * empty series. Its honesty comes from the prediction band, which is derived
 * from recent volatility / backtest residuals by the caller.
 */
export function naiveForecast(series: number[], horizon: number): number[] | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  return new Array<number>(horizon).fill(Math.max(0, Math.round(last)));
}

/**
 * Holt linear (double) exponential smoothing with correct initialization:
 * level = first observation, trend = mean of the first (up to 3) first
 * differences. Smoothing starts at the second observation. With
 * `damped: true` the h-step forecast uses level + (φ + φ² + … + φ^h)·trend,
 * which converges instead of extrapolating linearly forever — essential for
 * short histories. Returns null with fewer than 2 observations. Forecasts
 * are rounded and clamped at 0.
 */
export function trendForecast(
  series: number[],
  horizon: number,
  opts?: { alpha?: number; beta?: number; damped?: boolean; phi?: number },
): number[] | null {
  if (series.length < 2) return null;
  const alpha = opts?.alpha ?? HOLT_ALPHA;
  const beta = opts?.beta ?? HOLT_BETA;
  const damped = opts?.damped ?? false;
  const phi = opts?.phi ?? HOLT_PHI;

  let level = series[0];
  const initDiffCount = Math.min(3, series.length - 1);
  let diffSum = 0;
  for (let i = 1; i <= initDiffCount; i++) diffSum += series[i] - series[i - 1];
  let trend = diffSum / initDiffCount;

  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const out: number[] = [];
  let dampedCum = 0;
  for (let h = 1; h <= horizon; h++) {
    dampedCum += Math.pow(phi, h);
    const step = damped ? dampedCum : h;
    out.push(Math.max(0, Math.round(level + step * trend)));
  }
  return out;
}

/**
 * Seasonal-naive with an additive week-of-month (period 4) adjustment:
 * forecast = mean of the last 4 observations + the average deviation of the
 * target phase from its cycle mean, measured over all complete 4-week cycles.
 * REFUSES (returns null) below 16 weeks — with fewer than 4 full cycles the
 * "seasonality" is indistinguishable from noise.
 */
export function seasonalForecast(series: number[], horizon: number): number[] | null {
  const PERIOD = 4;
  if (series.length < 16) return null;

  const fullCycles = Math.floor(series.length / PERIOD);
  const phaseDeviations: number[][] = [[], [], [], []];
  for (let c = 0; c < fullCycles; c++) {
    let cycleSum = 0;
    for (let p = 0; p < PERIOD; p++) cycleSum += series[c * PERIOD + p];
    const cycleMean = cycleSum / PERIOD;
    for (let p = 0; p < PERIOD; p++) {
      phaseDeviations[p].push(series[c * PERIOD + p] - cycleMean);
    }
  }
  const seasonal = phaseDeviations.map(
    (devs) => devs.reduce((s, d) => s + d, 0) / devs.length,
  );

  let baseSum = 0;
  for (let i = series.length - PERIOD; i < series.length; i++) baseSum += series[i];
  const base = baseSum / PERIOD;

  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    const phase = (series.length - 1 + h) % PERIOD;
    out.push(Math.max(0, Math.round(base + seasonal[phase])));
  }
  return out;
}

/**
 * Cohort model, subscriber count: bottom-up projection of the active base.
 *
 * Assumptions (all deliberate simplifications, documented for the admin UI):
 * - Decay: with `perCycleSurvival` + `cycleDistribution` supplied, the base
 *   is split into per-cycle buckets and each bucket churns at its OWN
 *   empirical hazard — early-cycle churn is demonstrably higher (the risk
 *   model buckets orders-count for the same reason), and the old blended
 *   rate under-churned young cohorts and over-churned mature ones. Without
 *   them, every contract churns at the blended rate (homogeneous — the
 *   pre-FR-6 behavior, kept for thin books where per-cycle ratios are
 *   noise).
 * - The per-cycle rate converts to weekly retention as
 *   survival^(1 / avgIntervalWeeks) (one billing cycle spans the average
 *   interval; churn is spread evenly across its weeks).
 * - Buckets advance one cycle in lockstep every `avgIntervalWeeks` weeks —
 *   the phase of each contract within its current cycle is unknowable from
 *   the ordersCount distribution, so all buckets are assumed to have just
 *   billed. Cycles beyond the observed curve reuse its LAST ratio (the
 *   flattest, most mature hazard observed), not the blended average, which
 *   folds early-cycle churn back into mature buckets.
 * - Inflow: `weeklyNewSubscribers` (the last-4-week run rate) joins every
 *   week at cycle 1 — new arrivals face the early-cycle hazard, which is
 *   exactly the point of the heterogeneous decay — and decays from its
 *   arrival week onward.
 * - No pause/resume modelling; paused contracts are simply not in the base.
 */
export function cohortActivesForecast(opts: {
  activeBase: number;
  /** Blended per-cycle survival (0..1), e.g. from decidedCycleSurvival. */
  avgCycleSurvival: number;
  avgIntervalWeeks: number;
  weeklyNewSubscribers: number;
  horizon: number;
  /**
   * Optional heterogeneous decay (FR-6): survival ratio for the cycle
   * n → n+1 transition at index n−1. The caller fills thin cycles with the
   * blended rate; cycles past the end reuse the last entry.
   */
  perCycleSurvival?: number[];
  /**
   * Share (or raw count — normalized here) of the active base currently in
   * cycle n at index n−1. Both arrays must be non-empty for the bucketed
   * path to run.
   */
  cycleDistribution?: number[];
}): number[] {
  const survival = Math.min(1, Math.max(0, opts.avgCycleSurvival));
  const interval = Math.max(1, opts.avgIntervalWeeks);
  const inflow = Math.max(0, opts.weeklyNewSubscribers);

  const ratios = opts.perCycleSurvival;
  const distribution = opts.cycleDistribution;
  const distTotal = distribution?.reduce((s, v) => s + Math.max(0, v), 0) ?? 0;

  if (!ratios || ratios.length === 0 || !distribution || distTotal <= 0) {
    // Homogeneous fallback — byte-identical to the pre-heterogeneous model.
    const weeklyRetention = Math.pow(survival, 1 / interval);
    const out: number[] = [];
    let current = Math.max(0, opts.activeBase);
    for (let h = 1; h <= opts.horizon; h++) {
      current = current * weeklyRetention + inflow;
      out.push(Math.max(0, Math.round(current)));
    }
    return out;
  }

  // Per-bucket weekly retention; cycles beyond the curve reuse its last ratio.
  const retentionFor = (cycleIdx: number): number => {
    const raw = ratios[Math.min(cycleIdx, ratios.length - 1)];
    const ratio = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : survival));
    return Math.pow(ratio, 1 / interval);
  };

  // buckets[i] = actives currently in cycle i+1, seeded proportionally to the
  // book's ordersCount distribution. One extra tail bucket absorbs advances
  // past the deepest observed cycle.
  const buckets = new Array<number>(ratios.length + 1).fill(0);
  const base = Math.max(0, opts.activeBase);
  for (let i = 0; i < distribution.length; i++) {
    buckets[Math.min(i, buckets.length - 1)] +=
      (Math.max(0, distribution[i]) / distTotal) * base;
  }

  const out: number[] = [];
  let weeksIntoCycle = 0;
  for (let h = 1; h <= opts.horizon; h++) {
    for (let i = 0; i < buckets.length; i++) buckets[i] *= retentionFor(i);
    weeksIntoCycle += 1;
    if (weeksIntoCycle >= interval) {
      // Lockstep cycle boundary: every bucket ages one cycle; the tail stays.
      for (let i = buckets.length - 1; i >= 1; i--) {
        buckets[i] = (i === buckets.length - 1 ? buckets[i] : 0) + buckets[i - 1];
      }
      buckets[0] = 0;
      weeksIntoCycle -= interval;
    }
    // Inflow joins cycle 1 AFTER any advancement so an arrival is never aged
    // out of its first cycle in its arrival week; like the homogeneous path,
    // the arrival week itself is not decayed.
    buckets[0] += inflow;
    out.push(Math.max(0, Math.round(buckets.reduce((s, v) => s + v, 0))));
  }
  return out;
}

// ── Self-improvement primitives (pure) ────────────────────────────────────────

/** One week's error carrying the calendar key the decay is computed from. */
export interface WeightedErrorEntry {
  /** Monday "yyyy-MM-dd" of the week the error was measured for. */
  weekStartIso: string;
  /** That week's error; null/undefined (model unavailable) carries no weight. */
  error: number | null | undefined;
}

/**
 * Exponentially weighted mean over a weekly error series: the newest entry's
 * week gets weight 1, every other entry is discounted by
 * decay^(calendar weeks between its week and the newest) — CALENDAR distance,
 * never array position. Recorded histories have holes (a recording-job
 * outage simply appends nothing), and positional decay compressed time
 * across them: a 10-calendar-week-old error could rank as if it were 3 weeks
 * old, so auto-selection and blend weights leaned on stale performance after
 * every outage. Null-error entries carry no weight but their weeks still
 * anchor real elapsed time. Returns null when nothing is measurable — the
 * caller falls back to the one-shot backtest, so a shop with no history
 * behaves exactly as before. (Only relative weights matter for the mean, so
 * anchoring at the newest entry rather than "today" changes nothing.)
 */
export function exponentiallyWeightedError(
  weeklyErrorsOldestFirst: WeightedErrorEntry[],
  decay: number = FORECAST_EW_DECAY,
): number | null {
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const entry of weeklyErrorsOldestFirst) {
    const ms = new Date(`${entry.weekStartIso}T00:00:00.000Z`).getTime();
    if (Number.isFinite(ms) && ms > newestMs) newestMs = ms;
  }
  let weightSum = 0;
  let errorSum = 0;
  for (const entry of weeklyErrorsOldestFirst) {
    if (entry.error == null || !Number.isFinite(entry.error)) continue;
    const ms = new Date(`${entry.weekStartIso}T00:00:00.000Z`).getTime();
    if (!Number.isFinite(ms)) continue;
    const weeksOld = Math.max(0, Math.round((newestMs - ms) / WEEK_MS));
    const weight = Math.pow(decay, weeksOld);
    weightSum += weight;
    errorSum += weight * entry.error;
  }
  return weightSum > 0 ? errorSum / weightSum : null;
}

/**
 * Exponentially weighted historical error for one model, restricted to the
 * entries a forecaster standing at a given point in time could actually have
 * known — the fold-aware honesty guard for the blend model's weights.
 *
 * `evalWeekStartIso` is the FIRST week the forecast will be scored on (null =
 * no restriction, i.e. a live forward forecast whose evaluation weeks are all
 * in the future). An entry recorded in week X only encodes actuals of weeks
 * strictly before X (the recording run drops the in-progress week), so
 * entries with weekStartIso ≤ evalWeekStartIso are exactly the leak-free set:
 * anything recorded later would fold knowledge of the evaluated weeks back
 * into the weights that are being scored on them. Without this restriction a
 * walk-forward backtest of the blend re-scores historical folds with weights
 * fit on those folds' own evaluation weeks — hindsight leakage that
 * systematically flatters blend's backtest error.
 *
 * `weeks` must be oldest-first (the order getForecast keeps priorWeeks in).
 * Returns null when no restricted entry carries a measurable error — the
 * caller's blend then falls back to equal weights.
 */
export function historyErrorAsOf(
  weeks: ForecastModelHistoryWeek[],
  key: string,
  evalWeekStartIso: string | null,
  decay: number = FORECAST_EW_DECAY,
): number | null {
  const usable =
    evalWeekStartIso == null
      ? weeks
      : weeks.filter((w) => w.weekStartIso <= evalWeekStartIso);
  return exponentiallyWeightedError(
    usable.map((w) => ({
      weekStartIso: w.weekStartIso,
      error: w.errors[key] ?? null,
    })),
    decay,
  );
}

/**
 * Inverse-error-weighted average of candidate forecasts ("blend"). Candidates
 * with a known historical error get weight 1/(error + ε); candidates without
 * one get the mean known error's weight (equal weights when nothing is
 * known). Returns null with no candidates. Deterministic; rounded, clamped
 * at 0.
 */
export function blendForecasts(
  candidates: Array<{ points: number[]; error: number | null }>,
  horizon: number,
): number[] | null {
  if (candidates.length === 0) return null;
  const known = candidates
    .map((c) => c.error)
    .filter((e): e is number => e != null && Number.isFinite(e));
  const fallbackError =
    known.length > 0 ? known.reduce((s, e) => s + e, 0) / known.length : 1;
  const weights = candidates.map(
    (c) =>
      1 /
      ((c.error != null && Number.isFinite(c.error) ? c.error : fallbackError) +
        BLEND_EPSILON),
  );
  const weightSum = weights.reduce((s, w) => s + w, 0);

  const out: number[] = [];
  for (let h = 0; h < horizon; h++) {
    let acc = 0;
    for (let i = 0; i < candidates.length; i++) {
      acc += weights[i] * (candidates[i].points[h] ?? 0);
    }
    out.push(Math.max(0, Math.round(acc / weightSum)));
  }
  return out;
}

// ── Censoring-corrected per-cycle survival ────────────────────────────────────

/**
 * Statuses that DECIDE a transition as churn — the same terminal set
 * survival.server.ts applies (its TERMINAL_STATUSES). All three matter:
 * - CANCELLED: the classic voluntary/dunning cancel with a cancelledAt.
 * - FAILED: a dunning ladder exhausted under the default exhaustedAction
 *   PAUSE leaves the contract FAILED with NO cancelledAt at all — counting
 *   only CANCELLED made payment churn structurally invisible here (the same
 *   failure mode the rollup's failedAt leg fixes) and biased survival high
 *   by exactly the involuntary share.
 * - EXPIRED: a bounded plan completing billingMaxCycles. Voluntary by the
 *   shared classification (a scheduled end, not a payment failure), but for
 *   decay purposes still a death — the contract leaves the base.
 * The voluntary/involuntary split is irrelevant to this estimator: the
 * cohort model needs TOTAL decay, so every terminal state churns its bucket.
 */
const TERMINAL_STATUSES = new Set(["CANCELLED", "FAILED", "EXPIRED"]);

export interface CycleSurvivalEstimate {
  /** Blended per-cycle survival over decided transitions (or the default). */
  avgCycleSurvival: number;
  /** Total decided (uncensored) transitions the estimate is based on. */
  decidedTransitions: number;
  /** True when the default was used because too few transitions are decided. */
  insufficientData: boolean;
  perCycle: Array<{
    cycle: number;
    survivors: number;
    churned: number;
    atRisk: number;
    ratio: number;
  }>;
}

/**
 * Kaplan-Meier-style per-cycle survival over DECIDED transitions only.
 *
 * For the cycle n → n+1 transition:
 * - survivors = contracts with ordersCount ≥ n+1 (they demonstrably reached
 *   the next cycle — including ones that churned later);
 * - churned   = terminal contracts (TERMINAL_STATUSES: CANCELLED, FAILED,
 *   EXPIRED) with ordersCount exactly n (they died before billing cycle
 *   n+1);
 * - censored  = live (ACTIVE/PAUSED) contracts with ordersCount exactly n —
 *   their next billing simply hasn't come due, so they carry NO information
 *   about this transition and are excluded from the denominator.
 *
 * This is the audit fix for the right-censoring bug: the old estimate divided
 * raw "reached cycle N" fractions, so on a young book (everyone still waiting
 * for their second billing) survival looked like mass churn.
 *
 * Below `minDecided` total decided transitions the blended estimate falls
 * back to `DEFAULT_CYCLE_SURVIVAL` with `insufficientData: true`.
 */
export function decidedCycleSurvival(
  rows: Array<{ ordersCount: number; status: string; count: number }>,
  opts?: { maxCycles?: number; minDecided?: number },
): CycleSurvivalEstimate {
  const maxCycles = opts?.maxCycles ?? MAX_SURVIVAL_RATIO_CYCLES;
  const minDecided = opts?.minDecided ?? MIN_DECIDED_TRANSITIONS;

  let maxObserved = 0;
  for (const row of rows) maxObserved = Math.max(maxObserved, row.ordersCount);
  const cap = Math.min(maxObserved, maxCycles + 1);

  // reached[n] = contracts with ordersCount ≥ n; churnedAt[n] = terminal with ordersCount === n.
  const reached = new Array<number>(cap + 2).fill(0);
  const churnedAt = new Array<number>(cap + 2).fill(0);
  for (const row of rows) {
    const upTo = Math.min(row.ordersCount, cap + 1);
    for (let n = 1; n <= upTo; n++) reached[n] += row.count;
    if (TERMINAL_STATUSES.has(row.status) && row.ordersCount <= cap + 1) {
      churnedAt[Math.min(row.ordersCount, cap + 1)] += row.count;
    }
  }

  const perCycle: CycleSurvivalEstimate["perCycle"] = [];
  let totalSurvivors = 0;
  let totalAtRisk = 0;
  for (let n = 1; n <= Math.min(maxObserved, maxCycles); n++) {
    const survivors = reached[n + 1] ?? 0;
    const churned = churnedAt[n] ?? 0;
    const atRisk = survivors + churned;
    if (atRisk === 0) continue;
    perCycle.push({
      cycle: n,
      survivors,
      churned,
      atRisk,
      ratio: round4(survivors / atRisk),
    });
    totalSurvivors += survivors;
    totalAtRisk += atRisk;
  }

  if (totalAtRisk < minDecided || totalAtRisk === 0) {
    return {
      avgCycleSurvival: DEFAULT_CYCLE_SURVIVAL,
      decidedTransitions: totalAtRisk,
      insufficientData: true,
      perCycle,
    };
  }
  return {
    avgCycleSurvival: Math.min(1, totalSurvivors / totalAtRisk),
    decidedTransitions: totalAtRisk,
    insufficientData: false,
    perCycle,
  };
}

// ── Walk-forward backtest ─────────────────────────────────────────────────────

export type Forecaster = (train: number[], horizon: number) => number[] | null;

export interface BacktestReport {
  /** Mean absolute percentage error (fraction) over all predicted points; null if none. */
  mape: number | null;
  /** Mean signed percentage error; positive = over-forecast. Null if none. */
  bias: number | null;
  /** forecast − actual at horizon 1 for each fold (feeds interval σ). */
  oneStepResiduals: number[];
  /** Number of (fold, horizon) points evaluated. */
  points: number;
  /**
   * The FINAL fold's one-step APE — the model's true out-of-sample error for
   * the newest complete week (trained strictly on the weeks before it). This
   * is what recordForecastAccuracyWeek persists as that week's error: unlike
   * `mape` (an average over folds that overlap week to week), consecutive
   * weekly values of this measurement are independent, so the exponentially
   * weighted ranking and the beat-streak built on the recorded history are
   * honest. Null when the newest actual is 0, the forecaster refused the
   * final train window, or there are no folds at all.
   */
  latestOneStepApe: number | null;
}

/**
 * Walk-forward backtest: for every fold k ≥ minTrain, train on series[0..k)
 * and predict up to `maxHorizon` steps, comparing against the actual values.
 * Zero actuals are skipped for the percentage metrics (division by zero),
 * but their residuals still count toward `oneStepResiduals`. Deterministic.
 */
export function walkForwardBacktest(
  series: number[],
  forecaster: Forecaster,
  opts?: { minTrain?: number; maxHorizon?: number },
): BacktestReport {
  const minTrain = Math.max(1, opts?.minTrain ?? 2);
  const maxHorizon = Math.max(1, opts?.maxHorizon ?? BACKTEST_MAX_HORIZON);

  const apes: number[] = [];
  const pes: number[] = [];
  const oneStepResiduals: number[] = [];
  let points = 0;
  let latestOneStepApe: number | null = null;

  for (let k = minTrain; k < series.length; k++) {
    const horizon = Math.min(maxHorizon, series.length - k);
    const preds = forecaster(series.slice(0, k), horizon);
    if (!preds) continue;
    for (let h = 1; h <= horizon; h++) {
      const forecast = preds[h - 1];
      const actual = series[k + h - 1];
      if (forecast == null || !Number.isFinite(forecast)) continue;
      const residual = forecast - actual;
      if (h === 1) oneStepResiduals.push(residual);
      points += 1;
      if (actual !== 0) {
        const ape = Math.abs(residual) / Math.abs(actual);
        apes.push(ape);
        pes.push(residual / actual);
        // The final fold (k = length−1) at h = 1 predicts the newest complete
        // week from strictly earlier data — the week's true holdout error.
        if (h === 1 && k === series.length - 1) latestOneStepApe = ape;
      }
    }
  }

  return {
    mape: apes.length > 0 ? mean(apes) : null,
    bias: pes.length > 0 ? mean(pes) : null,
    oneStepResiduals,
    points,
    latestOneStepApe,
  };
}

// ── Model selection ───────────────────────────────────────────────────────────

/**
 * "auto" picks the available model with the lowest error; ties keep the
 * earlier entry in FORECAST_MODELS order. The ranking metric is
 * `recentWeightedMape` (the exponentially weighted error over the persisted
 * weekly history — recent weeks weigh more) when a report carries one,
 * falling back to the one-shot `backtestMape` otherwise, so shops without
 * recorded history select exactly as before. An explicitly requested model is
 * honoured when available; otherwise selection falls back to auto. With no
 * measurable model at all the naive model wins (grade will already be D).
 */
export function chooseModel(
  reports: ForecastModelReport[],
  requested: ForecastModelChoice,
): ForecastModelKey {
  if (requested !== "auto") {
    const wanted = reports.find((r) => r.key === requested);
    if (wanted?.available) return wanted.key;
  }
  const metricOf = (r: ForecastModelReport): number | null =>
    r.recentWeightedMape ?? r.backtestMape;
  let best: ForecastModelReport | null = null;
  for (const report of reports) {
    if (!report.available || metricOf(report) == null) continue;
    if (best == null || (metricOf(report) as number) < (metricOf(best) as number)) {
      best = report;
    }
  }
  if (best) return best.key;
  const naive = reports.find((r) => r.key === "naive");
  if (naive?.available) return "naive";
  return reports.find((r) => r.available)?.key ?? "naive";
}

// ── Accuracy grade ────────────────────────────────────────────────────────────

const GRADE_ORDER: AccuracyGrade[] = ["D", "C", "B", "A"];
const GRADE_LABELS: Record<AccuracyGrade, string> = {
  A: "High confidence",
  B: "Moderate confidence",
  C: "Low confidence",
  D: "Very low confidence — directional only",
};

/**
 * Honest, explainable accuracy grade.
 *
 * Hard caps from history depth (a model cannot be trusted beyond its data):
 * <6 weeks → D, 6–11 → C, 12–25 → B, ≥26 → A eligible. Adjustments within
 * the cap: active base <30 → one grade down (small-number noise), backtest
 * MAPE >25% → one grade down, MAPE <10% → one grade up (never above the
 * cap), week-over-week volatility >15% → one grade down. Every input that
 * moved the grade produces a plain-language reason.
 */
export function computeAccuracy(input: {
  weeksOfHistory: number;
  activeSubscribers: number;
  /** Backtest MAPE of the selected model (fraction), null when not backtestable. */
  backtestMape: number | null;
  /** Stdev of week-over-week fractional changes, null when unmeasurable. */
  volatility: number | null;
  extraReasons?: string[];
}): ForecastAccuracy {
  const { weeksOfHistory: weeks, activeSubscribers, backtestMape, volatility } = input;
  const reasons: string[] = [];

  let capIndex: number;
  if (weeks < 6) {
    capIndex = 0;
    reasons.push(
      weeks === 0
        ? "No weekly rollup history yet — this projection is a flat line from today's live numbers."
        : `Only ${weeks} week${weeks === 1 ? "" : "s"} of history — treat this as directional at best.`,
    );
  } else if (weeks < 12) {
    capIndex = 1;
    reasons.push(
      `${weeks} weeks of history — the models haven't seen a full quarter yet.`,
    );
  } else if (weeks < 26) {
    capIndex = 2;
    reasons.push(
      `${weeks} weeks of history — enough for a trend, not yet a full seasonal picture.`,
    );
  } else {
    capIndex = 3;
    reasons.push(`${weeks} weeks of history — a solid base for trend estimation.`);
  }

  let gradeIndex = capIndex;

  if (activeSubscribers < 30) {
    gradeIndex -= 1;
    reasons.push(
      `Only ${activeSubscribers} active subscriber${activeSubscribers === 1 ? "" : "s"} — small-number noise dominates percentage moves.`,
    );
  }

  if (backtestMape == null) {
    reasons.push("Not enough history to backtest — no measured error rate yet.");
  } else if (backtestMape > 0.25) {
    gradeIndex -= 1;
    reasons.push(
      `Backtest error averaged ${Math.round(backtestMape * 100)}% — recent projections have missed by a wide margin.`,
    );
  } else if (backtestMape < 0.1) {
    gradeIndex += 1;
    reasons.push(
      `Backtest error averaged ${Math.round(backtestMape * 100)}% over the observed weeks — the selected model has been reliable.`,
    );
  } else {
    reasons.push(
      `Backtest error averaged ${Math.round(backtestMape * 100)}% over the observed weeks.`,
    );
  }

  if (volatility != null && volatility > 0.15) {
    gradeIndex -= 1;
    reasons.push(
      "Week-over-week swings above 15% — the bands are widened accordingly.",
    );
  }

  gradeIndex = Math.max(0, Math.min(capIndex, gradeIndex));
  const grade = GRADE_ORDER[gradeIndex];

  if (input.extraReasons) reasons.push(...input.extraReasons);
  return { grade, label: GRADE_LABELS[grade], reasons };
}

// ── Prediction intervals ──────────────────────────────────────────────────────

/** Population standard deviation; null on an empty sample. */
export function residualSigma(residuals: number[]): number | null {
  if (residuals.length === 0) return null;
  const m = mean(residuals);
  const variance = mean(residuals.map((r) => (r - m) * (r - m)));
  return Math.sqrt(variance);
}

/**
 * Residual-based prediction bands: half-width = 1.28 · σ · √h, multiplied by
 * the grade factor (worse grade → wider band). `lo` is clamped at 0 — none
 * of the forecast metrics can go negative.
 */
export function predictionIntervals(
  points: number[],
  sigma: number,
  grade: AccuracyGrade,
): { lo: number[]; hi: number[] } {
  const mult = GRADE_BAND_MULT[grade];
  const lo: number[] = [];
  const hi: number[] = [];
  for (let h = 1; h <= points.length; h++) {
    const half = INTERVAL_Z * sigma * Math.sqrt(h) * mult;
    const value = points[h - 1];
    lo.push(Math.max(0, Math.round(value - half)));
    hi.push(Math.max(Math.round(value + half), Math.round(value)));
  }
  return { lo, hi };
}

// ── Weekly grid materialization ───────────────────────────────────────────────

export interface WeeklyObservation {
  mrrCents: number;
  activeSubscribers: number;
  /** Charged minus refunded, clamped ≥ 0 per week by the caller. */
  netRevenueCents: number;
  newSubscribers: number;
  /**
   * Churn split + paused snapshot (FR-6c): collected by the rollup for
   * exactly this kind of consumer but not yet wired into any model — outflow
   * decomposition and pause/resume dynamics need a validated model of their
   * own, and forcing them in without one degrades backtests. Exposed on the
   * grid so a future model starts with history from day one.
   */
  churnedVoluntary?: number;
  churnedInvoluntary?: number;
  pausedSubscribers?: number;
  /**
   * True when every rollup row of the week was gap-backfilled
   * (DailyRollup.snapshotFabricated): its point-in-time columns are 0 by
   * design, so the week's snapshot must be carried forward, not believed.
   */
  snapshotFabricated?: boolean;
}

export interface WeeklyGrid {
  /** Every Monday between the first and last observed week, inclusive. */
  weeks: string[];
  /**
   * Weeks whose snapshots were carried forward rather than observed: weeks
   * with no rollup rows at all, plus weeks whose only rows were
   * gap-backfilled (snapshotFabricated — flows real, snapshots unusable).
   */
  filledWeeks: string[];
  mrrCents: number[];
  activeSubscribers: number[];
  netRevenueCents: number[];
  newSubscribers: number[];
  /** See WeeklyObservation — exposed for future models, unconsumed today. */
  churnedVoluntary: number[];
  churnedInvoluntary: number[];
  pausedSubscribers: number[];
}

/**
 * Materialize the full weekly grid between the first and last observed week
 * (audit fix: gaps from rollup downtime used to be silently dropped, so Holt
 * read a 4-week jump as one week of growth). Missing weeks carry the last
 * observation forward — honest for point-in-time metrics (MRR, actives) and
 * the least-bad assumption for the flow metrics — and are listed in
 * `filledWeeks` so the UI can annotate them.
 *
 * Weeks flagged snapshotFabricated keep their REAL flow values (backfilled
 * rollup rows recompute flows from source) but carry the previous week's
 * point-in-time snapshot forward — the backfill's zeros would otherwise read
 * as a fake collapse — and are annotated in `filledWeeks` alongside wholly
 * missing weeks, so they never count as observed history. A leading
 * fabricated week has no earlier snapshot to carry and keeps the backfill's
 * zeros (annotated); in practice the runner only backfills gaps BETWEEN real
 * rollup days, so a fabricated week always follows a real one.
 */
export function materializeWeeklyGrid(
  observed: Map<string, WeeklyObservation>,
): WeeklyGrid {
  const keys = [...observed.keys()].sort();
  const grid: WeeklyGrid = {
    weeks: [],
    filledWeeks: [],
    mrrCents: [],
    activeSubscribers: [],
    netRevenueCents: [],
    newSubscribers: [],
    churnedVoluntary: [],
    churnedInvoluntary: [],
    pausedSubscribers: [],
  };
  if (keys.length === 0) return grid;

  const first = new Date(`${keys[0]}T00:00:00.000Z`).getTime();
  const last = new Date(`${keys[keys.length - 1]}T00:00:00.000Z`).getTime();
  let previous: WeeklyObservation = observed.get(keys[0]) as WeeklyObservation;

  for (let t = first; t <= last; t += WEEK_MS) {
    const key = utcDayKey(new Date(t));
    const row = observed.get(key);
    // Effective observation: a real row as-is; a fabricated row with its
    // snapshot columns replaced by the carried-forward ones; a missing week
    // entirely carried forward.
    const snapshot: WeeklyObservation = !row
      ? previous
      : row.snapshotFabricated === true
        ? {
            ...row,
            mrrCents: previous.mrrCents,
            activeSubscribers: previous.activeSubscribers,
            pausedSubscribers: previous.pausedSubscribers,
          }
        : row;
    if (!row || row.snapshotFabricated === true) grid.filledWeeks.push(key);
    grid.weeks.push(key);
    grid.mrrCents.push(snapshot.mrrCents);
    grid.activeSubscribers.push(snapshot.activeSubscribers);
    grid.netRevenueCents.push(snapshot.netRevenueCents);
    grid.newSubscribers.push(snapshot.newSubscribers);
    grid.churnedVoluntary.push(snapshot.churnedVoluntary ?? 0);
    grid.churnedInvoluntary.push(snapshot.churnedInvoluntary ?? 0);
    grid.pausedSubscribers.push(snapshot.pausedSubscribers ?? 0);
    previous = snapshot;
  }
  return grid;
}

// ── getForecast ───────────────────────────────────────────────────────────────

type MetricKey = "activeSubscribers" | "mrrCents" | "netRevenueCents";

/**
 * Build the forecast for the dashboard and the Forecast tab.
 *
 * Returns the v2 shape ({ series, models, accuracy, selectedModel,
 * horizonWeeks }) plus the deprecated v1 fields (historyWeeks,
 * projectedMrrCents, …) so existing consumers keep working while the UI
 * migrates.
 *
 * The second argument accepts either an options object or (legacy) a Date
 * used as "now".
 */
export async function getForecast(
  shopId: string,
  optsOrNow?: GetForecastOptions | Date,
): Promise<ForecastResult> {
  const opts: GetForecastOptions =
    optsOrNow instanceof Date ? { now: optsOrNow } : optsOrNow ?? {};
  const now = opts.now ?? new Date();
  const horizonWeeks = Math.max(
    1,
    Math.min(MAX_HORIZON_WEEKS, Math.round(opts.horizonWeeks ?? DEFAULT_HORIZON_WEEKS)),
  );
  const requested: ForecastModelChoice = opts.model ?? "auto";

  // DailyRollup rows are labeled by the SHOP-LOCAL calendar day (stored as a
  // synthetic UTC midnight — see rollup.server.ts / shopDayLabelUtc), so every
  // "which week is it / where does history start" decision below must be made
  // in that label space, never off the UTC date of the instant `now`. Keying
  // off `now` directly resurrects the partial-week defect during the hours
  // when the shop-local date and the UTC date disagree: for a UTC+ shop just
  // past its local Monday midnight the just-COMPLETED week would be deleted
  // (and the in-progress bucket kept as "complete"); for a UTC− shop still in
  // its local Sunday evening the delete would be a no-op and the in-progress
  // bucket would survive.
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;

  // Refund exclusion (v1.16.0): when ON, the rollup's chargedCents already
  // excludes refunded payments (charge-day repair included), so subtracting
  // the day's recorded refunds AGAIN would double-drop the money — net
  // revenue reads chargedCents alone. Must stay in lockstep with
  // runDailyRollup's estGrossProfitCents rule. Failure-contained like the
  // history read below: a broken settings read falls back to the shipped
  // default rather than taking the forecast down.
  const { excludeRefundedPayments } = await getSetting(shopId, "analytics").catch(
    () => defaultFor("analytics"),
  );

  // Persisted per-model accuracy history (self-improvement). Failure-contained
  // and graceful: any read problem = no history = pre-history behavior.
  let recordedWeeks: ForecastModelHistoryWeek[] = [];
  try {
    const stored = await getSetting(shopId, "forecastModelHistory");
    recordedWeeks = [...stored.weeks].sort((a, b) =>
      a.weekStartIso < b.weekStartIso ? -1 : a.weekStartIso > b.weekStartIso ? 1 : 0,
    );
  } catch {
    recordedWeeks = [];
  }
  const currentWeekKey = utcWeekStartKey(shopDayLabelUtc(now, tz));
  // Strictly PRIOR weeks — blend weights and streaks must never read an entry
  // measured with knowledge of the current week (recorded earlier today).
  // Per-fold restriction on top of this happens in blendForecaster via
  // historyErrorAsOf.
  const priorWeeks = recordedWeeks.filter((w) => w.weekStartIso < currentWeekKey);

  // Label-space cutoff: the rollup query compares against DailyRollup.date
  // (labels), so the instant must be converted first (queries.server.ts
  // forbids comparing instants against rollup labels — utcDayKey drift).
  const rollupCutoff = shopDayLabelUtc(subWeeks(now, HISTORY_WEEKS), tz);
  const [rollups, activeCount, intervalAgg, survivalGroups] = await Promise.all([
    prisma.dailyRollup.findMany({
      where: { shopId, date: { gte: rollupCutoff } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        mrrCents: true,
        activeSubscribers: true,
        chargedCents: true,
        // Netting column: refunds are booked on the day they were RECORDED
        // (rollup.server.ts), so per-week subtraction is well-defined.
        refundedCents: true,
        newSubscribers: true,
        // Churn split + paused snapshot ride into the grid for future models
        // (FR-6c) — see WeeklyObservation.
        churnedVoluntary: true,
        churnedInvoluntary: true,
        pausedSubscribers: true,
        snapshotFabricated: true,
      },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", isDemo: false, ...OURS_ONLY },
    }),
    prisma.subscriptionContract.aggregate({
      where: { shopId, status: "ACTIVE", isDemo: false, ...OURS_ONLY },
      _avg: { intervalWeeks: true },
    }),
    prisma.subscriptionContract.groupBy({
      by: ["ordersCount", "status"],
      where: { shopId, isDemo: false, ...OURS_ONLY },
      _count: { _all: true },
    }),
  ]);

  // Weekly buckets. MRR / actives / paused are point-in-time → the LAST
  // rollup in each week is that week's snapshot (rows arrive date-ascending);
  // money, churn and new-subscriber counts are flows → summed across the
  // week's rollups. Gap-backfilled rows (snapshotFabricated, I1) carry REAL
  // flows but zeroed snapshots, so the snapshot must come from the week's
  // last NON-fabricated row; a week with only fabricated rows keeps the flag
  // and is carry-forward-filled + annotated by materializeWeeklyGrid.
  const weekAgg = new Map<string, WeeklyObservation>();
  for (const rollup of rollups) {
    const key = utcWeekStartKey(rollup.date);
    const prev = weekAgg.get(key);
    const real = !rollup.snapshotFabricated;
    const prevSnapshotReal = prev != null && prev.snapshotFabricated !== true;
    weekAgg.set(key, {
      mrrCents: real ? rollup.mrrCents : prevSnapshotReal ? prev.mrrCents : 0,
      activeSubscribers: real
        ? rollup.activeSubscribers
        : prevSnapshotReal
          ? prev.activeSubscribers
          : 0,
      pausedSubscribers: real
        ? rollup.pausedSubscribers
        : prevSnapshotReal
          ? prev.pausedSubscribers
          : 0,
      // Net revenue = charged − refunded, per recorded day (with refund
      // exclusion ON, charged alone — the refunded payments never entered
      // it, see above). A week can go transiently negative here (refunds
      // recorded for prior weeks' charges); the clamp below floors the
      // WEEK's total, not each step.
      netRevenueCents:
        (prev?.netRevenueCents ?? 0) +
        rollup.chargedCents -
        (excludeRefundedPayments ? 0 : rollup.refundedCents),
      newSubscribers: (prev?.newSubscribers ?? 0) + rollup.newSubscribers,
      churnedVoluntary: (prev?.churnedVoluntary ?? 0) + rollup.churnedVoluntary,
      churnedInvoluntary:
        (prev?.churnedInvoluntary ?? 0) + rollup.churnedInvoluntary,
      snapshotFabricated: real ? false : prevSnapshotReal ? false : true,
    });
  }
  // Clamp each week's net revenue at 0: a refund-heavy week whose recorded
  // refunds exceed its charges is real cash-flow-wise, but every forecast
  // metric is defined non-negative (models and bands clamp at 0 already) —
  // a negative "collected" week would poison Holt's trend and the backtest.
  for (const obs of weekAgg.values()) {
    if (obs.netRevenueCents < 0) obs.netRevenueCents = 0;
  }

  // Only COMPLETE calendar weeks may enter the series. Two buckets can never
  // be complete and are dropped before the grid is materialized:
  //  • the current week — rollup_run has only upserted the days elapsed so
  //    far, so its "weekly" flow totals are 1–6 days of money recorded as 7.
  //    Left in, naive anchors the whole horizon on the partial sum, trend
  //    reads it as a collapse, the backtest scores it as an "actual", and
  //    inflowAt drags the cohort run rate down — and all of it changes with
  //    the day of the week, so the forecast would swing without any new data.
  //    "Current" is the SHOP-LOCAL week (currentWeekKey above) — the same
  //    calendar rollup_run stamps its labels in.
  //  • the leading cutoff week — the cutoff usually lands mid-week, so the
  //    first bucket only sums the labeled days on or after it.
  // Both drops remove the WHOLE bucket (MRR/actives snapshots included): the
  // grid arrays must stay aligned, and "through the last complete week" keeps
  // the forecast deterministic within a week. If nothing remains, the
  // live-anchored fallback below takes over.
  weekAgg.delete(currentWeekKey);
  const cutoffWeekKey = utcWeekStartKey(rollupCutoff);
  if (
    rollupCutoff.getTime() >
    new Date(`${cutoffWeekKey}T00:00:00.000Z`).getTime()
  ) {
    weekAgg.delete(cutoffWeekKey);
  }
  let grid = materializeWeeklyGrid(weekAgg);
  const observedWeekCount = grid.weeks.length - grid.filledWeeks.length;

  // No rollup history at all: anchor a single synthetic "this week" point on
  // the live numbers. This is the ONLY place live counts enter the series —
  // with real history the projection starts from the last observed snapshot
  // (audit fix for the step at the forecast divider).
  if (grid.weeks.length === 0) {
    const liveMrr = await computeMrrCents(shopId, shop.currencyCode);
    grid = {
      weeks: [currentWeekKey],
      filledWeeks: [],
      mrrCents: [liveMrr],
      activeSubscribers: [activeCount],
      netRevenueCents: [0],
      newSubscribers: [0],
      churnedVoluntary: [0],
      churnedInvoluntary: [0],
      pausedSubscribers: [0],
    };
  }

  const weeks = grid.weeks;
  const weekCount = weeks.length;
  const lastActives = grid.activeSubscribers[weekCount - 1];

  // ── Censoring-corrected survival + cohort-model ingredients ──
  const survival = decidedCycleSurvival(
    survivalGroups.map((g) => ({
      ordersCount: g.ordersCount,
      status: g.status,
      count: g._count._all,
    })),
  );
  const avgIntervalWeeks = Math.max(
    1,
    intervalAgg._avg.intervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
  );
  const weeklyRetention = Math.pow(survival.avgCycleSurvival, 1 / avgIntervalWeeks);

  // ── Heterogeneous decay inputs (FR-6a) ──
  // The per-cycle hazard curve decidedCycleSurvival already computes was
  // previously discarded — only the blended average reached the cohort model,
  // which under-churned young cohorts and over-churned mature ones. Each
  // cycle's own ratio is trusted only with MIN_DECIDED_PER_CYCLE decided
  // transitions behind it (thin cycles keep the blended rate); the current
  // ACTIVE ordersCount distribution seeds the buckets. Both are measured once
  // from the current book — the same documented approximation the blended
  // survival estimate already makes for backtest folds (per-fold historical
  // snapshots don't exist). Books below MIN_DECIDED_TRANSITIONS keep the
  // homogeneous model: per-cycle ratios there are noise on noise.
  let perCycleSurvival: number[] | undefined;
  let cycleDistribution: number[] | undefined;
  if (!survival.insufficientData && survival.perCycle.length > 0) {
    const deepestCycle = survival.perCycle[survival.perCycle.length - 1].cycle;
    perCycleSurvival = new Array<number>(deepestCycle).fill(
      survival.avgCycleSurvival,
    );
    for (const cycle of survival.perCycle) {
      if (cycle.atRisk >= MIN_DECIDED_PER_CYCLE) {
        perCycleSurvival[cycle.cycle - 1] = cycle.ratio;
      }
    }
    // ACTIVE contracts by their CURRENT cycle (ordersCount 0 — awaiting the
    // first billing — sits with cycle 1; deeper than the observed curve
    // clamps to its last bucket). PAUSED contracts are not in the projected
    // base, so they don't seed buckets either.
    const distribution = new Array<number>(deepestCycle).fill(0);
    for (const group of survivalGroups) {
      if (group.status !== "ACTIVE") continue;
      const bucket = Math.min(Math.max(1, group.ordersCount), deepestCycle) - 1;
      distribution[bucket] += group._count._all;
    }
    if (distribution.some((count) => count > 0)) {
      cycleDistribution = distribution;
    }
  }

  /** New-subscriber run rate over the last up-to-4 weeks ending at index k-1. */
  const inflowAt = (k: number): number => {
    const window = grid.newSubscribers.slice(Math.max(0, k - 4), k);
    return window.length > 0 ? mean(window) : 0;
  };

  // ── Forecaster closures per metric ──
  // The cohort closures index the aligned actives/new-subscriber series by
  // train.length, so backtest folds only see data up to their train window
  // (the survival curve, per-cycle hazards and cycle distribution are all
  // estimated once from the current book — a documented approximation, since
  // per-fold historical snapshots don't exist; folds scale the distribution
  // shares to their own active base).
  const trendForecaster: Forecaster = (train, horizon) =>
    trendForecast(train, horizon, {
      alpha: HOLT_ALPHA,
      beta: HOLT_BETA,
      damped: train.length < DAMP_BELOW_WEEKS,
      phi: HOLT_PHI,
    });

  const cohortActivesForecaster: Forecaster = (train, horizon) => {
    if (train.length === 0) return null;
    return cohortActivesForecast({
      activeBase: train[train.length - 1],
      avgCycleSurvival: survival.avgCycleSurvival,
      avgIntervalWeeks,
      weeklyNewSubscribers: inflowAt(train.length),
      horizon,
      perCycleSurvival,
      cycleDistribution,
    });
  };

  /** Cohort money forecast: actives projection × current per-active value. */
  const cohortMoneyForecaster: Forecaster = (train, horizon) => {
    const k = train.length;
    if (k === 0) return null;
    const activesAtK = grid.activeSubscribers[k - 1];
    if (activesAtK == null || activesAtK <= 0) return null;
    const perActive = train[k - 1] / activesAtK;
    const actives = cohortActivesForecast({
      activeBase: activesAtK,
      avgCycleSurvival: survival.avgCycleSurvival,
      avgIntervalWeeks,
      weeklyNewSubscribers: inflowAt(k),
      horizon,
      perCycleSurvival,
      cycleDistribution,
    });
    return actives.map((a) => Math.max(0, Math.round(a * perActive)));
  };

  const baseForecasters: Record<
    Exclude<ForecastModelKey, "blend">,
    Record<MetricKey, Forecaster>
  > = {
    naive: {
      activeSubscribers: naiveForecast,
      mrrCents: naiveForecast,
      netRevenueCents: naiveForecast,
    },
    trend: {
      activeSubscribers: trendForecaster,
      mrrCents: trendForecaster,
      netRevenueCents: trendForecaster,
    },
    seasonal: {
      activeSubscribers: seasonalForecast,
      mrrCents: seasonalForecast,
      netRevenueCents: seasonalForecast,
    },
    cohort: {
      activeSubscribers: cohortActivesForecaster,
      mrrCents: cohortMoneyForecaster,
      netRevenueCents: cohortMoneyForecaster,
    },
  };

  /**
   * "blend": inverse-error-weighted average of whichever base models produce
   * a forecast for this train window. Weights come from the PRIOR persisted
   * weekly errors only (never this run's backtest) — and, fold-aware, only
   * from entries recorded no later than the first week the forecast is
   * scored on. Every `train` this closure receives is a prefix of this run's
   * weekly grid (walk-forward folds slice it; the live horizon passes the
   * whole series), so `weeks[train.length]` is the first evaluated week; for
   * the live forecast that index is past the grid and the restriction lifts
   * (all evaluation weeks are in the future). Without the per-fold
   * restriction, weights fit on errors recorded DURING a fold's evaluation
   * weeks would re-score that fold — hindsight a real-time blend never had —
   * biasing blend's backtestMape optimistic, letting "auto" prefer it over
   * honestly-scored rivals, and compounding through every recorded blend
   * error. With no usable history all contributors weigh equally.
   */
  const blendForecaster =
    (metric: MetricKey): Forecaster =>
    (train, horizon) => {
      const evalWeekKey =
        train.length < weeks.length ? weeks[train.length] : null;
      const candidates: Array<{ points: number[]; error: number | null }> = [];
      for (const key of BLEND_BASE_KEYS) {
        const points = baseForecasters[key][metric](train, horizon);
        if (!points) continue;
        candidates.push({
          points,
          error: historyErrorAsOf(priorWeeks, key, evalWeekKey),
        });
      }
      return blendForecasts(candidates, horizon);
    };

  const forecasters: Record<ForecastModelKey, Record<MetricKey, Forecaster>> = {
    ...baseForecasters,
    blend: {
      activeSubscribers: blendForecaster("activeSubscribers"),
      mrrCents: blendForecaster("mrrCents"),
      netRevenueCents: blendForecaster("netRevenueCents"),
    },
  };

  const metricSeries: Record<MetricKey, number[]> = {
    activeSubscribers: grid.activeSubscribers,
    mrrCents: grid.mrrCents,
    netRevenueCents: grid.netRevenueCents,
  };

  // ── Backtest every model (scored on MRR + actives; net revenue is too
  //    lumpy under 8-week billing intervals to referee model choice) ──
  const cohortUsable = lastActives > 0 || activeCount > 0;
  const availableBaseCount = FORECAST_MODELS.filter(
    (spec) =>
      spec.key !== "blend" &&
      weekCount >= spec.minWeeksRequired &&
      (spec.key !== "cohort" || cohortUsable),
  ).length;
  const backtests = new Map<string, BacktestReport>();
  const reports: ForecastModelReport[] = FORECAST_MODELS.map((spec) => {
    const available =
      weekCount >= spec.minWeeksRequired &&
      (spec.key !== "cohort" || cohortUsable) &&
      // A blend of fewer than two models is just that model — refuse.
      (spec.key !== "blend" || availableBaseCount >= 2);

    const mapes: number[] = [];
    const biases: number[] = [];
    const holdouts: number[] = [];
    if (available) {
      for (const metric of ["mrrCents", "activeSubscribers"] as MetricKey[]) {
        const report = walkForwardBacktest(
          metricSeries[metric],
          forecasters[spec.key][metric],
          { minTrain: spec.minWeeksRequired, maxHorizon: BACKTEST_MAX_HORIZON },
        );
        backtests.set(`${spec.key}:${metric}`, report);
        if (report.mape != null) mapes.push(report.mape);
        if (report.bias != null) biases.push(report.bias);
        if (report.latestOneStepApe != null) {
          holdouts.push(report.latestOneStepApe);
        }
      }
      // Net-revenue residuals are still needed for that metric's bands.
      backtests.set(
        `${spec.key}:netRevenueCents`,
        walkForwardBacktest(
          metricSeries.netRevenueCents,
          forecasters[spec.key].netRevenueCents,
          { minTrain: spec.minWeeksRequired, maxHorizon: BACKTEST_MAX_HORIZON },
        ),
      );
    }

    return {
      key: spec.key,
      label: spec.label,
      available,
      minWeeksRequired: spec.minWeeksRequired,
      backtestMape: mapes.length > 0 ? round4(mean(mapes)) : null,
      backtestBias: biases.length > 0 ? round4(mean(biases)) : null,
      holdoutMape: holdouts.length > 0 ? round4(mean(holdouts)) : null,
      recommended: false,
    };
  });

  // Selection metric: exponentially weighted error over the persisted weekly
  // history with this run's backtest standing in as the current week. The
  // stand-in is deliberately the full backtest, not this run's single-fold
  // holdout: it estimates the same quantity with far less variance, and it
  // keeps the documented pre-history behavior (no recorded weeks →
  // recentWeightedMape === backtestMape) intact. A persisted entry for the
  // current week is superseded by it (recorded earlier in the same week —
  // this run has strictly fresher data).
  for (const report of reports) {
    // Entries carry their calendar week so the decay measures REAL elapsed
    // time from the current week — recording-outage holes discount by the
    // weeks that actually passed, not by array position.
    report.recentWeightedMape = exponentiallyWeightedError([
      ...priorWeeks.map((w) => ({
        weekStartIso: w.weekStartIso,
        error: w.errors[report.key] ?? null,
      })),
      {
        weekStartIso: currentWeekKey,
        error: report.available ? report.backtestMape : null,
      },
    ]);
    if (report.recentWeightedMape != null) {
      report.recentWeightedMape = round4(report.recentWeightedMape);
    }
  }

  const autoChoice = chooseModel(reports, "auto");
  for (const report of reports) report.recommended = report.key === autoChoice;
  const selectedModel = chooseModel(reports, requested);
  const selectedReport = reports.find((r) => r.key === selectedModel);
  const requestedUnavailable =
    requested !== "auto" && requested !== selectedModel;

  // ── Accuracy grade (the honesty signal) ──
  const mrrChanges: number[] = [];
  for (let i = 1; i < grid.mrrCents.length; i++) {
    const prev = grid.mrrCents[i - 1];
    if (prev > 0) mrrChanges.push(grid.mrrCents[i] / prev - 1);
  }
  const volatility = mrrChanges.length >= 3 ? residualSigma(mrrChanges) : null;

  const extraReasons: string[] = [];
  if (grid.filledWeeks.length > 0) {
    extraReasons.push(
      `${grid.filledWeeks.length} missing week${grid.filledWeeks.length === 1 ? "" : "s"} of rollup data filled by carrying the last snapshot forward.`,
    );
  }
  if (selectedModel === "cohort" && survival.insufficientData) {
    extraReasons.push(
      "Too few completed billing cycles to measure real churn — a conservative default retention is used.",
    );
  }
  if (requestedUnavailable) {
    const wanted = reports.find((r) => r.key === requested);
    extraReasons.push(
      `The requested "${requested}" model needs at least ${wanted?.minWeeksRequired ?? "?"} weeks of history — "${selectedModel}" was used instead.`,
    );
  }
  if (priorWeeks.length > 0) {
    extraReasons.push(
      `Model choice is calibrated against ${priorWeeks.length} recorded week${priorWeeks.length === 1 ? "" : "s"} of forecast-accuracy history (recent weeks weigh more).`,
    );
    // How long has the selected model beaten the naive baseline, week over
    // week? A streak is the plain-language proof the learning is working.
    if (selectedModel !== "naive") {
      let streak = 0;
      for (let i = priorWeeks.length - 1; i >= 0; i--) {
        const own = priorWeeks[i].errors[selectedModel];
        const naiveErr = priorWeeks[i].errors["naive"];
        if (own != null && naiveErr != null && own < naiveErr) streak += 1;
        else break;
      }
      if (streak >= 2) {
        const label =
          reports.find((r) => r.key === selectedModel)?.label ?? selectedModel;
        extraReasons.push(
          `The ${label} model has beaten last-value-carried-forward for ${streak} straight recorded weeks.`,
        );
      }
    }
  }

  const accuracy = computeAccuracy({
    weeksOfHistory: observedWeekCount,
    activeSubscribers: activeCount,
    backtestMape: selectedReport?.backtestMape ?? null,
    volatility,
    extraReasons,
  });

  // ── Forecast + bands per metric with the selected model ──
  const lastWeekStart = new Date(`${weeks[weekCount - 1]}T00:00:00.000Z`).getTime();
  const forecastWeeks: string[] = [];
  for (let w = 1; w <= horizonWeeks; w++) {
    forecastWeeks.push(utcDayKey(new Date(lastWeekStart + w * WEEK_MS)));
  }

  const buildMetric = (metric: MetricKey): ForecastMetricSeries => {
    const series = metricSeries[metric];
    const points =
      forecasters[selectedModel][metric](series, horizonWeeks) ??
      naiveForecast(series, horizonWeeks) ??
      new Array<number>(horizonWeeks).fill(0);

    const lastValue = series[series.length - 1] ?? 0;
    const backtest = backtests.get(`${selectedModel}:${metric}`);
    const diffs: number[] = [];
    for (let i = 1; i < series.length; i++) diffs.push(series[i] - series[i - 1]);
    const sigmaBase =
      residualSigma(backtest?.oneStepResiduals ?? []) ??
      residualSigma(diffs) ??
      0.1 * Math.abs(lastValue);
    // Minimum sensible width: never tighter than 3% of the current level or 1 unit.
    const sigma = Math.max(sigmaBase, 0.03 * Math.abs(lastValue), 1);
    const { lo, hi } = predictionIntervals(points, sigma, accuracy.grade);

    return {
      history: weeks.map((weekStartIso, i) => ({
        weekStartIso,
        value: series[i],
      })),
      forecast: forecastWeeks.map((weekStartIso, i) => ({
        weekStartIso,
        value: points[i],
        lo: lo[i],
        hi: hi[i],
      })),
      filledWeeks: grid.filledWeeks,
    };
  };

  const series = {
    activeSubscribers: buildMetric("activeSubscribers"),
    mrrCents: buildMetric("mrrCents"),
    netRevenueCents: buildMetric("netRevenueCents"),
  };

  return {
    series,
    models: reports,
    accuracy,
    selectedModel,
    horizonWeeks,
    modelHistory: {
      weeksRecorded: recordedWeeks.length,
      latestWeek:
        recordedWeeks.length > 0
          ? recordedWeeks[recordedWeeks.length - 1].weekStartIso
          : null,
    },
    // ── Deprecated v1 fields (kept until the routes migrate) ──
    historyWeeks: weeks,
    historyMrrCents: grid.mrrCents,
    historyActiveSubscribers: grid.activeSubscribers,
    projectedWeeks: forecastWeeks,
    projectedMrrCents: series.mrrCents.forecast.map((p) => p.value),
    projectedActiveSubscribers: series.activeSubscribers.forecast.map((p) => p.value),
    model: {
      alpha: HOLT_ALPHA,
      beta: HOLT_BETA,
      avgCycleSurvival: round4(survival.avgCycleSurvival),
      weeklyRetention: round4(weeklyRetention),
      avgIntervalWeeks: Math.round(avgIntervalWeeks * 100) / 100,
    },
  };
}

// ── Weekly accuracy-history persistence ───────────────────────────────────────

export interface RecordForecastAccuracyResult {
  weekStartIso: string;
  /** False when this week's entry already matched (idempotent re-run). */
  recorded: boolean;
  /** Models with a measurable error this week. */
  measuredModels: number;
  weeksRetained: number;
}

/**
 * Persist this week's per-model TRUE out-of-sample error — each model's
 * one-step holdout APE for the newest complete week, trained strictly on the
 * weeks before it (ForecastModelReport.holdoutMape) — into the machine-written
 * Setting "forecastModelHistory" (rolling FORECAST_HISTORY_WEEKS weeks, one
 * entry per ISO week — re-runs within the same week overwrite in place, so
 * the nightly cadence yields exactly one entry per week; the series drops the
 * in-progress week, so the measurement is deterministic within a week).
 * Called from the risk_learning_run job; this history is what makes "auto"
 * selection, blend weights and the accuracy reasons improve as data
 * accumulates.
 *
 * Recording the holdout error instead of the full walk-forward average is
 * deliberate (hindsight-leak audit): consecutive 26-week backtest averages
 * share ~25 folds, so recorded weeks were almost perfectly correlated — the
 * "recent weeks weigh more" ranking barely discriminated and the "beaten
 * naive for N straight weeks" streak was near-tautological. One independent
 * measurement per week makes both honest, and gives the blend's fold-aware
 * weights (historyErrorAsOf) genuinely out-of-sample inputs.
 */
export async function recordForecastAccuracyWeek(
  shopId: string,
  now: Date = new Date(),
): Promise<RecordForecastAccuracyResult> {
  const forecast = await getForecast(shopId, { now });
  // Entry key in the SHOP-LOCAL label space DailyRollup lives in — the same
  // calendar getForecast keys its currentWeekKey off. Keying off the UTC week
  // of `now` would, for a UTC+ shop whose local Monday has already begun,
  // OVERWRITE the just-completed week's entry with errors measured on a grid
  // whose newest "complete" week is the 1-day in-progress bucket — and once
  // UTC catches up that poisoned entry is never rewritten, distorting the
  // "auto" ranking, blend weights and beat-streak for FORECAST_HISTORY_WEEKS.
  const shop = await requireShopById(shopId);
  const weekStartIso = utcWeekStartKey(shopDayLabelUtc(now, shop.ianaTimezone));

  const errors: Record<string, number | null> = {};
  let measuredModels = 0;
  for (const report of forecast.models) {
    const err = report.available ? report.holdoutMape ?? null : null;
    errors[report.key] = err;
    if (err != null) measuredModels += 1;
  }

  let stored: { weeks: ForecastModelHistoryWeek[] };
  try {
    stored = await getSetting(shopId, "forecastModelHistory");
  } catch {
    stored = { weeks: [] };
  }

  const existing = stored.weeks.find((w) => w.weekStartIso === weekStartIso);
  const unchanged =
    existing != null &&
    JSON.stringify(existing.errors) === JSON.stringify(errors);
  if (unchanged) {
    return {
      weekStartIso,
      recorded: false,
      measuredModels,
      weeksRetained: stored.weeks.length,
    };
  }

  const weeks = [
    ...stored.weeks.filter((w) => w.weekStartIso !== weekStartIso),
    { weekStartIso, recordedAt: now.toISOString(), errors },
  ]
    .sort((a, b) =>
      a.weekStartIso < b.weekStartIso ? -1 : a.weekStartIso > b.weekStartIso ? 1 : 0,
    )
    .slice(-FORECAST_HISTORY_WEEKS);

  await setSetting(
    shopId,
    "forecastModelHistory",
    { version: 1, weeks },
    "system:risk_learning_run",
  );
  await logEvent({
    shopId,
    type: "admin.action",
    source: "SYSTEM",
    actor: "system",
    payload: {
      action: "forecast_history_recorded",
      weekStartIso,
      errors,
      weeksRetained: weeks.length,
    },
  });

  return {
    weekStartIso,
    recorded: true,
    measuredModels,
    weeksRetained: weeks.length,
  };
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
