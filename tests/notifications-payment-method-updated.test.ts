import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * app/lib/notifications/payment-method.server.ts (v1.28.0):
 *
 *  - emailCardLabel: "Visa ····4242" / "Shop Pay ····4242" / "PayPal" / ""
 *    (lower-case mirrored brands are capitalized; nothing mirrored → "");
 *  - paymentMethodUpdatedVars: change_line per reason, next_line with /
 *    without amount, cta_url = portal detail page ?toast=payment_method_changed,
 *    legacy card_brand/card_last4/via_backup kept, card_updated_by carried;
 *  - the English payment_method_updated body renders placeholder-free from
 *    those vars for every reason (the body references {change_line} and
 *    {next_line} unconditionally);
 *  - sendPaymentMethodUpdatedOnce: dedupes once per {contract,last4}/24h on
 *    NotificationLog (`payload.vars.dedupe_key`), stamps the key into the
 *    vars, fails OPEN on a dedupe read error, never throws.
 */

const mocks = vi.hoisted(() => ({
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  sendNotification: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    }),
  ),
  buildPortalUrl: vi.fn(
    async (_shopId: string, path = "/"): Promise<string> =>
      `https://shop.example/apps/cellexia${path}`,
  ),
}));

vi.mock("~/db.server", () => ({
  default: { notificationLog: { findFirst: mocks.notificationLogFindFirst } },
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
}));

import {
  emailCardLabel,
  paymentMethodUpdatedDedupeKey,
  paymentMethodUpdatedVars,
  sendPaymentMethodUpdatedOnce,
} from "~/lib/notifications/payment-method.server";
import { renderEmail } from "~/lib/notifications/templates.server";

const PLACEHOLDER = /\{[a-z0-9_]+\}/i;

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/new",
    paymentInstrumentType: "CREDIT_CARD" as string | null,
    cardBrand: "visa" as string | null,
    cardLast4: "4242" as string | null,
    nextBillingDate: new Date("2026-09-12T09:00:00Z") as Date | null,
    currencyCode: "CHF",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("emailCardLabel", () => {
  it("cards, Shop Pay, PayPal, nothing", () => {
    expect(emailCardLabel("en", contract())).toBe("Visa ····4242");
    expect(
      emailCardLabel("en", contract({ paymentInstrumentType: "SHOP_PAY" })),
    ).toBe("Shop Pay ····4242");
    expect(
      emailCardLabel("en", contract({ paymentInstrumentType: "PAYPAL" })),
    ).toBe("PayPal");
    // Legacy rows without a mirrored type still read as a card.
    expect(
      emailCardLabel("en", contract({ paymentInstrumentType: null, cardBrand: "Mastercard" })),
    ).toBe("Mastercard ····4242");
    expect(
      emailCardLabel("en", contract({ paymentInstrumentType: null, cardBrand: null })),
    ).toBe("Card ····4242");
    expect(
      emailCardLabel("en", contract({ paymentInstrumentType: null, cardBrand: null, cardLast4: null })),
    ).toBe("");
    expect(emailCardLabel("en", null)).toBe("");
  });
});

