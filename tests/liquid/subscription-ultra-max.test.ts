import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";
import type { WidgetDesignConfig } from "~/lib/widget/presets";

import {
  FIXTURE,
  attributeValue,
  countOccurrences,
  decodeEntitiesOnce,
  elementTexts,
  parseJsonIsland,
  renderEmbed,
  renderWidget,
  rootTag,
  tagsWithAttribute,
  visibleText,
} from "./harness";
import type { MakeContextOptions } from "./harness";

/**
 * GOLDEN TESTS for the subscription_ultra_max preset (v1.11.0) — the Liquid
 * render contract. (The JS satellite RELOCATION behavior lives in the DOM
 * suite; this file pins what the storefront markup promises to buy-box.js.)
 *
 * THE DESIGN CONTRACT UNDER TEST
 * ------------------------------
 * subscription_ultra_max renders the subscription as the PLAIN, NORMAL way
 * of buying: quieter than subscription_max — badge, frequency selector,
 * savings AND reassurance are all OFF by default (each re-enabled only by an
 * explicit `true` in config.layout), the heading defaults to empty, and the
 * subscription is preselected unless config.behavior.preselect === 'one_time'.
 *
 * Two disclosures are NOT negotiable, quiet or not:
 *   - the recurring "then … every …" sentence stays visible (recurrence
 *     disclosure is not a layout knob);
 *   - the one-time option stays a REAL radio whose link text carries the
 *     one-time price BEFORE any interaction ("or buy once for CHF 64.00").
 *
 * THE SATELLITE
 * -------------
 * The one-time wrap doubles as the satellite buy-box.js relocates below the
 * theme's buy area: it must carry BOTH the class `cx-buybox-satellite` and
 * the attributes `data-cellexia-satellite` + `data-cellexia-for="<uid>"`,
 * while remaining the same submax one-time wrap (radio in the shared group,
 * picked state, switch-back label) so the existing state machine keeps
 * working after the move. requires_selling_plan drops the wrap entirely —
 * there must never be a satellite with nothing to sell.
 */

// ── Config fixtures ──────────────────────────────────────────────────────────

interface UltramaxOverrides {
  layout?: Partial<WidgetDesignConfig["layout"]>;
  text?: WidgetDesignConfig["text"];
  behavior?: Partial<WidgetDesignConfig["behavior"]>;
}

/**
 * subscription_ultra_max the way the designer publishes it: the preset's
 * PRESET_LAYOUT_PATCH writes all four quiet knobs `false` into the layout
 * (DEFAULT_DESIGN_CONFIG has them all `true`, and for THIS preset an explicit
 * `true` re-enables — so the published quiet state must say `false`).
 * Validated through the real zod schema, then JSON round-tripped like the
 * shop metafield.
 */
function ultramaxConfig(overrides: UltramaxOverrides = {}): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset: "subscription_ultra_max",
    layout: {
      ...DEFAULT_DESIGN_CONFIG.layout,
      showBadge: false,
      showFrequency: false,
      showSavings: false,
      showReassurance: false,
      ...(overrides.layout ?? {}),
    },
    behavior: {
      ...DEFAULT_DESIGN_CONFIG.behavior,
      ...(overrides.behavior ?? {}),
    },
    text: overrides.text ?? {},
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

const ONE_TIME_PRICE = "CHF 64.00";
const SUB_FIRST_PRICE = "CHF 51.20";

// ── Markup extraction helpers ────────────────────────────────────────────────

function resolvedPreset(html: string): string | null {
  const root = rootTag(html);
  return root ? attributeValue(root, "data-cellexia-preset") : null;
}

/** The satellite/one-time wrap's OPENING tag, or null when not rendered. */
function satelliteTag(html: string): string | null {
  return tagsWithAttribute(html, "data-cellexia-satellite")[0] ?? null;
}

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

function radioByValue(html: string, value: string): string {
  const radios = tagsWithAttribute(html, "data-cellexia-option").filter(
    (tag) => attributeValue(tag, "data-cellexia-option") === value,
  );
  expect(radios, `exactly one ${value} radio`).toHaveLength(1);
  return radios[0];
}

