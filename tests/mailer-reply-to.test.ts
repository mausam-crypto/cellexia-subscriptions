import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reply-To on direct mail (v1.28.0, P5.1). Before this release
 * mailer.server.ts sent no Reply-To at all — a customer hitting Reply on
 * an OTP / payment email answered a no-reply mailbox.
 *
 * Pins:
 *  - with a shopId, sendEmail sets Reply-To from the resolved support
 *    channel (settings.support.replyTo → support.email → Shop.contactEmail);
 *  - an explicit `replyTo` on the send input wins (the merchant-bound
 *    support-request email uses the CUSTOMER's address);
 *  - nothing resolvable ⇒ no header (byte-identical to the old contract);
 *  - a broken channel resolver never blocks the send;
 *  - the console transport logs it, the SMTP transport passes it to
 *    nodemailer as `replyTo` — for the settings AND the env transports.
 *  - From fallback: with neither settings.from nor MAIL_FROM, a shop-aware
 *    resolution uses `Cellexia <support email>` instead of the hard-coded
 *    no-reply@cellexia.com literal.
 */

const createTransport = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/db.server", () => ({
  default: { shop: { findUnique: mocks.shopFindUnique } },
}));

import { resolveMailConfig, resolveReplyTo, sendEmail, verifyMailer } from "~/lib/notifications/mailer.server";

const MAIL = { to: "anna@example.com", subject: "s", html: "<p>h</p>" };
const ENV_KEYS = ["NODE_ENV", "MAIL_PROVIDER", "MAIL_FROM", "SMTP_HOST", "SMTP_PORT"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function smtpTransportMock() {
  const transport = {
    verify: vi.fn(async () => true),
    sendMail: vi.fn(async (_mail: unknown) => ({ messageId: "m1" })),
  };
  createTransport.mockReturnValue(transport);
  return transport;
}

function settings(overrides: Record<string, unknown>) {
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
    if (key in overrides) return overrides[key];
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  global.__cellexiaMailTransport = undefined;
  mocks.getSetting.mockImplementation(async () => ({}));
  mocks.shopFindUnique.mockResolvedValue(null);
  setEnv("NODE_ENV", "test");
  setEnv("MAIL_PROVIDER", "smtp");
  setEnv("MAIL_FROM", "Cellexia <care@cellexialabs.com>");
  setEnv("SMTP_HOST", "smtp.env.example");
  setEnv("SMTP_PORT", "587");
});

afterEach(() => {
  for (const k of ENV_KEYS) setEnv(k, ORIGINAL_ENV[k]);
});

describe("resolveReplyTo", () => {
  it("explicit input wins over the shop channel", async () => {
    settings({ support: { email: "care@cellexialabs.com" } });
    expect(await resolveReplyTo({ shopId: "shop_1", replyTo: "  anna@example.com " })).toBe(
      "anna@example.com",
    );
  });

  it("support.replyTo → support.email → Shop.contactEmail → null", async () => {
    settings({ support: { email: "care@cellexialabs.com", replyTo: "desk@helpdesk.io" } });
    expect(await resolveReplyTo({ shopId: "shop_1" })).toBe("desk@helpdesk.io");

    settings({ support: { email: "care@cellexialabs.com" } });
    expect(await resolveReplyTo({ shopId: "shop_1" })).toBe("care@cellexialabs.com");

    settings({ support: { email: "" } });
    mocks.shopFindUnique.mockResolvedValue({ contactEmail: "hello@cellexialabs.com" });
    expect(await resolveReplyTo({ shopId: "shop_1" })).toBe("hello@cellexialabs.com");

    mocks.shopFindUnique.mockResolvedValue(null);
    expect(await resolveReplyTo({ shopId: "shop_1" })).toBeNull();
  });

  it("no shopId ⇒ no header (env-only callers keep the old contract)", async () => {
    settings({ support: { email: "care@cellexialabs.com" } });
    expect(await resolveReplyTo({})).toBeNull();
  });
});

