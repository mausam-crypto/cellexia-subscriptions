import prisma from "~/db.server";
import { toZonedTime, format as formatTz } from "date-fns-tz";
import { subDays } from "date-fns";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { requireShopById } from "./queries.server";
import { getCostCoverage } from "./costs.server";
import { getForecast, type AccuracyGrade } from "./forecast.server";

/**
 * Rule-based, plain-language insights for the dashboard and analytics pages.
 *
 * Honesty contract:
 * - Every insight states its evidence (the actual numbers) in `detail`.
 * - Rules stay silent below minimum sample sizes instead of alarming on noise.
 * - `getInsights` returns [] on ANY error — insights are decoration, they must
 *   never take down a page (architecture rule 9: analytics failures are
 *   contained).
 *
 * NOTE: this module is intentionally NOT re-exported from
 * `analytics/index.server.ts` — import it directly. (Keeps the export-star
 * surface of the analytics barrel free of collisions.)
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Insight {
  tone: "positive" | "warning" | "neutral";
  headline: string;
  detail: string;
  actionLabel?: string;
  actionUrl?: string;
}

/** Pure inputs for `deriveInsights` — everything already aggregated. */
export interface InsightInputs {
  /** OURS, non-demo contracts of any status. */
  contractsTotal: number;
  /**
   * Daily rollup rows for the trailing 35 shop-tz days, oldest first. Missing
   * days simply don't appear; rules use sums over slices.
   */
  rollups: {
    churnedVoluntary: number;
    churnedInvoluntary: number;
    skips: number;
    takeRateNum: number;
    takeRateDen: number;
    /**
     * Completed bounded plans (status EXPIRED, expiredAt in day) — a SUBSET
     * of churnedVoluntary (the shared retention classification), supplied by
     * the wrapper so the two alarm rules can subtract scheduled completions:
     * a billingMaxCycles cohort finishing on schedule is churn nobody chose,
     * and must not read as a churn spike or a skip→cancel deterioration.
     * Optional: absent means "no expiry split available" (treated as 0).
     */
    expiredInDay?: number;
  }[];
  /** Whole weeks of rollup history available (0 for a brand-new store). */
  rollupWeeks: number;
  /** Dunning cases resolved in the last 30 days. */
  dunning30d: { resolved: number; recovered: number };
  /** Cancel-flow sessions decided (SAVED or CANCELLED) in the last 30 days. */
  saves30d: { decided: number; saved: number };
  /** Distilled from analytics/costs.server getCostCoverage. */
  costCoverage: {
    /** Non-gift lines on countable ACTIVE/PAUSED contracts. */
    totalLines: number;
    linesMissingCost: number;
    /** 0–100 share of lines with a KNOWN (non-estimated) cost. */
    coveragePct: number;
    /** Distinct products/variants with no known cost. */
    productsMissingCost: number;
  };
  /** Forecast accuracy grade when the engine provides one; null when unknown. */
  forecastGrade?: "A" | "B" | "C" | "D" | null;
}

// ── Thresholds (playbook targets) ─────────────────────────────────────────────

const CHURN_SPIKE_MIN = 3; // ignore spikes smaller than this many cancels/week
const CHURN_SPIKE_FACTOR = 2; // last week ≥ 2× the 4-week baseline
const DUNNING_MIN_RESOLVED = 5;
const DUNNING_LOW = 0.55;
const DUNNING_GREAT = 0.7;
const SAVE_MIN_DECIDED = 10;
const SAVE_BAND_LOW = 0.2;
const SAVE_BAND_HIGH = 0.3;
const COST_COVERAGE_WARN_PCT = 80;
const TAKE_RATE_MIN_DEN = 20; // checkouts per week before WoW moves are signal
const TAKE_RATE_MOVE_PTS = 2;
const SKIP_RATIO_MIN_CANCELS = 3;
const SKIP_RATIO_DETERIORATION = 0.6; // now < 60% of previous fortnight
const FORECAST_MATURITY_WEEKS = 6;
const MAX_INSIGHTS = 5;

// ── Pure rule engine (unit-testable, no I/O) ──────────────────────────────────

