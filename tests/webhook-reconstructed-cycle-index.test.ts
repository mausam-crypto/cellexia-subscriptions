import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE WRONG CYCLE NUMBER — reconstructed billing attempts, evaluated.
 *
 * When a charge this app did not originate settles (merchant pressing
 * "bill now" in the Shopify admin, Shopify Flow, another integration),
 * resolveBillingAttempt reconstructs a local BillingAttempt for it. The
 * defect: the reconstruction stamped `cycleIndex: ordersCount + 1` — LOCAL
 * order-count space — while everything cycle-scoped that the settlement
 * clears was stamped from getBillingCycleByDate, SHOPIFY billing-cycle
 * space: one-time add-on mirrors (addonCycleIndex, migration 0012) and gift
 * grants. The two spaces diverge permanently after any skipped or unbilled
 * cycle (a skipped cycle keeps its index — the winback engine documents the
 * same divergence).
 *
 * On a diverged contract (ordersCount=3, upcoming Shopify cycle index 5), a
 * customer-staged add-on carries addonCycleIndex=5; the reconstructed
 * attempt carried cycleIndex=4; consumeCycleOnSuccess's exact-index WHERE
 * matched nothing. The customer paid for the add-on (the Shopify cycle edit
 * rode the billed cycle) yet the mirror survived forever — portal shows
 * "staged for your next delivery" and the surviving addClaimKey turns every
 * future staging of that variant into a silent "already staged" no-op. No
 * later settlement matches index 5 again, so there is no self-heal.
 *
 * The fix: the reconstruction resolves the billed cycle from Shopify (the
 * cycle containing the mirror's nextBillingDate — still pre-charge at
 * webhook time, the same date addOneTimeAddon staged against) and falls
 * back to ordersCount + 1 only when the read fails or no date is mirrored.
 * These tests drive the REAL success handler end to end with mocked Prisma.
 */

const mocks = vi.hoisted(() => ({
  attemptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptCreate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 1 }),
  ),
  attemptFindUniqueOrThrow: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  lineFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  lineDeleteMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 0 }),
  ),
  giftUpdateMany: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ count: 0 }),
  ),
  subscriberEventFindFirst: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({
    totalCents: 5760,
    name: "#1001",
    currencyCode: "CHF",
  })),
  getContract: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: new Date("2026-10-03T00:00:00Z"),
  })),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  onBillingAttemptSucceeded: vi.fn(async (): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ tag: "admin" })),
}));

vi.mock("~/db.server", () => {
  const explicit: Record<string, unknown> = {
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      create: mocks.attemptCreate,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
      findUniqueOrThrow: mocks.attemptFindUniqueOrThrow,
    },
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      update: mocks.contractUpdate,
    },
    contractLine: {
      findMany: mocks.lineFindMany,
      deleteMany: mocks.lineDeleteMany,
    },
    giftGrant: {
      updateMany: mocks.giftUpdateMany,
    },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
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

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async () => ({ id: "shop_1" })),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  sendTemplate: vi.fn(async () => ({ status: "SENT" })),
  hasSentForCycle: mocks.hasSentForCycle,
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptSucceeded: mocks.onBillingAttemptSucceeded,
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getOrderSummary: mocks.getOrderSummary,
  getContract: mocks.getContract,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  getCustomer: vi.fn(async () => ({})),
  getVariants: vi.fn(async () => []),
  getSellingPlanGroupPlanIds: vi.fn(async () => []),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";
const NEXT_BILLING = new Date("2026-09-05T00:00:00Z");

/**
 * A contract whose Shopify cycle index has diverged from ordersCount: three
 * billed cycles plus one skipped cycle, so the upcoming Shopify billing
 * cycle carries index 5 while ordersCount + 1 = 4.
 */
function divergedContract(overrides: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "someone@example.com",
    ownership: "OURS",
    ordersCount: 3,
    lifetimeRevenueCents: 20_000,
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
    currencyCode: "CHF",
    originOrderId: null,
    locale: "en",
    status: "ACTIVE",
    consecutiveFailures: 0,
    nextBillingDate: NEXT_BILLING,
    ...overrides,
  };
}

