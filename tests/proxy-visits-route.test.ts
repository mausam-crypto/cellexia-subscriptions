import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /apps/cellexia-subs/w — the visit beacon route (proxy.w.tsx, v1.27.0).
 *
 *  - SIGNATURE FIRST: authenticate.public.appProxy runs before anything
 *    else; its rejection propagates (an unsigned request is not a beacon).
 *  - 204 ALWAYS after that: valid, invalid, dropped, or a throwing
 *    database, the storefront only ever sees 204 + Cache-Control: no-store.
 *  - DROPS: bad params, bot User-Agent, SETUP mode (verdict cached 60 s per
 *    shop), per-vid bucket (60/min), per-shop bucket (3,000/min); the
 *    limiters run BEFORE any database read.
 *  - WRITE: recordVisit gets the parsed beacon + shop id + shop-tz day +
 *    market handle for the country; shop = requireShop(session.shop) when
 *    the proxy names one, getPrimaryShop otherwise.
 *
 * The route keeps per-instance state (buckets, launch cache): every test
 * imports a FRESH module instance via vi.resetModules so state never leaks.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-visits";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.SHOPIFY_API_KEY = "test-key";
process.env.SHOPIFY_API_SECRET = "test-secret";
process.env.SHOPIFY_APP_URL = "https://app.example.com";
process.env.SCOPES = "read_products";

const SHOP_DOMAIN = "cellexia.myshopify.com";

const mocks = vi.hoisted(() => ({
  appProxy: vi.fn(async (_request: Request): Promise<unknown> => ({
    session: { shop: "cellexia.myshopify.com" },
  })),
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_primary",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getLaunchState: vi.fn(async (): Promise<unknown> => ({ mode: "LIVE" })),
  marketHandleForCountry: vi.fn(async (): Promise<string | null> => "uk"),
  recordVisit: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { public: { appProxy: mocks.appProxy } },
  adminClientForShop: vi.fn(),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: mocks.requireShop,
  getPrimaryShop: mocks.getPrimaryShop,
}));

vi.mock("~/lib/launch/launch.server", () => ({
  getLaunchState: mocks.getLaunchState,
}));

vi.mock("~/lib/design-measurement/markets.server", () => ({
  marketHandleForCountry: mocks.marketHandleForCountry,
}));

// The writer is mocked; its own semantics live in
// tests/design-measurement-visits.test.ts. Everything else in visits.server
// (parsing, buckets, bot regex, day key) runs for real.
vi.mock("~/lib/design-measurement/visits.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/design-measurement/visits.server")>();
  return { ...actual, recordVisit: mocks.recordVisit };
});

type Loader = (args: { request: Request; params: Record<string, string>; context: Record<string, unknown> }) => Promise<Response>;

async function loadRoute(): Promise<Loader> {
  vi.resetModules();
  const mod = await import("~/routes/proxy.w");
  return mod.loader as unknown as Loader;
}

const BASE_QUERY = {
  e: "view",
  d: "subscription_max",
  p: "s",
  v: "gid://shopify/ProductVariant/1",
  c: "GB",
  cur: "GBP",
  dv: "m",
  vid: "abcdefghijklmnop",
  pv: "pv123456",
  t: "1757505600000",
  // Shopify's proxy adds these; the signature is verified by the mocked lib.
  shop: SHOP_DOMAIN,
  signature: "deadbeef",
  timestamp: "1757505600",
};

function beaconRequest(
  overrides: Partial<Record<keyof typeof BASE_QUERY | "m", string>> = {},
  headers: Record<string, string> = {},
): Request {
  const query: Record<string, string> = { ...BASE_QUERY, ...overrides };
  const params = new URLSearchParams(query);
  return new Request(`https://app.example.com/proxy/w?${params.toString()}`, {
    method: "GET",
    headers,
  });
}

const call = (loader: Loader, request: Request) =>
  loader({ request, params: {}, context: {} });

const argOf = (mock: { mock: { calls: unknown[] } }, i = 0): Record<string, unknown> =>
  ((mock.mock.calls[i] as unknown[] | undefined)?.[0] ?? {}) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.appProxy.mockResolvedValue({ session: { shop: SHOP_DOMAIN } });
  mocks.requireShop.mockResolvedValue({
    id: "shop_1",
    domain: SHOP_DOMAIN,
    ianaTimezone: "Europe/Zurich",
  });
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_primary",
    domain: SHOP_DOMAIN,
    ianaTimezone: "Europe/Zurich",
  });
  mocks.getLaunchState.mockResolvedValue({ mode: "LIVE" });
  mocks.marketHandleForCountry.mockResolvedValue("uk");
  mocks.recordVisit.mockResolvedValue(undefined);
});

function expectNoContent(res: Response) {
  expect(res.status).toBe(204);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
}

