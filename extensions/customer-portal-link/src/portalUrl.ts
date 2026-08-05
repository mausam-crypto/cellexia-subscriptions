/**
 * Pure URL logic for the portal hand-off link — no I/O, no Shopify imports,
 * so it stays unit-testable from the root vitest suite
 * (tests/account-ext.portalUrl.test.ts).
 */

/**
 * App-proxy path that hands a logged-in customer into the treatment portal.
 * Shopify forwards https://<shop-domain>/apps/cellexia-subscriptions/portal-link
 * to the app's /proxy/portal-link route with a verified `logged_in_customer_id`.
 * Must match [app_proxy].subpath in shopify.app.toml — "cellexia" alone is
 * already owned by the AOV & LTV Booster app's proxy on this store.
 */
export const PORTAL_HANDOFF_PATH = "/apps/cellexia-subscriptions/portal-link";

/**
 * Build the hand-off URL from the shop's storefront URL when the extension
 * API provides one; otherwise fall back to a relative path (resolved against
 * the shop domain by the customer-accounts navigation layer).
 */
export function buildPortalHandoffUrl(
  storefrontUrl?: string | null,
): string {
  const trimmed = storefrontUrl?.trim();
  if (!trimmed) return PORTAL_HANDOFF_PATH;
  // Tolerate a trailing slash on the origin ("https://shop.example.com/").
  return trimmed.replace(/\/+$/, "") + PORTAL_HANDOFF_PATH;
}
