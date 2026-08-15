import { describe, expect, it } from "vitest";
import {
  JOY_GROUP,
  attributeValue,
  parseJsonIsland,
  renderEmbed,
  renderWidget,
  rootTag,
  tagsWithAttribute,
  visibleText,
} from "./harness";

/**
 * MARKET VISIBILITY (v1.25.0) — "the app is live, but the buy box only shows
 * in these Shopify Markets".
 *
 * The Liquid half of the contract, pinned render by render:
 *
 *  - The shop metafield `cellexia.widget_markets` ({v, mode, handles}) is
 *    read at the very top of cx-buybox-core; ABSENT, mode "all", an unknown
 *    mode or a mode-less object all SHOW the widget in every market — the
 *    default is a no-op nobody has to sync.
 *  - mode "selected" shows the widget only where `handles contains
 *    localization.market.handle` — plain Liquid array `contains`: EXACT
 *    element equality, no case folding, no trimming (the same rule as the
 *    v1.6.0 per-market preset lookup and the launch gate's exact "live").
 *    A blank handle, or a storefront without the `localization` drop at
 *    all, FAILS CLOSED under "selected".
 *  - An excluded market renders ONLY an inert hidden template
 *    (`data-cellexia-market-hidden`, carrying the resolved handle as
 *    `data-cellexia-diag-market`) — no widget markup, no JSON island, no
 *    launch-gate attribute (a gated widget would be REVEALED by any admin
 *    preview link and would trip the self-check's "still gated" FAIL), and
 *    NOT the `data-cellexia-no-owned-group` marker (so buy-box.js's "plans
 *    from another app" card can never fire on a market the merchant hid).
 *    Market-hidden wins over no-owned-group and over the launch gate.
 *  - The metafield-absent path is BYTE-IDENTICAL to v1.24.0 (verified by
 *    diffing renders across the tag; the golden snapshot suite renders with
 *    the metafield absent and stays green).
 *
 * The app half (setting, metafield publish + rollback, divergence detector,
 * doctor/self-check probes) is pinned in tests/widget-markets.test.ts,
 * tests/preview-doctor.test.ts and tests/selfcheck.test.ts.
 */

const PATHS = [
  { name: "section block", render: renderWidget },
  { name: "app embed", render: renderEmbed },
] as const;

const SELECTED_CH = { v: 1, mode: "selected", handles: ["ch"] };
const SELECTED_CH_DE = { v: 1, mode: "selected", handles: ["ch", "de"] };

const MARKET_HIDDEN_TEMPLATE =
  /<template class="cx-buybox-nogroup" data-cellexia-market-hidden hidden style="display:none!important" data-cellexia-diag-market="[^"]*"><\/template>/;

/** The excluded-market shape: nothing but the inert marker. */
function expectMarketHidden(html: string, expectedHandle: string): void {
  expect(rootTag(html)).toBeNull();
  expect(html).not.toContain("data-cellexia-buybox");
  expect(html).not.toContain("data-cellexia-gated");
  expect(html).not.toContain("data-cellexia-no-owned-group");
  expect(html).not.toContain("data-cellexia-data");
  expect(html).not.toContain("data-cellexia-preview-ribbon");
  expect(() => parseJsonIsland(html)).toThrow();
  expect(visibleText(html)).toBe("");
  expect(html).toMatch(MARKET_HIDDEN_TEMPLATE);
  const markers = tagsWithAttribute(html, "data-cellexia-market-hidden");
  expect(markers).toHaveLength(1);
  expect(attributeValue(markers[0], "data-cellexia-diag-market")).toBe(
    expectedHandle,
  );
}

/** The ordinary live widget: root present, island parses, no marker. */
function expectShown(html: string): void {
  expect(rootTag(html)).not.toBeNull();
  expect(html).toContain("data-cellexia-buybox");
  expect(() => parseJsonIsland(html)).not.toThrow();
  expect(html).not.toContain("data-cellexia-market-hidden");
  expect(html).not.toContain("data-cellexia-diag-market");
  expect(visibleText(html)).not.toBe("");
}

// ── Shown ────────────────────────────────────────────────────────────────────

