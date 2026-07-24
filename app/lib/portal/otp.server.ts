import crypto from "node:crypto";
import type { PortalSession } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { defaultFor } from "~/lib/settings/registry.server";
import { sha256 } from "~/lib/crypto/tokens.server";
import { sendNotification } from "~/lib/notifications/send.server";
import { createPortalSession } from "./session.server";

/**
 * Email OTP login for the customer portal.
 *
 * Anti-enumeration: requestOtp ALWAYS reports ok. A code is generated and
 * emailed only when a SubscriptionContract (any status) exists for the email;
 * unknown emails get the same response and no database row. Codes are 6
 * digits, stored as sha256(email + ":" + code) (the email salts the low-entropy
 * code), expire after settings.portal.otpCodeTtlMinutes and die after 5 wrong
 * guesses. Requests are limited to 3 per rolling hour per email.
 */

const MAX_REQUESTS_PER_HOUR = 3;
const MAX_VERIFY_ATTEMPTS = 5;
const CODE_PATTERN = /^\d{6}$/;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function codeHash(email: string, code: string): string {
  return sha256(`${email}:${code}`);
}

/** Newest contract for an email (any status), matched case-insensitively. */
async function newestContractForEmail(email: string) {
  return prisma.subscriptionContract.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
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
  const neutralTtl = defaultFor("portal").otpCodeTtlMinutes;
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return { ok: true, ttlMinutes: neutralTtl };

  // 3 requests per rolling hour per email, counted on stored OtpCode rows.
  const hourAgo = new Date(Date.now() - 3600_000);
  const recent = await prisma.otpCode.count({
    where: { email: emailNorm, createdAt: { gte: hourAgo } },
  });
  if (recent >= MAX_REQUESTS_PER_HOUR) {
    return { ok: true, ttlMinutes: neutralTtl };
  }

  // Unknown email: same response, no row, no send (no account enumeration).
  const contract = await newestContractForEmail(emailNorm);
  if (!contract) return { ok: true, ttlMinutes: neutralTtl };

  const portalSettings = await getSetting(contract.shopId, "portal");
  const ttlMinutes = portalSettings.otpCodeTtlMinutes;

  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  await prisma.otpCode.create({
    data: {
      email: emailNorm,
      codeHash: codeHash(emailNorm, code),
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
    },
  });

  // Direct email only — the otp_code template never routes through Klaviyo.
  await sendNotification({
    shopId: contract.shopId,
    contractId: contract.id,
    template: "otp_code",
    locale: locale ?? contract.locale,
    email: contract.email,
    vars: { code, minutes: ttlMinutes },
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

  return { ok: true, ttlMinutes };
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
  const emailNorm = normalizeEmail(email);
  const codeNorm = code.replace(/\s+/g, "");
  if (!emailNorm || !CODE_PATTERN.test(codeNorm)) return { ok: false };

  const now = new Date();
  const candidates = await prisma.otpCode.findMany({
    where: {
      email: emailNorm,
      consumedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: MAX_VERIFY_ATTEMPTS },
    },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 0) return { ok: false };

  const hash = codeHash(emailNorm, codeNorm);
  const match = candidates.find((c) => c.codeHash === hash);

  if (!match) {
    // Burn one attempt on every live code so parallel codes cannot be used to
    // widen the guessing budget.
    await prisma.otpCode.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false };
  }

  // Conditional consume — concurrent submissions cannot double-spend a code.
  const consumed = await prisma.otpCode.updateMany({
    where: { id: match.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count === 0) return { ok: false };

  const contract = await newestContractForEmail(emailNorm);
  if (!contract) return { ok: false };

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

  return {
    ok: true,
    customerId: contract.customerId,
    shopId: contract.shopId,
    session,
    cookie,
  };
}
