import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduled cancel — the portal DOOR (v1.28.0, P3.8 review fix).
 *
 * The scheduled-cancel path (requireCancelContext lets locked contracts in,
 * the confirm step schedules) is only honest if a locked subscriber can
 * REACH it. This file renders the real subscription detail loader for a
 * contract inside its plan lock window and pins:
 *
 *  1. cancelFlow.scheduledCancelEnabled ON (default): the "I'd like to
 *     cancel" link to /cancel/:id is on the page and the classic lock notice
 *     says the cancellation can be SCHEDULED for the unlock day (never
 *     "cancellation will be available on {date}").
 *  2. Toggle OFF: the pre-v1.28.0 behaviour — no cancel link, classic notice
 *     (requireCancelContext redirects a hand-typed URL the same way).
 *  3. Unlocked contracts keep the link either way; the friendly welcome card
 *     never claims cancellation is unavailable.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-scheduled-entry";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const PLAN_GID = "gid://shopify/SellingPlan/42";
const DAY_MS = 86_400_000;
const NOW = new Date();

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
    currencyCode: "CHF",
  };
  return {
    shop,
    scheduledCancelEnabled: { value: true },
    friendlyLock: { value: false },
    lockRules: [] as unknown[],
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    logEvent: vi.fn(async (): Promise<void> => {}),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findMany: mocks.contractFindMany,
    },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => mocks.lockRules) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    dunningCase: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    public: {
      appProxy: vi.fn(async () => ({
        session: { shop: SHOP_DOMAIN },
        liquid: (body: string, init?: ResponseInit | number) =>
          new Response(body, typeof init === "number" ? { status: init } : init),
      })),
    },
  },
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => mocks.shop),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") {
      return {
        contextualPrompts: false,
        allowAddProducts: false,
        otpCodeTtlMinutes: 10,
        sessionTtlDays: 30,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
        perLineCycleEdits: false,
        friendlyLockMessaging: mocks.friendlyLock.value,
      };
    }
    if (key === "lifecycle") return { milestoneGiftCycle: 4, rewardsUnlockDay: 90 };
    if (key === "pause") return { maxMonths: 3 };
    if (key === "portalGrowth") {
      return {
        homeValueCard: false,
        addonUpsell: false,
        postActionUpsell: false,
        concessionLadder: false,
        cadenceNudge: false,
        runoutPrompt: false,
        supplyMeter: false,
      };
    }
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    if (key === "dunning") return { preExpiryNoticeDays: 14, customerRetryCooldownMinutes: 30 };
    if (key === "cancelFlow") return { scheduledCancelEnabled: mocks.scheduledCancelEnabled.value };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: vi.fn(() => "UNDOTOKEN"),
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: false,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

vi.mock("~/lib/graphql/paymentMethods.server", () => ({
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
}));

import { loader as subscriptionLoader } from "~/routes/proxy.subscription.$id";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { t } from "~/lib/i18n/i18n.server";

function proxyUrl(pathname: string): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  url.searchParams.set("logged_in_customer_id", "1");
  return url.toString();
}

function makeContract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    // Terms as subscribed under: a 30-day plan lock, day 5 today.
    lockDays: 30,
    nextBillingDate: new Date(NOW.getTime() + 12 * DAY_MS),
    resumeAt: null,
    pausedAt: null,
    pausedReason: null,
    predictedEmptyDate: null,
    deliveryInstructions: null,
    cancelScheduledAt: null,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    deliveryPriceCents: 0,
    deliveryAddress: null,
    cardBrand: null,
    cardLast4: null,
    cardExpiryMonth: null,
    cardExpiryYear: null,
    paymentMethodId: null,
    ordersCount: 1,
    createdAt: new Date(NOW.getTime() - 5 * DAY_MS),
    firstChargeAt: new Date(NOW.getTime() - 5 * DAY_MS),
    lines: [
      {
        id: "line_1",
        productId: "p1",
        variantId: "v1",
        sellingPlanId: PLAN_GID,
        title: "Cellexia Serum",
        variantTitle: "Default Title",
        quantity: 1,
        currentPriceCents: 1000,
        compareAtPriceCents: null,
        isGift: false,
        isOneTimeAddon: false,
        imageUrl: null,
        skippedCycleIndex: null,
        cycleQuantityOverride: null,
        cycleQuantityOverrideIndex: null,
      },
    ],
    ...over,
  };
}

async function renderDetail(contract: unknown): Promise<string> {
  mocks.contractFindFirst.mockResolvedValue(contract);
  const response = (await subscriptionLoader({
    request: new Request(proxyUrl("/subscription/ctr_1")),
    params: { id: "ctr_1" },
    context: {},
  } as never)) as Response;
  expect(response.status).toBe(200);
  return response.text();
}

const CANCEL_HREF = `${PORTAL_PROXY_BASE}/cancel/ctr_1`;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.scheduledCancelEnabled.value = true;
  mocks.friendlyLock.value = false;
  mocks.lockRules = [{ lockDays: 30, shopifyPlanIds: [PLAN_GID] }];
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
});

describe("subscription page — cancel entry inside the plan lock window (P3.8)", () => {
  it("scheduledCancelEnabled ON (default): the cancel link is on the page and the notice offers to schedule the cancellation", async () => {
    const html = await renderDetail(makeContract());
    // Locked indeed: schedule + pause controls hidden.
    expect(html).not.toContain("/api/skip");
    expect(html).not.toContain("/api/pause");
    // …but the door to the cancel flow stays open.
    expect(html).toContain(`href="${CANCEL_HREF}"`);
    // Classic notice: schedule-aware wording carrying the exact unlock day,
    // never "cancellation … available on".
    const unlockDate = new Intl.DateTimeFormat("en", {
      dateStyle: "long",
      timeZone: "Europe/Zurich",
    }).format(new Date(NOW.getTime() + 25 * DAY_MS));
    expect(html).toContain(`plan changes will be available on ${unlockDate}`);
    expect(html).toContain("schedule your cancellation for that day");
    expect(html).not.toContain("cancellation will be available on");
  });

  it("scheduledCancelEnabled OFF: the pre-v1.28.0 door — no cancel link, classic notice", async () => {
    mocks.scheduledCancelEnabled.value = false;
    const html = await renderDetail(makeContract());
    expect(html).not.toContain(`href="${CANCEL_HREF}"`);
    expect(html).toContain("cancellation will be available on");
    expect(html).not.toContain("schedule your cancellation");
  });

  it("the friendly welcome card never claims cancellation is unavailable, and keeps the link with the toggle ON", async () => {
    mocks.friendlyLock.value = true;
    const html = await renderDetail(makeContract());
    expect(html).toContain(t("en", "portal.locked.friendly_title"));
    expect(html).not.toContain("cancellation will be available");
    expect(html).toContain(`href="${CANCEL_HREF}"`);
    mocks.scheduledCancelEnabled.value = false;
    const off = await renderDetail(makeContract());
    expect(off).not.toContain(`href="${CANCEL_HREF}"`);
  });

  it("an unlocked contract keeps the cancel link whatever the toggle says (no lock notice at all)", async () => {
    mocks.scheduledCancelEnabled.value = false;
    const html = await renderDetail(
      makeContract({
        createdAt: new Date(NOW.getTime() - 100 * DAY_MS),
        firstChargeAt: new Date(NOW.getTime() - 100 * DAY_MS),
      }),
    );
    expect(html).toContain(`href="${CANCEL_HREF}"`);
    expect(html).not.toContain(t("en", "portal.locked.friendly_title"));
    expect(html).not.toContain("minimum commitment period");
  });
});
