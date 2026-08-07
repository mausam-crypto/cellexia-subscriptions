import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Atomic add claims (migration 0009) — addOneTimeAddon / addLine.
 *
 * The defect: the portal is server-rendered HTML with no client-side button
 * disabling, and addOneTimeAddon's duplicate guard was find-then-act with a
 * window spanning the entire multi-second Shopify billing-cycle edit. A
 * double-tap on "Add one-time" staged the add-on twice and the customer was
 * charged for it twice on the next cycle (addLine had the identical shape
 * for recurring lines).
 *
 * The fix inverts the order: the mirror ContractLine is created FIRST under
 * the unique addClaimKey, and only then does the Shopify edit run — deleted
 * again if the edit fails. These tests pin the ordering, the key shapes, the
 * P2002 no-op and the failure cleanup against the REAL service functions.
 */

const calls = vi.hoisted(() => ({ order: [] as string[] }));

const mocks = vi.hoisted(() => ({
  lineCreate: vi.fn(async (args: { data: Record<string, unknown> }) => {
    calls.order.push("line.create");
    return { id: "line_new", ...args.data };
  }),
  lineUpdate: vi.fn(async (args: unknown) => {
    calls.order.push("line.update");
    return args;
  }),
  lineDelete: vi.fn(async (args: unknown) => {
    calls.order.push("line.delete");
    return args;
  }),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getVariants: vi.fn(async (): Promise<unknown[]> => [
    {
      id: "gid://shopify/ProductVariant/77",
      productId: "gid://shopify/Product/7",
      productTitle: "Night Serum",
      title: "50ml",
      sku: "NS-50",
      imageUrl: null,
      priceCents: 6400,
      unitCostCents: 1200,
    },
  ]),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({ cycleIndex: 6 })),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      _cycle: unknown,
      body: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      calls.order.push("shopify.cycleEdit");
      await body("draft_1", {});
    },
  ),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      body: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      calls.order.push("shopify.contractDraft");
      await body("draft_1", {});
    },
  ),
  draftLineAdd: vi.fn(async (): Promise<string> => "gid://shopify/Line/900"),
  ongoingDiscountedPriceCents: vi.fn(async (): Promise<number> => 5760),
  reloadContract: vi.fn(async (id: string) => ({ id, lines: [] })),
}));

vi.mock("~/db.server", () => ({
  default: {
    contractLine: {
      create: mocks.lineCreate,
      update: mocks.lineUpdate,
      delete: mocks.lineDelete,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: mocks.draftLineAdd,
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getVariants: mocks.getVariants,
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: vi.fn(),
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: mocks.withBillingCycleEdit,
    withContractDraft: mocks.withContractDraft,
  };
});

vi.mock("~/lib/contracts/shared.server", () => ({
  loadContractContext: vi.fn(async () => ({
    shop: { id: "shop_1", domain: "cellexia.myshopify.com" },
    contract: {
      id: "cm_c1",
      shopId: "shop_1",
      shopifyContractId: "gid://shopify/SubscriptionContract/1",
      customerId: "gid://shopify/Customer/5",
      email: "sub@example.com",
      status: "ACTIVE",
      nextBillingDate: new Date("2026-09-01T09:00:00Z"),
      lines: [],
    },
    admin: {},
  })),
  ongoingDiscountedPriceCents: mocks.ongoingDiscountedPriceCents,
  reloadContract: mocks.reloadContract,
  resolveActor: vi.fn(() => "customer"),
  resolveSource: vi.fn(() => "CUSTOMER_PORTAL"),
  eventIdentity: vi.fn(() => ({
    shopId: "shop_1",
    contractId: "cm_c1",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
  })),
  fetchNextBillingDate: vi.fn(),
  withMirrorGuard: vi.fn(
    async (
      _fn: string,
      _ctx: unknown,
      _options: unknown,
      mutate: () => Promise<unknown>,
    ) => mutate(),
  ),
}));

vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(),
}));

import { addLine, addOneTimeAddon } from "~/lib/contracts/service.server";

