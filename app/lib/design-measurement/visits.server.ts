import { toZonedTime, format as formatTz } from "date-fns-tz";
import prisma from "~/db.server";
import { loadMarketCountryMap } from "./markets.server";
import { sanitizeDesignKey } from "./shared";

/**
 * WidgetVisitorDay writer + readers (v1.27.0) — the storefront VISIT ledger
 * that pairs with the SubscribableOrder ORDER ledger.
 *
 * WHY: take rate (subscribed ÷ orders) says which design sells more
 * subscriptions per buyer, but not whether a design sells fewer buyers in
 * the first place. Conversion needs a denominator measured with the SAME
 * stamp as the orders (design key + preselect), which no Shopify Analytics
 * number carries. The buy-box embed sends a tiny beacon
 * (GET /apps/cellexia-subs/w) when the widget was really on screen, when the
 * shopper touched it and when our product was added to the cart; the route
 * (app/routes/proxy.w.tsx) validates and this module writes ONE row per
 * anonymous visitor per shop-day per (design, preselect). Only booleans and a
 * view count live on the row: no personal data, no IP, no user agent, no
 * page URL. `vid` is a browser-local random id, not a person.
 *
 * Volume: 3,000 beacons/minute/shop are accepted at most (route buckets), so
 * every write here is one indexed upsert and every read is a grouped
 * aggregate. Nothing here invalidates the scoreboard cache: the readout is
 * allowed to be up to 10 minutes stale (CONTRACT: cache unchanged), and a
 * beacon per page view invalidating it would defeat the cache entirely.
 */

export type VisitEvent = "view" | "engage" | "atc";
/** Stored designPreselect vocabulary: "u" = unknown (older buy-box.js). */
export type VisitPreselect = "sub" | "one" | "u";
export type VisitDeviceType = "mobile" | "tablet" | "desktop";

export const VISIT_EVENTS: readonly VisitEvent[] = ["view", "engage", "atc"];
/** Anonymous visitor id grammar (browser-local, 16 chars from the embed). */
export const VISIT_VID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
/** Rows recomputeVisitMarkets rewrites per call. */
export const VISIT_MARKETS_RECOMPUTE_CAP = 5000;
/** Default retention of the visit ledger (a little over the longest range). */
export const VISIT_RETENTION_DAYS = 400;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" of `at` in the shop timezone (WidgetVisitorDay.day). */
export function visitDayKey(at: Date, tz: string): string {
  return formatTz(toZonedTime(at, tz), "yyyy-MM-dd", { timeZone: tz });
}

// ── Beacon parsing (pure) ────────────────────────────────────────────────────

export interface ParsedVisitBeacon {
  event: VisitEvent;
  designKey: string;
  designPreselect: VisitPreselect;
  vid: string;
  countryCode: string | null;
  deviceType: VisitDeviceType | null;
  /** "s" (subscription) | "o" (one-time) on an atc; null otherwise. */
  mode: "s" | "o" | null;
}

/**
 * Validate the beacon query (see the embed's visit module for the grammar:
 * e, d, p, vid, c, dv, m; v/cur/pv/t are transport-only and ignored). Returns
 * null on ANY invalid required field: the route answers 204 either way, so
 * "invalid = silently dropped" is the whole error contract. Optional fields
 * degrade to null rather than failing the beacon: an unknown country or
 * device must not lose the visit.
 */
