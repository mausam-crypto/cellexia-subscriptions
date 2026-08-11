import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * VAT as a reporting cost (migration 0019 / costModel.vat).
 *
 * Pure half: resolveChargeVat's flat-percentage model (v1.16.0,
 * merchant-defined: VAT = kept money × rate/100 — a CHF 100 charge at 8.1%
 * books CHF 8.10; captured order tax is still collected but deliberately
 * IGNORED by the deduction), the country rate lookup, contractTaxCountry's
 * fallback chain, and the settings codec for per-country rates.
 *
 * Engine half (fake db): golden numbers for a VAT-enabled shop on BOTH
 * gross-profit surfaces, their reconciliation, the estimated-share
 * disclosure (all VAT is rate-derived now), origin-payment VAT, and the
 * documented rollup/cohort divergence on refunded charges.
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
  resolveChargeVat,
  vatRatePctForCountry,
  type CostModelSettings,
} from "~/lib/analytics/costs.server";
import { contractTaxCountry } from "~/lib/analytics/queries.server";
import { runDailyRollup } from "~/lib/analytics/rollup.server";
import { runCohortComputation } from "~/lib/analytics/cohorts.server";
import {
  decodeCountryRates,
  encodeCountryRates,
} from "~/lib/settings/country-rates";
import { settingsSchemas } from "~/lib/settings/registry.server";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VAT_ON: CostModelSettings["vat"] = {
  enabled: true,
  defaultRatePct: 10,
  countryRatesPct: { CH: 8.1, DE: 19 },
};

const COST_MODEL: CostModelSettings = {
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
  fulfillmentCostPerShipmentCents: 150,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
  cogsFallbackPctOfPrice: 25,
  vat: VAT_ON,
};

const modelWith = (vat: Partial<CostModelSettings["vat"]>): CostModelSettings => ({
  ...COST_MODEL,
  vat: { ...VAT_ON, ...vat },
});

// ── Pure: rate lookup ────────────────────────────────────────────────────────

describe("vatRatePctForCountry", () => {
  it("returns the exact country entry, case-insensitively", () => {
    expect(vatRatePctForCountry(COST_MODEL, "CH")).toBe(8.1);
    expect(vatRatePctForCountry(COST_MODEL, "ch")).toBe(8.1);
    expect(vatRatePctForCountry(COST_MODEL, "DE")).toBe(19);
  });

  it("falls back to the default rate for unlisted or unknown countries", () => {
    expect(vatRatePctForCountry(COST_MODEL, "FR")).toBe(10);
    expect(vatRatePctForCountry(COST_MODEL, null)).toBe(10);
  });

  it("is 0 whenever the vat setting is disabled", () => {
    expect(vatRatePctForCountry(modelWith({ enabled: false }), "CH")).toBe(0);
  });
});

// ── Pure: per-charge resolution ──────────────────────────────────────────────

describe("resolveChargeVat", () => {
  const charge = (over: Partial<Parameters<typeof resolveChargeVat>[0]> = {}) => ({
    netAmountCents: 10_000,
    grossAmountCents: 10_000,
    capturedTaxCents: null,
    countryCode: "CH",
    ...over,
  });

  it("resolves 0 (not estimated) when the setting is disabled", () => {
    expect(
      resolveChargeVat(charge(), modelWith({ enabled: false })),
    ).toEqual({ vatCents: 0, estimated: false });
  });

  it("resolves 0 on non-positive kept money", () => {
    expect(resolveChargeVat(charge({ netAmountCents: 0 }), COST_MODEL)).toEqual({
      vatCents: 0,
      estimated: false,
    });
    expect(
      resolveChargeVat(charge({ netAmountCents: -500 }), COST_MODEL),
    ).toEqual({ vatCents: 0, estimated: false });
  });

  it("captured order tax is IGNORED — the flat rate applies regardless", () => {
    // v1.16.0 merchant model: VAT is a straight % of revenue. The captured
    // 376 (the extracted-from-gross figure) must not replace the 405.
    expect(
      resolveChargeVat(
        charge({ netAmountCents: 5000, grossAmountCents: 5000, capturedTaxCents: 376 }),
        COST_MODEL,
      ),
    ).toEqual({ vatCents: 405, estimated: true });
    // A captured 0 does not suppress the rate either.
    expect(
      resolveChargeVat(
        charge({ netAmountCents: 5000, grossAmountCents: 5000, capturedTaxCents: 0 }),
        COST_MODEL,
      ),
    ).toEqual({ vatCents: 405, estimated: true });
  });

  it("computes a flat percentage of the KEPT money on partial refunds", () => {
    // 5000 charged, 1000 refunded → 4000 kept × 8.1% = 324.
    expect(
      resolveChargeVat(
        charge({
          netAmountCents: 4000,
          grossAmountCents: 5000,
          capturedTaxCents: 376,
        }),
        COST_MODEL,
      ),
    ).toEqual({ vatCents: 324, estimated: true });
  });

  it("VAT = rate × net / 100 — a straight percentage of revenue", () => {
    // CHF 100.00 at 8.1% subtracts CHF 8.10, exactly rate × net.
    expect(resolveChargeVat(charge(), COST_MODEL)).toEqual({
      vatCents: 810,
      estimated: true,
    });
    // Unlisted country → default 10%: 10000 × 10/100 = 1000.
    expect(
      resolveChargeVat(charge({ countryCode: "FR" }), COST_MODEL),
    ).toEqual({ vatCents: 1000, estimated: true });
    expect(resolveChargeVat(charge({ countryCode: null }), COST_MODEL)).toEqual(
      { vatCents: 1000, estimated: true },
    );
  });

  it("a 0% effective rate estimates 0 (still flagged as the estimate path)", () => {
    expect(
      resolveChargeVat(
        charge({ countryCode: "FR" }),
        modelWith({ defaultRatePct: 0 }),
      ),
    ).toEqual({ vatCents: 0, estimated: true });
  });
});

