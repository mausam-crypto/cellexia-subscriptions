import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * The portal preview's three gate dead-ends (v1.9.0). "Preview with a demo
 * subscription" mints a valid 1-hour ?cx_pp= link, yet real clicks still
 * landed on the generic "finishing touches" setup gate through three paths
 * the happy-path suite (portal-live-store.test.ts) never walked:
 *
 *  1. COOKIE SHADOWING (dev harness): getPortalSession checked the cx_portal
 *     cookie before the preview token, so a stale non-preview cookie session
 *     from an earlier OTP login swallowed the click and hit the gate. A VALID
 *     ?cx_pp= now outranks the cookie; an invalid one still falls through.
 *  2. STOREFRONT-LOGIN FALL-THROUGH: an expired/tampered token on a browser
 *     signed into the store account fell through to a logged_in_customer_id
 *     session — non-preview — and every gate site except /login rendered the
 *     nameless gate. closedPortalPage now applies the login page's rule
 *     everywhere: a gated request carrying ?cx_pp= gets the named
 *     "preview link expired" page.
 *  3. DROPPED QUERY STRING (storefront password page redirect): the token
 *     never arrived at all. The gate page — sessionless by construction, and
 *     only ever rendered while the store is dark — now retries ONCE with the
 *     sessionStorage-saved token a previous preview render stored.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-preview-gate";

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
  skipNextCycle: vi.fn(),
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

import { loader as indexLoader } from "~/routes/proxy._index";
import { loader as accountLoader } from "~/routes/proxy.account";
import { loader as subscriptionLoader } from "~/routes/proxy.subscription.$id";
import { getPortalSession, signValue } from "~/lib/portal/session.server";
import { mintPreviewToken } from "~/lib/portal/previewToken.server";
import {
  closedPortalPage,
  previewExpiredPage,
  setupGatePage,
} from "~/lib/portal/layout.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

const GATE_COPY = "finishing touches";
const EXPIRED_COPY = "Preview links stay valid";

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
    customerId: "gid://cellexia/demo/customer/abc",
    contractId: "ctr_demo",
    email: "preview@cellexia-demo.invalid",
  });
}

/** Request whose browser holds a signed cx_portal cookie for RAW_COOKIE_TOKEN. */
const RAW_COOKIE_TOKEN = "stale-dev-harness-session-token";

function cookieRequest(url: string): Request {
  return new Request(url, {
    headers: { Cookie: `cx_portal=${signValue(RAW_COOKIE_TOKEN)}` },
  });
}

function staleCookieRow() {
  return {
    id: "psn_stale",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/42",
    email: "customer@example.com",
    isPreview: false,
    expiresAt: new Date(Date.now() + 86_400_000),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PORTAL_COOKIE_DEV;
  mocks.setupMode.value = true;
  mocks.shopFindUnique.mockResolvedValue({ id: mocks.shop.id });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
});

// ── 1. Identity precedence: a VALID token outranks a stale cookie ────────────

describe("getPortalSession precedence", () => {
  it("lets a valid ?cx_pp= win over a stale non-preview cookie session", async () => {
    mocks.portalSessionFindUnique.mockResolvedValue(staleCookieRow());
    const token = mintValidToken();

    const session = await getPortalSession(
      cookieRequest(proxyUrl("/", { cx_pp: token })),
    );

    expect(session?.isPreview).toBe(true);
    expect(session?.previewToken).toBe(token);
    expect(session?.email).toBe("preview@cellexia-demo.invalid");
  });

  it("keeps the cookie session when no preview token rides the URL", async () => {
    mocks.portalSessionFindUnique.mockResolvedValue(staleCookieRow());

    const session = await getPortalSession(cookieRequest(proxyUrl("/")));

    expect(session?.isPreview).toBe(false);
    expect(session?.customerId).toBe("gid://shopify/Customer/42");
  });

  it("falls through an INVALID token to the cookie session", async () => {
    mocks.portalSessionFindUnique.mockResolvedValue(staleCookieRow());

    const session = await getPortalSession(
      cookieRequest(proxyUrl("/", { cx_pp: "expired.garbage" })),
    );

    expect(session?.isPreview).toBe(false);
    expect(session?.customerId).toBe("gid://shopify/Customer/42");
  });
});

