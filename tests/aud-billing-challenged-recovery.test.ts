import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE LOST 3DS OUTCOME LANE — CHALLENGED attempts in the stale sweep.
 *
 * A 3DS outcome only ever arrives by webhook: the CONFIRM_3DS magic link just
 * redirects the customer to their bank. Before this lane, the stale sweep
 * selected `status: "PENDING"` only, so once an attempt was locally
 * CHALLENGED no code path ever re-queried Shopify for its fate. Lose the
 * SUCCESS webhook and the paid charge was permanently unrecorded (no order,
 * no amountCents, no ordersCount/lifetimeRevenueCents) while the dunning
 * sweep's timeout exhausted the AWAITING_3DS case — failing or cancelling a
 * customer who PAID.
 *
 * The contract now, driven against the REAL sweep with mocked seams:
 *  - CHALLENGED rows older than the cutoff (and inside the
 *    cancelAfterFailedDays + grace window) join the re-query lane;
 *  - a Shopify-side order settles them through the SAME claim + settlement
 *    tail as PENDING rows (status-guarded, one writer wins);
 *  - a Shopify-side error settles them FAILED through the widened
 *    PENDING-or-CHALLENGED claim and hands off to dunning;
 *  - an unresolved CHALLENGED row is NEVER expired — its lifetime belongs to
 *    the dunning case's timeout (which now re-checks before exhausting);
 *  - recheckAttemptOutcome exposes the same resolution for the dunning
 *    sweep's pre-exhaustion re-check.
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  attemptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 1 }),
  ),
  attemptUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptFindUniqueOrThrow: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
  contractFindUniqueOrThrow: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({
      firstChargeAt: new Date("2026-01-01T00:00:00Z"),
    }),
  ),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  lineFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  lineDeleteMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 0 }),
  ),
  giftUpdateMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 0 }),
  ),
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getOrderSummarySweep: vi.fn(async (): Promise<unknown> => ({
    totalCents: 5760,
    currencyCode: "CHF",
    name: "#1042",
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    processedAt: new Date(Date.now() - 3 * 3_600_000),
    discountsCents: 0,
    taxCents: 0,
    shippingCents: 0,
    subtotalCents: 5760,
  })),
  syncContractFromShopify: vi.fn(async (): Promise<unknown> => ({})),
  onBillingAttemptSucceeded: vi.fn(async (): Promise<void> => {}),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
  onBillingAttemptChallenged: vi.fn(async (): Promise<void> => {}),
  onSuccessfulCycle: vi.fn(async (): Promise<void> => {}),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => {
  const explicit: Record<string, unknown> = {
    billingAttempt: {
      findMany: mocks.attemptFindMany,
      findUnique: mocks.attemptFindUnique,
      updateMany: mocks.attemptUpdateMany,
      update: mocks.attemptUpdate,
      findUniqueOrThrow: mocks.attemptFindUniqueOrThrow,
    },
    subscriptionContract: {
      findUniqueOrThrow: mocks.contractFindUniqueOrThrow,
      update: mocks.contractUpdate,
    },
    contractLine: {
      findMany: mocks.lineFindMany,
      deleteMany: mocks.lineDeleteMany,
    },
    giftGrant: {
      updateMany: mocks.giftUpdateMany,
    },
  };

  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    if (method === "aggregate") return { _sum: {}, _count: {}, _max: {} };
    return null;
  };

  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );

  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );

  return { default: db };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

// Real registry defaults (cancelAfterFailedDays = 30 shapes the CHALLENGED
// re-query window asserted below).
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) => {
    const { defaultFor } = await import("~/lib/settings/registry.server");
    return defaultFor(key as never);
  }),
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  sendTemplate: vi.fn(async () => ({ status: "SENT" })),
  hasSentForCycle: mocks.hasSentForCycle,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async () => ({})),
  getShopMetafield: vi.fn(async () => null),
}));

// The scheduler's own GraphQL seams.
vi.mock("~/lib/graphql/client.server", () => ({
  gql: mocks.gql,
}));
vi.mock("~/lib/graphql/orders.server", () => ({
  getOrderSummary: mocks.getOrderSummarySweep,
}));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  createBillingAttempt: vi.fn(async () => ({})),
  getBillingCycleByDate: vi.fn(async () => null),
}));

// The webhook module's GraphQL seam (the sweep imports the shared settlement
// helpers from it).
vi.mock("~/lib/graphql/index.server", () => ({
  getOrderSummary: vi.fn(async () => ({
    totalCents: 5760,
    name: "#1042",
    currencyCode: "CHF",
  })),
  getContract: vi.fn(async () => ({
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  })),
  getCustomer: vi.fn(async () => ({})),
  getVariants: vi.fn(async () => []),
  getSellingPlanGroupPlanIds: vi.fn(async () => []),
}));