const VARIANT = "gid://shopify/ProductVariant/77";

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("unique violation", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: "ContractLine_addClaimKey_key" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
});

describe("addOneTimeAddon claims before it edits", () => {
  it("creates the claim row BEFORE the Shopify cycle edit and stamps the line id after", async () => {
    await addOneTimeAddon("cellexia.myshopify.com", "cm_c1", VARIANT, 1);

    expect(calls.order).toEqual([
      "line.create",
      "shopify.cycleEdit",
      "line.update",
    ]);
    const data = (mocks.lineCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.addClaimKey).toBe(`addon:cm_c1:${VARIANT}`);
    expect(data.isOneTimeAddon).toBe(true);
    // The staged cycle is recorded (migration 0012) so settlement of an
    // EARLIER cycle can never consume this mirror and free its claim key.
    expect(data.addonCycleIndex).toBe(6);
    expect(data.shopifyLineId).toBeNull(); // claimed first, stamped later
    const update = mocks.lineUpdate.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(update.where).toEqual({ id: "line_new" });
    expect(update.data).toEqual({ shopifyLineId: "gid://shopify/Line/900" });
    expect(
      mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).toContain("cycle.addon_added");
  });

  it("the double-tap loser (P2002) no-ops: no second cycle edit, no second event, no charge", async () => {
    mocks.lineCreate.mockRejectedValueOnce(p2002());

    const result = await addOneTimeAddon(
      "cellexia.myshopify.com",
      "cm_c1",
      VARIANT,
      1,
    );

    expect(result).toEqual({ id: "cm_c1", lines: [] }); // graceful reload
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.lineDelete).not.toHaveBeenCalled(); // the winner's row is sacred
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("releases the claim when the Shopify edit fails, so a retry can stage cleanly", async () => {
    mocks.withBillingCycleEdit.mockRejectedValueOnce(
      new Error("cycle edit rejected"),
    );

    await expect(
      addOneTimeAddon("cellexia.myshopify.com", "cm_c1", VARIANT, 1),
    ).rejects.toThrow("cycle edit rejected");

    expect(mocks.lineDelete).toHaveBeenCalledWith({
      where: { id: "line_new" },
    });
    expect(
      mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).not.toContain("cycle.addon_added");
  });

  it("any non-P2002 create failure still surfaces", async () => {
    mocks.lineCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      addOneTimeAddon("cellexia.myshopify.com", "cm_c1", VARIANT, 1),
    ).rejects.toThrow("db down");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });
});

describe("addLine claims before it drafts", () => {
  it("creates the recurring claim BEFORE the contract draft, keyed line:{contract}:{variant}", async () => {
    await addLine("cellexia.myshopify.com", "cm_c1", VARIANT, 1);

    expect(calls.order).toEqual([
      "line.create",
      "shopify.contractDraft",
      "line.update",
    ]);
    const data = (mocks.lineCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.addClaimKey).toBe(`line:cm_c1:${VARIANT}`);
    expect(data.isOneTimeAddon).toBe(false);
  });

  it("the concurrent duplicate no-ops on P2002 instead of adding the variant twice", async () => {
    mocks.lineCreate.mockRejectedValueOnce(p2002());
    const result = await addLine("cellexia.myshopify.com", "cm_c1", VARIANT, 1);
    expect(result).toEqual({ id: "cm_c1", lines: [] });
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("releases the claim when the draft fails", async () => {
    mocks.withContractDraft.mockRejectedValueOnce(new Error("draft rejected"));
    await expect(
      addLine("cellexia.myshopify.com", "cm_c1", VARIANT, 1),
    ).rejects.toThrow("draft rejected");
    expect(mocks.lineDelete).toHaveBeenCalledWith({ where: { id: "line_new" } });
  });

  it("gift lines never claim — a gift must not block (or be blocked by) the paid line", async () => {
    await addLine("cellexia.myshopify.com", "cm_c1", VARIANT, 1, {
      isGift: true,
      addedVia: "GIFT_ENGINE",
    });
    const data = (mocks.lineCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.isGift).toBe(true);
    expect(data).not.toHaveProperty("addClaimKey");
  });
});
