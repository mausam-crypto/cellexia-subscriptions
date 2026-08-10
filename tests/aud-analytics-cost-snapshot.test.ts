import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Per-charge cost snapshots (migration 0016) — computeChargeCostSnapshot /
 * parseChargeCostSnapshot and the read-side preference in BOTH gross-profit
 * surfaces.
 *
 * Before the snapshot, every recompute (nightly cohort rebuild, rollup
 * trailing recompute) re-resolved historical charges through TODAY's cost
 * settings — editing a COGS override repriced all history. Settlement now
 * freezes the charge's cost basis into BillingAttempt.costSnapshot; the
 * readers PREFER the stored snapshot and fall back to the live model only
 * when it is absent (pre-0016 attempts) or unrecognized (future version —
 * fails closed to the fallback).
 *
 * Payment fees stay computed at read time on the charged amount, and the
 * rollup's discountCents prefers the money-true discountCents captured onto
 * the attempt at settlement over the mirror-line estimate.
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
  computeChargeCostSnapshot,
  parseChargeCostSnapshot,
  type ChargeCostSnapshot,
  type CostContext,
  type CostModelSettings,
} from "~/lib/analytics/costs.server";
import { runDailyRollup } from "~/lib/analytics/rollup.server";
import { runCohortComputation } from "~/lib/analytics/cohorts.server";

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};

const COST_MODEL: CostModelSettings = {
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
  fulfillmentCostPerShipmentCents: 150,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
  cogsFallbackPctOfPrice: 25,
};

function ctx(over: Partial<CostModelSettings> = {}): CostContext {
  return {
    costModel: { ...COST_MODEL, ...over },
    overrides: { byVariant: new Map(), byProduct: new Map() },
  };
}

/** Serum 4990 (synced cost 1200) + 2× Night Cream 1500 (25% fallback = 375) + gift. */
const LINES = [
  {
    productId: "p1",
    variantId: "v1",
    quantity: 1,
    currentPriceCents: 4990,
    unitCostCents: 1200,
    isGift: false,
  },
  {
    productId: "p2",
    variantId: "v2",
    quantity: 2,
    currentPriceCents: 1500,
    unitCostCents: null,
    isGift: false,
  },
  {
    productId: "p3",
    variantId: "v3",
    quantity: 1,
    currentPriceCents: 0,
    unitCostCents: 999, // gift — must never enter the snapshot
    isGift: true,
  },
];

const CONTRACT = {
  deliveryPriceCents: 500,
  isPrepaid: false,
  prepaidDeliveriesPerCharge: null,
  lines: LINES,
};

// ── computeChargeCostSnapshot ────────────────────────────────────────────────

describe("computeChargeCostSnapshot", () => {
  it("freezes the charge's cost basis to the cent, gift lines excluded", () => {
    expect(computeChargeCostSnapshot(ctx(), CONTRACT)).toEqual({
      v: 1,
      cogsCents: 1950, // 1200 + 2×375
      estimatedCogsCents: 750, // the fallback lines only
      shippingCostCents: 200, // flat mode ignores deliveryPriceCents
      fulfillmentCostCents: 150,
      deliveriesPerCharge: 1,
      lines: [
        { variantId: "v1", quantity: 1, priceCents: 4990, unitCostCents: 1200, estimated: false },
        { variantId: "v2", quantity: 2, priceCents: 1500, unitCostCents: 375, estimated: true },
      ],
    });
  });

  it("multiplies every per-charge total by deliveries on a prepaid contract", () => {
    const snap = computeChargeCostSnapshot(ctx(), {
      ...CONTRACT,
      isPrepaid: true,
      prepaidDeliveriesPerCharge: 3,
    });
    expect(snap.deliveriesPerCharge).toBe(3);
    expect(snap.cogsCents).toBe(5850); // 1950 × 3
    expect(snap.estimatedCogsCents).toBe(2250);
    expect(snap.shippingCostCents).toBe(600);
    expect(snap.fulfillmentCostCents).toBe(450);
    // lines stay per-unit — the totals carry the multiplication.
    expect(snap.lines[0].unitCostCents).toBe(1200);
  });

  it("honours an explicit deliveriesPerCharge override (never below 1)", () => {
    expect(
      computeChargeCostSnapshot(ctx(), CONTRACT, { deliveriesPerCharge: 2 })
        .cogsCents,
    ).toBe(3900);
    expect(
      computeChargeCostSnapshot(ctx(), CONTRACT, { deliveriesPerCharge: 0 })
        .deliveriesPerCharge,
    ).toBe(1);
  });

  it("charged shipping mode snapshots the customer-paid delivery as the carrier leg", () => {
    const snap = computeChargeCostSnapshot(
      ctx({ shippingCostPerShipmentCents: { mode: "charged", flatCents: 200 } }),
      CONTRACT,
    );
    expect(snap.shippingCostCents).toBe(500); // pass-through of deliveryPriceCents
    expect(snap.fulfillmentCostCents).toBe(150);
  });
});

// ── parseChargeCostSnapshot ──────────────────────────────────────────────────

