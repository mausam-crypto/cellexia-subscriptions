import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * First-order gift tests (SellingPlanConfig.firstOrderGiftVariantId runtime).
 *
 * Pure plan matching is tested directly; the ensureFirstOrderGift
 * orchestration is tested with every DB/Shopify seam mocked:
 *  - ~/db.server → contract / shop / plan-config / gift-grant access
 *  - ~/shopify.server → adminClientForShop
 *  - ~/lib/graphql/index.server → addFreeGiftToOrder (the order edit) +
 *    getVariants (event metadata)
 *  - ~/lib/events/log.server → logEvent capture (the audit assertion target)
 */

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => null),
  planFindMany: vi.fn(async (): Promise<unknown[]> => []),
  grantFindFirst: vi.fn(async (): Promise<unknown> => null),
  grantCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  grantUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  logEvent: vi.fn(async (_event: unknown): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  addFreeGiftToOrder: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({})),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  raiseAlert: vi.fn(async (_input: unknown): Promise<boolean> => true),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUniqueOrThrow: mocks.shopFindUniqueOrThrow },
    sellingPlanConfig: { findMany: mocks.planFindMany },
    giftGrant: {
      findFirst: mocks.grantFindFirst,
      create: mocks.grantCreate,
      update: mocks.grantUpdate,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("~/lib/graphql/index.server", () => ({
  addFreeGiftToOrder: mocks.addFreeGiftToOrder,
  getVariants: mocks.getVariants,
}));

// Lazy-imported by the ACCESS_DENIED branch only.
vi.mock("~/lib/analytics/alerts.server", () => ({
  raiseAlert: mocks.raiseAlert,
}));

import {
  FIRST_ORDER_GIFT_CYCLE_INDEX,
  FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX,
  ensureFirstOrderGift,
  matchFirstOrderGiftPlan,
  planProductIds,
} from "~/lib/gifts/firstOrderGift.server";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PRODUCT_A = "gid://shopify/Product/11";
const PRODUCT_B = "gid://shopify/Product/22";
const GIFT_VARIANT = "gid://shopify/ProductVariant/77";
const ORIGIN_ORDER = "gid://shopify/Order/900";
const SHOP_DOMAIN = "cellexia.myshopify.com";

function contractFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm_contract_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1001",
    customerId: "gid://shopify/Customer/2002",
    email: "anna@example.com",
    status: "ACTIVE",
    // Column default in Prisma; the gift runtime refuses to edit a contract
    // another subscription app owns, so the fixture must carry it explicitly.
    ownership: "OURS",
    ordersCount: 0,
    originOrderId: ORIGIN_ORDER,
    originOrderName: "#1042",
    lines: [
      {
        productId: PRODUCT_A,
        variantId: "gid://shopify/ProductVariant/12",
        isGift: false,
      },
    ],
    ...overrides,
  };
}

function planFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "plan_1",
    name: "Cellexia Subscribe & Save",
    active: true,
    productIds: [PRODUCT_A],
    firstOrderGiftVariantId: GIFT_VARIANT,
    ...overrides,
  };
}

function loggedEventTypes(): string[] {
  return mocks.logEvent.mock.calls.map(
    (call) => (call[0] as { type: string }).type,
  );
}

