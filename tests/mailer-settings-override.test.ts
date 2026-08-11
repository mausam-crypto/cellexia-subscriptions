import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ADMIN-CONFIGURED MAIL TRANSPORT MUST DELIVER — AND MUST NEVER MAKE
 * DELIVERY WORSE THAN THE ENV-ONLY CONTRACT.
 *
 * v1.12.0 lets the merchant configure SMTP on the Settings page
 * (`mailTransport` setting) with the environment variables as fallback.
 * Contracts pinned here, on top of tests/mailer-provider.test.ts (which
 * pins the env-only behavior when no shopId is passed):
 *
 *  - provider "smtp" saved in Settings delivers with the settings values —
 *    even in production with NO MAIL_PROVIDER env at all (the exact state
 *    that fails loud without settings).
 *  - blank settings fields fall back to their matching env var, including
 *    the encrypted password falling back to SMTP_PASS when decryption fails
 *    (rotated APP_SIGNING_SECRET must not brick OTP mail).
 *  - provider "" (default) means the env contract applies verbatim: a
 *    production deploy without MAIL_PROVIDER still fails loud even though a
 *    (blank) mailTransport row exists.
 *  - a settings save takes effect without a restart: the transport cache is
 *    keyed by the resolved config, not created-once.
 *  - a broken settings read (DB down, mocked-away getSetting) degrades to
 *    env resolution instead of throwing.
 */

const createTransport = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
}));

vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

import { sendEmail, verifyMailer } from "~/lib/notifications/mailer.server";
import { encryptSecret } from "~/lib/crypto/secrets.server";

const MAIL = { to: "anna@example.com", subject: "s", html: "<p>h</p>" };
const ENV_KEYS = [
  "NODE_ENV",
  "MAIL_PROVIDER",
  "MAIL_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "APP_SIGNING_SECRET",
] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function smtpTransportMock() {
  const transport = {
    verify: vi.fn(async () => true),
    sendMail: vi.fn(async () => ({ messageId: "m1" })),
  };
  createTransport.mockReturnValue(transport);
  return transport;
}

/** A fully admin-configured SMTP section value. */
function settingsSmtp(overrides: Record<string, unknown> = {}) {
  return {
    provider: "smtp",
    from: "Cellexia Care <care@cellexia.com>",
    smtpHost: "smtp.settings.example",
    smtpPort: 2525,
    smtpUser: "settings-user",
    smtpPass: encryptSecret("settings-pass"),
    smtpSecure: "never",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = "production";
  process.env.APP_SIGNING_SECRET = "test-signing-secret";
  global.__cellexiaMailTransport = undefined;
  mocks.getSetting.mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) setEnv(k, ORIGINAL_ENV[k]);
  global.__cellexiaMailTransport = undefined;
  vi.restoreAllMocks();
});