// ── 2. Every gate site names an expired token, not just /login ──────────────

describe("gated request carrying a dead ?cx_pp= (storefront-logged-in admin)", () => {
  const licid = { logged_in_customer_id: "77", cx_pp: "expired.garbage" };

  it("portal home names the expired preview — never the gate", async () => {
    const response = (await indexLoader({
      request: new Request(proxyUrl("/", licid)),
      params: {},
      context: {},
    } as never)) as Response;
    const html = await response.text();
    expect(html).toContain(EXPIRED_COPY);
    expect(html).not.toContain(GATE_COPY);
  });

  it("account page names the expired preview — never the gate", async () => {
    const response = (await accountLoader({
      request: new Request(proxyUrl("/account", licid)),
      params: {},
      context: {},
    } as never)) as Response;
    const html = await response.text();
    expect(html).toContain(EXPIRED_COPY);
    expect(html).not.toContain(GATE_COPY);
  });

  it("subscription page names the expired preview — never the gate", async () => {
    const response = (await subscriptionLoader({
      request: new Request(proxyUrl("/subscription/ctr_1", licid)),
      params: { id: "ctr_1" },
      context: {},
    } as never)) as Response;
    const html = await response.text();
    expect(html).toContain(EXPIRED_COPY);
    expect(html).not.toContain(GATE_COPY);
  });

  it("still gates a plain storefront-logged-in visitor without a token", async () => {
    const response = (await indexLoader({
      request: new Request(proxyUrl("/", { logged_in_customer_id: "77" })),
      params: {},
      context: {},
    } as never)) as Response;
    const html = await response.text();
    expect(html).toContain(GATE_COPY);
    expect(html).not.toContain(EXPIRED_COPY);
  });
});

// ── 3. Token continuity: store on preview, retry once on the gate ────────────

describe("preview-token continuity script", () => {
  it("marks ONLY the setup gate page with the data-cellexia-gate attribute", () => {
    // The inline script (with its hasAttribute check) ships on every page;
    // what must differ is the root ATTRIBUTE that arms the one-shot retry.
    expect(setupGatePage("en")).toContain('data-cellexia-gate=""');
    expect(previewExpiredPage("en")).not.toContain('data-cellexia-gate=""');
  });

  it("stores the token only behind a live preview bar, and retries only on the gate", () => {
    const gate = setupGatePage("en");
    // Saving is gated on .cxs-preview-bar (proof the token opened a session);
    // the retry is gated on the root's data-cellexia-gate attribute and a
    // URL that arrived WITHOUT cx_pp — so a retry URL can never retry again.
    expect(gate).toContain('root.querySelector(".cxs-preview-bar")');
    expect(gate).toContain('sessionStorage.setItem("cellexia:cx_pp"');
    expect(gate).toContain('root.hasAttribute("data-cellexia-gate")');
    expect(gate).toContain("window.location.replace");
  });

  it("arms the retry only on GET-rendered gates — a POST gate must not replay as GET", async () => {
    // A gate returned as a POST response (api action, cancel-flow action)
    // sits at a POST-only URL; location.replace would re-issue it as a GET
    // and land on a raw 405/404 instead of the designed gate page.
    const postGate = closedPortalPage(
      new Request(proxyUrl("/api/skip"), { method: "POST" }),
      "en",
    );
    expect(postGate).toContain(GATE_COPY);
    expect(postGate).not.toContain('data-cellexia-gate=""');

    const getGate = closedPortalPage(new Request(proxyUrl("/")), "en");
    expect(getGate).toContain('data-cellexia-gate=""');
  });

  it("renders the preview bar (the storage trigger) on preview sessions", async () => {
    const token = mintValidToken();
    const response = (await indexLoader({
      request: new Request(proxyUrl("/", { cx_pp: token })),
      params: {},
      context: {},
    } as never)) as Response;
    const html = await response.text();
    expect(html).toContain("cxs-preview-bar");
    expect(html).not.toContain(GATE_COPY);
  });
});

// ── 4. The demo preview shows the DEMO SUBSCRIPTION, pre-launch ──────────────

