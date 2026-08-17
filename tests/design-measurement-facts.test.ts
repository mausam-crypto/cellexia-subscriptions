import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SUBSCRIBABLE ORDER FACTS (facts.server.ts, v1.26.0)
 *
 *  1. recordSubscribableOrder resolves the design ladder seen → design_prop
 *     → calendar → none, records calendarDesignKey/designRevisionId from the
 *     ledger regardless, and derives ownership (ours/foreign/mixed/none from
 *     the lines' selling-plan ids against getOwnPlanIds, both id forms),
 *     exposure, mixed, promo, staff (excludeEmails, case-insensitive; the
 *     email is never stored) and transition (24h after a publish).
 *  2. Upsert by (shopId, orderId): create sets the facts; an UPDATE never
 *     touches subscribed / contractId / subscribedAt; the P2002 race lands as
 *     an update; the scoreboard cache is invalidated after writes.
 *  3. linkContractDesign: COUNTABLE gate (isDemo false, ownership OURS,
 *     originOrderId set); marks the fact subscribed (contractId,
 *     subscribedAt = firstChargeAt ?? createdAt); stamps originDesign*
 *     WRITE-ONCE (conditional updateMany on originDesignStampedAt null); the
 *     no-fact path waits out the race window, then falls back to
 *     widget.design_attributed → calendar → "none".
 */

const dbMocks = vi.hoisted(() => ({
  factFindUnique: vi.fn(async (): Promise<unknown> => null),
  factCreate: vi.fn(async (): Promise<unknown> => ({})),
  factUpdate: vi.fn(async (): Promise<unknown> => ({})),
  contractFindFirst: vi.fn(async (): Promise<unknown> => null),
  contractUpdateMany: vi.fn(async (): Promise<{ count: number }> => ({ count: 1 })),
  eventFindMany: vi.fn(async (): Promise<unknown[]> => []),
  revisionFindMany: vi.fn(async (): Promise<unknown[]> => []),
  marketFindUnique: vi.fn(async (): Promise<unknown> => null),
  planConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

const seamMocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (_shopId?: string, _key?: string): Promise<unknown> => ({})),
  getLaunchState: vi.fn(async (): Promise<unknown> => ({ mode: "LIVE" })),
  invalidateScoreboardCache: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscribableOrder: {
      findUnique: dbMocks.factFindUnique,
      create: dbMocks.factCreate,
      update: dbMocks.factUpdate,
    },
    subscriptionContract: {
      findFirst: dbMocks.contractFindFirst,
      updateMany: dbMocks.contractUpdateMany,
    },
    subscriberEvent: { findMany: dbMocks.eventFindMany },
    widgetDesignRevision: { findMany: dbMocks.revisionFindMany },
    marketCountryMap: { findUnique: dbMocks.marketFindUnique },
    sellingPlanConfig: { findMany: dbMocks.planConfigFindMany },
  },
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: seamMocks.getSetting,
}));

// launch.server pulls ~/shopify.server at load; the writer only needs the
// mode read, mocked here.
vi.mock("~/lib/launch/launch.server", () => ({
  getLaunchState: seamMocks.getLaunchState,
}));

vi.mock("~/lib/design-measurement/scoreboard.server", () => ({
  invalidateScoreboardCache: seamMocks.invalidateScoreboardCache,
}));

import { Prisma } from "@prisma/client";
import {
  LINK_NO_FACT_GRACE_MS,
  chooseDesign,
  classifyOrderOwnership,
  isMixedOrder,
  linkContractDesign,
  loadExposureGate,
  recordSubscribableOrder,
  type RecordSubscribableOrderInput,
  type RecordSubscribableOrderLine,
} from "~/lib/design-measurement/facts.server";
import {
  OPEN_EXPOSURE_GATE,
  calendarRungAllowed,
} from "~/lib/design-measurement/ledger.server";

const SHOP = "shop_1";
const ORDER = "gid://shopify/Order/100";
const OUR_PLAN = "gid://shopify/SellingPlan/11";
const FOREIGN_PLAN = "gid://shopify/SellingPlan/99";
const NOW = new Date("2026-09-10T12:00:00Z");

const DEFAULT_SETTING = {
  startedAt: null,
  excludeEmails: [] as string[],
  guardrailMaxOrderDropPct: 10,
  guardrailMinOrdersPerWeek: 20,
  weeklySessions: {},
};
const ALL_MARKETS = { mode: "all", handles: [] as string[] };

/** getSetting routed by key: designMeasurement + widgetMarkets (+ anything else → {}). */
function settings(over: { designMeasurement?: unknown; widgetMarkets?: unknown } = {}) {
  seamMocks.getSetting.mockImplementation(async (_shopId?: string, key?: string) => {
    if (key === "designMeasurement") return over.designMeasurement ?? DEFAULT_SETTING;
    if (key === "widgetMarkets") return over.widgetMarkets ?? ALL_MARKETS;
    return {};
  });
}

