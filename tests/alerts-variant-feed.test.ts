import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ONE DEMO GID MUST NOT BLIND THE STOCKOUT SCAN — the alerts_run variant
 * feed, evaluated.
 *
 * `collectRenewalVariantAvailability` (jobs/runner.server.ts) feeds
 * runAlertScan's STOCKOUT_RENEWALS check. It used to select contract lines by
 * isGift/status/nextBillingDate ONLY — no isDemo, no ownership — so the
 * merchant's reusable demo preview contract (ACTIVE, ownership OURS,
 * placeholder lines with fake `gid://cellexia/demo/variant/…` ids, a static
 * nextBillingDate that is never advanced) entered the horizon a few days
 * after creation and poisoned the getVariants batch: Shopify's nodes(ids:)
 * answers a malformed id with a TOP-LEVEL GraphQL error, gql() throws, the
 * catch blanks the whole availability map, and runAlertScan skips
 * STOCKOUT_RENEWALS entirely ("we never guess availability") — forever, with
 * only a console.error as evidence. ARCHITECTURE.md: demo is excluded from
 * jobs; OURS_ONLY everywhere.
 *
 * These tests drive the REAL helper with mocked seams and pin the query
 * scope, the map construction and the fail-soft contract.
 */

const mocks = vi.hoisted(() => ({
  lineFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => {
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );
  const explicit: Record<string, unknown> = {
    contractLine: { findMany: mocks.lineFindMany },
  };
  return {
    default: new Proxy(
      {},
      {
        get: (_t, model: string) =>
          model in explicit ? explicit[model] : autoModel,
      },
    ),
  };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/lib/graphql/products.server", () => ({
  getVariants: mocks.getVariants,
}));

import { collectRenewalVariantAvailability } from "~/lib/jobs/runner.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const SHOP = { id: "shop_1", domain: "cellexia.myshopify.com" };
const DAY_MS = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lineFindMany.mockResolvedValue([]);
  mocks.getVariants.mockResolvedValue([]);
});

describe("collectRenewalVariantAvailability", () => {
  it("excludes demo and non-OURS contracts from the variant query — the demo's fake GIDs must never reach Shopify", async () => {
    mocks.lineFindMany.mockResolvedValue([
      { variantId: "gid://shopify/ProductVariant/1" },
    ]);

    await collectRenewalVariantAvailability(SHOP, NOW);

    expect(mocks.lineFindMany).toHaveBeenCalledTimes(1);
    const args = mocks.lineFindMany.mock.calls[0][0] as {
      where: {
        isGift: boolean;
        contract: Record<string, unknown>;
      };
    };
    expect(args.where.isGift).toBe(false);
    expect(args.where.contract).toMatchObject({
      shopId: "shop_1",
      status: "ACTIVE",
      isDemo: false,
      ownership: "OURS",
    });
    const nbd = args.where.contract.nextBillingDate as {
      not: null;
      lte: Date;
    };
    expect(nbd.not).toBeNull();
    expect(nbd.lte.getTime()).toBe(NOW.getTime() + 7 * DAY_MS);
  });

  it("builds the availability map from getVariants", async () => {
    mocks.lineFindMany.mockResolvedValue([
      { variantId: "gid://shopify/ProductVariant/1" },
      { variantId: "gid://shopify/ProductVariant/2" },
    ]);
    mocks.getVariants.mockResolvedValue([
      { id: "gid://shopify/ProductVariant/1", availableForSale: true },
      { id: "gid://shopify/ProductVariant/2", availableForSale: false },
    ]);

    const map = await collectRenewalVariantAvailability(SHOP, NOW);

    expect(mocks.getVariants).toHaveBeenCalledWith(expect.anything(), [
      "gid://shopify/ProductVariant/1",
      "gid://shopify/ProductVariant/2",
    ]);
    expect(map?.get("gid://shopify/ProductVariant/1")).toBe(true);
    expect(map?.get("gid://shopify/ProductVariant/2")).toBe(false);
  });

  it("returns undefined without an admin round trip when nothing renews in the horizon", async () => {
    const map = await collectRenewalVariantAvailability(SHOP, NOW);

    expect(map).toBeUndefined();
    expect(mocks.adminClientForShop).not.toHaveBeenCalled();
    expect(mocks.getVariants).not.toHaveBeenCalled();
  });

  it("fails soft (undefined) when the fetch throws — the scan skips the check instead of crashing", async () => {
    mocks.lineFindMany.mockResolvedValue([
      { variantId: "gid://shopify/ProductVariant/1" },
    ]);
    mocks.getVariants.mockRejectedValue(new Error("invalid id"));

    const map = await collectRenewalVariantAvailability(SHOP, NOW);

    expect(map).toBeUndefined();
  });
});
