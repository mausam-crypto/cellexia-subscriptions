/**
 * Predicted per-subscriber LTGP (v1.21.0).
 *
 * The forward multiplication the analytics module never had: the
 * censoring-corrected survival curve (survival.server.ts) × each contract's
 * per-cycle gross profit (the shared cost model, costs.server.ts) × the
 * contract's own churn-risk tilt (risk.server.ts) → expected CUMULATIVE gross
 * profit at fixed horizons from subscription start: 90d / 180d / 1y / 3y / 5y.
 * Written nightly onto SubscriptionContract.predictedLtgp by
 * predicted_ltgp_run (after churn_risk_run, so the tilt reads fresh scores).
 *
 * Semantics — horizons measure from CONTRACT START, matching the cohort
 * LTGP actuals (cohorts.server.ts) they reconcile against: "what will this
 * subscriber have been worth by day 90 / year 1". Cycles already billed count
 * with probability 1; future cycles decay along the tilted curve. Realized
 * cycles are valued at the CURRENT per-cycle gross profit — the same
 * current-lines approximation the cohort month-0 COGS resolution documents.
 *
 * Honesty rules (the module's spine, same conventions as forecast.server.ts):
 *  - every horizon carries a grade capped by how much calendar history the
 *    book actually has relative to that horizon — a 5-year prediction on a
 *    young book grades D ("directional only") BY CONSTRUCTION, and the UI
 *    must render the grade next to the number;
 *  - rate-derived inputs (fallback COGS, flat VAT) mark the value
 *    `estimatedCosts` so the "partly estimated" banner logic extends here;
 *  - the day-one prediction is FROZEN once (predictedLtgpInitial) and the
 *    accuracy pass (runLtgpAccuracy) scores it against matured actuals into
 *    the machine-written `ltgpAccuracy` setting — the model grades its own
 *    homework, and the UI never claims accuracy without matured samples;
 *  - refund exclusion (analytics.excludeRefundedPayments) is honored as a
 *    disclosed expected-refund haircut — this module is the FIFTH consumer
 *    that must stay in lockstep with the setting (registry comment updated).
 *
 * Failure containment: golden rule 9 — this is derived analytics; every
 * batch entry point is designed to be run inside runStepsContained and no
 * failure here may touch billing or the portal.
 */

import prisma from "~/db.server";
import { Prisma } from "@prisma/client";
import type { SettingsValue } from "~/lib/settings/registry.server";
import {
  COUNTABLE_CONTRACT,
  DAYS_PER_MONTH,
  contractTaxCountry,
  originPaymentCountsOnce,
  requireShopById,
} from "./queries.server";
import { getSurvivalByCycle } from "./survival.server";
import {
  computeChargeCostSnapshot,
  parseChargeCostSnapshot,
  loadCostContext,
  paymentFeeCents,
  resolveChargeVat,
  type CostContext,
} from "./costs.server";
import { contractFrequency } from "~/lib/frequency";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { ymIndex, ymKey } from "./cohorts.server";

const DAY_MS = 86_400_000;

/** Mirror of forecast.server.ts's thin-curve fallback per-cycle survival. */
const DEFAULT_CYCLE_SURVIVAL = 0.9;

/** Tail extrapolation cap: no per-cycle survival is ever assumed above this. */
const MAX_TAIL_SURVIVAL = 0.98;

/** Risk tilt clamp — a contract can at most quadruple / quarter the book hazard. */
const RISK_TILT_MIN = 0.25;
const RISK_TILT_MAX = 4;

/** Contracts younger than this get their first prediction frozen as day-one. */
const INITIAL_STAMP_MAX_AGE_DAYS = 8;

export const LTGP_PREDICTION_HORIZONS = [
  { key: "d90", days: 90, label: "90 days" },
  { key: "d180", days: 180, label: "180 days" },
  { key: "y1", days: 365, label: "1 year" },
  { key: "y3", days: 1095, label: "3 years" },
  { key: "y5", days: 1825, label: "5 years" },
] as const;

