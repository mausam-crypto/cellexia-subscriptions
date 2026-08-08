import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN GROUP DRIFT — "SYNCED" must never quietly outlive the storefront.
 *
 * Another subscription app's product sync can detach our selling plan group
 * from products it also manages (observed live with Joy on the merchant's
 * store): the config row still says SYNCED, the Plans page shows a green
 * badge, and the product page renders no Cellexia widget at all. The
 * PLAN_GROUP_DRIFT check re-verifies every SYNCED config against the Admin
 * API (admin GIDs — one id space, reliable) and raises a deduped WARNING
 * naming the detached products, gated to one Admin API sweep per 24h on the
 * `system.plan_group_drift_check` event trail.
 *
 * Drives the REAL runAlertScan over a mocked db, like
 * tests/origin-backfill-alert.test.ts.
 */

const NOW = new Date("2026-08-07T09:00:00.000Z");
const GROUP_A = "gid://shopify/SellingPlanGroup/111";
const GROUP_B = "gid://shopify/SellingPlanGroup/222";
const PRODUCT_1 = "gid://shopify/Product/1001";
const PRODUCT_2 = "gid://shopify/Product/1002";

const mocks = vi.hoisted(() => ({
  sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
  alertCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "alert_1",
      ...args.data,
    }),
  ),
  alertFindFirst: vi.fn(async (): Promise<unknown> => null),
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ tag: "admin" })),
  findProductsMissingFromGroup: vi.fn(
    async (
      _admin: unknown,
      _groupId: string,
      _productIds: string[],
    ): Promise<string[]> => [],
  ),
  getProducts: vi.fn(
    async (_admin: unknown, ids: string[]): Promise<unknown[]> =>
      ids.map((id) => ({ id, title: `Title of ${id.split("/").pop()}` })),
  ),
}));

vi.mock("~/db.server", () => {
  // Every check other than the one under test gets silent all-clear answers
  // from the auto-stub, so the scan runs end to end and the assertions stay
  // about the drift check.
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
  const explicit: Record<string, unknown> = {
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      findMany: async () => [],
    },
    alert: { create: mocks.alertCreate, findFirst: mocks.alertFindFirst },
  };
  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        if (model === "$queryRaw") return async () => [];
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );
  return { default: db };
});

vi.mock("~/lib/analytics/queries.server", () => ({
  COUNTABLE_CONTRACT: {},
  requireShopById: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({
    stuckContractHours: 24,
    failureSpikeThresholdPct: 100,
    churnSpikeThresholdPct: 100,
    emailTo: [],
  })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  findProductsMissingFromGroup: mocks.findProductsMissingFromGroup,
}));

vi.mock("~/lib/graphql/products.server", () => ({
  getProducts: mocks.getProducts,
}));

import {
  PLAN_DRIFT_CHECK_EVENT_TYPE,
  runAlertScan,
} from "~/lib/analytics/alerts.server";

function syncedConfig(
  id: string,
  groupId: string,
  productIds: string[],
): Record<string, unknown> {
  return { id, name: `Plan ${id}`, shopifyGroupId: groupId, productIds };
}

function raisedDriftAlert(): Record<string, unknown> | undefined {
  return mocks.alertCreate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => d.type === "PLAN_GROUP_DRIFT");
}

function driftSweepEvents(): Record<string, unknown>[] {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === PLAN_DRIFT_CHECK_EVENT_TYPE);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alertFindFirst.mockResolvedValue(null);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.findProductsMissingFromGroup.mockResolvedValue([]);
  mocks.getProducts.mockImplementation(async (_admin: unknown, ids: string[]) =>
    ids.map((id) => ({ id, title: `Title of ${id.split("/").pop()}` })),
  );
});

