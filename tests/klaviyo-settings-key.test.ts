import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ADMIN-CONFIGURED KLAVIYO KEY IS THE ONE THAT AUTHENTICATES — AND ITS
 * ABSENCE OR CORRUPTION FALLS BACK TO THE ENV VAR, NEVER TO AN OUTAGE.
 *
 * v1.12.0 lets the merchant store the private API key on the Settings page
 * (`klaviyo` setting, encrypted at rest). Contracts pinned here:
 *
 *  - resolveKlaviyoAuth precedence: settings key (decrypted) → env key →
 *    null; decrypt failure (rotated APP_SIGNING_SECRET) → env, with a log.
 *  - the resolved key is what createKlaviyoEvent actually puts on the wire
 *    (Authorization header), not whatever happens to be in process.env.
 *  - isKlaviyoConfigured is async and shop-aware; without a shopId it never
 *    touches settings (env-only callers keep working).
 *  - probeKlaviyoKey (the Settings "Test key" button): only 401 condemns a
 *    key — 403 is a healthy Events-only scoped key (docs recommend exactly
 *    that scoping), and network failures are inconclusive, not failures of
 *    the key.
 */

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

import {
  createKlaviyoEvent,
  isKlaviyoConfigured,
  probeKlaviyoKey,
  resolveKlaviyoAuth,
} from "~/lib/klaviyo/client.server";
import { encryptSecret } from "~/lib/crypto/secrets.server";

const ENV_KEYS = [
  "KLAVIYO_PRIVATE_API_KEY",
  "KLAVIYO_API_REVISION",
  "APP_SIGNING_SECRET",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
  mocks.getSetting.mockResolvedValue({});
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveKlaviyoAuth precedence", () => {
  it("a stored settings key wins over the env var", async () => {
    mocks.getSetting.mockResolvedValue({
      privateApiKey: encryptSecret("pk_settings"),
    });
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";

    await expect(resolveKlaviyoAuth("shop_1")).resolves.toMatchObject({
      apiKey: "pk_settings",
      source: "settings",
    });
  });

  it("an undecryptable stored key falls back to env, with a log", async () => {
    mocks.getSetting.mockResolvedValue({ privateApiKey: "enc:v1:AAAA.BBBB.CCCC" });
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";

    await expect(resolveKlaviyoAuth("shop_1")).resolves.toMatchObject({
      apiKey: "pk_env",
      source: "env",
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("no settings key → env; neither → null", async () => {
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";
    await expect(resolveKlaviyoAuth("shop_1")).resolves.toMatchObject({
      apiKey: "pk_env",
      source: "env",
    });
    delete process.env.KLAVIYO_PRIVATE_API_KEY;
    await expect(resolveKlaviyoAuth("shop_1")).resolves.toMatchObject({
      apiKey: null,
      source: null,
    });
  });

  it("a throwing settings read degrades to env", async () => {
    mocks.getSetting.mockRejectedValue(new Error("db down"));
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";
    await expect(resolveKlaviyoAuth("shop_1")).resolves.toMatchObject({
      apiKey: "pk_env",
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("without a shopId the settings layer is never consulted", async () => {
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";
    await expect(isKlaviyoConfigured()).resolves.toBe(true);
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });

  it("isKlaviyoConfigured is shop-aware", async () => {
    mocks.getSetting.mockResolvedValue({
      privateApiKey: encryptSecret("pk_settings"),
    });
    await expect(isKlaviyoConfigured("shop_1")).resolves.toBe(true);
  });
});

describe("the resolved key is the one on the wire", () => {
  it("createKlaviyoEvent authenticates with the auth param, not process.env", async () => {
    process.env.KLAVIYO_PRIVATE_API_KEY = "pk_env";
    fetchMock.mockResolvedValue(new Response(null, { status: 202 }));

    const result = await createKlaviyoEvent(
      { eventName: "Cellexia Test", email: "anna@example.com" },
      { apiKey: "pk_settings", revision: "2024-10-15", source: "settings" },
    );

    expect(result.ok).toBe(true);
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBe("Klaviyo-API-Key pk_settings");
    expect(headers.revision).toBe("2024-10-15");
  });
});

describe("probeKlaviyoKey classification", () => {
  it("2xx accepts", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(probeKlaviyoKey("pk_x")).resolves.toMatchObject({ ok: true });
  });

  it("401 condemns", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 401 }));
    const probe = await probeKlaviyoKey("pk_x");
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("401");
  });

  it("403 is a healthy Events-only scoped key", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 403 }));
    const probe = await probeKlaviyoKey("pk_x");
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("Events");
  });

  it("network failure is inconclusive, not a bad key", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    const probe = await probeKlaviyoKey("pk_x");
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("try again");
  });
});