describe("paymentMethodUpdatedVars", () => {
  it("'updated' names the new card, next_line carries the amount when known, cta_url targets the detail page with the toast", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract(),
      reason: "updated",
      previousCard: { cardBrand: "visa", cardLast4: "0000", paymentInstrumentType: "CREDIT_CARD" },
      cardUpdatedBy: "customer",
      amountCents: 13200,
    });
    expect(vars.card_label).toBe("Visa ····4242");
    expect(vars.previous_card_label).toBe("Visa ····0000");
    expect(vars.change_line).toContain("now uses Visa ····4242");
    expect(vars.next_line).toContain("CHF");
    expect(vars.next_line).toContain("2026");
    expect(vars.card_brand).toBe("Visa");
    expect(vars.card_last4).toBe("4242");
    expect(vars.via_backup).toBe(false);
    expect(vars.card_updated_by).toBe("customer");
    expect(vars.cta_url).toBe(
      "https://shop.example/apps/cellexia/subscription/c_1?toast=payment_method_changed",
    );
    expect(mocks.buildPortalUrl).toHaveBeenCalledWith(
      "shop_1",
      "/subscription/c_1?toast=payment_method_changed",
    );
  });

  it("backup variants name the replaced card; no next date → empty next_line; PayPal has no digits", async () => {
    const promoted = await paymentMethodUpdatedVars({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract({ paymentInstrumentType: "SHOP_PAY", cardLast4: "8888", nextBillingDate: null }),
      reason: "backup_promoted",
      previousCard: { cardBrand: "visa", cardLast4: "4242", paymentInstrumentType: "CREDIT_CARD" },
      cardUpdatedBy: "system",
    });
    expect(promoted.change_line).toContain("because Visa ····4242 was removed");
    expect(promoted.change_line).toContain("backup card Shop Pay ····8888");
    expect(promoted.next_line).toBe("");
    expect(promoted.via_backup).toBe(true);

    const failed = await paymentMethodUpdatedVars({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract({ paymentInstrumentType: "PAYPAL" }),
      reason: "backup_failed",
      previousCard: { cardBrand: "visa", cardLast4: "4242" },
      cardUpdatedBy: "system",
    });
    expect(failed.change_line).toContain("couldn't charge Visa ····4242");
    expect(failed.change_line).toContain("backup card PayPal");
    // No amount → the plain next_line.
    expect(failed.next_line).toMatch(/^Your next order is scheduled for /);
  });

  it("a portal URL failure is contained — vars still render, just no cta_url", async () => {
    mocks.buildPortalUrl.mockRejectedValueOnce(new Error("no domain"));
    const vars = await paymentMethodUpdatedVars({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract(),
      reason: "updated",
      cardUpdatedBy: "customer",
    });
    expect(vars.cta_url).toBeUndefined();
    expect(vars.change_line).toContain("Visa ····4242");
  });

  it("an unmirrored previous card degrades to a generic phrase — never an empty hole in the sentence", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract(),
      reason: "backup_promoted",
      previousCard: { cardBrand: null, cardLast4: null },
      cardUpdatedBy: "system",
    });
    expect(vars.previous_card_label).toBe("your previous card");
    expect(vars.change_line).toContain("because your previous card was removed");
  });

  it("the English body renders placeholder-free for every reason (portal_url supplied by the router)", async () => {
    for (const reason of ["updated", "backup_promoted", "backup_failed"] as const) {
      const vars = await paymentMethodUpdatedVars({
        locale: "en",
        tz: "Europe/Zurich",
        contract: contract(),
        reason,
        previousCard: { cardBrand: "visa", cardLast4: "0000" },
        cardUpdatedBy: "customer",
      });
      const flat: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v === "string" || typeof v === "number") flat[k] = v;
      }
      const rendered = renderEmail("payment_method_updated", "en", {
        ...flat,
        portal_url: "https://example.com/account",
      });
      expect(rendered.subject).not.toMatch(PLACEHOLDER);
      expect(rendered.text, reason).not.toMatch(PLACEHOLDER);
      expect(rendered.html, reason).not.toMatch(PLACEHOLDER);
      // The CTA button reads "Back to my subscription" and points at the toast URL.
      expect(rendered.text).toContain("Back to my subscription: https://shop.example/apps/cellexia/subscription/c_1?toast=payment_method_changed");
    }
  });
});

describe("sendPaymentMethodUpdatedOnce", () => {
  const input = () => ({
    locale: "en",
    tz: "Europe/Zurich",
    contract: contract(),
    reason: "updated" as const,
    cardUpdatedBy: "customer" as const,
  });

  it("sends through the router with the dedupe key stamped into the vars", async () => {
    const status = await sendPaymentMethodUpdatedOnce(input());
    expect(status).toBe("SENT");
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const args = mocks.sendNotification.mock.calls[0][0] as {
      template: string;
      contractId: string;
      vars: Record<string, unknown>;
    };
    expect(args.template).toBe("payment_method_updated");
    expect(args.contractId).toBe("c_1");
    expect(args.vars.dedupe_key).toBe("payment_method_updated:4242");
    expect(args.vars.change_line).toContain("Visa ····4242");
    // The dedupe read looks at SENT rows for THIS contract, template and key
    // inside the 24 h window.
    const where = (mocks.notificationLogFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      contractId: "c_1",
      template: "payment_method_updated",
      status: "SENT",
      payload: { path: ["vars", "dedupe_key"], equals: "payment_method_updated:4242" },
    });
    expect((where.createdAt as { gte: Date }).gte).toBeInstanceOf(Date);
  });

  it("a SENT row inside the window → DUPLICATE, nothing sent", async () => {
    mocks.notificationLogFindFirst.mockResolvedValueOnce({ id: "nl_1" });
    const status = await sendPaymentMethodUpdatedOnce(input());
    expect(status).toBe("DUPLICATE");
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("dedupe key is per last4 — a different card is a fresh notice", () => {
    expect(paymentMethodUpdatedDedupeKey({ cardBrand: null, cardLast4: "1111" })).toBe(
      "payment_method_updated:1111",
    );
    expect(paymentMethodUpdatedDedupeKey({ cardBrand: null, cardLast4: null })).toBe(
      "payment_method_updated:unknown",
    );
  });

  it("dedupe read failure fails OPEN (sends); a throwing router is contained (FAILED)", async () => {
    mocks.notificationLogFindFirst.mockRejectedValueOnce(new Error("db down"));
    expect(await sendPaymentMethodUpdatedOnce(input())).toBe("SENT");
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

    mocks.sendNotification.mockRejectedValueOnce(new Error("router down"));
    expect(await sendPaymentMethodUpdatedOnce(input())).toBe("FAILED");
  });
});
