import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEventInput } from "~/lib/events/log.server";

/**
 * Klaviyo event-map tests. Everything DB/URL-shaped is mocked:
 *  - ~/db.server → contract / shop / dunning-case lookups
 *  - ~/lib/launch/launch.server → launch mode (LIVE by default here)
 *  - ~/lib/magiclinks/builder.server → portal + one-tap action links
 *  - ~/lib/klaviyo/outbox.server → `enqueue` capture (the assertion target)
 */

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  buildPortalUrl: vi.fn(
    async (): Promise<string> => "https://www.cellexia.example/apps/cellexia-subscriptions/",
  ),
  buildActionLinkBundle: vi.fn(
    async (): Promise<Record<string, string>> => ({
      skip_url: "https://app.example/magic/skip-token",
      delay_1w_url: "https://app.example/magic/delay1w-token",
      delay_3w_url: "https://app.example/magic/delay3w-token",
      update_card_url: "https://app.example/magic/update-card-token",
      pause_url: "https://app.example/magic/pause-token",
    }),
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
  },
}));

vi.mock("~/lib/klaviyo/outbox.server", () => ({
  enqueue: mocks.enqueue,
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));

vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildActionLinkBundle: mocks.buildActionLinkBundle,
}));

import {
  enqueueKlaviyoForEvent,
  metricForEventType,
} from "~/lib/klaviyo/events-map.server";

/** Minimal ContractWithLines-shaped fixture (fields the mapper reads). */
function contractFixture() {
  return {
    id: "cm_contract_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1001",
    customerId: "gid://shopify/Customer/2002",
    email: "anna@example.com",
    phone: "+447700900000",
    firstName: "Anna",
    lastName: "Larsson",
    status: "ACTIVE",
    // Column default in Prisma. enqueueKlaviyoForEvent refuses to enqueue for a
    // contract another subscription app owns, so the fixture states it.
    ownership: "OURS",
    locale: "en",
    currencyCode: "GBP",
    intervalWeeks: 8,
    nextBillingDate: new Date("2026-08-15T09:00:00Z"),
    ordersCount: 3,
    isPrepaid: false,
    churnRiskScore: 0.12,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 11,
    cardExpiryYear: 2027,
    lines: [
      {
        title: "Cellexia Renewal Serum",
        variantTitle: "30ml",
        quantity: 1,
        isGift: false,
        isOneTimeAddon: false,
      },
      {
        title: "Cellexia Travel Mask",
        variantTitle: null,
        quantity: 1,
        isGift: true,
        isOneTimeAddon: false,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(false); // LIVE unless a test says otherwise
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/London",
  });
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
});

describe("metricForEventType (pure map)", () => {
  it('contract.created maps to "Cellexia Subscription Started"', () => {
    expect(metricForEventType("contract.created")).toBe(
      "Cellexia Subscription Started",
    );
  });

  it("admin-only / plumbing types map to nothing", () => {
    expect(metricForEventType("admin.action")).toBeUndefined();
    expect(metricForEventType("alert.raised")).toBeUndefined();
    expect(metricForEventType("import.completed")).toBeUndefined();
    expect(metricForEventType("shop.installed")).toBeUndefined();
  });

  it("core lifecycle types are mapped to Cellexia-prefixed metrics", () => {
    expect(metricForEventType("contract.cancelled")).toBe(
      "Cellexia Subscription Cancelled",
    );
    expect(metricForEventType("cycle.skipped")).toBe("Cellexia Order Skipped");
    expect(metricForEventType("billing.attempt_failed")).toBe(
      "Cellexia Payment Failed",
    );
    expect(metricForEventType("dunning.recovered")).toBe(
      "Cellexia Payment Recovered",
    );
  });
});

