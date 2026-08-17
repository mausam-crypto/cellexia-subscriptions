import prisma from "~/db.server";
import type { DunningState } from "@prisma/client";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { format, startOfMonth, startOfWeek, subDays, subWeeks } from "date-fns";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Dashboard / funnel query layer for the analytics module.
 *
 * All money values are integer cents. All "per month" normalization uses
 * WEEKS_PER_MONTH so weekly-cadence subscriptions convert to calendar-month
 * revenue consistently across the app.
 */

/** 52.14 weeks / 12 months — used to normalize weekly cadences to monthly revenue. */
export const WEEKS_PER_MONTH = 4.345;

/** 365.25 / 12 — used to normalize day cadences to monthly revenue. */
export const DAYS_PER_MONTH = 30.4375;

/**
 * How many billed cycles one calendar month contains for a contract, from the
 * EXACT mirrored Shopify billing policy (billingIntervalUnit/Count, synced
 * since v1.4.0). MONTH cadences convert exactly (1/n — a monthly 80.– plan is
 * 80.–/mo MRR, not ×4.345/4 ≈ 86.90), and DAY cadences no longer pay the
 * ceil(count/7) whole-week rounding (up to ~16% understatement).
 *
 * Rows mirrored before v1.4.0 carry a null unit until their next sync and
 * fall back to the historical intervalWeeks approximation — a slightly skewed
 * number, never a crash or a zero.
 */
export function cyclesPerMonth(contract: {
  billingIntervalUnit: string | null;
  billingIntervalCount: number | null;
  intervalWeeks: number;
}): number {
  const count = Math.max(1, contract.billingIntervalCount ?? 1);
  switch (contract.billingIntervalUnit) {
    case "MONTH":
      return 1 / count;
    case "YEAR":
      return 1 / (12 * count);
    case "WEEK":
      return WEEKS_PER_MONTH / count;
    case "DAY":
      return DAYS_PER_MONTH / count;
    default:
      return WEEKS_PER_MONTH / Math.max(1, contract.intervalWeeks);
  }
}

/**
 * The contract filter EVERY analytics aggregate must apply: only contracts we
 * own (never another subscription app's) and never the portal demo fixture.
 * Defined once and spread — `{ shopId, ...COUNTABLE_CONTRACT }` directly, or
 * `contract: { shopId, ...COUNTABLE_CONTRACT }` through a relation — so the
 * ownership filter and the demo filter can never diverge again.
 */
export const COUNTABLE_CONTRACT = { isDemo: false, ...OURS_ONLY } as const;

/** Dunning states that count as "open" (a case still being worked). */
export const OPEN_DUNNING_STATES: DunningState[] = [
  "OPEN",
  "RETRYING",
  "AWAITING_CUSTOMER",
  "AWAITING_3DS",
];

// ── Origin-order payment inclusion (migration 0006) ───────────────────────────

/** Contract shape needed to decide whether its origin payment enters revenue. */
export interface OriginPaymentContract {
  originOrderId: string | null;
  originOrderTotalCents: number | null;
  originOrderProcessedAt: Date | null;
  originOrderCurrencyCode: string | null;
}

/**
 * THE double-count guard for origin (checkout) payments — used by BOTH
 * revenue surfaces (rollup + cohorts), so the precedence rule cannot diverge.
 * Pure (exported for tests). Returns true when the contract's mirrored origin
 * payment may be added to revenue aggregates:
 *
 * - a total was captured (null = not captured yet — the backfill will);
 * - a processed instant exists (the booking day);
 * - currency guard: a foreign-presentment origin total is never summed into
 *   shop-currency figures (same rule as BillingAttempt amounts; a null
 *   currency passes — capture always writes one, this is legacy tolerance);
 * - PRECEDENCE: an origin order that ALSO produced a successful
 *   BillingAttempt row (should not exist, but nothing structurally prevents
 *   it) counts ONCE — the attempt wins and the origin mirror is skipped,
 *   because successful attempts are the established revenue path every other
 *   metric (refund netting, recovery, fees) already keys off.
 */
