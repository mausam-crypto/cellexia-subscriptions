/**
 * Executive-dashboard insights + pure dashboard helpers [analytics/dashboard].
 *
 * `buildInsights` (ANALYTICS-V2 §3) turns two ExecutiveMetrics periods plus
 * forecast reliability / cost-model / best-configuration context into at most
 * five plain-language, importance-ordered insight cards. It is PURE — no
 * Prisma, no Shopify — and unit-tested in tests/analytics/insights.test.ts.
 *
 * The other exports are the pure halves of dashboard bug fixes:
 * - `reconstructActiveCount` — honest previous-period values for the
 *   point-in-time "active plans" tile (the old dashboard compared a metric
 *   computed from current DB state against itself and showed "Steady"
 *   forever).
 * - `aggregateForecastWeeks` — dense week axis over the full forecast
 *   horizon (the old chart dropped zero-revenue weeks, compressing a monthly
 *   cadence into what read as weekly revenue).
 * - `measurableSurvival` — drops 0/0 survival checkpoints so young shops
 *   see "not enough data yet" instead of a fabricated 0% curve.
 */
import type { ExecutiveMetrics } from "~/services/analytics/metrics.server";
import type { Reliability } from "~/services/analytics/forecast.server";
import type { CostModel } from "~/services/analytics/costModel.server";
import type { BestConfiguration } from "~/services/analytics/cohorts.server";
import { addWeeks, isoDate, startOfWeek } from "~/lib/dates";
import { fmtMoney, fmtPct } from "~/components/charts/format";

// ───────────────────────────── Insights ────────────────────────────────────

export interface Insight {
  tone: "positive" | "warning" | "neutral";
  headline: string;
  detail?: string;
  linkTo?: string;
}

export interface InsightExtras {
  reliability: Reliability;
  costModel: CostModel;
  bestConfig?: BestConfiguration;
}

type NumericMetricKey = {
  [K in keyof ExecutiveMetrics]-?: ExecutiveMetrics[K] extends number
    ? K
    : never;
}[keyof ExecutiveMetrics];

interface MoverDef {
  key: NumericMetricKey;
  label: string;
  /** Business direction: is an increase good for the merchant? */
  goodWhenUp: boolean;
}

/**
 * Rate metrics eligible for the "biggest mover" insight. Only range-scoped
 * rates belong here — point-in-time metrics have no honest previous value.
 */
const MOVERS: readonly MoverDef[] = [
  { key: "voluntaryChurnRate", label: "Voluntary churn", goodWhenUp: false },
  { key: "involuntaryChurnRate", label: "Payment-related churn", goodWhenUp: false },
  { key: "skipRate", label: "Skip rate", goodWhenUp: false },
  { key: "pauseRate", label: "Pause rate", goodWhenUp: false },
  { key: "reactivationRate", label: "Reactivation rate", goodWhenUp: true },
  { key: "paymentRecoveryRate", label: "Payment recovery", goodWhenUp: true },
  { key: "widgetConversionRate", label: "Widget conversion", goodWhenUp: true },
  { key: "attachRate", label: "Plan attach rate", goodWhenUp: true },
  { key: "oneTimeToSubscriptionRate", label: "One-time to plan conversion", goodWhenUp: true },
  { key: "productAdditionRate", label: "Product addition rate", goodWhenUp: true },
];

/** A rate move below half a percentage point is noise, not an insight. */
const MIN_RATE_MOVE = 0.005;
/** Involuntary share of churn from which payment failures dominate. */
const INVOLUNTARY_DOMINANT_SHARE = 0.5;
/** Involuntary-share shift (pp of churn mix) worth calling out. */
const MIN_SHARE_SHIFT = 0.15;
const MAX_INSIGHTS = 5;

/**
 * PURE — build the dashboard insight strip. At most five insights, ordered
 * by importance: biggest rate mover, churn composition, best configuration,
 * costs-unset warning, low forecast reliability. Tones follow BUSINESS
 * direction (voluntary churn falling is positive even though the number
 * went down).
 */