function line(over: Partial<RecordSubscribableOrderLine> = {}): RecordSubscribableOrderLine {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    productId: "gid://shopify/Product/1",
    sellingPlanId: null,
    designProp: null,
    seenProp: null,
    isOurProduct: true,
    ...over,
  };
}

function input(over: Partial<RecordSubscribableOrderInput> = {}): RecordSubscribableOrderInput {
  return {
    shopId: SHOP,
    orderId: ORDER,
    orderName: "#1001",
    processedAt: NOW,
    countryCode: "ch",
    currencyCode: "chf",
    deviceType: "mobile",
    sourceName: "web",
    orderTotalCents: 5900,
    units: 2,
    orderEmail: null,
    hasSellingPlanLine: false,
    lines: [line()],
    promo: false,
    ...over,
  };
}

/** One published revision: classic, subscription preselected, ch → tiles. */
function revisions(over: Array<Record<string, unknown>> = []) {
  return [
    {
      id: "rev_1",
      preset: "classic",
      config: {
        preset: "classic",
        behavior: { preselect: "subscription" },
        markets: { ch: { preset: "tiles" } },
      },
      publishedAt: new Date("2026-09-01T00:00:00Z"),
      label: "Launch",
    },
    ...over,
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  settings();
  seamMocks.getLaunchState.mockResolvedValue({ mode: "LIVE" });
  dbMocks.factFindUnique.mockResolvedValue(null);
  dbMocks.factCreate.mockResolvedValue({});
  dbMocks.factUpdate.mockResolvedValue({});
  dbMocks.contractFindFirst.mockResolvedValue(null);
  dbMocks.contractUpdateMany.mockResolvedValue({ count: 1 });
  dbMocks.eventFindMany.mockResolvedValue([]);
  dbMocks.revisionFindMany.mockResolvedValue([]);
  dbMocks.marketFindUnique.mockResolvedValue(null);
  // Our plan ids as stored: GID form; getOwnPlanIds derives the numeric form.
  dbMocks.planConfigFindMany.mockResolvedValue([{ shopifyPlanIds: [OUR_PLAN] }]);
});

/** First argument of the n-th call of a mock (vitest types no-arg mocks' calls as []). */
const argOf = (mock: { mock: { calls: unknown[] } }, call = 0): unknown =>
  (mock.mock.calls[call] as unknown[] | undefined)?.[0];

const createdData = () =>
  (argOf(dbMocks.factCreate) as { data: Record<string, unknown> }).data;

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("classifyOrderOwnership", () => {
  const own = new Set([OUR_PLAN, "11"]);
  it("ours / foreign / mixed / none from the lines' plan ids (any id form)", () => {
    expect(classifyOrderOwnership([line({ sellingPlanId: OUR_PLAN })], own)).toBe("ours");
    expect(classifyOrderOwnership([line({ sellingPlanId: "11" })], own)).toBe("ours");
    expect(classifyOrderOwnership([line({ sellingPlanId: FOREIGN_PLAN })], own)).toBe("foreign");
    expect(
      classifyOrderOwnership(
        [line({ sellingPlanId: OUR_PLAN }), line({ sellingPlanId: FOREIGN_PLAN, isOurProduct: false })],
        own,
      ),
    ).toBe("mixed");
    expect(classifyOrderOwnership([line(), line({ sellingPlanId: "  " })], own)).toBe("none");
  });
  it("knownOwnership (backfill) applies only when the lines carry no plan evidence", () => {
    expect(classifyOrderOwnership([line()], own, "ours")).toBe("ours");
    expect(classifyOrderOwnership([line({ sellingPlanId: FOREIGN_PLAN })], own, "ours")).toBe("foreign");
  });

  it("incomplete own-plan evidence (ownPlanIdsKnown false) never yields foreign or mixed", () => {
    // Finding #4: an empty-because-unpopulated set must not brand our own
    // subscription order as another app's (the scoreboard drops foreign rows).
    const empty = new Set<string>();
    expect(classifyOrderOwnership([line({ sellingPlanId: OUR_PLAN })], empty, null, false)).toBe("none");
    expect(classifyOrderOwnership([line({ sellingPlanId: OUR_PLAN })], empty, "ours", false)).toBe("ours");
    // A matched line still counts as ours; an unmatched one cannot make it mixed.
    expect(
      classifyOrderOwnership(
        [line({ sellingPlanId: OUR_PLAN }), line({ sellingPlanId: FOREIGN_PLAN, isOurProduct: false })],
        own,
        null,
        false,
      ),
    ).toBe("ours");
    // Complete evidence keeps the strict verdicts.
    expect(classifyOrderOwnership([line({ sellingPlanId: FOREIGN_PLAN })], own, null, true)).toBe("foreign");
  });
});