// ── Pure: contract country resolution ────────────────────────────────────────

describe("contractTaxCountry", () => {
  it("prefers the delivery address countryCode, uppercased", () => {
    expect(
      contractTaxCountry({
        deliveryAddress: { countryCode: "ch", city: "Zürich" },
        acqCountryCode: "DE",
      }),
    ).toBe("CH");
  });

  it("falls back to the acquisition country when the address has none", () => {
    expect(
      contractTaxCountry({
        deliveryAddress: { city: "Zürich" },
        acqCountryCode: "de",
      }),
    ).toBe("DE");
    expect(
      contractTaxCountry({ deliveryAddress: null, acqCountryCode: "CH" }),
    ).toBe("CH");
  });

  it("returns null when neither source knows (→ default rate applies)", () => {
    expect(
      contractTaxCountry({ deliveryAddress: null, acqCountryCode: null }),
    ).toBeNull();
    expect(
      contractTaxCountry({
        deliveryAddress: { countryCode: "  " },
        acqCountryCode: "",
      }),
    ).toBeNull();
    // Hostile shapes never throw.
    expect(
      contractTaxCountry({ deliveryAddress: [1, 2], acqCountryCode: null }),
    ).toBeNull();
    expect(
      contractTaxCountry({ deliveryAddress: "CH", acqCountryCode: null }),
    ).toBeNull();
  });
});

// ── Pure: settings codec + registry validation ───────────────────────────────

