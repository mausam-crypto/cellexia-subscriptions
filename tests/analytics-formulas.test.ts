import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * GOLDEN NUMERIC TESTS for the rebuilt analytics engines.
 *
 * One tiny synthetic shop, every number hand-computed to the cent:
 *
 * Shop: CHF, Europe/Zurich. Cost model (deliberately non-default):
 * fee 2.9% + 30c per charge, fulfillment 150c + flat shipping 200c per
 * shipment, COGS fallback 25% of price.
 *
 * Contracts:
 * - c_ours    OURS, ACTIVE, arrived 2026-06. Lines: Serum 4990 (compare-at
 *   5990, synced cost 1200), Night Cream 2×1500 (no cost → 25% fallback =
 *   375/unit), gift line (cost 999 — must be EXCLUDED from per-cycle COGS,
 *   gift COGS is booked per grant). Delivery 500.
 * - c_dunned  OURS, arrived 2026-06, CANCELLED by DUNNING on 2026-08-05.
 * - c_foreign FOREIGN (another subscription app's), ACTIVE, charging away.
 * - c_unknown UNKNOWN ownership, cancelled by CUSTOMER in the window.
 * - c_demo    OURS but isDemo (portal-preview fixture), ACTIVE, "arrived"
 *   today, charging, skipping and clicking through the cancel flow.
 *   The last three are pure pollution: they must contribute NOTHING anywhere.
 *
 * Billing attempts (5 in the named fixture, one refunded):
 * - a_june    c_ours   SUCCESS 8490  2026-06-10
 * - a_aug_1   c_ours   SUCCESS 8490  2026-08-05
 * - a_aug_2   c_ours   SUCCESS 8490  2026-08-05, 2000 refunded
 * - a_failed  c_dunned FAILED  2000  2026-08-05
 * - a_foreign c_foreign SUCCESS 99900 2026-08-05 (must never count)
 *
 * Plus: one gift grant on c_ours (rule COGS 450) added 2026-08-05, a dunning
 * case RECOVERED for 4990 in the window, one OPEN case, and one each of the
 * counted subscriber events.
 *
 * Rollup day 2026-08-05 (shop-tz window 2026-08-04T22:00Z → 2026-08-05T22:00Z):
 *   charged   = 8490 + 8490                        = 16980
 *   refunded  (event-recorded)                     =  2000
 *   discount  = (5990−4990)×1 per cycle × 2        =  2000
 *   COGS      = (1200 + 2×375) × 2                 =  3900 (est. share 1500)
 *   gift COGS = 450, shipping = 350×2 = 700, fees = (246+30)×2 = 552
 *   estGrossProfit = 16980−2000−3900−450−700−552   =  9378
 *   MRR = round((4990+3000+500) × 4.345 / 4)       =  9222
 *   (c_ours bills every 4 WEEKS exactly — unit WEEK count 4. Monthly/day/year
 *   cadences use exact calendar math; see the "MRR exact cadence" suite.)
 *
 * Cohort 2026-06 (renewals only, revenue net of refunds):
 *   offset 0: rev 8490,  GP 8490−1950−350−276          = 5914
 *   offset 1: all zero, GP 0
 *   offset 2: rev 8490+6490=14980, COGS 3900+450 gift  = 4350,
 *             GP 14980−4350−700−552                    = 9378  (cum 15292)
 *   — the SAME 9378 as the rollup day: the two gross-profit surfaces
 *   reconcile by construction.
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

import { runDailyRollup } from "~/lib/analytics/rollup.server";
import { runCohortComputation } from "~/lib/analytics/cohorts.server";
import { getSurvivalByCycle } from "~/lib/analytics/survival.server";
import { computeMrrCents } from "~/lib/analytics/queries.server";

// ── Fixture ───────────────────────────────────────────────────────────────────

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};

const COST_MODEL = {
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
  fulfillmentCostPerShipmentCents: 150,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 200 },
  cogsFallbackPctOfPrice: 25,
  // Explicitly OFF: this suite pins the vat-less formulas. Without this key
  // the registry's field-level default (enabled at 8.1% since v1.16.0)
  // would silently enter every golden number below.
  vat: { enabled: false, defaultRatePct: 0, countryRatesPct: {} },
};

