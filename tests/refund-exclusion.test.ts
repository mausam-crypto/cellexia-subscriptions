import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Refund exclusion (v1.16.0, analytics.excludeRefundedPayments — the shipped
 * DEFAULT). A payment with ANY recorded refund — partial or full, renewal or
 * origin — leaves the analytics entirely: revenue, COGS, shipping, fees and
 * billed-cycle count alike, on BOTH gross-profit surfaces. The refundedCents
 * columns keep being written as disclosure but stop participating in gross
 * profit (the excluded charges never entered chargedCents, so subtracting
 * their refunds too would double-drop the money).
 *
 * The suite pins:
 *  - the DEFAULT applies with no stored setting row (upgrade behavior);
 *  - golden rollup numbers under exclusion, including the no-double-
 *    subtraction gross-profit rule;
 *  - golden cohort numbers under exclusion (costs and billedCycles drop with
 *    the payment);
 *  - the off-mode netting math still reachable via the setting (spot check —
 *    tests/analytics-formulas.test.ts holds the full netting goldens).
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("~/db.server", () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        const client = dbHolder.current;
        if (!client) {
          throw new Error(`fake db not initialised (accessed ${String(prop)})`);
        }
        return client[prop as string];
      },
    },
  ),
}));

import {
  repairRefundAffectedRollupDays,
  runDailyRollup,
} from "~/lib/analytics/rollup.server";
import { runCohortComputation } from "~/lib/analytics/cohorts.server";
import { getSegmentForecast } from "~/lib/analytics/segment-views.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

// ── Fixture ──────────────────────────────────────────────────────────────────

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};

// VAT explicitly off — this suite isolates the refund-exclusion math;
// tests/vat-cost.test.ts holds the VAT goldens.
const COST_MODEL = {
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
  fulfillmentCostPerShipmentCents: 150,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
  cogsFallbackPctOfPrice: 25,
  vat: { enabled: false, defaultRatePct: 0, countryRatesPct: {} },
};

const DAY = new Date("2026-08-05T12:00:00Z");
const NOW = new Date("2026-08-05T12:00:00Z");

function D(iso: string): Date {
  return new Date(iso);
}

/** One known-cost line: price 5000, unit cost 1000 → per-cycle COGS 1000. */
const LINE = {
  productId: "p1",
  variantId: "v1",
  title: "Serum",
  quantity: 1,
  currentPriceCents: 5000,
  compareAtPriceCents: null,
  unitCostCents: 1000,
  isGift: false,
  isOneTimeAddon: false,
};

function contractRow(id: string, over: Row): Row {
  return {
    id,
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    cancelSource: null,
    cancelledAt: null,
    failedAt: null,
    expiredAt: null,
    createdAt: D("2026-06-01T08:00:00Z"),
    firstChargeAt: D("2026-06-10T10:00:00Z"),
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    deliveryAddress: null,
    acqCountryCode: null,
    originOrderId: null,
    originOrderTotalCents: null,
    originOrderDiscountCents: null,
    originOrderTaxCents: null,
    originOrderRefundedCents: 0,
    originOrderProcessedAt: null,
    originOrderCurrencyCode: null,
    ordersCount: 2,
    lines: [LINE],
    ...over,
  };
}

function attemptRow(id: string, contract: Row, over: Row): Row {
  return {
    id,
    contractId: contract.id,
    contract,
    status: "SUCCESS",
    amountCents: 0,
    refundedCents: 0,
    currencyCode: "CHF",
    taxCents: null,
    discountCents: null,
    costSnapshot: null,
    completedAt: null,
    orderId: null,
    ...over,
  };
}

/**
 * Golden shop (CHF, VAT off, per-charge costs COGS 1000 + shipping 350 +
 * fees 2.9%+30):
 *
 * cRenewals (cohort 2026-06, attempts complete 2026-08-05 → offset 2):
 *   a_clean   5000, no refund       → INCLUDED everywhere
 *   a_partial 5000, refunded 100    → EXCLUDED under the default
 *   a_full    5000, refunded 5000   → EXCLUDED under the default
 * cOriginRefunded (cohort 2026-08): origin 6000, refunded 500 → EXCLUDED
 * cOriginClean    (cohort 2026-08): origin 7000, no refund    → INCLUDED
 *
 * Exclusion-ON rollup day 2026-08-05:
 *   charged 5000 + 7000 = 12000
 *   refundedCents (disclosure, refund events recorded in-day) = 5600
 *   COGS 1000 × 2 = 2000 · shipping 350 × 2 = 700
 *   fees (145+30) + (203+30) = 408
 *   estGrossProfit = 12000 − 2000 − 700 − 408 = 8892  ← refunds NOT
 *   subtracted again (the excluded charges never entered chargedCents)
 *
 * Netting-OFF rollup day (setting off):
 *   charged 5000×3 + 6000 + 7000 = 28000 · refunded 5600
 *   COGS 5×1000 = 5000 · shipping 5×350 = 1750
 *   fees 175×3 + 204 + 233 = 962
 *   estGrossProfit = 28000 − 5600 − 5000 − 1750 − 962 = 14688
 */
