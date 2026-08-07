import { getSellingPlanGroupSummaries } from "~/lib/graphql/products.server";
import type { AdminClient } from "~/lib/graphql/client.server";
import { getOwnGroupIds, numericIdFromGid } from "./ownership.server";

/**
 * Foreign selling plan groups — the storefront half of the ownership model,
 * surfaced for the admin.
 *
 * `SubscriptionContract.ownership` answers "whose subscribers are these?".
 * This module answers the question that comes first in time: "whose subscribe
 * option is on my product page?". A store running a second subscription app
 * (cellexialabs.com runs Joy Subscriptions) has that app's selling plan group
 * attached to the same products ours is — both widgets render, the customer
 * picks whichever one they see, and the resulting contract belongs to whoever
 * owned the selling plan.
 *
 * Nothing here changes behaviour; it is read-only reporting so the merchant
 * can see the situation on the Preview & launch page (and per plan config on
 * the Plans page) instead of discovering it from a customer complaint.
 *
 * Every read is contained: a Shopify failure yields `readable: false` and an
 * empty list, never a thrown loader.
 */

export interface ForeignGroupProduct {
  id: string;
  title: string;
  handle: string | null;
}

export interface ForeignGroup {
  /** Full GID of the group. */
  id: string;
  /** Numeric id — the form Liquid's `group.id` yields. */
  numericId: string | null;
  name: string;
  /** The app that created it, when Shopify exposes it. */
  appId: string | null;
  merchantCode: string | null;
  summary: string | null;
  /** Subscribable products this foreign group is attached to. */
  products: ForeignGroupProduct[];
}

export interface ForeignGroupScan {
  /** False when Shopify could not be read — claim nothing in that case. */
  readable: boolean;
  /** Groups on the shop that are NOT ours. */
  foreignGroups: ForeignGroup[];
  /** Our own group GIDs, for callers that want to show both sides. */
  ownGroupIds: string[];
  /** productId → foreign groups attached to it. */
  foreignGroupsByProduct: Map<string, ForeignGroup[]>;
  error?: string;
}

const EMPTY_SCAN: ForeignGroupScan = {
  readable: false,
  foreignGroups: [],
  ownGroupIds: [],
  foreignGroupsByProduct: new Map(),
};

/**
 * Every selling plan group on the shop that this app did not create, with the
 * products each is attached to.
 *
 * "Ours" is decided by `SellingPlanConfig.shopifyGroupId` (both GID and numeric
 * forms compared, since the two id shapes appear in different places) — the
 * same source of truth the storefront allow-list metafield is built from, so
 * the admin card and the buy box can never disagree about which group is ours.
 */
export async function scanForeignSellingPlanGroups(
  admin: AdminClient,
  shopId: string,
): Promise<ForeignGroupScan> {
  let own: { gids: string[]; numericIds: string[] };
  try {
    own = await getOwnGroupIds(shopId);
  } catch (err) {
    console.error("[ownership] own group id lookup failed", err);
    return { ...EMPTY_SCAN, error: String(err) };
  }

  const ownIdForms = new Set<string>([...own.gids, ...own.numericIds]);

  let groups: Awaited<ReturnType<typeof getSellingPlanGroupSummaries>>;
  try {
    groups = await getSellingPlanGroupSummaries(admin);
  } catch (err) {
    // A Shopify hiccup must never make the page claim "no other app here" —
    // readable:false means "we don't know", and the UI says nothing.
    console.error("[ownership] selling plan group scan failed", err);
    return {
      ...EMPTY_SCAN,
      ownGroupIds: own.gids,
      foreignGroupsByProduct: new Map(),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const foreignGroups: ForeignGroup[] = [];
  const foreignGroupsByProduct = new Map<string, ForeignGroup[]>();

  for (const group of groups) {
    const numericId = numericIdFromGid(group.id);
    const isOurs =
      ownIdForms.has(group.id) || (numericId != null && ownIdForms.has(numericId));
    if (isOurs) continue;

    const foreign: ForeignGroup = {
      id: group.id,
      numericId,
      name: group.name,
      appId: group.appId,
      merchantCode: group.merchantCode,
      summary: group.summary,
      products: group.products.map((p) => ({
        id: p.id,
        title: p.title,
        handle: p.handle,
      })),
    };
    foreignGroups.push(foreign);

    for (const product of foreign.products) {
      const list = foreignGroupsByProduct.get(product.id);
      if (list) list.push(foreign);
      else foreignGroupsByProduct.set(product.id, [foreign]);
    }
  }

  return {
    readable: true,
    foreignGroups,
    ownGroupIds: own.gids,
    foreignGroupsByProduct,
  };
}

/** Serializable shape for a Remix loader (Map → plain record). */
export interface ForeignGroupScanJson {
  readable: boolean;
  foreignGroups: ForeignGroup[];
  /** productId → foreign group names attached to it. */
  foreignGroupNamesByProduct: Record<string, string[]>;
}

export function toForeignGroupScanJson(
  scan: ForeignGroupScan,
): ForeignGroupScanJson {
  const foreignGroupNamesByProduct: Record<string, string[]> = {};
  for (const [productId, groups] of scan.foreignGroupsByProduct) {
    foreignGroupNamesByProduct[productId] = groups.map(
      (g) => g.name || g.merchantCode || g.id,
    );
  }
  return {
    readable: scan.readable,
    foreignGroups: scan.foreignGroups,
    foreignGroupNamesByProduct,
  };
}