/** Any instant inside the 2026-08-05 shop-tz day. */
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
    createdAt: D("2026-06-01T08:00:00Z"),
    firstChargeAt: null,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK", // exact cadence: every 4 weeks (see MRR tests)
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    ordersCount: 0,
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
    completedAt: null,
    ...over,
  };
}

const OURS_LINES: Row[] = [
  {
    productId: "p1",
    variantId: "v1",
    title: "Renewal Serum",
    quantity: 1,
    currentPriceCents: 4990,
    compareAtPriceCents: 5990,
    unitCostCents: 1200,
    isGift: false,
    isOneTimeAddon: false,
  },
  {
    productId: "p2",
    variantId: "v2",
    title: "Night Cream",
    quantity: 2,
    currentPriceCents: 1500,
    compareAtPriceCents: null,
    unitCostCents: null,
    isGift: false,
    isOneTimeAddon: false,
  },
  {
    productId: "p3",
    variantId: "v3",
    title: "Gift Mask",
    quantity: 1,
    currentPriceCents: 0,
    compareAtPriceCents: null,
    unitCostCents: 999, // must NOT enter per-cycle COGS (gift)
    isGift: true,
    isOneTimeAddon: false,
  },
];

/**
 * Build the shop. `pollute: true` adds the FOREIGN + UNKNOWN + isDemo
 * contracts with their attempts, gift grant, dunning case and subscriber
 * events (skips, cancel-flow saves, a refund) — everything the
 * ownership/isDemo filter must keep out of every number.
 */
