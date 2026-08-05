/**
 * Forecasting [analytics] — V2 (docs/ANALYTICS-V2.md §2).
 *
 * - `forecastContract` — PURE per-contract CONTRACT-model forecast:
 *   P(success) x expected order value x expected margin, per week, with
 *   survival decay driven by churn risk, dunning phase and historical
 *   skip/pause propensities. No I/O; unit-tested in tests/analytics.
 * - `survivalTrendForecast` — PURE per-contract SURVIVAL_TREND-model
 *   forecast: applies the shop's realised per-cycle retention (from the
 *   observed survival curve) to the contract's billing schedule, ignoring
 *   per-contract scores.
 * - `forecastReliability` — PURE reliability estimator (grade, score,
 *   expected error band, plain-language reasons).
 * - `computeForecast(shop, options)` — on-the-fly forecast for the UI with
 *   selectable model / scenario / horizon; no snapshot is written.
 * - `runForecastJob` — nightly snapshot of the DEFAULT options, stored in
 *   `ForecastSnapshot.rowsJson` as an envelope `{rows, meta}` where
 *   `meta = {options, computedAt, reliability}`. Legacy snapshots whose
 *   rowsJson is a bare array stay readable via `parseForecastSnapshotRows`.
 * - `runPruneJob` — housekeeping: expired idempotency keys + magic-link
 *   tokens + aged ScoreSnapshot history (always preserving the newest row per
 *   contract × kind for explainability on no-longer-scanned contracts).
 *
 * Overdue contracts: a contract whose nextBillingDate lies several intervals
 * in the past (the normal state mid-dunning) bills at most ONCE this week —
 * missed cycles collapse into a single next-charge event whose recovery
 * probability comes from the dunning state. The cycle loop is capped by the
 * horizon date, not by a cycle count, so the forecast tail is never truncated.
 *
 * Margins flow through the cost engine (`orderContribution`); the row-level
 * `marginCents` is contribution after COGS, shipping, fulfilment and payment
 * fees — no local margin math for aggregated money.
 *
 * Confidence interval methodology: each (week, SKU, market) cell is a sum of
 * independent Bernoulli order events with heterogeneous probabilities p_i and
 * values v_i (a Poisson-binomial in value space). We use the normal
 * approximation: Var = sum(p_i * (1 - p_i) * v_i^2) and report
 * expected +/- 1.96 * sqrt(Var), floored at zero.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { pruneIdempotencyKeys } from "~/services/idempotency.server";
import { logger } from "~/lib/logger.server";
import { addWeeks, daysBetween, isoDate, startOfWeek } from "~/lib/dates";
import { parseJson } from "~/types/domain";
import type { AddOnMode, DunningPhase } from "~/types/domain";
import { getSurvivalCurves } from "~/services/analytics/survival.server";
import {
  getCostModel,
  metaByProductId,
  orderContribution,
} from "~/services/analytics/costModel.server";
// Module cycle (forecast → learning → forecast) is deliberate and safe: the
// learning engine reads STATIC_PROPENSITY_PRIORS and this module reads the
// learned state — both only inside function bodies, never at module init.
import { getModelState, shrinkRate } from "~/services/analytics/learning.server";
import type { ForecastPropensityParams } from "~/services/analytics/learning.server";

// ───────────────────────────── Model constants ─────────────────────────────

export const FORECAST_HORIZON_WEEKS = 13;

/** Baseline probability a scheduled charge fails (healthy card, no dunning). */
export const BASE_FAILURE_RATE = 0.04;

/** Per-cycle voluntary exit probability at churnRiskScore = 1. */
export const CHURN_HAZARD_SCALE = 0.35;

/** Share of failed charges that are never recovered (contract effectively lost). */
export const FAILURE_LOSS_SHARE = 0.5;

/** Fallback margin fraction when ProductMeta carries no margin data. */
export const DEFAULT_MARGIN_FRACTION = 0.7;

/** Churn risk prior used when a contract has not been scored yet. */
export const DEFAULT_CHURN_RISK = 0.15;

export interface PropensityPriors {
  /** Per-cycle probability a subscriber skips a delivery. */
  skip: number;
  /** Per-cycle probability a subscriber pauses. */
  pause: number;
  /** Per-cycle exit (voluntary churn) probability. */
  churn: number;
}

/**
 * Static per-cycle skip/pause/churn propensity priors — the launch defaults
 * the forecast falls back to when nothing has been learned yet. Exported so
 * the learning engine (services/analytics/learning.server, FORECAST_PROPENSITY
 * domain) shrinks observed rates toward the SAME defaults this module uses —
 * one source of truth on both sides (docs/LEARNING-DATA-V2.md §1).
 *
 * `churn` is the per-cycle exit probability implied by the unscored-contract
 * default: DEFAULT_CHURN_RISK × CHURN_HAZARD_SCALE, so resolving an unscored
 * contract through the priors reproduces the historical behaviour exactly.
 */
export const STATIC_PROPENSITY_PRIORS: PropensityPriors = {
  skip: 0.05,
  pause: 0.03,
  churn: DEFAULT_CHURN_RISK * CHURN_HAZARD_SCALE,
};

/**
 * Probability the NEXT charge fails, by current dunning phase. Applies to the
 * first forecast cycle only; later cycles revert to BASE_FAILURE_RATE because
 * dunning either resolves or exhausts before then.
 */
export const PHASE_FAILURE_RATES: Record<DunningPhase, number> = {
  NONE: BASE_FAILURE_RATE,
  PRE_DUNNING: 0.1,
  RETRYING: 0.35,
  GRACE: 0.5,
  FINAL_NOTICE: 0.65,
  RESOLVED: 0.05,
  EXHAUSTED: 1,
};

// ───────────────────────────── Forecast options (V2) ───────────────────────

export const FORECAST_MODELS = ["CONTRACT", "SURVIVAL_TREND"] as const;
export type ForecastModel = (typeof FORECAST_MODELS)[number];

export const FORECAST_SCENARIOS = ["BASE", "CONSERVATIVE", "OPTIMISTIC"] as const;
export type ForecastScenario = (typeof FORECAST_SCENARIOS)[number];

export const FORECAST_HORIZONS = [4, 13, 26] as const;
export type ForecastHorizonWeeks = (typeof FORECAST_HORIZONS)[number];

export interface ForecastOptions {
  model: ForecastModel;
  scenario: ForecastScenario;
  horizonWeeks: ForecastHorizonWeeks;
}

export const DEFAULT_FORECAST_OPTIONS: ForecastOptions = {
  model: "CONTRACT",
  scenario: "BASE",
  horizonWeeks: 13,
};

/** Multipliers a scenario applies on top of either model. */
export interface ScenarioMultipliers {
  /** Applied to the churn hazard and the skip propensity. */
  churnSkip: number;
  /** Applied to expected add-on take-up. */
  addOns: number;
}