export function originPaymentCountsOnce(
  contract: OriginPaymentContract,
  successfulAttemptOrderIds: ReadonlySet<string>,
  shopCurrencyCode: string,
): boolean {
  if (contract.originOrderTotalCents == null) return false;
  if (contract.originOrderProcessedAt == null) return false;
  if (
    contract.originOrderCurrencyCode != null &&
    contract.originOrderCurrencyCode !== shopCurrencyCode
  ) {
    return false;
  }
  if (
    contract.originOrderId != null &&
    successfulAttemptOrderIds.has(contract.originOrderId)
  ) {
    return false; // the BillingAttempt already carries this money — count once
  }
  return true;
}

// ── Small shared helpers (used by rollup / cohorts / forecast) ────────────────

/** Load the Shop row (needed for its IANA timezone) or throw — analytics is meaningless without it. */
export async function requireShopById(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`[analytics] Shop not found: ${shopId}`);
  return shop;
}

/**
 * THE country of a contract for analytics purposes — VAT rate lookup and the
 * country segment dimension resolve it through this one helper so the two can
 * never disagree. Resolution: the CURRENT delivery address's countryCode
 * (mirrored from Shopify — where renewals ship today), falling back to the
 * acquisition capture's shipping country (acqCountryCode — where the FIRST
 * order shipped; survives for pickup contracts and pre-address mirrors), else
 * null ("unknown" — VAT falls back to the default rate, the segment surfaces
 * an explicit Unknown bucket). Uppercased, never trusted beyond a short
 * string (the address mirror is external input).
 */
export function contractTaxCountry(contract: {
  deliveryAddress: unknown;
  acqCountryCode: string | null;
}): string | null {
  const address = contract.deliveryAddress;
  if (address != null && typeof address === "object" && !Array.isArray(address)) {
    const code = (address as Record<string, unknown>).countryCode;
    if (typeof code === "string" && code.trim() !== "") {
      return code.trim().toUpperCase().slice(0, 8);
    }
  }
  if (contract.acqCountryCode && contract.acqCountryCode.trim() !== "") {
    return contract.acqCountryCode.trim().toUpperCase().slice(0, 8);
  }
  return null;
}

/**
 * Line shape needed for discount estimation. (COGS estimation moved to
 * app/lib/analytics/costs.server.ts — resolveLineCogs / perCycleLineCosts —
 * where merchant overrides and the cost-model fallback are applied.)
 */
export interface LineForCosting {
  quantity: number;
  currentPriceCents: number;
  compareAtPriceCents: number | null;
  isGift: boolean;
}

/**
 * Estimated discount given on one billed cycle:
 * Σ over non-gift lines of max(0, compareAtPriceCents − currentPriceCents) × quantity,
 * counting only lines where compareAtPriceCents is known. Gift lines are excluded
 * (they are zero-priced by design, not "discounted").
 */
export function perCycleDiscountCents(lines: LineForCosting[]): number {
  let total = 0;
  for (const line of lines) {
    if (line.isGift) continue;
    if (line.compareAtPriceCents == null) continue;
    const delta = line.compareAtPriceCents - line.currentPriceCents;
    if (delta > 0) total += delta * line.quantity;
  }
  return total;
}

/** "yyyy-MM-dd" key of the Monday starting the week containing `date`, in the shop timezone. */
export function shopWeekStartKey(date: Date, tz: string): string {
  const zoned = toZonedTime(date, tz);
  return format(startOfWeek(zoned, { weekStartsOn: 1 }), "yyyy-MM-dd");
}

/** "yyyy-MM-dd" of a date's UTC calendar day. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Synthetic UTC-midnight Date of the shop-tz calendar day containing `date` —
 * the label space DailyRollup.date lives in. Use this (never utcDayKey) when
 * comparing a real instant against rollup day keys, or range boundaries drift
 * by one day whenever shop-local time and UTC disagree on the date.
 */
