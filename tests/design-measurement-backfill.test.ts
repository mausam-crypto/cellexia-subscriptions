import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * design_facts_backfill (backfill.server.ts, v1.26.0)
 *
 *  (0) market map refresh runs FIRST and is contained.
 *  (1) checkout.subscribable events without a fact row are rebuilt via
 *      recordSubscribableOrder from the payload (orderId, orderName,
 *      hasSellingPlanLine, presentmentCurrencyCode, designKeys, seen) + the
 *      order's acquisition.captured stash (country, device, source, total,
 *      units, processedAt, discount codes) + widget.design_attributed
 *      events, with knownOwnership "ours" when a countable contract's
 *      origin; existing rows are skipped; per-row failures are counted. The
 *      feed is walked by cursor so a backlog beyond one run's cap drains on
 *      the following runs.
 *  (2) subscribed=false rows whose order is a countable contract's origin →
 *      linkContractDesign, driven from the contract side.
 *  (3) countable contracts with an origin and no stamp → linkContractDesign.
 *  (4) flags recompute since designMeasurement.startedAt (all rows when
 *      unset): staff from the event email, transition from the ledger,
 *      marketHandle from the refreshed map (calendar rows re-resolved);
 *      writes only changed rows; keeps the stored staff verdict when no
 *      email is known. recomputeStaffFlags is exported for the Results tab.
 *  (4, v1.27.0) the flags step also maps WidgetVisitorDay rows with a
 *      country and no market (recomputeVisitMarkets), contained on its own.
 *  (5, v1.27.0) prune_visits: the LAST step, contained; a failure there
 *      never costs a repair step.
 *  Registration: design_facts_backfill right after origin_order_backfill,
 *  daily, ungated. Never throws; stats returned.
 */

const dbMocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  factFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  factUpdate: vi.fn(async (): Promise<unknown> => ({})),
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  revisionFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

const seamMocks = vi.hoisted(() => ({
  recordSubscribableOrder: vi.fn(async (): Promise<unknown> => ({ created: true })),
  linkContractDesign: vi.fn(async (): Promise<unknown> => ({ stamped: true })),
  loadExposureGate: vi.fn(async (): Promise<unknown> => ({
    widgetMarkets: { mode: "all", handles: [] },
    launchMode: "LIVE",
  })),
  refreshMarketCountryMap: vi.fn(async (): Promise<number> => 3),
  loadMarketCountryMap: vi.fn(async (): Promise<Map<string, string>> => new Map()),
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({ id: "shop_1", domain: "cellexia.myshopify.com" })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ graphql: vi.fn() })),
  // v1.27.0 visit ledger maintenance (visits.server.ts, tested on its own).
  recomputeVisitMarkets: vi.fn(async (): Promise<unknown> => ({ scanned: 0, updated: 0 })),
  pruneVisits: vi.fn(async (): Promise<number> => 0),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriberEvent: { findMany: dbMocks.eventFindMany },
    subscribableOrder: { findMany: dbMocks.factFindMany, update: dbMocks.factUpdate },
    subscriptionContract: { findMany: dbMocks.contractFindMany },
    widgetDesignRevision: { findMany: dbMocks.revisionFindMany },
  },
}));

vi.mock("~/lib/design-measurement/facts.server", () => ({
  recordSubscribableOrder: seamMocks.recordSubscribableOrder,
  linkContractDesign: seamMocks.linkContractDesign,
  loadExposureGate: seamMocks.loadExposureGate,
}));

vi.mock("~/lib/design-measurement/markets.server", () => ({
  refreshMarketCountryMap: seamMocks.refreshMarketCountryMap,
  loadMarketCountryMap: seamMocks.loadMarketCountryMap,
}));

vi.mock("~/lib/design-measurement/visits.server", () => ({
  recomputeVisitMarkets: seamMocks.recomputeVisitMarkets,
  pruneVisits: seamMocks.pruneVisits,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: seamMocks.getSetting,
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: seamMocks.getPrimaryShop,
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: seamMocks.adminClientForShop,
}));

import {
  DESIGN_BACKFILL_MAX_PAGES,
  DESIGN_BACKFILL_PAGE,
  DESIGN_BACKFILL_STEP_CAP,
  DESIGN_FLAGS_RECOMPUTE_CAP,
  collectFactlessOrders,
  recomputeStaffFlags,
  runDesignFactsBackfill,
} from "~/lib/design-measurement/backfill.server";
import { JOB_NAMES, JOB_SCHEDULE, SETUP_GATED_JOB_NAMES } from "~/lib/jobs/runner.server";