describe("country-rates codec + costModel.vat schema", () => {
  it("round-trips a record through encode/decode", () => {
    const text = encodeCountryRates({ DE: 19, CH: 8.1 });
    expect(text).toBe("CH:8.1, DE:19"); // stable sorted order
    expect(decodeCountryRates(text)).toEqual({ CH: 8.1, DE: 19 });
  });

  it("decode uppercases codes and preserves malformed entries for zod to reject", () => {
    expect(decodeCountryRates("ch : 8.1")).toEqual({ CH: 8.1 });
    expect(decodeCountryRates("Switzerland:8.1")).toEqual({ SWITZERLAND: 8.1 });
    expect(decodeCountryRates("CH")).toEqual({ CH: Number.NaN });
    expect(decodeCountryRates("CH:abc")).toEqual({ CH: Number.NaN });
    expect(decodeCountryRates("")).toEqual({});
  });

  it("a repeated country code is surfaced as a per-entry error, never last-wins", () => {
    // Two rates for one country is a typo (e.g. CH typed where DK was meant);
    // silently keeping the second would replace a real tax rate with no error.
    const decoded = decodeCountryRates("CH:8.1, CH:7.7");
    expect(decoded).toEqual({ CH: 8.1, "CH (duplicate)": 7.7 });
    const base = settingsSchemas.costModel.parse(undefined);
    const parsed = settingsSchemas.costModel.safeParse({
      ...base,
      vat: { enabled: true, defaultRatePct: 0, countryRatesPct: decoded },
    });
    expect(parsed.success).toBe(false);
  });

  it("the registry accepts valid rates and rejects malformed codes/rates per entry", () => {
    const base = settingsSchemas.costModel.parse(undefined);
    const good = settingsSchemas.costModel.safeParse({
      ...base,
      vat: { enabled: true, defaultRatePct: 8.1, countryRatesPct: { CH: 8.1 } },
    });
    expect(good.success).toBe(true);

    for (const countryRatesPct of [
      { SWITZERLAND: 8.1 }, // not a 2-letter code
      { CH: Number.NaN }, // unparseable rate survives decode → rejected here
      { CH: 51 }, // above the 50% ceiling
      { CH: -1 },
    ]) {
      const bad = settingsSchemas.costModel.safeParse({
        ...base,
        vat: { enabled: true, defaultRatePct: 0, countryRatesPct },
      });
      expect(bad.success, JSON.stringify(countryRatesPct)).toBe(false);
    }
  });

  it("vat defaults ON at 8.1% (merchant decision, v1.16.0 — flipped before any subscription existed)", () => {
    const parsed = settingsSchemas.costModel.parse(undefined);
    expect(parsed.vat).toEqual({
      enabled: true,
      defaultRatePct: 8.1,
      countryRatesPct: {},
    });
    // A stored pre-0019 costModel (no vat key) still parses — and flips ON
    // via the field-level default (same merchant decision; the book was
    // empty at flip time, so no historical figure is rewritten).
    const legacy = settingsSchemas.costModel.safeParse({
      paymentFeePct: 2.9,
      paymentFeeFixedCents: 30,
      fulfillmentCostPerShipmentCents: 0,
      shippingCostPerShipmentCents: { mode: "flat", flatCents: 0 },
      cogsFallbackPctOfPrice: 25,
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) {
      expect(legacy.data.vat).toEqual({
        enabled: true,
        defaultRatePct: 8.1,
        countryRatesPct: {},
      });
    }
  });
});

// ── Engines: golden numbers with VAT enabled ─────────────────────────────────

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};

const DAY = new Date("2026-08-05T12:00:00Z");
const NOW = new Date("2026-08-05T12:00:00Z");

function D(iso: string): Date {
  return new Date(iso);
}

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
    lines: [],
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

const LINE_5000 = {
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
const LINE_4400 = {
  productId: "p2",
  variantId: "v2",
  title: "Cream",
  quantity: 1,
  currentPriceCents: 4400,
  compareAtPriceCents: null,
  unitCostCents: 1100,
  isGift: false,
  isOneTimeAddon: false,
};

/**
 * Golden shop, VAT on (CH 8.1%, default 10%), flat-rate model (v1.16.0):
 * - cCh ships to CH (delivery address). Attempts in the 2026-08-05 window:
 *     aCaptured 5000, captured tax 376 (IGNORED) → round(5000×8.1/100) = 405
 *     aEstimated 5000, no captured tax           → round(5000×8.1/100) = 405
 * - cNowhere has no country anywhere. Attempt:
 *     aDefault 4400, no captured tax             → round(4400×10/100)  = 440
 *
 * Rollup day 2026-08-05:
 *   charged 14400 · COGS 1000+1000+1100 = 3100 · shipping 350×3 = 1050
 *   fees (145+30)+(145+30)+(128+30) = 508 · VAT 405+405+440 = 1250 (est 1250 —
 *   all VAT is rate-derived under the flat model)
 *   estGrossProfit = 14400 − 3100 − 1050 − 508 − 1250 = 8492
 *
 * Cohort 2026-06 offset 2 books the same three charges → the same 8492:
 * the surfaces reconcile with VAT in the formula.
 */
function buildVatStore(): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });
  // Pin the pre-v1.16.0 netting model: these fixtures exercise refunds as
  // NETTED (revenue minus refund, full costs kept). The shipped default is
  // exclusion — tests/refund-exclusion.test.ts pins that path.
  store.settings.push({
    shopId: SHOP_ID,
    key: "analytics",
    value: { excludeRefundedPayments: false },
  });

  const cCh = contractRow("c_ch", {
    deliveryAddress: { countryCode: "CH", city: "Zürich" },
    lines: [LINE_5000],
  });
  const cNowhere = contractRow("c_nowhere", { lines: [LINE_4400] });
  store.subscriptionContracts.push(cCh, cNowhere);

  store.billingAttempts.push(
    attemptRow("a_captured", cCh, {
      amountCents: 5000,
      taxCents: 376,
      completedAt: D("2026-08-05T09:00:00Z"),
    }),
    attemptRow("a_estimated", cCh, {
      amountCents: 5000,
      completedAt: D("2026-08-05T10:00:00Z"),
    }),
    attemptRow("a_default", cNowhere, {
      amountCents: 4400,
      completedAt: D("2026-08-05T11:00:00Z"),
    }),
  );
  return store;
}

