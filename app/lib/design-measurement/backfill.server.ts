import prisma from "~/db.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  calendarRungAllowed,
  isTransition,
  loadLedgerRevisions,
  resolveDesignFromRevisions,
  type ExposureGate,
  type LedgerRevision,
} from "./ledger.server";
import {
  linkContractDesign,
  loadExposureGate,
  recordSubscribableOrder,
  type RecordSubscribableOrderLine,
  type SubscribableOwnership,
} from "./facts.server";
import { loadMarketCountryMap, refreshMarketCountryMap } from "./markets.server";
import { pruneVisits, recomputeVisitMarkets } from "./visits.server";

/**
 * design_facts_backfill (v1.26.0, nightly, ungated) — the repair lane that
 * keeps SubscribableOrder / originDesign* complete without any webhook having
 * to be perfect. Steps, in the order they run:
 *
 *  (0) refresh MarketCountryMap from Shopify (contained). FIRST, because
 *      every step below resolves the calendar per market: on the first
 *      post-upgrade run the map is empty until this call, and a fact row or
 *      a WRITE-ONCE contract stamp resolved against an empty map would carry
 *      the DEFAULT-market design for every market with an override.
 *  (1) checkout.subscribable events without a fact row (orders that predate
 *      the feature, or whose ORDERS_CREATE fact write failed) → rebuild the
 *      row from the event payload + the same order's acquisition.captured
 *      stash + widget.design_attributed events + the calendar. The feed is
 *      WALKED newest → oldest by cursor (pages of DESIGN_BACKFILL_PAGE, at
 *      most DESIGN_BACKFILL_MAX_PAGES per run) collecting orders that have
 *      no row until DESIGN_BACKFILL_STEP_CAP are found or the feed ends, so
 *      a backlog older than the newest 2,000 events really does drain over
 *      consecutive nights instead of being re-read and skipped forever.
 *  (2) fact rows still subscribed=false whose order is a COUNTABLE
 *      contract's origin → linkContractDesign. Driven from the CONTRACT
 *      side (countable contracts with an origin order, walked by cursor,
 *      joined to unsubscribed rows in batches), so an unlinked subscribed
 *      order is found however many one-time rows are newer than it.
 *  (3) COUNTABLE contracts with an originOrderId and no design stamp →
 *      linkContractDesign (events/calendar fallback past the grace window).
 *  (4) rows since designMeasurement.startedAt (all rows when unset), capped
 *      DESIGN_FLAGS_RECOMPUTE_CAP: recompute `staff` from the checkout email
 *      on the checkout.subscribable event vs the CURRENT excludeEmails,
 *      `transition` from the ledger (a republish yesterday changes it), and
 *      `marketHandle` from the stored country vs the refreshed map: rows
 *      written before the map was filled carry marketHandle=null and, when
 *      their design came from the calendar, the DEFAULT-market design; those
 *      are re-resolved for the market they really belong to. The same pass
 *      maps WidgetVisitorDay rows (v1.27.0) that carry a country but no
 *      market yet (recomputeVisitMarkets), so the visit denominator and the
 *      order numerator answer a market filter the same way.
 *  (5) prune_visits (v1.27.0): drop visit rows older than
 *      VISIT_RETENTION_DAYS. LAST, and its own contained step: retention is
 *      housekeeping, and a failure there must not cost the repair steps.
 *
 * Every step is contained and capped so one bad row or one Shopify hiccup
 * never blocks the others. Stats are returned for JobRun.stats.
 * recomputeStaffFlags is also exported for the Results tab: saving the staff
 * email list re-stamps existing rows right away instead of at the next run.
 */

export const DESIGN_BACKFILL_STEP_CAP = 2000;
/** Page size of the cursor walks over events / contracts. */
export const DESIGN_BACKFILL_PAGE = 500;
/** Pages per walk per run: bounds one run to 20,000 events / contracts read. */
export const DESIGN_BACKFILL_MAX_PAGES = 40;
/** Rows one flags recompute (step 4, or a Results tab save) may rewrite. */
export const DESIGN_FLAGS_RECOMPUTE_CAP = 5000;
/** JSON-path OR filters are chunked so one query never carries thousands. */
const OR_CHUNK = 100;
/**
 * designMeasurement.startedAt is a calendar DATE ("2026-09-01") the merchant
 * reads in the shop's timezone; the recompute widens it by a day so no row
 * of the measured range is missed on either side of midnight.
 */
