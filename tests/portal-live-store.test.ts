import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * The portal on a LIVE store (v1.7.0), where Shopify's app proxy strips
 * Cookie/Set-Cookie in both directions — every session must ride the signed
 * query string. Covers the three route-level contracts:
 *
 *  1. proxy.login: an expired ?cx_pp= names itself (never the generic setup
 *     gate); ?signin=expired names a dead hand-off; the cookie-dependent OTP
 *     flow is hidden unless PORTAL_COOKIE_DEV=1, replaced by the storefront
 *     sign-in CTA (/account/login?return_url=…).
 *  2. proxy._index: a valid ?cx_pp= bypasses the setup gate (preview
 *     sessions render the real portal); a dead hand-off redirects to
 *     ?signin=expired instead of silently gating.
 *  3. proxy.api: a cx_pp session is read-only — the mutation is intercepted,
 *     nothing executes, and the bounce-back redirect keeps the token (the
 *     token in the URL IS the session).
 *  4. Sessionless bounces KEEP the request's cx_pp: the portal home is the
 *     exact URL the admin preview mints, so an expired token lands there
 *     first — the redirect to /login must carry the token or the login page
 *     can never name the expiry (proxy._index, proxy.api).
 *  5. Sign-out for a storefront-login (logged_in_customer_id) session goes
 *     through Shopify's /account/logout — the store account is the only
 *     credential, so the app's own POST /logout would sign nobody out.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-live-store";

const SHOP_DOMAIN = "cellexia.myshopify.com";

const mocks = vi.hoisted(() => {
  const shop = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "cellexialabs.com",
    ianaTimezone: "Europe/Zurich",
  };
  return {
    shop,
    setupMode: { value: true },
    shopFindUnique: vi.fn(async (): Promise<unknown> => ({ id: shop.id })),
    portalSessionFindUnique: vi.fn(async (): Promise<unknown> => null),
    contractFindFirst: vi.fn(async (): Promise<unknown> => null),
    contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
    subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
    subscriberEventCount: vi.fn(async (): Promise<number> => 1),
    giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
    logEvent: vi.fn(async (): Promise<void> => {}),
    skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    verifyAndConsumeMagicToken: vi.fn(
      async (): Promise<unknown> => ({ ok: false, reason: "UNKNOWN" }),
    ),
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
    },
    giftGrant: { findFirst: mocks.giftGrantFindFirst },
    // Plan lock window (v1.13.0): portal loaders resolve lock rules; no plan
    // sets lockDays in these fixtures.
    sellingPlanConfig: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
  },
}));

// Liquid seam: authenticate.public.appProxy returns a `liquid` that our
// routes call with the rendered fragment — a plain Response captures it.
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
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: vi.fn(async (): Promise<boolean> => mocks.setupMode.value),
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
      };
    }
    if (key === "lifecycle") {
      return { milestoneGiftCycle: 4, rewardsUnlockDay: 90 };
    }
    if (key === "pause") {
      return { maxMonths: 3 };
    }
    return {};
  }),
}));

vi.mock("~/lib/portal/otp.server", () => ({
  requestOtp: vi.fn(async (): Promise<unknown> => ({ ok: true, ttlMinutes: 10 })),
  verifyOtp: vi.fn(async (): Promise<unknown> => ({ ok: false })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/crypto/tokens.server", () => ({
  sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
  createMagicToken: vi.fn(async (): Promise<string> => "TOK"),
  verifyAndConsumeMagicToken: mocks.verifyAndConsumeMagicToken,
}));

vi.mock("~/lib/contracts/service.server", () => ({
  addLine: vi.fn(),
  addOneTimeAddon: vi.fn(),
  changeFrequency: vi.fn(),
  changeLineQuantity: vi.fn(),
  delayNextCycle: vi.fn(),
  pauseContract: vi.fn(),
  removeLine: vi.fn(),
  resumeContract: vi.fn(),
  setNextBillingDate: vi.fn(),
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: vi.fn(),
  unskipNextCycle: vi.fn(),
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
    options: [4],
    allowChoice: false,
  })),
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(async () => new Map()),
}));

import { loader as loginLoader } from "~/routes/proxy.login";
import { loader as indexLoader } from "~/routes/proxy._index";
import { loader as subscriptionLoader } from "~/routes/proxy.subscription.$id";
import { loader as accountLoader } from "~/routes/proxy.account";
import { action as apiAction } from "~/routes/proxy.api.$action";
import { action as logoutAction } from "~/routes/proxy.logout";
import { getPortalSession, signValue } from "~/lib/portal/session.server";
import { mintPreviewToken } from "~/lib/portal/previewToken.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

function proxyUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}${path}`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

function mintValidToken(): string {
  return mintPreviewToken({
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    contractId: "ctr_1",
    email: "sub@example.com",
  });
}

async function loaderResponse(result: unknown): Promise<Response> {
  return result as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.setupMode.value = true;
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.verifyAndConsumeMagicToken.mockResolvedValue({
    ok: false,
    reason: "UNKNOWN",
  });
});

// ── 1. Login page on a live store ────────────────────────────────────────────

describe("proxy.login on a live store", () => {
  it("names an expired ?cx_pp= preview link — never the setup gate", async () => {
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(proxyUrl("/login", { cx_pp: "expired.garbage" })),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("This preview link has expired");
    expect(html).toContain("Reopen the preview from the Cellexia admin");
    // The dead-end this release removes: the generic setup-gate copy.
    expect(html).not.toContain("finishing touches");
  });

  it("shows the storefront sign-in CTA by default and hides the OTP form", async () => {
    mocks.setupMode.value = false;
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(proxyUrl("/login")),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("/account/login?return_url=");
    expect(html).toContain("Sign in with your store account");
    // No cookie-dependent OTP email form on a live store.
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("Send me a code");
  });

  it("shows the OTP form again under PORTAL_COOKIE_DEV=1 (local harness)", async () => {
    process.env.PORTAL_COOKIE_DEV = "1";
    mocks.setupMode.value = false;
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(proxyUrl("/login")),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("Send me a code");
    expect(html).toContain('name="email"');
    // The storefront CTA stays available too.
    expect(html).toContain("/account/login?return_url=");
  });

  it("names an expired sign-in hand-off (?signin=expired)", async () => {
    mocks.setupMode.value = false;
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(proxyUrl("/login", { signin: "expired" })),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("That sign-in link has expired");
  });

  it("still gates the plain login page while in setup mode", async () => {
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(proxyUrl("/login")),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("finishing touches");
  });
});

// ── 2. Portal home: setup-gate bypass + dead hand-off ───────────────────────

describe("proxy._index with a valid ?cx_pp=", () => {
  it("bypasses the setup gate and renders the preview portal", async () => {
    const token = mintValidToken();
    const response = await loaderResponse(
      await indexLoader({
        request: new Request(proxyUrl("/", { cx_pp: token })),
        params: {},
        context: {},
      } as never),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("finishing touches");
    expect(html).toContain("data-cellexia-portal");
    // Preview banner + nav links keep the token.
    expect(html).toContain("Preview mode");
    expect(html).toContain(`cx_pp=${encodeURIComponent(token)}`);
  });
});

describe("proxy.subscription.$id with a valid ?cx_pp=", () => {
  it("bypasses the setup gate and threads the token through page links", async () => {
    const token = mintValidToken();
    mocks.contractFindFirst.mockResolvedValue({
      id: "ctr_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      status: "ACTIVE",
      nextBillingDate: new Date("2026-09-01T00:00:00Z"),
      resumeAt: null,
      currencyCode: "GBP",
      intervalWeeks: 4,
      deliveryPriceCents: 0,
      deliveryAddress: null,
      cardBrand: null,
      cardLast4: null,
      cardExpiryMonth: null,
      cardExpiryYear: null,
      paymentMethodId: null,
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
    });

    const response = await loaderResponse(
      await subscriptionLoader({
        request: new Request(proxyUrl("/subscription/ctr_1", { cx_pp: token })),
        params: { id: "ctr_1" },
        context: {},
      } as never),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("finishing touches");
    expect(html).toContain("Preview mode");
    // Form actions / links on the page keep the token — the token IS the
    // session, so a single dropped link dead-ends the preview.
    expect(html).toContain(
      `/api/skip?cx_pp=${encodeURIComponent(token)}`,
    );
  });
});

describe("proxy._index hand-off failure", () => {
  it("redirects a dead ?handoff= to the login page with ?signin=expired", async () => {
    let thrown: unknown;
    try {
      await indexLoader({
        request: new Request(proxyUrl("/", { handoff: "DEAD_CODE" })),
        params: {},
        context: {},
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain(`${PORTAL_PROXY_BASE}/login`);
    expect(location).toContain("signin=expired");
  });

  it("keeps a straggler cx_pp riding a dead hand-off (pre-1.7.0 links)", async () => {
    const token = mintValidToken();
    let thrown: unknown;
    try {
      await indexLoader({
        request: new Request(
          proxyUrl("/", { handoff: "DEAD_CODE", cx_pp: token }),
        ),
        params: {},
        context: {},
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).not.toContain("login");
    expect(location).toContain(`cx_pp=${encodeURIComponent(token)}`);
  });
});

// ── 3. Mutation interception for cx_pp sessions ──────────────────────────────

describe("proxy.api with a cx_pp session", () => {
  it("intercepts the mutation and bounces back with the token intact", async () => {
    const token = mintValidToken();
    // Fetch the session's CSRF token exactly as a rendered page would embed it.
    const session = await getPortalSession(
      new Request(proxyUrl("/", { cx_pp: token })),
    );
    expect(session?.isPreview).toBe(true);

    const form = new URLSearchParams({
      contractId: "ctr_1",
      _csrf: session?.csrfToken ?? "",
      return_to: "/",
    });
    const response = await loaderResponse(
      await apiAction({
        request: new Request(proxyUrl("/api/skip", { cx_pp: token }), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { action: "skip" },
        context: {},
      } as never),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("toast=preview_blocked");
    expect(location).toContain(`cx_pp=${encodeURIComponent(token)}`);
    // Nothing executed, nothing reached Shopify.
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });
});

// ── 4. Sessionless bounces keep the (expired) cx_pp ─────────────────────────

function mintExpiredToken(): string {
  return mintPreviewToken(
    {
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      contractId: "ctr_1",
      email: "sub@example.com",
    },
    -10,
  );
}

async function catchRedirect(promise: Promise<unknown>): Promise<Response> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Response);
  return thrown as Response;
}

describe("proxy._index with an expired ?cx_pp=", () => {
  it("redirects to login KEEPING the token, and the login page names the expiry", async () => {
    // The portal home is the EXACT URL app.preview mints — the most common
    // expiry scenario is the admin reopening a >1h-old preview link there.
    const expired = mintExpiredToken();
    const redirected = await catchRedirect(
      indexLoader({
        request: new Request(proxyUrl("/", { cx_pp: expired })),
        params: {},
        context: {},
      } as never),
    );
    const location = redirected.headers.get("Location") ?? "";
    expect(location).toContain(`${PORTAL_PROXY_BASE}/login`);
    expect(location).toContain(`cx_pp=${encodeURIComponent(expired)}`);

    // Follow the redirect exactly as the browser + proxy would (Shopify
    // re-appends ?shop= to the proxied request).
    const followed = new URL(location, "https://cellexialabs.com");
    followed.searchParams.set("shop", SHOP_DOMAIN);
    const response = await loaderResponse(
      await loginLoader({
        request: new Request(followed.toString()),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain("This preview link has expired");
    // The dead-end this release removes: the generic setup-gate copy.
    expect(html).not.toContain("finishing touches");
  });
});

describe("proxy.api with an expired ?cx_pp=", () => {
  it("bounces a mid-preview POST to login with the token intact", async () => {
    const expired = mintExpiredToken();
    const form = new URLSearchParams({ contractId: "ctr_1", return_to: "/" });
    const redirected = await catchRedirect(
      apiAction({
        request: new Request(proxyUrl("/api/skip", { cx_pp: expired }), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: { action: "skip" },
        context: {},
      } as never),
    );
    const location = redirected.headers.get("Location") ?? "";
    expect(location).toContain(`${PORTAL_PROXY_BASE}/login`);
    expect(location).toContain(`cx_pp=${encodeURIComponent(expired)}`);
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });
});

// ── 5. Sign-out for a storefront-login (logged_in_customer_id) session ──────

describe("sign-out with a storefront-login session", () => {
  it("renders Shopify's /account/logout link instead of the dead POST form", async () => {
    mocks.setupMode.value = false;
    const response = await loaderResponse(
      await accountLoader({
        request: new Request(
          proxyUrl("/account", { logged_in_customer_id: "7777" }),
        ),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    // The store account IS the session: only Shopify's own logout ends it.
    expect(html).toContain('href="/account/logout"');
    expect(html).not.toContain(`action="${PORTAL_PROXY_BASE}/logout"`);
  });

  it("keeps the app's POST /logout form for cookie sessions (dev harness)", async () => {
    mocks.setupMode.value = false;
    const rawToken = "raw-session-token";
    mocks.portalSessionFindUnique.mockResolvedValue({
      id: "ps_1",
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
      isPreview: false,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const response = await loaderResponse(
      await accountLoader({
        request: new Request(proxyUrl("/account"), {
          headers: { Cookie: `cx_portal=${signValue(rawToken)}` },
        }),
        params: {},
        context: {},
      } as never),
    );
    const html = await response.text();
    expect(html).toContain(`action="${PORTAL_PROXY_BASE}/logout"`);
    expect(html).not.toContain('href="/account/logout"');
  });

  it("POST /logout with logged_in_customer_id hands off to Shopify's logout", async () => {
    // A stale/cached account page can still POST the old form; the action
    // itself must not bounce the customer straight back into a session.
    const response = await loaderResponse(
      await logoutAction({
        request: new Request(
          proxyUrl("/logout", { logged_in_customer_id: "7777" }),
          { method: "POST" },
        ),
        params: {},
        context: {},
      } as never),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/account/logout");
  });
});
