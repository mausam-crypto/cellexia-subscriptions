import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 audit pins — payment-method webhook paths:
 *
 *  - CUSTOMER_PAYMENT_METHODS_UPDATE: an EXPIRY-ONLY refresh (same brand/last4
 *    — what a card network's account updater produces without any customer
 *    action) mirrors + logs but sends NO "thank you for updating / if you
 *    didn't, reply" notice unless the contract is in payment recovery, where
 *    the renewed expiry is the fix; the engine poke carries the previous
 *    expiry/brand so a RETRYING case retries at once;
 *  - CUSTOMER_PAYMENT_METHODS_REVOKE / MERGED: the merged-into method IS the
 *    fix moment — the engine is poked for an open case / FAILED contract;
 *  - REVOKE of the method the engine is currently charging AS backup (both
 *    pointers equal) is a plain removal, never a "switch" to the revoked
 *    method; a REVOKE of a backup-only method clears the dead pointer.
 *
 * Scaffold: tests/webhooks-payment-method-closed-loop.test.ts.
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
  getContract: vi.fn(async (): Promise<unknown> => null),
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
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  sendPaymentMethodUpdatedOnce: vi.fn(async (_input?: unknown): Promise<string> => "SENT"),
  onPaymentMethodUpdated: vi.fn(async (_id: string, _o?: unknown): Promise<void> => {}),
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
  t: (_l: string, k: string) => k,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: mocks.sendNotification,
}));

vi.mock("~/lib/notifications/payment-method.server", () => ({
  sendPaymentMethodUpdatedOnce: mocks.sendPaymentMethodUpdatedOnce,
  emailCardLabel: () => "",
}));

vi.mock("~/lib/graphql/index.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getContract: mocks.getContract,
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
  draftUpdatePaymentMethod: mocks.draftUpdatePaymentMethod,
  withContractDraft: mocks.withContractDraft,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  onPaymentMethodUpdated: mocks.onPaymentMethodUpdated,
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
const PM_MERGED = "gid://shopify/CustomerPaymentMethod/merged";

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
    currencyCode: "CHF",
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

function noticeCalls() {
  return mocks.sendPaymentMethodUpdatedOnce.mock.calls.map(
    (c) => c[0] as unknown as Record<string, unknown> & { contract: Record<string, unknown> },
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.getSetting.mockResolvedValue({ backupPaymentFallback: true });
  mocks.contractUpdateMany.mockResolvedValue({ count: 1 });
  mocks.getContract.mockResolvedValue(null);
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
});

afterEach(() => {
  consoleError.mockRestore();
});


describe("CUSTOMER_PAYMENT_METHODS_UPDATE — expiry-only refresh", () => {
  const payload = {
    admin_graphql_api_id: PM_MAIN,
    admin_graphql_api_customer_id: CUSTOMER_GID,
  };
  const renewed = () =>
    method(PM_MAIN, {
      instrument: {
        type: "CREDIT_CARD",
        brand: "Visa",
        lastDigits: "4242",
        expiryMonth: 4,
        expiryYear: 2030, // same card, new expiry
        expiresSoon: false,
      },
    });

  it("no case, ACTIVE: mirror + event, but NO closed-loop notice (nobody 'made this change')", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([renewed()]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_e1",
    });
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ cardExpiryYear: 2030, cardLast4: "4242" });
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
    expect(mocks.onPaymentMethodUpdated).not.toHaveBeenCalled();
  });

  it("with an open case: the renewed expiry IS the fix — notice (hasOpenCase) + engine poke carrying the previous expiry", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([renewed()]);
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_e2",
    });
    const calls = noticeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: "updated", hasOpenCase: true });
    expect(mocks.onPaymentMethodUpdated).toHaveBeenCalledWith("c_1", {
      previous: {
        paymentMethodId: PM_MAIN,
        cardLast4: "4242",
        cardExpiryMonth: 4,
        cardExpiryYear: 2027,
        cardBrand: "Visa",
      },
    });
  });

  it("brand/last4 change without a case still sends the notice (the customer really replaced the card)", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ cardLast4: "0000" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_e3",
    });
    expect(noticeCalls()).toHaveLength(1);
    expect(noticeCalls()[0]).toMatchObject({ hasOpenCase: false });
  });
});

