import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WIN-BACK STATE MACHINE — every transition leaves a trace, and touches are
 * timed to the CURRENT prediction.
 *
 * Four silent mutations (data-collection audit):
 *  a. the ownership/demo re-check sunset a campaign with no event;
 *  b. an orphaned state (contract purged) was sunset with only console.error;
 *  c. the zero-headroom discount stage advanced 2→3 with neither an offer
 *     nor a skip trace;
 *  d. reactivateFromWinback's ACTIVE short-circuit settled ACTIVE→WON_BACK
 *     silently when no attempts were released — the normal case when a
 *     Shopify-side reactivation was mirrored by webhook before the link
 *     click (the sweep only scans ACTIVE states, so it never logs it).
 *
 * Plus the frozen-anchor defect: processDueTouch timed every stage off the
 * WinbackState.predictedEmptyDate captured at cancel, while analytics kept
 * refreshing the CONTRACT's predictedEmptyDate for 180 days precisely for
 * these touches — a dead nightly write. Touches now re-anchor to the live
 * value when it moved materially (>= 2 days), deferring a no-longer-due
 * touch instead of firing on the stale week.
 *
 * Drives the REAL runWinbackSweep / reactivateFromWinback over a mocked db.
 */

const NOW = new Date("2026-08-09T12:00:00Z");
const TZ = "Europe/Zurich";

const store = vi.hoisted(() => ({
  states: [] as Array<Record<string, unknown>>,
  contracts: new Map<string, Record<string, unknown> | null>(),
  stateUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({ status: "SENT" })),
  clampGrantPercentForContract: vi.fn(
    async (): Promise<unknown> => ({ percent: 20, clamped: false }),
  ),
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
  winbackStateFindUnique: vi.fn(async (): Promise<unknown> => null),
  subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => {
  const client = {
    winbackState: {
      findMany: vi.fn(async (): Promise<unknown[]> => store.states),
      findUnique: mocks.winbackStateFindUnique,
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<unknown> => {
          store.stateUpdates.push({ id: args.where.id, data: args.data });
          const row = store.states.find((s) => s.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row ?? { id: args.where.id, ...args.data };
        },
      ),
    },
    subscriptionContract: {
      findUnique: vi.fn(
        async (args: { where: { id: string } }): Promise<unknown> =>
          store.contracts.get(args.where.id) ?? null,
      ),
      findUniqueOrThrow: vi.fn(
        async (args: { where: { id: string } }): Promise<unknown> =>
          store.contracts.get(args.where.id),
      ),
      findFirst: vi.fn(async (): Promise<unknown> => null), // no natural resub
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: TZ,
      })),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { default: client };
});

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: TZ,
  })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({
    enabled: true,
    softTouchOffsetDays: -7,
    perkOffsetDays: 3,
    discountOffsetDays: 21,
    sunsetOffsetDays: 60,
    discountPct: 20,
    discountCycles: 2,
    reactivationBillDelayDays: 3,
    linkGraceDays: 14,
  })),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: mocks.clampGrantPercentForContract,
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: mocks.releaseHeldCycleAttempts,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://magic"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: new Date("2026-08-12T09:00:00Z"),
  })),
}));

import { addDaysTz } from "~/lib/dates.server";
import {
  reactivateFromWinback,
  runWinbackSweep,
} from "~/lib/winback/engine.server";

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    ownership: "OURS",
    isDemo: false,
    status: "CANCELLED",
    locale: "en",
    intervalWeeks: 4,
    ordersCount: 5,
    predictedEmptyDate: null,
    cancelledAt: new Date("2026-07-20T00:00:00Z"),
    cancelReason: "TOO_MUCH_PRODUCT",
    cancelSource: "CUSTOMER",
    failedAt: null,
    nextBillingDate: null,
    lines: [],
    ...over,
  };
}

