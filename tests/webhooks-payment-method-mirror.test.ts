import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Payment-method webhooks and the migration-0027 mirror columns (v1.28.0):
 *
 *  - CUSTOMER_PAYMENT_METHODS_REVOKE, primary revoked and NO backup
 *    promotion → paymentMethodRevokedAt stamped (updateMany gated on null,
 *    so a redelivery keeps the first stamp), paymentMethodId and cardLast4
 *    left for copy; the existing payment_failed_1 notice is unchanged;
 *  - REVOKE with a backup + backupPaymentFallback ON → promotion mirrors the
 *    backup's instrument type and clears the revoked stamp;
 *  - CUSTOMER_PAYMENT_METHODS_UPDATE → paymentInstrumentType rides along
 *    with the card columns; a live method clears the revoked stamp; a
 *    type-only backfill (card columns unchanged, not a direct hit) writes
 *    the mirror silently — no contract.payment_method_updated event.
 *
 * Scaffold: aud-webhooks-contract-design-link.test.ts.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractUpdateMany: vi.fn(async (_args: unknown): Promise<unknown> => ({ count: 1 })),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  getSetting: vi.fn(async (): Promise<unknown> => ({ backupPaymentFallback: true })),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
  draftUpdatePaymentMethod: vi.fn(async (): Promise<void> => {}),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      body: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<void> => {
      await body("gid://shopify/SubscriptionDraft/1", {});
    },
  ),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
      updateMany: mocks.contractUpdateMany,
    },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
  t: (_locale: string, key: string) => key,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: mocks.sendNotification,
}));

vi.mock("~/lib/graphql/index.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
  draftUpdatePaymentMethod: mocks.draftUpdatePaymentMethod,
  withContractDraft: mocks.withContractDraft,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  name: "Cellexia",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};
const CUSTOMER_GID = "gid://shopify/Customer/1";
const PM_MAIN = "gid://shopify/CustomerPaymentMethod/main";
const PM_BACKUP = "gid://shopify/CustomerPaymentMethod/backup";

function mirror(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/500",
    customerId: CUSTOMER_GID,
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    paymentMethodId: PM_MAIN,
    backupPaymentMethodId: null,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardExpiryMonth: 4,
    cardExpiryYear: 2027,
    paymentInstrumentType: null,
    paymentMethodRevokedAt: null,
    lines: [],
    ...over,
  };
}

function method(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    revoked: false,
    revokedAt: null,
    revokedReason: null,
    instrument: {
      type: "CREDIT_CARD",
      brand: "Visa",
      lastDigits: "4242",
      expiryMonth: 4,
      expiryYear: 2027,
      expiresSoon: false,
    },
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.getSetting.mockResolvedValue({ backupPaymentFallback: true });
  mocks.contractUpdateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("CUSTOMER_PAYMENT_METHODS_REVOKE", () => {
  const payload = { admin_graphql_api_id: PM_MAIN, customer_id: 1 };

  it("no backup → stamps paymentMethodRevokedAt (first stamp wins), keeps id + last4, still sends payment_failed_1", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_r1",
    });

    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    const call = mocks.contractUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "c_1", paymentMethodRevokedAt: null });
    expect(call.data.paymentMethodRevokedAt).toBeInstanceOf(Date);
    // paymentMethodId / cardLast4 are NOT rewritten (copy needs them).
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.withContractDraft).not.toHaveBeenCalled();

    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({
      revoked: true,
      usedBackup: false,
      revokedMethodId: PM_MAIN,
    });
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ template: "payment_failed_1", contractId: "c_1" }),
    );
  });

  it("stamp failure is contained — event and notice still go out", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.contractUpdateMany.mockRejectedValueOnce(new Error("db down"));

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_r2",
    });

    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("backup + fallback ON → promotion mirrors the backup's instrument type and clears the revoked stamp; no stamp written", async () => {
    mocks.contractFindMany.mockResolvedValue([
      mirror({ backupPaymentMethodId: PM_BACKUP }),
    ]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, { revoked: true, revokedAt: new Date() }),
      method(PM_BACKUP, {
        instrument: {
          type: "SHOP_PAY",
          brand: "Shop Pay",
          lastDigits: "8888",
          expiryMonth: 1,
          expiryYear: 2030,
          expiresSoon: false,
        },
      }),
    ]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_r3",
    });

    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/SubscriptionDraft/1",
      PM_BACKUP,
    );
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      paymentMethodId: PM_BACKUP,
      backupPaymentMethodId: null,
      paymentMethodRevokedAt: null,
      cardBrand: "Shop Pay",
      cardLast4: "8888",
      paymentInstrumentType: "SHOP_PAY",
    });
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
    // No "your card was removed" prompt — the backup took over. (v1.28.0:
    // the customer IS now told about the switch via payment_method_updated,
    // pinned by tests/webhooks-payment-method-closed-loop.test.ts.)
    expect(mocks.sendNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ template: "payment_failed_1" }),
    );
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({ revoked: true, usedBackup: true });
  });
});

describe("CUSTOMER_PAYMENT_METHODS_UPDATE mirror riders", () => {
  const payload = {
    admin_graphql_api_id: PM_MAIN,
    admin_graphql_api_customer_id: CUSTOMER_GID,
  };

  it("direct hit with a changed card writes type + clears the revoked stamp and logs the event", async () => {
    mocks.contractFindMany.mockResolvedValue([
      mirror({
        cardLast4: "0000",
        paymentMethodRevokedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    ]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_u1",
    });

    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      cardLast4: "4242",
      paymentInstrumentType: "CREDIT_CARD",
      paymentMethodRevokedAt: null,
    });
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
  });

  it("type-only backfill on a NON-direct hit writes the mirror silently (no event)", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]); // type null, card unchanged
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload: {
        admin_graphql_api_id: "gid://shopify/CustomerPaymentMethod/somethingElse",
        admin_graphql_api_customer_id: CUSTOMER_GID,
      },
      webhookId: "wh_u2",
    });

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.paymentInstrumentType).toBe("CREDIT_CARD");
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(0);
  });

  it("nothing changed and not a direct hit → no write, no event", async () => {
    mocks.contractFindMany.mockResolvedValue([
      mirror({ paymentInstrumentType: "CREDIT_CARD" }),
    ]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload: {
        admin_graphql_api_id: "gid://shopify/CustomerPaymentMethod/somethingElse",
        admin_graphql_api_customer_id: CUSTOMER_GID,
      },
      webhookId: "wh_u3",
    });

    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
