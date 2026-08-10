import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SUCCESS WORTH ZERO GETS ITS MONEY BACK — the null-amount true-up arm of
 * sweepUnsettledAttempts.
 *
 * When getOrderSummary throws at claim time (throttle, 502), the SUCCESS
 * claim commits with amountCents NULL and lifetimeRevenueCents += 0. The
 * webhook replay path deliberately never re-reads a settled attempt's amount
 * (after a refund the CURRENT order total is reduced while refundedCents is
 * subtracted separately — overwriting would double-count the refund), so the
 * charge was permanently worth 0 in rollup chargedCents, cohorts,
 * lifetimeRevenueCents, and a recovered case's recoveredCents.
 *
 * NULL is proof no amount was ever read, which makes a re-fetch safe exactly
 * once: these tests drive the REAL sweep and pin the arm's scope, the
 * refund add-back, the guarded exactly-once claim, and the counter/case
 * true-ups it authorizes.
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  attemptUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({})),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  finishSuccessSettlement: vi.fn(async (): Promise<void> => {}),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
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
  const explicit: Record<string, unknown> = {
    billingAttempt: {
      findMany: mocks.attemptFindMany,
      updateMany: mocks.attemptUpdateMany,
    },
    subscriptionContract: { update: mocks.contractUpdate },
    dunningCase: { updateMany: mocks.dunningCaseUpdateMany },
  };
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
  requireShop: vi.fn(async () => ({ id: "shop_1" })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) => {
    const { defaultFor } = await import("~/lib/settings/registry.server");
    return defaultFor(key as never);
  }),
}));

// The scheduler's own GraphQL seams (top-level imports of the module).
vi.mock("~/lib/graphql/client.server", () => ({
  gql: vi.fn(async () => ({})),
}));
vi.mock("~/lib/graphql/orders.server", () => ({
  getOrderSummary: mocks.getOrderSummary,
}));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  createBillingAttempt: vi.fn(async () => ({})),
  getBillingCycleByDate: vi.fn(async () => null),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  applyGrantToCycle: vi.fn(async () => ({ applied: false })),
  getActiveDiscountForCycle: vi.fn(async () => null),
}));

// The other two arms' hand-off targets (out of scope here).
vi.mock("~/lib/webhooks/handlers.server", () => ({
  finishSuccessSettlement: mocks.finishSuccessSettlement,
  consumeCycleOnSuccess: vi.fn(async () => ({ addonTitles: [] })),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  DUNNING_CLAIM_LEASE_MS: 10 * 60 * 1000,
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
  onBillingAttemptSucceeded: vi.fn(async () => {}),
  onBillingAttemptChallenged: vi.fn(async () => {}),
}));

import { sweepUnsettledAttempts } from "~/lib/billing/scheduler.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const ORDER_GID = "gid://shopify/Order/700";

function nullAmountRow(over: Record<string, unknown> = {}) {
  return {
    id: "a_null",
    contractId: "c_1",
    status: "SUCCESS",
    amountCents: null,
    orderId: ORDER_GID,
    cycleIndex: 5,
    refundedCents: 0,
    completedAt: new Date(NOW.getTime() - 2 * 3_600_000),
    contract: {
      id: "c_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      email: "someone@example.com",
      currencyCode: "CHF",
    },
    ...over,
  };
}

/** Route the three arm queries; only the true-up arm returns rows. */
function primeTrueup(rows: Array<Record<string, unknown>>) {
  mocks.attemptFindMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if (where.status === "SUCCESS" && "amountCents" in where) return rows;
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.getOrderSummary.mockResolvedValue({
    totalCents: 5000,
    currencyCode: "CHF",
    name: "#1042",
    createdAt: new Date("2026-08-05T06:00:00Z"),
    processedAt: new Date("2026-08-05T06:00:00Z"),
    discountsCents: 250,
    taxCents: 380,
    shippingCents: 500,
    subtotalCents: 4750,
  });
  primeTrueup([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("scope", () => {
  it("selects only OURS/non-demo SUCCESS rows with a NULL amount and a known order, inside the lookback", async () => {
    primeTrueup([nullAmountRow()]);

    await sweepUnsettledAttempts(NOW);

    const call = mocks.attemptFindMany.mock.calls.find((c) => {
      const where = (c[0] as { where?: Record<string, unknown> })?.where ?? {};
      return where.status === "SUCCESS" && "amountCents" in where;
    });
    expect(call).toBeDefined();
    expect((call![0] as { where: Record<string, unknown> }).where).toMatchObject({
      status: "SUCCESS",
      amountCents: null,
      orderId: { not: null },
      contract: { shopId: "shop_1", isDemo: false, ownership: "OURS" },
    });
  });
});

describe("the true-up", () => {
  it("re-reads the order, restores the refunded portion, and trues up every inheriting surface", async () => {
    // A 700-cent refund landed BEFORE the repair: the order's current total
    // (5000) is already reduced, so the amount AS CHARGED is 5700 — anything
    // else would double-count the refund at read time.
    primeTrueup([nullAmountRow({ refundedCents: 700 })]);
    mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 1 });

    const stats = await sweepUnsettledAttempts(NOW);
    expect(stats.amountsTruedUp).toBe(1);
    expect(stats.errors).toBe(0);

    // Guarded exactly-once claim on amountCents STILL null.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "a_null", status: "SUCCESS", amountCents: null },
      data: {
        amountCents: 5700,
        currencyCode: "CHF",
        discountCents: 250,
        taxCents: 380,
        shippingCents: 500,
        subtotalCents: 4750,
        orderProcessedAt: new Date("2026-08-05T06:00:00Z"),
      },
    });

    // The contract counters the claim booked as 0.
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "c_1" },
      data: {
        lifetimeRevenueCents: { increment: 5700 },
        lifetimeDiscountCents: { increment: 250 },
      },
    });

    // A case recovered by this attempt inherited the NULL.
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { recoveredAttemptId: "a_null", recoveredCents: null },
      data: { recoveredCents: 5700 },
    });

    // The mutation is auditable.
    const event = mocks.logEvent.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((e) => e.type === "billing.attempt_amount_backfilled");
    expect(event?.payload).toMatchObject({
      attemptId: "a_null",
      amountCents: 5700,
      currencyCode: "CHF",
      refundedCentsIncluded: 700,
      resolvedBy: "settlement_redrive",
    });
  });

  it("a lost claim (rival run trued it up first) writes NO counters and NO event", async () => {
    primeTrueup([nullAmountRow()]);
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 });

    const stats = await sweepUnsettledAttempts(NOW);

    expect(stats.amountsTruedUp).toBe(0);
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a summary fetch failure counts an error and repairs nothing (row stays eligible)", async () => {
    primeTrueup([nullAmountRow()]);
    mocks.getOrderSummary.mockRejectedValueOnce(new Error("throttled again"));

    const stats = await sweepUnsettledAttempts(NOW);

    expect(stats.amountsTruedUp).toBe(0);
    expect(stats.errors).toBe(1);
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("one broken row never blocks the rest of the batch", async () => {
    primeTrueup([nullAmountRow({ id: "a_bad" }), nullAmountRow({ id: "a_ok" })]);
    mocks.getOrderSummary.mockRejectedValueOnce(new Error("502"));

    const stats = await sweepUnsettledAttempts(NOW);

    expect(stats.errors).toBe(1);
    expect(stats.amountsTruedUp).toBe(1);
    const claimed = mocks.attemptUpdateMany.mock.calls.map(
      (c) => (c[0] as { where: { id: string } }).where.id,
    );
    expect(claimed).toEqual(["a_ok"]);
  });
});
