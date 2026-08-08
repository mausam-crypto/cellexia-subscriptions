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
const OUR_APP_ID = "4477001";
const PLAN_A = "gid://shopify/SellingPlan/901";
const PLAN_B = "gid://shopify/SellingPlan/902";

/** A fully healthy v1.6.9 allow-list matching the GROUP_A/GROUP_B fixtures. */
const HEALTHY_ALLOW_LIST = {
  id: "gid://shopify/Metafield/1",
  namespace: "cellexia",
  key: "plan_groups",
  type: "json",
  value: JSON.stringify({
    v: 2,
    groupIds: ["111", "222"],
    planIds: ["901", "902"],
    planSets: [["901"], ["902"]],
    appId: OUR_APP_ID,
  }),
};

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
  getShopMetafield: vi.fn(async (): Promise<unknown> => null),
  getCurrentAppId: vi.fn(async (): Promise<string> => "4477001"),
  getSellingPlanGroupOwnershipStates: vi.fn(
    async (): Promise<Map<string, { appId: string | null; planIds: string[] }>> =>
      new Map(),
  ),
  publishOwnGroupsMetafield: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ ok: true }),
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
  getCurrentAppId: mocks.getCurrentAppId,
  getSellingPlanGroupOwnershipStates: mocks.getSellingPlanGroupOwnershipStates,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  getShopMetafield: mocks.getShopMetafield,
  setShopMetafield: vi.fn(),
}));

// The scan's static ownership imports (OURS_ONLY, numericIdFromGid) stay
// REAL; only the publish side effect is stubbed so the self-heal path is
// observable without booting Shopify.
vi.mock("~/lib/ownership/ownership.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    publishOwnGroupsMetafield: mocks.publishOwnGroupsMetafield,
  };
});

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

function raisedOwnershipAlert(): Record<string, unknown> | undefined {
  return mocks.alertCreate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => d.type === "OWNERSHIP_FACTORS");
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
  // Ownership factors healthy by default: stamped groups, live sets matching
  // the published planSets, our appId in the metafield.
  mocks.getShopMetafield.mockResolvedValue({ ...HEALTHY_ALLOW_LIST });
  mocks.getCurrentAppId.mockResolvedValue(OUR_APP_ID);
  mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
    new Map([
      [GROUP_A, { appId: OUR_APP_ID, planIds: [PLAN_A] }],
      [GROUP_B, { appId: OUR_APP_ID, planIds: [PLAN_B] }],
    ]),
  );
  mocks.publishOwnGroupsMetafield.mockResolvedValue({ ok: true });
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

// ── The v1.6.9 ownership factors, on the same daily sweep ────────────────────

describe("OWNERSHIP_FACTORS (the dark-widget class attachment cannot see)", () => {
  /**
   * The upgrade-order trap: extension deployed before Sync, or a hand-edited
   * metafield. Every plan row says SYNCED, every attachment verifies — and
   * the storefront renders nothing because the two-factor gate (published
   * appId + exact plan sets, group-side app_id stamp) is unsatisfied. The
   * sweep verifies the factors against the live state, SELF-HEALS by
   * republishing, and alerts only when the republish did not fix it.
   */
  const healedPublish = {
    ok: true,
    value: {
      v: 2,
      groupIds: ["111"],
      planIds: ["901"],
      planSets: [["901"]],
      appId: OUR_APP_ID,
    },
    heal: { stamped: [GROUP_A], alreadyStamped: [], failed: [] },
  };

  it("a pre-v1.6.9 metafield (no appId, no planSets) triggers the self-heal — and a successful republish raises NO alert", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.getShopMetafield.mockResolvedValue({
      ...HEALTHY_ALLOW_LIST,
      value: JSON.stringify({ v: 1, groupIds: ["111"], planIds: ["901"] }),
    });
    mocks.publishOwnGroupsMetafield.mockResolvedValue(healedPublish);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(mocks.publishOwnGroupsMetafield).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
    );
    expect(raisedOwnershipAlert()).toBeUndefined();
    expect(driftSweepEvents()[0].payload).toMatchObject({
      ownershipFactorsHealed: true,
    });
  });

  it("an UNSTAMPED group whose stamp still fails after the republish raises the alert, naming the problem", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
      new Map([[GROUP_A, { appId: null, planIds: [PLAN_A] }]]),
    );
    mocks.publishOwnGroupsMetafield.mockResolvedValue({
      ...healedPublish,
      heal: { stamped: [], alreadyStamped: [], failed: [GROUP_A] },
    });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedOwnershipAlert();
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(String(raised?.message)).toContain("not stamped");
    expect(String(raised?.message)).toContain("Sync to Shopify");
    expect(String(raised?.message)).toContain("Preview Doctor");
  });

  it("a live plan set no published set covers is caught — the exact-set factor, verified daily", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    // The group grew a plan; the published set is stale.
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
      new Map([[GROUP_A, { appId: OUR_APP_ID, planIds: [PLAN_A, PLAN_B] }]]),
    );
    mocks.publishOwnGroupsMetafield.mockResolvedValue(healedPublish);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    // Self-heal ran (a republish reads the live set and fixes exactly this).
    expect(mocks.publishOwnGroupsMetafield).toHaveBeenCalled();
    expect(raisedOwnershipAlert()).toBeUndefined();
  });

  it("a whitespace-padded appId is NOT trimmed into a false all-clear", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
    ]);
    mocks.getShopMetafield.mockResolvedValue({
      ...HEALTHY_ALLOW_LIST,
      value: JSON.stringify({
        v: 2,
        groupIds: ["111"],
        planIds: ["901"],
        planSets: [["901"]],
        appId: ` ${OUR_APP_ID}`,
      }),
    });
    mocks.publishOwnGroupsMetafield.mockResolvedValue(healedPublish);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    // The padded value is a dark storefront: the sweep must treat it as a
    // problem (and republish over it), never trim it into a match.
    expect(mocks.publishOwnGroupsMetafield).toHaveBeenCalled();
  });

  it("healthy factors touch nothing: no republish, no alert", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      syncedConfig("cfg_1", GROUP_A, [PRODUCT_1]),
      syncedConfig("cfg_2", GROUP_B, [PRODUCT_2]),
    ]);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    expect(mocks.publishOwnGroupsMetafield).not.toHaveBeenCalled();
    expect(raisedOwnershipAlert()).toBeUndefined();
    expect(driftSweepEvents()[0].payload).toMatchObject({
      ownershipFactorProblems: 0,
      ownershipFactorsHealed: false,
    });
  });
});