export const SCENARIO_MULTIPLIERS: Record<ForecastScenario, ScenarioMultipliers> = {
  BASE: { churnSkip: 1, addOns: 1 },
  CONSERVATIVE: { churnSkip: 1.35, addOns: 0.5 },
  OPTIMISTIC: { churnSkip: 0.75, addOns: 1.15 },
};

// ───────────────────────────── Pure forecast math ──────────────────────────

export interface ContractForecastInput {
  nextBillingDate: Date | null;
  intervalWeeks: number;
  /** Recurring order value in minor units (sum of line price x quantity). */
  orderValueCents: number;
  /** Margin as a fraction of order value, 0..1 (matches ProductMeta.grossMarginPercent). */
  marginPercent: number;
  /** 0..1 — from the retention module's churn scoring. */
  churnRiskScore: number;
  dunningPhase: DunningPhase;
  /** Historical share of cycles the subscriber skips, 0..1. */
  skipPropensity: number;
  /** Historical share of cycles lost to pauses, 0..1. */
  pausePropensity: number;
  /** Scenario multipliers to apply (defaults to BASE = x1). */
  scenario?: ForecastScenario;
  horizonWeeks?: number;
  /** Reference "today" for week bucketing (defaults to new Date()). */
  now?: Date;
}

export interface ContractForecastCycle {
  /** 1-based billing cycle number within the forecast horizon. */
  cycleNumber: number;
  weekIndex: number;
  billingDate: Date;
  /** Probability this cycle produces a successfully paid order. */
  pOrder: number;
  /** Expected skip / pause / cancel / failed-payment events for this cycle. */
  pSkip: number;
  pPause: number;
  pCancel: number;
  pFailedPayment: number;
  /** Survival probability entering the cycle. */
  aliveBefore: number;
}

export interface ContractForecastWeek {
  weekIndex: number;
  weekStart: Date;
  /** Billing cycle numbers that land in this week (usually 0 or 1). */
  cycleNumbers: number[];
  /** Expected successful orders this week (sum of pOrder over cycles). */
  pSuccess: number;
  pSkip: number;
  pPause: number;
  pCancel: number;
  pFailedPayment: number;
  expectedOrders: number;
  expectedRevenueCents: number;
  expectedMarginCents: number;
}