describe("signature", () => {
  it("runs authenticate.public.appProxy FIRST and lets its rejection propagate", async () => {
    const loader = await loadRoute();
    const rejection = new Response("Unauthorized", { status: 401 });
    mocks.appProxy.mockRejectedValueOnce(rejection);

    await expect(call(loader, beaconRequest())).rejects.toBe(rejection);
    expect(mocks.appProxy).toHaveBeenCalledTimes(1);
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(mocks.requireShop).not.toHaveBeenCalled();
    expect(mocks.getLaunchState).not.toHaveBeenCalled();
  });
});

describe("happy path", () => {
  it("records a view for the session's shop with the shop-tz day and the country's market, and answers 204 no-store", async () => {
    const loader = await loadRoute();
    // 23:30 UTC on Sep 10 = 01:30 on Sep 11 in Zurich.
    vi.useFakeTimers({ now: new Date("2026-09-10T23:30:00Z"), toFake: ["Date"] });

    const res = await call(loader, beaconRequest());
    expectNoContent(res);
    expect(await res.text()).toBe("");

    expect(mocks.requireShop).toHaveBeenCalledWith(SHOP_DOMAIN);
    expect(mocks.getPrimaryShop).not.toHaveBeenCalled();
    expect(mocks.marketHandleForCountry).toHaveBeenCalledWith("shop_1", "GB");
    expect(mocks.recordVisit).toHaveBeenCalledTimes(1);
    expect(argOf(mocks.recordVisit)).toEqual({
      shopId: "shop_1",
      day: "2026-09-11",
      vid: "abcdefghijklmnop",
      designKey: "subscription_max",
      designPreselect: "sub",
      countryCode: "GB",
      marketHandle: "uk",
      deviceType: "mobile",
      event: "view",
      mode: null,
      now: new Date("2026-09-10T23:30:00Z"),
    });
  });

  it("day follows the shop timezone across midnight: the same instant is a different day in another zone", async () => {
    const loader = await loadRoute();
    vi.useFakeTimers({ now: new Date("2026-09-10T23:30:00Z"), toFake: ["Date"] });
    mocks.requireShop.mockResolvedValue({ id: "shop_1", domain: SHOP_DOMAIN, ianaTimezone: "America/New_York" });

    await call(loader, beaconRequest());
    expect(argOf(mocks.recordVisit)).toMatchObject({ day: "2026-09-10" });
  });

  it("engage and atc map to their events; atc carries the mode; unknown country/device become null", async () => {
    const loader = await loadRoute();
    mocks.marketHandleForCountry.mockResolvedValue(null);

    await call(loader, beaconRequest({ e: "engage", p: "o", c: "", dv: "", vid: "vid_engage_0001" }));
    expect(argOf(mocks.recordVisit, 0)).toMatchObject({
      event: "engage",
      designPreselect: "one",
      countryCode: null,
      marketHandle: null,
      deviceType: null,
      mode: null,
    });
    expect(mocks.marketHandleForCountry).toHaveBeenLastCalledWith("shop_1", null);

    await call(loader, beaconRequest({ e: "atc", m: "s", p: "u", dv: "d", vid: "vid_atc_00000001" }));
    expect(argOf(mocks.recordVisit, 1)).toMatchObject({
      event: "atc",
      mode: "s",
      designPreselect: "u",
      deviceType: "desktop",
    });

    await call(loader, beaconRequest({ e: "atc", m: "o", dv: "t", vid: "vid_atc_00000002" }));
    expect(argOf(mocks.recordVisit, 2)).toMatchObject({ event: "atc", mode: "o", deviceType: "tablet" });
  });

  it("falls back to getPrimaryShop when the proxy session names no shop", async () => {
    const loader = await loadRoute();
    mocks.appProxy.mockResolvedValue({ session: undefined });

    expectNoContent(await call(loader, beaconRequest()));
    expect(mocks.requireShop).not.toHaveBeenCalled();
    expect(mocks.getPrimaryShop).toHaveBeenCalledTimes(1);
    expect(argOf(mocks.recordVisit)).toMatchObject({ shopId: "shop_primary" });
  });
});

