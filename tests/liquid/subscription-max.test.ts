import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";
import type { PresetKey, WidgetDesignConfig } from "~/lib/widget/presets";

import {
  FIXTURE,
  attributeValue,
  countOccurrences,
  decodeEntitiesOnce,
  elementTexts,
  parseJsonIsland,
  readAsset,
  renderEmbed,
  renderWidget,
  rootTag,
  tagsWithAttribute,
  visibleText,
} from "./harness";
import type { MakeContextOptions } from "./harness";

/**
 * GOLDEN TESTS for the subscription_max preset (v1.6.0) and the per-market
 * preset resolution it shipped with.
 *
 * THE DESIGN CONTRACT UNDER TEST
 * ------------------------------
 * subscription_max makes the subscription card the whole buy box: one calm
 * card (price, "then … every …" line, savings quiet, reassurance PROMINENT),
 * no badge / no frequency selector / no heading by default, and the one-time
 * purchase demoted to a single muted underlined link BELOW the card.
 *
 * The preset's COMPLIANCE GUARDRAILS are non-negotiable and are what most of
 * this file exists to pin:
 *   - one-time purchase stays a REAL, selectable option (a radio in the same
 *     group every card preset uses — the JS needs no submax-specific code);
 *   - it is reachable in exactly ONE interaction (the link and its radio
 *     share one <label>);
 *   - its price is visible IN THE LINK TEXT before any interaction;
 *   - quiet is never hidden: the widget must not pretend the product is
 *     subscription-only when it is not.
 * "Quiet" is presentation only — remove the price from the link and the
 * preset crosses from persuasion into dark-pattern territory, which is both
 * a compliance and a conversion problem. These assertions are the tripwire.
 *
 * PER-MARKET RESOLUTION
 * ---------------------
 * config.markets maps Shopify MARKET HANDLES → { preset }; the Liquid
 * resolves localization.market.handle against it (exact key match, nil-safe,
 * unknown preset falls back to the BASE preset) and the theme editor's
 * design_source override still beats everything. The harness only injects a
 * `localization` drop when a test passes marketHandle — leaving it out is
 * the nil-safe production state older stores present.
 */

// ── Config fixtures ──────────────────────────────────────────────────────────

type LayoutOverrides = Partial<WidgetDesignConfig["layout"]>;
type TextOverrides = WidgetDesignConfig["text"];
type MarketsOverrides = WidgetDesignConfig["markets"];

/**
 * A config the way the admin actually publishes it, validated through the
 * real zod schema and round-tripped through JSON like the shop metafield.
 */
function publishedConfig(
  preset: PresetKey,
  layout: LayoutOverrides = {},
  text: TextOverrides = {},
  markets: MarketsOverrides = {},
): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset,
    layout: { ...DEFAULT_DESIGN_CONFIG.layout, ...layout },
    text,
    markets,
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/**
 * subscription_max as the designer publishes it: picking the preset applies
 * its quiet layout defaults (PRESET_LAYOUT_DEFAULTS in app.buy-box.tsx —
 * showBadge and showFrequency OFF). Overrides let a test re-enable each knob
 * exactly like the merchant's toggles would.
 */
function submaxConfig(
  layout: LayoutOverrides = {},
  text: TextOverrides = {},
): Record<string, unknown> {
  return publishedConfig(
    "subscription_max",
    { showBadge: false, showFrequency: false, ...layout },
    text,
  );
}

const ONE_TIME_PRICE = "CHF 64.00";
const SUB_FIRST_PRICE = "CHF 51.20";

// ── Markup extraction helpers ────────────────────────────────────────────────