describe("enqueueKlaviyoForEvent", () => {
  it("contract.created enqueues Cellexia Subscription Started with snapshot props", async () => {
    const event: LogEventInput = {
      shopId: "shop_1",
      type: "contract.created",
      source: "WEBHOOK",
      contractId: "cm_contract_1",
      customerId: "gid://shopify/Customer/2002",
      email: "anna@example.com",
      payload: { originOrderName: "#1042" },
    };

    await enqueueKlaviyoForEvent(event);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [shopId, input] = mocks.enqueue.mock.calls[0] as unknown as [
      string,
      {
        eventName: string;
        email: string | null;
        phone: string | null;
        profileAttrs: Record<string, unknown>;
        properties: Record<string, unknown>;
      },
    ];

    expect(shopId).toBe("shop_1");
    expect(input.eventName).toBe("Cellexia Subscription Started");
    expect(input.email).toBe("anna@example.com");

    // Raw event payload flows through…
    expect(input.properties.originOrderName).toBe("#1042");
    expect(input.properties.event_type).toBe("contract.created");
    // …plus the standard contract snapshot…
    expect(input.properties.contract_id).toBe("cm_contract_1");
    expect(input.properties.interval_weeks).toBe(8);
    expect(input.properties.item_titles).toEqual(["Cellexia Renewal Serum"]); // gifts excluded
    expect(input.properties.portal_url).toBe(
      "https://www.cellexia.example/apps/cellexia-subscriptions/",
    );
    // …and profile attributes for the standing segments.
    expect(input.profileAttrs.cellexia_subscription_status).toBe("ACTIVE");
    expect(input.profileAttrs.cellexia_orders_count).toBe(3);

    // contract.created is not a link-bundle type — no magic links minted.
    expect(mocks.buildActionLinkBundle).not.toHaveBeenCalled();
  });

  it("admin.action and alert.raised enqueue nothing", async () => {
    const base = {
      shopId: "shop_1",
      source: "ADMIN" as const,
      contractId: "cm_contract_1",
      email: "anna@example.com",
    };

    await enqueueKlaviyoForEvent({ ...base, type: "admin.action" });
    await enqueueKlaviyoForEvent({ ...base, type: "alert.raised" });

    expect(mocks.enqueue).not.toHaveBeenCalled();
    // Unmapped events short-circuit before any DB work.
    expect(mocks.contractFindUnique).not.toHaveBeenCalled();
  });

  it("notification.* events are always skipped (router enqueues its own metrics)", async () => {
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      type: "notification.sent",
      source: "SYSTEM",
      contractId: "cm_contract_1",
      email: "anna@example.com",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("billing.attempt_failed attaches the one-tap action link bundle + dunning context", async () => {
    const event: LogEventInput = {
      shopId: "shop_1",
      type: "billing.attempt_failed",
      source: "WEBHOOK",
      contractId: "cm_contract_1",
      email: "anna@example.com",
      payload: {
        attemptNumber: 2,
        amountCents: 4999,
        errorCode: "INSUFFICIENT_FUNDS",
        declineCategory: "SOFT",
      },
    };

    await enqueueKlaviyoForEvent(event);

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.buildActionLinkBundle).toHaveBeenCalledTimes(1);

    const [, input] = mocks.enqueue.mock.calls[0] as unknown as [
      string,
      {
        eventName: string;
        profileAttrs: Record<string, unknown>;
        properties: Record<string, unknown>;
      },
    ];
    expect(input.eventName).toBe("Cellexia Payment Failed");

    // Dunning context extracted from the payload.
    expect(input.properties.attempt_number).toBe(2);
    expect(input.properties.amount_cents).toBe(4999);
    expect(input.properties.amount_formatted).toContain("49.99");
    expect(input.properties.decline_code).toBe("INSUFFICIENT_FUNDS");
    expect(input.properties.card_last4).toBe("4242");

    // One-tap links merged into the event properties for the flow templates.
    expect(input.properties.skip_url).toBe(
      "https://app.example/magic/skip-token",
    );
    expect(input.properties.update_card_url).toBe(
      "https://app.example/magic/update-card-token",
    );

    // Profile flag drives the "Dunning open" segment.
    expect(input.profileAttrs.cellexia_dunning_open).toBe(true);
  });

  it("dunning.recovered clears the dunning-open profile flag", async () => {
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      type: "dunning.recovered",
      source: "WEBHOOK",
      contractId: "cm_contract_1",
      email: "anna@example.com",
      payload: { recoveredCents: 4999 },
    });

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [, input] = mocks.enqueue.mock.calls[0] as unknown as [
      string,
      { profileAttrs: Record<string, unknown> },
    ];
    expect(input.profileAttrs.cellexia_dunning_open).toBe(false);
  });

  it("setup mode suppresses every event at source", async () => {
    mocks.isSetupMode.mockResolvedValue(true);

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      type: "contract.created",
      source: "WEBHOOK",
      contractId: "cm_contract_1",
      email: "anna@example.com",
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.contractFindUnique).not.toHaveBeenCalled();
  });

  it("demo contracts never reach Klaviyo", async () => {
    mocks.contractFindUnique.mockResolvedValue({
      ...contractFixture(),
      isDemo: true,
    });

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      type: "contract.created",
      source: "WEBHOOK",
      contractId: "cm_contract_1",
      email: "anna@example.com",
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("events with no reachable email or phone are dropped", async () => {
    mocks.contractFindUnique.mockResolvedValue(null);

    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      type: "contract.created",
      source: "WEBHOOK",
      contractId: "cm_missing",
      email: null,
    });

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("never throws into the caller, even when every dependency fails", async () => {
    mocks.contractFindUnique.mockRejectedValue(new Error("db down"));

    await expect(
      enqueueKlaviyoForEvent({
        shopId: "shop_1",
        type: "contract.created",
        source: "WEBHOOK",
        contractId: "cm_contract_1",
        email: "anna@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