function buildStore(opts: { pollute: boolean }): AnalyticsStore {
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

  const cOurs = contractRow("c_ours", {
    firstChargeAt: D("2026-06-10T10:00:00Z"),
    deliveryPriceCents: 500,
    ordersCount: 3,
    lines: OURS_LINES,
  });
  const cDunned = contractRow("c_dunned", {
    status: "CANCELLED",
    cancelSource: "DUNNING",
    firstChargeAt: D("2026-06-05T10:00:00Z"),
    cancelledAt: D("2026-08-05T09:00:00Z"),
    ordersCount: 2,
    lines: [
      {
        productId: "p4",
        variantId: "v4",
        title: "Day Cream",
        quantity: 1,
        currentPriceCents: 2000,
        compareAtPriceCents: null,
        unitCostCents: null,
        isGift: false,
        isOneTimeAddon: false,
      },
    ],
  });
  store.subscriptionContracts.push(cOurs, cDunned);

  store.billingAttempts.push(
    attemptRow("a_june", cOurs, {
      amountCents: 8490,
      completedAt: D("2026-06-10T10:00:00Z"),
    }),
    attemptRow("a_aug_1", cOurs, {
      amountCents: 8490,
      completedAt: D("2026-08-05T10:00:00Z"),
    }),
    attemptRow("a_aug_2", cOurs, {
      amountCents: 8490,
      refundedCents: 2000,
      completedAt: D("2026-08-05T11:00:00Z"),
    }),
    attemptRow("a_failed", cDunned, {
      status: "FAILED",
      amountCents: 2000,
      completedAt: D("2026-08-05T08:00:00Z"),
    }),
  );

  store.giftGrants.push({
    id: "g1",
    contractId: "c_ours",
    contract: cOurs,
    variantId: "v3",
    status: "ADDED",
    addedAt: D("2026-08-05T10:00:00Z"),
    rule: { unitCostCents: 450 },
  });

  store.dunningCases.push(
    {
      id: "dc_recovered",
      contractId: "c_ours",
      contract: cOurs,
      state: "RESOLVED",
      resolution: "RECOVERED",
      resolvedAt: D("2026-08-05T11:00:00Z"),
      recoveredCents: 4990,
    },
    {
      id: "dc_open",
      contractId: "c_dunned",
      contract: cDunned,
      state: "OPEN",
      resolution: null,
      resolvedAt: null,
      recoveredCents: 0,
    },
  );

  // Contract-scoped events carry their contract (every real emitter attaches
  // it via identity()/eventIdentity(), and the rollup now counts them through
  // the COUNTABLE contract join). checkout.subscribable fires before any
  // contract exists and stays contract-less.
  const event = (
    id: string,
    type: string,
    contract: Row | null,
    payload: Row | null = null,
  ): Row => ({
    id,
    shopId: SHOP_ID,
    type,
    contractId: contract ? (contract.id as string) : null,
    contract,
    createdAt: D("2026-08-05T12:30:00Z"),
    payload,
  });
  store.subscriberEvents.push(
    event("e_refund", "admin.action", cOurs, {
      action: "refund_recorded",
      amountCents: 2000,
      orderId: "gid://shopify/Order/9001",
    }),
    event("e_skip", "cycle.skipped", cOurs),
    event("e_checkout", "checkout.subscribable", null),
    event("e_save_shown", "cancel.save_shown", cDunned),
    event("e_save_accepted", "cancel.save_accepted", cDunned),
  );

  if (opts.pollute) {
    const cForeign = contractRow("c_foreign", {
      ownership: "FOREIGN",
      firstChargeAt: D("2026-08-05T10:00:00Z"), // would be a fake "new subscriber"
      ordersCount: 7,
      deliveryPriceCents: 900,
      lines: [
        {
          productId: "pf",
          variantId: "vf",
          title: "Joy Product",
          quantity: 1,
          currentPriceCents: 9900,
          compareAtPriceCents: 12900,
          unitCostCents: null,
          isGift: false,
          isOneTimeAddon: false,
        },
      ],
    });
    const cUnknown = contractRow("c_unknown", {
      ownership: "UNKNOWN",
      status: "CANCELLED",
      cancelSource: "CUSTOMER",
      firstChargeAt: D("2026-08-05T10:00:00Z"),
      cancelledAt: D("2026-08-05T10:30:00Z"),
      ordersCount: 1,
    });
    // OURS but isDemo — the merchant's portal-preview fixture. It is ACTIVE,
    // "arrived" today and interacts with the cancel flow: without the isDemo
    // leg of COUNTABLE_CONTRACT it would pollute active/new-subscriber counts,
    // MRR, revenue, survival AND the save/skip funnel columns.
    const cDemo = contractRow("c_demo", {
      isDemo: true,
      firstChargeAt: D("2026-08-05T09:00:00Z"),
      ordersCount: 4,
      lines: [
        {
          productId: "pd",
          variantId: "vd",
          title: "Demo Serum",
          quantity: 1,
          currentPriceCents: 7900,
          compareAtPriceCents: 9900,
          unitCostCents: 100,
          isGift: false,
          isOneTimeAddon: false,
        },
      ],
    });
    store.subscriptionContracts.push(cForeign, cUnknown, cDemo);
    store.billingAttempts.push(
      attemptRow("a_foreign", cForeign, {
        amountCents: 99_900,
        completedAt: D("2026-08-05T10:30:00Z"),
      }),
      attemptRow("a_foreign_failed", cForeign, {
        status: "FAILED",
        amountCents: 99_900,
        completedAt: D("2026-08-05T10:45:00Z"),
      }),
      attemptRow("a_demo", cDemo, {
        amountCents: 7900,
        completedAt: D("2026-08-05T09:30:00Z"),
      }),
    );
    // Counted-event pollution: demo-portal cancel-flow + skip interactions and
    // a foreign contract's events must not inflate skips/saves/addons, and a
    // refund recorded against a non-countable contract must not reduce revenue.
    store.subscriberEvents.push(
      event("e_demo_skip", "cycle.skipped", cDemo),
      event("e_demo_save_shown", "cancel.save_shown", cDemo),
      event("e_demo_save_accepted", "cancel.save_accepted", cDemo),
      event("e_demo_addon", "cycle.addon_added", cDemo),
      event("e_foreign_skip", "cycle.skipped", cForeign),
      event("e_foreign_refund", "admin.action", cForeign, {
        action: "refund_recorded",
        amountCents: 55_500,
        orderId: "gid://shopify/Order/9002",
      }),
    );
    store.giftGrants.push({
      id: "g_foreign",
      contractId: "c_foreign",
      contract: cForeign,
      variantId: "vf",
      status: "ADDED",
      addedAt: D("2026-08-05T10:00:00Z"),
      rule: { unitCostCents: 777 },
    });
    store.dunningCases.push({
      id: "dc_foreign",
      contractId: "c_foreign",
      contract: cForeign,
      state: "OPEN",
      resolution: null,
      resolvedAt: null,
      recoveredCents: 0,
    });
  }
  return store;
}

