import crypto from "crypto";

function secretKey(): Buffer {
  const secret = process.env.MAGIC_LINK_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("MAGIC_LINK_SECRET (or SHOPIFY_API_SECRET) must be set");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

/** Random URL-safe token for magic links. Store only its hash. */
export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** AES-256-GCM encryption for secrets at rest (e.g. the Klaviyo API key). */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, encB64] = payload.split(".");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    secretKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
