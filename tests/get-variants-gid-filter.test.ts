import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getVariants defence in depth: `nodes(ids:)` rejects a malformed id with a
 * TOP-LEVEL GraphQL error — not a null node — so ONE non-Shopify GID (e.g. a
 * demo contract's `gid://cellexia/demo/variant/…` placeholder) used to blank
 * the whole batch for every legitimate variant in it. Non-`gid://shopify/`
 * ids are now dropped before the query is built, whatever the caller.
 */

const mocks = vi.hoisted(() => ({
  gql: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => ({ nodes: [] }),
  ),
}));

vi.mock("~/lib/graphql/client.server", () => ({
  gql: mocks.gql,
  centsFromMoney: vi.fn(() => null),
  centsFromMoneyOrZero: vi.fn(() => 0),
}));

import { getVariants } from "~/lib/graphql/products.server";

const ADMIN = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gql.mockResolvedValue({ nodes: [] });
});

describe("getVariants GID pre-filter", () => {
  it("drops non-Shopify GIDs so one bad id cannot blank the whole batch", async () => {
    mocks.gql.mockResolvedValue({
      nodes: [
        {
          __typename: "ProductVariant",
          id: "gid://shopify/ProductVariant/1",
          title: "30 ml",
          availableForSale: true,
        },
      ],
    });

    const variants = await getVariants(ADMIN, [
      "gid://cellexia/demo/variant/abc123",
      "gid://shopify/ProductVariant/1",
    ]);

    expect(mocks.gql).toHaveBeenCalledTimes(1);
    const ids = (mocks.gql.mock.calls[0][2] as { ids: string[] }).ids;
    expect(ids).toEqual(["gid://shopify/ProductVariant/1"]);
    expect(variants).toHaveLength(1);
    expect(variants[0].id).toBe("gid://shopify/ProductVariant/1");
  });

  it("returns [] without any query when every id is malformed", async () => {
    const variants = await getVariants(ADMIN, [
      "gid://cellexia/demo/variant/abc123",
      "not-a-gid",
      "",
    ]);

    expect(variants).toEqual([]);
    expect(mocks.gql).not.toHaveBeenCalled();
  });
});
