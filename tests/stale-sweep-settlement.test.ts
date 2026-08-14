import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONE SETTLEMENT, TWO CLAIM WINNERS — the stale-attempt sweep, evaluated.
 *
 * When the SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS webhook is lost, the billing
 * sweep (`sweepStalePendingAttempts` → `resolveStaleAttempt`) resolves the
 * PENDING attempt from Shopify's status query and wins the → SUCCESS claim.
 * It used to perform only a SUBSET of the webhook's bookkeeping — counters,
 * dunning close, one event — and then stamp settledAt, which permanently
 * locked out the rest: a redelivered success webhook takes the
 * mirror-refresh-only path once the marker is set.
 *
 * What that stranded, concretely:
 *  - the cycle's one-time add-on mirror line survived forever. The portal
 *    showed a phantom "with your next order" add-on, and because the row
 *    still held the permanently-unique addClaimKey
 *    "addon:{contractId}:{variantId}", every future addOneTimeAddon for that
 *    variant was a silent "already staged" no-op — the customer was told it
 *    worked, no cycle edit ran, the next order shipped without the add-on;
 *  - the cycle's gift grants stayed ADDED forever (never SHIPPED), so the
 *    SHIPPED-gated gift-line cleanup never ran and gift analytics
 *    under-counted shipped gifts;
 *  - no order confirmation was sent for a real charge, lifecycle milestones
 *    never fired, and billing.order_created was never logged.
 *
 * The contract now: the sweep's claim transaction runs the SAME cycle
 * consumption helper as the webhook's claim transaction
 * (consumeCycleOnSuccess: add-on mirror clearing + gift ADDED → SHIPPED,
 * atomic with the claim), and then drives the SAME settlement tail
 * (finishSuccessSettlement: dunning close, lifecycle, order confirmation,
 * billing.attempt_succeeded + billing.order_created, settledAt stamped LAST).
 *
 * These tests drive the REAL sweep out of `sweepStalePendingAttempts` with a
 * mocked Prisma — what is asserted is what the sweep actually does.
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
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
  cadenceFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getOrderSummarySweep: vi.fn(async (): Promise<unknown> => ({
    totalCents: 5760,
    currencyCode: "CHF",
    name: "#1042",
    createdAt: new Date(Date.now() - 3 * 3_600_000),
    processedAt: new Date(Date.now() - 3 * 3_600_000),
    discountsCents: 300,
    taxCents: 410,
    shippingCents: 500,
    subtotalCents: 5050,
  })),
  syncContractFromShopify: vi.fn(async (): Promise<unknown> => ({})),
  onBillingAttemptSucceeded: vi.fn(async (): Promise<void> => {}),
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
    productCadence: {
      findMany: mocks.cadenceFindMany,
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

  // The sweep's claim + consumption + counters run through an interactive
  // transaction; the mock hands the callback the same client, so every model
  // spy above observes exactly what commits with the claim.
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

// Real registry defaults: the sweep reads settings.dunning (CHALLENGED
// re-query window) and settings.costModel (cost snapshot at settlement).
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

// The webhook module's GraphQL seam (loaded because the sweep imports the
// shared settlement helpers from it).
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
  // No consumeGrantCycle export on purpose: the optional hook must stay
  // skipped, exactly like production (applyGrantToCycle consumes pre-charge).
  applyGrantToCycle: vi.fn(async () => ({ applied: false })),
  getActiveDiscountForCycle: vi.fn(async () => null),
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptSucceeded: mocks.onBillingAttemptSucceeded,
  onBillingAttemptFailed: vi.fn(async () => {}),
  onBillingAttemptChallenged: vi.fn(async () => {}),
}));

vi.mock("~/lib/lifecycle/engine.server", () => ({
  onSuccessfulCycle: mocks.onSuccessfulCycle,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: mocks.syncContractFromShopify,
}));

import { sweepStalePendingAttempts } from "~/lib/billing/scheduler.server";

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";
const ATTEMPT_GID = "gid://shopify/SubscriptionBillingAttempt/900";
const ORDER_GID = "gid://shopify/Order/700";
const OLD = new Date("2026-01-01T00:00:00Z");

