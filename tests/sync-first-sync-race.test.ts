import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * FIRST-SYNC RACE — the P2002 that killed the first-order gift.
 *
 * Two concurrent FIRST-TIME syncs of the same contract are a routine pairing,
 * not an edge case: Shopify fires SUBSCRIPTION_CONTRACTS_CREATE and _UPDATE
 * back-to-back at checkout, and app.import's post-create sync races the
 * CREATE webhook. Both read `existing == null` at the top of
 * syncContractFromShopify, both spend seconds in Shopify round trips (variant
 * enrichment, ownership evidence, origin-order fetch), then both reach the
 * create on the unique `shopifyContractId`. The loser used to throw P2002 out
 * of the WHOLE sync: handleSubscriptionContractsCreate aborted BEFORE the
 * contract.created event, locale backfill, ensureFirstOrderGift and the
 * cycle-1/2 gift scheduling ever ran, the webhook answered 200 FAILED
 * (retry train over), and — since ensureFirstOrderGift has exactly one call
 * site — the plan-configured first-order gift silently never shipped.
 *
 * The fix: the loser catches P2002, re-reads the row the winner committed,
 * and falls through to the update path — re-applying the monotonic ownership
 * rule against the winner's verdict and logging contract.updated (the winner
 * already logged the one contract.created). These tests drive the REAL
 * syncContractFromShopify against a mocked persistence/GraphQL seam
 * (contract-ownership-sync.test.ts pattern).
 */

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_loser",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ...args.data,
    }),
  ),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_winner",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ownership: "OURS",
      ...args.data,
    }),
  ),
  contractUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  lineCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineDeleteMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  planConfigFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  getContract: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({ createdAt: new Date() })),
  getSellingPlanGroupPlanIds: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
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
    sellingPlanConfig: {
      findMany: mocks.planConfigFindMany,
      findFirst: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    shop: { findUnique: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })) },
  },
}));

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
const WINNER_FIRST_CHARGE = new Date("2026-08-01T10:00:00Z");

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("unique violation", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: "SubscriptionContract_shopifyContractId_key" },
  });
}

function shopifyContract(sellingPlanId: string | null): unknown {
  return {
    id: CONTRACT_GID,
    status: "ACTIVE",
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
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
    originOrder: { id: "gid://shopify/Order/900", name: "#1001" },
    lines: [
      {
        id: "gid://shopify/SubscriptionLine/1",
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Cream",
        variantTitle: null,
        sku: null,
        quantity: 1,
        sellingPlanId,
        sellingPlanName: sellingPlanId ? "Every 8 weeks" : null,
        currentPrice: "64.00",
        currentPriceCents: 6400,
        currencyCode: "CHF",
        pricingPolicy: null,
        imageUrl: null,
      },
    ],
  };
}

/** The row the winner committed between this sync's null read and its create. */
function winnerRow(over: Record<string, unknown> = {}) {
  return {
    id: "local_winner",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "a@b.c",
    status: "ACTIVE",
    ownership: "OURS",
    cancelledAt: null,
    cancelSource: null,
    failedAt: null,
    pausedAt: null,
    firstChargeAt: WINNER_FIRST_CHARGE,
    originOrderTotalCents: 6400,
    currencyCode: "CHF",
    lines: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.planConfigFindMany.mockResolvedValue([
    {
      shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
      shopifyPlanIds: [OUR_PLAN],
    },
  ]);
  mocks.getVariants.mockResolvedValue([]);
  mocks.getOrderSummary.mockResolvedValue({
    createdAt: WINNER_FIRST_CHARGE,
    totalCents: 6400,
    discountsCents: 0,
    shippingCents: 0,
    processedAt: WINNER_FIRST_CHARGE,
    currencyCode: "CHF",
  });
});

describe("syncContractFromShopify — lost first-sync race (P2002 on create)", () => {
  it("converges on the winner's row instead of throwing: update path + contract.updated", async () => {
    // Read at the top: nothing there yet. Re-read after the conflict: the
    // winner's committed row.
    mocks.contractFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerRow());
    mocks.contractCreate.mockRejectedValueOnce(p2002());
    mocks.getContract.mockResolvedValue(shopifyContract(OUR_PLAN));

    const result = await syncContractFromShopify(
      "cellexia.myshopify.com",
      CONTRACT_GID,
    );

    // The sync SUCCEEDED — the webhook handler's post-sync work (first-order
    // gift, gift scheduling, locale backfill) gets to run.
    expect(result).toBeTruthy();
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.contractUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "local_winner" },
    });

    // The loser logs contract.updated — the winner already logged the one
    // contract.created for this mirror.
    const events = mocks.logEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(events).toContain("contract.updated");
    expect(events).not.toContain("contract.created");
  });

  it("re-applies the monotonic ownership rule against the winner's verdict (no UNKNOWN downgrade)", async () => {
    // The loser resolved UNKNOWN (no selling plan on the payload it fetched);
    // the winner committed an explicit OURS (e.g. the import script's
    // grandfathered stamp). The fallen-through update must NOT write the
    // stale UNKNOWN over it.
    mocks.contractFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerRow({ ownership: "OURS" }));
    mocks.contractCreate.mockRejectedValueOnce(p2002());
    mocks.getContract.mockResolvedValue(shopifyContract(null));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    const data = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect("ownership" in data).toBe(false);
  });

  it("never clobbers the winner's firstChargeAt when the loser's own order fetch failed", async () => {
    mocks.contractFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerRow());
    mocks.contractCreate.mockRejectedValueOnce(p2002());
    mocks.getContract.mockResolvedValue(shopifyContract(OUR_PLAN));
    mocks.getOrderSummary.mockRejectedValue(new Error("shopify 500"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.firstChargeAt).toEqual(WINNER_FIRST_CHARGE);
    errSpy.mockRestore();
  });

  it("a non-P2002 create failure still propagates — the retry train must see real errors", async () => {
    mocks.contractCreate.mockRejectedValueOnce(new Error("db down"));
    mocks.getContract.mockResolvedValue(shopifyContract(OUR_PLAN));

    await expect(
      syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID),
    ).rejects.toThrow("db down");
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("P2002 with the conflicting row already gone re-throws the original error", async () => {
    // Uninstall cleanup deleted the winner's row between the conflict and the
    // re-read: nothing to converge on, so the failure must surface.
    mocks.contractFindUnique.mockResolvedValue(null);
    mocks.contractCreate.mockRejectedValueOnce(p2002());
    mocks.getContract.mockResolvedValue(shopifyContract(OUR_PLAN));

    await expect(
      syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID),
    ).rejects.toThrow("unique violation");
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });
});
