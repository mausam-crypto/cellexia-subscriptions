import { describe, expect, it } from "vitest";

/**
 * v1.2.0 app-embed config tests:
 *  - schema backward-compat — a v1.1.0-shaped config (no layout.showFrequency,
 *    no placement) must keep validating: published WidgetDesignRevision rows
 *    and the live cellexia.buybox_design metafield JSON in the wild predate
 *    these fields, and a parse failure would blank the storefront widget
 *  - layout.showFrequency — boolean, defaults true (frequency selector shown)
 *  - placement — app-embed mount point: mode/position enums, selector
 *    sanitization (sanitizePlacementSelector) + 200-char cap
 *  - DEFAULT_DESIGN_CONFIG brand tokens — the cellexialabs.com brand match
 *    (near-black #1D1D1B, panel #F4F4F4, sharp 0px corners) is a shipped
 *    requirement; changing these defaults must be a conscious decision
 *
 * presets.ts is isomorphic (zod only, no server imports), so this suite needs
 * no mocks. The embed's cart-payload injection (selling_plan into JSON items[],
 * flat {id,quantity} and urlencoded bodies) and anchor-precedence resolution
 * live only in extensions/cellexia-buy-box/assets/buy-box-embed.js — plain
 * theme JS with no TS export — so they are exercised on the storefront, not
 * here (no brittle file-content greps).
 */

import {
  DEFAULT_DESIGN_CONFIG,
  sanitizePlacementSelector,
  widgetDesignConfigSchema,
  type WidgetDesignConfig,
} from "~/lib/widget/presets";

/** Loosely-typed deep clone of DEFAULT_DESIGN_CONFIG for shape surgery. */
function looseConfig(): {
  layout: Record<string, unknown>;
  placement?: Record<string, unknown>;
  [key: string]: unknown;
} {
  return structuredClone(DEFAULT_DESIGN_CONFIG) as unknown as {
    layout: Record<string, unknown>;
    placement?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * A config exactly as v1.1.0 stored it: no layout.showFrequency, no placement
 * (both fields shipped in v1.2.0).
 */
function v110ShapedConfig(): Record<string, unknown> {
  const config = looseConfig();
  delete config.layout.showFrequency;
  delete config.placement;
  return config;
}

/** Parse or fail the test with zod's error message. */
function parseOk(input: unknown): WidgetDesignConfig {
  const result = widgetDesignConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`expected config to parse: ${result.error.message}`);
  }
  return result.data;
}

// ── Backward compatibility (v1.1.0 revisions in the wild) ────────────────────

describe("widgetDesignConfigSchema v1.1.0 backward-compat", () => {
  it("parses a v1.1.0-shaped config and fills showFrequency + placement defaults", () => {
    const parsed = parseOk(v110ShapedConfig());
    expect(parsed.layout.showFrequency).toBe(true);
    expect(parsed.placement).toEqual({
      mode: "auto",
      selector: "",
      position: "before",
    });
  });

  it("survives the metafield JSON round-trip (published revisions are stored JSON)", () => {
    const parsed = parseOk(JSON.parse(JSON.stringify(v110ShapedConfig())));
    expect(parsed.layout.showFrequency).toBe(true);
    expect(parsed.placement.mode).toBe("auto");
  });

  it("keeps a customized v1.1.0 revision's own values while gaining the new defaults", () => {
    const config = v110ShapedConfig();
    config.preset = "toggle";
    (config.layout as Record<string, unknown>).frequencyStyle = "chips";
    (config.style as Record<string, unknown>).accent = "#4a5d4a";
    config.text = { en: { heading: "Choose your ritual" } };

    const parsed = parseOk(config);
    expect(parsed.preset).toBe("toggle");
    expect(parsed.layout.frequencyStyle).toBe("chips");
    expect(parsed.style.accent).toBe("#4a5d4a");
    expect(parsed.text.en).toEqual({ heading: "Choose your ritual" });
    // …and the v1.2.0 additions arrive with their safe defaults.
    expect(parsed.layout.showFrequency).toBe(true);
    expect(parsed.placement).toEqual({
      mode: "auto",
      selector: "",
      position: "before",
    });
  });
});

// ── layout.showFrequency ─────────────────────────────────────────────────────

describe("layout.showFrequency", () => {
  it("accepts and preserves an explicit false (frequency selector removed)", () => {
    const config = looseConfig();
    config.layout.showFrequency = false;
    expect(parseOk(config).layout.showFrequency).toBe(false);
  });

  it("accepts and preserves an explicit true", () => {
    const config = looseConfig();
    config.layout.showFrequency = true;
    expect(parseOk(config).layout.showFrequency).toBe(true);
  });

  it("rejects non-boolean values", () => {
    for (const value of ["false", "true", 0, 1, null, {}]) {
      const config = looseConfig();
      config.layout.showFrequency = value;
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        `showFrequency ${JSON.stringify(value)} should be rejected`,
      ).toBe(false);
    }
  });
});

// ── placement ────────────────────────────────────────────────────────────────

