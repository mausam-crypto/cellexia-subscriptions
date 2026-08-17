import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Design measurement scoreboard (v1.26.0) — the readout engine behind
 * Buy box designer → Results, driven with mocked seams:
 * - prisma (subscribableOrder.findMany, subscriptionContract.findMany,
 *   marketCountryMap.findMany, shop.findUnique),
 * - the cohort engine (computeCohortRows / summarizeLtgp) so LTGP plumbing
 *   is pinned without a cost model,
 * - the settings getter and the design ledger.
 *
 * Pins: take rate, kept-rate maturity gates (matureSubscribed exposed as the
 * pct denominator), quick cancels, grades, the synthetic no-exposure row and
 * the RESERVED synthetic keys (a forged "no_exposure"/"unknown" designKey
 * only ever lands in the synthetic unknown row), foreign-only and staff
 * exclusions, calendar agreement over storefront-stamped rows only, shop-tz
 * ISO week bucketing, guardrail verdicts (incl. the ≥2-breaching-weeks rule
 * and the range's leading PARTIAL week never qualifying), the exact
 * closed-form probabilityBetterThan (symmetry, known values, peaked vs wide),
 * market scoping, conversion rows from typed-in sessions, the calendar
 * containment, and the 10-minute cache (hit / miss / fresh / invalidate).
 *
 * v1.27.0 (visits, mocked visits.server): the visit join per grouping
 * (variant / design / revision via the ledger), visit-only rows, the
 * conversion block (2-decimal per-100 rates, TIME-ALIGNED numerators over
 * covered days only, the day-based 30-day maturity gate on BOTH sides of
 * kept per 100 visits), weekly visits, the conversion-basis guardrail
 * (primary; weeks qualify on visits, so a zero-order traffic week counts as
 * 0 per 100) with the orders fallback, the comparison array vs the reference
 * (deltas from unrounded ratios, chance from the aligned counts), totals
 * (visits, the unscoped presence check hasVisits behind visitsRecorded /
 * visitsUnscoped, coverage, last visit), null-when-not-recorded vs zeros
 * for a market filter that matches no visit, and containment of a failing
 * visits module.
 */

const mocks = vi.hoisted(() => ({
  factFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  marketFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  shopFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  computeCohortRows: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  summarizeLtgp: vi.fn((..._a: unknown[]): unknown => ({
    cohorts: [],
    weightedAvg: { m3Cents: null, m6Cents: null, m12Cents: null },
  })),
  getDesignCalendar: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  loadLedgerRevisions: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  visitSummary: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
  lastVisitAt: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
  hasVisits: vi.fn(async (..._a: unknown[]): Promise<unknown> => false),
}));

vi.mock("~/db.server", () => {
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );
  const explicit: Record<string, unknown> = {
    subscribableOrder: { findMany: mocks.factFindMany },
    subscriptionContract: { findMany: mocks.contractFindMany },
    marketCountryMap: { findMany: mocks.marketFindMany },
    shop: { findUnique: mocks.shopFindUnique },
  };
  return {
    default: new Proxy(
      {},
      {
        get: (_t, model: string) =>
          model in explicit ? explicit[model] : autoModel,
      },
    ),
  };
});

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: vi.fn(),
}));

vi.mock("~/lib/analytics/cohorts.server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("~/lib/analytics/cohorts.server")
  >();
  return {
    ...actual,
    computeCohortRows: mocks.computeCohortRows,
    summarizeLtgp: mocks.summarizeLtgp,
  };
});

vi.mock("~/lib/design-measurement/ledger.server", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("~/lib/design-measurement/ledger.server")
  >();
  return {
    // The pure resolver is real: revision-grouping visit mapping is pinned
    // against the same rule facts.server uses; only the DB reads are mocked.
    resolveDesignFromRevisions: actual.resolveDesignFromRevisions,
    getDesignCalendar: mocks.getDesignCalendar,
    loadLedgerRevisions: mocks.loadLedgerRevisions,
  };
});

vi.mock("~/lib/design-measurement/visits.server", () => ({
  visitSummary: mocks.visitSummary,
  lastVisitAt: mocks.lastVisitAt,
  hasVisits: mocks.hasVisits,
}));

import {
  computeComparison,
  computeGuardrailVerdicts,
  getScoreboard,
  invalidateScoreboardCache,
  isoWeekKey,
  probabilityBetterThan,
} from "~/lib/design-measurement/scoreboard.server";
import type { ConversionBlock, VariantRow } from "~/lib/design-measurement/types";

const SHOP_ID = "shop_1";
const TZ = "Europe/Zurich";
// Thursday 20 Aug 2026, 12:00 UTC (14:00 in Zurich) — ISO week 2026-W34.
const NOW = new Date("2026-08-20T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number, fromNow: Date = NOW): Date {
  return new Date(fromNow.getTime() - n * DAY_MS);
}

interface FactInput {
  processedAt?: Date;
  marketHandle?: string | null;
  orderTotalCents?: number | null;
  designKey?: string | null;
  designPreselect?: string | null;
  designRevisionId?: string | null;
  designSource?: string;
  calendarDesignKey?: string | null;
  ownership?: string;
  exposure?: boolean;
  subscribed?: boolean;
  contractId?: string | null;
  promo?: boolean;
  mixed?: boolean;
  transition?: boolean;
  staff?: boolean;
}

/** A SubscribableOrder fact row: our-product, widget-seen, subscription_max|sub by default. */
function fact(input: FactInput = {}) {
  return {
    processedAt: input.processedAt ?? daysAgo(3),
    marketHandle: input.marketHandle === undefined ? "gb" : input.marketHandle,
    orderTotalCents: input.orderTotalCents === undefined ? 4900 : input.orderTotalCents,
    designKey: input.designKey === undefined ? "subscription_max" : input.designKey,
    designPreselect: input.designPreselect === undefined ? "sub" : input.designPreselect,
    designRevisionId: input.designRevisionId === undefined ? "rev_1" : input.designRevisionId,
    designSource: input.designSource ?? "seen",
    calendarDesignKey:
      input.calendarDesignKey === undefined ? "subscription_max" : input.calendarDesignKey,
    ownership: input.ownership ?? "ours",
    exposure: input.exposure ?? true,
    subscribed: input.subscribed ?? false,
    contractId: input.contractId === undefined ? null : input.contractId,
    promo: input.promo ?? false,
    mixed: input.mixed ?? false,
    transition: input.transition ?? false,
    staff: input.staff ?? false,
  };
}

function contract(
  id: string,
  extra: Partial<{
    status: string;
    cancelledAt: Date | null;
    failedAt: Date | null;
    expiredAt: Date | null;
  }> = {},
) {
  return {
    id,
    status: extra.status ?? "ACTIVE",
    cancelledAt: extra.cancelledAt ?? null,
    failedAt: extra.failedAt ?? null,
    expiredAt: extra.expiredAt ?? null,
    firstChargeAt: null,
    createdAt: daysAgo(10),
  };
}

const BASE_QUERY = {
  shopId: SHOP_ID,
  rangeDays: 90,
  marketHandle: null,
  groupBy: "variant" as const,
  now: NOW,
  fresh: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateScoreboardCache(SHOP_ID);
  mocks.factFindMany.mockResolvedValue([]);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.marketFindMany.mockResolvedValue([]);
  mocks.shopFindUnique.mockResolvedValue({
    id: SHOP_ID,
    domain: "cellexia.myshopify.com",
    ianaTimezone: TZ,
    currencyCode: "GBP",
  });
  mocks.getSetting.mockResolvedValue({
    startedAt: null,
    excludeEmails: [],
    guardrailMaxOrderDropPct: 10,
    guardrailMinOrdersPerWeek: 20,
    weeklySessions: {},
  });
  mocks.computeCohortRows.mockResolvedValue([]);
  mocks.summarizeLtgp.mockReturnValue({
    cohorts: [],
    weightedAvg: { m3Cents: null, m6Cents: null, m12Cents: null },
  });
  mocks.getDesignCalendar.mockResolvedValue([]);
  mocks.loadLedgerRevisions.mockResolvedValue([]);
  mocks.visitSummary.mockResolvedValue([]);
  mocks.lastVisitAt.mockResolvedValue(null);
  // Default presence check consistent with the summary mock (the real
  // hasVisits reads the same table, unscoped): true when the summary would
  // return rows for the shop without a market filter. Called through the
  // implementation, not the mock, so visitSummary's call count stays exact.
  mocks.hasVisits.mockImplementation(async () => {
    const impl = mocks.visitSummary.getMockImplementation();
    const rows = impl
      ? await impl(SHOP_ID, { since: null, until: NOW, marketHandle: null, tz: TZ })
      : [];
    return Array.isArray(rows) && rows.length > 0;
  });
});

/** Shop-tz day key (Europe/Zurich) of an instant, the way WidgetVisitorDay.day is stored. */
function dayKeyOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

interface VisitInput {
  designKey?: string;
  designPreselect?: string;
  day?: string;
  visits?: number;
  views?: number;
  engaged?: number;
  addedToCart?: number;
  addedSubscription?: number;
}

/** The conversion block of a row without visits (not recorded, or synthetic). */
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

/** A visitSummary row: subscription_max × sub, 3 days ago, 100 visitors by default. */
function visit(input: VisitInput = {}) {
  const visits = input.visits ?? 100;
  return {
    designKey: input.designKey ?? "subscription_max",
    designPreselect: input.designPreselect ?? "sub",
    day: input.day ?? dayKeyOf(daysAgo(3)),
    visits,
    views: input.views ?? visits,
    engaged: input.engaged ?? 0,
    addedToCart: input.addedToCart ?? 0,
    addedSubscription: input.addedSubscription ?? 0,
  };
}

// ── Take rate, keys, labels, sorting ──────────────────────────────────────────

describe("take rate and variant rows", () => {
  it("groups by design × preselect, computes take rate = subscribed ÷ orders, sorts by orders desc", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ subscribed: true, contractId: "c1" }),
      fact({ subscribed: true, contractId: "c2" }),
      fact(),
      fact(),
      fact({ designPreselect: "one", subscribed: false }),
      fact({ designKey: "classic", designPreselect: null, calendarDesignKey: "classic" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1"), contract("c2")]);

    const board = await getScoreboard(BASE_QUERY);
    expect(board.cached).toBe(false);
    expect(board.totals.orders).toBe(6);
    expect(board.totals.subscribed).toBe(2);
    expect(board.rows.map((r) => r.key)).toEqual([
      "subscription_max|sub",
      "classic|unknown",
      "subscription_max|one",
    ]);
    const top = board.rows[0];
    expect(top.label).toBe("Subscription max · sub preselected");
    expect(top.designKey).toBe("subscription_max");
    expect(top.preselect).toBe("sub");
    expect(top.orders).toBe(4);
    expect(top.subscribed).toBe(2);
    expect(top.oneTime).toBe(2);
    expect(top.takeRatePct).toBe(50);
    expect(top.aovCents).toBe(4900);
    expect(board.rows[1].label).toBe("Classic");
    expect(board.rows[2].takeRatePct).toBe(0);
    // Every fact came from the seen property and agreed with the calendar.
    expect(board.totals.seenCoveragePct).toBe(100);
    expect(board.totals.calendarAgreementPct).toBe(100);
    expect(board.totals.unattributedSubscribed).toBe(0);
    // Population query is scoped to the shop, the range and never past `now`.
    const where = (mocks.factFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.shopId).toBe(SHOP_ID);
    expect(where.processedAt).toMatchObject({ lte: NOW });
    expect((where.processedAt as { gte: Date }).gte.getTime()).toBeLessThan(
      NOW.getTime() - 89 * DAY_MS,
    );
  });

  it("groupBy design collapses preselects; groupBy revision keys on the revision id and uses the calendar label", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ designPreselect: "sub" }),
      fact({ designPreselect: "one" }),
      fact({ designKey: "classic", designRevisionId: "rev_0" }),
    ]);
    mocks.getDesignCalendar.mockResolvedValue([
      {
        revisionId: "rev_1",
        label: "Big green button",
        preset: "subscription_max",
        preselect: "sub",
        marketHandle: null,
        from: daysAgo(30),
        to: null,
      },
    ]);

    const byDesign = await getScoreboard({ ...BASE_QUERY, groupBy: "design" });
    expect(byDesign.rows.map((r) => [r.key, r.orders, r.label])).toEqual([
      ["subscription_max", 2, "Subscription max"],
      ["classic", 1, "Classic"],
    ]);

    const byRevision = await getScoreboard({ ...BASE_QUERY, groupBy: "revision" });
    expect(byRevision.rows.map((r) => [r.key, r.orders])).toEqual([
      ["rev_1", 2],
      ["rev_0", 1],
    ]);
    expect(byRevision.rows[0].label).toBe(
      "Big green button (Subscription max · sub preselected)",
    );
    expect(byRevision.rows[0].revisionId).toBe("rev_1");
    // No calendar entry for rev_0: falls back to the row's own design label.
    expect(byRevision.rows[1].label).toBe("Classic · sub preselected");
    expect(byRevision.calendar).toHaveLength(1);
  });

  it("assigns grades by order count: <30 too early, <200 direction only, ≥200 usable", async () => {
    const rows = [
      ...Array.from({ length: 5 }, () => fact({ designKey: "a" })),
      ...Array.from({ length: 30 }, () => fact({ designKey: "b" })),
      ...Array.from({ length: 200 }, () => fact({ designKey: "c" })),
    ];
    mocks.factFindMany.mockResolvedValue(rows);
    const board = await getScoreboard(BASE_QUERY);
    const grade = (k: string) => board.rows.find((r) => r.key === k)!.grade;
    expect(grade("a|sub")).toBe("too_early");
    expect(grade("b|sub")).toBe("direction_only");
    expect(grade("c|sub")).toBe("usable");
  });

  it("returns an empty scoreboard (no rows, no weeks) when there are no facts", async () => {
    const board = await getScoreboard(BASE_QUERY);
    expect(board.rows).toEqual([]);
    expect(board.totals.orders).toBe(0);
    expect(board.totals.seenCoveragePct).toBeNull();
    expect(board.guardrail.verdicts).toEqual([]);
    // A trailing range still yields the week axis so the UI can render it.
    expect(board.weeks.length).toBeGreaterThan(10);
    expect(board.weeks[board.weeks.length - 1]).toBe("2026-W34");
  });
});

