import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SHOPIFY-SIDE REACTIVATION × CYCLE-HISTORY GUARD — the third entry point of
 * the reactivated-but-never-billed trap (after win-back reactivation and the
 * admin Resume button): a merchant reactivates a payment-failed CANCELLED/
 * FAILED contract directly in the Shopify admin. CONTRACTS_UPDATE →
 * syncContractFromShopify flips the mirror ACTIVE with Shopify's
 * nextBillingDate still parked on the failed cycle; the EXHAUSTED dunning
 * case can never be reopened (onPaymentMethodUpdated requires status FAILED),
 * so without the release the billing sweep's b2 guard holds the unbilled
 * cycle on its terminal attempt forever.
 *
 * The fix: updateExistingRow detects CANCELLED/FAILED → ACTIVE and, in ONE
 * transaction with the ACTIVE mirror write (a crash between the two is
 * unfixable — the redelivered webhook re-syncs from prior status ACTIVE),
 * stamps the closed episode's terminal attempts superseded via the shared
 * releaseHeldCycleAttempts. It also clears the LIVE-STATE churn columns
 * (cancelledAt / cancelReason / cancelSource / failedAt): a reactivated
 * subscriber is retained again, and a stale stamp would also freeze the
 * timestamp of any LATER churn (transitions only write when the prior stamp
 * is null).
 *
 * Scaffold: contract-ownership-sync.test.ts (everything DB/Shopify-shaped
 * mocked; the REAL syncContractFromShopify + REAL release helper run).
 */

interface ShopifyLineFixture {
  id: string;
  sellingPlanId: string | null;
  sellingPlanName?: string | null;
}

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ...args.data,
    }),
  ),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ownership: "OURS",
      ...args.data,
    }),
  ),
  contractUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  attemptUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  dunningCaseFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  transaction: vi.fn(),
  lineCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineDeleteMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  planConfigFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  planConfigUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  getContract: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({ createdAt: new Date() })),
  getSellingPlanGroupPlanIds: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("~/db.server", () => {
  const client = {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      create: mocks.contractCreate,
      update: mocks.contractUpdate,
      updateMany: mocks.contractUpdateMany,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    contractLine: {
      create: mocks.lineCreate,
      update: mocks.lineUpdate,
      deleteMany: mocks.lineDeleteMany,
    },
    billingAttempt: { updateMany: mocks.attemptUpdateMany },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
    sellingPlanConfig: {
      findMany: mocks.planConfigFindMany,
      findFirst: vi.fn(async (): Promise<unknown> => null),
      update: mocks.planConfigUpdate,
    },
    shop: { findUnique: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })) },
  };
  // Interactive $transaction: hand the SAME client back as tx so the test
  // can observe which writes were committed inside the transaction.
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  );
  return { default: { ...client, $transaction: mocks.transaction } };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getContract: mocks.getContract,
  getVariants: mocks.getVariants,
  getOrderSummary: mocks.getOrderSummary,
  listContractGids: vi.fn(),
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getSellingPlanGroupPlanIds: mocks.getSellingPlanGroupPlanIds,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async (): Promise<unknown> => ({})),
  getShopMetafield: vi.fn(),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/contracts/shared.server", () => ({
  reloadContract: vi.fn(async (id: string): Promise<unknown> => ({ id, lines: [] })),
  resolveActor: vi.fn((): string => "system"),
}));

import { syncContractFromShopify } from "~/lib/contracts/sync.server";

const OUR_PLAN = "gid://shopify/SellingPlan/111";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/5";

function shopifyContract(
  lines: ShopifyLineFixture[],
  status = "ACTIVE",
): unknown {
  return {
    id: CONTRACT_GID,
    status,
    // The reactivation reality: Shopify's date is still parked on the failed,
    // unbilled cycle — exactly what the sweep will re-resolve.
    nextBillingDate: new Date("2026-08-01T00:00:00Z"),
    currencyCode: "CHF",
    billingPolicy: { interval: "WEEK", intervalCount: 8, minCycles: null, maxCycles: null },
    deliveryPolicy: null,
    deliveryPriceCents: 0,
    customer: {
      id: "gid://shopify/Customer/1",
      email: "a@b.c",
      firstName: "A",
      lastName: "B",
      phone: null,
      locale: "en",
    },
    customerPaymentMethod: null,
    deliveryMethod: null,
    originOrder: null,
    lines: lines.map((l, i) => ({
      id: l.id,
      productId: "gid://shopify/Product/1",
      variantId: `gid://shopify/ProductVariant/${i + 1}`,
      title: "Cream",
      variantTitle: null,
      sku: null,
      quantity: 1,
      sellingPlanId: l.sellingPlanId,
      sellingPlanName: l.sellingPlanName ?? null,
      currentPrice: "64.00",
      currentPriceCents: 6400,
      currencyCode: "CHF",
      pricingPolicy: null,
      imageUrl: null,
    })),
  };
}

