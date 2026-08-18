/**
 * Trusted-redirect gate for Shopify-hosted hand-offs (3DS challenge pages,
 * card-update pages). Only https URLs on shopify.com / myshopify.com
 * (dot-boundary) may be handed off. Isomorphic and dependency-free so the
 * portal's 3DS verb can share it without loading the magic-link executor.
 */
export function isTrustedShopifyRedirect(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "shopify.com" ||
    host.endsWith(".shopify.com") ||
    host === "myshopify.com" ||
    host.endsWith(".myshopify.com")
  );
}
