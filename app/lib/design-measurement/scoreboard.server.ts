import prisma from "~/db.server";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import {
  addWeeks,
  differenceInCalendarDays,
  format,
  startOfISOWeek,
} from "date-fns";
import { getSetting } from "~/lib/settings/settings.server";
import { addDaysTz, shopDayStartUtc } from "~/lib/dates.server";
import {
  COUNTABLE_CONTRACT,
  requireShopById,
} from "~/lib/analytics/queries.server";
import {
  churnEndOf,
  computeCohortRows,
  summarizeLtgp,
  ymIndex,
  ymKey,
} from "~/lib/analytics/cohorts.server";
import { designVariantLabel, presetDisplayName } from "./shared";
import type { DesignPeriod } from "./shared";
import type { LedgerRevision } from "./ledger.server";
import { probabilityBetterThan } from "./types";
import type {
  ConversionBlock,
  ConversionWeek,
  GuardrailBasis,
  GuardrailVerdict,
  MaturedRate,
  Scoreboard,
  ScoreboardComparison,
  ScoreboardGroupBy,
  ScoreboardMarket,
  ScoreboardQuery,
  VariantHygiene,
  VariantRow,
  VisitCounts,
  WeeklyBucket,
} from "./types";

export type {
  ConversionBlock,
  ConversionWeek,
  GuardrailBasis,
  GuardrailStatus,
  GuardrailVerdict,
  MaturedRate,
  Scoreboard,
  ScoreboardComparison,
  ScoreboardGrade,
  ScoreboardGroupBy,
  ScoreboardMarket,
  ScoreboardPreselect,
  ScoreboardQuery,
  ScoreboardTotals,
  VariantHygiene,
  VariantRow,
  VisitCounts,
  WeeklyBucket,
} from "./types";
export { probabilityBetterThan } from "./types";

/**
 * Design measurement scoreboard (v1.26.0) — the readout engine behind
 * Buy box designer → Results.
 *
 * Population: SubscribableOrder rows (the PII-free per-order fact written by
 * facts.server.ts) for the shop, in range, with staff = false. Every figure
 * on the Results tab derives from these rows plus a contract lookup for the
 * subscribed ones (churn end for the kept / quick-cancel rates) and the
 * cohort engine for LTGP. Rules, in one place so the UI never re-derives:
 *
 * - Staff / test-buyer orders (staff = true) are excluded from every count
 *   and reported as totals.excludedStaff (and per row as hygiene.staffExcluded
 *   so a design that only staff exercised is not silently empty).
 * - Foreign-only orders (ownership "foreign": another app's selling plan and
 *   none of our lines) are excluded from rows and totals and reported as
 *   totals.excludedForeignOnly. Orders that carry BOTH ("mixed") stay in the
 *   population (the shopper did see our product) and are flagged in hygiene.
 * - Orders with exposure = false AND designSource "none" (the widget never
 *   touched the order: bypass, hidden widget, other channel) sit in ONE
 *   synthetic row "no_exposure" so the merchant sees the bypass volume next
 *   to the designs instead of a mysteriously short total.
 * - Take rate = subscribed ÷ orders. Kept dN counts only orders old enough
 *   (processedAt + N days ≤ now); a subscriber is "kept" at N when its
 *   contract's churn end (churnEndOf — cancelledAt, failedAt for FAILED,
 *   expiredAt for EXPIRED; the identical rule the cohort engine uses) is
 *   null or after processedAt + N days. Quick cancel 14 = subscribers of
 *   14-day-old orders whose churn end fell within 14 days.
 * - LTGP per row runs the IDENTICAL cohort engine the analytics page uses
 *   (computeCohortRows over the row's contract ids + summarizeLtgp), so a
 *   design's LTGP and the whole-book LTGP are comparable figures — the same
 *   pattern as the segment layer (segment-views.server.ts).
 * - Weeks are ISO weeks (Monday start) in the shop timezone.
 * - Contract lookups spread COUNTABLE_CONTRACT (isDemo false, OURS_ONLY);
 *   a subscribed row whose contract is no longer countable/found counts as
 *   still kept (null churn end — the cohort engine's "never recorded" rule).
 *
 * Visits (v1.27.0): the storefront beacon writes WidgetVisitorDay (one row
 * per anonymous visitor per shop-tz day per design × preselect); the summary
 * from visits.server.ts is joined onto the rows BY THE SAME STAMP the facts
 * carry (design key + preselect / design key / the ledger's revision), so
 * conversion = orders ÷ exposed visits with the identical numerator and
 * denominator population. Rules:
 * - A design with visits but no order yet still gets a row (0 orders, N
 *   visits, conversion 0): the merchant sees a freshly published design is
 *   live and being seen instead of a missing line until the first order.
 * - Synthetic rows (no exposure / unknown) never get visits: every visit
 *   carries a design stamp, so nothing can join them.
 * - When the shop has NO visit rows in range (beacon not deployed, app embed
 *   disabled) or the visits module is unavailable, every row's visits is
 *   null and the UI says "visits not recorded yet"; a real row with no
 *   matching visits while others have some reads zeros. "Recorded" is an
 *   UNSCOPED presence check (visits.server hasVisits): a market filter whose
 *   visits are still unmapped (country not in the market map yet) reads
 *   zeros with totals.visitsRecorded true, never "not recorded". The visits
 *   read is contained: it can never blank the order-side readout.
 * - Time alignment: the beacon usually goes live after the first order, so
 *   the conversion numerators count only orders processed on a shop-tz day
 *   with at least one visit row for the SHOP (any design, any market: the
 *   covered-day set behind totals.visitCoverageDays). Whole-range orders over
 *   since-deploy visits would read 10x too high and contradict the weekly
 *   table; the counted numerators ride along on ConversionBlock so the UI
 *   can say "N orders since <day>". Take rate and kept rates are untouched.
 * - Kept subscribers per 100 visits matures BOTH sides on the day rule (day
 *   end + 30 days ≤ now); held.d30 keeps its instant rule for the kept RATE.
 * - Revision grouping maps a visit day onto the ledger revision live that
 *   day (the revision whose design for the queried market equals the visit's
 *   design key when a publish split the day; else the one live at day end),
 *   the same instant-based rule facts.server uses for designRevisionId. When
 *   the ledger is unavailable, revision rows read visits null.
 * - The weekly guardrail is judged on orders per 100 visits (basis
 *   "conversion", the primary verdict) whenever the reference and the row
 *   both have visits in ≥ 2 qualifying weeks, with the raw-orders verdict
 *   (basis "orders") always alongside as the fallback the UI shows otherwise.
 *   On the conversion basis a week qualifies on VISITS, not orders: a week
 *   with traffic and zero orders is the worst conversion week there is and
 *   contributes 0 per 100 (dropping it hid the exact collapse the guardrail
 *   exists to catch).
 *
 * Read-only derivation; failures are contained by the route (Golden rule 9).
 * The 10-minute module cache keeps the Results tab cheap: reads hit the cache
 * unless `fresh` is set; facts.server.ts calls invalidateScoreboardCache after
 * writes so a merchant refreshing right after an order sees it (visits are
 * deliberately NOT an invalidation source: a beacon per page view would
 * defeat the cache).
 */

// ── Settings shape (defensive normalisation) ────────────────────────────────

interface MeasurementSettings {
  startedAt: string | null;
  excludeEmails: string[];
  guardrailMaxOrderDropPct: number;
  guardrailMinOrdersPerWeek: number;
  weeklySessions: Record<string, number>;
}

const SETTINGS_DEFAULTS: MeasurementSettings = {
  startedAt: null,
  excludeEmails: [],
  guardrailMaxOrderDropPct: 10,
  guardrailMinOrdersPerWeek: 20,
  weeklySessions: {},
};

/**
 * The registry (settings/registry.server.ts) already validates the setting;
 * this only guards against an older stored blob or a missing key so the
 * scoreboard degrades to defaults instead of throwing on a shape surprise.
 */
