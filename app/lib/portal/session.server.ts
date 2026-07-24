import crypto from "node:crypto";
import { redirect } from "@remix-run/node";
import type { PortalSession } from "@prisma/client";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { sha256 } from "~/lib/crypto/tokens.server";

/**
 * Portal authentication on top of the app proxy.
 *
 * The proxy signature (`authenticate.public.appProxy`) proves the request came
 * through Shopify; this module proves WHICH customer is browsing. After an OTP
 * login we set an HMAC-signed cookie `cx_portal` on the store domain (scoped
 * to /apps/cellexia-subscriptions). The cookie carries the raw session token; the database
 * stores only its SHA-256, so a leaked database cannot mint valid cookies.
 *
 * CSRF: every mutating portal form carries a token derived from the session
 * (HMAC of the stored token hash). It is embedded in the rendered HTML, never
 * in a URL, and verified timing-safe by the action dispatcher.
 */

const COOKIE_NAME = "cx_portal";
const PENDING_COOKIE_NAME = "cx_otp_pending";
const PENDING_TTL_SECONDS = 15 * 60;

/** Portal base path on the storefront domain (app proxy prefix + subpath). */
export const PORTAL_BASE_PATH = "/apps/cellexia-subscriptions";
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
 * Raw session token for the request. Primary source is the signed cx_portal
 * cookie; the magic-link LOGIN hand-off is also honoured — the raw token
 * rides in ?session= (first hop after the redirect) or in the raw
 * cellexia_portal_session cookie the magic route sets for same-domain setups.
 * Unsigned sources are safe to accept: the DB stores only the SHA-256 of
 * 32-byte random tokens, so a lookup hit is itself proof of authenticity.
 */
function sessionTokenFromRequest(request: Request): string | null {
  const cookies = parseCookies(request);
  const signed = cookies[COOKIE_NAME];
  if (signed) {
    const token = verifySignedValue(signed);
    if (token) return token;
  }
  const fromQuery = new URL(request.url).searchParams.get("session");
  if (fromQuery) return fromQuery;
  return cookies["cellexia_portal_session"] || null;
}

/** Validated portal session for the request, or null. */
export async function getPortalSession(
  request: Request,
): Promise<PortalSessionContext | null> {
  const token = sessionTokenFromRequest(request);
  if (!token) return null;

  const tokenHash = sha256(token);
  const row = await prisma.portalSession.findUnique({ where: { tokenHash } });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;

  return {
    id: row.id,
    shopId: row.shopId,
    customerId: row.customerId,
    email: row.email,
    expiresAt: row.expiresAt,
    isPreview: row.isPreview,
    csrfToken: csrfTokenForHash(tokenHash),
  };
}

function loginRedirectUrl(request: Request): string {
  const locale = new URL(request.url).searchParams.get("locale");
  const suffix = locale ? `?locale=${encodeURIComponent(locale)}` : "";
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