const NOW = new Date("2026-09-10T12:00:00Z");
/** First argument of the n-th call of a mock (vitest types no-arg mocks' calls as []). */
const argOf = (mock: { mock: { calls: unknown[] } }, call = 0): unknown =>
  (mock.mock.calls[call] as unknown[] | undefined)?.[0];
const O1 = "gid://shopify/Order/1";
const O2 = "gid://shopify/Order/2";

type EventQuery = {
  where?: { type?: string; OR?: unknown[] };
  take?: number;
  cursor?: { id: string };
  skip?: number;
};

/**
 * Route the event mock by the `type` in the where clause and honour cursor
 * pagination (orderBy createdAt desc, id desc is assumed pre-sorted in the
 * fixture) so the step-1 walk can be exercised against a long feed.
 */
function eventsByType(map: Record<string, Array<Record<string, unknown>>>) {
  dbMocks.eventFindMany.mockImplementation(async (raw?: unknown) => {
    const args = (raw ?? {}) as EventQuery;
    const type = args.where?.type ?? "";
    const all = map[type] ?? [];
    if (args.take == null) return all;
    let start = 0;
    if (args.cursor) {
      const idx = all.findIndex((e) => e.id === args.cursor!.id);
      start = idx < 0 ? all.length : idx + (args.skip ?? 0);
    }
    return all.slice(start, start + args.take);
  });
}

const SETTING = {
  startedAt: null as string | null,
  excludeEmails: [] as string[],
  guardrailMaxOrderDropPct: 10,
  guardrailMinOrdersPerWeek: 20,
  weeklySessions: {},
};

type FactQuery = {
  where?: { orderId?: { in?: string[] }; subscribed?: boolean; processedAt?: unknown };
  select?: Record<string, boolean>;
  take?: number;
};

beforeEach(() => {
  vi.clearAllMocks();
  seamMocks.getSetting.mockResolvedValue(SETTING);
  seamMocks.getPrimaryShop.mockResolvedValue({ id: "shop_1", domain: "cellexia.myshopify.com" });
  seamMocks.recordSubscribableOrder.mockResolvedValue({ created: true });
  seamMocks.linkContractDesign.mockResolvedValue({ stamped: true });
  seamMocks.loadExposureGate.mockResolvedValue({
    widgetMarkets: { mode: "all", handles: [] },
    launchMode: "LIVE",
  });
  seamMocks.refreshMarketCountryMap.mockResolvedValue(3);
  seamMocks.loadMarketCountryMap.mockResolvedValue(new Map());
  seamMocks.recomputeVisitMarkets.mockResolvedValue({ scanned: 0, updated: 0 });
  seamMocks.pruneVisits.mockResolvedValue(0);
  dbMocks.eventFindMany.mockResolvedValue([]);
  dbMocks.factFindMany.mockResolvedValue([]);
  dbMocks.contractFindMany.mockResolvedValue([]);
  dbMocks.revisionFindMany.mockResolvedValue([]);
});

describe("registration", () => {
  it("design_facts_backfill sits right after origin_order_backfill, daily, ungated", () => {
    const names = [...JOB_NAMES];
    const origin = names.indexOf("origin_order_backfill");
    expect(origin).toBeGreaterThanOrEqual(0);
    expect(names[origin + 1]).toBe("design_facts_backfill");
    expect(JOB_SCHEDULE.find((j) => j.name === "design_facts_backfill")?.everyMinutes).toBe(1440);
    expect(SETUP_GATED_JOB_NAMES).not.toContain("design_facts_backfill");
    expect(DESIGN_BACKFILL_STEP_CAP).toBe(2000);
    expect(DESIGN_BACKFILL_PAGE).toBe(500);
    expect(DESIGN_BACKFILL_MAX_PAGES).toBe(40);
    expect(DESIGN_FLAGS_RECOMPUTE_CAP).toBe(5000);
  });
});

