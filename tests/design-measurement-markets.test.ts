import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MARKET COUNTRY MAP (markets.server.ts, v1.26.0)
 *
 *  1. GraphQL markets + regions → MarketCountryMap upserts for the shop:
 *     enabled markets only, primary market wins a country listed twice
 *     (then first-listed), codes uppercased, junk regions dropped.
 *  2. Stale rows are removed ONLY when the fresh answer is non-empty (an
 *     empty answer keeps the previous cache).
 *  3. Transport / GraphQL errors THROW (callers contain).
 *  4. marketHandleForCountry: null for no/invalid country or no row; the
 *     lookup uppercases.
 *  5. listCachedMarkets dedupes handles.
 */

const dbMocks = vi.hoisted(() => ({
  upsert: vi.fn(async (): Promise<unknown> => ({})),
  deleteMany: vi.fn(async (): Promise<{ count: number }> => ({ count: 0 })),
  findUnique: vi.fn(async (): Promise<unknown> => null),
  findMany: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    marketCountryMap: {
      upsert: dbMocks.upsert,
      deleteMany: dbMocks.deleteMany,
      findUnique: dbMocks.findUnique,
      findMany: dbMocks.findMany,
    },
  },
}));

import {
  listCachedMarkets,
  marketCountryEntriesFromResponse,
  marketHandleForCountry,
  refreshMarketCountryMap,
} from "~/lib/design-measurement/markets.server";

function adminReturning(body: unknown) {
  const graphql = vi.fn(async (_query: string, _options?: { variables?: Record<string, unknown> }) =>
    ({ json: async () => body }) as unknown as Response,
  );
  return { graphql };
}

