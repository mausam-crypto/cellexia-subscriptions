import prisma from "~/db.server";
import type { DunningState } from "@prisma/client";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { format, startOfMonth, startOfWeek, subDays, subWeeks } from "date-fns";

/**
 * Dashboard / funnel query layer for the analytics module.
 *
 * All money values are integer cents. All "per month" normalization uses
 * WEEKS_PER_MONTH so weekly-cadence subscriptions convert to calendar-month
 * revenue consistently across the app.
 */

/** 52.14 weeks / 12 months — used to normalize weekly cadences to monthly revenue. */
export const WEEKS_PER_MONTH = 4.345;

/** Dunning states that count as "open" (a case still being worked). */
export const OPEN_DUNNING_STATES: DunningState[] = [
  "OPEN",
  "RETRYING",
  "AWAITING_CUSTOMER",
  "AWAITING_3DS",
];

// ── Small shared helpers (used by rollup / cohorts / forecast) ────────────────

/** Load the Shop row (needed for its IANA timezone) or throw — analytics is meaningless without it. */
export async function requireShopById(shopId: string) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new Error(`[analytics] Shop not found: ${shopId}`);
  return shop;
}

/** Line shape needed for discount/COGS estimation. */
export interface LineForCosting {
  quantity: number;
  currentPriceCents: number;
  compareAtPriceCents: number | null;
  unitCostCents: number | null;
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

/**
 * COGS for one billed cycle: Σ over lines of unitCostCents × quantity where
 * unitCostCents is known. `includeGifts: false` excludes gift lines so callers
 * that account for gift COGS separately (via GiftGrant → GiftRule.unitCostCents)
 * do not double count.
 */
export function perCycleCogsCents(
  lines: LineForCosting[],
  opts: { includeGifts: boolean },
): number {
  let total = 0;
  for (const line of lines) {
    if (line.isGift && !opts.includeGifts) continue;
    if (line.unitCostCents == null) continue;
    total += line.unitCostCents * line.quantity;
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
 * Formula: Σ over ACTIVE contracts of round(cycleTotalCents × 4.345 / intervalWeeks)
 * where cycleTotalCents = Σ recurring lines (currentPriceCents × quantity,
 * one-time add-ons excluded, gift lines are zero-priced anyway) + deliveryPriceCents.
 *
 * Prepaid contracts: line prices are per delivery and the charge interval scales
 * with deliveries-per-charge, so the amortized monthly value reduces to the same
 * formula — no special-casing needed.
 */
export async function computeMrrCents(shopId: string): Promise<number> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId, status: "ACTIVE", isDemo: false },
    select: {
      intervalWeeks: true,
      deliveryPriceCents: true,
      lines: {
        select: { quantity: true, currentPriceCents: true, isOneTimeAddon: true },
      },
    },
  });

  let mrr = 0;
  for (const contract of contracts) {
    const cycleTotal =
      contract.lines
        .filter((l) => !l.isOneTimeAddon)
        .reduce((sum, l) => sum + l.currentPriceCents * l.quantity, 0) +
      contract.deliveryPriceCents;
    const weeks = Math.max(1, contract.intervalWeeks);
    mrr += Math.round((cycleTotal * WEEKS_PER_MONTH) / weeks);
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
  /** Σ DunningCase.recoveredCents resolved RECOVERED or CUSTOMER_FIXED this shop-tz calendar month. */
  recoveredThisMonthCents: number;
}