// ── Kept rates: maturity gates + churn end ────────────────────────────────────

describe("kept rates (held) with maturity gates", () => {
  it("only counts orders old enough for each horizon and uses the contract's churn end", async () => {
    mocks.factFindMany.mockResolvedValue([
      // 45 days old, subscribed, cancelled 10 days after the order:
      // matures at 30 (not kept), not yet at 60/90.
      fact({ processedAt: daysAgo(45), subscribed: true, contractId: "c_cancel" }),
      // 100 days old, subscribed, still active: kept at every horizon.
      fact({ processedAt: daysAgo(100), subscribed: true, contractId: "c_keep" }),
      // 100 days old, subscribed, dunning-exhausted (FAILED at +70d):
      // kept at 30 and 60, gone at 90.
      fact({ processedAt: daysAgo(100), subscribed: true, contractId: "c_failed" }),
      // 100 days old, one-time: matures everywhere, never a subscriber.
      fact({ processedAt: daysAgo(100) }),
      // 2 days old, subscribed: matures nowhere.
      fact({ processedAt: daysAgo(2), subscribed: true, contractId: "c_young" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([
      contract("c_cancel", { status: "CANCELLED", cancelledAt: daysAgo(35) }),
      contract("c_keep"),
      contract("c_failed", { status: "FAILED", failedAt: daysAgo(30) }),
      contract("c_young"),
    ]);

    const board = await getScoreboard(BASE_QUERY);
    const row = board.rows[0];
    expect(row.orders).toBe(5);
    // matureSubscribed rides along: it is the denominator of pct, and the
    // UI prints "held of matureSubscribed" next to the percentage.
    expect(row.held.d30).toEqual({ matureOrders: 4, matureSubscribed: 3, heldSubscribed: 2, pct: 66.7 });
    expect(row.held.d60).toEqual({ matureOrders: 3, matureSubscribed: 2, heldSubscribed: 2, pct: 100 });
    expect(row.held.d90).toEqual({ matureOrders: 3, matureSubscribed: 2, heldSubscribed: 1, pct: 50 });
    // The contract lookup spreads the countable filter (isDemo false + ownership).
    const where = (mocks.contractFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.shopId).toBe(SHOP_ID);
    expect(where.isDemo).toBe(false);
    expect(where.ownership).toBeDefined();
    expect((where.id as { in: string[] }).in.sort()).toEqual([
      "c_cancel",
      "c_failed",
      "c_keep",
      "c_young",
    ]);
  });

  it("reports pct null (not 0) while no subscribed order has matured, with matureSubscribed 0 so the UI can say 'no subscribers yet' rather than 'not yet'", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: daysAgo(40) }),
      fact({ processedAt: daysAgo(3), subscribed: true, contractId: "c1" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1")]);
    const board = await getScoreboard(BASE_QUERY);
    // One order matured at 30d (one-time), the subscribed one is 3 days old:
    // matured population 1, matured subscribers 0 → pct null, and the two
    // counts let the UI distinguish this from "no order old enough".
    expect(board.rows[0].held.d30).toEqual({
      matureOrders: 1,
      matureSubscribed: 0,
      heldSubscribed: 0,
      pct: null,
    });
    expect(board.rows[0].held.d60).toEqual({
      matureOrders: 0,
      matureSubscribed: 0,
      heldSubscribed: 0,
      pct: null,
    });
  });
});

// ── Quick cancels ─────────────────────────────────────────────────────────────

describe("quick cancels (14 days)", () => {
  it("counts subscribers of 14-day-old orders whose churn end fell within 14 days", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: daysAgo(20), subscribed: true, contractId: "c_quick" }),
      fact({ processedAt: daysAgo(20), subscribed: true, contractId: "c_late" }),
      fact({ processedAt: daysAgo(20), subscribed: true, contractId: "c_keep" }),
      fact({ processedAt: daysAgo(5), subscribed: true, contractId: "c_young" }),
      fact({ processedAt: daysAgo(20) }),
    ]);
    mocks.contractFindMany.mockResolvedValue([
      contract("c_quick", { status: "CANCELLED", cancelledAt: daysAgo(15) }),
      contract("c_late", { status: "CANCELLED", cancelledAt: daysAgo(2) }),
      contract("c_keep"),
      contract("c_young", { status: "CANCELLED", cancelledAt: daysAgo(4) }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.rows[0].quickCancel14).toEqual({
      matureSubscribed: 3,
      cancelled: 1,
      pct: 33.3,
    });
  });
});

// ── Synthetic no-exposure row, exclusions ─────────────────────────────────────

describe("population rules", () => {
  it("puts widget-untouched orders (exposure false + source none) in the synthetic no_exposure row", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact(),
      fact({
        exposure: false,
        designSource: "none",
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        calendarDesignKey: null,
        subscribed: true,
        contractId: "c_bypass",
      }),
      fact({
        exposure: false,
        designSource: "none",
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        calendarDesignKey: null,
      }),
      // No exposure but the calendar resolved a design: a normal design row.
      fact({ exposure: false, designSource: "calendar" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c_bypass")]);
    const board = await getScoreboard(BASE_QUERY);
    const synthetic = board.rows.find((r) => r.key === "no_exposure")!;
    expect(synthetic.label).toBe("No widget exposure");
    expect(synthetic.orders).toBe(2);
    expect(synthetic.subscribed).toBe(1);
    expect(synthetic.designKey).toBeNull();
    expect(synthetic.hygiene.noExposure).toBe(2);
    expect(board.rows.find((r) => r.key === "subscription_max|sub")!.orders).toBe(2);
    expect(board.totals.noExposure).toBe(3);
    expect(board.totals.unattributedSubscribed).toBe(1);
    expect(board.totals.orders).toBe(4);
    // Seen coverage: 1 of 4 rows came from the seen property (one calendar, two none).
    expect(board.totals.seenCoveragePct).toBe(25);
    // No guardrail verdict for synthetic rows.
    expect(board.guardrail.verdicts.map((v) => v.key)).not.toContain("no_exposure");
  });

  it("excludes foreign-only orders from rows and totals but keeps mixed ones (flagged)", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact(),
      fact({ ownership: "foreign", exposure: false, designSource: "calendar" }),
      fact({ ownership: "foreign", exposure: false, designSource: "none", designKey: null, designPreselect: null }),
      fact({ ownership: "mixed" }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.totals.orders).toBe(2);
    expect(board.totals.excludedForeignOnly).toBe(2);
    expect(board.rows).toHaveLength(1);
    const row = board.rows[0];
    expect(row.orders).toBe(2);
    // 1 mixed order in the row + 1 foreign-only order keyed to this design.
    expect(row.hygiene.foreignPlan).toBe(2);
    expect(row.hygiene.mixed).toBe(0);
    // The foreign-only no-exposure order created no synthetic row.
    expect(board.rows.find((r) => r.key === "no_exposure")).toBeUndefined();
  });

  it("excludes staff orders from every count and reports them per row and in totals", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact(),
      fact({ staff: true, subscribed: true, contractId: "c_staff" }),
      fact({ staff: true, designKey: "classic" }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.totals.orders).toBe(1);
    expect(board.totals.subscribed).toBe(0);
    expect(board.totals.excludedStaff).toBe(2);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].hygiene.staffExcluded).toBe(1);
    // A staff-only design creates no row, and its contract is never looked up.
    expect(mocks.contractFindMany).not.toHaveBeenCalled();
  });

  it("counts hygiene flags per row and the calendar disagreement", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ promo: true, mixed: true, transition: true }),
      fact({ calendarDesignKey: "classic" }),
      fact({ calendarDesignKey: null }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    const h = board.rows[0].hygiene;
    expect(h.promo).toBe(1);
    expect(h.mixed).toBe(1);
    expect(h.transition).toBe(1);
    expect(h.calendarDisagree).toBe(1);
    // 2 comparable rows, 1 agrees.
    expect(board.totals.calendarAgreementPct).toBe(50);
  });

  it("calendar agreement only compares storefront-stamped rows (seen / design_prop): calendar-sourced rows agree by construction and are left out", async () => {
    mocks.factFindMany.mockResolvedValue([
      // seen: agrees
      fact({ designSource: "seen", calendarDesignKey: "subscription_max" }),
      // design_prop: disagrees
      fact({ designSource: "design_prop", calendarDesignKey: "classic" }),
      // calendar-sourced: designKey IS the calendar's, so it would always
      // "agree"; it must not count (an earlier draft reported 66.7% here).
      fact({ designSource: "calendar", exposure: false, calendarDesignKey: "subscription_max" }),
      fact({ designSource: "calendar", exposure: false, calendarDesignKey: "subscription_max" }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.totals.orders).toBe(4);
    expect(board.totals.calendarAgreementPct).toBe(50);
    expect(board.rows[0].hygiene.calendarDisagree).toBe(1);
    // With only calendar-sourced rows there is nothing to compare: null, not 100.
    mocks.factFindMany.mockResolvedValue([
      fact({ designSource: "calendar", exposure: false, calendarDesignKey: "subscription_max" }),
    ]);
    const onlyCalendar = await getScoreboard(BASE_QUERY);
    expect(onlyCalendar.totals.calendarAgreementPct).toBeNull();
  });

  it("reserves the synthetic keys: a (forged) designKey 'no_exposure' or 'unknown' lands in the synthetic unknown row, never in a real one", async () => {
    mocks.factFindMany.mockResolvedValue([
      // A shopper can POST properties[_cellexia_seen]=no_exposure|s; the
      // sanitizer accepts it. Placed BEFORE the first genuine bypass order so
      // that, without the reservation, it would create the shared
      // "no_exposure" bucket as a NON-synthetic (guardrail-eligible) row.
      fact({ processedAt: daysAgo(10), designKey: "no_exposure", designPreselect: "sub", designSource: "seen", exposure: true }),
      fact({ processedAt: daysAgo(9), designKey: "unknown", designPreselect: null, designSource: "seen", exposure: true }),
      // Genuine bypass order.
      fact({
        processedAt: daysAgo(8),
        exposure: false,
        designSource: "none",
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        calendarDesignKey: null,
      }),
      fact({ processedAt: daysAgo(7) }),
    ]);
    for (const groupBy of ["variant", "design"] as const) {
      const board = await getScoreboard({ ...BASE_QUERY, groupBy });
      const keys = board.rows.map((r) => r.key).sort();
      expect(keys).toEqual(
        [groupBy === "variant" ? "subscription_max|sub" : "subscription_max", "no_exposure", "unknown"].sort(),
      );
      const unknown = board.rows.find((r) => r.key === "unknown")!;
      expect(unknown.orders).toBe(2);
      expect(unknown.label).toBe("Unknown design");
      expect(unknown.designKey).toBeNull();
      const bypass = board.rows.find((r) => r.key === "no_exposure")!;
      expect(bypass.orders).toBe(1);
      expect(bypass.label).toBe("No widget exposure");
      // Neither synthetic row gets a guardrail verdict (so neither can be the reference).
      expect(board.guardrail.verdicts.map((v) => v.key)).toEqual([
        groupBy === "variant" ? "subscription_max|sub" : "subscription_max",
      ]);
      // No real row keyed "no_exposure|sub" or "unknown|unknown" was created.
      expect(keys).not.toContain("no_exposure|sub");
      expect(keys).not.toContain("unknown|unknown");
    }
  });
});