describe("settings-configured SMTP delivers", () => {
  it("sends with the settings values in production with NO mail env at all", async () => {
    mocks.getSetting.mockResolvedValue(settingsSmtp());
    const transport = smtpTransportMock();

    await sendEmail({ ...MAIL, shopId: "shop_1" });

    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "mailTransport");
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.settings.example",
      port: 2525,
      secure: false,
      auth: { user: "settings-user", pass: "settings-pass" },
      // v1.17.0 fail-fast timeouts: sends can originate from portal
      // actions and webhook handlers (confirmation bridge) — a hung relay
      // must fail in seconds, not nodemailer's multi-minute defaults.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Cellexia Care <care@cellexia.com>",
        to: MAIL.to,
      }),
    );
  });

  it("verifyMailer(shopId) verifies the settings transport and reports source", async () => {
    mocks.getSetting.mockResolvedValue(settingsSmtp());
    const transport = smtpTransportMock();

    await expect(verifyMailer("shop_1")).resolves.toEqual({
      ok: true,
      provider: "smtp",
      source: "settings",
    });
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it("blank settings fields fall back to their env vars", async () => {
    mocks.getSetting.mockResolvedValue(
      settingsSmtp({ from: "", smtpHost: "", smtpPort: 0, smtpUser: "", smtpPass: "", smtpSecure: "auto" }),
    );
    setEnv("MAIL_FROM", "Env <env@cellexia.com>");
    setEnv("SMTP_HOST", "smtp.env.example");
    setEnv("SMTP_PORT", "465");
    setEnv("SMTP_USER", "env-user");
    setEnv("SMTP_PASS", "env-pass");
    const transport = smtpTransportMock();

    await sendEmail({ ...MAIL, shopId: "shop_1" });

    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.env.example",
      port: 465,
      secure: true, // auto + port 465
      auth: { user: "env-user", pass: "env-pass" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Env <env@cellexia.com>" }),
    );
  });

  it("an undecryptable stored password abandons the WHOLE settings transport for env (rotation survival)", async () => {
    // The admin host + a fallback password for a different relay could never
    // authenticate — after a rotation, the env transport the merchant
    // migrated from is the one configuration that may still work.
    mocks.getSetting.mockResolvedValue(
      settingsSmtp({ smtpPass: "enc:v1:AAAA.BBBB.CCCC" }),
    );
    setEnv("MAIL_PROVIDER", "smtp");
    setEnv("SMTP_HOST", "smtp.env.example");
    setEnv("SMTP_USER", "env-user");
    setEnv("SMTP_PASS", "env-pass");
    const transport = smtpTransportMock();

    await sendEmail({ ...MAIL, shopId: "shop_1" });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.env.example",
        auth: { user: "env-user", pass: "env-pass" },
      }),
    );
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });

  it("an undecryptable password with NO env transport still fails loud, never silent", async () => {
    mocks.getSetting.mockResolvedValue(
      settingsSmtp({ smtpPass: "enc:v1:AAAA.BBBB.CCCC" }),
    );
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).rejects.toThrow(
      /MAIL_PROVIDER is not set/,
    );
  });

  it("an explicit console choice is untouched by a corrupt leftover password blob", async () => {
    mocks.getSetting.mockResolvedValue(
      settingsSmtp({ provider: "console", smtpPass: "enc:v1:AAAA.BBBB.CCCC" }),
    );
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("settings smtp with no host anywhere fails loud, in the settings voice", async () => {
    mocks.getSetting.mockResolvedValue(settingsSmtp({ smtpHost: "" }));
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).rejects.toThrow(
      /Settings page but no SMTP host/,
    );
    const status = await verifyMailer("shop_1");
    expect(status.ok).toBe(false);
    expect(status.source).toBe("settings");
  });

  it("an explicit console choice in Settings works in production (staging opt-in parity)", async () => {
    mocks.getSetting.mockResolvedValue(settingsSmtp({ provider: "console" }));
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    await expect(verifyMailer("shop_1")).resolves.toEqual({
      ok: true,
      provider: "console",
      source: "settings",
    });
  });
});

describe("the env contract survives the settings layer", () => {
  it('provider "" (default row) keeps the production fail-loud behavior', async () => {
    mocks.getSetting.mockResolvedValue({
      provider: "",
      from: "",
      smtpHost: "",
      smtpPort: 0,
      smtpUser: "",
      smtpPass: "",
      smtpSecure: "auto",
    });
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).rejects.toThrow(
      /MAIL_PROVIDER is not set/,
    );
  });

  it("without a shopId the settings layer is never consulted", async () => {
    setEnv("MAIL_PROVIDER", "console");
    await expect(sendEmail(MAIL)).resolves.toBeUndefined();
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });

  it("a schema-invalid {} settings value (mocked-away suites) means env resolution", async () => {
    mocks.getSetting.mockResolvedValue({});
    setEnv("MAIL_PROVIDER", "console");
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
  });

  it("a throwing settings read degrades to env instead of failing the send", async () => {
    mocks.getSetting.mockRejectedValue(new Error("db down"));
    setEnv("MAIL_PROVIDER", "smtp");
    setEnv("SMTP_HOST", "smtp.env.example");
    const transport = smtpTransportMock();

    await sendEmail({ ...MAIL, shopId: "shop_1" });

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("a settings save takes effect without a restart", () => {
  it("the transport rebuilds when the resolved config changes, and only then", async () => {
    mocks.getSetting.mockResolvedValue(settingsSmtp({ smtpHost: "smtp.a.example" }));
    smtpTransportMock();
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    expect(createTransport).toHaveBeenCalledTimes(1); // same config — cached

    mocks.getSetting.mockResolvedValue(settingsSmtp({ smtpHost: "smtp.b.example" }));
    smtpTransportMock();
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    expect(createTransport).toHaveBeenCalledTimes(2); // config changed — rebuilt
    expect(createTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "smtp.b.example" }),
    );
  });
});
