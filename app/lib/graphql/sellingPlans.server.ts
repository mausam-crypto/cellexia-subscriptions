import { z } from "zod";
import type { SellingPlanConfig } from "@prisma/client";
import {
  type AdminClient,
  type UserError,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Selling plan group sync — turns a local SellingPlanConfig row into the
 * matching SellingPlanGroup on Shopify (create or reconcile-update).
 *
 * Offer architecture per ARCHITECTURE.md: one plan per frequency, with a
 * fixed pricing policy for the first order (cycle 0 — the fixed policy input
 * has no afterCycle field; first-order semantics are implicit) and a
 * recurring policy from cycle 1 for the ongoing discount. Optional prepaid
 * plan bills once per N deliveries at the prepaid discount.
 */

// ── Config parsing (Prisma Json fields, defensively) ─────────────────────────

const stringArraySchema = z.array(z.string());
const weeksArraySchema = z.array(z.number().int().positive());

function parseProductIds(config: SellingPlanConfig): string[] {
  const parsed = stringArraySchema.safeParse(config.productIds);
  return parsed.success ? parsed.data : [];
}

function parseFrequenciesWeeks(config: SellingPlanConfig): number[] {
  const parsed = weeksArraySchema.safeParse(config.frequenciesWeeks);
  const weeks =
    parsed.success && parsed.data.length > 0
      ? parsed.data
      : [config.defaultFrequencyWeeks];
  return [...new Set(weeks)].sort((a, b) => a - b);
}

// ── Desired plan construction ────────────────────────────────────────────────

interface DesiredSellingPlan {
  /** Stable reconcile key — the plan's single option value. */
  key: string;
  input: Record<string, unknown>;
}

function frequencyPlan(
  config: SellingPlanConfig,
  weeks: number,
  position: number,
): DesiredSellingPlan {
  const key = `Every ${weeks} weeks`;
  return {
    key,
    input: {
      name: key,
      category: "SUBSCRIPTION",
      options: [key],
      position,
      billingPolicy: {
        recurring: { interval: "WEEK", intervalCount: weeks },
      },
      deliveryPolicy: {
        recurring: { interval: "WEEK", intervalCount: weeks },
      },
      pricingPolicies: [
        {
          // Applies to the first order only (afterCycle 0 semantics are
          // implicit for fixed pricing policies in the Admin API input).
          fixed: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: config.firstOrderDiscountPct },
          },
        },
        {
          recurring: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: config.ongoingDiscountPct },
            afterCycle: 1,
          },
        },
      ],
    },
  };
}

function prepaidPlan(
  config: SellingPlanConfig,
  position: number,
): DesiredSellingPlan {
  const shipEveryWeeks = config.defaultFrequencyWeeks;
  const deliveries = Math.max(1, config.prepaidDeliveriesPerCharge);
  const key = `Every ${shipEveryWeeks} weeks, prepay ${deliveries} deliveries`;
  return {
    key,
    input: {
      name: key,
      category: "SUBSCRIPTION",
      options: [key],
      position,
      // Bill once per {deliveries} shipments; ship on the normal cadence.
      billingPolicy: {
        recurring: {
          interval: "WEEK",
          intervalCount: shipEveryWeeks * deliveries,
        },
      },
      deliveryPolicy: {
        recurring: { interval: "WEEK", intervalCount: shipEveryWeeks },
      },
      pricingPolicies: [
        {
          recurring: {
            adjustmentType: "PERCENTAGE",
            adjustmentValue: { percentage: config.prepaidDiscountPct },
            afterCycle: 0,
          },
        },
      ],
    },
  };
}

function buildDesiredPlans(config: SellingPlanConfig): DesiredSellingPlan[] {
  const plans = parseFrequenciesWeeks(config).map((weeks, i) =>
    frequencyPlan(config, weeks, i + 1),
  );
  if (config.prepaidEnabled) {
    plans.push(prepaidPlan(config, plans.length + 1));
  }
  return plans;
}

