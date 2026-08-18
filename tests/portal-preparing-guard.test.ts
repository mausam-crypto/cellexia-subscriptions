import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PREPARING-YOUR-ORDER GUARD (v1.28.0, P2.1)
 *
 * The portal hides skip / delay / next_date / frequency / swap once the
 * cycle's charge moment has passed (or a billing attempt is in flight); the
 * api dispatcher must refuse the same verbs for a stale page or crafted POST
 * — with toast=preparing and NO service call — so the UI state and the
 * dispatcher never disagree. Everything else (pause, additions, recoveries,
 * address, payment) stays available, and a failed attempts read never blocks
 * (contained: isPreparingOrder answers false).
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-preparing-guard";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const DAY_MS = 24 * 3600_000;
const TZ = "Europe/Zurich";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  return {
    shop,
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    attemptFindMany: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (): Promise<void> => {}),
    skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    delayNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    delaySchedule: vi.fn(async (): Promise<unknown> => ({})),
    pauseContract: vi.fn(async (): Promise<unknown> => ({})),
    changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
    setNextBillingDate: vi.fn(async (): Promise<unknown> => ({})),
    swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
    changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
    removeLine: vi.fn(async (): Promise<unknown> => ({})),
    unskipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    addOneTimeAddon: vi.fn(async (): Promise<unknown> => ({ lines: [] })),
    addLine: vi.fn(async (): Promise<unknown> => ({ lines: [] })),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findUnique: mocks.contractFindUnique,
      findMany: mocks.contractFindMany,
    },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      count: mocks.subscriberEventCount,
    },
    billingAttempt: { findMany: mocks.attemptFindMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: {
    public: {
      appProxy: vi.fn(async () => ({
        session: { shop: SHOP_DOMAIN },
        liquid: (body: string, init?: ResponseInit | number) =>
          new Response(
            body,
            typeof init === "number" ? { status: init } : init,
          ),
      })),
    },
  },
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => mocks.shop),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => mocks.shop),
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "portal") {
      return {
        contextualPrompts: false,
        allowAddProducts: true,
        otpCodeTtlMinutes: 10,
        sessionTtlDays: 30,
        mutationsPerHour: 30,
        nextDateMaxDays: 90,
        maxLineQuantity: 20,
        contextualPromptBufferDays: 10,
        contextualPromptDelayWeeks: 3,
        friendlyLockMessaging: false,
        delayReanchors: false,
        magicLinkTtlDays: 14,
      };
    }
    if (key === "pause") return { maxMonths: 3 };
    // Hour 0 + a 72h preparing window: TODAY's charge moment (shop midnight)
    // has passed whenever the suite runs, and stays inside the window.
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 72 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: vi.fn(),
  createSignedPayload: vi.fn(() => "UNDO"),
  verifySignedPayload: vi.fn(() => null),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  addLine: mocks.addLine,
  addOneTimeAddon: mocks.addOneTimeAddon,
  changeFrequency: mocks.changeFrequency,
  changeLineQuantity: mocks.changeLineQuantity,
  delayNextCycle: mocks.delayNextCycle,
  delaySchedule: mocks.delaySchedule,
  pauseContract: mocks.pauseContract,
  removeLine: mocks.removeLine,
  resumeContract: vi.fn(),
  setNextBillingDate: mocks.setNextBillingDate,
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: mocks.swapLineVariant,
  unskipNextCycle: mocks.unskipNextCycle,
  updateDeliveryAddress: vi.fn(),
}));

vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: vi.fn(),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getPaymentMethodUpdateUrl: vi.fn(async (): Promise<string> => "https://x"),
}));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({
    options: [{ unit: "WEEK", count: 4 }],
    allowChoice: true,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession } from "~/lib/portal/session.server";
import { TOAST_KEYS, resolveToast } from "~/lib/portal/layout.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import { shopDayStartUtc } from "~/lib/dates.server";
import en from "~/lib/i18n/locales/en.json";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeContract(nextBillingDate: Date, status = "ACTIVE") {
  return {
    id: "ctr_1",
    lockDays: null,
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status,
    ownership: "OURS",
    isDemo: false,
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate,
    deliveryPriceCents: 0,
    createdAt: new Date(Date.now() - 100 * DAY_MS),
    firstChargeAt: new Date(Date.now() - 100 * DAY_MS),
    ordersCount: 3,
    lines: [
      {
        id: "line_1",
        quantity: 2,
        isGift: false,
        isOneTimeAddon: false,
        sellingPlanId: null,
        productId: "gid://shopify/Product/9",
        variantId: "gid://shopify/ProductVariant/111",
        title: "Serum",
        variantTitle: "Default Title",
        currentPriceCents: 5000,
        compareAtPriceCents: null,
        imageUrl: null,
      },
    ],
  };
}

/** Today's shop-day start: the charge moment (hour 0) has already passed. */
const TODAY = shopDayStartUtc(new Date(), TZ);
const NEXT_WEEK = new Date(Date.now() + 7 * DAY_MS);

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

async function licidCsrf(): Promise<string> {
  const session = await getPortalSession(
    new Request(proxyUrl("/", { logged_in_customer_id: "1" })),
  );
  expect(session?.isPreview).toBe(false);
  return session?.csrfToken ?? "";
}

async function postAction(
  action: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new URLSearchParams({
    contractId: "ctr_1",
    _csrf: await licidCsrf(),
    return_to: "/subscription/ctr_1",
    ...fields,
  });
  return (await apiAction({
    request: new Request(
      proxyUrl(`/api/${action}`, { logged_in_customer_id: "1" }),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    ),
    params: { action },
    context: {},
  } as never)) as Response;
}

function expectToast(response: Response, toast: string): void {
  expect(response.status).toBe(302);
  expect(response.headers.get("Location") ?? "").toContain(`toast=${toast}`);
}

function setContract(contract: unknown) {
  mocks.contractFindFirst.mockResolvedValue(contract);
  mocks.contractFindUnique.mockResolvedValue(contract);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.subscriberEventCount.mockResolvedValue(1);
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
  mocks.attemptFindMany.mockResolvedValue([]);
  setContract(makeContract(TODAY));
});

