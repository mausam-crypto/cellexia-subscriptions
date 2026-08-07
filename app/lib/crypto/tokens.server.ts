import crypto from "node:crypto";
import prisma from "~/db.server";

/**
 * Signed, expiring, single-action tokens ("magic links").
 *
 * Format: base64url(payloadJson) + "." + base64url(hmacSha256(payload, secret))
 * The raw token is only ever in the URL we send; the database stores a SHA-256
 * hash plus use-count, so a leaked database cannot forge or replay links.
 */

const ALG = "sha256";

function secret(): string {
  const s = process.env.APP_SIGNING_SECRET;
  if (!s) throw new Error("APP_SIGNING_SECRET is not set");
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(data: string): string {
  return b64url(crypto.createHmac(ALG, secret()).update(data).digest());
}

export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export type MagicAction =
  | "SKIP_NEXT"
  | "UNSKIP_NEXT"
  | "DELAY_NEXT"
  | "ADD_TO_NEXT"
  | "UPDATE_CARD"
  | "PAUSE"
  | "RESUME"
  | "SWAP"
  | "CONFIRM_3DS"
  | "APPLY_WINBACK"
  | "LOGIN"
  | "PREVIEW";

export interface MagicPayload {
  v: 1;
  action: MagicAction;
  contractId?: string;
  customerId?: string;
  email?: string;
  params?: Record<string, unknown>;
  exp: number; // unix seconds
  nonce: string;
}

export interface CreateMagicLinkInput {
  action: MagicAction;
  contractId?: string;
  customerId?: string;
  email?: string;
  params?: Record<string, unknown>;
  ttlSeconds: number;
  maxUses?: number;
  createdVia?: string;
}

/** Creates + persists a token; returns the raw token for embedding in a URL. */
export async function createMagicToken(
  input: CreateMagicLinkInput,
): Promise<string> {
  const payload: MagicPayload = {
    v: 1,
    action: input.action,
    contractId: input.contractId,
    customerId: input.customerId,
    email: input.email,
    params: input.params,
    exp: Math.floor(Date.now() / 1000) + input.ttlSeconds,
    nonce: crypto.randomBytes(12).toString("base64url"),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const token = `${body}.${hmac(body)}`;

  await prisma.magicLinkToken.create({
    data: {
      tokenHash: sha256(token),
      action: input.action,
      contractId: input.contractId,
      customerId: input.customerId,
      email: input.email,
      payload: (input.params ?? {}) as object,
      expiresAt: new Date(payload.exp * 1000),
      maxUses: input.maxUses ?? 1,
      createdVia: input.createdVia,
    },
  });

  return token;
}

export type VerifyResult =
  | { ok: true; payload: MagicPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "USED" | "UNKNOWN" };

/**
 * Verifies signature + expiry and atomically consumes one use.
 * Consumption uses a conditional update so concurrent requests can't double-spend.
 */
export async function verifyAndConsumeMagicToken(
  token: string,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts;

  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: MagicPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  if (payload.exp * 1000 < Date.now()) return { ok: false, reason: "EXPIRED" };

  const consumed = await prisma.magicLinkToken.updateMany({
    where: {
      tokenHash: sha256(token),
      expiresAt: { gt: new Date() },
      // still has uses left
      useCount: { lt: prisma.magicLinkToken.fields.maxUses },
    },
    data: { useCount: { increment: 1 }, usedAt: new Date() },
  });
  if (consumed.count === 0) {
    const row = await prisma.magicLinkToken.findUnique({
      where: { tokenHash: sha256(token) },
    });
    if (!row) return { ok: false, reason: "UNKNOWN" };
    return { ok: false, reason: "USED" };
  }

  return { ok: true, payload };
}

/** Peek without consuming (used to render confirmation pages before POST). */
export function verifyMagicTokenSignature(token: string): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts;
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  try {
    const payload: MagicPayload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    );
    if (payload.exp * 1000 < Date.now()) return { ok: false, reason: "EXPIRED" };
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
}
