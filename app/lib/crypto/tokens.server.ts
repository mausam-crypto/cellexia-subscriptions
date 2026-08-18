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
  /** Pause exit ramp (v1.28.0): landing page offering week choices. */
  | "EXTEND_PAUSE"
  | "SWAP"
  | "CONFIRM_3DS"
  | "APPLY_WINBACK"
  | "RETRY_PAYMENT"
  /** Routine check-in answer (v1.28.0): logs the answer, lands on the portal. */
  | "CHECKIN"
  /** Keep a subscription whose cancellation was scheduled (v1.28.0, P3.8):
   * clears cancelScheduledAt — a recovery, never lock-blocked. */
  | "KEEP_SUBSCRIPTION"
  /**
   * One-tap slower cadence (v1.28.0, P3.6): the cancel-intent follow-up's
   * "every N weeks instead" — params {unit, count}; the option is re-derived
   * against the plan's offered list at execution time.
   */
  | "SET_FREQUENCY"
  /**
   * Switch the contract to another vaulted payment method (v1.28.0, P1.7):
   * params {paymentMethodId, label?}; the id is re-validated against the
   * customer's live methods at execution time (never trusted). Single-use.
   */
  | "USE_METHOD"
  /**
   * Set another vaulted method as the contract's BACKUP (v1.28.0, P1.8 —
   * the new_card_detected email's "keep my card, use the new one only if a
   * payment fails"): params {paymentMethodId, label?}; re-validated at
   * execution time like USE_METHOD. Single-use.
   */
  | "SET_BACKUP"
  /**
   * Skip the held (unbilled, dunning-exhausted) order and reactivate the
   * FAILED contract from the following date (v1.28.0, P1.9): the
   * post-exhaustion touches' third exit. No params; the held cycle and the
   * resume date are re-derived at execution time. Single-use.
   */
  | "SKIP_FAILED_CYCLE"
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

// ── Stateless signed payloads (portal Undo tokens, v1.28.0) ──────────────────
//
// Same format and secret as magic tokens (base64url(json) "." hmac), but NO
// database row: these ride inside a page the customer already holds (the
// portal toast's Undo form) and carry the exact restore they may perform,
// which the consumer re-validates against the contract's current state —
// replay after a successful undo is a harmless "nothing to undo".

export interface SignedPayload<T> {
  v: 1;
  kind: string;
  data: T;
  exp: number; // unix seconds
  nonce: string;
}

export function createSignedPayload<T>(
  kind: string,
  data: T,
  ttlSeconds: number,
): string {
  const payload: SignedPayload<T> = {
    v: 1,
    kind,
    data,
    exp: Math.floor(Date.now() / 1000) + Math.max(1, Math.floor(ttlSeconds)),
    nonce: crypto.randomBytes(9).toString("base64url"),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${hmac(body)}`;
}

export type SignedPayloadResult<T> =
  | { ok: true; payload: SignedPayload<T> }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "WRONG_KIND" };

export function verifySignedPayload<T>(
  token: string,
  kind: string,
): SignedPayloadResult<T> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, reason: "MALFORMED" };
  const [body, sig] = parts;
  const expected = hmac(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }
  let payload: SignedPayload<T>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!payload || payload.v !== 1 || typeof payload.exp !== "number") {
    return { ok: false, reason: "MALFORMED" };
  }
  if (payload.kind !== kind) return { ok: false, reason: "WRONG_KIND" };
  if (payload.exp * 1000 < Date.now()) return { ok: false, reason: "EXPIRED" };
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