function contractRow() {
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
    deliveryPriceCents: 500,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
  };
}

function staleAttemptRow() {
  return {
    id: "a_1",
    contractId: "c_1",
    shopifyAttemptId: ATTEMPT_GID,
    status: "PENDING",
    cycleIndex: 5,
    attemptNumber: 1,
    createdAt: OLD,
    startedAt: OLD,
    scheduledFor: OLD,
    completedAt: null,
    settledAt: null,
    orderId: null,
    orderName: null,
    amountCents: null,
    currencyCode: null,
    mitEvidence: null,
    contract: contractRow(),
  };
}

/** The settled row the settlement tail reads back after the claim commits. */
function settledAttemptRow() {
  return {
    ...staleAttemptRow(),
    status: "SUCCESS",
    orderId: ORDER_GID,
    orderName: "#1042",
    amountCents: 5760,
    currencyCode: "CHF",
    completedAt: new Date(),
  };
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptFindMany.mockResolvedValue([staleAttemptRow()]);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.attemptFindUniqueOrThrow.mockResolvedValue(settledAttemptRow());
  mocks.contractFindUniqueOrThrow.mockResolvedValue({
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
  });
  mocks.contractUpdate.mockResolvedValue(contractRow());
  // Shopify's answer: the charge went through and produced an order.
  mocks.gql.mockResolvedValue({
    subscriptionBillingAttempt: {
      id: ATTEMPT_GID,
      ready: true,
      order: { id: ORDER_GID, name: "#1042" },
    },
  });
  // Two line reads run per settled attempt: the pre-claim cost-snapshot
  // resolution (all lines) and the claim transaction's add-on consumption
  // (isOneTimeAddon filter) — route on the filter so each sees its shape.
  mocks.lineFindMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if (where.isOneTimeAddon) {
      return [
        { id: "line_addon_1", title: "Collagen Boost", isOneTimeAddon: true },
      ];
    }
    return [
      {
        productId: "gid://shopify/Product/10",
        variantId: "gid://shopify/ProductVariant/11",
        quantity: 2,
        currentPriceCents: 2400,
        unitCostCents: 900,
        isGift: false,
      },
    ];
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a sweep-resolved SUCCESS runs the webhook's full settlement", () => {
  it("clears the one-time add-on mirror inside the claim transaction", async () => {
    const stats = await sweepStalePendingAttempts(2);
    expect(stats.succeeded).toBe(1);

    // The claim itself stays status-guarded (one writer wins).
    const claimArgs = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(claimArgs.where).toMatchObject({
      id: "a_1",
      status: { not: "SUCCESS" },
    });

    // The phantom add-on line — and with it the permanently-unique
    // addClaimKey that would block every future re-add — is gone. The clear
    // is CYCLE-scoped (migration 0012): only mirrors staged onto the settling
    // cycle (plus legacy NULL rows) are touched — an add-on the customer
    // staged for the NEXT cycle during the stale window must survive.
    expect(mocks.lineFindMany).toHaveBeenCalledWith({
      where: {
        contractId: "c_1",
        isOneTimeAddon: true,
        OR: [{ addonCycleIndex: 5 }, { addonCycleIndex: null }],
      },
    });
    expect(mocks.lineDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["line_addon_1"] } },
    });

    // ...and the consumption is observable in the audit log, same event the
    // webhook path emits.
    const removed = eventsOfType("cycle.addon_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].source).toBe("SCHEDULER");
    expect(removed[0].payload).toMatchObject({
      cycleIndex: 5,
      titles: ["Collagen Boost"],
      reason: "consumed_by_successful_cycle",
    });
  });

  it("flips this cycle's gift grants ADDED → SHIPPED (stamping shippedAt)", async () => {
    await sweepStalePendingAttempts(2);

    // shippedAt rides the flip: analytics count gift COGS by "shipped or
    // ever-shipped", so a later REMOVED flip must not erase the evidence.
    expect(mocks.giftUpdateMany).toHaveBeenCalledWith({
      where: { contractId: "c_1", cycleIndex: 5, status: "ADDED" },
      data: { status: "SHIPPED", shippedAt: expect.any(Date) },
    });
  });

  it("drives the shared settlement tail: dunning, lifecycle, confirmation, both events", async () => {
    await sweepStalePendingAttempts(2);

    // Dunning close.
    expect(mocks.onBillingAttemptSucceeded).toHaveBeenCalledWith("a_1");

    // Lifecycle milestones fire for the charged cycle.
    expect(mocks.onSuccessfulCycle).toHaveBeenCalled();

    // The customer is told about a real charge.
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop_1",
        contractId: "c_1",
        template: "order_confirmed",
      }),
    );

    // Both success events, attributed to the sweep.
    const succeeded = eventsOfType("billing.attempt_succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].source).toBe("SCHEDULER");
    expect(succeeded[0].payload).toMatchObject({
      attemptId: "a_1",
      resolvedBy: "stale_sweep",
    });

    const orderCreated = eventsOfType("billing.order_created");
    expect(orderCreated).toHaveLength(1);
    expect(orderCreated[0].source).toBe("SCHEDULER");
    expect(orderCreated[0].payload).toMatchObject({
      attemptId: "a_1",
      orderId: ORDER_GID,
      resolvedBy: "stale_sweep",
    });

    // The missed webhook's mirror refresh still happens.
    expect(mocks.syncContractFromShopify).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      CONTRACT_GID,
    );
  });

  it("stamps settledAt LAST — after every re-drivable side effect", async () => {
    await sweepStalePendingAttempts(2);

    const settleCalls = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data: Record<string, unknown> }).data;
      return "settledAt" in data && data.settledAt != null;
    });
    expect(settleCalls).toHaveLength(1);

    const marker = mocks.attemptUpdate.mock.invocationCallOrder[
      mocks.attemptUpdate.mock.calls.findIndex((c) => {
        const data = (c[0] as { data: Record<string, unknown> }).data;
        return "settledAt" in data && data.settledAt != null;
      })
    ];
    for (const order of [
      ...mocks.sendNotification.mock.invocationCallOrder,
      ...mocks.onBillingAttemptSucceeded.mock.invocationCallOrder,
      ...mocks.logEvent.mock.invocationCallOrder,
    ]) {
      expect(order).toBeLessThan(marker);
    }
  });
});

