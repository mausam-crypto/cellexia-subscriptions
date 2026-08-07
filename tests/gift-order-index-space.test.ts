import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ORDER_INDEX gift rules live in ORDER-NUMBER space, not Shopify cycle-index
 * space.
 *
 * The two spaces diverge permanently after any skipped cycle (skipped cycles
 * keep their index): a subscriber who skipped once has their Nth ORDER billed
 * by Shopify cycle N+1. The lifecycle engine's milestone email fires on
 * ordersCount (order space), so when ruleMatchesCycle compared
 * rule.orderIndex against the Shopify cycle index the milestone email
 * announced a gift whose rule could never match again — the "gift on your
 * Nth order" promise was silently broken for every skipper. The daily
 * gifts_run compounded it by ensuring cycle ordersCount + 1, an old
 * skipped/billed cycle on a diverged contract, making the job a permanent
 * no-op there.
 *
 * Contract under test (real ensureGiftsForUpcomingCycle / runGiftScheduling,
 * every seam mocked):
 *  - ORDER_INDEX matches the order number the ensured cycle will become;
 *  - the grant/attach still target the REAL Shopify cycle index;
 *  - gifts_run resolves the upcoming cycle from Shopify by nextBillingDate
 *    and passes both numbers, falling back to aligned spaces on read failure.
 */

const CONTRACT_GID = "gid://shopify/SubscriptionContract/901";
const GIFT_VARIANT = "gid://shopify/ProductVariant/78";
const NEXT_BILLING = new Date("2026-08-10T09:00:00Z");

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
  shopFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({})),
  giftRuleFindMany: vi.fn(async (): Promise<unknown[]> => []),
  giftRuleFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (): Promise<unknown[]> => []),
  giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantUpdate: vi.fn(async (): Promise<unknown> => ({})),
  giftGrantCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
  lineFindFirst: vi.fn(async (): Promise<unknown> => null),
  lineCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => null,
  ),
  getBillingCycleByDate: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => null,
  ),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      _cycle: unknown,
      body: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      await body("draft_1", {});
    },
  ),
  draftLineAdd: vi.fn(async (): Promise<string> => "gid://shopify/Line/901"),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
    },
    shop: { findUniqueOrThrow: mocks.shopFindUniqueOrThrow },
    giftRule: {
      findMany: mocks.giftRuleFindMany,
      findFirst: mocks.giftRuleFindFirst,
    },
    giftGrant: {
      findMany: mocks.giftGrantFindMany,
      findFirst: mocks.giftGrantFindFirst,
      update: mocks.giftGrantUpdate,
      create: mocks.giftGrantCreate,
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    contractLine: {
      findFirst: mocks.lineFindFirst,
      create: mocks.lineCreate,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineAdd: mocks.draftLineAdd,
  getBillingCycleByIndex: mocks.getBillingCycleByIndex,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  getVariants: mocks.getVariants,
  withBillingCycleEdit: mocks.withBillingCycleEdit,
}));

import {
  ensureGiftsForUpcomingCycle,
  runGiftScheduling,
} from "~/lib/gifts/engine.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  ianaTimezone: "Europe/Zurich",
};

/** One successful order so far; one EARLY SKIP → upcoming cycle 3 bills order 2. */
function divergedContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/6",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    ordersCount: 1,
    intervalWeeks: 4,
    firstChargeAt: new Date("2026-06-15T09:00:00Z"),
    nextBillingDate: NEXT_BILLING,
    currencyCode: "CHF",
    locale: "en",
    lines: [],
    ...over,
  };
}