function normalizeSettings(raw: unknown): MeasurementSettings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const sessions: Record<string, number> = {};
  if (o.weeklySessions && typeof o.weeklySessions === "object") {
    for (const [k, v] of Object.entries(
      o.weeklySessions as Record<string, unknown>,
    )) {
      if (/^\d{4}-W\d{2}$/.test(k) && typeof v === "number" && v >= 0) {
        sessions[k] = Math.floor(v);
      }
    }
  }
  return {
    startedAt:
      typeof o.startedAt === "string" && o.startedAt.length > 0
        ? o.startedAt
        : null,
    excludeEmails: Array.isArray(o.excludeEmails)
      ? o.excludeEmails.filter((e): e is string => typeof e === "string")
      : [],
    guardrailMaxOrderDropPct: num(
      o.guardrailMaxOrderDropPct,
      SETTINGS_DEFAULTS.guardrailMaxOrderDropPct,
    ),
    guardrailMinOrdersPerWeek: num(
      o.guardrailMinOrdersPerWeek,
      SETTINGS_DEFAULTS.guardrailMinOrdersPerWeek,
    ),
    weeklySessions: sessions,
  };
}

// ── Cache ────────────────────────────────────────────────────────────────────

const SCOREBOARD_CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  shopId: string;
  expiresAt: number;
  value: Scoreboard;
}

const cache = new Map<string, CacheEntry>();

function cacheKeyOf(q: ScoreboardQuery): string {
  // `fresh` and `now` are deliberately NOT part of the key: two reads a few
  // seconds apart must share one computation.
  return JSON.stringify({
    shopId: q.shopId,
    rangeDays: q.rangeDays,
    marketHandle: q.marketHandle,
    groupBy: q.groupBy,
  });
}

/** Drop every cached scoreboard of a shop (facts.server calls this after writes; publish calls it too). */
export function invalidateScoreboardCache(shopId: string): void {
  for (const [key, entry] of cache) {
    if (entry.shopId === shopId) cache.delete(key);
  }
}

// ── Week helpers (shop timezone, ISO weeks) ─────────────────────────────────

/** ISO week key ("2026-W35", Monday start) of an instant in the shop timezone. */
export function isoWeekKey(date: Date, tz: string): string {
  return format(toZonedTime(date, tz), "RRRR-'W'II");
}

/** Every ISO week key from the week containing `from` to the week containing `to`, inclusive, oldest first. */
function weekKeysBetween(from: Date, to: Date, tz: string): string[] {
  const keys: string[] = [];
  let cursor = startOfISOWeek(toZonedTime(from, tz));
  const end = startOfISOWeek(toZonedTime(to, tz));
  // Hard cap so a bad `from` (year 1970) can never spin the loop forever.
  for (let i = 0; i < 1000 && cursor.getTime() <= end.getTime(); i++) {
    keys.push(format(cursor, "RRRR-'W'II"));
    cursor = addWeeks(cursor, 1);
  }
  return keys;
}

// ── Row accumulation ─────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const HELD_HORIZONS = [30, 60, 90] as const;
const QUICK_CANCEL_DAYS = 14;

export const NO_EXPOSURE_KEY = "no_exposure";
export const UNKNOWN_KEY = "unknown";
/**
 * The synthetic row keys are RESERVED: a fact whose designKey equals one of
 * them can only come from a forged storefront property (the sanitizer accepts
 * any /^[a-z0-9_]{1,40}$/ value, and a shopper can POST any seen value to
 * /cart/add). Such a fact must never create or join a NON-synthetic row,
 * otherwise a forged "no_exposure" order placed before the first genuine
 * bypass order would turn the shared bucket into a real design (guardrail
 * reference-eligible, "chance it beats" comparable). They bucket into the
 * synthetic unknown row instead.
 */
const RESERVED_DESIGN_KEYS: ReadonlySet<string> = new Set([NO_EXPOSURE_KEY, UNKNOWN_KEY]);

interface FactRow {
  processedAt: Date;
  marketHandle: string | null;
  orderTotalCents: number | null;
  designKey: string | null;
  designPreselect: string | null;
  designRevisionId: string | null;
  designSource: string;
  calendarDesignKey: string | null;
  ownership: string;
  exposure: boolean;
  subscribed: boolean;
  contractId: string | null;
  promo: boolean;
  mixed: boolean;
  transition: boolean;
  staff: boolean;
}

interface Bucket {
  key: string;
  synthetic: boolean;
  orders: number;
  subscribed: number;
  designKeys: Map<string | null, number>;
  preselects: Map<string | null, number>;
  revisionIds: Map<string | null, number>;
  held: Record<30 | 60 | 90, { matureOrders: number; matureSubscribed: number; heldSubscribed: number }>;
  quick: { matureSubscribed: number; cancelled: number };
  weekly: Map<string, { orders: number; subscribed: number }>;
  /**
   * Per shop-tz day key: the counts the conversion numerators are built
   * from once the covered-day set is known (visits load after the facts).
   * keptD30 = subscribed, still live 30 days after the order AND the whole
   * day matured (day end + 30 days ≤ now): the day-based gate that mirrors
   * the matured-visits denominator, distinct from held[30] (instant gate).
   */
  days: Map<string, { orders: number; subscribed: number; keptD30: number }>;
  hygiene: VariantHygiene;
  totalCentsSum: number;
  totalCentsCount: number;
  contractIds: string[];
}

