import prisma from "~/db.server";
import { toZonedTime, fromZonedTime, format as formatTz } from "date-fns-tz";
import {
  perCycleCogsCents,
  perCycleDiscountCents,
  requireShopById,
} from "./queries.server";

/**
 * Cohort LTGP engine.
 *
 * A contract belongs to the signup cohort month of (firstChargeAt ?? createdAt)
 * in the shop timezone. Cells are calendar-month based: cohort "2026-01" at
 * monthOffset 2 covers activity during calendar month 2026-03 for that cohort's
 * contracts. The whole triangle is recomputed from raw data on every run
 * (delete + createMany per shop) so late webhooks / backfills self-heal.
 */

/**
 * Payment processing fee model: 2.9% + 30¢ per successful charge (standard
 * Shopify Payments online card rate). If the merchant negotiates a different
 * rate, adjust these two constants — they are intentionally local to the
 * analytics estimate and do not affect any billing behavior.
 */
const PAYMENT_FEE_PCT = 2.9;
const PAYMENT_FEE_FIXED_CENTS = 30;

interface CellAccumulator {
  revenueCents: number;
  discountCents: number;
  cogsCents: number;
  shippingCostCents: number;
  feesCents: number;
  billedCycles: number;
}

function ymKey(date: Date, tz: string): string {
  return formatTz(toZonedTime(date, tz), "yyyy-MM", { timeZone: tz });
}

function ymIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
}

