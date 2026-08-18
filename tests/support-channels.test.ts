import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Support channels (v1.28.0, P5.1) — the ONE resolver behind the Get-help
 * card, the cancel-flow support cards, the mailer's Reply-To and the
 * merchant email.
 *
 * Pins:
 *  - settings.support.email → Shop.contactEmail → null (no dead mailto:);
 *  - replyTo → email; whatsapp normalized to E.164 → wa.me; chatUrl https only;
 *  - slaBusinessDays defaults to 1 and is bounded;
 *  - the Shop record is only read when the setting leaves the email blank;
 *  - every failure (settings, DB) degrades to the empty channel set — never
 *    throws (golden rule 9);
 *  - the registry ships the `support` group with the documented defaults;
 *  - the hard-coded `mailto:support@cellexia.com` is GONE from every locale
 *    (the store is cellexialabs.com) — the two URL keys became subject-only
 *    keys, present in all 22 catalogs;
 *  - the mailto builder encodes the subject RFC 6068-style (%20, not +).
 */

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: { shop: { findUnique: mocks.shopFindUnique } },
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

import {
  EMPTY_SUPPORT_CHANNELS,
  getSupportChannels,
  mailtoHref,
  normalizeChatUrl,
  normalizeSupportEmail,
  normalizeWhatsapp,
  resolveSupportChannels,
  whatsappHrefFor,
} from "~/lib/support/channels.server";
import { defaultFor, settingsSchemas } from "~/lib/settings/registry.server";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockResolvedValue({});
  mocks.shopFindUnique.mockResolvedValue(null);
});

describe("resolveSupportChannels (pure)", () => {
  it("setting email wins; replyTo falls back to it", () => {
    const c = resolveSupportChannels(
      { email: " care@cellexialabs.com ", replyTo: "" },
      "shop@cellexialabs.com",
    );
    expect(c.email).toBe("care@cellexialabs.com");
    expect(c.replyTo).toBe("care@cellexialabs.com");
    expect(c.hasAny).toBe(true);
  });

  it("blank setting → the Shop's contact email; both blank → null and hasAny false", () => {
    expect(resolveSupportChannels({ email: "" }, "shop@cellexialabs.com").email).toBe(
      "shop@cellexialabs.com",
    );
    const none = resolveSupportChannels({}, null);
    expect(none.email).toBeNull();
    expect(none.replyTo).toBeNull();
    expect(none.hasAny).toBe(false);
  });

  it("an explicit replyTo overrides; a malformed one is ignored", () => {
    expect(
      resolveSupportChannels({ email: "a@x.io", replyTo: "desk@helpdesk.io" }, null).replyTo,
    ).toBe("desk@helpdesk.io");
    expect(
      resolveSupportChannels({ email: "a@x.io", replyTo: "not an email" }, null).replyTo,
    ).toBe("a@x.io");
  });

  it("whatsapp normalizes to E.164 and links to wa.me; malformed → hidden", () => {
    const c = resolveSupportChannels({ whatsapp: "+41 79 123 45 67" }, null);
    expect(c.whatsapp).toBe("+41791234567");
    expect(c.whatsappHref).toBe("https://wa.me/41791234567");
    expect(c.hasAny).toBe(true);
    expect(resolveSupportChannels({ whatsapp: "call me" }, null).whatsapp).toBeNull();
    expect(normalizeWhatsapp("0041 (79) 123-45-67")).toBe("+41791234567");
    expect(normalizeWhatsapp("123")).toBeNull();
    expect(whatsappHrefFor("+41791234567", "Hi there")).toBe(
      "https://wa.me/41791234567?text=Hi%20there",
    );
  });

  it("chatUrl must be https; hoursNote trimmed; SLA bounded with default 1", () => {
    const c = resolveSupportChannels(
      { chatUrl: "https://chat.example.com/x", hoursNote: "  Mon–Fri 9–17 CET ", slaBusinessDays: 2 },
      null,
    );
    expect(c.chatUrl).toBe("https://chat.example.com/x");
    expect(c.hoursNote).toBe("Mon–Fri 9–17 CET");
    expect(c.slaBusinessDays).toBe(2);
    expect(normalizeChatUrl("http://insecure.example")).toBeNull();
    expect(normalizeChatUrl("javascript:alert(1)")).toBeNull();
    expect(resolveSupportChannels({ slaBusinessDays: 0 }, null).slaBusinessDays).toBe(1);
    expect(resolveSupportChannels({ slaBusinessDays: 99 }, null).slaBusinessDays).toBe(1);
    expect(resolveSupportChannels({ slaBusinessDays: "3" }, null).slaBusinessDays).toBe(1);
  });

  it("email validation refuses header-injection shapes", () => {
    expect(normalizeSupportEmail("a@b.io\nBcc: x@y.io")).toBeNull();
    expect(normalizeSupportEmail("<a@b.io>")).toBeNull();
    expect(normalizeSupportEmail("a@b")).toBeNull();
    expect(normalizeSupportEmail("care@cellexialabs.com")).toBe("care@cellexialabs.com");
  });
});