// ── Weekly bucketing in the shop timezone ────────────────────────────────────

describe("weekly buckets (shop-tz ISO weeks)", () => {
  it("assigns an order at Sunday 22:30 UTC to Monday's week in Europe/Zurich", () => {
    const sundayLateUtc = new Date("2026-08-16T22:30:00.000Z");
    expect(isoWeekKey(sundayLateUtc, "UTC")).toBe("2026-W33");
    expect(isoWeekKey(sundayLateUtc, TZ)).toBe("2026-W34");
    // And the other direction: Monday 01:00 UTC is still Sunday in Los Angeles.
    const mondayEarlyUtc = new Date("2026-08-17T01:00:00.000Z");
    expect(isoWeekKey(mondayEarlyUtc, "America/Los_Angeles")).toBe("2026-W33");
    // ISO year boundary: 1 Jan 2027 (Friday) belongs to 2026-W53.
    expect(isoWeekKey(new Date("2027-01-01T12:00:00.000Z"), "UTC")).toBe("2026-W53");
  });

  it("buckets rows per shop-tz week, emits every week of the range (zeros included), aligned across rows", async () => {
    mocks.factFindMany.mockResolvedValue([
      // W33 in UTC, W34 in Zurich.
      fact({ processedAt: new Date("2026-08-16T22:30:00.000Z"), subscribed: true, contractId: "c1" }),
      // Clearly W33 everywhere (Wednesday 12 Aug).
      fact({ processedAt: new Date("2026-08-12T10:00:00.000Z") }),
      fact({ processedAt: new Date("2026-08-12T11:00:00.000Z"), designKey: "classic" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1")]);
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 14 });
    // 14 days back from Thursday 20 Aug lands on Thursday 6 Aug → W32..W34.
    expect(board.weeks).toEqual(["2026-W32", "2026-W33", "2026-W34"]);
    const max = board.rows.find((r) => r.key === "subscription_max|sub")!;
    expect(max.weekly).toEqual([
      { week: "2026-W32", orders: 0, subscribed: 0, oneTime: 0, visits: 0 },
      { week: "2026-W33", orders: 1, subscribed: 0, oneTime: 1, visits: 0 },
      { week: "2026-W34", orders: 1, subscribed: 1, oneTime: 0, visits: 0 },
    ]);
    const classic = board.rows.find((r) => r.key === "classic|sub")!;
    expect(classic.weekly.map((w) => w.orders)).toEqual([0, 1, 0]);
    // Conversion rows carry the population per week (sessions not entered).
    expect(board.conversion.map((c) => [c.week, c.orders, c.subscribed, c.sessions])).toEqual([
      ["2026-W32", 0, 0, null],
      ["2026-W33", 2, 0, null],
      ["2026-W34", 1, 1, null],
    ]);
    expect(board.conversion[1].dominantKey).toBe("subscription_max|sub");
    expect(board.conversion[0].dominantKey).toBeNull();
  });

  it("with no range and no startedAt the week axis starts at the first order's week", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: new Date("2026-08-04T10:00:00.000Z") }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: null });
    expect(board.weeks).toEqual(["2026-W32", "2026-W33", "2026-W34"]);
    const where = (mocks.factFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.processedAt).toEqual({ lte: NOW });
  });
});

// ── Guardrail verdicts ───────────────────────────────────────────────────────

describe("guardrail verdicts", () => {
  const wk = (orders: number[], from = 30) =>
    orders.map((n, i) => ({
      week: `2026-W${from + i}`,
      orders: n,
      subscribed: 0,
      oneTime: n,
    }));
  const OPTS = { maxOrderDropPct: 10, minOrdersPerWeek: 20, currentWeek: "2026-W40" };

  it("ok: the reference is ok and a design within tolerance is ok", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 190, weekly: wk([0, 0, 95, 95]) },
      ],
      OPTS,
    );
    expect(verdicts).toEqual([
      expect.objectContaining({ key: "ref", status: "ok" }),
      expect.objectContaining({ key: "b", status: "ok" }),
    ]);
    expect(verdicts[0].detail).toContain("Reference design");
    expect(verdicts[1].detail).toContain("95 vs 100");
  });

  it("watch: a mean drop between half the threshold and the threshold", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 184, weekly: wk([0, 0, 92, 92]) },
      ],
      OPTS,
    );
    expect(verdicts[1]).toMatchObject({ key: "b", status: "watch" });
    expect(verdicts[1].detail).toContain("down 8%");
  });

  it("breach: mean below the reference by more than the threshold over at least 2 qualifying weeks", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 160, weekly: wk([0, 0, 80, 80]) },
      ],
      OPTS,
    );
    expect(verdicts[1]).toMatchObject({ key: "b", status: "breach" });
    expect(verdicts[1].detail).toContain("down 20%");
    expect(verdicts[1].detail).toContain("2 weeks each more than 10% below");
  });

  it("insufficient: fewer than 2 qualifying weeks (zero weeks and the current partial week never qualify)", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        // one full week at 80, plus the current week (ignored).
        {
          key: "b",
          synthetic: false,
          orders: 88,
          weekly: [...wk([0, 0, 0, 80], 30), { week: "2026-W40", orders: 8, subscribed: 0, oneTime: 8 }],
        },
        { key: "no_exposure", synthetic: true, orders: 900, weekly: wk([300, 300, 300]) },
      ],
      OPTS,
    );
    expect(verdicts.map((v) => v.key)).toEqual(["ref", "b"]);
    expect(verdicts[1]).toMatchObject({ key: "b", status: "insufficient" });
    expect(verdicts[1].detail).toContain("Only 1 full week");
  });

  it("a single breaching week is WATCH (not breach), with the 'on single weeks' wording; two breaching weeks make it a breach", () => {
    // Mean drop 20% (60 and 100 vs 100) but only ONE week is individually
    // more than 10% below the reference: the ">= 2 breaching weeks" rule
    // holds it at watch. Removing that rule would flip this to breach.
    const single = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 160, weekly: wk([0, 0, 100, 60]) },
      ],
      OPTS,
    );
    expect(single[1]).toMatchObject({ key: "b", status: "watch" });
    expect(single[1].detail).toContain("down 20%");
    expect(single[1].detail).toContain("on single weeks");
    expect(single[1].detail).not.toContain("weeks each more than");

    // Mirror: both weeks 15% below → 2 breaching weeks → breach.
    const two = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 170, weekly: wk([0, 0, 85, 85]) },
      ],
      OPTS,
    );
    expect(two[1]).toMatchObject({ key: "b", status: "breach" });
    expect(two[1].detail).toContain("down 15%");
    expect(two[1].detail).toContain("2 weeks each more than 10% below");
  });

  it("the range's leading partial week never qualifies (partialWeeks), so it cannot dilute the reference mean; the detail counts only the weeks used", () => {
    // Reference: a 4-order tail of the week the range starts in, then 8 full
    // weeks at 30. Challenger: 25/week over 3 full weeks. With the partial
    // week counted as full the reference mean reads 27.1 and the challenger
    // is only "watch" (down 7.8%); with it excluded the mean is 30 and the
    // challenger is a breach (down 16.7%, 3 breaching weeks).
    const rows = [
      { key: "ref", synthetic: false, orders: 244, weekly: wk([4, 30, 30, 30, 30, 30, 30, 30, 30], 30) },
      { key: "b", synthetic: false, orders: 75, weekly: wk([0, 0, 0, 0, 0, 0, 25, 25, 25], 30) },
    ];
    const withPartial = computeGuardrailVerdicts(rows, {
      ...OPTS,
      partialWeeks: new Set(["2026-W30"]),
    });
    expect(withPartial[0]).toMatchObject({ key: "ref", status: "ok" });
    expect(withPartial[0].detail).toContain("30 orders per week over 8 full weeks");
    expect(withPartial[1]).toMatchObject({ key: "b", status: "breach" });
    expect(withPartial[1].detail).toContain("down 16.7%");
    expect(withPartial[1].detail).toContain("3 weeks each more than 10% below");
    // Sanity: the same rows WITHOUT the partial-week hint show the dilution.
    const diluted = computeGuardrailVerdicts(rows, OPTS);
    expect(diluted[0].detail).toContain("over 9 full weeks");
    expect(diluted[1]).toMatchObject({ key: "b", status: "watch" });
  });

  it("a challenger that collapses orders below the floor is a BREACH, not insufficient (the floor applies to the reference)", () => {
    // Reference averages 100/week; challenger 12 and 8 — both weeks are far
    // below the reference. An earlier draft filtered the challenger's own
    // weeks by the 20-orders floor and reported "insufficient", hiding
    // exactly the failure the guardrail exists for.
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wk([100, 100, 100, 100]) },
        { key: "b", synthetic: false, orders: 20, weekly: wk([0, 0, 12, 8]) },
      ],
      OPTS,
    );
    expect(verdicts[1]).toMatchObject({ key: "b", status: "breach" });
  });

  it("insufficient for everyone when the reference itself lacks 2 qualifying weeks or averages below the floor", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 40, weekly: wk([25, 15]) },
        { key: "b", synthetic: false, orders: 30, weekly: wk([15, 15]) },
      ],
      OPTS,
    );
    // ref has 2 full weeks averaging 20 = the floor (20 in OPTS) → ready
    // unless the floor is above 20; check the below-floor case explicitly.
    const belowFloor = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 30, weekly: wk([16, 14]) },
        { key: "b", synthetic: false, orders: 30, weekly: wk([15, 15]) },
      ],
      OPTS,
    );
    expect(belowFloor).toEqual([
      expect.objectContaining({ key: "ref", status: "insufficient" }),
      expect.objectContaining({ key: "b", status: "insufficient" }),
    ]);
    expect(belowFloor[0].detail).toContain("floor");
    const oneWeek = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 40, weekly: wk([40, 0]) },
        { key: "b", synthetic: false, orders: 30, weekly: wk([15, 15]) },
      ],
      OPTS,
    );
    expect(oneWeek[0]).toMatchObject({ key: "ref", status: "insufficient" });
    expect(oneWeek[1]).toMatchObject({ key: "b", status: "insufficient" });
    // and with the reference at the floor everything is judged normally
    expect(verdicts[0]).toMatchObject({ key: "ref", status: "ok" });
  });

  it("wires settings + weekly rows through getScoreboard (reference = most orders)", async () => {
    // Reference design: 30/week for weeks W30..W32; challenger: 24/week W33 (full) and W34 (current, ignored)
    // → 20% drop but only 1 qualifying full week → insufficient. Then thresholds from settings.
    const rows: ReturnType<typeof fact>[] = [];
    const weekStart = (isoWeekMonday: string) => new Date(isoWeekMonday);
    for (const monday of ["2026-07-20", "2026-07-27", "2026-08-03"]) {
      for (let i = 0; i < 30; i++) {
        rows.push(fact({ processedAt: new Date(weekStart(monday).getTime() + i * 3_600_000 + 12 * 3_600_000) }));
      }
    }
    for (let i = 0; i < 24; i++) {
      rows.push(fact({ designKey: "classic", processedAt: new Date(new Date("2026-08-10").getTime() + 12 * 3_600_000 + i * 3_600_000) }));
    }
    mocks.factFindMany.mockResolvedValue(rows);
    mocks.getSetting.mockResolvedValue({
      startedAt: null,
      excludeEmails: [],
      guardrailMaxOrderDropPct: 15,
      guardrailMinOrdersPerWeek: 10,
      weeklySessions: {},
    });
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 60 });
    expect(board.guardrail.maxOrderDropPct).toBe(15);
    expect(board.guardrail.minOrdersPerWeek).toBe(10);
    expect(board.guardrail.verdicts).toEqual([
      expect.objectContaining({ key: "subscription_max|sub", status: "ok" }),
      expect.objectContaining({ key: "classic|sub", status: "insufficient" }),
    ]);
  });

  it("through getScoreboard: a range starting mid-week marks its first week partial (excluded from the verdict math, still on the week axis); a range starting on Monday 00:00 shop time does not", async () => {
    // NOW is Thursday 20 Aug 2026 (Zurich). rangeDays 30 → since = Tuesday
    // 21 Jul 00:00 Zurich, i.e. inside W30 (Mon 20 Jul): W30 is partial.
    // Reference: 4 orders in the W30 tail + 30/week in W31..W33.
    // Challenger: 25/week in W31..W33. W34 is the current week.
    const at = (iso: string, i: number) => new Date(new Date(iso).getTime() + (12 + i) * 3_600_000);
    const rows: ReturnType<typeof fact>[] = [];
    for (let i = 0; i < 4; i++) rows.push(fact({ processedAt: at("2026-07-22", i) }));
    for (const monday of ["2026-07-27", "2026-08-03", "2026-08-10"]) {
      for (let i = 0; i < 30; i++) rows.push(fact({ processedAt: at(monday, i) }));
      for (let i = 0; i < 25; i++) rows.push(fact({ designKey: "classic", processedAt: at(monday, i) }));
    }
    mocks.factFindMany.mockResolvedValue(rows);

    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 30 });
    expect(board.weeks).toEqual(["2026-W30", "2026-W31", "2026-W32", "2026-W33", "2026-W34"]);
    const ref = board.rows.find((r) => r.key === "subscription_max|sub")!;
    // The weekly TABLE still shows the partial week's orders.
    expect(ref.weekly.map((w) => w.orders)).toEqual([4, 30, 30, 30, 0]);
    // The verdict math skips it: reference mean 30 over 3 full weeks (not
    // 23.5 over 4), so the 25/week challenger reads as the breach it is.
    expect(board.guardrail.verdicts).toEqual([
      expect.objectContaining({ key: "subscription_max|sub", status: "ok" }),
      expect.objectContaining({ key: "classic|sub", status: "breach" }),
    ]);
    expect(board.guardrail.verdicts[0].detail).toContain("30 orders per week over 3 full weeks");
    expect(board.guardrail.verdicts[1].detail).toContain("down 16.7%");

    // rangeDays 24 → since = Monday 27 Jul 00:00 Zurich = the W31 boundary:
    // nothing is partial, W31 counts (3 full weeks W31..W33 again, W30 is
    // simply out of range).
    const onBoundary = await getScoreboard({ ...BASE_QUERY, rangeDays: 24 });
    expect(onBoundary.weeks[0]).toBe("2026-W31");
    expect(onBoundary.guardrail.verdicts[0].detail).toContain("over 3 full weeks");
    expect(onBoundary.guardrail.verdicts[1]).toMatchObject({ key: "classic|sub", status: "breach" });
  });
});

