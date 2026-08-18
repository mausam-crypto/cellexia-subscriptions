import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Single-subscription view (v1.29.0, portal.singleSubscriptionOpensDetail).
 *
 *  1. Pure helper: redirect on exactly one contract (any status), never on
 *     0 / ≥2, never with the setting off, never with ?list=1; the query
 *     string is forwarded (toast / cid / locale / cx_pp) MINUS the Shopify
 *     app-proxy reserved keys (shop / path_prefix / timestamp / signature /
 *     logged_in_customer_id) and the home's one-shot keys (handoff / next).
 *  2. Home loader: the redirect happens AFTER the guard chain (auth, setup
 *     gate, contracts loaded) — a 302 to the detail URL for real sessions and
 *     preview sessions alike; ?list=1 renders the list.
 *  3. Detail loader in single mode: the rewards card (shared builder), the
 *     cancel-intent + newer-card banners above the hero, the back link and
 *     the nav "Subscriptions" tab pointing at /?list=1; multi mode unchanged.
 *  4. Round-trips: card actions and toast Undo on the explicit list return
 *     to `/?list=1` (the API accepts it), and every "not found" redirect
 *     targets the explicit list — never the single detail page.
 */

process.env.APP_SIGNING_SECRET = "test-secret-single-subscription";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  return {
    shop,
    setupMode: { value: false },
    singleSetting: { value: true },
    paymentMethodsList: { value: true },
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    contractCount: vi.fn(async (): Promise<number> => 1),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
    renderIntentBanner: vi.fn(async (): Promise<string> => ""),
    newCardBannerHits: vi.fn(async (): Promise<Map<string, unknown>> => new Map()),
    logEvent: vi.fn(async (): Promise<void> => {}),
    unskipNextCycle: vi.fn(async (): Promise<unknown> => null),
  };
});

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: {
      findFirst: mocks.contractFindFirst,
      findMany: mocks.contractFindMany,
      count: mocks.contractCount,
    },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      count: vi.fn(async (): Promise<number> => 1),
    },
    giftGrant: {
      findFirst: mocks.giftGrantFindFirst,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      count: vi.fn(async (): Promise<number> => 0),
    },
    giftRule: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      count: vi.fn(async (): Promise<number> => 0),
    },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    notificationLog: { findFirst: vi.fn(async (): Promise<unknown> => null) },
  },
}));

vi.mock("~/lib/contracts/service.server", () => ({
  PaymentMethodChangeError: class extends Error {},
  PauseUntilError: class extends Error {},
  SendTomorrowError: class extends Error {},
  CycleLineEditError: class extends Error {},
  unskipNextCycle: mocks.unskipNextCycle,
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
  isSetupMode: vi.fn(async (): Promise<boolean> => mocks.setupMode.value),
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
        contextualPromptBufferDays: 10,
        contextualPromptDelayWeeks: 3,
        friendlyLockMessaging: true,
        dunningBannerEventHours: 6,
        deliveriesProcessingMaxDays: 30,
        deliveriesInTransitMaxDays: 14,
        paymentMethodsList: mocks.paymentMethodsList.value,
        singleSubscriptionOpensDetail: mocks.singleSetting.value,
        pauseExtendChoicesWeeks: [2, 4],
        deliveryInstructionsMaxChars: 250,
      };
    }
    if (key === "lifecycle") {
      return { milestoneGiftCycle: 4, milestoneLadder: [], rewardsUnlockDay: 90 };
    }
    if (key === "portalGrowth") {
      // Roadmap OFF here so the rewards card is the classic strip — the
      // builder's fallback path — which needs only the two mocked reads.
      return { rewardsRoadmap: false, homeValueCard: false };
    }
    if (key === "cancelFlow") {
      return { enabled: true, intentBannerDays: 7, downsizeSaveEnabled: true };
    }
    if (key === "dunning") return { preExpiryNoticeDays: 14 };
    if (key === "pause") return { maxMonths: 3 };
    return {};
  }),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/portal/catalog.server", () => ({
  catalogProduct: vi.fn(() => null),
  discountedCents: vi.fn((cents: number) => cents),
  frequencyOptionsForContract: vi.fn(async () => ({ options: [4], allowChoice: false })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
  ongoingDiscountPctForProduct: vi.fn(async () => null),
}));

