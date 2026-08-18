import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Delivery-tracking mirror (v1.28.0, P4.2 "Your deliveries").
 *
 * BillingAttempt.trackingUrl / trackingCompany / trackingNumber /
 * orderStatusUrl / shippedAt / deliveredAt (migration 0028) are written by
 * applyDeliveryTracking, fed by ORDERS_FULFILLED, FULFILLMENTS_CREATE,
 * FULFILLMENTS_UPDATE and FULFILLMENT_EVENTS_CREATE. Pinned:
 *
 *  1. persist: orders/fulfilled writes tracking + shippedAt + orderStatusUrl
 *     and logs contract.delivery_shipped (analytics only, no tracking
 *     number on the stream); the existing fulfilledAt stamp + billing
 *     notification path is untouched.
 *  2. idempotent: a redelivery / a second topic carrying the same facts
 *     writes nothing and logs nothing; shippedAt/deliveredAt are first-wins;
 *     tracking values overwrite when they change (3PL adds the number later
 *     on fulfillments/update); nulls never erase.
 *  3. ownership: an attempt on a FOREIGN/UNKNOWN contract is never written.
 *  4. missing attempt (origin/checkout order, or a foreign app's renewal):
 *     no write, no event.
 *  5. delivered: fulfillment_events/create status "delivered" (happened_at)
 *     and fulfillments/update shipment_status "delivered" stamp deliveredAt
 *     once and log contract.delivery_delivered once; other event statuses are
 *     ignored without a DB read.
 *  6. containment: a mirror failure never fails the webhook.
 *  7. registry ↔ toml: the three new topics are declared in shopify.app.toml
 *     and mapped to handlers (`npm run deploy` registers them).
 *  8. race-safe milestones (Stage E review): shippedAt/deliveredAt are
 *     written with GUARDED updateMany (where column null) and the event is
 *     logged only when that write affected the row — two topics landing at
 *     once stamp once and log once.
 *  9. cancelled fulfillments (Stage E review): orders/fulfilled reads the
 *     first SUCCESS fulfillment (Shopify keeps cancelled ones in the array);
 *     fulfillments/update status cancelled|error|failure un-ships the mirror
 *     when the stored tracking is that fulfillment's, and leaves another
 *     fulfillment's tracking alone.
 * 10. settlement backfill: the success settlement feeds the mirror from the
 *     order summary's fulfillments (an order fulfilled before the attempt
 *     had an orderId).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  contractFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (_a?: unknown): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(async () => null), update: vi.fn() },
    subscriptionContract: {
      findUnique: vi.fn(async () => null),
      findFirst: mocks.contractFindFirst,
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: mocks.contractUpdateMany,
    },
    billingAttempt: {
      findFirst: mocks.attemptFindFirst,
      update: mocks.attemptUpdate,
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
  gql: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  draftUpdatePaymentMethod: vi.fn(),
  withContractDraft: vi.fn(),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/gifts/firstOrderGift.server", () => ({
  ensureFirstOrderGift: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";
import {
  applyDeliveryTracking,
  applyDeliveryTrackingContained,
} from "~/lib/webhooks/fulfillment-tracking.server";

const SHOP = { id: "shop_1", domain: "cellexia.myshopify.com" };
const ORDER_GID = "gid://shopify/Order/700";

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    contractId: "c_1",
    cycleIndex: 3,
    orderName: "#1001",
    trackingUrl: null,
    trackingCompany: null,
    trackingNumber: null,
    orderStatusUrl: null,
    shippedAt: null,
    deliveredAt: null,
    contract: {
      id: "c_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      ownership: "OURS",
    },
    ...over,
  };
}

function loggedOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

/** Everything the mirror wrote: the tracking update (plain) merged with the
 * guarded milestone updateMany writes ({ where: { id, shippedAt: null } } /
 * { deliveredAt: null }) — the pre-existing fulfilledAt stamp excluded. */
function updateData(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of mocks.attemptUpdate.mock.calls) {
    Object.assign(out, (c[0] as { data: Record<string, unknown> }).data);
  }
  for (const c of mocks.attemptUpdateMany.mock.calls) {
    const arg = c[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    if ("fulfilledAt" in arg.where) continue;
    Object.assign(out, arg.data);
  }
  return out;
}

/** The guarded milestone writes only (where shippedAt/deliveredAt: null). */
function milestoneWrites(): Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> {
  return mocks.attemptUpdateMany.mock.calls
    .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
    .filter((a) => "shippedAt" in a.where || "deliveredAt" in a.where);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.hasSentForCycle.mockResolvedValue(false);
});