export type LtgpHorizonKey = (typeof LTGP_PREDICTION_HORIZONS)[number]["key"];

export type LtgpGrade = "A" | "B" | "C" | "D";

export interface PredictedLtgpHorizon {
  /** Expected cumulative gross profit from contract start to this horizon. */
  cents: number;
  /** Expected cycles billed by this horizon (realized + probability-weighted). */
  expectedCycles: number;
  grade: LtgpGrade;
}

export interface PredictedLtgpValue {
  v: 1;
  computedAt: string;
  currencyCode: string;
  cycleDays: number;
  cycleGpCents: number;
  /** The applied hazard multiplier (contract risk vs book mean), clamped. */
  riskTilt: number;
  horizons: Record<LtgpHorizonKey, PredictedLtgpHorizon>;
  basis: {
    /** True when fallback COGS or rate-derived VAT entered the number. */
    estimatedCosts: boolean;
    /** Expected-refund haircut applied, percent of gross profit. */
    refundHaircutPct: number;
    /** Contracts behind the survival curve at compute time. */
    curveContracts: number;
    /** Calendar depth of the book at compute time, days. */
    observedSpanDays: number;
    scorer: "heuristic" | "learned" | "none";
  };
}

/** Defensive parser for the stored Json (the parseChargeCostSnapshot pattern). */
export function parsePredictedLtgp(value: unknown): PredictedLtgpValue | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  const horizons = v.horizons as Record<string, unknown> | undefined;
  if (typeof horizons !== "object" || horizons === null) return null;
  for (const { key } of LTGP_PREDICTION_HORIZONS) {
    const h = horizons[key] as Record<string, unknown> | undefined;
    if (
      typeof h !== "object" ||
      h === null ||
      !Number.isFinite(h.cents) ||
      !Number.isFinite(h.expectedCycles) ||
      typeof h.grade !== "string"
    ) {
      return null;
    }
  }
  return value as PredictedLtgpValue;
}

/**
 * Per-horizon honesty grade. Capped by calendar coverage — the ratio of how
 * long the book has existed to how far out the horizon reaches. The forecast
 * module's history caps express the same idea in weeks; here the horizon
 * itself sets the yardstick, which is what makes y3/y5 grade D on a young
 * book without any special-casing.
 */
export function ltgpHorizonGrade(input: {
  horizonDays: number;
  observedSpanDays: number;
  curveContracts: number;
}): LtgpGrade {
  const coverage = input.observedSpanDays / Math.max(1, input.horizonDays);
  let idx = coverage >= 1.5 ? 3 : coverage >= 0.75 ? 2 : coverage >= 0.3 ? 1 : 0;
  // A thin curve degrades every horizon one notch: per-cycle hazards
  // estimated on a handful of contracts produce sign-flip noise.
  if (input.curveContracts < 30) idx = Math.max(0, idx - 1);
  return (["D", "C", "B", "A"] as const)[idx];
}

export interface ComputePredictedLtgpInput {
  /**
   * RENEWAL cycles billed to date — SubscriptionContract.ordersCount, which
   * counts successful app-billed renewals ONLY (the origin checkout charge
   * is never in it; lifetimeRevenueCents beside it is renewals-only for the
   * same reason). The origin charge is accounted separately as one realized
   * charge, and the survival curve is likewise in renewal space (KM buckets
   * by ordersCount): S(1) = P(reach the 1st renewal).
   */
  currentCycle: number;
  cycleGpCents: number;
  cycleDays: number;
  /** KM overall survival S(1..n) from getSurvivalByCycle; may be empty. */
  overallSurvival: readonly number[];
  curveContracts: number;
  riskScore: number | null;
  bookMeanRisk: number | null;
  /** Percent of gross profit expected to vanish to refund-excluded payments. */
  refundHaircutPct: number;
  observedSpanDays: number;
  estimatedCosts: boolean;
  scorer: "heuristic" | "learned" | "none";
  currencyCode: string;
  computedAt: Date;
}

/**
 * The pure core: conditional tilted survival × per-cycle gross profit,
 * accumulated to each horizon. Deterministic, no I/O — unit-tested directly.
 */
