/**
 * Typed Admin GraphQL API layer — the only place the app talks to Shopify.
 *
 * Import from "~/lib/graphql/index.server" (or the individual modules).
 * All mutations validate `userErrors` and throw ShopifyUserError; all money
 * crosses this boundary as integer cents; all IDs are full GIDs.
 */

export * from "./client.server";
export * from "./sellingPlans.server";
export * from "./contracts.server";
export * from "./billingCycles.server";
export * from "./paymentMethods.server";
export * from "./products.server";
export * from "./orders.server";
export * from "./customers.server";
export * from "./metafields.server";
export * from "./markets.server";
export * from "./appInstallation.server";