describe("parseChargeCostSnapshot", () => {
  const valid = computeChargeCostSnapshot(ctx(), CONTRACT);

  it("round-trips a snapshot it computed itself", () => {
    expect(parseChargeCostSnapshot(JSON.parse(JSON.stringify(valid)))).toEqual(
      valid,
    );
  });

  it.each([
    ["null", null],
    ["a non-object", 42],
    ["an array", [1]],
    ["an unknown version", { ...valid, v: 2 }],
    ["a missing money field", { ...valid, cogsCents: undefined }],
    ["a non-numeric money field", { ...valid, shippingCostCents: "200" }],
  ])("fails closed (null → live-model fallback) on %s", (_name, value) => {
    expect(parseChargeCostSnapshot(value)).toBeNull();
  });
});

// ── Read-side preference in both engines ─────────────────────────────────────

/**
 * One contract, one August charge. The stored snapshot deliberately DISAGREES
 * with what the live model would resolve from the same lines (cogs 1000 vs
 * 1950, shipping 100+50 vs 350, nothing estimated) — the engines must report
 * the stored numbers, proving history is priced as charged, not as configured
 * today.
 */
const STORED_SNAPSHOT: ChargeCostSnapshot = {
  v: 1,
  cogsCents: 1000,
  estimatedCogsCents: 0,
  shippingCostCents: 100,
  fulfillmentCostCents: 50,
  deliveriesPerCharge: 1,
  lines: [
    { variantId: "v1", quantity: 1, priceCents: 4990, unitCostCents: 1000, estimated: false },
  ],
};

function engineStore(attemptOver: Row = {}): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });
  const contract: Row = {
    id: "c1",
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    cancelSource: null,
    cancelledAt: null,
    failedAt: null,
    expiredAt: null,
    createdAt: new Date("2026-08-01T08:00:00Z"),
    firstChargeAt: new Date("2026-08-01T08:00:00Z"),
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 500,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    ordersCount: 1,
    lines: LINES.map((l) => ({
      ...l,
      compareAtPriceCents: l.variantId === "v1" ? 5990 : null,
      isOneTimeAddon: false,
      title: l.variantId,
    })),
  };
  store.subscriptionContracts.push(contract);
  store.billingAttempts.push({
    id: "a1",
    contractId: "c1",
    contract,
    status: "SUCCESS",
    amountCents: 8490,
    refundedCents: 0,
    currencyCode: "CHF",
    completedAt: new Date("2026-08-05T10:00:00Z"),
    costSnapshot: null,
    discountCents: null,
    ...attemptOver,
  });
  return store;
}

describe("rollup prefers the stored cost snapshot", () => {
  it("uses stored COGS/shipping/fulfillment; fees stay computed on the charged amount", async () => {
    const store = engineStore({ costSnapshot: STORED_SNAPSHOT });
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(store.dailyRollups[0]).toMatchObject({
      chargedCents: 8490,
      estimatedCogsCents: 0, // snapshot says nothing was estimated
      shippingCostCents: 150, // 100 + 50 from the snapshot, NOT 350 live
      feesCents: 276, // round(8490×2.9%) + 30 — always live, on the amount
      // 8490 − 1000 (snapshot cogs) − 150 (snapshot shipping+fulfillment) − 276
      estGrossProfitCents: 7064,
    });
  });

  it("falls back to the live cost model when the snapshot is absent (pre-0016 attempt)", async () => {
    const store = engineStore();
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(store.dailyRollups[0]).toMatchObject({
      estimatedCogsCents: 750,
      shippingCostCents: 350,
      estGrossProfitCents: 8490 - 1950 - 350 - 276,
    });
  });

  it("prefers the money-true attempt discountCents over the mirror-line estimate", async () => {
    // Mirror-line estimate would be 5990 − 4990 = 1000; settlement captured 1250.
    const store = engineStore({ discountCents: 1250 });
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(store.dailyRollups[0].discountCents).toBe(1250);

    // A captured zero is a KNOWN zero, not a missing value.
    const zeroStore = engineStore({ discountCents: 0 });
    dbHolder.current = createAnalyticsDb(zeroStore);
    await runDailyRollup(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(zeroStore.dailyRollups[0].discountCents).toBe(0);

    // Null (pre-0016) keeps the estimate.
    const nullStore = engineStore();
    dbHolder.current = createAnalyticsDb(nullStore);
    await runDailyRollup(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(nullStore.dailyRollups[0].discountCents).toBe(1000);
  });
});

describe("cohorts prefer the stored cost snapshot", () => {
  it("prices the cell from the snapshot, so a later cost-setting edit cannot reprice history", async () => {
    const store = engineStore({ costSnapshot: STORED_SNAPSHOT });
    dbHolder.current = createAnalyticsDb(store);
    await runCohortComputation(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(store.cohortCells).toHaveLength(1);
    expect(store.cohortCells[0]).toMatchObject({
      cohortMonth: "2026-08",
      monthOffset: 0,
      revenueCents: 8490,
      cogsCents: 1000,
      estimatedCogsCents: 0,
      shippingCostCents: 150,
      feesCents: 276,
      grossProfitCents: 7064, // matches the rollup day above — surfaces reconcile
    });
  });

  it("falls back to the live cost model when the snapshot is absent", async () => {
    const store = engineStore();
    dbHolder.current = createAnalyticsDb(store);
    await runCohortComputation(SHOP_ID, new Date("2026-08-05T12:00:00Z"));
    expect(store.cohortCells[0]).toMatchObject({
      cogsCents: 1950,
      estimatedCogsCents: 750,
      shippingCostCents: 350,
    });
  });
});
