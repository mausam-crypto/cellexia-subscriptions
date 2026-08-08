import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Ownership tests — "which subscription app does this belong to?".
 *
 * The store runs a second subscription app (Joy). Its selling plan group is on
 * the same products and its contracts arrive on the same
 * SUBSCRIPTION_CONTRACTS_* webhooks, so every safety property here is about
 * NOT touching them: never billing, never messaging, never rendering their
 * plan. Everything DB-shaped is mocked (launch-mode.test.ts pattern).
 */

const mocks = vi.hoisted(() => ({
  planConfigFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  planConfigFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  planConfigUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  shopFindUnique: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ id: "shop_1" }),
  ),
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  contractGroupBy: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  contractCount: vi.fn(async (_args?: unknown): Promise<number> => 0),
  syncContractFromShopify: vi.fn(
    async (_domain: string, _gid: string, _opts?: unknown): Promise<unknown> => ({}),
  ),
  setShopMetafield: vi.fn(async (_admin: unknown, _input: unknown): Promise<unknown> => ({})),
  adminClientForShop: vi.fn(async (_domain: string): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  getSellingPlanGroupPlanIds: vi.fn(
    async (_admin: unknown, _groupId: string): Promise<string[]> => [],
  ),
  getCurrentAppId: vi.fn(async (_admin: unknown): Promise<string> => OUR_APP_ID),
  getSellingPlanGroupOwnershipStates: vi.fn(
    async (
      _admin: unknown,
      _groupIds: string[],
    ): Promise<Map<string, { appId: string | null; planIds: string[] }>> =>
      new Map(),
  ),
  stampSellingPlanGroupAppIds: vi.fn(
    async (
      _admin: unknown,
      _states: unknown,
      _groupIds: string[],
      _appId: string,
    ): Promise<{ stamped: string[]; alreadyStamped: string[]; failed: string[] }> => ({
      stamped: [],
      alreadyStamped: [],
      failed: [],
    }),
  ),
}));

/** This app's own numeric App id, as the mocked Admin API reports it. */
const OUR_APP_ID = "4477001";

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: {
      findMany: mocks.planConfigFindMany,
      findFirst: mocks.planConfigFindFirst,
      update: mocks.planConfigUpdate,
    },
    shop: { findUnique: mocks.shopFindUnique },
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
      // No updateMany: this module has no bulk contract writer, and the guard
      // in "claimContracts is the only bulk writer of OURS" keeps it that way.
      groupBy: mocks.contractGroupBy,
      count: mocks.contractCount,
    },
  },
}));

vi.mock("~/lib/contracts/sync.server", () => ({
  syncContractFromShopify: mocks.syncContractFromShopify,
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: mocks.setShopMetafield,
  getShopMetafield: vi.fn(),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getSellingPlanGroupPlanIds: mocks.getSellingPlanGroupPlanIds,
  getCurrentAppId: mocks.getCurrentAppId,
  getSellingPlanGroupOwnershipStates: mocks.getSellingPlanGroupOwnershipStates,
  stampSellingPlanGroupAppIds: mocks.stampSellingPlanGroupAppIds,
}));

import {
  OWNERSHIP_FOREIGN,
  OWNERSHIP_OURS,
  OWNERSHIP_UNKNOWN,
  buildPlanGroupsValue,
  claimContracts,
  classifyContractOwnership,
  getOwnGroupIds,
  getOwnPlanIdEvidence,
  getOwnPlanIds,
  isBillableOwnership,
  isOurSellingPlan,
  mergePlanIds,
  numericIdFromGid,
  parsePlanIdsJson,
  publishOwnGroupsMetafield,
  reclassifyAllContracts,
  reclassifyContracts,
  recordSellingPlanSync,
} from "~/lib/ownership/ownership.server";

