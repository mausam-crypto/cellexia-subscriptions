import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE FIXTURE THAT GOT A CARD-EXPIRY WARNING — demo contracts vs sweeps.
 *
 * The portal-preview demo contract (portal/demo.server.ts) is deliberately
 * plausible: ACTIVE, ownership OURS, a visa •••• 4242 expiring 12/{Y+1}, and
 * email preview@cellexia-demo.invalid. `isDemo` is the ONLY thing keeping it
 * out of billing / notifications / analytics — every consumer is supposed to
 * filter on `isDemo: false`.
 *
 * The defect: runPreExpiryNotices was the one contract sweep without that
 * filter (OURS_ONLY + ACTIVE + card expiry set matched the fixture), and
 * sendNotification had an ownership gate but no demo gate. Come December of
 * the following year the sweep entered the fixture's notice window, built an
 * update-card magic link for a fake contract, enqueued a "Cellexia Card
 * Expiring" Klaviyo event carrying full fake profile attributes for the
 * .invalid address (a bogus profile in the merchant's Active Subscribers
 * segments plus a guaranteed bounce), wrote a SENT NotificationLog row, and
 * logged dunning.card_expiring_notice — recurring for every new expiry
 * window as long as the demo row exists.
 *
 * Two layers, mirroring tests/ownership-enforcement.test.ts:
 *  1. Behavioural — sendNotification now suppresses any customer-facing
 *     template for a demo contract (reason "demo_contract"), so no FUTURE
 *     sweep can repeat the mistake even if it forgets its filter.
 *  2. Static — the pre-expiry sweep's own query carries isDemo: false, the
 *     same defense every other sweep has.
 */

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  shopFindUnique: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({
      id: "shop_1",
      ianaTimezone: "Europe/London",
      contactEmail: "merchant@example.com",
    }),
  ),
  notificationLogCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  notificationLogFindFirst: vi.fn(async (): Promise<unknown> => null),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  enqueue: vi.fn(async (): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return {
        channels: { email: true, sms: true },
        upcomingOrderDaysBefore: 3,
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
      };
    }
    if (key === "alerts") return { emailTo: ["merchant@example.com"] };
    return {};
  }),
  sendEmail: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://example.test/portal"),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUnique: mocks.shopFindUnique },
    notificationLog: {
      create: mocks.notificationLogCreate,
      findFirst: mocks.notificationLogFindFirst,
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/klaviyo/outbox.server", () => ({ enqueue: mocks.enqueue }));
// The demo gate is what's under test — pin the Klaviyo key as present so the
// vacuity guard's happy path exercises the outbox, not the SMTP fallback
// (which has its own suite: tests/klaviyo-unconfigured-fallback.test.ts).
vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: () => true,
}));
vi.mock("~/lib/launch/launch.server", () => ({ isSetupMode: mocks.isSetupMode }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/notifications/mailer.server", () => ({ sendEmail: mocks.sendEmail }));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildActionLinkBundle: mocks.buildActionLinkBundle,
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

import { sendNotification } from "~/lib/notifications/send.server";

/** The demo fixture's shape, faithful to portal/demo.server.ts. */
function demoContract(overrides: Record<string, unknown> = {}) {
  return {
    id: "cm_demo_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/demo-0001",
    customerId: "gid://shopify/Customer/demo-0001",
    email: "preview@cellexia-demo.invalid",
    phone: null,
    firstName: "Alex",
    lastName: "Morgan",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: true,
    locale: "en",
    currencyCode: "GBP",
    intervalWeeks: 8,
    nextBillingDate: new Date("2026-09-01T09:00:00Z"),
    ordersCount: 3,
    isPrepaid: false,
    deliveryPriceCents: 0,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 12,
    cardExpiryYear: 2027,
    churnRiskScore: 0.1,
    cancelReason: null,
    cancelledAt: null,
    predictedEmptyDate: null,
    lines: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupMode.mockResolvedValue(false);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
});

describe("sendNotification demo gate", () => {
  it("suppresses a customer template for the demo fixture with reason demo_contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(demoContract());

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_demo_1",
      template: "card_expiring",
      vars: {
        card_brand: "visa",
        card_last4: "4242",
        expiry: "12/2027",
        dedupe_key: "card_expiring:4242:202712",
      },
    });

    expect(result.status).toBe("SUPPRESSED");
    // Nothing left the building: no Klaviyo event (no bogus profile in the
    // merchant's segments), no direct email (no guaranteed bounce).
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    // And no magic link was minted for a fake contract.
    expect(mocks.buildActionLinkBundle).not.toHaveBeenCalled();

    const logged = mocks.notificationLogCreate.mock.calls[0]?.[0] as {
      data: { status: string; payload: { reason?: string } };
    };
    expect(logged.data.status).toBe("SUPPRESSED");
    expect(logged.data.payload.reason).toBe("demo_contract");
  });

  it("VACUITY GUARD: the identical contract without isDemo sends normally", async () => {
    // The gate must cost a real subscriber nothing — same card, same window,
    // isDemo false.
    mocks.contractFindUnique.mockResolvedValue(
      demoContract({ isDemo: false, email: "anna@example.com" }),
    );

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_demo_1",
      template: "card_expiring",
      vars: { card_last4: "4242", expiry: "12/2027" },
    });

    expect(result.status).not.toBe("SUPPRESSED");
    expect(mocks.enqueue).toHaveBeenCalled();
  });

  it("still delivers merchant-facing templates that reference the demo contract", async () => {
    // admin_alert goes to the MERCHANT — e.g. an alert ABOUT the demo fixture
    // must not be swallowed by the gate that protects the fixture's address.
    mocks.contractFindUnique.mockResolvedValue(demoContract());

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "cm_demo_1",
      template: "admin_alert",
      vars: { message: "something about the preview fixture" },
    });

    expect(result.status).not.toBe("SUPPRESSED");
  });
});

// ── Static: the pre-expiry sweep's own filter ────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("runPreExpiryNotices contract query", () => {
  it("filters on OURS_ONLY AND isDemo: false — like every other sweep", () => {
    const source = stripComments(
      fs.readFileSync(
        path.join(ROOT, "app/lib/dunning/engine.server.ts"),
        "utf8",
      ),
    );
    const fn = source.slice(source.indexOf("export async function runPreExpiryNotices"));
    const query = fn.slice(fn.indexOf("prisma.subscriptionContract.findMany"));
    const whereBlock = query.slice(0, query.indexOf("include:"));
    expect(whereBlock).toContain("OURS_ONLY");
    expect(whereBlock).toContain("isDemo: false");
    // v1.28.0: PAUSED contracts join the sweep (a card expiring before
    // resumeAt would fail the first resumed charge) — the resumeAt gate lives
    // in the loop, pinned by tests/dunning-preexpiry-paused.test.ts.
    expect(whereBlock).toContain('status: { in: ["ACTIVE", "PAUSED"] }');
  });
});
