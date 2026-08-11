import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Golden numeric tests for the analytics COST MODEL
 * (app/lib/analytics/costs.server.ts) — the one place per-line COGS,
 * per-shipment fulfillment/shipping cost and payment fees are resolved.
 *
 * Everything is asserted in exact integer cents. The DB seam is the in-memory
 * interpreter from tests/helpers/analytics-db.ts, so getCostCoverage and the
 * net-of-refunds check run the REAL queries (ownership + status filters
 * included) rather than canned mock returns.
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
  EMPTY_OVERRIDES,
  getCostCoverage,
  paymentFeeCents,
  perCycleLineCosts,
  perShipmentCostCents,
  resolveLineCogs,
  type CostContext,
  type CostModelSettings,
  type LineForCogs,
} from "~/lib/analytics/costs.server";
import { runCohortComputation } from "~/lib/analytics/cohorts.server";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SHOP_ID = "shop_1";

/** Deliberately non-default values so defaults passing by accident is impossible. */
const COST_MODEL: CostModelSettings = {
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
  fulfillmentCostPerShipmentCents: 150,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
  cogsFallbackPctOfPrice: 25,
  vat: { enabled: false, defaultRatePct: 0, countryRatesPct: {} },
};

function ctxWith(
  overrides: Partial<{
    byVariant: [string, number][];
    byProduct: [string, number][];
    costModel: Partial<CostModelSettings>;
  }> = {},
): CostContext {
  return {
    costModel: { ...COST_MODEL, ...overrides.costModel },
    overrides: {
      byVariant: new Map(overrides.byVariant ?? []),
      byProduct: new Map(overrides.byProduct ?? []),
    },
  };
}

function line(overrides: Partial<LineForCogs> = {}): LineForCogs {
  return {
    productId: "p1",
    variantId: "v1",
    quantity: 1,
    currentPriceCents: 4990,
    unitCostCents: null,
    isGift: false,
    ...overrides,
  };
}

// ── resolveLineCogs: resolution order ─────────────────────────────────────────

describe("resolveLineCogs resolution order", () => {
  it("synced Shopify cost wins over both override levels", () => {
    const ctx = ctxWith({
      byVariant: [["p1|v1", 100]],
      byProduct: [["p1", 50]],
    });
    expect(resolveLineCogs(line({ unitCostCents: 700 }), ctx)).toEqual({
      unitCostCents: 700,
      source: "SHOPIFY",
      estimated: false,
    });
  });

  it("a synced cost of 0 is a KNOWN zero, not a missing value", () => {
    // 0 cents is a legitimate cost (e.g. digital freebie); only null is unknown.
    const ctx = ctxWith({ byVariant: [["p1|v1", 100]] });
    expect(resolveLineCogs(line({ unitCostCents: 0 }), ctx)).toEqual({
      unitCostCents: 0,
      source: "SHOPIFY",
      estimated: false,
    });
  });

  it("variant-level override beats product-level override when the cost is unsynced", () => {
    const ctx = ctxWith({
      byVariant: [["p1|v1", 850]],
      byProduct: [["p1", 999]],
    });
    expect(resolveLineCogs(line(), ctx)).toEqual({
      unitCostCents: 850,
      source: "OVERRIDE",
      estimated: false,
    });
  });

  it("falls through to the product-level override when no variant row exists", () => {
    const ctx = ctxWith({ byProduct: [["p1", 425]] });
    expect(resolveLineCogs(line(), ctx)).toEqual({
      unitCostCents: 425,
      source: "OVERRIDE",
      estimated: false,
    });
  });

  it("an override for a DIFFERENT variant/product does not leak", () => {
    const ctx = ctxWith({
      byVariant: [["p1|v2", 850]],
      byProduct: [["p2", 425]],
    });
    const resolved = resolveLineCogs(line(), ctx);
    expect(resolved.source).toBe("ESTIMATED");
  });

  it("last resort is the percentage-of-price estimate, rounded to the cent", () => {
    // 4990 × 25% = 1247.5 → rounds to 1248.
    expect(resolveLineCogs(line(), ctxWith())).toEqual({
      unitCostCents: 1248,
      source: "ESTIMATED",
      estimated: true,
    });
    // 999 × 12.5% = 124.875 → 125.
    expect(
      resolveLineCogs(
        line({ currentPriceCents: 999 }),
        ctxWith({ costModel: { cogsFallbackPctOfPrice: 12.5 } }),
      ).unitCostCents,
    ).toBe(125);
    // 0% fallback estimates 0 — never negative, never NaN.
    expect(
      resolveLineCogs(
        line(),
        ctxWith({ costModel: { cogsFallbackPctOfPrice: 0 } }),
      ).unitCostCents,
    ).toBe(0);
  });
});

