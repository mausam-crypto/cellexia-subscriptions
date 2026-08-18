import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 cross-stage audit — CUSTOMERS_REDACT must erase the customer-
 * authored free text the release added:
 *  - SubscriptionContract.deliveryInstructions (Stage D2, migration 0028);
 *  - `support.requested` SubscriberEvent payloads (message, cancelReasonDetail,
 *    orderRef) — the admin subscriber page renders them;
 *  - SUPPORT_REQUEST alerts (name + email + excerpt in message,
 *    cancelReasonDetail in context), matched by context.contractId because
 *    their context carries neither customerId nor email.
 * Structural facts (topic / saveRequest / cancelSessionId / cancelReason)
 * survive so the concierge SLA job and the timeline keep working.
 *
 * Harness mirrors tests/acquisition-capture.test.ts.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  subscriberEventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  subscriberEventUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  subscriberEventUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  shopFindUnique: vi.fn(
    async (): Promise<unknown> => ({ id: "shop_1", domain: "cellexia-test.myshopify.com" }),
  ),
  notificationLogUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  otpCodeDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  portalSessionDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  magicLinkTokenDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  klaviyoOutboxDeleteMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  klaviyoOutboxUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
  alertCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  alertFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  alertUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: vi.fn(async () => []) },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      findMany: mocks.subscriberEventFindMany,
      update: mocks.subscriberEventUpdate,
      updateMany: mocks.subscriberEventUpdateMany,
    },
    subscriptionContract: {
      findFirst: vi.fn(async () => null),
      findMany: mocks.contractFindMany,
      updateMany: mocks.contractUpdateMany,
    },
    shop: { findUnique: mocks.shopFindUnique },
    notificationLog: { updateMany: mocks.notificationLogUpdateMany },
    otpCode: { deleteMany: mocks.otpCodeDeleteMany },
    portalSession: { deleteMany: mocks.portalSessionDeleteMany },
    magicLinkToken: { deleteMany: mocks.magicLinkTokenDeleteMany },
    klaviyoOutbox: {
      deleteMany: mocks.klaviyoOutboxDeleteMany,
      updateMany: mocks.klaviyoOutboxUpdateMany,
    },
    alert: {
      create: mocks.alertCreate,
      findMany: mocks.alertFindMany,
      update: mocks.alertUpdate,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: vi.fn() }));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));
vi.mock("~/lib/graphql/customers.server", () => ({
  getCustomer: vi.fn(async (): Promise<unknown> => null),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const JANE_EMAIL = "jane@example.com";
const MESSAGE = "I am Jane Doe at 12 Rue X, my card ending 4242 was charged twice";
const DETAIL = "my phone is +44 7700 900123, call me";

async function runRedact(): Promise<void> {
  await webhookHandlers.CUSTOMERS_REDACT({
    shopDomain: "cellexia-test.myshopify.com",
    payload: {
      customer: { id: 42, admin_graphql_api_id: "gid://shopify/Customer/42", email: JANE_EMAIL },
    },
    webhookId: "wh_redact_v128",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({ id: "shop_1", domain: "cellexia-test.myshopify.com" });
  mocks.contractFindMany.mockResolvedValue([{ id: "c1", originOrderId: null }]);
  mocks.subscriberEventFindMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: { type?: unknown } })?.where;
    if (where?.type !== "support.requested") return [];
    return [
      {
        id: "ev_support_1",
        payload: {
          topic: "DELIVERY",
          contractId: "c1",
          orderRef: "#1042",
          pushBack: false,
          pushBackApplied: false,
          message: MESSAGE,
          surface: "cancel_flow",
          cancelReason: "TOO_EXPENSIVE",
          cancelSessionId: "cs_1",
          cancelReasonDetail: DETAIL,
          saveRequest: true,
        },
      },
    ];
  });
  mocks.alertFindMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: { type?: unknown } })?.where;
    if (where?.type !== "SUPPORT_REQUEST") return [];
    return [
      {
        id: "alert_support_1",
        context: {
          contractId: "c1",
          subscriberUrl: "/app/subscribers/c1",
          topic: "DELIVERY",
          orderRef: "#1042",
          pushBack: false,
          pushBackApplied: false,
          surface: "cancel_flow",
          cancelReason: "TOO_EXPENSIVE",
          cancelReasonDetail: DETAIL,
          cancelSessionId: "cs_1",
          saveRequest: true,
        },
      },
    ];
  });
});

