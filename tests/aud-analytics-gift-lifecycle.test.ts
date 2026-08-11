import { describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Gift COGS vs. the GiftGrant status lifecycle.
 *
 * A grant's status is TRANSIENT: attachGrantToCycle stamps ADDED (with
 * addedAt), settlement flips ADDED→SHIPPED the day the cycle bills, and the
 * next daily gifts_run's mirror hygiene flips SHIPPED→REMOVED. Both
 * gross-profit surfaces used to filter on status (rollup: ADDED only,
 * cohorts: ADDED/SHIPPED), so every gift's COGS vanished from the cohort
 * triangle within ~a day of shipping, and the rollup's trailing recompute
 * erased any gift attached ≤2 days before billing — estGrossProfitCents and
 * LTGP silently overstated by the gift program's entire cost.
 *
 * The fix keys both engines on the durable facts instead: addedAt (the
 * booking day/month) plus status in ADDED/SHIPPED OR shippedAt set — the
 * migration-0016 timestamp stamped at the SHIPPED flip that survives the
 * REMOVED flip. These tests walk one grant through the full lifecycle and
 * assert its COGS never leaves either surface; supersede-retired grants
 * (REMOVED, never shipped) must stay excluded.
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
const NOW = new Date("2026-08-05T12:00:00Z");

function D(iso: string): Date {
  return new Date(iso);
}

function buildStore(): { store: AnalyticsStore; grant: Row } {
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

  // The grant under test: attached pre-charge on the rollup day.
  const grant: Row = {
    id: "g1",
    contractId: "c1",
    contract,
    variantId: "v_gift",
    status: "ADDED",
    addedAt: D("2026-08-05T10:00:00Z"),
    shippedAt: null,
    rule: { unitCostCents: 450 },
  };
  store.giftGrants.push(grant);
  return { store, grant };
}

async function rollupGiftCogs(store: AnalyticsStore): Promise<number> {
  dbHolder.current = createAnalyticsDb(store);
  await runDailyRollup(SHOP_ID, DAY);
  return store.dailyRollups[0].giftCogsCents as number;
}

async function cohortGiftCogs(store: AnalyticsStore): Promise<number> {
  dbHolder.current = createAnalyticsDb(store);
  await runCohortComputation(SHOP_ID, NOW);
  // Booked in the grant's addedAt month = cohort 2026-06 offset 2 (August).
  const cell = store.cohortCells.find((c) => c.monthOffset === 2);
  return (cell?.cogsCents as number) ?? 0;
}

describe("gift COGS survives the ADDED → SHIPPED → REMOVED lifecycle", () => {
  it("counts an ADDED grant (pre-settlement) on both surfaces", async () => {
    const { store } = buildStore();
    expect(await rollupGiftCogs(store)).toBe(450);
    expect(await cohortGiftCogs(store)).toBe(450);
  });

  it("counts a SHIPPED grant (settlement flipped it the same day it billed)", async () => {
    const { store, grant } = buildStore();
    grant.status = "SHIPPED";
    grant.shippedAt = D("2026-08-05T10:30:00Z");
    expect(await rollupGiftCogs(store)).toBe(450);
    expect(await cohortGiftCogs(store)).toBe(450);
  });

  it("counts a REMOVED-after-ship grant (daily mirror hygiene cleared it)", async () => {
    const { store, grant } = buildStore();
    grant.status = "REMOVED";
    grant.shippedAt = D("2026-08-05T10:30:00Z"); // the ship fact survives
    expect(await rollupGiftCogs(store)).toBe(450);
    expect(await cohortGiftCogs(store)).toBe(450);
  });

  it("full lifecycle crossing: the trailing recompute never erases a counted grant", async () => {
    const { store, grant } = buildStore();
    dbHolder.current = createAnalyticsDb(store);

    // Night 1: grant still ADDED when the day first computes.
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups[0].giftCogsCents).toBe(450);

    // Settlement flips ADDED→SHIPPED; the trailing recompute re-upserts the day.
    grant.status = "SHIPPED";
    grant.shippedAt = D("2026-08-05T18:00:00Z");
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups[0].giftCogsCents).toBe(450);

    // Next day's gifts_run mirror hygiene flips SHIPPED→REMOVED; the day is
    // still inside ROLLUP_RECOMPUTE_DAYS and re-upserts once more.
    grant.status = "REMOVED";
    await runDailyRollup(SHOP_ID, DAY);
    expect(store.dailyRollups[0].giftCogsCents).toBe(450);

    // The cohort triangle (nightly full recompute) agrees throughout.
    await runCohortComputation(SHOP_ID, NOW);
    const cell = store.cohortCells.find((c) => c.monthOffset === 2);
    expect(cell?.cogsCents).toBe(450);
  });

  it("still excludes supersede-retired grants — REMOVED without ever shipping", async () => {
    const { store, grant } = buildStore();
    grant.status = "REMOVED";
    grant.shippedAt = null; // retired by a rule change, no gift ever went out
    expect(await rollupGiftCogs(store)).toBe(0);
    expect(await cohortGiftCogs(store)).toBe(0);
  });

  it("a pre-0016 shipped-then-removed grant (no shippedAt) stays uncounted — the instant was never recorded", async () => {
    // Honesty over guesswork: REMOVED + null shippedAt is indistinguishable
    // from a supersede retirement, so it cannot be counted. Grants that were
    // still ADDED/SHIPPED at migration time are captured by the status arm.
    const { store, grant } = buildStore();
    grant.status = "REMOVED";
    grant.shippedAt = null;
    grant.addedAt = D("2026-08-05T09:00:00Z");
    expect(await rollupGiftCogs(store)).toBe(0);
  });
});