describe("calendarRungAllowed (exposure gate)", () => {
  it("open gate: every market, live store", () => {
    expect(calendarRungAllowed(OPEN_EXPOSURE_GATE, "de")).toBe(true);
    expect(calendarRungAllowed(OPEN_EXPOSURE_GATE, null)).toBe(true);
  });
  it("widgetMarkets selected: a KNOWN market outside the list is hidden; an unknown market fails open", () => {
    const gate = { widgetMarkets: { mode: "selected" as const, handles: ["fr"] }, launchMode: "LIVE" as const };
    expect(calendarRungAllowed(gate, "fr")).toBe(true);
    expect(calendarRungAllowed(gate, "de")).toBe(false);
    expect(calendarRungAllowed(gate, null)).toBe(true);
  });
  it("SETUP mode hides the widget everywhere", () => {
    const gate = { widgetMarkets: { mode: "all" as const, handles: [] }, launchMode: "SETUP" as const };
    expect(calendarRungAllowed(gate, null)).toBe(false);
    expect(calendarRungAllowed(gate, "fr")).toBe(false);
  });
});

describe("loadExposureGate", () => {
  it("reads widgetMarkets + launch mode and is contained (failure = fully open)", async () => {
    settings({ widgetMarkets: { mode: "selected", handles: ["fr", "ch"] } });
    seamMocks.getLaunchState.mockResolvedValue({ mode: "SETUP" });
    expect(await loadExposureGate(SHOP)).toEqual({
      widgetMarkets: { mode: "selected", handles: ["fr", "ch"] },
      launchMode: "SETUP",
    });
    expect(seamMocks.getSetting).toHaveBeenCalledWith(SHOP, "widgetMarkets");
    expect(seamMocks.getLaunchState).toHaveBeenCalledWith(SHOP);

    seamMocks.getLaunchState.mockRejectedValue(new Error("settings down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadExposureGate(SHOP)).toEqual(OPEN_EXPOSURE_GATE);
    spy.mockRestore();
  });
});

describe("chooseDesign + isMixedOrder", () => {
  const own = new Set([OUR_PLAN]);
  const calendar = { designKey: "classic", preselect: "sub" as const, revisionId: "r", label: null };

  it("prefers the seen value on OUR subscription line over another line's", () => {
    const choice = chooseDesign(
      [
        line({ seenProp: "tiles|o" }),
        line({ seenProp: "classic|s", sellingPlanId: OUR_PLAN }),
      ],
      own,
      calendar,
    );
    expect(choice).toMatchObject({ designKey: "classic", preselect: "sub", source: "seen", exposure: true });
    expect(choice.distinctKeys).toEqual(["classic", "tiles"]);
  });

  it("seen with unknown preselect borrows the calendar's only for the same design", () => {
    expect(chooseDesign([line({ seenProp: "classic|u" })], own, calendar)).toMatchObject({
      designKey: "classic",
      preselect: "sub",
      source: "seen",
    });
    expect(chooseDesign([line({ seenProp: "tiles|u" })], own, calendar)).toMatchObject({
      designKey: "tiles",
      preselect: null,
      source: "seen",
    });
  });

  it("design_prop when no seen; calendar when no property; none otherwise", () => {
    expect(chooseDesign([line({ designProp: "Tiles" })], own, calendar)).toMatchObject({
      designKey: "tiles",
      preselect: null,
      source: "design_prop",
      exposure: true,
    });
    expect(chooseDesign([line({ designProp: "classic" })], own, calendar).preselect).toBe("sub");
    expect(chooseDesign([line()], own, calendar)).toMatchObject({
      designKey: "classic",
      preselect: "sub",
      source: "calendar",
      exposure: false,
    });
    expect(chooseDesign([line()], own, null)).toMatchObject({
      designKey: null,
      preselect: null,
      source: "none",
      exposure: false,
    });
    // An invalid property value still counts as exposure but yields no key.
    expect(chooseDesign([line({ seenProp: "<junk>|s" })], own, null)).toMatchObject({
      designKey: null,
      source: "none",
      exposure: true,
    });
  });

  it("calendarRung false turns the calendar step into none but still lends its preselect to a matching stamp", () => {
    expect(chooseDesign([line()], own, calendar, false)).toMatchObject({
      designKey: null,
      preselect: null,
      source: "none",
      exposure: false,
    });
    expect(chooseDesign([line({ seenProp: "classic|u" })], own, calendar, false)).toMatchObject({
      designKey: "classic",
      preselect: "sub",
      source: "seen",
    });
    expect(chooseDesign([line({ designProp: "classic" })], own, calendar, false)).toMatchObject({
      designKey: "classic",
      preselect: "sub",
      source: "design_prop",
    });
  });

  it("isMixedOrder: several designs, or our product bought sub + one-time together", () => {
    expect(isMixedOrder([line()], ["a", "b"])).toBe(true);
    expect(isMixedOrder([line({ sellingPlanId: OUR_PLAN }), line()], ["a"])).toBe(true);
    expect(isMixedOrder([line({ sellingPlanId: OUR_PLAN }), line({ isOurProduct: false })], ["a"])).toBe(false);
    expect(isMixedOrder([line({ sellingPlanId: OUR_PLAN })], ["a"])).toBe(false);
  });
});

// ── recordSubscribableOrder ─────────────────────────────────────────────────

describe("recordSubscribableOrder", () => {
  it("seen wins: creates a PII-free row with the resolved design, market, calendar audit and flags", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    dbMocks.marketFindUnique.mockResolvedValue({ marketHandle: "ch" });

    const result = await recordSubscribableOrder(
      input({
        hasSellingPlanLine: true,
        orderEmail: "Buyer@Example.com",
        lines: [
          line({ sellingPlanId: OUR_PLAN, seenProp: "subscription_max|s", designProp: "subscription_max" }),
        ],
        promo: true,
      }),
    );

    expect(result).toEqual({
      designKey: "subscription_max",
      designPreselect: "sub",
      designSource: "seen",
      created: true,
    });
    expect(dbMocks.marketFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId_countryCode: { shopId: SHOP, countryCode: "CH" } } }),
    );
    const data = createdData();
    expect(data).toMatchObject({
      shopId: SHOP,
      orderId: ORDER,
      orderName: "#1001",
      processedAt: NOW,
      countryCode: "CH",
      currencyCode: "CHF",
      marketHandle: "ch",
      deviceType: "mobile",
      sourceName: "web",
      orderTotalCents: 5900,
      units: 2,
      designKey: "subscription_max",
      designPreselect: "sub",
      designSource: "seen",
      // Calendar audit for ch = tiles (the market override), revision id kept.
      calendarDesignKey: "tiles",
      designRevisionId: "rev_1",
      hasSellingPlanLine: true,
      ownership: "ours",
      exposure: true,
      promo: true,
      mixed: false,
      transition: false,
      staff: false,
    });
    // PII-free: no email, and the create never sets the join fields
    // (schema defaults keep them false/null).
    expect(JSON.stringify(data)).not.toContain("Buyer@");
    expect(data).not.toHaveProperty("subscribed");
    expect(data).not.toHaveProperty("contractId");
    expect(data).not.toHaveProperty("subscribedAt");
    expect(seamMocks.invalidateScoreboardCache).toHaveBeenCalledWith(SHOP);
  });

  it("ladder: design_prop when only _cellexia_design is present (preselect from the calendar when the design matches)", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    const result = await recordSubscribableOrder(
      input({ lines: [line({ sellingPlanId: OUR_PLAN, designProp: "classic" })] }),
    );
    expect(result).toMatchObject({ designKey: "classic", designPreselect: "sub", designSource: "design_prop" });
    expect(createdData()).toMatchObject({ exposure: true, calendarDesignKey: "classic" });

    // A different design than the calendar's: preselect stays unknown.
    dbMocks.factCreate.mockClear();
    const other = await recordSubscribableOrder(
      input({ lines: [line({ sellingPlanId: OUR_PLAN, designProp: "planner" })] }),
    );
    expect(other).toMatchObject({ designKey: "planner", designPreselect: null, designSource: "design_prop" });
  });

  it("ladder: calendar when no property at all; none when nothing was ever published", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    const calendar = await recordSubscribableOrder(input({ lines: [line()] }));
    expect(calendar).toMatchObject({ designKey: "classic", designPreselect: "sub", designSource: "calendar" });
    expect(createdData()).toMatchObject({ exposure: false, designRevisionId: "rev_1", calendarDesignKey: "classic" });

    dbMocks.factCreate.mockClear();
    dbMocks.revisionFindMany.mockResolvedValue([]);
    const none = await recordSubscribableOrder(input({ lines: [line()] }));
    expect(none).toMatchObject({ designKey: null, designPreselect: null, designSource: "none" });
    expect(createdData()).toMatchObject({
      exposure: false,
      designRevisionId: null,
      calendarDesignKey: null,
      ownership: "none",
    });
  });

  it("calendar resolves BEFORE the first publish to none even when later revisions exist", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    await recordSubscribableOrder(
      input({ processedAt: new Date("2026-08-01T00:00:00Z"), lines: [line()] }),
    );
    expect(createdData()).toMatchObject({ designSource: "none", calendarDesignKey: null });
  });

  it("calendar rung is withheld in a market hidden by widgetMarkets (designSource none, calendar audit kept)", async () => {
    // Finding #2: widgetMarkets selected = [fr]; a CH shopper (market ch)
    // buys one-time with no widget property. The widget could not render,
    // so the order must NOT count as "saw tiles, chose one-time".
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    dbMocks.marketFindUnique.mockResolvedValue({ marketHandle: "ch" });
    settings({ widgetMarkets: { mode: "selected", handles: ["fr"] } });

    const result = await recordSubscribableOrder(input({ lines: [line()] }));
    expect(result).toMatchObject({ designKey: null, designPreselect: null, designSource: "none" });
    expect(createdData()).toMatchObject({
      marketHandle: "ch",
      designKey: null,
      designSource: "none",
      exposure: false,
      // Audit fields still say what the ledger would have answered.
      calendarDesignKey: "tiles",
      designRevisionId: "rev_1",
    });
    expect(seamMocks.getSetting).toHaveBeenCalledWith(SHOP, "widgetMarkets");

    // The same shopper in an allowed market keeps the calendar rung.
    dbMocks.factCreate.mockClear();
    settings({ widgetMarkets: { mode: "selected", handles: ["ch"] } });
    expect(await recordSubscribableOrder(input({ lines: [line()] }))).toMatchObject({
      designKey: "tiles",
      designSource: "calendar",
    });

    // Unknown market (no map row) cannot be proven hidden: calendar stays.
    dbMocks.factCreate.mockClear();
    dbMocks.marketFindUnique.mockResolvedValue(null);
    settings({ widgetMarkets: { mode: "selected", handles: ["fr"] } });
    expect(await recordSubscribableOrder(input({ lines: [line()] }))).toMatchObject({
      designKey: "classic",
      designSource: "calendar",
    });

    // A stamped line is proof of exposure and wins regardless of the gate.
    dbMocks.factCreate.mockClear();
    dbMocks.marketFindUnique.mockResolvedValue({ marketHandle: "ch" });
    expect(await recordSubscribableOrder(input({ lines: [line({ seenProp: "tiles|o" })] }))).toMatchObject({
      designKey: "tiles",
      designPreselect: "one",
      designSource: "seen",
    });
  });

  it("calendar rung is withheld while the store is in SETUP (widget renders hidden), and a failed gate read fails open", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    seamMocks.getLaunchState.mockResolvedValue({ mode: "SETUP" });
    expect(await recordSubscribableOrder(input({ lines: [line()] }))).toMatchObject({
      designKey: null,
      designSource: "none",
    });
    expect(createdData()).toMatchObject({ calendarDesignKey: "classic", designRevisionId: "rev_1" });

    // Contained: a throwing launch read is treated as LIVE / all markets.
    dbMocks.factCreate.mockClear();
    seamMocks.getLaunchState.mockRejectedValue(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recordSubscribableOrder(input({ lines: [line()] }))).toMatchObject({
      designKey: "classic",
      designSource: "calendar",
    });
    spy.mockRestore();
  });

  it("ownership uses getOwnPlanIdEvidence: incomplete evidence never marks our subscription order foreign", async () => {
    // Finding #4: a config with a synced group but no persisted plan ids
    // (pre-0003 upgrade / half-failed sync) → evidence.known false.
    dbMocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "gid://shopify/SellingPlanGroup/1", shopifyPlanIds: null },
    ]);
    await recordSubscribableOrder(
      input({ hasSellingPlanLine: true, lines: [line({ sellingPlanId: OUR_PLAN })] }),
    );
    expect(createdData().ownership).toBe("none");
    expect(dbMocks.planConfigFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { shopifyGroupId: true, shopifyPlanIds: true } }),
    );

    // The backfill's contract-derived verdict fills the gap.
    dbMocks.factCreate.mockClear();
    await recordSubscribableOrder(
      input({ hasSellingPlanLine: true, lines: [line({ sellingPlanId: OUR_PLAN })], knownOwnership: "ours" }),
    );
    expect(createdData().ownership).toBe("ours");

    // Complete evidence: the strict classification is unchanged.
    dbMocks.factCreate.mockClear();
    dbMocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "gid://shopify/SellingPlanGroup/1", shopifyPlanIds: [OUR_PLAN] },
    ]);
    await recordSubscribableOrder(
      input({ hasSellingPlanLine: true, lines: [line({ sellingPlanId: FOREIGN_PLAN, isOurProduct: false })] }),
    );
    expect(createdData().ownership).toBe("foreign");
  });

  it("ownership: ours / foreign / mixed / none, matching numeric ids as well as GIDs", async () => {
    const own = async (lines: RecordSubscribableOrderLine[]) => {
      dbMocks.factCreate.mockClear();
      await recordSubscribableOrder(input({ lines, hasSellingPlanLine: true }));
      return createdData().ownership;
    };
    expect(await own([line({ sellingPlanId: OUR_PLAN })])).toBe("ours");
    expect(await own([line({ sellingPlanId: "11" })])).toBe("ours");
    expect(await own([line({ sellingPlanId: FOREIGN_PLAN, isOurProduct: false })])).toBe("foreign");
    expect(
      await own([line({ sellingPlanId: OUR_PLAN }), line({ sellingPlanId: FOREIGN_PLAN, isOurProduct: false })]),
    ).toBe("mixed");
    expect(await own([line()])).toBe("none");
  });

  it("flags: mixed (two designs / sub + one-time of our product), promo, staff (case-insensitive), transition (24h after a publish)", async () => {
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    settings({ designMeasurement: { ...DEFAULT_SETTING, excludeEmails: ["staff@cellexia.com"] } });

    await recordSubscribableOrder(
      input({
        processedAt: new Date("2026-09-01T12:00:00Z"), // 12h after the publish
        orderEmail: "  STAFF@Cellexia.com ",
        promo: true,
        lines: [
          line({ sellingPlanId: OUR_PLAN, seenProp: "classic|s" }),
          line({ seenProp: "tiles|s" }),
        ],
      }),
    );
    expect(createdData()).toMatchObject({ mixed: true, promo: true, staff: true, transition: true });
    expect(seamMocks.getSetting).toHaveBeenCalledWith(SHOP, "designMeasurement");

    // Same product as subscription AND one-time in one order = mixed too.
    dbMocks.factCreate.mockClear();
    await recordSubscribableOrder(
      input({
        processedAt: new Date("2026-09-05T12:00:00Z"),
        lines: [line({ sellingPlanId: OUR_PLAN, seenProp: "classic|s" }), line({ seenProp: "classic|s" })],
      }),
    );
    expect(createdData()).toMatchObject({ mixed: true, staff: false, transition: false });

    // A non-listed email is never staff; no email → no settings lookup needed.
    dbMocks.factCreate.mockClear();
    await recordSubscribableOrder(input({ orderEmail: "buyer@example.com", lines: [line()] }));
    expect(createdData().staff).toBe(false);
  });

  it("caps and normalises free-text columns (sourceName 40, currency upper, invalid country → null)", async () => {
    await recordSubscribableOrder(
      input({
        countryCode: "Switzerland",
        currencyCode: " eur ",
        sourceName: "x".repeat(80),
        orderName: "#" + "9".repeat(80),
        deviceType: "desktop",
        units: 3.7,
        orderTotalCents: 12.6,
      }),
    );
    const data = createdData();
    expect(data.countryCode).toBeNull();
    expect(data.marketHandle).toBeNull();
    expect(dbMocks.marketFindUnique).not.toHaveBeenCalled();
    expect(data.currencyCode).toBe("EUR");
    expect((data.sourceName as string).length).toBe(40);
    expect((data.orderName as string).length).toBe(40);
    expect(data.units).toBe(4);
    expect(data.orderTotalCents).toBe(13);
  });

  it("UPDATE path (idempotent redelivery): rewrites the facts but never the join fields", async () => {
    dbMocks.factFindUnique.mockResolvedValue({ id: "fact_1" });
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    const result = await recordSubscribableOrder(
      input({ lines: [line({ sellingPlanId: OUR_PLAN, seenProp: "classic|o" })] }),
    );
    expect(result.created).toBe(false);
    expect(dbMocks.factCreate).not.toHaveBeenCalled();
    expect(dbMocks.factUpdate).toHaveBeenCalledTimes(1);
    const call = argOf(dbMocks.factUpdate) as { where: unknown; data: Record<string, unknown> };
    expect(call.where).toEqual({ id: "fact_1" });
    expect(call.data).toMatchObject({ designKey: "classic", designPreselect: "one", designSource: "seen" });
    expect(call.data).not.toHaveProperty("subscribed");
    expect(call.data).not.toHaveProperty("contractId");
    expect(call.data).not.toHaveProperty("subscribedAt");
    expect(seamMocks.invalidateScoreboardCache).toHaveBeenCalledWith(SHOP);
  });

  it("a P2002 race on create lands as an update by (shopId, orderId); other errors propagate", async () => {
    const dup = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "test",
    });
    dbMocks.factCreate.mockRejectedValueOnce(dup);
    const result = await recordSubscribableOrder(input());
    expect(result.created).toBe(false);
    expect(dbMocks.factUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId_orderId: { shopId: SHOP, orderId: ORDER } } }),
    );

    dbMocks.factCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(recordSubscribableOrder(input())).rejects.toThrow("db down");
  });

  it("a scoreboard invalidation failure never fails the write", async () => {
    seamMocks.invalidateScoreboardCache.mockImplementationOnce(() => {
      throw new Error("cache exploded");
    });
    await expect(recordSubscribableOrder(input())).resolves.toMatchObject({ created: true });
  });
});

