import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WidgetVisitorDay writer + readers (visits.server.ts, v1.27.0).
 *
 *  - parseVisitBeacon: the beacon grammar (e, d, p, vid required; c, dv, m
 *    optional) and "invalid = null" for every required field.
 *  - recordVisit: upsert on (shop, day, vid, design, preselect): view
 *    increments views (created with 1); engage sets engaged; atc sets
 *    addedToCart and, with mode "s", addedSubscription; engage/atc create
 *    the row with views 0 when no view landed first; identity columns are
 *    create-only; lastSeenAt refreshed on every event.
 *  - pruneVisits: deletes day keys strictly below the cutoff, computed in
 *    the given calendar.
 *  - recomputeVisitMarkets: rows with a country and no market get the
 *    handle from MarketCountryMap; capped; skipped on an empty map.
 *  - visitSummary: (designKey, designPreselect, day) groups over a shop-tz
 *    day range with a market filter; visits = rows, views = Σ, flags = rows
 *    where true; sorted.
 *  - hasVisits / firstVisitDay: unscoped presence probes over the shop-tz
 *    day range (any market, any design) for the scoreboard's "visits
 *    recorded" flag and its "since visits started" alignment.
 *  - lastVisitAt, TokenBucketLimiter, isBotUserAgent (whole-word crawler
 *    tokens: a device name containing "bot" is not a bot), visitDayKey.
 */

const dbMocks = vi.hoisted(() => ({
  upsert: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  deleteMany: vi.fn(async (_args?: unknown): Promise<{ count: number }> => ({ count: 0 })),
  findMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  updateMany: vi.fn(async (_args?: unknown): Promise<{ count: number }> => ({ count: 0 })),
  groupBy: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  loadMarketCountryMap: vi.fn(async (): Promise<Map<string, string>> => new Map()),
}));

vi.mock("~/db.server", () => ({
  default: {
    widgetVisitorDay: {
      upsert: dbMocks.upsert,
      deleteMany: dbMocks.deleteMany,
      findMany: dbMocks.findMany,
      updateMany: dbMocks.updateMany,
      groupBy: dbMocks.groupBy,
      findFirst: dbMocks.findFirst,
    },
  },
}));

vi.mock("~/lib/design-measurement/markets.server", () => ({
  loadMarketCountryMap: dbMocks.loadMarketCountryMap,
}));

import {
  TokenBucketLimiter,
  VISIT_MARKETS_RECOMPUTE_CAP,
  VISIT_RETENTION_DAYS,
  firstVisitDay,
  hasVisits,
  isBotUserAgent,
  lastVisitAt,
  parseVisitBeacon,
  pruneVisits,
  recomputeVisitMarkets,
  recordVisit,
  visitDayKey,
  visitSummary,
} from "~/lib/design-measurement/visits.server";

const argOf = (mock: { mock: { calls: unknown[] } }, call = 0): Record<string, unknown> =>
  ((mock.mock.calls[call] as unknown[] | undefined)?.[0] ?? {}) as Record<string, unknown>;

const NOW = new Date("2026-09-10T12:00:00Z");

const BASE = {
  shopId: "shop_1",
  day: "2026-09-10",
  vid: "abcdefghijklmnop",
  designKey: "subscription_max",
  designPreselect: "sub" as const,
  countryCode: "GB",
  marketHandle: "uk",
  deviceType: "mobile" as const,
  now: NOW,
};

const WHERE = {
  shopId_day_vid_designKey_designPreselect: {
    shopId: "shop_1",
    day: "2026-09-10",
    vid: "abcdefghijklmnop",
    designKey: "subscription_max",
    designPreselect: "sub",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.loadMarketCountryMap.mockResolvedValue(new Map());
  dbMocks.findMany.mockResolvedValue([]);
  dbMocks.groupBy.mockResolvedValue([]);
  dbMocks.findFirst.mockResolvedValue(null);
  dbMocks.deleteMany.mockResolvedValue({ count: 0 });
  dbMocks.updateMany.mockResolvedValue({ count: 0 });
});