// ── probabilityBetterThan ─────────────────────────────────────────────────────

describe("probabilityBetterThan", () => {
  it("is 0.5 for identical evidence and for no evidence at all", () => {
    expect(probabilityBetterThan(10, 100, 10, 100)).toBe(0.5);
    expect(probabilityBetterThan(0, 0, 0, 0)).toBe(0.5);
  });

  it("is symmetric: P(B>A) + P(A>B) = 1, including a peaked posterior next to a wide one", () => {
    const p = probabilityBetterThan(12, 100, 20, 100);
    const q = probabilityBetterThan(20, 100, 12, 100);
    expect(p + q).toBeCloseTo(1, 10);
    const p2 = probabilityBetterThan(300, 2500, 340, 2500);
    const q2 = probabilityBetterThan(340, 2500, 300, 2500);
    expect(p2 + q2).toBeCloseTo(1, 10);
    // Peaked (1/20000) vs wide (10/20): the old shared-grid quadrature gave
    // 0.171 one way and 0.000 the other (sum 0.17, not 1).
    const p3 = probabilityBetterThan(1, 20000, 10, 20);
    const q3 = probabilityBetterThan(10, 20, 1, 20000);
    expect(p3 + q3).toBeCloseTo(1, 10);
    expect(p3).toBeGreaterThanOrEqual(0.999);
  });

  it("matches the exact closed form: known values, a certain winner, and a clear winner", () => {
    expect(probabilityBetterThan(10, 100, 30, 100)).toBeGreaterThan(0.9);
    expect(probabilityBetterThan(30, 100, 10, 100)).toBeLessThan(0.1);
    // Large, close counts (peaked posteriors) still evaluate sensibly.
    const big = probabilityBetterThan(1000, 5000, 1100, 5000);
    expect(big).toBeGreaterThan(0.95);
    expect(big).toBeLessThanOrEqual(1);
    // Known value: 1/2 vs 2/2 with flat priors, Beta(2,2) vs Beta(3,1):
    // P(B>A) = ∫ 3x² · (3x² − 2x³) dx = 9/5 − 1 = 0.8 exactly.
    expect(probabilityBetterThan(1, 2, 2, 2)).toBeCloseTo(0.8, 10);
    // And 0/1 vs 1/1: Beta(1,2) vs Beta(2,1): ∫ 2x · (2x − x²) dx = 4/3 − 1/2 = 5/6.
    expect(probabilityBetterThan(0, 1, 1, 1)).toBeCloseTo(5 / 6, 10);
    // A very peaked posterior next to a wide one: the exact answer is 1.000
    // (to 3 decimals). The old quadrature printed 0.879 / 0.928 here because
    // the peaked density got a handful of grid points, so a certain winner
    // showed "88%" in the "chance it beats the reference" column.
    expect(probabilityBetterThan(1, 5000, 15, 30)).toBeGreaterThanOrEqual(0.999);
    expect(probabilityBetterThan(2, 10000, 50, 100)).toBeGreaterThanOrEqual(0.999);
    expect(probabilityBetterThan(15, 30, 1, 5000)).toBeLessThanOrEqual(0.001);
  });

  it("tolerates garbage input (negative, NaN, successes above totals)", () => {
    expect(probabilityBetterThan(-5, 10, 5, 10)).toBeGreaterThan(0.9);
    expect(probabilityBetterThan(50, 10, 5, 10)).toBeLessThan(0.5);
    // No evidence on A (flat prior) against a symmetric 5/10 on B: exactly
    // 1/2 (E[pB] = 0.5); the old quadrature returned slightly above 0.5 by
    // integration error, the closed form lands on it.
    expect(probabilityBetterThan(NaN, NaN, 5, 10)).toBeCloseTo(0.5, 10);
    expect(probabilityBetterThan(NaN, NaN, 8, 10)).toBeGreaterThan(0.5);
  });
});

// ── LTGP plumbing, markets, conversion, calendar containment ─────────────────

describe("LTGP, markets, conversion, calendar", () => {
  it("runs the cohort engine per row over the row's contract ids and maps the weighted averages", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ subscribed: true, contractId: "c1", processedAt: daysAgo(120) }),
      fact({ subscribed: true, contractId: "c2", processedAt: daysAgo(120) }),
      fact({ designKey: "classic" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1"), contract("c2")]);
    mocks.computeCohortRows.mockResolvedValue([{ cohortMonth: "2026-04", monthOffset: 0 }]);
    mocks.summarizeLtgp.mockReturnValue({
      cohorts: [],
      weightedAvg: { m3Cents: 4200, m6Cents: null, m12Cents: null },
    });
    const board = await getScoreboard(BASE_QUERY);
    const max = board.rows.find((r) => r.key === "subscription_max|sub")!;
    expect(max.ltgp).toEqual({ m3: 4200, m6: null, m12: null, contracts: 2 });
    expect(mocks.computeCohortRows).toHaveBeenCalledTimes(1);
    const [shopId, now, opts] = mocks.computeCohortRows.mock.calls[0] as [string, Date, { contractIds: string[] }];
    expect(shopId).toBe(SHOP_ID);
    expect(now).toBe(NOW);
    expect([...opts.contractIds].sort()).toEqual(["c1", "c2"]);
    // A row without contracts gets null LTGP and no engine call.
    expect(board.rows.find((r) => r.key === "classic|sub")!.ltgp).toBeNull();
  });

  it("contains a cohort-engine failure to the row (LTGP null, everything else intact)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.factFindMany.mockResolvedValue([
      fact({ subscribed: true, contractId: "c1" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1")]);
    mocks.computeCohortRows.mockRejectedValue(new Error("cost model down"));
    const board = await getScoreboard(BASE_QUERY);
    expect(board.rows[0].ltgp).toBeNull();
    expect(board.rows[0].orders).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(
      "[design-measurement] ltgp failed",
      "subscription_max|sub",
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("lists markets with whole-range order counts and scopes rows to the requested market", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ marketHandle: "gb" }),
      fact({ marketHandle: "gb" }),
      fact({ marketHandle: "eu", designKey: "classic" }),
      fact({ marketHandle: null }),
      fact({ marketHandle: "gb", staff: true }),
    ]);
    mocks.marketFindMany.mockResolvedValue([
      { marketHandle: "gb", marketName: "United Kingdom" },
      { marketHandle: "gb", marketName: "United Kingdom" },
      { marketHandle: "eu", marketName: "Europe" },
      { marketHandle: "us", marketName: "United States" },
    ]);
    const all = await getScoreboard(BASE_QUERY);
    expect(all.markets).toEqual([
      { handle: "gb", name: "United Kingdom", orders: 2 },
      { handle: "eu", name: "Europe", orders: 1 },
      { handle: "us", name: "United States", orders: 0 },
    ]);
    expect(all.totals.orders).toBe(4);

    const eu = await getScoreboard({ ...BASE_QUERY, marketHandle: "eu" });
    expect(eu.marketHandle).toBe("eu");
    expect(eu.totals.orders).toBe(1);
    expect(eu.rows.map((r) => r.key)).toEqual(["classic|sub"]);
    // The market list is NOT narrowed by the market filter.
    expect(eu.markets.map((m) => m.orders)).toEqual([2, 1, 0]);
  });

  it("computes conversion from typed-in weekly sessions and echoes the start date", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: new Date("2026-08-12T10:00:00.000Z"), subscribed: true, contractId: "c1" }),
      fact({ processedAt: new Date("2026-08-12T11:00:00.000Z") }),
      fact({ processedAt: new Date("2026-08-12T12:00:00.000Z") }),
      fact({ processedAt: new Date("2026-08-12T13:00:00.000Z") }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1")]);
    mocks.getSetting.mockResolvedValue({
      startedAt: "2026-08-10",
      excludeEmails: [],
      guardrailMaxOrderDropPct: 10,
      guardrailMinOrdersPerWeek: 20,
      weeklySessions: { "2026-W33": 200 },
    });
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: null });
    expect(board.startedAt).toBe("2026-08-10");
    // startedAt (Monday 10 Aug, Zurich) is the floor: the axis starts at W33.
    expect(board.weeks).toEqual(["2026-W33", "2026-W34"]);
    const where = (mocks.factFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect((where.processedAt as { gte: Date }).gte.toISOString()).toBe("2026-08-09T22:00:00.000Z");
    expect(board.conversion[0]).toEqual({
      week: "2026-W33",
      sessions: 200,
      orders: 4,
      subscribed: 1,
      conversionPct: 2,
      subscriptionConversionPct: 0.5,
      dominantKey: "subscription_max|sub",
    });
    expect(board.conversion[1].sessions).toBeNull();
    expect(board.conversion[1].conversionPct).toBeNull();
  });

  it("a trailing range never reaches behind startedAt", async () => {
    mocks.getSetting.mockResolvedValue({
      startedAt: "2026-08-01",
      excludeEmails: [],
      guardrailMaxOrderDropPct: 10,
      guardrailMinOrdersPerWeek: 20,
      weeklySessions: {},
    });
    await getScoreboard({ ...BASE_QUERY, rangeDays: 365 });
    const where = (mocks.factFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect((where.processedAt as { gte: Date }).gte.toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });

  it("degrades to an empty calendar when the ledger throws, and passes `since` to it otherwise", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getDesignCalendar.mockRejectedValue(new Error("ledger down"));
    mocks.factFindMany.mockResolvedValue([fact()]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.calendar).toEqual([]);
    expect(board.rows).toHaveLength(1);
    errSpy.mockRestore();

    mocks.getDesignCalendar.mockResolvedValue([]);
    await getScoreboard({ ...BASE_QUERY, rangeDays: 30 });
    const opts = mocks.getDesignCalendar.mock.calls[1][1] as { since: Date };
    expect(opts.since).toBeInstanceOf(Date);
    expect(mocks.getDesignCalendar.mock.calls[1][0]).toBe(SHOP_ID);
  });

  it("falls back to defaults when the stored setting has an unexpected shape", async () => {
    mocks.getSetting.mockResolvedValue({ guardrailMaxOrderDropPct: "ten", weeklySessions: { bad: 1, "2026-W33": 5 } });
    const board = await getScoreboard(BASE_QUERY);
    expect(board.guardrail.maxOrderDropPct).toBe(10);
    expect(board.guardrail.minOrdersPerWeek).toBe(20);
    expect(board.startedAt).toBeNull();
  });
});

// ── Visits (v1.27.0) ──────────────────────────────────────────────────────────