export function shopDayLabelUtc(date: Date, tz: string): Date {
  return new Date(
    `${format(toZonedTime(date, tz), "yyyy-MM-dd")}T00:00:00.000Z`,
  );
}

/**
 * Week key for synthetic UTC-midnight day keys (DailyRollup.date). Pure UTC
 * arithmetic — rollup keys are labels, not instants, so shop-tz conversion
 * would shift them across day boundaries for negative-offset timezones.
 */
export function utcWeekStartKey(dayKey: Date): string {
  const dt = new Date(`${utcDayKey(dayKey)}T00:00:00.000Z`);
  const mondayOffset = (dt.getUTCDay() + 6) % 7; // Monday = 0
  return utcDayKey(new Date(dt.getTime() - mondayOffset * 86_400_000));
}

/**
 * MRR in cents.
 *
 * Formula: Σ over ACTIVE contracts of round(cycleTotalCents × cyclesPerMonth)
 * where cyclesPerMonth converts the contract's EXACT billing cadence to
 * calendar months (see cyclesPerMonth above; pre-v1.4.0 rows fall back to the
 * intervalWeeks approximation until their next sync) and cycleTotalCents =
 * Σ recurring lines (currentPriceCents × quantity, one-time add-ons excluded,
 * gift lines are zero-priced anyway) + deliveryPriceCents.
 *
 * Prepaid contracts: line prices are per delivery and the charge interval scales
 * with deliveries-per-charge, so the amortized monthly value reduces to the same
 * formula — no special-casing needed.
 *
 * Currency guard: integer cents are only additive within ONE currency, so
 * contracts whose currencyCode differs from the shop currency (Shopify Markets
 * presentment currencies, e.g. EUR contracts on a CHF shop) are EXCLUDED
 * rather than silently summed as if 1 EUR = 1 CHF. The excluded count is not
 * returned here (the headline stays a number); pass `shopCurrencyCode` when
 * the caller already loaded the shop to save a query.
 *
 * `opts.contractIds` (segment layer) restricts the ACTIVE population to those
 * ids on top of the ownership/demo filter — narrowing only, never widening.
 */
export async function computeMrrCents(
  shopId: string,
  shopCurrencyCode?: string,
  opts: { contractIds?: readonly string[] | null } = {},
): Promise<number> {
  const currency =
    shopCurrencyCode ?? (await requireShopById(shopId)).currencyCode;
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      ...COUNTABLE_CONTRACT,
      ...(opts.contractIds != null
        ? { id: { in: [...opts.contractIds] } }
        : {}),
    },
    select: {
      intervalWeeks: true,
      billingIntervalUnit: true,
      billingIntervalCount: true,
      deliveryPriceCents: true,
      currencyCode: true,
      lines: {
        select: { quantity: true, currentPriceCents: true, isOneTimeAddon: true },
      },
    },
  });

  let mrr = 0;
  for (const contract of contracts) {
    if (contract.currencyCode !== currency) continue; // never mix currencies
    const cycleTotal =
      contract.lines
        .filter((l) => !l.isOneTimeAddon)
        .reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0) +
      contract.deliveryPriceCents;
    mrr += Math.round(cycleTotal * cyclesPerMonth(contract));
  }
  return mrr;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface DashboardStats {
  activeSubscribers: number;
  pausedCount: number;
  mrrCents: number;
  /** Open dunning cases (OPEN / RETRYING / AWAITING_CUSTOMER / AWAITING_3DS). */
  failedQueueCount: number;
  /** Unresolved Alert rows. */
  openAlerts: number;
  /** Last 12 shop-timezone weeks (oldest first), parallel arrays. */
  newVsChurnedByWeek: {
    weeks: string[]; // "yyyy-MM-dd" Monday keys
    newSubscribers: number[];
    churned: number[];
  };
  /**
   * Σ DunningCase.recoveredCents over cases resolved this shop-tz calendar
   * month that carry money (recoveredCents non-null) — THE "recovered"
   * definition, shared with DailyRollup.recoveredCents: money actually
   * collected on a case that had a failure, regardless of resolution kind.
   * The engine stamps recoveredCents on RECOVERED and on same-cycle
   * CUSTOMER_FIXED (e.g. a 3DS challenge the customer completes on attempt
   * #1 — real money), and null on cross-cycle CUSTOMER_FIXED closes.
   * Currency-guarded through the recovering attempt, like every other
   * shop-currency aggregate.
   */
  recoveredThisMonthCents: number;
}

