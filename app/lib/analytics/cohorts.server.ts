import prisma from "~/db.server";
import { toZonedTime, fromZonedTime, format as formatTz } from "date-fns-tz";
import {
  COUNTABLE_CONTRACT,
  originPaymentCountsOnce,
  perCycleDiscountCents,
  requireShopById,
} from "./queries.server";
import {
  loadCostContext,
  parseChargeCostSnapshot,
  paymentFeeCents,
  perCycleLineCosts,
  perShipmentCostCents,
} from "./costs.server";

/**
 * Cohort LTGP engine.
 *
 * A contract belongs to the signup cohort month of (firstChargeAt ?? createdAt)
 * in the shop timezone. Cells are calendar-month based: cohort "2026-01" at
 * monthOffset 2 covers activity during calendar month 2026-03 for that cohort's
 * contracts. The whole triangle is recomputed from raw data on every run
 * (delete + createMany per shop) so late webhooks / backfills self-heal.
 *
 * Costs come from the shared cost model (app/lib/analytics/costs.server.ts):
 * payment fees + merchant-side shipping/fulfillment per shipment from the
 * "costModel" setting, COGS per line via Shopify cost → merchant override →
 * percentage-of-price estimate (the estimated share is stored per cell as
 * estimatedCogsCents so the UI can flag partly-estimated LTGP). This is the
 * SAME formula the daily rollup's estGrossProfitCents uses.
 *
 * SCOPE — RENEWALS + ORIGIN PAYMENTS (since migration 0006): revenue is
 * Σ successful BillingAttempt amounts PLUS each contract's mirrored origin
 * (checkout) payment (originOrderTotalCents net of originOrderRefundedCents),
 * booked in the month it PROCESSED — normally the cohort's month 0, since the
 * cohort anchor (firstChargeAt) derives from the same order. Cumulative LTGP
 * therefore now includes the first payment. Two caveats, both documented on
 * the surfaces:
 * - contracts whose origin payment is not yet captured (backfill pending, or
 *   no origin order at all — imports) contribute renewals only;
 * - origin-month COGS is approximated from the contract's CURRENT lines via
 *   the shared cost model (origin lines ≈ current lines — the same
 *   lines-as-they-exist-now approximation billed cycles already accept).
 * Double-count guard: an origin order that somehow also produced a successful
 * BillingAttempt counts ONCE — originPaymentCountsOnce (queries.server.ts) is
 * the single precedence rule shared with the daily rollup.
 */