vi.mock("~/lib/billing/discounts.server", () => ({
  applyGrantToCycle: vi.fn(async () => ({ applied: false })),
  getActiveDiscountForCycle: vi.fn(async () => null),
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptSucceeded: mocks.onBillingAttemptSucceeded,
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
  onBillingAttemptChallenged: mocks.onBillingAttemptChallenged,
}));

vi.mock("~/lib/lifecycle/engine.server", () => ({
  onSuccessfulCycle: mocks.onSuccessfulCycle,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: mocks.syncContractFromShopify,
}));

import {
  recheckAttemptOutcome,
  sweepStalePendingAttempts,
} from "~/lib/billing/scheduler.server";

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";
const ATTEMPT_GID = "gid://shopify/SubscriptionBillingAttempt/900";
const ORDER_GID = "gid://shopify/Order/700";
const FIVE_HOURS_AGO = new Date(Date.now() - 5 * 3_600_000);
const DAY_MS = 86_400_000;

function contractRow(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "someone@example.com",
    ownership: "OURS",
    isDemo: false,
    ordersCount: 4,
    lifetimeRevenueCents: 20_000,
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
    currencyCode: "CHF",
    locale: "en",
    status: "ACTIVE",
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    ...over,
  };
}

function challengedRow(over: Record<string, unknown> = {}) {
  return {
    id: "a_ch1",
    contractId: "c_1",
    shopifyAttemptId: ATTEMPT_GID,
    status: "CHALLENGED",
    cycleIndex: 5,
    attemptNumber: 1,
    startedAt: FIVE_HOURS_AGO,
    scheduledFor: FIVE_HOURS_AGO,
    completedAt: null,
    settledAt: null,
    orderId: null,
    orderName: null,
    amountCents: null,
    currencyCode: null,
    refundedCents: 0,
    mitEvidence: { threeDS: { challenged: true } },
    contract: contractRow(),
    ...over,
  };
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptFindMany.mockResolvedValue([challengedRow()]);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.attemptFindUniqueOrThrow.mockResolvedValue({
    ...challengedRow(),
    status: "SUCCESS",
    orderId: ORDER_GID,
    orderName: "#1042",
    amountCents: 5760,
    currencyCode: "CHF",
    completedAt: new Date(),
  });
  mocks.contractFindUniqueOrThrow.mockResolvedValue({
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
  });
  mocks.contractUpdate.mockResolvedValue(contractRow());
  // Default Shopify answer: nothing new (still challenged, no redirect kept).
  mocks.gql.mockResolvedValue({
    subscriptionBillingAttempt: { id: ATTEMPT_GID, ready: false },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the sweep's CHALLENGED re-query lane", () => {
  it("selects PENDING rows AND windowed CHALLENGED rows", async () => {
    await sweepStalePendingAttempts(2);

    const where = (
      mocks.attemptFindMany.mock.calls[0][0] as {
        where: { OR: Array<Record<string, unknown>> };
      }
    ).where;
    expect(where.OR[0]).toMatchObject({ status: "PENDING" });
    const challengedArm = where.OR[1] as {
      status: string;
      OR: Array<{ startedAt?: { lte: Date; gte: Date } }>;
    };
    expect(challengedArm.status).toBe("CHALLENGED");
    // The lane closes once the dunning window (cancelAfterFailedDays = 30)
    // plus grace has passed — a still-CHALLENGED row past it is a closed
    // case's residue, not worth a Shopify round trip every sweep.
    const floor = challengedArm.OR[0].startedAt!.gte;
    const ageDays = (Date.now() - floor.getTime()) / DAY_MS;
    expect(ageDays).toBeGreaterThan(36.9);
    expect(ageDays).toBeLessThan(37.1);
  });

  it("a challenge the customer PAID (order on Shopify, webhook lost) settles fully", async () => {
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: {
        id: ATTEMPT_GID,
        ready: true,
        order: { id: ORDER_GID, name: "#1042" },
      },
    });

    const stats = await sweepStalePendingAttempts(2);
    expect(stats.succeeded).toBe(1);

    // Same status-guarded claim as PENDING rows (one writer wins)…
    const claim = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(claim.where).toMatchObject({
      id: "a_ch1",
      status: { not: "SUCCESS" },
    });
    // …and the SAME settlement tail: money, dunning close (which folds the
    // 3DS SUCCEEDED outcome), events.
    expect(mocks.onBillingAttemptSucceeded).toHaveBeenCalledWith("a_ch1");
    expect(eventsOfType("billing.attempt_succeeded")).toHaveLength(1);
  });

  it("a challenge the customer FAILED (error on Shopify, webhook lost) claims from CHALLENGED and opens dunning", async () => {
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: {
        id: ATTEMPT_GID,
        ready: false,
        errorCode: "AUTHENTICATION_ERROR",
        errorMessage: "3-D Secure authentication failed",
      },
    });

    const stats = await sweepStalePendingAttempts(2);
    expect(stats.failed).toBe(1);

    const claim = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where).toMatchObject({
      id: "a_ch1",
      status: { in: ["PENDING", "CHALLENGED"] },
    });
    expect(claim.data).toMatchObject({
      status: "FAILED",
      errorCode: "AUTHENTICATION_ERROR",
    });
    expect(mocks.onBillingAttemptFailed).toHaveBeenCalledWith("a_ch1");

    // BD-9 payload discrimination: a REAL decline, not an unknown outcome.
    const failed = eventsOfType("billing.attempt_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].payload).toMatchObject({
      outcome: "FAILED",
      superseded: false,
      resolvedBy: "stale_sweep",
    });
  });

  it("an unresolved CHALLENGED row is NEVER expired — the dunning timeout owns it", async () => {
    // Shopify still shows nothing terminal, and the row is far older than
    // the 24h PENDING expiry.
    mocks.attemptFindMany.mockResolvedValue([
      challengedRow({
        startedAt: new Date(Date.now() - 3 * DAY_MS),
        scheduledFor: new Date(Date.now() - 3 * DAY_MS),
      }),
    ]);

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.unresolved).toBe(1);
    expect(stats.expired).toBe(0);
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled(); // no EXPIRED write
    expect(eventsOfType("billing.attempt_failed")).toHaveLength(0);
  });

  it("an ancient PENDING row still expires, and its event says the outcome is UNKNOWN", async () => {
    mocks.attemptFindMany.mockResolvedValue([
      challengedRow({
        id: "a_p1",
        status: "PENDING",
        startedAt: new Date(Date.now() - 3 * DAY_MS),
        scheduledFor: new Date(Date.now() - 3 * DAY_MS),
        mitEvidence: null,
      }),
    ]);
    mocks.gql.mockResolvedValue({ subscriptionBillingAttempt: null });

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.expired).toBe(1);
    const failed = eventsOfType("billing.attempt_failed");
    expect(failed).toHaveLength(1);
    // The charge outcome was never learned — event-derived failure features
    // must be able to skip it (BD-9's EXPIRED_UNKNOWN discrimination).
    expect(failed[0].payload).toMatchObject({
      reason: "expired_unresolved",
      outcome: "EXPIRED_UNKNOWN",
      superseded: false,
    });
  });
});