/**
 * Headline dashboard numbers. All counts are live snapshots; the weekly
 * new-vs-churned series buckets contract arrival / cancelledAt into
 * shop-timezone ISO weeks (Monday start).
 *
 * "Arrival" is firstChargeAt ?? createdAt — createdAt is the LOCAL MIRROR
 * creation instant, so a bulk import/backfill of pre-existing contracts would
 * otherwise register hundreds of fake "new subscribers" on import day.
 * firstChargeAt is backfilled from the origin order's real date at sync time,
 * so imported books chart when subscribers actually arrived.
 */
export async function getDashboardStats(shopId: string): Promise<DashboardStats> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const now = new Date();

  const zonedNow = toZonedTime(now, tz);
  const thisWeekStartZoned = startOfWeek(zonedNow, { weekStartsOn: 1 });
  const windowStartUtc = fromZonedTime(subWeeks(thisWeekStartZoned, 11), tz);
  const monthStartUtc = fromZonedTime(startOfMonth(zonedNow), tz);

  const [
    statusGroups,
    mrrCents,
    failedQueueCount,
    openAlerts,
    newContracts,
    cancelledContracts,
    recoveredCases,
  ] = await Promise.all([
    prisma.subscriptionContract.groupBy({
      by: ["status"],
      where: { shopId, ...COUNTABLE_CONTRACT },
      _count: { _all: true },
    }),
    computeMrrCents(shopId, shop.currencyCode),
    prisma.dunningCase.count({
      where: {
        state: { in: OPEN_DUNNING_STATES },
        contract: { shopId, ...COUNTABLE_CONTRACT },
      },
    }),
    prisma.alert.count({ where: { shopId, resolvedAt: null } }),
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        // Arrival (firstChargeAt ?? createdAt) inside the window.
        OR: [
          { firstChargeAt: { gte: windowStartUtc } },
          { firstChargeAt: null, createdAt: { gte: windowStartUtc } },
        ],
      },
      select: { createdAt: true, firstChargeAt: true },
    }),
    prisma.subscriptionContract.findMany({
      where: { shopId, ...COUNTABLE_CONTRACT, cancelledAt: { gte: windowStartUtc } },
      select: { cancelledAt: true },
    }),
    // Money-carrying resolutions only (see recoveredThisMonthCents doc — the
    // predicate DailyRollup.recoveredCents shares); currency guard joins
    // through recoveredAttemptId below, after the fetch.
    prisma.dunningCase.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        resolvedAt: { gte: monthStartUtc },
        recoveredCents: { not: null },
      },
      select: { recoveredCents: true, recoveredAttemptId: true },
    }),
  ]);

  // Currency guard through the recovering attempt (the case row stores no
  // currency of its own): a recovery charged in a non-shop currency is
  // excluded, mirroring every shop-currency aggregate; an unprovable currency
  // (no recoveredAttemptId / attempt without currencyCode) counts — mismatch
  // must be provable.
  let recoveredThisMonthCents = 0;
  {
    const recoveredAttemptIds = recoveredCases
      .map((c) => c.recoveredAttemptId)
      .filter((id): id is string => id != null);
    const recoveredAttempts = recoveredAttemptIds.length
      ? await prisma.billingAttempt.findMany({
          where: { id: { in: recoveredAttemptIds } },
          select: { id: true, currencyCode: true },
        })
      : [];
    const currencyByAttemptId = new Map(
      recoveredAttempts.map((a) => [a.id, a.currencyCode]),
    );
    for (const kase of recoveredCases) {
      const currency = kase.recoveredAttemptId
        ? currencyByAttemptId.get(kase.recoveredAttemptId)
        : null;
      if (currency != null && currency !== shop.currencyCode) continue;
      recoveredThisMonthCents += kase.recoveredCents ?? 0;
    }
  }

  const countFor = (status: string) =>
    statusGroups.find((g) => g.status === status)?._count._all ?? 0;

  const weeks: string[] = [];
  for (let i = 11; i >= 0; i--) {
    weeks.push(format(subWeeks(thisWeekStartZoned, i), "yyyy-MM-dd"));
  }
  const newByWeek = new Map<string, number>();
  const churnByWeek = new Map<string, number>();
  for (const c of newContracts) {
    const arrivedAt = c.firstChargeAt ?? c.createdAt;
    if (arrivedAt < windowStartUtc) continue; // firstChargeAt predates window
    const key = shopWeekStartKey(arrivedAt, tz);
    newByWeek.set(key, (newByWeek.get(key) ?? 0) + 1);
  }
  for (const c of cancelledContracts) {
    if (!c.cancelledAt) continue;
    const key = shopWeekStartKey(c.cancelledAt, tz);
    churnByWeek.set(key, (churnByWeek.get(key) ?? 0) + 1);
  }

  return {
    activeSubscribers: countFor("ACTIVE"),
    pausedCount: countFor("PAUSED"),
    mrrCents,
    failedQueueCount,
    openAlerts,
    newVsChurnedByWeek: {
      weeks,
      newSubscribers: weeks.map((w) => newByWeek.get(w) ?? 0),
      churned: weeks.map((w) => churnByWeek.get(w) ?? 0),
    },
    recoveredThisMonthCents,
  };
}