describe("placement", () => {
  it("accepts an explicit selector placement and preserves it", () => {
    const config = looseConfig();
    config.placement = {
      mode: "selector",
      selector: ".pdp__info .pdp__grey",
      position: "before",
    };
    expect(parseOk(config).placement).toEqual({
      mode: "selector",
      selector: ".pdp__info .pdp__grey",
      position: "before",
    });
  });

  it("accepts every position", () => {
    for (const position of ["before", "after", "prepend", "append"]) {
      const config = looseConfig();
      config.placement = { mode: "selector", selector: ".x", position };
      expect(parseOk(config).placement.position).toBe(position);
    }
  });

  it("fills field-level defaults inside a partial placement object", () => {
    const config = looseConfig();
    config.placement = { mode: "auto" };
    expect(parseOk(config).placement).toEqual({
      mode: "auto",
      selector: "",
      position: "before",
    });
  });

  it("sanitizes the selector on parse — angle brackets, quotes, backslashes stripped", () => {
    const config = looseConfig();
    config.placement = {
      mode: "selector",
      selector: ` [data-x="atc"] .grey<script>\\'\` `,
      position: "after",
    };
    const parsed = parseOk(config);
    expect(parsed.placement.selector).toBe("[data-x=atc] .greyscript");
    expect(parsed.placement.selector).not.toMatch(/[<>"'`\\]/);
  });

  it("caps the selector at 200 chars (201 rejected, 200 accepted)", () => {
    const over = looseConfig();
    over.placement = { mode: "selector", selector: "a".repeat(201), position: "before" };
    expect(widgetDesignConfigSchema.safeParse(over).success).toBe(false);

    const at = looseConfig();
    at.placement = { mode: "selector", selector: "a".repeat(200), position: "before" };
    expect(parseOk(at).placement.selector).toBe("a".repeat(200));
  });

  it("rejects invalid modes", () => {
    for (const mode of ["manual", "fixed", "AUTO", "", null]) {
      const config = looseConfig();
      config.placement = { mode, selector: "", position: "before" };
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        `mode ${JSON.stringify(mode)} should be rejected`,
      ).toBe(false);
    }
  });

  it("rejects invalid positions", () => {
    for (const position of ["inside", "top", "BEFORE", "", null]) {
      const config = looseConfig();
      config.placement = { mode: "auto", selector: "", position };
      expect(
        widgetDesignConfigSchema.safeParse(config).success,
        `position ${JSON.stringify(position)} should be rejected`,
      ).toBe(false);
    }
  });

  it("rejects unknown keys in placement (strict)", () => {
    const config = looseConfig();
    config.placement = {
      mode: "auto",
      selector: "",
      position: "before",
      offset: 10,
    };
    expect(widgetDesignConfigSchema.safeParse(config).success).toBe(false);
  });
});

// ── sanitizePlacementSelector ────────────────────────────────────────────────

describe("sanitizePlacementSelector", () => {
  it("strips every unsafe character class", () => {
    expect(sanitizePlacementSelector(`<>"'\`\\`)).toBe("");
  });

  it("preserves legitimate CSS selectors verbatim", () => {
    for (const selector of [
      ".pdp__info .pdp__grey",
      "#main [data-role=atc]",
      "section.pdp div.pdp__actions",
      "form[action$=cart]",
    ]) {
      expect(sanitizePlacementSelector(selector)).toBe(selector);
    }
  });

  it("strips quotes out of attribute selectors but keeps them usable", () => {
    expect(sanitizePlacementSelector('[data-section="buybox"]')).toBe(
      "[data-section=buybox]",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePlacementSelector("   .pdp__grey  ")).toBe(".pdp__grey");
  });

  it("neutralizes markup-breaking payloads", () => {
    const out = sanitizePlacementSelector(
      '"></div><script>alert(1)</script>',
    );
    expect(out).not.toMatch(/[<>"'`\\]/);
  });
});

// ── DEFAULT_DESIGN_CONFIG brand tokens ───────────────────────────────────────

describe("DEFAULT_DESIGN_CONFIG brand tokens (cellexialabs.com match)", () => {
  // The v1.2.0 contract: publishing an untouched config must look native on
  // cellexialabs.com (monochrome editorial — near-black #1D1D1B on white,
  // #F4F4F4 panel, sharp corners). If a future change trips these assertions,
  // that is the test doing its job: rebranding the defaults must be a
  // conscious decision, not a drive-by edit.

  it("accent is the brand near-black #1D1D1B", () => {
    expect(DEFAULT_DESIGN_CONFIG.style.accent.toLowerCase()).toBe("#1d1d1b");
    expect(DEFAULT_DESIGN_CONFIG.style.text.toLowerCase()).toBe("#1d1d1b");
    expect(DEFAULT_DESIGN_CONFIG.style.accentText.toLowerCase()).toBe(
      "#ffffff",
    );
  });

  it("panel tint is the brand grey #F4F4F4", () => {
    expect(DEFAULT_DESIGN_CONFIG.style.bgTint.toLowerCase()).toBe("#f4f4f4");
  });

  it("corners are sharp (radius 0)", () => {
    expect(DEFAULT_DESIGN_CONFIG.layout.radiusPx).toBe(0);
  });

  it("frequency selector defaults on, placement defaults to auto", () => {
    expect(DEFAULT_DESIGN_CONFIG.layout.showFrequency).toBe(true);
    expect(DEFAULT_DESIGN_CONFIG.placement).toEqual({
      mode: "auto",
      selector: "",
      position: "before",
    });
  });
});
