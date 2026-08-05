/**
 * Shopify Admin GraphQL (2025-10) — product + variant documents.
 */

export const GET_VARIANT_QUERY = /* GraphQL */ `
  query CellexiaGetVariant($id: ID!) {
    productVariant(id: $id) {
      id
      title
      price
      availableForSale
      product {
        id
        title
        handle
      }
    }
  }
`;

export const GET_PRODUCT_QUERY = /* GraphQL */ `
  query CellexiaGetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      tracksInventory
      totalInventory
    }
  }
`;

/** Batch product lookup (offers/treatment modules use this for hydration). */
export const GET_PRODUCTS_BY_IDS_QUERY = /* GraphQL */ `
  query CellexiaGetProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
        tracksInventory
        totalInventory
        featuredMedia {
          preview {
            image {
              url
            }
          }
        }
      }
    }
  }
`;

export const GET_PRODUCT_VARIANTS_QUERY = /* GraphQL */ `
  query CellexiaGetProductVariants($id: ID!, $first: Int!) {
    product(id: $id) {
      id
      variants(first: $first) {
        edges {
          node {
            id
            title
            price
            availableForSale
          }
        }
      }
    }
  }
`;