/**
 * Headline dashboard numbers. All counts are live snapshots; the weekly
 * new-vs-churned series buckets contract createdAt / cancelledAt into
 * shop-timezone ISO weeks (Monday start).
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
    recoveredAgg,
  ] = await Promise.all([
    prisma.subscriptionContract.groupBy({
      by: ["status"],
      where: { shopId, isDemo: false },
      _count: { _all: true },
    }),
    computeMrrCents(shopId),
    prisma.dunningCase.count({
      where: { state: { in: OPEN_DUNNING_STATES }, contract: { shopId } },
    }),
    prisma.alert.count({ where: { shopId, resolvedAt: null } }),
    prisma.subscriptionContract.findMany({
      where: { shopId, isDemo: false, createdAt: { gte: windowStartUtc } },
      select: { createdAt: true },
    }),
    prisma.subscriptionContract.findMany({
      where: { shopId, isDemo: false, cancelledAt: { gte: windowStartUtc } },
      select: { cancelledAt: true },
    }),
    prisma.dunningCase.aggregate({
      where: {
        contract: { shopId },
        resolvedAt: { gte: monthStartUtc },
        resolution: { in: ["RECOVERED", "CUSTOMER_FIXED"] },
      },
      _sum: { recoveredCents: true },
    }),
  ]);

  const countFor = (status: string) =>
    statusGroups.find((g) => g.status === status)?._count._all ?? 0;

  const weeks: string[] = [];
  for (let i = 11; i >= 0; i--) {
    weeks.push(format(subWeeks(thisWeekStartZoned, i), "yyyy-MM-dd"));
  }
  const newByWeek = new Map<string, number>();
  const churnByWeek = new Map<string, number>();
  for (const c of newContracts) {
    const key = shopWeekStartKey(c.createdAt, tz);
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
    recoveredThisMonthCents: recoveredAgg._sum.recoveredCents ?? 0,
  };
}

// ── Funnel metrics ────────────────────────────────────────────────────────────

export interface FunnelMetrics {
  rangeDays: number;
  /**
   * takeRateNum / takeRateDen summed over DailyRollup rows in range, ×100.
   * null when no denominator data exists (the storefront checkout counter
   * event isn't being emitted yet).
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
  /** cycle.skipped events ÷ contracts cancelled in range; null when no cancels. */
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
 */
export async function getFunnelMetrics(
  shopId: string,
  rangeDays: number,
): Promise<FunnelMetrics> {
  const now = new Date();
  const cutoff = subDays(now, rangeDays);
  const rollupCutoff = new Date(`${utcDayKey(cutoff)}T00:00:00.000Z`);

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
      where: { contract: { shopId }, startedAt: { gte: cutoff } },
      _count: { _all: true },
    }),
    prisma.subscriberEvent.count({
      where: { shopId, type: "cycle.skipped", createdAt: { gte: cutoff } },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, isDemo: false, cancelledAt: { gte: cutoff } },
    }),
    prisma.dunningCase.groupBy({
      by: ["resolution"],
      where: { contract: { shopId }, resolvedAt: { gte: cutoff } },
      _count: { _all: true },
    }),
    prisma.subscriberEvent.count({
      where: { shopId, type: "cycle.addon_added", createdAt: { gte: cutoff } },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId },
        status: "SUCCESS",
        completedAt: { gte: cutoff },
      },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", isDemo: false },
    }),
    prisma.subscriptionContract.count({
      where: { shopId, status: "ACTIVE", isDemo: false, isPrepaid: true },
    }),
  ]);

  const num = rollupSums._sum.takeRateNum ?? 0;
  const den = rollupSums._sum.takeRateDen ?? 0;
  const takeRatePct = den > 0 ? round2((num / den) * 100) : null;

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
 */
export async function getDesignPerformance(
  shopId: string,
  rangeDays: number,
): Promise<DesignPerformance> {
  const cutoff = subDays(new Date(), rangeDays);
  const rollupCutoff = new Date(`${utcDayKey(cutoff)}T00:00:00.000Z`);

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
 * enriched with contract identity and the failed amount from the attempt that
 * opened each case.
 */
export async function getFailedPaymentsQueue(
  shopId: string,
): Promise<FailedPaymentRow[]> {
  const cases = await prisma.dunningCase.findMany({
    where: { state: { in: OPEN_DUNNING_STATES }, contract: { shopId } },
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
      amountCents: attempt?.amountCents ?? null,
      currencyCode: attempt?.currencyCode ?? c.contract.currencyCode,
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
