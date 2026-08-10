import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cookie-less portal identities (v1.7.0). Shopify's app proxy strips the
 * Cookie and Set-Cookie headers in both directions, so on a live store the
 * cx_portal cookie can neither be set nor read — getPortalSession therefore
 * gained two cookie-less paths, both trustworthy only behind the proxy HMAC
 * every route verifies first:
 *
 *  - ?cx_pp=   signed admin preview token → isPreview session;
 *  - ?logged_in_customer_id=   Shopify's own signed storefront-login
 *    identity → real customer session, matched against contracts that store
 *    the customer gid.
 *
 * DB-free: prisma is a capture stub (portal-audit.test.ts pattern).
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-cookieless-session";

const mocks = vi.hoisted(() => ({
  shopFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  portalSessionFindUnique: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
  contractFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: { findUnique: mocks.shopFindUnique },
    portalSession: { findUnique: mocks.portalSessionFindUnique },
    subscriptionContract: { findFirst: mocks.contractFindFirst },
  },
}));

import { getPortalSession } from "~/lib/portal/session.server";
import { mintPreviewToken } from "~/lib/portal/previewToken.server";
import { withLocale } from "~/lib/portal/layout.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";

const SHOP_DOMAIN = "cellexia.myshopify.com";

function proxyRequest(extraParams: Record<string, string>): Request {
  const url = new URL(`https://cellexialabs.com${PORTAL_PROXY_BASE}/`);
  url.searchParams.set("shop", SHOP_DOMAIN);
  for (const [name, value] of Object.entries(extraParams)) {
    url.searchParams.set(name, value);
  }
  return new Request(url.toString());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.shopFindUnique.mockResolvedValue({ id: "shop_1" });
  mocks.portalSessionFindUnique.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
});

describe("getPortalSession — bare requests", () => {
  it("yields null with no cookie, no cx_pp and no logged_in_customer_id", async () => {
    expect(await getPortalSession(proxyRequest({}))).toBeNull();
  });

  it("yields null when logged_in_customer_id is empty (visitor not signed in)", async () => {
    expect(
      await getPortalSession(proxyRequest({ logged_in_customer_id: "" })),
    ).toBeNull();
  });
});

describe("getPortalSession — ?cx_pp= admin preview", () => {
  const mint = () =>
    mintPreviewToken({
      shopId: "shop_1",
      customerId: "gid://shopify/Customer/1",
      contractId: "ctr_1",
      email: "sub@example.com",
    });

  it("opens an isPreview session carrying the raw token", async () => {
    const raw = mint();
    const session = await getPortalSession(proxyRequest({ cx_pp: raw }));
    expect(session).not.toBeNull();
    expect(session?.isPreview).toBe(true);
    expect(session?.shopId).toBe("shop_1");
    expect(session?.customerId).toBe("gid://shopify/Customer/1");
    expect(session?.email).toBe("sub@example.com");
    expect(session?.previewToken).toBe(raw);
    expect(session?.csrfToken).toBeTruthy();
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // Stateless: no PortalSession row was consulted or created.
    expect(mocks.contractFindFirst).not.toHaveBeenCalled();
  });

  it("keeps the CSRF token stable across requests with the same token", async () => {
    const raw = mint();
    const a = await getPortalSession(proxyRequest({ cx_pp: raw }));
    const b = await getPortalSession(proxyRequest({ cx_pp: raw }));
    expect(a?.csrfToken).toBe(b?.csrfToken);
  });

  it("yields null for a tampered token", async () => {
    const raw = mint();
    const session = await getPortalSession(
      proxyRequest({ cx_pp: `${raw.slice(0, -2)}xx` }),
    );
    expect(session).toBeNull();
  });

  it("yields null for a token minted for another shop", async () => {
    const raw = mintPreviewToken({
      shopId: "shop_OTHER",
      customerId: "gid://shopify/Customer/1",
      email: "sub@example.com",
    });
    expect(await getPortalSession(proxyRequest({ cx_pp: raw }))).toBeNull();
  });

  it("yields null when the ?shop= domain is unknown", async () => {
    mocks.shopFindUnique.mockResolvedValue(null);
    expect(await getPortalSession(proxyRequest({ cx_pp: mint() }))).toBeNull();
  });
});

describe("getPortalSession — ?logged_in_customer_id= storefront login", () => {
  it("opens a real (non-preview) session anchored on the stored contract", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      customerId: "gid://shopify/Customer/777",
      email: "customer@example.com",
    });
    const session = await getPortalSession(
      proxyRequest({ logged_in_customer_id: "777" }),
    );
    expect(session).not.toBeNull();
    expect(session?.isPreview).toBe(false);
    expect(session?.previewToken).toBeNull();
    expect(session?.customerId).toBe("gid://shopify/Customer/777");
    expect(session?.email).toBe("customer@example.com");

    // Normalization: the lookup matched BOTH the gid and the bare numeric
    // form, scoped to the resolved shop.
    const call = mocks.contractFindFirst.mock.calls[0]?.[0] as {
      where: { shopId: string; customerId: { in: string[] } };
    };
    expect(call.where.shopId).toBe("shop_1");
    expect(call.where.customerId.in).toEqual([
      "gid://shopify/Customer/777",
      "777",
    ]);
  });

  it("still opens a session with no contract yet (empty email, gid identity)", async () => {
    const session = await getPortalSession(
      proxyRequest({ logged_in_customer_id: "42" }),
    );
    expect(session).not.toBeNull();
    expect(session?.customerId).toBe("gid://shopify/Customer/42");
    expect(session?.email).toBe("");
  });

  it("rejects a non-numeric logged_in_customer_id", async () => {
    expect(
      await getPortalSession(
        proxyRequest({ logged_in_customer_id: "gid://shopify/Customer/1" }),
      ),
    ).toBeNull();
  });
});

describe("withLocale third parameter (preview token propagation)", () => {
  const base = PORTAL_PROXY_BASE;

  it("appends cx_pp to portal paths when a token is given", () => {
    expect(withLocale(`${base}/`, "en", "tok.sig")).toBe(
      `${base}/?cx_pp=tok.sig`,
    );
    expect(withLocale(`${base}/account`, "fr", "tok.sig")).toBe(
      `${base}/account?locale=fr&cx_pp=tok.sig`,
    );
  });

  it("leaves URLs alone when the token is null/undefined (cookie sessions)", () => {
    expect(withLocale(`${base}/`, "en", null)).toBe(`${base}/`);
    expect(withLocale(`${base}/`, "en")).toBe(`${base}/`);
  });

  it("never leaks the token onto non-portal paths", () => {
    expect(withLocale("/account/login", "en", "tok.sig")).toBe(
      "/account/login",
    );
  });
});