async function computeAll(store: AnalyticsStore) {
  dbHolder.current = createAnalyticsDb(store);
  await runDailyRollup(SHOP_ID, DAY);
  const cohortResult = await runCohortComputation(SHOP_ID, NOW);
  const survival = await getSurvivalByCycle(SHOP_ID);
  return {
    rollup: store.dailyRollups[0],
    cells: store.cohortCells,
    cohortResult,
    survival,
  };
}

const GOLDEN_ROLLUP: Row = {
  shopId: SHOP_ID,
  date: D("2026-08-05T00:00:00.000Z"),
  activeSubscribers: 1,
  pausedSubscribers: 0,
  newSubscribers: 0,
  churnedVoluntary: 0,
  churnedInvoluntary: 1,
  mrrCents: 9222,
  chargedCents: 16_980,
  refundedCents: 2000,
  discountCents: 2000,
  giftCogsCents: 450,
  shippingCostCents: 700,
  feesCents: 552,
  estimatedCogsCents: 1500,
  // VAT explicitly off in the fixture cost model (the shipped default is ON
  // since v1.16.0) — both columns stay 0 and gross profit is unchanged.
  // tests/vat-cost.test.ts holds the VAT-enabled goldens.
  vatCents: 0,
  estimatedVatCents: 0,
  estGrossProfitCents: 9378,
  failedAttempts: 1,
  recoveredCents: 4990,
  openDunningCases: 1,
  skips: 1,
  cancels: 1,
  savesOffered: 1,
  savesAccepted: 1,
  addonsAttached: 0,
  takeRateNum: 0,
  takeRateDen: 1,
  prepaidActive: 0,
  excludedForeignCurrencyCents: 0,
  snapshotFabricated: false,
};

const cellRow = (over: Row): Row => ({
  shopId: SHOP_ID,
  cohortMonth: "2026-06",
  cohortSize: 2,
  monthOffset: 0,
  activeRemaining: 2,
  revenueCents: 0,
  refundedCents: 0,
  discountCents: 0,
  cogsCents: 0,
  estimatedCogsCents: 0,
  shippingCostCents: 0,
  feesCents: 0,
  vatCents: 0,
  estimatedVatCents: 0,
  grossProfitCents: 0,
  cumGrossProfitCents: 0,
  ...over,
});

const GOLDEN_CELLS: Row[] = [
  cellRow({
    monthOffset: 0,
    revenueCents: 8490,
    discountCents: 1000,
    cogsCents: 1950,
    estimatedCogsCents: 750,
    shippingCostCents: 350,
    feesCents: 276,
    grossProfitCents: 5914,
    cumGrossProfitCents: 5914,
  }),
  cellRow({ monthOffset: 1, cumGrossProfitCents: 5914 }),
  cellRow({
    monthOffset: 2,
    activeRemaining: 1, // c_dunned churned 2026-08-05, before August month-end
    revenueCents: 14_980, // 8490 + (8490 − 2000 refunded)
    refundedCents: 2000,
    discountCents: 2000,
    cogsCents: 4350, // 2×1950 billed + 450 gift grant
    estimatedCogsCents: 1500,
    shippingCostCents: 700,
    feesCents: 552,
    grossProfitCents: 9378,
    cumGrossProfitCents: 15_292,
  }),
];