describe("runDesignFactsBackfill", () => {
  it("skips without a shop", async () => {
    seamMocks.getPrimaryShop.mockResolvedValue(null);
    expect(await runDesignFactsBackfill(NOW)).toEqual({ skipped: "no_shop" });
    expect(dbMocks.eventFindMany).not.toHaveBeenCalled();
  });

  it("step 0 runs the market map refresh BEFORE any fact write or contract stamp (finding #14)", async () => {
    eventsByType({
      "checkout.subscribable": [
        { id: "e1", payload: { orderId: O1, hasSellingPlanLine: false, designKeys: [] }, email: null, createdAt: new Date("2026-09-05T10:00:00Z") },
      ],
    });
    dbMocks.contractFindMany.mockImplementation(async (raw?: unknown) => {
      const where = ((raw ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      return where.originDesignStampedAt === null ? [{ id: "c2" }] : [];
    });

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ marketsRefreshed: 3, factsCreated: 1, errors: 0 });
    const refreshOrder = seamMocks.refreshMarketCountryMap.mock.invocationCallOrder[0];
    const factOrder = seamMocks.recordSubscribableOrder.mock.invocationCallOrder[0];
    const stampOrder = seamMocks.linkContractDesign.mock.invocationCallOrder[0];
    expect(refreshOrder).toBeLessThan(factOrder);
    expect(refreshOrder).toBeLessThan(stampOrder);
  });

  it("step 1: rebuilds missing fact rows from the event feed + stash + attributed events; skips existing rows", async () => {
    eventsByType({
      "checkout.subscribable": [
        {
          id: "e1",
          payload: {
            orderId: O1,
            orderName: "#1001",
            hasSellingPlanLine: true,
            presentmentCurrencyCode: "CHF",
            designKeys: ["classic"],
            seen: ["classic|s"],
          },
          email: "buyer@example.com",
          createdAt: new Date("2026-09-05T10:00:01Z"),
        },
        {
          // Duplicate event for O1 (redelivery) → deduped in memory.
          id: "e2",
          payload: { orderId: O1, hasSellingPlanLine: true, designKeys: ["classic"] },
          email: "buyer@example.com",
          createdAt: new Date("2026-09-05T10:00:00Z"),
        },
        {
          // Already has a fact row → skipped.
          id: "e3",
          payload: { orderId: O2, hasSellingPlanLine: false, designKeys: [] },
          email: null,
          createdAt: new Date("2026-09-04T10:00:00Z"),
        },
      ],
      "acquisition.captured": [
        {
          payload: {
            orderId: O1,
            acquisition: {
              acqRaw: {
                orderProcessedAt: "2026-09-05T09:59:00.000Z",
                countryCode: "CH",
                deviceType: "mobile",
                sourceName: "web",
                orderTotalCents: 5900,
                unitsFirstOrder: 2,
                discountCodes: ["WELCOME10"],
                orderCurrencyCode: "CHF",
              },
            },
          },
          email: "buyer@example.com",
          createdAt: new Date("2026-09-05T10:00:00Z"),
        },
      ],
      "widget.design_attributed": [
        { payload: { orderId: O1, designKey: "planner" }, email: null, createdAt: new Date() },
      ],
    });
    // Only O2 has a fact row; step-2/4 reads return nothing.
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) =>
      (raw as FactQuery | undefined)?.where?.orderId ? [{ orderId: O2 }] : [],
    );
    // A countable contract has O1 as its origin → knownOwnership ours.
    dbMocks.contractFindMany.mockImplementation(async (raw?: unknown) => {
      const where = ((raw ?? {}) as { where?: { originOrderId?: unknown } }).where ?? {};
      return where.originOrderId && typeof where.originOrderId === "object" && "in" in where.originOrderId
        ? [{ id: "c1", originOrderId: O1 }]
        : [];
    });

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ factsCreated: 1, errors: 0, marketsRefreshed: 3 });

    expect(seamMocks.recordSubscribableOrder).toHaveBeenCalledTimes(1);
    const call = argOf(seamMocks.recordSubscribableOrder) as Record<string, unknown>;
    expect(call).toMatchObject({
      shopId: "shop_1",
      orderId: O1,
      orderName: "#1001",
      processedAt: new Date("2026-09-05T09:59:00.000Z"),
      countryCode: "CH",
      currencyCode: "CHF",
      deviceType: "mobile",
      sourceName: "web",
      orderTotalCents: 5900,
      units: 2,
      orderEmail: "buyer@example.com",
      hasSellingPlanLine: true,
      promo: true,
      knownOwnership: "ours",
    });
    // Synthetic lines: one per seen value, one per design key (payload +
    // attributed events, deduped), our product, no plan ids.
    expect(call.lines).toEqual([
      expect.objectContaining({ seenProp: "classic|s", designProp: null, isOurProduct: true, sellingPlanId: null }),
      expect.objectContaining({ designProp: "classic", seenProp: null }),
      expect.objectContaining({ designProp: "planner", seenProp: null }),
    ]);
    // Newest events first, cursor-paged on (createdAt, id).
    expect(dbMocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop_1", type: "checkout.subscribable" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: DESIGN_BACKFILL_PAGE,
      }),
    );
  });

  it("step 1 without a stash falls back to the event's createdAt and nulls, and a throwing write is counted, not fatal", async () => {
    eventsByType({
      "checkout.subscribable": [
        { id: "e1", payload: { orderId: O1, hasSellingPlanLine: false, designKeys: [] }, email: null, createdAt: new Date("2026-09-05T10:00:00Z") },
        { id: "e2", payload: { orderId: O2, hasSellingPlanLine: false, designKeys: [] }, email: null, createdAt: new Date("2026-09-04T10:00:00Z") },
      ],
    });
    seamMocks.recordSubscribableOrder
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce({ created: true });

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ factsCreated: 1, errors: 1 });
    expect(seamMocks.recordSubscribableOrder).toHaveBeenCalledTimes(2);
    const second = argOf(seamMocks.recordSubscribableOrder, 1) as Record<string, unknown>;
    expect(second).toMatchObject({
      orderId: O2,
      processedAt: new Date("2026-09-04T10:00:00Z"),
      countryCode: null,
      deviceType: null,
      orderTotalCents: null,
      units: null,
      promo: false,
      knownOwnership: "none",
      lines: [],
    });
  });

  it("step 1 drains a backlog beyond one run's cap: 2,001 factless events, two runs, the 2,001st gets its row on run 2 (findings #3/#15)", async () => {
    // Feed newest → oldest; every order lacks a fact row until the run
    // writes it (the fact "table" is simulated by a Set the write feeds).
    const feed: Array<Record<string, unknown>> = [];
    for (let i = 2001; i >= 1; i--) {
      feed.push({
        id: `e${i}`,
        payload: { orderId: `gid://shopify/Order/${i}`, hasSellingPlanLine: false, designKeys: [] },
        email: null,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, Math.floor(i / 60), i % 60)),
      });
    }
    eventsByType({ "checkout.subscribable": feed });
    const written = new Set<string>();
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) => {
      const q = raw as FactQuery | undefined;
      const ids = q?.where?.orderId?.in;
      if (!ids) return [];
      return ids.filter((id) => written.has(id)).map((orderId) => ({ orderId }));
    });
    seamMocks.recordSubscribableOrder.mockImplementation(async (raw?: unknown) => {
      written.add((raw as { orderId: string }).orderId);
      return { created: true };
    });

    const run1 = await runDesignFactsBackfill(NOW);
    expect(run1).toMatchObject({ factsCreated: DESIGN_BACKFILL_STEP_CAP, errors: 0 });
    expect(written.size).toBe(2000);
    // The oldest order (#1) is the one left over.
    expect(written.has("gid://shopify/Order/1")).toBe(false);

    seamMocks.recordSubscribableOrder.mockClear();
    const run2 = await runDesignFactsBackfill(NOW);
    expect(run2).toMatchObject({ factsCreated: 1, errors: 0 });
    expect(seamMocks.recordSubscribableOrder).toHaveBeenCalledTimes(1);
    expect(argOf(seamMocks.recordSubscribableOrder)).toMatchObject({ orderId: "gid://shopify/Order/1" });
    expect(written.size).toBe(2001);

    // Run 3: nothing left; the walk read the whole feed and wrote nothing.
    seamMocks.recordSubscribableOrder.mockClear();
    expect(await runDesignFactsBackfill(NOW)).toMatchObject({ factsCreated: 0, errors: 0 });
    expect(seamMocks.recordSubscribableOrder).not.toHaveBeenCalled();
  });

  it("collectFactlessOrders is bounded: at most DESIGN_BACKFILL_MAX_PAGES pages per run and stops when the cap is reached", async () => {
    const feed: Array<Record<string, unknown>> = [];
    for (let i = 30000; i >= 1; i--) {
      feed.push({ id: `e${i}`, payload: { orderId: `o${i}` }, email: null, createdAt: new Date(i * 1000) });
    }
    eventsByType({ "checkout.subscribable": feed });
    // Every order already has a row → the walk must give up after MAX_PAGES.
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) =>
      ((raw as FactQuery).where?.orderId?.in ?? []).map((orderId) => ({ orderId })),
    );
    expect((await collectFactlessOrders("shop_1", 2000)).size).toBe(0);
    expect(dbMocks.eventFindMany).toHaveBeenCalledTimes(DESIGN_BACKFILL_MAX_PAGES);

    // Cap reached on the first page: one page read, `cap` orders returned.
    dbMocks.eventFindMany.mockClear();
    dbMocks.factFindMany.mockResolvedValue([]);
    const collected = await collectFactlessOrders("shop_1", 10);
    expect(collected.size).toBe(10);
    expect([...collected.keys()][0]).toBe("o30000");
    expect(dbMocks.eventFindMany).toHaveBeenCalledTimes(1);
  });

  it("step 2 links unlinked facts from the contract side (countable contracts walked by cursor); step 3 stamps unstamped contracts", async () => {
    // Countable contracts with an origin: c1 (origin O1, fact still
    // unlinked) and c9 (origin O2, fact already linked). Step 3 finds c2.
    dbMocks.contractFindMany.mockImplementation(async (raw?: unknown) => {
      const args = (raw ?? {}) as { where?: Record<string, unknown> };
      const where = args.where ?? {};
      if ("originDesignStampedAt" in where) return [{ id: "c2" }];
      if (where.originOrderId && typeof where.originOrderId === "object" && "not" in where.originOrderId) {
        return [
          { id: "c1", originOrderId: O1 },
          { id: "c9", originOrderId: O2 },
        ];
      }
      return [];
    });
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) => {
      const q = raw as FactQuery | undefined;
      if (q?.where?.subscribed === false) {
        expect(q.where.orderId?.in).toEqual([O1, O2]);
        return [{ orderId: O1 }];
      }
      return [];
    });
    seamMocks.linkContractDesign
      .mockResolvedValueOnce({ stamped: true, designKey: "classic", designSource: "seen" })
      .mockResolvedValueOnce({ stamped: false, designKey: null, designSource: null });

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ linked: 1, stamped: 1, errors: 0 });
    expect(seamMocks.linkContractDesign).toHaveBeenCalledTimes(2);
    expect(seamMocks.linkContractDesign).toHaveBeenNthCalledWith(1, "shop_1", "c1", NOW);
    expect(seamMocks.linkContractDesign).toHaveBeenNthCalledWith(2, "shop_1", "c2", NOW);
    // Both contract queries are COUNTABLE-scoped.
    const contractQueries = (dbMocks.contractFindMany.mock.calls as unknown[][]).map(
      (c) => c[0] as { where: Record<string, unknown>; take?: number; orderBy?: unknown },
    );
    for (const query of contractQueries) {
      expect(query.where).toMatchObject({ shopId: "shop_1", isDemo: false, ownership: "OURS" });
    }
    const linkQuery = contractQueries.find(
      (c) => !("originDesignStampedAt" in c.where) && c.where.originOrderId != null,
    );
    expect(linkQuery).toMatchObject({
      where: { originOrderId: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DESIGN_BACKFILL_PAGE,
    });
    const stampQuery = contractQueries.find((c) => c.where.originDesignStampedAt === null);
    expect(stampQuery).toMatchObject({
      where: { originOrderId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: DESIGN_BACKFILL_STEP_CAP,
    });
  });

  it("step 2 finds an unlinked subscribed order however many newer one-time rows exist (no newest-2,000 window)", async () => {
    // Regression for finding #3: the old step selected the newest 2,000
    // unsubscribed rows; an older subscribed order past that window was
    // never linked. Now the contract drives the lookup.
    dbMocks.contractFindMany.mockImplementation(async (raw?: unknown) => {
      const where = ((raw ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      if ("originDesignStampedAt" in where) return [];
      if (where.originOrderId && typeof where.originOrderId === "object" && "not" in where.originOrderId) {
        return [{ id: "c_old", originOrderId: "gid://shopify/Order/old" }];
      }
      return [];
    });
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) => {
      const q = raw as FactQuery | undefined;
      // No `take` on the join read: the batch is exactly the page's origins.
      if (q?.where?.subscribed === false) {
        expect(q.take).toBeUndefined();
        return [{ orderId: "gid://shopify/Order/old" }];
      }
      return [];
    });
    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ linked: 1 });
    expect(seamMocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_old", NOW);
  });

  it("step 4 recomputes staff (from the event email) and transition (from the ledger), writing only changed rows", async () => {
    seamMocks.getSetting.mockResolvedValue({ ...SETTING, excludeEmails: ["staff@cellexia.com"] });
    dbMocks.revisionFindMany.mockResolvedValue([
      { id: "r1", preset: "classic", config: {}, publishedAt: new Date("2026-09-08T00:00:00Z"), label: null },
    ]);
    const rows = [
      // Newly listed staff email → staff flips on.
      { id: "f1", orderId: O1, processedAt: new Date("2026-09-01T00:00:00Z"), staff: false, transition: false, countryCode: null, marketHandle: null, designSource: "none" },
      // Inside 24h after the publish → transition flips on.
      { id: "f2", orderId: O2, processedAt: new Date("2026-09-08T06:00:00Z"), staff: false, transition: false, countryCode: null, marketHandle: null, designSource: "none" },
      // No email known and nothing else changed → untouched (keeps staff true).
      { id: "f3", orderId: "gid://shopify/Order/3", processedAt: new Date("2026-09-02T00:00:00Z"), staff: true, transition: false, countryCode: null, marketHandle: null, designSource: "none" },
      // Redacted email is no evidence → untouched (keeps staff true).
      { id: "f4", orderId: "gid://shopify/Order/4", processedAt: new Date("2026-09-02T00:00:00Z"), staff: true, transition: false, countryCode: null, marketHandle: null, designSource: "none" },
    ];
    eventsByType({
      "checkout.subscribable": [
        { id: "e1", payload: { orderId: O1 }, email: "STAFF@cellexia.com", createdAt: new Date("2026-09-01T00:00:00Z") },
        { id: "e2", payload: { orderId: O2 }, email: "buyer@example.com", createdAt: new Date("2026-09-08T06:00:00Z") },
        { id: "e4", payload: { orderId: "gid://shopify/Order/4" }, email: "redacted+77@example.invalid", createdAt: new Date("2026-09-02T00:00:00Z") },
      ],
    });
    // Step 1 must not try to rebuild these (they have rows): the existence
    // check (where.orderId in […]) returns them; the step-4 read (select
    // includes staff) returns the rows to recompute.
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) => {
      const q = raw as FactQuery | undefined;
      if (q?.where?.orderId) return [{ orderId: O1 }, { orderId: O2 }, { orderId: "gid://shopify/Order/4" }];
      if (q?.select?.staff) return rows;
      return [];
    });

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ staffRecomputed: 2, errors: 0 });
    expect(seamMocks.recordSubscribableOrder).not.toHaveBeenCalled();
    expect(dbMocks.factUpdate).toHaveBeenCalledTimes(2);
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({ where: { id: "f1" }, data: { staff: true } });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({ where: { id: "f2" }, data: { transition: true } });
    // Range: startedAt unset → every row, capped; emails read by orderId.
    const flagsQuery = (dbMocks.factFindMany.mock.calls as unknown[][])
      .map((c) => c[0] as FactQuery)
      .find((q) => q.select?.staff);
    expect(flagsQuery).toMatchObject({ where: { shopId: "shop_1" }, take: DESIGN_FLAGS_RECOMPUTE_CAP });
    expect(flagsQuery?.where).not.toHaveProperty("processedAt");
    const emailQuery = (dbMocks.eventFindMany.mock.calls as unknown[][])
      .map((c) => c[0] as EventQuery)
      .find((q) => q.where?.type === "checkout.subscribable" && Array.isArray(q.where?.OR));
    expect(emailQuery?.where?.OR).toEqual(
      expect.arrayContaining([{ payload: { path: ["orderId"], equals: O1 } }]),
    );
  });

  it("step 4 recomputes marketHandle from the stored country once the map is filled and re-resolves calendar rows (finding #5)", async () => {
    dbMocks.revisionFindMany.mockResolvedValue([
      {
        id: "rev_1",
        preset: "classic",
        config: { preset: "classic", behavior: { preselect: "subscription" }, markets: { ch: { preset: "tiles" } } },
        publishedAt: new Date("2026-08-01T00:00:00Z"),
        label: null,
      },
    ]);
    seamMocks.loadMarketCountryMap.mockResolvedValue(new Map([["CH", "ch"], ["DE", "de"]]));
    seamMocks.loadExposureGate.mockResolvedValue({
      widgetMarkets: { mode: "selected", handles: ["ch"] },
      launchMode: "LIVE",
    });
    const rows = [
      // Written against the empty map: default design, market unknown →
      // ch override applies.
      { id: "f1", orderId: O1, processedAt: new Date("2026-09-01T00:00:00Z"), staff: false, transition: false, countryCode: "CH", marketHandle: null, designSource: "calendar" },
      // Seen row: market + calendar audit follow, the design does not.
      { id: "f2", orderId: O2, processedAt: new Date("2026-09-01T00:00:00Z"), staff: false, transition: false, countryCode: "CH", marketHandle: null, designSource: "seen" },
      // Calendar row now resolving to a HIDDEN market → none.
      { id: "f3", orderId: "gid://shopify/Order/3", processedAt: new Date("2026-09-01T00:00:00Z"), staff: false, transition: false, countryCode: "DE", marketHandle: null, designSource: "calendar" },
      // Already right → untouched.
      { id: "f4", orderId: "gid://shopify/Order/4", processedAt: new Date("2026-09-01T00:00:00Z"), staff: false, transition: false, countryCode: "CH", marketHandle: "ch", designSource: "calendar" },
    ];
    dbMocks.factFindMany.mockImplementation(async (raw?: unknown) =>
      (raw as FactQuery | undefined)?.select?.staff ? rows : [],
    );

    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ staffRecomputed: 3, errors: 0 });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({
      where: { id: "f1" },
      data: {
        marketHandle: "ch",
        calendarDesignKey: "tiles",
        designRevisionId: "rev_1",
        designKey: "tiles",
        designPreselect: "sub",
      },
    });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({
      where: { id: "f2" },
      data: { marketHandle: "ch", calendarDesignKey: "tiles", designRevisionId: "rev_1" },
    });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({
      where: { id: "f3" },
      data: {
        marketHandle: "de",
        calendarDesignKey: "classic",
        designRevisionId: "rev_1",
        designKey: null,
        designPreselect: null,
        designSource: "none",
      },
    });
    expect(dbMocks.factUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: "f4" } }));

    // An EMPTY map (refresh never succeeded) must not clear good handles.
    dbMocks.factUpdate.mockClear();
    seamMocks.loadMarketCountryMap.mockResolvedValue(new Map());
    rows[0].marketHandle = "ch";
    await runDesignFactsBackfill(NOW);
    expect(dbMocks.factUpdate).not.toHaveBeenCalled();
  });

  it("step 0 is contained: a Shopify failure counts as an error and the run still returns stats", async () => {
    seamMocks.refreshMarketCountryMap.mockRejectedValue(new Error("Field 'regions' doesn't exist"));
    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ marketsRefreshed: 0, errors: 1 });
    expect(seamMocks.adminClientForShop).toHaveBeenCalledWith("cellexia.myshopify.com");
    expect(seamMocks.refreshMarketCountryMap).toHaveBeenCalledWith("shop_1", expect.anything());
  });

  it("a step that throws outright is contained and the following steps still run", async () => {
    dbMocks.eventFindMany.mockRejectedValueOnce(new Error("events table locked"));
    dbMocks.contractFindMany.mockImplementation(async (raw?: unknown) => {
      const where = ((raw ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      return "originDesignStampedAt" in where ? [{ id: "c2" }] : [];
    });
    const stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ errors: 1, marketsRefreshed: 3 });
    // Step 3 still stamped; step 0 still refreshed markets.
    expect(seamMocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c2", NOW);
    expect(seamMocks.refreshMarketCountryMap).toHaveBeenCalledTimes(1);
  });

  it("step 4 (v1.27.0) also maps visit rows to markets and reports the count; a failure there is contained on its own", async () => {
    seamMocks.recomputeVisitMarkets.mockResolvedValue({ scanned: 40, updated: 7 });
    let stats = await runDesignFactsBackfill(NOW);
    expect(seamMocks.recomputeVisitMarkets).toHaveBeenCalledWith("shop_1");
    expect(stats).toMatchObject({ visitMarketsRecomputed: 7, errors: 0 });
    // The visit pass runs AFTER the fact-row recompute of the same step (the
    // settings read is the flags step's own work) and before the prune.
    const flagsOrder = seamMocks.getSetting.mock.invocationCallOrder.at(-1)!;
    const visitsOrder = seamMocks.recomputeVisitMarkets.mock.invocationCallOrder[0];
    const pruneOrder = seamMocks.pruneVisits.mock.invocationCallOrder[0];
    expect(flagsOrder).toBeLessThan(visitsOrder);
    expect(visitsOrder).toBeLessThan(pruneOrder);

    seamMocks.recomputeVisitMarkets.mockRejectedValue(new Error("visits table locked"));
    stats = await runDesignFactsBackfill(NOW);
    // Counted, not fatal: the prune step still ran after it.
    expect(stats).toMatchObject({ visitMarketsRecomputed: 0, errors: 1 });
    expect(seamMocks.pruneVisits).toHaveBeenCalledTimes(2);
  });

  it("step 5 (v1.27.0) prune_visits runs LAST with the shop calendar and default retention; a failure is contained", async () => {
    seamMocks.getPrimaryShop.mockResolvedValue({
      id: "shop_1",
      domain: "cellexia.myshopify.com",
      ianaTimezone: "Europe/Zurich",
    });
    seamMocks.pruneVisits.mockResolvedValue(123);
    let stats = await runDesignFactsBackfill(NOW);
    expect(seamMocks.pruneVisits).toHaveBeenCalledTimes(1);
    expect(seamMocks.pruneVisits).toHaveBeenCalledWith("shop_1", undefined, {
      now: NOW,
      tz: "Europe/Zurich",
    });
    expect(stats).toMatchObject({ visitsPruned: 123, errors: 0 });
    // Last: every other seam was invoked before it.
    const pruneOrder = seamMocks.pruneVisits.mock.invocationCallOrder[0];
    for (const seam of [
      seamMocks.refreshMarketCountryMap,
      seamMocks.recomputeVisitMarkets,
      seamMocks.getSetting,
    ]) {
      expect(seam.mock.invocationCallOrder.at(-1)).toBeLessThan(pruneOrder);
    }

    // A failing prune costs nothing but an error count: it runs after every
    // repair step, so nothing is left undone by it.
    seamMocks.pruneVisits.mockRejectedValue(new Error("delete timed out"));
    seamMocks.recomputeVisitMarkets.mockResolvedValue({ scanned: 1, updated: 1 });
    stats = await runDesignFactsBackfill(NOW);
    expect(stats).toMatchObject({ visitsPruned: 0, visitMarketsRecomputed: 1, errors: 1 });
  });
});

