import crypto from "node:crypto";
import { redirect } from "@remix-run/node";
import type { PortalSession } from "@prisma/client";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { sha256 } from "~/lib/crypto/tokens.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

/**
 * Portal authentication on top of the app proxy.
 *
 * The proxy signature (`authenticate.public.appProxy`) proves the request came
 * through Shopify; this module proves WHICH customer is browsing, through one
 * of three identity paths (in order):
 *
 *  1. A signed, 1-hour, view-only admin preview token in the ?cx_pp= query
 *    parameter (previewToken.server.ts) — the cookie-less identity for the
 *    admin "Preview the portal" flow on a live store. A VALID token outranks
 *    the cookie: it is explicit, admin-minted intent, and in the dev harness
 *    a stale non-preview cookie shadowing it dead-ended every preview click
 *    at the setup gate. An invalid one falls through to the other paths.
 *  2. The HMAC-signed HttpOnly cookie `cx_portal`, set after an OTP login and
 *    scoped to /apps/cellexia-subs. The cookie carries the raw session token;
 *    the database stores only its SHA-256, so a leaked database cannot mint
 *    valid cookies. NOTE: on a live store Shopify's app proxy STRIPS the
 *    Cookie request header and the Set-Cookie response header in both
 *    directions, so this path only works in environments that reach the app
 *    host directly (the local dev harness — see PORTAL_COOKIE_DEV).
 *  3. Shopify's own storefront login: the proxy appends
 *    ?logged_in_customer_id=<numeric id> to every proxied request, filled in
 *    ONLY when the visitor is signed into their store account. That value is
 *    covered by the proxy request signature, so it is Shopify's sanctioned,
 *    unforgeable customer identity for app-proxy requests — no app cookie
 *    needed.
 *
 * Paths 2 and 3 are safe ONLY because every proxy route verifies the request
 * HMAC via authenticate.public.appProxy BEFORE calling into this module — the
 * exact trust contract the cookie path already places on its callers. A
 * request that skipped that verification could fabricate both parameters;
 * one that passed it cannot (Shopify signs the full query string).
 *
 * CSRF: every mutating portal form carries a token derived from the session
 * (HMAC of the stored token hash). It is embedded in the rendered HTML, never
 * in a URL, and verified timing-safe by the action dispatcher.
 */

const COOKIE_NAME = "cx_portal";
const PENDING_COOKIE_NAME = "cx_otp_pending";
const PENDING_TTL_SECONDS = 15 * 60;
// Literal duplicated from previewToken.server.ts (PREVIEW_TOKEN_PARAM):
// that module imports signValue/verifySignedValue from THIS one, so a static
// import back would be circular. Its tests pin the two values equal.
const PREVIEW_TOKEN_PARAM = "cx_pp";

/** Portal base path on the storefront domain (app proxy prefix + subpath) —
 * single source of truth in app/lib/portal/proxy-path.ts. */
export const PORTAL_BASE_PATH = PORTAL_PROXY_BASE;
const COOKIE_PATH = PORTAL_BASE_PATH;

// ── Signing primitives ───────────────────────────────────────────────────────

function secret(): string {
  const s = process.env.APP_SIGNING_SECRET;
  if (!s) throw new Error("APP_SIGNING_SECRET is not set");
  return s;
}

