import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The topics the data-collection audit added, and the guard the create
 * webhook was missing.
 *
 * WH-06 shop/update: Shop.currencyCode / ianaTimezone were written only by
 * onAppInstalled (OAuth afterAuth) — a merchant changing store currency or
 * timezone left every shop-day window and currency guard on stale values
 * forever. The handler keeps the mirror live and DATES the boundary with an
 * admin.action event when currency/timezone actually changed.
 *
 * WH-07 customers/update: identity mirrors only refreshed on contract-scoped
 * webhooks, so PAUSED/FAILED/CANCELLED contracts — the dunning and winback
 * audiences — held stale addresses indefinitely. Redacted mirrors are never
 * revived.
 *
 * WH-08 orders/fulfilled: the payload is the only carrier of the charge→ship
 * gap; it is now persisted (BillingAttempt.fulfilledAt /
 * originOrderFulfilledAt, first fulfillment wins) and logged as
 * billing.order_fulfilled instead of being consumed for one notification and
 * dropped.
 *
 * WH-13 orders/cancelled: capture-only billing.order_cancelled — the void
 * case (cancelled authorization, no refund transaction) becomes visible
 * without opening a second money-mutation channel.
 *
 * WH-14: SUBSCRIPTION_CONTRACTS_CREATE guards its canonical contract.created
 * on the contract's own identity, so a manual replay cannot double-log the
 * creation moment (and re-fire the subscription-started Klaviyo flow).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  shopUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
  gql: vi.fn(async (): Promise<unknown> => ({ shopLocales: [] })),
  getContract: vi.fn(async (): Promise<unknown> => ({
    customer: { locale: null },
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  })),
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique, update: mocks.shopUpdate },
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findFirst: mocks.contractFindFirst,
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
      updateMany: mocks.contractUpdateMany,
    },
    billingAttempt: {
      findFirst: mocks.attemptFindFirst,
      updateMany: mocks.attemptUpdateMany,
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
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
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: mocks.hasSentForCycle,
  sendNotification: mocks.sendNotification,
}));

vi.mock("~/lib/graphql/index.server", () => ({
  gql: mocks.gql,
  getContract: mocks.getContract,
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  draftUpdatePaymentMethod: vi.fn(),
  withContractDraft: vi.fn(),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: mocks.syncContractFromShopify,
}));

vi.mock("~/lib/gifts/firstOrderGift.server", () => ({
  ensureFirstOrderGift: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  name: "Cellexia",
  currencyCode: "GBP",
  ianaTimezone: "Europe/London",
  contactEmail: "old@cellexia.example",
  primaryDomain: "www.cellexia.example",
};

function loggedOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.shopFindUnique.mockResolvedValue({ ...SHOP });
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.contractUpdateMany.mockResolvedValue({ count: 1 });
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.hasSentForCycle.mockResolvedValue(false);
  mocks.gql.mockResolvedValue({
    shopLocales: [{ locale: "en", primary: true, published: true }],
  });
});

// ── WH-06: shop/update ───────────────────────────────────────────────────────

describe("SHOP_UPDATE", () => {
  async function deliver(over: Record<string, unknown> = {}): Promise<void> {
    await webhookHandlers.SHOP_UPDATE({
      shopDomain: SHOP.domain,
      payload: {
        name: "Cellexia",
        currency: "CHF",
        iana_timezone: "Europe/Zurich",
        customer_email: "new@cellexia.example",
        domain: "www.cellexia.com",
        ...over,
      },
      webhookId: "wh_shop_1",
    });
  }

  it("refreshes the mirror the install-time sync abandoned (currency, tz, name, email, domain, locales)", async () => {
    await deliver();
    expect(mocks.shopUpdate).toHaveBeenCalledTimes(1);
    const { data } = mocks.shopUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({
      currencyCode: "CHF",
      ianaTimezone: "Europe/Zurich",
      contactEmail: "new@cellexia.example",
      primaryDomain: "www.cellexia.com",
      enabledLocales: [{ locale: "en", primary: true, published: true }],
    });
  });

  it("dates the day-bucketing boundary: an event fires when currency/timezone CHANGED, with previous values", async () => {
    await deliver();
    const events = loggedOfType("admin.action");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "shop_metadata_changed",
      previousCurrencyCode: "GBP",
      currencyCode: "CHF",
      previousIanaTimezone: "Europe/London",
      ianaTimezone: "Europe/Zurich",
    });
  });

  it("stays silent when neither currency nor timezone moved", async () => {
    await deliver({ currency: "GBP", iana_timezone: "Europe/London" });
    expect(mocks.shopUpdate).toHaveBeenCalledTimes(1); // mirror still refreshed
    expect(loggedOfType("admin.action")).toHaveLength(0);
  });

  it("a locales fetch failure never loses the currency/timezone refresh", async () => {
    mocks.gql.mockRejectedValue(new Error("throttled"));
    await deliver();
    const { data } = mocks.shopUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.currencyCode).toBe("CHF");
    expect("enabledLocales" in data).toBe(false);
  });
});