describe("the sweep's crash contract", () => {
  it("a tail failure leaves settledAt NULL (re-drivable) and surfaces as unresolved", async () => {
    mocks.sendNotification.mockRejectedValueOnce(new Error("smtp down"));

    const stats = await sweepStalePendingAttempts(2);

    // The failure is not swallowed into a false "succeeded".
    expect(stats.succeeded).toBe(0);
    expect(stats.unresolved).toBe(1);

    // The marker never landed: a redelivered success webhook re-drives the
    // remaining side effects through finishSuccessSettlement's redrive path.
    const settleCalls = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data: Record<string, unknown> }).data;
      return "settledAt" in data && data.settledAt != null;
    });
    expect(settleCalls).toHaveLength(0);

    // But the claim transaction already committed the cycle consumption —
    // atomic with the claim, exactly like the webhook path.
    expect(mocks.lineDeleteMany).toHaveBeenCalled();
    expect(mocks.giftUpdateMany).toHaveBeenCalled();
  });

  it("a lost claim (webhook settled first) hands off NOTHING", async () => {
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 });

    const stats = await sweepStalePendingAttempts(2);
    expect(stats.succeeded).toBe(1); // reported, not re-driven

    expect(mocks.lineDeleteMany).not.toHaveBeenCalled();
    expect(mocks.giftUpdateMany).not.toHaveBeenCalled();
    expect(mocks.onBillingAttemptSucceeded).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.syncContractFromShopify).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
  });
});