const RESPONSE = {
  data: {
    markets: {
      nodes: [
        {
          id: "gid://shopify/Market/2",
          name: "Europe",
          handle: "eu",
          primary: false,
          enabled: true,
          regions: { nodes: [{ code: "DE" }, { code: "FR" }, { code: "CH" }] },
        },
        {
          id: "gid://shopify/Market/1",
          name: "Switzerland",
          handle: "ch",
          primary: true,
          enabled: true,
          regions: { nodes: [{ code: "CH" }, { code: "li" }, { code: "" }, null, {}] },
        },
        {
          id: "gid://shopify/Market/3",
          name: "Draft",
          handle: "draft",
          primary: false,
          enabled: false,
          regions: { nodes: [{ code: "US" }] },
        },
        {
          id: "gid://shopify/Market/4",
          name: "No handle",
          handle: null,
          primary: false,
          enabled: true,
          regions: { nodes: [{ code: "GB" }] },
        },
      ],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.findUnique.mockResolvedValue(null);
  dbMocks.findMany.mockResolvedValue([]);
});

describe("marketCountryEntriesFromResponse", () => {
  it("projects enabled markets, primary wins a shared country, codes uppercased, junk dropped", () => {
    const entries = marketCountryEntriesFromResponse(RESPONSE.data);
    expect(entries).toEqual([
      // Primary first: CH and LI belong to "ch" even though "eu" also lists CH.
      { countryCode: "CH", marketHandle: "ch", marketName: "Switzerland" },
      { countryCode: "LI", marketHandle: "ch", marketName: "Switzerland" },
      { countryCode: "DE", marketHandle: "eu", marketName: "Europe" },
      { countryCode: "FR", marketHandle: "eu", marketName: "Europe" },
    ]);
  });

  it("without a primary flag the first-listed market keeps a shared country", () => {
    const entries = marketCountryEntriesFromResponse({
      markets: {
        nodes: [
          { handle: "a", enabled: true, regions: { nodes: [{ code: "DE" }] } },
          { handle: "b", enabled: true, regions: { nodes: [{ code: "DE" }, { code: "AT" }] } },
        ],
      },
    });
    expect(entries).toEqual([
      { countryCode: "DE", marketHandle: "a", marketName: null },
      { countryCode: "AT", marketHandle: "b", marketName: null },
    ]);
  });

  it("returns [] for an empty or malformed answer", () => {
    expect(marketCountryEntriesFromResponse({})).toEqual([]);
    expect(marketCountryEntriesFromResponse({ markets: null })).toEqual([]);
    expect(marketCountryEntriesFromResponse({ markets: { nodes: [null] } })).toEqual([]);
  });
});

describe("refreshMarketCountryMap", () => {
  it("queries markets + regions (2025-01 shape) and upserts one row per country, deleting stale rows", async () => {
    const admin = adminReturning(RESPONSE);
    const count = await refreshMarketCountryMap("shop_1", admin);
    expect(count).toBe(4);

    const [query, options] = admin.graphql.mock.calls[0];
    expect(query).toContain("markets(first: $first)");
    expect(query).toContain("regions(first: 250)");
    expect(query).toContain("... on MarketRegionCountry");
    expect(query).toContain("enabled");
    expect(options).toEqual({ variables: { first: 50 } });

    expect(dbMocks.upsert).toHaveBeenCalledTimes(4);
    expect(dbMocks.upsert).toHaveBeenCalledWith({
      where: { shopId_countryCode: { shopId: "shop_1", countryCode: "CH" } },
      create: { shopId: "shop_1", countryCode: "CH", marketHandle: "ch", marketName: "Switzerland" },
      update: { marketHandle: "ch", marketName: "Switzerland" },
    });
    expect(dbMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId_countryCode: { shopId: "shop_1", countryCode: "DE" } },
        update: { marketHandle: "eu", marketName: "Europe" },
      }),
    );
    expect(dbMocks.deleteMany).toHaveBeenCalledWith({
      where: { shopId: "shop_1", countryCode: { notIn: ["CH", "LI", "DE", "FR"] } },
    });
  });

  it("keeps the previous cache when the answer maps no country (never wipes on an empty read)", async () => {
    const admin = adminReturning({ data: { markets: { nodes: [] } } });
    expect(await refreshMarketCountryMap("shop_1", admin)).toBe(0);
    expect(dbMocks.upsert).not.toHaveBeenCalled();
    expect(dbMocks.deleteMany).not.toHaveBeenCalled();
  });

  it("throws on GraphQL errors (callers contain) and writes nothing", async () => {
    const admin = adminReturning({ errors: [{ message: "Field 'regions' doesn't exist" }] });
    await expect(refreshMarketCountryMap("shop_1", admin)).rejects.toThrow(/regions/);
    expect(dbMocks.upsert).not.toHaveBeenCalled();
    expect(dbMocks.deleteMany).not.toHaveBeenCalled();
  });
});

describe("marketHandleForCountry", () => {
  it("null for missing/invalid country without touching the DB", async () => {
    expect(await marketHandleForCountry("shop_1", null)).toBeNull();
    expect(await marketHandleForCountry("shop_1", "")).toBeNull();
    expect(await marketHandleForCountry("shop_1", "Switzerland")).toBeNull();
    expect(dbMocks.findUnique).not.toHaveBeenCalled();
  });

  it("uppercases the lookup and returns the cached handle (null when no row)", async () => {
    dbMocks.findUnique.mockResolvedValue({ marketHandle: "ch" });
    expect(await marketHandleForCountry("shop_1", " ch ")).toBe("ch");
    expect(dbMocks.findUnique).toHaveBeenCalledWith({
      where: { shopId_countryCode: { shopId: "shop_1", countryCode: "CH" } },
      select: { marketHandle: true },
    });
    dbMocks.findUnique.mockResolvedValue(null);
    expect(await marketHandleForCountry("shop_1", "US")).toBeNull();
  });
});

describe("listCachedMarkets", () => {
  it("dedupes handles and keeps the first name", async () => {
    dbMocks.findMany.mockResolvedValue([
      { marketHandle: "ch", marketName: "Switzerland" },
      { marketHandle: "ch", marketName: "Switzerland" },
      { marketHandle: "eu", marketName: null },
    ]);
    expect(await listCachedMarkets("shop_1")).toEqual([
      { handle: "ch", name: "Switzerland" },
      { handle: "eu", name: null },
    ]);
  });
});