// ── Daily rollup ──────────────────────────────────────────────────────────────

describe("runDailyRollup — golden day 2026-08-05", () => {
  it("computes every rollup field to the cent", async () => {
    const { rollup } = await computeAll(buildStore({ pollute: true }));
    expect(rollup).toEqual(GOLDEN_ROLLUP);
  });

  it("keys the row on the shop-timezone day label (synthetic UTC midnight)", async () => {
    const store = buildStore({ pollute: true });
    dbHolder.current = createAnalyticsDb(store);
    // 2026-08-05 23:30 Zurich is already 2026-08-05T21:30Z — still the same shop day.
    await runDailyRollup(SHOP_ID, D("2026-08-05T21:30:00Z"));
    expect(store.dailyRollups).toHaveLength(1);
    expect(store.dailyRollups[0].date).toEqual(D("2026-08-05T00:00:00.000Z"));
    expect(store.dailyRollups[0]).toEqual(GOLDEN_ROLLUP);
  });

  it("is idempotent — recomputing the same day upserts, not duplicates", async () => {
    const store = buildStore({ pollute: true });
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, DAY);
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups).toHaveLength(1);
    expect(store.dailyRollups[0]).toEqual(GOLDEN_ROLLUP);
  });

  it("excludes non-shop-currency attempts from every money column (never sums EUR into CHF)", async () => {
    const store = buildStore({ pollute: true });
    const cOurs = store.subscriptionContracts.find((c) => c.id === "c_ours") as Row;
    store.billingAttempts.push(
      attemptRow("a_eur", cOurs, {
        amountCents: 6000,
        currencyCode: "EUR",
        completedAt: D("2026-08-05T10:15:00Z"),
      }),
    );
    const { rollup } = await computeAll(store);
    // Identical to the golden row EXCEPT the audit counter: the EUR attempt
    // adds neither revenue nor COGS/fees/shipping (the whole attempt is
    // skipped, not just its amount), and the exclusion is no longer silent —
    // its raw foreign cents land in excludedForeignCurrencyCents.
    expect(rollup).toEqual({
      ...GOLDEN_ROLLUP,
      excludedForeignCurrencyCents: 6000,
    });
  });

  it("produces an all-zero row (no throw) on a shop with no data at all", async () => {
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
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups[0]).toEqual({
      ...GOLDEN_ROLLUP,
      activeSubscribers: 0,
      churnedInvoluntary: 0,
      mrrCents: 0,
      chargedCents: 0,
      refundedCents: 0,
      discountCents: 0,
      giftCogsCents: 0,
      shippingCostCents: 0,
      feesCents: 0,
      estimatedCogsCents: 0,
      estGrossProfitCents: 0,
      failedAttempts: 0,
      recoveredCents: 0,
      openDunningCases: 0,
      skips: 0,
      cancels: 0,
      savesOffered: 0,
      savesAccepted: 0,
      takeRateDen: 0,
    });
  });
});

// ── Cohorts ───────────────────────────────────────────────────────────────────

describe("runCohortComputation — golden triangle", () => {
  it("computes the 2026-06 cohort cells to the cent, cumulative included", async () => {
    const { cells, cohortResult } = await computeAll(buildStore({ pollute: true }));
    expect(cohortResult).toEqual({ cohorts: 1, cells: 3 });
    expect(cells).toEqual(GOLDEN_CELLS);
  });

  it("reconciles with the rollup: same day, same activity, same gross profit", async () => {
    const { rollup, cells } = await computeAll(buildStore({ pollute: true }));
    // All August activity of this shop happened on the rollup day, so the
    // cohort's offset-2 gross profit must equal the day's estGrossProfitCents.
    const august = cells.find((c) => c.monthOffset === 2) as Row;
    expect(august.grossProfitCents).toBe(rollup.estGrossProfitCents);
    expect(august.grossProfitCents).toBe(9378);
  });

  it("clears the triangle (and computes nothing) when no countable contract exists", async () => {
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
    store.cohortCells.push(cellRow({ monthOffset: 0 })); // stale row from an earlier run
    dbHolder.current = createAnalyticsDb(store);
    const result = await runCohortComputation(SHOP_ID, NOW);
    expect(result).toEqual({ cohorts: 0, cells: 0 });
    expect(store.cohortCells).toEqual([]);
  });
});