describe("visits join (v1.27.0)", () => {
  it("joins visits onto rows by design key + preselect, gives unmatched real rows zeros, synthetic rows null, and creates a visit-only row for a design with no order yet", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ subscribed: true, contractId: "c1" }),
      fact({ subscribed: true, contractId: "c2" }),
      fact(),
      fact(),
      fact({ designPreselect: "one" }),
      // Fact preselect null ↔ visit preselect "u": both key as "|unknown".
      fact({ designKey: "classic", designPreselect: null, calendarDesignKey: "classic" }),
      fact({ designKey: "plain", designPreselect: "sub" }),
      fact({
        exposure: false,
        designSource: "none",
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        calendarDesignKey: null,
      }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1"), contract("c2")]);
    mocks.visitSummary.mockResolvedValue([
      visit({ visits: 100, views: 120, engaged: 30, addedToCart: 10, addedSubscription: 6 }),
      visit({ day: dayKeyOf(daysAgo(4)), visits: 100, views: 100, engaged: 20, addedToCart: 10, addedSubscription: 4 }),
      visit({ designPreselect: "one", visits: 50 }),
      visit({ designKey: "classic", designPreselect: "u", visits: 25 }),
      // A design that has visits but no order yet.
      visit({ designKey: "toggle", visits: 40, addedToCart: 2 }),
    ]);
    mocks.lastVisitAt.mockResolvedValue(new Date("2026-08-20T11:58:00.000Z"));

    const board = await getScoreboard(BASE_QUERY);
    const byKey = (k: string) => board.rows.find((r) => r.key === k)!;

    const max = byKey("subscription_max|sub");
    expect(max.visits).toEqual({ visits: 200, views: 220, engaged: 50, addedToCart: 20, addedSubscription: 10 });
    expect(max.conversion).toEqual({
      ordersPer100Visits: 2, // 4 orders ÷ 200 visits
      subscriptionsPer100Visits: 1, // 2 subscribed ÷ 200
      keptSubscribersPer100VisitsD30: null, // no visit day old enough yet
      addToCartPct: 10,
      subscriptionPickPct: 50, // 10 of 20 adds picked the subscription
      // Every order sits on a covered day (3 days ago has visits), so the
      // time-aligned numerators equal the row's orders here.
      ordersCounted: 4,
      subscribedCounted: 2,
      keptCounted: 0,
      maturedVisits: 0,
      firstVisitDay: dayKeyOf(daysAgo(4)),
    });
    expect(byKey("subscription_max|one").visits!.visits).toBe(50);
    expect(byKey("classic|unknown").visits!.visits).toBe(25);
    // Visits recorded on the shop but none for this design: zeros, not null.
    expect(byKey("plain|sub").visits).toEqual({ visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 });
    expect(byKey("plain|sub").conversion.ordersPer100Visits).toBeNull();
    // Its order is still on a covered day: counted, just no denominator.
    expect(byKey("plain|sub").conversion.ordersCounted).toBe(1);
    // Synthetic rows can never join a visit.
    const synthetic = byKey("no_exposure");
    expect(synthetic.visits).toBeNull();
    expect(synthetic.conversion).toEqual(NULL_CONVERSION);
    // Presence: recorded, and no market filter, so unscoped = scoped.
    expect(board.totals.visitsRecorded).toBe(true);
    expect(board.totals.visitsUnscoped).toBe(315);
    // The visit-only row: 0 orders, its identity from the visit stamps,
    // conversion 0 (not null), sorted after every row with orders.
    const toggle = byKey("toggle|sub");
    expect(toggle.orders).toBe(0);
    expect(toggle.takeRatePct).toBeNull();
    expect(toggle.designKey).toBe("toggle");
    expect(toggle.preselect).toBe("sub");
    expect(toggle.label).toBe("Toggle · sub preselected");
    expect(toggle.grade).toBe("too_early");
    expect(toggle.visits!.visits).toBe(40);
    expect(toggle.conversion.ordersPer100Visits).toBe(0);
    expect(toggle.conversion.addToCartPct).toBe(5);
    expect(board.rows[board.rows.length - 1].key).toBe("toggle|sub");
    // Totals: every visit row counts, market-scoped like the rows.
    expect(board.totals.visits).toBe(315);
    expect(board.totals.lastVisitAt).toBe("2026-08-20T11:58:00.000Z");
    // The read is scoped like the facts: same since, until = now, market, shop tz.
    expect(mocks.visitSummary).toHaveBeenCalledTimes(1);
    const [shopId, opts] = mocks.visitSummary.mock.calls[0] as [string, { since: Date | null; until: Date; marketHandle: string | null; tz: string }];
    expect(shopId).toBe(SHOP_ID);
    expect(opts.until).toBe(NOW);
    expect(opts.marketHandle).toBeNull();
    expect(opts.tz).toBe(TZ);
    const where = (mocks.factFindMany.mock.calls[0][0] as { where: { processedAt: { gte: Date } } }).where;
    expect(opts.since?.getTime()).toBe(where.processedAt.gte.getTime());
  });

  it("kept subscribers per 100 visits (30d) divides matured subscribers by MATURED visits only (day end + 30 days ≤ now)", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: daysAgo(45), subscribed: true, contractId: "c_keep" }),
      fact({ processedAt: daysAgo(45), subscribed: true, contractId: "c_cancel" }),
      fact({ processedAt: daysAgo(45) }),
      fact({ processedAt: daysAgo(3), subscribed: true, contractId: "c_young" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([
      contract("c_keep"),
      contract("c_cancel", { status: "CANCELLED", cancelledAt: daysAgo(40) }),
      contract("c_young"),
    ]);
    mocks.visitSummary.mockResolvedValue([
      visit({ day: dayKeyOf(daysAgo(45)), visits: 200 }),
      // Exactly 30 days ago: its day END + 30d is later today, so it has NOT matured.
      visit({ day: dayKeyOf(daysAgo(30)), visits: 1000 }),
      // 31 days ago: day end + 30d was yesterday → matured.
      visit({ day: dayKeyOf(daysAgo(31)), visits: 300 }),
      visit({ day: dayKeyOf(daysAgo(3)), visits: 300 }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    const row = board.rows[0];
    expect(row.held.d30).toMatchObject({ matureSubscribed: 2, heldSubscribed: 1 });
    // 1 kept subscriber ÷ 500 matured visits (200 + 300) × 100 = 0.2. Over
    // ALL 1,800 visits it would read 0.06; over the 30-days-ago day too it
    // would be 0.07: both wrong denominators for a matured numerator.
    expect(row.conversion.keptSubscribersPer100VisitsD30).toBe(0.2);
    expect(row.conversion.keptCounted).toBe(1);
    expect(row.conversion.maturedVisits).toBe(500);
    // Plain conversion still uses every visit in range, 2 decimals.
    expect(row.conversion.ordersPer100Visits).toBe(0.22); // 4 ÷ 1800 × 100 = 0.222

    // No matured visit day yet → null, even though d30 has matured orders.
    mocks.visitSummary.mockResolvedValue([visit({ day: dayKeyOf(daysAgo(3)), visits: 300 })]);
    const young = await getScoreboard(BASE_QUERY);
    expect(young.rows[0].held.d30.matureOrders).toBe(3);
    expect(young.rows[0].conversion.keptSubscribersPer100VisitsD30).toBeNull();
    // The numerator only counts orders on covered days: the 45-day-old kept
    // subscriber has no visit row on its day now, so keptCounted is 0 (and
    // ordersCounted only sees the 3-day-old order).
    expect(young.rows[0].conversion.keptCounted).toBe(0);
    expect(young.rows[0].conversion.ordersCounted).toBe(1);
  });

  it("kept subscribers per 100 visits matures the ORDER side by the same day rule as the visits (day end + 30 days ≤ now), so the day exactly 30 days ago is out on both sides", async () => {
    // Two kept subscribers: one 31 days ago (its whole day has matured), one
    // 30 days ago at 12:00 UTC (the order INSTANT + 30d equals now, so the
    // instant gate of held.d30 lets it in, but its day ends 23:59:59 Zurich,
    // later than now: NOT matured on the day rule).
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: daysAgo(31), subscribed: true, contractId: "c_a" }),
      fact({ processedAt: daysAgo(30), subscribed: true, contractId: "c_b" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c_a"), contract("c_b")]);
    mocks.visitSummary.mockResolvedValue([
      visit({ day: dayKeyOf(daysAgo(31)), visits: 200 }),
      visit({ day: dayKeyOf(daysAgo(30)), visits: 1000 }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    const row = board.rows[0];
    // The kept RATE keeps its instant gate: both orders matured, both kept.
    expect(row.held.d30).toMatchObject({ matureSubscribed: 2, heldSubscribed: 2, pct: 100 });
    // The per-100 metric: 1 kept (day 31) over 200 matured visits (day 31)
    // = 0.5 per 100. Instant-gated orders over day-gated visits read 2 ÷ 200
    // = 1.0, double the truth, and 2 ÷ 1200 = 0.17 would mix the horizons.
    expect(row.conversion.keptCounted).toBe(1);
    expect(row.conversion.maturedVisits).toBe(200);
    expect(row.conversion.keptSubscribersPer100VisitsD30).toBe(0.5);

    // One second past that day's end + 30 days, both sides mature together.
    const dayAfter = new Date(
      new Date(`${dayKeyOf(daysAgo(30))}T23:59:59.999+02:00`).getTime() + 30 * DAY_MS + 1,
    );
    const later = await getScoreboard({ ...BASE_QUERY, now: dayAfter });
    expect(later.rows[0].conversion.keptCounted).toBe(2);
    expect(later.rows[0].conversion.maturedVisits).toBe(1200);
    expect(later.rows[0].conversion.keptSubscribersPer100VisitsD30).toBe(0.17);
  });

  it("design grouping collapses the preselects of the visits like it does for the facts", async () => {
    mocks.factFindMany.mockResolvedValue([fact({ designPreselect: "sub" }), fact({ designPreselect: "one" })]);
    mocks.visitSummary.mockResolvedValue([
      visit({ designPreselect: "sub", visits: 10 }),
      visit({ designPreselect: "one", visits: 20 }),
      visit({ designPreselect: "u", visits: 5 }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, groupBy: "design" });
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].key).toBe("subscription_max");
    expect(board.rows[0].visits!.visits).toBe(35);
    expect(board.rows[0].conversion.ordersPer100Visits).toBe(5.71); // 2 ÷ 35 = 5.714
  });

  it("time-aligns conversion: orders processed before the first visit day (beacon deployed mid-range) are excluded from the per-100-visits rates and the comparison chance, but still count in take rate and orders", async () => {
    // 300 orders over the range, 30 of them on the 3 covered days; the beacon
    // recorded 30 visits on those days. Whole-range orders over since-deploy
    // visits would print 1000 per 100.
    const rows: ReturnType<typeof fact>[] = [];
    for (let i = 0; i < 270; i++) rows.push(fact({ processedAt: daysAgo(20 + (i % 40)), subscribed: i % 3 === 0, contractId: i % 3 === 0 ? `c_old_${i}` : null }));
    for (let i = 0; i < 30; i++) rows.push(fact({ processedAt: daysAgo(1 + (i % 3)), subscribed: i % 5 === 0, contractId: i % 5 === 0 ? `c_new_${i}` : null }));
    // A challenger with the same shape at a third of the volume, so the
    // comparison has a reference and a row.
    for (let i = 0; i < 90; i++) rows.push(fact({ designKey: "classic", processedAt: daysAgo(20 + (i % 40)) }));
    for (let i = 0; i < 12; i++) rows.push(fact({ designKey: "classic", processedAt: daysAgo(1 + (i % 3)) }));
    mocks.factFindMany.mockResolvedValue(rows);
    mocks.visitSummary.mockResolvedValue([
      visit({ day: dayKeyOf(daysAgo(1)), visits: 10 }),
      visit({ day: dayKeyOf(daysAgo(2)), visits: 10 }),
      visit({ day: dayKeyOf(daysAgo(3)), visits: 10 }),
      visit({ day: dayKeyOf(daysAgo(1)), designKey: "classic", visits: 40 }),
      visit({ day: dayKeyOf(daysAgo(2)), designKey: "classic", visits: 40 }),
      visit({ day: dayKeyOf(daysAgo(3)), designKey: "classic", visits: 40 }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    const max = board.rows.find((r) => r.key === "subscription_max|sub")!;
    expect(max.orders).toBe(300);
    expect(max.subscribed).toBe(96); // 90 old + 6 new: take rate is whole-range
    expect(max.takeRatePct).toBe(32);
    expect(max.visits!.visits).toBe(30);
    // Only the 30 orders on covered days count: 30 ÷ 30 × 100 = 100 per 100,
    // not 300 ÷ 30 = 1000; subscriptions 6 ÷ 30 = 20 per 100.
    expect(max.conversion.ordersCounted).toBe(30);
    expect(max.conversion.subscribedCounted).toBe(6);
    expect(max.conversion.ordersPer100Visits).toBe(100);
    expect(max.conversion.subscriptionsPer100Visits).toBe(20);
    expect(max.conversion.firstVisitDay).toBe(dayKeyOf(daysAgo(3)));
    const classic = board.rows.find((r) => r.key === "classic|sub")!;
    expect(classic.conversion.ordersCounted).toBe(12);
    expect(classic.conversion.ordersPer100Visits).toBe(10); // 12 ÷ 120
    // Comparison: deltas and the chance use the aligned counts (12/120 vs
    // 30/30), never the whole-range 102 vs 300 that clamp to 100% each.
    const cmp = board.comparison.find((c) => c.key === "classic|sub")!;
    expect(cmp.deltas.conversionPts).toBe(-90);
    expect(cmp.chance.conversion).toBeCloseTo(probabilityBetterThan(30, 30, 12, 120), 12);
    expect(cmp.chance.conversion).toBeLessThan(0.01);
    // Coverage tells the merchant why: 3 of 91 days.
    expect(board.totals.visitDaysCovered).toBe(3);
    expect(board.totals.visitCoverageDays).toBe(0.033);
  });

  it("revision grouping maps each visit day onto the ledger revision live that day, splitting a publish day by the visit's own design stamp; visits before any publish join nothing", async () => {
    // rev_0 (classic) published 60 days ago; rev_1 (subscription_max)
    // published 20 days ago at 16:00 Zurich, i.e. in the middle of a day.
    const publishDay = dayKeyOf(daysAgo(20));
    const rev1At = new Date(`${publishDay}T14:00:00.000Z`);
    mocks.loadLedgerRevisions.mockResolvedValue([
      { id: "rev_0", preset: "classic", config: { preset: "classic" }, publishedAt: daysAgo(60), label: null },
      { id: "rev_1", preset: "subscription_max", config: { preset: "subscription_max" }, publishedAt: rev1At, label: "Big" },
    ]);
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: daysAgo(10), designRevisionId: "rev_1" }),
      fact({ processedAt: daysAgo(30), designKey: "classic", designRevisionId: "rev_0" }),
    ]);
    mocks.visitSummary.mockResolvedValue([
      visit({ day: dayKeyOf(daysAgo(30)), designKey: "classic", visits: 100 }),
      visit({ day: dayKeyOf(daysAgo(10)), visits: 200 }),
      // The publish day: the classic visits belong to rev_0 (live until
      // 16:00), the subscription_max ones to rev_1 (live after).
      visit({ day: publishDay, designKey: "classic", visits: 40 }),
      visit({ day: publishDay, visits: 60 }),
      // A stamp no revision serves for the default market (a market override
      // seen while reading all markets): the revision live at day end.
      visit({ day: dayKeyOf(daysAgo(10)), designKey: "toggle", visits: 5 }),
      // Before any revision was published: cannot be keyed, counts in totals only.
      visit({ day: dayKeyOf(daysAgo(70)), designKey: "classic", visits: 9 }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, groupBy: "revision" });
    const rev0 = board.rows.find((r) => r.key === "rev_0")!;
    const rev1 = board.rows.find((r) => r.key === "rev_1")!;
    expect(rev0.visits!.visits).toBe(140);
    expect(rev1.visits!.visits).toBe(265);
    expect(rev1.revisionId).toBe("rev_1");
    expect(board.totals.visits).toBe(414);
    expect(mocks.loadLedgerRevisions).toHaveBeenCalledWith(SHOP_ID);

    // The raw ledger is only loaded for revision grouping.
    mocks.loadLedgerRevisions.mockClear();
    await getScoreboard(BASE_QUERY);
    expect(mocks.loadLedgerRevisions).not.toHaveBeenCalled();
  });

  it("revision grouping without a usable ledger reads visits null (documented), while variant grouping still joins", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.loadLedgerRevisions.mockRejectedValue(new Error("ledger down"));
    mocks.factFindMany.mockResolvedValue([fact({ designRevisionId: "rev_1" })]);
    mocks.visitSummary.mockResolvedValue([visit({ visits: 50 })]);
    const byRevision = await getScoreboard({ ...BASE_QUERY, groupBy: "revision" });
    expect(byRevision.rows[0].key).toBe("rev_1");
    expect(byRevision.rows[0].visits).toBeNull();
    // Totals still count the visits that were read.
    expect(byRevision.totals.visits).toBe(50);
    const byVariant = await getScoreboard(BASE_QUERY);
    expect(byVariant.rows[0].visits!.visits).toBe(50);
    errSpy.mockRestore();
  });

  it("buckets visit days into shop-tz ISO weeks on the row's weekly series, aligned with the order weeks", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact({ processedAt: new Date("2026-08-12T10:00:00.000Z") }),
      fact({ processedAt: new Date("2026-08-12T11:00:00.000Z"), designKey: "classic" }),
    ]);
    mocks.visitSummary.mockResolvedValue([
      // Sunday 16 Aug is W33; Monday 17 Aug is W34 (day keys are already shop-tz days).
      visit({ day: "2026-08-16", visits: 10 }),
      visit({ day: "2026-08-17", visits: 20 }),
      visit({ day: "2026-08-18", visits: 5 }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 14 });
    expect(board.weeks).toEqual(["2026-W32", "2026-W33", "2026-W34"]);
    const max = board.rows.find((r) => r.key === "subscription_max|sub")!;
    expect(max.weekly.map((w) => [w.week, w.orders, w.visits])).toEqual([
      ["2026-W32", 0, 0],
      ["2026-W33", 1, 10],
      ["2026-W34", 0, 25],
    ]);
    // A row without visits carries a zero series (the shop does record visits).
    const classic = board.rows.find((r) => r.key === "classic|sub")!;
    expect(classic.weekly.map((w) => w.visits)).toEqual([0, 0, 0]);
    expect(classic.visits).toEqual({ visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 });
  });

  it("with no range and no orders the week axis and the coverage window start at the first visit day", async () => {
    mocks.visitSummary.mockResolvedValue([
      visit({ day: "2026-08-04", visits: 3 }),
      visit({ day: "2026-08-19", visits: 4 }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: null });
    expect(board.totals.orders).toBe(0);
    expect(board.weeks).toEqual(["2026-W32", "2026-W33", "2026-W34"]);
    expect(board.rows.map((r) => [r.key, r.orders, r.visits!.visits])).toEqual([["subscription_max|sub", 0, 7]]);
    // 4 Aug .. 20 Aug = 17 days, 2 with visits.
    expect(board.totals.visitDaysInRange).toBe(17);
    expect(board.totals.visitDaysCovered).toBe(2);
    expect(board.totals.visitCoverageDays).toBe(0.118);
  });

  it("reports null visits everywhere (and zero totals) when the shop has no visit rows in range", async () => {
    mocks.factFindMany.mockResolvedValue([fact(), fact({ designKey: "classic" })]);
    const board = await getScoreboard(BASE_QUERY);
    for (const row of board.rows) {
      expect(row.visits).toBeNull();
      expect(row.conversion).toEqual(NULL_CONVERSION);
      expect(row.weekly.every((w) => w.visits === 0)).toBe(true);
    }
    expect(board.totals.visits).toBe(0);
    expect(board.totals.visitsRecorded).toBe(false);
    expect(board.totals.visitsUnscoped).toBe(0);
    expect(board.totals.visitCoverageDays).toBe(0);
    expect(board.totals.visitDaysCovered).toBe(0);
    expect(board.totals.lastVisitAt).toBeNull();
    // Without visits every guardrail verdict is on the orders basis.
    expect(board.guardrail.verdicts.length).toBeGreaterThan(0);
    expect(board.guardrail.verdicts.every((v) => v.basis === "orders")).toBe(true);
    // And the comparison carries no visit-based figures.
    expect(board.comparison).toHaveLength(1);
    expect(board.comparison[0].chance.conversion).toBeNull();
    expect(board.comparison[0].deltas.conversionPts).toBeNull();
  });

  it("contains a failing visits read (visits null, orders readout intact) and a failing last-visit lookup independently", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.factFindMany.mockResolvedValue([fact()]);
    mocks.visitSummary.mockRejectedValue(new Error("visits table missing"));
    mocks.lastVisitAt.mockResolvedValue(new Date("2026-08-20T10:00:00.000Z"));
    const board = await getScoreboard(BASE_QUERY);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].orders).toBe(1);
    expect(board.rows[0].visits).toBeNull();
    expect(board.totals.visits).toBe(0);
    // The last-visit lookup is separate: it still lands.
    expect(board.totals.lastVisitAt).toBe("2026-08-20T10:00:00.000Z");
    expect(errSpy).toHaveBeenCalledWith("[design-measurement] visit summary failed", expect.any(Error));

    mocks.visitSummary.mockResolvedValue([visit({ visits: 12 })]);
    mocks.lastVisitAt.mockRejectedValue(new Error("db"));
    const other = await getScoreboard(BASE_QUERY);
    expect(other.rows[0].visits!.visits).toBe(12);
    expect(other.totals.lastVisitAt).toBeNull();
    errSpy.mockRestore();
  });

  it("scopes the visit read to the requested market and computes coverage over the days in range", async () => {
    mocks.factFindMany.mockResolvedValue([fact({ marketHandle: "eu" })]);
    mocks.visitSummary.mockResolvedValue([
      visit({ day: dayKeyOf(daysAgo(1)), visits: 1 }),
      visit({ day: dayKeyOf(daysAgo(2)), visits: 1 }),
      visit({ day: dayKeyOf(daysAgo(2)), designKey: "classic", visits: 1 }),
      visit({ day: dayKeyOf(daysAgo(9)), visits: 1 }),
    ]);
    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 14, marketHandle: "eu" });
    // The rows' summary is market-scoped (first call); the coverage days and
    // the presence check are shop-level (a second, unscoped summary read and
    // hasVisits over the same range).
    const opts = mocks.visitSummary.mock.calls[0][1] as { since: Date | null; marketHandle: string | null };
    expect(opts.marketHandle).toBe("eu");
    expect(mocks.visitSummary).toHaveBeenCalledTimes(2);
    expect((mocks.visitSummary.mock.calls[1][1] as { marketHandle: string | null }).marketHandle).toBeNull();
    expect(mocks.hasVisits).toHaveBeenCalledWith(SHOP_ID, { since: opts.since, until: NOW, tz: TZ });
    // 14 days back from Thursday 20 Aug = Thursday 6 Aug 00:00 Zurich: 15 days
    // in range, 3 distinct days with a visit row → 3 ÷ 15.
    expect(board.totals.visitDaysInRange).toBe(15);
    expect(board.totals.visitDaysCovered).toBe(3);
    expect(board.totals.visitCoverageDays).toBe(0.2);
    expect(board.totals.visits).toBe(4);
    expect(board.totals.visitsRecorded).toBe(true);
    expect(board.totals.visitsUnscoped).toBe(4);
  });

  it("decides 'visits recorded' from the unscoped presence check: a market filter whose visits are not mapped yet reads zeros (recorded, none in this market), and a shop without visits reads null (not recorded)", async () => {
    mocks.factFindMany.mockResolvedValue([fact({ marketHandle: "de" }), fact({ marketHandle: "de", designKey: "classic" })]);
    // The shop records visits, but none carries marketHandle "de" (country
    // not in the market map yet): the scoped summary is empty.
    mocks.visitSummary.mockImplementation(async (_shopId: unknown, o: unknown) =>
      (o as { marketHandle: string | null }).marketHandle === "de"
        ? []
        : [visit({ visits: 70 }), visit({ day: dayKeyOf(daysAgo(2)), designKey: "classic", visits: 30 })],
    );
    mocks.hasVisits.mockResolvedValue(true);
    mocks.lastVisitAt.mockResolvedValue(new Date("2026-08-20T11:00:00.000Z"));
    const scoped = await getScoreboard({ ...BASE_QUERY, marketHandle: "de" });
    // Rows: zeros, not null; conversion rates null (no denominator) but the
    // covered-day numerators still count (both orders sit on a covered day).
    for (const row of scoped.rows) {
      expect(row.visits).toEqual({ visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 });
      expect(row.conversion.ordersPer100Visits).toBeNull();
      expect(row.conversion.ordersCounted).toBe(1);
      expect(row.conversion.firstVisitDay).toBe(dayKeyOf(daysAgo(3)));
    }
    expect(scoped.totals.visits).toBe(0);
    expect(scoped.totals.visitsRecorded).toBe(true);
    expect(scoped.totals.visitsUnscoped).toBe(100);
    expect(scoped.totals.visitDaysCovered).toBe(2);
    expect(scoped.totals.lastVisitAt).toBe("2026-08-20T11:00:00.000Z");

    // The other state: the shop has no visit row anywhere in range.
    mocks.visitSummary.mockResolvedValue([]);
    mocks.hasVisits.mockResolvedValue(false);
    const none = await getScoreboard({ ...BASE_QUERY, marketHandle: "de" });
    for (const row of none.rows) {
      expect(row.visits).toBeNull();
      expect(row.conversion).toEqual(NULL_CONVERSION);
    }
    expect(none.totals.visitsRecorded).toBe(false);
    expect(none.totals.visitsUnscoped).toBe(0);

    // The presence check is what decides: with hasVisits true and an empty
    // shop-wide summary (a race between the two reads), rows read zeros.
    mocks.hasVisits.mockResolvedValue(true);
    const racy = await getScoreboard({ ...BASE_QUERY, marketHandle: "de" });
    expect(racy.rows[0].visits).toEqual({ visits: 0, views: 0, engaged: 0, addedToCart: 0, addedSubscription: 0 });
    expect(racy.totals.visitsRecorded).toBe(true);

    // And when the check itself is unavailable (older visits module or a
    // thrown check), the unscoped rows decide.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.hasVisits.mockRejectedValue(new Error("db"));
    mocks.visitSummary.mockImplementation(async (_shopId: unknown, o: unknown) =>
      (o as { marketHandle: string | null }).marketHandle === "de" ? [] : [visit({ visits: 5 })],
    );
    const fallback = await getScoreboard({ ...BASE_QUERY, marketHandle: "de" });
    expect(fallback.totals.visitsRecorded).toBe(true);
    expect(fallback.rows[0].visits!.visits).toBe(0);
    expect(errSpy).toHaveBeenCalledWith("[design-measurement] visit presence check failed", expect.any(Error));
    errSpy.mockRestore();
  });

  it("never joins a visit whose design key is a reserved synthetic key (a forged beacon), and never creates a row from it", async () => {
    mocks.factFindMany.mockResolvedValue([
      fact(),
      fact({
        exposure: false,
        designSource: "none",
        designKey: null,
        designPreselect: null,
        designRevisionId: null,
        calendarDesignKey: null,
      }),
    ]);
    mocks.visitSummary.mockResolvedValue([
      visit({ visits: 10 }),
      visit({ designKey: "no_exposure", visits: 500 }),
      visit({ designKey: "unknown", visits: 500 }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.rows.map((r) => r.key).sort()).toEqual(["no_exposure", "subscription_max|sub"]);
    expect(board.rows.find((r) => r.key === "no_exposure")!.visits).toBeNull();
    expect(board.rows.find((r) => r.key === "subscription_max|sub")!.visits!.visits).toBe(10);
    // Read, so counted; just not attributable to any design.
    expect(board.totals.visits).toBe(1010);
  });
});

