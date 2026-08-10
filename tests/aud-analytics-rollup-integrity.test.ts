import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * DailyRollup integrity (migration 0016 era):
 *
 * - refund currency guard: a foreign-presentment refund is never subtracted
 *   from shop-currency revenue its matching charge was excluded from;
 * - excludedForeignCurrencyCents: every cent a currency guard silently drops
 *   (attempts + origin totals + refunds) is accumulated so the exclusion is
 *   visible and sizeable instead of indistinguishable from "no sales";
 * - the unified "recovered" definition (money actually collected —
 *   recoveredCents non-null — regardless of resolution kind), shared verbatim
 *   by DailyRollup.recoveredCents and the dashboard's recoveredThisMonthCents,
 *   currency-guarded through the recovering attempt;
 * - savesOffered/savesAccepted fold the step-4 final offer in;
 * - EXPIRED churn: expiredAt-in-day counts as VOLUNTARY churn (the shared
 *   classification) on the rollup, and cohort activeRemaining churns at
 *   expiredAt;
 * - the documented over-refund divergence (rollup books the raw recorded
 *   amount; cohorts clamp at the captured total);
 * - backfill mode: fabricated snapshot columns stay 0 and the row is flagged.
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
import { getDashboardStats, getFunnelMetrics } from "~/lib/analytics/queries.server";

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

const DAY = new Date("2026-08-05T12:00:00Z");

function D(iso: string): Date {
  return new Date(iso);
}

function baseStore(): { store: AnalyticsStore; contract: Row } {
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
    createdAt: D("2026-06-01T08:00:00Z"),
    firstChargeAt: D("2026-06-10T10:00:00Z"),
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    ordersCount: 2,
    lines: [],
  };
  store.subscriptionContracts.push(contract);
  return { store, contract };
}

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

async function rollup(store: AnalyticsStore, opts?: { backfill?: boolean }) {
  dbHolder.current = createAnalyticsDb(store);
  await runDailyRollup(SHOP_ID, DAY, opts);
  return store.dailyRollups[0];
}

afterEach(() => {
  vi.useRealTimers();
});

// ── Refund currency guard + the exclusion audit counter ──────────────────────

describe("foreign-currency exclusions are guarded AND visible", () => {
  it("a foreign-presentment refund is excluded from refundedCents (its charge was never summed either)", async () => {
    const { store, contract } = baseStore();
    store.subscriberEvents.push(
      event("e_eur_refund", "admin.action", contract, {
        action: "refund_recorded",
        amountCents: 3000,
        currencyCode: "EUR",
        orderId: "gid://shopify/Order/1",
      }),
    );
    const row = await rollup(store);
    expect(row.refundedCents).toBe(0);
    expect(row.excludedForeignCurrencyCents).toBe(3000);
  });

  it("a refund payload without currencyCode still nets — mismatch must be provable (legacy tolerance)", async () => {
    const { store, contract } = baseStore();
    store.subscriberEvents.push(
      event("e_legacy_refund", "admin.action", contract, {
        action: "refund_recorded",
        amountCents: 1500,
        orderId: "gid://shopify/Order/2",
      }),
    );
    const row = await rollup(store);
    expect(row.refundedCents).toBe(1500);
    expect(row.excludedForeignCurrencyCents).toBe(0);
  });

  it("accumulates every silent exclusion: foreign attempt + foreign origin total + foreign refund", async () => {
    const { store, contract } = baseStore();
    // Foreign-presentment attempt (EUR 60.00).
    store.billingAttempts.push({
      id: "a_eur",
      contractId: "c1",
      contract,
      status: "SUCCESS",
      amountCents: 6000,
      refundedCents: 0,
      currencyCode: "EUR",
      completedAt: D("2026-08-05T10:00:00Z"),
    });
    // Foreign-captured origin payment (EUR 70.00) processed in-day.
    const cEurOrigin: Row = {
      ...baseStore().contract,
      id: "c_eur_origin",
      originOrderId: "gid://shopify/Order/9",
      originOrderTotalCents: 7000,
      originOrderDiscountCents: 0,
      originOrderRefundedCents: 0,
      originOrderProcessedAt: D("2026-08-05T09:00:00Z"),
      originOrderCurrencyCode: "EUR",
      firstChargeAt: D("2026-08-01T09:00:00Z"),
    };
    store.subscriptionContracts.push(cEurOrigin);
    // Foreign refund (EUR 20.00).
    store.subscriberEvents.push(
      event("e_eur_refund", "admin.action", contract, {
        action: "refund_recorded",
        amountCents: 2000,
        currencyCode: "EUR",
        orderId: "gid://shopify/Order/3",
      }),
    );
    const row = await rollup(store);
    // None of it entered the money columns…
    expect(row.chargedCents).toBe(0);
    expect(row.refundedCents).toBe(0);
    // …and all of it is audited (raw foreign cents: 6000 + 7000 + 2000).
    expect(row.excludedForeignCurrencyCents).toBe(15_000);
  });
});