describe("market visibility — shown", () => {
  it("metafield absent → shown in a market, with a blank handle, and with no localization drop (both paths)", async () => {
    for (const { render } of PATHS) {
      expectShown(await render({ launchStatus: "live", marketHandle: "ch" }));
      expectShown(await render({ launchStatus: "live", marketHandle: "" }));
      expectShown(await render({ launchStatus: "live" }));
    }
  });

  it('mode "all" → shown everywhere, whatever the handles list says (both paths)', async () => {
    for (const { render } of PATHS) {
      expectShown(
        await render({
          launchStatus: "live",
          marketHandle: "fr",
          widgetMarkets: { v: 1, mode: "all", handles: [] },
        }),
      );
      // A stale handles list under "all" is inert — the mode decides.
      expectShown(
        await render({
          launchStatus: "live",
          marketHandle: "fr",
          widgetMarkets: { v: 1, mode: "all", handles: ["ch"] },
        }),
      );
      expectShown(
        await render({
          launchStatus: "live",
          widgetMarkets: { v: 1, mode: "all", handles: [] },
        }),
      );
    }
  });

  it('mode "selected" + a member market → shown, byte-identical to the metafield-absent render (both paths)', async () => {
    for (const { render } of PATHS) {
      const shown = await render({
        launchStatus: "live",
        marketHandle: "ch",
        widgetMarkets: SELECTED_CH_DE,
      });
      expectShown(shown);
      const baseline = await render({ launchStatus: "live", marketHandle: "ch" });
      expect(shown).toBe(baseline);
    }
  });

  it("an unknown mode → shown (only byte-exact 'selected' restricts)", async () => {
    for (const mode of ["SELECTED", "Selected", " selected", "none", "some", "", null, 1]) {
      const html = await renderWidget({
        launchStatus: "live",
        marketHandle: "fr",
        widgetMarkets: { v: 1, mode, handles: ["ch"] },
      });
      expectShown(html);
    }
  });

  it("a mode-less object, or a metafield of the wrong shape, → shown", async () => {
    expectShown(
      await renderWidget({
        launchStatus: "live",
        marketHandle: "fr",
        widgetMarkets: { v: 1, handles: ["ch"] },
      }),
    );
    expectShown(
      await renderWidget({
        launchStatus: "live",
        marketHandle: "fr",
        widgetMarkets: {},
      }),
    );
  });

  it("the market visibility rule does not disturb the per-market PRESET rule (hoisted handle assign)", async () => {
    // config.markets still resolves off the same handle after the assign
    // moved to the top of the snippet — and a member market of the
    // visibility list resolves its preset exactly as before.
    const config = {
      v: 1,
      preset: "classic",
      markets: { ch: { preset: "subscription_max" } },
    };
    const html = await renderWidget({
      launchStatus: "live",
      marketHandle: "ch",
      config,
      widgetMarkets: SELECTED_CH,
    });
    expectShown(html);
    expect(rootTag(html)).toContain("cx-buybox--subscription_max");
    const fr = await renderWidget({
      launchStatus: "live",
      marketHandle: "ch",
      config,
    });
    expect(fr).toBe(html);
  });
});

// ── Hidden ───────────────────────────────────────────────────────────────────