interface CellAccumulator {
  revenueCents: number;
  refundedCents: number;
  discountCents: number;
  cogsCents: number;
  estimatedCogsCents: number;
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
 * - activeRemaining: cohort contracts not churned before the end of the
 *   offset's calendar month. "Churned" means cancelledAt, OR — for contracts
 *   sitting in status FAILED with no cancelledAt (dunning exhausted under the
 *   default PAUSE action) — failedAt, OR — for completed bounded plans
 *   (status EXPIRED, billingMaxCycles ran out) — expiredAt (stamped since
 *   migration 0016). Without the failedAt leg, payment-churned contracts
 *   would read as retained forever; without the expiredAt leg, expired ones
 *   did. All three retention surfaces (this, the rollup churn columns, the
 *   survival curves) classify EXPIRED as VOLUNTARY churn — a scheduled end
 *   the subscriber signed up for, not a payment failure. Contracts that
 *   expired before 0016 carry no expiredAt and still count as retained: the
 *   instant was never recorded and cannot be reconstructed.
 * - revenueCents: Σ successful BillingAttempt.amountCents completed in that
 *   calendar month for cohort contracts, NET of refundedCents (actual money
 *   kept), PLUS the cohort contracts' origin (checkout) payments
 *   (originOrderTotalCents net of originOrderRefundedCents) booked in the
 *   month they processed — normally the cohort's month 0. Attempts/origin
 *   totals in a non-shop currency are excluded (cents are only additive
 *   within one currency), and an origin order also claimed by a successful
 *   attempt counts once (originPaymentCountsOnce). refundedCents is also
 *   stored per cell. Origin payments carry the shared cost model too: fees
 *   on the origin total, one shipment (× deliveries-per-charge when
 *   prepaid), and COGS from the contract's CURRENT lines via resolveLineCogs
 *   — the documented origin-lines ≈ current-lines approximation.
 * - discountCents: per billed cycle, Σ non-gift lines max(0, compareAt − current) × qty
 *   (informational; not subtracted from gross profit since revenue is already net).
 * - cogsCents: per billed cycle, PREFERRING the cost basis frozen into
 *   BillingAttempt.costSnapshot at settlement (migration 0016) so the nightly
 *   full recompute stops repricing history with today's cost settings;
 *   attempts with no parseable snapshot (pre-0016) keep the live shared cost
 *   model (Shopify cost → merchant override → percentage estimate). Gift
 *   lines EXCLUDED either way — gift COGS is added from GiftGrant rows (rule
 *   cost, falling back to the variant's override), the same per-grant source
 *   the daily rollup uses, so a gift's cost is booked once in the month it
 *   was granted and survives line removal.
 *   Prepaid charges multiply line COGS by deliveries-per-charge.
 *   estimatedCogsCents stores the estimated share (COGS-coverage stat).
 * - shippingCostCents: merchant-side fulfillment + carrier cost per shipment
 *   from the cost model × shipments (prepaid: deliveries-per-charge).
 *   Customer-paid delivery is NOT a cost — it stays inside revenueCents.
 * - feesCents: payment processing fees per successful charge (cost model).
 * - grossProfitCents = revenue(net of refunds) − cogs − shipping − fees.
 * - cumGrossProfitCents: running total across offsets within the cohort.
 *
 * Approximations (documented, acceptable for a mirror): lines are read as they
 * exist today, so historical swaps slightly blur per-cycle COGS/discount.
 */
export async function runCohortComputation(
  shopId: string,
  now: Date = new Date(),
): Promise<{ cohorts: number; cells: number }> {
  const shop = await requireShopById(shopId);
  const tz = shop.ianaTimezone;
  const nowIdx = ymIndex(ymKey(now, tz));

  const costCtx = await loadCostContext(shopId);

  const [contracts, attempts, giftGrants] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: { shopId, ...COUNTABLE_CONTRACT },
      select: {
        id: true,
        createdAt: true,
        firstChargeAt: true,
        cancelledAt: true,
        status: true,
        failedAt: true,
        expiredAt: true,
        deliveryPriceCents: true,
        isPrepaid: true,
        prepaidDeliveriesPerCharge: true,
        originOrderId: true,
        originOrderTotalCents: true,
        originOrderDiscountCents: true,
        originOrderRefundedCents: true,
        originOrderProcessedAt: true,
        originOrderCurrencyCode: true,
        lines: {
          select: {
            productId: true,
            variantId: true,
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
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "SUCCESS",
        completedAt: { not: null },
      },
      select: {
        contractId: true,
        orderId: true,
        amountCents: true,
        refundedCents: true,
        currencyCode: true,
        completedAt: true,
        costSnapshot: true,
      },
    }),
    // Gift COGS source — per grant, like the rollup, so it cannot be
    // re-counted per billed cycle nor vanish when the gift line is removed.
    // Status is transient (ADDED → SHIPPED at settlement → REMOVED by daily
    // mirror hygiene), so the filter keys on the durable facts: attached
    // (addedAt), and either not yet cleared or provably shipped (shippedAt
    // survives the REMOVED flip). Supersede-retired grants (REMOVED, never
    // shipped) stay excluded.
    prisma.giftGrant.findMany({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        addedAt: { not: null },
        OR: [
          { status: { in: ["ADDED", "SHIPPED"] } },
          { shippedAt: { not: null } },
        ],
      },
      select: {
        contractId: true,
        variantId: true,
        addedAt: true,
        rule: { select: { unitCostCents: true } },
      },
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
        refundedCents: 0,
        discountCents: 0,
        cogsCents: 0,
        estimatedCogsCents: 0,
        shippingCostCents: 0,
        feesCents: 0,
        billedCycles: 0,
      };
      cells.set(key, cell);
    }
    return cell;
  };