export interface ContractForecast {
  weeks: ContractForecastWeek[];
  cycles: ContractForecastCycle[];
  totalExpectedOrders: number;
  totalExpectedRevenueCents: number;
  totalExpectedMarginCents: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyWeeks(horizon: number, week0: Date): ContractForecastWeek[] {
  return Array.from({ length: horizon }, (_, i) => ({
    weekIndex: i,
    weekStart: addWeeks(week0, i),
    cycleNumbers: [],
    pSuccess: 0,
    pSkip: 0,
    pPause: 0,
    pCancel: 0,
    pFailedPayment: 0,
    expectedOrders: 0,
    expectedRevenueCents: 0,
    expectedMarginCents: 0,
  }));
}

interface CycleSlot {
  cycleNumber: number;
  weekIndex: number;
  billingDate: Date;
}

/**
 * Billing schedule shared by both forecast models.
 *
 * Overdue collapse: a contract overdue by multiple intervals bills at most
 * once this week — missed cycles are skipped, keeping only the latest date on
 * or before the current week, so it stays cycleNumber 1 (the dunning-phase
 * recovery probability applies to that single charge) and week 0 is never
 * multi-counted.
 *
 * Horizon cap: the loop is capped by the horizon DATE, not a cycle count —
 * only in-horizon cycles consume the safety budget, so a clamped overdue
 * cycle can never truncate the forecast tail.
 */
function scheduleCycles(
  nextBillingDate: Date,
  intervalWeeks: number,
  horizon: number,
  week0: Date,
): CycleSlot[] {
  const slots: CycleSlot[] = [];
  let billDate = new Date(nextBillingDate.getTime());

  // Fast-forward missed intervals: advance while the NEXT date would still
  // land on or before the current week, leaving exactly one cycle at week <= 0
  // (aligned and misaligned schedules alike). No-op for non-overdue contracts.
  while (
    daysBetween(week0, startOfWeek(addWeeks(billDate, intervalWeeks))) <= 0
  ) {
    billDate = addWeeks(billDate, intervalWeeks);
  }

  for (let cycleNumber = 1, budget = horizon + 2; budget > 0; cycleNumber++) {
    const weekIndexRaw = Math.floor(
      daysBetween(week0, startOfWeek(billDate)) / 7,
    );
    if (weekIndexRaw >= horizon) break;
    if (weekIndexRaw >= 0) budget -= 1;
    slots.push({
      cycleNumber,
      // An overdue billing date (in the past) is expected to bill this week.
      weekIndex: Math.max(0, weekIndexRaw),
      billingDate: new Date(billDate.getTime()),
    });
    billDate = addWeeks(billDate, intervalWeeks);
  }
  return slots;
}

function finalizeForecast(
  weeks: ContractForecastWeek[],
  cycles: ContractForecastCycle[],
  revenueFloat: number[],
  marginFraction: number,
): ContractForecast {
  let totalExpectedOrders = 0;
  let totalExpectedRevenueCents = 0;
  let totalExpectedMarginCents = 0;
  for (const week of weeks) {
    week.expectedRevenueCents = Math.round(revenueFloat[week.weekIndex]);
    week.expectedMarginCents = Math.round(
      revenueFloat[week.weekIndex] * marginFraction,
    );
    totalExpectedOrders += week.expectedOrders;
    totalExpectedRevenueCents += week.expectedRevenueCents;
    totalExpectedMarginCents += week.expectedMarginCents;
  }
  return {
    weeks,
    cycles,
    totalExpectedOrders,
    totalExpectedRevenueCents,
    totalExpectedMarginCents,
  };
}

/**
 * Pure per-contract forecast (CONTRACT model). Event ordering within a cycle
 * is documented as cancel → payment failure → pause → skip; each
 * expected-event probability is conditioned on the earlier events not having
 * happened. Pauses and skips do not reduce survival (the plan continues);
 * cancels remove the contract and FAILURE_LOSS_SHARE of payment failures are
 * never recovered. Scenario multipliers scale the churn hazard and skip
 * propensity.
 */
export function forecastContract(input: ContractForecastInput): ContractForecast {
  const horizon = input.horizonWeeks ?? FORECAST_HORIZON_WEEKS;
  const now = input.now ?? new Date();
  const week0 = startOfWeek(now);

  const weeks = emptyWeeks(horizon, week0);
  const cycles: ContractForecastCycle[] = [];

  const empty: ContractForecast = {
    weeks,
    cycles,
    totalExpectedOrders: 0,
    totalExpectedRevenueCents: 0,
    totalExpectedMarginCents: 0,
  };

  if (
    !input.nextBillingDate ||
    input.intervalWeeks <= 0 ||
    input.dunningPhase === "EXHAUSTED"
  ) {
    return empty;
  }

  const multipliers = SCENARIO_MULTIPLIERS[input.scenario ?? "BASE"];
  const marginFraction = clamp01(input.marginPercent);
  const pCancelCycle = clamp01(
    clamp01(input.churnRiskScore) * CHURN_HAZARD_SCALE * multipliers.churnSkip,
  );
  const pSkipCycle = clamp01(
    clamp01(input.skipPropensity) * multipliers.churnSkip,
  );
  const pPauseCycle = clamp01(input.pausePropensity);

  const revenueFloat = new Array<number>(horizon).fill(0);
  let alive = 1;

  for (const slot of scheduleCycles(
    input.nextBillingDate,
    input.intervalWeeks,
    horizon,
    week0,
  )) {
    const pFail =
      slot.cycleNumber === 1
        ? PHASE_FAILURE_RATES[input.dunningPhase]
        : BASE_FAILURE_RATE;

    const pCancelEvt = alive * pCancelCycle;
    const pFailEvt = alive * (1 - pCancelCycle) * pFail;
    const pPauseEvt = alive * (1 - pCancelCycle) * (1 - pFail) * pPauseCycle;
    const pSkipEvt =
      alive * (1 - pCancelCycle) * (1 - pFail) * (1 - pPauseCycle) * pSkipCycle;
    const pOrder =
      alive *
      (1 - pCancelCycle) *
      (1 - pFail) *
      (1 - pPauseCycle) *
      (1 - pSkipCycle);

    cycles.push({
      cycleNumber: slot.cycleNumber,
      weekIndex: slot.weekIndex,
      billingDate: slot.billingDate,
      pOrder,
      pSkip: pSkipEvt,
      pPause: pPauseEvt,
      pCancel: pCancelEvt,
      pFailedPayment: pFailEvt,
      aliveBefore: alive,
    });

    const week = weeks[slot.weekIndex];
    week.cycleNumbers.push(slot.cycleNumber);
    week.pSuccess += pOrder;
    week.pSkip += pSkipEvt;
    week.pPause += pPauseEvt;
    week.pCancel += pCancelEvt;
    week.pFailedPayment += pFailEvt;
    week.expectedOrders += pOrder;
    revenueFloat[slot.weekIndex] += pOrder * input.orderValueCents;

    alive = alive * (1 - pCancelCycle) * (1 - pFail * FAILURE_LOSS_SHARE);
  }

  return finalizeForecast(weeks, cycles, revenueFloat, marginFraction);
}

// ───────────────────────────── Survival-trend model (V2) ───────────────────

/** Minimum observed completed cycles for the survival-trend model. */
export const SURVIVAL_TREND_MIN_OBSERVED_CYCLES = 2;

/**
 * Structural view of a survival-curve point (survival.server SurvivalPoint;
 * V2 curves also carry a parallel `atRisk` array — callers may zip it in as
 * the per-point `atRisk` field, which falls back to `eligible` when absent).
 * Percentages are null when the checkpoint is not observable yet.
 */
export interface ObservedSurvivalPoint {
  kind: "REBILL" | "DAYS";
  threshold: number;
  remainingPercent: number | null;
  voluntaryExitPercent: number | null;
  paymentFailureExitPercent: number | null;
  eligible: number;
  atRisk?: number;
}

export interface ObservedRetention {
  /** Realised per-cycle retention fractions; index 0 = first rebill cycle. */
  retentionByCycle: number[];
  /** Share of observed exits that were voluntary (rest = payment failure). */
  voluntaryExitShare: number;
  /** Number of rebill checkpoints with observable at-risk contracts. */
  observedCycles: number;
}

/**
 * PURE — extract realised per-cycle retention from a survival curve's rebill
 * checkpoints. Uses the consecutive prefix of checkpoints with at-risk
 * contracts (atRisk ?? eligible > 0); returns null when fewer than
 * SURVIVAL_TREND_MIN_OBSERVED_CYCLES cycles are observable, which callers
 * treat as "fall back to the CONTRACT model".
 */
export function observedRetentionFromCurve(
  points: ObservedSurvivalPoint[],
): ObservedRetention | null {
  const rebills = points
    .filter((p) => p.kind === "REBILL")
    .sort((a, b) => a.threshold - b.threshold);

  const usable: ObservedSurvivalPoint[] = [];
  for (const point of rebills) {
    if ((point.atRisk ?? point.eligible) <= 0) break;
    if (point.remainingPercent == null) break;
    usable.push(point);
  }
  if (usable.length < SURVIVAL_TREND_MIN_OBSERVED_CYCLES) return null;

  const retentionByCycle: number[] = [];
  let previousSurvival = 1;
  for (const point of usable) {
    const survival = clamp01((point.remainingPercent ?? 0) / 100);
    retentionByCycle.push(
      previousSurvival > 0 ? clamp01(survival / previousSurvival) : 0,
    );
    previousSurvival = survival;
  }

  const deepest = usable[usable.length - 1];
  const exits =
    (deepest.voluntaryExitPercent ?? 0) +
    (deepest.paymentFailureExitPercent ?? 0);
  const voluntaryExitShare =
    exits > 0 ? clamp01((deepest.voluntaryExitPercent ?? 0) / exits) : 1;

  return { retentionByCycle, voluntaryExitShare, observedCycles: usable.length };
}

export interface SurvivalTrendForecastInput {
  nextBillingDate: Date | null;
  intervalWeeks: number;
  /** Recurring order value in minor units (sum of line price x quantity). */
  orderValueCents: number;
  /** Margin/contribution fraction 0..1 applied to expected revenue. */
  marginPercent: number;
  /**
   * Realised per-cycle retention fractions (index 0 = first upcoming cycle).
   * Cycles beyond the observed history reuse the last entry.
   */
  retentionByCycle: number[];
  /** Share of exits counted as voluntary (rest = payment failures). */
  voluntaryExitShare: number;
  scenario?: ForecastScenario;
  horizonWeeks?: number;
  now?: Date;
}

/**
 * Pure per-contract forecast (SURVIVAL_TREND model): applies the shop's
 * realised per-cycle retention to the contract's billing schedule uniformly,
 * ignoring per-contract churn/dunning scores. The scenario multiplier scales
 * the per-cycle exit hazard (1 - retention). Skips/pauses are folded into the
 * observed retention, so pSkip/pPause are 0.
 */
export function survivalTrendForecast(
  input: SurvivalTrendForecastInput,
): ContractForecast {
  const horizon = input.horizonWeeks ?? FORECAST_HORIZON_WEEKS;
  const now = input.now ?? new Date();
  const week0 = startOfWeek(now);

  const weeks = emptyWeeks(horizon, week0);
  const cycles: ContractForecastCycle[] = [];

  const empty: ContractForecast = {
    weeks,
    cycles,
    totalExpectedOrders: 0,
    totalExpectedRevenueCents: 0,
    totalExpectedMarginCents: 0,
  };

  if (
    !input.nextBillingDate ||
    input.intervalWeeks <= 0 ||
    input.retentionByCycle.length === 0
  ) {
    return empty;
  }

  const multipliers = SCENARIO_MULTIPLIERS[input.scenario ?? "BASE"];
  const marginFraction = clamp01(input.marginPercent);
  const voluntaryShare = clamp01(input.voluntaryExitShare);

  const revenueFloat = new Array<number>(horizon).fill(0);
  let alive = 1;

  for (const slot of scheduleCycles(
    input.nextBillingDate,
    input.intervalWeeks,
    horizon,
    week0,
  )) {
    const observed =
      input.retentionByCycle[
        Math.min(slot.cycleNumber, input.retentionByCycle.length) - 1
      ];
    const hazard = clamp01((1 - clamp01(observed)) * multipliers.churnSkip);
    const retention = 1 - hazard;

    const pOrder = alive * retention;
    const pExit = alive * hazard;
    const pCancelEvt = pExit * voluntaryShare;
    const pFailEvt = pExit * (1 - voluntaryShare);

    cycles.push({
      cycleNumber: slot.cycleNumber,
      weekIndex: slot.weekIndex,
      billingDate: slot.billingDate,
      pOrder,
      pSkip: 0,
      pPause: 0,
      pCancel: pCancelEvt,
      pFailedPayment: pFailEvt,
      aliveBefore: alive,
    });

    const week = weeks[slot.weekIndex];
    week.cycleNumbers.push(slot.cycleNumber);
    week.pSuccess += pOrder;
    week.pCancel += pCancelEvt;
    week.pFailedPayment += pFailEvt;
    week.expectedOrders += pOrder;
    revenueFloat[slot.weekIndex] += pOrder * input.orderValueCents;

    alive *= retention;
  }

  return finalizeForecast(weeks, cycles, revenueFloat, marginFraction);
}

// ───────────────────────────── Confidence interval ─────────────────────────

/**
 * 95% confidence interval from a normal approximation of the value-weighted
 * Poisson-binomial: expected +/- 1.96 * sqrt(variance), floored at zero.
 * `varianceCents2` is in cents-squared.
 */
export function ciBoundsCents(
  expectedCents: number,
  varianceCents2: number,
): { ciLowCents: number; ciHighCents: number } {
  const sd = Math.sqrt(Math.max(0, varianceCents2));
  const half = Math.round(1.96 * sd);
  return {
    ciLowCents: Math.max(0, expectedCents - half),
    ciHighCents: expectedCents + half,
  };
}

// ───────────────────────────── Reliability estimator (V2) ──────────────────

export interface ReliabilityInput {
  activeContracts: number;
  monthsOfHistory: number;
  completedCycles: number;
  productsWithCosts: number;
  productsTotal: number;
  cancelledObserved: number;
}

export interface Reliability {
  grade: "LOW" | "MODERATE" | "HIGH";
  score: number; // 0-100
  expectedErrorBand: string; // e.g. "±40%"
  reasons: string[];
}

const RELIABILITY_BANDS: Record<Reliability["grade"], string> = {
  LOW: "±50%",
  MODERATE: "±25%",
  HIGH: "±12%",
};

const WEEKS_PER_MONTH = 365.25 / 12 / 7;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * PURE — grade how much the forecast can be trusted.
 *
 * Scoring guide (docs/ANALYTICS-V2.md §2):
 * - active < 15 or months < 2 → LOW (±50%)
 * - active ≥ 15 & months ≥ 3 & completedCycles ≥ 30 → MODERATE (±25%)
 * - active ≥ 40 & months ≥ 6 & cancelledObserved ≥ 10 & cost coverage ≥ 60% → HIGH (±12%)
 * Anything in between the guarantees stays LOW.
 */
export function forecastReliability(input: ReliabilityInput): Reliability {
  const active = Math.max(0, Math.floor(input.activeContracts));
  const months = Math.max(0, input.monthsOfHistory);
  const cycles = Math.max(0, Math.floor(input.completedCycles));
  const cancelled = Math.max(0, Math.floor(input.cancelledObserved));
  const productsTotal = Math.max(0, Math.floor(input.productsTotal));
  const productsWithCosts = Math.min(
    productsTotal,
    Math.max(0, Math.floor(input.productsWithCosts)),
  );
  const coverage = productsTotal > 0 ? productsWithCosts / productsTotal : 0;

  const hardLow = active < 15 || months < 2;
  const high =
    !hardLow &&
    active >= 40 &&
    months >= 6 &&
    cancelled >= 10 &&
    coverage >= 0.6;
  const moderate =
    !hardLow && !high && active >= 15 && months >= 3 && cycles >= 30;
  const grade: Reliability["grade"] = high
    ? "HIGH"
    : moderate
      ? "MODERATE"
      : "LOW";

  const score = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        30 * Math.min(active / 40, 1) +
          25 * Math.min(months / 6, 1) +
          20 * Math.min(cycles / 30, 1) +
          10 * Math.min(cancelled / 10, 1) +
          15 * coverage,
      ),
    ),
  );

  const reasons: string[] = [];
  if (active < 15) {
    reasons.push(
      `Only ${plural(active, "active contract")} — small bases swing hard, so treat every number as a rough guide.`,
    );
  }
  if (months < 3) {
    const weeks = Math.round(months * WEEKS_PER_MONTH);
    if (weeks <= 0) {
      reasons.push(
        "No billing history yet — the forecast is a template, not a measurement.",
      );
    } else {
      reasons.push(
        `Only ${plural(weeks, "week")} of billing history — treat weeks ${weeks + 1}+ as directional.`,
      );
    }
  }
  if (cycles < 30) {
    reasons.push(
      `Only ${plural(cycles, "completed billing cycle")} observed — retention estimates are noisy.`,
    );
  }
  if (cancelled < 10) {
    reasons.push(
      `Only ${plural(cancelled, "cancellation")} observed — churn behaviour is still mostly assumption.`,
    );
  }
  if (productsTotal === 0) {
    reasons.push("No product cost data yet; profit lines use the default margin.");
  } else if (coverage < 0.6) {
    reasons.push(
      `${productsWithCosts} of ${productsTotal} products have real cost data; profit lines use the default margin.`,
    );
  }
  if (reasons.length === 0) {
    reasons.push(
      `Based on ${plural(active, "active contract")} and ${plural(Math.round(months), "month")} of billing history — the forecast is well grounded.`,
    );
  }

  return { grade, score, expectedErrorBand: RELIABILITY_BANDS[grade], reasons };
}

