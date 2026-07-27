import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  PRESET_KEYS,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";
import type { PresetKey, WidgetDesignConfig } from "~/lib/widget/presets";

import {
  FIXTURE,
  attributeValue,
  decodeEntitiesOnce,
  parseJsonIsland,
  readAsset,
  renderEmbed,
  renderWidget,
  rootTag,
} from "./harness";

/**
 * THEME ADD-TO-CART PRICE SYNC (v1.2.2).
 *
 * The defect this covers was observed live on cellexialabs.com: with the
 * SUBSCRIPTION option preselected (CHF 51.20 first order) the theme's own
 * button still read "ADD TO CART - CHF 64.00" — the shopper saw one price in
 * the widget and another on the button they were about to click.
 *
 * The fix is a money-STRING swap performed by assets/buy-box.js, so the only
 * thing the Liquid owes it is the two strings, formatted by the SAME money
 * filter the theme used:
 *
 *   data-cellexia-money-onetime   the one-time price of the current variant
 *   data-cellexia-money-sub       the FIRST-ORDER subscription price of the
 *                           current plan ("" when the variant has no
 *                           allocation — nothing to promise, nothing to swap)
 *   data-cellexia-price-sync      the themeSync.syncAddToCartPrice flag
 *   data-cellexia-price-selector  themeSync.priceSelector ("" = built-in list)
 *
 * …plus the JSON island keys the JS re-syncs from on variant/plan change,
 * which are deliberately the SAME strings ("oneTime" per variant, "first"
 * per variant x plan) rather than a second copy that could drift.
 *
 * Everything here renders the real extension Liquid through tests/liquid/
 * harness.ts (Shopify theme-app-extension semantics, real money formatting).
 */

// ── Config fixtures ──────────────────────────────────────────────────────────

type ThemeSyncOverrides = Partial<WidgetDesignConfig["themeSync"]>;

/** A publishable config (validated through the real zod schema, JSON round-tripped). */
function configWith(
  preset: PresetKey = "classic",
  themeSync: ThemeSyncOverrides = {},
): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset,
    themeSync: { ...DEFAULT_DESIGN_CONFIG.themeSync, ...themeSync },
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/**
 * A config exactly as v1.1.0 stored it — no themeSync key, no placement, no
 * layout.showFrequency. Published `WidgetDesignRevision` rows and the live
 * `cellexia.buybox_design` metafield in the wild predate all three, and the
 * Liquid reads the metafield JSON directly (no zod in between), so both
 * layers have to tolerate the missing key.
 */
function v110ShapedConfig(): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(DEFAULT_DESIGN_CONFIG)) as Record<
    string,
    unknown
  > & { layout: Record<string, unknown> };
  delete config.themeSync;
  delete config.placement;
  delete config.layout.showFrequency;
  return config;
}

/** One of the widget root's attributes, still HTML-escaped. */
function rootAttr(html: string, name: string): string | null {
  return attributeValue(rootTag(html) as string, name);
}

/** What buy-box.js gets from getAttribute: the browser decodes entities once. */
function rootAttrDecoded(html: string, name: string): string {
  return decodeEntitiesOnce(rootAttr(html, name) ?? "");
}

const SMALL = String(FIXTURE.variantIds.small);
const PLAN_8_WEEKS = String(FIXTURE.planIds.weeks8);

// ── The money strings ────────────────────────────────────────────────────────

