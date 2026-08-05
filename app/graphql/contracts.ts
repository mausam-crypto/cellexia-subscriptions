/**
 * Shopify Admin GraphQL (2025-10) — subscription contract documents.
 * All modules import their documents from app/graphql/*; never inline GraphQL.
 */

export const CONTRACT_FIELDS_FRAGMENT = /* GraphQL */ `
  fragment CellexiaContractFields on SubscriptionContract {
    id
    status
    createdAt
    updatedAt
    nextBillingDate
    note
    customAttributes {
      key
      value
    }
    currencyCode
    customer {
      id
      email
      firstName
      lastName
    }
    customerPaymentMethod {
      id
      instrument {
        ... on CustomerCreditCard {
          brand
          lastDigits
          expiryMonth
          expiryYear
        }
      }
    }
    billingPolicy {
      interval
      intervalCount
    }
    deliveryPolicy {
      interval
      intervalCount
    }
    deliveryMethod {
      ... on SubscriptionDeliveryMethodShipping {
        address {
          firstName
          lastName
          company
          address1
          address2
          city
          province
          provinceCode
          country
          countryCode
          zip
          phone
        }
      }
    }
    originOrder {
      id
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
    lines(first: 100) {
      edges {
        node {
          id
          productId
          variantId
          title
          quantity
          currentPrice {
            amount
            currencyCode
          }
          sellingPlanId
          sellingPlanName
        }
      }
    }
  }
`;

export const GET_CONTRACT_QUERY = /* GraphQL */ `
  query CellexiaGetContract($id: ID!) {
    subscriptionContract(id: $id) {
      ...CellexiaContractFields
    }
  }
  ${CONTRACT_FIELDS_FRAGMENT}
`;

// ─────────────────────────── Draft workflow ────────────────────────────────

export const SUBSCRIPTION_CONTRACT_UPDATE_MUTATION = /* GraphQL */ `
  mutation CellexiaContractUpdate($contractId: ID!) {
    subscriptionContractUpdate(contractId: $contractId) {
      draft {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_COMMIT_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftCommit($draftId: ID!) {
    subscriptionDraftCommit(draftId: $draftId) {
      contract {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_UPDATE_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
    subscriptionDraftUpdate(draftId: $draftId, input: $input) {
      draft {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_LINE_ADD_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftLineAdd($draftId: ID!, $input: SubscriptionLineInput!) {
    subscriptionDraftLineAdd(draftId: $draftId, input: $input) {
      lineAdded {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_LINE_UPDATE_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftLineUpdate(
    $draftId: ID!
    $lineId: ID!
    $input: SubscriptionLineUpdateInput!
  ) {
    subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
      lineUpdated {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftLineRemove($draftId: ID!, $lineId: ID!) {
    subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) {
      lineRemoved {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_DRAFT_DISCOUNT_ADD_MUTATION = /* GraphQL */ `
  mutation CellexiaDraftDiscountAdd(
    $draftId: ID!
    $input: SubscriptionManualDiscountInput!
  ) {
    subscriptionDraftDiscountAdd(draftId: $draftId, input: $input) {
      discountAdded {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─────────────────────────── Status mutations ──────────────────────────────

export const SUBSCRIPTION_CONTRACT_PAUSE_MUTATION = /* GraphQL */ `
  mutation CellexiaContractPause($subscriptionContractId: ID!) {
    subscriptionContractPause(subscriptionContractId: $subscriptionContractId) {
      contract {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_CONTRACT_ACTIVATE_MUTATION = /* GraphQL */ `
  mutation CellexiaContractActivate($subscriptionContractId: ID!) {
    subscriptionContractActivate(subscriptionContractId: $subscriptionContractId) {
      contract {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_CONTRACT_CANCEL_MUTATION = /* GraphQL */ `
  mutation CellexiaContractCancel($subscriptionContractId: ID!) {
    subscriptionContractCancel(subscriptionContractId: $subscriptionContractId) {
      contract {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_CONTRACT_SET_NEXT_BILLING_DATE_MUTATION = /* GraphQL */ `
  mutation CellexiaSetNextBillingDate($contractId: ID!, $date: DateTime!) {
    subscriptionContractSetNextBillingDate(contractId: $contractId, date: $date) {
      contract {
        id
        nextBillingDate
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─────────────────────────── Billing cycles ────────────────────────────────

export const SUBSCRIPTION_BILLING_CYCLE_SKIP_MUTATION = /* GraphQL */ `
  mutation CellexiaBillingCycleSkip($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleSkip(billingCycleInput: $billingCycleInput) {
      billingCycle {
        cycleIndex
        skipped
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_BILLING_CYCLE_UNSKIP_MUTATION = /* GraphQL */ `
  mutation CellexiaBillingCycleUnskip($billingCycleInput: SubscriptionBillingCycleInput!) {
    subscriptionBillingCycleUnskip(billingCycleInput: $billingCycleInput) {
      billingCycle {
        cycleIndex
        skipped
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const SUBSCRIPTION_BILLING_CYCLE_SCHEDULE_EDIT_MUTATION = /* GraphQL */ `
  mutation CellexiaBillingCycleScheduleEdit(
    $billingCycleInput: SubscriptionBillingCycleInput!
    $input: SubscriptionBillingCycleScheduleEditInput!
  ) {
    subscriptionBillingCycleScheduleEdit(
      billingCycleInput: $billingCycleInput
      input: $input
    ) {
      billingCycle {
        cycleIndex
        skipped
        billingAttemptExpectedDate
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─────────────────────────── Contract creation (split) ─────────────────────

export const SUBSCRIPTION_CONTRACT_ATOMIC_CREATE_MUTATION = /* GraphQL */ `
  mutation CellexiaContractAtomicCreate($input: SubscriptionContractAtomicCreateInput!) {
    subscriptionContractAtomicCreate(input: $input) {
      contract {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