function orderIndexRule(orderIndex: number) {
  return {
    id: "rule_oi",
    shopId: "shop_1",
    name: `Gift on order ${orderIndex}`,
    trigger: "ORDER_INDEX",
    orderIndex,
    daysSubscribed: null,
    variantId: GIFT_VARIANT,
    variantTitle: "Free Serum",
    unitCostCents: 500,
    announceInAdvance: false,
    active: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function cycle(index: number, over: Record<string, unknown> = {}) {
  return {
    cycleIndex: index,
    billingAttemptExpectedDate: NEXT_BILLING,
    skipped: false,
    edited: false,
    status: "UNBILLED",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(divergedContract());
  mocks.shopFindUniqueOrThrow.mockResolvedValue(SHOP);
  mocks.getPrimaryShop.mockResolvedValue(SHOP);
  mocks.giftRuleFindMany.mockResolvedValue([orderIndexRule(2)]);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  mocks.giftGrantCreate.mockImplementation(
    async (args: { data?: Record<string, unknown> } | unknown) => ({
      id: "grant_new",
      ...(args as { data: Record<string, unknown> }).data,
      rule: orderIndexRule(2),
    }),
  );
  mocks.getBillingCycleByIndex.mockImplementation(
    async (_admin: unknown, _gid: unknown, index: unknown) =>
      cycle(index as number),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ORDER_INDEX rules match the ORDER number, grants target the CYCLE index", () => {
  it("grants the 'gift on your 2nd order' when the 2nd order bills as Shopify cycle 3 (one skip)", async () => {
    const result = await ensureGiftsForUpcomingCycle("c_1", 3, 2);

    expect(result.rulesMatched).toBe(1);
    expect(result.grantsCreated).toBe(1);

    // The grant row and the zero-priced line ride the REAL Shopify cycle.
    expect(mocks.giftGrantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cycleIndex: 3, variantId: GIFT_VARIANT }),
      }),
    );
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 3 },
      expect.any(Function),
    );
    expect(result.linesAdded).toBe(1);

    // The audit event carries both spaces.
    const scheduled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "lifecycle.gift_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toMatchObject({ cycleIndex: 3, orderNumber: 2 });
  });

  it("does NOT match on the cycle index: ORDER_INDEX=3 stays quiet while cycle 3 bills order 2", async () => {
    mocks.giftRuleFindMany.mockResolvedValue([orderIndexRule(3)]);

    const result = await ensureGiftsForUpcomingCycle("c_1", 3, 2);

    expect(result.rulesMatched).toBe(0);
    expect(mocks.giftGrantCreate).not.toHaveBeenCalled();
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("defaults the order number to ordersCount + 1 when the caller omits it", async () => {
    // ordersCount 1 → upcoming order 2; aligned spaces (no skip): cycle 2.
    const result = await ensureGiftsForUpcomingCycle("c_1", 2);

    expect(result.rulesMatched).toBe(1);
    expect(mocks.giftGrantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cycleIndex: 2 }),
      }),
    );
  });
});

describe("gifts_run resolves the upcoming Shopify cycle by nextBillingDate", () => {
  beforeEach(() => {
    mocks.contractFindMany.mockResolvedValue([
      {
        id: "c_1",
        ordersCount: 1,
        shopifyContractId: CONTRACT_GID,
        nextBillingDate: NEXT_BILLING,
      },
    ]);
  });

  it("ensures the REAL upcoming cycle (3) so a diverged contract is no longer a permanent no-op", async () => {
    mocks.getBillingCycleByDate.mockResolvedValue(cycle(3));

    const stats = await runGiftScheduling(new Date("2026-08-06T08:00:00Z"));

    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      NEXT_BILLING,
    );
    // Order 2's rule matched and the grant landed on cycle 3.
    expect(stats.rulesMatched).toBe(1);
    expect(stats.grantsCreated).toBe(1);
    expect(mocks.giftGrantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cycleIndex: 3 }),
      }),
    );
    expect(stats.errors).toBe(0);
  });

  it("falls back to aligned spaces (ordersCount + 1) when the cycle read fails", async () => {
    mocks.getBillingCycleByDate.mockRejectedValue(new Error("shopify down"));

    const stats = await runGiftScheduling(new Date("2026-08-06T08:00:00Z"));

    // The sweep still ran the ensure — pre-fix behavior, not a hard failure.
    expect(stats.scanned).toBe(1);
    expect(stats.rulesMatched).toBe(1);
    expect(mocks.giftGrantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cycleIndex: 2 }),
      }),
    );
  });
});