vi.mock("~/lib/cancel/intent-banner.server", () => ({
  renderIntentBanner: mocks.renderIntentBanner,
}));

vi.mock("~/lib/dunning/new-method.server", () => ({
  newCardBannerHits: mocks.newCardBannerHits,
}));

vi.mock("~/lib/support/channels.server", () => ({
  getSupportChannels: vi.fn(async () => ({
    hasAny: false,
    email: null,
    whatsapp: null,
    chatUrl: null,
    responseTime: null,
  })),
}));

import { loader as indexLoader } from "~/routes/proxy._index";
import { loader as subscriptionLoader } from "~/routes/proxy.subscription.$id";
import { action as apiAction } from "~/routes/proxy.api.$action";
import { getPortalSession, signValue } from "~/lib/portal/session.server";
import { mintPreviewToken } from "~/lib/portal/previewToken.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
import {
  HOME_LIST_RETURN_TO,
  forwardedSearch,
  homeReturnTo,
  isSingleSubscriptionMode,
  listHref,
  singleSubscriptionRedirectPath,
  wantsList,
} from "~/lib/portal/single-subscription.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CUSTOMER = "gid://shopify/Customer/1";

function proxyUrl(pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${pathname}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "ctr_1",
    shopId: "shop_1",
    customerId: CUSTOMER,
    email: "sub@example.com",
    status: "ACTIVE",
    isDemo: false,
    ownership: "OURS",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    firstChargeAt: new Date("2026-05-01T00:00:00Z"),
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    resumeAt: null,
    cancelScheduledAt: null,
    cancelReason: null,
    currencyCode: "EUR",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 2,
    deliveryPriceCents: 0,
    deliveryAddress: null,
    cardBrand: null,
    cardLast4: null,
    cardExpiryMonth: null,
    cardExpiryYear: null,
    paymentMethodId: null,
    predictedEmptyDate: null,
    lines: [
      {
        id: "line_1",
        productId: "p1",
        variantId: "v1",
        title: "Cellexia Serum",
        variantTitle: "Default Title",
        quantity: 1,
        currentPriceCents: 1000,
        compareAtPriceCents: null,
        isGift: false,
        isOneTimeAddon: false,
        imageUrl: null,
      },
    ],
    ...over,
  };
}

const RAW = "raw-session-token";
const cookieHeaders = { Cookie: `cx_portal=${signValue(RAW)}` };