export function parseVisitBeacon(
  params: URLSearchParams,
): ParsedVisitBeacon | null {
  const e = params.get("e");
  if (e !== "view" && e !== "engage" && e !== "atc") return null;
  const designKey = sanitizeDesignKey(params.get("d"));
  if (!designKey) return null;
  const p = params.get("p");
  const designPreselect: VisitPreselect | null =
    p === "s" ? "sub" : p === "o" ? "one" : p === "u" ? "u" : null;
  if (!designPreselect) return null;
  const vid = params.get("vid") ?? "";
  if (!VISIT_VID_RE.test(vid)) return null;

  const cRaw = (params.get("c") ?? "").trim().toUpperCase();
  const countryCode = COUNTRY_RE.test(cRaw) ? cRaw : null;
  const dv = params.get("dv");
  const deviceType: VisitDeviceType | null =
    dv === "m" ? "mobile" : dv === "t" ? "tablet" : dv === "d" ? "desktop" : null;
  const m = params.get("m");
  const mode = e === "atc" && (m === "s" || m === "o") ? m : null;

  return { event: e, designKey, designPreselect, vid, countryCode, deviceType, mode };
}

/**
 * Crawlers, headless browsers and link-preview fetchers never see the
 * widget as a shopper does; their views would dilute conversion. Only used
 * when the proxy forwards a User-Agent at all (absence is not evidence).
 *
 * WHY three groups instead of a bare substring list: a bare `bot` matched
 * INSIDE device names ("CUBOT KINGKONG 5 Pro" is a phone) and silently
 * dropped every beacon of those shoppers, so their orders counted while
 * their visits did not and conversion was inflated for that device
 * population. Generic words therefore only count as whole words (a token
 * of their own, not part of a longer name), tool prefixes count when a
 * product name continues after them, and the crawlers that spell
 * "<name>bot" as one word are listed by name because the whole-word rule
 * cannot see them. `[^a-z]` with the i flag rejects upper-case letters too.
 * "yandex" on its own is NOT listed: YandexSearch is a shopper's mobile
 * browser; only its crawler names are.
 */
export const VISIT_BOT_UA_RE = new RegExp(
  [
    // Generic crawler words, whole-word only: "Robot Framework" is a bot,
    // "CUBOT" and "Robotics" are not.
    "(?:^|[^a-z])(?:bot|robot|crawler|crawl|spider|slurp|preview)(?![a-z])",
    // Tool prefixes: the product name continues after them (HeadlessChrome,
    // Chrome-Lighthouse, Pingdom.com_bot, facebookexternalhit/1.1).
    "(?:^|[^a-z])(?:headless|lighthouse|pingdom|facebookexternalhit)",
    // Named crawlers and link-preview fetchers ("<name>bot" as one word).
    [
      "googlebot",
      "bingbot",
      "yandexbot",
      "yandexmobilebot",
      "baiduspider",
      "duckduckbot",
      "applebot",
      "semrush",
      "ahrefs",
      "petalbot",
      "slackbot",
      "twitterbot",
      "discordbot",
      "linkedinbot",
      "telegrambot",
      "whatsapp",
      "bytespider",
      "gptbot",
      "claudebot",
      "ccbot",
      "amazonbot",
      "mj12bot",
      "dotbot",
      "seznambot",
      "ia_archiver",
    ].join("|"),
  ].join("|"),
  "i",
);

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && VISIT_BOT_UA_RE.test(userAgent);
}

// ── Token buckets (route rate limit) ─────────────────────────────────────────

/**
 * Per-key token buckets: `limit` tokens refilled continuously at
 * `limit / windowMs`. Per-INSTANCE state (a Map): with several server
 * instances behind one proxy the effective limit is N times the configured
 * one, which is fine for a defence against a runaway tab or a scripted
 * flood, not a security boundary. Idle keys are swept every `windowMs` so
 * the Map cannot grow with the visitor population.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60_000,
  ) {}

  /** Consume one token for `key`; false when the bucket is empty. */
  take(key: string, now: number = Date.now()): boolean {
    this.sweep(now);
    const bucket = this.buckets.get(key) ?? { tokens: this.limit, at: now };
    const refill = ((now - bucket.at) / this.windowMs) * this.limit;
    bucket.tokens = Math.min(this.limit, bucket.tokens + Math.max(0, refill));
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < this.windowMs) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      // A bucket idle for a full window has refilled completely: dropping it
      // is indistinguishable from keeping it.
      if (now - bucket.at >= this.windowMs) this.buckets.delete(key);
    }
  }
}