// ── Dispatcher behaviour ─────────────────────────────────────────────────────

describe("api dispatcher — preparing-your-order guard", () => {
  it.each(["skip", "delay", "next_date", "frequency", "swap"])(
    "refuses %s with toast=preparing and no service call once the charge moment has passed",
    async (verb) => {
      const response = await postAction(verb, {
        weeks: "1",
        date: "2099-01-01",
        every: "4:WEEK",
        lineId: "line_1",
        variantId: "gid://shopify/ProductVariant/222",
      });
      expectToast(response, "preparing");
      expect(mocks.skipNextCycle).not.toHaveBeenCalled();
      expect(mocks.delayNextCycle).not.toHaveBeenCalled();
      expect(mocks.delaySchedule).not.toHaveBeenCalled();
      expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
      expect(mocks.changeFrequency).not.toHaveBeenCalled();
      expect(mocks.swapLineVariant).not.toHaveBeenCalled();
    },
  );

  it("refuses skip while a billing attempt is in flight even if the date is ahead", async () => {
    setContract(makeContract(NEXT_WEEK));
    mocks.attemptFindMany.mockResolvedValue([
      {
        status: "PENDING",
        originatingAction: "SCHEDULER",
        startedAt: new Date(),
        scheduledFor: new Date(),
        supersededAt: null,
      },
    ]);
    const response = await postAction("skip");
    expectToast(response, "preparing");
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });

  it("executes skip when the next order is still ahead of its charge moment", async () => {
    setContract(makeContract(NEXT_WEEK));
    const response = await postAction("skip");
    expectToast(response, "skipped");
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });

  it("does not block pause (or other non-schedule verbs) while preparing", async () => {
    const response = await postAction("pause", { months: "1" });
    expect(response.headers.get("Location") ?? "").not.toContain(
      "toast=preparing",
    );
    expect(mocks.pauseContract).toHaveBeenCalledTimes(1);
  });

  it("dunning owns a FAILED cycle — the guard does not fire (payment surfaces speak)", async () => {
    mocks.attemptFindMany.mockResolvedValue([
      {
        status: "FAILED",
        originatingAction: "SCHEDULER",
        startedAt: new Date(),
        scheduledFor: TODAY,
        supersededAt: null,
      },
    ]);
    const response = await postAction("skip");
    expect(response.headers.get("Location") ?? "").not.toContain(
      "toast=preparing",
    );
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });

  it("is contained: a failed attempts read never blocks the action", async () => {
    mocks.attemptFindMany.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await postAction("skip");
    spy.mockRestore();
    expectToast(response, "skipped");
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
  });
});

// ── Toast + copy ─────────────────────────────────────────────────────────────

describe("preparing toast", () => {
  it("is a rendered toast key with English copy that never names cancellation", () => {
    expect(TOAST_KEYS.has("preparing")).toBe(true);
    const copy = (en as Record<string, string>)["portal.toast.preparing"];
    expect(copy).toBeTruthy();
    expect(copy.toLowerCase()).not.toMatch(/cancel/);
    const resolved = resolveToast(
      new Request("https://cellexialabs.com/apps/x/?toast=preparing"),
      "en",
    );
    expect(resolved?.toast.text).toBe(copy);
  });

  it("source pin: the dispatcher's preparing set is exactly the verbs the portal hides", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    const block = src.slice(
      src.indexOf("const PREPARING_BLOCKED"),
      src.indexOf('return back("preparing")'),
    );
    for (const verb of ["skip", "delay", "frequency", "next_date", "swap", "undo"]) {
      expect(block).toContain(`"${verb}"`);
    }
    expect(block).not.toContain('"pause"');
    expect(block).not.toContain('"unskip"');
    expect(block).toContain("isPreparingOrder(contract, timing)");
  });
});