const OUR_PLAN = "gid://shopify/SellingPlan/111";
const OUR_PLAN_2 = "gid://shopify/SellingPlan/112";
const JOY_PLAN = "gid://shopify/SellingPlan/999";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.planConfigFindMany.mockResolvedValue([]);
  mocks.planConfigFindFirst.mockResolvedValue(null);
  mocks.shopFindUnique.mockResolvedValue({ id: "shop_1" });
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.contractGroupBy.mockResolvedValue([]);
  mocks.contractCount.mockResolvedValue(0);
  mocks.syncContractFromShopify.mockResolvedValue({});
  mocks.getSellingPlanGroupPlanIds.mockResolvedValue([]);
  mocks.getCurrentAppId.mockResolvedValue(OUR_APP_ID);
  // Steady state: the one synced group is stamped and its live plans are
  // the recorded ones (numeric forms of OUR_PLAN / OUR_PLAN_2).
  mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
    new Map([
      [
        "gid://shopify/SellingPlanGroup/77",
        { appId: OUR_APP_ID, planIds: [OUR_PLAN, OUR_PLAN_2] },
      ],
    ]),
  );
  mocks.stampSellingPlanGroupAppIds.mockResolvedValue({
    stamped: [],
    alreadyStamped: ["gid://shopify/SellingPlanGroup/77"],
    failed: [],
  });
});

describe("numericIdFromGid", () => {
  it("extracts the numeric id Liquid exposes", () => {
    expect(numericIdFromGid("gid://shopify/SellingPlanGroup/42")).toBe("42");
    expect(numericIdFromGid("gid://shopify/SellingPlan/9007199254740993")).toBe(
      "9007199254740993",
    );
  });

  it("passes a bare numeric id through and rejects everything else", () => {
    expect(numericIdFromGid("42")).toBe("42");
    expect(numericIdFromGid("gid://cellexia/demo/contract/abc")).toBeNull();
    expect(numericIdFromGid("")).toBeNull();
    expect(numericIdFromGid(null)).toBeNull();
    expect(numericIdFromGid(undefined)).toBeNull();
  });
});

describe("parsePlanIdsJson / mergePlanIds", () => {
  it("survives malformed Json columns", () => {
    expect(parsePlanIdsJson(null)).toEqual([]);
    expect(parsePlanIdsJson("not-an-array")).toEqual([]);
    expect(parsePlanIdsJson([1, null, "  ", OUR_PLAN, OUR_PLAN])).toEqual([OUR_PLAN]);
  });

  it("is append-only: a plan deleted on Shopify stays known", () => {
    // Dropping a frequency deletes that selling plan, but live contracts keep
    // referencing it. Forgetting it would make our own subscribers look
    // foreign on the next re-sync — and silently stop their billing.
    const merged = mergePlanIds([OUR_PLAN, OUR_PLAN_2], [OUR_PLAN_2]);
    expect(merged).toEqual([OUR_PLAN, OUR_PLAN_2]);
  });

  it("caps growth without dropping the newest ids", () => {
    const many = Array.from({ length: 600 }, (_, i) => `gid://shopify/SellingPlan/${i}`);
    const merged = mergePlanIds([], many);
    expect(merged).toHaveLength(500);
    expect(merged.at(-1)).toBe("gid://shopify/SellingPlan/599");
  });
});