// ── WH-07: customers/update ──────────────────────────────────────────────────

describe("CUSTOMERS_UPDATE", () => {
  const CUSTOMER_GID = "gid://shopify/Customer/77";

  function contractRow(over: Record<string, unknown> = {}) {
    return {
      id: "c_1",
      shopId: "shop_1",
      customerId: CUSTOMER_GID,
      email: "old@example.com",
      phone: "+41790000000",
      firstName: "Jane",
      lastName: "Doe",
      ownership: "FOREIGN", // identity, not billing: foreign mirrors refresh too
      ...over,
    };
  }

  async function deliver(over: Record<string, unknown> = {}): Promise<void> {
    await webhookHandlers.CUSTOMERS_UPDATE({
      shopDomain: SHOP.domain,
      payload: {
        id: 77,
        admin_graphql_api_id: CUSTOMER_GID,
        email: "new@example.com",
        first_name: "Jane",
        last_name: "Doe",
        phone: null,
        ...over,
      },
      webhookId: "wh_cu_1",
    });
  }

  it("refreshes the drifted mirror and logs the changed FIELD NAMES only", async () => {
    mocks.contractFindMany.mockResolvedValue([contractRow()]);
    await deliver();

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toEqual({ email: "new@example.com" });

    const events = loggedOfType("contract.updated");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      action: "customer_updated",
      changedFields: ["email"],
    });
  });

  it("a null payload field never clobbers a mirrored value (phone survives)", async () => {
    mocks.contractFindMany.mockResolvedValue([contractRow()]);
    await deliver({ phone: null });
    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect("phone" in data).toBe(false);
  });

  it("an unchanged identity writes and logs nothing", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractRow({ email: "new@example.com" }),
    ]);
    await deliver();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("GDPR: a redacted mirror is never revived (customerId survives redaction)", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractRow({ email: "redacted+42@example.invalid" }),
    ]);
    await deliver();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });
});

// ── WH-08: orders/fulfilled collects the charge→ship gap ─────────────────────

describe("ORDERS_FULFILLED", () => {
  const ORDER_GID = "gid://shopify/Order/700";

  const contract = {
    id: "c_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    ownership: "OURS",
  };

  function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 700,
      admin_graphql_api_id: ORDER_GID,
      name: "#1001",
      fulfillments: [
        {
          created_at: "2026-08-08T10:00:00Z",
          tracking_number: "1Z999",
          tracking_url: "https://track.example/1Z999",
          tracking_company: "DHL",
        },
      ],
      ...over,
    };
  }

  async function deliver(over: Record<string, unknown> = {}): Promise<void> {
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: payload(over),
      webhookId: "wh_ff_1",
    });
  }

  it("renewal order: persists fulfilledAt (first fulfillment wins) and logs billing.order_fulfilled without the tracking number", async () => {
    mocks.attemptFindFirst.mockResolvedValue({
      id: "att_1",
      contractId: "c_1",
      cycleIndex: 3,
      orderName: "#1001",
      contract,
    });

    await deliver();

    expect(mocks.attemptUpdateMany).toHaveBeenCalledTimes(1);
    const stamp = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Only while still null: split shipments keep the FIRST ship instant.
    expect(stamp.where).toEqual({ id: "att_1", fulfilledAt: null });
    expect(stamp.data.fulfilledAt).toEqual(new Date("2026-08-08T10:00:00Z"));

    const events = loggedOfType("billing.order_fulfilled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orderId: ORDER_GID,
      origin: false,
      cycleIndex: 3,
      trackingCompany: "DHL",
      hasTracking: true,
    });
    // No PII, no tracking number on the stream.
    expect(JSON.stringify(events[0])).not.toContain("1Z999");

    // The notification behavior is unchanged.
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("redelivery: the event dedupes on the order id, the stamp is a no-op, the notification dedupes per cycle", async () => {
    mocks.attemptFindFirst.mockResolvedValue({
      id: "att_1",
      contractId: "c_1",
      cycleIndex: 3,
      orderName: "#1001",
      contract,
    });
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });
    mocks.hasSentForCycle.mockResolvedValue(true);

    await deliver();

    expect(loggedOfType("billing.order_fulfilled")).toHaveLength(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("origin (checkout) order: stamps originOrderFulfilledAt for an OWNED contract, no notification", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      ...contract,
      originOrderId: ORDER_GID,
    });

    await deliver();

    expect(mocks.contractUpdateMany).toHaveBeenCalledTimes(1);
    const stamp = mocks.contractUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(stamp.where).toEqual({ id: "c_1", originOrderFulfilledAt: null });
    expect(loggedOfType("billing.order_fulfilled")[0]).toMatchObject({
      origin: true,
    });
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a foreign contract's checkout is not ours to measure", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      ...contract,
      ownership: "FOREIGN",
      originOrderId: ORDER_GID,
    });
    await deliver();
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── WH-13: orders/cancelled is capture-only ──────────────────────────────────

