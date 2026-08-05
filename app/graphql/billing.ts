/**
 * Shopify Admin GraphQL (2025-10) — billing attempt documents.
 */

export const SUBSCRIPTION_BILLING_ATTEMPT_CREATE_MUTATION = /* GraphQL */ `
  mutation CellexiaBillingAttemptCreate(
    $subscriptionContractId: ID!
    $subscriptionBillingAttemptInput: SubscriptionBillingAttemptInput!
  ) {
    subscriptionBillingAttemptCreate(
      subscriptionContractId: $subscriptionContractId
      subscriptionBillingAttemptInput: $subscriptionBillingAttemptInput
    ) {
      subscriptionBillingAttempt {
        id
        ready
        idempotencyKey
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_BILLING_ATTEMPT_QUERY = /* GraphQL */ `
  query CellexiaGetBillingAttempt($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      ready
      idempotencyKey
      errorCode
      errorMessage
      order {
        id
      }
    }
  }
`;

/** Single order lookup — used by webhook handlers to price a charge. */
export const GET_ORDER_TOTAL_QUERY = /* GraphQL */ `
  query CellexiaGetOrderTotal($id: ID!) {
    order(id: $id) {
      id
      createdAt
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

/** Paged orders scan for reconciliation. */
export const RECONCILE_ORDERS_QUERY = /* GraphQL */ `
  query CellexiaReconcileOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          name
          createdAt
          sourceName
          tags
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          customer {
            id
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;
