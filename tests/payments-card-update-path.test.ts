import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * resolveCardUpdatePath (v1.28.0, P1.1) — the ONE server-side decision every
 * "Update your card" surface (portal, magic UPDATE_CARD, admin, SMS/dunning
 * links) goes through:
 *
 *  - no paymentMethodId → unavailable(no_payment_method);
 *  - revoked primary → unavailable(payment_method_revoked), no Shopify call;
 *  - SHOP_PAY → hosted URL (customerPaymentMethodGetUpdateUrl) → redirect;
 *  - null / UNKNOWN type → try hosted, fall back to Shopify's update email on
 *    userError code INVALID_INSTRUMENT ("only supports Shop Pay");
 *  - CREDIT_CARD / PAYPAL → email directly, hosted URL never tried;
 *  - both paths failing → unavailable(shopify_error), never throws;
 *  - every served path logs contract.card_update_link_sent {channel, source,
 *    actor}; a failing event log is contained.
 *
 * Also pins that GET_UPDATE_URL_MUTATION selects userErrors.code — without
 * it INVALID_INSTRUMENT is invisible and the fallback can never trigger.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://shop.app/pay/update/abc"),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ graphql: vi.fn() })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/graphql/index.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/graphql/client.server")>(
    "~/lib/graphql/client.server",
  );
  return {
    ShopifyUserError: actual.ShopifyUserError,
    getPaymentMethodUpdateUrl: mocks.getPaymentMethodUpdateUrl,
    sendPaymentMethodUpdateEmail: mocks.sendPaymentMethodUpdateEmail,
  };
});

import { ShopifyUserError } from "~/lib/graphql/client.server";
import { resolveCardUpdatePath } from "~/lib/payments/cardUpdate.server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PM = "gid://shopify/CustomerPaymentMethod/1";

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    paymentMethodId: PM,
    paymentInstrumentType: null as string | null,
    paymentMethodRevokedAt: null as Date | null,
    ...over,
  };
}

function invalidInstrument() {
  return new ShopifyUserError("customerPaymentMethodGetUpdateUrl", [
    {
      field: ["customerPaymentMethodId"],
      message: "Payment method instrument not supported for this mutation",
      code: "INVALID_INSTRUMENT",
    },
  ]);
}

function sentEvents() {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; source: string; actor: string | null; payload: Record<string, unknown> })
    .filter((e) => e.type === "contract.card_update_link_sent");
}

const admin = { graphql: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPaymentMethodUpdateUrl.mockResolvedValue("https://shop.app/pay/update/abc");
  mocks.sendPaymentMethodUpdateEmail.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("resolveCardUpdatePath — unavailable states (no Shopify call)", () => {
  it("no paymentMethodId → no_payment_method", async () => {
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentMethodId: null }),
      source: "CUSTOMER_PORTAL",
    });
    expect(out).toEqual({ kind: "unavailable", reason: "no_payment_method" });
    expect(mocks.getPaymentMethodUpdateUrl).not.toHaveBeenCalled();
    expect(mocks.sendPaymentMethodUpdateEmail).not.toHaveBeenCalled();
    expect(sentEvents()).toHaveLength(0);
  });

  it("revoked primary → payment_method_revoked", async () => {
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentMethodRevokedAt: new Date("2026-08-01T00:00:00Z") }),
      source: "MAGIC_LINK",
    });
    expect(out).toEqual({ kind: "unavailable", reason: "payment_method_revoked" });
    expect(mocks.getPaymentMethodUpdateUrl).not.toHaveBeenCalled();
    expect(mocks.sendPaymentMethodUpdateEmail).not.toHaveBeenCalled();
  });
});

