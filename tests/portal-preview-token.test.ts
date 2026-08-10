import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stateless ?cx_pp= admin preview token (v1.7.0) — the cookie-less portal
 * identity that survives Shopify's app proxy, which strips Cookie/Set-Cookie
 * in both directions and therefore killed every cookie-based preview on a
 * live store. Signature first (timing-safe), then expiry, then the shop
 * binding; a token minted for one shop must never open another shop's portal.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-preview-token";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

import {
  PORTAL_PREVIEW_TTL_SECONDS,
  PREVIEW_TOKEN_PARAM,
  mintPreviewToken,
  verifyPreviewToken,
} from "~/lib/portal/previewToken.server";
import { signValue } from "~/lib/portal/session.server";

const INPUT = {
  shopId: "shop_1",
  customerId: "gid://shopify/Customer/1",
  contractId: "ctr_1",
  email: "sub@example.com",
};

const T0 = new Date("2026-08-08T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flip the final character of the signature segment, keeping its length. */
function tamperSignature(token: string): string {
  const dot = token.lastIndexOf(".");
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const last = sig.at(-1) === "A" ? "B" : "A";
  return `${body}.${sig.slice(0, -1)}${last}`;
}

describe("preview token roundtrip", () => {
  it("mints a token that verifies back to its payload", () => {
    const token = mintPreviewToken(INPUT, PORTAL_PREVIEW_TTL_SECONDS);
    const payload = verifyPreviewToken(token, "shop_1");
    expect(payload).not.toBeNull();
    expect(payload?.v).toBe(1);
    expect(payload?.shopId).toBe("shop_1");
    expect(payload?.customerId).toBe("gid://shopify/Customer/1");
    expect(payload?.contractId).toBe("ctr_1");
    expect(payload?.email).toBe("sub@example.com");
    // Default TTL is exactly 1 hour.
    expect(payload?.exp).toBe(Math.floor(T0.getTime() / 1000) + 3600);
  });

  it("survives until — and not past — its TTL", () => {
    const token = mintPreviewToken(INPUT, 3600);
    vi.setSystemTime(new Date(T0.getTime() + 3599_000));
    expect(verifyPreviewToken(token, "shop_1")).not.toBeNull();
    vi.setSystemTime(new Date(T0.getTime() + 3601_000));
    expect(verifyPreviewToken(token, "shop_1")).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = mintPreviewToken(INPUT);
    expect(verifyPreviewToken(tamperSignature(token), "shop_1")).toBeNull();
  });

  it("rejects a tampered payload even with the original signature", () => {
    const token = mintPreviewToken(INPUT);
    const dot = token.lastIndexOf(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...INPUT, v: 1, exp: 9999999999 }),
    ).toString("base64url");
    expect(
      verifyPreviewToken(`${forgedBody}.${token.slice(dot + 1)}`, "shop_1"),
    ).toBeNull();
  });

  it("rejects the wrong shop (shop binding)", () => {
    const token = mintPreviewToken(INPUT);
    expect(verifyPreviewToken(token, "shop_2")).toBeNull();
  });

  it("rejects garbage and empty strings", () => {
    expect(verifyPreviewToken("", "shop_1")).toBeNull();
    expect(verifyPreviewToken("not-a-token", "shop_1")).toBeNull();
    expect(verifyPreviewToken("a.b", "shop_1")).toBeNull();
  });

  it("returns null — never throws — for a signed non-object payload", () => {
    // JSON.parse("null") returns null WITHOUT throwing, so the try/catch
    // around the parse never sees it; before the guard, the first property
    // access dereferenced null and escaped as a 500. Defense-in-depth only
    // (reaching the parse at all requires a valid HMAC, and mintPreviewToken
    // never signs such a body) — but a signed degenerate body must fail
    // closed like every other invalid token.
    for (const body of ["null", "42", '"a-string"', "true"]) {
      const signed = signValue(Buffer.from(body).toString("base64url"));
      expect(() => verifyPreviewToken(signed, "shop_1")).not.toThrow();
      expect(verifyPreviewToken(signed, "shop_1")).toBeNull();
    }
  });
});

describe("wiring pins", () => {
  it("the query parameter is cx_pp everywhere", () => {
    expect(PREVIEW_TOKEN_PARAM).toBe("cx_pp");
    // session.server.ts cannot statically import the constant (previewToken
    // imports its signing primitives, which would be circular), so it carries
    // the literal — pin the two equal.
    const source = readFileSync(
      join(REPO_ROOT, "app/lib/portal/session.server.ts"),
      "utf8",
    );
    expect(source).toContain('const PREVIEW_TOKEN_PARAM = "cx_pp"');
  });

  it("the TTL matches the 1-hour admin card copy", () => {
    expect(PORTAL_PREVIEW_TTL_SECONDS).toBe(3600);
  });
});