// ── Funnel metrics ────────────────────────────────────────────────────────────

export interface FunnelMetrics {
  rangeDays: number;
  /**
   * takeRateNum / takeRateDen summed over DailyRollup rows in range, ×100.
   * null when no denominator data exists (the storefront checkout counter
   * event isn't being emitted yet). UNIT MISMATCH, documented: the numerator
   * counts CONTRACTS while the denominator counts ORDERS (one
   * checkout.subscribable event per order), so a multi-selling-plan checkout
   * adds several contracts against one order and the ratio can exceed 100%.
   * The two sides also book on different clocks (den at event-log time, num
   * on firstChargeAt) — range sums absorb the day skew, single days don't.
   */
  takeRatePct: number | null;
  /** Cancel-flow sessions in range with a recorded reason, by reason. */
  cancelReasonBreakdown: { reason: string; count: number }[];
  /** Per reason: sessions shown / saved and save rate (0..1). */
  saveRateByReason: {
    reason: string;
    sessions: number;
    saved: number;
    saveRate: number;
  }[];
  /**
   * cycle.skipped events ÷ contracts cancelled in range (consolidation
   * merges excluded — the customer stayed); null when no cancels.
   */
  skipToCancelRatio: number | null;
  /**
   * Of dunning cases resolved in range: (RECOVERED + CUSTOMER_FIXED) ÷ all
   * resolved (0..1); null when none resolved.
   */
  dunningRecoveryRate: number | null;
  /** cycle.addon_added events ÷ successful billing attempts in range (0..1); null when no charges. */
  addonAttachRate: number | null;
  /** ACTIVE prepaid contracts ÷ all ACTIVE contracts × 100 (live snapshot). */
  prepaidMixPct: number;
}

/**
 * Conversion / retention funnel metrics over the trailing `rangeDays` window.
 *
 * Population consistency: every event-based numerator (skips, add-on
 * attaches) is filtered through the contract relation with the same
 * ours-and-not-demo filter as its denominator — demo-seeded or foreign-app
 * events must never inflate a ratio whose denominator excludes them.
 *
 * Rollup cutoffs are computed in the SHOP-timezone day-label space that
 * DailyRollup.date lives in (synthetic UTC midnight of the shop-tz day) — a
 * UTC-day cutoff would include one extra day whenever local time is past UTC
 * midnight (Europe/Zurich evenings).
 *
 * `opts.contractIds` (segment layer) scopes every contract-joined metric to
 * those ids on top of the ownership/demo filter. Take rate is then reported
 * null: its denominator (checkout.subscribable events) precedes any contract
 * and cannot be segmented — an unsegmentable denominator under a segmented
 * numerator would be a silently wrong ratio.
 */