describe("sendEmail — SMTP transport", () => {
  it("env transport: passes replyTo from the shop's support channel", async () => {
    settings({ support: { email: "care@cellexialabs.com" } });
    const transport = smtpTransportMock();
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ replyTo: "care@cellexialabs.com", to: MAIL.to }),
    );
  });

  it("settings transport: same header, and an explicit replyTo overrides it", async () => {
    settings({
      support: { email: "care@cellexialabs.com" },
      mailTransport: {
        provider: "smtp",
        from: "Cellexia <care@cellexialabs.com>",
        smtpHost: "smtp.settings.example",
        smtpPort: 2525,
        smtpUser: "",
        smtpPass: "",
        smtpSecure: "never",
      },
    });
    const transport = smtpTransportMock();
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    expect(transport.sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ replyTo: "care@cellexialabs.com" }),
    );
    await sendEmail({ ...MAIL, shopId: "shop_1", replyTo: "anna@example.com" });
    expect(transport.sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ replyTo: "anna@example.com" }),
    );
  });

  it("nothing resolvable ⇒ NO replyTo key at all (old contract)", async () => {
    const transport = smtpTransportMock();
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    const call = transport.sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect("replyTo" in call).toBe(false);
    await sendEmail(MAIL);
    const shopless = transport.sendMail.mock.calls[1][0] as Record<string, unknown>;
    expect("replyTo" in shopless).toBe(false);
  });

  it("a broken channel resolver never blocks the send", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "support") throw new Error("boom");
      return {};
    });
    mocks.shopFindUnique.mockRejectedValue(new Error("db down"));
    const transport = smtpTransportMock();
    await expect(sendEmail({ ...MAIL, shopId: "shop_1" })).resolves.toBeUndefined();
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});

describe("sendEmail — console transport", () => {
  it("logs the reply-to and still succeeds", async () => {
    setEnv("MAIL_PROVIDER", "console");
    settings({ support: { email: "care@cellexialabs.com" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendEmail({ ...MAIL, shopId: "shop_1" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("replyTo=care@cellexialabs.com"));
    log.mockRestore();
  });
});

describe("From fallback of last resort", () => {
  it("no settings.from and no MAIL_FROM: a shop-aware resolution uses the support email, not no-reply@cellexia.com", async () => {
    setEnv("MAIL_FROM", undefined);
    settings({ support: { email: "care@cellexialabs.com" } });
    const config = await resolveMailConfig("shop_1");
    expect(config.from).toBe("Cellexia <care@cellexialabs.com>");
  });

  it("MAIL_FROM still wins over the support fallback; shop-less resolution keeps the literal", async () => {
    settings({ support: { email: "care@cellexialabs.com" } });
    expect((await resolveMailConfig("shop_1")).from).toBe("Cellexia <care@cellexialabs.com>");
    setEnv("MAIL_FROM", "Env <env@cellexialabs.com>");
    expect((await resolveMailConfig("shop_1")).from).toBe("Env <env@cellexialabs.com>");
    setEnv("MAIL_FROM", undefined);
    expect((await resolveMailConfig()).from).toContain("no-reply@");
  });

  it("the engaged fallback is SURFACED (fromFallback: support_email) by resolveMailConfig and verifyMailer — transport.verify() never checks the sender, so the Settings test can warn", async () => {
    smtpTransportMock();
    setEnv("MAIL_FROM", undefined);
    settings({ support: { email: "care@cellexialabs.com" } });
    // Env transport (no mailTransport row).
    const envConfig = await resolveMailConfig("shop_1");
    expect(envConfig.fromFallback).toBe("support_email");
    const envStatus = await verifyMailer("shop_1");
    expect(envStatus.ok).toBe(true);
    expect(envStatus.from).toBe("Cellexia <care@cellexialabs.com>");
    expect(envStatus.fromFallback).toBe("support_email");
    // Settings transport with a blank From: same flag.
    settings({
      support: { email: "care@cellexialabs.com" },
      mailTransport: {
        provider: "smtp",
        from: "",
        smtpHost: "smtp.settings.example",
        smtpPort: 2525,
        smtpUser: "",
        smtpPass: "",
        smtpSecure: "never",
      },
    });
    const settingsStatus = await verifyMailer("shop_1");
    expect(settingsStatus.source).toBe("settings");
    expect(settingsStatus.fromFallback).toBe("support_email");
    // An explicit From (env or settings) ⇒ no flag at all.
    setEnv("MAIL_FROM", "Env <env@cellexialabs.com>");
    settings({ support: { email: "care@cellexialabs.com" } });
    const explicit = await verifyMailer("shop_1");
    expect(explicit.from).toBe("Env <env@cellexialabs.com>");
    expect(explicit.fromFallback).toBeUndefined();
    // No support email resolvable ⇒ the literal, no flag.
    setEnv("MAIL_FROM", undefined);
    settings({});
    const literal = await verifyMailer("shop_1");
    expect(literal.from).toContain("no-reply@");
    expect(literal.fromFallback).toBeUndefined();
  });
});