describe("resolveCardUpdatePath — instrument-aware routing", () => {
  it("SHOP_PAY → hosted URL redirect, event channel hosted_url", async () => {
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentInstrumentType: "SHOP_PAY" }),
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(out).toEqual({ kind: "redirect", url: "https://shop.app/pay/update/abc" });
    expect(mocks.getPaymentMethodUpdateUrl).toHaveBeenCalledWith(admin, PM);
    expect(mocks.sendPaymentMethodUpdateEmail).not.toHaveBeenCalled();
    const [event] = sentEvents();
    expect(event.source).toBe("CUSTOMER_PORTAL");
    expect(event.actor).toBe("customer");
    expect(event.payload).toMatchObject({
      channel: "hosted_url",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      instrumentType: "SHOP_PAY",
    });
  });

  it.each(["CREDIT_CARD", "PAYPAL"])(
    "%s → Shopify update email directly, hosted URL never tried",
    async (type) => {
      const out = await resolveCardUpdatePath({
        admin,
        contract: contract({ paymentInstrumentType: type }),
        source: "ADMIN",
        actor: "merchant@example.com",
      });
      expect(out).toEqual({ kind: "email_sent" });
      expect(mocks.getPaymentMethodUpdateUrl).not.toHaveBeenCalled();
      expect(mocks.sendPaymentMethodUpdateEmail).toHaveBeenCalledWith(admin, PM);
      const [event] = sentEvents();
      expect(event.source).toBe("ADMIN");
      expect(event.payload).toMatchObject({ channel: "shopify_email", source: "ADMIN" });
    },
  );

  it.each([null, "UNKNOWN"])(
    "type %s → probes the hosted URL and falls back to email on INVALID_INSTRUMENT",
    async (type) => {
      mocks.getPaymentMethodUpdateUrl.mockRejectedValueOnce(invalidInstrument());
      const out = await resolveCardUpdatePath({
        admin,
        contract: contract({ paymentInstrumentType: type }),
        source: "CUSTOMER_PORTAL",
      });
      expect(out).toEqual({ kind: "email_sent" });
      expect(mocks.getPaymentMethodUpdateUrl).toHaveBeenCalledTimes(1);
      expect(mocks.sendPaymentMethodUpdateEmail).toHaveBeenCalledWith(admin, PM);
      // Only the path actually served is recorded.
      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0].payload.channel).toBe("shopify_email");
    },
  );

  it("type null and the hosted URL works (a Shop Pay method not yet mirrored) → redirect", async () => {
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentInstrumentType: null }),
      source: "SMS",
    });
    expect(out).toEqual({ kind: "redirect", url: "https://shop.app/pay/update/abc" });
    expect(mocks.sendPaymentMethodUpdateEmail).not.toHaveBeenCalled();
    expect(sentEvents()[0].source).toBe("SCHEDULER");
  });

  it("SHOP_PAY hosted URL failing for another reason still tries the email before giving up", async () => {
    mocks.getPaymentMethodUpdateUrl.mockRejectedValueOnce(new Error("network"));
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentInstrumentType: "SHOP_PAY" }),
      source: "CUSTOMER_PORTAL",
    });
    expect(out).toEqual({ kind: "email_sent" });
  });

  it("both paths failing → unavailable(shopify_error), never throws, no sent event", async () => {
    mocks.getPaymentMethodUpdateUrl.mockRejectedValueOnce(invalidInstrument());
    mocks.sendPaymentMethodUpdateEmail.mockRejectedValueOnce(
      new ShopifyUserError("customerPaymentMethodSendUpdateEmail", [
        { message: "Payment method does not exist", code: "PAYMENT_METHOD_DOES_NOT_EXIST" },
      ]),
    );
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract(),
      source: "CUSTOMER_PORTAL",
    });
    expect(out).toEqual({ kind: "unavailable", reason: "shopify_error" });
    expect(sentEvents()).toHaveLength(0);
  });

  it("builds the admin client from shopDomain when none is passed; missing both → shopify_error", async () => {
    const out = await resolveCardUpdatePath({
      shopDomain: "cellexia.myshopify.com",
      contract: contract({ paymentInstrumentType: "CREDIT_CARD" }),
      source: "DUNNING",
    });
    expect(out).toEqual({ kind: "email_sent" });
    expect(mocks.adminClientForShop).toHaveBeenCalledWith("cellexia.myshopify.com");

    const none = await resolveCardUpdatePath({
      contract: contract({ paymentInstrumentType: "CREDIT_CARD" }),
      source: "DUNNING",
    });
    expect(none).toEqual({ kind: "unavailable", reason: "shopify_error" });
  });

  it("a failing event log is contained — the path is still served", async () => {
    mocks.logEvent.mockRejectedValueOnce(new Error("db down"));
    const out = await resolveCardUpdatePath({
      admin,
      contract: contract({ paymentInstrumentType: "SHOP_PAY" }),
      source: "CUSTOMER_PORTAL",
    });
    expect(out.kind).toBe("redirect");
  });
});

describe("GET_UPDATE_URL_MUTATION selects userErrors.code", () => {
  it("the mutation document asks Shopify for the structured error code", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const src = fs.readFileSync(
      path.join(root, "app/lib/graphql/paymentMethods.server.ts"),
      "utf8",
    );
    const start = src.indexOf("const GET_UPDATE_URL_MUTATION");
    const end = src.indexOf("const SEND_UPDATE_EMAIL_MUTATION");
    const doc = src.slice(start, end);
    expect(doc).toMatch(/userErrors\s*\{[^}]*\bcode\b[^}]*\}/);
  });
});