export async function getFunnelMetrics(
  shopId: string,
  rangeDays: number,
  opts: { contractIds?: readonly string[] | null } = {},
): Promise<FunnelMetrics> {
  const shop = await requireShopById(shopId);
  const now = new Date();
  const cutoff = subDays(now, rangeDays);
  const rollupCutoff = shopDayLabelUtc(cutoff, shop.ianaTimezone);
  const segmented = opts.contractIds != null;
  const idFilter = segmented ? { id: { in: [...opts.contractIds!] } } : {};
  const relationIdFilter = segmented
    ? { contractId: { in: [...opts.contractIds!] } }
    : {};

  const [
    rollupSums,
    cancelSessionGroups,
    skips,
    cancels,
    dunningGroups,
    addonEvents,
    successfulCharges,
    activeTotal,
    activePrepaid,
  ] = await Promise.all([
    prisma.dailyRollup.aggregate({
      where: { shopId, date: { gte: rollupCutoff } },
      _sum: { takeRateNum: true, takeRateDen: true },
    }),
    prisma.cancelSession.groupBy({
      by: ["reason", "outcome"],
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        ...relationIdFilter,
        startedAt: { gte: cutoff },
      },
      _count: { _all: true },
    }),
    prisma.subscriberEvent.count({
      where: {
        shopId,
        type: "cycle.skipped",
        createdAt: { gte: cutoff },
        contract: { is: { ...COUNTABLE_CONTRACT } },
        ...relationIdFilter,
      },
    }),
    // Consolidation merges (reason MERGED, source SYSTEM) are NOT churn —
    // the customer stayed, their contracts were combined — so they must not
    // deflate skipToCancelRatio: one dedupe batch would otherwise fire the
    // "cancelling instead of skipping" reading on churn that never happened
    // (the same exclusion insight rule 6 and the analytics page apply).
    prisma.subscriptionContract.count({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        ...idFilter,
        cancelledAt: { gte: cutoff },
        NOT: { cancelReason: "MERGED" },
      },
    }),
    prisma.dunningCase.groupBy({
      by: ["resolution"],
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        ...relationIdFilter,
        resolvedAt: { gte: cutoff },
      },
      _count: { _all: true },
    }),
    prisma.subscriberEvent.count({
      where: {
        shopId,
        type: "cycle.addon_added",
        createdAt: { gte: cutoff },
        contract: { is: { ...COUNTABLE_CONTRACT } },
        ...relationIdFilter,
      },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        ...relationIdFilter,
        status: "SUCCESS",
        completedAt: { gte: cutoff },
      },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", ...COUNTABLE_CONTRACT, ...idFilter },
    }),
    prisma.subscriptionContract.count({
      where: {
        shopId,
        status: "ACTIVE",
        ...COUNTABLE_CONTRACT,
        ...idFilter,
        isPrepaid: true,
      },
    }),
  ]);

  const num = rollupSums._sum.takeRateNum ?? 0;
  const den = rollupSums._sum.takeRateDen ?? 0;
  const takeRatePct = segmented
    ? null
    : den > 0
      ? round2((num / den) * 100)
      : null;

  // Reason breakdown + save rates from cancel sessions.
  const byReason = new Map<string, { sessions: number; saved: number }>();
  for (const g of cancelSessionGroups) {
    if (!g.reason) continue;
    const entry = byReason.get(g.reason) ?? { sessions: 0, saved: 0 };
    entry.sessions += g._count._all;
    if (g.outcome === "SAVED") entry.saved += g._count._all;
    byReason.set(g.reason, entry);
  }
  const cancelReasonBreakdown = [...byReason.entries()]
    .map(([reason, v]) => ({ reason, count: v.sessions }))
    .sort((a, b) => b.count - a.count);
  const saveRateByReason = [...byReason.entries()]
    .map(([reason, v]) => ({
      reason,
      sessions: v.sessions,
      saved: v.saved,
      saveRate: v.sessions > 0 ? round4(v.saved / v.sessions) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  let resolvedTotal = 0;
  let resolvedRecovered = 0;
  for (const g of dunningGroups) {
    if (!g.resolution) continue;
    resolvedTotal += g._count._all;
    if (g.resolution === "RECOVERED" || g.resolution === "CUSTOMER_FIXED") {
      resolvedRecovered += g._count._all;
    }
  }

  return {
    rangeDays,
    takeRatePct,
    cancelReasonBreakdown,
    saveRateByReason,
    skipToCancelRatio: cancels > 0 ? round4(skips / cancels) : null,
    dunningRecoveryRate:
      resolvedTotal > 0 ? round4(resolvedRecovered / resolvedTotal) : null,
    addonAttachRate:
      successfulCharges > 0 ? round4(addonEvents / successfulCharges) : null,
    prepaidMixPct: activeTotal > 0 ? round2((activePrepaid / activeTotal) * 100) : 0,
  };
}

// ── Buy-box design performance ────────────────────────────────────────────────

export interface DesignPerformanceRow {
  /** Buy-box preset key stamped on the order ("classic", "toggle", ...). */
  designKey: string;
  /** Subscription orders attributed to this design in range. */
  subscriptionOrders: number;
  /** Share of all design-attributed subscription orders in range, 0–100. */
  sharePct: number;
}

export interface DesignPerformance {
  rangeDays: number;
  /** Σ attributed subscription orders across all designs in range. */
  totalAttributed: number;
  /**
   * Σ DailyRollup.takeRateDen in range — checkouts of subscribable products,
   * the take-rate denominator, for context (attributed ÷ this ≈ take rate by
   * design). 0 when the rollup has no data yet.
   */
  checkoutDenominator: number;
  /** One row per design seen in range, most subscription orders first. */
  rows: DesignPerformanceRow[];
}

/**
 * Subscription take-rate contribution per buy-box design over the trailing
 * `rangeDays` window. Feed: "widget.design_attributed" events, logged by the
 * ORDERS_CREATE webhook when an order line carries both a selling plan and
 * the widget's hidden `_cellexia_design` property (payload {designKey, orderId}).
 * Grouping happens in JS because the key lives inside the JSON payload.
 * Resilient to zero data: empty rows, zero totals.
 *
 * Superseded by design-measurement/scoreboard (v1.26.0): the Buy box
 * designer's Results tab reads take rate, kept rates and guardrails from
 * SubscribableOrder facts instead, and the designer no longer calls this.
 * Kept as a public helper (event-fed, dependency-free) for other callers.
 */
export async function getDesignPerformance(
  shopId: string,
  rangeDays: number,
): Promise<DesignPerformance> {
  const shop = await requireShopById(shopId);
  const cutoff = subDays(new Date(), rangeDays);
  const rollupCutoff = shopDayLabelUtc(cutoff, shop.ianaTimezone);

  const [events, rollupSums] = await Promise.all([
    prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: "widget.design_attributed",
        createdAt: { gte: cutoff },
      },
      select: { payload: true },
    }),
    prisma.dailyRollup.aggregate({
      where: { shopId, date: { gte: rollupCutoff } },
      _sum: { takeRateDen: true },
    }),
  ]);

  const ordersByDesign = new Map<string, number>();
  for (const event of events) {
    const payload = event.payload as { designKey?: unknown } | null;
    const designKey =
      typeof payload?.designKey === "string" && payload.designKey.length > 0
        ? payload.designKey
        : null;
    if (!designKey) continue;
    ordersByDesign.set(designKey, (ordersByDesign.get(designKey) ?? 0) + 1);
  }

  const totalAttributed = [...ordersByDesign.values()].reduce(
    (sum, n) => sum + n,
    0,
  );
  const rows = [...ordersByDesign.entries()]
    .map(([designKey, subscriptionOrders]) => ({
      designKey,
      subscriptionOrders,
      sharePct:
        totalAttributed > 0
          ? round2((subscriptionOrders / totalAttributed) * 100)
          : 0,
    }))
    .sort((a, b) => b.subscriptionOrders - a.subscriptionOrders);

  return {
    rangeDays,
    totalAttributed,
    checkoutDenominator: rollupSums._sum.takeRateDen ?? 0,
    rows,
  };
}

