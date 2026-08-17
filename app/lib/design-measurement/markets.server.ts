import prisma from "~/db.server";
import { type AdminClient, gql } from "~/lib/graphql/client.server";

/**
 * Country → Shopify market handle cache (v1.26.0, MarketCountryMap).
 *
 * WHY: orders carry a shipping/billing COUNTRY; the buy-box design is chosen
 * per MARKET (config.markets keyed by `localization.market.handle`). To ask
 * the design calendar "which design was live for this order" the country
 * must be mapped to the market the storefront resolved for it. Shopify's
 * Market regions answer that (each enabled market lists the countries it
 * serves); this module mirrors the answer into MarketCountryMap so the
 * webhook path pays one indexed read, never an API call.
 *
 * Refreshed by the nightly design_facts_backfill and after every design
 * publish (design.server.ts, contained). Cache only: rebuilt from Shopify
 * whenever refreshed, and a stale or missing entry degrades to
 * marketHandle = null (the DEFAULT design), never to an error. `regions` and
 * `enabled` are deprecated in Admin API 2025-01 but present; a future removal
 * makes refresh THROW, which every caller contains, so the worst case is a
 * frozen map, not a broken webhook.
 */

const MARKET_REGIONS_QUERY = `#graphql
  query CellexiaMarketRegions($first: Int!) {
    markets(first: $first) {
      nodes {
        id
        name
        handle
        primary
        enabled
        regions(first: 250) {
          nodes {
            ... on MarketRegionCountry {
              code
            }
          }
        }
      }
    }
  }
`;

interface MarketRegionsResponse {
  markets?: {
    nodes?: Array<{
      id?: string | null;
      name?: string | null;
      handle?: string | null;
      primary?: boolean | null;
      enabled?: boolean | null;
      regions?: {
        nodes?: Array<{ code?: string | null } | null> | null;
      } | null;
    } | null> | null;
  } | null;
}

export interface MarketCountryEntry {
  countryCode: string;
  marketHandle: string;
  marketName: string | null;
}

const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * Pure projection of the GraphQL answer: enabled markets only (a disabled
 * market never resolves on the storefront), primary market first, then the
 * API's order; a country appearing in two markets keeps the FIRST (i.e. the
 * primary when it is one of them). Exported for tests.
 */
export function marketCountryEntriesFromResponse(
  data: MarketRegionsResponse,
): MarketCountryEntry[] {
  const markets = (data.markets?.nodes ?? []).filter(
    (m): m is NonNullable<typeof m> =>
      m != null &&
      typeof m.handle === "string" &&
      m.handle.trim() !== "" &&
      m.enabled !== false,
  );
  // Stable sort: primary first, otherwise keep the API order.
  const ordered = markets
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ap = a.m.primary === true ? 0 : 1;
      const bp = b.m.primary === true ? 0 : 1;
      return ap !== bp ? ap - bp : a.index - b.index;
    })
    .map((x) => x.m);

  const seen = new Set<string>();
  const out: MarketCountryEntry[] = [];
  for (const market of ordered) {
    const handle = market.handle!.trim();
    for (const region of market.regions?.nodes ?? []) {
      const code =
        typeof region?.code === "string" ? region.code.trim().toUpperCase() : "";
      if (!COUNTRY_RE.test(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        countryCode: code,
        marketHandle: handle,
        marketName:
          typeof market.name === "string" && market.name.trim() !== ""
            ? market.name.trim()
            : null,
      });
    }
  }
  return out;
}

/**
 * Read markets + regions from Shopify and upsert MarketCountryMap rows for
 * the shop. Rows for countries no longer served by any enabled market are
 * removed, but ONLY when the fresh answer is non-empty: an empty answer
 * (throttled partial, scope drift) must never wipe a working map. Throws on
 * transport/GraphQL failure — callers contain. Returns the number of
 * countries mapped.
 */
export async function refreshMarketCountryMap(
  shopId: string,
  admin: AdminClient,
): Promise<number> {
  const data = await gql<MarketRegionsResponse>(admin, MARKET_REGIONS_QUERY, {
    first: 50,
  });
  const entries = marketCountryEntriesFromResponse(data);
  if (entries.length === 0) return 0;

  for (const entry of entries) {
    await prisma.marketCountryMap.upsert({
      where: { shopId_countryCode: { shopId, countryCode: entry.countryCode } },
      create: {
        shopId,
        countryCode: entry.countryCode,
        marketHandle: entry.marketHandle,
        marketName: entry.marketName,
      },
      update: {
        marketHandle: entry.marketHandle,
        marketName: entry.marketName,
      },
    });
  }
  await prisma.marketCountryMap.deleteMany({
    where: {
      shopId,
      countryCode: { notIn: entries.map((e) => e.countryCode) },
    },
  });
  return entries.length;
}

/**
 * The market handle serving `countryCode` on this shop, null when unknown
 * (no country, no cache row) — the DEFAULT design applies. Never throws on a
 * malformed code; a DB error propagates (callers contain).
 */
export async function marketHandleForCountry(
  shopId: string,
  countryCode: string | null,
): Promise<string | null> {
  if (typeof countryCode !== "string") return null;
  const code = countryCode.trim().toUpperCase();
  if (!COUNTRY_RE.test(code)) return null;
  const row = await prisma.marketCountryMap.findUnique({
    where: { shopId_countryCode: { shopId, countryCode: code } },
    select: { marketHandle: true },
  });
  return row?.marketHandle ?? null;
}

/**
 * The whole cache as country → market handle, for loops that resolve many
 * rows against one read (the backfill's market recompute). Same semantics
 * as marketHandleForCountry: a country with no entry means "unknown" (the
 * DEFAULT design), never an error.
 */
export async function loadMarketCountryMap(
  shopId: string,
): Promise<Map<string, string>> {
  const rows = await prisma.marketCountryMap.findMany({
    where: { shopId },
    select: { countryCode: true, marketHandle: true },
  });
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.countryCode, row.marketHandle);
  return map;
}

/**
 * Distinct markets present in the cache (handle + name), for the Results
 * tab's market select when the live listMarkets read is unavailable.
 */
export async function listCachedMarkets(
  shopId: string,
): Promise<Array<{ handle: string; name: string | null }>> {
  const rows = await prisma.marketCountryMap.findMany({
    where: { shopId },
    select: { marketHandle: true, marketName: true },
    orderBy: { marketHandle: "asc" },
  });
  const byHandle = new Map<string, string | null>();
  for (const row of rows) {
    if (!byHandle.has(row.marketHandle)) {
      byHandle.set(row.marketHandle, row.marketName ?? null);
    }
  }
  return [...byHandle.entries()].map(([handle, name]) => ({ handle, name }));
}
