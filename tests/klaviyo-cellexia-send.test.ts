import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEventInput } from "~/lib/events/log.server";

/**
 * cellexia_send + confirmation content on canonical events (v1.18.0,
 * events-map.server.ts).
 *
 * The auto-created Klaviyo flows (guided setup) trigger-filter on the
 * string property cellexia_send — these tests pin the stamping rules:
 *  - every mapped non-confirmation event carries "true";
 *  - confirmation events carry the provenance verdict (the SAME gate the
 *    app-sent bridge uses): person-initiated + template enabled = "true"
 *    with the app-rendered content attached; SYSTEM moments, non-CUSTOMER
 *    skips, MERGED cancels and disabled templates = "false" with no
 *    content;
 *  - a content-render failure flips the verdict to "false" (an auto flow
 *    must send NOTHING rather than an empty email);
 *  - the router's own enqueues carry "true" (pinned in
 *    email-sender-model.test.ts alongside);
 *  - the outbox dedupe graft carries cellexia_send onto a surviving row
 *    (pinned in emails-tab.test.ts).
 */

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(
    async (
      _shopId: string,
      _input: { properties: Record<string, unknown> },
    ): Promise<void> => {},
  ),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (): Promise<unknown> => null),
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  notificationLogFindFirst: vi.fn(async (): Promise<unknown> => null),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://portal.example/"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  emailsSetting: {
    templates: {} as Record<
      string,
      { enabled?: boolean; subject?: string; body?: string; sender?: string }
    >,
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
  },
}));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildActionLinkBundle: mocks.buildActionLinkBundle,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) => {
    if (key === "emails") return mocks.emailsSetting;
    if (key === "emailDesign") return {};
    return {};
  }),
}));

import {
  CELLEXIA_SEND_PROPERTY,
  enqueueKlaviyoForEvent,
} from "~/lib/klaviyo/events-map.server";

function contractFixture() {
  return {
    id: "cm_contract_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1001",
    customerId: "gid://shopify/Customer/2002",
    email: "anna@example.com",
    phone: null,
    firstName: "Anna",
    lastName: "Larsson",
    status: "ACTIVE",
    ownership: "OURS",
    locale: "en",
    currencyCode: "CHF",
    intervalWeeks: 8,
    nextBillingDate: new Date("2026-09-12T09:00:00Z"),
    ordersCount: 3,
    isPrepaid: false,
    churnRiskScore: null,
    cardBrand: null,
    cardLast4: null,
    cardExpiryMonth: null,
    cardExpiryYear: null,
    lines: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.shopFindUnique.mockResolvedValue({
    id: "shop_1",
    ianaTimezone: "Europe/Zurich",
  });
  mocks.emailsSetting.templates = {};
});

function enqueuedProperties(): Record<string, unknown> {
  expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  return mocks.enqueue.mock.calls[0][1].properties;
}

const customerSkip: LogEventInput = {
  shopId: "shop_1",
  contractId: "cm_contract_1",
  type: "cycle.skipped",
  source: "CUSTOMER_PORTAL",
  payload: { cycleIndex: 4, initiator: "CUSTOMER" },
};

describe("non-confirmation events", () => {
  it("canonical events carry cellexia_send 'false' — delivery rides the router's content-carrying enqueue", async () => {
    // billing.attempt_failed shares the "Cellexia Payment Failed" metric
    // with the router's payment_failed_1/2/3; a "true" here without content
    // would make an auto-created flow send a BLANK email on ladder days.
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      type: "billing.attempt_failed",
      source: "WEBHOOK",
      payload: { amountCents: 4999 },
    });
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });
});

describe("confirmation events — provenance verdict + content", () => {
  it("a customer portal skip is 'true' and carries the rendered email", async () => {
    await enqueueKlaviyoForEvent(customerSkip);
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("true");
    expect(typeof properties.content_subject).toBe("string");
    expect(String(properties.content_html)).toContain("<table");
    // The skip confirmation's built-in copy renders with the portal link.
    expect(String(properties.content_html)).toContain("https://portal.example/");
    expect(typeof properties.content_text).toBe("string");
  });

  it("merchant-customized copy and the brand kit reach the event content", async () => {
    mocks.emailsSetting.templates.skip_confirmed = {
      enabled: true,
      subject: "Skipped ✔",
      body: "All done, {first_name}.",
      sender: "auto",
    };
    await enqueueKlaviyoForEvent(customerSkip);
    const properties = enqueuedProperties();
    expect(properties.content_subject).toBe("Skipped ✔");
    expect(String(properties.content_html)).toContain("All done, Anna.");
  });

  it("an ADMIN-initiated skip is 'false' with no content", async () => {
    await enqueueKlaviyoForEvent({
      ...customerSkip,
      source: "ADMIN",
      payload: { initiator: "ADMIN" },
    });
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });

  it("a MERGED cancel (consolidation) is 'false' — the customer never left", async () => {
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      type: "contract.cancelled",
      source: "ADMIN",
      payload: { reason: "MERGED", cancelSource: "SYSTEM" },
    });
    expect(enqueuedProperties()[CELLEXIA_SEND_PROPERTY]).toBe("false");
  });

  it("a SYSTEM auto-resume is 'false'", async () => {
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      type: "contract.resumed",
      source: "SCHEDULER",
      payload: {},
    });
    expect(enqueuedProperties()[CELLEXIA_SEND_PROPERTY]).toBe("false");
  });

  it("the in-app 'Send this email' toggle controls the flow: disabled = 'false'", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { enabled: false };
    await enqueueKlaviyoForEvent(customerSkip);
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });

  it("sender 'app' flips to 'false' — the bridge owns delivery, never two emails", async () => {
    mocks.emailsSetting.templates.skip_confirmed = { enabled: true, sender: "app" };
    await enqueueKlaviyoForEvent(customerSkip);
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });

  it("a webhook cancel twin with no payload provenance consults the contract mirror — a merge-cancel can never email", async () => {
    mocks.contractFindUnique.mockResolvedValue({
      ...contractFixture(),
      cancelReason: "MERGED",
      cancelSource: "SYSTEM",
    });
    await enqueueKlaviyoForEvent({
      shopId: "shop_1",
      contractId: "cm_contract_1",
      type: "contract.cancelled",
      source: "WEBHOOK",
      payload: { previousStatus: "ACTIVE", status: "CANCELLED" },
    });
    expect(enqueuedProperties()[CELLEXIA_SEND_PROPERTY]).toBe("false");
  });

  it("a content-render failure flips to 'false' — never an empty email", async () => {
    const settings = await import("~/lib/settings/settings.server");
    // First read (emails, verdict) succeeds; the content-render reads throw.
    (settings.getSetting as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async () => mocks.emailsSetting)
      .mockImplementation(async () => {
        throw new Error("db down");
      });
    await enqueueKlaviyoForEvent(customerSkip);
    const properties = enqueuedProperties();
    expect(properties[CELLEXIA_SEND_PROPERTY]).toBe("false");
    expect(properties.content_html).toBeUndefined();
  });
});