describe("classifyContractOwnership", () => {
  const ownPlanIds = new Set([OUR_PLAN, "111", OUR_PLAN_2, "112"]);

  it("claims a contract when any line rides one of our plans", () => {
    expect(
      classifyContractOwnership({ linePlanIds: [JOY_PLAN, OUR_PLAN], ownPlanIds }),
    ).toBe(OWNERSHIP_OURS);
  });

  it("matches the numeric id form too", () => {
    expect(classifyContractOwnership({ linePlanIds: ["112"], ownPlanIds })).toBe(
      OWNERSHIP_OURS,
    );
  });

  it("marks another app's contract FOREIGN on positive evidence", () => {
    expect(classifyContractOwnership({ linePlanIds: [JOY_PLAN], ownPlanIds })).toBe(
      OWNERSHIP_FOREIGN,
    );
  });

  it("is UNKNOWN (not billable) when no line carries a selling plan", () => {
    expect(classifyContractOwnership({ linePlanIds: [], ownPlanIds })).toBe(
      OWNERSHIP_UNKNOWN,
    );
    expect(
      classifyContractOwnership({ linePlanIds: [null, undefined, "  "], ownPlanIds }),
    ).toBe(OWNERSHIP_UNKNOWN);
  });

  it("never downgrades an explicit OURS when evidence is missing", () => {
    // Import-created contracts carry no selling plan; the import stamps OURS.
    // A later re-sync must not turn that into an unbillable UNKNOWN.
    expect(
      classifyContractOwnership({
        linePlanIds: [],
        ownPlanIds,
        existingOwnership: OWNERSHIP_OURS,
      }),
    ).toBe(OWNERSHIP_OURS);
  });

  it("never guesses when our own plan ids could not be loaded", () => {
    expect(
      classifyContractOwnership({
        linePlanIds: [JOY_PLAN],
        ownPlanIds: new Set(),
        ownPlanIdsKnown: false,
      }),
    ).toBe(OWNERSHIP_UNKNOWN);
    expect(
      classifyContractOwnership({
        linePlanIds: [JOY_PLAN],
        ownPlanIds: new Set(),
        ownPlanIdsKnown: false,
        existingOwnership: OWNERSHIP_OURS,
      }),
    ).toBe(OWNERSHIP_OURS);
  });

  it("does move OURS to FOREIGN on positive evidence", () => {
    expect(
      classifyContractOwnership({
        linePlanIds: [JOY_PLAN],
        ownPlanIds,
        existingOwnership: OWNERSHIP_OURS,
      }),
    ).toBe(OWNERSHIP_FOREIGN);
  });

  it("only OURS is billable", () => {
    expect(isBillableOwnership(OWNERSHIP_OURS)).toBe(true);
    expect(isBillableOwnership(OWNERSHIP_FOREIGN)).toBe(false);
    expect(isBillableOwnership(OWNERSHIP_UNKNOWN)).toBe(false);
    expect(isBillableOwnership(null)).toBe(false);
    expect(isBillableOwnership("ours")).toBe(false);
  });
});

describe("own group / plan reads", () => {
  it("returns both id forms for synced groups", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "gid://shopify/SellingPlanGroup/77" },
    ]);
    await expect(getOwnGroupIds("shop_1")).resolves.toEqual({
      gids: ["gid://shopify/SellingPlanGroup/77"],
      numericIds: ["77"],
    });
  });

  it("exposes plan ids as GID and numeric", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2] },
    ]);
    const ids = await getOwnPlanIds("shop_1");
    expect([...ids].sort()).toEqual([OUR_PLAN, OUR_PLAN_2, "111", "112"].sort());
  });

  it("isOurSellingPlan accepts either form and rejects the other app's", async () => {
    mocks.planConfigFindMany.mockResolvedValue([{ shopifyPlanIds: [OUR_PLAN] }]);
    await expect(isOurSellingPlan("shop_1", OUR_PLAN)).resolves.toBe(true);
    await expect(isOurSellingPlan("shop_1", "111")).resolves.toBe(true);
    await expect(isOurSellingPlan("shop_1", JOY_PLAN)).resolves.toBe(false);
    await expect(isOurSellingPlan("shop_1", null)).resolves.toBe(false);
  });

  it("reports evidence as incomplete when a synced group has no recorded plans", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
    ]);
    const evidence = await getOwnPlanIdEvidence("shop_1");
    expect(evidence.known).toBe(false);
    expect(evidence.planIds.size).toBe(0);
  });

  it("reports complete evidence when nothing is synced at all", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: null, shopifyPlanIds: null },
    ]);
    await expect(getOwnPlanIdEvidence("shop_1")).resolves.toMatchObject({
      known: true,
    });
  });
});