/** The quiet one-time link's opening tag + decoded visible text. */
function quietLink(html: string): { tag: string; text: string } {
  const match =
    /<span class="cx-buybox__submax-link"([^>]*)>([\s\S]*?)<\/span>/.exec(html);
  expect(match, "quiet one-time link (.cx-buybox__submax-link)").not.toBeNull();
  const m = match as RegExpExecArray;
  return {
    tag: `<span class="cx-buybox__submax-link"${m[1]}>`,
    text: decodeEntitiesOnce(m[2].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/** The single label that wraps the one-time radio, the link and the picked state. */
function quietChoiceLabel(html: string): string {
  const match =
    /<label class="cx-buybox__submax-choice">([\s\S]*?)<\/label>/.exec(html);
  expect(match, "one-time choice label (.cx-buybox__submax-choice)").not.toBeNull();
  return (match as RegExpExecArray)[0];
}

/** The reassurance <p> opening tag, or null. */
function reassuranceTag(html: string): string | null {
  const match = /<p class="cx-buybox__reassurance"[^>]*>/.exec(html);
  return match ? match[0] : null;
}

function resolvedPreset(html: string): string | null {
  const root = rootTag(html);
  return root ? attributeValue(root, "data-cellexia-preset") : null;
}

/** The guards every render in this file must satisfy (see render.test.ts). */
function expectStandingGuards(html: string): void {
  // (a) app-snippet markers stay comments, never page text.
  expect(html).toContain("<!-- BEGIN app snippet: cx-buybox-core -->");
  expect(html).not.toContain("&lt;!--");
  const text = visibleText(html);
  expect(text).not.toContain("app snippet");
  // (b) nothing escaped twice.
  expect(html).not.toContain("&amp;amp;");
  expect(text).not.toContain("&amp;");
  // (c) no unresolved placeholders / missing translations.
  for (const placeholder of ["{percent}", "{amount}", "{frequency}"]) {
    expect(text).not.toContain(placeholder);
  }
  expect(text).not.toContain("translation missing");
  // Never leak a Liquid delimiter.
  expect(html).not.toContain("{%");
  expect(html).not.toContain("%}");
}

function expectGate(html: string, live: boolean): void {
  const root = rootTag(html);
  expect(root).not.toBeNull();
  const rootMarkup = root as string;
  if (live) {
    expect(rootMarkup).not.toMatch(/(?:^|\s)hidden(?=[\s>=])/);
    expect(rootMarkup).not.toContain("data-cellexia-gated");
  } else {
    expect(rootMarkup).toMatch(/(?:^|\s)hidden(?=[\s>=])/);
    expect(rootMarkup).toContain('data-cellexia-gated="true"');
  }
}

// ── The subscription_max matrix: block + embed, live + gated ─────────────────

const PATHS = [
  { name: "app block", render: renderWidget },
  { name: "app embed", render: renderEmbed },
] as const;

describe.each(PATHS)("subscription_max · $name", ({ render }) => {
  describe.each(["live", "setup"] as const)("launch_status %s", (launchStatus) => {
    const options: MakeContextOptions = {
      config: submaxConfig(),
      launchStatus,
    };

    it("renders ONE subscription card as the buy box", async () => {
      const html = await render(options);
      expectStandingGuards(html);
      expectGate(html, launchStatus === "live");

      expect(countOccurrences(html, "data-cellexia-buybox")).toBe(1);
      expect(resolvedPreset(html)).toBe("subscription_max");
      expect(rootTag(html)).toContain("cx-buybox--subscription_max");
      expect(html).toContain("cx-buybox__submax-card");
      expect(html).toContain('data-cellexia-option-wrap="subscription"');

      // The card carries the price machinery and the "then …" line hooks.
      expect(html).toContain("data-cellexia-sub-price");
      expect(html).toContain("data-cellexia-then");
      expect(visibleText(html)).toContain(SUB_FIRST_PRICE);
      expect(visibleText(html)).toContain("then CHF 57.60 every 8 weeks");
    });

    it("COMPLIANCE: the quiet link shows the one-time price BEFORE selection", async () => {
      const html = await render(options);
      const link = quietLink(html);

      // The price is part of the link's own VISIBLE text — a shopper reads
      // "or buy once for CHF 64.00" without hovering, tapping or scrolling.
      // (Mutation-checked: dropping the amount from the label makes this
      // line fail — see the release notes for the run log.)
      expect(link.text).toBe(`or buy once for ${ONE_TIME_PRICE}`);
      expect(link.text).toContain(ONE_TIME_PRICE);

      // …and it is the real one-time price, not a subscription number.
      expect(link.text).not.toContain(SUB_FIRST_PRICE);

      // The link is a quiet element, never a hidden one.
      expect(link.tag).not.toMatch(/(?:^|\s)hidden(?=[\s>=]|$)/);

      // The RAW template travels to buy-box.js so variant changes keep the
      // price in the link current.
      const tpl = attributeValue(link.tag, "data-cellexia-tpl");
      expect(tpl).not.toBeNull();
      expect(decodeEntitiesOnce(tpl as string)).toBe("or buy once for {amount}");
    });

    it("one-time purchase stays a REAL radio wired to the existing JS machinery", async () => {
      const html = await render(options);

      // Exactly one radio per option, in the SAME group (name), with the
      // value contract buy-box.js's `input[data-cellexia-option]` handler
      // expects — subscription_max deliberately adds no JS of its own.
      const radios = tagsWithAttribute(html, "data-cellexia-option");
      const byValue = (value: string) =>
        radios.filter((tag) => attributeValue(tag, "data-cellexia-option") === value);
      expect(byValue("subscription")).toHaveLength(1);
      expect(byValue("one_time")).toHaveLength(1);

      const sub = byValue("subscription")[0];
      const oneTime = byValue("one_time")[0];
      for (const radio of [sub, oneTime]) {
        expect(radio.startsWith("<input")).toBe(true);
        expect(attributeValue(radio, "type")).toBe("radio");
        expect(attributeValue(radio, "name")).toBe("cx-purchase-cx-block-1");
      }
      expect(attributeValue(sub, "value")).toBe("subscription");
      expect(attributeValue(oneTime, "value")).toBe("one_time");

      // Subscription preselected (the preset's posture), one-time not.
      expect(sub).toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
      expect(oneTime).not.toMatch(/(?:^|\s)checked(?=[\s>]|$)/);

      // Screen readers get a proper radio group: sr-only inputs inside a
      // role=radiogroup tied to the visually-hidden label.
      expect(sub).toContain("cx-buybox__sr-input");
      expect(oneTime).toContain("cx-buybox__sr-input");
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain('aria-labelledby="cx-buybox-label-cx-block-1"');

      // ONE interaction: the radio and the link text live in the same
      // <label>, so tapping the visible link IS selecting one-time.
      const label = quietChoiceLabel(html);
      expect(label).toContain('data-cellexia-option="one_time"');
      expect(label).toContain("cx-buybox__submax-link");

      // The minimal selected state is server-rendered and CSS-swapped: the
      // picked line (check + label + price) and the switch-back link, wired
      // to the subscription radio through its `for` attribute.
      expect(label).toContain("cx-buybox__submax-picked");
      expect(elementTexts(html, "data-cellexia-onetime-price")).toContain(
        ONE_TIME_PRICE,
      );
      expect(visibleText(html)).toContain("One-time purchase");
      const switchback =
        /<label class="cx-buybox__submax-switchback"[^>]*>/.exec(html);
      expect(switchback).not.toBeNull();
      expect(attributeValue((switchback as RegExpExecArray)[0], "for")).toBe(
        "cx-submax-sub-cx-block-1",
      );
      expect(attributeValue(sub, "id")).toBe("cx-submax-sub-cx-block-1");
      expect(visibleText(html)).toContain("Switch back to Subscribe & Save");

      // …and the one-time wrap sits BELOW the card in the markup.
      expect(html.indexOf("cx-buybox__submax-onetime")).toBeGreaterThan(
        html.indexOf("cx-buybox__submax-card"),
      );
    });

    it("quiet defaults: no badge, no frequency selector, no heading", async () => {
      const html = await render(options);
      expect(html).not.toContain("cx-buybox__badge");
      expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
      expect(tagsWithAttribute(html, "data-cellexia-freq-chip")).toHaveLength(0);
      expect(html).not.toContain('<h3 class="cx-buybox__heading">');
      // No "choose your option" framing anywhere (the block-setting default
      // heading is skipped on purpose for this preset).
      expect(visibleText(html)).not.toContain("Choose your ritual");
      // The selector being off still means a REAL default cadence in the
      // hidden mirror — the plan the add-to-cart will use.
      expect(
        attributeValue(
          tagsWithAttribute(html, "data-cellexia-selling-plan")[0],
          "value",
        ),
      ).toBe(String(FIXTURE.planIds.weeks8));
    });

    it("keeps the reassurance line PROMINENT — present and never hidden", async () => {
      const html = await render(options);
      const tag = reassuranceTag(html);
      expect(tag, "reassurance <p> must render").not.toBeNull();
      expect(tag as string).not.toMatch(/(?:^|\s)hidden(?=[\s>=]|$)/);
      expect(visibleText(html)).toContain("Skip, pause or cancel anytime.");
      // …inside the subscription card, where the objection is killed.
      expect(html.indexOf('class="cx-buybox__reassurance"')).toBeGreaterThan(
        html.indexOf("cx-buybox__submax-card"),
      );
    });

    it("standing guards: money attrs + JSON island keep their contracts", async () => {
      const html = await render(options);
      const root = rootTag(html) as string;
      expect(decodeEntitiesOnce(attributeValue(root, "data-cellexia-money-onetime") ?? "")).toBe(
        ONE_TIME_PRICE,
      );
      expect(decodeEntitiesOnce(attributeValue(root, "data-cellexia-money-sub") ?? "")).toBe(
        SUB_FIRST_PRICE,
      );

      const island = parseJsonIsland(html);
      const small = island.variants[String(FIXTURE.variantIds.small)];
      expect(small.oneTime).toBe(ONE_TIME_PRICE);
      expect(small.plans[String(FIXTURE.planIds.weeks8)].first).toBe(
        SUB_FIRST_PRICE,
      );
    });
  });
});

// ── Explicit config overrides re-enable each quiet default ───────────────────

describe("subscription_max · config overrides beat the quiet defaults", () => {
  it("layout.showBadge=true brings the badge back", async () => {
    const html = await renderWidget({
      config: submaxConfig({ showBadge: true }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(html).toContain("cx-buybox__badge");
    expect(visibleText(html)).toContain("Most popular");
    // Only the badge came back.
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
    expect(html).not.toContain('<h3 class="cx-buybox__heading">');
  });

  it("layout.showFrequency=true brings the frequency selector back", async () => {
    const html = await renderWidget({
      config: submaxConfig({ showFrequency: true }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    const selects = tagsWithAttribute(html, "data-cellexia-freq");
    expect(selects).toHaveLength(1);
    expect(selects[0].startsWith("<select")).toBe(true);
    expect((html.match(/<option value="\d+"[^>]*>/g) ?? []).length).toBe(3);
    // Only the selector came back.
    expect(html).not.toContain("cx-buybox__badge");
    expect(html).not.toContain('<h3 class="cx-buybox__heading">');
  });

  it("a config text heading brings the heading back", async () => {
    const html = await renderWidget({
      config: submaxConfig({}, { en: { heading: "The Cellexia ritual" } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(html).toContain('<h3 class="cx-buybox__heading">');
    expect(visibleText(html)).toContain("The Cellexia ritual");
    // Only the heading came back.
    expect(html).not.toContain("cx-buybox__badge");
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
  });

  it("a config oneTimeLinkLabel still has to carry the price to show it", async () => {
    // The override wins verbatim — with {amount} present the price stays in
    // the link. (The compliance guard tested above covers the DEFAULT copy;
    // a merchant editing the label owns their own compliance, but the
    // template machinery must never strip the amount.)
    const html = await renderWidget({
      config: submaxConfig({}, {
        en: { oneTimeLinkLabel: "prefer a single delivery? {amount}" },
      }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(quietLink(html).text).toBe(
      `prefer a single delivery? ${ONE_TIME_PRICE}`,
    );
  });

  it("a Liquid-level default config (no layout knobs at all) is quiet too", async () => {
    // A hand-shaped metafield carrying only the preset: cx_use_cfg is true
    // but there is no layout block, so the PRESET defaults (badge off,
    // selector off) must hold on their own.
    const html = await renderWidget({
      config: { preset: "subscription_max" },
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(resolvedPreset(html)).toBe("subscription_max");
    expect(html).not.toContain("cx-buybox__badge");
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
    expect(html).not.toContain('<h3 class="cx-buybox__heading">');
    expect(quietLink(html).text).toBe(`or buy once for ${ONE_TIME_PRICE}`);
  });
});

// ── Compliance guardrails that go beyond the link text ───────────────────────

describe("subscription_max · compliance guardrails", () => {
  it("never renders for a product that carries only a foreign group", async () => {
    // The ownership allow-list is preset-independent: quiet or not, nothing
    // of ours on the product means NOTHING rendered.
    const html = await renderWidget({
      config: submaxConfig(),
      foreignGroupOnly: true,
      launchStatus: "live",
    });
    expect(html).not.toContain("data-cellexia-buybox");
    expect(html).not.toContain("cx-buybox__submax");
    expect(html).not.toContain(String(FIXTURE.foreignPlanIds.monthly));
    expect(visibleText(html)).toBe("");
  });

  it("drops the quiet link ONLY when the product is genuinely subscription-only", async () => {
    const html = await renderWidget({
      config: submaxConfig(),
      requiresSellingPlan: true,
      launchStatus: "live",
    });
    expectStandingGuards(html);
    // No one-time option exists on the platform, so none is claimed…
    expect(html).not.toContain('data-cellexia-option="one_time"');
    expect(html).not.toContain("cx-buybox__submax-onetime");
    expect(parseJsonIsland(html).requiresSellingPlan).toBe(true);
    // …and the subscription card still stands.
    expect(html).toContain('data-cellexia-option="subscription"');
  });

  it("the quiet posture is CSS, not concealment (buy-box.css contract)", () => {
    const css = readAsset("buy-box.css");
    // The link is styled quiet — muted, small, underlined — never display:none.
    const linkRule = /\.cx-buybox\s+\.cx-buybox__submax-link\s*\{([^}]*)\}/.exec(
      css,
    );
    expect(linkRule).not.toBeNull();
    const body = (linkRule as RegExpExecArray)[1];
    expect(body).toContain("text-decoration: underline");
    expect(body).not.toContain("display: none");
    expect(body).not.toContain("visibility: hidden");
    // The selected-state swap the JS relies on exists in the stylesheet.
    expect(css).toContain(".cx-buybox__submax-picked");
    expect(css).toContain(".cx-buybox__submax-switchback");
    expect(css).toContain(".cx-buybox__submax-onetime.is-selected");
  });
});

// ── Per-market preset resolution (config.markets) ────────────────────────────

describe("per-market preset resolution", () => {
  /** classic everywhere, subscription_max for the Switzerland market. */
  const marketedConfig = (): Record<string, unknown> =>
    publishedConfig("classic", {}, {}, { ch: { preset: "subscription_max" } });

  it('resolves markets["ch"] on marketHandle "ch" — block and embed', async () => {
    for (const { render } of PATHS) {
      const html = await render({
        config: marketedConfig(),
        marketHandle: "ch",
        launchStatus: "live",
      });
      expectStandingGuards(html);
      expect(resolvedPreset(html)).toBe("subscription_max");
      expect(rootTag(html)).toContain("cx-buybox--subscription_max");
      // The resolved preset is the real thing, not just an attribute: the
      // quiet one-time link renders with its price.
      expect(quietLink(html).text).toBe(`or buy once for ${ONE_TIME_PRICE}`);
    }
  });

  it("falls back to the base preset for a market with no entry", async () => {
    const html = await renderWidget({
      config: marketedConfig(),
      marketHandle: "fr",
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("classic");
    expect(html).not.toContain("cx-buybox__submax");
  });

  it("is nil-safe: no localization drop at all → the base preset", async () => {
    // marketHandle unset = the harness omits `localization` entirely (older
    // stores, and every context this suite built before v1.6.0).
    const html = await renderWidget({
      config: marketedConfig(),
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("classic");
  });

  it("treats a blank market handle as no market", async () => {
    const html = await renderWidget({
      config: marketedConfig(),
      marketHandle: "",
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("classic");
  });

  it("matches handles EXACTLY — no prefix, suffix or whitespace match", async () => {
    for (const nearMiss of ["c", "ch2", "cha", " ch", "ch ", "CH"]) {
      const html = await renderWidget({
        config: marketedConfig(),
        marketHandle: nearMiss,
        launchStatus: "live",
      });
      expect(resolvedPreset(html), JSON.stringify(nearMiss)).toBe("classic");
    }
    // …and the exact handle still resolves, so the loop is not vacuous.
    const exact = await renderWidget({
      config: marketedConfig(),
      marketHandle: "ch",
      launchStatus: "live",
    });
    expect(resolvedPreset(exact)).toBe("subscription_max");
  });

  it("an unknown preset in a market entry falls back to the BASE preset", async () => {
    // The schema rejects this value, so it can only reach the storefront in
    // a hand-edited metafield — never a half-applied render for it.
    const config = marketedConfig();
    (config.markets as Record<string, unknown>).ch = { preset: "mega_stack" };
    const html = await renderWidget({
      config,
      marketHandle: "ch",
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("classic");
    expect(html).not.toContain("mega_stack");
  });

  it("resolves any known preset, not only subscription_max", async () => {
    const html = await renderWidget({
      config: publishedConfig("classic", {}, {}, { de: { preset: "planner" } }),
      marketHandle: "de",
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("planner");
  });

  it("the design_source forced preset beats the market resolution", async () => {
    const html = await renderWidget({
      config: marketedConfig(),
      marketHandle: "ch",
      blockSettings: { design_source: "planner" },
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("planner");
    expect(html).not.toContain("cx-buybox__submax");
  });

  it("everything but the preset inherits the BASE config in a market", async () => {
    // The base classic config has the badge and the frequency selector ON
    // (DEFAULT_DESIGN_CONFIG); a market that swaps the preset to
    // subscription_max inherits those explicit layout values — the quiet
    // preset DEFAULTS apply only where the config does not speak.
    const html = await renderWidget({
      config: marketedConfig(),
      marketHandle: "ch",
      launchStatus: "live",
    });
    expect(resolvedPreset(html)).toBe("subscription_max");
    expect(html).toContain("cx-buybox__badge");
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(1);
    // A base text override travels into the market's preset too.
    const withText = await renderWidget({
      config: publishedConfig(
        "classic",
        {},
        { en: { reassurance: "Pause whenever you like" } },
        { ch: { preset: "subscription_max" } },
      ),
      marketHandle: "ch",
      launchStatus: "live",
    });
    expect(visibleText(withText)).toContain("Pause whenever you like");
  });

  it("marketing the SAME preset everywhere changes nothing (attribute carries the resolved preset)", async () => {
    // data-cellexia-preset is what analytics attribution and buy-box.js read:
    // it must always carry the RESOLVED preset, whichever path resolved it.
    const base = await renderWidget({
      config: marketedConfig(),
      marketHandle: "ch",
      launchStatus: "live",
    });
    const attributed = /data-cellexia-preset="([^"]+)"/.exec(base);
    expect(attributed?.[1]).toBe("subscription_max");
  });

  it("still gates a market-resolved preset until launch", async () => {
    const html = await renderWidget({
      config: marketedConfig(),
      marketHandle: "ch",
      launchStatus: "setup",
    });
    expect(resolvedPreset(html)).toBe("subscription_max");
    expectGate(html, false);
  });
});
