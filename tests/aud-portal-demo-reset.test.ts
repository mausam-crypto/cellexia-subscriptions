import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EVT-9 — the demo-reset deletion invariant.
 *
 * Demo contracts are the ONLY contracts ever deleted, and
 * SubscriberEvent.contractId is `onDelete: SetNull`: deleting the contract
 * alone silently flips its demo events to contractId NULL — provenance lost
 * forever, and every contract-less surface (the audit page/CSV, any future
 * contract-less counter) has no way to filter them. ARCHITECTURE.md's demo
 * passage documents the invariant; these tests pin the implementation: a
 * reset deletes the demo contracts' EVENTS first, then the contracts.
 */

const mocks = vi.hoisted(() => ({
  eventDeleteMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
  contractDeleteMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  contractCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "c_demo_new",
    customerId: "gid://cellexia/demo/customer/x",
    email: "preview@cellexia-demo.invalid",
    ...args.data,
  })),
  shopFindUnique: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    currencyCode: "CHF",
    ianaTimezone: "Europe/Zurich",
  })),
  logEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    subscriptionContract: {
      deleteMany: mocks.contractDeleteMany,
      create: mocks.contractCreate,
      findFirst: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    subscriberEvent: { deleteMany: mocks.eventDeleteMany },
    sellingPlanConfig: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftRule: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: { create: vi.fn(async (): Promise<unknown> => ({})) },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
}));

import { resetDemoContract } from "~/lib/portal/demo.server";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resetDemoContract", () => {
  it("deletes the demo contracts' events BEFORE the contracts (SetNull would orphan them)", async () => {
    const { contractId } = await resetDemoContract("shop_1");
    expect(contractId).toBe("c_demo_new");

    expect(mocks.eventDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.contractDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.eventDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.contractDeleteMany.mock.invocationCallOrder[0],
    );
  });

  it("scopes both deletes to THIS shop's demo rows only", async () => {
    await resetDemoContract("shop_1");

    expect(mocks.eventDeleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1", contract: { is: { isDemo: true } } },
    });
    expect(mocks.contractDeleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1", isDemo: true },
    });
  });
});