const DAYS_PER_MONTH = 30.4375;

/**
 * Gather the reliability estimator's input for a shop — UIs call this one
 * function and pass the result to `forecastReliability`.
 */
export async function computeReliabilityInputs(
  shop: string,
): Promise<ReliabilityInput> {
  const now = new Date();
  const [
    activeContracts,
    firstAttempt,
    firstContract,
    completedCycles,
    metas,
    cancelledObserved,
  ] = await Promise.all([
    prisma.subscriptionContract.count({ where: { shop, status: "ACTIVE" } }),
    prisma.billingAttempt.findFirst({
      where: { shop },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
    prisma.subscriptionContract.findFirst({
      where: { shop },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, treatmentStartedAt: true },
    }),
    prisma.billingAttempt.count({ where: { shop, status: "SUCCESS" } }),
    prisma.productMeta.findMany({
      where: { shop },
      select: { unitCostCents: true, grossMarginPercent: true },
    }),
    prisma.subscriptionContract.count({
      where: { shop, cancelledAt: { not: null } },
    }),
  ]);

  const historyStart =
    firstAttempt?.occurredAt ??
    firstContract?.treatmentStartedAt ??
    firstContract?.createdAt ??
    null;
  const monthsOfHistory = historyStart
    ? Math.max(
        0,
        Math.round((daysBetween(historyStart, now) / DAYS_PER_MONTH) * 100) /
          100,
      )
    : 0;

  return {
    activeContracts,
    monthsOfHistory,
    completedCycles,
    productsWithCosts: metas.filter(
      (m) => m.unitCostCents != null || m.grossMarginPercent != null,
    ).length,
    productsTotal: metas.length,
    cancelledObserved,
  };
}

// ───────────────────────────── Margin helpers (pure) ───────────────────────
// Kept for cross-module consumers (metrics/cohorts). Forecast aggregation
// itself routes all money through the cost engine's orderContribution.

export interface MarginMetaLike {
  grossMarginPercent: number | null;
  unitCostCents: number | null;
}

/**
 * Gross-margin fraction for a line: prefers ProductMeta.grossMarginPercent,
 * falls back to (price - unitCost) / price, then DEFAULT_MARGIN_FRACTION.
 */
export function marginFractionFor(
  priceCents: number,
  meta: MarginMetaLike | null | undefined,
): number {
  if (meta?.grossMarginPercent != null) return clamp01(meta.grossMarginPercent);
  if (meta?.unitCostCents != null && priceCents > 0) {
    return clamp01((priceCents - meta.unitCostCents) / priceCents);
  }
  return DEFAULT_MARGIN_FRACTION;
}

/**
 * Contribution fraction for a line: prefers explicit unit costs
 * ((price - unitCost) / price), falls back to grossMarginPercent, then
 * DEFAULT_MARGIN_FRACTION.
 */
export function contributionFractionFor(
  priceCents: number,
  meta: MarginMetaLike | null | undefined,
): number {
  if (meta?.unitCostCents != null && priceCents > 0) {
    return clamp01((priceCents - meta.unitCostCents) / priceCents);
  }
  if (meta?.grossMarginPercent != null) return clamp01(meta.grossMarginPercent);
  return DEFAULT_MARGIN_FRACTION;
}

/** Market for aggregation, from the contract's delivery address JSON. */
export function marketFromAddressJson(
  deliveryAddressJson: string | null | undefined,
): string {
  const address = parseJson<Record<string, unknown>>(
    deliveryAddressJson ?? null,
    {},
  );
  const candidate =
    address.countryCode ?? address.country_code ?? address.country;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate.trim().toUpperCase()
    : "UNKNOWN";
}

// Local, trivial GID tail extraction. Deliberately not imported from
// services/core/shopifyClient.server so pure-math test imports of this module
// never pull in the Shopify app bootstrap.
function skuOf(variantGid: string): string {
  const idx = variantGid.lastIndexOf("/");
  return idx === -1 ? variantGid : variantGid.slice(idx + 1);
}

// ───────────────────────────── Forecast rows + snapshot envelope ───────────

export interface ForecastRow {
  weekStart: string; // ISO date (Monday)
  sku: string;
  title: string;
  market: string;
  contractedUnits: number;
  probabilityAdjustedUnits: number;
  expectedSkips: number;
  expectedPauses: number;
  expectedCancellations: number;
  expectedFailedPayments: number;
  expectedAddOnUnits: number;
  revenueCents: number;
  marginCents: number;
  ciLowCents: number;
  ciHighCents: number;
}

export interface ForecastMeta {
  options: ForecastOptions;
  computedAt: string; // ISO datetime
  reliability: Reliability;
}

export interface ForecastResult {
  rows: ForecastRow[];
  meta: ForecastMeta;
}

/** Meta parsed from a stored snapshot; legacy array snapshots have no meta. */
export interface ForecastSnapshotMeta {
  options: ForecastOptions;
  computedAt: string | null;
  reliability: Reliability | null;
}

export interface ParsedForecastSnapshot {
  rows: ForecastRow[];
  meta: ForecastSnapshotMeta;
}

/**
 * PURE — read a `ForecastSnapshot.rowsJson` column, tolerating both the V2
 * envelope `{rows, meta}` and legacy bare-array snapshots (treated as rows
 * with default options and no stored reliability/computedAt — fall back to
 * the snapshot row's own `computedAt` column when needed).
 */
export function parseForecastSnapshotRows(
  rowsJson: string | null | undefined,
): ParsedForecastSnapshot {
  const defaultMeta = (): ForecastSnapshotMeta => ({
    options: { ...DEFAULT_FORECAST_OPTIONS },
    computedAt: null,
    reliability: null,
  });

  const parsed = parseJson<unknown>(rowsJson ?? null, null);
  if (Array.isArray(parsed)) {
    return { rows: parsed as ForecastRow[], meta: defaultMeta() };
  }
  if (parsed && typeof parsed === "object") {
    const envelope = parsed as {
      rows?: unknown;
      meta?: {
        options?: Partial<ForecastOptions>;
        computedAt?: unknown;
        reliability?: unknown;
      };
    };
    if (Array.isArray(envelope.rows)) {
      const meta = envelope.meta;
      return {
        rows: envelope.rows as ForecastRow[],
        meta: {
          options: { ...DEFAULT_FORECAST_OPTIONS, ...(meta?.options ?? {}) },
          computedAt:
            typeof meta?.computedAt === "string" ? meta.computedAt : null,
          reliability:
            meta?.reliability && typeof meta.reliability === "object"
              ? (meta.reliability as Reliability)
              : null,
        },
      };
    }
  }
  return { rows: [], meta: defaultMeta() };
}

// ───────────────────────────── Pure aggregation ────────────────────────────

export interface ForecastLineInput {
  sku: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
}

export interface ForecastAddOnInput {
  sku: string;
  title: string;
  quantity: number;
  priceCents: number;
  mode: AddOnMode;
  remainingDeliveries: number | null;
  /** Incremental contribution fraction of the add-on (cost engine). */
  contributionFraction: number;
}

export interface ForecastAggregationContract {
  /** Per-contract forecast from either model. */
  forecast: ContractForecast;
  market: string;
  /** Order-level contribution fraction from the cost engine. */
  contributionFraction: number;
  lines: ForecastLineInput[];
  addOns: ForecastAddOnInput[];
}

/**
 * PURE — aggregate per-contract forecasts into week x SKU x market rows.
 * `contractedUnits` counts every scheduled unit — subscription lines AND
 * applying add-on units — ignoring probabilities, so the ops table's
 * Expected-vs-Contracted comparison stays consistent. The scenario's add-on
 * multiplier scales expected add-on take-up (capped at probability 1), never
 * the scheduled units.
 */
export function aggregateForecastRows(
  contracts: ForecastAggregationContract[],
  week0: Date,
  scenario: ForecastScenario = "BASE",
): ForecastRow[] {
  const multipliers = SCENARIO_MULTIPLIERS[scenario];

  interface MutableRow {
    weekStart: string;
    sku: string;
    title: string;
    market: string;
    contractedUnits: number;
    probabilityAdjustedUnits: number;
    expectedSkips: number;
    expectedPauses: number;
    expectedCancellations: number;
    expectedFailedPayments: number;
    expectedAddOnUnits: number;
    revenueFloat: number;
    marginFloat: number;
    varianceFloat: number;
  }

  const acc = new Map<string, MutableRow>();
  const rowFor = (
    weekStart: string,
    sku: string,
    title: string,
    market: string,
  ): MutableRow => {
    const key = `${weekStart}|${sku}|${market}`;
    let row = acc.get(key);
    if (!row) {
      row = {
        weekStart,
        sku,
        title,
        market,
        contractedUnits: 0,
        probabilityAdjustedUnits: 0,
        expectedSkips: 0,
        expectedPauses: 0,
        expectedCancellations: 0,
        expectedFailedPayments: 0,
        expectedAddOnUnits: 0,
        revenueFloat: 0,
        marginFloat: 0,
        varianceFloat: 0,
      };
      acc.set(key, row);
    }
    return row;
  };

  for (const contract of contracts) {
    for (const cycle of contract.forecast.cycles) {
      const weekStart = isoDate(addWeeks(week0, cycle.weekIndex));

      for (const line of contract.lines) {
        const row = rowFor(weekStart, line.sku, line.title, contract.market);
        const lineValueCents = line.unitPriceCents * line.quantity;
        row.contractedUnits += line.quantity;
        row.probabilityAdjustedUnits += line.quantity * cycle.pOrder;
        row.expectedSkips += line.quantity * cycle.pSkip;
        row.expectedPauses += line.quantity * cycle.pPause;
        row.expectedCancellations += line.quantity * cycle.pCancel;
        row.expectedFailedPayments += line.quantity * cycle.pFailedPayment;
        row.revenueFloat += cycle.pOrder * lineValueCents;
        row.marginFloat +=
          cycle.pOrder * lineValueCents * contract.contributionFraction;
        row.varianceFloat +=
          cycle.pOrder * (1 - cycle.pOrder) * lineValueCents * lineValueCents;
      }

      for (const addOn of contract.addOns) {
        const applies =
          addOn.mode === "RECURRING" ||
          (addOn.mode === "NEXT_ONLY" && cycle.cycleNumber === 1) ||
          (addOn.mode === "N_DELIVERIES" &&
            cycle.cycleNumber <= (addOn.remainingDeliveries ?? 0));
        if (!applies) continue;
        const row = rowFor(weekStart, addOn.sku, addOn.title, contract.market);
        const addOnValueCents = addOn.priceCents * addOn.quantity;
        const pAddOn = Math.min(1, cycle.pOrder * multipliers.addOns);
        // Scheduled add-on deliveries ARE contracted volume: keep the ops
        // table's Expected <= Contracted comparison meaningful for SKUs sold
        // only as add-ons.
        row.contractedUnits += addOn.quantity;
        row.expectedAddOnUnits += addOn.quantity * pAddOn;
        row.revenueFloat += pAddOn * addOnValueCents;
        row.marginFloat += pAddOn * addOnValueCents * addOn.contributionFraction;
        row.varianceFloat +=
          pAddOn * (1 - pAddOn) * addOnValueCents * addOnValueCents;
      }
    }
  }

  return [...acc.values()]
    .map((r) => {
      const revenueCents = Math.round(r.revenueFloat);
      const { ciLowCents, ciHighCents } = ciBoundsCents(
        revenueCents,
        r.varianceFloat,
      );
      return {
        weekStart: r.weekStart,
        sku: r.sku,
        title: r.title,
        market: r.market,
        contractedUnits: r.contractedUnits,
        probabilityAdjustedUnits: round2(r.probabilityAdjustedUnits),
        expectedSkips: round2(r.expectedSkips),
        expectedPauses: round2(r.expectedPauses),
        expectedCancellations: round2(r.expectedCancellations),
        expectedFailedPayments: round2(r.expectedFailedPayments),
        expectedAddOnUnits: round2(r.expectedAddOnUnits),
        revenueCents,
        marginCents: Math.round(r.marginFloat),
        ciLowCents,
        ciHighCents,
      };
    })
    .sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) ||
        a.sku.localeCompare(b.sku) ||
        a.market.localeCompare(b.market),
    );
}