function groupInputBase(config: SellingPlanConfig): Record<string, unknown> {
  return {
    name: config.name,
    merchantCode: config.merchantCode,
    options: ["Delivery frequency"],
    position: 1,
  };
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const GROUP_QUERY = `#graphql
  query CellexiaSellingPlanGroup($id: ID!) {
    sellingPlanGroup(id: $id) {
      id
      sellingPlans(first: 50) {
        nodes {
          id
          name
          options
        }
      }
      products(first: 250) {
        nodes {
          id
        }
      }
    }
  }
`;

const GROUP_CREATE_MUTATION = `#graphql
  mutation CellexiaSellingPlanGroupCreate($input: SellingPlanGroupInput!, $resources: SellingPlanGroupResourceInput) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup {
        id
        sellingPlans(first: 50) {
          nodes {
            id
            name
            options
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GROUP_UPDATE_MUTATION = `#graphql
  mutation CellexiaSellingPlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup {
        id
        sellingPlans(first: 50) {
          nodes {
            id
            name
            options
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GROUP_ADD_PRODUCTS_MUTATION = `#graphql
  mutation CellexiaSellingPlanGroupAddProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupAddProducts(id: $id, productIds: $productIds) {
      sellingPlanGroup {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GROUP_REMOVE_PRODUCTS_MUTATION = `#graphql
  mutation CellexiaSellingPlanGroupRemoveProducts($id: ID!, $productIds: [ID!]!) {
    sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
      removedProductIds
      userErrors {
        field
        message
      }
    }
  }
`;

const GROUP_DELETE_MUTATION = `#graphql
  mutation CellexiaSellingPlanGroupDelete($id: ID!) {
    sellingPlanGroupDelete(id: $id) {
      deletedSellingPlanGroupId
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_GROUPS_QUERY = `#graphql
  query CellexiaProductSellingPlanGroups($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        sellingPlanGroups(first: 25) {
          nodes {
            id
          }
        }
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawPlanNode {
  id: string;
  name?: string | null;
  options?: string[] | null;
}

interface RawGroup {
  id: string;
  sellingPlans?: { nodes?: RawPlanNode[] | null } | null;
  products?: { nodes?: Array<{ id: string }> | null } | null;
}

interface GroupQueryResponse {
  sellingPlanGroup?: RawGroup | null;
}

interface GroupCreateResponse {
  sellingPlanGroupCreate?: {
    sellingPlanGroup?: RawGroup | null;
    userErrors?: UserError[];
  } | null;
}

interface GroupUpdateResponse {
  sellingPlanGroupUpdate?: {
    sellingPlanGroup?: RawGroup | null;
    userErrors?: UserError[];
  } | null;
}

interface GroupAddProductsResponse {
  sellingPlanGroupAddProducts?: {
    sellingPlanGroup?: { id: string } | null;
    userErrors?: UserError[];
  } | null;
}

interface GroupRemoveProductsResponse {
  sellingPlanGroupRemoveProducts?: {
    removedProductIds?: string[] | null;
    userErrors?: UserError[];
  } | null;
}

interface GroupDeleteResponse {
  sellingPlanGroupDelete?: {
    deletedSellingPlanGroupId?: string | null;
    userErrors?: UserError[];
  } | null;
}

interface ProductGroupsResponse {
  nodes?: Array<{
    id: string;
    sellingPlanGroups?: { nodes?: Array<{ id: string }> | null } | null;
  } | null> | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface SellingPlanSyncResult {
  groupId: string;
  planIds: string[];
}

/**
 * Create or reconcile the Shopify selling plan group for a config row.
 *
 * - No `shopifyGroupId` (or the group was deleted on Shopify): create the
 *   group with all plans and attach `productIds` via `resources`.
 * - Existing group: match plans by their option value ("Every N weeks"),
 *   update matches in place (keeps plan GIDs stable for live contracts),
 *   create missing, delete removed, then add/remove products to match.
 *
 * The caller owns persistence (`shopifyGroupId`, `syncStatus`) and event
 * logging — this layer only talks to Shopify.
 */
export async function syncSellingPlanGroupFromConfig(
  admin: AdminClient,
  config: SellingPlanConfig,
): Promise<SellingPlanSyncResult> {
  const productIds = parseProductIds(config);
  const desired = buildDesiredPlans(config);

  if (!config.shopifyGroupId) {
    return createGroup(admin, config, desired, productIds);
  }

  const existing = await fetchGroup(admin, config.shopifyGroupId);
  if (!existing) {
    // Group vanished on Shopify (deleted in admin) — recreate from scratch.
    return createGroup(admin, config, desired, productIds);
  }

  return updateGroup(admin, config, existing, desired, productIds);
}

/**
 * The selling plan GIDs currently inside one group. Used to repair the
 * ownership evidence (`SellingPlanConfig.shopifyPlanIds`) for a config that was
 * synced before plan ids were persisted, without forcing a full re-sync.
 * Returns [] when the group no longer exists on Shopify.
 */
export async function getSellingPlanGroupPlanIds(
  admin: AdminClient,
  groupId: string,
): Promise<string[]> {
  const group = await fetchGroup(admin, groupId);
  return planIdsOf(group);
}

/**
 * Products the `nodes(ids:)` query reads per round trip. Each product carries
 * a 25-item sellingPlanGroups connection, so 25 products keeps a single query
 * comfortably under Shopify's 1000-point single-query cost ceiling.
 */
const ATTACHMENT_QUERY_BATCH = 25;

/**
 * Attachment verification — which of `productIds` do NOT currently carry the
 * selling plan group `groupId` on Shopify?
 *
 * WHY THIS EXISTS. `sellingPlanGroupAddProducts` returning without userErrors
 * is not proof the storefront agrees: another subscription app's own product
 * sync can detach our group from products it also manages (observed live with
 * Joy on the merchant's store), and a deleted product simply vanishes. A
 * config must never sit at SYNCED while the product page has nothing of ours
 * to render — so the sync flow verifies after attaching, and the daily drift
 * check re-verifies, both through this one function.
 *
 * Deliberately in ADMIN id space end to end: the product GIDs come from the
 * config, the group GID from the sync result, and the query returns admin
 * GIDs — exact string equality is reliable here. (Storefront Liquid exposes
 * GROUP ids in a different, opaque id space — that comparison lives in the
 * buy box and matches on PLAN ids instead; never mix the two id spaces.)
 *
 * A product that cannot be read back (null node — deleted, or not a Product)
 * counts as MISSING: the group is provably not attached to anything a
 * customer can buy under that id. Throws on transport/GraphQL errors — the
 * caller decides what an unverifiable state means for it.
 */
export async function findProductsMissingFromGroup(
  admin: AdminClient,
  groupId: string,
  productIds: string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < productIds.length; i += ATTACHMENT_QUERY_BATCH) {
    const chunk = productIds.slice(i, i + ATTACHMENT_QUERY_BATCH);
    const data = await gql<ProductGroupsResponse>(admin, PRODUCT_GROUPS_QUERY, {
      ids: chunk,
    });
    const attachedById = new Map<string, boolean>();
    for (const node of data.nodes ?? []) {
      if (!node?.id) continue;
      const groups = node.sellingPlanGroups?.nodes ?? [];
      attachedById.set(node.id, groups.some((g) => g.id === groupId));
    }
    for (const productId of chunk) {
      if (attachedById.get(productId) !== true) missing.push(productId);
    }
  }
  return missing;
}

/** Delete the group on Shopify (plans go with it). Returns the deleted GID. */
export async function deleteSellingPlanGroup(
  admin: AdminClient,
  groupId: string,
): Promise<string> {
  const data = await gql<GroupDeleteResponse>(admin, GROUP_DELETE_MUTATION, {
    id: groupId,
  });
  ensureNoUserErrors("sellingPlanGroupDelete", data.sellingPlanGroupDelete);
  return data.sellingPlanGroupDelete?.deletedSellingPlanGroupId ?? groupId;
}

// ── Internals ────────────────────────────────────────────────────────────────

async function fetchGroup(
  admin: AdminClient,
  groupId: string,
): Promise<RawGroup | null> {
  const data = await gql<GroupQueryResponse>(admin, GROUP_QUERY, {
    id: groupId,
  });
  return data.sellingPlanGroup ?? null;
}

function planIdsOf(group: RawGroup | null | undefined): string[] {
  return (group?.sellingPlans?.nodes ?? []).map((n) => n.id);
}

function planKey(plan: RawPlanNode): string {
  return plan.options?.[0] ?? plan.name ?? plan.id;
}

async function createGroup(
  admin: AdminClient,
  config: SellingPlanConfig,
  desired: DesiredSellingPlan[],
  productIds: string[],
): Promise<SellingPlanSyncResult> {
  const data = await gql<GroupCreateResponse>(admin, GROUP_CREATE_MUTATION, {
    input: {
      ...groupInputBase(config),
      sellingPlansToCreate: desired.map((d) => d.input),
    },
    resources: { productIds },
  });
  ensureNoUserErrors("sellingPlanGroupCreate", data.sellingPlanGroupCreate);
  const group = data.sellingPlanGroupCreate?.sellingPlanGroup;
  if (!group?.id) {
    throw new Error("sellingPlanGroupCreate returned no selling plan group");
  }
  return { groupId: group.id, planIds: planIdsOf(group) };
}

async function updateGroup(
  admin: AdminClient,
  config: SellingPlanConfig,
  existing: RawGroup,
  desired: DesiredSellingPlan[],
  productIds: string[],
): Promise<SellingPlanSyncResult> {
  const existingPlans = existing.sellingPlans?.nodes ?? [];
  const existingByKey = new Map(existingPlans.map((p) => [planKey(p), p]));
  const desiredKeys = new Set(desired.map((d) => d.key));

  const sellingPlansToCreate = desired
    .filter((d) => !existingByKey.has(d.key))
    .map((d) => d.input);
  const sellingPlansToUpdate = desired
    .filter((d) => existingByKey.has(d.key))
    .map((d) => ({ ...d.input, id: existingByKey.get(d.key)!.id }));
  const sellingPlansToDelete = existingPlans
    .filter((p) => !desiredKeys.has(planKey(p)))
    .map((p) => p.id);

  const data = await gql<GroupUpdateResponse>(admin, GROUP_UPDATE_MUTATION, {
    id: existing.id,
    input: {
      ...groupInputBase(config),
      sellingPlansToCreate,
      sellingPlansToUpdate,
      sellingPlansToDelete,
    },
  });
  ensureNoUserErrors("sellingPlanGroupUpdate", data.sellingPlanGroupUpdate);
  const group = data.sellingPlanGroupUpdate?.sellingPlanGroup;
  if (!group?.id) {
    throw new Error("sellingPlanGroupUpdate returned no selling plan group");
  }

  await reconcileProducts(admin, group.id, existing, productIds);

  return { groupId: group.id, planIds: planIdsOf(group) };
}

async function reconcileProducts(
  admin: AdminClient,
  groupId: string,
  existing: RawGroup,
  desiredProductIds: string[],
): Promise<void> {
  const current = new Set((existing.products?.nodes ?? []).map((n) => n.id));
  const desired = new Set(desiredProductIds);

  const toAdd = desiredProductIds.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !desired.has(id));

  if (toAdd.length > 0) {
    const data = await gql<GroupAddProductsResponse>(
      admin,
      GROUP_ADD_PRODUCTS_MUTATION,
      { id: groupId, productIds: toAdd },
    );
    ensureNoUserErrors(
      "sellingPlanGroupAddProducts",
      data.sellingPlanGroupAddProducts,
    );
  }

  if (toRemove.length > 0) {
    const data = await gql<GroupRemoveProductsResponse>(
      admin,
      GROUP_REMOVE_PRODUCTS_MUTATION,
      { id: groupId, productIds: toRemove },
    );
    ensureNoUserErrors(
      "sellingPlanGroupRemoveProducts",
      data.sellingPlanGroupRemoveProducts,
    );
  }
}