// ── perCycleLineCosts: totals + fallback accounting ───────────────────────────

describe("perCycleLineCosts", () => {
  const lines: LineForCogs[] = [
    // Known synced cost: 1200 × qty 2 = 2400.
    line({ productId: "p1", variantId: "v1", quantity: 2, unitCostCents: 1200 }),
    // Estimated: 25% of 1500 = 375 × qty 2 = 750.
    line({ productId: "p2", variantId: "v2", quantity: 2, currentPriceCents: 1500 }),
    // Gift line with a synced cost of 999.
    line({ productId: "p3", variantId: "v3", currentPriceCents: 0, unitCostCents: 999, isGift: true }),
  ];

  it("sums known + estimated COGS and counts every fallback use", () => {
    expect(perCycleLineCosts(lines, ctxWith(), { includeGifts: false })).toEqual({
      cogsCents: 3150, // 2400 + 750
      estimatedCogsCents: 750, // only the fallback line
      linesEstimated: 1,
    });
  });

  it("includeGifts: true adds the gift line's cost (for callers that do not book gifts separately)", () => {
    expect(perCycleLineCosts(lines, ctxWith(), { includeGifts: true })).toEqual({
      cogsCents: 4149, // 3150 + 999
      estimatedCogsCents: 750,
      linesEstimated: 1,
    });
  });

  it("an empty cycle costs nothing and estimates nothing", () => {
    expect(perCycleLineCosts([], ctxWith(), { includeGifts: false })).toEqual({
      cogsCents: 0,
      estimatedCogsCents: 0,
      linesEstimated: 0,
    });
  });
});

// ── paymentFeeCents: 2.9% + 30c per charge ────────────────────────────────────

describe("paymentFeeCents", () => {
  it.each([
    [10_000, 320], // 290 + 30
    [8_490, 276], // round(246.21) = 246 + 30
    [1_550, 75], // round(44.95) = 45 + 30
    [2_500, 103], // round(72.5) = 73 + 30 (half-cent rounds up)
    [1, 30], // round(0.029) = 0 + 30
  ])("charge of %i cents costs %i cents in fees", (amount, expected) => {
    expect(paymentFeeCents(amount, COST_MODEL)).toBe(expected);
  });

  it("charges no fee (not even the fixed part) on zero or negative amounts", () => {
    expect(paymentFeeCents(0, COST_MODEL)).toBe(0);
    expect(paymentFeeCents(-500, COST_MODEL)).toBe(0);
  });

  it("percentage-only and fixed-only models compute independently", () => {
    expect(
      paymentFeeCents(10_000, { ...COST_MODEL, paymentFeeFixedCents: 0 }),
    ).toBe(290);
    expect(paymentFeeCents(10_000, { ...COST_MODEL, paymentFeePct: 0 })).toBe(30);
  });
});

// ── perShipmentCostCents ──────────────────────────────────────────────────────

describe("perShipmentCostCents", () => {
  it("flat mode: fulfillment + flat carrier cost, ignoring what the customer paid", () => {
    expect(perShipmentCostCents(COST_MODEL, 500)).toBe(350); // 150 + 200
    expect(perShipmentCostCents(COST_MODEL, 0)).toBe(350);
  });

  it("charged mode: fulfillment + the customer-paid delivery as pass-through cost", () => {
    const charged: CostModelSettings = {
      ...COST_MODEL,
      shippingCostPerShipmentCents: { mode: "charged", flatCents: 200 },
    };
    expect(perShipmentCostCents(charged, 500)).toBe(650); // 150 + 500
    expect(perShipmentCostCents(charged, 0)).toBe(150);
    // Negative delivery data can never produce a negative cost.
    expect(perShipmentCostCents(charged, -300)).toBe(150);
  });

  it("EMPTY_OVERRIDES is genuinely empty (safe default context)", () => {
    expect(EMPTY_OVERRIDES.byVariant.size).toBe(0);
    expect(EMPTY_OVERRIDES.byProduct.size).toBe(0);
  });
});