function safeDiv(num: number, den: number): number | null {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const q = num / den;
  return Number.isFinite(q) ? q : null;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

/**
 * Turn aggregated numbers into at most 5 priority-ordered insights. Pure —
 * all data access lives in `getInsights`.
 */
export function deriveInsights(input: InsightInputs): Insight[] {
  // Zero-data welcome: nothing else is computable, say so and stop.
  if (input.contractsTotal === 0) {
    return [
      {
        tone: "neutral",
        headline: "Welcome — no subscribers yet",
        detail:
          "No subscription contracts exist yet, so every metric below is empty. " +
          "Create a subscription plan and the analytics fill in from the first signup.",
        actionLabel: "Create a plan",
        actionUrl: "/app/plans",
      },
    ];
  }

  const out: Insight[] = [];
  const rollups = input.rollups;
  const last7 = rollups.slice(-7);
  const prior28 = rollups.slice(-35, -7);
  const last14 = rollups.slice(-14);
  const prior14 = rollups.slice(-28, -14);
  const sum = (
    rows: typeof rollups,
    key: Exclude<keyof (typeof rollups)[number], "expiredInDay">,
  ) =>
    rows.reduce((total, r) => total + (Number.isFinite(r[key]) ? r[key] : 0), 0);
  // Voluntary churn somebody CHOSE: the rollup column minus that day's
  // scheduled bounded-plan completions (see the expiredInDay doc above).
  // The retention surfaces keep classifying EXPIRED as voluntary churn —
  // this subtraction is scoped to the two ALARM rules (1 and 6), which
  // diagnose behavior ("review save offers", "cancelling instead of
  // skipping") that a completion on schedule says nothing about. Clamped
  // defensively; by construction expiredInDay ⊆ churnedVoluntary.
  const chosenVoluntary = (rows: typeof rollups) =>
    rows.reduce(
      (total, r) =>
        total +
        Math.max(
          0,
          (Number.isFinite(r.churnedVoluntary) ? r.churnedVoluntary : 0) -
            (r.expiredInDay ?? 0),
        ),
      0,
    );

  // 1) Churn spike vs the 4-week baseline. Uses the voluntary+involuntary
  // columns (consolidation-merge SYSTEM cancels are excluded by the rollup;
  // scheduled expiries are subtracted — churn nobody chose cannot spike).
  const churnNowVol = chosenVoluntary(last7);
  const churnNowInv = sum(last7, "churnedInvoluntary");
  const churnNow = churnNowVol + churnNowInv;
  const churnBaseWeekly =
    prior28.length > 0
      ? ((chosenVoluntary(prior28) + sum(prior28, "churnedInvoluntary")) /
          prior28.length) *
        7
      : 0;
  const spiked =
    churnNow >= CHURN_SPIKE_MIN &&
    (churnBaseWeekly > 0
      ? churnNow >= CHURN_SPIKE_FACTOR * churnBaseWeekly
      : churnNow >= CHURN_SPIKE_MIN + 2);
  if (spiked) {
    const involuntaryLed = churnNowInv > churnNowVol;
    out.push({
      tone: "warning",
      headline: "Churn spiked this week",
      detail:
        `${churnNow} subscribers churned in the last 7 days vs a weekly average of ` +
        `${Math.round(churnBaseWeekly * 10) / 10} over the previous 4 weeks ` +
        `(${churnNowVol} voluntary, ${churnNowInv} from failed payments).`,
      actionLabel: involuntaryLed ? "Review dunning" : "Review save offers",
      actionUrl: involuntaryLed ? "/app/dunning" : "/app/cancel-flow",
    });
  }

  // 2) Dunning recovery rate vs the 55–70% playbook band.
  const dunningRate = safeDiv(input.dunning30d.recovered, input.dunning30d.resolved);
  if (input.dunning30d.resolved >= DUNNING_MIN_RESOLVED && dunningRate != null) {
    if (dunningRate < DUNNING_LOW) {
      out.push({
        tone: "warning",
        headline: "Dunning recovery is below target",
        detail:
          `Only ${input.dunning30d.recovered} of ${input.dunning30d.resolved} failed-payment ` +
          `cases closed in the last 30 days were recovered (${pct(dunningRate)}; healthy is 55–70%).`,
        actionLabel: "Review dunning settings",
        actionUrl: "/app/dunning",
      });
    } else if (dunningRate >= DUNNING_GREAT) {
      out.push({
        tone: "positive",
        headline: "Dunning is recovering strongly",
        detail:
          `${input.dunning30d.recovered} of ${input.dunning30d.resolved} failed-payment cases ` +
          `closed in the last 30 days were recovered (${pct(dunningRate)}, above the 55–70% target band).`,
      });
    }
  }

  // 3) Cancel-flow save rate vs the 20–30% band.
  const saveRate = safeDiv(input.saves30d.saved, input.saves30d.decided);
  if (input.saves30d.decided >= SAVE_MIN_DECIDED && saveRate != null) {
    if (saveRate < SAVE_BAND_LOW) {
      out.push({
        tone: "warning",
        headline: "Save offers are underperforming",
        detail:
          `${input.saves30d.saved} of ${input.saves30d.decided} cancel-flow sessions in the ` +
          `last 30 days ended in a save (${pct(saveRate)}; the target band is 20–30%).`,
        actionLabel: "Tune the cancel flow",
        actionUrl: "/app/cancel-flow",
      });
    } else if (saveRate > SAVE_BAND_HIGH) {
      out.push({
        tone: "neutral",
        headline: "Save rate is above the target band",
        detail:
          `${input.saves30d.saved} of ${input.saves30d.decided} cancel-flow sessions in the ` +
          `last 30 days were saved (${pct(saveRate)}, above the 20–30% band). Strong — but check ` +
          `you are not giving away more discount than the retained revenue is worth.`,
        actionLabel: "Review offers",
        actionUrl: "/app/cancel-flow",
      });
    }
  }

  // 4) COGS coverage — the LTGP honesty flag.
  if (
    input.costCoverage.totalLines > 0 &&
    input.costCoverage.coveragePct < COST_COVERAGE_WARN_PCT
  ) {
    out.push({
      tone: "warning",
      headline: "Your margins are partly estimated — set product costs",
      detail:
        `${input.costCoverage.linesMissingCost} of ${input.costCoverage.totalLines} subscription ` +
        `lines (${input.costCoverage.productsMissingCost} products) have no known unit cost, so their ` +
        `COGS is only estimated and LTGP is approximate. Set costs on the Plans page, or as ` +
        `"Cost per item" on the product in Shopify.`,
      actionLabel: "Set product costs",
      actionUrl: "/app/plans",
    });
  }

  // 5) Take-rate week-over-week move > 2 points.
  const nowNum = sum(last7, "takeRateNum");
  const nowDen = sum(last7, "takeRateDen");
  const prevNum = sum(rollups.slice(-14, -7), "takeRateNum");
  const prevDen = sum(rollups.slice(-14, -7), "takeRateDen");
  if (nowDen >= TAKE_RATE_MIN_DEN && prevDen >= TAKE_RATE_MIN_DEN) {
    const nowRate = safeDiv(nowNum, nowDen);
    const prevRate = safeDiv(prevNum, prevDen);
    if (nowRate != null && prevRate != null) {
      const movePts = (nowRate - prevRate) * 100;
      if (Math.abs(movePts) > TAKE_RATE_MOVE_PTS) {
        const up = movePts > 0;
        out.push({
          tone: up ? "positive" : "warning",
          headline: up ? "Subscription take rate is climbing" : "Subscription take rate dropped",
          detail:
            `${pct(nowRate)} of subscribable checkouts chose the subscription this week ` +
            `(${nowNum}/${nowDen}) vs ${pct(prevRate)} last week (${prevNum}/${prevDen}) — ` +
            `a ${Math.round(Math.abs(movePts) * 10) / 10}-point ${up ? "gain" : "fall"}.`,
          actionLabel: up ? undefined : "Check the buy box",
          actionUrl: up ? undefined : "/app/buy-box",
        });
      }
    }
  }

  // 6) Skip:cancel ratio deteriorating (skips are the healthy pressure valve).
  // Uses the churn columns like rule 1, NOT the raw `cancels` column: that
  // one counts every cancelledAt-in-day contract including consolidation
  // merges (reason MERGED, cancelSource SYSTEM — the customer stayed), so a
  // single dedupe batch could deflate the ratio and fire this warning on
  // churn that never happened. The churn columns exclude SYSTEM/null-source
  // cancels by construction — and scheduled expiries are subtracted too: a
  // bounded plan completing on schedule is not "cancelling instead of
  // skipping".
  const cancelsNow = chosenVoluntary(last14) + sum(last14, "churnedInvoluntary");
  const cancelsPrev =
    chosenVoluntary(prior14) + sum(prior14, "churnedInvoluntary");
  if (cancelsNow >= SKIP_RATIO_MIN_CANCELS && cancelsPrev >= SKIP_RATIO_MIN_CANCELS) {
    const ratioNow = safeDiv(sum(last14, "skips"), cancelsNow);
    const ratioPrev = safeDiv(sum(prior14, "skips"), cancelsPrev);
    if (
      ratioNow != null &&
      ratioPrev != null &&
      ratioPrev > 0 &&
      ratioNow < SKIP_RATIO_DETERIORATION * ratioPrev
    ) {
      out.push({
        tone: "warning",
        headline: "Subscribers are cancelling instead of skipping",
        detail:
          `The skip-to-cancel ratio fell from ${Math.round(ratioPrev * 10) / 10}:1 to ` +
          `${Math.round(ratioNow * 10) / 10}:1 over the last two weeks — deliveries may be ` +
          `arriving faster than customers use the product. A longer default cadence can help.`,
        actionLabel: "Review plan cadence",
        actionUrl: "/app/plans",
      });
    }
  }

  // 7) Forecast maturity — the numbers firm up around week 6.
  if (input.forecastGrade === "D" || input.rollupWeeks < FORECAST_MATURITY_WEEKS) {
    out.push({
      tone: "neutral",
      headline: "Forecasts are still calibrating",
      detail:
        `Only ${input.rollupWeeks} week${input.rollupWeeks === 1 ? "" : "s"} of daily analytics ` +
        `history exists so far — projections firm up around ` +
        `week ${FORECAST_MATURITY_WEEKS}. Treat forecast numbers as rough until then.`,
    });
  }

  return out.slice(0, MAX_INSIGHTS);
}

// ── Data-fetching wrapper ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const ROLLUP_WINDOW_DAYS = 35;

/**
 * Fetch the aggregates and run the rule engine. Returns [] on any error —
 * never throws into a page loader.
 *
 * `opts.forecastGrade` feeds rule 7's grade-D leg. Callers that already run
 * getForecast in the same loader (both dashboards do, and both now chain
 * their own forecast promise in) should pass `forecast.accuracy.grade` to
 * skip the duplicate computation; pass null for "known unknown". When
 * omitted, the grade is computed here — without this self-service default
 * the grade-D leg was production-dead: the interface declared the input,
 * both loaders held the grade, and nothing ever passed it. The internal
 * fetch is failure-contained on its own — a broken forecast must degrade to
 * "no grade", never to zero insights.
 */
export async function getInsights(
  shopId: string,
  now: Date = new Date(),
  opts?: { forecastGrade?: AccuracyGrade | null },
): Promise<Insight[]> {
  try {
    const shop = await requireShopById(shopId);
    const tz = shop.ianaTimezone;

    // Rollup dates are shop-tz day LABELS (synthetic UTC midnights), so the
    // cutoff is derived in label space from the shop-tz "today" — not from the
    // raw UTC instant (which is off by one near midnight for Europe/Zurich).
    const todayKey = formatTz(toZonedTime(now, tz), "yyyy-MM-dd", { timeZone: tz });
    const todayLabel = new Date(`${todayKey}T00:00:00.000Z`);
    const rollupCutoff = new Date(todayLabel.getTime() - (ROLLUP_WINDOW_DAYS - 1) * DAY_MS);
    const cutoff30d = subDays(now, 30);

    const [
      contractsTotal,
      rollupRows,
      expiredContracts,
      firstRollup,
      dunningGroups,
      saveGroups,
      coverage,
      forecastGrade,
    ] = await Promise.all([
      prisma.subscriptionContract.count({
        where: { shopId, isDemo: false, ...OURS_ONLY },
      }),
      prisma.dailyRollup.findMany({
        where: { shopId, date: { gte: rollupCutoff } },
        orderBy: { date: "asc" },
        select: {
          date: true,
          churnedVoluntary: true,
          churnedInvoluntary: true,
          skips: true,
          takeRateNum: true,
          takeRateDen: true,
        },
      }),
      // Scheduled bounded-plan completions in the window: the rollup counts
      // them inside churnedVoluntary (the shared retention classification),
      // but the two alarm rules must subtract them (see expiredInDay on
      // InsightInputs). Fetched by instant with a day of slack and bucketed
      // into the same shop-tz labels the rollup rows carry — only instants
      // whose label matches a fetched row ever count.
      prisma.subscriptionContract.findMany({
        where: {
          shopId,
          isDemo: false,
          ...OURS_ONLY,
          status: "EXPIRED",
          expiredAt: { gte: subDays(now, ROLLUP_WINDOW_DAYS + 1) },
        },
        select: { expiredAt: true },
      }),
      prisma.dailyRollup.findFirst({
        where: { shopId },
        orderBy: { date: "asc" },
        select: { date: true },
      }),
      prisma.dunningCase.groupBy({
        by: ["resolution"],
        where: {
          contract: { shopId, isDemo: false, ...OURS_ONLY },
          resolvedAt: { gte: cutoff30d },
        },
        _count: { _all: true },
      }),
      prisma.cancelSession.groupBy({
        by: ["outcome"],
        where: {
          contract: { shopId, isDemo: false, ...OURS_ONLY },
          startedAt: { gte: cutoff30d },
          outcome: { in: ["SAVED", "CANCELLED"] },
        },
        _count: { _all: true },
      }),
      getCostCoverage(shopId),
      // See the doc block: supplied grade wins (including an explicit null);
      // otherwise compute it, contained to null on failure.
      opts?.forecastGrade !== undefined
        ? Promise.resolve(opts.forecastGrade)
        : getForecast(shopId, { now }).then(
            (forecast) => forecast.accuracy.grade,
            (): AccuracyGrade | null => null,
          ),
    ]);

    // Bucket expiries into the rollup rows' shop-tz day labels.
    const expiredByDay = new Map<string, number>();
    for (const c of expiredContracts) {
      if (!c.expiredAt) continue;
      const key = formatTz(toZonedTime(c.expiredAt, tz), "yyyy-MM-dd", {
        timeZone: tz,
      });
      expiredByDay.set(key, (expiredByDay.get(key) ?? 0) + 1);
    }
    const rollups = rollupRows.map(({ date, ...columns }) => ({
      ...columns,
      expiredInDay: expiredByDay.get(date.toISOString().slice(0, 10)) ?? 0,
    }));

    let resolved = 0;
    let recovered = 0;
    for (const g of dunningGroups) {
      if (!g.resolution) continue;
      resolved += g._count._all;
      if (g.resolution === "RECOVERED" || g.resolution === "CUSTOMER_FIXED") {
        recovered += g._count._all;
      }
    }

    let decided = 0;
    let saved = 0;
    for (const g of saveGroups) {
      decided += g._count._all;
      if (g.outcome === "SAVED") saved += g._count._all;
    }

    const rollupWeeks = firstRollup
      ? Math.max(
          0,
          Math.floor((todayLabel.getTime() - firstRollup.date.getTime()) / (7 * DAY_MS)) + 1,
        )
      : 0;

    const knownLines = Math.round(
      (coverage.linesWithKnownCogsPct / 100) * coverage.totalLines,
    );

    return deriveInsights({
      contractsTotal,
      rollups,
      rollupWeeks,
      dunning30d: { resolved, recovered },
      saves30d: { decided, saved },
      costCoverage: {
        totalLines: coverage.totalLines,
        linesMissingCost: Math.max(0, coverage.totalLines - knownLines),
        coveragePct: coverage.linesWithKnownCogsPct,
        productsMissingCost: coverage.productsMissingCogs.length,
      },
      forecastGrade,
    });
  } catch (error) {
    console.error("[insights] getInsights failed — returning no insights", error);
    return [];
  }
}