/** All four quiet defaults hold at once and the heading stays empty. */
function expectQuiet(html: string): void {
  expect(html).not.toContain("cx-buybox__badge");
  expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
  expect(tagsWithAttribute(html, "data-cellexia-freq-chip")).toHaveLength(0);
  expect(tagsWithAttribute(html, "data-cellexia-save")).toHaveLength(0);
  expect(html).not.toContain("cx-buybox__reassurance");
  expect(visibleText(html)).not.toContain("Skip, pause or cancel anytime.");
  expect(html).not.toContain('<h3 class="cx-buybox__heading">');
  expect(visibleText(html)).not.toContain("Choose your ritual");
}

/** The guards every render in this file must satisfy (see render.test.ts). */
function expectStandingGuards(html: string): void {
  expect(html).toContain("<!-- BEGIN app snippet: cx-buybox-core -->");
  expect(html).not.toContain("&lt;!--");
  const text = visibleText(html);
  expect(text).not.toContain("app snippet");
  expect(html).not.toContain("&amp;amp;");
  expect(text).not.toContain("&amp;");
  for (const placeholder of ["{percent}", "{amount}", "{frequency}", "{price}"]) {
    expect(text).not.toContain(placeholder);
  }
  expect(text).not.toContain("translation missing");
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

// ── The matrix: block + embed, live + gated ──────────────────────────────────

const PATHS = [
  { name: "app block", render: renderWidget },
  { name: "app embed", render: renderEmbed },
] as const;

describe.each(PATHS)("subscription_ultra_max · $name", ({ render }) => {
  describe.each(["live", "setup"] as const)("launch_status %s", (launchStatus) => {
    const options: MakeContextOptions = {
      config: ultramaxConfig(),
      launchStatus,
    };

    it("renders ONE ultra-quiet subscription card as the buy box", async () => {
      const html = await render(options);
      expectStandingGuards(html);
      expectGate(html, launchStatus === "live");

      expect(countOccurrences(html, "data-cellexia-buybox")).toBe(1);
      expect(resolvedPreset(html)).toBe("subscription_ultra_max");
      expect(rootTag(html)).toContain("cx-buybox--subscription_ultra_max");
      // The card reuses the submax machinery and adds its own hook class.
      expect(html).toContain("cx-buybox__submax-card");
      expect(html).toContain("cx-buybox__ultramax-card");
      expect(html).toContain('data-cellexia-option-wrap="subscription"');
      expect(html).toContain("data-cellexia-sub-price");
      expect(visibleText(html)).toContain(SUB_FIRST_PRICE);
    });

    it("quiet defaults: badge, frequency, savings, reassurance AND heading all off", async () => {
      const html = await render(options);
      expectQuiet(html);
      // The selector being off still means a REAL default cadence in the
      // hidden mirror — the plan the add-to-cart will use.
      expect(
        attributeValue(
          tagsWithAttribute(html, "data-cellexia-selling-plan")[0],
          "value",
        ),
      ).toBe(String(FIXTURE.planIds.weeks8));
    });

    it("DISCLOSURE: the recurring then-line survives the quiet treatment", async () => {
      const html = await render(options);
      const then = tagsWithAttribute(html, "data-cellexia-then");
      expect(then.length).toBeGreaterThan(0);
      // Never hidden while a recurring sentence exists — quiet is presentation,
      // recurrence disclosure is not optional.
      expect(then[0]).not.toMatch(/(?:^|\s)hidden(?=[\s>=]|$)/);
      expect(visibleText(html)).toContain("then CHF 57.60 every 8 weeks");
    });

    it("SATELLITE: the one-time wrap carries the class AND both handshake attributes", async () => {
      const html = await render(options);
      const tag = satelliteTag(html);
      expect(tag, "satellite one-time wrap").not.toBeNull();
      const wrap = tag as string;
      // buy-box.js finds it by '.cx-buybox-satellite[data-cellexia-satellite]'
      // and pairs it back to its widget via data-cellexia-for — all three
      // tokens must sit on the SAME element, which is still the submax
      // one-time wrap the state machine already knows.
      expect(wrap).toContain("cx-buybox-satellite");
      expect(wrap).toContain("cx-buybox__submax-onetime");
      expect(attributeValue(wrap, "data-cellexia-for")).toBe("cx-block-1");
      expect(attributeValue(wrap, "data-cellexia-option-wrap")).toBe("one_time");
      // Rendered exactly once, inside this widget's markup.
      expect(tagsWithAttribute(html, "data-cellexia-satellite")).toHaveLength(1);

      // The wrap holds the REAL one-time radio in the shared group…
      const oneTime = radioByValue(html, "one_time");
      expect(attributeValue(oneTime, "type")).toBe("radio");
      expect(attributeValue(oneTime, "name")).toBe("cx-purchase-cx-block-1");
      expect(attributeValue(oneTime, "value")).toBe("one_time");
      expect(html.indexOf(oneTime)).toBeGreaterThan(html.indexOf(wrap));

      // …the picked state and switch-back the CSS swaps in on selection…
      expect(html).toContain("cx-buybox__submax-picked");
      expect(elementTexts(html, "data-cellexia-onetime-price")).toContain(
        ONE_TIME_PRICE,
      );
      expect(html).toContain("cx-buybox__submax-switchback");
      expect(visibleText(html)).toContain("Switch back to Subscribe & Save");

      // …and it sits BELOW the card in the source order.
      expect(html.indexOf("cx-buybox__submax-onetime")).toBeGreaterThan(
        html.indexOf("cx-buybox__submax-card"),
      );
    });

    it("COMPLIANCE: the quiet link shows the one-time price BEFORE selection", async () => {
      const html = await render(options);
      const link = quietLink(html);
      expect(link.text).toBe(`or buy once for ${ONE_TIME_PRICE}`);
      expect(link.text).not.toContain(SUB_FIRST_PRICE);
      // Quiet, never hidden.
      expect(link.tag).not.toMatch(/(?:^|\s)hidden(?=[\s>=]|$)/);
      // The RAW template travels to buy-box.js so variant changes keep the
      // price in the link current after the satellite moves.
      expect(decodeEntitiesOnce(attributeValue(link.tag, "data-cellexia-tpl") ?? "")).toBe(
        "or buy once for {amount}",
      );
    });

    it("preselects the subscription (bare config, preselect 'inherit')", async () => {
      const html = await render(options);
      expect(radioByValue(html, "subscription")).toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
      expect(radioByValue(html, "one_time")).not.toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
      expect(parseJsonIsland(html).preselect).toBe(true);
    });

    it("standing guards: money attrs keep their contracts", async () => {
      const html = await render(options);
      const root = rootTag(html) as string;
      expect(
        decodeEntitiesOnce(attributeValue(root, "data-cellexia-money-onetime") ?? ""),
      ).toBe(ONE_TIME_PRICE);
      expect(
        decodeEntitiesOnce(attributeValue(root, "data-cellexia-money-sub") ?? ""),
      ).toBe(SUB_FIRST_PRICE);
      const island = parseJsonIsland(html);
      expect(island.variants[String(FIXTURE.variantIds.small)].oneTime).toBe(
        ONE_TIME_PRICE,
      );
    });
  });
});

// ── Config overrides: explicit true re-enables each quiet knob ───────────────

describe("subscription_ultra_max · explicit layout true re-enables each knob", () => {
  it("layout.showBadge=true brings ONLY the badge back", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ layout: { showBadge: true } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(html).toContain("cx-buybox__badge");
    expect(visibleText(html)).toContain("Most popular");
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
    expect(tagsWithAttribute(html, "data-cellexia-save")).toHaveLength(0);
    expect(html).not.toContain("cx-buybox__reassurance");
  });

  it("layout.showFrequency=true brings ONLY the frequency selector back", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ layout: { showFrequency: true } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    const selects = tagsWithAttribute(html, "data-cellexia-freq");
    expect(selects).toHaveLength(1);
    expect(selects[0].startsWith("<select")).toBe(true);
    expect(html).not.toContain("cx-buybox__badge");
    expect(html).not.toContain("cx-buybox__reassurance");
  });

  it("layout.showSavings=true brings ONLY the savings node back, with real text", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ layout: { showSavings: true } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    const saveNodes = tagsWithAttribute(html, "data-cellexia-save");
    expect(saveNodes).toHaveLength(1);
    expect(saveNodes[0]).not.toMatch(/(?:^|\s)hidden(?=[\s>=]|$)/);
    expect(elementTexts(html, "data-cellexia-save")).toContain("Save 20%");
    expect(html).not.toContain("cx-buybox__badge");
    expect(html).not.toContain("cx-buybox__reassurance");
  });

  it("layout.showReassurance=true brings ONLY the reassurance line back", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ layout: { showReassurance: true } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(html).toContain("cx-buybox__reassurance");
    expect(visibleText(html)).toContain("Skip, pause or cancel anytime.");
    expect(html).not.toContain("cx-buybox__badge");
    expect(tagsWithAttribute(html, "data-cellexia-save")).toHaveLength(0);
  });

  it("a config text heading beats the empty-heading default", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ text: { en: { heading: "The Cellexia ritual" } } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(html).toContain('<h3 class="cx-buybox__heading">');
    expect(visibleText(html)).toContain("The Cellexia ritual");
  });

  it("behavior.preselect='one_time' flips the checked radio (the ONLY override that can)", async () => {
    const html = await renderWidget({
      config: ultramaxConfig({ behavior: { preselect: "one_time" } }),
      launchStatus: "live",
    });
    expectStandingGuards(html);
    expect(radioByValue(html, "one_time")).toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
    expect(radioByValue(html, "subscription")).not.toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
    // The selected state travels: satellite wrap marked, island agrees.
    expect(satelliteTag(html) as string).toContain("is-selected");
    expect(parseJsonIsland(html).preselect).toBe(false);
  });
});