describe("silent drops (204 either way)", () => {
  it("invalid params: bad event, bad design key, bad preselect, bad vid, empty query", async () => {
    const loader = await loadRoute();
    for (const bad of [
      { e: "click" },
      { d: "Not A Key!" },
      { p: "x" },
      { vid: "short" },
      { vid: "has space in it!" },
    ] as Array<Partial<typeof BASE_QUERY>>) {
      expectNoContent(await call(loader, beaconRequest(bad)));
    }
    expectNoContent(
      await call(loader, new Request("https://app.example.com/proxy/w?shop=x&signature=y")),
    );
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    // Cheap gates first: no shop or launch read for an invalid beacon.
    expect(mocks.requireShop).not.toHaveBeenCalled();
    expect(mocks.getLaunchState).not.toHaveBeenCalled();
  });

  it("bot User-Agents are dropped before any database read; a real browser UA and no UA pass", async () => {
    const loader = await loadRoute();
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 HeadlessChrome/120",
      "Chrome-Lighthouse",
      "Slack link preview",
    ]) {
      expectNoContent(await call(loader, beaconRequest({ vid: "vid_bot_00000001" }, { "user-agent": ua })));
    }
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(mocks.requireShop).not.toHaveBeenCalled();

    await call(
      loader,
      beaconRequest(
        { vid: "vid_real_0000001" },
        { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" },
      ),
    );
    await call(loader, beaconRequest({ vid: "vid_noua_0000001" }));
    expect(mocks.recordVisit).toHaveBeenCalledTimes(2);
  });

  it("SETUP mode: nothing is written, and the verdict is cached for 60 s per shop", async () => {
    const loader = await loadRoute();
    vi.useFakeTimers({ now: new Date("2026-09-10T12:00:00Z"), toFake: ["Date"] });
    mocks.getLaunchState.mockResolvedValue({ mode: "SETUP" });

    expectNoContent(await call(loader, beaconRequest({ vid: "vid_setup_000001" })));
    expectNoContent(await call(loader, beaconRequest({ vid: "vid_setup_000002" })));
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    // One launch read for two beacons: cached.
    expect(mocks.getLaunchState).toHaveBeenCalledTimes(1);
    expect(mocks.getLaunchState).toHaveBeenCalledWith("shop_1");

    // Going live is picked up once the minute has passed, not before.
    mocks.getLaunchState.mockResolvedValue({ mode: "LIVE" });
    vi.setSystemTime(new Date("2026-09-10T12:00:59Z"));
    await call(loader, beaconRequest({ vid: "vid_setup_000003" }));
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(mocks.getLaunchState).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-10T12:01:01Z"));
    await call(loader, beaconRequest({ vid: "vid_setup_000004" }));
    expect(mocks.getLaunchState).toHaveBeenCalledTimes(2);
    expect(mocks.recordVisit).toHaveBeenCalledTimes(1);
  });

  it("no shop installed: dropped, still 204", async () => {
    const loader = await loadRoute();
    mocks.appProxy.mockResolvedValue({ session: undefined });
    mocks.getPrimaryShop.mockResolvedValue(null);
    expectNoContent(await call(loader, beaconRequest()));
    expect(mocks.recordVisit).not.toHaveBeenCalled();
    expect(mocks.getLaunchState).not.toHaveBeenCalled();
  });

  it("per-vid bucket: the 61st beacon of one visitor within a minute is dropped, another visitor is not", async () => {
    const loader = await loadRoute();
    vi.useFakeTimers({ now: new Date("2026-09-10T12:00:00Z"), toFake: ["Date"] });
    for (let i = 0; i < 60; i++) {
      expectNoContent(await call(loader, beaconRequest({ vid: "vid_flood_000001" })));
    }
    expect(mocks.recordVisit).toHaveBeenCalledTimes(60);
    expectNoContent(await call(loader, beaconRequest({ vid: "vid_flood_000001" })));
    expect(mocks.recordVisit).toHaveBeenCalledTimes(60);
    // Another visitor is unaffected.
    await call(loader, beaconRequest({ vid: "vid_other_000001" }));
    expect(mocks.recordVisit).toHaveBeenCalledTimes(61);
    // A minute later the flooding visitor is served again.
    vi.setSystemTime(new Date("2026-09-10T12:01:01Z"));
    await call(loader, beaconRequest({ vid: "vid_flood_000001" }));
    expect(mocks.recordVisit).toHaveBeenCalledTimes(62);
  });

  it("per-shop bucket: 3,000 beacons per minute across all visitors, checked before any database read", async () => {
    const loader = await loadRoute();
    vi.useFakeTimers({ now: new Date("2026-09-10T12:00:00Z"), toFake: ["Date"] });
    // 3,000 distinct visitors (one beacon each: the per-vid bucket never
    // fires) exhaust the shop bucket; the 3,001st is dropped before the
    // shop lookup.
    for (let i = 0; i < 3000; i++) {
      await call(loader, beaconRequest({ vid: `vid_shop_${String(i).padStart(7, "0")}` }));
    }
    expect(mocks.recordVisit).toHaveBeenCalledTimes(3000);
    const shopReadsBefore = mocks.requireShop.mock.calls.length;
    expectNoContent(await call(loader, beaconRequest({ vid: "vid_shop_overflow" })));
    expect(mocks.recordVisit).toHaveBeenCalledTimes(3000);
    expect(mocks.requireShop.mock.calls.length).toBe(shopReadsBefore);
  });

  it("a throwing shop lookup, market lookup or writer is contained: 204, logged, never thrown", async () => {
    const loader = await loadRoute();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.recordVisit.mockRejectedValueOnce(new Error("db down"));
      expectNoContent(await call(loader, beaconRequest({ vid: "vid_err_00000001" })));

      mocks.marketHandleForCountry.mockRejectedValueOnce(new Error("db down"));
      expectNoContent(await call(loader, beaconRequest({ vid: "vid_err_00000002" })));

      mocks.requireShop.mockRejectedValueOnce(new Error("Shop not found"));
      expectNoContent(await call(loader, beaconRequest({ vid: "vid_err_00000003" })));

      expect(errorSpy).toHaveBeenCalledTimes(3);
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/^\[visits\]/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