// ───────────────────────────── Forecast computation (I/O) ──────────────────

const SURVIVAL_TREND_FALLBACK_REASON =
  "Fewer than 2 completed billing cycles observed — not enough history for the survival-trend model, so the contract model was used instead.";

interface LoadedForecast {
  inputs: ForecastAggregationContract[];
  contracts: number;
  effectiveModel: ForecastModel;
  fallbackReason: string | null;
  /** Where skip/pause/churn priors came from (learned ModelState vs static). */
  propensitySource: { learned: boolean; sampleSize: number };
}

/**
 * Propensity resolution order (docs/LEARNING-DATA-V2.md §1): learned
 * shop-level rates from the newest FORECAST_PROPENSITY ModelState when its
 * params are well-formed, otherwise the STATIC_PROPENSITY_PRIORS launch
 * defaults.
 */
function resolvePropensityPriors(
  state: Awaited<ReturnType<typeof getModelState>>,
): { priors: PropensityPriors; learned: boolean; sampleSize: number } {
  const params = state?.params as Partial<ForecastPropensityParams> | undefined;
  if (
    params &&
    typeof params.skip === "number" &&
    typeof params.pause === "number" &&
    typeof params.churn === "number"
  ) {
    return {
      priors: {
        skip: clamp01(params.skip),
        pause: clamp01(params.pause),
        churn: clamp01(params.churn),
      },
      learned: true,
      sampleSize: state?.sampleSize ?? 0,
    };
  }
  return { priors: STATIC_PROPENSITY_PRIORS, learned: false, sampleSize: 0 };
}