describe("plan_groups metafield", () => {
  it("publishes numeric ids under cellexia/plan_groups as json", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2],
      },
    ]);

    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(mocks.setShopMetafield).toHaveBeenCalledTimes(1);
    const input = mocks.setShopMetafield.mock.calls[0][1] as {
      namespace: string;
      key: string;
      type: string;
      value: string;
    };
    expect(input).toMatchObject({
      namespace: "cellexia",
      key: "plan_groups",
      type: "json",
    });
    expect(JSON.parse(input.value)).toEqual({
      v: 2,
      groupIds: ["77"],
      planIds: ["111", "112"],
      planSets: [["111", "112"]],
      appId: OUR_APP_ID,
    });
  });

  it("publishes this app's own appId — one of the storefront's two ownership factors", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN],
      },
    ]);
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(result.value?.appId).toBe(OUR_APP_ID);
    expect(mocks.getCurrentAppId).toHaveBeenCalledTimes(1);
  });

  it("publishes the LIVE plan set per group, never the append-only DB evidence", async () => {
    // The DB column keeps dead plan ids on purpose (billing safety). The
    // exact-set factor must come from the live read, or a shop that ever
    // dropped a frequency would publish a set the group can never equal —
    // a permanent dark widget in the steady state.
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        // DB remembers a dead plan (999) alongside the live ones.
        shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2, "gid://shopify/SellingPlan/999"],
      },
    ]);
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(
      new Map([
        [
          "gid://shopify/SellingPlanGroup/77",
          { appId: OUR_APP_ID, planIds: [OUR_PLAN, OUR_PLAN_2] },
        ],
      ]),
    );
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    // Union field keeps the dead id (legacy consumers), the SET does not.
    expect(result.value?.planIds).toEqual(["111", "112", "999"]);
    expect(result.value?.planSets).toEqual([["111", "112"]]);
  });

  it("heals unstamped groups BEFORE writing the metafield, from the same live read", async () => {
    // Reachable from flows that never run the full group sync (go-live,
    // config delete): publishing an appId the groups don't carry would
    // darken the widget, so the publish path itself stamps them.
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN],
      },
    ]);
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(mocks.stampSellingPlanGroupAppIds).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Map),
      ["gid://shopify/SellingPlanGroup/77"],
      OUR_APP_ID,
    );
    // Heal first, then publish — never an appId-bearing metafield ahead of
    // an unstamped group when both calls succeed.
    const healOrder =
      mocks.stampSellingPlanGroupAppIds.mock.invocationCallOrder[0];
    const writeOrder = mocks.setShopMetafield.mock.invocationCallOrder[0];
    expect(healOrder).toBeLessThan(writeOrder);
    // …and the outcome is on the result, never swallowed.
    expect(result.heal).toEqual({
      stamped: [],
      alreadyStamped: ["gid://shopify/SellingPlanGroup/77"],
      failed: [],
    });
  });

  it("a failed stamp is contained but VISIBLE: published, with the group named in heal.failed", async () => {
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN],
      },
    ]);
    mocks.stampSellingPlanGroupAppIds.mockResolvedValueOnce({
      stamped: [],
      alreadyStamped: [],
      failed: ["gid://shopify/SellingPlanGroup/77"],
    });
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(mocks.setShopMetafield).toHaveBeenCalledTimes(1);
    expect(result.heal?.failed).toEqual(["gid://shopify/SellingPlanGroup/77"]);
  });

  it("a failed live-state read fails the whole publish — stale-but-valid beats fresh-but-dark", async () => {
    // Without the live read there is no truthful plan set to publish; a
    // fresh metafield missing planSets would darken the widget exactly the
    // same while looking like a successful publish. The previous allow-list
    // stays in place instead.
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN],
      },
    ]);
    mocks.getSellingPlanGroupOwnershipStates.mockRejectedValueOnce(
      new Error("throttled"),
    );
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result).toMatchObject({ ok: false, error: "throttled" });
    expect(mocks.setShopMetafield).not.toHaveBeenCalled();
  });

  it("a failed appId read fails the publish and leaves the previous allow-list alone", async () => {
    // Fail closed by staleness: without the appId there is no valid value to
    // write — a value missing the field would darken the widget exactly the
    // same, while silently looking like a successful publish.
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN],
      },
    ]);
    mocks.getCurrentAppId.mockRejectedValueOnce(new Error("no app id"));
    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result).toMatchObject({ ok: false, error: "no app id" });
    expect(mocks.setShopMetafield).not.toHaveBeenCalled();
  });

  it("never throws — a failed write leaves the previous allow-list in place", async () => {
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("throttled"));
    await expect(
      publishOwnGroupsMetafield("cellexia.myshopify.com"),
    ).resolves.toMatchObject({ ok: false, error: "throttled" });
  });

  it("repairs missing plan ids BEFORE publishing, so planIds is never needlessly empty", async () => {
    // The snippet decides ownership on planIds (Liquid's group ids live in a
    // different id space than the admin ids groupIds carries, so plan-id
    // intersection is the one comparison that can match), and an allow-list
    // with no plan ids renders nothing at all. A shop upgrading from a build
    // that never recorded shopifyPlanIds would otherwise have go-live freeze
    // an empty planIds into the metafield and go dark storefront-wide.
    mocks.planConfigFindMany.mockResolvedValue([
      { id: "cfg_1", shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
    ]);
    mocks.getSellingPlanGroupPlanIds.mockResolvedValue([OUR_PLAN, OUR_PLAN_2]);

    await publishOwnGroupsMetafield("cellexia.myshopify.com");

    expect(mocks.getSellingPlanGroupPlanIds).toHaveBeenCalled();
    expect(mocks.planConfigUpdate).toHaveBeenCalledWith({
      where: { id: "cfg_1" },
      data: { shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2] },
    });
  });

  it("publishes group ids anyway when the repair cannot read the group", async () => {
    // The snippet requires BOTH factors, so this value renders nothing until a
    // later sync records the plan ids — the buy box is off every product in
    // the meantime, and that is the intended direction. Publishing it anyway
    // is still right: empty planIds means we never recorded any, so there is
    // no earlier working allow-list being overwritten, and the group ids that
    // ARE known get into place for the moment the plan ids land.
    mocks.planConfigFindMany.mockResolvedValue([
      { id: "cfg_1", shopifyGroupId: "gid://shopify/SellingPlanGroup/77", shopifyPlanIds: null },
    ]);
    mocks.getSellingPlanGroupPlanIds.mockRejectedValue(new Error("throttled"));
    // The group cannot be read back live either: no set can be attested.
    mocks.getSellingPlanGroupOwnershipStates.mockResolvedValue(new Map());

    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      v: 2,
      groupIds: ["77"],
      planIds: [],
      planSets: [],
      appId: OUR_APP_ID,
    });
  });

  it("omits groups that were never synced", async () => {
    mocks.planConfigFindMany.mockResolvedValue([]);
    await expect(buildPlanGroupsValue("shop_1")).resolves.toEqual({
      v: 2,
      groupIds: [],
      planIds: [],
    });
  });
});