describe("settlement money capture (cost snapshot + order breakdown)", () => {
  /** The claim write of the first settled attempt. */
  function claimData(): Record<string, unknown> {
    return (
      mocks.attemptUpdateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      }
    ).data;
  }

  it("freezes the charge's cost basis and order money breakdown into the claim", async () => {
    await sweepStalePendingAttempts(2);

    const data = claimData();
    // The renewal-order money breakdown rides the settlement (same capture
    // the webhook path performs), so rollup/cohorts stop estimating tax and
    // discount spend for sweep-settled charges.
    expect(data).toMatchObject({
      amountCents: 5760,
      currencyCode: "CHF",
      discountCents: 300,
      taxCents: 410,
      shippingCents: 500,
      subtotalCents: 5050,
    });
    expect(data.orderProcessedAt).toBeInstanceOf(Date);

    // The cost basis is frozen through the shared cost model: 2 × 900 known
    // unit cost, nothing estimated, one delivery per charge.
    expect(data.costSnapshot).toMatchObject({
      v: 1,
      cogsCents: 1800,
      estimatedCogsCents: 0,
      deliveriesPerCharge: 1,
    });
    expect(
      (data.costSnapshot as { lines: unknown[] }).lines,
    ).toHaveLength(1);

    // lifetimeDiscountCents gains its renewals-only writer alongside
    // lifetimeRevenueCents, inside the same claim transaction.
    const counterWrite = mocks.contractUpdate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.ordersCount !== undefined);
    expect(counterWrite).toMatchObject({
      lifetimeRevenueCents: { increment: 5760 },
      lifetimeDiscountCents: { increment: 300 },
    });
  });

  it("scopes the frozen cost basis to the settling cycle — a future-cycle add-on mirror is excluded", async () => {
    // A lost success webhook settled by the sweep on a contract holding an
    // add-on staged for the NEXT cycle: that add-on's COGS belongs to ITS
    // cycle's charge (it books when cycle 6 settles), so freezing it into
    // cycle 5's snapshot would double-book the same units — the exact
    // cycle-scope rule the webhook path's snapshot and the add-on
    // consumption below already apply.
    mocks.lineFindMany.mockImplementation(async (args?: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if (where.isOneTimeAddon) {
        return [
          { id: "line_addon_1", title: "Collagen Boost", isOneTimeAddon: true },
        ];
      }
      return [
        {
          productId: "gid://shopify/Product/10",
          variantId: "gid://shopify/ProductVariant/11",
          quantity: 2,
          currentPriceCents: 2400,
          unitCostCents: 900,
          isGift: false,
          isOneTimeAddon: false,
          addonCycleIndex: null,
        },
        {
          // Staged for cycle 6 during the stale window — must NOT enter
          // cycle 5's frozen basis.
          productId: "gid://shopify/Product/20",
          variantId: "gid://shopify/ProductVariant/21",
          quantity: 1,
          currentPriceCents: 1500,
          unitCostCents: 400,
          isGift: false,
          isOneTimeAddon: true,
          addonCycleIndex: 6,
        },
        {
          // Staged for the settling cycle — the customer paid for it on this
          // order, so it belongs to this charge's cost basis.
          productId: "gid://shopify/Product/30",
          variantId: "gid://shopify/ProductVariant/31",
          quantity: 1,
          currentPriceCents: 1200,
          unitCostCents: 350,
          isGift: false,
          isOneTimeAddon: true,
          addonCycleIndex: 5,
        },
      ];
    });

    await sweepStalePendingAttempts(2);

    const data = claimData();
    // 2 × 900 recurring + 350 this-cycle add-on; the 400-cent future add-on
    // stays out of both the totals and the line list.
    expect(data.costSnapshot).toMatchObject({
      v: 1,
      cogsCents: 2150,
      estimatedCogsCents: 0,
    });
    expect(
      (data.costSnapshot as { lines: Array<{ variantId: string }> }).lines.map(
        (l) => l.variantId,
      ),
    ).toEqual([
      "gid://shopify/ProductVariant/11",
      "gid://shopify/ProductVariant/31",
    ]);
  });

  it("re-arms the prepaid delivery allotment — sweep parity with the webhook claim", async () => {
    const prepaidContract = {
      ...contractRow(),
      isPrepaid: true,
      prepaidDeliveriesPerCharge: 3,
      prepaidDeliveriesRemaining: 0, // exhausted by the old per-charge decrement
    };
    mocks.attemptFindMany.mockResolvedValue([
      { ...staleAttemptRow(), contract: prepaidContract },
    ]);

    await sweepStalePendingAttempts(2);

    // A successful prepaid charge pays for a fresh allotment; a sweep-settled
    // charge must not leave the cockpit badge on "Prepaid (0 left)".
    const counterWrite = mocks.contractUpdate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.ordersCount !== undefined);
    expect(counterWrite?.prepaidDeliveriesRemaining).toBe(3);
  });

  it("a cost-model failure never blocks the settlement — snapshot omitted, charge recorded", async () => {
    mocks.cadenceFindMany.mockRejectedValueOnce(new Error("db hiccup"));

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.succeeded).toBe(1);
    const data = claimData();
    expect(data.costSnapshot).toBeUndefined();
    // The money still lands — readers fall back to live cost resolution.
    expect(data).toMatchObject({ amountCents: 5760 });
  });

  it("an order-summary failure settles with NO amount or breakdown (the true-up sweep's case)", async () => {
    mocks.getOrderSummarySweep.mockRejectedValueOnce(new Error("throttled"));

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.succeeded).toBe(1);
    const data = claimData();
    expect(data.amountCents).toBeUndefined();
    expect(data.discountCents).toBeUndefined();
    // No amount read ⇒ amountCents stays NULL, which is exactly the marker
    // sweepUnsettledAttempts' null-amount arm keys on to true the money up.
    const counterWrite = mocks.contractUpdate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.ordersCount !== undefined);
    expect(counterWrite).toMatchObject({
      lifetimeRevenueCents: { increment: 0 },
    });
    expect(counterWrite?.lifetimeDiscountCents).toBeUndefined();
  });
});