function buildStore(opts: { setting?: boolean | null } = {}): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });
  // setting: undefined/null → NO analytics row stored (the upgrade case —
  // the zod default must apply); boolean → stored row with that value.
  if (opts.setting != null) {
    store.settings.push({
      shopId: SHOP_ID,
      key: "analytics",
      value: { excludeRefundedPayments: opts.setting },
    });
  }

  const cRenewals = contractRow("c_renewals", {});
  const cOriginRefunded = contractRow("c_origin_refunded", {
    firstChargeAt: D("2026-08-05T08:00:00Z"),
    originOrderId: "gid://shopify/Order/801",
    originOrderTotalCents: 6000,
    originOrderRefundedCents: 500,
    originOrderProcessedAt: D("2026-08-05T08:00:00Z"),
    originOrderCurrencyCode: "CHF",
  });
  const cOriginClean = contractRow("c_origin_clean", {
    firstChargeAt: D("2026-08-05T08:30:00Z"),
    originOrderId: "gid://shopify/Order/802",
    originOrderTotalCents: 7000,
    originOrderRefundedCents: 0,
    originOrderProcessedAt: D("2026-08-05T08:30:00Z"),
    originOrderCurrencyCode: "CHF",
  });
  store.subscriptionContracts.push(cRenewals, cOriginRefunded, cOriginClean);

  store.billingAttempts.push(
    attemptRow("a_clean", cRenewals, {
      amountCents: 5000,
      completedAt: D("2026-08-05T09:00:00Z"),
    }),
    attemptRow("a_partial", cRenewals, {
      amountCents: 5000,
      refundedCents: 100,
      completedAt: D("2026-08-05T10:00:00Z"),
    }),
    attemptRow("a_full", cRenewals, {
      amountCents: 5000,
      refundedCents: 5000,
      completedAt: D("2026-08-05T11:00:00Z"),
    }),
  );

  // The refund-day disclosure column reads refund_recorded events.
  const refundEvent = (id: string, contract: Row, amountCents: number): Row => ({
    id,
    shopId: SHOP_ID,
    type: "admin.action",
    contractId: contract.id as string,
    contract,
    createdAt: D("2026-08-05T12:30:00Z"),
    payload: {
      action: "refund_recorded",
      amountCents,
      currencyCode: "CHF",
    },
  });
  store.subscriberEvents.push(
    refundEvent("e_refund_partial", cRenewals, 100),
    refundEvent("e_refund_full", cRenewals, 5000),
    refundEvent("e_refund_origin", cOriginRefunded, 500),
  );
  return store;
}

// ── Default ──────────────────────────────────────────────────────────────────

describe("analytics settings default", () => {
  it("excludeRefundedPayments defaults ON (merchant decision, v1.16.0)", () => {
    expect(settingsSchemas.analytics.parse(undefined)).toEqual({
      excludeRefundedPayments: true,
    });
  });
});

// ── Rollup ───────────────────────────────────────────────────────────────────

describe("runDailyRollup — refund exclusion (the default, golden)", () => {
  it("drops partially AND fully refunded payments — revenue and costs alike — with no stored setting row", async () => {
    const store = buildStore(); // no analytics row → zod default applies
    dbHolder.current = createAnalyticsDb(store) as never;
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;

    expect(row.chargedCents).toBe(12_000); // a_clean 5000 + clean origin 7000
    expect(row.refundedCents).toBe(5600); // disclosure column keeps recording
    expect(row.feesCents).toBe(408); // fees only on the included payments
    expect(row.shippingCostCents).toBe(700);
    expect(row.estGrossProfitCents).toBe(8892); // 12000−2000−700−408, NO −5600
  });

  it("with the setting off, the pre-v1.16.0 netting math is byte-identical", async () => {
    const store = buildStore({ setting: false });
    dbHolder.current = createAnalyticsDb(store) as never;
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;

    expect(row.chargedCents).toBe(28_000);
    expect(row.refundedCents).toBe(5600);
    expect(row.feesCents).toBe(962);
    expect(row.shippingCostCents).toBe(1750);
    expect(row.estGrossProfitCents).toBe(14_688); // 28000−5600−5000−1750−962
  });
});

// ── Cohorts ──────────────────────────────────────────────────────────────────