describe("runDailyRollup — VAT enabled (golden)", () => {
  it("books a flat percentage of every charge and subtracts it from gross profit", async () => {
    const store = buildVatStore();
    dbHolder.current = createAnalyticsDb(store) as never;
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;

    expect(row.chargedCents).toBe(14_400);
    expect(row.vatCents).toBe(1250); // 405 + 405 + 440 — captured tax ignored
    expect(row.estimatedVatCents).toBe(1250); // all rate-derived under the flat model
    expect(row.feesCents).toBe(508);
    expect(row.shippingCostCents).toBe(1050);
    expect(row.estGrossProfitCents).toBe(8492); // 14400−3100−1050−508−1250
  });

  it("books origin-payment VAT the same way (captured originOrderTaxCents ignored too)", async () => {
    const store = buildVatStore();
    store.subscriptionContracts.push(
      contractRow("c_origin", {
        deliveryAddress: { countryCode: "DE" },
        lines: [LINE_5000],
        originOrderId: "gid://shopify/Order/9",
        originOrderTotalCents: 6000,
        originOrderTaxCents: 450,
        originOrderProcessedAt: D("2026-08-05T08:00:00Z"),
        originOrderCurrencyCode: "CHF",
      }),
    );
    dbHolder.current = createAnalyticsDb(store) as never;
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;

    expect(row.chargedCents).toBe(20_400); // + the 6000 origin payment
    expect(row.vatCents).toBe(2390); // 1250 + round(6000×19/100) = 1140 (DE rate)
    expect(row.estimatedVatCents).toBe(2390); // rate-derived, captured 450 ignored
  });

  it("with vat disabled the columns stay 0 and gross profit is unchanged", async () => {
    const store = buildVatStore();
    store.settings.length = 0;
    store.settings.push({
      shopId: SHOP_ID,
      key: "costModel",
      value: modelWith({ enabled: false }),
    });
    dbHolder.current = createAnalyticsDb(store) as never;
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;

    expect(row.vatCents).toBe(0);
    expect(row.estimatedVatCents).toBe(0);
    expect(row.estGrossProfitCents).toBe(9742); // 14400−3100−1050−508
  });
});

describe("runCohortComputation — VAT enabled (golden + reconciliation)", () => {
  it("subtracts VAT per cell and reconciles with the rollup day", async () => {
    const store = buildVatStore();
    dbHolder.current = createAnalyticsDb(store) as never;
    await runCohortComputation(SHOP_ID, NOW);

    const cell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-06" && c.monthOffset === 2,
    ) as Row;
    expect(cell.vatCents).toBe(1250);
    expect(cell.estimatedVatCents).toBe(1250);
    // 14400 − 3100 − 1050 − 508 − 1250 — the SAME figure the rollup produced.
    expect(cell.grossProfitCents).toBe(8492);
  });

  it("applies the rate to the KEPT money on a partial refund — while the rollup deliberately books the full charge-day tax (documented divergence)", async () => {
    const store = buildVatStore();
    const attempt = store.billingAttempts.find(
      (a) => a.id === "a_captured",
    ) as Row;
    attempt.refundedCents = 1000; // 4/5 kept

    dbHolder.current = createAnalyticsDb(store) as never;
    await runCohortComputation(SHOP_ID, NOW);
    const cell = store.cohortCells.find(
      (c) => c.cohortMonth === "2026-06" && c.monthOffset === 2,
    ) as Row;
    // Kept 4000 × 8.1% = 324 (net revenue drops by the refund too).
    expect(cell.vatCents).toBe(324 + 405 + 440);
    expect(cell.revenueCents).toBe(13_400);

    // The rollup keys VAT off the charge day exactly like fees — the refund's
    // VAT share is not credited back (the cohort surface carries it).
    const row = (await runDailyRollup(SHOP_ID, DAY)) as unknown as Row;
    expect(row.vatCents).toBe(1250);
  });
});