// ── Guardrail: conversion basis (v1.27.0) ────────────────────────────────────

describe("guardrail conversion basis", () => {
  const wkv = (pairs: Array<[number, number]>, from = 30) =>
    pairs.map(([orders, visits], i) => ({
      week: `2026-W${from + i}`,
      orders,
      subscribed: 0,
      oneTime: orders,
      visits,
    }));
  const OPTS = { maxOrderDropPct: 10, minOrdersPerWeek: 20, currentWeek: "2026-W40" };

  it("emits a conversion verdict FIRST (primary) and the orders verdict after it, per row, when both sides have 2 weeks with visits: less traffic is not a drop", () => {
    // Challenger: 20% fewer orders, but on 20% less traffic → conversion identical.
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 160, weekly: wkv([[0, 0], [0, 0], [80, 800], [80, 800]]) },
      ],
      OPTS,
    );
    expect(verdicts.map((v) => [v.key, v.basis, v.status])).toEqual([
      ["ref", "conversion", "ok"],
      ["ref", "orders", "ok"],
      ["b", "conversion", "ok"],
      ["b", "orders", "breach"],
    ]);
    expect(verdicts[0].detail).toContain("10 orders per 100 visits per week over 4 full weeks");
    expect(verdicts[2].detail).toContain("10 vs 10 orders per 100 visits per week");
    expect(verdicts[2].detail).toContain("Conversion is holding");
    expect(verdicts[3].detail).toContain("Orders are not holding");
  });

  it("catches a conversion drop that extra traffic hides in raw orders (orders ok, conversion breach)", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        // Same 100 orders, on 1,250 visits: 8 per 100 vs 10 → down 20%.
        { key: "b", synthetic: false, orders: 200, weekly: wkv([[0, 0], [0, 0], [100, 1250], [100, 1250]]) },
      ],
      OPTS,
    );
    const b = verdicts.filter((v) => v.key === "b");
    expect(b.map((v) => [v.basis, v.status])).toEqual([
      ["conversion", "breach"],
      ["orders", "ok"],
    ]);
    expect(b[0].detail).toContain("8 vs 10 orders per 100 visits per week (down 20%)");
    expect(b[0].detail).toContain("2 weeks each more than 10% below");
    expect(b[0].detail).toContain("Conversion is not holding");
    // Watch band and 2 decimals: 9.25 vs 10 → down 7.5%.
    const watch = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 148, weekly: wkv([[0, 0], [0, 0], [74, 800], [74, 800]]) },
      ],
      OPTS,
    );
    expect(watch.find((v) => v.key === "b" && v.basis === "conversion")).toMatchObject({ status: "watch" });
    expect(watch.find((v) => v.key === "b" && v.basis === "conversion")!.detail).toContain("9.25 vs 10");
  });

  it("falls back to the orders verdict alone for a row without 2 weeks of visits, and emits no conversion verdict at all when the reference lacks them", () => {
    // Challenger has orders but no visits (older embed, say): only its orders verdict.
    const partial = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 190, weekly: wkv([[0, 0], [0, 0], [95, 0], [95, 900]]) },
      ],
      OPTS,
    );
    expect(partial.map((v) => [v.key, v.basis, v.status])).toEqual([
      ["ref", "conversion", "ok"],
      ["ref", "orders", "ok"],
      ["b", "orders", "ok"],
    ]);
    // Reference with visits in only one week: nothing to normalise against.
    const refShort = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 0], [100, 0], [100, 0], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 160, weekly: wkv([[0, 0], [0, 0], [80, 800], [80, 800]]) },
      ],
      OPTS,
    );
    expect(refShort.every((v) => v.basis === "orders")).toBe(true);
    expect(refShort.map((v) => [v.key, v.status])).toEqual([
      ["ref", "ok"],
      ["b", "breach"],
    ]);
    // Legacy weekly rows without a visits field behave exactly as before.
    const legacy = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: [{ week: "2026-W30", orders: 100 }, { week: "2026-W31", orders: 100 }] },
        { key: "b", synthetic: false, orders: 190, weekly: [{ week: "2026-W30", orders: 95 }, { week: "2026-W31", orders: 95 }] },
      ],
      OPTS,
    );
    expect(legacy.map((v) => [v.key, v.basis, v.status])).toEqual([
      ["ref", "orders", "ok"],
      ["b", "orders", "ok"],
    ]);
  });

  it("qualifies conversion weeks on VISITS, not orders: a full week with traffic and zero orders contributes 0 per 100 (a collapse), while the orders basis still skips it", () => {
    // Challenger: a zero-order week with 1,000 exposed visits between two
    // normal weeks. Conversion mean = (9.5 + 0 + 9.5) ÷ 3 = 6.33 vs 10 (down
    // 37%), but only ONE week is individually more than 10% below the
    // reference, so the rule reads WATCH ("on single weeks"); an earlier
    // draft dropped the zero-order week and printed "holding" (down 5%).
    const one = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 300, weekly: wkv([[100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 190, weekly: wkv([[95, 1000], [0, 1000], [95, 1000]]) },
      ],
      OPTS,
    );
    const oneB = one.filter((v) => v.key === "b");
    expect(oneB.map((v) => [v.basis, v.status])).toEqual([
      ["conversion", "watch"],
      ["orders", "ok"],
    ]);
    expect(oneB[0].detail).toContain("6.33 vs 10 orders per 100 visits per week (down 36.7%) over 3 full weeks");
    expect(oneB[0].detail).toContain("on single weeks");
    // The orders basis keeps its "orders > 0" qualifier: 95 vs 100 over 2 weeks.
    expect(oneB[1].detail).toContain("95 vs 100 orders per week (down 5%) over 2 full weeks");

    // Two zero-order traffic weeks: 2 breaching weeks, mean 4.75 vs 10 → BREACH.
    const two = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 190, weekly: wkv([[95, 1000], [0, 1000], [95, 1000], [0, 1000]]) },
      ],
      OPTS,
    );
    const twoB = two.filter((v) => v.key === "b");
    expect(twoB.map((v) => [v.basis, v.status])).toEqual([
      ["conversion", "breach"],
      ["orders", "ok"],
    ]);
    expect(twoB[0].detail).toContain("4.75 vs 10 orders per 100 visits per week (down 52.5%) over 4 full weeks");
    expect(twoB[0].detail).toContain("2 weeks each more than 10% below");

    // The same weeks with NO visits recorded are not traffic weeks: they do
    // not qualify on either basis (the design may not have been on the page).
    const dark = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 400, weekly: wkv([[100, 1000], [100, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 190, weekly: wkv([[95, 1000], [0, 0], [95, 1000], [0, 0]]) },
      ],
      OPTS,
    );
    expect(dark.filter((v) => v.key === "b").map((v) => [v.basis, v.status])).toEqual([
      ["conversion", "ok"],
      ["orders", "ok"],
    ]);
    // A zero-order traffic week on the REFERENCE lowers its own mean too.
    const refZero = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 300, weekly: wkv([[100, 1000], [0, 1000], [100, 1000], [100, 1000]]) },
        { key: "b", synthetic: false, orders: 150, weekly: wkv([[75, 1000], [75, 1000], [0, 0], [0, 0]]) },
      ],
      OPTS,
    );
    expect(refZero.find((v) => v.key === "ref" && v.basis === "conversion")!.detail).toContain("7.5 orders per 100 visits per week over 4 full weeks");
    expect(refZero.find((v) => v.key === "b" && v.basis === "conversion")).toMatchObject({ status: "ok" });
  });

  it("keeps the orders floor on the reference for both bases: a reference below the floor yields no conversion verdict and 'insufficient' orders verdicts", () => {
    const verdicts = computeGuardrailVerdicts(
      [
        { key: "ref", synthetic: false, orders: 30, weekly: wkv([[16, 400], [14, 400]]) },
        { key: "b", synthetic: false, orders: 30, weekly: wkv([[15, 300], [15, 300]]) },
      ],
      OPTS,
    );
    expect(verdicts.map((v) => [v.key, v.basis, v.status])).toEqual([
      ["ref", "orders", "insufficient"],
      ["b", "orders", "insufficient"],
    ]);
  });

  it("through getScoreboard: weekly visits feed the conversion basis (partial and current weeks excluded as for orders)", async () => {
    // Same fixture as the partial-week test: reference 30/week W31..W33
    // (+ a 4-order W30 tail), challenger 25/week. Visits: reference 300/week,
    // challenger 250/week in W31..W33 → identical conversion (10 per 100).
    const at = (iso: string, i: number) => new Date(new Date(iso).getTime() + (12 + i) * 3_600_000);
    const rows: ReturnType<typeof fact>[] = [];
    for (let i = 0; i < 4; i++) rows.push(fact({ processedAt: at("2026-07-22", i) }));
    const visits: ReturnType<typeof visit>[] = [];
    for (const monday of ["2026-07-27", "2026-08-03", "2026-08-10"]) {
      for (let i = 0; i < 30; i++) rows.push(fact({ processedAt: at(monday, i) }));
      for (let i = 0; i < 25; i++) rows.push(fact({ designKey: "classic", processedAt: at(monday, i) }));
      visits.push(visit({ day: monday, visits: 300 }));
      visits.push(visit({ day: monday, designKey: "classic", visits: 250 }));
    }
    // Visits in the partial W30 tail and the current week W34 must not count.
    visits.push(visit({ day: "2026-07-22", visits: 5 }));
    visits.push(visit({ day: "2026-08-18", designKey: "classic", visits: 5 }));
    mocks.factFindMany.mockResolvedValue(rows);
    mocks.visitSummary.mockResolvedValue(visits);

    const board = await getScoreboard({ ...BASE_QUERY, rangeDays: 30 });
    expect(board.guardrail.verdicts.map((v) => [v.key, v.basis, v.status])).toEqual([
      ["subscription_max|sub", "conversion", "ok"],
      ["subscription_max|sub", "orders", "ok"],
      ["classic|sub", "conversion", "ok"],
      ["classic|sub", "orders", "breach"],
    ]);
    expect(board.guardrail.verdicts[0].detail).toContain("over 3 full weeks");
    expect(board.guardrail.verdicts[2].detail).toContain("10 vs 10 orders per 100 visits per week");
    const ref = board.rows.find((r) => r.key === "subscription_max|sub")!;
    expect(ref.weekly.map((w) => w.visits)).toEqual([5, 300, 300, 300, 0]);
  });
});