describe("recheckAttemptOutcome (the dunning sweep's pre-exhaustion probe)", () => {
  it("resolves a paid challenge through the full settlement and reports SUCCESS", async () => {
    mocks.attemptFindUnique.mockResolvedValue(challengedRow());
    mocks.gql.mockResolvedValue({
      subscriptionBillingAttempt: {
        id: ATTEMPT_GID,
        ready: true,
        order: { id: ORDER_GID, name: "#1042" },
      },
    });

    const outcome = await recheckAttemptOutcome("a_ch1");

    expect(outcome).toBe("SUCCESS");
    expect(mocks.onBillingAttemptSucceeded).toHaveBeenCalledWith("a_ch1");
  });

  it("reports UNRESOLVED when Shopify has nothing new (and settles nothing)", async () => {
    mocks.attemptFindUnique.mockResolvedValue(challengedRow());

    const outcome = await recheckAttemptOutcome("a_ch1");

    expect(outcome).toBe("UNRESOLVED");
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses foreign and demo contracts outright", async () => {
    mocks.attemptFindUnique.mockResolvedValue(
      challengedRow({ contract: contractRow({ ownership: "FOREIGN" }) }),
    );
    expect(await recheckAttemptOutcome("a_ch1")).toBe("UNRESOLVED");

    mocks.attemptFindUnique.mockResolvedValue(
      challengedRow({ contract: contractRow({ isDemo: true }) }),
    );
    expect(await recheckAttemptOutcome("a_ch1")).toBe("UNRESOLVED");
    expect(mocks.gql).not.toHaveBeenCalled();
  });
});