describe("getSupportChannels (fallback chain + containment)", () => {
  it("reads the Shop contact email only when the setting is blank", async () => {
    mocks.getSetting.mockResolvedValue({ email: "care@cellexialabs.com" });
    const withSetting = await getSupportChannels("shop_1");
    expect(withSetting.email).toBe("care@cellexialabs.com");
    expect(mocks.shopFindUnique).not.toHaveBeenCalled();

    mocks.getSetting.mockResolvedValue({ email: "" });
    mocks.shopFindUnique.mockResolvedValue({ contactEmail: "hello@cellexialabs.com" });
    const fromShop = await getSupportChannels("shop_1");
    expect(fromShop.email).toBe("hello@cellexialabs.com");
    expect(fromShop.replyTo).toBe("hello@cellexialabs.com");
    expect(mocks.shopFindUnique).toHaveBeenCalledTimes(1);
  });

  it("nothing anywhere → empty channels (email CTA hidden), never a placeholder address", async () => {
    const c = await getSupportChannels("shop_1");
    expect(c.email).toBeNull();
    expect(c.hasAny).toBe(false);
    expect(JSON.stringify(c)).not.toContain("cellexia.com");
  });

  it("settings and DB failures degrade to the empty set — never throw", async () => {
    mocks.getSetting.mockRejectedValue(new Error("db down"));
    mocks.shopFindUnique.mockRejectedValue(new Error("db down"));
    const c = await getSupportChannels("shop_1");
    expect(c).toEqual(EMPTY_SUPPORT_CHANNELS);
  });
});

describe("registry: the support settings group", () => {
  it("ships with empty channels, SLA 1 business day and 3 requests/hour", () => {
    expect(defaultFor("support")).toEqual({
      email: "",
      replyTo: "",
      whatsapp: "",
      chatUrl: "",
      hoursNote: "",
      slaBusinessDays: 1,
      requestsPerHour: 3,
    });
    // Field-level defaults keep a partially stored row valid.
    expect(settingsSchemas.support.parse({ email: "care@cellexialabs.com" }).slaBusinessDays).toBe(1);
  });
});

describe("mailto builder", () => {
  it("encodes the subject with %20 (RFC 6068), never '+'", () => {
    expect(mailtoHref("care@cellexialabs.com", "Delivery issue")).toBe(
      "mailto:care@cellexialabs.com?subject=Delivery%20issue",
    );
    expect(mailtoHref("care@cellexialabs.com")).toBe("mailto:care@cellexialabs.com");
  });
});

describe("locales: no hard-coded support address anywhere", () => {
  const dir = fileURLToPath(new URL("../app/lib/i18n/locales/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("covers the 22 shipped catalogs", () => {
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  for (const file of files) {
    it(`[${file}] carries subject-only keys and no cellexia.com mailto`, () => {
      const raw = readFileSync(`${dir}${file}`, "utf8");
      const catalog = JSON.parse(raw) as Record<string, string>;
      expect(raw).not.toContain("cellexia.com");
      expect(raw).not.toContain("mailto:");
      expect(catalog["cancel.saves.education.consult_url"]).toBeUndefined();
      expect(catalog["cancel.saves.support.contact_url"]).toBeUndefined();
      expect(typeof catalog["cancel.saves.education.consult_subject"]).toBe("string");
      expect(typeof catalog["cancel.saves.support.contact_subject"]).toBe("string");
      expect(catalog["cancel.saves.education.consult_subject"]).not.toMatch(/^mailto:/);
      expect(catalog["cancel.saves.support.contact_subject"]).not.toMatch(/^mailto:/);
    });
  }
});