// ── Writer ───────────────────────────────────────────────────────────────────

export interface RecordVisitInput {
  shopId: string;
  /** Shop-timezone "YYYY-MM-DD" (visitDayKey). */
  day: string;
  vid: string;
  designKey: string;
  designPreselect: VisitPreselect;
  countryCode: string | null;
  marketHandle: string | null;
  deviceType: VisitDeviceType | null;
  event: VisitEvent;
  /** atc only: "s" when the subscription option was added. */
  mode: "s" | "o" | null;
  now?: Date;
}

/**
 * Upsert the visitor-day row for (shop, day, vid, design, preselect):
 *   view   → views + 1 (created with views 1);
 *   engage → engaged = true;
 *   atc    → addedToCart = true, addedSubscription = true when mode "s".
 * engage/atc create the row with views 0 when no view landed first (an
 * add-to-cart is still a visit; the beacon order is not guaranteed), and
 * every event refreshes lastSeenAt. Identity columns (country, market,
 * device) are written on create only: first seen wins, and a later beacon
 * carrying null must never blank them. May throw (DB); the route contains.
 */
export async function recordVisit(input: RecordVisitInput): Promise<void> {
  const now = input.now ?? new Date();
  const where = {
    shopId_day_vid_designKey_designPreselect: {
      shopId: input.shopId,
      day: input.day,
      vid: input.vid,
      designKey: input.designKey,
      designPreselect: input.designPreselect,
    },
  };
  const base = {
    shopId: input.shopId,
    day: input.day,
    vid: input.vid,
    designKey: input.designKey,
    designPreselect: input.designPreselect,
    countryCode: input.countryCode,
    marketHandle: input.marketHandle,
    deviceType: input.deviceType,
    firstSeenAt: now,
    lastSeenAt: now,
  };
  if (input.event === "view") {
    await prisma.widgetVisitorDay.upsert({
      where,
      create: { ...base, views: 1 },
      update: { views: { increment: 1 }, lastSeenAt: now },
    });
    return;
  }
  if (input.event === "engage") {
    await prisma.widgetVisitorDay.upsert({
      where,
      create: { ...base, views: 0, engaged: true },
      update: { engaged: true, lastSeenAt: now },
    });
    return;
  }
  const subscription = input.mode === "s";
  await prisma.widgetVisitorDay.upsert({
    where,
    create: {
      ...base,
      views: 0,
      addedToCart: true,
      addedSubscription: subscription,
    },
    update: {
      addedToCart: true,
      ...(subscription ? { addedSubscription: true } : {}),
      lastSeenAt: now,
    },
  });
}

// ── Maintenance (design_facts_backfill) ──────────────────────────────────────

/**
 * Delete rows older than `olderThanDays` (day key strictly below the cutoff
 * day). Day keys are shop-timezone dates, so the cutoff is computed in the
 * same calendar (`tz`; UTC when unknown, one day of slack at most). Returns
 * the number of rows removed. May throw; the backfill contains.
 */
export async function pruneVisits(
  shopId: string,
  olderThanDays: number = VISIT_RETENTION_DAYS,
  opts: { now?: Date; tz?: string } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = visitDayKey(new Date(now.getTime() - olderThanDays * DAY_MS), opts.tz ?? "UTC");
  const result = await prisma.widgetVisitorDay.deleteMany({
    where: { shopId, day: { lt: cutoff } },
  });
  return result.count;
}

export interface RecomputeVisitMarketsResult {
  scanned: number;
  updated: number;
}

/**
 * Rows written before MarketCountryMap was filled (or for a country added
 * to a market later) carry countryCode but marketHandle null; map them now.
 * Capped at VISIT_MARKETS_RECOMPUTE_CAP rows per call (oldest first so the
 * backlog drains in order). Same rule as the fact-row recompute: an EMPTY
 * map means the refresh never succeeded and the pass is skipped. May throw;
 * the backfill contains.
 */