const params = (q: Record<string, string>) => new URLSearchParams(q);
const GOOD = { e: "view", d: "subscription_max", p: "s", vid: "abcdefghijklmnop", c: "GB", dv: "m" };

describe("parseVisitBeacon", () => {
  it("parses a full beacon into the stored vocabulary", () => {
    expect(parseVisitBeacon(params({ ...GOOD, cur: "GBP", v: "123", pv: "abcd1234", t: "1" }))).toEqual({
      event: "view",
      designKey: "subscription_max",
      designPreselect: "sub",
      vid: "abcdefghijklmnop",
      countryCode: "GB",
      deviceType: "mobile",
      mode: null,
    });
  });

  it("maps p (s|o|u) and dv (m|t|d) and only atc carries a mode", () => {
    expect(parseVisitBeacon(params({ ...GOOD, p: "o", dv: "t" }))).toMatchObject({
      designPreselect: "one",
      deviceType: "tablet",
    });
    expect(parseVisitBeacon(params({ ...GOOD, p: "u", dv: "d" }))).toMatchObject({
      designPreselect: "u",
      deviceType: "desktop",
    });
    expect(parseVisitBeacon(params({ ...GOOD, e: "atc", m: "s" }))).toMatchObject({
      event: "atc",
      mode: "s",
    });
    expect(parseVisitBeacon(params({ ...GOOD, e: "atc", m: "o" }))).toMatchObject({ mode: "o" });
    // A mode on a view is meaningless and dropped; an atc without one is
    // still an add-to-cart (one-time by absence of evidence).
    expect(parseVisitBeacon(params({ ...GOOD, m: "s" }))).toMatchObject({ mode: null });
    expect(parseVisitBeacon(params({ ...GOOD, e: "atc" }))).toMatchObject({ event: "atc", mode: null });
    expect(parseVisitBeacon(params({ ...GOOD, e: "atc", m: "x" }))).toMatchObject({ mode: null });
  });

  it("returns null for any invalid REQUIRED field (e, d, p, vid)", () => {
    expect(parseVisitBeacon(params({ ...GOOD, e: "click" }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, e: "" }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, d: "Subscription Max!" }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, d: "" }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, p: "x" }))).toBeNull();
    const { p: _p, ...noP } = GOOD;
    expect(parseVisitBeacon(params(noP))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, vid: "short" }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, vid: "a".repeat(33) }))).toBeNull();
    expect(parseVisitBeacon(params({ ...GOOD, vid: "abc def ghijklmn" }))).toBeNull();
    expect(parseVisitBeacon(new URLSearchParams())).toBeNull();
  });

  it("degrades OPTIONAL fields to null instead of dropping the beacon", () => {
    expect(parseVisitBeacon(params({ ...GOOD, c: "", dv: "" }))).toMatchObject({
      countryCode: null,
      deviceType: null,
    });
    expect(parseVisitBeacon(params({ ...GOOD, c: "GBR", dv: "x" }))).toMatchObject({
      countryCode: null,
      deviceType: null,
    });
    // Lower-case ISO-2 is accepted (uppercased) so a theme that lowercases
    // Shopify.country still maps to a market.
    expect(parseVisitBeacon(params({ ...GOOD, c: "fr" }))).toMatchObject({ countryCode: "FR" });
    // The design key is sanitized, not rejected, for case/whitespace.
    expect(parseVisitBeacon(params({ ...GOOD, d: " Subscription_Max " }))).toMatchObject({
      designKey: "subscription_max",
    });
  });
});

