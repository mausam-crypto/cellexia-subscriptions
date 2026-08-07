import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * syncContractFromShopify is the single writer of contract mirrors, and
 * therefore the single place that decides which subscription app a contract
 * belongs to. These tests pin that decision, because getting it wrong in the
 * permissive direction means charging another app's subscribers a second time.
 *
 * Everything DB- and Shopify-shaped is mocked (launch-mode.test.ts pattern).
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
      ...args.data,
    }),
  ),
  contractUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
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
      update: mocks.planConfigUpdate,
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
const JOY_PLAN = "gid://shopify/SellingPlan/999";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/5";

function shopifyContract(
  lines: ShopifyLineFixture[],
  originOrder: { id: string; name: string } | null = null,
): unknown {
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
    originOrder,
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

/** The ownership value the sync wrote, from whichever write path ran. */
function writtenOwnership(): unknown {
  const call =
    mocks.contractCreate.mock.calls[0] ?? mocks.contractUpdate.mock.calls[0];
  const data = (call?.[0] as { data: Record<string, unknown> } | undefined)?.data;
  return data?.ownership;
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
});

describe("syncContractFromShopify — ownership classification", () => {
  it("mirrors another app's contract as FOREIGN (never billable)", async () => {
    // The exact live scenario: Joy Subscriptions created this contract, the
    // shop-wide SUBSCRIPTION_CONTRACTS_CREATE webhook handed it to us.
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: JOY_PLAN, sellingPlanName: "Joy 5%" }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(writtenOwnership()).toBe("FOREIGN");
  });

  it("mirrors our own contract as OURS", async () => {
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(writtenOwnership()).toBe("OURS");
  });

  it("mirrors a contract with no selling plan as UNKNOWN, not OURS", async () => {
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: null }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(writtenOwnership()).toBe("UNKNOWN");
  });

  it("keeps an explicit OURS when a re-sync brings no plan evidence", async () => {
    // Imported subscribers are stamped OURS at creation; a later re-sync must
    // not demote them to an unbillable UNKNOWN.
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "OURS",
      status: "ACTIVE",
      lines: [],
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: null }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(writtenOwnership()).toBe("OURS");
  });

  it("refuses to call anything FOREIGN while our own plan ids are unknown", async () => {
    // A group synced by an older build that never recorded its plan ids, and
    // the read-back repair fails: the set we hold is knowingly incomplete, so
    // "not in the set" proves nothing.
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
    ]);
    mocks.getSellingPlanGroupPlanIds.mockResolvedValue([]);
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: JOY_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(writtenOwnership()).toBe("UNKNOWN");
  });

  it("repairs missing plan ids from Shopify, then classifies with them", async () => {
    mocks.planConfigFindMany
      .mockResolvedValueOnce([
        { id: "cfg_1", shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
      ])
      // refreshOwnPlanIdsFromShopify's own lookup
      .mockResolvedValueOnce([
        { id: "cfg_1", shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
      ])
      // re-read after the repair persisted the plan ids
      .mockResolvedValue([
        { shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: [OUR_PLAN] },
      ]);
    mocks.getSellingPlanGroupPlanIds.mockResolvedValue([OUR_PLAN]);
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.planConfigUpdate).toHaveBeenCalledWith({
      where: { id: "cfg_1" },
      data: { shopifyPlanIds: [OUR_PLAN] },
    });
    expect(writtenOwnership()).toBe("OURS");
  });

  it("stores the selling plan on the mirrored line (local ownership evidence)", async () => {
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: JOY_PLAN, sellingPlanName: "Joy 5%" }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (mocks.lineCreate.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      sellingPlanId: JOY_PLAN,
      sellingPlanName: "Joy 5%",
    });
  });

  it("never writes UNKNOWN on the update path — a concurrent OURS stamp survives the race", async () => {
    // The import race: this sync read `existing` while the row was still
    // UNKNOWN, then spent seconds on Shopify round trips; in that window the
    // import script stamped grandfathered+OURS. The sync's resolution (no
    // selling plan → prior ?? UNKNOWN) is stale — if the update carried it,
    // the imported subscriber would flip back to UNKNOWN and silently drop
    // out of every OURS_ONLY billing/reminder/dunning sweep. The monotonic
    // rule: a resolved UNKNOWN is simply not written (row is NOT NULL DEFAULT
    // 'UNKNOWN', so the only legal UNKNOWN write is a no-op).
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "UNKNOWN", // stale read — concurrently stamped OURS
      status: "ACTIVE",
      lines: [],
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: null }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    const data = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    // No ownership key AT ALL: not UNKNOWN, not the stale prior — the column
    // is untouched, so whatever verdict landed concurrently is preserved.
    expect(Object.keys(data)).not.toContain("ownership");
  });

  it("still tightens UNKNOWN → FOREIGN on the update path (positive evidence)", async () => {
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "UNKNOWN",
      status: "ACTIVE",
      lines: [],
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: JOY_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.ownership).toBe("FOREIGN");
  });

  it("still tightens UNKNOWN → OURS on the update path (our plan on a line)", async () => {
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "UNKNOWN",
      status: "ACTIVE",
      lines: [],
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.ownership).toBe("OURS");
  });

  it("a brand-new mirror still records UNKNOWN on the create row", async () => {
    mocks.contractFindUnique.mockResolvedValue(null);
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: null }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.contractCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.ownership).toBe("UNKNOWN");
  });

  it("the audit event reports the ROW's ownership when the downgrade was suppressed", async () => {
    // Same race as above, but the concurrent OURS stamp already landed by the
    // time the update ran: the row the write returns says OURS, and that —
    // not the sync's stale UNKNOWN resolution — is what the event must say.
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "UNKNOWN",
      status: "ACTIVE",
      lines: [],
    });
    mocks.contractUpdate.mockResolvedValue({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ownership: "OURS", // what the row actually holds post-update
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: null }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const event = mocks.logEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(event.payload).toMatchObject({ ownership: "OURS" });
  });

  it("records ownership in the audit event", async () => {
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: JOY_PLAN }]),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const event = mocks.logEvent.mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(event.payload).toMatchObject({ ownership: "FOREIGN" });
  });
});

