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
 *  - PRESET_META — CRO metadata completeness for every preset key
 *  - design attribution — `_cx_design` line-property extraction from both
 *    REST property shapes, and the ORDERS_CREATE handler logging
 *    widget.design_attributed
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
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
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
  resolveDesignBenefits,
  resolveDesignText,
  sanitizeCustomCss,
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
  it("covers exactly the six preset keys", () => {
    expect(Object.keys(PRESET_META).sort()).toEqual([...PRESET_KEYS].sort());
    expect(PRESET_KEYS).toHaveLength(6);
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
});

// ── Design attribution (_cx_design) ─────────────────────────────────────────

describe("lineProperty (_cx_design extraction)", () => {
  it("reads the array-of-{name,value} REST shape", () => {
    const li = {
      properties: [
        { name: "_gift_note", value: "hi" },
        { name: "_cx_design", value: "toggle" },
      ],
    };
    expect(lineProperty(li, "_cx_design")).toBe("toggle");
  });

  it("reads the flattened object shape", () => {
    expect(lineProperty({ properties: { _cx_design: "tiles" } }, "_cx_design")).toBe(
      "tiles",
    );
  });

  it("returns null when absent, empty, or non-string", () => {
    expect(lineProperty({}, "_cx_design")).toBeNull();
    expect(lineProperty({ properties: [] }, "_cx_design")).toBeNull();
    expect(lineProperty({ properties: {} }, "_cx_design")).toBeNull();
    expect(
      lineProperty({ properties: [{ name: "other", value: "x" }] }, "_cx_design"),
    ).toBeNull();
    expect(
      lineProperty({ properties: { _cx_design: "" } }, "_cx_design"),
    ).toBeNull();
    expect(
      lineProperty({ properties: { _cx_design: 42 } }, "_cx_design"),
    ).toBeNull();
    expect(lineProperty({ properties: "oops" }, "_cx_design")).toBeNull();
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
          properties: [{ name: "_cx_design", value: "value_stack" }],
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

  it("ignores _cx_design on one-time lines (no selling-plan marker)", async () => {
    await run(
      orderPayload([
        {
          product_id: 111,
          properties: [{ name: "_cx_design", value: "planner" }],
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
          properties: [{ name: "_cx_design", value: "toggle" }],
        },
        {
          product_id: 222,
          selling_plan: { id: 777 },
          properties: { _cx_design: "toggle" },
        },
      ]),
    );
    const events = attributedEvents();
    expect(events).toHaveLength(1);
    expect((events[0].payload as Record<string, unknown>).designKey).toBe(
      "toggle",
    );
  });

  it("subscription lines without _cx_design log nothing (pre-v1.1.0 carts)", async () => {
    await run(
      orderPayload([{ product_id: 111, selling_plan_id: 777, properties: [] }]),
    );
    expect(attributedEvents()).toHaveLength(0);
  });
});