// ── Pure-Liquid defaults: no config at all, forced via design_source ─────────

describe("subscription_ultra_max · pure-Liquid defaults (design_source, config null)", () => {
  it("the theme-editor forced preset is quiet with NO config metafield", async () => {
    // No published config → cx_use_cfg is false → nothing can re-enable the
    // quiet knobs, and the block-setting heading/badge/preselect defaults
    // (heading "Choose your ritual", show_badge true, …) must all LOSE to
    // the preset's own quiet posture.
    const html = await renderWidget({
      config: null,
      launchStatus: "live",
      blockSettings: { design_source: "subscription_ultra_max" },
    });
    expectStandingGuards(html);
    expect(resolvedPreset(html)).toBe("subscription_ultra_max");
    expectQuiet(html);
    // The two disclosures still stand without any config.
    expect(quietLink(html).text).toBe(`or buy once for ${ONE_TIME_PRICE}`);
    expect(visibleText(html)).toContain("then CHF 57.60 every 8 weeks");
    expect(satelliteTag(html)).not.toBeNull();
  });

  it("preselects the subscription even against the block-setting toggle", async () => {
    // Only config.behavior.preselect === 'one_time' may flip it; the theme
    // editor checkbox is a pre-ultra_max knob and must not.
    const html = await renderWidget({
      config: null,
      launchStatus: "live",
      blockSettings: {
        design_source: "subscription_ultra_max",
        preselect_subscription: false,
      },
    });
    expect(radioByValue(html, "subscription")).toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
    expect(radioByValue(html, "one_time")).not.toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
  });
});

// ── Subscription-only products drop the satellite entirely ───────────────────

describe("subscription_ultra_max · requires_selling_plan", () => {
  it("drops the satellite/one-time wrap — never a satellite with nothing to sell", async () => {
    for (const { render } of PATHS) {
      const html = await render({
        config: ultramaxConfig(),
        requiresSellingPlan: true,
        launchStatus: "live",
      });
      expectStandingGuards(html);
      expect(tagsWithAttribute(html, "data-cellexia-satellite")).toHaveLength(0);
      expect(html).not.toContain("cx-buybox-satellite");
      expect(html).not.toContain("cx-buybox__submax-onetime");
      expect(html).not.toContain('data-cellexia-option="one_time"');
      expect(parseJsonIsland(html).requiresSellingPlan).toBe(true);
      // The subscription card still stands, checked, with its disclosure.
      expect(radioByValue(html, "subscription")).toMatch(/(?:^|\s)checked(?=[\s>]|$)/);
      expect(visibleText(html)).toContain("then CHF 57.60 every 8 weeks");
    }
  });
});