// ── getCostCoverage on a synthetic mixed dataset ──────────────────────────────

function coverageStore(): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({
    id: SHOP_ID,
    currencyCode: "CHF",
    ianaTimezone: "Europe/Zurich",
  });
  store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });
  // Pin the pre-v1.16.0 netting model: these fixtures exercise refunds as
  // NETTED (revenue minus refund, full costs kept). The shipped default is
  // exclusion — tests/refund-exclusion.test.ts pins that path.
  store.settings.push({
    shopId: SHOP_ID,
    key: "analytics",
    value: { excludeRefundedPayments: false },
  });
  // Product-level override for p2 → its lines count as KNOWN.
  store.productCadences.push({
    shopId: SHOP_ID,
    productId: "p2",
    variantId: null,
    unitCostCentsOverride: 250,
  });

  const contract = (id: string, over: Row): Row => ({
    id,
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    lines: [],
    ...over,
  });
  const covLine = (over: Row): Row => ({
    productId: "p1",
    variantId: "v1",
    title: "Serum",
    quantity: 1,
    currentPriceCents: 3000,
    compareAtPriceCents: null,
    unitCostCents: null,
    isGift: false,
    ...over,
  });

  store.subscriptionContracts.push(
    contract("k1", {
      lines: [
        covLine({ unitCostCents: 900 }), // known via synced cost — 3000 revenue
        covLine({ productId: "p2", variantId: "v2", title: "Mask", quantity: 2, currentPriceCents: 1000 }), // known via override — 2000 revenue
      ],
    }),
    contract("k2", {
      status: "PAUSED",
      lines: [
        covLine({ productId: "p3", variantId: "v3", title: "Cream", currentPriceCents: 2000 }), // estimated
        covLine({ productId: "p9", variantId: "v9", title: "Gift", currentPriceCents: 0, isGift: true }), // gift — excluded
      ],
    }),
    contract("k3", {
      lines: [
        covLine({ productId: "p3", variantId: "v3", title: "Cream", currentPriceCents: 1500 }), // estimated, SAME product → dedup
      ],
    }),
    // Everything below must be invisible to coverage:
    contract("k4", { status: "CANCELLED", lines: [covLine({ title: "Cancelled" })] }),
    contract("k5", { ownership: "FOREIGN", lines: [covLine({ title: "Foreign" })] }),
    contract("k6", { isDemo: true, lines: [covLine({ title: "Demo" })] }),
  );
  return store;
}

describe("getCostCoverage", () => {
  beforeEach(() => {
    dbHolder.current = createAnalyticsDb(coverageStore());
  });

  it("computes line and revenue coverage percentages exactly", async () => {
    const coverage = await getCostCoverage(SHOP_ID);
    // 4 countable non-gift lines, 2 known → 50.0% by lines.
    expect(coverage.totalLines).toBe(4);
    expect(coverage.linesWithKnownCogsPct).toBe(50);
    expect(coverage.coveragePct).toBe(50);
    expect(coverage.linesMissingCost).toBe(2);
    // Revenue-weighted: known 3000 + 2×1000 = 5000 of 8500 → 58.8%.
    expect(coverage.revenueWithKnownCogsPct).toBe(58.8);
  });

  it("lists each missing product ONCE with its identity, plus banner conveniences", async () => {
    const coverage = await getCostCoverage(SHOP_ID);
    expect(coverage.productsMissingCogs).toEqual([
      { productId: "p3", variantId: "v3", title: "Cream" },
    ]);
    expect(coverage.productsMissingCost).toBe(1);
    expect(coverage.sampleProductTitles).toEqual(["Cream"]);
  });

  it("never counts gift lines, cancelled books, demo fixtures or foreign contracts", async () => {
    const coverage = await getCostCoverage(SHOP_ID);
    // If any excluded population leaked, totalLines would exceed 4 and the
    // missing list would include "Cancelled"/"Foreign"/"Demo"/"Gift".
    expect(coverage.totalLines).toBe(4);
    const titles = coverage.productsMissingCogs.map((p) => p.title);
    expect(titles).not.toContain("Cancelled");
    expect(titles).not.toContain("Foreign");
    expect(titles).not.toContain("Demo");
    expect(titles).not.toContain("Gift");
  });

  it("reports 100% (not NaN) on a shop with no billed lines at all", async () => {
    const store = coverageStore();
    store.subscriptionContracts = [];
    dbHolder.current = createAnalyticsDb(store);
    const coverage = await getCostCoverage(SHOP_ID);
    expect(coverage.totalLines).toBe(0);
    expect(coverage.linesWithKnownCogsPct).toBe(100);
    expect(coverage.revenueWithKnownCogsPct).toBe(100);
    expect(coverage.productsMissingCogs).toEqual([]);
    expect(coverage.linesMissingCost).toBe(0);
  });
});

