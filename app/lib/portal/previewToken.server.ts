import { signValue, verifySignedValue } from "~/lib/portal/session.server";

/**
 * Stateless, signed admin-preview token for the customer portal ("cx_pp"
 * query parameter).
 *
 * WHY A TOKEN IN THE URL IS ACCEPTABLE HERE — AND ONLY HERE. Shopify's app
 * proxy strips the Cookie request header and the Set-Cookie response header
 * in both directions, so on a live store the portal's HttpOnly cx_portal
 * cookie can never be set or read through /apps/cellexia-subs. The admin
 * "Preview the portal" flow therefore needs an identity that rides the URL.
 * That is safe for THIS credential because it is everything the customer
 * session token is not:
 *
 *  - Admin-initiated and view-only: the session it opens is isPreview, and
 *    every mutating portal action is intercepted before it executes (api
 *    dispatcher, cancel flow) — a leaked link can read a demo/preview portal,
 *    never change anything.
 *  - Short-lived: 1 hour (PORTAL_PREVIEW_TTL_SECONDS), the same TTL the old
 *    magic-link preview had.
 *  - The same trade-off this app already accepted for the storefront buy-box
 *    preview (?cx_preview, proxy.preview.validate.tsx): a signed, expiring
 *    admin token in a URL, treated as private for its lifetime.
 *
 * Customer session tokens in URLs remain banned — see the doc comment on
 * sessionTokenFromRequest in session.server.ts: those are long-lived bearer
 * credentials rendered next to third-party theme scripts.
 *
 * Format: base64url(payloadJson) + "." + HMAC — signValue/verifySignedValue
 * from session.server.ts (the exact primitives the cookie already uses; no
 * new crypto). Stateless on purpose: nothing to store, nothing to consume,
 * multi-use within its TTL so the admin can share it with staff and click
 * around freely.
 */

/** Query parameter carrying the preview token on portal URLs. */
export const PREVIEW_TOKEN_PARAM = "cx_pp";

/** Portal preview link TTL — 1 hour, matching the admin card copy. */
export const PORTAL_PREVIEW_TTL_SECONDS = 3600;

export interface PreviewTokenPayload {
  v: 1;
  shopId: string;
  customerId: string;
  contractId: string | null;
  email: string;
  exp: number; // unix seconds
}

export interface MintPreviewTokenInput {
  shopId: string;
  customerId: string;
  contractId?: string | null;
  email: string;
}

/** Mint a signed preview token. Stateless — nothing is persisted. */
export function mintPreviewToken(
  input: MintPreviewTokenInput,
  ttlSeconds: number = PORTAL_PREVIEW_TTL_SECONDS,
): string {
  const payload: PreviewTokenPayload = {
    v: 1,
    shopId: input.shopId,
    customerId: input.customerId,
    contractId: input.contractId ?? null,
    email: input.email,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return signValue(body);
}

/**
 * Verify a raw preview token: signature FIRST (timing-safe, inside
 * verifySignedValue), then expiry, then the shop binding — a token minted
 * for one shop must never open another shop's portal, however the request
 * was routed. Returns the payload, or null for anything invalid.
 */
export function verifyPreviewToken(
  raw: string,
  shopId: string,
): PreviewTokenPayload | null {
  const body = verifySignedValue(raw);
  if (!body) return null;

  let payload: PreviewTokenPayload | null;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // JSON.parse does NOT throw on the body "null" (or a bare number/string):
  // it returns the value, so the try/catch above never sees it. Guard before
  // the first property access — dereferencing null here would escape as a
  // 500 instead of a clean rejection. Defense-in-depth only: reaching this
  // line requires a valid HMAC, and mintPreviewToken never signs such a body.
  if (typeof payload !== "object" || payload === null) return null;

  if (payload.v !== 1) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return null;
  }
  if (payload.shopId !== shopId) return null;
  if (typeof payload.customerId !== "string" || !payload.customerId) return null;

  return payload;
}