export function computePredictedLtgp(
  input: ComputePredictedLtgpInput,
): PredictedLtgpValue {
  const cycleDays = Math.max(1, input.cycleDays);
  const S = input.overallSurvival;

  // Per-renewal survival s(k) = S(k)/S(k-1) in renewal space. Observed
  // ratios are taken as measured (they came from the censoring-corrected
  // life table); only the EXTRAPOLATED tail — beyond observed depth — is
  // capped at MAX_TAIL_SURVIVAL so a lucky flat stretch can never compound
  // into an immortal 5-year book. Thin/absent depth falls back to the
  // conservative default.
  const perCycleSurvival = (cycle: number): number => {
    const idx = cycle - 1; // S is 1-indexed conceptually, 0-indexed in array
    let s: number;
    let extrapolated = false;
    if (S.length === 0) {
      s = DEFAULT_CYCLE_SURVIVAL;
    } else if (idx <= 0) {
      s = S[0] > 0 ? S[0] : DEFAULT_CYCLE_SURVIVAL;
    } else if (idx < S.length) {
      const prev = S[idx - 1];
      s = prev > 0 ? S[idx] / prev : DEFAULT_CYCLE_SURVIVAL;
    } else {
      // Beyond observed depth: geometric tail at the last observed ratio.
      extrapolated = true;
      const lastIdx = S.length - 1;
      const prev = lastIdx > 0 ? S[lastIdx - 1] : 1;
      s = prev > 0 && S[lastIdx] > 0 ? S[lastIdx] / prev : DEFAULT_CYCLE_SURVIVAL;
    }
    if (!Number.isFinite(s) || s <= 0) s = DEFAULT_CYCLE_SURVIVAL;
    const ceiling = extrapolated ? MAX_TAIL_SURVIVAL : 1;
    return Math.min(ceiling, Math.max(0.05, s));
  };

  const riskTilt =
    input.riskScore != null &&
    input.bookMeanRisk != null &&
    input.bookMeanRisk > 0.01
      ? Math.min(
          RISK_TILT_MAX,
          Math.max(RISK_TILT_MIN, input.riskScore / input.bookMeanRisk),
        )
      : 1;

  const tiltedSurvival = (cycle: number): number => {
    const hazard = 1 - perCycleSurvival(cycle);
    const tilted = Math.min(0.95, hazard * riskTilt);
    return 1 - tilted;
  };

  const haircut = Math.min(100, Math.max(0, input.refundHaircutPct)) / 100;
  const renewalsBilled = Math.max(0, Math.floor(input.currentCycle));

  const horizons = {} as Record<LtgpHorizonKey, PredictedLtgpHorizon>;
  for (const horizon of LTGP_PREDICTION_HORIZONS) {
    // Charges inside the window: the origin charge at day 0 (already
    // realized — every countable contract was born from a paid checkout)
    // plus one renewal per cycleDays. Renewals up to ordersCount happened
    // with probability 1; each further renewal k decays by the tilted
    // renewal-space survival s(k) — s(1) being the origin→first-renewal
    // transition, the steepest hazard on the curve.
    const totalRenewals = Math.floor(horizon.days / cycleDays);
    const totalCharges = 1 + totalRenewals;
    const realizedCharges = Math.min(1 + renewalsBilled, totalCharges);
    let expectedCycles = realizedCharges;
    let reachProbability = 1;
    for (let renewal = renewalsBilled + 1; renewal <= totalRenewals; renewal++) {
      reachProbability *= tiltedSurvival(renewal);
      expectedCycles += reachProbability;
    }
    const cents = Math.round(
      expectedCycles * input.cycleGpCents * (1 - haircut),
    );
    horizons[horizon.key] = {
      cents,
      expectedCycles: Math.round(expectedCycles * 100) / 100,
      grade: ltgpHorizonGrade({
        horizonDays: horizon.days,
        observedSpanDays: input.observedSpanDays,
        curveContracts: input.curveContracts,
      }),
    };
  }

  return {
    v: 1,
    computedAt: input.computedAt.toISOString(),
    currencyCode: input.currencyCode,
    cycleDays,
    cycleGpCents: input.cycleGpCents,
    riskTilt: Math.round(riskTilt * 100) / 100,
    horizons,
    basis: {
      estimatedCosts: input.estimatedCosts,
      refundHaircutPct: Math.round(input.refundHaircutPct * 10) / 10,
      curveContracts: input.curveContracts,
      observedSpanDays: Math.round(input.observedSpanDays),
      scorer: input.scorer,
    },
  };
}

