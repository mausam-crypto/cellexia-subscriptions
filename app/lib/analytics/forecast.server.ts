import prisma from "~/db.server";
import { subWeeks } from "date-fns";
import { computeMrrCents, utcDayKey, utcWeekStartKey } from "./queries.server";
import { getSurvivalByCycle } from "./survival.server";

/**
 * 12-week forward projection of MRR and active subscribers.
 *
 * MRR: Holt's linear (double) exponential smoothing over up to 26 weekly MRR
 * observations from DailyRollup — level/trend model, no seasonality (weekly
 * subscription revenue for a single brand has little of it).
 *
 * Subscribers: cohort-retention decay — the average per-cycle survival from
 * the observed survival curve, converted to a weekly retention using the
 * average billing interval, applied to the current active base. Deliberately
 * conservative: new-subscriber inflow is not projected (that's marketing's
 * forecast, not the subscription engine's).
 */

const HOLT_ALPHA = 0.5;
const HOLT_BETA = 0.3;
const HISTORY_WEEKS = 26;
const HORIZON_WEEKS = 12;
/** Used when the book is too young to estimate per-cycle survival. */
const DEFAULT_CYCLE_SURVIVAL = 0.9;
/** Fallback average billing interval (the default plan frequency). */
const DEFAULT_INTERVAL_WEEKS = 8;
/** Per-cycle survival ratios beyond this cycle are too thin to trust. */
const MAX_SURVIVAL_RATIO_CYCLES = 12;

const WEEK_MS = 7 * 86_400_000;

export interface ForecastSeries {
  /** Observed weekly points, oldest first ("yyyy-MM-dd" Monday keys, UTC label space of DailyRollup). */
  historyWeeks: string[];
  historyMrrCents: number[];
  historyActiveSubscribers: number[];
  /** Next 12 weekly points after the last observed week. */
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

/**
 * Holt's linear exponential smoothing. Returns `horizon` forecasts
 * (level + h × trend), clamped to ≥ 0.
 */
function holtForecast(
  series: number[],
  alpha: number,
  beta: number,
  horizon: number,
): number[] {
  if (series.length === 0) {
    return new Array<number>(horizon).fill(0);
  }
  const first = series[0];
  if (series.length === 1) {
    return new Array<number>(horizon).fill(Math.max(0, Math.round(first)));
  }

  let level = first;
  let trend = series[1] - first;
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = alpha * series[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const out: number[] = [];
  for (let h = 1; h <= horizon; h++) {
    out.push(Math.max(0, Math.round(level + h * trend)));
  }
  return out;
}

/**
 * Build the forecast series for charting. Resilient to sparse data: with fewer
 * than two weekly rollup points it projects a flat line from live MRR.
 */
export async function getForecast(
  shopId: string,
  now: Date = new Date(),
): Promise<ForecastSeries> {
  const historyCutoff = subWeeks(now, HISTORY_WEEKS);

  const [rollups, activeCount, intervalAgg, survival] = await Promise.all([
    prisma.dailyRollup.findMany({
      where: { shopId, date: { gte: historyCutoff } },
      orderBy: { date: "asc" },
      select: { date: true, mrrCents: true, activeSubscribers: true },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", isDemo: false },
    }),
    prisma.subscriptionContract.aggregate({
      where: { shopId, status: "ACTIVE", isDemo: false },
      _avg: { intervalWeeks: true },
    }),
    getSurvivalByCycle(shopId),
  ]);

  // Weekly buckets: the LAST rollup in each week is that week's snapshot
  // (MRR and active count are point-in-time metrics, not sums).
  const weekMap = new Map<string, { mrrCents: number; activeSubscribers: number }>();
  for (const rollup of rollups) {
    weekMap.set(utcWeekStartKey(rollup.date), {
      mrrCents: rollup.mrrCents,
      activeSubscribers: rollup.activeSubscribers,
    });
  }
  const historyWeeks = [...weekMap.keys()].sort();
  const historyMrrCents = historyWeeks.map((w) => weekMap.get(w)?.mrrCents ?? 0);
  const historyActiveSubscribers = historyWeeks.map(
    (w) => weekMap.get(w)?.activeSubscribers ?? 0,
  );

  // ── MRR projection (Holt) ──
  let projectedMrrCents: number[];
  if (historyMrrCents.length >= 2) {
    projectedMrrCents = holtForecast(
      historyMrrCents,
      HOLT_ALPHA,
      HOLT_BETA,
      HORIZON_WEEKS,
    );
  } else {
    // Too little rollup history — flat-line the live MRR.
    const liveMrr = await computeMrrCents(shopId);
    projectedMrrCents = new Array<number>(HORIZON_WEEKS).fill(liveMrr);
  }

  // ── Subscriber projection (cohort survival decay) ──
  // Average per-cycle survival = mean of S(n+1)/S(n) over the early curve.
  const ratios: number[] = [];
  const maxN = Math.min(survival.overall.length - 1, MAX_SURVIVAL_RATIO_CYCLES);
  for (let i = 0; i < maxN; i++) {
    const current = survival.overall[i];
    const next = survival.overall[i + 1];
    if (current > 0) ratios.push(Math.min(1, next / current));
  }
  const avgCycleSurvival =
    ratios.length > 0
      ? ratios.reduce((sum, r) => sum + r, 0) / ratios.length
      : DEFAULT_CYCLE_SURVIVAL;

  const avgIntervalWeeks = Math.max(
    1,
    intervalAgg._avg.intervalWeeks ?? DEFAULT_INTERVAL_WEEKS,
  );
  // One cycle spans avgIntervalWeeks weeks → weekly retention is the cycle
  // survival taken to the 1/interval power.
  const weeklyRetention = Math.pow(avgCycleSurvival, 1 / avgIntervalWeeks);

  const projectedActiveSubscribers: number[] = [];
  for (let w = 1; w <= HORIZON_WEEKS; w++) {
    projectedActiveSubscribers.push(
      Math.max(0, Math.round(activeCount * Math.pow(weeklyRetention, w))),
    );
  }

  // ── Projected week labels: continue weekly from the last observed week ──
  const lastWeekKey =
    historyWeeks.length > 0
      ? historyWeeks[historyWeeks.length - 1]
      : utcWeekStartKey(now);
  const lastWeekStart = new Date(`${lastWeekKey}T00:00:00.000Z`);
  const projectedWeeks: string[] = [];
  for (let w = 1; w <= HORIZON_WEEKS; w++) {
    projectedWeeks.push(
      utcDayKey(new Date(lastWeekStart.getTime() + w * WEEK_MS)),
    );
  }

  return {
    historyWeeks,
    historyMrrCents,
    historyActiveSubscribers,
    projectedWeeks,
    projectedMrrCents,
    projectedActiveSubscribers,
    model: {
      alpha: HOLT_ALPHA,
      beta: HOLT_BETA,
      avgCycleSurvival: Math.round(avgCycleSurvival * 10_000) / 10_000,
      weeklyRetention: Math.round(weeklyRetention * 10_000) / 10_000,
      avgIntervalWeeks: Math.round(avgIntervalWeeks * 100) / 100,
    },
  };
}
