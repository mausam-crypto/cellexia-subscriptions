import { type AdminClient, gql } from "./client.server";

/**
 * Shopify Markets reads (v1.6.0) — powers the Buy box designer's per-market
 * preset selection (config.markets, keyed by MARKET HANDLE) and its market
 * preview select. Read-only; the `read_markets` scope is already granted.
 *
 * The handle is the join key: the storefront Liquid resolves the active
 * market via `localization.market.handle` and looks it up in the published
 * config's `markets` record, so the admin must save entries under exactly
 * the handles Shopify reports here.
 */

const MARKETS_QUERY = `#graphql
  query CellexiaMarkets($first: Int!) {
    markets(first: $first) {
      nodes {
        id
        name
        handle
        primary
      }
    }
  }
`;

interface MarketsResponse {
  markets?: {
    nodes?: Array<{
      id: string;
      name?: string | null;
      handle?: string | null;
      primary?: boolean | null;
    } | null> | null;
  } | null;
}

export interface ShopifyMarket {
  /** Full GID, e.g. "gid://shopify/Market/123". */
  id: string;
  name: string;
  /** The `localization.market.handle` value the storefront Liquid sees. */
  handle: string;
  /** True for the shop's primary market. */
  primary: boolean;
}

/**
 * Every market on the shop (first 50 — Shopify caps shops far below that),
 * primary market first, then alphabetical. Nodes without a handle are
 * dropped: the storefront could never resolve a config entry for them.
 */
export async function listMarkets(admin: AdminClient): Promise<ShopifyMarket[]> {
  const data = await gql<MarketsResponse>(admin, MARKETS_QUERY, { first: 50 });

  const markets: ShopifyMarket[] = [];
  for (const node of data.markets?.nodes ?? []) {
    if (!node?.id || !node.handle) continue;
    markets.push({
      id: node.id,
      name: node.name ?? node.handle,
      handle: node.handle,
      primary: node.primary ?? false,
    });
  }
  return markets.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