describe("widget root money strings", () => {
  for (const preset of PRESET_KEYS) {
    it(`[${preset}] carries both money strings, formatted by the shop's money_format`, async () => {
      const html = await renderWidget({
        config: configWith(preset),
        launchStatus: "live",
      });

      const oneTime = rootAttrDecoded(html, "data-cellexia-money-onetime");
      const sub = rootAttrDecoded(html, "data-cellexia-money-sub");

      // The fixture shop sells in CHF and formats as "CHF 64.00" — exactly
      // the string cellexialabs.com's button prints.
      expect(oneTime).toBe("CHF 64.00");
      expect(sub).toBe("CHF 51.20");
      for (const value of [oneTime, sub]) {
        expect(value).toMatch(/^CHF \d+\.\d{2}$/);
      }
    });
  }

  it("the two strings DIFFER whenever there is a subscription discount", async () => {
    for (const preset of PRESET_KEYS) {
      const html = await renderWidget({
        config: configWith(preset),
        launchStatus: "live",
        hasSavings: true,
      });
      const oneTime = rootAttrDecoded(html, "data-cellexia-money-onetime");
      const sub = rootAttrDecoded(html, "data-cellexia-money-sub");
      expect(sub, preset).not.toBe(oneTime);
      // 20% off the first order — the swap is worth doing.
      expect(sub, preset).toBe("CHF 51.20");
    }
  });

  it("they are IDENTICAL with no discount, so the JS has nothing to swap", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
      hasSavings: false,
    });
    expect(rootAttrDecoded(html, "data-cellexia-money-sub")).toBe(
      rootAttrDecoded(html, "data-cellexia-money-onetime"),
    );
  });

  it("prices the LARGE variant when the page is deep-linked to it", async () => {
    // Guards the "same money filter, same variant" contract: the attributes
    // must follow the variant the server rendered, not the first one.
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
    });
    const island = parseJsonIsland(html);
    // The block opens on `selected_or_first_available_variant` (the small
    // one); the island holds the large one's strings for the JS to swap in.
    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe(
      island.variants[SMALL].oneTime,
    );
    expect(island.variants[String(FIXTURE.variantIds.large)].oneTime).toBe(
      "CHF 98.00",
    );
  });

  it("states NO subscription price for a variant with no allocation", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
      selectedVariantHasNoAllocations: true,
    });
    // There is no subscription to sell for this variant, so there is no
    // price to put on the theme's button — and buy-box.js does nothing.
    expect(rootAttr(html, "data-cellexia-money-sub")).toBe("");
    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe("CHF 64.00");
  });

  it("is present while the widget is launch-gated (the preview flow needs it)", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "setup",
    });
    const root = rootTag(html) as string;
    expect(root).toContain('data-cellexia-gated="true"');
    // The markup is complete in setup mode; only buy-box.js's hidden-widget
    // gate keeps it from touching the theme until a validated preview token
    // reveals the widget — at which point resync() runs the sync for real.
    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe("CHF 64.00");
    expect(rootAttrDecoded(html, "data-cellexia-money-sub")).toBe("CHF 51.20");
  });

  it("is identical in the app embed (the install shape on cellexialabs.com)", async () => {
    const [section, embed] = await Promise.all([
      renderWidget({ config: configWith("classic"), launchStatus: "live" }),
      renderEmbed({ config: configWith("classic"), launchStatus: "live" }),
    ]);
    for (const name of ["data-cellexia-money-onetime", "data-cellexia-money-sub"]) {
      expect(rootAttrDecoded(embed, name)).toBe(rootAttrDecoded(section, name));
    }
  });

  it("zero-config shops get the sync too (no metafield at all)", async () => {
    const html = await renderWidget({ config: null, launchStatus: "live" });
    expect(rootAttr(html, "data-cellexia-price-sync")).toBe("true");
    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe("CHF 64.00");
    expect(rootAttrDecoded(html, "data-cellexia-money-sub")).toBe("CHF 51.20");
  });
});

// ── The island is the same pair, for every later variant/plan change ─────────

describe("JSON island ⇄ root attribute agreement", () => {
  it("the root strings are the island's initial variant × initial plan", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
    });
    const island = parseJsonIsland(html);
    const variant = island.variants[island.initialVariant];

    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe(
      variant.oneTime,
    );
    expect(rootAttrDecoded(html, "data-cellexia-money-sub")).toBe(
      variant.plans[island.initialPlan].first,
    );
  });

  it("every variant × plan pair the JS can switch to is priced", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
    });
    const island = parseJsonIsland(html);
    for (const variant of Object.values(island.variants)) {
      expect(variant.oneTime).toMatch(/^CHF \d+\.\d{2}$/);
      for (const plan of Object.values(variant.plans)) {
        expect(plan.first).toMatch(/^CHF \d+\.\d{2}$/);
        // A swap is only ever worth doing when the two differ…
        expect(plan.first).not.toBe(variant.oneTime);
      }
    }
    expect(island.variants[SMALL].plans[PLAN_8_WEEKS].first).toBe("CHF 51.20");
  });
});

// ── themeSync config → markup ────────────────────────────────────────────────