function successPayload() {
  return {
    admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
    admin_graphql_api_subscription_contract_id: CONTRACT_GID,
    admin_graphql_api_order_id: "gid://shopify/Order/700",
  };
}

async function deliverSuccess() {
  await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
    shopDomain: "cellexia.myshopify.com",
    payload: successPayload(),
    webhookId: "wh_1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  // No local attempt matches: this charge was not originated by our
  // scheduler, which is what sends resolveBillingAttempt down the
  // reconstruction path.
  mocks.attemptFindUnique.mockResolvedValue(null);
  mocks.contractFindUnique.mockResolvedValue(divergedContract());
  mocks.contractUpdate.mockResolvedValue(divergedContract());
  mocks.lineFindMany.mockResolvedValue([]);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });

  // The created row is what the claim transaction reads back: echo the
  // cycleIndex the reconstruction actually stamped so the assertion below is
  // end-to-end (create → claim → consumeCycleOnSuccess), not a fixture echo.
  let createdCycleIndex: unknown = null;
  mocks.attemptCreate.mockImplementation(async (args) => {
    const data = (args as { data: Record<string, unknown> }).data;
    createdCycleIndex = data.cycleIndex;
    return {
      id: "att_1",
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      settledAt: null,
      cycleIndex: data.cycleIndex,
      attemptNumber: 1,
      shopifyAttemptId: data.shopifyAttemptId,
      orderId: null,
      orderName: null,
      amountCents: null,
      currencyCode: "CHF",
      contract: divergedContract(),
    };
  });
  mocks.attemptFindUniqueOrThrow.mockImplementation(async () => ({
    id: "att_1",
    status: "SUCCESS",
    startedAt: new Date(),
    completedAt: new Date(),
    settledAt: null,
    cycleIndex: createdCycleIndex,
    attemptNumber: 1,
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    orderId: "gid://shopify/Order/700",
    orderName: "#1001",
    amountCents: 5760,
    currencyCode: "CHF",
    contract: divergedContract(),
  }));
});

describe("a reconstructed billing attempt on a cycle-diverged contract", () => {
  it("stamps the SHOPIFY billing-cycle index, so settlement clears the staged add-on", async () => {
    // Shopify says the cycle containing the billed date carries index 5 —
    // the same index addOneTimeAddon stamped onto the staged mirror.
    mocks.getBillingCycleByDate.mockResolvedValue({
      cycleIndex: 5,
      billingAttemptExpectedDate: NEXT_BILLING,
      skipped: false,
      edited: true,
      status: "BILLED",
    });

    await deliverSuccess();

    // The billed cycle was resolved against the mirror's (pre-charge)
    // nextBillingDate — the very date the add-on staging resolved against.
    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      NEXT_BILLING,
    );

    // The reconstructed row lives in Shopify space (5), not ordersCount
    // space (4).
    expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.cycleIndex).toBe(5);
    expect(created.data.originatingAction).toBe("ADMIN_MANUAL");

    // And the cycle-scoped consumption inside the claim transaction ran
    // against THAT index: the addonCycleIndex=5 mirror is in the WHERE, so
    // the customer-paid add-on is cleared and its addClaimKey freed.
    expect(mocks.lineFindMany).toHaveBeenCalledWith({
      where: {
        contractId: "c_1",
        isOneTimeAddon: true,
        OR: [{ addonCycleIndex: 5 }, { addonCycleIndex: null }],
      },
    });
    // Same space for the gift ADDED → SHIPPED flip.
    expect(mocks.giftUpdateMany).toHaveBeenCalledWith({
      where: { contractId: "c_1", cycleIndex: 5, status: "ADDED" },
      data: { status: "SHIPPED" },
    });
  });

  it("falls back to ordersCount + 1 when the Shopify cycle read fails", async () => {
    mocks.getBillingCycleByDate.mockRejectedValue(new Error("throttled"));

    await deliverSuccess();

    expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.cycleIndex).toBe(4);
  });

  it("falls back to ordersCount + 1 when no nextBillingDate is mirrored (no Shopify round trip)", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      divergedContract({ nextBillingDate: null }),
    );

    await deliverSuccess();

    expect(mocks.getBillingCycleByDate).not.toHaveBeenCalled();
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.cycleIndex).toBe(4);
  });
});
