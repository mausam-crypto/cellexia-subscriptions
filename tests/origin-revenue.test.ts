import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  matchesWhere,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Origin (checkout) payment revenue — migration 0006.
 *
 * Since v1.5.0 cohort LTGP and the daily rollup include each contract's
 * mirrored origin payment (net of origin refunds, costed through the shared
 * cost model) instead of being renewals-only. This file pins:
 *
 *  - the golden cohort numbers for a contract whose first payment was
 *    captured: month 0 books originOrderTotalCents − originOrderRefundedCents
 *    with fees/COGS/shipping from the cost model, renewals keep booking in
 *    their own months;
 *  - THE double-count guard: an origin order that also produced a successful
 *    BillingAttempt counts ONCE, in both the cohort engine and the rollup
 *    (originPaymentCountsOnce precedence — the attempt wins);
 *  - the currency / missing-processedAt guards, refund clamping, and recompute
 *    idempotency;
 *  - the origin_order_backfill job: selects exactly OURS + non-demo contracts
 *    with an originOrderId and NO captured total, capped and oldest-first, and
 *    captures idempotently (a concurrent claim writes nothing twice);
 *  - the "renewals-only" disclaimers are GONE from the analytics UI — the
 *    surfaces now say first orders are included where captured.
 *
 * Engines run unmodified over the analytics-db interpreter (the
 * analytics-formulas.test.ts pattern), so a lost filter changes the numbers.
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => {
  /**
   * Stands in for the graphql layer's typed OrderNotFoundError inside the
   * barrel mock below; sync.server.ts imports the class from the same mocked
   * module, so `instanceof` matches instances thrown here.
   */
  class OrderNotFoundError extends Error {
    constructor(orderGid: string) {
      super(`Order not found on Shopify: ${orderGid}`);
      this.name = "OrderNotFoundError";
    }
  }
  return {
    OrderNotFoundError,
    logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
    getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
    getOrderSummary: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
    enrichAcquisition: vi.fn(
      async (_domain: string, _shopId: string, _contractId: string): Promise<boolean> =>
        false,
    ),
  };
});

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

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/graphql/index.server", () => ({
  getContract: vi.fn(),
  getOrderSummary: mocks.getOrderSummary,
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  listContractGids: vi.fn(async (): Promise<unknown[]> => []),
  OrderNotFoundError: mocks.OrderNotFoundError,
}));

// The backfill's acquisition pickup goes through the webhooks module's stash
// handshake (lazy-imported seam). Its own behavior is pinned in
// tests/acquisition-capture.test.ts; here the seam is mocked so the job's
// orchestration (who gets called, how failures are contained) is what's tested.
vi.mock("~/lib/webhooks/handlers.server", () => ({
  enrichAcquisitionOnContractCreate: mocks.enrichAcquisition,
}));

import { runCohortComputation } from "~/lib/analytics/cohorts.server";
import { runDailyRollup } from "~/lib/analytics/rollup.server";
import {
  ORIGIN_BACKFILL_CAP,
  runOriginOrderBackfill,
} from "~/lib/contracts/sync.server";

// ── Fixture (mirrors the golden analytics shop: CHF, Europe/Zurich) ──────────

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
};

const NOW = new Date("2026-08-05T12:00:00Z");
const ORIGIN_ORDER = "gid://shopify/Order/501";

function D(iso: string): Date {
  return new Date(iso);
}

/** Serum 4990 (cost 1200) + 2× Night Cream 1500 (25% fallback) + a gift line. */
const LINES: Row[] = [
  {
    productId: "p1",
    variantId: "v1",
    title: "Serum",
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
    unitCostCents: 999, // must never enter per-cycle or origin COGS
    isGift: true,
    isOneTimeAddon: false,
  },
];

interface OriginOverrides {
  originOverrides?: Row;
  /** Add a successful BillingAttempt CLAIMING the origin order id. */
  attemptClaimsOrigin?: boolean;
  /** Strip the origin money mirror entirely (pre-capture contract). */
  noOriginMoney?: boolean;
}

