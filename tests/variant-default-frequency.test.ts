import { describe, expect, it, vi } from "vitest";

/**
 * PER-VARIANT DEFAULT FREQUENCY (v1.14.0) — server side.
 *
 * Products sold as unit-count variants (1 / 2 / 3 jars) empty at different
 * rates, so the cadence the buy box PRESELECTS follows the variant. The
 * merchant's explicit overrides live on
 * `SellingPlanConfig.variantDefaultFrequencies` (variant GID → {unit,count});
 * the storefront reads the projection from the shop metafield
 * `cellexia.variant_defaults` (NUMERIC variant ids — the id form Liquid and
 * the theme's [name=id] field carry).
 *
 * Pinned here:
 *  a. parseConfigVariantDefaults — defensive like every config parser:
 *     malformed columns/keys/entries DROP, never throw, and entries outside
 *     the offered list drop too (a frequency edit retires its overrides);
 *  b. buildVariantDefaultsValue — inactive configs contribute nothing, keys
 *     go numeric, offered-filtering runs against EACH config's own list;
 *  c. publishVariantDefaultsMetafield — writes {v:1, byVariant} as json and
 *     contains its own failures ({ok:false}, never a throw);
 *  d. the ownership publish choke point (publishOwnGroupsMetafield) carries
 *     the variant-defaults write ALONG — after the allow-list write, and
 *     CONTAINED: a failing variant_defaults write must degrade to
 *     `variantDefaults.ok === false` on an otherwise ok:true publish,
 *     because a missing presentation metafield merely preselects the group
 *     default while a failed allow-list is a widget outage. The two must
 *     never share a fate.
 */

const GROUP_GID = "gid://shopify/SellingPlanGroup/661";

const mocks = vi.hoisted(() => ({
  setShopMetafield: vi.fn(async (_admin: unknown, input: unknown) => input),
  sellingPlanConfigFindMany: vi.fn(
    async (_args?: unknown): Promise<unknown[]> => [],
  ),
  logEvent: vi.fn(async () => undefined),
}));

vi.mock("~/db.server", () => {
  const db = {
    shop: {
      findUnique: async () => ({ id: "shop_1" }),
    },
    sellingPlanConfig: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        // The plan-id repair inside publishOwnGroupsMetafield queries with a
        // shopifyPlanIds filter — answer "nothing to repair" so the publish
        // path stays about the metafield writes under test.
        if (args?.where && "shopifyPlanIds" in args.where) return [];
        return mocks.sellingPlanConfigFindMany(args);
      },
      update: async () => ({}),
    },
  };
  return { default: db };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => ({ graphql: vi.fn() })),
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: mocks.setShopMetafield,
  getShopMetafield: vi.fn(async () => null),
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getCurrentAppId: vi.fn(async () => "4477001"),
  getSellingPlanGroupOwnershipStates: vi.fn(
    async () =>
      new Map([
        [
          GROUP_GID,
          {
            appId: "4477001",
            planIds: ["gid://shopify/SellingPlan/1"],
          },
        ],
      ]),
  ),
  stampSellingPlanGroupAppIds: vi.fn(async () => ({
    stamped: [],
    alreadyStamped: [GROUP_GID],
    failed: [],
  })),
  getSellingPlanGroupPlanIds: vi.fn(async () => []),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

import { parseConfigVariantDefaults } from "~/lib/frequency";
import {
  buildVariantDefaultsValue,
  publishVariantDefaultsMetafield,
} from "~/lib/widget/variant-defaults.server";
import { publishOwnGroupsMetafield } from "~/lib/ownership/ownership.server";

const V1 = "gid://shopify/ProductVariant/4411100011201";
const V2 = "gid://shopify/ProductVariant/4411100011202";
const V3 = "gid://shopify/ProductVariant/4411100011203";

const WEEKS = (count: number) => ({ unit: "WEEK" as const, count });
const MONTHS = (count: number) => ({ unit: "MONTH" as const, count });