function realSession() {
  mocks.portalSessionFindUnique.mockResolvedValue({
    id: "ps_1",
    shopId: "shop_1",
    customerId: CUSTOMER,
    email: "sub@example.com",
    isPreview: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
}

function previewToken(): string {
  return mintPreviewToken({
    shopId: "shop_1",
    customerId: CUSTOMER,
    contractId: "ctr_1",
    email: "sub@example.com",
  });
}

async function runIndex(url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return (await indexLoader({
      request: new Request(url, { headers }),
      params: {},
      context: {},
    } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

async function runDetail(url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return (await subscriptionLoader({
      request: new Request(url, { headers }),
      params: { id: "ctr_1" },
      context: {},
    } as never)) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setupMode.value = false;
  mocks.singleSetting.value = true;
  mocks.paymentMethodsList.value = true;
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.contractCount.mockResolvedValue(1);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  mocks.renderIntentBanner.mockResolvedValue("");
  mocks.newCardBannerHits.mockResolvedValue(new Map());
});

// ── 1. Pure helper ───────────────────────────────────────────────────────────

describe("singleSubscriptionRedirectPath (pure)", () => {
  const home = (q = "") => `https://cellexialabs.com${PORTAL_PROXY_BASE}/${q}`;

  it("redirects on exactly one contract, forwarding the portal query but NEVER the proxy-reserved keys", () => {
    const out = singleSubscriptionRedirectPath({
      requestUrl: home(
        "?shop=x.myshopify.com&path_prefix=%2Fapps%2Fcellexia-subs&timestamp=1700000000&signature=abc&logged_in_customer_id=123&toast=skipped&cid=ctr_1&locale=fr&cx_pp=tok",
      ),
      enabled: true,
      contractIds: ["ctr_1"],
    });
    // The 302 is resolved against the storefront and re-proxied: Shopify
    // appends fresh shop / path_prefix / timestamp / signature /
    // logged_in_customer_id, so a forwarded copy would duplicate every one
    // of them (HMAC base divergence ⇒ 400) and leak a signature + customer
    // id into the address bar. Only the portal's own keys travel.
    expect(out).toBe(`${PORTAL_PROXY_BASE}/subscription/ctr_1?toast=skipped&cid=ctr_1&locale=fr&cx_pp=tok`);
    for (const reserved of ["shop", "path_prefix", "timestamp", "signature", "logged_in_customer_id"]) {
      expect(out).not.toContain(`${reserved}=`);
    }
  });

  it("forwardedSearch: drops reserved + one-shot keys, keeps order and repeats, '' when nothing remains", () => {
    expect(forwardedSearch(new URL(home("?shop=x.myshopify.com&signature=s&timestamp=1")))).toBe("");
    expect(forwardedSearch(new URL(home("?handoff=h&next=%2Fsubscription%2Fctr_1&list=1&toast=paused")))).toBe(
      "?toast=paused",
    );
    // Toast extras (undo tokens, reply-promise params, etc.) ride along untouched.
    expect(forwardedSearch(new URL(home("?toast=support_sent&sla=30&slau=m&sla247=1&undo=tok&d1=a&d1=b")))).toBe(
      "?toast=support_sent&sla=30&slau=m&sla247=1&undo=tok&d1=a&d1=b",
    );
    // The redirect for a proxy-only query is the bare detail path.
    expect(
      singleSubscriptionRedirectPath({
        requestUrl: home("?shop=x.myshopify.com&logged_in_customer_id=1"),
        enabled: true,
        contractIds: ["ctr_1"],
      }),
    ).toBe(`${PORTAL_PROXY_BASE}/subscription/ctr_1`);
  });

  it("homeReturnTo: '/?list=1' only when the page is the explicit list", () => {
    expect(HOME_LIST_RETURN_TO).toBe("/?list=1");
    expect(homeReturnTo(new URL(home("?list=1")))).toBe("/?list=1");
    expect(homeReturnTo(new URL(home("?list=1&toast=skipped")))).toBe("/?list=1");
    expect(homeReturnTo(new URL(home("?list=0")))).toBe("/");
    expect(homeReturnTo(new URL(home()))).toBe("/");
  });

  it("no query ⇒ the bare detail path", () => {
    expect(
      singleSubscriptionRedirectPath({ requestUrl: home(), enabled: true, contractIds: ["ctr_9"] }),
    ).toBe(`${PORTAL_PROXY_BASE}/subscription/ctr_9`);
  });

  it("never on 0 or ≥2 contracts, never with the setting off", () => {
    expect(singleSubscriptionRedirectPath({ requestUrl: home(), enabled: true, contractIds: [] })).toBeNull();
    expect(
      singleSubscriptionRedirectPath({ requestUrl: home(), enabled: true, contractIds: ["a", "b"] }),
    ).toBeNull();
    expect(
      singleSubscriptionRedirectPath({ requestUrl: home(), enabled: false, contractIds: ["a"] }),
    ).toBeNull();
  });

  it("?list=1 is the escape hatch (only the exact marker value)", () => {
    expect(
      singleSubscriptionRedirectPath({ requestUrl: home("?list=1"), enabled: true, contractIds: ["a"] }),
    ).toBeNull();
    expect(wantsList(new URL(home("?list=1&toast=paused")))).toBe(true);
    expect(wantsList(new URL(home("?list=0")))).toBe(false);
    expect(wantsList(new URL(home()))).toBe(false);
  });

  it("isSingleSubscriptionMode + listHref (locale + preview token carried)", () => {
    expect(isSingleSubscriptionMode({ enabled: true, contractCount: 1 })).toBe(true);
    expect(isSingleSubscriptionMode({ enabled: true, contractCount: 2 })).toBe(false);
    expect(isSingleSubscriptionMode({ enabled: false, contractCount: 1 })).toBe(false);
    expect(listHref("en", null)).toBe(`${PORTAL_PROXY_BASE}/?list=1`);
    expect(listHref("fr", "tok")).toBe(`${PORTAL_PROXY_BASE}/?list=1&locale=fr&cx_pp=tok`);
  });

  it("the setting exists in the registry (default ON) and on the Settings page", () => {
    const parsed = settingsSchemas.portal.parse(undefined) as { singleSubscriptionOpensDetail: boolean };
    expect(parsed.singleSubscriptionOpensDetail).toBe(true);
    const page = readSource("app/routes/app.settings.tsx");
    expect(page).toContain('path: "singleSubscriptionOpensDetail"');
    expect(page).toContain(
      "When a customer has exactly one subscription, the portal opens it directly instead of the list.",
    );
  });
});

// ── 2. Home loader ───────────────────────────────────────────────────────────

describe("proxy._index — single-subscription redirect", () => {
  it("one ACTIVE contract ⇒ 302 to the detail page, query forwarded (toast + cid) minus the proxy keys", async () => {
    realSession();
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(
      proxyUrl("/", {
        toast: "skipped",
        cid: "ctr_1",
        path_prefix: PORTAL_PROXY_BASE,
        timestamp: "1700000000",
        signature: "deadbeef",
        logged_in_customer_id: "1",
      }),
      cookieHeaders,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location.startsWith(`${PORTAL_PROXY_BASE}/subscription/ctr_1?`)).toBe(true);
    const q = new URL(location, "https://cellexialabs.com").searchParams;
    expect(q.get("toast")).toBe("skipped");
    expect(q.get("cid")).toBe("ctr_1");
    // Shopify re-appends these on the next hop — a stale copy must not travel.
    for (const reserved of ["shop", "path_prefix", "timestamp", "signature", "logged_in_customer_id"]) {
      expect(q.has(reserved), reserved).toBe(false);
    }
    // The visit event was still logged (the redirect sits after the guard chain).
    expect(mocks.logEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "portal.visit" }));
  });

  it("one CANCELLED contract redirects too (the detail page handles every status)", async () => {
    realSession();
    mocks.contractFindMany.mockResolvedValue([contract({ status: "CANCELLED", nextBillingDate: null })]);
    const res = await runIndex(proxyUrl("/"), cookieHeaders);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain(`${PORTAL_PROXY_BASE}/subscription/ctr_1`);
  });

  it("zero contracts ⇒ the empty list (200); two contracts ⇒ the list (200)", async () => {
    realSession();
    mocks.contractFindMany.mockResolvedValue([]);
    let res = await runIndex(proxyUrl("/"), cookieHeaders);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("data-cellexia-portal");

    mocks.contractFindMany.mockResolvedValue([contract(), contract({ id: "ctr_2" })]);
    res = await runIndex(proxyUrl("/"), cookieHeaders);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/subscription/ctr_1"`);
    expect(html).toContain(`/subscription/ctr_2"`);
  });

  it("setting off ⇒ the list renders even with one contract", async () => {
    realSession();
    mocks.singleSetting.value = false;
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(proxyUrl("/"), cookieHeaders);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`/subscription/ctr_1"`);
  });

  it("?list=1 ⇒ the list renders (escape hatch, no loop) and its card actions return to /?list=1", async () => {
    realSession();
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(proxyUrl("/", { list: "1" }), cookieHeaders);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/subscription/ctr_1"`);
    // The escape hatch survives a round-trip: every card form on the
    // explicit list carries return_to=/?list=1 (never a bare "/", which the
    // home would immediately bounce to the detail page).
    expect(html).toContain('name="return_to" value="/?list=1"');
    expect(html).not.toContain('name="return_to" value="/"');
    // The plain home (multi mode) still returns to "/".
    mocks.contractFindMany.mockResolvedValue([contract(), contract({ id: "ctr_2" })]);
    const plain = await (await runIndex(proxyUrl("/"), cookieHeaders)).text();
    expect(plain).toContain('name="return_to" value="/"');
    expect(plain).not.toContain('value="/?list=1"');
  });

  it("toast Undo on the explicit list returns to /?list=1 too", async () => {
    realSession();
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(proxyUrl("/", { list: "1", toast: "skipped", cid: "ctr_1" }), cookieHeaders);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("/api/unskip");
    const undo = html.slice(html.indexOf("/api/unskip"));
    expect(undo).toContain('name="return_to" value="/?list=1"');
  });

  it("preview session (?cx_pp=) follows the redirect too and keeps the token", async () => {
    const token = previewToken();
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(proxyUrl("/", { cx_pp: token }));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain(`${PORTAL_PROXY_BASE}/subscription/ctr_1?`);
    expect(location).toContain(`cx_pp=${encodeURIComponent(token)}`);
  });

  it("the guard chain runs first: sessionless ⇒ login redirect, never the detail page", async () => {
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const res = await runIndex(proxyUrl("/"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/login");
  });

  it("the ?handoff= exchange still lands on the clean home URL — the redirect fires on the next request", () => {
    // Source pin: the hand-off block precedes the single-subscription block,
    // and the block reads the whole query string (toast / undo forwarded).
    const src = readSource("app/routes/proxy._index.tsx");
    const handoff = src.indexOf('requestUrl.searchParams.get("handoff")');
    const single = src.indexOf("singleSubscriptionRedirectPath({");
    const contractsLoaded = src.indexOf("const [contracts, portalSettings, lifecycle, growth, lockRules, dunningSettings]");
    expect(handoff).toBeGreaterThan(0);
    expect(contractsLoaded).toBeGreaterThan(handoff);
    expect(single).toBeGreaterThan(contractsLoaded);
    expect(src).toContain("enabled: portalSettings.singleSubscriptionOpensDetail");
  });
});

// ── 3. Detail loader — single mode ───────────────────────────────────────────

describe("proxy.subscription.$id — single mode", () => {
  it("renders the rewards card, the back link and nav tab to /?list=1", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    mocks.contractCount.mockResolvedValue(1);
    const res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page title stays the subscription title.
    expect(html).toContain("<h1>Your subscription</h1>");
    // Rewards card (the classic strip here — roadmap toggle off in fixtures).
    expect(html).toContain('<section class="cxs-rewards">');
    expect(html).toContain("Days with us");
    // Back link + nav "Subscriptions" tab both carry the escape hatch.
    expect(html).toContain(`<a class="cxs-back" href="${PORTAL_PROXY_BASE}/?list=1">`);
    expect(html).toContain(`<a href="${PORTAL_PROXY_BASE}/?list=1" class="cxs-nav--on" aria-current="page">`);
    // Never a plain "/" link that would bounce through the redirect.
    expect(html).not.toContain(`href="${PORTAL_PROXY_BASE}/"`);
    // The rewards card sits AFTER the hero, not above it.
    expect(html.indexOf('<section class="cxs-rewards">')).toBeGreaterThan(html.indexOf('id="cxs-next"'));
  });

  it("renders the cancel-intent + newer-card banners above the hero (same gates as the home)", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    mocks.renderIntentBanner.mockResolvedValue('<div class="cxs-banner cxs-intent">INTENT</div>');
    mocks.newCardBannerHits.mockResolvedValue(
      new Map([
        [
          "ctr_1",
          {
            paymentMethodId: "gid://shopify/CustomerPaymentMethod/new",
            instrumentType: "CustomerCreditCard",
            cardBrand: "visa",
            cardLast4: "4242",
          },
        ],
      ]),
    );
    const res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    const html = await res.text();
    expect(html).toContain("INTENT");
    expect(html).toContain('class="cxs-banner cxs-newcard"');
    expect(html).toContain("Use it for this subscription");
    expect(html).toContain('href="#cxs-payment"');
    expect(html).toContain('name="paymentMethodId" value="gid://shopify/CustomerPaymentMethod/new"');
    expect(html.indexOf("INTENT")).toBeLessThan(html.indexOf('id="cxs-next"'));
    expect(html.indexOf("cxs-newcard")).toBeLessThan(html.indexOf('id="cxs-next"'));
    // The intent banner got THIS contract, the cancel-flow gate values, and the preparing flag.
    expect(mocks.renderIntentBanner).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "ctr_1" })],
      expect.objectContaining({ bannerDays: 7, downsizeEnabled: true, isPreview: false }),
    );
    expect(mocks.newCardBannerHits).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "ctr_1" })],
      expect.objectContaining({ preExpiryNoticeDays: 14 }),
    );
  });

  it("newer-card banner: never for previews, never with paymentMethodsList off", async () => {
    mocks.contractFindFirst.mockResolvedValue(contract());
    mocks.newCardBannerHits.mockResolvedValue(new Map([["ctr_1", { paymentMethodId: "x" }]]));
    // Preview session.
    const token = previewToken();
    let res = await runDetail(proxyUrl("/subscription/ctr_1", { cx_pp: token }));
    expect((await res.text()).includes("cxs-newcard")).toBe(false);
    expect(mocks.newCardBannerHits).not.toHaveBeenCalled();
    // Real session, list feature off.
    realSession();
    mocks.paymentMethodsList.value = false;
    res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    expect((await res.text()).includes("cxs-newcard")).toBe(false);
    expect(mocks.newCardBannerHits).not.toHaveBeenCalled();
  });

  it("multi mode (2 contracts) or setting off: no rewards card, no banners, plain back link", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    mocks.contractCount.mockResolvedValue(2);
    mocks.renderIntentBanner.mockResolvedValue("INTENT");
    let res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    let html = await res.text();
    expect(html).not.toContain('<section class="cxs-rewards">');
    expect(html).not.toContain("INTENT");
    expect(html).toContain(`<a class="cxs-back" href="${PORTAL_PROXY_BASE}/">`);
    expect(html).toContain(`<a href="${PORTAL_PROXY_BASE}/" class="cxs-nav--on" aria-current="page">`);

    mocks.contractCount.mockClear();
    mocks.contractCount.mockResolvedValue(1);
    mocks.singleSetting.value = false;
    res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    html = await res.text();
    expect(html).not.toContain('<section class="cxs-rewards">');
    expect(html).toContain(`<a class="cxs-back" href="${PORTAL_PROXY_BASE}/">`);
    // The count is not even read when the setting is off.
    expect(mocks.contractCount).not.toHaveBeenCalled();
  });

  it("toasts resolve on the detail page from the forwarded query (?toast=skipped keeps its Undo)", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    const res = await runDetail(proxyUrl("/subscription/ctr_1", { toast: "skipped", cid: "ctr_1" }), cookieHeaders);
    const html = await res.text();
    expect(html).toContain("data-cellexia-toast");
    expect(html).toContain("/api/unskip");
  });

  it("the count is OURS_ONLY-scoped and any-status; the rewards card is the shared builder", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    const block = src.slice(src.indexOf("let singleMode = false;"), src.indexOf("// Catalog + discount map"));
    expect(block).toContain("prisma.subscriptionContract.count({");
    expect(block).toContain("...OURS_ONLY,");
    expect(block).not.toContain("status:");
    expect(src).toContain('from "~/lib/portal/rewards-card.server"');
    expect(src).toContain("contracts: [contract],");
    // Both routes call the same builder — no second roadmap renderer anywhere.
    const home = readSource("app/routes/proxy._index.tsx");
    expect(home).toContain("body += await rewardsSectionHtml({");
    expect(home).not.toContain("function rewardsRoadmapHtml");
    expect(src).not.toContain("function rewardsRoadmapHtml");
  });
});