// ── Over-refund: the documented rollup/cohort divergence ─────────────────────

describe("over-refund handling (documented divergence)", () => {
  it("the rollup books the raw recorded amount on the refund day — no clamp against the charge", async () => {
    const { store, contract } = baseStore();
    store.billingAttempts.push({
      id: "a1",
      contractId: "c1",
      contract,
      status: "SUCCESS",
      amountCents: 5000,
      refundedCents: 5000,
      currencyCode: "CHF",
      completedAt: D("2026-08-05T10:00:00Z"),
    });
    // The REFUNDS_CREATE writer recorded more than was ever charged (order
    // edited upward on Shopify, or a corrupt payload). The rollup has no
    // cross-day join back to the charge, so the day ledger books the full
    // 8000 while the cohort surface clamps at the attempt amount — the
    // divergence the module docs accept and document.
    store.subscriberEvents.push(
      event("e_over_refund", "admin.action", contract, {
        action: "refund_recorded",
        amountCents: 8000,
        currencyCode: "CHF",
        orderId: "gid://shopify/Order/4",
      }),
    );
    const row = await rollup(store);
    expect(row.refundedCents).toBe(8000);

    // Cohort side of the same book: refunds clamp at the charged amount.
    await runCohortComputation(SHOP_ID, DAY);
    const cell = store.cohortCells.find((c) => c.monthOffset === 2);
    expect(cell?.refundedCents).toBe(5000);
    expect(cell?.revenueCents).toBe(0); // never negative
  });
});

// ── The unified "recovered" definition ───────────────────────────────────────

/**
 * Five resolved cases, resolvedAt on the rollup day:
 * - RECOVERED, 4990, CHF attempt            → counts
 * - same-cycle CUSTOMER_FIXED, 2000, CHF    → counts (real money — 3DS pass)
 * - cross-cycle CUSTOMER_FIXED, null        → no money, never counts
 * - RECOVERED, 3000, EUR attempt            → provably foreign, excluded
 * - RECOVERED, 500, no recoveredAttemptId   → unprovable currency, counts
 * Expected on BOTH surfaces: 4990 + 2000 + 500 = 7490.
 */
function recoveredStore(): AnalyticsStore {
  const { store, contract } = baseStore();
  // Currency-lookup attempts (recovery charges from earlier days — outside
  // the rollup day window on purpose, so only their currency matters here).
  store.billingAttempts.push(
    { id: "a_chf1", currencyCode: "CHF" },
    { id: "a_chf2", currencyCode: "CHF" },
    { id: "a_eur", currencyCode: "EUR" },
  );
  const kase = (id: string, over: Row): Row => ({
    id,
    contractId: "c1",
    contract,
    state: "RESOLVED",
    resolvedAt: D("2026-08-05T11:00:00Z"),
    ...over,
  });
  store.dunningCases.push(
    kase("dc1", { resolution: "RECOVERED", recoveredCents: 4990, recoveredAttemptId: "a_chf1" }),
    kase("dc2", { resolution: "CUSTOMER_FIXED", recoveredCents: 2000, recoveredAttemptId: "a_chf2" }),
    kase("dc3", { resolution: "CUSTOMER_FIXED", recoveredCents: null, recoveredAttemptId: "a_chf2" }),
    kase("dc4", { resolution: "RECOVERED", recoveredCents: 3000, recoveredAttemptId: "a_eur" }),
    kase("dc5", { resolution: "RECOVERED", recoveredCents: 500, recoveredAttemptId: null }),
  );
  return store;
}

describe("recovered money — one definition on both surfaces", () => {
  it("rollup: sums money-carrying resolutions of either kind, currency-guarded via the attempt", async () => {
    const row = await rollup(recoveredStore());
    expect(row.recoveredCents).toBe(7490);
  });

  it("dashboard: recoveredThisMonthCents applies the identical predicate", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(D("2026-08-15T12:00:00Z")); // resolvedAt is this month
    dbHolder.current = createAnalyticsDb(recoveredStore());
    const stats = await getDashboardStats(SHOP_ID);
    expect(stats.recoveredThisMonthCents).toBe(7490);
  });
});