/**
 * The launch-checklist promise, end-to-end at the loader: while the app is
 * still in SETUP mode, "Preview with a demo subscription" must open the real
 * portal home rendering the demo contract — not the setup gate, and not the
 * empty "no subscriptions" portal. The gate tests above prove a valid token
 * opens a session; this one proves the session then finds the demo contract:
 * demo rows are `ownership: OURS` on purpose (demo.server.ts stamps and
 * repairs it), so the portal's OURS_ONLY filter must keep passing them and
 * must never grow an `isDemo: false` clause — every OTHER consumer filters
 * demo rows out, which is exactly how such a clause would sneak in here.
 */
describe("demo preview in setup mode", () => {
  function demoContractRow() {
    const now = Date.now();
    return {
      id: "ctr_demo",
      shopId: "shop_1",
      customerId: "gid://cellexia/demo/customer/abc",
      email: "preview@cellexia-demo.invalid",
      status: "ACTIVE",
      isDemo: true,
      ownership: "OURS",
      currencyCode: "GBP",
      intervalWeeks: 8,
      billingIntervalUnit: "WEEK",
      billingIntervalCount: 8,
      createdAt: new Date(now - 70 * 86_400_000),
      firstChargeAt: new Date(now - 70 * 86_400_000),
      nextBillingDate: new Date(now + 12 * 86_400_000),
      resumeAt: null,
      predictedEmptyDate: null,
      ordersCount: 2,
      deliveryPriceCents: 0,
      lines: [
        {
          id: "line_1",
          title: "Cell Renewal Serum",
          variantTitle: null,
          imageUrl: null,
          quantity: 1,
          currentPriceCents: 5400,
          isGift: false,
          isOneTimeAddon: false,
        },
        {
          id: "line_2",
          title: "Surprise gift — thank you",
          variantTitle: null,
          imageUrl: null,
          quantity: 1,
          currentPriceCents: 0,
          isGift: true,
          isOneTimeAddon: false,
        },
      ],
    };
  }

  it("renders the demo subscription behind the preview bar — no gate, no empty state", async () => {
    mocks.setupMode.value = true; // explicit: the app is NOT live
    mocks.contractFindMany.mockResolvedValue([demoContractRow()]);
    const token = mintValidToken();

    const response = (await indexLoader({
      request: new Request(proxyUrl("/", { cx_pp: token })),
      params: {},
      context: {},
    } as never)) as Response;
    const html = await response.text();

    // The preview shell…
    expect(html).toContain("Preview mode");
    expect(html).toContain("cxs-preview-bar");
    // …around the actual demo subscription…
    expect(html).toContain("Cell Renewal Serum");
    expect(html).toContain("Surprise gift — thank you");
    // …and neither dead end.
    expect(html).not.toContain(GATE_COPY);
    expect(html).not.toContain("There are no subscriptions on this account yet");

    // The contract lookup ran as the token's demo customer, OURS-scoped,
    // WITHOUT an isDemo exclusion (the clause that would silently turn the
    // demo preview into the empty portal).
    const lastCall = mocks.contractFindMany.mock.calls.at(-1) as
      | unknown[]
      | undefined;
    const where = (
      lastCall?.[0] as { where?: Record<string, unknown> } | undefined
    )?.where;
    expect(where).toMatchObject({
      shopId: "shop_1",
      customerId: "gid://cellexia/demo/customer/abc",
      ownership: "OURS",
    });
    expect(where).not.toHaveProperty("isDemo");
  });

  it("bounces /login back to the portal home when the valid token lands there", async () => {
    // Any redirect that dumps a valid preview link on the login page must
    // come straight back to the portal — carrying the token — instead of
    // rendering a sign-in (or, worse, gate) page to the previewing admin.
    const token = mintValidToken();
    const { loader: loginLoader } = await import("~/routes/proxy.login");

    const response = await loginLoader({
      request: new Request(proxyUrl("/login", { cx_pp: token })),
      params: {},
      context: {},
    } as never).then(
      (r) => r as Response,
      (thrown) => thrown as Response,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain(`${PORTAL_PROXY_BASE}/`);
    expect(location).toContain(`cx_pp=${encodeURIComponent(token)}`);
    expect(mocks.contractFindMany).not.toHaveBeenCalled();
  });
});