describe("PLAN_GROUP_DRIFT", () => {
  it("a SYNCED config whose group was detached from a product raises the WARNING naming it", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1, PRODUCT_2]),
    ]);
    mocks.findProductsMissingFromGroup.mockResolvedValue([PRODUCT_2]);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedDriftAlert();
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(String(raised?.message)).toContain(
      "Your Cellexia plan was detached from Title of 1002",
    );
    expect(String(raised?.message)).toContain(
      "another subscription app's sync may be reconciling products it manages",
    );
    expect(String(raised?.message)).toContain("Re-sync on the Plans page");
    expect(raised?.context).toMatchObject({
      drifted: [
        {
          configId: "cfg_1",
          groupId: GROUP_A,
          missingProductIds: [PRODUCT_2],
        },
      ],
    });

    // Verified in ADMIN id space: the config's group GID and product GIDs.
    expect(mocks.findProductsMissingFromGroup).toHaveBeenCalledWith(
      expect.anything(),
      GROUP_A,
      [PRODUCT_1, PRODUCT_2],
    );
    // Only SYNCED configs with a group are ever verified.
    const where = (
      mocks.sellingPlanConfigFindMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where).toMatchObject({ shopId: "shop_1", syncStatus: "SYNCED" });
  });

  it("timestamps the sweep even when everything is attached (and raises nothing)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(raisedDriftAlert()).toBeUndefined();
    expect(driftSweepEvents()).toHaveLength(1);
    expect(driftSweepEvents()[0].payload).toMatchObject({
      configsChecked: 1,
      driftedConfigs: 0,
      checkErrors: 0,
    });
  });

  it("gates to one Admin API sweep per day: a recent sweep event skips the check", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.subscriberEventFindFirst.mockImplementation(async (args?: unknown) => {
      const where =
        (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
      return where.type === PLAN_DRIFT_CHECK_EVENT_TYPE ? { id: "evt_1" } : null;
    });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.skipped).toContain("PLAN_GROUP_DRIFT");
    expect(mocks.adminClientForShop).not.toHaveBeenCalled();
    expect(mocks.findProductsMissingFromGroup).not.toHaveBeenCalled();
    expect(raisedDriftAlert()).toBeUndefined();
    expect(driftSweepEvents()).toHaveLength(0);
  });

  it("no SYNCED configs → all clear with zero Shopify traffic and no sweep event", async () => {
    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(result.skipped).not.toContain("PLAN_GROUP_DRIFT");
    expect(mocks.adminClientForShop).not.toHaveBeenCalled();
    expect(raisedDriftAlert()).toBeUndefined();
    expect(driftSweepEvents()).toHaveLength(0);
  });

  it("one config's failed verification never blocks the others (per-config containment)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
      syncedConfig("cfg_2", GROUP_B, [PRODUCT_2]),
    ]);
    mocks.findProductsMissingFromGroup.mockImplementation(
      async (_admin: unknown, groupId: string) => {
        if (groupId === GROUP_A) throw new Error("Throttled");
        return [PRODUCT_2];
      },
    );

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedDriftAlert();
    expect(raised).toBeDefined();
    expect(String(raised?.message)).toContain("Title of 1002");
    expect(raised?.context).toMatchObject({ checkErrors: 1 });
    expect(driftSweepEvents()[0].payload).toMatchObject({
      configsChecked: 2,
      driftedConfigs: 1,
      checkErrors: 1,
    });
  });

  it("a title lookup failure falls back to the product GIDs — drift is never hidden", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.findProductsMissingFromGroup.mockResolvedValue([PRODUCT_1]);
    mocks.getProducts.mockRejectedValue(new Error("read failed"));

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(String(raisedDriftAlert()?.message)).toContain(PRODUCT_1);
  });

  it("dedupes on an open alert of the same type like every other check", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.findProductsMissingFromGroup.mockResolvedValue([PRODUCT_1]);
    mocks.alertFindFirst.mockResolvedValue({ id: "alert_open" });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(mocks.alertCreate).not.toHaveBeenCalled();
  });
});