// ── Survival: right-censoring ─────────────────────────────────────────────────

/**
 * Life-table fixture, hand-computed:
 * - 10 ACTIVE at ordersCount 2  → censored at 2 (the "2-month-old actives")
 * -  5 ACTIVE at ordersCount 5  → censored at 5
 * -  2 CANCELLED (CUSTOMER) at 1 → voluntary deaths in interval 1→2
 * -  1 FAILED at 3               → involuntary death in interval 3→4
 *
 * n=2: at-risk 16+2=18, deaths 2 → S = 16/18            = 0.8889
 * n=3: deaths 0 (censored actives are NOT deaths) → S carries 0.8889
 * n=4: at-risk 5+1=6, death 1 → S = (16/18)(5/6) = 80/108 = 0.7407
 */
function survivalStore(): AnalyticsStore {
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
  const push = (n: number, over: Row) => {
    for (let i = 0; i < n; i++) {
      store.subscriptionContracts.push(
        contractRow(`s_${String(over.status)}_${String(over.ordersCount)}_${i}`, over),
      );
    }
  };
  push(10, { status: "ACTIVE", ordersCount: 2 });
  push(5, { status: "ACTIVE", ordersCount: 5 });
  push(2, { status: "CANCELLED", cancelSource: "CUSTOMER", ordersCount: 1 });
  push(1, { status: "FAILED", ordersCount: 3 });
  return store;
}

describe("getSurvivalByCycle — right-censoring", () => {
  it("matches the hand-computed life table exactly", async () => {
    dbHolder.current = createAnalyticsDb(survivalStore());
    expect(await getSurvivalByCycle(SHOP_ID)).toEqual({
      cycles: [1, 2, 3, 4, 5],
      overall: [1, 0.8889, 0.8889, 0.7407, 0.7407],
      voluntary: [1, 0.8889, 0.8889, 0.8889, 0.8889],
      involuntary: [1, 1, 1, 0.8333, 0.8333],
      totalContracts: 18,
    });
  });

  it("a 2-month-old ACTIVE contract does NOT count as churned at cycle 3 (censored, not dead)", async () => {
    dbHolder.current = createAnalyticsDb(survivalStore());
    const { overall } = await getSurvivalByCycle(SHOP_ID);
    // The 10 actives censored at cycle 2 cause NO drop from cycle 2 to 3…
    expect(overall[2]).toBe(overall[1]);
    // …whereas the naive share-of-book estimate would read 6/18 ≈ 0.33 here.
    expect(overall[2]).toBeGreaterThan(0.85);
  });

  it("a brand-new all-active book yields a flat 100% curve, not 0%", async () => {
    const store = emptyStore();
    store.shops.push({ ...SHOP });
    for (let i = 0; i < 4; i++) {
      store.subscriptionContracts.push(
        contractRow(`fresh_${i}`, { status: "ACTIVE", ordersCount: i }),
      );
    }
    dbHolder.current = createAnalyticsDb(store);
    const curves = await getSurvivalByCycle(SHOP_ID);
    expect(curves.overall).toEqual(curves.overall.map(() => 1));
    expect(curves.totalContracts).toBe(4);
  });

  it("returns empty curves (not a crash, not NaN) on an empty book", async () => {
    const store = emptyStore();
    store.shops.push({ ...SHOP });
    dbHolder.current = createAnalyticsDb(store);
    expect(await getSurvivalByCycle(SHOP_ID)).toEqual({
      cycles: [],
      overall: [],
      voluntary: [],
      involuntary: [],
      totalContracts: 0,
    });
  });
});

// ── Ownership/demo exclusion: FOREIGN/UNKNOWN/isDemo contribute NOTHING ───────

