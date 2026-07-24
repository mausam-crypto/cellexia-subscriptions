import {
  type AdminClient,
  centsFromMoney,
  centsFromMoneyOrZero,
  gql,
} from "./client.server";

/**
 * Product and variant reads: pricing (incl. COGS for LTGP math), stock for
 * the stockout policy, admin picker search, and the set of products already
 * attached to selling plan groups.
 *
 * Note: ProductVariant.price / compareAtPrice are bare decimal strings in
 * the Admin API; inventoryItem.unitCost is MoneyV2. Both funnel through
 * ~/lib/money at this boundary.
 */

const NODE_BATCH_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ── GraphQL documents ────────────────────────────────────────────────────────

const VARIANTS_QUERY = `#graphql
  query CellexiaVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on ProductVariant {
        id
        title
        sku
        price
        compareAtPrice
        availableForSale
        inventoryQuantity
        image {
          url
        }
        product {
          id
          title
          status
          featuredImage {
            url
          }
        }
        inventoryItem {
          unitCost {
            amount
            currencyCode
          }
        }
      }
    }
  }
`;

const PRODUCTS_QUERY = `#graphql
  query CellexiaProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id
        title
        handle
        status
        totalInventory
        featuredImage {
          url
        }
      }
    }
  }
`;

const PRODUCT_SEARCH_QUERY = `#graphql
  query CellexiaProductSearch($query: String!, $first: Int!) {
    products(first: $first, query: $query) {
      nodes {
        id
        title
        status
        featuredImage {
          url
        }
        variants(first: 10) {
          nodes {
            id
            title
            sku
            price
            availableForSale
          }
        }
      }
    }
  }
`;

