import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Buy box designer, Results tab (v1.26.0): the /app/buy-box/results resource
 * route (app/routes/app.buy-box_.results.tsx) and the page wiring around it.
 *
 * Pinned here:
 *  - LOADER PARSING: range 30|90|365|all → rangeDays 30|90|365|null (default
 *    all), market handle sanitised ("" / junk → null), group variant|design|
 *    revision (default variant), fresh=1|true → getScoreboard({fresh:true});
 *    the payload carries scoreboard + designMeasurement settings + a merged
 *    market list (MarketCountryMap handles + live Shopify names) + the shop
 *    currency, and Cache-Control: no-store on both the loader Response and
 *    the route `headers` export.
 *  - ACTION VALIDATION: save-measurement-settings parses the four fields
 *    (emails one-per-line or comma-separated, lowercased, de-duplicated;
 *    ISO date or empty; whole-number ranges) and MERGES over the current
 *    setting (weeklySessions untouched); save-sessions replaces the map from
 *    JSON and keeps the other fields; both log admin.action
 *    design_measurement_settings_saved and clear the scoreboard cache;
 *    save-measurement-settings ALSO re-flags staff on the recorded rows
 *    (recomputeStaffFlags, contained) before the cache drop; bad values →
 *    422 with a plain toast; unknown intent → 400.
 *  - PAGE SHAPE: the designer no longer queries getDesignPerformance in its
 *    loader (the Results tab replaced the bottom card), has the fifth tab,
 *    and the publish modal carries the optional label; the client component
 *    imports nothing server-side.
 *
 * Follows the tests/klaviyo-setup-route.test.ts harness (route module
 * imported with its server seams mocked; no DB, no Shopify).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const DEFAULT_SETTINGS = {
  startedAt: null as string | null,
  excludeEmails: [] as string[],
  guardrailMaxOrderDropPct: 10,
  guardrailMinOrdersPerWeek: 20,
  weeklySessions: {} as Record<string, number>,
};

const mocks = vi.hoisted(() => ({
  authenticateAdmin: vi.fn(async (): Promise<unknown> => ({
    admin: { graphql: vi.fn() },
    session: {
      shop: "cellexia.myshopify.com",
      onlineAccessInfo: { associated_user: { email: "owner@example.com" } },
    },
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    currencyCode: "EUR",
    ianaTimezone: "Europe/Zurich",
  })),
  currentSetting: null as unknown,
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "designMeasurement") return mocks.currentSetting;
    return {};
  }),
  setSetting: vi.fn(
    async (_shopId: string, _key: string, _value: unknown, _actor?: string): Promise<void> => {},
  ),
  logEvent: vi.fn(async (): Promise<void> => {}),
  getScoreboard: vi.fn(async (q: unknown): Promise<unknown> => ({
    computedAt: "2026-09-10T10:00:00.000Z",
    cached: false,
    rangeDays: (q as { rangeDays: number | null }).rangeDays,
    startedAt: null,
    marketHandle: (q as { marketHandle: string | null }).marketHandle,
    groupBy: (q as { groupBy: string }).groupBy,
    totals: {
      orders: 0,
      subscribed: 0,
      excludedStaff: 0,
      excludedForeignOnly: 0,
      noExposure: 0,
      unattributedSubscribed: 0,
      seenCoveragePct: null,
      calendarAgreementPct: null,
      // v1.27.0 visit totals ride inside the scoreboard; the route passes them through untouched.
      visits: 0,
      visitCoverageDays: 0,
      lastVisitAt: null,
    },
    rows: [],
    weeks: [],
    guardrail: { maxOrderDropPct: 10, minOrdersPerWeek: 20, verdicts: [] },
    conversion: [],
    comparison: [],
    calendar: [],
    markets: [],
  })),
  invalidateScoreboardCache: vi.fn((): void => {}),
  recomputeStaffFlags: vi.fn(
    async (_shopId: string, _emails: string[], _opts: { since: Date | null }): Promise<unknown> => ({
      scanned: 0,
      changed: 0,
    }),
  ),
  /** Records the ORDER of the two post-save calls: the recompute must land before the cache drop. */
  callOrder: [] as string[],
  listMarkets: vi.fn(async (): Promise<unknown[]> => [
    { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
    { id: "gid://shopify/Market/2", name: "European Union", handle: "eu", primary: false, enabled: true },
  ]),
  marketCountryMapFindMany: vi.fn(async (): Promise<unknown[]> => [
    { marketHandle: "ch", marketName: "Schweiz" },
    { marketHandle: "uk", marketName: "United Kingdom" },
  ]),
}));