export async function recomputeVisitMarkets(
  shopId: string,
): Promise<RecomputeVisitMarketsResult> {
  const result: RecomputeVisitMarketsResult = { scanned: 0, updated: 0 };
  const map = await loadMarketCountryMap(shopId);
  if (map.size === 0) return result;
  const rows = await prisma.widgetVisitorDay.findMany({
    where: { shopId, marketHandle: null, countryCode: { not: null } },
    orderBy: { firstSeenAt: "asc" },
    take: VISIT_MARKETS_RECOMPUTE_CAP,
    select: { id: true, countryCode: true },
  });
  result.scanned = rows.length;
  const idsByHandle = new Map<string, string[]>();
  for (const row of rows) {
    const handle = row.countryCode ? map.get(row.countryCode) : undefined;
    if (!handle) continue;
    const list = idsByHandle.get(handle) ?? [];
    list.push(row.id);
    idsByHandle.set(handle, list);
  }
  for (const [marketHandle, ids] of idsByHandle) {
    const updated = await prisma.widgetVisitorDay.updateMany({
      where: { id: { in: ids } },
      data: { marketHandle },
    });
    result.updated += updated.count;
  }
  return result;
}

// ── Readers (scoreboard) ─────────────────────────────────────────────────────

export interface VisitSummaryRow {
  designKey: string;
  designPreselect: string;
  /** Shop-timezone "YYYY-MM-DD". */
  day: string;
  /** Distinct visitors that day for this design × preselect (row count). */
  visits: number;
  views: number;
  engaged: number;
  addedToCart: number;
  addedSubscription: number;
}

export interface VisitSummaryOptions {
  /** Lower bound (inclusive) as an instant; null = no lower bound. */
  since: Date | null;
  /** Upper bound (inclusive) as an instant. */
  until: Date;
  /** Restrict to one market; null = every market (unknown included). */
  marketHandle: string | null;
  /** Shop IANA timezone: bounds are converted to day keys in it. */
  tz: string;
}

type SummaryGroup = {
  designKey: string;
  designPreselect: string;
  day: string;
  _count: { _all: number };
  _sum?: { views: number | null };
};

/**
 * Visits grouped by (designKey, designPreselect, day) over the shop-tz day
 * range [since, until]: visits = rows (distinct visitors), views = Σ views,
 * engaged / addedToCart / addedSubscription = rows where true. Four grouped
 * reads instead of one raw query so the mocks stay plain Prisma calls; the
 * indexes on (shopId, day) and (shopId, designKey, day) carry all four.
 * Sorted by day, designKey, designPreselect.
 */