function buildStore(opts: OriginOverrides = {}): AnalyticsStore {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  store.settings.push({ shopId: SHOP_ID, key: "costModel", value: COST_MODEL });

  const origin: Row = opts.noOriginMoney
    ? {
        originOrderId: ORIGIN_ORDER,
        originOrderTotalCents: null,
        originOrderDiscountCents: null,
        originOrderRefundedCents: 0,
        originOrderProcessedAt: null,
        originOrderCurrencyCode: null,
      }
    : {
        originOrderId: ORIGIN_ORDER,
        originOrderTotalCents: 8490,
        originOrderDiscountCents: 1000,
        originOrderRefundedCents: 500,
        originOrderProcessedAt: D("2026-06-10T10:00:00Z"),
        originOrderCurrencyCode: "CHF",
        ...opts.originOverrides,
      };

  const contract: Row = {
    id: "c_org",
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    cancelSource: null,
    cancelledAt: null,
    failedAt: null,
    createdAt: D("2026-06-01T08:00:00Z"),
    firstChargeAt: D("2026-06-10T10:00:00Z"),
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 500,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    ordersCount: 2,
    lines: LINES,
    ...origin,
  };
  store.subscriptionContracts.push(contract);

  // One ordinary renewal in August — proves renewals still book normally.
  store.billingAttempts.push({
    id: "a_renewal",
    contractId: "c_org",
    contract,
    status: "SUCCESS",
    amountCents: 8490,
    refundedCents: 0,
    currencyCode: "CHF",
    orderId: "gid://shopify/Order/601",
    completedAt: D("2026-08-05T10:00:00Z"),
  });

  if (opts.attemptClaimsOrigin) {
    // The anomaly the double-count guard exists for: a successful attempt row
    // carrying the ORIGIN order's id.
    store.billingAttempts.push({
      id: "a_origin",
      contractId: "c_org",
      contract,
      status: "SUCCESS",
      amountCents: 8490,
      refundedCents: 500,
      currencyCode: "CHF",
      orderId: ORIGIN_ORDER,
      completedAt: D("2026-06-10T10:00:00Z"),
    });
  }

  return store;
}

async function computeCells(store: AnalyticsStore) {
  dbHolder.current = createAnalyticsDb(store) as unknown as Record<string, unknown>;
  const result = await runCohortComputation(SHOP_ID, NOW);
  return { result, cells: store.cohortCells };
}

const cellRow = (over: Row): Row => ({
  shopId: SHOP_ID,
  cohortMonth: "2026-06",
  cohortSize: 1,
  monthOffset: 0,
  activeRemaining: 1,
  revenueCents: 0,
  refundedCents: 0,
  discountCents: 0,
  cogsCents: 0,
  estimatedCogsCents: 0,
  shippingCostCents: 0,
  feesCents: 0,
  grossProfitCents: 0,
  cumGrossProfitCents: 0,
  ...over,
});

/**
 * Golden triangle with the origin payment captured:
 * - month 0 (June): origin 8490 − 500 refund = 7990 net; order-level discount
 *   1000; COGS 1200 + 2×375 = 1950 (est. share 750, gift excluded); shipping
 *   150 + 200 = 350; fees round(8490·2.9%) + 30 = 276 → GP 5414.
 * - month 2 (August): the renewal — 8490, per-cycle discount (5990−4990) =
 *   1000, same costs → GP 5914. Cumulative 11328.
 */