describe("syncContractFromShopify — origin money is an atomic first-capture claim", () => {
  const ORDER = { id: "gid://shopify/Order/900", name: "#1042" };
  const SUMMARY = {
    totalCents: 4200,
    discountsCents: 0,
    shippingCents: 500,
    processedAt: new Date("2026-06-10T10:00:00Z"),
    createdAt: new Date("2026-06-10T09:59:00Z"),
    currencyCode: "CHF",
  };

  it("on a re-sync, money goes through updateMany gated on a still-null total — never the plain update", async () => {
    // Mirror exists but its capture-at-create fetch failed: total still null.
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "OURS",
      status: "ACTIVE",
      lines: [],
      originOrderTotalCents: null,
      firstChargeAt: new Date("2026-06-10T09:59:00Z"),
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }], ORDER),
    );
    mocks.getOrderSummary.mockResolvedValue(SUMMARY);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    // The unconditional update must not carry money: a stale sync (order
    // fetched pre-refund, written post-capture) would overwrite a captured
    // total while refundedCents stays incremented — the double-net.
    const updateData = (
      mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(updateData).not.toHaveProperty("originOrderTotalCents");
    expect(updateData).not.toHaveProperty("originOrderRefundedCents");

    // The claim is the backfill's shape: fills a still-null mirror only.
    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    const claim = mocks.contractUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where).toEqual({ id: "local_1", originOrderTotalCents: null });
    expect(claim.data).toMatchObject({
      originOrderTotalCents: 4200,
      originOrderCurrencyCode: "CHF",
    });
    expect(claim.data).not.toHaveProperty("originOrderRefundedCents");
  });

  it("an already-captured mirror is left alone (no fetch, no claim)", async () => {
    mocks.contractFindUnique.mockResolvedValue({
      id: "local_1",
      ownership: "OURS",
      status: "ACTIVE",
      lines: [],
      originOrderTotalCents: 9999,
      firstChargeAt: new Date("2026-06-10T09:59:00Z"),
    });
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }], ORDER),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.getOrderSummary).not.toHaveBeenCalled();
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
  });

  it("a brand-new mirror captures on the create row itself (nothing to overwrite)", async () => {
    mocks.contractFindUnique.mockResolvedValue(null);
    mocks.getContract.mockResolvedValue(
      shopifyContract([{ id: "l1", sellingPlanId: OUR_PLAN }], ORDER),
    );
    mocks.getOrderSummary.mockResolvedValue(SUMMARY);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const createData = (
      mocks.contractCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(createData).toMatchObject({ originOrderTotalCents: 4200 });
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
  });
});
