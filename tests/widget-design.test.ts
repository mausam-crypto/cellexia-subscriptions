import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Buy-box design studio tests (v1.1.0):
 *  - widgetDesignConfigSchema — shape/range/hex validation, all six presets,
 *    locale-keyed text partials, DEFAULT_DESIGN_CONFIG round-trip
 *  - sanitizeCustomCss — banned-token stripping (incl. recomposition), cap
 *  - resolveDesignText / resolveDesignBenefits — locale → base → en →
 *    extension-fallback chain; {percent}/{amount}/{frequency} templates must
 *    survive resolution intact for the client-side substitution layer
 *    (buy-box.js / cx-tpl) to fill
 *  - themeSync (v1.2.2) — the theme add-to-cart price-sync config: safe
 *    defaults for every pre-v1.2.2 revision, and priceSelector sanitization
 *  - PRESET_META — CRO metadata completeness for every preset key
 *  - design attribution — `_cellexia_design` line-property extraction from both
 *    REST property shapes, and the ORDERS_CREATE handler logging
 *    widget.design_attributed
 *
 * The v1.2.0 app-embed additions (layout.showFrequency, placement, selector
 * sanitization, v1.1.0 backward-compat, brand-token defaults) are covered in
 * tests/embed-config.test.ts.
 *
 * The webhook module is DB/Shopify-heavy at import time, so everything
 * server-shaped is mocked (klaviyo-map.test.ts / launch-mode.test.ts pattern);
 * the suite never touches a database.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(
    async (_event: Record<string, unknown>): Promise<void> => {},
  ),
  requireShop: vi.fn(
    async (): Promise<unknown> => ({
      id: "shop_1",
      domain: "cellexia-test.myshopify.com",
    }),
  ),
  sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
  // ORDERS_CREATE replay guard: an existing event for the order's id means a
  // manual redelivery — null (the default) means "first delivery".
  subscriberEventFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  // Acquisition capture: the handler looks up a contract mirror by
  // originOrderId to direct-persist the sanitized bundle. null (the default)
  // means "no mirror yet" — the stash side still logs acquisition.captured
  // and the direct-persist path is a no-op, which is the shape these tests
  // exercise.
  subscriptionContractFindFirst: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    subscriptionContract: { findFirst: mocks.subscriptionContractFindFirst },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

import {
  CUSTOM_CSS_MAX_LENGTH,
  DEFAULT_DESIGN_CONFIG,
  PRESET_KEYS,
  PRESET_META,
  PRICE_SELECTOR_MAX_LENGTH,
  resolveDesignBenefits,
  resolveDesignText,
  sanitizeCustomCss,
  sanitizePlacementSelector,
  widgetDesignConfigSchema,
  type WidgetDesignConfig,
} from "~/lib/widget/presets";
import {
  lineProperty,
  webhookHandlers,
} from "~/lib/webhooks/handlers.server";

/** Deep-cloned DEFAULT_DESIGN_CONFIG with overrides merged shallowly per section. */
function configWith(overrides: {
  preset?: WidgetDesignConfig["preset"];
  layout?: Partial<WidgetDesignConfig["layout"]>;
  style?: Partial<WidgetDesignConfig["style"]>;
  behavior?: Partial<WidgetDesignConfig["behavior"]>;
  text?: WidgetDesignConfig["text"];
}): WidgetDesignConfig {
  const base = structuredClone(DEFAULT_DESIGN_CONFIG);
  return {
    ...base,
    preset: overrides.preset ?? base.preset,
    layout: { ...base.layout, ...overrides.layout },
    style: { ...base.style, ...overrides.style },
    behavior: { ...base.behavior, ...overrides.behavior },
    text: overrides.text ?? base.text,
  };
}

// ── widgetDesignConfigSchema ─────────────────────────────────────────────────

