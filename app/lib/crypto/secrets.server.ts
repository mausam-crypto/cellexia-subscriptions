import crypto from "node:crypto";

/**
 * Encryption at rest for admin-entered credentials stored in the Setting
 * table (SMTP password, Klaviyo private API key).
 *
 * Stored format: "enc:v1:" + base64url(iv) + "." + base64url(authTag) + "." +
 * base64url(ciphertext) — AES-256-GCM with a key derived from
 * APP_SIGNING_SECRET (scrypt, fixed context salt).
 *
 * Contract for readers: revealSecret() NEVER throws. If APP_SIGNING_SECRET was
 * rotated (docs/OPERATIONS.md §10) or the blob is corrupt, it reports
 * { ok: false } and callers fall back to the matching environment variable —
 * a rotation must never brick mail or Klaviyo delivery, it just means the
 * admin re-enters the credential on the Settings page.
 */

const PREFIX = "enc:v1:";
const KDF_SALT = "cellexia-settings-secrets-v1";

// scrypt is deliberately slow; derive once per APP_SIGNING_SECRET value so the
// notification hot path never pays the KDF cost twice.
let cachedKey: { secret: string; key: Buffer } | null = null;

function deriveKey(): Buffer {
  const secret = process.env.APP_SIGNING_SECRET;
  if (!secret) throw new Error("APP_SIGNING_SECRET is not set");
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = crypto.scryptSync(secret, KDF_SALT, 32);
  cachedKey = { secret, key };
  return key;
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypts a plaintext credential for storage. Throws only when APP_SIGNING_SECRET is unset. */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export type RevealResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Resolves a stored settings credential to its plaintext.
 *
 * - "" → ok with "" (nothing stored).
 * - Unprefixed values pass through as-is: a hand-edited Setting row with a
 *   plaintext credential should work rather than silently break delivery.
 * - "enc:v1:..." → decrypted; any failure (rotated APP_SIGNING_SECRET,
 *   truncated/tampered blob) reports ok:false instead of throwing.
 */
export function revealSecret(stored: string): RevealResult {
  if (!isEncryptedSecret(stored)) return { ok: true, value: stored };
  try {
    const [ivPart, tagPart, dataPart] = stored.slice(PREFIX.length).split(".");
    if (!ivPart || !tagPart || !dataPart) {
      return { ok: false, error: "malformed encrypted secret" };
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]);
    return { ok: true, value: plain.toString("utf8") };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