describe("recordSellingPlanSync", () => {
  it("persists the group + merged plan ids and republishes the allow-list", async () => {
    mocks.planConfigFindFirst.mockResolvedValue({ shopifyPlanIds: [OUR_PLAN] });
    mocks.planConfigFindMany.mockResolvedValue([
      {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2],
      },
    ]);

    const result = await recordSellingPlanSync({
      shopId: "shop_1",
      shopDomain: "cellexia.myshopify.com",
      configId: "cfg_1",
      groupId: "gid://shopify/SellingPlanGroup/77",
      planIds: [OUR_PLAN_2],
    });

    expect(result.storedPlanIds).toEqual([OUR_PLAN, OUR_PLAN_2]);
    expect(mocks.planConfigUpdate).toHaveBeenCalledWith({
      where: { id: "cfg_1" },
      data: {
        shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
        shopifyPlanIds: [OUR_PLAN, OUR_PLAN_2],
      },
    });
    expect(mocks.setShopMetafield).toHaveBeenCalledTimes(1);
  });
});

describe("claimContracts", () => {
  it("promotes UNKNOWN to OURS and logs the admin action", async () => {
    mocks.contractFindMany.mockResolvedValue([
      {
        id: "c1",
        shopifyContractId: "gid://shopify/SubscriptionContract/1",
        email: "a@b.c",
        customerId: "gid://shopify/Customer/1",
      },
    ]);

    await expect(claimContracts("shop_1", ["c1", "c2"], "admin@x")).resolves.toEqual({
      claimed: 1,
      skipped: 1,
    });
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { ownership: OWNERSHIP_OURS },
    });
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
  });

  it("only ever looks at UNKNOWN rows — a FOREIGN contract cannot be claimed", async () => {
    await claimContracts("shop_1", ["c1"], "admin@x");
    expect(mocks.contractFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownership: OWNERSHIP_UNKNOWN }),
      }),
    );
  });

  it("is scoped to the calling shop, so an id from another store cannot be claimed", async () => {
    // Contract ids are cuids and the caller supplies them; without shopId in
    // the where clause, one shop's admin could flip a row belonging to another
    // installation of the app.
    await claimContracts("shop_1", ["c1"], "admin@x");
    expect(mocks.contractFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shopId: "shop_1" }),
      }),
    );
  });

  it("is a no-op on an empty selection", async () => {
    await expect(claimContracts("shop_1", [], "admin@x")).resolves.toEqual({
      claimed: 0,
      skipped: 0,
    });
    expect(mocks.contractFindMany).not.toHaveBeenCalled();
  });
});