describe("ownership exclusion — non-OURS and demo contracts contribute nothing", () => {
  it("rollup, cohorts and survival are IDENTICAL with and without the FOREIGN/UNKNOWN/demo rows", async () => {
    const polluted = await computeAll(buildStore({ pollute: true }));
    const clean = await computeAll(buildStore({ pollute: false }));
    expect(polluted.rollup).toEqual(clean.rollup);
    expect(polluted.cells).toEqual(clean.cells);
    expect(polluted.survival).toEqual(clean.survival);
    expect(polluted.cohortResult).toEqual(clean.cohortResult);
  });

  it("the polluted store still yields the exact golden numbers (not merely equal garbage)", async () => {
    const polluted = await computeAll(buildStore({ pollute: true }));
    expect(polluted.rollup).toEqual(GOLDEN_ROLLUP);
    expect(polluted.cells).toEqual(GOLDEN_CELLS);
    // Survival sees only the two OURS contracts: c_dunned (DUNNING) dies in
    // interval 3, c_ours censored at 3.
    expect(polluted.survival).toEqual({
      cycles: [1, 2, 3],
      overall: [1, 1, 0.5],
      voluntary: [1, 1, 1],
      involuntary: [1, 1, 0.5],
      totalContracts: 2,
    });
  });

  it("MRR counts only OURS contracts — a 99900-cent FOREIGN book adds zero", async () => {
    dbHolder.current = createAnalyticsDb(buildStore({ pollute: true }));
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(9222);
  });
});

// ── MRR exact cadence (audit fix: monthly ×4.345/4 overstated MRR ~8.6%) ─────

describe("MRR exact cadence — billingIntervalUnit/Count beat the week approximation", () => {
  /** One ACTIVE contract with an 8490 cycle total and the given cadence. */
  function storeWithCadence(over: Row): AnalyticsStore {
    const store = emptyStore();
    store.shops.push({ ...SHOP });
    store.subscriptionContracts.push(
      contractRow("c_cadence", {
        deliveryPriceCents: 500,
        lines: OURS_LINES,
        ...over,
      }),
    );
    return store;
  }

  it("a MONTHLY 8490 contract is exactly 8490/mo — not ×4.345/4 = 9222", async () => {
    dbHolder.current = createAnalyticsDb(
      storeWithCadence({
        billingIntervalUnit: "MONTH",
        billingIntervalCount: 1,
        intervalWeeks: 4, // the approximation the old formula overcharged
      }),
    );
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(8490);
  });

  it("an every-2-months contract amortizes to half the cycle total", async () => {
    dbHolder.current = createAnalyticsDb(
      storeWithCadence({
        billingIntervalUnit: "MONTH",
        billingIntervalCount: 2,
        intervalWeeks: 8,
      }),
    );
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(4245);
  });

  it("a 30-DAY contract uses day math — not ceil(30/7)=5 whole weeks", async () => {
    dbHolder.current = createAnalyticsDb(
      storeWithCadence({
        billingIntervalUnit: "DAY",
        billingIntervalCount: 30,
        intervalWeeks: 5, // old path: 8490×4.345/5 = 7378 (~13% understated)
      }),
    );
    // 8490 × (365.25/12) / 30 = 8613.8… → 8614
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(8614);
  });

  it("a YEARLY contract is cycleTotal/12", async () => {
    dbHolder.current = createAnalyticsDb(
      storeWithCadence({
        billingIntervalUnit: "YEAR",
        billingIntervalCount: 1,
        intervalWeeks: 52,
      }),
    );
    // 8490/12 = 707.5 → 708
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(708);
  });

  it("a pre-v1.4.0 row (null unit) falls back to the intervalWeeks approximation", async () => {
    dbHolder.current = createAnalyticsDb(
      storeWithCadence({
        billingIntervalUnit: null,
        billingIntervalCount: null,
        intervalWeeks: 4,
      }),
    );
    // Legacy behaviour preserved: 8490 × 4.345 / 4 = 9222 — skewed, never zero.
    expect(await computeMrrCents(SHOP_ID, "CHF")).toBe(9222);
  });
});