/** A config row shaped like the columns the builder selects. */
function configRow(overrides: Record<string, unknown> = {}) {
  return {
    active: true,
    frequencies: [WEEKS(4), WEEKS(8), MONTHS(3)],
    defaultFrequency: WEEKS(8),
    frequenciesWeeks: [4, 8, 12],
    defaultFrequencyWeeks: 8,
    variantDefaultFrequencies: null,
    shopifyGroupId: GROUP_GID,
    shopifyPlanIds: ["gid://shopify/SellingPlan/1"],
    ...overrides,
  };
}

describe("parseConfigVariantDefaults — defensive column parsing", () => {
  it("keeps well-formed entries, keyed by variant GID", () => {
    const out = parseConfigVariantDefaults({
      [V1]: WEEKS(8),
      [V2]: MONTHS(3),
    });
    expect(out.get(V1)).toEqual(WEEKS(8));
    expect(out.get(V2)).toEqual(MONTHS(3));
    expect(out.size).toBe(2);
  });

  it.each([
    ["null", null],
    ["a string", "garbage"],
    ["an array", [WEEKS(4)]],
    ["a number", 7],
  ])("returns empty for %s instead of throwing", (_label, value) => {
    expect(parseConfigVariantDefaults(value).size).toBe(0);
  });

  it("drops non-variant keys and malformed / out-of-range entries", () => {
    const out = parseConfigVariantDefaults({
      "gid://shopify/Product/1": WEEKS(8), // wrong resource type
      "4411100011201": WEEKS(8), // bare numeric — the GID is the contract
      [V1]: { unit: "FORTNIGHT", count: 2 }, // unknown unit
      [V2]: { unit: "WEEK" }, // missing count
      [V3]: WEEKS(99), // outside the WEEK 1–26 range
    });
    expect(out.size).toBe(0);
  });

  it("filters to the offered list when given (a removed cadence retires its overrides)", () => {
    const out = parseConfigVariantDefaults(
      { [V1]: WEEKS(8), [V2]: MONTHS(3) },
      [WEEKS(4), WEEKS(8)],
    );
    expect(out.get(V1)).toEqual(WEEKS(8));
    expect(out.has(V2)).toBe(false);
  });
});

describe("buildVariantDefaultsValue — DB → metafield projection", () => {
  it("projects GID keys to numeric ids, filters against each config's own offered list, and carries the group default", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([
      configRow({
        variantDefaultFrequencies: {
          [V1]: WEEKS(8),
          [V2]: MONTHS(3),
          [V3]: WEEKS(6), // NOT offered by this config — must drop
        },
      }),
    ]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value).toEqual({
      v: 1,
      default: WEEKS(8),
      byVariant: {
        "4411100011201": WEEKS(8),
        "4411100011202": MONTHS(3),
      },
    });
  });

  it("queries SYNCED configs only — allow-list parity, 'save is not publish'", async () => {
    // The draft-config exclusion lives in the where-clause (the mock cannot
    // model Prisma filtering): pin the exact filter buildPlanGroupsValue
    // uses, so a draft saved-but-never-synced can never steer the live
    // storefront and the two metafields never disagree about which configs
    // exist.
    mocks.sellingPlanConfigFindMany.mockClear();
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([]);
    await buildVariantDefaultsValue("shop_1");
    expect(mocks.sellingPlanConfigFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop_1", shopifyGroupId: { not: null } },
      }),
    );
  });

  it("an INACTIVE-but-synced config still contributes (its group still renders under the allow-list)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([
      configRow({
        active: false,
        variantDefaultFrequencies: { [V1]: WEEKS(8) },
      }),
    ]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value.byVariant).toEqual({ "4411100011201": WEEKS(8) });
  });

  it("a null column and a config without overrides publish just the group default", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([configRow()]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value.byVariant).toEqual({});
    expect(value.default).toEqual(WEEKS(8));
  });

  it("no synced configs → no default field at all", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value).toEqual({ v: 1, byVariant: {} });
  });

  it("a corrupt group default (NaN weeks) degrades the default field only, never the metafield", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([
      configRow({
        defaultFrequency: null,
        defaultFrequencyWeeks: Number.NaN,
        variantDefaultFrequencies: { [V1]: WEEKS(8) },
      }),
    ]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value.default).toBeUndefined();
    expect(value.byVariant).toEqual({ "4411100011201": WEEKS(8) });
  });

  it("a later config wins a cross-config variant collision (createdAt order)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([
      configRow({ variantDefaultFrequencies: { [V1]: WEEKS(4) } }),
      configRow({ variantDefaultFrequencies: { [V1]: MONTHS(3) } }),
    ]);
    const value = await buildVariantDefaultsValue("shop_1");
    expect(value.byVariant).toEqual({ "4411100011201": MONTHS(3) });
  });
});