const STARTED_AT_SLACK_MS = 24 * 60 * 60 * 1000;

export interface DesignBackfillStats {
  factsCreated: number;
  linked: number;
  stamped: number;
  /** Rows rewritten by the flags recompute (staff / transition / market). */
  staffRecomputed: number;
  marketsRefreshed: number;
  /** v1.27.0: visit rows given a market handle by the flags step. */
  visitMarketsRecomputed: number;
  /** v1.27.0: visit rows dropped by the prune_visits step. */
  visitsPruned: number;
  errors: number;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "" && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Events of `type` whose payload.orderId is one of `orderIds`, by orderId. */
async function eventsByOrderId(
  shopId: string,
  type: string,
  orderIds: string[],
): Promise<Map<string, Array<{ payload: unknown; email: string | null; createdAt: Date }>>> {
  const map = new Map<
    string,
    Array<{ payload: unknown; email: string | null; createdAt: Date }>
  >();
  for (const ids of chunk(orderIds, OR_CHUNK)) {
    const rows = await prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type,
        OR: ids.map((orderId) => ({
          payload: { path: ["orderId"], equals: orderId },
        })),
      },
      orderBy: { createdAt: "asc" },
      select: { payload: true, email: true, createdAt: true },
    });
    for (const row of rows) {
      const orderId = asString(asRecord(row.payload)?.orderId);
      if (!orderId) continue;
      const list = map.get(orderId) ?? [];
      list.push({ payload: row.payload, email: row.email ?? null, createdAt: row.createdAt });
      map.set(orderId, list);
    }
  }
  return map;
}

/** Fact rows that exist for `orderIds` (batched `in` reads). */
async function existingFactOrderIds(
  shopId: string,
  orderIds: string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  for (const ids of chunk(orderIds, 500)) {
    const rows = await prisma.subscribableOrder.findMany({
      where: { shopId, orderId: { in: ids } },
      select: { orderId: true },
    });
    for (const row of rows) existing.add(row.orderId);
  }
  return existing;
}

interface FeedEvent {
  payload: Record<string, unknown>;
  email: string | null;
  createdAt: Date;
}

/**
 * Walk the checkout.subscribable feed newest → oldest and collect the orders
 * that have NO fact row, up to `cap`, reading at most DESIGN_BACKFILL_MAX_PAGES
 * pages. Cursor pagination on (createdAt desc, id desc) so two events logged
 * in the same millisecond can neither be skipped nor read twice. Exported
 * for tests.
 */
export async function collectFactlessOrders(
  shopId: string,
  cap: number,
): Promise<Map<string, FeedEvent>> {
  const missing = new Map<string, FeedEvent>();
  const judged = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < DESIGN_BACKFILL_MAX_PAGES && missing.size < cap; page++) {
    const after: string | null = cursor;
    const events: Array<{
      id: string;
      payload: unknown;
      email: string | null;
      createdAt: Date;
    }> = await prisma.subscriberEvent.findMany({
      where: { shopId, type: "checkout.subscribable" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DESIGN_BACKFILL_PAGE,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
      select: { id: true, payload: true, email: true, createdAt: true },
    });
    if (events.length === 0) break;
    cursor = events[events.length - 1].id;

    // Newest event per order within the page; orders judged on an earlier
    // page (existing or already collected) are not looked up again.
    const candidates = new Map<string, FeedEvent>();
    for (const event of events) {
      const payload = asRecord(event.payload);
      const orderId = asString(payload?.orderId);
      if (!payload || !orderId || judged.has(orderId) || candidates.has(orderId)) continue;
      candidates.set(orderId, {
        payload,
        email: event.email ?? null,
        createdAt: event.createdAt,
      });
    }
    if (candidates.size > 0) {
      const existing = await existingFactOrderIds(shopId, [...candidates.keys()]);
      for (const [orderId, event] of candidates) {
        judged.add(orderId);
        if (existing.has(orderId)) continue;
        if (missing.size >= cap) break;
        missing.set(orderId, event);
      }
    }
    if (events.length < DESIGN_BACKFILL_PAGE) break; // feed exhausted
  }
  return missing;
}