// ── Failed payments queue ─────────────────────────────────────────────────────

export interface FailedPaymentRow {
  caseId: string;
  contractId: string;
  shopifyContractId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  state: DunningState;
  declineCode: string | null;
  declineCategory: string | null;
  ladderStep: number;
  openedAt: Date;
  nextRetryAt: Date | null;
  emailsSent: number;
  smsSent: number;
  amountCents: number | null;
  currencyCode: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  consecutiveFailures: number;
}

/**
 * Open dunning cases ordered by next retry (soonest first, unscheduled last),
 * enriched with contract identity and the at-risk amount. Failed attempts
 * never carry amountCents (only the SUCCESS transition stamps it), so the
 * amount comes from DunningCase.amountAtRiskCents — the cycle estimate
 * ensureOpenCase persists at case-open. The trigger attempt's amount stays
 * as a fallback only for pre-0016 cases, whose estimate column is null.
 */
export async function getFailedPaymentsQueue(
  shopId: string,
): Promise<FailedPaymentRow[]> {
  const cases = await prisma.dunningCase.findMany({
    where: {
      state: { in: OPEN_DUNNING_STATES },
      contract: { shopId, ...COUNTABLE_CONTRACT },
    },
    orderBy: { nextRetryAt: { sort: "asc", nulls: "last" } },
    include: {
      contract: {
        select: {
          id: true,
          shopifyContractId: true,
          email: true,
          firstName: true,
          lastName: true,
          currencyCode: true,
          cardBrand: true,
          cardLast4: true,
          consecutiveFailures: true,
        },
      },
    },
  });

  const triggerIds = cases
    .map((c) => c.triggerAttemptId)
    .filter((id): id is string => id != null);
  const attempts = triggerIds.length
    ? await prisma.billingAttempt.findMany({
        where: { id: { in: triggerIds } },
        select: { id: true, amountCents: true, currencyCode: true },
      })
    : [];
  const attemptById = new Map(attempts.map((a) => [a.id, a]));

  return cases.map((c) => {
    const attempt = c.triggerAttemptId
      ? attemptById.get(c.triggerAttemptId)
      : undefined;
    return {
      caseId: c.id,
      contractId: c.contract.id,
      shopifyContractId: c.contract.shopifyContractId,
      email: c.contract.email,
      firstName: c.contract.firstName,
      lastName: c.contract.lastName,
      state: c.state,
      declineCode: c.declineCode,
      declineCategory: c.declineCategory,
      ladderStep: c.ladderStep,
      openedAt: c.openedAt,
      nextRetryAt: c.nextRetryAt,
      emailsSent: c.emailsSent,
      smsSent: c.smsSent,
      amountCents: c.amountAtRiskCents ?? attempt?.amountCents ?? null,
      currencyCode:
        c.amountAtRiskCurrencyCode ??
        attempt?.currencyCode ??
        c.contract.currencyCode,
      cardBrand: c.contract.cardBrand,
      cardLast4: c.contract.cardLast4,
      consecutiveFailures: c.contract.consecutiveFailures,
    };
  });
}

// ── Recent events ─────────────────────────────────────────────────────────────

/** Newest-first slice of the shop event log for the admin activity feed. */
export async function getRecentEvents(shopId: string, limit = 50) {
  return prisma.subscriberEvent.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, limit), 500),
  });
}

// ── Rounding helpers ──────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