describe("publishVariantDefaultsMetafield — contained write", () => {
  it("writes {v:1, byVariant} as cellexia.variant_defaults (json)", async () => {
    mocks.setShopMetafield.mockClear();
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([
      configRow({ variantDefaultFrequencies: { [V2]: MONTHS(3) } }),
    ]);
    const result = await publishVariantDefaultsMetafield(
      { graphql: vi.fn() } as never,
      "shop_1",
    );
    expect(result.ok).toBe(true);
    expect(mocks.setShopMetafield).toHaveBeenCalledTimes(1);
    const input = mocks.setShopMetafield.mock.calls[0][1] as Record<
      string,
      string
    >;
    expect(input.namespace).toBe("cellexia");
    expect(input.key).toBe("variant_defaults");
    expect(input.type).toBe("json");
    expect(JSON.parse(input.value)).toEqual({
      v: 1,
      default: WEEKS(8),
      byVariant: { "4411100011202": MONTHS(3) },
    });
  });

  it("returns {ok:false} instead of throwing when the write fails", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValueOnce([configRow()]);
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("metafieldsSet: boom"));
    const result = await publishVariantDefaultsMetafield(
      { graphql: vi.fn() } as never,
      "shop_1",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });
});

describe("publishOwnGroupsMetafield carries the variant-defaults write along — contained", () => {
  function primeConfigs() {
    // Both the allow-list build and the variant-defaults build read configs;
    // serve the same synced row to every non-repair findMany.
    mocks.sellingPlanConfigFindMany.mockImplementation(async () => [
      configRow({ variantDefaultFrequencies: { [V2]: MONTHS(3) } }),
    ]);
  }

  it("writes plan_groups FIRST, then variant_defaults, and reports ok on both", async () => {
    primeConfigs();
    mocks.setShopMetafield.mockClear();
    mocks.setShopMetafield.mockImplementation(async (_admin, input) => input);

    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(result.variantDefaults).toEqual({ ok: true });

    const keys = mocks.setShopMetafield.mock.calls.map(
      (call) => (call[1] as { key: string }).key,
    );
    expect(keys).toEqual(["plan_groups", "variant_defaults"]);
    const defaultsValue = JSON.parse(
      (mocks.setShopMetafield.mock.calls[1][1] as { value: string }).value,
    );
    expect(defaultsValue).toEqual({
      v: 1,
      default: WEEKS(8),
      byVariant: { "4411100011202": MONTHS(3) },
    });
  });

  it("a failing variant_defaults write leaves the ownership publish ok:true (never shared fate)", async () => {
    primeConfigs();
    mocks.setShopMetafield.mockClear();
    mocks.setShopMetafield.mockImplementation(async (_admin, input) => {
      if ((input as { key: string }).key === "variant_defaults") {
        throw new Error("metafieldsSet: variant_defaults exploded");
      }
      return input;
    });

    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(true);
    expect(result.value?.appId).toBe("4477001");
    expect(result.variantDefaults?.ok).toBe(false);
    expect(result.variantDefaults?.error).toContain("exploded");
  });

  it("the reverse fate-sharing also holds: a failed ALLOW-LIST write never reaches the defaults write", async () => {
    primeConfigs();
    mocks.setShopMetafield.mockClear();
    mocks.setShopMetafield.mockImplementation(async (_admin, input) => {
      if ((input as { key: string }).key === "plan_groups") {
        throw new Error("metafieldsSet: plan_groups exploded");
      }
      return input;
    });

    const result = await publishOwnGroupsMetafield("cellexia.myshopify.com");
    expect(result.ok).toBe(false);
    // Fail-closed ordering: nothing must publish fresh presentation data on
    // top of a stale allow-list — the defaults write never ran.
    const keys = mocks.setShopMetafield.mock.calls.map(
      (call) => (call[1] as { key: string }).key,
    );
    expect(keys).toEqual(["plan_groups"]);
  });
});
