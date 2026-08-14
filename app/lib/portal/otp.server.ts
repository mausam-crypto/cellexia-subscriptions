import crypto from "node:crypto";
import type { PortalSession } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { defaultFor } from "~/lib/settings/registry.server";
import { sha256 } from "~/lib/crypto/tokens.server";
import { sendNotification } from "~/lib/notifications/send.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { createPortalSession } from "./session.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

/**
 * Email OTP login for the customer portal.
 *
 * Anti-enumeration: requestOtp ALWAYS reports ok. A code is generated and
 * emailed only when a SubscriptionContract (any status) exists for the email;
 * unknown emails get the same response and no database row. Codes are 6
 * digits, stored as sha256(email + ":" + code) (the email salts the low-entropy
 * code), expire after settings.portal.otpCodeTtlMinutes and die after
 * settings.portal.otpVerifyMaxAttempts wrong guesses. Requests are limited to
 * settings.portal.otpRequestsPerHour per rolling hour per email.
 *
 * Timing: identical response copy is not enough — a known email used to do
 * measurably more work (settings read, code insert, an AWAITED email send)
 * than an unknown one, so response latency leaked "has a subscription" even
 * though the page looked neutral. The email is now fire-and-forget and every
 * return path waits out a jittered constant-time floor that dominates the
 * remaining DB-write delta.
 *
 * Content: the reported ttlMinutes must ALSO be identical on every path — the
 * step-2 page prints "expires in N minutes", so returning the merchant's
 * configured value for known emails but the registry default for unknown ones
 * was an enumeration oracle whenever the merchant changed the TTL setting.
 * The value is resolved once, before the contract lookup, and returned from
 * every path.
 */

const CODE_PATTERN = /^\d{6}$/;

/**
 * Minimum requestOtp/verifyOtp duration. The floor (plus jitter) must dwarf
 * the work delta between the known/unknown paths (a couple of DB writes).
 */
const MIN_RESPONSE_MS = 350;
const JITTER_MS = 150;

/** Resolve no earlier than MIN_RESPONSE_MS (+ random jitter) after `started`. */
async function timingFloor<T>(started: number, result: T): Promise<T> {
  const target = MIN_RESPONSE_MS + crypto.randomInt(0, JITTER_MS);
  const remaining = started + target - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return result;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function codeHash(email: string, code: string): string {
  return sha256(`${email}:${code}`);
}

/**
 * Newest contract for an email (any status), matched case-insensitively —
 * restricted to contracts THIS app manages.
 *
 * The store may run a second subscription app whose contracts are mirrored
 * here. Its subscribers must not be able to log into our portal and "manage" a
 * subscription we do not own: every action would either fail against Shopify or,
 * worse, edit the other app's contract behind its back. They see the same
 * neutral "if that email has a subscription, a code is on its way" copy, and no
 * code is ever sent (which also keeps the no-enumeration property intact).
 */
async function newestContractForEmail(email: string) {
  return prisma.subscriptionContract.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, ...OURS_ONLY },
    orderBy: { createdAt: "desc" },
  });
}

export interface RequestOtpResult {
  /** Always true — the caller must render the same neutral copy either way. */
  ok: true;
  /** Minutes the code stays valid; used for the "expires in N minutes" copy. */
  ttlMinutes: number;
}

/**
 * Rate-limit, generate, store and email a login code. Returns the same shape
 * whether or not the email belongs to a subscriber.
 */