describe("claimContracts is the only bulk writer of OURS", () => {
  /**
   * A second helper, `markContractsOurs(contractIds)`, used to live next to
   * claimContracts for the import paths. It had no production caller (the
   * import paths stamp ownership inline in their own create/upsert, atomically
   * with the row), and it differed from claimContracts in exactly the two ways
   * a bulk ownership writer must not: it matched `ownership: { not: OURS }`,
   * so it would PROMOTE A FOREIGN ROW — a contract positively identified as
   * the other app's, i.e. the double-charge case this column exists to
   * prevent — and it carried no `shopId`, so it reached across installations.
   *
   * Dead code passes every behavioural test it does not have, so the guard is
   * on the source: no bulk update in this module may write OURS, and none may
   * select rows by "not OURS". Repairing such a helper would make it a
   * duplicate of claimContracts anyway, minus the audit event.
   */
  const source = readFileSync(
    new URL("../app/lib/ownership/ownership.server.ts", import.meta.url),
    "utf8",
  )
    // Drop block comments so the prose explaining this rule cannot break it.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("exports no other function that stamps OURS in bulk", () => {
    expect(source).not.toContain("markContractsOurs");
    expect(source).not.toMatch(/updateMany/);
  });

  it("never selects contracts by 'anything that is not OURS'", () => {
    // `{ not: OWNERSHIP_OURS }` matches FOREIGN as well as UNKNOWN. Claiming
    // is only ever legitimate from UNKNOWN.
    expect(source).not.toMatch(/ownership:\s*\{\s*not:/);
  });

  it("still writes OURS somewhere — the guard above is not vacuous", () => {
    expect(source).toContain("data: { ownership: OWNERSHIP_OURS }");
  });
});

// ── reclassifyContracts — the upgrade path off the UNKNOWN backfill ──────────

/**
 * Migration 0003 backfills every pre-existing contract to UNKNOWN, because at
 * migration time the two columns ownership is derived from do not have values
 * yet. UNKNOWN is unbillable, so the upgrade is safe — and incomplete: OUR OWN
 * subscribers are sitting in it. This function is what completes it, and
 * go-live is what runs it, so these tests are the difference between "the
 * client's renewals resume" and "the client's renewals stop".
 */
