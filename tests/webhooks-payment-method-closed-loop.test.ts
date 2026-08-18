import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.4 — the closed loop after a card change (v1.28.0):
 *
 *  - CUSTOMER_PAYMENT_METHODS_UPDATE, DIRECT hit whose mirrored card really
 *    changed → payment_method_updated (reason "updated", card_updated_by
 *    "customer", previous card = the pre-update mirror); the event carries
 *    card_updated_by for the Klaviyo metric;
 *  - direct hit with an unchanged card, or a non-direct change → no notice;
 *  - CUSTOMER_PAYMENT_METHODS_REVOKE with revokedReason MERGED (looked up on
 *    the customer's methods when the payload has no reason) → treated as
 *    "moved": NO "your card was removed" payment_failed_1, no revoked stamp;
 *    the mirror is refreshed from the contract's merged-into method and the
 *    closed-loop notice goes out when the card changed; when Shopify exposes
 *    nothing usable it just logs (merged: true, mirrorRefreshed: false);
 *  - REVOKE promoting the backup → the customer is now told
 *    (payment_method_updated, reason "backup_promoted", previous = revoked
 *    card, contract = the backup card).
 *
 * Scaffold: tests/webhooks-payment-method-mirror.test.ts; the notice helper
 * is mocked at its seam (its own dedupe/vars contract is pinned by
 * tests/notifications-payment-method-updated.test.ts).
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
});

afterEach(() => {
  consoleError.mockRestore();
});

describe("CUSTOMER_PAYMENT_METHODS_UPDATE closed loop", () => {
  const payload = {
    admin_graphql_api_id: PM_MAIN,
    admin_graphql_api_customer_id: CUSTOMER_GID,
  };

  it("direct hit + changed card → payment_method_updated (updated / customer) naming old and new card", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ cardLast4: "0000" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_cl1",
    });

    const calls = noticeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      reason: "updated",
      cardUpdatedBy: "customer",
      tz: SHOP.ianaTimezone,
      locale: "en",
    });
    expect(calls[0].contract).toMatchObject({
      id: "c_1",
      cardLast4: "4242",
      paymentInstrumentType: "CREDIT_CARD",
    });
    expect(calls[0].previousCard).toMatchObject({ cardLast4: "0000" });
    // Klaviyo prop on the canonical event.
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({ card_updated_by: "customer" });
  });

  it("direct hit with an UNCHANGED card → event only, no notice", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_cl2",
    });

    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });

  it("changed card on a NON-direct hit → mirror + event, no notice", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ cardLast4: "0000" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload: {
        admin_graphql_api_id: "gid://shopify/CustomerPaymentMethod/other",
        admin_graphql_api_customer_id: CUSTOMER_GID,
      },
      webhookId: "wh_cl3",
    });

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });

  it("a CANCELLED contract's card change mirrors + logs but never sends the notice (nothing left to reassure about)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      mirror({ cardLast4: "0000", status: "CANCELLED" }),
    ]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_cl5",
    });

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });

  it("a throwing notice helper never breaks the handler (contained by contract)", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror({ cardLast4: "0000" })]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([method(PM_MAIN)]);
    // The real helper never throws; the handler still must not depend on it
    // for the mirror write, which happens BEFORE the notice.
    mocks.sendPaymentMethodUpdatedOnce.mockResolvedValueOnce("FAILED");

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_UPDATE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_cl4",
    });

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(eventsOfType("contract.payment_method_updated")).toHaveLength(1);
  });
});

