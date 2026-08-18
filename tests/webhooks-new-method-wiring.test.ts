import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.8 — handlePaymentMethodUpsert hands a NEW live method to the detection
 * seam (dunning/new-method.server) with the customer's contracts + the
 * account's method list, only when the method is not every contract's
 * primary; the seam throwing never breaks the mirror refresh. Branch logic
 * itself is pinned in tests/webhooks-new-method-detection.test.ts.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
  detect: vi.fn(async (_i: unknown): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
      updateMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ admin: true })),
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
  t: (_l: string, k: string) => k,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));
vi.mock("~/lib/notifications/payment-method.server", () => ({
  sendPaymentMethodUpdatedOnce: vi.fn(async (): Promise<string> => "SENT"),
  emailCardLabel: () => "",
}));
vi.mock("~/lib/graphql/index.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getContract: vi.fn(async (): Promise<unknown> => null),
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
  draftUpdatePaymentMethod: vi.fn(),
  withContractDraft: vi.fn(),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/dunning/new-method.server", () => ({
  detectNewPaymentMethod: mocks.detect,
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";
import {
  _resetPaymentMethodsCache,
  listLivePaymentMethodsCached,
} from "~/lib/portal/payment-methods.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  name: "Cellexia",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};
const CUSTOMER_GID = "gid://shopify/Customer/1";
const PM_MAIN = "gid://shopify/CustomerPaymentMethod/main";
const PM_NEW = "gid://shopify/CustomerPaymentMethod/new";

function mirror(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/500",
    customerId: CUSTOMER_GID,
    email: "sub@example.com",
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    paymentMethodId: PM_MAIN,
    backupPaymentMethodId: null,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardExpiryMonth: 4,
    cardExpiryYear: 2027,
    paymentInstrumentType: "CREDIT_CARD",
    paymentMethodRevokedAt: null,
    nextBillingDate: new Date("2026-09-12T09:00:00Z"),
    ...over,
  };
}
function method(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    revoked: false,
    revokedAt: null,
    revokedReason: null,
    instrument: { type: "CREDIT_CARD", brand: "Visa", lastDigits: "4242", expiryMonth: 4, expiryYear: 2027, expiresSoon: false },
    ...over,
  };
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.detect.mockResolvedValue([]);
});
afterEach(() => consoleError.mockRestore());

describe("CUSTOMER_PAYMENT_METHODS_CREATE → new-method detection seam", () => {
  it("a live method that is not the contract's primary reaches the seam with contracts + methods", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_NEW)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm1",
    });
    expect(mocks.detect).toHaveBeenCalledTimes(1);
    const arg = mocks.detect.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      shop: { id: SHOP.id, domain: SHOP.domain, ianaTimezone: SHOP.ianaTimezone },
      customerGid: CUSTOMER_GID,
      methodGid: PM_NEW,
    });
    expect((arg.contracts as unknown[]).length).toBe(1);
    expect((arg.methods as Array<{ id: string }>).map((m) => m.id)).toEqual([PM_MAIN, PM_NEW]);
    expect(arg.topic).toBe("CREATE");
  });

  it("only OUR contracts reach the seam; a FOREIGN / UNKNOWN mirror never does (Stage G review fix)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      mirror({ id: "joy", ownership: "FOREIGN" }),
      mirror({ id: "unk", ownership: "UNKNOWN" }),
    ]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_NEW)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm_foreign",
    });
    expect(mocks.detect).not.toHaveBeenCalled();

    mocks.contractFindMany.mockResolvedValue([mirror({ id: "joy", ownership: "FOREIGN" }), mirror()]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm_mixed",
    });
    expect(mocks.detect).toHaveBeenCalledTimes(1);
    const arg = mocks.detect.mock.calls[0][0] as { contracts: Array<{ id: string }> };
    expect(arg.contracts.map((c) => c.id)).toEqual(["c_1"]);
  });

  it("drops the portal payment-methods memo for the customer on CREATE / UPDATE / REVOKE (the events that change the list)", async () => {
    _resetPaymentMethodsCache();
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);
    // Warm the memo (one Shopify read), prove it is a memo (no second read).
    await listLivePaymentMethodsCached({} as never, CUSTOMER_GID);
    await listLivePaymentMethodsCached({} as never, CUSTOMER_GID);
    expect(mocks.listCustomerPaymentMethods).toHaveBeenCalledTimes(1);

    for (const [topic, payload] of [
      ["CUSTOMER_PAYMENT_METHODS_CREATE", { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID }],
      ["CUSTOMER_PAYMENT_METHODS_UPDATE", { admin_graphql_api_id: PM_MAIN, admin_graphql_api_customer_id: CUSTOMER_GID }],
      ["CUSTOMER_PAYMENT_METHODS_REVOKE", { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID }],
    ] as const) {
      mocks.listCustomerPaymentMethods.mockClear();
      await listLivePaymentMethodsCached({} as never, CUSTOMER_GID);
      const before = mocks.listCustomerPaymentMethods.mock.calls.length;
      await webhookHandlers[topic]({ shopDomain: SHOP.domain, payload: { ...payload }, webhookId: `wh_${topic}` });
      mocks.listCustomerPaymentMethods.mockClear();
      await listLivePaymentMethodsCached({} as never, CUSTOMER_GID);
      // The memo was dropped by the webhook: the next portal read hits Shopify again.
      expect(mocks.listCustomerPaymentMethods, `${topic} (warm before: ${before})`).toHaveBeenCalledTimes(1);
    }
    _resetPaymentMethodsCache();
  });

  it("the UPDATE topic is passed through so the seam can tell a detail edit from a new card", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_NEW)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm_upd",
    });
    expect(mocks.detect).toHaveBeenCalledTimes(1);
    expect((mocks.detect.mock.calls[0][0] as { topic: string }).topic).toBe("UPDATE");
  });

  it("the contract's OWN method (direct hit) never reaches the seam", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_MAIN, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm2",
    });
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it("a method missing from the account list, or revoked, never reaches the seam", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm3",
    });
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_NEW, { revoked: true })]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
      webhookId: "wh_nm4",
    });
    expect(mocks.detect).not.toHaveBeenCalled();
  });

  it("a throwing seam is contained — the handler resolves and the mirror refresh already happened", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ cardLast4: "0000" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN), method(PM_NEW)]);
    mocks.detect.mockRejectedValueOnce(new Error("boom"));
    await expect(
      webhookHandlers.CUSTOMER_PAYMENT_METHODS_CREATE({
        shopDomain: SHOP.domain,
        payload: { admin_graphql_api_id: PM_NEW, admin_graphql_api_customer_id: CUSTOMER_GID },
        webhookId: "wh_nm5",
      }),
    ).resolves.toBeUndefined();
    // The primary's mirror (last4 0000 → 4242) was refreshed before the seam ran.
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });
});