describe("runCohortComputation — refund exclusion (the default, golden)", () => {
  it("drops refunded payments from cells entirely, billedCycles included", async () => {
    const store = buildStore();
    dbHolder.current = createAnalyticsDb(store) as never;
    await runCohortComputation(SHOP_ID, NOW);

    // cRenewals: cohort 2026-06, attempts land at offset 2 — only a_clean.
    const renewalCell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-06" && c.monthOffset === 2,
    ) as Row;
    expect(renewalCell.revenueCents).toBe(5000);
    expect(renewalCell.refundedCents).toBe(0); // excluded, not netted
    // a_partial/a_full dropped whole: their COGS/fees are gone too.
    expect(renewalCell.cogsCents).toBe(1000);
    expect(renewalCell.feesCents).toBe(175);
    // 5000 − 1000 − 350 − 175 = 3475
    expect(renewalCell.grossProfitCents).toBe(3475);

    // 2026-08 month 0: the refunded origin payment is gone; only the clean
    // origin books (7000 − 1000 − 350 − 233 = 5417).
    const originCell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-08" && c.monthOffset === 0,
    ) as Row;
    expect(originCell.revenueCents).toBe(7000);
    expect(originCell.refundedCents).toBe(0);
    expect(originCell.grossProfitCents).toBe(5417);
  });

  it("with the setting off, refunded payments net instead (spot check)", async () => {
    const store = buildStore({ setting: false });
    dbHolder.current = createAnalyticsDb(store) as never;
    await runCohortComputation(SHOP_ID, NOW);

    const renewalCell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-06" && c.monthOffset === 2,
    ) as Row;
    // 5000 + (5000−100) + (5000−5000) = 9900 — every payment still books.
    expect(renewalCell.revenueCents).toBe(9900);
    expect(renewalCell.refundedCents).toBe(5100);
    expect(renewalCell.cogsCents).toBe(3000); // netting keeps full costs

    const originCell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-08" && c.monthOffset === 0,
    ) as Row;
    // (6000−500) + 7000 — the refunded origin nets, everything still books.
    expect(originCell.revenueCents).toBe(12_500);
    expect(originCell.refundedCents).toBe(500);
  });
});

// ── Repair helper ────────────────────────────────────────────────────────────

describe("repairRefundAffectedRollupDays", () => {
  it("re-upserts the refunded payments' charge day under the CURRENT mode (exclusion)", async () => {
    const store = buildStore();
    // Pre-existing history: the shop's first rollup predates the charge day
    // (the helper never synthesizes pre-analytics days).
    store.dailyRollups.push({
      shopId: SHOP_ID,
      date: new Date("2026-06-01T00:00:00.000Z"),
      chargedCents: 0,
    });
    dbHolder.current = createAnalyticsDb(store) as never;

    const repaired = await repairRefundAffectedRollupDays(SHOP_ID);
    // a_partial/a_full and the refunded origin all sit on 2026-08-05 —
    // one distinct repair day.
    expect(repaired).toBe(1);
    const row = store.dailyRollups.find(
      (r) => (r.date as Date).toISOString() === "2026-08-05T00:00:00.000Z",
    ) as Row;
    expect(row.chargedCents).toBe(12_000); // exclusion semantics applied
  });

  it("restores NETTING figures after the toggle flips off (the settings-save repair)", async () => {
    const store = buildStore({ setting: false });
    store.dailyRollups.push(
      { shopId: SHOP_ID, date: new Date("2026-06-01T00:00:00.000Z"), chargedCents: 0 },
      // The day was previously written under exclusion (charged 12 000);
      // the toggle-off repair must rewrite it to netting semantics.
      {
        shopId: SHOP_ID,
        date: new Date("2026-08-05T00:00:00.000Z"),
        chargedCents: 12_000,
      },
    );
    dbHolder.current = createAnalyticsDb(store) as never;

    const repaired = await repairRefundAffectedRollupDays(SHOP_ID, {
      includeRefundRecordedDays: true,
    });
    expect(repaired).toBe(1);
    const row = store.dailyRollups.find(
      (r) => (r.date as Date).toISOString() === "2026-08-05T00:00:00.000Z",
    ) as Row;
    expect(row.chargedCents).toBe(28_000); // netting semantics restored
    expect(row.refundedCents).toBe(5600);
  });

  it("is a no-op when the shop has no rollup history at all", async () => {
    const store = buildStore();
    dbHolder.current = createAnalyticsDb(store) as never;
    expect(await repairRefundAffectedRollupDays(SHOP_ID)).toBe(0);
  });
});

// ── Segment forecast (the fourth lockstep surface) ───────────────────────────

describe("getSegmentForecast — refund exclusion", () => {
  // Late enough that the charge week (Aug 3–9) is a COMPLETE calendar week.
  const SEG_NOW = new Date("2026-08-20T12:00:00Z");
  const IDS = ["c_renewals", "c_origin_refunded", "c_origin_clean"];

  async function reconstructedRevenueTotal(store: AnalyticsStore): Promise<number> {
    dbHolder.current = createAnalyticsDb(store) as never;
    const forecast = await getSegmentForecast(SHOP_ID, IDS, { now: SEG_NOW });
    return forecast.series.netRevenueCents.history.reduce(
      (sum, p) => sum + p.value,
      0,
    );
  }

  it("drops refunded payments from the reconstructed series under the default", async () => {
    // a_clean 5000 + clean origin 7000 — same population the rollup counts.
    expect(await reconstructedRevenueTotal(buildStore())).toBe(12_000);
  });

  it("nets refunds instead when the setting is off", async () => {
    // 5000 + 4900 + 0 + (6000−500) + 7000.
    expect(
      await reconstructedRevenueTotal(buildStore({ setting: false })),
    ).toBe(22_400);
  });
});
