import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MAIL_PROVIDER resolution — the forgot-to-configure-mail production deploy.
 *
 * Historically anything other than the exact string "smtp" silently became
 * the console provider, which logs and REPORTS SUCCESS. In production that
 * combination is catastrophic: a deploy that forgets MAIL_PROVIDER (or typos
 * it) console-logs every OTP code, 3DS action request and admin alert,
 * NotificationLog records SENT for mail nobody received, and /api/health
 * stayed green because verifyMailer() had zero call sites.
 *
 * The contract under test:
 *  - MAIL_PROVIDER is case-insensitive ("SMTP" is smtp, not a silent typo);
 *  - an EXPLICIT console choice works everywhere (dev/test/staging opt-in);
 *  - an IMPLICIT console fallback (unset or unknown value) still works in
 *    dev/test but FAILS LOUD in production: sendEmail throws (the send lands
 *    as FAILED, not SENT) and verifyMailer reports ok:false so /api/health
 *    goes red;
 *  - verifyMailer mirrors sendEmail's policy exactly: every state in which
 *    sendEmail would throw reports ok:false.
 */

const createTransport = vi.hoisted(() => vi.fn());

vi.mock("nodemailer", () => ({
  default: { createTransport },
}));

import { sendEmail, verifyMailer } from "~/lib/notifications/mailer.server";

const MAIL = { to: "sub@example.com", subject: "OTP", html: "<p>123456</p>" };

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  MAIL_PROVIDER: process.env.MAIL_PROVIDER,
  SMTP_HOST: process.env.SMTP_HOST,
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The module caches the transport on globalThis — a leftover from another
  // test would bypass createTransport entirely.
  global.__cellexiaMailTransport = undefined;
  delete process.env.MAIL_PROVIDER;
  delete process.env.SMTP_HOST;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  setEnv("NODE_ENV", ORIGINAL_ENV.NODE_ENV);
  setEnv("MAIL_PROVIDER", ORIGINAL_ENV.MAIL_PROVIDER);
  setEnv("SMTP_HOST", ORIGINAL_ENV.SMTP_HOST);
  global.__cellexiaMailTransport = undefined;
  vi.restoreAllMocks();
});

function smtpTransportMock(overrides: Partial<{ verify: unknown; sendMail: unknown }> = {}) {
  const transport = {
    verify: vi.fn(async () => true),
    sendMail: vi.fn(async () => ({ messageId: "m1" })),
    ...overrides,
  };
  createTransport.mockReturnValue(transport);
  return transport;
}

describe("production refuses the implicit console fallback", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });

  it("sendEmail throws when MAIL_PROVIDER is unset — the send must land FAILED, never SENT", async () => {
    await expect(sendEmail(MAIL)).rejects.toThrow(/MAIL_PROVIDER is not set/);
    // Nothing was logged as if delivered.
    expect(console.log).not.toHaveBeenCalled();
  });

  it("sendEmail throws on a typo'd MAIL_PROVIDER (the 'smpt' deploy)", async () => {
    process.env.MAIL_PROVIDER = "smpt";
    await expect(sendEmail(MAIL)).rejects.toThrow(/unknown value "smpt"/);
  });

  it("verifyMailer reports the same states unhealthy, so /api/health goes red", async () => {
    const unset = await verifyMailer();
    expect(unset).toMatchObject({
      ok: false,
      provider: "console",
      implicitFallback: true,
    });
    expect(unset.error).toMatch(/MAIL_PROVIDER is not set/);

    process.env.MAIL_PROVIDER = "Klaviyo"; // plausible operator confusion
    const unknown = await verifyMailer();
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Klaviyo");
  });

  it("an EXPLICIT console choice still works in production (staging opt-in)", async () => {
    process.env.MAIL_PROVIDER = "console";
    await expect(sendEmail(MAIL)).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    await expect(verifyMailer()).resolves.toEqual({
      ok: true,
      provider: "console",
      source: "env",
      from: "Cellexia <no-reply@cellexia.com>",
    });
  });
});

describe("dev/test keep the mail-free default", () => {
  it("unset MAIL_PROVIDER console-logs and succeeds outside production", async () => {
    process.env.NODE_ENV = "test";
    await expect(sendEmail(MAIL)).resolves.toBeUndefined();
    expect(console.log).toHaveBeenCalledTimes(1);
    const status = await verifyMailer();
    expect(status).toMatchObject({
      ok: true,
      provider: "console",
      implicitFallback: true, // still surfaced, just not unhealthy
    });
  });
});

describe("MAIL_PROVIDER is case-insensitive", () => {
  it('"SMTP" routes to the smtp transport instead of silently becoming console', async () => {
    process.env.NODE_ENV = "production";
    process.env.MAIL_PROVIDER = "SMTP";
    process.env.SMTP_HOST = "mail.example.com";
    const transport = smtpTransportMock();

    await sendEmail(MAIL);

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
    await expect(verifyMailer()).resolves.toEqual({
      ok: true,
      provider: "smtp",
      source: "env",
      from: "Cellexia <no-reply@cellexia.com>",
    });
    expect(transport.verify).toHaveBeenCalledTimes(1);
  });

  it("smtp verify failure surfaces as unhealthy with the transport error", async () => {
    process.env.MAIL_PROVIDER = "smtp";
    process.env.SMTP_HOST = "mail.example.com";
    smtpTransportMock({
      verify: vi.fn(async () => {
        throw new Error("Invalid login: 535");
      }),
    });

    const status = await verifyMailer();
    expect(status.ok).toBe(false);
    expect(status.provider).toBe("smtp");
    expect(status.error).toContain("535");
  });

  it("smtp without SMTP_HOST is unhealthy, not a silent console fallback", async () => {
    process.env.MAIL_PROVIDER = "smtp";
    await expect(sendEmail(MAIL)).rejects.toThrow(/SMTP_HOST is not set/);
    const status = await verifyMailer();
    expect(status).toMatchObject({ ok: false, provider: "smtp" });
  });
});