describe("CUSTOMER_PAYMENT_METHODS_REVOKE — MERGED pokes the engine", () => {
  const payload = { admin_graphql_api_id: PM_MAIN, customer_id: 1 };
  const mergedContract = () => ({
    customerPaymentMethod: {
      id: PM_MERGED,
      revokedAt: null,
      instrument: {
        type: "CREDIT_CARD",
        brand: "Mastercard",
        lastDigits: "8888",
        expiryMonth: 1,
        expiryYear: 2030,
        expiresSoon: false,
      },
    },
  });

  it("open case: onPaymentMethodUpdated is called with the revoked id as 'previous' — the case retries now instead of sleeping to its timeout", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, { revoked: true, revokedAt: new Date(), revokedReason: "MERGED" }),
    ]);
    mocks.getContract.mockResolvedValue(mergedContract());
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_mp1",
    });

    expect(mocks.onPaymentMethodUpdated).toHaveBeenCalledWith("c_1", {
      previous: expect.objectContaining({ paymentMethodId: PM_MAIN, cardLast4: "4242" }),
    });
    expect(noticeCalls()[0]).toMatchObject({ reason: "updated", hasOpenCase: true });
  });

  it("FAILED contract without an open case reopens through the same poke; ACTIVE without a case is not poked", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ status: "FAILED" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, { revoked: true, revokedAt: new Date(), revokedReason: "MERGED" }),
    ]);
    mocks.getContract.mockResolvedValue(mergedContract());
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_mp2",
    });
    expect(mocks.onPaymentMethodUpdated).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.requireShop.mockResolvedValue({ ...SHOP });
    mocks.getSetting.mockResolvedValue({ backupPaymentFallback: true });
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, { revoked: true, revokedAt: new Date(), revokedReason: "MERGED" }),
    ]);
    mocks.getContract.mockResolvedValue(mergedContract());
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_mp3",
    });
    expect(mocks.onPaymentMethodUpdated).not.toHaveBeenCalled();
  });
});

describe("CUSTOMER_PAYMENT_METHODS_REVOKE — backup pointer hygiene", () => {
  it("revoking the card the engine is charging AS backup (both pointers equal) is a plain removal — never a draft switch to the revoked method", async () => {
    mocks.contractFindMany.mockImplementation(async (args: any) => {
      // First query: contracts whose PRIMARY is the revoked method.
      if (args?.where?.paymentMethodId === PM_BACKUP) {
        return [mirror({ paymentMethodId: PM_BACKUP, backupPaymentMethodId: PM_BACKUP })];
      }
      return [];
    });
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_BACKUP, { revoked: true, revokedAt: new Date() }),
    ]);
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_BACKUP, customer_id: 1 },
      webhookId: "wh_bk1",
    });
    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(mocks.draftUpdatePaymentMethod).not.toHaveBeenCalled();
    // The historical removal path: stamp + payment_failed_1 prompt.
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ template: "payment_failed_1" }),
    );
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });

  it("revoking a BACKUP-only method clears the dead pointer (backup_payment_cleared, ENGINE) and touches nothing else", async () => {
    mocks.contractFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.paymentMethodId === PM_BACKUP) return []; // not anyone's primary
      if (args?.where?.backupPaymentMethodId === PM_BACKUP) {
        return [
          {
            id: "c_9",
            customerId: CUSTOMER_GID,
            email: "sub@example.com",
            paymentMethodId: PM_MAIN,
            backupPaymentMethodId: PM_BACKUP,
          },
        ];
      }
      return [];
    });
    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: PM_BACKUP, customer_id: 1 },
      webhookId: "wh_bk2",
    });
    expect(mocks.contractUpdateMany).toHaveBeenCalledWith({
      where: { id: "c_9", backupPaymentMethodId: PM_BACKUP },
      data: expect.objectContaining({ backupPaymentMethodId: null, backupSetBy: "ENGINE" }),
    });
    const [event] = eventsOfType("contract.backup_payment_cleared");
    expect(event).toBeDefined();
    expect(event.payload).toMatchObject({
      setBy: "ENGINE",
      reason: "backup_method_revoked",
      previousBackupPaymentMethodId: PM_BACKUP,
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