// ── 1 + 2: orders/fulfilled persists, redelivery is a no-op ──────────────────

describe("ORDERS_FULFILLED feeds the delivery mirror", () => {
  function orderPayload(over: Record<string, unknown> = {}) {
    return {
      id: 700,
      admin_graphql_api_id: ORDER_GID,
      name: "#1001",
      order_status_url: "https://cellexialabs.com/12345/orders/abcdef/authenticate?key=k",
      fulfillments: [
        {
          created_at: "2026-08-08T10:00:00Z",
          tracking_number: "1Z999",
          tracking_url: "https://track.example/1Z999",
          tracking_company: "DHL",
          shipment_status: null,
        },
      ],
      ...over,
    };
  }

  it("persists tracking + shippedAt + orderStatusUrl on the renewal attempt and logs contract.delivery_shipped once (no tracking number on the stream)", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: orderPayload(),
      webhookId: "wh_1",
    });

    expect(updateData()).toEqual({
      trackingUrl: "https://track.example/1Z999",
      trackingCompany: "DHL",
      trackingNumber: "1Z999",
      orderStatusUrl: "https://cellexialabs.com/12345/orders/abcdef/authenticate?key=k",
      shippedAt: new Date("2026-08-08T10:00:00Z"),
    });
    // The analytics stamp (fulfilledAt, first wins) is unchanged.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "att_1", fulfilledAt: null },
      data: { fulfilledAt: new Date("2026-08-08T10:00:00Z") },
    });
    // The ship milestone is a GUARDED write (race-safe first-wins).
    expect(milestoneWrites()).toEqual([
      { where: { id: "att_1", shippedAt: null }, data: { shippedAt: new Date("2026-08-08T10:00:00Z") } },
    ]);
    // The order_shipped notification path is untouched.
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

    const shipped = loggedOfType("contract.delivery_shipped");
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toMatchObject({
      orderId: ORDER_GID,
      attemptId: "att_1",
      cycleIndex: 3,
      orderName: "#1001",
      trackingCompany: "DHL",
      hasTracking: true,
      via: "orders/fulfilled",
    });
    expect(JSON.stringify(shipped[0])).not.toContain("1Z999");
    expect(loggedOfType("contract.delivery_delivered")).toHaveLength(0);
    // Analytics event only: never on the Klaviyo path (logEvent, not OrThrow).
    const shippedCall = mocks.logEvent.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "contract.delivery_shipped",
    );
    expect((shippedCall?.[0] as { source: string }).source).toBe("WEBHOOK");
  });

  it("redelivery with the same facts already mirrored writes nothing and logs nothing (idempotent)", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/1Z999",
        trackingCompany: "DHL",
        trackingNumber: "1Z999",
        orderStatusUrl: "https://cellexialabs.com/12345/orders/abcdef/authenticate?key=k",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
      }),
    );
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: orderPayload(),
      webhookId: "wh_2",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(milestoneWrites()).toEqual([]);
    expect(loggedOfType("contract.delivery_shipped")).toHaveLength(0);
  });

  it("a split shipment keeps the FIRST shippedAt but a changed tracking url overwrites; a null tracking field never erases", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/OLD",
        trackingCompany: "DHL",
        trackingNumber: "OLD",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
      }),
    );
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: orderPayload({
        order_status_url: null,
        fulfillments: [
          {
            created_at: "2026-08-10T10:00:00Z",
            tracking_url: "https://track.example/NEW",
            tracking_company: null,
            tracking_number: null,
          },
        ],
      }),
      webhookId: "wh_3",
    });
    expect(updateData()).toEqual({ trackingUrl: "https://track.example/NEW" });
    expect(milestoneWrites()).toEqual([]);
    // No milestone transition → no event.
    expect(loggedOfType("contract.delivery_shipped")).toHaveLength(0);
  });

  it("reads the first SUCCESS fulfillment — a cancelled one earlier in the array never feeds the mirror", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/B",
        trackingCompany: "UPS",
        trackingNumber: "B-1",
        shippedAt: new Date("2026-08-09T10:00:00Z"),
      }),
    );
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: orderPayload({
        fulfillments: [
          {
            status: "cancelled",
            created_at: "2026-08-08T10:00:00Z",
            tracking_url: "https://track.example/A",
            tracking_company: "DHL",
            tracking_number: "A-1",
          },
          {
            status: "success",
            created_at: "2026-08-09T10:00:00Z",
            tracking_url: "https://track.example/B",
            tracking_company: "UPS",
            tracking_number: "B-1",
          },
        ],
      }),
      webhookId: "wh_3b",
    });
    // Nothing from the cancelled fulfillment A landed; B was already mirrored
    // (only the order-status url is new).
    expect(updateData()).toEqual({
      orderStatusUrl: "https://cellexialabs.com/12345/orders/abcdef/authenticate?key=k",
    });
    // The analytics stamp uses B's created_at too.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "att_1", fulfilledAt: null },
      data: { fulfilledAt: new Date("2026-08-09T10:00:00Z") },
    });
    // Notification carries B's tracking, not A's.
    const vars = (mocks.sendNotification.mock.calls[0][0] as { vars: Record<string, unknown> }).vars;
    expect(vars.tracking_number).toBe("B-1");
  });

  it("an origin (checkout) order has no attempt: the mirror writes nothing (Shopify's own order page owns it)", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "c_1",
      shopId: SHOP.id,
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      ownership: "OURS",
      originOrderId: ORDER_GID,
    });
    await webhookHandlers.ORDERS_FULFILLED({
      shopDomain: SHOP.domain,
      payload: orderPayload(),
      webhookId: "wh_4",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(loggedOfType("contract.delivery_shipped")).toHaveLength(0);
  });
});

