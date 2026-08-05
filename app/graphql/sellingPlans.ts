/**
 * Shopify Admin GraphQL (2025-10) — selling plan group documents.
 */

export const SELLING_PLAN_GROUP_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment CellexiaSellingPlanGroupFields on SellingPlanGroup {
    id
    name
    merchantCode
    sellingPlans(first: 25) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

export const SELLING_PLAN_GROUP_CREATE_MUTATION = /* GraphQL */ `
  mutation CellexiaSellingPlanGroupCreate(
    $input: SellingPlanGroupInput!
    $resources: SellingPlanGroupResourceInput
  ) {
    sellingPlanGroupCreate(input: $input, resources: $resources) {
      sellingPlanGroup {
        ...CellexiaSellingPlanGroupFields
      }
      userErrors {
        field
        message
      }
    }
  }
  ${SELLING_PLAN_GROUP_FIELDS_FRAGMENT}
`;

export const SELLING_PLAN_GROUP_UPDATE_MUTATION = /* GraphQL */ `
  mutation CellexiaSellingPlanGroupUpdate($id: ID!, $input: SellingPlanGroupInput!) {
    sellingPlanGroupUpdate(id: $id, input: $input) {
      sellingPlanGroup {
        ...CellexiaSellingPlanGroupFields
      }
      userErrors {
        field
        message
      }
    }
  }
  ${SELLING_PLAN_GROUP_FIELDS_FRAGMENT}
`;

export const SELLING_PLAN_GROUP_ADD_PRODUCTS_MUTATION = /* GraphQL */ `
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

export const GET_SELLING_PLAN_GROUP_QUERY = /* GraphQL */ `
  query CellexiaGetSellingPlanGroup($id: ID!) {
    sellingPlanGroup(id: $id) {
      ...CellexiaSellingPlanGroupFields
    }
  }
  ${SELLING_PLAN_GROUP_FIELDS_FRAGMENT}
`;
