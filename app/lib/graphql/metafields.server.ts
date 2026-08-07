import {
  type AdminClient,
  type UserError,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Shop metafield reads/writes. Used to mirror app state into Liquid-readable
 * metafields — e.g. cellexia.launch_status ("setup" | "live") so the theme
 * app extension can render dark until the merchant explicitly goes live.
 */

// ── GraphQL documents ────────────────────────────────────────────────────────

const SHOP_ID_QUERY = `#graphql
  query CellexiaShopId {
    shop {
      id
    }
  }
`;

const SHOP_METAFIELD_QUERY = `#graphql
  query CellexiaShopMetafield($namespace: String!, $key: String!) {
    shop {
      metafield(namespace: $namespace, key: $key) {
        id
        namespace
        key
        type
        value
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `#graphql
  mutation CellexiaMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        type
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawMetafield {
  id: string;
  namespace?: string | null;
  key?: string | null;
  type?: string | null;
  value?: string | null;
}

interface ShopIdResponse {
  shop?: { id?: string | null } | null;
}

interface ShopMetafieldResponse {
  shop?: { metafield?: RawMetafield | null } | null;
}

interface MetafieldsSetResponse {
  metafieldsSet?: {
    metafields?: RawMetafield[] | null;
    userErrors?: UserError[];
  } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ShopMetafield {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
}

export interface SetShopMetafieldInput {
  namespace: string;
  key: string;
  /** Metafield definition type, e.g. "single_line_text_field". */
  type: string;
  value: string;
}

/** The shop's own GID (metafieldsSet needs an explicit ownerId). */
async function getShopGid(admin: AdminClient): Promise<string> {
  const data = await gql<ShopIdResponse>(admin, SHOP_ID_QUERY);
  const id = data.shop?.id;
  if (!id) throw new Error("Shopify GraphQL error: shop id not resolved");
  return id;
}

/** Upsert one shop-owned metafield; returns the resulting metafield. */
export async function setShopMetafield(
  admin: AdminClient,
  input: SetShopMetafieldInput,
): Promise<ShopMetafield> {
  const ownerId = await getShopGid(admin);
  const data = await gql<MetafieldsSetResponse>(admin, METAFIELDS_SET_MUTATION, {
    metafields: [
      {
        ownerId,
        namespace: input.namespace,
        key: input.key,
        type: input.type,
        value: input.value,
      },
    ],
  });
  ensureNoUserErrors("metafieldsSet", data.metafieldsSet);

  const raw = data.metafieldsSet?.metafields?.[0];
  if (!raw) {
    throw new Error("Shopify GraphQL error: metafieldsSet returned no metafield");
  }
  return {
    id: raw.id,
    namespace: raw.namespace ?? input.namespace,
    key: raw.key ?? input.key,
    type: raw.type ?? input.type,
    value: raw.value ?? input.value,
  };
}

/** Read one shop-owned metafield. Returns null when it does not exist. */
export async function getShopMetafield(
  admin: AdminClient,
  namespace: string,
  key: string,
): Promise<ShopMetafield | null> {
  const data = await gql<ShopMetafieldResponse>(admin, SHOP_METAFIELD_QUERY, {
    namespace,
    key,
  });
  const raw = data.shop?.metafield;
  if (!raw) return null;
  return {
    id: raw.id,
    namespace: raw.namespace ?? namespace,
    key: raw.key ?? key,
    type: raw.type ?? "",
    value: raw.value ?? "",
  };
}