// ── Final-offer saves in the daily ledger ────────────────────────────────────

describe("savesOffered/savesAccepted include the step-4 final offer", () => {
  it("folds cancel.final_offer_shown/accepted in, still demo-guarded", async () => {
    const { store, contract } = baseStore();
    const demo: Row = { ...contract, id: "c_demo", isDemo: true };
    store.subscriptionContracts.push(demo);
    store.subscriberEvents.push(
      event("e1", "cancel.save_shown", contract),
      event("e2", "cancel.final_offer_shown", contract),
      event("e3", "cancel.final_offer_accepted", contract),
      // Demo-portal final-offer interactions must never count.
      event("e4", "cancel.final_offer_shown", demo),
      event("e5", "cancel.final_offer_accepted", demo),
    );
    const row = await rollup(store);
    expect(row.savesOffered).toBe(2); // save_shown + final_offer_shown
    expect(row.savesAccepted).toBe(1); // final_offer_accepted
  });
});

// ── EXPIRED churn (shared voluntary classification) ──────────────────────────

describe("EXPIRED contracts churn at expiredAt", () => {
  it("rollup: expiredAt-in-day counts as voluntary churn, not involuntary, not a cancel", async () => {
    const { store, contract } = baseStore();
    contract.status = "EXPIRED";
    contract.expiredAt = D("2026-08-05T09:00:00Z");
    const row = await rollup(store);
    expect(row.churnedVoluntary).toBe(1);
    expect(row.churnedInvoluntary).toBe(0);
    expect(row.cancels).toBe(0); // no cancelledAt — it completed, wasn't cancelled
  });

  it("rollup: a pre-0016 expiry (no expiredAt) stays uncounted — the instant was never recorded", async () => {
    const { store, contract } = baseStore();
    contract.status = "EXPIRED";
    contract.expiredAt = null;
    const row = await rollup(store);
    expect(row.churnedVoluntary).toBe(0);
  });

  it("cohorts: activeRemaining drops in the expiry month; null expiredAt stays retained", async () => {
    const { store, contract } = baseStore();
    contract.status = "EXPIRED";
    contract.expiredAt = D("2026-08-05T09:00:00Z"); // June cohort, expires in August
    dbHolder.current = createAnalyticsDb(store);
    await runCohortComputation(SHOP_ID, DAY);
    const remaining = store.cohortCells.map((c) => [
      c.monthOffset,
      c.activeRemaining,
    ]);
    // Retained through June & July month-ends, churned by August's.
    expect(remaining).toEqual([
      [0, 1],
      [1, 1],
      [2, 0],
    ]);

    contract.expiredAt = null; // pre-0016 expiry: retained (documented legacy)
    await runCohortComputation(SHOP_ID, DAY);
    expect(
      store.cohortCells.find((c) => c.monthOffset === 2)?.activeRemaining,
    ).toBe(1);
  });
});

// ── EXTERNAL cancels (CM-3 read side) ────────────────────────────────────────

describe("EXTERNAL cancels count as voluntary churn", () => {
  it("rollup: a Shopify-side cancel (cancelSource EXTERNAL) lands in churnedVoluntary", async () => {
    // The collection side stamps EXTERNAL for cancels first observed FROM
    // Shopify; the read side must not leave them in the SYSTEM neither-bucket
    // — that was exactly the invisibility the EXTERNAL stamp exists to end.
    const { store, contract } = baseStore();
    contract.status = "CANCELLED";
    contract.cancelSource = "EXTERNAL";
    contract.cancelledAt = D("2026-08-05T09:00:00Z");
    const row = await rollup(store);
    expect(row.churnedVoluntary).toBe(1);
    expect(row.churnedInvoluntary).toBe(0);
    expect(row.cancels).toBe(1);
  });

  it("rollup: SYSTEM (merge bookkeeping) still counts in neither churn column", async () => {
    const { store, contract } = baseStore();
    contract.status = "CANCELLED";
    contract.cancelSource = "SYSTEM";
    contract.cancelReason = "MERGED";
    contract.cancelledAt = D("2026-08-05T09:00:00Z");
    const row = await rollup(store);
    expect(row.churnedVoluntary).toBe(0);
    expect(row.churnedInvoluntary).toBe(0);
    expect(row.cancels).toBe(1);
  });
});

// ── Funnel: merges are not churn (FR-10, funnel leg) ─────────────────────────