async function loadForecastInputs(
  shop: string,
  options: ForecastOptions,
  now: Date,
): Promise<LoadedForecast> {
  const [contracts, propensityCounts, costModel, survivalCurves, propensityState] =
    await Promise.all([
      prisma.subscriptionContract.findMany({
        where: { shop, status: { in: ["ACTIVE", "PAUSED"] } },
        include: { lines: true, dunningState: true, addOns: true },
      }),
      prisma.analyticsEvent.groupBy({
        by: ["contractId", "name"],
        where: {
          shop,
          name: { in: ["ORDER_SKIPPED", "PAUSE_STARTED"] },
          contractId: { not: null },
        },
        _count: { _all: true },
      }),
      getCostModel(shop),
      options.model === "SURVIVAL_TREND"
        ? getSurvivalCurves(shop)
        : Promise.resolve(null),
      getModelState(shop, "FORECAST_PROPENSITY"),
    ]);

  const {
    priors,
    learned: propensityLearned,
    sampleSize: propensitySampleSize,
  } = resolvePropensityPriors(propensityState);

  const productIds = [
    ...new Set(
      contracts.flatMap((c) => [
        ...c.lines.map((l) => l.shopifyProductId),
        ...c.addOns.map((a) => a.shopifyProductId),
      ]),
    ),
  ];
  const metaMap = await metaByProductId(shop, productIds);

  let effectiveModel: ForecastModel = options.model;
  let fallbackReason: string | null = null;
  let trend: ObservedRetention | null = null;
  if (options.model === "SURVIVAL_TREND") {
    const allCurve = survivalCurves?.[0];
    trend = allCurve
      ? observedRetentionFromCurve(
          // Zip the curve-level atRisk array (parallel to points) into the
          // per-point view the pure extractor consumes.
          allCurve.points.map((point, i) => ({
            ...point,
            atRisk: allCurve.atRisk?.[i] ?? point.eligible,
          })),
        )
      : null;
    if (!trend) {
      effectiveModel = "CONTRACT";
      fallbackReason = SURVIVAL_TREND_FALLBACK_REASON;
    }
  }

  const eventCount = new Map<string, number>();
  for (const row of propensityCounts) {
    if (row.contractId) {
      eventCount.set(`${row.contractId}|${row.name}`, row._count._all);
    }
  }

  const inputs: ForecastAggregationContract[] = [];

  for (const contract of contracts) {
    let nextBillingDate = contract.nextBillingDate;
    if (contract.status === "PAUSED") {
      // An indefinite pause contributes nothing to the operational forecast.
      if (!contract.pausedUntil) continue;
      if (!nextBillingDate || contract.pausedUntil > nextBillingDate) {
        nextBillingDate = contract.pausedUntil;
      }
    }

    const orderValueCents = contract.lines.reduce(
      (sum, line) => sum + line.currentPriceCents * line.quantity,
      0,
    );

    // Every profit number flows through the cost engine: the order-level
    // contribution fraction prices in COGS, shipping, fulfilment and fees.
    const contributionLines = contract.lines.map((line) => ({
      priceCents: line.currentPriceCents,
      quantity: line.quantity,
      meta: metaMap.get(line.shopifyProductId) ?? null,
    }));
    const baseContribution = orderContribution(
      { lines: contributionLines },
      costModel,
    );

    let forecast: ContractForecast;
    if (effectiveModel === "SURVIVAL_TREND" && trend) {
      forecast = survivalTrendForecast({
        nextBillingDate,
        intervalWeeks: contract.intervalWeeks,
        orderValueCents,
        marginPercent: baseContribution.contributionFraction,
        retentionByCycle: trend.retentionByCycle,
        voluntaryExitShare: trend.voluntaryExitShare,
        scenario: options.scenario,
        horizonWeeks: options.horizonWeeks,
        now,
      });
    } else {
      // Per-contract propensities = observed rate shrunk toward the resolved
      // shop prior (learned ModelState → static defaults). A contract with no
      // history inherits the prior outright; ~20 of its own cycles move it
      // halfway to its personal rate.
      const skips = eventCount.get(`${contract.id}|ORDER_SKIPPED`) ?? 0;
      const pauses = eventCount.get(`${contract.id}|PAUSE_STARTED`) ?? 0;
      const skipCycles = contract.successfulOrders + skips;
      const skipPropensity = Math.min(
        0.9,
        shrinkRate(skips / Math.max(1, skipCycles), skipCycles, priors.skip),
      );
      const pauseCycles = contract.successfulOrders + pauses;
      const pausePropensity = Math.min(
        0.9,
        shrinkRate(pauses / Math.max(1, pauseCycles), pauseCycles, priors.pause),
      );

      forecast = forecastContract({
        nextBillingDate,
        intervalWeeks: contract.intervalWeeks,
        orderValueCents,
        marginPercent: baseContribution.contributionFraction,
        // Unscored contracts fall back to the per-cycle churn prior mapped
        // back through the hazard scale (static priors reproduce
        // DEFAULT_CHURN_RISK exactly).
        churnRiskScore:
          contract.churnRiskScore ?? clamp01(priors.churn / CHURN_HAZARD_SCALE),
        dunningPhase: (contract.dunningState?.phase ?? "NONE") as DunningPhase,
        skipPropensity,
        pausePropensity,
        scenario: options.scenario,
        horizonWeeks: options.horizonWeeks,
        now,
      });
    }

    const addOns: ForecastAddOnInput[] = contract.addOns.map((addOn) => {
      // Incremental contribution of the add-on on top of the base order:
      // marginal COGS + payment fee only (per-delivery costs are already
      // carried by the base order).
      const addOnValueCents = addOn.priceCents * addOn.quantity;
      const withAddOn = orderContribution(
        {
          lines: [
            ...contributionLines,
            {
              priceCents: addOn.priceCents,
              quantity: addOn.quantity,
              meta: metaMap.get(addOn.shopifyProductId) ?? null,
            },
          ],
        },
        costModel,
      );
      const incrementalCents =
        withAddOn.contributionCents - baseContribution.contributionCents;
      const contributionFraction =
        addOnValueCents > 0
          ? Math.max(-1, Math.min(1, incrementalCents / addOnValueCents))
          : 0;
      return {
        sku: skuOf(addOn.shopifyVariantId),
        title: addOn.title,
        quantity: addOn.quantity,
        priceCents: addOn.priceCents,
        mode: addOn.mode as AddOnMode,
        remainingDeliveries: addOn.remainingDeliveries,
        contributionFraction,
      };
    });

    inputs.push({
      forecast,
      market: marketFromAddressJson(contract.deliveryAddressJson),
      contributionFraction: baseContribution.contributionFraction,
      lines: contract.lines.map((line) => ({
        sku: skuOf(line.shopifyVariantId),
        title: line.title,
        quantity: line.quantity,
        unitPriceCents: line.currentPriceCents,
      })),
      addOns,
    });
  }

  return {
    inputs,
    contracts: contracts.length,
    effectiveModel,
    fallbackReason,
    propensitySource: {
      learned: propensityLearned,
      sampleSize: propensitySampleSize,
    },
  };
}

