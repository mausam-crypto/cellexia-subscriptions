import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";

import { renderWidget } from "./harness";

/**
 * CUSTOM CSS STAYS INSIDE THE WRAPPER — the Liquid belt, evaluated.
 *
 * The core snippet emits merchant custom CSS inside
 * `<style>#cx-buybox-<uid> { … }</style>`. That scoping is only real if no
 * `}` in the css can close the wrapper rule itself: `color:red}
 * body{display:none` would ship `body{display:none}` as UNSCOPED,
 * storefront-global CSS — including the exact rule that hides the demoted
 * one-time purchase link the subscription_max/value_stack presets keep as a
 * compliance guardrail.
 *
 * sanitizeCustomCss rejects unbalanced css server-side before publish
 * (tests/widget-design.test.ts), but the metafield can be HAND-EDITED
 * outside the app — both files name that as part of the threat model — so
 * the snippet carries its own depth-walk belt. These tests render the REAL
 * Liquid with configs the app itself would never publish and pin that no
 * brace escape survives to the page.
 */

/**
 * A published design whose style.customCss carries `css` VERBATIM — built
 * through the zod schema (which only length-caps customCss), exactly the
 * shape a hand-edited `cellexia.buybox_design` metafield presents to Liquid:
 * valid config, hostile css, never through sanitizeCustomCss.
 */
function handEditedConfig(css: string): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    style: { ...DEFAULT_DESIGN_CONFIG.style, customCss: css },
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** The custom-css style block, or null when the belt dropped the css. */
function customCssBlock(html: string): string | null {
  const match = /<style>#cx-buybox-[^{]*\{([\s\S]*?)\}<\/style>/.exec(html);
  return match ? match[1] : null;
}

describe("custom CSS brace containment (Liquid belt)", () => {
  it("emits benign declarations inside the wrapper rule", async () => {
    const html = await renderWidget({
      config: handEditedConfig("color: #4a5d4a; letter-spacing: 0.1em;"),
      launchStatus: "live",
    });
    const block = customCssBlock(html);
    expect(block).not.toBeNull();
    expect(block).toContain("letter-spacing: 0.1em;");
  });

  it("keeps balanced nested rules (they stay scoped under the wrapper id)", async () => {
    const html = await renderWidget({
      config: handEditedConfig(".cx-buybox__heading { font-style: italic; }"),
      launchStatus: "live",
    });
    expect(html).toContain(".cx-buybox__heading { font-style: italic; }");
  });

  it("drops a hand-edited css whose early brace would escape the wrapper", async () => {
    const html = await renderWidget({
      config: handEditedConfig(
        "color:#000} .cx-buybox__stack-onetime,.cx-buybox__onetime-link{display:none;",
      ),
      launchStatus: "live",
    });
    // The whole css is rejected: no global one-time-hiding rule survives
    // anywhere in the page ("display:none" spelled the attacker's way — the
    // widget's own noscript fallback writes "display: none;" with a space),
    // and no custom style block is emitted at all.
    expect(html).not.toContain("display:none");
    expect(html).not.toContain("stack-onetime,.cx-buybox__onetime-link{");
    expect(customCssBlock(html)).toBeNull();
  });

  it("drops the storefront-blanking escape too", async () => {
    const html = await renderWidget({
      config: handEditedConfig("color:red} body{display:none"),
      launchStatus: "live",
    });
    expect(html).not.toContain("body{display:none");
    expect(customCssBlock(html)).toBeNull();
  });

  it("is not fooled by balanced COUNTS — interleaved depth still dips negative", async () => {
    const html = await renderWidget({
      config: handEditedConfig("a{x}b}c{d"),
      launchStatus: "live",
    });
    expect(customCssBlock(html)).toBeNull();
  });
});