describe("widgetDesignConfigSchema", () => {
  it("DEFAULT_DESIGN_CONFIG parses and round-trips unchanged", () => {
    const parsed = widgetDesignConfigSchema.parse(DEFAULT_DESIGN_CONFIG);
    expect(parsed).toEqual(DEFAULT_DESIGN_CONFIG);
  });

  it("DEFAULT_DESIGN_CONFIG is the v1.0.0 rendering (classic, sub first, dropdown)", () => {
    // The pixel-identical-fallback contract: these knobs ARE v1.0.0.
    expect(DEFAULT_DESIGN_CONFIG.preset).toBe("classic");
    expect(DEFAULT_DESIGN_CONFIG.layout.order).toBe("sub_first");
    expect(DEFAULT_DESIGN_CONFIG.layout.frequencyStyle).toBe("dropdown");
    expect(DEFAULT_DESIGN_CONFIG.style.customCss).toBe("");
    expect(DEFAULT_DESIGN_CONFIG.text).toEqual({});
  });

  for (const preset of PRESET_KEYS) {
    it(`accepts preset "${preset}"`, () => {
      const result = widgetDesignConfigSchema.safeParse(configWith({ preset }));
      expect(result.success, `preset "${preset}" should parse`).toBe(true);
    });
  }

  it("rejects unknown presets", () => {
    for (const preset of ["mega_stack", "CLASSIC", "", "classic "]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ preset: preset as WidgetDesignConfig["preset"] }),
      );
      expect(result.success, `preset "${preset}" should be rejected`).toBe(false);
    }
  });

  it("rejects a wrong version", () => {
    const config = { ...configWith({}), version: 2 };
    expect(widgetDesignConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects bad hex colors on accent", () => {
    for (const accent of ["red", "4a5d4a", "#12345", "#gggggg", "#12", ""]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ style: { accent } }),
      );
      expect(result.success, `accent "${accent}" should be rejected`).toBe(false);
    }
  });

  it("accepts #rgb and #rrggbb hex on accent", () => {
    for (const accent of ["#fff", "#4a5d4a", "#ABCDEF"]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ style: { accent } }),
      );
      expect(result.success, `accent "${accent}" should parse`).toBe(true);
    }
  });

  it('allows "" (inherit) on bgTint/text/badgeBg but not on badgeText', () => {
    expect(
      widgetDesignConfigSchema.safeParse(
        configWith({ style: { bgTint: "", text: "", badgeBg: "" } }),
      ).success,
    ).toBe(true);
    expect(
      widgetDesignConfigSchema.safeParse(configWith({ style: { badgeText: "" } }))
        .success,
    ).toBe(false);
  });

  it("rejects out-of-range fontScale, accepts the boundaries", () => {
    for (const fontScale of [0.84, 1.16, 0, -1, 2]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ style: { fontScale } }),
      );
      expect(result.success, `fontScale ${fontScale} should be rejected`).toBe(
        false,
      );
    }
    for (const fontScale of [0.85, 1, 1.15]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ style: { fontScale } }),
      );
      expect(result.success, `fontScale ${fontScale} should parse`).toBe(true);
    }
  });

  it("rejects out-of-range / non-integer layout numbers", () => {
    const bad: Partial<WidgetDesignConfig["layout"]>[] = [
      { radiusPx: -1 },
      { radiusPx: 25 },
      { radiusPx: 12.5 },
      { borderWidthPx: 0 },
      { borderWidthPx: 4 },
      { benefitCount: -1 },
      { benefitCount: 6 },
    ];
    for (const layout of bad) {
      const result = widgetDesignConfigSchema.safeParse(configWith({ layout }));
      expect(
        result.success,
        `layout ${JSON.stringify(layout)} should be rejected`,
      ).toBe(false);
    }
  });

  it("rejects customCss over the cap", () => {
    const result = widgetDesignConfigSchema.safeParse(
      configWith({ style: { customCss: "a".repeat(CUSTOM_CSS_MAX_LENGTH + 1) } }),
    );
    expect(result.success).toBe(false);
  });

  it("text accepts locale-keyed partial overrides", () => {
    const result = widgetDesignConfigSchema.safeParse(
      configWith({
        text: {
          en: { heading: "Choose your ritual" },
          "pt-BR": {
            subscribeLabel: "Assine e economize {percent}",
            benefits: ["Desconto", "Presente"],
          },
          fr: {},
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects malformed locale keys in text", () => {
    for (const key of ["EN", "english language", "pt_BR", "1en"]) {
      const result = widgetDesignConfigSchema.safeParse(
        configWith({ text: { [key]: { heading: "x" } } }),
      );
      expect(result.success, `locale key "${key}" should be rejected`).toBe(
        false,
      );
    }
  });

  it("rejects unknown fields in a text override (strict)", () => {
    const result = widgetDesignConfigSchema.safeParse(
      configWith({
        text: { en: { heading: "x", evil: "y" } as never },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects more than 5 benefits", () => {
    const result = widgetDesignConfigSchema.safeParse(
      configWith({
        text: { en: { benefits: ["1", "2", "3", "4", "5", "6"] } },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const config = { ...configWith({}), extra: true };
    expect(widgetDesignConfigSchema.safeParse(config).success).toBe(false);
  });
});

// ── themeSync (v1.2.2 — theme add-to-cart price sync) ────────────────────────

/**
 * The config half of the feature that keeps the THEME's own add-to-cart
 * button ("ADD TO CART - CHF 64.00") showing the price the shopper actually
 * selected. Rendering is covered in tests/liquid/theme-sync.test.ts; here:
 * the schema shape, the safe defaults every pre-v1.2.2 revision inherits, and
 * the selector sanitization (the value is printed into a data-attribute and
 * then handed to querySelectorAll on the storefront).
 */
describe("themeSync", () => {
  /** Deep clone with free-form surgery on the themeSync object. */
  function looseConfig(): Record<string, unknown> & {
    themeSync?: Record<string, unknown>;
  } {
    return structuredClone(DEFAULT_DESIGN_CONFIG) as unknown as Record<
      string,
      unknown
    > & { themeSync?: Record<string, unknown> };
  }

  function parseOk(input: unknown): WidgetDesignConfig {
    const result = widgetDesignConfigSchema.safeParse(input);
    if (!result.success) {
      throw new Error(`expected config to parse: ${result.error.message}`);
    }
    return result.data;
  }

  it("DEFAULT_DESIGN_CONFIG ships the sync ON with the built-in selector list", () => {
    expect(DEFAULT_DESIGN_CONFIG.themeSync).toEqual({
      syncAddToCartPrice: true,
      priceSelector: "",
    });
  });

  it("a config with NO themeSync key parses and defaults to ON", () => {
    // Every WidgetDesignRevision published before v1.2.2 — and the live
    // cellexia.buybox_design metafield — has this shape. A parse failure here
    // would blank the storefront widget for the whole shop.
    const config = looseConfig();
    delete config.themeSync;
    expect(parseOk(config).themeSync).toEqual({
      syncAddToCartPrice: true,
      priceSelector: "",
    });
  });

  it("survives the metafield JSON round-trip", () => {
    const config = looseConfig();
    delete config.themeSync;
    const parsed = parseOk(JSON.parse(JSON.stringify(config)));
    expect(parsed.themeSync.syncAddToCartPrice).toBe(true);
  });

  it("fills field-level defaults inside a PARTIAL themeSync object", () => {
    const config = looseConfig();
    config.themeSync = { syncAddToCartPrice: false };
    expect(parseOk(config).themeSync).toEqual({
      syncAddToCartPrice: false,
      priceSelector: "",
    });
  });

  it("accepts and preserves an explicit opt-out plus a custom selector", () => {
    const config = looseConfig();
    config.themeSync = {
      syncAddToCartPrice: false,
      priceSelector: ".pdp__actions .btn--atc",
    };
    expect(parseOk(config).themeSync).toEqual({
      syncAddToCartPrice: false,
      priceSelector: ".pdp__actions .btn--atc",
    });
  });

  it("rejects a non-boolean flag", () => {
    for (const value of ["true", 1, null]) {
      const config = looseConfig();
      config.themeSync = { syncAddToCartPrice: value, priceSelector: "" };
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        String(value),
      ).toBe(false);
    }
  });

  it("sanitizes priceSelector on parse — angle brackets, quotes, backslashes", () => {
    const config = looseConfig();
    config.themeSync = {
      syncAddToCartPrice: true,
      priceSelector: '  [data-atc="1"] .btn<script>\\  ',
    };
    const selector = parseOk(config).themeSync.priceSelector;
    expect(selector).toBe("[data-atc=1] .btnscript");
    expect(selector).not.toMatch(/[<>"'`\\]/);
  });

  it("sanitizes exactly like placement.selector (one rule, two fields)", () => {
    const hostile = '.a"> <b\'c`\\d';
    const config = looseConfig();
    config.themeSync = { syncAddToCartPrice: true, priceSelector: hostile };
    (config as { placement: Record<string, unknown> }).placement = {
      mode: "selector",
      selector: hostile,
      position: "before",
    };
    const parsed = parseOk(config);
    expect(parsed.themeSync.priceSelector).toBe(sanitizePlacementSelector(hostile));
    expect(parsed.themeSync.priceSelector).toBe(parsed.placement.selector);
  });

  it("caps priceSelector at PRICE_SELECTOR_MAX_LENGTH (301 rejected, 300 kept)", () => {
    const over = looseConfig();
    over.themeSync = {
      syncAddToCartPrice: true,
      priceSelector: "a".repeat(PRICE_SELECTOR_MAX_LENGTH + 1),
    };
    expect(widgetDesignConfigSchema.safeParse(over).success).toBe(false);

    const at = looseConfig();
    at.themeSync = {
      syncAddToCartPrice: true,
      priceSelector: "a".repeat(PRICE_SELECTOR_MAX_LENGTH),
    };
    expect(parseOk(at).themeSync.priceSelector).toBe(
      "a".repeat(PRICE_SELECTOR_MAX_LENGTH),
    );
  });

  it("rejects unknown keys inside themeSync (strict)", () => {
    const config = looseConfig();
    config.themeSync = {
      syncAddToCartPrice: true,
      priceSelector: "",
      onSwap: "alert(1)",
    };
    expect(widgetDesignConfigSchema.safeParse(config).success).toBe(false);
  });
});

// ── markets (v1.6.0 — per-market preset selection) ───────────────────────────

/**
 * config.markets maps Shopify MARKET HANDLES → { preset }: the design preset
 * per market, everything else inheriting the base config. The schema-side
 * contract has two halves:
 *  - BACKWARD COMPATIBILITY: every stored revision and the live
 *    cellexia.buybox_design metafield predate the field, so a config with no
 *    `markets` key MUST keep parsing (field-level .default({}) — the schema
 *    evolution rule in presets.ts). A failure here blanks the designer for
 *    the whole shop.
 *  - VALIDATION: handles are capped at 80 chars and the entry is a strict
 *    { preset } naming a known preset — anything else is rejected on save,
 *    so the storefront's unknown-preset fallback only ever handles
 *    hand-edited metafields.
 * Rendering (exact-handle match, nil-safety, design_source precedence) is
 * covered in tests/liquid/subscription-max.test.ts.
 */
describe("markets (per-market preset selection)", () => {
  function looseConfig(): Record<string, unknown> {
    return structuredClone(DEFAULT_DESIGN_CONFIG) as unknown as Record<
      string,
      unknown
    >;
  }

  function parseOk(input: unknown): WidgetDesignConfig {
    const result = widgetDesignConfigSchema.safeParse(input);
    if (!result.success) {
      throw new Error(`expected config to parse: ${result.error.message}`);
    }
    return result.data;
  }

  it("DEFAULT_DESIGN_CONFIG ships with no per-market overrides", () => {
    expect(DEFAULT_DESIGN_CONFIG.markets).toEqual({});
  });

  it("a v1.5-shaped config with NO markets key parses and defaults to {}", () => {
    // Every WidgetDesignRevision published before v1.6.0 — and the live
    // cellexia.buybox_design metafield — has this shape.
    const config = looseConfig();
    delete config.markets;
    expect(parseOk(config).markets).toEqual({});
  });

  it("survives the metafield JSON round-trip without the field", () => {
    const config = looseConfig();
    delete config.markets;
    expect(parseOk(JSON.parse(JSON.stringify(config))).markets).toEqual({});
  });

  it("accepts market-handle keys mapping to known presets and preserves them", () => {
    const config = looseConfig();
    config.markets = {
      ch: { preset: "subscription_max" },
      "eu-west": { preset: "classic" },
      us: { preset: "planner" },
    };
    expect(parseOk(config).markets).toEqual({
      ch: { preset: "subscription_max" },
      "eu-west": { preset: "classic" },
      us: { preset: "planner" },
    });
  });

  it("rejects an unknown preset in a market entry", () => {
    for (const preset of ["mega_stack", "SUBSCRIPTION_MAX", "", "classic "]) {
      const config = looseConfig();
      config.markets = { ch: { preset } };
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        `markets preset "${preset}" should be rejected`,
      ).toBe(false);
    }
  });

  it("caps market handles at 80 chars (81 rejected, 80 kept)", () => {
    const over = looseConfig();
    over.markets = { ["h".repeat(81)]: { preset: "classic" } };
    expect(widgetDesignConfigSchema.safeParse(over).success).toBe(false);

    const at = looseConfig();
    at.markets = { ["h".repeat(80)]: { preset: "classic" } };
    expect(parseOk(at).markets["h".repeat(80)]).toEqual({ preset: "classic" });
  });

  it("rejects malformed entries — extra keys, wrong shapes, null", () => {
    for (const entry of [
      { preset: "classic", extra: true }, // strict object
      "classic", // bare string, not { preset }
      { presets: "classic" }, // wrong key
      {}, // preset is required
      null,
      42,
    ]) {
      const config = looseConfig();
      config.markets = { ch: entry };
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        `markets entry ${JSON.stringify(entry)} should be rejected`,
      ).toBe(false);
    }
  });

  it("an empty markets object is valid (no overrides anywhere)", () => {
    const config = looseConfig();
    config.markets = {};
    expect(parseOk(config).markets).toEqual({});
  });
});

// ── sanitizeCustomCss ────────────────────────────────────────────────────────

describe("sanitizeCustomCss", () => {
  it("preserves benign declarations verbatim", () => {
    const css =
      ".cx-card { color: #4a5d4a; border-radius: 8px; }\n" +
      ".cx-badge { background: url(/assets/leaf.svg) no-repeat; }\n" +
      '.cx-tile { background-image: url("images/tile.png"); mask: url(#frag); }';
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  it("strips @import (case-insensitive)", () => {
    for (const css of [
      "@import url('theme.css');",
      "@IMPORT 'x.css';",
      "a { color: red; } @Import url(b.css);",
    ]) {
      expect(sanitizeCustomCss(css)).not.toMatch(/@import/i);
    }
  });

  it("strips expression( including spaced variants", () => {
    for (const css of [
      "width: expression(alert(1));",
      "width: EXPRESSION (alert(1));",
    ]) {
      expect(sanitizeCustomCss(css)).not.toMatch(/expression\s*\(/i);
    }
  });

  it("strips javascript: anywhere", () => {
    expect(sanitizeCustomCss("background: JAVASCRIPT:alert(1)")).not.toMatch(
      /javascript:/i,
    );
  });

  it("neutralizes url() with any scheme, keeps relative targets", () => {
    const out = sanitizeCustomCss(
      ".a { background: url(https://evil.example/x.png); }\n" +
        ".b { background: url('http://evil.example/y.png'); }\n" +
        ".c { background: url(data:image/svg+xml,<svg/>); }\n" +
        ".d { background: url(/assets/ok.png); }",
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("data:");
    expect(out).toContain("url(/assets/ok.png)");
    // schemed urls collapse to an inert empty url()
    expect(out).toContain("url()");
  });

  it("removes angle brackets so CSS can never close its <style> scope", () => {
    const out = sanitizeCustomCss('</style><script>alert(1)</script>');
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("strips until stable — removed fragments cannot recompose a banned token", () => {
    // "@imp" + "@import" + "ort": one removal pass would recompose "@import".
    expect(sanitizeCustomCss("@imp@importort")).not.toMatch(/@import/i);
    // same trick for javascript:
    expect(sanitizeCustomCss("javajavascript:script:alert(1)")).not.toMatch(
      /javascript:/i,
    );
  });

  it("caps output at CUSTOM_CSS_MAX_LENGTH", () => {
    const out = sanitizeCustomCss("a".repeat(CUSTOM_CSS_MAX_LENGTH + 1000));
    expect(out.length).toBe(CUSTOM_CSS_MAX_LENGTH);
  });

  it("leaves the empty string alone", () => {
    expect(sanitizeCustomCss("")).toBe("");
  });

  it("rejects css whose closing brace would escape the #cx-buybox wrapper rule", () => {
    // The Liquid emits customCss inside `#cx-buybox-<uid> { … }`; an early `}`
    // closes that wrapper and everything after ships as UNSCOPED,
    // storefront-global CSS. Depth going negative rejects the css WHOLE.
    expect(sanitizeCustomCss("color:red} body{display:none")).toBe("");
    // The exact compliance-guardrail attack: globally hiding the demoted
    // one-time purchase link the subscription_max/value_stack presets keep.
    expect(
      sanitizeCustomCss(
        "color:#000} .cx-buybox__stack-onetime,.cx-buybox__onetime-link{display:none;",
      ),
    ).toBe("");
    // Balanced COUNTS are not enough: interleaving still dips negative.
    expect(sanitizeCustomCss("a{x}b}c{d")).toBe("");
    // A lone closing brace, first character.
    expect(sanitizeCustomCss("} .anything{color:red}")).toBe("");
  });

  it("rejects unclosed braces (they would swallow the wrapper's own closing brace)", () => {
    expect(sanitizeCustomCss(".a { color: red")).toBe("");
    expect(sanitizeCustomCss("{{{")).toBe("");
  });

  it("still accepts balanced nested rules — the containment is a check, not a brace strip", () => {
    const css = ".cx-buybox__heading { letter-spacing: 0.1em; }";
    expect(sanitizeCustomCss(css)).toBe(css);
    const declarationsOnly = "color: #4a5d4a; border-radius: 8px;";
    expect(sanitizeCustomCss(declarationsOnly)).toBe(declarationsOnly);
  });

  it("checks braces AFTER the length cap, so a truncated-open css cannot ship", () => {
    // Balanced at full length, but the cap cuts inside a rule and strands an
    // open brace — shipping that would let the wrapper's closing brace be
    // swallowed. It must be rejected whole instead.
    const filler = "a".repeat(CUSTOM_CSS_MAX_LENGTH - 5);
    const out = sanitizeCustomCss(`${filler}.x { color: red }`);
    expect(out).toBe("");
  });
});

// ── resolveDesignText / resolveDesignBenefits ───────────────────────────────

describe("resolveDesignText", () => {
  const config = configWith({
    text: {
      en: {
        heading: "Choose your plan",
        savingsTemplate: "Save {percent} on every {frequency}",
        oneTimeLinkLabel: "or buy once for {amount}",
      },
      fr: { heading: "Choisissez votre formule" },
      de: { heading: "Plan wählen" },
      "pt-br": { heading: "Escolha seu plano" },
    },
  });

  it("uses the exact locale when present", () => {
    expect(resolveDesignText(config, "fr", "heading", "fallback")).toBe(
      "Choisissez votre formule",
    );
  });

  it("matches locale keys case-insensitively", () => {
    expect(resolveDesignText(config, "pt-BR", "heading", "fallback")).toBe(
      "Escolha seu plano",
    );
  });

  it("falls back from a regional locale to its base language", () => {
    expect(resolveDesignText(config, "de-AT", "heading", "fallback")).toBe(
      "Plan wählen",
    );
  });

  it("falls back to en when the locale has no override for the key", () => {
    // fr overrides heading but not savingsTemplate → en's template wins.
    expect(
      resolveDesignText(config, "fr", "savingsTemplate", "fallback"),
    ).toBe("Save {percent} on every {frequency}");
  });

  it("falls back to the extension-locale fallback when nothing is configured", () => {
    expect(
      resolveDesignText(config, "ja", "reassurance", "Skip anytime."),
    ).toBe("Skip anytime.");
    expect(
      resolveDesignText(configWith({}), "en", "heading", "Purchase options"),
    ).toBe("Purchase options");
  });

  it("treats blank overrides as absent — an empty admin field never blanks copy", () => {
    const blanked = configWith({ text: { en: { heading: "   " } } });
    expect(resolveDesignText(blanked, "en", "heading", "fallback")).toBe(
      "fallback",
    );
  });

  it("keeps {percent}/{amount}/{frequency} placeholders intact through the chain for client-side substitution", () => {
    // Substitution happens at render time (buy-box.js template resolver /
    // admin preview): resolveDesignText's contract is to deliver the template
    // with its placeholders untouched, in every fallback branch.
    const viaEn = resolveDesignText(config, "de", "savingsTemplate", "x");
    expect(viaEn).toContain("{percent}");
    expect(viaEn).toContain("{frequency}");
    const direct = resolveDesignText(config, "en", "oneTimeLinkLabel", "x");
    expect(direct).toContain("{amount}");
    // and simulated substitution yields no leftover braces
    const filled = viaEn
      .replace(/\{percent\}/g, "20%")
      .replace(/\{frequency\}/g, "4 weeks");
    expect(filled).toBe("Save 20% on every 4 weeks");
    expect(filled).not.toMatch(/\{\w+\}/);
  });
});

describe("resolveDesignBenefits", () => {
  const fallback = ["First-order discount", "Ongoing discount"];

  it("uses the locale's benefits when present", () => {
    const config = configWith({
      text: { fr: { benefits: ["Réduction", "Cadeau"] } },
    });
    expect(resolveDesignBenefits(config, "fr", fallback)).toEqual([
      "Réduction",
      "Cadeau",
    ]);
  });

  it("falls back to en, then to the provided fallback", () => {
    const config = configWith({ text: { en: { benefits: ["A", "B"] } } });
    expect(resolveDesignBenefits(config, "sv", fallback)).toEqual(["A", "B"]);
    expect(resolveDesignBenefits(configWith({}), "sv", fallback)).toEqual(
      fallback,
    );
  });

  it("treats an empty benefits array as absent", () => {
    const config = configWith({
      text: { fr: { benefits: [] }, en: { benefits: ["A"] } },
    });
    expect(resolveDesignBenefits(config, "fr", fallback)).toEqual(["A"]);
  });
});

// ── PRESET_META ──────────────────────────────────────────────────────────────

describe("PRESET_META", () => {
  it("covers exactly the seven preset keys", () => {
    expect(Object.keys(PRESET_META).sort()).toEqual([...PRESET_KEYS].sort());
    expect(PRESET_KEYS).toHaveLength(7);
  });

  for (const key of PRESET_KEYS) {
    it(`[${key}] has complete CRO metadata`, () => {
      const meta = PRESET_META[key];
      expect(meta.name.length, `${key}.name`).toBeGreaterThan(0);
      expect(meta.tagline.length, `${key}.tagline`).toBeGreaterThan(0);
      expect(meta.croRationale.length, `${key}.croRationale`).toBeGreaterThan(
        0,
      );
      expect(meta.bestFor.length, `${key}.bestFor`).toBeGreaterThan(0);
      expect(["minimal", "low", "medium"]).toContain(meta.conversionRisk);
    });
  }

  it("the zero-risk presets are flagged minimal", () => {
    // classic is the untouched v1.0.0 baseline; inline is the documented
    // zero-conversion-risk option — the designer UI leans on these flags.
    expect(PRESET_META.classic.conversionRisk).toBe("minimal");
    expect(PRESET_META.inline.conversionRisk).toBe("minimal");
  });

  it("subscription_max carries HONEST CRO copy, not sales copy", () => {
    // The client asked for the highest take-rate posture; the meta must still
    // tell the merchant the truth the designer UI leans on: one-time is
    // demoted to a quiet link (not removed), the risk to cold-traffic PDP
    // conversion is real ("medium"), and the mitigation is testing against
    // the baseline + one-click restore from design history.
    const meta = PRESET_META.subscription_max;
    expect(meta.conversionRisk).toBe("medium");
    expect(meta.croRationale).toMatch(/take-rate/i);
    expect(meta.croRationale).toMatch(/quiet/i);
    expect(meta.croRationale).toMatch(/one[- ]?time/i);
    // Never oversold as subscription-only, and never implying extra perks.
    expect(meta.croRationale).toMatch(/NOT\s+subscription-only/i);
    expect(meta.croRationale).toMatch(/no extra perks or discounts/i);
    // The safety rails: measure against the baseline, restore in one click.
    expect(meta.croRationale).toMatch(/baseline/i);
    expect(meta.croRationale).toMatch(/restore/i);
  });
});

// ── Design attribution (_cellexia_design) ─────────────────────────────────────────

describe("lineProperty (_cellexia_design extraction)", () => {
  it("reads the array-of-{name,value} REST shape", () => {
    const li = {
      properties: [
        { name: "_gift_note", value: "hi" },
        { name: "_cellexia_design", value: "toggle" },
      ],
    };
    expect(lineProperty(li, "_cellexia_design")).toBe("toggle");
  });

  it("reads the flattened object shape", () => {
    expect(lineProperty({ properties: { _cellexia_design: "tiles" } }, "_cellexia_design")).toBe(
      "tiles",
    );
  });

  it("returns null when absent, empty, or non-string", () => {
    expect(lineProperty({}, "_cellexia_design")).toBeNull();
    expect(lineProperty({ properties: [] }, "_cellexia_design")).toBeNull();
    expect(lineProperty({ properties: {} }, "_cellexia_design")).toBeNull();
    expect(
      lineProperty({ properties: [{ name: "other", value: "x" }] }, "_cellexia_design"),
    ).toBeNull();
    expect(
      lineProperty({ properties: { _cellexia_design: "" } }, "_cellexia_design"),
    ).toBeNull();
    expect(
      lineProperty({ properties: { _cellexia_design: 42 } }, "_cellexia_design"),
    ).toBeNull();
    expect(lineProperty({ properties: "oops" }, "_cellexia_design")).toBeNull();
  });
});

describe("ORDERS_CREATE design attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireShop.mockResolvedValue({
      id: "shop_1",
      domain: "cellexia-test.myshopify.com",
    });
    mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
    mocks.subscriberEventFindFirst.mockResolvedValue(null);
    mocks.subscriptionContractFindFirst.mockResolvedValue(null);
  });

  function orderPayload(lineItems: unknown[]): Record<string, unknown> {
    return {
      id: 999001,
      admin_graphql_api_id: "gid://shopify/Order/999001",
      name: "#1042",
      email: "buyer@cellexia.example",
      line_items: lineItems,
    };
  }

  async function run(payload: Record<string, unknown>): Promise<void> {
    await webhookHandlers.ORDERS_CREATE({
      shopDomain: "cellexia-test.myshopify.com",
      payload,
      webhookId: "wh_test_1",
    });
  }

  function attributedEvents(): Record<string, unknown>[] {
    return mocks.logEvent.mock.calls
      .map((call) => call[0])
      .filter((e) => e.type === "widget.design_attributed");
  }

  it("logs widget.design_attributed with the designKey for a subscription line", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cellexia_design", value: "value_stack" }],
        },
      ]),
    );
    const events = attributedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      designKey: "value_stack",
      orderId: "gid://shopify/Order/999001",
    });
  });

  it("ignores _cellexia_design on one-time lines (no selling-plan marker)", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          properties: [{ name: "_cellexia_design", value: "planner" }],
        },
      ]),
    );
    expect(attributedEvents()).toHaveLength(0);
  });

  it("dedupes to one event per distinct design key", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cellexia_design", value: "toggle" }],
        },
        {
          product_id: 222,
          selling_plan: { id: 777 },
          properties: { _cellexia_design: "toggle" },
        },
      ]),
    );
    const events = attributedEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).designKey).toBe(
      "toggle",
    );
  });

  it("subscription lines without _cellexia_design log nothing (pre-v1.1.0 carts)", async () => {
    await run(
      orderPayload([{ product_id: 111, selling_plan_id: 777, properties: [] }]),
    );
    expect(attributedEvents()).toHaveLength(0);
  });

  /**
   * Backward compatibility across the v1.2.3 namespace rename. The property
   * was `_cx_design` until the widget's whole storefront namespace was moved
   * off "cx" (another vendor owns it on the client's live store). Orders that
   * were placed — or carts that were already open — before the merchant
   * updated the theme extension still carry the old name, so attribution must
   * keep working for them.
   */
  it("still attributes the legacy _cx_design property (orders from before the rename)", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cx_design", value: "tiles" }],
        },
      ]),
    );
    const events = attributedEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).designKey).toBe(
      "tiles",
    );
  });

  it("reads the legacy name in the flattened property shape too", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan: { id: 777 },
          properties: { _cx_design: "planner" },
        },
      ]),
    );
    expect(
      (attributedEvents()[0].payload as Record<string, unknown>).designKey,
    ).toBe("planner");
  });

  it("prefers the current name when a line somehow carries both", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [
            { name: "_cx_design", value: "classic" },
            { name: "_cellexia_design", value: "value_stack" },
          ],
        },
      ]),
    );
    const events = attributedEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).designKey).toBe(
      "value_stack",
    );
  });

  /**
   * Manual redelivery (Shopify admin "Resend") arrives with a NEW webhook id,
   * so the route-level receipt dedupe cannot catch it. The handler's own
   * order-id guard must: without it, checkout.subscribable (the take-rate
   * denominator) and widget.design_attributed double-count per resend.
   */
  it("a manual redelivery of the same order logs NO events (order-id replay guard)", async () => {
    // An event for this order already exists — this is a redelivery.
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });

    await run(
      orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cellexia_design", value: "value_stack" }],
        },
      ]),
    );

    expect(mocks.logEvent).not.toHaveBeenCalled();
    // The guard filtered on the order's identity, not just any event.
    const query = mocks.subscriberEventFindFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(query.where.payload).toMatchObject({
      path: ["orderId"],
      equals: "gid://shopify/Order/999001",
    });
  });

  /**
   * Renewal orders — Shopify stamps source_name "subscription_contract" on
   * orders created by subscription billing attempts. They are not storefront
   * checkouts: counting them would deflate the take-rate level once per
   * cycle as the book matures (the audit's denominator-inflation finding),
   * and their line items re-carry the widget's design property from the
   * original add-to-cart, which would re-attribute the same design every
   * cycle. The handler must skip them before any event is logged.
   */
  it("a renewal order (source_name subscription_contract) logs NO events", async () => {
    await run({
      ...orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cellexia_design", value: "value_stack" }],
        },
      ]),
      source_name: "subscription_contract",
    });

    expect(mocks.logEvent).not.toHaveBeenCalled();
    // Skipped before any DB work — on a mature book most orders are renewals.
    expect(mocks.requireShop).not.toHaveBeenCalled();
    expect(mocks.subscriberEventFindFirst).not.toHaveBeenCalled();
  });

  it("a storefront checkout (source_name web) still counts in both feeds", async () => {
    await run({
      ...orderPayload([
        {
          product_id: 111,
          selling_plan_id: 777,
          properties: [{ name: "_cellexia_design", value: "value_stack" }],
        },
      ]),
      source_name: "web",
    });

    const types = mocks.logEvent.mock.calls.map((call) => call[0].type);
    expect(types).toContain("widget.design_attributed");
    expect(types).toContain("checkout.subscribable");
  });
});
