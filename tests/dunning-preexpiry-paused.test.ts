import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.5 (v1.28.0) — the pre-expiry job's ACTIVE-only filter used to leave
 * PAUSED contracts unwarned: a card that expires BEFORE the pause ends fails
 * the very first resumed charge, and nobody had told the customer.
 *
 * Driven against the REAL runPreExpiryNotices with mocked seams:
 *  - the query now selects ACTIVE and PAUSED (pinned by
 *    tests/demo-contract-notifications.test.ts's static check);
 *  - PAUSED + resumeAt at/after the card's expiry moment → card_expiring is
 *    sent exactly like an ACTIVE contract (same dedupe key, same event);
 *  - PAUSED + resumeAt before the expiry moment → nothing (the resumed
 *    charge lands on a still-valid card; the job will catch it once ACTIVE);
 *  - PAUSED without resumeAt (indefinite) → nothing;
 *  - ACTIVE behavior unchanged.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(
    async (_input: unknown): Promise<unknown> => ({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    }),
  ),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    dunningCase: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    billingAttempt: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://example.test/portal"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(async (): Promise<void> => {}),
    contractFail: vi.fn(async (): Promise<void> => {}),
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({})),
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: mocks.sendPaymentMethodUpdateEmail,
    withContractDraft: vi.fn(),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import { runPreExpiryNotices } from "~/lib/dunning/engine.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: "Europe/Zurich",
  currencyCode: "CHF",
};

// Card expires 09/2026 → expiry moment 1 Oct 2026 (UTC). Notice window with
// the default 30 days opens 1 Sep; "now" sits inside it.
const NOW = new Date("2026-09-15T09:00:00Z");

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_c1",
    shopId: SHOP.id,
    shop: SHOP,
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    phone: null,
    locale: "en",
    currencyCode: "CHF",
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/main",
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 9,
    cardExpiryYear: 2026,
    resumeAt: null as Date | null,
    ...over,
  };
}

function sends() {
  return mocks.sendNotification.mock.calls.map(
    (c) => c[0] as { template: string; contractId: string; vars: Record<string, unknown> },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runPreExpiryNotices × PAUSED contracts", () => {
  it("queries ACTIVE and PAUSED contracts (the resumeAt gate lives in the loop)", async () => {
    mocks.contractFindMany.mockResolvedValue([]);
    await runPreExpiryNotices(NOW);
    const where = (mocks.contractFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.status).toEqual({ in: ["ACTIVE", "PAUSED"] });
    expect(where.isDemo).toBe(false);
  });

  it("PAUSED with resumeAt AFTER the card's expiry → card_expiring goes out like an ACTIVE contract", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({
        status: "PAUSED",
        resumeAt: new Date("2026-11-01T09:00:00Z"),
      }),
    ]);

    const stats = await runPreExpiryNotices(NOW);

    expect(stats.emailsSent).toBe(1);
    const [send] = sends();
    expect(send.template).toBe("card_expiring");
    expect(send.vars).toMatchObject({
      card_last4: "4242",
      expiry: "09/2026",
      dedupe_key: "card_expiring:4242:202609",
    });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dunning.card_expiring_notice" }),
    );
    // Shopify's own hosted update email still rides along on SENT.
    expect(mocks.sendPaymentMethodUpdateEmail).toHaveBeenCalledTimes(1);
  });

  it("PAUSED with resumeAt exactly AT the expiry moment still warns (the resumed charge would hit an expired card)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({
        status: "PAUSED",
        resumeAt: new Date(Date.UTC(2026, 9, 1)), // 1 Oct 2026 = expiry moment
      }),
    ]);
    await runPreExpiryNotices(NOW);
    expect(sends()).toHaveLength(1);
  });

  it("PAUSED with resumeAt BEFORE the expiry → nothing (card still valid when it resumes)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({
        status: "PAUSED",
        resumeAt: new Date("2026-09-25T09:00:00Z"),
      }),
    ]);
    const stats = await runPreExpiryNotices(NOW);
    expect(stats.processed).toBe(1);
    expect(sends()).toHaveLength(0);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("PAUSED without resumeAt (indefinite pause) → nothing", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ status: "PAUSED", resumeAt: null }),
    ]);
    await runPreExpiryNotices(NOW);
    expect(sends()).toHaveLength(0);
  });

  it("ACTIVE behavior is unchanged: warns inside the window regardless of resumeAt, dedupes on the SENT row", async () => {
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);
    await runPreExpiryNotices(NOW);
    expect(sends()).toHaveLength(1);

    vi.clearAllMocks();
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);
    mocks.notificationLogFindFirst.mockResolvedValueOnce({ id: "nl_sent" });
    await runPreExpiryNotices(NOW);
    expect(sends()).toHaveLength(0);
  });
});