describe("recomputeStaffFlags (Results tab save)", () => {
  it("re-stamps staff for rows since designMeasurement.startedAt with the given list, capped, never throwing (finding #8)", async () => {
    seamMocks.getSetting.mockResolvedValue({ ...SETTING, startedAt: "2026-09-01" });
    const rows = [
      { id: "f1", orderId: O1, processedAt: new Date("2026-09-05T00:00:00Z"), staff: false, transition: false, countryCode: null, marketHandle: null, designSource: "seen" },
      { id: "f2", orderId: O2, processedAt: new Date("2026-09-06T00:00:00Z"), staff: true, transition: false, countryCode: null, marketHandle: null, designSource: "seen" },
    ];
    dbMocks.factFindMany.mockResolvedValue(rows);
    eventsByType({
      "checkout.subscribable": [
        { id: "e1", payload: { orderId: O1 }, email: "Tester@Brand.com", createdAt: new Date() },
        { id: "e2", payload: { orderId: O2 }, email: "buyer@example.com", createdAt: new Date() },
      ],
    });

    const result = await recomputeStaffFlags("shop_1", ["tester@brand.com"]);
    expect(result).toEqual({ scanned: 2, updated: 2, errors: 0 });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({ where: { id: "f1" }, data: { staff: true } });
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({ where: { id: "f2" }, data: { staff: false } });
    // Range from startedAt (a day of timezone slack), capped at 5,000; the
    // ledger and market map are NOT read (staff only).
    const query = argOf(dbMocks.factFindMany) as FactQuery;
    expect(query.take).toBe(DESIGN_FLAGS_RECOMPUTE_CAP);
    expect(query.where?.processedAt).toEqual({ gte: new Date("2026-08-31T00:00:00Z") });
    expect(dbMocks.revisionFindMany).not.toHaveBeenCalled();
    expect(seamMocks.loadMarketCountryMap).not.toHaveBeenCalled();

    // Explicit `since: null` = every row; the list defaults to the setting.
    dbMocks.factFindMany.mockClear();
    seamMocks.getSetting.mockResolvedValue({ ...SETTING, excludeEmails: ["buyer@example.com"] });
    await recomputeStaffFlags("shop_1", undefined, { since: null });
    expect((argOf(dbMocks.factFindMany) as FactQuery).where).not.toHaveProperty("processedAt");
    expect(seamMocks.getSetting).toHaveBeenCalledWith("shop_1", "designMeasurement");

    // Contained: a failing read reports an error instead of throwing.
    dbMocks.factFindMany.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recomputeStaffFlags("shop_1", [])).toEqual({ scanned: 0, updated: 0, errors: 1 });
    spy.mockRestore();
  });
});
