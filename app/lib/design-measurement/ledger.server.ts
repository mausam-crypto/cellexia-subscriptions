import prisma from "~/db.server";
import { marketAllowed } from "~/lib/widget/widget-markets";
import type { DesignPeriod, DesignPreselect } from "./shared";

export type { DesignPeriod, DesignPreselect } from "./shared";

/**
 * The design calendar (v1.26.0) — "which buy-box design was live at instant
 * T for market M?", answered from the append-only WidgetDesignRevision
 * history (publishedAt is the publish instant; publishRevision rolls it back
 * when the metafield write fails, so a published row IS a design that went
 * live).
 *
 * WHY it exists: not every order carries a widget-stamped line property. A
 * theme-form install without the seen input, an order placed through a
 * channel that bypassed the widget, every order placed before v1.26.0 — for
 * those the calendar is the only attribution left, and it is also the
 * AUDIT for the stamped ones (SubscribableOrder.calendarDesignKey lets the
 * scoreboard report how often the two agree). The calendar is derived, never
 * stored: a merchant correcting history by republishing changes the answer
 * for future rows only, exactly like the storefront.
 *
 * Resolution rule (mirrors the storefront Liquid, cx-buybox-core.liquid):
 * `config.markets[handle]?.preset ?? config.preset` — a market with no
 * override inherits the default preset. Preselect comes from
 * `config.behavior.preselect`: "subscription" → sub, "one_time" → one,
 * "inherit" → the theme block setting decides, which the ledger cannot see,
 * EXCEPT for subscription_ultra_max whose preset forces the subscription
 * option first (its whole design is the subscription-only frame), so
 * inherit resolves to sub there and to unknown (null) elsewhere. The
 * storefront's `_cellexia_seen` carries the truth per add; the calendar is
 * the fallback.
 */

export interface ResolvedDesign {
  designKey: string;
  preselect: DesignPreselect | null;
  revisionId: string;
  label: string | null;
}

export interface LedgerRevision {
  id: string;
  preset: string;
  config: unknown;
  publishedAt: Date;
  label: string | null;
}

/** Ultra max is the one preset whose frame forces the subscription first. */
const FORCED_SUB_PRESET = "subscription_ultra_max";

/** Newest-first calendar cap — the Results tab renders at most this many. */
const CALENDAR_CAP = 200;

/** Publishes within this window before an order flag it as a transition. */
export const TRANSITION_WINDOW_MS = 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Preset a revision serves to `marketHandle` (null = the default). */
function presetFor(revision: LedgerRevision, marketHandle: string | null): string {
  const config = asRecord(revision.config);
  if (marketHandle) {
    const markets = asRecord(config?.markets);
    const entry = asRecord(markets?.[marketHandle]);
    if (typeof entry?.preset === "string" && entry.preset !== "") {
      return entry.preset;
    }
  }
  if (typeof config?.preset === "string" && config.preset !== "") {
    return config.preset;
  }
  return revision.preset;
}

/** Preselect a revision implies for `preset` (see the module header). */
function preselectFor(
  revision: LedgerRevision,
  preset: string,
): DesignPreselect | null {
  const config = asRecord(revision.config);
  const behavior = asRecord(config?.behavior);
  const value = behavior?.preselect;
  if (value === "subscription") return "sub";
  if (value === "one_time") return "one";
  return preset === FORCED_SUB_PRESET ? "sub" : null;
}

/** Every market handle any revision ever overrode (the calendar's rows). */
function marketHandlesOf(revisions: LedgerRevision[]): string[] {
  const handles = new Set<string>();
  for (const revision of revisions) {
    const markets = asRecord(asRecord(revision.config)?.markets);
    if (!markets) continue;
    for (const handle of Object.keys(markets)) {
      if (handle.trim() !== "") handles.add(handle);
    }
  }
  return [...handles].sort();
}

/** Published revisions ordered by publish instant (oldest first). */
function sortedPublished(revisions: LedgerRevision[]): LedgerRevision[] {
  return revisions
    .filter(
      (r) =>
        r.publishedAt instanceof Date && !Number.isNaN(r.publishedAt.getTime()),
    )
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
}

function resolveWith(
  revision: LedgerRevision,
  marketHandle: string | null,
): ResolvedDesign {
  const designKey = presetFor(revision, marketHandle);
  return {
    designKey,
    preselect: preselectFor(revision, designKey),
    revisionId: revision.id,
    label: revision.label ?? null,
  };
}

/**
 * The design live at `at` for `marketHandle` from a preloaded revision list
 * (backfill loops resolve thousands of rows against one list). Null when no
 * revision was published at or before `at`. Tolerates any order of input.
 */
export function resolveDesignFromRevisions(
  revisions: LedgerRevision[],
  at: Date,
  marketHandle: string | null,
): ResolvedDesign | null {
  const t = at.getTime();
  if (Number.isNaN(t)) return null;
  let live: LedgerRevision | null = null;
  for (const revision of sortedPublished(revisions)) {
    if (revision.publishedAt.getTime() <= t) live = revision;
    else break;
  }
  return live ? resolveWith(live, marketHandle) : null;
}

/**
 * What the storefront could structurally show at the time of an order: the
 * `widgetMarkets` gate (v1.25.0: cx-buybox-core.liquid renders the hidden
 * marker instead of the widget in an excluded market) and the launch mode
 * (SETUP renders the block hidden everywhere). Loaded by facts.server
 * (contained: a failed read is treated as fully open) and applied through
 * calendarRungAllowed below.
 */
export interface ExposureGate {
  widgetMarkets: { mode: "all" | "selected"; handles: string[] };
  launchMode: "SETUP" | "LIVE";
}

