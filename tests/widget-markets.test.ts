import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MARKET VISIBILITY (v1.25.0) — the app half of "the buy box only shows in
 * these Shopify Markets".
 *
 * What is pinned:
 *  - buildWidgetMarketsValue: the exact `{v:1, mode, handles}` the storefront
 *    reads; handles travel only under "selected", deduplicated, order kept.
 *  - publishWidgetMarketsMetafield never throws — reports.
 *  - saveWidgetMarkets: validate → setting → metafield → audit; a failed
 *    metafield write ROLLS THE SETTING BACK (the goLive contract) and
 *    returns a friendly error; "selected" with zero handles is refused;
 *    handles unknown to the live market list are refused; an unreadable
 *    market list refuses the save rather than trusting the input.
 *  - widgetMarketsDiverged mirrors the Liquid rule exactly: absent ⇔ all;
 *    "selected" lists compare as exact-string SETS; anything but byte-exact
 *    "selected" is "all"; unparsable / wrong-shape values are drift.
 *  - marketAllowed + parseHiddenMarketFromHtml (what the doctor/self-check
 *    read off a market-hidden page).
 *
 * DB-free: every seam is mocked (tests/launch-sync.test.ts pattern).
 */

const mocks = vi.hoisted(() => {
  const settings = new Map<string, unknown>();
  return {
    settings,
    setSettingCalls: [] as Array<{ key: string; value: unknown; actor?: string }>,
    setShopMetafield: vi.fn(async (): Promise<unknown> => ({ id: "gid://mf/1" })),
    getShopMetafield: vi.fn(async (): Promise<unknown> => null),
    listMarkets: vi.fn(async (): Promise<unknown[]> => []),
    logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ graphql: vi.fn() })),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    primaryDomain: "www.cellexia.example",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/settings/settings.server", async () => {
  const { settingsSchemas, defaultFor } = await import(
    "~/lib/settings/registry.server"
  );
  return {
    getSetting: vi.fn(async (shopId: string, key: string): Promise<unknown> => {
      const stored = mocks.settings.get(`${shopId}:${key}`);
      const schema = settingsSchemas[key as keyof typeof settingsSchemas];
      const parsed = schema.safeParse(stored);
      return parsed.success
        ? parsed.data
        : defaultFor(key as keyof typeof settingsSchemas);
    }),
    setSetting: vi.fn(
      async (
        shopId: string,
        key: string,
        value: unknown,
        actor?: string,
      ): Promise<void> => {
        const schema = settingsSchemas[key as keyof typeof settingsSchemas];
        const validated = schema.parse(value);
        mocks.settings.set(`${shopId}:${key}`, validated);
        mocks.setSettingCalls.push({ key, value: validated, actor });
      },
    ),
  };
});

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: mocks.setShopMetafield,
  getShopMetafield: mocks.getShopMetafield,
}));

