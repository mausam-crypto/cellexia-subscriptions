import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CREDENTIAL TYPED INTO THE SETTINGS PAGE MUST NEVER COME BACK OUT.
 *
 * The mailTransport/klaviyo sections hold secrets (SMTP password, Klaviyo
 * private key). Four surfaces could leak them, and each is pinned here:
 *
 *  1. The loader: stored blobs never reach the browser — secret fields are
 *     blanked, replaced by a "where does the effective value come from" hint.
 *  2. The Setting table: a typed value is stored encrypted ("enc:v1:..."),
 *     never plaintext.
 *  3. The settings_updated audit event (append-only SubscriberEvent rows,
 *     rendered on the Audit page and exported as CSV): both `value` and
 *     `previous` carry markers — "(set)"/"(updated)"/"(cleared)" — never the
 *     credential, encrypted or not.
 *  4. The save round-trip: a blank secret field means "keep what is stored"
 *     (the form can't echo it, so blank must not erase it); the explicit
 *     clear checkbox is the only way to remove it.
 *
 * Follows the tests/aud-platform-settings-audit.test.ts harness.
 */

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(async (): Promise<unknown> => ({
    session: { shop: "cellexia.myshopify.com" },
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    currencyCode: "GBP",
  })),
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
  // Typed with the 4-arg signature so recorded calls can be inspected.
  setSetting: vi.fn(
    async (
      _shopId?: unknown,
      _key?: unknown,
      _value?: unknown,
      _actor?: unknown,
    ): Promise<void> => {},
  ),
  getAllSettings: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  verifyMailer: vi.fn(async (_shopId?: string): Promise<unknown> => ({
    ok: true,
    provider: "smtp",
    source: "settings",
  })),
  probeKlaviyoKey: vi.fn(async (_key: string): Promise<unknown> => ({
    ok: true,
    detail: "Klaviyo accepted the key.",
  })),
  resolveKlaviyoAuth: vi.fn(async (_shopId?: string): Promise<unknown> => ({
    apiKey: null,
    revision: "2024-10-15",
    source: null,
  })),
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
  getAllSettings: mocks.getAllSettings,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/notifications/mailer.server", () => ({
  verifyMailer: mocks.verifyMailer,
}));
vi.mock("~/lib/klaviyo/client.server", () => ({
  probeKlaviyoKey: mocks.probeKlaviyoKey,
  resolveKlaviyoAuth: mocks.resolveKlaviyoAuth,
}));

const { action, loader } = await import("~/routes/app.settings");
const { revealSecret } = await import("~/lib/crypto/secrets.server");

function post(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://cellexia.example/app/settings", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function invokeAction(request: Request) {
  return action({ request, params: {}, context: {} } as never) as Promise<
    Response
  >;
}

function invokeLoader() {
  const request = new Request("https://cellexia.example/app/settings");
  return loader({ request, params: {}, context: {} } as never) as Promise<
    Response
  >;
}

/** A stored settings record with both secrets present. */
function allSettingsWithSecrets(overrides: Record<string, unknown> = {}) {
  return {
    mailTransport: {
      provider: "smtp",
      from: "Cellexia <care@cellexia.com>",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "cellexia",
      smtpPass: "enc:v1:stored-mail-blob",
      smtpSecure: "auto",
    },
    klaviyo: { privateApiKey: "enc:v1:stored-klaviyo-blob" },
    ...overrides,
  };
}

const ENV_KEYS = ["APP_SIGNING_SECRET", "SMTP_PASS", "KLAVIYO_PRIVATE_API_KEY"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
  mocks.authenticateAdmin.mockResolvedValue({
    session: { shop: "cellexia.myshopify.com" },
  });
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    currencyCode: "GBP",
  });
  mocks.getSetting.mockResolvedValue({});
  mocks.getAllSettings.mockResolvedValue(allSettingsWithSecrets());
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
});

describe("loader redaction", () => {
  it("blanks stored secrets and reports their source as settings", async () => {
    const res = await invokeLoader();
    const data = (await res.json()) as {
      settings: {
        mailTransport: { smtpPass: string; smtpHost: string };
        klaviyo: { privateApiKey: string };
      };
      secretsState: Record<string, string>;
    };
    expect(data.settings.mailTransport.smtpPass).toBe("");
    expect(data.settings.klaviyo.privateApiKey).toBe("");
    // Non-secret fields still round-trip to the form.
    expect(data.settings.mailTransport.smtpHost).toBe("smtp.example.com");
    expect(data.secretsState).toEqual({
      "mailTransport.smtpPass": "settings",
      "klaviyo.privateApiKey": "settings",
    });
    // Nothing in the whole response carries the stored blobs.
    expect(JSON.stringify(data)).not.toContain("enc:v1:");
  });

  it("reports env when nothing is stored but the env var exists, else none", async () => {
    mocks.getAllSettings.mockResolvedValue(
      allSettingsWithSecrets({
        mailTransport: {
          provider: "",
          from: "",
          smtpHost: "",
          smtpPort: 0,
          smtpUser: "",
          smtpPass: "",
          smtpSecure: "auto",
        },
        klaviyo: { privateApiKey: "" },
      }),
    );
    process.env.SMTP_PASS = "env-pass";
    const res = await invokeLoader();
    const data = (await res.json()) as { secretsState: Record<string, string> };
    expect(data.secretsState).toEqual({
      "mailTransport.smtpPass": "env",
      "klaviyo.privateApiKey": "none",
    });
  });
});