describe("skipToCancelRatio excludes consolidation merges", () => {
  it("a merge-cancelled contract does not deflate the ratio", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(D("2026-08-06T12:00:00Z"));

    const { store, contract } = baseStore();
    // One REAL cancel in range…
    const cancelled: Row = {
      ...contract,
      id: "c_cancelled",
      status: "CANCELLED",
      cancelSource: "CUSTOMER",
      cancelReason: null,
      cancelledAt: D("2026-08-01T09:00:00Z"),
      lines: [],
    };
    // …and a consolidation-batch merge: the customer STAYED (their contracts
    // were combined), so it must not count as a cancel in the funnel.
    const merged: Row = {
      ...contract,
      id: "c_merged",
      status: "CANCELLED",
      cancelSource: "SYSTEM",
      cancelReason: "MERGED",
      cancelledAt: D("2026-08-01T10:00:00Z"),
      lines: [],
    };
    store.subscriptionContracts.push(cancelled, merged);
    store.subscriberEvents.push(
      event("e_skip_1", "cycle.skipped", contract),
      event("e_skip_2", "cycle.skipped", contract),
    );
    dbHolder.current = createAnalyticsDb(store);

    const funnel = await getFunnelMetrics(SHOP_ID, 30);
    // 2 skips ÷ 1 real cancel — not ÷ 2 (the pre-fix deflated reading).
    expect(funnel.skipToCancelRatio).toBe(2);
  });
});

// ── Backfill mode (fabricated snapshots) ─────────────────────────────────────

describe("runDailyRollup backfill mode", () => {
  function activityStore(): AnalyticsStore {
    const { store, contract } = baseStore();
    store.billingAttempts.push({
      id: "a1",
      contractId: "c1",
      contract,
      status: "SUCCESS",
      amountCents: 8490,
      refundedCents: 0,
      currencyCode: "CHF",
      completedAt: D("2026-08-05T10:00:00Z"),
    });
    store.dunningCases.push({
      id: "dc_open",
      contractId: "c1",
      contract,
      state: "OPEN",
      resolution: null,
      resolvedAt: null,
      recoveredCents: null,
    });
    return store;
  }

  it("leaves snapshot columns at 0, flags the row, and still computes flow columns from source", async () => {
    const row = await rollup(activityStore(), { backfill: true });
    expect(row).toMatchObject({
      snapshotFabricated: true,
      // Point-in-time columns: unreconstructable for a past day — never
      // stamped with TODAY's book.
      activeSubscribers: 0,
      pausedSubscribers: 0,
      mrrCents: 0,
      openDunningCases: 0,
      prepaidActive: 0,
      // Flow columns recompute from source exactly as on a normal run.
      chargedCents: 8490,
      feesCents: 276,
    });
  });

  it("a later normal recompute of the same day restores real snapshots and clears the flag", async () => {
    const store = activityStore();
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, DAY, { backfill: true });
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups).toHaveLength(1);
    expect(store.dailyRollups[0]).toMatchObject({
      snapshotFabricated: false,
      activeSubscribers: 1,
      openDunningCases: 1,
      chargedCents: 8490,
    });
  });

  it("a backfill landing on a day that already has a REAL row preserves its snapshots", async () => {
    // The repair-re-upsert contract (late firstChargeAt backfills call this
    // path): flow columns recompute, but zeroing an existing row's
    // point-in-time snapshots would destroy history nothing can recompute —
    // and falsely flag the day fabricated.
    const store = activityStore();
    dbHolder.current = createAnalyticsDb(store);
    await runDailyRollup(SHOP_ID, DAY); // the real nightly run wrote the day
    // A late arrival lands in the day (flow columns must move on re-upsert).
    store.subscriptionContracts.push({
      ...(store.subscriptionContracts[0] as Row),
      id: "c_late",
      firstChargeAt: D("2026-08-05T09:00:00Z"),
      lines: [],
    });
    await runDailyRollup(SHOP_ID, DAY, { backfill: true });

    expect(store.dailyRollups).toHaveLength(1);
    expect(store.dailyRollups[0]).toMatchObject({
      // Snapshots + flag: untouched real history — activeSubscribers stays
      // at the nightly run's 1 even though the live book now holds 2 ACTIVE
      // contracts (a fresh snapshot would read 2; a zeroing overwrite 0).
      snapshotFabricated: false,
      activeSubscribers: 1,
      openDunningCases: 1,
      // Flow columns: recomputed from source (the late arrival counted).
      newSubscribers: 1,
      chargedCents: 8490,
    });
  });
});