// ── linkContractDesign ───────────────────────────────────────────────────────

const contract = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  originOrderId: ORDER,
  isDemo: false,
  ownership: "OURS",
  originDesignStampedAt: null,
  firstChargeAt: new Date("2026-09-10T12:05:00Z"),
  createdAt: new Date("2026-09-10T12:01:00Z"),
  originOrderProcessedAt: new Date("2026-09-10T12:00:00Z"),
  acqCountryCode: "CH",
  ...over,
});

const fact = (over: Record<string, unknown> = {}) => ({
  id: "fact_1",
  shopId: SHOP,
  orderId: ORDER,
  designKey: "subscription_max",
  designPreselect: "sub",
  designRevisionId: "rev_1",
  designSource: "seen",
  subscribed: false,
  contractId: null,
  ...over,
});

describe("linkContractDesign", () => {
  it("joins the fact (subscribed, contractId, subscribedAt = firstChargeAt) and stamps the contract write-once from it", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract());
    dbMocks.factFindUnique.mockResolvedValue(fact());

    const result = await linkContractDesign(SHOP, "c1", NOW);
    expect(result).toEqual({ stamped: true, designKey: "subscription_max", designSource: "seen" });

    expect(dbMocks.contractFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", shopId: SHOP } }),
    );
    expect(dbMocks.factUpdate).toHaveBeenCalledWith({
      where: { id: "fact_1" },
      data: { subscribed: true, contractId: "c1", subscribedAt: new Date("2026-09-10T12:05:00Z") },
    });
    // WRITE-ONCE enforced at the write: conditional on the null stamp.
    expect(dbMocks.contractUpdateMany).toHaveBeenCalledWith({
      where: { id: "c1", shopId: SHOP, originDesignStampedAt: null },
      data: {
        originDesignKey: "subscription_max",
        originDesignPreselect: "sub",
        originDesignRevisionId: "rev_1",
        originDesignSource: "seen",
        originDesignStampedAt: NOW,
      },
    });
    expect(seamMocks.invalidateScoreboardCache).toHaveBeenCalledWith(SHOP);
  });

  it("subscribedAt falls back to the contract's createdAt when firstChargeAt is null", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract({ firstChargeAt: null }));
    dbMocks.factFindUnique.mockResolvedValue(fact());
    await linkContractDesign(SHOP, "c1", NOW);
    expect(dbMocks.factUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscribedAt: new Date("2026-09-10T12:01:00Z") }),
      }),
    );
  });

  it("is idempotent: an already-joined fact and an already-stamped contract cause no writes", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract({ originDesignStampedAt: new Date("2026-09-10T12:02:00Z") }));
    dbMocks.factFindUnique.mockResolvedValue(fact({ subscribed: true, contractId: "c1" }));
    const result = await linkContractDesign(SHOP, "c1", NOW);
    expect(result).toEqual({ stamped: false, designKey: null, designSource: null });
    expect(dbMocks.factUpdate).not.toHaveBeenCalled();
    expect(dbMocks.contractUpdateMany).not.toHaveBeenCalled();
    expect(seamMocks.invalidateScoreboardCache).not.toHaveBeenCalled();
  });

  it("still repairs the fact join when the contract is already stamped (and reports stamped:false)", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract({ originDesignStampedAt: new Date("2026-09-10T12:02:00Z") }));
    dbMocks.factFindUnique.mockResolvedValue(fact({ subscribed: false }));
    const result = await linkContractDesign(SHOP, "c1", NOW);
    expect(result.stamped).toBe(false);
    expect(dbMocks.factUpdate).toHaveBeenCalledTimes(1);
    expect(dbMocks.contractUpdateMany).not.toHaveBeenCalled();
  });

  it("a lost race at the write (count 0) reports stamped:false", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract());
    dbMocks.factFindUnique.mockResolvedValue(fact());
    dbMocks.contractUpdateMany.mockResolvedValue({ count: 0 });
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: false,
      designKey: null,
      designSource: null,
    });
  });

  it("COUNTABLE gate: demo, non-OURS (FOREIGN/UNKNOWN), no originOrderId or unknown contract → nothing happens", async () => {
    for (const row of [
      contract({ isDemo: true }),
      contract({ ownership: "FOREIGN" }),
      contract({ ownership: "UNKNOWN" }),
      contract({ originOrderId: null }),
      null,
    ]) {
      dbMocks.contractFindFirst.mockResolvedValue(row);
      dbMocks.factFindUnique.mockResolvedValue(fact());
      expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
        stamped: false,
        designKey: null,
        designSource: null,
      });
    }
    expect(dbMocks.factFindUnique).not.toHaveBeenCalled();
    expect(dbMocks.factUpdate).not.toHaveBeenCalled();
    expect(dbMocks.contractUpdateMany).not.toHaveBeenCalled();
  });

  it("no fact row + young contract: waits for the order webhook (does not burn the write-once slot)", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(contract({ createdAt: new Date(NOW.getTime() - 60_000) }));
    dbMocks.factFindUnique.mockResolvedValue(null);
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: false,
      designKey: null,
      designSource: null,
    });
    expect(dbMocks.contractUpdateMany).not.toHaveBeenCalled();
    expect(LINK_NO_FACT_GRACE_MS).toBe(48 * 3_600_000);
  });

  it("no fact row + old contract: widget.design_attributed events win, then the calendar (market from acqCountryCode), then none", async () => {
    const old = contract({
      createdAt: new Date(NOW.getTime() - LINK_NO_FACT_GRACE_MS - 1),
      originOrderProcessedAt: new Date("2026-09-02T00:00:00Z"),
    });
    dbMocks.contractFindFirst.mockResolvedValue(old);
    dbMocks.factFindUnique.mockResolvedValue(null);
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    dbMocks.marketFindUnique.mockResolvedValue({ marketHandle: "ch" });

    // (a) attributed events → design_prop; preselect borrowed only on a match.
    dbMocks.eventFindMany.mockResolvedValue([
      { payload: { orderId: ORDER, designKey: "planner" } },
      { payload: { orderId: ORDER, designKey: "classic" } },
    ]);
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: "classic",
      designSource: "design_prop",
    });
    expect(dbMocks.eventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          shopId: SHOP,
          type: "widget.design_attributed",
          payload: { path: ["orderId"], equals: ORDER },
        },
      }),
    );
    expect(dbMocks.contractUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originDesignKey: "classic",
          // ch calendar = tiles ≠ classic → preselect unknown; revision kept.
          originDesignPreselect: null,
          originDesignRevisionId: "rev_1",
          originDesignSource: "design_prop",
        }),
      }),
    );

    // (b) no events → calendar for the ch market (tiles, sub).
    dbMocks.contractUpdateMany.mockClear();
    dbMocks.eventFindMany.mockResolvedValue([]);
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: "tiles",
      designSource: "calendar",
    });
    expect(dbMocks.marketFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId_countryCode: { shopId: SHOP, countryCode: "CH" } } }),
    );
    expect(dbMocks.contractUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originDesignKey: "tiles",
          originDesignPreselect: "sub",
          originDesignRevisionId: "rev_1",
          originDesignSource: "calendar",
        }),
      }),
    );

    // (c) nothing at all → "none" is stamped so the row stops being revisited.
    dbMocks.contractUpdateMany.mockClear();
    dbMocks.revisionFindMany.mockResolvedValue([]);
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: null,
      designSource: "none",
    });
    expect(dbMocks.contractUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originDesignKey: null,
          originDesignPreselect: null,
          originDesignRevisionId: null,
          originDesignSource: "none",
        }),
      }),
    );
  });

  it("no fact row + old contract: the calendar fallback is withheld in a hidden market or SETUP store (stamps none)", async () => {
    // Finding #2, contract side: same gate as the fact writer.
    const old = contract({
      createdAt: new Date(NOW.getTime() - LINK_NO_FACT_GRACE_MS - 1),
      originOrderProcessedAt: new Date("2026-09-02T00:00:00Z"),
    });
    dbMocks.contractFindFirst.mockResolvedValue(old);
    dbMocks.factFindUnique.mockResolvedValue(null);
    dbMocks.revisionFindMany.mockResolvedValue(revisions());
    dbMocks.marketFindUnique.mockResolvedValue({ marketHandle: "ch" });
    dbMocks.eventFindMany.mockResolvedValue([]);
    settings({ widgetMarkets: { mode: "selected", handles: ["fr"] } });

    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: null,
      designSource: "none",
    });
    expect(dbMocks.contractUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ originDesignKey: null, originDesignSource: "none" }),
      }),
    );

    // Attributed events still win: a stamp is proof of exposure.
    dbMocks.contractUpdateMany.mockClear();
    dbMocks.eventFindMany.mockResolvedValue([{ payload: { orderId: ORDER, designKey: "tiles" } }]);
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: "tiles",
      designSource: "design_prop",
    });

    // SETUP store, allowed market: still none.
    dbMocks.contractUpdateMany.mockClear();
    dbMocks.eventFindMany.mockResolvedValue([]);
    settings();
    seamMocks.getLaunchState.mockResolvedValue({ mode: "SETUP" });
    expect(await linkContractDesign(SHOP, "c1", NOW)).toEqual({
      stamped: true,
      designKey: null,
      designSource: "none",
    });
  });

  it("no fact row + already stamped contract: no reads beyond the contract, no writes", async () => {
    dbMocks.contractFindFirst.mockResolvedValue(
      contract({ originDesignStampedAt: new Date(), createdAt: new Date("2020-01-01T00:00:00Z") }),
    );
    dbMocks.factFindUnique.mockResolvedValue(null);
    expect((await linkContractDesign(SHOP, "c1", NOW)).stamped).toBe(false);
    expect(dbMocks.eventFindMany).not.toHaveBeenCalled();
    expect(dbMocks.contractUpdateMany).not.toHaveBeenCalled();
  });
});