/**
 * Step (1): rebuild fact rows for checkout.subscribable events that have
 * none. Newest first: the recent history is what the merchant is reading
 * right now; the older backlog drains over the following nights because the
 * walk skips past every order that already has a row.
 */
async function backfillFactsFromEvents(
  shopId: string,
  stats: DesignBackfillStats,
): Promise<void> {
  const byOrder = await collectFactlessOrders(shopId, DESIGN_BACKFILL_STEP_CAP);
  if (byOrder.size === 0) return;
  const missing = [...byOrder.keys()];

  const [stashes, attributed, contracts] = await Promise.all([
    eventsByOrderId(shopId, "acquisition.captured", missing),
    eventsByOrderId(shopId, "widget.design_attributed", missing),
    prisma.subscriptionContract.findMany({
      where: {
        shopId,
        isDemo: false,
        ...OURS_ONLY,
        originOrderId: { in: missing },
      },
      select: { originOrderId: true },
    }),
  ]);
  const oursOrigin = new Set<string>();
  for (const c of contracts) if (c.originOrderId) oursOrigin.add(c.originOrderId);

  for (const orderId of missing) {
    const event = byOrder.get(orderId)!;
    try {
      const stash = stashes.get(orderId)?.at(-1);
      const acquisition = asRecord(asRecord(stash?.payload)?.acquisition);
      const acqRaw = asRecord(acquisition?.acqRaw) ?? {};
      const processedAtRaw = asString(acqRaw.orderProcessedAt);
      const processedAtParsed = processedAtRaw ? new Date(processedAtRaw) : null;
      const processedAt =
        processedAtParsed && !Number.isNaN(processedAtParsed.getTime())
          ? processedAtParsed
          : event.createdAt;

      const hasSellingPlanLine = event.payload.hasSellingPlanLine === true;
      const designKeys = asStringArray(event.payload.designKeys);
      for (const evt of attributed.get(orderId) ?? []) {
        const key = asString(asRecord(evt.payload)?.designKey);
        if (key && !designKeys.includes(key)) designKeys.push(key);
      }
      // v1.26.0 payloads additionally carry the distinct seen values.
      const seenValues = asStringArray(event.payload.seen);

      // No line detail survives in the event feed: one synthetic line per
      // stamped value. Ownership comes from the contract mirror instead
      // (knownOwnership) — the lines carry no plan ids to classify.
      const lines: RecordSubscribableOrderLine[] = [];
      for (const seen of seenValues) {
        lines.push({
          variantId: null,
          productId: null,
          sellingPlanId: null,
          designProp: null,
          seenProp: seen,
          isOurProduct: true,
        });
      }
      for (const key of designKeys) {
        lines.push({
          variantId: null,
          productId: null,
          sellingPlanId: null,
          designProp: key,
          seenProp: null,
          isOurProduct: true,
        });
      }
      const knownOwnership: SubscribableOwnership = oursOrigin.has(orderId)
        ? "ours"
        : "none";
      const discountCodes = asStringArray(acqRaw.discountCodes);
      const units = asNumber(acqRaw.unitsFirstOrder);

      const result = await recordSubscribableOrder({
        shopId,
        orderId,
        orderName: asString(event.payload.orderName),
        processedAt,
        countryCode: asString(acqRaw.countryCode),
        currencyCode:
          asString(event.payload.presentmentCurrencyCode) ??
          asString(acqRaw.presentmentCurrencyCode) ??
          asString(acqRaw.orderCurrencyCode),
        deviceType: asString(acqRaw.deviceType),
        sourceName: asString(acqRaw.sourceName),
        orderTotalCents: asNumber(acqRaw.orderTotalCents),
        units: units != null ? Math.round(units) : null,
        orderEmail: event.email,
        hasSellingPlanLine,
        lines,
        promo: discountCodes.length > 0,
        knownOwnership,
      });
      if (result.created) stats.factsCreated += 1;
    } catch (err) {
      stats.errors += 1;
      console.error("[design-measurement] fact backfill failed", orderId, err);
    }
  }
}