function loggedEvent(type: string): Record<string, unknown> | undefined {
  return mocks.logEvent.mock.calls
    .map((call) => call[0] as { type: string; payload?: Record<string, unknown> })
    .find((event) => event.type === type) as
    | Record<string, unknown>
    | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    domain: SHOP_DOMAIN,
    ianaTimezone: "Europe/London",
  });
  mocks.planFindMany.mockResolvedValue([planFixture()]);
  mocks.grantFindFirst.mockResolvedValue(null);
  mocks.grantCreate.mockImplementation(async (args: unknown) => ({
    id: "grant_1",
    ...(args as { data: Record<string, unknown> }).data,
  }));
  mocks.grantUpdate.mockImplementation(async (args: unknown) => args);
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.adminClientForShop.mockResolvedValue({ graphql: vi.fn() });
  mocks.addFreeGiftToOrder.mockResolvedValue({
    orderId: ORIGIN_ORDER,
    calculatedLineItemId: "gid://shopify/CalculatedLineItem/1",
  });
  mocks.getVariants.mockResolvedValue([
    {
      id: GIFT_VARIANT,
      title: "Default Title",
      sku: null,
      productId: "gid://shopify/Product/70",
      productTitle: "Cellexia Travel Mask",
      productStatus: "ACTIVE",
      priceCents: 1400,
      compareAtPriceCents: null,
      availableForSale: true,
      inventoryQuantity: 50,
      imageUrl: null,
      unitCostCents: 300,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pure plan matching ───────────────────────────────────────────────────────

describe("matchFirstOrderGiftPlan", () => {
  it("matches when a contract product is covered by the plan", () => {
    const plan = planFixture();
    expect(matchFirstOrderGiftPlan([plan], [PRODUCT_A])).toBe(plan);
    expect(matchFirstOrderGiftPlan([plan], [PRODUCT_B, PRODUCT_A])).toBe(plan);
  });

  it("returns null when no plan covers the contract's products", () => {
    expect(matchFirstOrderGiftPlan([planFixture()], [PRODUCT_B])).toBeNull();
    expect(matchFirstOrderGiftPlan([], [PRODUCT_A])).toBeNull();
    expect(matchFirstOrderGiftPlan([planFixture()], [])).toBeNull();
  });

  it("skips inactive plans and plans without a gift", () => {
    expect(
      matchFirstOrderGiftPlan([planFixture({ active: false })], [PRODUCT_A]),
    ).toBeNull();
    expect(
      matchFirstOrderGiftPlan(
        [planFixture({ firstOrderGiftVariantId: null })],
        [PRODUCT_A],
      ),
    ).toBeNull();
  });

  it("first matching plan wins (caller passes createdAt asc)", () => {
    const first = planFixture({ id: "plan_1" });
    const second = planFixture({
      id: "plan_2",
      firstOrderGiftVariantId: "gid://shopify/ProductVariant/88",
    });
    expect(matchFirstOrderGiftPlan([first, second], [PRODUCT_A])).toBe(first);
  });

  it("tolerates malformed productIds Json", () => {
    expect(planProductIds({ productIds: null })).toEqual([]);
    expect(planProductIds({ productIds: { nope: true } })).toEqual([]);
    expect(planProductIds({ productIds: [42, "", PRODUCT_A] })).toEqual([
      PRODUCT_A,
    ]);
    expect(
      matchFirstOrderGiftPlan(
        [planFixture({ productIds: "not-an-array" })],
        [PRODUCT_A],
      ),
    ).toBeNull();
  });
});

// ── ensureFirstOrderGift orchestration ───────────────────────────────────────

describe("ensureFirstOrderGift", () => {
  it("adds the gift to the origin order as a free line and logs cycle.gift_added", async () => {
    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result.status).toBe("added");
    if (result.status !== "added") throw new Error("unreachable");
    expect(result.grantId).toBe("grant_1");
    expect(result.planConfigId).toBe("plan_1");
    expect(result.variantId).toBe(GIFT_VARIANT);
    expect(result.orderId).toBe(ORIGIN_ORDER);

    // The order edit targeted the origin order with the configured variant.
    expect(mocks.addFreeGiftToOrder).toHaveBeenCalledTimes(1);
    const [, orderGid, variantGid, options] =
      mocks.addFreeGiftToOrder.mock.calls[0] as unknown[];
    expect(orderGid).toBe(ORIGIN_ORDER);
    expect(variantGid).toBe(GIFT_VARIANT);
    expect(options).toMatchObject({ quantity: 1, notifyCustomer: false });

    // Claim row on the synthetic origin-order cycle, then flipped to ADDED.
    expect(mocks.grantCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contractId: "cm_contract_1",
          ruleId: null,
          cycleIndex: FIRST_ORDER_GIFT_CYCLE_INDEX,
          variantId: GIFT_VARIANT,
          status: "SCHEDULED",
        }),
      }),
    );
    expect(mocks.grantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant_1" },
        data: expect.objectContaining({ status: "ADDED" }),
      }),
    );

    // Audit trail: cycle.gift_added with the first-order marker + COGS.
    expect(loggedEventTypes()).toContain("cycle.gift_added");
    const event = loggedEvent("cycle.gift_added");
    expect(event?.payload).toMatchObject({
      grantId: "grant_1",
      planConfigId: "plan_1",
      firstOrderGift: true,
      cycleIndex: FIRST_ORDER_GIFT_CYCLE_INDEX,
      originOrderId: ORIGIN_ORDER,
      variantId: GIFT_VARIANT,
      title: "Cellexia Travel Mask",
      unitCostCents: 300,
    });
  });

  it("is idempotent: an existing grant for the variant skips everything", async () => {
    mocks.grantFindFirst.mockResolvedValue({ id: "grant_existing" });

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result).toEqual({ status: "skipped", reason: "already_granted" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
    expect(mocks.addFreeGiftToOrder).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("skips when no active plan with a gift covers the contract's products", async () => {
    mocks.planFindMany.mockResolvedValue([
      planFixture({ productIds: [PRODUCT_B] }),
    ]);

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result).toEqual({ status: "skipped", reason: "no_matching_plan" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
    expect(mocks.addFreeGiftToOrder).not.toHaveBeenCalled();
  });

  it("never retro-gifts catch-up mirrors of older contracts", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ordersCount: 3 }),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result).toEqual({ status: "skipped", reason: "not_first_order" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("skips non-active contracts", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ status: "CANCELLED" }),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result).toEqual({ status: "skipped", reason: "contract_not_active" });
    expect(mocks.grantCreate).not.toHaveBeenCalled();
  });

  it("gift lines never count as qualifying products", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({
        lines: [
          {
            productId: PRODUCT_A,
            variantId: "gid://shopify/ProductVariant/12",
            isGift: true,
          },
        ],
      }),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result).toEqual({ status: "skipped", reason: "no_lines" });
  });

  it("defers to cycle 1 when the origin order is unknown", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ originOrderId: null }),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result.status).toBe("deferred");
    if (result.status !== "deferred") throw new Error("unreachable");
    expect(result.cycleIndex).toBe(FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX);
    expect(result.reason).toBe("origin_order_unknown");
    expect(mocks.addFreeGiftToOrder).not.toHaveBeenCalled();
    // Grant stays SCHEDULED, re-pointed at the first renewal so the gift
    // engine attaches it pre-charge.
    expect(mocks.grantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant_1" },
        data: { cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX },
      }),
    );
    expect(loggedEventTypes()).toContain("lifecycle.gift_scheduled");
    expect(loggedEventTypes()).not.toContain("cycle.gift_added");
  });

  it("defers to cycle 1 when the order edit fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.addFreeGiftToOrder.mockRejectedValue(
      new Error("Shopify userErrors at orderEditBegin: order is archived"),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result.status).toBe("deferred");
    if (result.status !== "deferred") throw new Error("unreachable");
    expect(result.reason).toBe("origin_order_edit_failed");
    expect(result.cycleIndex).toBe(FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX);
    expect(mocks.grantUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "grant_1" },
        data: { cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX },
      }),
    );
    const scheduled = loggedEvent("lifecycle.gift_scheduled");
    expect(scheduled?.payload).toMatchObject({
      grantId: "grant_1",
      trigger: "FIRST_ORDER_GIFT",
      firstOrderGift: true,
      cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX,
      reason: "origin_order_edit_failed",
    });
    expect(loggedEventTypes()).not.toContain("cycle.gift_added");
    // An archived/uneditable order is expected operations, not
    // misconfiguration — no operator alert.
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
  });

  it("ACCESS_DENIED raises a CRITICAL operator alert (scope misconfiguration) and still defers", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // What Shopify returns when write_order_edits is missing: every gift
    // would silently defer forever with only a console line — the alert is
    // the merchant-visible trace.
    mocks.addFreeGiftToOrder.mockRejectedValue(
      new Error(
        "Shopify GraphQL error: Access denied for orderEditBegin field. " +
          "Required access: `write_order_edits` access scope.",
      ),
    );

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    // The promise is still kept via cycle 1…
    expect(result.status).toBe("deferred");
    if (result.status !== "deferred") throw new Error("unreachable");
    expect(result.reason).toBe("origin_order_edit_failed");

    // …and the misconfiguration is surfaced as a deduped CRITICAL alert.
    expect(mocks.raiseAlert).toHaveBeenCalledTimes(1);
    const alert = mocks.raiseAlert.mock.calls[0][0] as Record<string, unknown>;
    expect(alert).toMatchObject({
      shopId: "shop_1",
      type: "FIRST_ORDER_GIFT_ACCESS_DENIED",
      severity: "CRITICAL",
    });
    expect(String(alert.message)).toContain("write_order_edits");
    expect(alert.context).toMatchObject({
      contractId: "cm_contract_1",
      originOrderId: ORIGIN_ORDER,
    });
  });

  it("a broken alert channel never breaks the deferral fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.addFreeGiftToOrder.mockRejectedValue(new Error("ACCESS_DENIED"));
    mocks.raiseAlert.mockRejectedValue(new Error("alerts table unavailable"));

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result.status).toBe("deferred");
    expect(loggedEventTypes()).toContain("lifecycle.gift_scheduled");
  });

  it("a variant metadata failure never blocks the gift", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getVariants.mockRejectedValue(new Error("throttled"));

    const result = await ensureFirstOrderGift(SHOP_DOMAIN, "cm_contract_1");

    expect(result.status).toBe("added");
    const event = loggedEvent("cycle.gift_added");
    expect(event?.payload).toMatchObject({
      title: "Welcome gift",
      unitCostCents: null,
    });
  });
});