// ── Net-of-refunds revenue (shared formula, exercised through the cohort engine) ──

describe("net-of-refunds revenue", () => {
  function refundStore(): AnalyticsStore {
    const store = emptyStore();
    store.shops.push({
      id: SHOP_ID,
      currencyCode: "CHF",
      ianaTimezone: "Europe/Zurich",
    });
    store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });
  // Pin the pre-v1.16.0 netting model: these fixtures exercise refunds as
  // NETTED (revenue minus refund, full costs kept). The shipped default is
  // exclusion — tests/refund-exclusion.test.ts pins that path.
  store.settings.push({
    shopId: SHOP_ID,
    key: "analytics",
    value: { excludeRefundedPayments: false },
  });
    const contract: Row = {
      id: "cn",
      shopId: SHOP_ID,
      ownership: "OURS",
      isDemo: false,
      status: "ACTIVE",
      cancelledAt: null,
      failedAt: null,
      createdAt: new Date("2026-06-01T08:00:00Z"),
      firstChargeAt: new Date("2026-06-10T10:00:00Z"),
      currencyCode: "CHF",
      deliveryPriceCents: 0,
      isPrepaid: false,
      prepaidDeliveriesPerCharge: null,
      lines: [
        {
          productId: "p1",
          variantId: "v1",
          quantity: 1,
          currentPriceCents: 2500,
          compareAtPriceCents: null,
          unitCostCents: 1000,
          isGift: false,
        },
      ],
    };
    store.subscriptionContracts.push(contract);
    store.billingAttempts.push(
      {
        id: "n1",
        contractId: "cn",
        contract,
        status: "SUCCESS",
        amountCents: 5000,
        refundedCents: 1200, // partial refund
        currencyCode: "CHF",
        completedAt: new Date("2026-06-15T10:00:00Z"),
      },
      {
        id: "n2",
        contractId: "cn",
        contract,
        status: "SUCCESS",
        amountCents: 4000,
        refundedCents: 999_999, // corrupt over-refund — must clamp at the charge
        currencyCode: "CHF",
        completedAt: new Date("2026-06-20T10:00:00Z"),
      },
    );
    return store;
  }

  it("revenue is net of refunds, refunds clamp at the charged amount, fees stay on the GROSS charge", async () => {
    const store = refundStore();
    dbHolder.current = createAnalyticsDb(store);
    const result = await runCohortComputation(
      SHOP_ID,
      new Date("2026-06-30T12:00:00Z"),
    );
    expect(result).toEqual({ cohorts: 1, cells: 1 });

    expect(store.cohortCells).toEqual([
      {
        shopId: SHOP_ID,
        cohortMonth: "2026-06",
        monthOffset: 0,
        cohortSize: 1,
        activeRemaining: 1,
        // (5000 − 1200) + (4000 − min(999999, 4000)) = 3800 + 0.
        revenueCents: 3800,
        // 1200 + 4000 (clamped), NOT 1 001 199.
        refundedCents: 5200,
        discountCents: 0,
        cogsCents: 2000, // 1000 per cycle × 2 billed cycles
        estimatedCogsCents: 0,
        shippingCostCents: 700, // 350 × 2 shipments
        // Fees on the gross amounts: (145+30) + (116+30) = 321.
        feesCents: 321,
        vatCents: 0, // VAT off in this fixture's cost model
        estimatedVatCents: 0,
        grossProfitCents: 779, // 3800 − 2000 − 700 − 321
        cumGrossProfitCents: 779,
      },
    ]);
  });
});