describe("recordVisit", () => {
  it("view: creates the row with views 1 or increments views, refreshing lastSeenAt", async () => {
    await recordVisit({ ...BASE, event: "view", mode: null });
    expect(dbMocks.upsert).toHaveBeenCalledTimes(1);
    const args = argOf(dbMocks.upsert);
    expect(args.where).toEqual(WHERE);
    expect(args.create).toEqual({
      shopId: "shop_1",
      day: "2026-09-10",
      vid: "abcdefghijklmnop",
      designKey: "subscription_max",
      designPreselect: "sub",
      countryCode: "GB",
      marketHandle: "uk",
      deviceType: "mobile",
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      views: 1,
    });
    expect(args.update).toEqual({ views: { increment: 1 }, lastSeenAt: NOW });
  });

  it("engage: creates with views 0 + engaged, or sets engaged; never touches views on update", async () => {
    await recordVisit({ ...BASE, event: "engage", mode: null });
    const args = argOf(dbMocks.upsert);
    expect(args.create).toMatchObject({ views: 0, engaged: true });
    expect(args.update).toEqual({ engaged: true, lastSeenAt: NOW });
  });

  it("atc: addedToCart always; addedSubscription only with mode 's' (and never cleared on update)", async () => {
    await recordVisit({ ...BASE, event: "atc", mode: "s" });
    let args = argOf(dbMocks.upsert, 0);
    expect(args.create).toMatchObject({ views: 0, addedToCart: true, addedSubscription: true });
    expect(args.update).toEqual({ addedToCart: true, addedSubscription: true, lastSeenAt: NOW });

    await recordVisit({ ...BASE, event: "atc", mode: "o" });
    args = argOf(dbMocks.upsert, 1);
    expect(args.create).toMatchObject({ views: 0, addedToCart: true, addedSubscription: false });
    // A one-time add after a subscription add must not clear the flag: the
    // update carries no addedSubscription key at all.
    expect(args.update).toEqual({ addedToCart: true, lastSeenAt: NOW });
    expect(args.update).not.toHaveProperty("addedSubscription");

    await recordVisit({ ...BASE, event: "atc", mode: null });
    args = argOf(dbMocks.upsert, 2);
    expect(args.create).toMatchObject({ addedToCart: true, addedSubscription: false });
  });

  it("identity columns are create-only: an update never rewrites country / market / device", async () => {
    await recordVisit({ ...BASE, event: "view", mode: null, countryCode: null, marketHandle: null, deviceType: null });
    const args = argOf(dbMocks.upsert);
    expect(args.create).toMatchObject({ countryCode: null, marketHandle: null, deviceType: null });
    for (const key of ["countryCode", "marketHandle", "deviceType", "firstSeenAt"]) {
      expect(args.update).not.toHaveProperty(key);
    }
  });

  it("propagates a database failure (the route contains it, not the writer)", async () => {
    dbMocks.upsert.mockRejectedValueOnce(new Error("db down"));
    await expect(recordVisit({ ...BASE, event: "view", mode: null })).rejects.toThrow("db down");
  });
});

describe("visitDayKey", () => {
  it("is the calendar day in the shop timezone, not UTC", () => {
    // 23:30 UTC on Sep 10 is already Sep 11 in Zurich (UTC+2 in September)
    // and still Sep 10 in New York.
    const at = new Date("2026-09-10T23:30:00Z");
    expect(visitDayKey(at, "Europe/Zurich")).toBe("2026-09-11");
    expect(visitDayKey(at, "America/New_York")).toBe("2026-09-10");
    expect(visitDayKey(at, "UTC")).toBe("2026-09-10");
  });
});

describe("pruneVisits", () => {
  it("deletes rows whose day is strictly below the cutoff day (400 days by default), in the given calendar", async () => {
    dbMocks.deleteMany.mockResolvedValue({ count: 12 });
    const removed = await pruneVisits("shop_1", undefined, { now: NOW, tz: "UTC" });
    expect(removed).toBe(12);
    expect(VISIT_RETENTION_DAYS).toBe(400);
    // 2026-09-10 minus 400 days = 2025-08-06.
    expect(argOf(dbMocks.deleteMany)).toEqual({
      where: { shopId: "shop_1", day: { lt: "2025-08-06" } },
    });
  });

  it("honours a custom horizon and the shop calendar", async () => {
    // 2026-09-11T01:00 Zurich = 2026-09-10T23:00Z; minus 1 day is 2026-09-10 in Zurich.
    await pruneVisits("shop_1", 1, { now: new Date("2026-09-10T23:00:00Z"), tz: "Europe/Zurich" });
    expect(argOf(dbMocks.deleteMany)).toEqual({
      where: { shopId: "shop_1", day: { lt: "2026-09-10" } },
    });
  });
});