export async function visitSummary(
  shopId: string,
  opts: VisitSummaryOptions,
): Promise<VisitSummaryRow[]> {
  const where = {
    ...dayRangeWhere(shopId, opts),
    ...(opts.marketHandle ? { marketHandle: opts.marketHandle } : {}),
  };
  const by = ["designKey", "designPreselect", "day"] as const;

  // No casts on the calls: Prisma infers groupBy's payload type from the
  // literal arguments, and a cast on the promise breaks that inference.
  const [all, engaged, atc, sub] = await Promise.all([
    prisma.widgetVisitorDay.groupBy({
      by: [...by],
      where,
      _count: { _all: true },
      _sum: { views: true },
    }),
    prisma.widgetVisitorDay.groupBy({
      by: [...by],
      where: { ...where, engaged: true },
      _count: { _all: true },
    }),
    prisma.widgetVisitorDay.groupBy({
      by: [...by],
      where: { ...where, addedToCart: true },
      _count: { _all: true },
    }),
    prisma.widgetVisitorDay.groupBy({
      by: [...by],
      where: { ...where, addedSubscription: true },
      _count: { _all: true },
    }),
  ]);

  const keyOf = (g: SummaryGroup) => `${g.day}\u0000${g.designKey}\u0000${g.designPreselect}`;
  const rows = new Map<string, VisitSummaryRow>();
  for (const g of all as SummaryGroup[]) {
    rows.set(keyOf(g), {
      designKey: g.designKey,
      designPreselect: g.designPreselect,
      day: g.day,
      visits: g._count._all,
      views: g._sum?.views ?? 0,
      engaged: 0,
      addedToCart: 0,
      addedSubscription: 0,
    });
  }
  const fold = (groups: SummaryGroup[], field: "engaged" | "addedToCart" | "addedSubscription") => {
    for (const g of groups) {
      const row = rows.get(keyOf(g));
      // A flagged row is always in `all` (same where, extra filter); a miss
      // means the reads raced a write, and the flag is dropped rather than
      // invented for a group with zero visits.
      if (row) row[field] = g._count._all;
    }
  };
  fold(engaged as SummaryGroup[], "engaged");
  fold(atc as SummaryGroup[], "addedToCart");
  fold(sub as SummaryGroup[], "addedSubscription");

  return [...rows.values()].sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.designKey.localeCompare(b.designKey) ||
      a.designPreselect.localeCompare(b.designPreselect),
  );
}

/**
 * Most recent beacon landed for the shop; null when no visit was ever
 * recorded. Backed by the (shopId, lastSeenAt) index (migration 0026), so
 * the top-1 is an index probe and not a sort of the shop's whole ledger on
 * every scoreboard cache miss.
 */
export async function lastVisitAt(shopId: string): Promise<Date | null> {
  const row = await prisma.widgetVisitorDay.findFirst({
    where: { shopId },
    orderBy: { lastSeenAt: "desc" },
    select: { lastSeenAt: true },
  });
  return row?.lastSeenAt ?? null;
}

export interface VisitPresenceOptions {
  /** Lower bound (inclusive) as an instant; null = no lower bound. */
  since: Date | null;
  /** Upper bound (inclusive) as an instant. */
  until: Date;
  /** Shop IANA timezone: bounds are converted to day keys in it. */
  tz: string;
}

/** Shop-tz day-key range shared by the presence readers (same rule as visitSummary). */
function dayRangeWhere(shopId: string, opts: VisitPresenceOptions) {
  const untilDay = visitDayKey(opts.until, opts.tz);
  const sinceDay = opts.since ? visitDayKey(opts.since, opts.tz) : null;
  return {
    shopId,
    day: { ...(sinceDay ? { gte: sinceDay } : {}), lte: untilDay },
  };
}

/**
 * Whether the SHOP has any visit row in the day range, in every market and
 * for every design. WHY unscoped: the scoreboard's "visits recorded" flag
 * decides between "the beacon is not deployed yet" and "no visits matched
 * this filter". A market whose rows still carry marketHandle null (country
 * mapped after the fact) has orders and no market-scoped visits; deciding
 * "not recorded" from the filtered summary would show the beacon warning
 * for a store whose beacon works. One indexed probe on (shopId, day).
 */
export async function hasVisits(shopId: string, opts: VisitPresenceOptions): Promise<boolean> {
  const row = await prisma.widgetVisitorDay.findFirst({
    where: dayRangeWhere(shopId, opts),
    select: { id: true },
  });
  return row != null;
}

/**
 * Earliest shop-tz day ("YYYY-MM-DD") with a visit row in the day range,
 * unscoped by market or design; null when the range holds no visits. The
 * scoreboard aligns conversion numerators to "since visits started" with
 * it. Top-1 on the (shopId, day) index.
 */
export async function firstVisitDay(
  shopId: string,
  opts: VisitPresenceOptions,
): Promise<string | null> {
  const row = await prisma.widgetVisitorDay.findFirst({
    where: dayRangeWhere(shopId, opts),
    orderBy: { day: "asc" },
    select: { day: true },
  });
  return row?.day ?? null;
}