vi.mock("~/db.server", () => ({
  default: {
    marketCountryMap: { findMany: mocks.marketCountryMapFindMany },
  },
}));
vi.mock("~/shopify.server", () => ({
  authenticate: { admin: mocks.authenticateAdmin },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/graphql/index.server", () => ({
  listMarkets: mocks.listMarkets,
}));
vi.mock("~/lib/design-measurement/scoreboard.server", () => ({
  getScoreboard: mocks.getScoreboard,
  invalidateScoreboardCache: mocks.invalidateScoreboardCache,
}));
vi.mock("~/lib/design-measurement/backfill.server", () => ({
  recomputeStaffFlags: mocks.recomputeStaffFlags,
}));

const route = await import("~/routes/app.buy-box_.results");
const { action, loader, headers } = route;

function invokeLoader(query = "") {
  const request = new Request(`https://cellexia.example/app/buy-box/results${query}`);
  return loader({ request, params: {}, context: {} } as never) as Promise<Response>;
}

function invokeAction(fields: Record<string, string>) {
  const request = new Request("https://cellexia.example/app/buy-box/results", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return action({ request, params: {}, context: {} } as never) as Promise<Response>;
}

type ActionBody = { intent: string; ok: boolean; toast: string };
type LoaderBody = {
  scoreboard: { rangeDays: number | null; marketHandle: string | null; groupBy: string };
  settings: typeof DEFAULT_SETTINGS;
  markets: Array<{ handle: string; name: string | null }>;
  currencyCode: string;
  query: { range: string; market: string; group: string };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentSetting = { ...DEFAULT_SETTINGS, weeklySessions: { "2026-W36": 500 } };
  mocks.callOrder = [];
  mocks.recomputeStaffFlags.mockImplementation(async () => {
    mocks.callOrder.push("recompute");
    return { scanned: 0, changed: 0 };
  });
  mocks.invalidateScoreboardCache.mockImplementation(() => {
    mocks.callOrder.push("invalidate");
  });
});

// ── Loader ───────────────────────────────────────────────────────────────────

describe("loader query parsing", () => {
  it("defaults: range all → rangeDays null, every market, group variant, cache allowed", async () => {
    const res = await invokeLoader();
    expect(res.status).toBe(200);
    expect(mocks.getScoreboard).toHaveBeenCalledTimes(1);
    expect(mocks.getScoreboard).toHaveBeenCalledWith({
      shopId: "shop_1",
      rangeDays: null,
      marketHandle: null,
      groupBy: "variant",
      fresh: false,
    });
    const body = (await res.json()) as LoaderBody;
    expect(body.query).toEqual({ range: "all", market: "", group: "variant" });
    expect(body.currencyCode).toBe("EUR");
  });

  it("range=30|90|365 → rangeDays; unknown range falls back to all", async () => {
    for (const [raw, days] of [
      ["30", 30],
      ["90", 90],
      ["365", 365],
      ["7", null],
      ["forever", null],
    ] as const) {
      mocks.getScoreboard.mockClear();
      await invokeLoader(`?range=${raw}`);
      expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ rangeDays: days });
    }
  });

  it("market handle passes through when it looks like a Shopify handle; junk and empty → null", async () => {
    await invokeLoader("?market=eu");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ marketHandle: "eu" });
    mocks.getScoreboard.mockClear();
    await invokeLoader("?market=");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ marketHandle: null });
    mocks.getScoreboard.mockClear();
    await invokeLoader(`?market=${encodeURIComponent("<script>")}`);
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ marketHandle: null });
  });

  it("group=design|revision honoured; unknown → variant", async () => {
    await invokeLoader("?group=design");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ groupBy: "design" });
    mocks.getScoreboard.mockClear();
    await invokeLoader("?group=revision");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ groupBy: "revision" });
    mocks.getScoreboard.mockClear();
    await invokeLoader("?group=whatever");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ groupBy: "variant" });
  });

  it("fresh=1 or fresh=true bypasses the cache; anything else does not", async () => {
    await invokeLoader("?fresh=1");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ fresh: true });
    mocks.getScoreboard.mockClear();
    await invokeLoader("?fresh=true");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ fresh: true });
    mocks.getScoreboard.mockClear();
    await invokeLoader("?fresh=0");
    expect(mocks.getScoreboard.mock.calls[0][0]).toMatchObject({ fresh: false });
  });

  it("returns the scoreboard, the designMeasurement settings and a merged market list (live names win, cached-only handles kept)", async () => {
    const res = await invokeLoader("?range=90&market=ch&group=design");
    const body = (await res.json()) as LoaderBody;
    expect(body.scoreboard).toMatchObject({ rangeDays: 90, marketHandle: "ch", groupBy: "design" });
    // v1.27.0: the visit totals and the reference comparison travel inside
    // `scoreboard` unchanged (no new top-level payload field, no new param).
    expect(body.scoreboard).toMatchObject({
      totals: { visits: 0, visitCoverageDays: 0, lastVisitAt: null },
      comparison: [],
    });
    expect(body.settings).toEqual({ ...DEFAULT_SETTINGS, weeklySessions: { "2026-W36": 500 } });
    expect(body.markets).toEqual([
      { handle: "eu", name: "European Union" },
      { handle: "ch", name: "Switzerland" },
      { handle: "uk", name: "United Kingdom" },
    ]);
    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "designMeasurement");
  });

  it("a failing Shopify markets read degrades to the cached handles; a failing map read degrades to the live list", async () => {
    mocks.listMarkets.mockRejectedValueOnce(new Error("api down"));
    let body = (await (await invokeLoader()).json()) as LoaderBody;
    expect(body.markets.map((m) => m.handle)).toEqual(["ch", "uk"]);
    expect(body.markets[0].name).toBe("Schweiz");

    mocks.marketCountryMapFindMany.mockRejectedValueOnce(new Error("db down"));
    body = (await (await invokeLoader()).json()) as LoaderBody;
    expect(body.markets.map((m) => m.handle)).toEqual(["eu", "ch"]);
  });

  it("answers no-store on the loader Response AND through the route headers export", async () => {
    const res = await invokeLoader();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const routeHeaders = headers({
      loaderHeaders: new Headers(),
      parentHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as never) as Record<string, string>;
    expect(routeHeaders["Cache-Control"]).toBe("no-store");
  });

  it("is a resource route: no default export", () => {
    expect((route as Record<string, unknown>).default).toBeUndefined();
  });
});