export async function requestOtp(
  email: string,
  locale?: string | null,
): Promise<RequestOtpResult> {
  const started = Date.now();

  // Anti-enumeration: resolve the reported TTL ONCE, before any contract
  // lookup, so known, unknown, empty and throttled paths all return the SAME
  // value — the merchant's configured setting (registry default when no shop
  // is installed). A per-path value is a content-level oracle even with
  // identical timing and copy templates. Contained: a broken settings read
  // must never break login — the default applies, still on every path alike.
  let ttlMinutes = defaultFor("portal").otpCodeTtlMinutes;
  try {
    const primaryShop = await getPrimaryShop();
    if (primaryShop) {
      ttlMinutes = (await getSetting(primaryShop.id, "portal"))
        .otpCodeTtlMinutes;
    }
  } catch (err) {
    console.error("[portal] otp ttl settings read failed", err);
  }

  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return timingFloor(started, { ok: true as const, ttlMinutes });

  // Unknown email: same response, no row, no send (no account enumeration) —
  // and, via the timing floor, no faster than the known path either.
  const contract = await newestContractForEmail(emailNorm);
  if (!contract) {
    return timingFloor(started, { ok: true as const, ttlMinutes });
  }

  const portalSettings = await getSetting(contract.shopId, "portal");

  // Rolling per-email request limit, counted on stored OtpCode rows.
  const hourAgo = new Date(Date.now() - 3600_000);
  const recent = await prisma.otpCode.count({
    where: { email: emailNorm, createdAt: { gte: hourAgo } },
  });
  if (recent >= portalSettings.otpRequestsPerHour) {
    // Telemetry only — the response stays byte-identical to every other
    // requestOtp outcome (anti-enumeration), and the timing floor already
    // dwarfs this one extra write. Email-keyed; never any code material.
    await logEvent({
      shopId: contract.shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "portal.otp_throttled",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: { recentRequests: recent, limit: portalSettings.otpRequestsPerHour },
    });
    return timingFloor(started, { ok: true as const, ttlMinutes });
  }

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.otpCode.create({
    data: {
      email: emailNorm,
      codeHash: codeHash(emailNorm, code),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });

  // Direct email only — the otp_code template never routes through Klaviyo.
  // Fire-and-forget: awaiting an outbound email send (tens to hundreds of ms)
  // was the dominant timing signal separating known from unknown emails.
  void sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template: "otp_code",
    locale: locale ?? contract.locale,
    email: contract.email,
    vars: { code, minutes: ttlMinutes },
  }).catch((err) => {
    console.error("[portal] otp email send failed", err);
  });

  await logEvent({
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "portal.otp_sent",
    source: "CUSTOMER_PORTAL",
    actor: "customer",
    payload: { ttlMinutes },
  });

  return timingFloor(started, { ok: true as const, ttlMinutes });
}

export type VerifyOtpResult =
  | {
      ok: true;
      customerId: string;
      shopId: string;
      session: PortalSession;
      /** Set-Cookie header value that logs the browser in. */
      cookie: string;
    }
  | { ok: false };

/**
 * Verify a submitted code: consume it atomically, resolve the customer from
 * the newest contract for the email, and open a portal session.
 */
export async function verifyOtp(
  email: string,
  code: string,
): Promise<VerifyOtpResult> {
  const started = Date.now();
  const emailNorm = normalizeEmail(email);
  const codeNorm = code.replace(/\s+/g, "");
  if (!emailNorm || !CODE_PATTERN.test(codeNorm)) {
    return timingFloor(started, { ok: false as const });
  }

  // The contract also pins the shop whose settings cap verify attempts.
  const contract = await newestContractForEmail(emailNorm);
  if (!contract) return timingFloor(started, { ok: false as const });
  const portalSettings = await getSetting(contract.shopId, "portal");

  const now = new Date();
  const candidates = await prisma.otpCode.findMany({
    where: {
      email: emailNorm,
      consumedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: portalSettings.otpVerifyMaxAttempts },
    },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 0) return timingFloor(started, { ok: false as const });

  const hash = codeHash(emailNorm, codeNorm);
  const match = candidates.find((c) => c.codeHash === hash);

  if (!match) {
    // Burn one attempt on every live code so parallel codes cannot be used to
    // widen the guessing budget.
    await prisma.otpCode.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { attempts: { increment: 1 } },
    });
    // Telemetry only — same { ok: false } as every other failure path, timed
    // by the same floor. Email-keyed; the guessed code (and its hash) never
    // enters the event stream.
    await logEvent({
      shopId: contract.shopId,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "portal.login_failed",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: { reason: "code_mismatch", liveCodes: candidates.length },
    });
    return timingFloor(started, { ok: false as const });
  }

  // Conditional consume — concurrent submissions cannot double-spend a code.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: match.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) return timingFloor(started, { ok: false as const });

  const { session, cookie } = await createPortalSession(
    contract.shopId,
    contract.customerId,
    contract.email,
  );

  await logEvent({
    shopId: contract.shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "portal.login",
    source: "CUSTOMER_PORTAL",
    actor: "customer",
    payload: { sessionId: session.id },
  });

  return timingFloor(started, {
    ok: true as const,
    customerId: contract.customerId,
    shopId: contract.shopId,
    session,
    cookie,
  });
}