describe("themeSync config", () => {
  it("defaults to ON and to the built-in selector list", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
    });
    expect(rootAttr(html, "data-cellexia-price-sync")).toBe("true");
    expect(rootAttr(html, "data-cellexia-price-selector")).toBe("");
  });

  it("syncAddToCartPrice:false switches the module off in the markup", async () => {
    const html = await renderWidget({
      config: configWith("classic", { syncAddToCartPrice: false }),
      launchStatus: "live",
    });
    expect(rootAttr(html, "data-cellexia-price-sync")).toBe("false");
    // The money strings stay — they are honest data either way; the flag is
    // what buy-box.js reads before it touches anything.
    expect(rootAttrDecoded(html, "data-cellexia-money-onetime")).toBe("CHF 64.00");
  });

  it("carries a merchant priceSelector verbatim", async () => {
    const html = await renderWidget({
      config: configWith("classic", {
        priceSelector: ".pdp__actions .btn--atc",
      }),
      launchStatus: "live",
    });
    expect(rootAttrDecoded(html, "data-cellexia-price-selector")).toBe(
      ".pdp__actions .btn--atc",
    );
  });

  it("a v1.1.0-shaped config (no themeSync key) still renders the sync ON", async () => {
    const config = v110ShapedConfig();
    expect(config.themeSync).toBeUndefined();

    // 1. the schema: a stored revision without the key keeps validating…
    const parsed = widgetDesignConfigSchema.parse(config);
    expect(parsed.themeSync).toEqual({
      syncAddToCartPrice: true,
      priceSelector: "",
    });

    // 2. …and the Liquid, which reads the raw metafield JSON with no zod in
    // between, defaults the missing key the same way.
    const html = await renderWidget({ config, launchStatus: "live" });
    expect(rootAttr(html, "data-cellexia-price-sync")).toBe("true");
    expect(rootAttr(html, "data-cellexia-price-selector")).toBe("");
    expect(rootAttrDecoded(html, "data-cellexia-money-sub")).toBe("CHF 51.20");
  });

  it("neutralizes a HAND-EDITED metafield selector (the Liquid belt)", async () => {
    // sanitizePlacementSelector already strips these on publish; the metafield
    // can still be edited by hand in the Shopify admin, and this value is
    // printed into an attribute and handed to querySelectorAll.
    const config = configWith("classic");
    (config as { themeSync: Record<string, unknown> }).themeSync = {
      syncAddToCartPrice: true,
      priceSelector: '.a"><script>alert(1)</script>',
    };
    const html = await renderWidget({ config, launchStatus: "live" });

    const raw = rootAttr(html, "data-cellexia-price-selector") ?? "";
    const decoded = decodeEntitiesOnce(raw);
    expect(decoded).not.toMatch(/[<>"'`]/);
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

// ── Money formats that carry HTML entities or quotes ─────────────────────────

describe("hostile money formats", () => {
  it("never double-escapes a money entity into the attributes", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
      moneyFormat: "{{amount}}&nbsp;CHF",
    });
    const raw = rootAttr(html, "data-cellexia-money-onetime") ?? "";
    // The signature of the v1.2.0 bug: the entity's "&" escaped again. The JS
    // would then hunt for a string no button on the page contains.
    expect(raw).not.toContain("&amp;nbsp;");
    // The browser decodes the attribute ONCE — real character, no entity.
    expect(decodeEntitiesOnce(raw)).toBe("64.00 CHF");
  });

  it("keeps the attribute well-formed when money_format contains a quote", async () => {
    const html = await renderWidget({
      config: configWith("classic"),
      launchStatus: "live",
      moneyFormat: '"{{amount}}" CHF',
    });
    const raw = rootAttr(html, "data-cellexia-money-onetime") ?? "";
    // Converted to its entity, so it cannot terminate the attribute…
    expect(raw).toContain("&quot;");
    expect(raw).not.toContain('"');
    // …and decodes back to exactly what the theme printed.
    expect(decodeEntitiesOnce(raw)).toBe('"64.00" CHF');
  });
});

// ── The JS side of the contract ──────────────────────────────────────────────

describe("assets/buy-box.js price-sync module", () => {
  const source = readAsset("buy-box.js");

  it("reads exactly the four attributes the Liquid emits", async () => {
    const html = await renderWidget({
      config: configWith("classic", { priceSelector: ".x" }),
      launchStatus: "live",
    });
    for (const attribute of [
      "data-cellexia-money-onetime",
      "data-cellexia-money-sub",
      "data-cellexia-price-sync",
      "data-cellexia-price-selector",
    ]) {
      expect(source, attribute).toContain(attribute);
      expect(rootAttr(html, attribute), attribute).not.toBeNull();
    }
  });

  it("ships a built-in selector list covering this theme and the common ones", () => {
    for (const selector of [
      ".pdp__actions .btn--atc",
      'button[name="add"]',
      ".product-form__submit",
      "[data-add-to-cart]",
      ".btn--atc",
    ]) {
      expect(source, selector).toContain(selector);
    }
  });

  it("never rewrites markup — text nodes only", () => {
    // The whole safety argument rests on this: we replace a string inside a
    // TEXT node, so no theme markup, listener, framework binding or analytics
    // hook inside the button is ever destroyed. Comments are stripped first —
    // the file talks ABOUT innerHTML in prose.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
    for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML"]) {
      expect(code, banned).not.toContain(banned);
    }
    expect(code).toContain("nodeValue");
  });

  it("re-applies through a MutationObserver and guards against loops", () => {
    expect(source).toContain("MutationObserver");
    expect(source).toContain("characterData");
    expect(source).toContain("PRICE_SYNC_MAX_WRITES");
  });
});