describe("market visibility — hidden", () => {
  it('mode "selected" + a non-member market → only the inert marker (both paths)', async () => {
    for (const { render } of PATHS) {
      const html = await render({
        launchStatus: "live",
        marketHandle: "fr",
        widgetMarkets: SELECTED_CH_DE,
      });
      expectMarketHidden(html, "fr");
    }
  });

  it("the embed path still renders its (empty, hidden) wrapper so the mount logic sees nothing to place", async () => {
    const html = await renderEmbed({
      launchStatus: "live",
      marketHandle: "fr",
      widgetMarkets: SELECTED_CH,
    });
    const wrappers = tagsWithAttribute(html, "data-cellexia-embed");
    expect(wrappers).toHaveLength(1);
    expect(wrappers[0]).toMatch(/(?:^|\s)hidden(?=[\s>=])/);
    expectMarketHidden(html, "fr");
  });

  it('no localization drop under "selected" → hidden (fails closed, blank diag handle)', async () => {
    for (const { render } of PATHS) {
      const html = await render({
        launchStatus: "live",
        widgetMarkets: SELECTED_CH,
      });
      expectMarketHidden(html, "");
    }
  });

  it('a blank market handle under "selected" → hidden (fails closed)', async () => {
    const html = await renderWidget({
      launchStatus: "live",
      marketHandle: "",
      widgetMarkets: SELECTED_CH,
    });
    expectMarketHidden(html, "");
  });

  it("matches handles EXACTLY — no prefix, suffix, whitespace or case match", async () => {
    for (const nearMiss of ["c", "ch2", "cha", " ch", "ch ", "CH"]) {
      const html = await renderWidget({
        launchStatus: "live",
        marketHandle: nearMiss,
        widgetMarkets: SELECTED_CH,
      });
      expect(html, JSON.stringify(nearMiss)).not.toContain("data-cellexia-buybox");
      expect(html, JSON.stringify(nearMiss)).toContain("data-cellexia-market-hidden");
    }
    // …and the exact handle still renders, so the loop is not vacuous.
    expectShown(
      await renderWidget({
        launchStatus: "live",
        marketHandle: "ch",
        widgetMarkets: SELECTED_CH,
      }),
    );
  });

  it("the diag handle is HTML-escaped", async () => {
    const html = await renderWidget({
      launchStatus: "live",
      marketHandle: 'x"><script>alert(1)</script>',
      widgetMarkets: SELECTED_CH,
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    const markers = tagsWithAttribute(html, "data-cellexia-market-hidden");
    expect(markers).toHaveLength(1);
    expect(attributeValue(markers[0], "data-cellexia-diag-market")).toBe(
      "x&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it('{mode:"selected"} with no handles at all → hidden (the app refuses to save this; the Liquid fails closed anyway)', async () => {
    for (const widgetMarkets of [
      { v: 1, mode: "selected" },
      { v: 1, mode: "selected", handles: [] },
    ]) {
      const html = await renderWidget({
        launchStatus: "live",
        marketHandle: "ch",
        widgetMarkets,
      });
      expectMarketHidden(html, "ch");
    }
  });

  it("market-hidden WINS over no-owned-group: a foreign-group-only product in an excluded market renders the market marker, not the no-group marker", async () => {
    for (const { render } of PATHS) {
      const html = await render({
        launchStatus: "live",
        omitOwnGroup: true,
        otherGroups: [JOY_GROUP],
        marketHandle: "fr",
        widgetMarkets: SELECTED_CH,
      });
      expectMarketHidden(html, "fr");
      expect(html).not.toContain("data-cellexia-diag-groups");
      expect(html).not.toContain(String(JOY_GROUP.plans?.[0]?.id));
    }
  });

  it("…while the same product in a MEMBER market still renders the no-owned-group marker (the ownership rule is untouched)", async () => {
    const html = await renderWidget({
      launchStatus: "live",
      omitOwnGroup: true,
      otherGroups: [JOY_GROUP],
      marketHandle: "ch",
      widgetMarkets: SELECTED_CH,
    });
    expect(html).toContain("data-cellexia-no-owned-group");
    expect(html).not.toContain("data-cellexia-market-hidden");
    expect(rootTag(html)).toBeNull();
  });

  it("market-hidden WINS over the launch gate: SETUP + excluded market → no gated widget markup at all", async () => {
    for (const { render } of PATHS) {
      const html = await render({
        launchStatus: "setup",
        marketHandle: "fr",
        widgetMarkets: SELECTED_CH,
      });
      expectMarketHidden(html, "fr");
      expect(html).not.toContain('data-cellexia-gated="true"');
    }
    // …and SETUP + member market renders the ordinary gated widget.
    const gated = await renderWidget({
      launchStatus: "setup",
      marketHandle: "ch",
      widgetMarkets: SELECTED_CH,
    });
    expect(gated).toContain('data-cellexia-gated="true"');
    expect(gated).not.toContain("data-cellexia-market-hidden");
  });

  it("an absent allow-list in an excluded market still renders the market marker (market check runs first, leaks nothing)", async () => {
    const html = await renderWidget({
      launchStatus: "live",
      planGroups: null,
      marketHandle: "fr",
      widgetMarkets: SELECTED_CH,
    });
    expectMarketHidden(html, "fr");
  });

  it("a subscription-only product (requires_selling_plan) in an excluded market is hidden like any other — deliberate: the gate never leaks subscription UI into a hidden market, so such products are unbuyable there (the admin copy + docs say so)", async () => {
    // Pinned so the interaction is a documented decision, not an accident:
    // no selling_plan input reaches the theme form in a hidden market, and
    // Shopify rejects a cart add of a requires-selling-plan variant without
    // one. The remedy lives in Markets (unpublish the product there) or in
    // making the product subscription-optional — never in this Liquid.
    for (const { render } of PATHS) {
      const html = await render({
        launchStatus: "live",
        marketHandle: "fr",
        widgetMarkets: SELECTED_CH,
        requiresSellingPlan: true,
      });
      expectMarketHidden(html, "fr");
      expect(html).not.toContain('name="selling_plan"');
    }
    // …while a member market renders it subscription-forced as before.
    const shown = await renderWidget({
      launchStatus: "live",
      marketHandle: "ch",
      widgetMarkets: SELECTED_CH,
      requiresSellingPlan: true,
    });
    expectShown(shown);
    expect(parseJsonIsland(shown).requiresSellingPlan).toBe(true);
  });

  it("the excluded-market render carries no plan id, price or heading text", async () => {
    const shown = await renderWidget({ launchStatus: "live", marketHandle: "ch" });
    const island = parseJsonIsland(shown);
    const hidden = await renderWidget({
      launchStatus: "live",
      marketHandle: "fr",
      widgetMarkets: SELECTED_CH,
    });
    expect(hidden).not.toContain(String(island.initialPlan));
    expect(hidden).not.toContain("Choose your ritual");
    expect(hidden).not.toContain("cx-buybox__");
  });
});