/** Days per charge cycle from the exact mirrored cadence (week fallback). */
export function contractCycleDays(contract: {
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
}): number {
  const freq = contractFrequency(contract);
  switch (freq.unit) {
    case "DAY":
      return Math.max(1, freq.count);
    case "MONTH":
      return freq.count * DAYS_PER_MONTH;
    case "WEEK":
    default:
      return freq.count * 7;
  }
}

interface CycleGpResult {
  cycleGpCents: number;
  estimated: boolean;
}

/** One cycle's expected gross profit for a live contract, via the shared cost model. */
function expectedCycleGp(
  ctx: CostContext,
  contract: {
    deliveryPriceCents: number;
    isPrepaid: boolean;
    prepaidDeliveriesPerCharge: number | null;
    deliveryAddress: unknown;
    acqCountryCode: string | null;
    lines: Array<{
      productId: string;
      variantId: string;
      quantity: number;
      currentPriceCents: number;
      unitCostCents: number | null;
      isGift: boolean;
      isOneTimeAddon: boolean;
    }>;
  },
): CycleGpResult {
  // One-time add-ons settle once and are not recurring value; gifts carry
  // cost but no revenue (the snapshot skips their COGS by design — gift cost
  // is booked per grant on the cohort surface, not per predicted cycle).
  const recurringLines = contract.lines.filter((line) => !line.isOneTimeAddon);
  const snapshot = computeChargeCostSnapshot(ctx, {
    deliveryPriceCents: contract.deliveryPriceCents,
    isPrepaid: contract.isPrepaid,
    prepaidDeliveriesPerCharge: contract.prepaidDeliveriesPerCharge,
    lines: recurringLines,
  });
  const deliveries = Math.max(1, snapshot.deliveriesPerCharge);
  const itemRevenue = recurringLines.reduce(
    (sum, line) =>
      line.isGift ? sum : sum + line.currentPriceCents * line.quantity,
    0,
  );
  const revenue =
    itemRevenue * deliveries + contract.deliveryPriceCents * deliveries;
  const fee = paymentFeeCents(revenue, ctx.costModel);
  const vat = resolveChargeVat(
    {
      netAmountCents: revenue,
      grossAmountCents: revenue,
      capturedTaxCents: null,
      countryCode: contractTaxCountry(contract),
    },
    ctx.costModel,
  );
  const cycleGpCents =
    revenue -
    snapshot.cogsCents -
    snapshot.shippingCostCents -
    snapshot.fulfillmentCostCents -
    fee -
    vat.vatCents;
  return {
    cycleGpCents,
    estimated: snapshot.estimatedCogsCents > 0 || vat.estimated,
  };
}

/**
 * Expected-refund haircut: the share of recent successful payments the
 * refund-exclusion setting would drop. Thin data (< 20 payments) reads 0 —
 * no haircut is claimed on noise. With the setting off, refunds net against
 * revenue instead; the haircut approximates that too (documented blur: the
 * netting mode's true haircut is refund cents, not payment count — accepted,
 * the mode is rarely off and the basis discloses the percentage applied).
 */
async function recentRefundHaircutPct(
  shopId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - 180 * DAY_MS);
  const [total, refunded] = await Promise.all([
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "SUCCESS",
        completedAt: { gte: cutoff },
      },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "SUCCESS",
        completedAt: { gte: cutoff },
        refundedCents: { gt: 0 },
      },
    }),
  ]);
  if (total < 20) return 0;
  return (refunded / total) * 100;
}