describe("CUSTOMER_PAYMENT_METHODS_REVOKE — MERGED means moved, not removed", () => {
  const payload = { admin_graphql_api_id: PM_MAIN, customer_id: 1 };

  it("MERGED (from the customer's methods) → no payment_failed_1, no revoked stamp; mirror refreshed from the contract's merged-into method + closed-loop notice", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, {
        revoked: true,
        revokedAt: new Date(),
        revokedReason: "MERGED",
      }),
    ]);
    mocks.getContract.mockResolvedValue({
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

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_m1",
    });

    expect(mocks.sendNotification).not.toHaveBeenCalled(); // no "card removed"
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled(); // no revoked stamp
    expect(mocks.withContractDraft).not.toHaveBeenCalled(); // no backup swap
    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      paymentMethodId: PM_MERGED,
      paymentMethodRevokedAt: null,
      cardBrand: "Mastercard",
      cardLast4: "8888",
      paymentInstrumentType: "CREDIT_CARD",
    });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({
      revoked: true,
      merged: true,
      usedBackup: false,
      revokedMethodId: PM_MAIN,
      paymentMethodId: PM_MERGED,
      mirrorRefreshed: true,
      card_updated_by: "customer",
    });
    const calls = noticeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: "updated", cardUpdatedBy: "customer" });
    expect(calls[0].contract).toMatchObject({ paymentMethodId: PM_MERGED, cardLast4: "8888" });
    expect(calls[0].previousCard).toMatchObject({ cardLast4: "4242" });
  });

  it("MERGED from the payload, Shopify exposes nothing usable → just log (no mirror write, no notice, no removed prompt)", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.getContract.mockResolvedValue({ customerPaymentMethod: null });

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload: { ...payload, revoked_reason: "merged" },
      webhookId: "wh_m2",
    });

    // The payload reason short-circuits the lookup.
    expect(mocks.listCustomerPaymentMethods).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({
      merged: true,
      mirrorRefreshed: false,
      paymentMethodId: null,
    });
  });

  it("MERGED where the merged-into method carries the SAME card → mirror moves, no notice (nothing to announce)", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.getContract.mockResolvedValue({
      customerPaymentMethod: {
        id: PM_MERGED,
        revokedAt: null,
        instrument: {
          type: "CREDIT_CARD",
          brand: "Visa",
          lastDigits: "4242",
          expiryMonth: 4,
          expiryYear: 2027,
          expiresSoon: false,
        },
      },
    });

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload: { ...payload, revoked_reason: "MERGED" },
      webhookId: "wh_m3",
    });

    const data = (mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ paymentMethodId: PM_MERGED });
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a plain removal (reason null) still stamps + sends payment_failed_1 — the historical path", async () => {
    mocks.contractFindMany.mockResolvedValue([mirror()]);
    mocks.listCustomerPaymentMethods.mockResolvedValue([
      method(PM_MAIN, { revoked: true, revokedAt: new Date() }),
    ]);

    await webhookHandlers.CUSTOMER_PAYMENT_METHODS_REVOKE({
      shopDomain: SHOP.domain,
      payload,
      webhookId: "wh_m4",
    });

    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ template: "payment_failed_1" }),
    );
    expect(mocks.sendPaymentMethodUpdatedOnce).not.toHaveBeenCalled();
  });
});

describe("CUSTOMER_PAYMENT_METHODS_REVOKE — backup promotion tells the customer", () => {
  it("promotion → payment_method_updated (backup_promoted / system): contract = backup card, previous = revoked card; no payment_failed_1", async () => {
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
      payload: { admin_graphql_api_id: PM_MAIN, customer_id: 1 },
      webhookId: "wh_b1",
    });

    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/SubscriptionDraft/1",
      PM_BACKUP,
    );
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const calls = noticeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: "backup_promoted", cardUpdatedBy: "system" });
    expect(calls[0].contract).toMatchObject({
      paymentMethodId: PM_BACKUP,
      cardLast4: "8888",
      paymentInstrumentType: "SHOP_PAY",
      paymentMethodRevokedAt: null,
    });
    expect(calls[0].previousCard).toMatchObject({ cardLast4: "4242", cardBrand: "Visa" });
    const [event] = eventsOfType("contract.payment_method_updated");
    expect(event.payload).toMatchObject({
      revoked: true,
      usedBackup: true,
      card_updated_by: "system",
    });
  });
});