vi.mock("~/lib/graphql/markets.server", () => ({
  listMarkets: mocks.listMarkets,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

import {
  MARKET_DIAG_ATTR,
  MARKET_HIDDEN_ATTR,
  WIDGET_MARKETS_METAFIELD_KEY,
  WIDGET_MARKETS_METAFIELD_NAMESPACE,
  auditSelectedHandles,
  buildWidgetMarketsValue,
  marketAllowed,
  parseHiddenMarketFromHtml,
  publishWidgetMarketsMetafield,
  readWidgetMarketsMetafield,
  saveWidgetMarkets,
  widgetMarketsDiverged,
} from "~/lib/widget/widget-markets.server";
import { defaultFor } from "~/lib/settings/registry.server";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const SETTING_KEY = "shop_1:widgetMarkets";
const ACTOR = "admin@cellexia.example";
const MARKETS = [
  { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
  { id: "gid://shopify/Market/2", name: "Germany", handle: "de", primary: false, enabled: true },
  { id: "gid://shopify/Market/3", name: "France", handle: "fr", primary: false, enabled: true },
];
const admin = { graphql: vi.fn() };

function stored(): unknown {
  return mocks.settings.get(SETTING_KEY);
}

function lastMetafieldWrite(): { namespace: string; key: string; type: string; value: string } {
  const call = mocks.setShopMetafield.mock.calls.at(-1) as unknown[] | undefined;
  if (!call) throw new Error("no metafield write");
  return call[1] as { namespace: string; key: string; type: string; value: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.clear();
  mocks.setSettingCalls.length = 0;
  mocks.setShopMetafield.mockImplementation(async () => ({ id: "gid://mf/1" }));
  mocks.getShopMetafield.mockImplementation(async () => null);
  mocks.listMarkets.mockImplementation(async () => MARKETS);
});

// ── buildWidgetMarketsValue ──────────────────────────────────────────────────

describe("buildWidgetMarketsValue", () => {
  it("emits {v:1, mode, handles} — the exact shape cx-buybox-core reads", () => {
    expect(
      buildWidgetMarketsValue({ mode: "selected", handles: ["ch", "de"] }),
    ).toEqual({ v: 1, mode: "selected", handles: ["ch", "de"] });
  });

  it("drops handles under mode all (Liquid never reads them; absent ⇔ all)", () => {
    expect(buildWidgetMarketsValue({ mode: "all", handles: ["ch"] })).toEqual({
      v: 1,
      mode: "all",
      handles: [],
    });
    expect(buildWidgetMarketsValue(defaultFor("widgetMarkets"))).toEqual({
      v: 1,
      mode: "all",
      handles: [],
    });
  });

  it("deduplicates handles, keeping first-seen order (never sorts, never normalises case)", () => {
    expect(
      buildWidgetMarketsValue({
        mode: "selected",
        handles: ["de", "ch", "de", "CH"],
      }).handles,
    ).toEqual(["de", "ch", "CH"]);
  });
});

// ── publish / read ───────────────────────────────────────────────────────────

describe("publishWidgetMarketsMetafield", () => {
  it("writes cellexia.widget_markets as a json metafield and reports the value", async () => {
    const result = await publishWidgetMarketsMetafield(admin, {
      mode: "selected",
      handles: ["ch"],
    });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ v: 1, mode: "selected", handles: ["ch"] });
    const write = lastMetafieldWrite();
    expect(write.namespace).toBe(WIDGET_MARKETS_METAFIELD_NAMESPACE);
    expect(write.key).toBe(WIDGET_MARKETS_METAFIELD_KEY);
    expect(write.type).toBe("json");
    expect(JSON.parse(write.value)).toEqual({ v: 1, mode: "selected", handles: ["ch"] });
    expect(WIDGET_MARKETS_METAFIELD_NAMESPACE).toBe("cellexia");
    expect(WIDGET_MARKETS_METAFIELD_KEY).toBe("widget_markets");
  });

  it("never throws — a failed write is reported", async () => {
    mocks.setShopMetafield.mockRejectedValue(new Error("metafieldsSet: throttled"));
    const result = await publishWidgetMarketsMetafield(admin, {
      mode: "all",
      handles: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("throttled");
  });

  it("readWidgetMarketsMetafield returns the raw value or null", async () => {
    expect(await readWidgetMarketsMetafield(admin)).toBeNull();
    mocks.getShopMetafield.mockResolvedValue({
      id: "gid://mf/1",
      namespace: "cellexia",
      key: "widget_markets",
      type: "json",
      value: '{"v":1,"mode":"all","handles":[]}',
    });
    expect(await readWidgetMarketsMetafield(admin)).toBe(
      '{"v":1,"mode":"all","handles":[]}',
    );
    expect(mocks.getShopMetafield).toHaveBeenLastCalledWith(
      admin,
      "cellexia",
      "widget_markets",
    );
  });
});

// ── saveWidgetMarkets ────────────────────────────────────────────────────────

describe("saveWidgetMarkets", () => {
  it("stores the setting, publishes the metafield and audits (previous + value)", async () => {
    const result = await saveWidgetMarkets(
      SHOP_DOMAIN,
      { mode: "selected", handles: ["ch", "de"] },
      ACTOR,
    );
    expect(result.ok).toBe(true);
    expect(stored()).toEqual({ mode: "selected", handles: ["ch", "de"] });
    expect(JSON.parse(lastMetafieldWrite().value)).toEqual({
      v: 1,
      mode: "selected",
      handles: ["ch", "de"],
    });
    expect(mocks.setSettingCalls.at(-1)?.actor).toBe(ACTOR);
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const event = mocks.logEvent.mock.calls[0][0] as {
      type: string;
      source: string;
      actor: string;
      payload: Record<string, unknown>;
    };
    expect(event.type).toBe("admin.action");
    expect(event.source).toBe("ADMIN");
    expect(event.actor).toBe(ACTOR);
    expect(event.payload).toEqual({
      action: "widget_markets_saved",
      value: { mode: "selected", handles: ["ch", "de"] },
      previous: { mode: "all", handles: [] },
    });
  });

  it("back to all markets: publishes {mode:all} (never deletes — absent and all mean the same) without listing markets", async () => {
    mocks.settings.set(SETTING_KEY, { mode: "selected", handles: ["ch"] });
    const result = await saveWidgetMarkets(SHOP_DOMAIN, { mode: "all", handles: [] }, ACTOR);
    expect(result.ok).toBe(true);
    expect(stored()).toEqual({ mode: "all", handles: [] });
    expect(JSON.parse(lastMetafieldWrite().value)).toEqual({ v: 1, mode: "all", handles: [] });
    expect(mocks.listMarkets).not.toHaveBeenCalled();
    const event = mocks.logEvent.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(event.payload.previous).toEqual({ mode: "selected", handles: ["ch"] });
  });

  it("ROLLS THE SETTING BACK when the metafield write fails, and returns a friendly error (goLive contract)", async () => {
    mocks.settings.set(SETTING_KEY, { mode: "selected", handles: ["ch"] });
    mocks.setShopMetafield.mockRejectedValue(new Error("network down"));

    const result = await saveWidgetMarkets(
      SHOP_DOMAIN,
      { mode: "selected", handles: ["ch", "de"] },
      ACTOR,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("publish_failed");
    expect(result.error).toContain("cellexia.widget_markets");
    expect(result.error).toContain("network down");
    expect(result.error).toContain("Nothing was changed");
    // Written, then restored to the previous value.
    expect(mocks.setSettingCalls.map((c) => c.value)).toEqual([
      { mode: "selected", handles: ["ch", "de"] },
      { mode: "selected", handles: ["ch"] },
    ]);
    expect(stored()).toEqual({ mode: "selected", handles: ["ch"] });
    // No audit event for a save that did not happen.
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("rolls back to the DEFAULT when there was no previous row", async () => {
    mocks.setShopMetafield.mockRejectedValue(new Error("boom"));
    const result = await saveWidgetMarkets(SHOP_DOMAIN, { mode: "selected", handles: ["ch"] }, ACTOR);
    expect(result.ok).toBe(false);
    expect(stored()).toEqual({ mode: "all", handles: [] });
  });

  it("refuses “selected” with zero handles — hidden everywhere is never what the merchant meant — touching nothing", async () => {
    for (const next of [
      { mode: "selected", handles: [] },
      { mode: "selected" },
      { mode: "selected", handles: ["  "] },
    ]) {
      const result = await saveWidgetMarkets(SHOP_DOMAIN, next, ACTOR);
      expect(result.ok, JSON.stringify(next)).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("invalid");
    }
    expect(stored()).toBeUndefined();
    expect(mocks.setShopMetafield).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // The zero-handles refusal names the intent (and the real kill switch).
    const r = await saveWidgetMarkets(SHOP_DOMAIN, { mode: "selected", handles: [] }, ACTOR);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("at least one market");
    expect(r.error).toContain("Revert to setup");
  });

  it("refuses handles that are not markets on this shop (validated against the LIVE list), naming them", async () => {
    const result = await saveWidgetMarkets(
      SHOP_DOMAIN,
      { mode: "selected", handles: ["ch", "xx", "CH"] },
      ACTOR,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unknown_handles");
    expect(result.error).toContain("“xx”");
    expect(result.error).toContain("“CH”"); // exact match — case is not folded
    expect(result.error).not.toContain("“ch”");
    expect(stored()).toBeUndefined();
    expect(mocks.setShopMetafield).not.toHaveBeenCalled();
  });

  it("uses a caller-supplied market list instead of re-reading Shopify", async () => {
    const result = await saveWidgetMarkets(
      SHOP_DOMAIN,
      { mode: "selected", handles: ["ch"] },
      ACTOR,
      { markets: MARKETS },
    );
    expect(result.ok).toBe(true);
    expect(mocks.listMarkets).not.toHaveBeenCalled();
  });

  it("refuses the save when the market list cannot be read (never trusts unverified handles)", async () => {
    mocks.listMarkets.mockRejectedValue(new Error("read_markets denied"));
    const result = await saveWidgetMarkets(SHOP_DOMAIN, { mode: "selected", handles: ["ch"] }, ACTOR);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("markets_unreadable");
    expect(result.error).toContain("read_markets denied");
    expect(stored()).toBeUndefined();
    expect(mocks.setShopMetafield).not.toHaveBeenCalled();
  });

  it("rejects malformed input through the registry schema (mode, handle length, list length)", async () => {
    for (const next of [
      { mode: "some", handles: ["ch"] },
      { mode: "selected", handles: ["x".repeat(256)] },
      { mode: "selected", handles: Array.from({ length: 51 }, (_, i) => `m${i}`) },
      "garbage",
      null,
    ]) {
      const result = await saveWidgetMarkets(SHOP_DOMAIN, next, ACTOR);
      expect(result.ok, JSON.stringify(next)).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.code).toBe("invalid");
    }
    expect(stored()).toBeUndefined();
  });

  it("trims and deduplicates handles before storing and publishing", async () => {
    const result = await saveWidgetMarkets(
      SHOP_DOMAIN,
      { mode: "selected", handles: [" ch ", "de", "ch"] },
      ACTOR,
    );
    expect(result.ok).toBe(true);
    expect(stored()).toEqual({ mode: "selected", handles: ["ch", "de"] });
    expect(JSON.parse(lastMetafieldWrite().value).handles).toEqual(["ch", "de"]);
  });
});

// ── widgetMarketsDiverged ────────────────────────────────────────────────────

describe("widgetMarketsDiverged", () => {
  const ALL = { mode: "all" as const, handles: [] as string[] };
  const CH_DE = { mode: "selected" as const, handles: ["ch", "de"] };

  it("absent metafield ⇔ all markets (the default needs no sync)", () => {
    expect(widgetMarketsDiverged(ALL, null)).toBe(false);
    expect(widgetMarketsDiverged({ mode: "all", handles: ["ch"] }, null)).toBe(false);
    expect(widgetMarketsDiverged(CH_DE, null)).toBe(true);
  });

  it("all ⇔ any published mode other than byte-exact 'selected' (mirrors the Liquid)", () => {
    for (const value of [
      '{"v":1,"mode":"all","handles":[]}',
      '{"v":1,"mode":"all","handles":["ch"]}',
      '{"v":1,"mode":"SELECTED","handles":["ch"]}',
      '{"v":1,"handles":["ch"]}',
      "{}",
    ]) {
      expect(widgetMarketsDiverged(ALL, value), value).toBe(false);
      expect(widgetMarketsDiverged(CH_DE, value), value).toBe(true);
    }
  });

  it("selected lists compare as exact-string SETS: order and duplicates ignored, case and whitespace not", () => {
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":["de","ch","de"]}')).toBe(false);
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":["ch"]}')).toBe(true);
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":["ch","de","fr"]}')).toBe(true);
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":["CH","de"]}')).toBe(true);
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":[" ch","de"]}')).toBe(true);
    expect(widgetMarketsDiverged(ALL, '{"v":1,"mode":"selected","handles":["ch"]}')).toBe(true);
    // Non-string members can never equal a market handle — ignored.
    expect(widgetMarketsDiverged(CH_DE, '{"v":1,"mode":"selected","handles":["ch",1,"de",null]}')).toBe(false);
  });

  it("unparsable or wrong-shape values are drift (a re-sync rewrites the canonical value)", () => {
    for (const value of ["{not json", "[]", "\"selected\"", "1", '{"mode":"selected","handles":"ch"}', '{"mode":"selected"}']) {
      expect(widgetMarketsDiverged(ALL, value), value).toBe(true);
      expect(widgetMarketsDiverged(CH_DE, value), value).toBe(true);
    }
  });

  it("round-trips its own publish (build → stringify → not diverged)", () => {
    for (const setting of [ALL, CH_DE, { mode: "selected" as const, handles: ["ch"] }]) {
      const value = JSON.stringify(buildWidgetMarketsValue(setting));
      expect(widgetMarketsDiverged(setting, value)).toBe(false);
    }
  });
});

// ── marketAllowed / parseHiddenMarketFromHtml ────────────────────────────────

describe("marketAllowed", () => {
  it("all → every handle, blank and missing included", () => {
    expect(marketAllowed({ mode: "all", handles: [] }, "ch")).toBe(true);
    expect(marketAllowed({ mode: "all", handles: [] }, "")).toBe(true);
    expect(marketAllowed({ mode: "all", handles: [] }, null)).toBe(true);
  });

  it("selected → exact members only; blank/missing fail closed", () => {
    const s = { mode: "selected" as const, handles: ["ch"] };
    expect(marketAllowed(s, "ch")).toBe(true);
    for (const h of ["CH", " ch", "ch ", "c", "cha", "", null, undefined]) {
      expect(marketAllowed(s, h), JSON.stringify(h)).toBe(false);
    }
  });
});

describe("parseHiddenMarketFromHtml", () => {
  const marker = (handle: string) =>
    `<html><!-- BEGIN app snippet: cx-buybox-core --><template class="cx-buybox-nogroup" ${MARKET_HIDDEN_ATTR} hidden style="display:none!important" ${MARKET_DIAG_ATTR}="${handle}"></template><!-- END app snippet --></html>`;

  it("returns null when the marker is absent (ordinary and gated pages alike)", () => {
    expect(parseHiddenMarketFromHtml('<div class="cx-buybox" data-cellexia-buybox></div>')).toBeNull();
    expect(parseHiddenMarketFromHtml('<div class="cx-buybox" data-cellexia-buybox hidden data-cellexia-gated="true"></div>')).toBeNull();
    expect(parseHiddenMarketFromHtml("")).toBeNull();
    // The no-owned-group marker is NOT the market marker.
    expect(
      parseHiddenMarketFromHtml('<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden></template>'),
    ).toBeNull();
  });

  it("returns the handle (Liquid-escaped attribute decoded), or '' for a blank one", () => {
    expect(parseHiddenMarketFromHtml(marker("fr"))).toBe("fr");
    expect(parseHiddenMarketFromHtml(marker(""))).toBe("");
    expect(parseHiddenMarketFromHtml(marker("a&amp;b"))).toBe("a&b");
  });

  it("the attribute names match what the Liquid renders", () => {
    expect(MARKET_HIDDEN_ATTR).toBe("data-cellexia-market-hidden");
    expect(MARKET_DIAG_ATTR).toBe("data-cellexia-diag-market");
  });
});

// ── auditSelectedHandles (saved handles vs the LIVE market list) ─────────────

describe("auditSelectedHandles", () => {
  const LIVE_AND_DRAFT = [
    { handle: "ch", enabled: true },
    { handle: "de", enabled: true },
    { handle: "eu", enabled: false }, // a draft market: listed, never resolved
  ];

  it("under all → nothing to audit (empty lists)", () => {
    expect(auditSelectedHandles({ mode: "all", handles: ["zz"] }, LIVE_AND_DRAFT)).toEqual({
      missing: [],
      disabled: [],
      live: [],
    });
  });

  it("splits a selected list into live / disabled / missing (exact handles, first-seen order, deduplicated)", () => {
    expect(
      auditSelectedHandles(
        { mode: "selected", handles: ["de", "eu", "xx", "ch", "de", "CH"] },
        LIVE_AND_DRAFT,
      ),
    ).toEqual({ missing: ["xx", "CH"], disabled: ["eu"], live: ["de", "ch"] });
  });

  it("names the hidden-everywhere state: a selection of only drafts / deleted markets has zero live handles", () => {
    expect(
      auditSelectedHandles({ mode: "selected", handles: ["eu"] }, LIVE_AND_DRAFT).live,
    ).toEqual([]);
    expect(
      auditSelectedHandles({ mode: "selected", handles: ["gone"] }, LIVE_AND_DRAFT).live,
    ).toEqual([]);
    // …and a shop whose market list is empty (nothing to match against).
    expect(auditSelectedHandles({ mode: "selected", handles: ["ch"] }, [])).toEqual({
      missing: ["ch"],
      disabled: [],
      live: [],
    });
  });
});

// ── listMarkets: `enabled` reaches the app (the real module, mocked API) ─────

describe("listMarkets (real module) — draft markets are flagged, not dropped", () => {
  function adminAnswering(nodes: unknown[]) {
    return {
      graphql: vi.fn(
        async (_query: string, _options?: { variables?: Record<string, unknown> }) =>
          new Response(JSON.stringify({ data: { markets: { nodes } } }), {
            status: 200,
          }),
      ),
    };
  }

  it("queries `enabled` and maps it; a missing field counts as enabled (never mislabels a live market)", async () => {
    // The module is mocked file-wide for saveWidgetMarkets; reach the real one.
    const real = await vi.importActual<typeof import("~/lib/graphql/markets.server")>(
      "~/lib/graphql/markets.server",
    );
    const admin = adminAnswering([
      { id: "gid://shopify/Market/2", name: "EU (draft)", handle: "eu", primary: false, enabled: false },
      { id: "gid://shopify/Market/1", name: "Switzerland", handle: "ch", primary: true, enabled: true },
      { id: "gid://shopify/Market/3", name: "Legacy", handle: "old", primary: false },
      { id: "gid://shopify/Market/4", name: "No handle", handle: null, primary: false, enabled: true },
    ]);
    const markets = await real.listMarkets(admin);
    expect(String(admin.graphql.mock.calls[0]?.[0])).toContain("enabled");
    expect(markets.map((m) => [m.handle, m.enabled])).toEqual([
      ["ch", true],
      ["eu", false],
      ["old", true],
    ]);
  });
});