function ymFromIndex(index: number): string {
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** UTC instant of the start of month #index (year×12 + month0) in the shop tz. */
function monthStartUtc(index: number, tz: string): Date {
  return fromZonedTime(`${ymFromIndex(index)}-01T00:00:00`, tz);
}

/**
 * Recompute the full cohort triangle for a shop and upsert CohortCell rows.
 *
 * Per (cohortMonth, monthOffset) cell:
 * - cohortSize: contracts whose (firstChargeAt ?? createdAt) falls in cohortMonth.
 * - activeRemaining: cohort contracts not cancelled before the end of the
 *   offset's calendar month (cancelledAt null or ≥ next month start).
 * - revenueCents: Σ successful BillingAttempt.amountCents completed in that
 *   calendar month for cohort contracts (net of all discounts — actual receipts).
 * - discountCents: per billed cycle, Σ non-gift lines max(0, compareAt − current) × qty
 *   (informational; not subtracted from gross profit since revenue is already net).
 * - cogsCents: per billed cycle, Σ all lines unitCostCents × qty (gift lines
 *   included here — CohortCell has no separate gift column).
 * - shippingCostCents: contract.deliveryPriceCents per billed cycle.
 * - feesCents: round(amount × 2.9%) + 30¢ per successful charge.
 * - grossProfitCents = revenue − cogs − shipping − fees.
 * - cumGrossProfitCents: running total across offsets within the cohort.
 *
 * Approximations (documented, acceptable for a mirror): lines are read as they
 * exist today, so historical swaps slightly blur per-cycle COGS/discount; a
 * prepaid charge counts its line COGS once (per-charge, not per-delivery).
 */
export async function runCohortComputation(
  shopId: string,
  now: Date = new Date(),
): Promise<{ cohorts: number; cells: number }> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const nowIdx = ymIndex(ymKey(now, tz));

  const [contracts, attempts] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, isDemo: false },
      select: {
        id: true,
        createdAt: true,
        firstChargeAt: true,
        cancelledAt: true,
        deliveryPriceCents: true,
        lines: {
          select: {
            quantity: true,
            currentPriceCents: true,
            compareAtPriceCents: true,
            unitCostCents: true,
            isGift: true,
          },
        },
      },
    }),
    prisma.billingAttempt.findMany({
      where: {
        contract: { shopId },
        status: "SUCCESS",
        completedAt: { not: null },
      },
      select: { contractId: true, amountCents: true, completedAt: true },
    }),
  ]);

  if (contracts.length === 0) {
    await prisma.cohortCell.deleteMany({ where: { shopId } });
    return { cohorts: 0, cells: 0 };
  }

  // Contract → cohort assignment.
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const cohortIdxByContract = new Map<string, number>();
  const cohortMembers = new Map<number, typeof contracts>();
  for (const contract of contracts) {
    const anchor = contract.firstChargeAt ?? contract.createdAt;
    const idx = ymIndex(ymKey(anchor, tz));
    cohortIdxByContract.set(contract.id, idx);
    const members = cohortMembers.get(idx) ?? [];
    members.push(contract);
    cohortMembers.set(idx, members);
  }

  // Accumulate revenue/cost per (cohortIdx, offset) from successful attempts.
  const cells = new Map<string, CellAccumulator>();
  const cellFor = (cohortIdx: number, offset: number): CellAccumulator => {
    const key = `${cohortIdx}:${offset}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        revenueCents: 0,
        discountCents: 0,
        cogsCents: 0,
        shippingCostCents: 0,
        feesCents: 0,
        billedCycles: 0,
      };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const attempt of attempts) {
    const contract = contractById.get(attempt.contractId);
    const cohortIdx = cohortIdxByContract.get(attempt.contractId);
    if (!contract || cohortIdx == null || !attempt.completedAt) continue;
    const offset = Math.max(0, ymIndex(ymKey(attempt.completedAt, tz)) - cohortIdx);
    const amount = attempt.amountCents ?? 0;
    const cell = cellFor(cohortIdx, offset);
    cell.revenueCents += amount;
    cell.discountCents += perCycleDiscountCents(contract.lines);
    cell.cogsCents += perCycleCogsCents(contract.lines, { includeGifts: true });
    cell.shippingCostCents += contract.deliveryPriceCents;
    cell.feesCents +=
      Math.round((amount * PAYMENT_FEE_PCT) / 100) + PAYMENT_FEE_FIXED_CENTS;
    cell.billedCycles += 1;
  }

  // Emit every cell 0..maxOffset per cohort (even all-zero months), with
  // survival counts and cumulative gross profit.
  const rows: {
    shopId: string;
    cohortMonth: string;
    monthOffset: number;
    cohortSize: number;
    activeRemaining: number;
    revenueCents: number;
    discountCents: number;
    cogsCents: number;
    shippingCostCents: number;
    feesCents: number;
    grossProfitCents: number;
    cumGrossProfitCents: number;
  }[] = [];

  const cohortIndexes = [...cohortMembers.keys()].sort((a, b) => a - b);
  for (const cohortIdx of cohortIndexes) {
    const members = cohortMembers.get(cohortIdx) ?? [];
    const cohortMonth = ymFromIndex(cohortIdx);
    const maxOffset = Math.max(0, nowIdx - cohortIdx);
    let cumGrossProfitCents = 0;

    for (let offset = 0; offset <= maxOffset; offset++) {
      const monthEnd = monthStartUtc(cohortIdx + offset + 1, tz);
      const activeRemaining = members.filter(
        (m) => m.cancelledAt == null || m.cancelledAt >= monthEnd,
      ).length;
      const acc = cells.get(`${cohortIdx}:${offset}`);
      const revenueCents = acc?.revenueCents ?? 0;
      const cogsCents = acc?.cogsCents ?? 0;
      const shippingCostCents = acc?.shippingCostCents ?? 0;
      const feesCents = acc?.feesCents ?? 0;
      const grossProfitCents =
        revenueCents - cogsCents - shippingCostCents - feesCents;
      cumGrossProfitCents += grossProfitCents;

      rows.push({
        shopId,
        cohortMonth,
        monthOffset: offset,
        cohortSize: members.length,
        activeRemaining,
        revenueCents,
        discountCents: acc?.discountCents ?? 0,
        cogsCents,
        shippingCostCents,
        feesCents,
        grossProfitCents,
        cumGrossProfitCents,
      });
    }
  }

  // Full refresh keeps the triangle self-consistent even after backfills.
  await prisma.$transaction([
    prisma.cohortCell.deleteMany({ where: { shopId } }),
    prisma.cohortCell.createMany({ data: rows }),
  ]);

  return { cohorts: cohortIndexes.length, cells: rows.length };
}

// ── LTGP summary ──────────────────────────────────────────────────────────────

export interface LtgpCohortSummary {
  cohortMonth: string;
  cohortSize: number;
  /** Cumulative gross profit per subscriber (cents) at month offset 3; null if the cohort hasn't fully aged past it. */
  ltgpM3Cents: number | null;
  ltgpM6Cents: number | null;
  ltgpM12Cents: number | null;
}

export interface LtgpSummary {
  cohorts: LtgpCohortSummary[];
  /**
   * Cohort-size-weighted averages across cohorts old enough for each horizon:
   * Σ cumGrossProfit ÷ Σ cohortSize. Null when no cohort has aged that far.
   */
  weightedAvg: {
    m3Cents: number | null;
    m6Cents: number | null;
    m12Cents: number | null;
  };
}

const LTGP_HORIZONS = [3, 6, 12] as const;

/**
 * Per-cohort lifetime gross profit at M3/M6/M12 (cum GP per subscriber, cents),
 * plus size-weighted averages. A cohort contributes to a horizon only once that
 * offset month has fully elapsed, so young cohorts never drag the average down.
 */
export async function getLtgpSummary(
  shopId: string,
  now: Date = new Date(),
): Promise<LtgpSummary> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const nowIdx = ymIndex(ymKey(now, tz));

  // Offset 0 always exists — it carries cohortMonth/cohortSize for young
  // cohorts that haven't reached any LTGP horizon yet.
  const cellRows = await prisma.cohortCell.findMany({
    where: { shopId, monthOffset: { in: [0, ...LTGP_HORIZONS] } },
    orderBy: [{ cohortMonth: "asc" }, { monthOffset: "asc" }],
    select: {
      cohortMonth: true,
      monthOffset: true,
      cohortSize: true,
      cumGrossProfitCents: true,
    },
  });

  const byCohort = new Map<string, typeof cellRows>();
  for (const row of cellRows) {
    const list = byCohort.get(row.cohortMonth) ?? [];
    list.push(row);
    byCohort.set(row.cohortMonth, list);
  }

  const totals = new Map<number, { gp: number; size: number }>();
  const cohorts: LtgpCohortSummary[] = [];

  for (const [cohortMonth, rowsForCohort] of byCohort) {
    const cohortIdx = ymIndex(cohortMonth);
    const cohortSize = rowsForCohort[0]?.cohortSize ?? 0;
    const at = (horizon: number): number | null => {
      // Only report once the offset month has fully elapsed.
      if (nowIdx <= cohortIdx + horizon) return null;
      const cell = rowsForCohort.find((r) => r.monthOffset === horizon);
      if (!cell || cohortSize === 0) return null;
      const t = totals.get(horizon) ?? { gp: 0, size: 0 };
      t.gp += cell.cumGrossProfitCents;
      t.size += cohortSize;
      totals.set(horizon, t);
      return Math.round(cell.cumGrossProfitCents / cohortSize);
    };
    cohorts.push({
      cohortMonth,
      cohortSize,
      ltgpM3Cents: at(3),
      ltgpM6Cents: at(6),
      ltgpM12Cents: at(12),
    });
  }

  cohorts.sort((a, b) => a.cohortMonth.localeCompare(b.cohortMonth));

  const weighted = (horizon: number): number | null => {
    const t = totals.get(horizon);
    return t && t.size > 0 ? Math.round(t.gp / t.size) : null;
  };

  return {
    cohorts,
    weightedAvg: {
      m3Cents: weighted(3),
      m6Cents: weighted(6),
      m12Cents: weighted(12),
    },
  };
}