// ── Comparison vs the reference (v1.27.0) ────────────────────────────────────

describe("comparison against the reference", () => {
  const vrow = (over: Partial<VariantRow> & { key: string }): VariantRow => ({
    designKey: over.key.split("|")[0],
    preselect: "sub",
    revisionId: null,
    label: over.key,
    orders: 0,
    subscribed: 0,
    oneTime: 0,
    takeRatePct: null,
    held: {
      d30: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
      d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
      d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
    },
    quickCancel14: { matureSubscribed: 0, cancelled: 0, pct: null },
    ltgp: null,
    grade: "too_early",
    weekly: [],
    hygiene: { promo: 0, mixed: 0, transition: 0, noExposure: 0, foreignPlan: 0, staffExcluded: 0, calendarDisagree: 0 },
    aovCents: null,
    visits: null,
    conversion: NULL_CONVERSION,
    ...over,
  });

  it("computes deltas in points and 'chance better' from the raw counts against the row with most orders; the reference and synthetic rows are not listed", () => {
    const rows: VariantRow[] = [
      vrow({
        key: "a|sub",
        orders: 100,
        subscribed: 30,
        takeRatePct: 30,
        held: {
          d30: { matureOrders: 80, matureSubscribed: 20, heldSubscribed: 16, pct: 80 },
          d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        },
        visits: { visits: 5000, views: 5000, engaged: 0, addedToCart: 0, addedSubscription: 0 },
        conversion: {
          ...NULL_CONVERSION,
          ordersPer100Visits: 2,
          subscriptionsPer100Visits: 0.6,
          keptSubscribersPer100VisitsD30: 0.4,
          ordersCounted: 100,
          subscribedCounted: 30,
          keptCounted: 16,
          maturedVisits: 4000,
        },
      }),
      vrow({
        key: "b|sub",
        orders: 60,
        subscribed: 24,
        takeRatePct: 40,
        held: {
          d30: { matureOrders: 40, matureSubscribed: 10, heldSubscribed: 9, pct: 90 },
          d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        },
        visits: { visits: 2000, views: 2000, engaged: 0, addedToCart: 0, addedSubscription: 0 },
        conversion: {
          ...NULL_CONVERSION,
          ordersPer100Visits: 3,
          subscriptionsPer100Visits: 1.2,
          keptSubscribersPer100VisitsD30: 0.5,
          ordersCounted: 60,
          subscribedCounted: 24,
          keptCounted: 9,
          maturedVisits: 1800,
        },
      }),
      // No visits at all for this one, and no matured subscriber.
      vrow({ key: "c|sub", orders: 10, subscribed: 1, takeRatePct: 10 }),
      vrow({ key: "no_exposure", orders: 500 }),
    ];
    const cmp = computeComparison(rows);
    expect(cmp.map((c) => [c.key, c.vsKey])).toEqual([
      ["b|sub", "a|sub"],
      ["c|sub", "a|sub"],
    ]);
    expect(cmp[0].deltas).toEqual({
      conversionPts: 1,
      subscriptionConversionPts: 0.6,
      takeRatePts: 10,
      kept30Pts: 10,
      keptPer100VisitsD30: 0.1,
    });
    expect(cmp[0].chance.conversion).toBeCloseTo(probabilityBetterThan(100, 5000, 60, 2000), 12);
    expect(cmp[0].chance.takeRate).toBeCloseTo(probabilityBetterThan(30, 100, 24, 60), 12);
    expect(cmp[0].chance.kept30).toBeCloseTo(probabilityBetterThan(16, 20, 9, 10), 12);
    expect(cmp[0].chance.conversion).toBeGreaterThan(0.99);
    expect(cmp[0].chance.takeRate).toBeGreaterThan(0.85);
    // Missing denominators → null, never 0.5.
    expect(cmp[1].deltas.conversionPts).toBeNull();
    expect(cmp[1].deltas.kept30Pts).toBeNull();
    expect(cmp[1].deltas.takeRatePts).toBe(-20);
    expect(cmp[1].chance.conversion).toBeNull();
    expect(cmp[1].chance.kept30).toBeNull();
    expect(cmp[1].chance.takeRate).toBeLessThan(0.2);
    // Fewer than 2 real rows: nothing to compare.
    expect(computeComparison([rows[0], rows[3]])).toEqual([]);
  });

  it("computes deltas from the UNROUNDED ratios (raw counts) and rounds once to 2 decimals, and uses the time-aligned ordersCounted for the conversion chance, never the whole-range orders", () => {
    // 26 vs 34 kept subscribers per 10,000 matured visits: 0.26 vs 0.34, a
    // 31% gap that 1-decimal display values (0.3 vs 0.3) would erase.
    const rows: VariantRow[] = [
      vrow({
        key: "a|sub",
        orders: 300,
        subscribed: 100, // 33.33%
        takeRatePct: 33.3,
        held: {
          d30: { matureOrders: 200, matureSubscribed: 60, heldSubscribed: 40, pct: 66.7 }, // 66.67%
          d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        },
        visits: { visits: 12000, views: 12000, engaged: 0, addedToCart: 0, addedSubscription: 0 },
        conversion: {
          ...NULL_CONVERSION,
          ordersPer100Visits: 2.34,
          subscriptionsPer100Visits: 0.83,
          keptSubscribersPer100VisitsD30: 0.26,
          // Whole-range orders 300, but only 281 on covered days.
          ordersCounted: 281,
          subscribedCounted: 100,
          keptCounted: 26,
          maturedVisits: 10000,
        },
      }),
      vrow({
        key: "b|sub",
        orders: 240,
        subscribed: 60, // 25%
        takeRatePct: 25,
        held: {
          d30: { matureOrders: 150, matureSubscribed: 30, heldSubscribed: 20, pct: 66.7 }, // 66.67%
          d60: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
          d90: { matureOrders: 0, matureSubscribed: 0, heldSubscribed: 0, pct: null },
        },
        visits: { visits: 12000, views: 12000, engaged: 0, addedToCart: 0, addedSubscription: 0 },
        conversion: {
          ...NULL_CONVERSION,
          ordersPer100Visits: 2.26,
          subscriptionsPer100Visits: 0.5,
          keptSubscribersPer100VisitsD30: 0.34,
          ordersCounted: 271,
          subscribedCounted: 60,
          keptCounted: 34,
          maturedVisits: 10000,
        },
      }),
    ];
    const [cmp] = computeComparison(rows);
    expect(cmp.key).toBe("b|sub");
    expect(cmp.deltas).toEqual({
      conversionPts: -0.08, // 271/12000 - 281/12000 = 2.2583 - 2.3417
      subscriptionConversionPts: -0.33, // 0.5 - 0.8333
      takeRatePts: -8.33, // 25 - 33.333 (from the counts, not 25 - 33.3 = -8.3)
      kept30Pts: 0, // 66.67 - 66.67 exactly, from the counts
      keptPer100VisitsD30: 0.08, // 0.34 - 0.26
    });
    // The chance uses the aligned counts (281 / 271), not orders (300 / 240).
    expect(cmp.chance.conversion).toBeCloseTo(probabilityBetterThan(281, 12000, 271, 12000), 12);
    expect(cmp.chance.conversion).not.toBeCloseTo(probabilityBetterThan(300, 12000, 240, 12000), 6);
  });

  it("through getScoreboard: the comparison uses the same reference as the guardrail (most orders) and lands on the payload", async () => {
    mocks.factFindMany.mockResolvedValue([
      ...Array.from({ length: 6 }, () => fact()),
      fact({ subscribed: true, contractId: "c1" }),
      fact({ subscribed: true, contractId: "c2" }),
      ...Array.from({ length: 2 }, () => fact({ designKey: "classic" })),
      fact({ designKey: "classic", subscribed: true, contractId: "c3" }),
    ]);
    mocks.contractFindMany.mockResolvedValue([contract("c1"), contract("c2"), contract("c3")]);
    mocks.visitSummary.mockResolvedValue([
      visit({ visits: 400 }),
      visit({ designKey: "classic", visits: 100 }),
    ]);
    const board = await getScoreboard(BASE_QUERY);
    expect(board.comparison).toHaveLength(1);
    const c = board.comparison[0];
    expect(c.key).toBe("classic|sub");
    expect(c.vsKey).toBe("subscription_max|sub");
    // classic: 3 orders / 100 visits = 3 per 100; max: 8 / 400 = 2 per 100.
    expect(c.deltas.conversionPts).toBe(1);
    // take rate 33.33 vs 25 from the counts (2 decimals), not 33.3 - 25.
    expect(c.deltas.takeRatePts).toBe(8.33);
    expect(c.chance.conversion).toBeCloseTo(probabilityBetterThan(8, 400, 3, 100), 12);
    expect(c.chance.takeRate).toBeCloseTo(probabilityBetterThan(2, 8, 1, 3), 12);
    expect(c.chance.kept30).toBeNull();
    expect(board.guardrail.verdicts[0].key).toBe("subscription_max|sub");
  });
});