const GOLDEN_CELLS: Row[] = [
  cellRow({
    monthOffset: 0,
    revenueCents: 7990,
    refundedCents: 500,
    discountCents: 1000,
    cogsCents: 1950,
    estimatedCogsCents: 750,
    shippingCostCents: 350,
    feesCents: 276,
    grossProfitCents: 5414,
    cumGrossProfitCents: 5414,
  }),
  cellRow({ monthOffset: 1, cumGrossProfitCents: 5414 }),
  cellRow({
    monthOffset: 2,
    revenueCents: 8490,
    discountCents: 1000,
    cogsCents: 1950,
    estimatedCogsCents: 750,
    shippingCostCents: 350,
    feesCents: 276,
    grossProfitCents: 5914,
    cumGrossProfitCents: 11_328,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = null;
});

// ── Cohort month 0 includes the origin payment ───────────────────────────────

describe("runCohortComputation — origin payment in month 0", () => {
  it("books the origin payment net of origin refunds with cost-model fees (golden numbers)", async () => {
    const { result, cells } = await computeCells(buildStore());
    expect(result).toEqual({ cohorts: 1, cells: 3 });
    expect(cells).toEqual(GOLDEN_CELLS);
  });

  it("cumulative LTGP now contains the first payment (was renewals-only before 0006)", async () => {
    const withOrigin = await computeCells(buildStore());
    const preCapture = await computeCells(buildStore({ noOriginMoney: true }));
    const cum = (cells: Row[]) =>
      cells.find((c) => c.monthOffset === 2)!.cumGrossProfitCents as number;
    // Renewals alone: only the August GP. With the captured origin payment the
    // same contract's LTGP is higher by exactly the origin month's GP.
    expect(cum(preCapture.cells)).toBe(5914);
    expect(cum(withOrigin.cells)).toBe(11_328);
    expect(cum(withOrigin.cells) - cum(preCapture.cells)).toBe(5414);
  });

  it("a contract whose origin money is not yet captured contributes renewals only (no guess)", async () => {
    const { cells } = await computeCells(buildStore({ noOriginMoney: true }));
    expect(cells.find((c) => c.monthOffset === 0)).toEqual(
      cellRow({ monthOffset: 0 }),
    );
  });

  it("recomputation is idempotent — the triangle is replaced, never appended", async () => {
    const store = buildStore();
    dbHolder.current = createAnalyticsDb(store) as unknown as Record<string, unknown>;
    await runCohortComputation(SHOP_ID, NOW);
    await runCohortComputation(SHOP_ID, NOW);
    expect(store.cohortCells).toEqual(GOLDEN_CELLS);
  });

  it("clamps an over-refunded origin payment at zero revenue instead of going negative", async () => {
    const { cells } = await computeCells(
      buildStore({ originOverrides: { originOrderRefundedCents: 99_999 } }),
    );
    const month0 = cells.find((c) => c.monthOffset === 0)!;
    expect(month0.revenueCents).toBe(0);
    expect(month0.refundedCents).toBe(8490); // clamped to the captured total
  });

  it("never sums a foreign-currency origin total into shop-currency cells", async () => {
    const { cells } = await computeCells(
      buildStore({ originOverrides: { originOrderCurrencyCode: "EUR" } }),
    );
    expect(cells.find((c) => c.monthOffset === 0)).toEqual(
      cellRow({ monthOffset: 0 }),
    );
    // The renewal is untouched by the origin guard.
    expect(cells.find((c) => c.monthOffset === 2)!.revenueCents).toBe(8490);
  });

  it("requires a processed instant — a total without a booking day is skipped", async () => {
    const { cells } = await computeCells(
      buildStore({ originOverrides: { originOrderProcessedAt: null } }),
    );
    expect(cells.find((c) => c.monthOffset === 0)!.revenueCents).toBe(0);
  });
});

// ── THE double-count guard ───────────────────────────────────────────────────

describe("origin payment double-count guard (attempt wins, counts once)", () => {
  it("cohorts: an origin order claimed by a successful BillingAttempt books once", async () => {
    // Store A: origin mirror captured AND a successful attempt carries the
    // origin order id. Store B: the attempt alone (mirror not captured).
    // If the guard holds, A ≡ B — the money exists once either way.
    const claimed = await computeCells(buildStore({ attemptClaimsOrigin: true }));
    const attemptOnly = await computeCells(
      buildStore({ attemptClaimsOrigin: true, noOriginMoney: true }),
    );
    expect(claimed.cells).toEqual(attemptOnly.cells);

    // And the month-0 revenue is the single net amount, not 2× anything.
    const month0 = claimed.cells.find((c) => c.monthOffset === 0)!;
    expect(month0.revenueCents).toBe(7990);
    expect(month0.feesCents).toBe(276); // one charge's fees, not two
  });

  it("rollup: the origin's processed day books the payment once too", async () => {
    const mirrorOnly = buildStore();
    dbHolder.current = createAnalyticsDb(mirrorOnly) as unknown as Record<string, unknown>;
    await runDailyRollup(SHOP_ID, D("2026-06-10T12:00:00Z"));
    const goldenDay = mirrorOnly.dailyRollups[0];

    // Origin mirror present: the checkout money is in the day's numbers.
    expect(goldenDay).toMatchObject({
      chargedCents: 8490,
      discountCents: 1000,
      feesCents: 276,
      shippingCostCents: 350,
      estGrossProfitCents: 8490 - 1950 - 350 - 276,
      newSubscribers: 1,
    });

    // Mirror AND claiming attempt: identical day — never 16980.
    const claimed = buildStore({ attemptClaimsOrigin: true });
    dbHolder.current = createAnalyticsDb(claimed) as unknown as Record<string, unknown>;
    await runDailyRollup(SHOP_ID, D("2026-06-10T12:00:00Z"));
    expect(claimed.dailyRollups[0]).toEqual(goldenDay);
  });
});

// ── origin_order_backfill job ────────────────────────────────────────────────

describe("runOriginOrderBackfill", () => {
  interface BackfillDb {
    subscriptionContract: {
      findMany: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
  }

  /**
   * The job now issues TWO findMany calls: the money query (originOrderTotal-
   * Cents null) and the acquisition query (acqRaw null). The mock keys off the
   * where clause so each pass gets its own book.
   */
  function backfillDb(pending: Row[], acqPending: Row[] = []): BackfillDb {
    const db: BackfillDb = {
      subscriptionContract: {
        findMany: vi.fn(async (args?: unknown) => {
          const where =
            ((args as { where?: Row } | undefined)?.where as Row | undefined) ??
            {};
          return "acqRaw" in where ? acqPending : pending;
        }),
        updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
      },
    };
    dbHolder.current = db as unknown as Record<string, unknown>;
    return db;
  }

  /** Money-pass retirements + the whole acquisition pass: all quiet. */
  const NO_ACQ = {
    exhausted: 0,
    acqScanned: 0,
    acqApplied: 0,
    acqFailed: 0,
    acqExhausted: 0,
  };

  const pendingContract: Row = {
    id: "c_pending",
    customerId: "gid://shopify/Customer/7",
    email: "sub@example.com",
    currencyCode: "CHF",
    originOrderId: ORIGIN_ORDER,
    createdAt: D("2026-06-01T08:00:00Z"), // mirrored months ago
  };

  const orderSummary = {
    totalCents: 8490,
    discountsCents: 1000,
    shippingCents: 500,
    processedAt: D("2026-06-10T10:00:00Z"),
    createdAt: D("2026-06-10T09:59:00Z"),
    currencyCode: "CHF",
  };

  beforeEach(() => {
    mocks.getPrimaryShop.mockResolvedValue({ ...SHOP });
    mocks.getOrderSummary.mockResolvedValue(orderSummary);
  });

  it("skips cleanly when no shop is installed", async () => {
    mocks.getPrimaryShop.mockResolvedValue(null);
    expect(await runOriginOrderBackfill()).toEqual({ skipped: "no_shop" });
  });

  it("selects exactly OURS, non-demo contracts with an order id and no captured total — capped, oldest first", async () => {
    const db = backfillDb([]);
    await runOriginOrderBackfill();

    const args = db.subscriptionContract.findMany.mock.calls[0][0] as {
      where: Row;
      orderBy: Row;
      take: number;
    };
    expect(args.take).toBe(ORIGIN_BACKFILL_CAP);
    expect(args.orderBy).toEqual({ createdAt: "asc" });

    // Apply the REAL where clause to a candidate zoo: only the eligible
    // contract may pass. A dropped ownership/demo/null-total leg shows up
    // here as an extra match.
    const eligible = {
      shopId: SHOP_ID, ownership: "OURS", isDemo: false,
      originOrderId: ORIGIN_ORDER, originOrderTotalCents: null,
      originCaptureExhaustedAt: null,
    };
    const rejected: Row[] = [
      { ...eligible, ownership: "FOREIGN" }, // another app's subscriber
      { ...eligible, ownership: "UNKNOWN" }, // unproven — fails safe
      { ...eligible, isDemo: true }, // portal demo fixture
      { ...eligible, originOrderId: null }, // no origin order (import)
      { ...eligible, originOrderTotalCents: 8490 }, // already captured
      // Proven permanently unfetchable (order-not-found past the grace
      // horizon) — retired rows must never re-occupy the capped window.
      { ...eligible, originCaptureExhaustedAt: D("2026-08-01T00:00:00Z") },
      { ...eligible, shopId: "other_shop" },
    ];
    expect(matchesWhere(eligible, args.where)).toBe(true);
    for (const row of rejected) {
      expect(matchesWhere(row, args.where), JSON.stringify(row)).toBe(false);
    }
  });

  it("captures the money mirror and logs origin_order_captured", async () => {
    const db = backfillDb([pendingContract]);
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({ scanned: 1, captured: 1, failed: 0, ...NO_ACQ });

    const update = db.subscriptionContract.updateMany.mock.calls[0][0] as {
      where: Row;
      data: Row;
    };
    // Idempotent claim: only fills a still-null mirror.
    expect(update.where).toEqual({
      id: "c_pending",
      originOrderTotalCents: null,
    });
    expect(update.data).toEqual({
      originOrderTotalCents: 8490,
      originOrderDiscountCents: 1000,
      originOrderShippingChargedCents: 500,
      originOrderProcessedAt: D("2026-06-10T10:00:00Z"),
      originOrderCurrencyCode: "CHF",
    });
    // Refunds are never written here — only REFUNDS_CREATE increments them.
    expect(update.data).not.toHaveProperty("originOrderRefundedCents");

    const events = mocks.logEvent.mock.calls.map((c) => c[0]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "contract.updated",
      source: "SCHEDULER",
      contractId: "c_pending",
      payload: {
        action: "origin_order_captured",
        originOrderId: ORIGIN_ORDER,
        totalCents: 8490,
      },
    });
  });

  it("a lost claim race (concurrent capture) writes nothing and logs nothing", async () => {
    const db = backfillDb([pendingContract]);
    db.subscriptionContract.updateMany.mockResolvedValue({ count: 0 });
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({ scanned: 1, captured: 0, failed: 0, ...NO_ACQ });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("contains per-contract failures — one dead order GID never stalls the queue", async () => {
    const db = backfillDb([
      { ...pendingContract, id: "c_dead", originOrderId: "gid://shopify/Order/404" },
      pendingContract,
    ]);
    mocks.getOrderSummary
      .mockRejectedValueOnce(new Error("order not found"))
      .mockResolvedValueOnce(orderSummary);
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({ scanned: 2, captured: 1, failed: 1, ...NO_ACQ });
    // The dead contract wrote nothing; the healthy one captured.
    expect(db.subscriptionContract.updateMany).toHaveBeenCalledTimes(1);
  });

  // ── Money-pass drainability (the 0011 starvation fix) ──────────────────────
  // Without the read_all_orders scope the Admin API answers `order: null` —
  // getOrderSummary's OrderNotFoundError — for EVERY order older than 60
  // days, and forever for deleted / GDPR-erased orders. Those rows failed
  // every night yet never left the oldest-first window; once >= cap of them
  // existed the entire window was dead and the fetchable rows this job exists
  // for (capture-at-sync hiccup, UNKNOWN reclassified OURS in time) sorted
  // after them forever. A conclusive not-found past the grace horizon now
  // retires the row (originCaptureExhaustedAt — the money twin of 0010).

  it("money pass: order-not-found past the grace horizon is stamped terminal and leaves the queue", async () => {
    const db = backfillDb([pendingContract]); // mirrored months ago
    mocks.getOrderSummary.mockRejectedValue(
      new mocks.OrderNotFoundError(ORIGIN_ORDER),
    );
    const result = await runOriginOrderBackfill();

    // Retired, NOT failed: the row will never burn another round trip.
    expect(result).toEqual({
      scanned: 1, captured: 0, failed: 0, ...NO_ACQ, exhausted: 1,
    });
    const mark = db.subscriptionContract.updateMany.mock.calls[0][0] as {
      where: Row;
      data: Row;
    };
    // The stamp is an atomic claim: the mirror must STILL be uncaptured (a
    // concurrent sync-capture that just filled the row wins — it has already
    // left the queue anyway) and un-stamped.
    expect(mark.where).toEqual({
      id: "c_pending",
      originOrderTotalCents: null,
      originCaptureExhaustedAt: null,
    });
    // Terminal means terminal: nothing else is written — no invented money
    // fields, and no origin_order_captured event for money never captured.
    expect(Object.keys(mark.data)).toEqual(["originCaptureExhaustedAt"]);
    expect(mark.data.originCaptureExhaustedAt).toBeInstanceOf(Date);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("money pass: order-not-found on a FRESH mirror is retried, not retired (read-lag grace)", async () => {
    const db = backfillDb([
      {
        ...pendingContract,
        id: "c_fresh",
        createdAt: new Date(Date.now() - 60_000), // mirrored a minute ago
      },
    ]);
    mocks.getOrderSummary.mockRejectedValue(
      new mocks.OrderNotFoundError(ORIGIN_ORDER),
    );
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({ scanned: 1, captured: 0, failed: 1, ...NO_ACQ });
    expect(db.subscriptionContract.updateMany).not.toHaveBeenCalled();
  });

  it("money pass: a transient error is NEVER stamped, however old the row — only a conclusive not-found may retire", async () => {
    const db = backfillDb([pendingContract]); // months old
    mocks.getOrderSummary.mockRejectedValue(new Error("throttled: 429"));
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({ scanned: 1, captured: 0, failed: 1, ...NO_ACQ });
    expect(db.subscriptionContract.updateMany).not.toHaveBeenCalled();
  });

  it("money pass: a lost stamp race (concurrent capture just filled the row) counts nothing", async () => {
    const db = backfillDb([pendingContract]);
    db.subscriptionContract.updateMany.mockResolvedValue({ count: 0 });
    mocks.getOrderSummary.mockRejectedValue(
      new mocks.OrderNotFoundError(ORIGIN_ORDER),
    );
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({
      scanned: 1, captured: 0, failed: 0, ...NO_ACQ,
    });
  });

  it("falls back to the contract's currency / order createdAt when Shopify omits them", async () => {
    const db = backfillDb([pendingContract]);
    mocks.getOrderSummary.mockResolvedValue({
      ...orderSummary,
      processedAt: null,
      currencyCode: null,
    });
    await runOriginOrderBackfill();
    const update = db.subscriptionContract.updateMany.mock.calls[0][0] as {
      data: Row;
    };
    expect(update.data.originOrderCurrencyCode).toBe("CHF"); // contract's, never "GBP"
    expect(update.data.originOrderProcessedAt).toEqual(D("2026-06-10T09:59:00Z"));
  });

  // ── Acquisition stash pickup (the retry path the handshake was missing) ────
  // The online handshake has exactly two triggers (ORDERS_CREATE direct-persist
  // and the contract-create/catch-up webhooks) and both can fire while the
  // contract is not yet billable — e.g. mirrored UNKNOWN because the plan-
  // evidence fetch failed, reclassified OURS later. Without this daily pickup
  // the captured bundle sits in the event log while acq* stays null forever.

  it("acquisition pass: selects exactly OURS, non-demo contracts with an order id and no acqRaw", async () => {
    const db = backfillDb([]);
    await runOriginOrderBackfill();

    const acqCall = db.subscriptionContract.findMany.mock.calls
      .map((c) => c[0] as { where: Row; orderBy: Row; take: number })
      .find((args) => "acqRaw" in args.where);
    expect(acqCall).toBeDefined();
    expect(acqCall!.take).toBe(ORIGIN_BACKFILL_CAP);
    expect(acqCall!.orderBy).toEqual({ createdAt: "asc" });

    const eligible = {
      shopId: SHOP_ID, ownership: "OURS", isDemo: false,
      originOrderId: ORIGIN_ORDER, acqRaw: null, acqPickupExhaustedAt: null,
    };
    const rejected: Row[] = [
      { ...eligible, ownership: "FOREIGN" }, // another app's subscriber — never profiled
      { ...eligible, ownership: "UNKNOWN" }, // unproven — fails safe
      { ...eligible, isDemo: true },
      { ...eligible, originOrderId: null }, // no origin order → no stash key
      { ...eligible, acqRaw: { sourceName: "web" } }, // already captured
      // Proven unfillable (no stash past the grace horizon, or redacted) —
      // retired rows must never re-occupy the capped oldest-first window.
      { ...eligible, acqPickupExhaustedAt: D("2026-08-01T00:00:00Z") },
      { ...eligible, shopId: "other_shop" },
    ];
    expect(matchesWhere(eligible, acqCall!.where)).toBe(true);
    for (const row of rejected) {
      expect(matchesWhere(row, acqCall!.where), JSON.stringify(row)).toBe(false);
    }
  });

  it("acquisition pass: re-runs the stash pickup per pending contract and counts real applies", async () => {
    backfillDb([], [
      // Reclassified long after create — the very row the retry path exists
      // for. Old, but its stash EXISTS, so it applies (never retired).
      { id: "c_reclassified", createdAt: D("2026-06-01T08:00:00Z") },
      // Created moments ago: ORDERS_CREATE may simply not have arrived yet.
      { id: "c_no_stash_yet", createdAt: new Date(Date.now() - 60_000) },
    ]);
    mocks.enrichAcquisition
      .mockResolvedValueOnce(true) // stash found and persisted
      .mockResolvedValueOnce(false); // no stash yet — retried next run
    const result = await runOriginOrderBackfill();

    expect(mocks.enrichAcquisition.mock.calls).toEqual([
      [SHOP.domain, SHOP_ID, "c_reclassified"],
      [SHOP.domain, SHOP_ID, "c_no_stash_yet"],
    ]);
    expect(result).toEqual({
      scanned: 0, captured: 0, failed: 0, exhausted: 0,
      acqScanned: 2, acqApplied: 1, acqFailed: 0, acqExhausted: 0,
    });
  });

  it("acquisition pass: contains per-contract failures and never blocks the money pass", async () => {
    const db = backfillDb(
      [pendingContract],
      [
        // Old rows: an ERROR is transient (retried next run, never retired) —
        // only a clean "no stash" verdict past the grace horizon may retire.
        { id: "c_boom", createdAt: D("2026-06-01T08:00:00Z") },
        { id: "c_ok", createdAt: D("2026-06-01T08:00:00Z") },
      ],
    );
    mocks.enrichAcquisition
      .mockRejectedValueOnce(new Error("event log unavailable"))
      .mockResolvedValueOnce(true);
    const result = await runOriginOrderBackfill();

    expect(result).toEqual({
      scanned: 1, captured: 1, failed: 0, exhausted: 0,
      acqScanned: 2, acqApplied: 1, acqFailed: 1, acqExhausted: 0,
    });
    // The money mirror still captured despite the acquisition failure — and
    // exactly ONE updateMany ran (the money capture): the errored contract
    // was NOT stamped terminal.
    expect(db.subscriptionContract.updateMany).toHaveBeenCalledTimes(1);
  });

  // ── Queue drainability (the starvation fix) ────────────────────────────────
  // Without a terminal marker, rows that can NEVER be filled — pre-0006
  // contracts whose ORDERS_CREATE predates the stash feature, redacted
  // contracts whose stash payloads were cleared — sat in the oldest-first
  // window forever; once ≥ cap of them existed, the newest (reclassified)
  // contracts the pass exists for could never be scanned again.

  it("acquisition pass: a no-stash row past the grace horizon is stamped terminal and leaves the queue", async () => {
    const db = backfillDb([], [
      { id: "c_pre_feature", createdAt: D("2026-06-01T08:00:00Z") }, // months old
    ]);
    mocks.enrichAcquisition.mockResolvedValue(false); // no stash, ever
    const result = await runOriginOrderBackfill();

    expect(result).toEqual({
      scanned: 0, captured: 0, failed: 0, exhausted: 0,
      acqScanned: 1, acqApplied: 0, acqFailed: 0, acqExhausted: 1,
    });
    const mark = db.subscriptionContract.updateMany.mock.calls[0][0] as {
      where: Row;
      data: Row;
    };
    // The stamp is an atomic claim: acqRaw must STILL be null (a concurrent
    // direct-persist that just filled the row wins) and un-stamped.
    expect(mark.where).toMatchObject({ id: "c_pre_feature", acqPickupExhaustedAt: null });
    expect(mark.where).toHaveProperty("acqRaw");
    expect(mark.data.acqPickupExhaustedAt).toBeInstanceOf(Date);
    // Terminal means terminal: nothing else is written — acq* data columns
    // stay null and the money mirror is untouched.
    expect(Object.keys(mark.data)).toEqual(["acqPickupExhaustedAt"]);
  });

  it("acquisition pass: a young no-stash row is retried, not retired (webhook race grace)", async () => {
    const db = backfillDb([], [
      { id: "c_fresh", createdAt: new Date(Date.now() - 60_000) },
    ]);
    mocks.enrichAcquisition.mockResolvedValue(false);
    const result = await runOriginOrderBackfill();

    expect(result).toEqual({
      scanned: 0, captured: 0, failed: 0, exhausted: 0,
      acqScanned: 1, acqApplied: 0, acqFailed: 0, acqExhausted: 0,
    });
    expect(db.subscriptionContract.updateMany).not.toHaveBeenCalled();
  });

  it("acquisition pass: a lost stamp race (concurrent fill) counts nothing", async () => {
    const db = backfillDb([], [
      { id: "c_raced", createdAt: D("2026-06-01T08:00:00Z") },
    ]);
    db.subscriptionContract.updateMany.mockResolvedValue({ count: 0 });
    mocks.enrichAcquisition.mockResolvedValue(false);
    const result = await runOriginOrderBackfill();
    expect(result).toEqual({
      scanned: 0, captured: 0, failed: 0, exhausted: 0,
      acqScanned: 1, acqApplied: 0, acqFailed: 0, acqExhausted: 0,
    });
  });
});

// ── UI honesty: the renewals-only era is over ────────────────────────────────

describe("app.analytics.tsx no longer disclaims renewals-only LTGP", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/routes/app.analytics.tsx", import.meta.url)),
    "utf8",
  );

  it('carries no "renewals-only" (or variant) disclaimer anywhere', () => {
    expect(source).not.toMatch(/renewals?[-\s_]only/i);
  });

  it("no longer claims the first payment is excluded", () => {
    expect(source).not.toMatch(/first[\s(]+(checkout[\s)]+)?payment[^.]*exclud/i);
    expect(source).not.toMatch(/exclud\w*[^.]*first (payment|order)/i);
    expect(source).not.toMatch(/never becomes a billing attempt/i);
  });

  it("says instead that first orders are included where captured", () => {
    expect(source).toMatch(/first orders included where captured/i);
  });
});