function newBucket(key: string, synthetic: boolean): Bucket {
  return {
    key,
    synthetic,
    orders: 0,
    subscribed: 0,
    designKeys: new Map(),
    preselects: new Map(),
    revisionIds: new Map(),
    held: {
      30: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0 },
      60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0 },
      90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0 },
    },
    quick: { matureSubscribed: 0, cancelled: 0 },
    weekly: new Map(),
    days: new Map(),
    hygiene: {
      promo: 0,
      mixed: 0,
      transition: 0,
      noExposure: 0,
      foreignPlan: 0,
      staffExcluded: 0,
      calendarDisagree: 0,
    },
    totalCentsSum: 0,
    totalCentsCount: 0,
    contractIds: [],
  };
}

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Most frequent key of a counter map (first seen wins ties); null for an empty map. */
function modeOf<K>(map: Map<K, number>): K | null {
  let best: K | null = null;
  let bestN = -1;
  for (const [k, n] of map) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * Which row an order fact belongs to. Synthetic keys: "no_exposure" for
 * orders the widget never touched, "unknown" for orders with exposure but no
 * resolvable design (an unparseable seen value, a designKey that collides
 * with a reserved synthetic key, or a revision-less row when grouping by
 * revision).
 */
function bucketKeyFor(
  row: FactRow,
  groupBy: ScoreboardGroupBy,
): { key: string; synthetic: boolean } {
  // A reserved key on a fact is treated as "no resolvable design" (see
  // RESERVED_DESIGN_KEYS): it may only ever land in a synthetic row.
  const designKey =
    row.designKey && !RESERVED_DESIGN_KEYS.has(row.designKey) ? row.designKey : null;
  if (!row.exposure && row.designSource === "none" && !designKey) {
    return { key: NO_EXPOSURE_KEY, synthetic: true };
  }
  if (groupBy === "revision") {
    return row.designRevisionId
      ? { key: row.designRevisionId, synthetic: false }
      : { key: UNKNOWN_KEY, synthetic: true };
  }
  if (!designKey) return { key: UNKNOWN_KEY, synthetic: true };
  if (groupBy === "design") return { key: designKey, synthetic: false };
  return {
    key: `${designKey}|${row.designPreselect ?? "unknown"}`,
    synthetic: false,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Share as a percentage, 1 decimal (take rate, kept rate, add-to-cart share). */
function pctOrNull(num: number, den: number): number | null {
  return den > 0 ? round1((num / den) * 100) : null;
}

/**
 * Per-100-visits rate, 2 decimals: these are small numbers (0.26 vs 0.34
 * kept subscribers per 100 visits is a 31% gap) that 1 decimal would
 * quantise into equality, and the guardrail already prints conversion with
 * 2 decimals, so the row and the verdict agree on the screen.
 */
function per100OrNull(num: number, den: number): number | null {
  return den > 0 ? round2((num / den) * 100) : null;
}

function gradeOf(orders: number): VariantRow["grade"] {
  if (orders < 30) return "too_early";
  if (orders < 200) return "direction_only";
  return "usable";
}

// ── Visits (v1.27.0) ─────────────────────────────────────────────────────────

/** Shape of visits.server.ts's visitSummary rows (typed locally: the module is imported lazily). */
interface VisitSummaryRow {
  designKey: string;
  designPreselect: string;
  day: string;
  visits: number;
  views: number;
  engaged: number;
  addedToCart: number;
  addedSubscription: number;
}

interface VisitAgg {
  counts: VisitCounts;
  /** Visitor-days per ISO week (shop tz). */
  weekly: Map<string, number>;
  /** Visitor-days on days old enough for the 30-day horizon (see ConversionBlock). */
  matureVisitsD30: number;
  designKeys: Map<string | null, number>;
  preselects: Map<string | null, number>;
}

function newVisitAgg(): VisitAgg {
  return {
    counts: { visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 },
    weekly: new Map(),
    matureVisitsD30: 0,
    designKeys: new Map(),
    preselects: new Map(),
  };
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function nonNegInt(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Normalised visitSummary payload; null when the read threw. */
async function readSummary(
  mod: typeof import("./visits.server"),
  shopId: string,
  opts: { since: Date | null; until: Date; marketHandle: string | null; tz: string },
  what: string,
): Promise<VisitSummaryRow[] | null> {
  try {
    const raw = await mod.visitSummary(shopId, opts);
    if (!Array.isArray(raw)) return null;
    const rows: VisitSummaryRow[] = [];
    for (const r of raw as unknown as Array<Record<string, unknown>>) {
      if (!r || typeof r.designKey !== "string" || typeof r.day !== "string") continue;
      if (!DAY_KEY_RE.test(r.day)) continue;
      rows.push({
        designKey: r.designKey,
        designPreselect: typeof r.designPreselect === "string" ? r.designPreselect : "u",
        day: r.day,
        visits: nonNegInt(r.visits),
        views: nonNegInt(r.views),
        engaged: nonNegInt(r.engaged),
        addedToCart: nonNegInt(r.addedToCart),
        addedSubscription: nonNegInt(r.addedSubscription),
      });
    }
    return rows;
  } catch (err) {
    console.error(`[design-measurement] ${what} failed`, err);
    return null;
  }
}

interface VisitsRead {
  /** Summary rows scoped like the facts (market filter applied); null when unavailable. */
  rows: VisitSummaryRow[] | null;
  /**
   * Whether the SHOP has at least one visit row in range regardless of the
   * market filter (visits.server hasVisits; falls back to the unscoped rows
   * when that check is unavailable). Drives "recorded" for every row.
   */
  recorded: boolean;
  /** Visitor-days in range across every market; null when unknown. */
  unscopedVisits: number | null;
  /** Shop-tz days in range with ≥ 1 visit row for the shop (unscoped); empty when unknown. */
  coverageDays: Set<string>;
  lastVisitAt: string | null;
}

/**
 * Defensive read of the visits module (contained, lazy): a missing module,
 * a thrown read or a shape surprise all yield null rows, which the rows
 * report as "visits not recorded". Each read sits in its own try so a
 * summary failure never hides the last-beacon time and vice versa.
 *
 * With a market filter the summary is market-scoped (rows join by stamp
 * within the market), but two facts stay SHOP-level on purpose: whether
 * visits are recorded at all (a market whose visits are not mapped yet must
 * read zeros, not "beacon not deployed") and which days the beacon covered
 * (the numerator gate of the conversion rates: "was the beacon live that
 * day" is a property of the shop, not of a market). Both come from one
 * extra unscoped summary read on market-scoped queries only; without a
 * filter the scoped rows are already the shop's.
 */
async function loadVisits(
  shopId: string,
  opts: { since: Date | null; until: Date; marketHandle: string | null; tz: string },
): Promise<VisitsRead> {
  const empty: VisitsRead = {
    rows: null,
    recorded: false,
    unscopedVisits: null,
    coverageDays: new Set(),
    lastVisitAt: null,
  };
  let mod: typeof import("./visits.server") | null = null;
  try {
    mod = await import("./visits.server");
  } catch (err) {
    console.error("[design-measurement] visits module unavailable", err);
    return empty;
  }
  const rows = await readSummary(mod, shopId, opts, "visit summary");
  const unscoped = opts.marketHandle
    ? await readSummary(mod, shopId, { ...opts, marketHandle: null }, "unscoped visit summary")
    : rows;

  const coverageDays = new Set<string>();
  let unscopedVisits: number | null = null;
  if (unscoped) {
    unscopedVisits = 0;
    for (const v of unscoped) {
      unscopedVisits += v.visits;
      if (v.visits > 0) coverageDays.add(v.day);
    }
  } else if (rows) {
    // The unscoped read failed but the scoped one landed: the market's own
    // visit days are a subset of the shop's and a far better numerator gate
    // than an empty set (which would zero every conversion rate).
    for (const v of rows) if (v.visits > 0) coverageDays.add(v.day);
  }

  // Presence check, unscoped: hasVisits (visits.server) when the module has
  // it. Read through an untyped handle so an older visits module without it
  // degrades to the unscoped rows instead of failing the import; a thrown
  // check degrades the same way. A numeric answer (a count) is accepted too.
  // The property read itself is guarded: a strict module proxy (a test
  // mock) throws on an export it does not define.
  let recorded: boolean | null = null;
  let hasVisits: unknown;
  try {
    hasVisits = (mod as unknown as { hasVisits?: unknown }).hasVisits;
  } catch {
    hasVisits = undefined;
  }
  if (typeof hasVisits === "function") {
    try {
      const r: unknown = await (
        hasVisits as (
          shopId: string,
          o: { since: Date | null; until: Date; tz: string },
        ) => Promise<unknown>
      )(shopId, { since: opts.since, until: opts.until, tz: opts.tz });
      if (typeof r === "boolean") recorded = r;
      else if (typeof r === "number" && Number.isFinite(r)) recorded = r > 0;
    } catch (err) {
      console.error("[design-measurement] visit presence check failed", err);
      recorded = null;
    }
  }
  if (recorded == null) recorded = (unscoped?.length ?? 0) > 0;

  let last: string | null = null;
  try {
    const at = await mod.lastVisitAt(shopId);
    if (at instanceof Date && !Number.isNaN(at.getTime())) last = at.toISOString();
    else if (typeof at === "string" && at) last = at;
  } catch (err) {
    console.error("[design-measurement] last visit lookup failed", err);
    last = null;
  }
  return { rows, recorded, unscopedVisits, coverageDays, lastVisitAt: last };
}

/** Stored visit preselect ("sub" | "one" | "u") → the fact vocabulary ("sub" | "one" | null). */
function visitPreselectToFact(p: string): string | null {
  return p === "sub" || p === "one" ? p : null;
}

/** Noon of a shop-tz day key as an instant (DST-safe anchor for week/day maths). */
function dayNoon(day: string, tz: string): Date {
  return fromZonedTime(`${day}T12:00:00`, tz);
}

/** Last instant of a shop-tz day key. */
function dayEnd(day: string, tz: string): Date {
  return fromZonedTime(`${day}T23:59:59.999`, tz);
}

/** Shop-tz day key ("YYYY-MM-DD") of an instant, the way WidgetVisitorDay.day is stored. */
function shopDayKey(at: Date, tz: string): string {
  return format(toZonedTime(at, tz), "yyyy-MM-dd");
}

/**
 * The 30-day maturity gate for the kept-per-100-visits metric, DAY based on
 * both sides: a shop-tz day has matured when its last instant is at least
 * 30 days old (day end + 30d ≤ now). The visits denominator can only be
 * gated per day (WidgetVisitorDay is a per-day fact), so the order-side
 * numerator uses the identical rule; gating orders by their instant (as
 * held.d30 does for the kept RATE) let the orders of the day exactly 30 days
 * ago in while that day's visits stayed out, biasing the metric upward every
 * single day.
 */
function dayMaturedD30(day: string, tz: string, now: Date): boolean {
  return dayEnd(day, tz).getTime() + 30 * DAY_MS <= now.getTime();
}

/**
 * Which ledger revision a visit day belongs to (revision grouping). Candidates
 * are the revision live at the day's start plus every revision published
 * during the day; the LAST candidate whose design for `marketHandle` equals
 * the visit's own design key wins (a publish that changed the design mid-day
 * splits that day's visits by their stamp), else the revision live at day
 * end. Null when no revision had been published by then. Memoised per day
 * by the caller; the ledger is small (published revisions of one shop).
 */
function revisionForVisitDay(
  ledger: Pick<typeof import("./ledger.server"), "resolveDesignFromRevisions">,
  revisions: LedgerRevision[],
  day: string,
  designKey: string,
  marketHandle: string | null,
  tz: string,
): string | null {
  const start = fromZonedTime(`${day}T00:00:00`, tz);
  const end = dayEnd(day, tz);
  const instants: Date[] = [start];
  for (const r of revisions) {
    const t = r.publishedAt.getTime();
    if (t > start.getTime() && t <= end.getTime()) instants.push(r.publishedAt);
  }
  let fallback: string | null = null;
  let match: string | null = null;
  for (const at of instants) {
    const resolved = ledger.resolveDesignFromRevisions(revisions, at, marketHandle);
    if (!resolved) continue;
    fallback = resolved.revisionId;
    if (resolved.designKey === designKey) match = resolved.revisionId;
  }
  return match ?? fallback;
}

/** Row key a visit summary row joins under, or null when it joins nothing (reserved key, unresolvable revision). */
function visitKeyFor(
  row: VisitSummaryRow,
  groupBy: ScoreboardGroupBy,
  revisionOf: (day: string, designKey: string) => string | null,
): string | null {
  if (RESERVED_DESIGN_KEYS.has(row.designKey)) return null;
  if (groupBy === "revision") return revisionOf(row.day, row.designKey);
  if (groupBy === "design") return row.designKey;
  return `${row.designKey}|${visitPreselectToFact(row.designPreselect) ?? "unknown"}`;
}

const NULL_CONVERSION: ConversionBlock = {
  ordersPer100Visits: null,
  subscriptionsPer100Visits: null,
  keptSubscribersPer100VisitsD30: null,
  addToCartPct: null,
  subscriptionPickPct: null,
  ordersCounted: 0,
  subscribedCounted: 0,
  keptCounted: 0,
  maturedVisits: 0,
  firstVisitDay: null,
};

/** The row's order-side counts restricted to covered days (see Bucket.days). */
interface CountedNumerators {
  orders: number;
  subscribed: number;
  keptD30: number;
}

/**
 * Sum of a bucket's per-day counts over the covered days: the time-aligned
 * numerators. A bucket with no orders (visit-only row) sums to zeros.
 */
function countedOn(bucket: Bucket, coverageDays: ReadonlySet<string>): CountedNumerators {
  const out: CountedNumerators = { orders: 0, subscribed: 0, keptD30: 0 };
  for (const [day, t] of bucket.days) {
    if (!coverageDays.has(day)) continue;
    out.orders += t.orders;
    out.subscribed += t.subscribed;
    out.keptD30 += t.keptD30;
  }
  return out;
}

function conversionFor(
  agg: VisitAgg | null,
  counted: CountedNumerators,
  firstVisitDay: string | null,
): ConversionBlock {
  if (!agg) return NULL_CONVERSION;
  const v = agg.counts;
  return {
    ordersPer100Visits: per100OrNull(counted.orders, v.visits),
    subscriptionsPer100Visits: per100OrNull(counted.subscribed, v.visits),
    keptSubscribersPer100VisitsD30: per100OrNull(counted.keptD30, agg.matureVisitsD30),
    addToCartPct: pctOrNull(v.addedToCart, v.visits),
    subscriptionPickPct: pctOrNull(v.addedSubscription, v.addedToCart),
    ordersCounted: counted.orders,
    subscribedCounted: counted.subscribed,
    keptCounted: counted.keptD30,
    maturedVisits: agg.matureVisitsD30,
    firstVisitDay,
  };
}

// ── Comparison vs the reference (v1.27.0) ────────────────────────────────────

/**
 * Row minus reference in points from the UNROUNDED ratios (num ÷ den × 100
 * each side), rounded once to 2 decimals; null when either denominator is 0.
 * Subtracting the rows' displayed (rounded) values instead erased real gaps:
 * 26 and 34 kept per 10,000 visits both display as 0.3 and would delta 0.
 */
function deltaPts(
  rowNum: number,
  rowDen: number,
  refNum: number,
  refDen: number,
): number | null {
  if (!(rowDen > 0) || !(refDen > 0)) return null;
  const num = (n: number): number => (Number.isFinite(n) ? n : 0);
  return round2((num(rowNum) / rowDen) * 100 - (num(refNum) / refDen) * 100);
}

/**
 * Every non-synthetic row other than the reference, compared with it. The
 * reference is the real row with most orders (first in the orders-desc row
 * order, so it is the SAME row the guardrail uses). Deltas are row minus
 * reference in points from the raw counts on the rows; the visit-based ones
 * use the time-aligned numerators (conversion.ordersCounted etc.), never the
 * whole-range orders. Chances come from probabilityBetterThan over the same
 * raw counts and are null when either side has no denominator (no visits,
 * no orders, no matured subscriber). Pure and exported for tests.
 */
export function computeComparison(rows: VariantRow[]): ScoreboardComparison[] {
  const real = rows.filter(
    (r) => r.key !== NO_EXPOSURE_KEY && r.key !== UNKNOWN_KEY,
  );
  if (real.length < 2) return [];
  const ref = [...real].sort((a, b) => b.orders - a.orders)[0];
  const out: ScoreboardComparison[] = [];
  for (const row of real) {
    if (row.key === ref.key) continue;
    const refVisits = ref.visits?.visits ?? 0;
    const rowVisits = row.visits?.visits ?? 0;
    const refC = ref.conversion;
    const rowC = row.conversion;
    out.push({
      key: row.key,
      vsKey: ref.key,
      deltas: {
        conversionPts: deltaPts(rowC.ordersCounted, rowVisits, refC.ordersCounted, refVisits),
        subscriptionConversionPts: deltaPts(
          rowC.subscribedCounted,
          rowVisits,
          refC.subscribedCounted,
          refVisits,
        ),
        takeRatePts: deltaPts(row.subscribed, row.orders, ref.subscribed, ref.orders),
        kept30Pts: deltaPts(
          row.held.d30.heldSubscribed,
          row.held.d30.matureSubscribed,
          ref.held.d30.heldSubscribed,
          ref.held.d30.matureSubscribed,
        ),
        keptPer100VisitsD30: deltaPts(
          rowC.keptCounted,
          rowC.maturedVisits,
          refC.keptCounted,
          refC.maturedVisits,
        ),
      },
      chance: {
        conversion:
          refVisits > 0 && rowVisits > 0
            ? probabilityBetterThan(refC.ordersCounted, refVisits, rowC.ordersCounted, rowVisits)
            : null,
        takeRate:
          ref.orders > 0 && row.orders > 0
            ? probabilityBetterThan(ref.subscribed, ref.orders, row.subscribed, row.orders)
            : null,
        kept30:
          ref.held.d30.matureSubscribed > 0 && row.held.d30.matureSubscribed > 0
            ? probabilityBetterThan(
                ref.held.d30.heldSubscribed,
                ref.held.d30.matureSubscribed,
                row.held.d30.heldSubscribed,
                row.held.d30.matureSubscribed,
              )
            : null,
      },
    });
  }
  return out;
}

// ── Guardrail ────────────────────────────────────────────────────────────────

/**
 * Weekly-orders guardrail. The metric ladder starts with "orders per week
 * must hold": a design that lifts take rate by suppressing one-time buyers
 * is a loss, so each design's mean weekly orders is compared against the
 * reference (the row with most orders — the incumbent).
 *
 * A week QUALIFIES for a row when the row had at least one order in it (a
 * week with none is a week the design was not on the page, not a
 * catastrophe) and it is not a PARTIAL week: the current week (always looks
 * like a drop) and the range's leading week when the range starts after
 * that week's Monday 00:00 shop time (a 30/90/365-day range or a start date
 * lands on an arbitrary weekday, so the first week holds only its tail
 * days; counting it as full diluted the reference mean and turned a real
 * breach into "watch"). minOrdersPerWeek is a floor on the REFERENCE, not on
 * the challenger: guardrails are only meaningful once the incumbent
 * averages at least that many orders per week — and a challenger that
 * collapses orders far below the floor must read as a breach, never as
 * "insufficient" (an earlier draft filtered the challenger's own weeks by
 * the floor, which hid exactly the failure the guardrail exists for).
 * Verdicts:
 * - insufficient: fewer than 2 qualifying weeks for the row, or the
 *   reference has fewer than 2 qualifying weeks or averages below the floor;
 * - breach: the row's mean over its qualifying weeks is below the reference
 *   mean by more than maxOrderDropPct AND at least 2 qualifying weeks are
 *   individually below the reference mean by more than that;
 * - watch: the mean drop is between half the threshold and the threshold
 *   (or beyond it without 2 individually-breaching weeks yet);
 * - ok: otherwise. The reference row itself is always ok.
 * Synthetic rows (no exposure / unknown) get no verdict.
 *
 * Conversion basis (v1.27.0): the identical rule is ALSO run on weekly
 * orders per 100 visits when the reference and the row each have at least
 * 2 qualifying weeks that carry visits; those verdicts carry basis
 * "conversion" and are the primary reading, because a design that simply
 * received less traffic (a quieter week, a market rollout) is not a design
 * that suppresses orders. On this basis a week qualifies on VISITS > 0 (not
 * current, not partial), whatever its orders: with traffic recorded, "the
 * design was on the page" is known from the visits, and a week with 1,000
 * exposed visits and zero orders is the worst possible conversion week
 * (0 per 100), not a week to skip (an earlier draft reused the orders > 0
 * qualifier and read a collapse of that shape as "holding"). The orders > 0
 * qualifier stays for the orders basis and for the reference floor.
 * The floor stays on the reference's weekly ORDERS for both bases (a
 * conversion read over a handful of orders is noise whatever the traffic).
 * The raw-orders verdict (basis "orders") is always present per real row as
 * the fallback the UI shows when no conversion verdict exists; when both
 * exist the conversion verdict comes first.
 */
export function computeGuardrailVerdicts(
  rows: Array<{
    key: string;
    synthetic: boolean;
    orders: number;
    weekly: Array<{ week: string; orders: number; visits?: number }>;
  }>,
  opts: {
    maxOrderDropPct: number;
    minOrdersPerWeek: number;
    currentWeek: string | null;
    /** Further weeks that are not whole (the range's leading partial week); never qualify. */
    partialWeeks?: ReadonlySet<string>;
  },
): GuardrailVerdict[] {
  const real = rows.filter((r) => !r.synthetic);
  if (real.length === 0) return [];
  const reference = [...real].sort((a, b) => b.orders - a.orders)[0];
  const orders = judgeBasis(real, reference, opts, "orders");
  const conversion = judgeBasis(real, reference, opts, "conversion");
  const verdicts: GuardrailVerdict[] = [];
  for (const row of real) {
    const c = conversion.get(row.key);
    if (c) verdicts.push(c);
    const o = orders.get(row.key);
    if (o) verdicts.push(o);
  }
  return verdicts;
}

type GuardrailRow = {
  key: string;
  orders: number;
  weekly: Array<{ week: string; orders: number; visits?: number }>;
};

/** One basis of the guardrail rule (see computeGuardrailVerdicts); keyed by row. */
function judgeBasis(
  real: GuardrailRow[],
  reference: GuardrailRow,
  opts: {
    maxOrderDropPct: number;
    minOrdersPerWeek: number;
    currentWeek: string | null;
    partialWeeks?: ReadonlySet<string>;
  },
  basis: GuardrailBasis,
): Map<string, GuardrailVerdict> {
  const out = new Map<string, GuardrailVerdict>();
  const floor = Math.max(0, opts.minOrdersPerWeek);
  const partial = opts.partialWeeks ?? new Set<string>();
  const isWholeWeek = (w: { week: string }): boolean =>
    w.week !== opts.currentWeek && !partial.has(w.week);
  // Orders basis: a week qualifies with orders > 0 (a week with none is a
  // week the design was not on the page). Conversion basis: a week qualifies
  // with visits > 0, orders may be 0 (contributing 0 per 100): the visits
  // prove the design was on the page, and a zero-order traffic week is the
  // collapse the guardrail exists to catch.
  const isFullWeek = (w: { week: string; orders: number }): boolean =>
    isWholeWeek(w) && w.orders > 0;
  const ordersSeries = (r: GuardrailRow): number[] =>
    r.weekly.filter(isFullWeek).map((w) => w.orders);
  const conversionSeries = (r: GuardrailRow): number[] =>
    r.weekly
      .filter((w) => isWholeWeek(w) && (w.visits ?? 0) > 0)
      .map((w) => (w.orders / (w.visits as number)) * 100);
  const series = basis === "orders" ? ordersSeries : conversionSeries;
  const mean = (xs: number[]): number =>
    xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
  // Display: orders read whole-ish (1 decimal); orders per 100 visits are
  // small numbers (2.35 vs 2.10), so they keep 2 decimals.
  const fmt = (n: number): number =>
    basis === "orders" ? round1(n) : Math.round(n * 100) / 100;
  const unit = basis === "orders" ? "orders per week" : "orders per 100 visits per week";
  const metricName = basis === "orders" ? "Orders" : "Conversion";

  const refOrders = ordersSeries(reference);
  const refReady = refOrders.length >= 2 && mean(refOrders) >= floor;
  const refWeeks = series(reference);
  const refMean = mean(refWeeks);
  // The conversion basis only exists once the reference is judgeable on
  // orders AND has 2 weeks with visits; otherwise the orders verdicts alone
  // speak (they already explain why the reference is not ready).
  if (basis === "conversion" && (!refReady || refWeeks.length < 2)) return out;

  for (const row of real) {
    if (row.key === reference.key) {
      out.set(row.key, {
        key: row.key,
        basis,
        status: refReady ? "ok" : "insufficient",
        detail: refReady
          ? `Reference design (most orders): ${fmt(refMean)} ${unit} over ${refWeeks.length} full weeks.`
          : refWeeks.length < 2
            ? `Reference design (most orders): only ${refWeeks.length} full week${refWeeks.length === 1 ? "" : "s"} with orders so far. Guardrails need 2.`
            : `Reference design (most orders): ${fmt(refMean)} orders per week is below the ${floor}-orders-per-week floor, so no design can be judged yet. Lower the floor in the settings if your store is smaller.`,
      });
      continue;
    }
    const weeks = series(row);
    // Conversion: a row without 2 weeks of visits gets no conversion verdict
    // at all; its orders verdict is the fallback.
    if (basis === "conversion" && weeks.length < 2) continue;
    if (weeks.length < 2 || !refReady) {
      out.set(row.key, {
        key: row.key,
        basis,
        status: "insufficient",
        detail: !refReady
          ? `The reference design does not have 2 full weeks averaging at least ${floor} orders yet.`
          : `Only ${weeks.length} full week${weeks.length === 1 ? "" : "s"} with orders for this design. Guardrails need 2.`,
      });
      continue;
    }
    const rowMean = mean(weeks);
    const dropPct = refMean > 0 ? ((refMean - rowMean) / refMean) * 100 : 0;
    const breachingWeeks = weeks.filter(
      (n) => refMean > 0 && ((refMean - n) / refMean) * 100 > opts.maxOrderDropPct,
    ).length;
    const summary = `${fmt(rowMean)} vs ${fmt(refMean)} ${unit} (${dropPct >= 0 ? "down" : "up"} ${round1(Math.abs(dropPct))}%) over ${weeks.length} full weeks`;
    if (dropPct > opts.maxOrderDropPct && breachingWeeks >= 2) {
      out.set(row.key, {
        key: row.key,
        basis,
        status: "breach",
        detail: `${summary}; ${breachingWeeks} weeks each more than ${opts.maxOrderDropPct}% below the reference. ${metricName} ${basis === "orders" ? "are" : "is"} not holding: revert or investigate before reading take rate.`,
      });
    } else if (dropPct > opts.maxOrderDropPct / 2) {
      out.set(row.key, {
        key: row.key,
        basis,
        status: "watch",
        detail: `${summary}; within the ${opts.maxOrderDropPct}% tolerance${dropPct > opts.maxOrderDropPct ? " on single weeks" : ""} but worth watching.`,
      });
    } else {
      out.set(row.key, {
        key: row.key,
        basis,
        status: "ok",
        detail: `${summary}. ${metricName} ${basis === "orders" ? "are" : "is"} holding.`,
      });
    }
  }
  return out;
}

// ── The engine ───────────────────────────────────────────────────────────────

/** Since-instant for the query: a trailing range never reaches behind designMeasurement.startedAt. */
function sinceFor(
  q: ScoreboardQuery,
  now: Date,
  tz: string,
  startedAt: string | null,
): Date | null {
  let floor: Date | null = null;
  if (startedAt && /^\d{4}-\d{2}-\d{2}$/.test(startedAt)) {
    const parsed = fromZonedTime(`${startedAt}T00:00:00`, tz);
    if (!Number.isNaN(parsed.getTime())) floor = parsed;
  }
  if (q.rangeDays == null || !(q.rangeDays > 0)) return floor;
  const rangeStart = shopDayStartUtc(addDaysTz(now, -q.rangeDays, tz), tz);
  return floor && floor.getTime() > rangeStart.getTime() ? floor : rangeStart;
}

/**
 * The scoreboard for a shop / range / market / grouping. See the module doc
 * for the rules. Cached 10 minutes per (shopId, rangeDays, marketHandle,
 * groupBy); `fresh` bypasses and refills the cache.
 */
export async function getScoreboard(q: ScoreboardQuery): Promise<Scoreboard> {
  const key = cacheKeyOf(q);
  const nowMs = Date.now();
  if (!q.fresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > nowMs) return { ...hit.value, cached: true };
  }
  const value = await computeScoreboard(q);
  cache.set(key, {
    shopId: q.shopId,
    expiresAt: nowMs + SCOREBOARD_CACHE_TTL_MS,
    value,
  });
  return value;
}

async function computeScoreboard(q: ScoreboardQuery): Promise<Scoreboard> {
  const now = q.now ?? new Date();
  const shop = await requireShopById(q.shopId);
  const tz = shop.ianaTimezone;
  const settings = normalizeSettings(
    await getSetting(q.shopId, "designMeasurement"),
  );
  const since = sinceFor(q, now, tz, settings.startedAt);

  // One query for the whole in-range population; staff, foreign-only and
  // the market filter are applied in JS so the exclusions can be COUNTED
  // and the market list keeps per-market volumes across the whole range.
  const facts = (await prisma.subscribableOrder.findMany({
    where: {
      shopId: q.shopId,
      // Never read past `now`: an injected clock (tests, replays) must see
      // the same population a live read at that instant would have.
      processedAt: since ? { gte: since, lte: now } : { lte: now },
    },
    select: {
      processedAt: true,
      marketHandle: true,
      orderTotalCents: true,
      designKey: true,
      designPreselect: true,
      designRevisionId: true,
      designSource: true,
      calendarDesignKey: true,
      ownership: true,
      exposure: true,
      subscribed: true,
      contractId: true,
      promo: true,
      mixed: true,
      transition: true,
      staff: true,
    },
    orderBy: { processedAt: "asc" },
  })) as FactRow[];

  // Markets: every market on record plus any handle seen on an order, with
  // order volume across the WHOLE range (before the market filter) so the
  // Results tab's market selector shows what each option holds.
  const marketRows = (await prisma.marketCountryMap.findMany({
    where: { shopId: q.shopId },
    select: { marketHandle: true, marketName: true },
  })) as Array<{ marketHandle: string; marketName: string | null }>;
  const marketNames = new Map<string, string | null>();
  for (const m of marketRows) {
    if (!marketNames.has(m.marketHandle) || m.marketName) {
      marketNames.set(m.marketHandle, m.marketName ?? marketNames.get(m.marketHandle) ?? null);
    }
  }
  const marketOrders = new Map<string, number>();
  for (const f of facts) {
    if (f.staff || f.ownership === "foreign" || !f.marketHandle) continue;
    bump(marketOrders, f.marketHandle);
  }
  const markets: ScoreboardMarket[] = [
    ...new Set([...marketNames.keys(), ...marketOrders.keys()]),
  ]
    .map((handle) => ({
      handle,
      name: marketNames.get(handle) ?? null,
      orders: marketOrders.get(handle) ?? 0,
    }))
    .sort((a, b) => b.orders - a.orders || a.handle.localeCompare(b.handle));

  const scoped = q.marketHandle
    ? facts.filter((f) => f.marketHandle === q.marketHandle)
    : facts;

  // ── Split the population ──
  const buckets = new Map<string, Bucket>();
  const bucketFor = (k: { key: string; synthetic: boolean }): Bucket => {
    let b = buckets.get(k.key);
    if (!b) {
      b = newBucket(k.key, k.synthetic);
      buckets.set(k.key, b);
    }
    return b;
  };
  // Excluded rows keyed to the design they WOULD have joined, attached to
  // hygiene only after the real rows exist (an exclusion never creates a row).
  const staffByKey = new Map<string, number>();
  const foreignByKey = new Map<string, number>();

  const totals = {
    orders: 0,
    subscribed: 0,
    excludedStaff: 0,
    excludedForeignOnly: 0,
    noExposure: 0,
    unattributedSubscribed: 0,
    seenRows: 0,
    calendarComparable: 0,
    calendarAgree: 0,
  };
  const weekTotals = new Map<string, { orders: number; subscribed: number }>();
  const contractIdSet = new Set<string>();

  const population: Array<{ fact: FactRow; bucket: Bucket; week: string }> = [];
  for (const f of scoped) {
    const k = bucketKeyFor(f, q.groupBy);
    if (f.staff) {
      totals.excludedStaff++;
      bump(staffByKey, k.key);
      continue;
    }
    if (f.ownership === "foreign") {
      totals.excludedForeignOnly++;
      bump(foreignByKey, k.key);
      continue;
    }
    const b = bucketFor(k);
    const week = isoWeekKey(f.processedAt, tz);
    population.push({ fact: f, bucket: b, week });
    if (f.subscribed && f.contractId) contractIdSet.add(f.contractId);
  }

  // ── Contract churn ends (kept / quick-cancel rates) ──
  const churnEndById = new Map<string, Date | null>();
  if (contractIdSet.size > 0) {
    const contracts = (await prisma.subscriptionContract.findMany({
      where: {
        shopId: q.shopId,
        id: { in: [...contractIdSet] },
        ...COUNTABLE_CONTRACT,
      },
      select: {
        id: true,
        status: true,
        cancelledAt: true,
        failedAt: true,
        expiredAt: true,
        firstChargeAt: true,
        createdAt: true,
      },
    })) as Array<{
      id: string;
      status: string;
      cancelledAt: Date | null;
      failedAt: Date | null;
      expiredAt: Date | null;
      firstChargeAt: Date | null;
      createdAt: Date;
    }>;
    for (const c of contracts) churnEndById.set(c.id, churnEndOf(c));
  }

  // ── Accumulate ──
  const dayMaturedMemo = new Map<string, boolean>();
  for (const { fact: f, bucket: b, week } of population) {
    totals.orders++;
    b.orders++;
    bump(b.designKeys, f.designKey);
    bump(b.preselects, f.designPreselect);
    bump(b.revisionIds, f.designRevisionId);
    if (f.subscribed) {
      totals.subscribed++;
      b.subscribed++;
      if (!f.designKey) totals.unattributedSubscribed++;
      if (f.contractId) b.contractIds.push(f.contractId);
    }
    if (f.designSource === "seen") totals.seenRows++;
    // Calendar agreement validates the STOREFRONT stamp against the ledger,
    // so only rows whose design came from the storefront are comparable; a
    // calendar-sourced row's design IS the calendar's and would agree by
    // construction, inflating the metric.
    if (
      f.designKey &&
      f.calendarDesignKey &&
      (f.designSource === "seen" || f.designSource === "design_prop")
    ) {
      totals.calendarComparable++;
      if (f.designKey === f.calendarDesignKey) totals.calendarAgree++;
      else b.hygiene.calendarDisagree++;
    }
    if (!f.exposure) {
      totals.noExposure++;
      b.hygiene.noExposure++;
    }
    if (f.promo) b.hygiene.promo++;
    if (f.mixed) b.hygiene.mixed++;
    if (f.transition) b.hygiene.transition++;
    if (f.ownership === "mixed") b.hygiene.foreignPlan++;
    if (f.orderTotalCents != null && Number.isFinite(f.orderTotalCents)) {
      b.totalCentsSum += f.orderTotalCents;
      b.totalCentsCount++;
    }

    const wk = b.weekly.get(week) ?? { orders: 0, subscribed: 0 };
    wk.orders++;
    if (f.subscribed) wk.subscribed++;
    b.weekly.set(week, wk);
    const wt = weekTotals.get(week) ?? { orders: 0, subscribed: 0 };
    wt.orders++;
    if (f.subscribed) wt.subscribed++;
    weekTotals.set(week, wt);

    // Maturity gates: an order only enters a horizon once it is old enough,
    // so young designs never look worse than old ones on kept rates.
    const processedMs = f.processedAt.getTime();
    const churnEnd = f.subscribed
      ? (f.contractId ? (churnEndById.get(f.contractId) ?? null) : null)
      : null;
    for (const n of HELD_HORIZONS) {
      const horizonMs = processedMs + n * DAY_MS;
      if (horizonMs > now.getTime()) continue;
      const h = b.held[n];
      h.matureOrders++;
      if (f.subscribed) {
        h.matureSubscribed++;
        if (churnEnd == null || churnEnd.getTime() > horizonMs) {
          h.heldSubscribed++;
        }
      }
    }
    if (f.subscribed) {
      const quickMs = processedMs + QUICK_CANCEL_DAYS * DAY_MS;
      if (quickMs <= now.getTime()) {
        b.quick.matureSubscribed++;
        if (churnEnd != null && churnEnd.getTime() <= quickMs) {
          b.quick.cancelled++;
        }
      }
    }

    // Per shop-tz day, for the conversion numerators: the covered-day set is
    // only known once the visits are loaded (after this loop), so the counts
    // are kept per day and summed over the covered days later. keptD30 uses
    // the DAY-based maturity gate (see dayMaturedD30), "kept" itself is the
    // same 30-days-after-the-order rule as held.d30.
    const dayKey = shopDayKey(f.processedAt, tz);
    const dt = b.days.get(dayKey) ?? { orders: 0, subscribed: 0, keptD30: 0 };
    dt.orders++;
    if (f.subscribed) {
      dt.subscribed++;
      let matured = dayMaturedMemo.get(dayKey);
      if (matured === undefined) {
        matured = dayMaturedD30(dayKey, tz, now);
        dayMaturedMemo.set(dayKey, matured);
      }
      if (matured && (churnEnd == null || churnEnd.getTime() > processedMs + 30 * DAY_MS)) {
        dt.keptD30++;
      }
    }
    b.days.set(dayKey, dt);
  }
  for (const [k, n] of staffByKey) {
    const b = buckets.get(k);
    if (b) b.hygiene.staffExcluded += n;
  }
  for (const [k, n] of foreignByKey) {
    const b = buckets.get(k);
    if (b) b.hygiene.foreignPlan += n;
  }

  // ── Calendar (contained: the ledger is a sibling module; a failure there
  // must never blank the scoreboard) ──
  let calendar: DesignPeriod[] = [];
  let ledger: typeof import("./ledger.server") | null = null;
  try {
    ledger = await import("./ledger.server");
    calendar = (
      await ledger.getDesignCalendar(q.shopId, since ? { since } : undefined)
    ).slice(0, 200);
  } catch (err) {
    console.error("[design-measurement] calendar unavailable", err);
    calendar = [];
  }
  const revisionLabels = new Map<
    string,
    { label: string | null; preset: string; preselect: string | null }
  >();
  for (const p of calendar) {
    if (!revisionLabels.has(p.revisionId)) {
      revisionLabels.set(p.revisionId, {
        label: p.label,
        preset: p.preset,
        preselect: p.preselect,
      });
    }
  }
  // Revision grouping needs the raw ledger to map a visit DAY onto the
  // revision live that day (facts carry designRevisionId; visits carry only
  // the design stamp). Loaded only for that grouping and contained
  // separately: without it, revision rows read visits null.
  let ledgerRevisions: LedgerRevision[] | null = null;
  if (q.groupBy === "revision" && ledger) {
    try {
      ledgerRevisions = await ledger.loadLedgerRevisions(q.shopId);
    } catch (err) {
      console.error("[design-measurement] ledger revisions unavailable", err);
      ledgerRevisions = null;
    }
  }

  // ── Visits (v1.27.0; contained) ──
  const visitsRead = await loadVisits(q.shopId, {
    since,
    until: now,
    marketHandle: q.marketHandle,
    tz,
  });
  // Visits are "recorded" when the SHOP has at least one visit row in range
  // (unscoped presence check: a market filter that matches no visit row
  // must not read as "beacon not deployed"); then every real row carries
  // counts (zeros when unmatched), provided the scoped summary was readable.
  // For revision grouping the ledger must also be usable, otherwise no visit
  // can be keyed and every row reads null (documented in the module header).
  const visitsRecorded =
    visitsRead.recorded &&
    visitsRead.rows != null &&
    (q.groupBy !== "revision" || ledgerRevisions != null);
  const visitByKey = new Map<string, VisitAgg>();
  // Shop-wide covered days: the coverage metric AND the conversion numerator
  // gate (an order counts toward conversion only when its day is in here).
  const visitDays = visitsRead.coverageDays;
  let totalVisits = 0;
  let firstVisitDay: string | null = null;
  for (const day of visitDays) {
    if (firstVisitDay == null || day < firstVisitDay) firstVisitDay = day;
  }
  const revisionMemo = new Map<string, string | null>();
  const revisionOf = (day: string, designKey: string): string | null => {
    if (!ledger || !ledgerRevisions) return null;
    const memoKey = `${day}|${designKey}`;
    const hit = revisionMemo.get(memoKey);
    if (hit !== undefined) return hit;
    const id = revisionForVisitDay(
      ledger,
      ledgerRevisions,
      day,
      designKey,
      q.marketHandle,
      tz,
    );
    revisionMemo.set(memoKey, id);
    return id;
  };
  for (const v of visitsRead.rows ?? []) {
    totalVisits += v.visits;
    if (!visitsRecorded) continue;
    const key = visitKeyFor(v, q.groupBy, revisionOf);
    if (!key) continue;
    let agg = visitByKey.get(key);
    if (!agg) {
      agg = newVisitAgg();
      visitByKey.set(key, agg);
    }
    agg.counts.visits += v.visits;
    agg.counts.views += v.views;
    agg.counts.engaged += v.engaged;
    agg.counts.addedToCart += v.addedToCart;
    agg.counts.addedSubscription += v.addedSubscription;
    const week = isoWeekKey(dayNoon(v.day, tz), tz);
    agg.weekly.set(week, (agg.weekly.get(week) ?? 0) + v.visits);
    // Same DAY-based maturity gate as the keptD30 numerator (dayMaturedD30):
    // the whole day must be at least 30 days old before its visits enter
    // the kept per-100-visits denominator.
    if (dayMaturedD30(v.day, tz, now)) {
      agg.matureVisitsD30 += v.visits;
    }
    bump(agg.designKeys, v.designKey);
    bump(agg.preselects, visitPreselectToFact(v.designPreselect));
  }
  // A design with visits but no order yet still gets a row (0 orders): the
  // merchant sees a freshly published design is live and being seen instead
  // of a missing line until its first order.
  for (const key of visitByKey.keys()) {
    if (!buckets.has(key)) buckets.set(key, newBucket(key, false));
  }

  // ── Weeks in range ──
  // The axis starts at `since` when set, else at the earliest fact or visit
  // (all-time reads), so a visit-only week still shows on the weekly table.
  const firstProcessed = population[0]?.fact.processedAt ?? null;
  const firstVisitInstant = firstVisitDay ? dayNoon(firstVisitDay, tz) : null;
  const earliest =
    firstProcessed && firstVisitInstant
      ? (firstProcessed.getTime() <= firstVisitInstant.getTime()
          ? firstProcessed
          : firstVisitInstant)
      : (firstProcessed ?? firstVisitInstant);
  const weekFrom = since ?? earliest;
  const weeks = weekFrom ? weekKeysBetween(weekFrom, now, tz) : [];
  const currentWeek = isoWeekKey(now, tz);
  // The leading week is partial when the range cuts into it: `since` later
  // than the Monday 00:00 (shop tz) of its own ISO week means the facts of
  // that week were truncated at `since`, so the guardrail must not read it
  // as a full week (the weekly TABLE still shows it; only the verdict math
  // skips it). No `since` (all time, no start date) truncates nothing.
  const partialWeeks = new Set<string>();
  if (since) {
    const sinceZoned = toZonedTime(since, tz);
    if (sinceZoned.getTime() !== startOfISOWeek(sinceZoned).getTime()) {
      partialWeeks.add(isoWeekKey(since, tz));
    }
  }

  // ── Rows ──
  const rows: VariantRow[] = [];
  const guardrailInput: Array<{
    key: string;
    synthetic: boolean;
    orders: number;
    weekly: WeeklyBucket[];
  }> = [];
  const visitsOf = (b: Bucket): number => visitByKey.get(b.key)?.counts.visits ?? 0;
  const sortedBuckets = [...buckets.values()].sort(
    (a, b) =>
      b.orders - a.orders || visitsOf(b) - visitsOf(a) || a.key.localeCompare(b.key),
  );
  const nowIdx = ymIndex(ymKey(now, tz));

  for (const b of sortedBuckets) {
    const visitAgg = b.synthetic ? null : (visitByKey.get(b.key) ?? null);
    // Real rows read their fact-side identity first; a visit-only row (no
    // orders) borrows it from the visit stamps.
    const visitOnly = !b.synthetic && b.orders === 0 && visitAgg != null;
    const designKey = b.synthetic
      ? null
      : visitOnly
        ? modeOf(visitAgg.designKeys)
        : modeOf(b.designKeys);
    const preselect = b.synthetic
      ? null
      : visitOnly
        ? modeOf(visitAgg.preselects)
        : modeOf(b.preselects);
    const revisionId =
      modeOf(b.revisionIds) ??
      (q.groupBy === "revision" && !b.synthetic ? b.key : null);
    const label = labelFor(b.key, q.groupBy, designKey, preselect, revisionLabels);

    const weekly: WeeklyBucket[] = weeks.map((week) => {
      const w = b.weekly.get(week);
      const orders = w?.orders ?? 0;
      const subscribed = w?.subscribed ?? 0;
      return {
        week,
        orders,
        subscribed,
        oneTime: orders - subscribed,
        visits: visitAgg?.weekly.get(week) ?? 0,
      };
    });

    const matured = (n: 30 | 60 | 90): MaturedRate => ({
      matureOrders: b.held[n].matureOrders,
      matureSubscribed: b.held[n].matureSubscribed,
      heldSubscribed: b.held[n].heldSubscribed,
      pct: pctOrNull(b.held[n].heldSubscribed, b.held[n].matureSubscribed),
    });

    // LTGP through the cohort engine, per row, contained: a cost-model or
    // cohort failure leaves the row's LTGP null and logs, never the tab blank.
    let ltgp: VariantRow["ltgp"] = null;
    if (b.contractIds.length > 0) {
      try {
        const cohortRows = await computeCohortRows(q.shopId, now, {
          contractIds: b.contractIds,
        });
        const summary = summarizeLtgp(cohortRows, nowIdx);
        ltgp = {
          m3: summary.weightedAvg.m3Cents,
          m6: summary.weightedAvg.m6Cents,
          m12: summary.weightedAvg.m12Cents,
          contracts: b.contractIds.length,
        };
      } catch (err) {
        console.error("[design-measurement] ltgp failed", b.key, err);
        ltgp = null;
      }
    }

    rows.push({
      key: b.key,
      designKey,
      preselect,
      revisionId,
      label,
      orders: b.orders,
      subscribed: b.subscribed,
      oneTime: b.orders - b.subscribed,
      takeRatePct: pctOrNull(b.subscribed, b.orders),
      held: { d30: matured(30), d60: matured(60), d90: matured(90) },
      quickCancel14: {
        matureSubscribed: b.quick.matureSubscribed,
        cancelled: b.quick.cancelled,
        pct: pctOrNull(b.quick.cancelled, b.quick.matureSubscribed),
      },
      ltgp,
      grade: gradeOf(b.orders),
      weekly,
      hygiene: b.hygiene,
      aovCents:
        b.totalCentsCount > 0
          ? Math.round(b.totalCentsSum / b.totalCentsCount)
          : null,
      // Recorded + real row → counts (zeros when nothing matched); else null.
      visits:
        visitsRecorded && !b.synthetic
          ? (visitAgg ?? newVisitAgg()).counts
          : null,
      conversion: conversionFor(
        visitsRecorded && !b.synthetic ? (visitAgg ?? newVisitAgg()) : null,
        countedOn(b, visitDays),
        firstVisitDay,
      ),
    });
    guardrailInput.push({
      key: b.key,
      synthetic: b.synthetic,
      orders: b.orders,
      weekly,
    });
  }

  // ── Conversion (merchant-typed sessions per ISO week) ──
  const conversion: ConversionWeek[] = weeks.map((week) => {
    const wt = weekTotals.get(week) ?? { orders: 0, subscribed: 0 };
    const sessions = settings.weeklySessions[week] ?? null;
    let dominantKey: string | null = null;
    let dominantOrders = 0;
    for (const b of sortedBuckets) {
      if (b.synthetic) continue;
      const n = b.weekly.get(week)?.orders ?? 0;
      if (n > dominantOrders) {
        dominantOrders = n;
        dominantKey = b.key;
      }
    }
    return {
      week,
      sessions,
      orders: wt.orders,
      subscribed: wt.subscribed,
      conversionPct: sessions && sessions > 0 ? round1((wt.orders / sessions) * 100) : null,
      subscriptionConversionPct:
        sessions && sessions > 0 ? round1((wt.subscribed / sessions) * 100) : null,
      dominantKey,
    };
  });

  // ── Visit coverage: days with ≥ 1 visit row over the days in range ──
  // The range's first day is `since` when set, else the earliest day any
  // fact or visit landed on (all-time reads); the last day is today (shop
  // tz). differenceInCalendarDays on zoned clock times counts calendar days
  // the way the day keys do.
  const visitDaysInRange = weekFrom
    ? Math.max(
        1,
        differenceInCalendarDays(toZonedTime(now, tz), toZonedTime(weekFrom, tz)) + 1,
      )
    : 1;
  const visitDaysCovered = visitDays.size;
  const visitCoverageDays =
    Math.round(Math.min(1, visitDaysCovered / visitDaysInRange) * 1000) / 1000;

  return {
    computedAt: new Date().toISOString(),
    cached: false,
    rangeDays: q.rangeDays,
    startedAt: settings.startedAt,
    marketHandle: q.marketHandle,
    groupBy: q.groupBy,
    totals: {
      orders: totals.orders,
      subscribed: totals.subscribed,
      excludedStaff: totals.excludedStaff,
      excludedForeignOnly: totals.excludedForeignOnly,
      noExposure: totals.noExposure,
      unattributedSubscribed: totals.unattributedSubscribed,
      seenCoveragePct: pctOrNull(totals.seenRows, totals.orders),
      calendarAgreementPct: pctOrNull(
        totals.calendarAgree,
        totals.calendarComparable,
      ),
      visits: totalVisits,
      // The presence fact, unscoped: true with visits 0 = recorded, none in
      // this market; rows may still read null when the scoped read failed
      // (contained, logged) or revision grouping had no usable ledger.
      visitsRecorded: visitsRead.recorded,
      visitsUnscoped: visitsRead.unscopedVisits,
      visitCoverageDays,
      visitDaysCovered,
      visitDaysInRange,
      lastVisitAt: visitsRead.lastVisitAt,
    },
    rows,
    weeks,
    guardrail: {
      maxOrderDropPct: settings.guardrailMaxOrderDropPct,
      minOrdersPerWeek: settings.guardrailMinOrdersPerWeek,
      verdicts: computeGuardrailVerdicts(guardrailInput, {
        maxOrderDropPct: settings.guardrailMaxOrderDropPct,
        minOrdersPerWeek: settings.guardrailMinOrdersPerWeek,
        currentWeek,
        partialWeeks,
      }),
    },
    conversion,
    comparison: computeComparison(rows),
    calendar,
    markets,
  };
}

/** Display label per grouping; synthetic rows get fixed plain-English names. */
function labelFor(
  key: string,
  groupBy: ScoreboardGroupBy,
  designKey: string | null,
  preselect: string | null,
  revisionLabels: Map<
    string,
    { label: string | null; preset: string; preselect: string | null }
  >,
): string {
  if (key === NO_EXPOSURE_KEY) return "No widget exposure";
  if (key === UNKNOWN_KEY) {
    return groupBy === "revision" ? "Unknown revision" : "Unknown design";
  }
  if (groupBy === "design") return presetDisplayName(designKey);
  if (groupBy === "revision") {
    const rev = revisionLabels.get(key);
    if (rev) {
      const variant = designVariantLabel(rev.preset, rev.preselect);
      return rev.label ? `${rev.label} (${variant})` : variant;
    }
    return designVariantLabel(designKey, preselect);
  }
  return designVariantLabel(designKey, preselect);
}