export function buildInsights(
  current: ExecutiveMetrics,
  previous: ExecutiveMetrics,
  extras: InsightExtras,
): Insight[] {
  const insights: Insight[] = [];
  const currency = current.currencyCode;

  // 1. Biggest mover among the honestly-comparable rates.
  let best: { def: MoverDef; delta: number } | null = null;
  for (const def of MOVERS) {
    const cur = current[def.key];
    const prev = previous[def.key];
    if (!Number.isFinite(cur) || !Number.isFinite(prev)) continue;
    const delta = cur - prev;
    if (Math.abs(delta) < MIN_RATE_MOVE) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { def, delta };
  }
  if (best) {
    const improved = best.delta > 0 === best.def.goodWhenUp;
    const ppText = `${(Math.abs(best.delta) * 100).toFixed(1)} pp`;
    insights.push({
      tone: improved ? "positive" : "warning",
      headline: `${best.def.label} ${improved ? "improved" : "worsened"} by ${ppText}`,
      detail: `${fmtPct(current[best.def.key])} this period vs ${fmtPct(previous[best.def.key])} in the period before.`,
    });
  }

  // 2. Churn composition: is churn (increasingly) payment-driven?
  const curTotal = current.voluntaryChurnRate + current.involuntaryChurnRate;
  if (curTotal > 0) {
    const invShare = current.involuntaryChurnRate / curTotal;
    const prevTotal =
      previous.voluntaryChurnRate + previous.involuntaryChurnRate;
    const prevShare =
      prevTotal > 0 ? previous.involuntaryChurnRate / prevTotal : null;
    if (invShare >= INVOLUNTARY_DOMINANT_SHARE) {
      insights.push({
        tone: "warning",
        headline: `Payment failures drive ${fmtPct(invShare, 0)} of churn`,
        detail:
          "Failed cards now cost at least as many plans as customer cancellations — recovering them is usually cheaper than win-back offers.",
        linkTo: "/app/dunning",
      });
    } else if (prevShare != null && invShare - prevShare >= MIN_SHARE_SHIFT) {
      insights.push({
        tone: "warning",
        headline: "Churn is shifting toward payment failures",
        detail: `${fmtPct(invShare, 0)} of churn is payment-related this period, up from ${fmtPct(prevShare, 0)} in the period before.`,
        linkTo: "/app/dunning",
      });
    }
  }

  // 3. Best-performing acquisition configuration.
  if (extras.bestConfig && extras.bestConfig.contracts > 0) {
    const bc = extras.bestConfig;
    const maturity =
      bc.matureContracts === 0
        ? " (cohort still maturing — treat as directional)"
        : "";
    insights.push({
      tone: "positive",
      headline: `Best configuration: ${bc.source} · ${bc.offer} · ${bc.product}`,
      detail: `${bc.cadenceWeeks}-week cadence, averaging ${fmtMoney(bc.avgContribution12mCents, currency)} contribution in the first 12 months across ${bc.contracts} plans${maturity}.`,
      linkTo: "/app/analytics?tab=cohorts",
    });
  }

  // 4. Cost model not configured — every profit tile is an estimate.
  if (!extras.costModel.configured) {
    insights.push({
      tone: "warning",
      headline: "Profit numbers use default margins",
      detail:
        "Set real product costs, shipping, fulfilment and payment fees so contribution and LTV reflect true profit.",
      linkTo: "/app/analytics?tab=costs",
    });
  }

  // 5. Low forecast reliability.
  if (extras.reliability.grade === "LOW") {
    insights.push({
      tone: "neutral",
      headline: `Forecast reliability is low (${extras.reliability.expectedErrorBand})`,
      detail:
        extras.reliability.reasons[0] ??
        "More billing history will tighten the forecast.",
      linkTo: "/app/analytics?tab=forecast",
    });
  }

  return insights.slice(0, MAX_INSIGHTS);
}

// ─────────────────── Point-in-time reconstruction ──────────────────────────

export interface ContractStateRow {
  createdAt: Date | string;
  cancelledAt: Date | string | null;
  status: string;
  pausedUntil: Date | string | null;
}

const TERMINAL_STATUSES = new Set(["CANCELLED", "EXPIRED", "FAILED"]);

function toTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * PURE — how many contracts were plausibly active at `at`, reconstructed
 * from createdAt/cancelledAt/pausedUntil. This gives the "active plans"
 * tile an honest period-over-period delta (the stored metric is computed
 * from current state only, so current === previous, structurally).
 *
 * Rules, chosen to never fabricate a trend:
 * - counted only once created (createdAt <= at) and until cancelled
 *   (cancelledAt > at);
 * - terminal contracts with NO cancelledAt (externally cancelled before the
 *   sync stamped a date) are censored at every checkpoint — their death
 *   date is unknown, so counting them anywhere would invent a delta;
 * - a currently-PAUSED contract is excluded only where its pause window is
 *   verifiable: we know it covers [now, pausedUntil], while past pause
 *   state is not reconstructable and counts as active.
 */