interface ComputedForecast {
  rows: ForecastRow[];
  contracts: number;
  meta: ForecastMeta;
}

async function computeForecastAt(
  shop: string,
  options: ForecastOptions,
  now: Date,
): Promise<ComputedForecast> {
  const [reliabilityInput, loaded] = await Promise.all([
    computeReliabilityInputs(shop),
    loadForecastInputs(shop, options, now),
  ]);

  const reliability = forecastReliability(reliabilityInput);
  if (loaded.fallbackReason) {
    reliability.reasons.unshift(loaded.fallbackReason);
  }
  if (loaded.effectiveModel === "CONTRACT") {
    reliability.reasons.push(
      loaded.propensitySource.learned
        ? `Skip and pause rates learned from ${loaded.propensitySource.sampleSize} observed billing cycles.`
        : "Skip and pause rates use industry priors — too little subscriber history to learn from yet.",
    );
  }

  const rows = aggregateForecastRows(
    loaded.inputs,
    startOfWeek(now),
    options.scenario,
  );

  return {
    rows,
    contracts: loaded.contracts,
    meta: { options, computedAt: now.toISOString(), reliability },
  };
}

/**
 * On-the-fly forecast for the UI with selectable model, scenario and horizon.
 * Never writes a snapshot. When the SURVIVAL_TREND model lacks observed
 * history (< 2 completed cycles) it falls back to CONTRACT and says so in
 * `meta.reliability.reasons`.
 */