/**
 * Step (2): unlinked fact rows whose order is a countable contract's origin,
 * found from the contract side: countable contracts with an origin order are
 * walked newest → oldest by cursor and each page is joined to the
 * subscribed=false rows in one batched read. Capped at
 * DESIGN_BACKFILL_STEP_CAP links per run.
 */
async function linkUnlinkedFacts(
  shopId: string,
  now: Date,
  stats: DesignBackfillStats,
): Promise<void> {
  let cursor: string | null = null;
  let links = 0;
  for (let page = 0; page < DESIGN_BACKFILL_MAX_PAGES && links < DESIGN_BACKFILL_STEP_CAP; page++) {
    const after: string | null = cursor;
    const contracts: Array<{ id: string; originOrderId: string | null }> =
      await prisma.subscriptionContract.findMany({
        where: { shopId, isDemo: false, ...OURS_ONLY, originOrderId: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: DESIGN_BACKFILL_PAGE,
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        select: { id: true, originOrderId: true },
      });
    if (contracts.length === 0) break;
    cursor = contracts[contracts.length - 1].id;

    const byOrigin = new Map<string, string[]>();
    for (const c of contracts) {
      if (!c.originOrderId) continue;
      const list = byOrigin.get(c.originOrderId) ?? [];
      list.push(c.id);
      byOrigin.set(c.originOrderId, list);
    }
    if (byOrigin.size > 0) {
      const unlinked = await prisma.subscribableOrder.findMany({
        where: { shopId, subscribed: false, orderId: { in: [...byOrigin.keys()] } },
        select: { orderId: true },
      });
      for (const row of unlinked) {
        for (const contractId of byOrigin.get(row.orderId) ?? []) {
          if (links >= DESIGN_BACKFILL_STEP_CAP) break;
          links += 1;
          try {
            const result = await linkContractDesign(shopId, contractId, now);
            stats.linked += 1;
            if (result.stamped) stats.stamped += 1;
          } catch (err) {
            stats.errors += 1;
            console.error("[design-measurement] fact link failed", contractId, err);
          }
        }
      }
    }
    if (contracts.length < DESIGN_BACKFILL_PAGE) break; // exhausted
  }
}

/** Step (3): countable contracts with an origin order and no design stamp. */
async function stampUnstampedContracts(
  shopId: string,
  now: Date,
  stats: DesignBackfillStats,
): Promise<void> {
  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      isDemo: false,
      ...OURS_ONLY,
      originOrderId: { not: null },
      originDesignStampedAt: null,
    },
    orderBy: { createdAt: "asc" },
    take: DESIGN_BACKFILL_STEP_CAP,
    select: { id: true },
  });
  for (const contract of contracts) {
    try {
      const result = await linkContractDesign(shopId, contract.id, now);
      if (result.stamped) stats.stamped += 1;
    } catch (err) {
      stats.errors += 1;
      console.error("[design-measurement] contract stamp failed", contract.id, err);
    }
  }
}

// ── Step (4): flags recompute ────────────────────────────────────────────────

export interface RecomputeFlagsResult {
  /** Rows examined (capped at DESIGN_FLAGS_RECOMPUTE_CAP). */
  scanned: number;
  /** Rows actually rewritten (only rows whose flags changed are written). */
  updated: number;
  errors: number;
}

interface RecomputeFactFlagsOptions {
  /** Staff email list; defaults to the current designMeasurement setting. */
  excludeEmails?: string[];
  /**
   * Lower bound on processedAt. `undefined` = designMeasurement.startedAt
   * (minus a day of timezone slack); `null` = every row of the shop.
   */
  since?: Date | null;
  /** Also recompute `transition` from the ledger. */
  transition?: boolean;
  /** Also recompute `marketHandle` (and re-resolve calendar rows). */
  market?: boolean;
}

function startedAtBound(startedAt: string | null): Date | null {
  if (typeof startedAt !== "string" || startedAt.trim() === "") return null;
  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() - STARTED_AT_SLACK_MS);
}

/**
 * The checkout email of each order, from its checkout.subscribable event.
 * `undefined` for an order with no event (or a CUSTOMERS_REDACT-rewritten
 * address, `redacted+…@example.invalid`, which is no evidence about the
 * buyer any more): the caller keeps the stored verdict for those.
 */