describe("recomputeVisitMarkets", () => {
  it("maps rows with a country and no market via MarketCountryMap, batching by handle", async () => {
    dbMocks.loadMarketCountryMap.mockResolvedValue(
      new Map([
        ["GB", "uk"],
        ["FR", "eu"],
        ["DE", "eu"],
      ]),
    );
    dbMocks.findMany.mockResolvedValue([
      { id: "v1", countryCode: "GB" },
      { id: "v2", countryCode: "FR" },
      { id: "v3", countryCode: "DE" },
      { id: "v4", countryCode: "US" }, // no market: left null
    ]);
    dbMocks.updateMany.mockImplementation(async (raw?: unknown) => {
      const args = raw as { where: { id: { in: string[] } } };
      return { count: args.where.id.in.length };
    });

    const result = await recomputeVisitMarkets("shop_1");
    expect(result).toEqual({ scanned: 4, updated: 3 });
    expect(argOf(dbMocks.findMany)).toMatchObject({
      where: { shopId: "shop_1", marketHandle: null, countryCode: { not: null } },
      take: VISIT_MARKETS_RECOMPUTE_CAP,
    });
    const writes = (dbMocks.updateMany.mock.calls as unknown[][]).map((c) => c[0]);
    expect(writes).toEqual(
      expect.arrayContaining([
        { where: { id: { in: ["v1"] } }, data: { marketHandle: "uk" } },
        { where: { id: { in: ["v2", "v3"] } }, data: { marketHandle: "eu" } },
      ]),
    );
    expect(writes).toHaveLength(2);
  });

  it("skips the pass on an EMPTY map (a refresh that never succeeded is not evidence)", async () => {
    dbMocks.loadMarketCountryMap.mockResolvedValue(new Map());
    const result = await recomputeVisitMarkets("shop_1");
    expect(result).toEqual({ scanned: 0, updated: 0 });
    expect(dbMocks.findMany).not.toHaveBeenCalled();
    expect(dbMocks.updateMany).not.toHaveBeenCalled();
  });
});