/** Strip the timestamp so an unchanged prediction skips its write. */
function comparableValue(value: PredictedLtgpValue): string {
  const { computedAt: _computedAt, ...rest } = value;
  return JSON.stringify(rest);
}

/**
 * Nightly scoring pass (predicted_ltgp_run step "scoring"): recompute the
 * five-horizon prediction for every countable ACTIVE contract in the shop
 * currency, stamp day-one initials, and skip unchanged rows. PAUSED
 * contracts keep their last prediction (billing is stopped; extrapolating a
 * paused clock would be fiction) — predictedLtgpAt shows the staleness.
 */
export async function runPredictedLtgpScoring(
  shopId: string,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const shop = await requireShopById(shopId);
  const [ctx, curve, analyticsSettings, oldest] = await Promise.all([
    loadCostContext(shopId),
    getSurvivalByCycle(shopId),
    getSetting(shopId, "analytics"),
    prisma.subscriptionContract.aggregate({
      where: { shopId, ...COUNTABLE_CONTRACT },
      _min: { firstChargeAt: true, createdAt: true },
    }),
  ]);
  const refundHaircutPct = analyticsSettings.excludeRefundedPayments
    ? await recentRefundHaircutPct(shopId, now).catch(() => 0)
    : 0;

  const bookBirth =
    oldest._min.firstChargeAt ?? oldest._min.createdAt ?? now;
  const observedSpanDays = Math.max(
    0,
    (now.getTime() - bookBirth.getTime()) / DAY_MS,
  );

  const riskStatus = await getSetting(shopId, "riskModel");
  const scorer: "heuristic" | "learned" | "none" =
    riskStatus.mode === "learned" ? "learned" : "heuristic";

  const contracts = await prisma.subscriptionContract.findMany({
    where: { shopId, status: "ACTIVE", ...COUNTABLE_CONTRACT },
    select: {
      id: true,
      ordersCount: true,
      churnRiskScore: true,
      currencyCode: true,
      deliveryPriceCents: true,
      isPrepaid: true,
      prepaidDeliveriesPerCharge: true,
      intervalWeeks: true,
      billingIntervalUnit: true,
      billingIntervalCount: true,
      deliveryAddress: true,
      acqCountryCode: true,
      firstChargeAt: true,
      createdAt: true,
      predictedLtgp: true,
      predictedLtgpInitial: true,
      lines: {
        select: {
          productId: true,
          variantId: true,
          quantity: true,
          currentPriceCents: true,
          unitCostCents: true,
          isGift: true,
          isOneTimeAddon: true,
        },
      },
    },
  });

  const inCurrency = contracts.filter(
    (c) => c.currencyCode === shop.currencyCode,
  );
  const skippedCurrency = contracts.length - inCurrency.length;

  const riskValues = inCurrency
    .map((c) => c.churnRiskScore ?? 0)
    .filter((v) => Number.isFinite(v));
  const bookMeanRisk =
    riskValues.length > 0
      ? riskValues.reduce((a, b) => a + b, 0) / riskValues.length
      : null;

  let updated = 0;
  let unchanged = 0;
  let initialStamped = 0;
  const writes: Array<() => Prisma.PrismaPromise<unknown>> = [];

  for (const contract of inCurrency) {
    const gp = expectedCycleGp(ctx, contract);
    const value = computePredictedLtgp({
      currentCycle: contract.ordersCount,
      cycleGpCents: gp.cycleGpCents,
      cycleDays: contractCycleDays(contract),
      overallSurvival: curve.overall,
      curveContracts: curve.totalContracts,
      riskScore: contract.churnRiskScore,
      bookMeanRisk,
      refundHaircutPct,
      observedSpanDays,
      estimatedCosts: gp.estimated,
      scorer,
      currencyCode: shop.currencyCode,
      computedAt: now,
    });

    const arrival = contract.firstChargeAt ?? contract.createdAt;
    const ageDays = (now.getTime() - arrival.getTime()) / DAY_MS;
    const stampInitial =
      contract.predictedLtgpInitial == null &&
      ageDays <= INITIAL_STAMP_MAX_AGE_DAYS;

    const stored = parsePredictedLtgp(contract.predictedLtgp);
    if (
      !stampInitial &&
      stored != null &&
      comparableValue(stored) === comparableValue(value)
    ) {
      unchanged += 1;
      continue;
    }

    if (stampInitial) initialStamped += 1;
    updated += 1;
    const valueJson = value as unknown as Prisma.InputJsonValue;
    writes.push(() =>
      prisma.subscriptionContract.update({
        where: { id: contract.id },
        data: {
          predictedLtgp: valueJson,
          predictedLtgpAt: now,
          ...(stampInitial ? { predictedLtgpInitial: valueJson } : {}),
        },
      }),
    );
  }

  const BATCH = 50;
  for (let i = 0; i < writes.length; i += BATCH) {
    await prisma.$transaction(writes.slice(i, i + BATCH).map((w) => w()));
  }

  return {
    scored: inCurrency.length,
    updated,
    unchanged,
    initialStamped,
    skippedCurrency,
    refundHaircutPct: Math.round(refundHaircutPct * 10) / 10,
    curveContracts: curve.totalContracts,
  };
}