function hmac(data: string): string {
  return crypto
    .createHmac("sha256", secret())
    .update(data)
    .digest("base64url");
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** value -> "value.signature" (both base64url-safe). */
export function signValue(value: string): string {
  return `${value}.${hmac(value)}`;
}

/** "value.signature" -> value, or null when malformed / bad signature. */
export function verifySignedValue(signed: string): string | null {
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  return timingSafeEquals(sig, hmac(value)) ? value : null;
}

// ── Cookie plumbing ──────────────────────────────────────────────────────────

function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get("Cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

function clearingCookie(name: string): string {
  return serializeCookie(name, "", 0);
}

// ── Portal sessions ──────────────────────────────────────────────────────────

export interface PortalSessionContext {
  id: string;
  shopId: string;
  customerId: string;
  email: string;
  expiresAt: Date;
  /**
   * Admin preview session (opened from the launch checklist): the portal
   * renders exactly as the customer would see it, but every mutating action
   * is intercepted before it executes.
   */
  isPreview: boolean;
  /** Derived per-session CSRF token — embed in forms, verify with verifyCsrf. */
  csrfToken: string;
  /**
   * Raw ?cx_pp= preview token this session came from, so links and redirects
   * can re-embed it (withLocale's third parameter) — the app proxy strips
   * cookies, so the token in the URL IS the session. Null for cookie and
   * logged_in_customer_id sessions.
   */
  previewToken: string | null;
  /**
   * Identity came from Shopify's ?logged_in_customer_id= (storefront login) —
   * the primary path on a live store. These sessions hold NO app credential
   * to destroy: Shopify re-appends the parameter to every proxied request,
   * so the portal's own POST /logout deletes nothing and the very next
   * request signs the customer straight back in. "Sign out" for them must go
   * through Shopify's /account/logout (the store account IS the session).
   */
  viaStorefrontLogin: boolean;
}

function csrfTokenForHash(tokenHash: string): string {
  return hmac(`csrf:${tokenHash}`);
}

export interface CreatedPortalSession {
  session: PortalSession;
  /** Set-Cookie header value for the response that completes the login. */
  cookie: string;
}

/**
 * Create a PortalSession row and its signed cookie. TTL comes from
 * settings.portal.sessionTtlDays.
 */
export async function createPortalSession(
  shopId: string,
  customerId: string,
  email: string,
  opts?: { isPreview?: boolean },
): Promise<CreatedPortalSession> {
  const portalSettings = await getSetting(shopId, "portal");
  const ttlSeconds = portalSettings.sessionTtlDays * 24 * 3600;
  const rawToken = crypto.randomBytes(32).toString("base64url");

  const session = await prisma.portalSession.create({
    data: {
      tokenHash: sha256(rawToken),
      customerId,
      email,
      shopId,
      isPreview: opts?.isPreview ?? false,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    },
  });

  return {
    session,
    cookie: serializeCookie(COOKIE_NAME, signValue(rawToken), ttlSeconds),
  };
}

/**
 * Raw session token for the request — ONLY from the signed, HttpOnly
 * cx_portal cookie.
 *
 * The session token is a long-lived bearer credential. It must never be
 * accepted from a URL query parameter or from a JS-writable cookie: the
 * portal is injected into the merchant's theme, where every storefront app
 * (including the other subscription vendor) runs scripts that can read
 * location.href and document.cookie — and proxy/CDN access logs plus browser
 * history keep URLs forever. The magic-link LOGIN flow therefore hands off a
 * single-use, short-TTL code instead (see exchangeLoginHandoff below), which
 * this server immediately swaps for the HttpOnly cookie.
 */
function sessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookies(request);
  const signed = cookies[COOKIE_NAME];
  if (!signed) return null;
  return verifySignedValue(signed);
}

/** TTL of a logged_in_customer_id session context. Advisory only — the
 * identity is re-proven by Shopify's signed query on every request. */
const LICID_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * The Shop row id for the ?shop= domain Shopify appends to every proxied
 * request. Only consulted for the cookie-less identity paths; the parameter
 * is covered by the proxy signature the calling route has already verified.
 */
async function shopIdFromProxyRequest(request: Request): Promise<string | null> {
  const domain = new URL(request.url).searchParams.get("shop");
  if (!domain) return null;
  const shop = await prisma.shop.findUnique({
    where: { domain },
    select: { id: true },
  });
  return shop?.id ?? null;
}

/**
 * Validated portal session for the request, or null.
 *
 * Identity paths, in order (see the module doc comment): a VALID ?cx_pp=
 * admin preview token, then the cx_portal cookie, then Shopify's
 * ?logged_in_customer_id=. The cookie-less paths exist because the app proxy
 * strips cookies on a live store; BOTH are trustworthy only behind
 * authenticate.public.appProxy, which every proxy route runs first.
 */
export async function getPortalSession(
  request: Request,
): Promise<PortalSessionContext | null> {
  const params = new URL(request.url).searchParams;
  const rawPreview = params.get(PREVIEW_TOKEN_PARAM);

  // (a) Admin preview token — signed, 1h, shop-bound, view-only (isPreview
  // sessions have every mutation intercepted). Stateless: the CSRF token is
  // derived from the token hash, so it is stable across the token's clicks.
  // Checked FIRST: clicking a freshly minted preview link is the clearest
  // intent a request can carry, and in the cookie-preserving dev harness a
  // stale non-preview cx_portal cookie would otherwise shadow it and land
  // the admin on the setup gate. On a live store the proxy strips cookies,
  // so this ordering changes nothing there.
  if (rawPreview) {
    const previewShopId = await shopIdFromProxyRequest(request);
    if (previewShopId) {
      const { verifyPreviewToken } = await import(
        "~/lib/portal/previewToken.server"
      );
      const payload = verifyPreviewToken(rawPreview, previewShopId);
      if (payload) {
        const previewHash = sha256(rawPreview);
        return {
          id: `preview:${previewHash.slice(0, 12)}`,
          shopId: payload.shopId,
          customerId: payload.customerId,
          email: payload.email,
          expiresAt: new Date(payload.exp * 1000),
          isPreview: true,
          csrfToken: csrfTokenForHash(previewHash),
          previewToken: rawPreview,
          viaStorefrontLogin: false,
        };
      }
    }
    // Invalid/expired preview token: fall through — a cookie session or a
    // storefront-logged-in customer on a stale link still gets their own
    // portal; anyone else gets null and the closed-portal pages name the
    // expired preview (closedPortalPage) instead of silently gating.
  }

  const token = sessionTokenFromRequest(request);
  if (token) {
    const tokenHash = sha256(token);
    const row = await prisma.portalSession.findUnique({ where: { tokenHash } });
    if (row && row.expiresAt.getTime() > Date.now()) {
      return {
        id: row.id,
        shopId: row.shopId,
        customerId: row.customerId,
        email: row.email,
        expiresAt: row.expiresAt,
        isPreview: row.isPreview,
        csrfToken: csrfTokenForHash(tokenHash),
        previewToken: null,
        viaStorefrontLogin: false,
      };
    }
  }

  // ── Storefront login (proxy strips cookies on a live store) ────────────────
  const loggedInCustomerId = params.get("logged_in_customer_id");
  if (!loggedInCustomerId) return null;

  const shopId = await shopIdFromProxyRequest(request);
  if (!shopId) return null;

  // (b) Shopify storefront login. logged_in_customer_id is numeric; contracts
  // store the customer gid (gid://shopify/Customer/<id>) — match both forms,
  // and anchor the context on the stored form so every later query hits.
  if (loggedInCustomerId && /^\d+$/.test(loggedInCustomerId)) {
    const customerGid = `gid://shopify/Customer/${loggedInCustomerId}`;
    const contract = await prisma.subscriptionContract.findFirst({
      where: {
        shopId,
        customerId: { in: [customerGid, loggedInCustomerId] },
      },
      orderBy: { createdAt: "desc" },
      select: { customerId: true, email: true },
    });
    const customerId = contract?.customerId ?? customerGid;
    return {
      id: `licid:${loggedInCustomerId}`,
      shopId,
      customerId,
      email: contract?.email ?? "",
      expiresAt: new Date(Date.now() + LICID_SESSION_TTL_MS),
      isPreview: false,
      csrfToken: csrfTokenForHash(sha256(`licid:${shopId}:${customerId}`)),
      previewToken: null,
      viaStorefrontLogin: true,
    };
  }

  return null;
}

/**
 * Login-page URL for a request that turned out to be sessionless, carrying
 * ?locale= and — crucially — the request's (invalid) ?cx_pp= preview token,
 * so the login page can say "this preview link has expired" instead of the
 * generic gate. Every sessionless bounce to /login MUST go through this
 * helper (requireCustomer does; routes that call getPortalSession directly
 * use it by hand): a hand-rolled redirect that drops cx_pp recreates the
 * exact dead-end this token exists to name — the portal home IS the URL the
 * admin preview mints, so an expired token most often lands right there.
 */
export function loginRedirectUrl(request: Request): string {
  const params = new URL(request.url).searchParams;
  const carried = new URLSearchParams();
  const locale = params.get("locale");
  if (locale) carried.set("locale", locale);
  // Carry an (invalid) preview token to the login page so it can say "this
  // preview link has expired" instead of the generic gate.
  const preview = params.get(PREVIEW_TOKEN_PARAM);
  if (preview) carried.set(PREVIEW_TOKEN_PARAM, preview);
  const suffix = carried.size > 0 ? `?${carried.toString()}` : "";
  return `${PORTAL_BASE_PATH}/login${suffix}`;
}

/**
 * The session for the request, or a thrown redirect to the portal login page
 * (preserving ?locale=). Use in every authenticated proxy loader/action.
 */
export async function requireCustomer(
  request: Request,
): Promise<PortalSessionContext> {
  const session = await getPortalSession(request);
  if (!session) throw redirect(loginRedirectUrl(request));
  return session;
}

/**
 * Delete the request's session row (if any) and return the Set-Cookie header
 * value that clears the browser cookie.
 */
export async function destroySession(request: Request): Promise<string> {
  const token = sessionTokenFromRequest(request);
  if (token) {
    try {
      await prisma.portalSession.deleteMany({
        where: { tokenHash: sha256(token) },
      });
    } catch (err) {
      console.error("[portal] session delete failed", err);
    }
  }
  return clearingCookie(COOKIE_NAME);
}

// ── Magic-link LOGIN hand-off ────────────────────────────────────────────────
// The magic LOGIN executor redirects the browser to the portal with a
// single-use ~60s hand-off code in the query (?handoff=...), NOT the session
// token. This exchange runs server-side on the store domain: it consumes the
// code, mints the PortalSession and returns the HttpOnly cx_portal cookie —
// the long-lived bearer credential never appears in a URL, a log line or a
// JS-readable cookie.

export interface LoginHandoffResult {
  /** Set-Cookie header value that logs the browser in (HttpOnly). */
  cookie: string;
  isPreview: boolean;
}

/**
 * Consume a LOGIN hand-off code and open a portal session for its customer.
 * Returns null for anything invalid: expired, replayed, wrong action, or a
 * plain LOGIN magic link pasted here directly (params.handoff must be true —
 * emailed LOGIN links must go through /magic/:token where their use is
 * audited).
 */
export async function exchangeLoginHandoff(
  code: string,
  shopId: string,
): Promise<LoginHandoffResult | null> {
  const { verifyAndConsumeMagicToken } = await import(
    "~/lib/crypto/tokens.server"
  );
  const verified = await verifyAndConsumeMagicToken(code);
  if (!verified.ok) return null;
  const payload = verified.payload;
  if (payload.action !== "LOGIN") return null;
  if (payload.params?.handoff !== true) return null;
  if (!payload.customerId || !payload.email) return null;

  const isPreview = payload.params?.preview === true;
  const { cookie, session } = await createPortalSession(
    shopId,
    payload.customerId,
    payload.email,
    { isPreview },
  );

  const { logEvent } = await import("~/lib/events/log.server");
  await logEvent({
    shopId,
    contractId: payload.contractId ?? null,
    customerId: payload.customerId,
    email: payload.email,
    type: "portal.login",
    source: "MAGIC_LINK",
    actor: "customer",
    payload: {
      via: "magic_link",
      sessionId: session.id,
      ...(isPreview ? { preview: true } : {}),
    },
  });

  return { cookie, isPreview };
}

/** Timing-safe check of a form-submitted CSRF token against the session's. */
export function verifyCsrf(
  session: PortalSessionContext,
  submitted: string | null | undefined,
): boolean {
  if (!submitted) return false;
  return timingSafeEquals(submitted, session.csrfToken);
}

// ── Pending-login cookie (OTP step 2) ────────────────────────────────────────
// Between "send me a code" and "verify", the email travels in a short-lived
// signed cookie — never in a URL query parameter (no PII in URLs, no re-POST
// on refresh).

interface PendingLoginPayload {
  email: string;
  ttlMinutes: number;
  exp: number; // unix seconds
}

export interface PendingLogin {
  email: string;
  /** OTP validity minutes, carried for the "expires in N minutes" copy. */
  ttlMinutes: number;
}

/** Set-Cookie header value carrying the email awaiting OTP verification. */
export function createPendingLoginCookie(
  email: string,
  ttlMinutes: number,
): string {
  const payload: PendingLoginPayload = {
    email,
    ttlMinutes,
    exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS,
  };
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return serializeCookie(
    PENDING_COOKIE_NAME,
    signValue(value),
    PENDING_TTL_SECONDS,
  );
}

/** The pending login, or null (absent / tampered / expired). */
export function readPendingLogin(request: Request): PendingLogin | null {
  const raw = parseCookies(request)[PENDING_COOKIE_NAME];
  if (!raw) return null;
  const value = verifySignedValue(raw);
  if (!value) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as PendingLoginPayload;
    if (typeof payload.email !== "string" || !payload.email) return null;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
      return null;
    }
    return {
      email: payload.email,
      ttlMinutes:
        typeof payload.ttlMinutes === "number" && payload.ttlMinutes > 0
          ? payload.ttlMinutes
          : 10,
    };
  } catch {
    return null;
  }
}

/** Set-Cookie header value that clears the pending-login cookie. */
export function clearPendingLoginCookie(): string {
  return clearingCookie(PENDING_COOKIE_NAME);
}