describe("CUSTOMERS_REDACT erases the v1.28.0 customer-authored stores", () => {
  it("nulls SubscriptionContract.deliveryInstructions next to deliveryAddress", async () => {
    await runRedact();
    const args = mocks.contractUpdateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(
      Object.prototype.hasOwnProperty.call(args.data, "deliveryInstructions"),
      "deliveryInstructions must be in the redact updateMany",
    ).toBe(true);
    expect(args.data.deliveryInstructions).toBeNull();
  });

  it("scrubs message / cancelReasonDetail / orderRef from support.requested payloads, keeps the structural facts", async () => {
    await runRedact();
    const query = mocks.subscriberEventFindMany.mock.calls.find(
      (c) => (c[0] as { where?: { type?: unknown } })?.where?.type === "support.requested",
    );
    expect(query, "handler must look up support.requested events for the identity").toBeDefined();
    const where = (query![0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toEqual(
      expect.arrayContaining([{ contractId: { in: ["c1"] } }, { email: JANE_EMAIL }]),
    );

    expect(mocks.subscriberEventUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.subscriberEventUpdate.mock.calls[0][0] as {
      where: { id: string };
      data: { payload: Record<string, unknown> };
    };
    expect(update.where).toEqual({ id: "ev_support_1" });
    const serialised = JSON.stringify(update.data.payload);
    expect(serialised).not.toContain("Jane Doe");
    expect(serialised).not.toContain("4242");
    expect(serialised).not.toContain("+44");
    expect(update.data.payload.message).toBe("");
    expect(update.data.payload.orderRef).toBeNull();
    expect(update.data.payload).not.toHaveProperty("cancelReasonDetail");
    expect(update.data.payload.redacted).toBe(true);
    // The SLA job / timeline facts survive.
    expect(update.data.payload.topic).toBe("DELIVERY");
    expect(update.data.payload.saveRequest).toBe(true);
    expect(update.data.payload.cancelSessionId).toBe("cs_1");
    expect(update.data.payload.cancelReason).toBe("TOO_EXPENSIVE");
    expect(update.data.payload.surface).toBe("cancel_flow");
  });

  it("rewrites SUPPORT_REQUEST alerts matched by context.contractId (they carry no customerId/email)", async () => {
    await runRedact();
    const query = mocks.alertFindMany.mock.calls.find(
      (c) => (c[0] as { where?: { type?: unknown } })?.where?.type === "SUPPORT_REQUEST",
    );
    expect(query, "handler must look up SUPPORT_REQUEST alerts").toBeDefined();
    const where = (query![0] as { where: { OR: unknown[] } }).where;
    expect(where.OR).toEqual([{ context: { path: ["contractId"], equals: "c1" } }]);

    const update = mocks.alertUpdate.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === "alert_support_1",
    );
    expect(update).toBeDefined();
    const data = (update![0] as { data: { message: string; context: Record<string, unknown> } }).data;
    expect(data.message).not.toContain(JANE_EMAIL);
    expect(data.message).not.toContain("Jane");
    expect(data.message).toContain("redacted");
    expect(JSON.stringify(data.context)).not.toContain("+44");
    expect(data.context).not.toHaveProperty("cancelReasonDetail");
    expect(data.context.redacted).toBe(true);
    // Operational keys the concierge SLA job reads survive.
    expect(data.context.contractId).toBe("c1");
    expect(data.context.saveRequest).toBe(true);
    expect(data.context.cancelSessionId).toBe("cs_1");
    expect(data.context.cancelReason).toBe("TOO_EXPENSIVE");
    expect(data.context.subscriberUrl).toBe("/app/subscribers/c1");
  });

  it("does not touch support stores when no contract of the identity exists (alerts have no identity keys)", async () => {
    mocks.contractFindMany.mockResolvedValue([]);
    await runRedact();
    const supportAlertQuery = mocks.alertFindMany.mock.calls.find(
      (c) => (c[0] as { where?: { type?: unknown } })?.where?.type === "SUPPORT_REQUEST",
    );
    expect(supportAlertQuery).toBeUndefined();
    // Events are still reachable by the email filter (the row carries it).
    const eventQuery = mocks.subscriberEventFindMany.mock.calls.find(
      (c) => (c[0] as { where?: { type?: unknown } })?.where?.type === "support.requested",
    );
    expect(eventQuery).toBeDefined();
  });
});