describe("ORDERS_CANCELLED", () => {
  const ORDER_GID = "gid://shopify/Order/700";
  const contract = {
    id: "c_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    ownership: "OURS",
  };

  async function deliver(): Promise<void> {
    await webhookHandlers.ORDERS_CANCELLED({
      shopDomain: SHOP.domain,
      payload: {
        id: 700,
        admin_graphql_api_id: ORDER_GID,
        name: "#1001",
        cancel_reason: "customer",
        cancelled_at: "2026-08-08T12:00:00Z",
        financial_status: "voided",
        total_price: "57.60",
        currency: "CHF",
      },
      webhookId: "wh_oc_1",
    });
  }

  it("logs billing.order_cancelled with amounts + currency and mutates NO money", async () => {
    mocks.attemptFindFirst.mockResolvedValue({
      id: "att_1",
      contractId: "c_1",
      cycleIndex: 3,
      contract,
    });

    await deliver();

    const events = loggedOfType("billing.order_cancelled");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      orderId: ORDER_GID,
      origin: false,
      attemptId: "att_1",
      cycleIndex: 3,
      cancelReason: "customer",
      financialStatus: "voided",
      totalCents: 5760,
      currencyCode: "CHF",
    });
    // Capture-only: refunds flow via REFUNDS_CREATE, never from here.
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.contractUpdateMany).not.toHaveBeenCalled();
  });

  it("matches the origin mirror when no attempt owns the order", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      ...contract,
      originOrderId: ORDER_GID,
    });
    await deliver();
    expect(loggedOfType("billing.order_cancelled")[0]).toMatchObject({
      origin: true,
    });
  });

  it("dedupes on the order id and ignores foreign orders", async () => {
    mocks.attemptFindFirst.mockResolvedValue({
      id: "att_1",
      contractId: "c_1",
      cycleIndex: 3,
      contract,
    });
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });
    await deliver();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.requireShop.mockResolvedValue({ ...SHOP });
    mocks.attemptFindFirst.mockResolvedValue(null);
    mocks.contractFindFirst.mockResolvedValue(null);
    await deliver();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── WH-14: contract.created replay guard ─────────────────────────────────────

describe("SUBSCRIPTION_CONTRACTS_CREATE canonical-event guard", () => {
  const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";

  function mirror() {
    return {
      id: "c_1",
      shopId: "shop_1",
      shopifyContractId: CONTRACT_GID,
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      status: "ACTIVE",
      intervalWeeks: 4,
      billingIntervalUnit: "WEEK",
      billingIntervalCount: 4,
      currencyCode: "CHF",
      nextBillingDate: null,
      isPrepaid: false,
      locale: "en",
      originOrderId: null,
      ownership: "OURS",
      acqRaw: null,
      lines: [],
    };
  }

  async function deliver(): Promise<void> {
    await webhookHandlers.SUBSCRIPTION_CONTRACTS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: CONTRACT_GID, id: 500 },
      webhookId: "wh_cc_1",
    });
  }

  it("logs contract.created once on the first delivery", async () => {
    mocks.contractFindUnique.mockResolvedValue(mirror());
    await deliver();
    const created = loggedOfType("contract.created");
    expect(created).toHaveLength(1);
    expect(created[0].shopifyContractId).toBe(CONTRACT_GID);
    // The guard queried by the contract's identity.
    const guard = mocks.subscriberEventFindFirst.mock.calls.find((c) => {
      const where = (c[0] as { where?: Record<string, unknown> }).where ?? {};
      return where.type === "contract.created";
    });
    expect(guard).toBeDefined();
  });

  it("a manual replay re-syncs but never duplicates the canonical event", async () => {
    mocks.contractFindUnique.mockResolvedValue(mirror());
    mocks.subscriberEventFindFirst.mockImplementation(async (args?: unknown) => {
      const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      return where.type === "contract.created" ? { id: "evt_created" } : null;
    });

    await deliver();

    expect(loggedOfType("contract.created")).toHaveLength(0);
    // The idempotent sync still ran — replay heals mirrors, not events.
    expect(mocks.syncContractFromShopify).toHaveBeenCalledTimes(1);
  });
});

// ── Registry ↔ toml parity for the added topics ──────────────────────────────

describe("webhook registry covers every configured topic", () => {
  it("each toml topic has a handler (incl. shop/update, customers/update, orders/cancelled)", () => {
    const toml = readFileSync(
      fileURLToPath(new URL("../shopify.app.toml", import.meta.url)),
      "utf8",
    );
    const topicArrays = [...toml.matchAll(/(?<!compliance_)topics = \[([^\]]*)\]/g)];
    const topics = topicArrays
      .flatMap((m) => m[1].split(","))
      .map((t) => t.trim().replace(/^"|"$/g, ""))
      .filter((t) => t.length > 0);
    expect(topics).toContain("shop/update");
    expect(topics).toContain("customers/update");
    expect(topics).toContain("orders/cancelled");
    for (const topic of topics) {
      const key = topic.toUpperCase().replace(/\//g, "_");
      expect(
        webhookHandlers[key],
        `topic ${topic} configured in shopify.app.toml has no ${key} handler`,
      ).toBeTypeOf("function");
    }
  });
});