/**
 * Accuracy pass (predicted_ltgp_run step "accuracy"): for contracts whose
 * frozen day-one prediction exists and whose horizon window has fully
 * elapsed, measure actual realized gross profit over that window — origin
 * payment (once, the originPaymentCountsOnce rule) plus successful renewal
 * charges, each valued through the same cost model the cohorts use (stored
 * cost snapshots first, live resolution as fallback) — and persist the
 * per-horizon error summary to the machine-written `ltgpAccuracy` setting.
 *
 * Error metric: absolute percentage error against a £10 floor denominator
 * (tiny actuals would otherwise explode the mean); bias keeps the sign
 * (positive = the model over-promised). Terminal contracts stay measurable —
 * churned early IS the outcome being scored.
 */
export async function runLtgpAccuracy(
  shopId: string,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const shop = await requireShopById(shopId);
  const [ctx, analyticsSettings] = await Promise.all([
    loadCostContext(shopId),
    getSetting(shopId, "analytics"),
  ]);
  const excludeRefunded = analyticsSettings.excludeRefundedPayments;

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      ...COUNTABLE_CONTRACT,
      predictedLtgpInitial: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      currencyCode: true,
      firstChargeAt: true,
      createdAt: true,
      predictedLtgpInitial: true,
      deliveryPriceCents: true,
      isPrepaid: true,
      prepaidDeliveriesPerCharge: true,
      deliveryAddress: true,
      acqCountryCode: true,
      originOrderId: true,
      originOrderTotalCents: true,
      originOrderRefundedCents: true,
      originOrderProcessedAt: true,
      originOrderCurrencyCode: true,
      lines: {
        select: {
          productId: true,
          variantId: true,
          quantity: true,
          currentPriceCents: true,
          unitCostCents: true,
          isGift: true,
          isOneTimeAddon: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });

  const measurable = contracts.filter(
    (c) =>
      c.currencyCode === shop.currencyCode &&
      parsePredictedLtgp(c.predictedLtgpInitial) != null,
  );
  if (measurable.length === 0) {
    return { measured: 0, reason: "no_initial_predictions" };
  }

  const attempts = await prisma.billingAttempt.findMany({
    where: {
      contractId: { in: measurable.map((c) => c.id) },
      status: "SUCCESS",
    },
    select: {
      contractId: true,
      orderId: true,
      amountCents: true,
      currencyCode: true,
      refundedCents: true,
      taxCents: true,
      completedAt: true,
      orderProcessedAt: true,
      costSnapshot: true,
    },
  });
  const attemptsByContract = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const list = attemptsByContract.get(attempt.contractId) ?? [];
    list.push(attempt);
    attemptsByContract.set(attempt.contractId, list);
  }

  const APE_FLOOR_CENTS = 1000;
  const sums = new Map<
    LtgpHorizonKey,
    { matured: number; apeSum: number; biasSum: number }
  >();

  for (const contract of measurable) {
    const predicted = parsePredictedLtgp(contract.predictedLtgpInitial);
    if (!predicted) continue;
    const arrival = contract.firstChargeAt ?? contract.createdAt;
    const contractAttempts = attemptsByContract.get(contract.id) ?? [];
    const successfulOrderIds = new Set(
      contractAttempts
        .map((a) => a.orderId)
        .filter((id): id is string => id != null),
    );

    for (const horizon of LTGP_PREDICTION_HORIZONS) {
      const windowEnd = arrival.getTime() + horizon.days * DAY_MS;
      if (windowEnd > now.getTime()) continue; // not matured yet

      let actual = 0;

      // Origin payment, once, in shop currency, refund rule applied.
      if (
        originPaymentCountsOnce(contract, successfulOrderIds, shop.currencyCode)
      ) {
        const refunded = contract.originOrderRefundedCents > 0;
        if (!(excludeRefunded && refunded)) {
          const originRevenue =
            (contract.originOrderTotalCents ?? 0) -
            (excludeRefunded ? 0 : contract.originOrderRefundedCents);
          if (originRevenue > 0) {
            const snapshot = computeChargeCostSnapshot(ctx, {
              deliveryPriceCents: contract.deliveryPriceCents,
              isPrepaid: contract.isPrepaid,
              prepaidDeliveriesPerCharge: contract.prepaidDeliveriesPerCharge,
              lines: contract.lines.filter((l) => !l.isOneTimeAddon),
            });
            const fee = paymentFeeCents(originRevenue, ctx.costModel);
            const vat = resolveChargeVat(
              {
                netAmountCents: originRevenue,
                grossAmountCents: originRevenue,
                capturedTaxCents: null,
                countryCode: contractTaxCountry(contract),
              },
              ctx.costModel,
            );
            actual +=
              originRevenue -
              snapshot.cogsCents -
              snapshot.shippingCostCents -
              snapshot.fulfillmentCostCents -
              fee -
              vat.vatCents;
          }
        }
      }

      for (const attempt of contractAttempts) {
        const at = attempt.orderProcessedAt ?? attempt.completedAt;
        if (!at || at.getTime() > windowEnd) continue;
        if (attempt.currencyCode && attempt.currencyCode !== shop.currencyCode)
          continue;
        const refunded = attempt.refundedCents > 0;
        if (excludeRefunded && refunded) continue;
        const revenue =
          (attempt.amountCents ?? 0) -
          (excludeRefunded ? 0 : attempt.refundedCents);
        if (revenue <= 0) continue;
        const snapshot =
          parseChargeCostSnapshot(attempt.costSnapshot) ??
          computeChargeCostSnapshot(ctx, {
            deliveryPriceCents: contract.deliveryPriceCents,
            isPrepaid: contract.isPrepaid,
            prepaidDeliveriesPerCharge: contract.prepaidDeliveriesPerCharge,
            lines: contract.lines.filter((l) => !l.isOneTimeAddon),
          });
        const fee = paymentFeeCents(revenue, ctx.costModel);
        const vat = resolveChargeVat(
          {
            netAmountCents: revenue,
            grossAmountCents: revenue,
            capturedTaxCents: attempt.taxCents,
            countryCode: contractTaxCountry(contract),
          },
          ctx.costModel,
        );
        actual +=
          revenue -
          snapshot.cogsCents -
          snapshot.shippingCostCents -
          snapshot.fulfillmentCostCents -
          fee -
          vat.vatCents;
      }

      const predictedCents = predicted.horizons[horizon.key].cents;
      const denom = Math.max(Math.abs(actual), APE_FLOOR_CENTS);
      const signedError = (predictedCents - actual) / denom;
      const entry = sums.get(horizon.key) ?? {
        matured: 0,
        apeSum: 0,
        biasSum: 0,
      };
      entry.matured += 1;
      entry.apeSum += Math.abs(signedError);
      entry.biasSum += signedError;
      sums.set(horizon.key, entry);
    }
  }

  const horizons: Record<
    string,
    { matured: number; mapePct: number | null; biasPct: number | null }
  > = {};
  for (const [key, entry] of sums) {
    horizons[key] = {
      matured: entry.matured,
      mapePct:
        entry.matured > 0
          ? Math.round((entry.apeSum / entry.matured) * 1000) / 10
          : null,
      biasPct:
        entry.matured > 0
          ? Math.round((entry.biasSum / entry.matured) * 1000) / 10
          : null,
    };
  }

  await setSetting(
    shopId,
    "ltgpAccuracy",
    { version: 1, updatedAt: now.toISOString(), horizons },
    "system:predicted_ltgp_run",
  );

  return {
    measured: measurable.length,
    horizons,
  };
}

