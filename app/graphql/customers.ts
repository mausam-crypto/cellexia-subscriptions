/**
 * Shopify Admin GraphQL (2025-10) — customer + payment method documents.
 */

export const GET_CUSTOMER_QUERY = /* GraphQL */ `
  query CellexiaGetCustomer($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      lastName
    }
  }
`;

export const GET_CUSTOMER_PAYMENT_METHOD_QUERY = /* GraphQL */ `
  query CellexiaGetCustomerPaymentMethod($id: ID!) {
    customerPaymentMethod(id: $id) {
      id
      customer {
        id
      }
      instrument {
        ... on CustomerCreditCard {
          brand
          lastDigits
          expiryMonth
          expiryYear
        }
      }
    }
  }
`;

export const CUSTOMER_PAYMENT_METHOD_SEND_UPDATE_EMAIL_MUTATION = /* GraphQL */ `
  mutation CellexiaSendPaymentUpdateEmail($customerPaymentMethodId: ID!) {
    customerPaymentMethodSendUpdateEmail(
      customerPaymentMethodId: $customerPaymentMethodId
    ) {
      customer {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