const SUBSCRIBABLE_PRODUCTS_QUERY = `#graphql
  query CellexiaSubscribableProducts {
    sellingPlanGroups(first: 10) {
      nodes {
        id
        name
        products(first: 50) {
          nodes {
            id
            title
            handle
            featuredImage {
              url
            }
          }
        }
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawVariantNode {
  __typename?: string | null;
  id?: string | null;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  availableForSale?: boolean | null;
  inventoryQuantity?: number | null;
  image?: { url?: string | null } | null;
  product?: {
    id?: string | null;
    title?: string | null;
    status?: string | null;
    featuredImage?: { url?: string | null } | null;
  } | null;
  inventoryItem?: {
    unitCost?: { amount?: string | null; currencyCode?: string | null } | null;
  } | null;
}

interface VariantsResponse {
  nodes?: Array<RawVariantNode | null> | null;
}

interface RawProductNode {
  __typename?: string | null;
  id?: string | null;
  title?: string | null;
  handle?: string | null;
  status?: string | null;
  totalInventory?: number | null;
  featuredImage?: { url?: string | null } | null;
}

interface ProductsResponse {
  nodes?: Array<RawProductNode | null> | null;
}

interface RawSearchVariant {
  id: string;
  title?: string | null;
  sku?: string | null;
  price?: string | null;
  availableForSale?: boolean | null;
}

interface ProductSearchResponse {
  products?: {
    nodes?: Array<{
      id: string;
      title?: string | null;
      status?: string | null;
      featuredImage?: { url?: string | null } | null;
      variants?: { nodes?: RawSearchVariant[] | null } | null;
    }> | null;
  } | null;
}

interface SubscribableProductsResponse {
  sellingPlanGroups?: {
    nodes?: Array<{
      id: string;
      name?: string | null;
      products?: {
        nodes?: Array<{
          id: string;
          title?: string | null;
          handle?: string | null;
          featuredImage?: { url?: string | null } | null;
        }> | null;
      } | null;
    }> | null;
  } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ShopifyVariant {
  id: string;
  title: string;
  sku: string | null;
  productId: string | null;
  productTitle: string;
  productStatus: string | null;
  priceCents: number;
  compareAtPriceCents: number | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  imageUrl: string | null;
  /** COGS from inventoryItem.unitCost — feeds LTGP; null when not set. */
  unitCostCents: number | null;
}

/** Batch-fetch variants by GID. Missing/deleted GIDs are silently dropped. */
export async function getVariants(
  admin: AdminClient,
  variantGids: string[],
): Promise<ShopifyVariant[]> {
  if (variantGids.length === 0) return [];
  const out: ShopifyVariant[] = [];

  for (const batch of chunk(variantGids, NODE_BATCH_SIZE)) {
    const data = await gql<VariantsResponse>(admin, VARIANTS_QUERY, {
      ids: batch,
    });
    for (const node of data.nodes ?? []) {
      if (!node?.id || node.__typename !== "ProductVariant") continue;
      out.push({
        id: node.id,
        title: node.title ?? "",
        sku: node.sku ?? null,
        productId: node.product?.id ?? null,
        productTitle: node.product?.title ?? "",
        productStatus: node.product?.status ?? null,
        priceCents: centsFromMoneyOrZero(node.price),
        compareAtPriceCents: centsFromMoney(node.compareAtPrice),
        availableForSale: node.availableForSale ?? false,
        inventoryQuantity: node.inventoryQuantity ?? null,
        imageUrl: node.image?.url ?? node.product?.featuredImage?.url ?? null,
        unitCostCents: centsFromMoney(node.inventoryItem?.unitCost),
      });
    }
  }
  return out;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string | null;
  status: string | null;
  totalInventory: number | null;
  featuredImageUrl: string | null;
}

/** Batch-fetch products by GID. Missing/deleted GIDs are silently dropped. */
export async function getProducts(
  admin: AdminClient,
  productGids: string[],
): Promise<ShopifyProduct[]> {
  if (productGids.length === 0) return [];
  const out: ShopifyProduct[] = [];

  for (const batch of chunk(productGids, NODE_BATCH_SIZE)) {
    const data = await gql<ProductsResponse>(admin, PRODUCTS_QUERY, {
      ids: batch,
    });
    for (const node of data.nodes ?? []) {
      if (!node?.id || node.__typename !== "Product") continue;
      out.push({
        id: node.id,
        title: node.title ?? "",
        handle: node.handle ?? null,
        status: node.status ?? null,
        totalInventory: node.totalInventory ?? null,
        featuredImageUrl: node.featuredImage?.url ?? null,
      });
    }
  }
  return out;
}

export interface ProductSearchResult {
  id: string;
  title: string;
  status: string | null;
  featuredImageUrl: string | null;
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    priceCents: number;
    availableForSale: boolean;
  }>;
}

/** Free-text product search for admin pickers (plan config, gifts, swaps). */
export async function searchProducts(
  admin: AdminClient,
  query: string,
  first = 20,
): Promise<ProductSearchResult[]> {
  const data = await gql<ProductSearchResponse>(admin, PRODUCT_SEARCH_QUERY, {
    query,
    first,
  });
  return (data.products?.nodes ?? []).map((node) => ({
    id: node.id,
    title: node.title ?? "",
    status: node.status ?? null,
    featuredImageUrl: node.featuredImage?.url ?? null,
    variants: (node.variants?.nodes ?? []).map((v) => ({
      id: v.id,
      title: v.title ?? "",
      sku: v.sku ?? null,
      priceCents: centsFromMoneyOrZero(v.price),
      availableForSale: v.availableForSale ?? false,
    })),
  }));
}

export interface SubscribableProduct {
  id: string;
  title: string;
  handle: string | null;
  featuredImageUrl: string | null;
  sellingPlanGroupIds: string[];
}

/**
 * Products currently attached to any selling plan group (first 50 per group),
 * deduped across groups. Powers take-rate denominators and the buy-box audit.
 */
export async function getSubscribableProducts(
  admin: AdminClient,
): Promise<SubscribableProduct[]> {
  const data = await gql<SubscribableProductsResponse>(
    admin,
    SUBSCRIBABLE_PRODUCTS_QUERY,
  );

  const byId = new Map<string, SubscribableProduct>();
  for (const group of data.sellingPlanGroups?.nodes ?? []) {
    for (const product of group.products?.nodes ?? []) {
      const existing = byId.get(product.id);
      if (existing) {
        if (!existing.sellingPlanGroupIds.includes(group.id)) {
          existing.sellingPlanGroupIds.push(group.id);
        }
        continue;
      }
      byId.set(product.id, {
        id: product.id,
        title: product.title ?? "",
        handle: product.handle ?? null,
        featuredImageUrl: product.featuredImage?.url ?? null,
        sellingPlanGroupIds: [group.id],
      });
    }
  }
  return [...byId.values()];
}