describe("secret save semantics", () => {
  it("a typed Klaviyo key is stored encrypted and audited as markers only", async () => {
    const res = await invokeAction(
      post({
        intent: "save-section",
        section: "klaviyo",
        f_privateApiKey: "pk_live_secret_123",
        f_privateApiKey__clear: "false",
      }),
    );
    expect(res.status).toBe(200);

    const [, key, value] = mocks.setSetting.mock.calls[0] as unknown as [
      string,
      string,
      { privateApiKey: string },
      string,
    ];
    expect(key).toBe("klaviyo");
    expect(value.privateApiKey).toMatch(/^enc:v1:/);
    expect(value.privateApiKey).not.toContain("pk_live_secret_123");
    // The blob genuinely decrypts back to what was typed.
    expect(revealSecret(value.privateApiKey)).toEqual({
      ok: true,
      value: "pk_live_secret_123",
    });

    const event = mocks.logEvent.mock.calls[0]![0] as {
      payload: {
        value: { privateApiKey: string };
        previous: { privateApiKey: string };
      };
    };
    expect(event.payload.value.privateApiKey).toBe("(updated)");
    expect(event.payload.previous.privateApiKey).toBe("(not set)");
    // Neither the plaintext nor the ciphertext lands in the audit trail.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("pk_live_secret_123");
    expect(serialized).not.toContain("enc:v1:");
  });

  it("a blank secret field keeps the stored value", async () => {
    mocks.getSetting.mockResolvedValue({ privateApiKey: "enc:v1:prior-blob" });
    const res = await invokeAction(
      post({
        intent: "save-section",
        section: "klaviyo",
        f_privateApiKey: "",
        f_privateApiKey__clear: "false",
      }),
    );
    expect(res.status).toBe(200);
    const value = mocks.setSetting.mock.calls[0]![2] as {
      privateApiKey: string;
    };
    expect(value.privateApiKey).toBe("enc:v1:prior-blob");
    const event = mocks.logEvent.mock.calls[0]![0] as {
      payload: {
        value: { privateApiKey: string };
        previous: { privateApiKey: string };
      };
    };
    expect(event.payload.value.privateApiKey).toBe("(unchanged)");
    expect(event.payload.previous.privateApiKey).toBe("(set)");
  });

  it("the clear checkbox removes the stored value", async () => {
    mocks.getSetting.mockResolvedValue({ privateApiKey: "enc:v1:prior-blob" });
    const res = await invokeAction(
      post({
        intent: "save-section",
        section: "klaviyo",
        f_privateApiKey: "",
        f_privateApiKey__clear: "true",
      }),
    );
    expect(res.status).toBe(200);
    const value = mocks.setSetting.mock.calls[0]![2] as {
      privateApiKey: string;
    };
    expect(value.privateApiKey).toBe("");
    const event = mocks.logEvent.mock.calls[0]![0] as {
      payload: { value: { privateApiKey: string } };
    };
    expect(event.payload.value.privateApiKey).toBe("(cleared)");
  });

  it("a mailTransport save encrypts the password and keeps the rest intact", async () => {
    const res = await invokeAction(
      post({
        intent: "save-section",
        section: "mailTransport",
        f_provider: "smtp",
        f_from: "Cellexia <care@cellexia.com>",
        f_smtpHost: "smtp.example.com",
        f_smtpPort: "587",
        f_smtpUser: "cellexia",
        f_smtpPass: "hunter2-hunter2",
        f_smtpPass__clear: "false",
        f_smtpSecure: "auto",
      }),
    );
    expect(res.status).toBe(200);
    const value = mocks.setSetting.mock.calls[0]![2] as {
      provider: string;
      smtpPort: number;
      smtpPass: string;
    };
    expect(value.provider).toBe("smtp");
    expect(value.smtpPort).toBe(587);
    expect(revealSecret(value.smtpPass)).toEqual({
      ok: true,
      value: "hunter2-hunter2",
    });
    const serialized = JSON.stringify(mocks.logEvent.mock.calls[0]![0]);
    expect(serialized).not.toContain("hunter2");
  });
});

describe("test-connection intents", () => {
  it("test-mailer verifies the saved transport for the primary shop", async () => {
    mocks.verifyMailer.mockResolvedValue({
      ok: false,
      provider: "smtp",
      source: "settings",
      error: "connect ECONNREFUSED",
    });
    const res = await invokeAction(post({ intent: "test-mailer" }));
    const data = (await res.json()) as { ok: boolean; toast: string };
    expect(mocks.verifyMailer).toHaveBeenCalledWith("shop_1");
    expect(data.ok).toBe(false);
    expect(data.toast).toContain("ECONNREFUSED");
  });

  it("test-klaviyo probes the TYPED key before it is ever saved", async () => {
    const res = await invokeAction(
      post({ intent: "test-klaviyo", key: "pk_candidate" }),
    );
    const data = (await res.json()) as { ok: boolean; toast: string };
    expect(mocks.probeKlaviyoKey).toHaveBeenCalledWith("pk_candidate");
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(data.ok).toBe(true);
  });

  it("test-klaviyo with no key anywhere fails without probing", async () => {
    const res = await invokeAction(post({ intent: "test-klaviyo" }));
    const data = (await res.json()) as { ok: boolean; toast: string };
    expect(mocks.probeKlaviyoKey).not.toHaveBeenCalled();
    expect(data.ok).toBe(false);
    expect(data.toast).toContain("No Klaviyo key");
  });
});