export function reconstructActiveCount(
  rows: readonly ContractStateRow[],
  at: Date,
  now: Date,
): number {
  const atMs = at.getTime();
  const nowMs = now.getTime();
  let count = 0;
  for (const row of rows) {
    if (toTime(row.createdAt) > atMs) continue;
    if (row.cancelledAt != null) {
      if (toTime(row.cancelledAt) <= atMs) continue;
    } else if (TERMINAL_STATUSES.has(row.status)) {
      continue; // Dead, date unknown: censor everywhere.
    }
    if (row.status === "PAUSED") {
      const pausedUntilMs =
        row.pausedUntil != null ? toTime(row.pausedUntil) : null;
      // Paused at `now` for certain (that is what the status says, even when
      // pausedUntil is overdue); beyond pausedUntil assume it resumed.
      const verifiablyPaused =
        atMs >= nowMs &&
        (pausedUntilMs == null || atMs <= Math.max(pausedUntilMs, nowMs));
      if (verifiablyPaused) continue;
    }
    count++;
  }
  return count;
}

// ───────────────────── Forecast week aggregation ────────────────────────────

export interface ForecastRowLike {
  weekStart: string;
  revenueCents: number;
  marginCents: number;
  probabilityAdjustedUnits: number;
  expectedAddOnUnits: number;
}

export interface ForecastWeekPoint {
  weekStart: string;
  revenueCents: number;
  marginCents: number;
  units: number;
}

/** Tolerate both snapshot rowsJson shapes: `[rows]` (V1) and `{meta, rows}` (V2). */
export function extractForecastRows(parsed: unknown): ForecastRowLike[] {
  if (Array.isArray(parsed)) return parsed as ForecastRowLike[];
  if (
    parsed != null &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    return (parsed as { rows: ForecastRowLike[] }).rows;
  }
  return [];
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * PURE — aggregate forecast rows into one point per week over a DENSE axis
 * covering the full horizon. Weeks in which nothing bills appear as zeros
 * instead of vanishing — the old sparse axis showed a monthly-cadence shop
 * as 3-4 adjacent full-revenue points, reading as that revenue EVERY week.
 * `computedAt` reproduces the job's week 0 (both are Monday-of-UTC-week).
 */
export function aggregateForecastWeeks(
  rows: readonly ForecastRowLike[],
  computedAt: Date,
  horizonWeeks: number,
): ForecastWeekPoint[] {
  const byWeek = new Map<
    string,
    { revenueCents: number; marginCents: number; units: number }
  >();
  const week0 = startOfWeek(computedAt);
  for (let i = 0; i < Math.max(0, Math.floor(horizonWeeks)); i++) {
    byWeek.set(isoDate(addWeeks(week0, i)), {
      revenueCents: 0,
      marginCents: 0,
      units: 0,
    });
  }
  for (const row of rows) {
    if (typeof row.weekStart !== "string" || row.weekStart.length === 0) {
      continue;
    }
    const acc = byWeek.get(row.weekStart) ?? {
      revenueCents: 0,
      marginCents: 0,
      units: 0,
    };
    acc.revenueCents += finite(row.revenueCents);
    acc.marginCents += finite(row.marginCents);
    acc.units +=
      finite(row.probabilityAdjustedUnits) + finite(row.expectedAddOnUnits);
    byWeek.set(row.weekStart, acc);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, v]) => ({
      weekStart,
      revenueCents: v.revenueCents,
      marginCents: v.marginCents,
      units: Math.round(v.units * 10) / 10,
    }));
}

// ───────────────────────── Survival guard ──────────────────────────────────

/**
 * PURE — keep only survival checkpoints that were actually measurable
 * (eligible > 0). A checkpoint nobody is old enough for is 0/0; rendering
 * it as "0% remaining" told young shops every plan dies. Returns null when
 * no checkpoint is measurable so callers can show a "not enough data yet"
 * state instead of a curve.
 */
export function measurableSurvival<
  P extends { eligible: number },
  C extends { points: P[] },
>(curve: C | null | undefined): C | null {
  if (!curve) return null;
  const points = curve.points.filter((p) => p.eligible > 0);
  if (points.length === 0) return null;
  return { ...curve, points };
}