// ── Cache ─────────────────────────────────────────────────────────────────────

describe("cache", () => {
  const q = { ...BASE_QUERY, fresh: false };

  it("misses first, hits second (cached: true, no re-query), and `fresh` recomputes", async () => {
    mocks.factFindMany.mockResolvedValue([fact()]);
    const first = await getScoreboard(q);
    expect(first.cached).toBe(false);
    expect(mocks.factFindMany).toHaveBeenCalledTimes(1);

    mocks.factFindMany.mockResolvedValue([fact(), fact()]);
    const second = await getScoreboard(q);
    expect(second.cached).toBe(true);
    expect(second.totals.orders).toBe(1);
    expect(second.computedAt).toBe(first.computedAt);
    expect(mocks.factFindMany).toHaveBeenCalledTimes(1);

    const third = await getScoreboard({ ...q, fresh: true });
    expect(third.cached).toBe(false);
    expect(third.totals.orders).toBe(2);
    expect(mocks.factFindMany).toHaveBeenCalledTimes(2);

    // The fresh read refilled the cache.
    const fourth = await getScoreboard(q);
    expect(fourth.cached).toBe(true);
    expect(fourth.totals.orders).toBe(2);
  });

  it("keys on shopId / rangeDays / marketHandle / groupBy but not on now or fresh", async () => {
    mocks.factFindMany.mockResolvedValue([fact()]);
    await getScoreboard(q);
    await getScoreboard({ ...q, now: new Date(NOW.getTime() + 60_000) });
    expect(mocks.factFindMany).toHaveBeenCalledTimes(1);
    await getScoreboard({ ...q, groupBy: "design" });
    await getScoreboard({ ...q, rangeDays: 30 });
    await getScoreboard({ ...q, marketHandle: "gb" });
    expect(mocks.factFindMany).toHaveBeenCalledTimes(4);
  });

  it("invalidateScoreboardCache drops the shop's entries only", async () => {
    mocks.factFindMany.mockResolvedValue([fact()]);
    mocks.shopFindUnique.mockImplementation(async (args: unknown) => ({
      id: (args as { where: { id: string } }).where.id,
      domain: "x",
      ianaTimezone: TZ,
      currencyCode: "GBP",
    }));
    await getScoreboard(q);
    await getScoreboard({ ...q, shopId: "shop_2" });
    expect(mocks.factFindMany).toHaveBeenCalledTimes(2);

    invalidateScoreboardCache(SHOP_ID);
    await getScoreboard(q);
    expect(mocks.factFindMany).toHaveBeenCalledTimes(3);
    const other = await getScoreboard({ ...q, shopId: "shop_2" });
    expect(other.cached).toBe(true);
    expect(mocks.factFindMany).toHaveBeenCalledTimes(3);
    invalidateScoreboardCache("shop_2");
  });

  it("expires after 10 minutes", async () => {
    mocks.factFindMany.mockResolvedValue([fact()]);
    const realNow = Date.now;
    let clock = NOW.getTime();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await getScoreboard(q);
      clock += 9 * 60_000;
      expect((await getScoreboard(q)).cached).toBe(true);
      clock += 2 * 60_000;
      expect((await getScoreboard(q)).cached).toBe(false);
      expect(mocks.factFindMany).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });
});
