import {
  type AdminClient,
  type UserError,
  ensureNoUserErrors,
  gql,
} from "./client.server";

/**
 * Customer reads (portal OTP login resolves email -> customer GID here) and
 * a small locale-tag helper so Klaviyo/theme segments can key off
 * "locale:xx" tags without replacing the customer's whole tag set.
 */

// ── GraphQL documents ────────────────────────────────────────────────────────

const CUSTOMER_FIELDS = `
      id
      email
      firstName
      lastName
      phone
      locale
      tags
      defaultAddress {
        firstName
        lastName
        company
        address1
        address2
        city
        province
        provinceCode
        country
        zip
        phone
      }`;

const CUSTOMER_BY_EMAIL_QUERY = `#graphql
  query CellexiaCustomerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes {
${CUSTOMER_FIELDS}
      }
    }
  }
`;

const CUSTOMER_QUERY = `#graphql
  query CellexiaCustomer($id: ID!) {
    customer(id: $id) {
${CUSTOMER_FIELDS}
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation CellexiaCustomerTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation CellexiaCustomerTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ── Response shapes ──────────────────────────────────────────────────────────

interface RawCustomerAddress {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  provinceCode?: string | null;
  country?: string | null;
  zip?: string | null;
  phone?: string | null;
}

interface RawCustomer {
  id: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  locale?: string | null;
  tags?: string[] | null;
  defaultAddress?: RawCustomerAddress | null;
}

interface CustomerByEmailResponse {
  customers?: { nodes?: RawCustomer[] | null } | null;
}

interface CustomerResponse {
  customer?: RawCustomer | null;
}

interface TagsMutationResponse {
  tagsAdd?: { node?: { id: string } | null; userErrors?: UserError[] } | null;
  tagsRemove?: { node?: { id: string } | null; userErrors?: UserError[] } | null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ShopifyCustomer {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  locale: string | null;
  tags: string[];
  defaultAddress: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    provinceCode: string | null;
    country: string | null;
    zip: string | null;
    phone: string | null;
  } | null;
}

function normalizeCustomer(raw: RawCustomer): ShopifyCustomer {
  return {
    id: raw.id,
    email: raw.email ?? null,
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    phone: raw.phone ?? null,
    locale: raw.locale ?? null,
    tags: raw.tags ?? [],
    defaultAddress: raw.defaultAddress
      ? {
          firstName: raw.defaultAddress.firstName ?? null,
          lastName: raw.defaultAddress.lastName ?? null,
          company: raw.defaultAddress.company ?? null,
          address1: raw.defaultAddress.address1 ?? null,
          address2: raw.defaultAddress.address2 ?? null,
          city: raw.defaultAddress.city ?? null,
          province: raw.defaultAddress.province ?? null,
          provinceCode: raw.defaultAddress.provinceCode ?? null,
          country: raw.defaultAddress.country ?? null,
          zip: raw.defaultAddress.zip ?? null,
          phone: raw.defaultAddress.phone ?? null,
        }
      : null,
  };
}

/**
 * Look a customer up by exact email (portal OTP login). Returns null when no
 * customer matches.
 */
export async function getCustomerByEmail(
  admin: AdminClient,
  email: string,
): Promise<ShopifyCustomer | null> {
  // Strip characters that would break the search-query string; emails never
  // legitimately contain quotes or backslashes.
  const sanitized = email.trim().replace(/["\\]/g, "");
  if (!sanitized) return null;

  const data = await gql<CustomerByEmailResponse>(
    admin,
    CUSTOMER_BY_EMAIL_QUERY,
    { query: `email:"${sanitized}"` },
  );
  const node = data.customers?.nodes?.[0];
  return node ? normalizeCustomer(node) : null;
}

/** Fetch one customer by GID. Returns null when the GID does not resolve. */
export async function getCustomer(
  admin: AdminClient,
  customerGid: string,
): Promise<ShopifyCustomer | null> {
  const data = await gql<CustomerResponse>(admin, CUSTOMER_QUERY, {
    id: customerGid,
  });
  return data.customer ? normalizeCustomer(data.customer) : null;
}

/**
 * Keep exactly one "locale:xx" tag on the customer (adds the new one,
 * removes stale ones). Leaves all other tags untouched — never uses
 * customerUpdate, which would replace the whole tag set.
 */
export async function updateCustomerLocaleTags(
  admin: AdminClient,
  customerGid: string,
  locale: string,
): Promise<void> {
  const normalized = locale.trim().toLowerCase().split(/[-_]/)[0];
  if (!normalized) return;
  const desiredTag = `locale:${normalized}`;

  const customer = await getCustomer(admin, customerGid);
  if (!customer) {
    throw new Error(`Customer not found on Shopify: ${customerGid}`);
  }

  const staleTags = customer.tags.filter(
    (tag) => tag.toLowerCase().startsWith("locale:") && tag !== desiredTag,
  );
  const hasDesired = customer.tags.includes(desiredTag);

  if (staleTags.length > 0) {
    const data = await gql<TagsMutationResponse>(admin, TAGS_REMOVE_MUTATION, {
      id: customerGid,
      tags: staleTags,
    });
    ensureNoUserErrors("tagsRemove", data.tagsRemove);
  }

  if (!hasDesired) {
    const data = await gql<TagsMutationResponse>(admin, TAGS_ADD_MUTATION, {
      id: customerGid,
      tags: [desiredTag],
    });
    ensureNoUserErrors("tagsAdd", data.tagsAdd);
  }
}