describe("reclassifyContracts", () => {
  const OUR_CONFIG = [{ shopifyGroupId: "gid://shopify/SellingPlanGroup/1", shopifyPlanIds: [OUR_PLAN] }];

  function contract(over: Record<string, unknown>) {
    return {
      id: "c1",
      ownership: OWNERSHIP_UNKNOWN,
      shopifyContractId: "gid://shopify/SubscriptionContract/1",
      lines: [],
      ...over,
    };
  }

  it("promotes an UNKNOWN contract whose line carries one of our plans", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(1);
    mocks.contractFindMany.mockResolvedValue([
      contract({ lines: [{ sellingPlanId: OUR_PLAN }] }),
    ]);

    const result = await reclassifyContracts("shop.myshopify.com");
    expect(result.changed).toBe(1);
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { ownership: OWNERSHIP_OURS },
    });
    // Local evidence was enough: no Shopify round trip.
    expect(mocks.syncContractFromShopify).not.toHaveBeenCalled();
  });

  it("marks another app's contract FOREIGN — the double-charge case", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(1);
    mocks.contractFindMany.mockResolvedValue([
      contract({ lines: [{ sellingPlanId: JOY_PLAN }] }),
    ]);

    await reclassifyContracts("shop.myshopify.com");
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { ownership: OWNERSHIP_FOREIGN },
    });
  });

  it("re-fetches a contract with no local evidence, so the UNKNOWN backfill resolves", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(1);
    mocks.contractFindMany.mockResolvedValue([contract({ lines: [] })]);

    const result = await reclassifyContracts("shop.myshopify.com");
    expect(result.resynced).toBe(1);
    expect(mocks.syncContractFromShopify).toHaveBeenCalledWith(
      "shop.myshopify.com",
      "gid://shopify/SubscriptionContract/1",
      { source: "SYSTEM" },
    );
    // The sync writes the verdict itself — no blind local update on top.
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("never re-fetches a contract that is already OURS", async () => {
    // Import-created contracts carry no selling plan at all. Re-fetching them
    // would be one Shopify round trip per imported subscriber, every pass,
    // to learn nothing — and they already have positive evidence behind them.
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(1);
    mocks.contractFindMany.mockResolvedValue([
      contract({ ownership: OWNERSHIP_OURS, lines: [] }),
    ]);

    const result = await reclassifyContracts("shop.myshopify.com");
    expect(mocks.syncContractFromShopify).not.toHaveBeenCalled();
    expect(result.resynced).toBe(0);
    // …and the verdict is not downgraded either.
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("honours fetchMissing:false (a purely local pass)", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(1);
    mocks.contractFindMany.mockResolvedValue([contract({ lines: [] })]);

    await reclassifyContracts("shop.myshopify.com", { fetchMissing: false });
    expect(mocks.syncContractFromShopify).not.toHaveBeenCalled();
  });

  it("contains a per-contract sync failure and keeps going", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractCount.mockResolvedValue(2);
    mocks.contractFindMany.mockResolvedValue([
      contract({ id: "c1", shopifyContractId: "gid://a", lines: [] }),
      contract({ id: "c2", shopifyContractId: "gid://b", lines: [] }),
    ]);
    mocks.syncContractFromShopify.mockRejectedValueOnce(new Error("throttled"));

    const result = await reclassifyContracts("shop.myshopify.com");
    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.resynced).toBe(1);
  });

  it("scans indeterminate rows first, so repeated runs converge", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractFindMany.mockResolvedValue([
      contract({ lines: [{ sellingPlanId: OUR_PLAN }] }),
    ]);

    await reclassifyContracts("shop.myshopify.com", { limit: 1 });
    const args = mocks.contractFindMany.mock.calls[0][0] as {
      take: number;
      orderBy: Array<Record<string, string>>;
      where: Record<string, unknown>;
    };
    expect(args.take).toBe(1);
    // UNKNOWN sorts last alphabetically, so descending puts it first.
    expect(args.orderBy[0]).toEqual({ ownership: "desc" });
    expect(args.where).toMatchObject({ shopId: "shop_1", isDemo: false });
  });

  /**
   * `remaining` is the admin's only "is it finished?" signal — the Preview &
   * launch toast turns it into "run it again" and the go-live audit event
   * records it. It used to be `total - scanned` over EVERY non-demo contract,
   * which on a shop bigger than one pass is a constant: it never reached 0
   * however many times the pass ran, so the signal said "not done" forever.
   */
  it("reports what is LEFT to attribute, and reaches 0 when nothing is", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractFindMany.mockResolvedValue([
      contract({ lines: [{ sellingPlanId: OUR_PLAN }] }),
    ]);
    // 5000 contracts on the shop, far more than one pass may scan — but every
    // one of them already has a verdict, so there is nothing left to do.
    mocks.contractCount.mockResolvedValue(5000);
    mocks.contractGroupBy.mockResolvedValue([
      { ownership: OWNERSHIP_OURS, _count: { _all: 4000 } },
      { ownership: OWNERSHIP_FOREIGN, _count: { _all: 1000 } },
    ]);

    const result = await reclassifyContracts("shop.myshopify.com", { limit: 1 });
    expect(result.remaining).toBe(0);
  });

  it("counts the still-unattributed rows as the work remaining", async () => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
    mocks.contractFindMany.mockResolvedValue([
      contract({ lines: [{ sellingPlanId: OUR_PLAN }] }),
    ]);
    mocks.contractGroupBy.mockResolvedValue([
      { ownership: OWNERSHIP_OURS, _count: { _all: 10 } },
      { ownership: OWNERSHIP_UNKNOWN, _count: { _all: 7 } },
    ]);

    const result = await reclassifyContracts("shop.myshopify.com");
    expect(result.remaining).toBe(7);
    expect(result.counts.unknown).toBe(7);
  });

  it("throws for an unknown shop rather than silently doing nothing", async () => {
    mocks.shopFindUnique.mockResolvedValue(null);
    await expect(reclassifyContracts("nope.myshopify.com")).rejects.toThrow(
      /Unknown shop/,
    );
  });
});