async function checkoutEmailByOrderId(
  shopId: string,
  orderIds: string[],
): Promise<Map<string, string | null>> {
  const events = await eventsByOrderId(shopId, "checkout.subscribable", orderIds);
  const out = new Map<string, string | null>();
  for (const [orderId, list] of events) {
    const email = list[0]?.email ?? null;
    if (email != null && email.toLowerCase().endsWith("@example.invalid")) continue;
    out.set(orderId, email);
  }
  return out;
}

/**
 * Recompute derived flags over the measured range. Only rows whose values
 * actually change are written. Never throws (returns error counts): callable
 * from the Results tab action as well as the nightly job.
 */
async function recomputeFactFlags(
  shopId: string,
  opts: RecomputeFactFlagsOptions,
): Promise<RecomputeFlagsResult> {
  const result: RecomputeFlagsResult = { scanned: 0, updated: 0, errors: 0 };
  try {
    let excludeEmails = opts.excludeEmails;
    let since = opts.since;
    if (excludeEmails === undefined || since === undefined) {
      const setting = await getSetting(shopId, "designMeasurement");
      if (excludeEmails === undefined) excludeEmails = setting.excludeEmails;
      if (since === undefined) since = startedAtBound(setting.startedAt);
    }
    const exclude = new Set(
      excludeEmails.map((e) => e.trim().toLowerCase()).filter((e) => e !== ""),
    );

    const rows = await prisma.subscribableOrder.findMany({
      where: { shopId, ...(since ? { processedAt: { gte: since } } : {}) },
      orderBy: { processedAt: "desc" },
      take: DESIGN_FLAGS_RECOMPUTE_CAP,
      select: {
        id: true,
        orderId: true,
        processedAt: true,
        staff: true,
        transition: true,
        countryCode: true,
        marketHandle: true,
        designSource: true,
      },
    });
    result.scanned = rows.length;
    if (rows.length === 0) return result;

    const emailByOrder = await checkoutEmailByOrderId(
      shopId,
      rows.map((r) => r.orderId),
    );
    let revisions: LedgerRevision[] = [];
    let marketMap: Map<string, string> | null = null;
    let gate: ExposureGate | null = null;
    if (opts.transition || opts.market) revisions = await loadLedgerRevisions(shopId);
    if (opts.market) {
      const loaded = await loadMarketCountryMap(shopId);
      // An EMPTY map means the refresh never succeeded (Shopify always has a
      // primary market with regions): recomputing against it would clear
      // every good handle, so the market pass is skipped for this run.
      marketMap = loaded.size > 0 ? loaded : null;
      if (marketMap) gate = await loadExposureGate(shopId);
    }

    for (const row of rows) {
      try {
        const data: Record<string, unknown> = {};
        const email = emailByOrder.get(row.orderId);
        // Unknown email (no event): keep the stored verdict — absence of
        // evidence must not clear a staff flag set at write time.
        const staff =
          email === undefined ? row.staff : email != null && exclude.has(email.trim().toLowerCase());
        if (staff !== row.staff) data.staff = staff;

        if (opts.transition) {
          const transition = isTransition(revisions, row.processedAt);
          if (transition !== row.transition) data.transition = transition;
        }

        if (marketMap && gate) {
          const handle = row.countryCode ? (marketMap.get(row.countryCode) ?? null) : null;
          if (handle !== row.marketHandle) {
            data.marketHandle = handle;
            const calendar = resolveDesignFromRevisions(revisions, row.processedAt, handle);
            // The calendar audit follows the market for every row; the
            // DESIGN itself only for rows whose design CAME from the
            // calendar (a storefront stamp is evidence the market cannot
            // overrule).
            data.calendarDesignKey = calendar?.designKey ?? null;
            data.designRevisionId = calendar?.revisionId ?? null;
            if (row.designSource === "calendar") {
              if (calendar && calendarRungAllowed(gate, handle)) {
                data.designKey = calendar.designKey;
                data.designPreselect = calendar.preselect;
              } else {
                data.designKey = null;
                data.designPreselect = null;
                data.designSource = "none";
              }
            }
          }
        }

        if (Object.keys(data).length === 0) continue;
        await prisma.subscribableOrder.update({ where: { id: row.id }, data });
        result.updated += 1;
      } catch (err) {
        result.errors += 1;
        console.error("[design-measurement] flags recompute failed", row.id, err);
      }
    }
  } catch (err) {
    result.errors += 1;
    console.error("[design-measurement] flags recompute failed", shopId, err);
  }
  return result;
}