// ── 4. Round-trips through the API + "not found" targets ────────────────────

describe("explicit list round-trip + not_found targets", () => {
  async function csrf(): Promise<string> {
    const session = await getPortalSession(new Request(proxyUrl("/"), { headers: cookieHeaders }));
    return session?.csrfToken ?? "";
  }

  async function post(action: string, fields: Record<string, string>): Promise<Response> {
    const form = new URLSearchParams({ contractId: "ctr_1", _csrf: await csrf(), ...fields });
    try {
      return (await apiAction({
        request: new Request(proxyUrl(`/api/${action}`), {
          method: "POST",
          headers: { ...cookieHeaders, "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { action },
        context: {},
      } as never)) as Response;
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      throw thrown;
    }
  }

  it("return_to=/?list=1 is accepted by the API and lands on the explicit list with its toast", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    const res = await post("unskip", { return_to: HOME_LIST_RETURN_TO });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, "https://cellexialabs.com");
    expect(location.pathname).toBe(`${PORTAL_PROXY_BASE}/`);
    expect(location.searchParams.get("list")).toBe("1");
    expect(location.searchParams.get("toast")).toBe("unskipped");
    expect(mocks.unskipNextCycle).toHaveBeenCalled();
    // The home then renders the list (no bounce to the detail page).
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const home = await runIndex(location.toString(), cookieHeaders);
    expect(home.status).toBe(200);
  });

  it("any other query-carrying return_to is rejected back to '/'", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(contract());
    for (const bad of ["/?list=2", "/?list=1&x=1", "/subscription/ctr_1?list=1", "//evil", "/account?x"]) {
      const res = await post("unskip", { return_to: bad });
      const location = new URL(res.headers.get("Location")!, "https://cellexialabs.com");
      expect(location.pathname, bad).toBe(`${PORTAL_PROXY_BASE}/`);
      expect(location.searchParams.has("list"), bad).toBe(false);
    }
  });

  it("API not_found ⇒ /?list=1&toast=not_found — never the single detail page", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(null);
    const res = await post("unskip", { return_to: "/" });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, "https://cellexialabs.com");
    expect(location.pathname).toBe(`${PORTAL_PROXY_BASE}/`);
    expect(location.searchParams.get("list")).toBe("1");
    expect(location.searchParams.get("toast")).toBe("not_found");
    // Single mode: the home renders the list with the toast instead of
    // forwarding "not found" onto the customer's one real subscription page.
    mocks.contractFindMany.mockResolvedValue([contract()]);
    const home = await runIndex(location.toString(), cookieHeaders);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("data-cellexia-toast");
  });

  it("detail + restart not_found redirects target /?list=1&toast=not_found", async () => {
    realSession();
    mocks.contractFindFirst.mockResolvedValue(null);
    const res = await runDetail(proxyUrl("/subscription/ctr_1"), cookieHeaders);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location")!, "https://cellexialabs.com");
    expect(location.pathname).toBe(`${PORTAL_PROXY_BASE}/`);
    expect(location.searchParams.get("list")).toBe("1");
    expect(location.searchParams.get("toast")).toBe("not_found");
    // Source pins: the restart page and the API use the same target; no
    // portal redirect emits a bare "/?toast=not_found" any more.
    for (const rel of [
      "app/routes/proxy.subscription.$id.restart.tsx",
      "app/routes/proxy.subscription.$id.tsx",
      "app/routes/proxy.api.$action.tsx",
    ]) {
      const src = readSource(rel);
      expect(src, rel).not.toContain("/?toast=not_found");
      expect(src, rel).toContain("HOME_LIST_RETURN_TO");
    }
  });
});