export interface PredictedLtgpCohortRow {
  cohortMonth: string;
  contracts: number;
  avgCents: Record<LtgpHorizonKey, number | null>;
}

export interface PredictedLtgpSummary {
  cohorts: PredictedLtgpCohortRow[];
  overall: { contracts: number; avgCents: Record<LtgpHorizonKey, number | null> };
  accuracy: SettingsValue<"ltgpAccuracy">;
}

/**
 * Aggregate view for the admin Cohorts & LTGP tab: average predicted LTGP
 * per signup-month cohort (newest 12) and overall, over live predictions.
 * Accepts the segment layer's contractIds narrowing (same convention as
 * every other engine).
 */
export async function getPredictedLtgpSummary(
  shopId: string,
  opts: { contractIds?: readonly string[] | null; now?: Date } = {},
): Promise<PredictedLtgpSummary> {
  const now = opts.now ?? new Date();
  const shop = await requireShopById(shopId);
  const [rows, accuracy] = await Promise.all([
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        ...COUNTABLE_CONTRACT,
        predictedLtgp: { not: Prisma.DbNull },
        ...(opts.contractIds != null
          ? { id: { in: [...opts.contractIds] } }
          : {}),
      },
      select: {
        predictedLtgp: true,
        firstChargeAt: true,
        createdAt: true,
      },
    }),
    getSetting(shopId, "ltgpAccuracy"),
  ]);

  const byCohort = new Map<
    string,
    { count: number; sums: Map<LtgpHorizonKey, number> }
  >();
  const overallSums = new Map<LtgpHorizonKey, number>();
  let overallCount = 0;

  for (const row of rows) {
    const value = parsePredictedLtgp(row.predictedLtgp);
    if (!value) continue;
    const cohort = ymKey(row.firstChargeAt ?? row.createdAt, shop.ianaTimezone);
    const entry =
      byCohort.get(cohort) ?? { count: 0, sums: new Map<LtgpHorizonKey, number>() };
    entry.count += 1;
    overallCount += 1;
    for (const { key } of LTGP_PREDICTION_HORIZONS) {
      entry.sums.set(key, (entry.sums.get(key) ?? 0) + value.horizons[key].cents);
      overallSums.set(key, (overallSums.get(key) ?? 0) + value.horizons[key].cents);
    }
    byCohort.set(cohort, entry);
  }

  const avg = (
    sums: Map<LtgpHorizonKey, number>,
    count: number,
  ): Record<LtgpHorizonKey, number | null> => {
    const out = {} as Record<LtgpHorizonKey, number | null>;
    for (const { key } of LTGP_PREDICTION_HORIZONS) {
      const sum = sums.get(key);
      out[key] = count > 0 && sum != null ? Math.round(sum / count) : null;
    }
    return out;
  };

  const cohorts = [...byCohort.entries()]
    .sort((a, b) => ymIndex(b[0]) - ymIndex(a[0]))
    .slice(0, 12)
    .map(([cohortMonth, entry]) => ({
      cohortMonth,
      contracts: entry.count,
      avgCents: avg(entry.sums, entry.count),
    }));

  return {
    cohorts,
    overall: { contracts: overallCount, avgCents: avg(overallSums, overallCount) },
    accuracy,
  };
}