// ── Action: save-measurement-settings ────────────────────────────────────────

describe("action save-measurement-settings", () => {
  it("parses every field, merges over the current setting (weeklySessions kept), logs the audit event, clears the cache", async () => {
    const res = await invokeAction({
      intent: "save-measurement-settings",
      startedAt: " 2026-09-01 ",
      excludeEmails: "Owner@Example.com\ntester@example.com, owner@example.com;  qa@example.com ",
      guardrailMaxOrderDropPct: "15",
      guardrailMinOrdersPerWeek: "30",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionBody;
    expect(body).toEqual({
      intent: "save-measurement-settings",
      ok: true,
      toast: "Measurement settings saved",
    });
    expect(mocks.setSetting).toHaveBeenCalledTimes(1);
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "shop_1",
      "designMeasurement",
      {
        startedAt: "2026-09-01",
        excludeEmails: ["owner@example.com", "tester@example.com", "qa@example.com"],
        guardrailMaxOrderDropPct: 15,
        guardrailMinOrdersPerWeek: 30,
        weeklySessions: { "2026-W36": 500 },
      },
      "owner@example.com",
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        shopId: "shop_1",
        type: "admin.action",
        source: "ADMIN",
        actor: "owner@example.com",
        payload: expect.objectContaining({
          action: "design_measurement_settings_saved",
          part: "settings",
          excludeEmailsCount: 3,
        }),
      }),
    );
    expect(mocks.invalidateScoreboardCache).toHaveBeenCalledWith("shop_1");
  });

  it("re-flags staff on the rows already recorded (recomputeStaffFlags with the saved list, since = start date at 00:00 shop time) BEFORE clearing the cache", async () => {
    // Without this the fresh refetch recomputes over the OLD staff flags and
    // the tab keeps counting staff orders until the nightly job, while the
    // help text promises they are left out of every number.
    const res = await invokeAction({
      intent: "save-measurement-settings",
      startedAt: "2026-09-01",
      excludeEmails: "Tester@Brand.com\nowner@brand.com",
      guardrailMaxOrderDropPct: "10",
      guardrailMinOrdersPerWeek: "20",
    });
    expect(res.status).toBe(200);
    expect(mocks.recomputeStaffFlags).toHaveBeenCalledTimes(1);
    const [shopId, emails, opts] = mocks.recomputeStaffFlags.mock.calls[0];
    expect(shopId).toBe("shop_1");
    expect(emails).toEqual(["tester@brand.com", "owner@brand.com"]);
    // 2026-09-01 00:00 Europe/Zurich (the shop's tz) = 2026-08-31T22:00Z.
    expect(opts.since?.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    // Order matters: recompute first, then drop the cache.
    expect(mocks.callOrder).toEqual(["recompute", "invalidate"]);
    // Only the settings intent re-flags: sessions never touch staff.
    mocks.recomputeStaffFlags.mockClear();
    await invokeAction({ intent: "save-sessions", weeklySessions: "{}" });
    expect(mocks.recomputeStaffFlags).not.toHaveBeenCalled();
  });

  it("without a start date the recompute covers every row (since null); a failing recompute is contained (save still ok, cache still cleared)", async () => {
    await invokeAction({
      intent: "save-measurement-settings",
      startedAt: "",
      excludeEmails: "tester@brand.com",
      guardrailMaxOrderDropPct: "10",
      guardrailMinOrdersPerWeek: "20",
    });
    expect(mocks.recomputeStaffFlags.mock.calls[0][2]).toEqual({ since: null });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.recomputeStaffFlags.mockRejectedValueOnce(new Error("db down"));
    mocks.invalidateScoreboardCache.mockClear();
    const res = await invokeAction({
      intent: "save-measurement-settings",
      startedAt: "",
      excludeEmails: "tester@brand.com",
      guardrailMaxOrderDropPct: "10",
      guardrailMinOrdersPerWeek: "20",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ActionBody).ok).toBe(true);
    expect(mocks.invalidateScoreboardCache).toHaveBeenCalledWith("shop_1");
    expect(errSpy).toHaveBeenCalledWith(
      "[design-results] staff flag recompute failed",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("empty start date and empty email list are valid (all time, nobody excluded)", async () => {
    const res = await invokeAction({
      intent: "save-measurement-settings",
      startedAt: "",
      excludeEmails: "",
      guardrailMaxOrderDropPct: "0",
      guardrailMinOrdersPerWeek: "0",
    });
    expect(res.status).toBe(200);
    expect(mocks.setSetting.mock.calls[0][2]).toMatchObject({
      startedAt: null,
      excludeEmails: [],
      guardrailMaxOrderDropPct: 0,
      guardrailMinOrdersPerWeek: 0,
    });
  });

  it("rejects a malformed or impossible start date with 422 and saves nothing", async () => {
    for (const startedAt of ["01/09/2026", "2026-13-01", "2026-02-30", "yesterday"]) {
      mocks.setSetting.mockClear();
      const res = await invokeAction({
        intent: "save-measurement-settings",
        startedAt,
        excludeEmails: "",
        guardrailMaxOrderDropPct: "10",
        guardrailMinOrdersPerWeek: "20",
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as ActionBody;
      expect(body.ok).toBe(false);
      expect(body.toast).toMatch(/start date/i);
      expect(mocks.setSetting).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-email entry in the staff list with 422 naming the entry", async () => {
    const res = await invokeAction({
      intent: "save-measurement-settings",
      startedAt: "",
      excludeEmails: "owner@example.com\nnot-an-email",
      guardrailMaxOrderDropPct: "10",
      guardrailMinOrdersPerWeek: "20",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ActionBody;
    expect(body.toast).toContain("not-an-email");
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it("rejects out-of-range or non-integer guardrail numbers with 422", async () => {
    for (const [maxDrop, minOrders] of [
      ["91", "20"],
      ["-1", "20"],
      ["10.5", "20"],
      ["abc", "20"],
      ["10", "100001"],
      ["10", ""],
    ]) {
      mocks.setSetting.mockClear();
      const res = await invokeAction({
        intent: "save-measurement-settings",
        startedAt: "",
        excludeEmails: "",
        guardrailMaxOrderDropPct: maxDrop,
        guardrailMinOrdersPerWeek: minOrders,
      });
      expect(res.status).toBe(422);
      expect(mocks.setSetting).not.toHaveBeenCalled();
    }
  });
});

// ── Action: save-sessions ────────────────────────────────────────────────────

describe("action save-sessions", () => {
  it("replaces weeklySessions from the JSON map (blank values drop the week) and keeps the other fields", async () => {
    mocks.currentSetting = {
      ...DEFAULT_SETTINGS,
      startedAt: "2026-09-01",
      excludeEmails: ["owner@example.com"],
      weeklySessions: { "2026-W35": 100 },
    };
    const res = await invokeAction({
      intent: "save-sessions",
      weeklySessions: JSON.stringify({ "2026-W36": 1200, "2026-W37": "1300", "2026-W38": "" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionBody;
    expect(body).toEqual({ intent: "save-sessions", ok: true, toast: "Product page sessions saved" });
    expect(mocks.setSetting).toHaveBeenCalledWith(
      "shop_1",
      "designMeasurement",
      {
        startedAt: "2026-09-01",
        excludeEmails: ["owner@example.com"],
        guardrailMaxOrderDropPct: 10,
        guardrailMinOrdersPerWeek: 20,
        weeklySessions: { "2026-W36": 1200, "2026-W37": 1300 },
      },
      "owner@example.com",
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          action: "design_measurement_settings_saved",
          part: "sessions",
          weeks: 2,
        }),
      }),
    );
    expect(mocks.invalidateScoreboardCache).toHaveBeenCalledWith("shop_1");
  });

  it("rejects bad JSON, non-week keys and negative / fractional counts with 422", async () => {
    for (const weeklySessions of [
      "{not json",
      "[1,2]",
      JSON.stringify({ "2026-09-01": 10 }),
      JSON.stringify({ "2026-W36": -1 }),
      JSON.stringify({ "2026-W36": 10.5 }),
      JSON.stringify({ "2026-W36": "lots" }),
    ]) {
      mocks.setSetting.mockClear();
      const res = await invokeAction({ intent: "save-sessions", weeklySessions });
      expect(res.status).toBe(422);
      const body = (await res.json()) as ActionBody;
      expect(body.ok).toBe(false);
      expect(mocks.setSetting).not.toHaveBeenCalled();
    }
  });

  it("an empty map is allowed (clears every week)", async () => {
    const res = await invokeAction({ intent: "save-sessions", weeklySessions: "{}" });
    expect(res.status).toBe(200);
    expect(mocks.setSetting.mock.calls[0][2]).toMatchObject({ weeklySessions: {} });
  });
});

describe("action edge cases", () => {
  it("unknown intent → 400, nothing saved", async () => {
    const res = await invokeAction({ intent: "nope" });
    expect(res.status).toBe(400);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a storage failure answers 422 with a plain toast instead of a crash", async () => {
    mocks.setSetting.mockRejectedValueOnce(new Error("db down"));
    const res = await invokeAction({ intent: "save-sessions", weeklySessions: "{}" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ActionBody;
    expect(body.ok).toBe(false);
    expect(body.toast).toContain("Not saved");
  });

  it("the actor falls back to admin@shop when the session has no user email", async () => {
    mocks.authenticateAdmin.mockResolvedValueOnce({
      admin: {},
      session: { shop: "cellexia.myshopify.com" },
    });
    await invokeAction({ intent: "save-sessions", weeklySessions: "{}" });
    expect(mocks.setSetting.mock.calls[0][3]).toBe("admin@cellexia.myshopify.com");
  });
});

// ── Pure parsers ─────────────────────────────────────────────────────────────

describe("exported parsers", () => {
  it("parseExcludeEmailsField splits on newline, comma and semicolon; lowercases; de-duplicates", () => {
    expect(
      route.parseExcludeEmailsField("A@x.io\r\nb@x.io,  C@X.IO ; a@x.io"),
    ).toEqual(["a@x.io", "b@x.io", "c@x.io"]);
    expect(route.parseExcludeEmailsField("")).toEqual([]);
    expect(() => route.parseExcludeEmailsField("nope")).toThrow(/does not look like an email/);
  });

  it("parseStartedAtField accepts ISO dates and empty; rejects everything else", () => {
    expect(route.parseStartedAtField("")).toBeNull();
    expect(route.parseStartedAtField("2026-09-01")).toBe("2026-09-01");
    expect(() => route.parseStartedAtField("2026-9-1")).toThrow();
    expect(() => route.parseStartedAtField("2026-02-30")).toThrow();
  });

  it("parseWeeklySessionsField accepts numbers and numeric strings, drops blanks, rejects bad keys", () => {
    expect(route.parseWeeklySessionsField("")).toEqual({});
    expect(
      route.parseWeeklySessionsField(JSON.stringify({ "2026-W01": 5, "2026-W02": "6", "2026-W03": null })),
    ).toEqual({ "2026-W01": 5, "2026-W02": 6 });
    expect(() => route.parseWeeklySessionsField(JSON.stringify({ W01: 5 }))).toThrow(/week/);
  });

  it("staffRecomputeSince: start date at 00:00 shop time, null without one or for a malformed value", () => {
    expect(route.staffRecomputeSince(null, "Europe/Zurich")).toBeNull();
    expect(route.staffRecomputeSince("", "Europe/Zurich")).toBeNull();
    expect(route.staffRecomputeSince("2026/09/01", "Europe/Zurich")).toBeNull();
    expect(route.staffRecomputeSince("2026-09-01", "Europe/Zurich")?.toISOString()).toBe(
      "2026-08-31T22:00:00.000Z",
    );
    expect(route.staffRecomputeSince("2026-09-01", "America/Los_Angeles")?.toISOString()).toBe(
      "2026-09-01T07:00:00.000Z",
    );
  });

  it("parseRangeParam / parseGroupParam / parseMarketParam / parseFreshParam", () => {
    expect(route.parseRangeParam(null)).toBe("all");
    expect(route.parseRangeParam("30")).toBe("30");
    expect(route.parseRangeParam("60")).toBe("all");
    expect(route.parseGroupParam(null)).toBe("variant");
    expect(route.parseGroupParam("revision")).toBe("revision");
    expect(route.parseMarketParam(null)).toBe("");
    expect(route.parseMarketParam(" eu ")).toBe("eu");
    expect(route.parseMarketParam("north-america_2")).toBe("north-america_2");
    expect(route.parseMarketParam("a b")).toBe("");
    expect(route.parseFreshParam("1")).toBe(true);
    expect(route.parseFreshParam("true")).toBe(true);
    expect(route.parseFreshParam("yes")).toBe(false);
  });
});

// ── Static shape pins ────────────────────────────────────────────────────────

describe("designer page + component shape", () => {
  it("the results route file uses the escaped (non-nested) name and the old nested name does not exist", () => {
    expect(fs.existsSync(path.join(ROOT, "app/routes/app.buy-box_.results.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, "app/routes/app.buy-box.results.tsx"))).toBe(false);
  });

  it("app.buy-box.tsx no longer queries design performance in its loader, has the Results tab, the label field and label display", () => {
    const source = readSource("app/routes/app.buy-box.tsx");
    expect(source).not.toMatch(/\bgetDesignPerformance\b/);
    expect(source).not.toContain("performance.rows");
    expect(source).not.toContain("performanceRows");
    expect(source).toContain('{ id: "results", content: "Results" }');
    expect(source).toContain("<DesignResults markets={markets} launchMode={launchMode} />");
    expect(source).toContain('label="Name this design (optional)"');
    expect(source).toContain("label: publishLabel");
    expect(source).toContain("rev.label");
    expect(source).toContain("parseLabelField(formData)");
  });

  it("design-results.tsx is client-safe: no *.server imports, no prisma, only types + probabilityBetterThan from design-measurement", () => {
    const source = readSource("app/components/design-results.tsx");
    const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)";/gms)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec, `server import leaked into the client component: ${spec}`).not.toMatch(/\.server$/);
      expect(spec).not.toBe("~/db.server");
    }
    expect(source).toContain('import { probabilityBetterThan } from "~/lib/design-measurement/types"');
    expect(source).toContain("useFetcher");
    expect(source).toContain("fresh=1");
    // Merchant-facing copy: no em dashes in the new tab.
    const jsxText = source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(jsxText).not.toContain("—");
  });

  it("merchant-facing preset copy points at the Results tab, not the removed 'Design performance' card", () => {
    // app.buy-box.tsx renders meta.croRationale in the preset picker; the
    // "Design performance" card was removed in v1.26.0 (the Results tab
    // replaced it), so no rationale may send the merchant to it.
    const source = readSource("app/lib/widget/presets.ts");
    expect(source).not.toContain("Design performance");
    expect(source).toContain("in the Results tab");
  });

  it("the settings help text no longer promises what the nightly job could not deliver: exclusions apply on save", () => {
    const source = readSource("app/components/design-results.tsx");
    expect(source).toContain("saving applies right away to the orders already recorded");
  });

  it("getDesignPerformance still exists for its other callers and is marked superseded", () => {
    const source = readSource("app/lib/analytics/queries.server.ts");
    expect(source).toMatch(/export async function getDesignPerformance/);
    expect(source).toMatch(/superseded by design-measurement\/scoreboard/i);
  });
});