/** Fully open gate: every market allowed, store live — the safe fallback. */
export const OPEN_EXPOSURE_GATE: ExposureGate = {
  widgetMarkets: { mode: "all", handles: [] },
  launchMode: "LIVE",
};

/**
 * May the calendar rung attribute a design to an order with NO widget
 * property? Only when the widget could actually have rendered: the store was
 * live and the order's market was not excluded by widgetMarkets. In a hidden
 * market (or in SETUP) the shopper could not see any design, so counting the
 * order as "saw design X, chose one-time" would deflate that design's take
 * rate with orders where exposure was impossible; those rows stay
 * designSource "none" (the scoreboard's no-exposure bucket) while
 * calendarDesignKey still records what the ledger would have said, for the
 * audit. An UNKNOWN market (null handle: no country, no map row) cannot be
 * proven hidden and keeps the calendar (fail open, like a missing map).
 */
export function calendarRungAllowed(
  gate: ExposureGate,
  marketHandle: string | null,
): boolean {
  if (gate.launchMode !== "LIVE") return false;
  if (marketHandle == null) return true;
  return marketAllowed(gate.widgetMarkets, marketHandle);
}

/** All published revisions of the shop, oldest first (the ledger). */
export async function loadLedgerRevisions(
  shopId: string,
): Promise<LedgerRevision[]> {
  const rows = await prisma.widgetDesignRevision.findMany({
    where: { shopId, publishedAt: { not: null } },
    orderBy: { publishedAt: "asc" },
    select: {
      id: true,
      preset: true,
      config: true,
      publishedAt: true,
      label: true,
    },
  });
  const out: LedgerRevision[] = [];
  for (const row of rows) {
    if (!row.publishedAt) continue;
    out.push({
      id: row.id,
      preset: row.preset,
      config: row.config,
      publishedAt: row.publishedAt,
      label: row.label ?? null,
    });
  }
  return out;
}

/** The design live at `at` for `marketHandle` (null = default design). */
export async function resolveDesignAt(
  shopId: string,
  at: Date,
  marketHandle: string | null,
): Promise<ResolvedDesign | null> {
  const revisions = await loadLedgerRevisions(shopId);
  return resolveDesignFromRevisions(revisions, at, marketHandle);
}

/**
 * True when a publish happened within `windowMs` (default 24h) BEFORE `at`
 * (publishedAt in (at - window, at]). Orders in that window carry carry-over
 * risk: a cart built under the previous design, checked out under the new
 * one — the scoreboard discloses them as `transition` rather than silently
 * attributing them.
 */
export function isTransition(
  revisions: LedgerRevision[],
  at: Date,
  windowMs: number = TRANSITION_WINDOW_MS,
): boolean {
  const t = at.getTime();
  if (Number.isNaN(t) || windowMs <= 0) return false;
  const floor = t - windowMs;
  return revisions.some((r) => {
    if (!(r.publishedAt instanceof Date)) return false;
    const p = r.publishedAt.getTime();
    return !Number.isNaN(p) && p > floor && p <= t;
  });
}

/**
 * Pure calendar builder over a preloaded revision list: one entry per
 * (market or default) per contiguous period. Consecutive publishes that
 * leave a market's design unchanged (same preset, same preselect, same
 * label — a colour tweak, say) MERGE into one period, because the merchant
 * reads the calendar to find "the weeks design X was live", not the publish
 * log; the period keeps the revision that opened it. A relabelled republish
 * of the same preset starts a new period on purpose: naming a design is how
 * the merchant marks the start of a new test.
 */
export function buildDesignCalendar(
  revisions: LedgerRevision[],
  opts: { since?: Date } = {},
): DesignPeriod[] {
  const sorted = sortedPublished(revisions);
  if (sorted.length === 0) return [];
  const rows: Array<string | null> = [null, ...marketHandlesOf(sorted)];
  const periods: DesignPeriod[] = [];

  for (const marketHandle of rows) {
    let open: DesignPeriod | null = null;
    for (const revision of sorted) {
      const resolved = resolveWith(revision, marketHandle);
      const same =
        open != null &&
        open.preset === resolved.designKey &&
        open.preselect === resolved.preselect &&
        (open.label ?? null) === (resolved.label ?? null);
      if (same) continue;
      if (open) {
        open.to = revision.publishedAt;
        periods.push(open);
      }
      open = {
        revisionId: resolved.revisionId,
        label: resolved.label,
        preset: resolved.designKey,
        preselect: resolved.preselect,
        marketHandle,
        from: revision.publishedAt,
        to: null,
      };
    }
    if (open) periods.push(open);
  }

  const since = opts.since?.getTime();
  const filtered =
    since != null && !Number.isNaN(since)
      ? periods.filter((p) => p.to == null || p.to.getTime() >= since)
      : periods;
  return filtered
    .sort((a, b) => {
      const d = b.from.getTime() - a.from.getTime();
      if (d !== 0) return d;
      // Default first, then markets alphabetically, for a stable listing.
      if (a.marketHandle === b.marketHandle) return 0;
      if (a.marketHandle == null) return -1;
      if (b.marketHandle == null) return 1;
      return a.marketHandle.localeCompare(b.marketHandle);
    })
    .slice(0, CALENDAR_CAP);
}

/**
 * Human calendar: one entry per (market or default) per contiguous period,
 * newest first, capped at 200. `since` keeps periods still live at or after
 * that instant (the Results tab passes the range start).
 */
export async function getDesignCalendar(
  shopId: string,
  opts: { since?: Date } = {},
): Promise<DesignPeriod[]> {
  const revisions = await loadLedgerRevisions(shopId);
  return buildDesignCalendar(revisions, opts);
}