describe("REGRESSION: expiry age basis for un-started residue rows (v1.22.0)", () => {
  // f1 (attempt-create transient) leaves a PENDING row with startedAt null
  // and scheduledFor = nextBillingDate. On an OVERDUE contract that date is
  // arbitrarily far in the past — the old `startedAt ?? scheduledFor` basis
  // expired the row on the sweep's FIRST tick, collapsing the documented 24h
  // of 5-minute resume retries to zero and parking the cycle forever behind
  // the b2 cycle-history guard.
  function residueRow(createdAgoMs: number) {
    return {
      ...staleAttemptRow(),
      shopifyAttemptId: null, // Shopify never confirmed the attempt
      startedAt: null,
      scheduledFor: OLD, // months-overdue contract
      createdAt: new Date(Date.now() - createdAgoMs),
    };
  }

  it("a fresh residue row on an overdue contract is NOT expired — the resume window survives", async () => {
    mocks.attemptFindMany.mockResolvedValue([residueRow(3 * 3_600_000)]);

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.expired).toBe(0);
    expect(stats.unresolved).toBe(1);
    const expiredWrites = mocks.attemptUpdateMany.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { status?: string } })?.data?.status === "EXPIRED",
    );
    expect(expiredWrites).toHaveLength(0);
  });

  it("a residue row genuinely unresolved past 24h still expires", async () => {
    mocks.attemptFindMany.mockResolvedValue([residueRow(26 * 3_600_000)]);

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.expired).toBe(1);
    const expiredWrites = mocks.attemptUpdateMany.mock.calls.filter(
      (c) =>
        (c[0] as { data?: { status?: string } })?.data?.status === "EXPIRED",
    );
    expect(expiredWrites).toHaveLength(1);
  });

  it("a STARTED attempt keeps aging from its real start (no behavior change)", async () => {
    mocks.gql.mockResolvedValue({ subscriptionBillingAttempt: null });
    mocks.attemptFindMany.mockResolvedValue([
      { ...staleAttemptRow(), createdAt: new Date() }, // startedAt = OLD
    ]);

    const stats = await sweepStalePendingAttempts(2);

    expect(stats.expired).toBe(1);
  });
});
