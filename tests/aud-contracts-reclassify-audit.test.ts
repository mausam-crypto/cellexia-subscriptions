import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ownership reclassification audit trail (data-collection audit, EVT-4).
 *
 * reclassifyOne flips contract.ownership — the gate deciding
 * COUNTABLE_CONTRACT membership, i.e. the population of every metric — and
 * used to do it silently, unlike every other ownership writer (the sync's
 * synced_from_shopify payload, claimContracts' claim event). A reclassify
 * run could retroactively shift MRR/churn/funnel with nothing in the event
 * stream to explain the step. These tests pin the audit event.
 */

const store = vi.hoisted(() => ({
  contracts: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  contractUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
    },
    subscriptionContract: {
      findMany: vi.fn(async (): Promise<unknown[]> => store.contracts),
      update: mocks.contractUpdate,
      groupBy: vi.fn(async (): Promise<unknown[]> => []),
    },
    sellingPlanConfig: {
      findMany: vi.fn(async (): Promise<unknown[]> => [
        {
          shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
          shopifyPlanIds: ["gid://shopify/SellingPlan/111"],
        },
      ]),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async (): Promise<unknown> => ({})),
  getShopMetafield: vi.fn(),
}));

import { reclassifyContracts } from "~/lib/ownership/ownership.server";

const OUR_PLAN = "gid://shopify/SellingPlan/111";
const JOY_PLAN = "gid://shopify/SellingPlan/999";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    ownership: "UNKNOWN",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    lines: [{ sellingPlanId: OUR_PLAN }],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contracts = [];
});

describe("reclassifyContracts audit events", () => {
  it("logs contract.updated / ownership_reclassified when the verdict changes", async () => {
    store.contracts = [row()];

    const result = await reclassifyContracts("cellexia.myshopify.com", {
      fetchMissing: false,
    });

    expect(result.changed).toBe(1);
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "c_1" },
      data: { ownership: "OURS" },
    });
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent.mock.calls[0][0]).toMatchObject({
      type: "contract.updated",
      source: "SYSTEM",
      contractId: "c_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      payload: {
        action: "ownership_reclassified",
        ownership: "OURS",
        previousOwnership: "UNKNOWN",
      },
    });
  });

  it("logs the FOREIGN flip too — leaving the population is as auditable as entering it", async () => {
    store.contracts = [row({ lines: [{ sellingPlanId: JOY_PLAN }] })];

    await reclassifyContracts("cellexia.myshopify.com", { fetchMissing: false });

    expect(mocks.logEvent.mock.calls[0][0]).toMatchObject({
      payload: {
        action: "ownership_reclassified",
        ownership: "FOREIGN",
        previousOwnership: "UNKNOWN",
      },
    });
  });

  it("an unchanged verdict writes nothing and logs nothing", async () => {
    store.contracts = [row({ ownership: "OURS" })];

    const result = await reclassifyContracts("cellexia.myshopify.com", {
      fetchMissing: false,
    });

    expect(result.changed).toBe(0);
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