/**
 * Re-stamp `staff` for every fact row since designMeasurement.startedAt (all
 * rows when unset), capped at DESIGN_FLAGS_RECOMPUTE_CAP per call, reading
 * each order's checkout email from its checkout.subscribable event. The
 * Results tab action calls this right after saving the staff email list so
 * the exclusion is visible on the next readout, not the next nightly run.
 * `excludeEmails` defaults to the saved setting; `opts.since` overrides the
 * range (null = all rows). Never throws.
 */
export async function recomputeStaffFlags(
  shopId: string,
  excludeEmails?: string[],
  opts: { since?: Date | null } = {},
): Promise<RecomputeFlagsResult> {
  return recomputeFactFlags(shopId, {
    excludeEmails,
    since: opts.since,
    transition: false,
    market: false,
  });
}

/**
 * Step (4) as run nightly: staff + transition + market over the range, then
 * the visit ledger's market pass (v1.27.0). The visit pass is contained on
 * its own: a failure there must not report the fact recompute as failed,
 * and vice versa.
 */
async function recomputeFlagsNightly(
  shopId: string,
  stats: DesignBackfillStats,
): Promise<void> {
  const result = await recomputeFactFlags(shopId, { transition: true, market: true });
  stats.staffRecomputed += result.updated;
  stats.errors += result.errors;
  try {
    const visits = await recomputeVisitMarkets(shopId);
    stats.visitMarketsRecomputed += visits.updated;
  } catch (err) {
    stats.errors += 1;
    console.error("[design-measurement] visit market recompute failed", shopId, err);
  }
}

/** Step (5): retention of the visit ledger (v1.27.0). */
async function pruneVisitsNightly(
  shop: { id: string; ianaTimezone: string },
  now: Date,
  stats: DesignBackfillStats,
): Promise<void> {
  stats.visitsPruned += await pruneVisits(shop.id, undefined, {
    now,
    tz: shop.ianaTimezone,
  });
}

/** Step (0): refresh the country → market cache (contained). */
async function refreshMarkets(
  shop: { id: string; domain: string },
  stats: DesignBackfillStats,
): Promise<void> {
  try {
    // Lazy: ~/shopify.server builds the Prisma session storage at load, and
    // this job body is imported by the runner in every environment.
    const { adminClientForShop } = await import("~/shopify.server");
    const admin = await adminClientForShop(shop.domain);
    stats.marketsRefreshed = await refreshMarketCountryMap(shop.id, admin);
  } catch (err) {
    stats.errors += 1;
    console.error("[design-measurement] market map refresh failed", shop.domain, err);
  }
}

/** Nightly job body: see the module header. Never throws. */
export async function runDesignFactsBackfill(
  now: Date,
): Promise<Record<string, unknown>> {
  const { getPrimaryShop } = await import("~/lib/shop/install.server");
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };

  const stats: DesignBackfillStats = {
    factsCreated: 0,
    linked: 0,
    stamped: 0,
    staffRecomputed: 0,
    marketsRefreshed: 0,
    visitMarketsRecomputed: 0,
    visitsPruned: 0,
    errors: 0,
  };
  // Markets FIRST (see the module header): a failure leaves the map as it
  // was and the other steps still run against it. prune_visits LAST: pure
  // housekeeping, never allowed to cost a repair step.
  const steps: Array<[string, () => Promise<void>]> = [
    ["markets", () => refreshMarkets({ id: shop.id, domain: shop.domain }, stats)],
    ["facts", () => backfillFactsFromEvents(shop.id, stats)],
    ["link", () => linkUnlinkedFacts(shop.id, now, stats)],
    ["stamp", () => stampUnstampedContracts(shop.id, now, stats)],
    ["flags", () => recomputeFlagsNightly(shop.id, stats)],
    [
      "prune_visits",
      () =>
        pruneVisitsNightly(
          { id: shop.id, ianaTimezone: shop.ianaTimezone ?? "UTC" },
          now,
          stats,
        ),
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      stats.errors += 1;
      console.error(`[design-measurement] backfill step ${name} failed`, err);
    }
  }
  return stats;
}