export async function computeForecast(
  shop: string,
  options: ForecastOptions,
): Promise<ForecastResult> {
  const merged: ForecastOptions = { ...DEFAULT_FORECAST_OPTIONS, ...options };
  const { rows, meta } = await computeForecastAt(shop, merged, new Date());
  return { rows, meta };
}

// ───────────────────────────── Forecast job ────────────────────────────────

export interface ForecastJobResult {
  shops: number;
  snapshots: Array<{ shop: string; snapshotId: string; rows: number }>;
}

async function forecastShop(
  shop: string,
  now: Date,
): Promise<{ snapshotId: string; rows: number }> {
  const computed = await computeForecastAt(shop, DEFAULT_FORECAST_OPTIONS, now);

  const snapshot = await prisma.forecastSnapshot.create({
    data: {
      shop,
      horizonWeeks: DEFAULT_FORECAST_OPTIONS.horizonWeeks,
      rowsJson: JSON.stringify({ rows: computed.rows, meta: computed.meta }),
    },
  });

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "FORECAST_SNAPSHOT_CREATED",
    subjectType: "ForecastSnapshot",
    subjectId: snapshot.id,
    payload: {
      horizonWeeks: DEFAULT_FORECAST_OPTIONS.horizonWeeks,
      model: DEFAULT_FORECAST_OPTIONS.model,
      scenario: DEFAULT_FORECAST_OPTIONS.scenario,
      rows: computed.rows.length,
      contracts: computed.contracts,
      reliabilityGrade: computed.meta.reliability.grade,
    },
  });

  return { snapshotId: snapshot.id, rows: computed.rows.length };
}

export async function runForecastJob(shop?: string): Promise<ForecastJobResult> {
  const now = new Date();
  const shops = shop
    ? [shop]
    : (
        await prisma.subscriptionContract.findMany({
          distinct: ["shop"],
          select: { shop: true },
        })
      ).map((r) => r.shop);

  const snapshots: ForecastJobResult["snapshots"] = [];
  for (const s of shops) {
    const { snapshotId, rows } = await forecastShop(s, now);
    snapshots.push({ shop: s, snapshotId, rows });
    logger.info("forecast snapshot created", { shop: s, snapshotId, rows });
  }
  return { shops: shops.length, snapshots };
}

// ───────────────────────────── Prune job ───────────────────────────────────

export interface PruneJobResult {
  idempotencyKeysPruned: number;
  magicLinkTokensPruned: number;
  snapshotsPruned: number;
}

/** ScoreSnapshot rows older than this are pruned (newest per contract × kind kept). */
export const SCORE_SNAPSHOT_RETENTION_DAYS = 180;

/**
 * Housekeeping: removes expired idempotency keys (foundation helper), expired
 * magic-link tokens, and ScoreSnapshot rows older than
 * SCORE_SNAPSHOT_RETENTION_DAYS. The newest snapshot per (contractId, kind)
 * is always preserved — PAUSED/CANCELLED contracts are no longer rescanned,
 * and the CS console still needs their latest factor breakdown. `shop`
 * narrows token/snapshot deletion only — idempotency keys are keyed globally.
 */
export async function runPruneJob(shop?: string): Promise<PruneJobResult> {
  const idempotencyKeysPruned = await pruneIdempotencyKeys();
  const tokens = await prisma.magicLinkToken.deleteMany({
    where: { expiresAt: { lt: new Date() }, ...(shop ? { shop } : {}) },
  });

  const cutoff = new Date(
    Date.now() - SCORE_SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000,
  );
  const shopParam = shop ?? null;
  const snapshotsPruned = await prisma.$executeRaw`
    DELETE FROM "ScoreSnapshot"
    WHERE "computedAt" < ${cutoff}
      AND (${shopParam} IS NULL OR "shop" = ${shopParam})
      AND EXISTS (
        SELECT 1 FROM "ScoreSnapshot" newer
        WHERE newer."contractId" = "ScoreSnapshot"."contractId"
          AND newer."kind" = "ScoreSnapshot"."kind"
          AND newer."computedAt" > "ScoreSnapshot"."computedAt"
      )`;

  if (shop) {
    await appendAudit({
      shop,
      actorType: "SYSTEM",
      action: "MAINTENANCE_PRUNE",
      payload: {
        idempotencyKeysPruned,
        magicLinkTokensPruned: tokens.count,
        snapshotsPruned,
      },
    });
  } else {
    logger.info("prune completed", {
      idempotencyKeysPruned,
      magicLinkTokensPruned: tokens.count,
      snapshotsPruned,
    });
  }

  return {
    idempotencyKeysPruned,
    magicLinkTokensPruned: tokens.count,
    snapshotsPruned,
  };
}