// ── reclassifyAllContracts — the sweep go-live runs ──────────────────────────

/**
 * Go-live used to run ONE bounded pass. A shop with more contracts than the
 * pass limit therefore went live with the overflow still UNKNOWN — and UNKNOWN
 * is not billable, so those renewals stopped — with nothing in the product
 * re-running the pass. This sweep is what makes go-live finish the job.
 */
describe("reclassifyAllContracts", () => {
  const OUR_CONFIG = [
    { shopifyGroupId: "gid://shopify/SellingPlanGroup/1", shopifyPlanIds: [OUR_PLAN] },
  ];

  function row(id: string, over: Record<string, unknown> = {}) {
    return {
      id,
      ownership: OWNERSHIP_UNKNOWN,
      shopifyContractId: `gid://shopify/SubscriptionContract/${id}`,
      lines: [{ sellingPlanId: OUR_PLAN }],
      ...over,
    };
  }

  /** Feed findMany a fixed sequence of pages. */
  function pages(...batches: unknown[][]) {
    let call = 0;
    mocks.contractFindMany.mockImplementation(async () => batches[call++] ?? []);
  }

  beforeEach(() => {
    mocks.planConfigFindMany.mockResolvedValue(OUR_CONFIG);
  });

  it("pages through every contract by id cursor, visiting each exactly once", async () => {
    pages([row("c1"), row("c2")], [row("c3")]);

    const result = await reclassifyAllContracts("shop.myshopify.com", {
      batchSize: 2,
    });

    expect(result.scanned).toBe(3);
    const calls = mocks.contractFindMany.mock.calls.map(
      (c) => c[0] as Record<string, unknown>,
    );
    expect(calls).toHaveLength(2);
    // Ordered by id, which this sweep never rewrites. Ordering by `ownership`
    // — the column it DOES rewrite — would move rows between pages while
    // paging through them, so a contract could be skipped or seen twice.
    expect(calls[0].orderBy).toEqual({ id: "asc" });
    expect(calls[0].cursor).toBeUndefined();
    expect(calls[1].cursor).toEqual({ id: "c2" });
    expect(calls[1].skip).toBe(1);
  });

  it("stops at a short page instead of querying forever", async () => {
    pages([row("c1")]);
    const result = await reclassifyAllContracts("shop.myshopify.com", {
      batchSize: 10,
    });
    expect(result.scanned).toBe(1);
    expect(mocks.contractFindMany).toHaveBeenCalledTimes(1);
  });

  it("honours maxContracts so one call can never run unbounded", async () => {
    pages([row("c1"), row("c2")], [row("c3"), row("c4")]);
    const result = await reclassifyAllContracts("shop.myshopify.com", {
      batchSize: 2,
      maxContracts: 2,
    });
    expect(result.scanned).toBe(2);
    expect(mocks.contractFindMany).toHaveBeenCalledTimes(1);
  });

  it("caps the Shopify round trips and leaves the rest UNKNOWN for next time", async () => {
    // Right after migration 0003 no contract has a mirrored selling plan yet
    // (the column is added by that migration), so EVERY row wants a re-fetch.
    // Unbudgeted, the first sweep would sit in one request making one API call
    // per subscriber. What it cannot reach stays UNKNOWN — unbillable, the
    // safe direction — and is reported as remaining.
    pages([row("c1", { lines: [] }), row("c2", { lines: [] }), row("c3", { lines: [] })]);
    mocks.contractGroupBy.mockResolvedValue([
      { ownership: OWNERSHIP_UNKNOWN, _count: { _all: 2 } },
    ]);

    const result = await reclassifyAllContracts("shop.myshopify.com", {
      batchSize: 10,
      resyncBudget: 1,
    });

    expect(result.scanned).toBe(3);
    expect(result.resynced).toBe(1);
    expect(mocks.syncContractFromShopify).toHaveBeenCalledTimes(1);
    expect(result.remaining).toBe(2);
  });

  it("throws for an unknown shop rather than silently doing nothing", async () => {
    mocks.shopFindUnique.mockResolvedValue(null);
    await expect(reclassifyAllContracts("nope.myshopify.com")).rejects.toThrow(
      /Unknown shop/,
    );
  });
});