function stateFixture(over: Record<string, unknown> = {}) {
  return {
    id: "wb_1",
    contractId: "c_1",
    shopId: "shop_1",
    cancelledAt: new Date("2026-07-20T00:00:00Z"),
    predictedEmptyDate: new Date("2026-08-10T00:00:00Z"),
    stage: 0,
    nextTouchAt: new Date("2026-08-03T00:00:00Z"), // due
    status: "ACTIVE",
    wonBackAt: null,
    optedOutAt: null,
    ...over,
  };
}

function events(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.states = [];
  store.contracts = new Map();
  store.stateUpdates = [];
  mocks.clampGrantPercentForContract.mockResolvedValue({
    percent: 20,
    clamped: false,
  });
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.winbackStateFindUnique.mockResolvedValue(null);
  mocks.releaseHeldCycleAttempts.mockResolvedValue(0);
});

// ── a/b. Silent sunsets now log ──────────────────────────────────────────────

describe("sweep sunsets leave a trace", () => {
  it("orphaned state (contract purged): winback.sunset with the purged id in the payload", async () => {
    store.states = [stateFixture({ contractId: "c_gone", stage: 1 })];
    store.contracts.set("c_gone", null);

    await runWinbackSweep(NOW);

    const sunset = events("winback.sunset");
    expect(sunset).toHaveLength(1);
    // contractId stays unset — the FK row is gone, an event pointing at it
    // would fail the insert; the id is preserved in the payload instead.
    expect(sunset[0].contractId).toBeUndefined();
    expect(sunset[0].payload).toMatchObject({
      stateId: "wb_1",
      purgedContractId: "c_gone",
      stage: 1,
      reason: "contract_purged",
    });
    expect(store.stateUpdates[0]?.data).toMatchObject({ status: "SUNSET" });
  });

  it("foreign-ownership re-check: winback.sunset names the cause", async () => {
    store.states = [stateFixture({ stage: 2 })];
    store.contracts.set("c_1", contractFixture({ ownership: "FOREIGN" }));

    await runWinbackSweep(NOW);

    const sunset = events("winback.sunset");
    expect(sunset).toHaveLength(1);
    expect(sunset[0].contractId).toBe("c_1");
    expect(sunset[0].payload).toMatchObject({
      stateId: "wb_1",
      stage: 2,
      reason: "foreign_ownership",
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("demo fixture: winback.sunset names demo_contract", async () => {
    store.states = [stateFixture()];
    store.contracts.set("c_1", contractFixture({ isDemo: true }));

    await runWinbackSweep(NOW);

    expect(events("winback.sunset")[0]?.payload).toMatchObject({
      reason: "demo_contract",
    });
  });
});

// ── SP-04: re-anchoring to the live prediction ──────────────────────────────

describe("due touches re-anchor to the contract's current predictedEmptyDate", () => {
  it("a prediction that moved LATER defers the touch instead of firing on the stale week", async () => {
    const liveAnchor = new Date("2026-08-20T00:00:00Z"); // +10d vs state
    store.states = [stateFixture()];
    store.contracts.set(
      "c_1",
      contractFixture({ predictedEmptyDate: liveAnchor }),
    );

    await runWinbackSweep(NOW);

    // No touch fired — the soft touch is no longer due under the fresh
    // anchor (liveAnchor - 7d is in the future).
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(events("winback.soft_touch")).toHaveLength(0);

    const expectedDue = addDaysTz(liveAnchor, -7, TZ);
    expect(store.stateUpdates).toHaveLength(1);
    expect(store.stateUpdates[0].data).toMatchObject({
      predictedEmptyDate: liveAnchor,
      stage: 0,
      nextTouchAt: expectedDue,
    });

    // The re-time is auditable.
    const scheduled = events("winback.scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toMatchObject({
      stateId: "wb_1",
      reanchored: true,
      previousPredictedEmptyDate: "2026-08-10T00:00:00.000Z",
      predictedEmptyDate: liveAnchor.toISOString(),
      stage: 0,
    });
  });

  it("a prediction that moved EARLIER fires the now-relevant stage with the fresh date", async () => {
    const liveAnchor = new Date("2026-07-20T00:00:00Z"); // -21d vs state
    store.states = [stateFixture()];
    store.contracts.set(
      "c_1",
      contractFixture({ predictedEmptyDate: liveAnchor }),
    );

    await runWinbackSweep(NOW);

    // Skip-ahead lands on the perk stage (perk moment passed, discount not
    // yet) — one touch, no stale-email burst.
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification.mock.calls[0][0]).toMatchObject({
      template: "winback_perk",
    });
    const perk = events("winback.perk_offered");
    expect(perk).toHaveLength(1);
    expect(perk[0].payload).toMatchObject({
      predictedEmptyDate: liveAnchor.toISOString(),
    });
    // The fresh anchor is persisted so the state row matches the event.
    expect(
      store.stateUpdates.some(
        (u) =>
          (u.data.predictedEmptyDate as Date | undefined)?.getTime() ===
          liveAnchor.getTime(),
      ),
    ).toBe(true);
  });

  it("sub-threshold drift keeps the stored anchor (recompute noise)", async () => {
    const liveAnchor = new Date("2026-08-11T00:00:00Z"); // +1d < 2d threshold
    store.states = [stateFixture()];
    store.contracts.set(
      "c_1",
      contractFixture({ predictedEmptyDate: liveAnchor }),
    );

    await runWinbackSweep(NOW);

    // The soft touch fires as scheduled, on the STORED anchor.
    expect(events("winback.scheduled")).toHaveLength(0);
    const soft = events("winback.soft_touch");
    expect(soft).toHaveLength(1);
    expect(soft[0].payload).toMatchObject({
      predictedEmptyDate: "2026-08-10T00:00:00.000Z",
    });
  });
});

// ── c. Zero-headroom discount skip ──────────────────────────────────────────

describe("zero-headroom discount stage", () => {
  it("logs winback.discount_skipped (never discount_offered) and still advances to sunset timing", async () => {
    mocks.clampGrantPercentForContract.mockResolvedValue({
      percent: 0,
      clamped: true,
      requestedPercent: 20,
    });
    store.states = [
      stateFixture({
        stage: 2,
        nextTouchAt: new Date("2026-08-08T00:00:00Z"),
        predictedEmptyDate: new Date("2026-07-18T00:00:00Z"),
      }),
    ];
    store.contracts.set("c_1", contractFixture());

    await runWinbackSweep(NOW);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(events("winback.discount_offered")).toHaveLength(0);

    const skipped = events("winback.discount_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].payload).toMatchObject({
      stateId: "wb_1",
      reason: "no_discount_headroom",
      requestedPercent: 20,
    });
    // 2 → 3 advance still happens (a 0% offer is worse than none).
    expect(
      store.stateUpdates.some((u) => u.data.stage === 3),
    ).toBe(true);
  });
});

// ── d. Shopify-side reactivation settled via the link click ─────────────────

describe("reactivateFromWinback ACTIVE short-circuit", () => {
  it("logs winback.reactivated when it performs the ACTIVE→WON_BACK settle (no released attempts)", async () => {
    store.contracts.set("c_1", contractFixture({ status: "ACTIVE" }));
    mocks.winbackStateFindUnique.mockResolvedValue(
      stateFixture({ stage: 1 }),
    );

    await reactivateFromWinback("c_1");

    const reactivated = events("winback.reactivated");
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].payload).toMatchObject({
      stateId: "wb_1",
      natural: false,
      settledFromMirror: true,
      releasedFailedAttempts: 0,
    });
    expect(store.stateUpdates[0]?.data).toMatchObject({ status: "WON_BACK" });
  });

  it("a pure replay (state already WON_BACK, nothing released) stays silent", async () => {
    store.contracts.set("c_1", contractFixture({ status: "ACTIVE" }));
    mocks.winbackStateFindUnique.mockResolvedValue(
      stateFixture({ status: "WON_BACK" }),
    );

    await reactivateFromWinback("c_1");

    expect(events("winback.reactivated")).toHaveLength(0);
  });
});