describe("visitSummary", () => {
  it("groups by (designKey, designPreselect, day) over shop-tz day keys with a market filter", async () => {
    dbMocks.groupBy.mockImplementation(async (raw?: unknown) => {
      const args = raw as { where: Record<string, unknown> };
      const w = args.where;
      if (w.engaged === true) {
        return [
          { designKey: "subscription_max", designPreselect: "sub", day: "2026-09-09", _count: { _all: 2 } },
        ];
      }
      if (w.addedToCart === true) {
        return [
          { designKey: "subscription_max", designPreselect: "sub", day: "2026-09-09", _count: { _all: 1 } },
          { designKey: "classic", designPreselect: "one", day: "2026-09-10", _count: { _all: 1 } },
        ];
      }
      if (w.addedSubscription === true) {
        return [
          { designKey: "subscription_max", designPreselect: "sub", day: "2026-09-09", _count: { _all: 1 } },
        ];
      }
      return [
        { designKey: "classic", designPreselect: "one", day: "2026-09-10", _count: { _all: 3 }, _sum: { views: 4 } },
        { designKey: "subscription_max", designPreselect: "sub", day: "2026-09-09", _count: { _all: 5 }, _sum: { views: 7 } },
        { designKey: "subscription_max", designPreselect: "u", day: "2026-09-09", _count: { _all: 1 }, _sum: { views: null } },
      ];
    });

    const rows = await visitSummary("shop_1", {
      since: new Date("2026-09-08T23:30:00Z"), // Sep 9 in Zurich
      until: new Date("2026-09-10T12:00:00Z"),
      marketHandle: "eu",
      tz: "Europe/Zurich",
    });

    expect(rows).toEqual([
      { designKey: "subscription_max", designPreselect: "sub", day: "2026-09-09", visits: 5, views: 7, engaged: 2, addedToCart: 1, addedSubscription: 1 },
      { designKey: "subscription_max", designPreselect: "u", day: "2026-09-09", visits: 1, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 },
      { designKey: "classic", designPreselect: "one", day: "2026-09-10", visits: 3, views: 4, engaged: 0, addedToCart: 1, addedSubscription: 0 },
    ]);

    expect(dbMocks.groupBy).toHaveBeenCalledTimes(4);
    const first = argOf(dbMocks.groupBy);
    expect(first).toEqual({
      by: ["designKey", "designPreselect", "day"],
      where: { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" }, marketHandle: "eu" },
      _count: { _all: true },
      _sum: { views: true },
    });
    const flagged = (dbMocks.groupBy.mock.calls as unknown[][]).slice(1).map((c) => (c[0] as { where: Record<string, unknown> }).where);
    expect(flagged).toEqual([
      { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" }, marketHandle: "eu", engaged: true },
      { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" }, marketHandle: "eu", addedToCart: true },
      { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" }, marketHandle: "eu", addedSubscription: true },
    ]);
  });

  it("since null = no lower bound; marketHandle null = every market", async () => {
    await visitSummary("shop_1", { since: null, until: NOW, marketHandle: null, tz: "UTC" });
    const first = argOf(dbMocks.groupBy);
    expect(first.where).toEqual({ shopId: "shop_1", day: { lte: "2026-09-10" } });
    expect(first.where).not.toHaveProperty("marketHandle");
  });

  it("returns [] when the shop has no rows in range", async () => {
    expect(await visitSummary("shop_1", { since: null, until: NOW, marketHandle: null, tz: "UTC" })).toEqual([]);
  });
});

describe("lastVisitAt", () => {
  it("returns the newest lastSeenAt or null", async () => {
    expect(await lastVisitAt("shop_1")).toBeNull();
    dbMocks.findFirst.mockResolvedValue({ lastSeenAt: NOW });
    expect(await lastVisitAt("shop_1")).toEqual(NOW);
    expect(argOf(dbMocks.findFirst)).toEqual({
      where: { shopId: "shop_1" },
      orderBy: { lastSeenAt: "desc" },
      select: { lastSeenAt: true },
    });
  });
});

describe("hasVisits (unscoped presence in the day range)", () => {
  it("is one indexed probe on (shopId, day) with NO market or design filter, true when any row exists", async () => {
    // WHY unscoped: the scoreboard's "visits recorded" flag must tell "the
    // beacon is not deployed" apart from "no visits matched this market";
    // a market-filtered summary cannot (rows with marketHandle null exist
    // for a market whose countries were mapped after the fact).
    dbMocks.findFirst.mockResolvedValue({ id: "v1" });
    expect(
      await hasVisits("shop_1", {
        since: new Date("2026-09-08T23:30:00Z"), // Sep 9 in Zurich
        until: new Date("2026-09-10T12:00:00Z"),
        tz: "Europe/Zurich",
      }),
    ).toBe(true);
    expect(dbMocks.findFirst).toHaveBeenCalledTimes(1);
    expect(argOf(dbMocks.findFirst)).toEqual({
      where: { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" } },
      select: { id: true },
    });
    const where = argOf(dbMocks.findFirst).where as Record<string, unknown>;
    expect(where).not.toHaveProperty("marketHandle");
    expect(where).not.toHaveProperty("designKey");
    expect(where).not.toHaveProperty("designPreselect");
  });

  it("false when the range holds no row; since null = no lower bound", async () => {
    expect(await hasVisits("shop_1", { since: null, until: NOW, tz: "UTC" })).toBe(false);
    expect(argOf(dbMocks.findFirst).where).toEqual({ shopId: "shop_1", day: { lte: "2026-09-10" } });
  });

  it("propagates a database failure (the scoreboard contains it)", async () => {
    dbMocks.findFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(hasVisits("shop_1", { since: null, until: NOW, tz: "UTC" })).rejects.toThrow("db down");
  });
});

describe("firstVisitDay (earliest day with a visit row in the range)", () => {
  it("is the min day key over the SAME unscoped day range, read as a top-1 ordered by day", async () => {
    dbMocks.findFirst.mockResolvedValue({ day: "2026-09-09" });
    expect(
      await firstVisitDay("shop_1", {
        since: new Date("2026-09-08T23:30:00Z"),
        until: new Date("2026-09-10T12:00:00Z"),
        tz: "Europe/Zurich",
      }),
    ).toBe("2026-09-09");
    expect(argOf(dbMocks.findFirst)).toEqual({
      where: { shopId: "shop_1", day: { gte: "2026-09-09", lte: "2026-09-10" } },
      orderBy: { day: "asc" },
      select: { day: true },
    });
  });

  it("returns null when the range holds no visits", async () => {
    expect(await firstVisitDay("shop_1", { since: null, until: NOW, tz: "UTC" })).toBeNull();
    expect(argOf(dbMocks.findFirst).where).toEqual({ shopId: "shop_1", day: { lte: "2026-09-10" } });
  });
});

describe("TokenBucketLimiter", () => {
  it("allows `limit` requests per window per key, refills continuously, and keys are independent", () => {
    const limiter = new TokenBucketLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("a", t0)).toBe(true);
    expect(limiter.take("a", t0)).toBe(false);
    expect(limiter.take("b", t0)).toBe(true); // other key unaffected
    // 20 s later one token (3 per 60 s) has refilled.
    expect(limiter.take("a", t0 + 20_000)).toBe(true);
    expect(limiter.take("a", t0 + 20_000)).toBe(false);
    // A full window later the bucket is full again.
    expect(limiter.take("a", t0 + 80_000)).toBe(true);
    expect(limiter.take("a", t0 + 80_000)).toBe(true);
    expect(limiter.take("a", t0 + 80_000)).toBe(true);
    expect(limiter.take("a", t0 + 80_000)).toBe(false);
  });

  it("sweeps idle keys once per window so the Map does not grow with the visitor population", () => {
    const limiter = new TokenBucketLimiter(60, 60_000);
    const t0 = 5_000_000;
    for (let i = 0; i < 100; i++) limiter.take(`v${i}`, t0);
    expect(limiter.size).toBe(100);
    // Within the window nothing is swept, even for new keys arriving.
    limiter.take("late", t0 + 30_000);
    expect(limiter.size).toBe(101);
    // A window after the first sweep opportunity, idle keys are gone; the
    // one that just spoke stays.
    limiter.take("late", t0 + 61_000);
    expect(limiter.size).toBe(1);
  });
});

describe("isBotUserAgent", () => {
  it("matches crawlers / headless / preview fetchers and nothing else", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 HeadlessChrome/120",
      "Chrome-Lighthouse",
      "Pingdom.com_bot_version_1.4",
      "Slackbot-LinkExpanding 1.0",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "WhatsApp/2.0 link preview",
      // Named crawlers spell "<name>bot" as one word: listed explicitly.
      "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)",
      "Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)",
      "DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)",
      "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
      "Mozilla/5.0 (compatible; PetalBot;+https://webmaster.petalsearch.com/site/petalbot)",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)",
      "TelegramBot (like TwitterBot)",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)",
      // Generic words count as whole words: "Robot" on its own is a bot.
      "Robot Framework",
      "Mozilla/5.0 (compatible; my crawler)",
      "spider/1.0",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(true);
    }
    for (const ua of [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
    // Absence is not evidence: the proxy may not forward a UA at all.
    expect(isBotUserAgent(null)).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
  });

  it("does NOT match a crawler token inside a device or app name (CUBOT phones are shoppers)", () => {
    // WHY: with a bare substring `bot`, every beacon from a Cubot phone was
    // dropped while its orders still landed in SubscribableOrder, so
    // conversion per design was inflated for that device population.
    for (const ua of [
      "Mozilla/5.0 (Linux; Android 11; CUBOT KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
      // "bot" / "preview" / "crawl" as PART of a longer word are not tokens.
      "Mozilla/5.0 (Linux; Android 10; Robotics Tab) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 12; TCL 30 SE) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 PreviewApp/1.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36 Scrawly/2.0",
      // Yandex's search app is a shopper's browser; only YandexBot is a crawler.
      "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 YandexSearch/23.10",
    ]) {
      expect(isBotUserAgent(ua), ua).toBe(false);
    }
  });
});