function failedMirror(over: Record<string, unknown> = {}) {
  return {
    id: "local_1",
    shopId: "shop_1",
    ownership: "OURS",
    status: "FAILED",
    customerId: "gid://shopify/Customer/1",
    email: "a@b.c",
    cancelledAt: null,
    cancelSource: null,
    failedAt: new Date("2026-08-02T00:00:00Z"),
    pausedAt: null,
    firstChargeAt: new Date("2026-01-05T00:00:00Z"),
    originOrderTotalCents: 6400,
    lines: [],
    ...over,
  };
}

function updateData(): Record<string, unknown> {
  const call = mocks.contractUpdate.mock.calls[0];
  return (call?.[0] as { data: Record<string, unknown> }).data;
}

function updatedEventPayload(): Record<string, unknown> {
  const event = mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .find((e) => e.type === "contract.updated");
  return event?.payload ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.planConfigFindMany.mockResolvedValue([
    {
      shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
      shopifyPlanIds: [OUR_PLAN],
    },
  ]);
  mocks.getVariants.mockResolvedValue([]);
  mocks.contractUpdate.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ownership: "OURS",
      ...args.data,
    }),
  );
});

describe("syncContractFromShopify — Shopify-side reactivation release", () => {
  it("FAILED → ACTIVE releases the held cycle inside the mirror-write transaction", async () => {
    mocks.contractFindUnique.mockResolvedValue(failedMirror());
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    // Update + release committed together.
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.attemptUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: {
        contractId: "local_1",
        status: { in: ["FAILED", "CHALLENGED", "EXPIRED"] },
        supersededAt: null,
      },
      data: { supersededAt: expect.any(Date) },
    });

    // LIVE-STATE churn columns cleared with the ACTIVE flip.
    expect(updateData()).toMatchObject({
      status: "ACTIVE",
      failedAt: null,
      cancelledAt: null,
      cancelReason: null,
      cancelSource: null,
    });

    // Auditable on the sync's contract.updated event.
    expect(updatedEventPayload()).toMatchObject({
      previousStatus: "FAILED",
      reactivated: true,
      releasedFailedAttempts: 1,
    });
  });

  it("CANCELLED → ACTIVE releases too (merchant reactivates a cancelled contract)", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      failedMirror({
        status: "CANCELLED",
        cancelledAt: new Date("2026-08-02T00:00:00Z"),
        cancelSource: "SYSTEM",
        failedAt: null,
      }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.attemptUpdateMany).toHaveBeenCalledTimes(1);
    expect(updateData()).toMatchObject({
      status: "ACTIVE",
      cancelledAt: null,
      cancelReason: null,
      cancelSource: null,
    });
    expect(updatedEventPayload()).toMatchObject({
      previousStatus: "CANCELLED",
      reactivated: true,
      releasedFailedAttempts: 1,
    });
  });

  it("an OPEN dunning case still owns its cycle: transition clears columns, releases nothing", async () => {
    mocks.contractFindUnique.mockResolvedValue(failedMirror());
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(updatedEventPayload()).toMatchObject({
      reactivated: true,
      releasedFailedAttempts: 0,
    });
  });

  it("a plain ACTIVE → ACTIVE sync neither opens a transaction nor touches attempts", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      failedMirror({ status: "ACTIVE", failedAt: null }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(updatedEventPayload()).not.toHaveProperty("reactivated");
  });

  it("a FOREIGN contract's reactivation is mirrored but never released (not ours to bill)", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      failedMirror({ status: "CANCELLED", ownership: "FOREIGN" }),
    );
    mocks.contractUpdate.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({
        id: "local_1",
        customerId: "gid://shopify/Customer/1",
        email: "a@b.c",
        ownership: "FOREIGN",
        ...args.data,
      }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract([
        { id: "l1", sellingPlanId: "gid://shopify/SellingPlan/999" },
      ]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(updatedEventPayload()).not.toHaveProperty("releasedFailedAttempts");
  });
});
