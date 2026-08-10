import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ADMIN-ENTERED CREDENTIALS ARE ENCRYPTED AT REST, AND A KEY ROTATION MUST
 * NEVER THROW ON THE DELIVERY PATH.
 *
 * The Settings page stores the SMTP password and the Klaviyo private key in
 * the Setting table via app/lib/crypto/secrets.server.ts. Two contracts:
 *
 *  1. encryptSecret produces an opaque "enc:v1:..." blob (fresh IV per call —
 *     equal plaintexts must not produce equal ciphertexts) that never
 *     contains the plaintext, and revealSecret round-trips it.
 *
 *  2. revealSecret NEVER throws. A rotated APP_SIGNING_SECRET
 *     (docs/OPERATIONS.md §10), a tampered blob, or a missing secret all
 *     report { ok: false } so the mailer/Klaviyo resolvers fall back to the
 *     environment variables instead of taking delivery down.
 */

import {
  encryptSecret,
  isEncryptedSecret,
  revealSecret,
} from "~/lib/crypto/secrets.server";

const ORIGINAL_SECRET = process.env.APP_SIGNING_SECRET;

beforeEach(() => {
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.APP_SIGNING_SECRET;
  else process.env.APP_SIGNING_SECRET = ORIGINAL_SECRET;
});

describe("encryptSecret", () => {
  it("round-trips through revealSecret", () => {
    const blob = encryptSecret("pk_super_secret_key");
    expect(isEncryptedSecret(blob)).toBe(true);
    expect(revealSecret(blob)).toEqual({ ok: true, value: "pk_super_secret_key" });
  });

  it("never embeds the plaintext and uses a fresh IV per call", () => {
    const a = encryptSecret("hunter2-hunter2");
    const b = encryptSecret("hunter2-hunter2");
    expect(a).not.toContain("hunter2");
    expect(a).not.toBe(b); // random IV — equal plaintexts, distinct blobs
    expect(revealSecret(a)).toEqual({ ok: true, value: "hunter2-hunter2" });
    expect(revealSecret(b)).toEqual({ ok: true, value: "hunter2-hunter2" });
  });

  it("throws only when APP_SIGNING_SECRET is unset (write path may fail loud)", () => {
    delete process.env.APP_SIGNING_SECRET;
    expect(() => encryptSecret("x")).toThrow(/APP_SIGNING_SECRET/);
  });
});

describe("revealSecret never throws", () => {
  it('"" (nothing stored) is ok with an empty value', () => {
    expect(revealSecret("")).toEqual({ ok: true, value: "" });
  });

  it("an unprefixed value passes through as plaintext (hand-edited Setting row)", () => {
    expect(revealSecret("pk_typed_directly_into_db")).toEqual({
      ok: true,
      value: "pk_typed_directly_into_db",
    });
  });

  it("a tampered blob reports ok:false instead of throwing", () => {
    const blob = encryptSecret("pk_super_secret_key");
    const tampered = blob.slice(0, -4) + "AAAA";
    expect(revealSecret(tampered).ok).toBe(false);
  });

  it("a truncated blob reports ok:false", () => {
    expect(revealSecret("enc:v1:not-even-three-parts").ok).toBe(false);
  });

  it("a rotated APP_SIGNING_SECRET reports ok:false — env fallback, not an outage", () => {
    const blob = encryptSecret("pk_super_secret_key");
    process.env.APP_SIGNING_SECRET = "rotated-to-a-new-secret";
    expect(revealSecret(blob).ok).toBe(false);
  });

  it("a missing APP_SIGNING_SECRET reports ok:false for encrypted blobs", () => {
    const blob = encryptSecret("pk_super_secret_key");
    delete process.env.APP_SIGNING_SECRET;
    expect(revealSecret(blob).ok).toBe(false);
  });
});