// ── fulfillments/create + fulfillments/update ────────────────────────────────

describe("FULFILLMENTS_CREATE / FULFILLMENTS_UPDATE", () => {
  function fulfillmentPayload(over: Record<string, unknown> = {}) {
    return {
      id: 9001,
      order_id: 700,
      status: "success",
      created_at: "2026-08-08T10:00:00Z",
      updated_at: "2026-08-08T10:00:00Z",
      tracking_company: "DHL",
      tracking_number: "1Z999",
      tracking_url: "https://track.example/1Z999",
      shipment_status: null,
      ...over,
    };
  }

  it("fulfillments/create resolves the order from the numeric order_id and persists tracking + shippedAt", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    await webhookHandlers.FULFILLMENTS_CREATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload(),
      webhookId: "wh_f1",
    });
    const where = (mocks.attemptFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ orderId: ORDER_GID, contract: { shopId: SHOP.id } });
    expect(updateData()).toEqual({
      trackingUrl: "https://track.example/1Z999",
      trackingCompany: "DHL",
      trackingNumber: "1Z999",
      shippedAt: new Date("2026-08-08T10:00:00Z"),
    });
    expect(loggedOfType("contract.delivery_shipped")[0]).toMatchObject({
      via: "fulfillments/create",
    });
    // No shipping email from the app — Klaviyo owns those.
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("fulfillments/update adds the tracking number a 3PL attached later, without touching shippedAt or re-logging", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingCompany: "DHL",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
      }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({ updated_at: "2026-08-09T08:00:00Z" }),
      webhookId: "wh_f2",
    });
    expect(updateData()).toEqual({
      trackingUrl: "https://track.example/1Z999",
      trackingNumber: "1Z999",
    });
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("fulfillments/update with shipment_status delivered stamps deliveredAt (updated_at) once and logs contract.delivery_delivered once", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/1Z999",
        trackingCompany: "DHL",
        trackingNumber: "1Z999",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
      }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({
        shipment_status: "delivered",
        updated_at: "2026-08-11T15:30:00Z",
      }),
      webhookId: "wh_f3",
    });
    expect(updateData()).toEqual({ deliveredAt: new Date("2026-08-11T15:30:00Z") });
    const delivered = loggedOfType("contract.delivery_delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      orderId: ORDER_GID,
      attemptId: "att_1",
      deliveredAt: "2026-08-11T15:30:00.000Z",
      via: "fulfillments/update",
    });

    // Redelivery: deliveredAt is first-wins → nothing written, nothing logged.
    vi.clearAllMocks();
    mocks.requireShop.mockResolvedValue({ ...SHOP });
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/1Z999",
        trackingCompany: "DHL",
        trackingNumber: "1Z999",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
        deliveredAt: new Date("2026-08-11T15:30:00Z"),
      }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({
        shipment_status: "delivered",
        updated_at: "2026-08-12T09:00:00Z",
      }),
      webhookId: "wh_f4",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(milestoneWrites()).toEqual([]);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a pending / open fulfillment writes nothing (not on its way yet)", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    for (const status of ["pending", "open"]) {
      await webhookHandlers.FULFILLMENTS_UPDATE({
        shopDomain: SHOP.domain,
        payload: fulfillmentPayload({ status }),
        webhookId: `wh_${status}`,
      });
    }
    expect(mocks.attemptFindFirst).not.toHaveBeenCalled();
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("a CANCELLED fulfillment un-ships the mirror when the stored tracking is its own: tracking cleared, shippedAt cleared, contract.delivery_shipment_cancelled logged", async () => {
    for (const status of ["cancelled", "error", "failure"]) {
      vi.clearAllMocks();
      mocks.requireShop.mockResolvedValue({ ...SHOP });
      mocks.attemptFindFirst.mockResolvedValue(
        attemptRow({
          trackingUrl: "https://track.example/1Z999",
          trackingCompany: "DHL",
          trackingNumber: "1Z999",
          shippedAt: new Date("2026-08-08T10:00:00Z"),
        }),
      );
      await webhookHandlers.FULFILLMENTS_UPDATE({
        shopDomain: SHOP.domain,
        payload: fulfillmentPayload({ status }),
        webhookId: `wh_${status}`,
      });
      expect(mocks.attemptUpdate).toHaveBeenCalledTimes(1);
      expect((mocks.attemptUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({
        trackingUrl: null,
        trackingCompany: null,
        trackingNumber: null,
        shippedAt: null,
      });
      const ev = loggedOfType("contract.delivery_shipment_cancelled");
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ orderId: ORDER_GID, attemptId: "att_1", unshipped: true, via: "fulfillments/update" });
      expect(JSON.stringify(ev[0])).not.toContain("1Z999");
    }
  });

  it("a cancelled fulfillment whose tracking is NOT the stored one (another live parcel) leaves the mirror alone; a delivered row keeps its stamps", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/B",
        trackingNumber: "B-1",
        shippedAt: new Date("2026-08-09T10:00:00Z"),
      }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({
        status: "cancelled",
        tracking_url: "https://track.example/A",
        tracking_number: "A-1",
      }),
      webhookId: "wh_c1",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    // Delivered already: tracking withdrawn, the delivered/shipped stamps stay.
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({
        trackingUrl: "https://track.example/1Z999",
        trackingNumber: "1Z999",
        shippedAt: new Date("2026-08-08T10:00:00Z"),
        deliveredAt: new Date("2026-08-11T10:00:00Z"),
      }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({ status: "cancelled" }),
      webhookId: "wh_c2",
    });
    expect((mocks.attemptUpdate.mock.calls[0][0] as { data: unknown }).data).toEqual({
      trackingUrl: null,
      trackingCompany: null,
      trackingNumber: null,
    });
    expect(loggedOfType("contract.delivery_shipment_cancelled")[0]).toMatchObject({ unshipped: false });
  });

  it("a cancelled fulfillment without tracking matches on its created_at (the stored ship instant) — and never a different one", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({ shippedAt: new Date("2026-08-08T10:00:00Z") }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({
        status: "cancelled",
        tracking_url: null,
        tracking_number: null,
        tracking_company: null,
        created_at: "2026-08-08T10:00:00Z",
      }),
      webhookId: "wh_c3",
    });
    expect((mocks.attemptUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data.shippedAt).toBeNull();
    vi.clearAllMocks();
    mocks.requireShop.mockResolvedValue({ ...SHOP });
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({ shippedAt: new Date("2026-08-08T10:00:00Z") }),
    );
    await webhookHandlers.FULFILLMENTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload({
        status: "cancelled",
        tracking_url: null,
        tracking_number: null,
        tracking_company: null,
        created_at: "2026-08-09T10:00:00Z",
      }),
      webhookId: "wh_c4",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
  });

  it("no matching attempt (another app's renewal, an origin order): no write, no event", async () => {
    await webhookHandlers.FULFILLMENTS_CREATE({
      shopDomain: SHOP.domain,
      payload: fulfillmentPayload(),
      webhookId: "wh_f5",
    });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("ownership: an attempt on a FOREIGN or UNKNOWN contract is never written", async () => {
    for (const ownership of ["FOREIGN", "UNKNOWN"]) {
      mocks.attemptFindFirst.mockResolvedValue(
        attemptRow({ contract: { ...attemptRow().contract, ownership } }),
      );
      await webhookHandlers.FULFILLMENTS_CREATE({
        shopDomain: SHOP.domain,
        payload: fulfillmentPayload(),
        webhookId: `wh_${ownership}`,
      });
    }
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── fulfillment_events/create ────────────────────────────────────────────────

describe("FULFILLMENT_EVENTS_CREATE", () => {
  it("status delivered stamps deliveredAt from happened_at and logs contract.delivery_delivered", async () => {
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({ shippedAt: new Date("2026-08-08T10:00:00Z"), trackingCompany: "DHL" }),
    );
    await webhookHandlers.FULFILLMENT_EVENTS_CREATE({
      shopDomain: SHOP.domain,
      payload: {
        id: 1,
        fulfillment_id: 9001,
        order_id: 700,
        status: "delivered",
        happened_at: "2026-08-11T15:30:00Z",
        created_at: "2026-08-11T15:31:00Z",
      },
      webhookId: "wh_e1",
    });
    expect(updateData()).toEqual({ deliveredAt: new Date("2026-08-11T15:30:00Z") });
    expect(loggedOfType("contract.delivery_delivered")[0]).toMatchObject({
      via: "fulfillment_events/create",
      trackingCompany: "DHL",
    });
  });

  it("other statuses (in_transit, out_for_delivery, …) are ignored before any DB read", async () => {
    for (const status of ["in_transit", "out_for_delivery", "attempted_delivery", "failure"]) {
      await webhookHandlers.FULFILLMENT_EVENTS_CREATE({
        shopDomain: SHOP.domain,
        payload: { order_id: 700, status, happened_at: "2026-08-10T00:00:00Z" },
        webhookId: `wh_${status}`,
      });
    }
    expect(mocks.requireShop).not.toHaveBeenCalled();
    expect(mocks.attemptFindFirst).not.toHaveBeenCalled();
  });
});

// ── the pure mirror function ─────────────────────────────────────────────────

describe("applyDeliveryTracking", () => {
  it("reports the outcome and the columns written", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    const r = await applyDeliveryTracking({
      shopId: SHOP.id,
      orderGid: ORDER_GID,
      source: "test",
      orderStatusUrl: "https://cellexialabs.com/o/1",
      shippedAt: new Date("2026-08-08T10:00:00Z"),
    });
    expect(r).toEqual({
      outcome: "updated",
      attemptId: "att_1",
      changed: ["orderStatusUrl", "shippedAt"],
    });
  });

  it("no attempt → no_attempt; foreign → foreign; nothing new → unchanged (no update, no event)", async () => {
    expect((await applyDeliveryTracking({ shopId: SHOP.id, orderGid: ORDER_GID, source: "t" })).outcome).toBe("no_attempt");
    mocks.attemptFindFirst.mockResolvedValue(
      attemptRow({ contract: { ...attemptRow().contract, ownership: "FOREIGN" } }),
    );
    expect(
      (await applyDeliveryTracking({ shopId: SHOP.id, orderGid: ORDER_GID, source: "t", shippedAt: new Date() })).outcome,
    ).toBe("foreign");
    mocks.attemptFindFirst.mockResolvedValue(attemptRow({ shippedAt: new Date("2026-08-01T00:00:00Z") }));
    expect(
      (await applyDeliveryTracking({ shopId: SHOP.id, orderGid: ORDER_GID, source: "t", shippedAt: new Date() })).outcome,
    ).toBe("unchanged");
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("race-safe: the milestone is stamped with a GUARDED updateMany and logged ONLY when that write affected the row (a concurrent topic that lost writes/logs nothing)", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    // Loser: the guarded write finds shippedAt already set by the other topic.
    mocks.attemptUpdateMany.mockResolvedValueOnce({ count: 0 });
    const lost = await applyDeliveryTracking({
      shopId: SHOP.id,
      orderGid: ORDER_GID,
      source: "fulfillments/create",
      shippedAt: new Date("2026-08-08T10:00:00Z"),
    });
    expect(lost).toEqual({ outcome: "unchanged", attemptId: "att_1", changed: [] });
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(milestoneWrites()).toEqual([
      { where: { id: "att_1", shippedAt: null }, data: { shippedAt: new Date("2026-08-08T10:00:00Z") } },
    ]);

    // Winner: count 1 → stamped + logged once. Same for deliveredAt.
    vi.clearAllMocks();
    mocks.attemptFindFirst.mockResolvedValue(attemptRow({ shippedAt: new Date("2026-08-08T10:00:00Z") }));
    const won = await applyDeliveryTracking({
      shopId: SHOP.id,
      orderGid: ORDER_GID,
      source: "fulfillment_events/create",
      deliveredAt: new Date("2026-08-11T10:00:00Z"),
    });
    expect(won.changed).toEqual(["deliveredAt"]);
    expect(milestoneWrites()).toEqual([
      { where: { id: "att_1", deliveredAt: null }, data: { deliveredAt: new Date("2026-08-11T10:00:00Z") } },
    ]);
    expect(loggedOfType("contract.delivery_delivered")).toHaveLength(1);
  });

  it("an invalid date is ignored, never written", async () => {
    mocks.attemptFindFirst.mockResolvedValue(attemptRow());
    const r = await applyDeliveryTracking({
      shopId: SHOP.id,
      orderGid: ORDER_GID,
      source: "t",
      shippedAt: new Date("not a date"),
      deliveredAt: new Date("nope"),
    });
    expect(r.outcome).toBe("unchanged");
  });

  it("the contained variant swallows a DB failure (a mirror failure never fails a webhook)", async () => {
    mocks.attemptFindFirst.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await applyDeliveryTrackingContained({
      shopId: SHOP.id,
      orderGid: ORDER_GID,
      source: "t",
      shippedAt: new Date(),
    });
    expect(r).toBeNull();
    // …and the webhook handler that uses it still completes.
    await expect(
      webhookHandlers.FULFILLMENTS_CREATE({
        shopDomain: SHOP.domain,
        payload: { order_id: 700, status: "success", created_at: "2026-08-08T10:00:00Z" },
        webhookId: "wh_x",
      }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

// ── 7. registry ↔ toml ───────────────────────────────────────────────────────

describe("fulfillment topics are declared and mapped (npm run deploy registers them)", () => {
  it("shopify.app.toml lists fulfillments/create, fulfillments/update, fulfillment_events/create and each has a handler", () => {
    const toml = readFileSync(
      fileURLToPath(new URL("../shopify.app.toml", import.meta.url)),
      "utf8",
    );
    for (const topic of ["fulfillments/create", "fulfillments/update", "fulfillment_events/create"]) {
      expect(toml).toContain(`"${topic}"`);
      const key = topic.toUpperCase().replace(/\//g, "_");
      expect(webhookHandlers[key]).toBeTypeOf("function");
    }
    // The fulfillment topics need the fulfillments read scope, already held.
    expect(toml).toMatch(/scopes = "[^"]*read_fulfillments/);
  });

  it("the settlement claim mirrors the order-status page URL from the order summary when Shopify returns one", () => {
    const handlers = readFileSync(
      fileURLToPath(new URL("../app/lib/webhooks/handlers.server.ts", import.meta.url)),
      "utf8",
    );
    expect(handlers).toContain("orderStatusUrl: orderSummary.statusPageUrl");
    const orders = readFileSync(
      fileURLToPath(new URL("../app/lib/graphql/orders.server.ts", import.meta.url)),
      "utf8",
    );
    expect(orders).toMatch(/displayFulfillmentStatus\s+statusPageUrl/);
  });

  it("the settlement feeds the mirror from the order summary's fulfillments (fulfilled-before-settlement orders) — first SUCCESS only", () => {
    const orders = readFileSync(
      fileURLToPath(new URL("../app/lib/graphql/orders.server.ts", import.meta.url)),
      "utf8",
    );
    expect(orders).toMatch(/fulfillments\(first: 10\) \{\s+status\s+createdAt\s+trackingInfo\(first: 1\)/);
    expect(orders).toContain("fulfillments: OrderFulfillmentSummary[]");
    const handlers = readFileSync(
      fileURLToPath(new URL("../app/lib/webhooks/handlers.server.ts", import.meta.url)),
      "utf8",
    );
    expect(handlers).toContain('source: "settlement/order_summary"');
    expect(handlers).toMatch(/summaryFulfillments\.find\(\s*\(f\) => \(f\.status \?\? ""\)\.toUpperCase\(\) === "SUCCESS"/);
  });

  it("the scheduler's stale-sweep claim mirrors the order-status page URL too (both settlement winners capture it)", () => {
    const scheduler = readFileSync(
      fileURLToPath(new URL("../app/lib/billing/scheduler.server.ts", import.meta.url)),
      "utf8",
    );
    // Same shape as the webhook claim: key omitted when the summary has none.
    expect(scheduler).toMatch(
      /summary\.statusPageUrl\s*\?\s*\{\s*orderStatusUrl:\s*summary\.statusPageUrl\s*\}\s*:\s*\{\}/,
    );
    // The mirror rides the same claim payload as the money breakdown.
    expect(scheduler).toContain("...(orderBreakdown ?? {})");
  });
});