  // Successful-attempt order ids — the precedence set the origin-payment
  // double-count guard checks against (an order claimed by an attempt is
  // never also booked from the origin mirror).
  const successfulAttemptOrderIds = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.orderId) successfulAttemptOrderIds.add(attempt.orderId);
  }

  for (const attempt of attempts) {
    const contract = contractById.get(attempt.contractId);
    const cohortIdx = cohortIdxByContract.get(attempt.contractId);
    if (!contract || cohortIdx == null || !attempt.completedAt) continue;
    // Currency guard: never sum foreign-presentment cents into shop-currency cells.
    if (attempt.currencyCode && attempt.currencyCode !== shop.currencyCode) {
      continue;
    }
    const offset = Math.max(0, ymIndex(ymKey(attempt.completedAt, tz)) - cohortIdx);
    const amount = attempt.amountCents ?? 0;
    const refunded = Math.min(attempt.refundedCents, Math.max(amount, 0));
    const cell = cellFor(cohortIdx, offset);
    cell.revenueCents += amount - refunded;
    cell.refundedCents += refunded;
    cell.discountCents += perCycleDiscountCents(contract.lines);
    // Cost basis: the settlement-frozen snapshot when present (the full
    // recompute must not reprice history with today's cost settings); live
    // cost model for pre-0016 attempts. Fees always compute on the charged
    // amount at read time. Gift lines excluded either way — gift COGS is
    // booked per grant below.
    const snapshot = parseChargeCostSnapshot(attempt.costSnapshot);
    if (snapshot) {
      cell.cogsCents += snapshot.cogsCents;
      cell.estimatedCogsCents += snapshot.estimatedCogsCents;
      cell.shippingCostCents +=
        snapshot.shippingCostCents + snapshot.fulfillmentCostCents;
    } else {
      const deliveries = contract.isPrepaid
        ? Math.max(1, contract.prepaidDeliveriesPerCharge ?? 1)
        : 1;
      const costs = perCycleLineCosts(contract.lines, costCtx, {
        includeGifts: false,
      });
      cell.cogsCents += costs.cogsCents * deliveries;
      cell.estimatedCogsCents += costs.estimatedCogsCents * deliveries;
      cell.shippingCostCents +=
        perShipmentCostCents(costCtx.costModel, contract.deliveryPriceCents) *
        deliveries;
    }
    cell.feesCents += paymentFeeCents(amount, costCtx.costModel);
    cell.billedCycles += 1;
  }

  // ── Origin (checkout) payments, booked in their processed month ────────────
  // Normally the cohort's month 0 (the cohort anchor derives from the same
  // order). Guarded against double counting by originPaymentCountsOnce —
  // shared with the daily rollup, so the precedence rule cannot diverge.
  for (const contract of contracts) {
    const cohortIdx = cohortIdxByContract.get(contract.id);
    if (cohortIdx == null) continue;
    if (
      !originPaymentCountsOnce(
        contract,
        successfulAttemptOrderIds,
        shop.currencyCode,
      )
    ) {
      continue;
    }
    const processedAt = contract.originOrderProcessedAt;
    if (!processedAt) continue; // countsOnce already requires it — belt & braces
    const offset = Math.max(0, ymIndex(ymKey(processedAt, tz)) - cohortIdx);
    const amount = contract.originOrderTotalCents ?? 0;
    const refunded = Math.min(
      Math.max(0, contract.originOrderRefundedCents),
      Math.max(amount, 0),
    );
    const deliveries = contract.isPrepaid
      ? Math.max(1, contract.prepaidDeliveriesPerCharge ?? 1)
      : 1;
    const cell = cellFor(cohortIdx, offset);
    cell.revenueCents += amount - refunded;
    cell.refundedCents += refunded;
    // Order-level discount mirrored from Shopify — money-true, no estimation.
    cell.discountCents += Math.max(0, contract.originOrderDiscountCents ?? 0);
    // COGS approximation (documented): the contract's CURRENT lines stand in
    // for the origin order's lines, resolved through the shared cost model.
    const costs = perCycleLineCosts(contract.lines, costCtx, {
      includeGifts: false,
    });
    cell.cogsCents += costs.cogsCents * deliveries;
    cell.estimatedCogsCents += costs.estimatedCogsCents * deliveries;
    cell.shippingCostCents +=
      perShipmentCostCents(costCtx.costModel, contract.deliveryPriceCents) *
      deliveries;
    cell.feesCents += paymentFeeCents(amount, costCtx.costModel);
  }

  // Gift COGS per grant, booked in the month the gift was attached (survives
  // later line removal; never multiplied per billed cycle). Fallback when the
  // rule is gone: the merchant's per-product COGS override for the variant.
  const overrideByVariant = new Map<string, number>();
  for (const [key, cents] of costCtx.overrides.byVariant) {
    overrideByVariant.set(key.split("|")[1] ?? key, cents);
  }
  for (const grant of giftGrants) {
    const cohortIdx = cohortIdxByContract.get(grant.contractId);
    if (cohortIdx == null || !grant.addedAt) continue;
    const cost =
      grant.rule?.unitCostCents ?? overrideByVariant.get(grant.variantId) ?? 0;
    if (cost === 0) continue;
    const offset = Math.max(0, ymIndex(ymKey(grant.addedAt, tz)) - cohortIdx);
    cellFor(cohortIdx, offset).cogsCents += cost;
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
    refundedCents: number;
    discountCents: number;
    cogsCents: number;
    estimatedCogsCents: number;
    shippingCostCents: number;
    feesCents: number;
    grossProfitCents: number;
    cumGrossProfitCents: number;
  }[] = [];

  // When did this contract stop being a live subscriber? cancelledAt when
  // cancelled; failedAt for dunning-exhausted contracts stuck in FAILED with
  // no cancel timestamp; expiredAt for completed bounded plans (EXPIRED —
  // voluntary churn, the shared classification, see activeRemaining doc).
  // Null = still considered retained, including pre-0016 expiries whose
  // instant was never recorded.
  const churnEndOf = (m: {
    cancelledAt: Date | null;
    status: string;
    failedAt: Date | null;
    expiredAt: Date | null;
  }): Date | null =>
    m.cancelledAt ??
    (m.status === "FAILED"
      ? m.failedAt
      : m.status === "EXPIRED"
        ? m.expiredAt
        : null);

  const cohortIndexes = [...cohortMembers.keys()].sort((a, b) => a - b);
  for (const cohortIdx of cohortIndexes) {
    const members = cohortMembers.get(cohortIdx) ?? [];
    const cohortMonth = ymFromIndex(cohortIdx);
    const maxOffset = Math.max(0, nowIdx - cohortIdx);
    let cumGrossProfitCents = 0;

    for (let offset = 0; offset <= maxOffset; offset++) {
      const monthEnd = monthStartUtc(cohortIdx + offset + 1, tz);
      const activeRemaining = members.filter((m) => {
        const churnEnd = churnEndOf(m);
        return churnEnd == null || churnEnd >= monthEnd;
      }).length;
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
        refundedCents: acc?.refundedCents ?? 0,
        discountCents: acc?.discountCents ?? 0,
        cogsCents,
        estimatedCogsCents: acc?.estimatedCogsCents ?? 0,
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
 *
 * SCOPE (see runCohortComputation): renewals PLUS captured origin (checkout)
 * payments since migration 0006 — the first payment is in these figures for
 * every contract whose origin order money has been captured. Contracts with
 * no captured origin payment (backfill pending, or imported books with no
 * origin order) still contribute renewals only, so surfaces should say
 * "first orders included where captured".
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
