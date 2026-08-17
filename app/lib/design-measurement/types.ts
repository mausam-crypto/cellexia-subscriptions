import type { DesignPeriod, DesignPreselect } from "./shared";

/**
 * Design measurement scoreboard — the pure types + the one pure statistic
 * (v1.26.0; visits, conversion, comparison and the guardrail basis added in
 * v1.27.0). This file has NO server imports on purpose: the Results tab
 * component (app/components/design-results.tsx) imports the Scoreboard
 * shapes and `probabilityBetterThan` from here, so a client bundle never
 * drags prisma / settings / cohorts into the browser. scoreboard.server.ts
 * re-exports everything so server callers keep one import path.
 */

// ── Query ────────────────────────────────────────────────────────────────────

export type ScoreboardGroupBy = "variant" | "design" | "revision";

export interface ScoreboardQuery {
  shopId: string;
  /** Trailing window in days; null = since designMeasurement.startedAt, or all time when unset. */
  rangeDays: number | null;
  /** Shopify market handle to restrict to; null = every market. */
  marketHandle: string | null;
  groupBy: ScoreboardGroupBy;
  /** Injectable clock (tests); defaults to new Date(). Not part of the cache key. */
  now?: Date;
  /** Bypass the 10-minute module cache. Not part of the cache key. */
  fresh?: boolean;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/**
 * Orders old enough for the horizon, how many of them subscribed, and how
 * many of those subscribers were still live at it. All three counts ride
 * along so the UI can print the exact fraction behind the percentage
 * (heldSubscribed of matureSubscribed) next to the population that had the
 * chance to mature (matureOrders); a "no subscribers yet" state
 * (matureOrders > 0, matureSubscribed = 0) is distinguishable from "not yet"
 * (matureOrders = 0).
 */
export interface MaturedRate {
  matureOrders: number;
  /** Subscribed orders among matureOrders: the denominator of pct. */
  matureSubscribed: number;
  heldSubscribed: number;
  /** heldSubscribed ÷ matureSubscribed × 100 (1 decimal); null when no matured subscribed order yet. */
  pct: number | null;
}

export type ScoreboardGrade = "too_early" | "direction_only" | "usable";

export interface WeeklyBucket {
  /** ISO week in the shop timezone, e.g. "2026-W35" (Monday-start). */
  week: string;
  orders: number;
  subscribed: number;
  oneTime: number;
  /**
   * Visitors (one per visitor per shop-tz day per design × preselect) whose
   * visit day fell in this week (v1.27.0). 0 when the shop has no visit rows
   * at all: read `VariantRow.visits === null` to tell "not recorded" from
   * "recorded, none this week".
   */
  visits: number;
}

// ── Visits (v1.27.0: storefront beacon → WidgetVisitorDay) ──────────────────

/**
 * Exposed visits joined onto a row by the SAME stamp the facts carry
 * (design key + preselect for variant grouping, design key for design
 * grouping, the calendar's revision for revision grouping), summed over the
 * range. `visits` = visitor-days (a shopper counted once per shop-tz day per
 * design × preselect), `views` = page views with the widget on screen,
 * `engaged` = visitor-days with an interaction, `addedToCart` /
 * `addedSubscription` = visitor-days that added our product (with the
 * subscription option).
 */
export interface VisitCounts {
  visits: number;
  views: number;
  engaged: number;
  addedToCart: number;
  addedSubscription: number;
}

/**
 * Per-row conversion, every rate over EXPOSED visits with the same stamp as
 * the numerator (so a design that only ever ran in one market is compared on
 * its own traffic, never on the store's). The per-100-visits rates keep 2
 * decimals (they are small numbers: 0.26 vs 0.34 kept subscribers per 100
 * visits is a 31% difference that 1 decimal would erase); the two share
 * percentages keep 1 decimal like every other pct on the row. null when the
 * denominator is 0 or visits are not recorded (VariantRow.visits null).
 *
 * TIME ALIGNMENT: the beacon usually starts recording after the first order
 * (deployed mid-range), so the numerators are NOT the row's whole-range
 * orders: only orders processed on a shop-tz day on which the SHOP recorded
 * at least one visit row (any design, any market) count, so both sides of
 * every ratio cover the same days. The counted numerators ride along
 * (ordersCounted, subscribedCounted, keptCounted) with the matured-visits
 * denominator and the first covered day, so the UI can print "N orders since
 * <day>" next to the rate and the merchant can reconcile the row with the
 * weekly table.
 */
export interface ConversionBlock {
  /** ordersCounted ÷ visits × 100 (2 decimals). */
  ordersPer100Visits: number | null;
  /** subscribedCounted ÷ visits × 100 (2 decimals). */
  subscriptionsPer100Visits: number | null;
  /**
   * keptCounted ÷ maturedVisits × 100 (2 decimals): the one number that
   * combines conversion and net take rate. Both sides mature on the SAME
   * day-based rule (the whole shop-tz day must be at least 30 days old: day
   * end + 30 days ≤ now), so the orders of the day exactly 30 days ago never
   * enter the numerator while that day's visits are still outside the
   * denominator. Dividing matured subscribers by ALL visits in range would
   * read low for any design still collecting traffic. null until at least
   * one visit day has matured.
   */
  keptSubscribersPer100VisitsD30: number | null;
  /** addedToCart ÷ visits × 100 (1 decimal; visitor-days that added our product). */
  addToCartPct: number | null;
  /** addedSubscription ÷ addedToCart × 100 (1 decimal): of those who added, the share that picked the subscription. */
  subscriptionPickPct: number | null;
  /** Orders of this row on days with visit coverage: the numerator of ordersPer100Visits. 0 when visits are not recorded. */
  ordersCounted: number;
  /** Subscribed orders of this row on days with visit coverage: the numerator of subscriptionsPer100Visits. */
  subscribedCounted: number;
  /**
   * Subscribed orders on covered days whose day has matured 30 days (day
   * end + 30 days ≤ now) and whose contract was still live 30 days after the
   * order: the numerator of keptSubscribersPer100VisitsD30. Differs from
   * held.d30.heldSubscribed, which matures by the order INSTANT.
   */
  keptCounted: number;
  /** Visits of this row on days matured for the 30-day horizon: the denominator of keptSubscribersPer100VisitsD30. */
  maturedVisits: number;
  /** First shop-tz day in range on which the shop recorded a visit row ("YYYY-MM-DD"); null when none. */
  firstVisitDay: string | null;
}

export interface VariantHygiene {
  promo: number;
  mixed: number;
  transition: number;
  noExposure: number;
  /** Orders that ALSO carried another app's selling plan (ownership "mixed"), plus foreign-only orders keyed to this design (excluded from the counts). */
  foreignPlan: number;
  /** Staff / test-buyer orders keyed to this design (excluded from every count). */
  staffExcluded: number;
  /** Orders whose stamped design disagrees with what the design calendar said was live. */
  calendarDisagree: number;
}

export interface VariantRow {
  /** "subscription_max|sub" (variant), "subscription_max" (design), revisionId (revision), or the synthetic "no_exposure" / "unknown". */
  key: string;
  designKey: string | null;
  /** "sub" | "one" | null (unknown). Kept as string for forward compatibility. */
  preselect: string | null;
  revisionId?: string | null;
  /** Display label, e.g. "Subscription max · sub preselected". */
  label: string;
  orders: number;
  subscribed: number;
  oneTime: number;
  /** subscribed ÷ orders × 100 (1 decimal); null when orders = 0. */
  takeRatePct: number | null;
  held: { d30: MaturedRate; d60: MaturedRate; d90: MaturedRate };
  quickCancel14: { matureSubscribed: number; cancelled: number; pct: number | null };
  /** Cents per subscriber at each horizon (matured cohorts only, cohort engine); null when no contract. */
  ltgp: {
    m3: number | null;
    m6: number | null;
    m12: number | null;
    contracts: number;
  } | null;
  /** <30 orders too_early, <200 direction_only, else usable. */
  grade: ScoreboardGrade;
  /** One entry per week of Scoreboard.weeks (zeros included) so tables align. */
  weekly: WeeklyBucket[];
  hygiene: VariantHygiene;
  /** Mean order total in cents over orders with a known total; null when none. */
  aovCents: number | null;
  /**
   * Visits with this row's stamp (v1.27.0). null when the shop has NO visit
   * rows in range at all (beacon not deployed yet, app embed disabled, or
   * revision grouping without a usable ledger): the UI says "visits not
   * recorded yet". Synthetic rows (no_exposure / unknown) are always null:
   * a visit always carries a design stamp, so nothing can join them. A real
   * row with no matching visits while the shop records some (another design,
   * or another market when a market filter is set) gets zeros, not null:
   * ScoreboardTotals.visitsRecorded is the presence fact behind the choice.
   */
  visits: VisitCounts | null;
  /** Conversion over this row's visits; every field null when visits are null. */
  conversion: ConversionBlock;
}

// ── Scoreboard ───────────────────────────────────────────────────────────────

export type GuardrailStatus = "ok" | "watch" | "breach" | "insufficient";

/**
 * What a guardrail verdict was judged on (v1.27.0). "orders": weekly raw
 * orders (the v1.26.0 rule, always present per real row). "conversion":
 * weekly orders per 100 visits, the SAME rule on a traffic-normalised
 * series; present only when both the reference and the row have visits in
 * at least 2 qualifying weeks, and then it is the primary verdict (a design
 * that gets less traffic is no longer read as "orders dropped").
 */
export type GuardrailBasis = "orders" | "conversion";

export interface GuardrailVerdict {
  key: string;
  status: GuardrailStatus;
  /** Plain-English explanation of the verdict (numbers included). */
  detail: string;
  basis: GuardrailBasis;
}

/**
 * One design compared with the reference (the row with most orders), the
 * v1.27.0 "Compare against the reference" card. Deltas are row minus
 * reference in percentage points, computed from the UNROUNDED ratios (the
 * raw counts on the rows) and rounded once to 2 decimals, so two rows that
 * both display as "0.3 per 100" can still show their real 0.08-point gap;
 * null when either side has no denominator. `chance` is
 * probabilityBetterThan over the raw counts (row vs reference; null when
 * either side has no denominator); the conversion chance uses the
 * time-aligned ordersCounted, not the whole-range orders. The reference row
 * itself is not listed; synthetic rows are never listed.
 */
export interface ScoreboardComparison {
  key: string;
  vsKey: string;
  deltas: {
    conversionPts: number | null;
    subscriptionConversionPts: number | null;
    takeRatePts: number | null;
    kept30Pts: number | null;
    keptPer100VisitsD30: number | null;
  };
  chance: {
    /** P(row orders-per-visit > reference), from (orders, visits). */
    conversion: number | null;
    /** P(row take rate > reference), from (subscribed, orders). */
    takeRate: number | null;
    /** P(row kept-30d rate > reference), from (heldSubscribed, matureSubscribed) at 30 days. */
    kept30: number | null;
  };
}

export interface ConversionWeek {
  week: string;
  /** Product-page sessions typed in by the merchant (designMeasurement.weeklySessions); null when not entered. */
  sessions: number | null;
  orders: number;
  subscribed: number;
  conversionPct: number | null;
  subscriptionConversionPct: number | null;
  /** The design row with the most orders that week; null when the week has no design-attributed order. */
  dominantKey: string | null;
}

export interface ScoreboardMarket {
  handle: string;
  name: string | null;
  orders: number;
}

export interface ScoreboardTotals {
  orders: number;
  subscribed: number;
  excludedStaff: number;
  excludedForeignOnly: number;
  noExposure: number;
  /** Subscribed orders with no design stamped at all. */
  unattributedSubscribed: number;
  /** Rows whose design came from the storefront `_cellexia_seen` property ÷ rows × 100; null when no rows. */
  seenCoveragePct: number | null;
  /**
   * Among rows whose design came from the STOREFRONT (designSource "seen" or
   * "design_prop") and that also have a calendar design: share that agree;
   * null when none. Calendar-sourced rows are excluded on purpose: their
   * design IS the calendar's, so they would agree by construction and
   * inflate the one metric meant to validate the storefront stamp.
   */
  calendarAgreementPct: number | null;
  /** Visitor-days recorded in range (every stamp, market-scoped like the rows); 0 when none (v1.27.0). */
  visits: number;
  /**
   * Whether the SHOP recorded at least one visit row in range, regardless of
   * the market filter (a cheap unscoped presence check). false means the
   * beacon has not landed anything yet (not deployed, app embed disabled)
   * and every row reads visits null; true with a market-scoped `visits` of 0
   * means the beacon works but no visit mapped onto that market (country
   * not in the market map yet), and the rows read zeros. The UI tells the
   * two apart with this flag, never with `visits` alone.
   */
  visitsRecorded: boolean;
  /**
   * Visitor-days recorded in range across EVERY market (the unscoped count
   * behind visitsRecorded); equals `visits` when no market filter is set;
   * null when the unscoped read was unavailable.
   */
  visitsUnscoped: number | null;
  /**
   * Days in range with at least one visit row (shop-wide, not market-scoped:
   * "was the beacon live that day" is a property of the shop) ÷ days in
   * range, as a fraction 0..1 (3 decimals). A low value on a live store means
   * the beacon only recently started (or was blocked part of the time). The
   * same covered-day set gates the conversion numerators (ConversionBlock).
   * 0 when no visits.
   */
  visitCoverageDays: number;
  /** The two counts behind visitCoverageDays, for a "N of M days" line. */
  visitDaysCovered?: number;
  visitDaysInRange?: number;
  /** ISO instant of the most recent visit row on the shop (any range); null when none or unavailable. */
  lastVisitAt: string | null;
}

export interface Scoreboard {
  computedAt: string;
  cached: boolean;
  rangeDays: number | null;
  startedAt: string | null;
  marketHandle: string | null;
  groupBy: string;
  totals: ScoreboardTotals;
  /** Sorted by orders desc. */
  rows: VariantRow[];
  /** Ordered ISO weeks (shop timezone) covering the range, oldest first. */
  weeks: string[];
  guardrail: {
    maxOrderDropPct: number;
    minOrdersPerWeek: number;
    /**
     * Per real row: the "orders" verdict always, preceded by a "conversion"
     * verdict when both the row and the reference have visits in ≥ 2
     * qualifying weeks (v1.27.0). Filter on `basis` to pick one.
     */
    verdicts: GuardrailVerdict[];
  };
  conversion: ConversionWeek[];
  /** Every non-reference real row vs the reference (v1.27.0); [] with fewer than 2 real rows. */
  comparison: ScoreboardComparison[];
  /** Design calendar periods (newest first, capped 200); [] when the ledger is unavailable. */
  calendar: DesignPeriod[];
  markets: ScoreboardMarket[];
}

/** Re-exported so client code can narrow preselect values without importing shared.ts directly. */
export type ScoreboardPreselect = DesignPreselect;

// ── The one pure statistic ───────────────────────────────────────────────────

/**
 * Lanczos approximation of ln Γ(x) for x > 0 (g = 7, n = 9 — the standard
 * double-precision coefficients). Used only to normalise Beta densities so
 * that large counts (thousands of orders) never overflow a direct Γ product.
 */
function lnGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection keeps the recursion in the well-conditioned half-plane.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function sanitizeCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/** ln B(a, b) = ln Γ(a) + ln Γ(b) − ln Γ(a + b), for a, b > 0. */
function lnBeta(a: number, b: number): number {
  return lnGamma(a) + lnGamma(b) - lnGamma(a + b);
}

/**
 * Exact P(pB > pA) for pA ~ Beta(alphaA, betaA), pB ~ Beta(alphaB, betaB)
 * with integer alphaB (always true here: alpha = 1 + successes):
 *
 *   Σ_{i=0}^{alphaB−1} B(alphaA+i, betaA+betaB) / ((betaB+i) · B(1+i, betaB) · B(alphaA, betaA))
 *
 * Every term is evaluated in log space (lnBeta) so thousands of orders never
 * overflow, and the terms are all positive so the sum has no cancellation.
 */
function betaWinProbability(
  alphaA: number,
  betaA: number,
  alphaB: number,
  betaB: number,
): number {
  const lnBetaA = lnBeta(alphaA, betaA);
  let total = 0;
  for (let i = 0; i < alphaB; i++) {
    total += Math.exp(
      lnBeta(alphaA + i, betaA + betaB) -
        Math.log(betaB + i) -
        lnBeta(1 + i, betaB) -
        lnBetaA,
    );
  }
  return total;
}

/**
 * Probability that B's underlying rate exceeds A's, with flat Beta(1,1)
 * priors on both: pA ~ Beta(1+aS, 1+aF), pB ~ Beta(1+bS, 1+bF), and
 * P(pB > pA) = ∫ pdfB(x) · cdfA(x) dx over [0,1].
 *
 * Computed with the EXACT closed form (betaWinProbability) rather than a
 * grid quadrature: an earlier draft integrated both densities on one shared
 * uniform grid, and when one posterior was very peaked (thousands of orders)
 * next to a wide one it got only a handful of points under its mass, so a
 * certain winner could print 88% and P(A>B) + P(B>A) drifted away from 1.
 * The closed form loops over the SMALLER alpha (swapping roles and returning
 * 1 − result when A's is the smaller one), so cost is min(successes) terms
 * and the two mirrored calls are computed from the identical sum, which
 * makes them add up to exactly 1 (ties have measure zero).
 *
 * Returns a value in [0, 1]; equal evidence returns 0.5, no evidence at all
 * (both totals 0) returns 0.5. This is the "chance it beats the reference"
 * column: an honest, prior-flat comparison that a merchant reads as a
 * percentage without needing p-values. Successes greater than totals are
 * clamped (a defensive guard, not a valid input), negatives / NaN count as
 * zero.
 */
export function probabilityBetterThan(
  aSuccess: number,
  aTotal: number,
  bSuccess: number,
  bTotal: number,
): number {
  const aT = sanitizeCount(aTotal);
  const bT = sanitizeCount(bTotal);
  const aS = Math.min(sanitizeCount(aSuccess), aT);
  const bS = Math.min(sanitizeCount(bSuccess), bT);

  const alphaA = 1 + aS;
  const betaA = 1 + (aT - aS);
  const alphaB = 1 + bS;
  const betaB = 1 + (bT - bS);

  // Both posteriors identical → exactly 1/2 by symmetry; skip the numerics.
  if (alphaA === alphaB && betaA === betaB) return 0.5;

  const result =
    alphaB <= alphaA
      ? betaWinProbability(alphaA, betaA, alphaB, betaB)
      : 1 - betaWinProbability(alphaB, betaB, alphaA, betaA);

  if (!Number.isFinite(result)) return 0.5;
  return Math.min(1, Math.max(0, result));
}
