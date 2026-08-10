import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  PRESET_KEYS,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";
import type { PresetKey, WidgetDesignConfig } from "~/lib/widget/presets";

import {
  FIXTURE,
  JOY_GROUP,
  REPO_ROOT,
  attributeValue,
  attributeValues,
  countOccurrences,
  decodeEntitiesOnce,
  domContractTokens,
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
 * GOLDEN RENDER TESTS for the Cellexia buy box.
 *
 * These render the real extension Liquid through a harness that reproduces
 * Shopify's theme-app-extension semantics (see tests/liquid/harness.ts) and
 * assert the properties the v1.2.0 storefront regression violated:
 *
 *   a. no app-snippet comment markers ever reach the page as TEXT
 *   b. nothing is HTML-escaped twice ("Subscribe &amp;amp; Save")
 *   c. no {percent}/{amount}/{frequency} placeholder survives into the copy
 *   d. the structural contract (one root, the selling-plan id, both purchase
 *      options) holds for all six presets
 *   e. the launch gate is intact for all six presets
 *   f. layout.showFrequency=false removes the control everywhere without
 *      dropping the default plan
 *   g. data-cellexia-tpl attributes carry RAW templates, escaped exactly once
 *   h. every DOM hook assets/buy-box.js looks up actually exists in the markup
 *   i. a shop with NO published design renders the classic preset, byte-stable
 *
 * The matrix is 6 presets x {live, setup-gated} x {showFrequency} x {savings},
 * plus the locale-override, config-override and zero-config cases.
 */

// ── Config fixtures ──────────────────────────────────────────────────────────

type LayoutOverrides = Partial<WidgetDesignConfig["layout"]>;
type TextOverrides = WidgetDesignConfig["text"];

/**
 * Build a design config the way the admin publishes it: DEFAULT_DESIGN_CONFIG
 * plus overrides, validated through the real zod schema so a fixture can never
 * be a config the app could not actually publish, then round-tripped through
 * JSON exactly like the shop metafield.
 */
function designConfig(
  preset: PresetKey,
  layout: LayoutOverrides = {},
  text: TextOverrides = {},
): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset,
    layout: { ...DEFAULT_DESIGN_CONFIG.layout, ...layout },
    text,
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

const ALL_PLAN_IDS = [
  FIXTURE.planIds.weeks4,
  FIXTURE.planIds.weeks6,
  FIXTURE.planIds.weeks8,
].map(String);

/** The plan the block preselects: the "8 weeks" recommended frequency. */
const DEFAULT_PLAN_ID = String(FIXTURE.planIds.weeks8);

// ── Shared assertions ────────────────────────────────────────────────────────

/**
 * (a) The production defect: Shopify's "<!-- BEGIN app snippet: x -->" markers
 * turning into visible page text. The harness DOES wrap every snippet render
 * in those markers (asserted here too, so this test can never pass vacuously);
 * they must survive only as real HTML comments.
 */
function expectNoAppSnippetLeak(html: string): void {
  expect(html).toContain("<!-- BEGIN app snippet: cx-buybox-core -->");
  expect(html).toContain("<!-- END app snippet -->");

  // An escaped comment marker is the exact signature of the v1.2.0 bug.
  expect(html).not.toContain("&lt;!--");
  expect(html).not.toContain("&lt;!");

  const text = visibleText(html);
  expect(text).not.toContain("BEGIN app snippet");
  expect(text).not.toContain("END app snippet");
  expect(text).not.toContain("app snippet");
  expect(text).not.toContain("<!--");
}

/** (b) Nothing may be escaped twice — "Subscribe &amp;amp; Save" on the page. */
function expectNoDoubleEscaping(html: string): void {
  expect(html).not.toContain("&amp;amp;");
  expect(html).not.toContain("&amp;lt;");
  expect(html).not.toContain("&amp;gt;");
  expect(html).not.toContain("&amp;quot;");
  expect(html).not.toContain("&amp;#39;");

  const text = visibleText(html);
  // Decoding the page ONCE must yield real characters, never more entities.
  expect(text).not.toContain("&amp;");
  expect(text).not.toContain("&quot;");
  expect(text).not.toContain("&#39;");
}

/**
 * (b) The screenshot bug stated positively, for the default locale: the
 * subscribe label reaches the page with a LITERAL ampersand. en.default.json
 * has "Subscribe & Save"; the toggle/inline presets use the percent variant
 * ("Subscribe & save {percent}"), hence the case-insensitive compare.
 */
function expectLiteralAmpersandLabel(html: string): void {
  expect(visibleText(html).toLowerCase()).toContain("subscribe & save");
}

/** (c) No template placeholder or untranslated key may reach the shopper. */
function expectNoUnresolvedPlaceholders(html: string): void {
  const text = visibleText(html);
  for (const placeholder of ["{percent}", "{amount}", "{frequency}"]) {
    expect(text).not.toContain(placeholder);
  }
  // Locale-file interpolation that the t filter failed to fill.
  expect(text).not.toMatch(/\{\{\s*[\w.]+\s*\}\}/);
  // Shopify's own missing-key output.
  expect(text).not.toContain("translation missing");
}

/** (g) data-cellexia-tpl carries RAW text: placeholders intact, escaped exactly once. */
function expectRawTemplateAttributes(html: string): void {
  for (const tag of tagsWithAttribute(html, "data-cellexia-tpl")) {
    const raw = attributeValue(tag, "data-cellexia-tpl");
    expect(raw).not.toBeNull();
    const decoded = decodeEntitiesOnce(raw as string);

    // buy-box.js reads this with getAttribute (one decode) and writes it with
    // textContent, so anything left encoded would print as literal entities.
    expect(decoded).not.toContain("&amp;");
    expect(decoded).not.toContain("&lt;");
    expect(decoded).not.toContain("&quot;");
    expect(decoded).not.toContain("&#39;");
    expect(decoded).not.toContain("<!--");
    expect(decoded).not.toContain("app snippet");

    // Templates are emitted BECAUSE they carry a placeholder — except a
    // merchant savingsTemplate, which is always emitted so the JS never
    // overwrites it with the built-in "Save X" label (documented at its use
    // site in cx-buybox-core.liquid).
    if (!/(?:^|\s)data-cellexia-save(?=[\s=>/]|$)/.test(tag)) {
      expect(decoded).toContain("{");
    }
  }
}

/** (e) Setup mode hides the widget from everyone; live mode never gates it. */
function expectLaunchGate(html: string, live: boolean): void {
  const root = rootTag(html);
  expect(root).not.toBeNull();
  const rootMarkup = root as string;

  if (live) {
    expect(rootMarkup).not.toMatch(/(?:^|\s)hidden(?=[\s>=])/);
    expect(rootMarkup).not.toContain("data-cellexia-gated");
    // The preview ribbon only exists while the widget is gated.
    expect(html).not.toContain("data-cellexia-preview-ribbon");
  } else {
    expect(rootMarkup).toMatch(/(?:^|\s)hidden(?=[\s>=])/);
    expect(rootMarkup).toContain('data-cellexia-gated="true"');
    expect(html).toContain("data-cellexia-preview-ribbon");
    // …and the ribbon itself stays hidden until buy-box.js validates a token.
    const ribbon = tagsWithAttribute(html, "data-cellexia-preview-ribbon")[0];
    expect(ribbon).toMatch(/(?:^|\s)hidden(?=[\s>]|$)/);
  }
}

/** (d) One root, the right preset, a real plan id on the hidden input. */
function expectStructure(html: string, preset: PresetKey): void {
  expect(countOccurrences(html, "data-cellexia-buybox")).toBe(1);
  const root = rootTag(html) as string;
  expect(attributeValue(root, "data-cellexia-preset")).toBe(preset);
  expect(root).toContain(`class="cx-buybox cx-buybox--${preset}`);

  const planInputs = tagsWithAttribute(html, "data-cellexia-selling-plan");
  expect(planInputs).toHaveLength(1);
  const planInput = planInputs[0];
  expect(attributeValue(planInput, "type")).toBe("hidden");
  // The mirror is deliberately NON-SUBMITTING (no name attribute). Shopify's
  // cart parser honours the LAST field named selling_plan in a form, and the
  // app embed can move this widget INTO the theme's product form — where a
  // named mirror would silently out-vote the single field buy-box.js keeps in
  // sync, adding a subscription for a shopper who chose one-time. buy-box.js
  // owns the only named field; this one only mirrors the resolved plan id.
  expect(attributeValue(planInput, "name")).toBeNull();
  expect(ALL_PLAN_IDS).toContain(attributeValue(planInput, "value"));
  expect(attributeValue(planInput, "value")).toBe(DEFAULT_PLAN_ID);

  // The JSON island must be parseable — buy-box.js reads every price from it.
  const island = parseJsonIsland(html);
  expect(island.initialPlan).toBe(DEFAULT_PLAN_ID);
  expect(island.initialVariant).toBe(String(FIXTURE.variantIds.small));
  expect(Object.keys(island.variants)).toEqual([
    String(FIXTURE.variantIds.small),
    String(FIXTURE.variantIds.large),
  ]);
  for (const variant of Object.values(island.variants)) {
    expect(Object.keys(variant.plans)).toEqual(ALL_PLAN_IDS);
  }
}

/**
 * (d) Both purchase options are offered. Presets express them differently;
 * inline and value_stack deliberately demote the one-time purchase, so they
 * are asserted through the control that actually carries it.
 */
function expectPurchaseOptions(html: string, preset: PresetKey): void {
  const text = visibleText(html);

  switch (preset) {
    case "toggle":
      expect(html).toContain('data-cellexia-tab="subscription"');
      expect(html).toContain('data-cellexia-panel="subscription"');
      expect(html).toContain('data-cellexia-tab="one_time"');
      expect(html).toContain('data-cellexia-panel="one_time"');
      expect(html).toContain("data-cellexia-onetime-price");
      expect(text).toContain("One-time");
      break;

    case "inline":
      // One checkbox row: subscription on = checked, one-time = unchecked.
      expect(tagsWithAttribute(html, "data-cellexia-inline")).toHaveLength(1);
      expect(attributeValue(tagsWithAttribute(html, "data-cellexia-inline")[0], "type")).toBe(
        "checkbox",
      );
      expect(html).toContain('data-cellexia-option-wrap="subscription"');
      expect(html).toContain('data-cellexia-panel="subscription"');
      break;

    case "value_stack":
      expect(html).toContain('data-cellexia-option="subscription"');
      // One-time demoted to a text link: assert the link and its label.
      expect(html).toContain('data-cellexia-option="one_time"');
      expect(html).toContain("cx-buybox__stack-onetime-link");
      expect(text).toMatch(/or buy once for CHF \d/);
      break;

    case "subscription_max":
    case "subscription_ultra_max":
      // The subscription card IS the buy box; one-time is a quiet underlined
      // link below it — but still a REAL radio in the same group, with its
      // price visible in the link before selection (compliance guardrail;
      // tests/liquid/subscription-max.test.ts and
      // tests/liquid/subscription-ultra-max.test.ts own the full contracts).
      expect(html).toContain('data-cellexia-option="subscription"');
      expect(html).toContain('data-cellexia-option="one_time"');
      expect(html).toContain("cx-buybox__submax-link");
      expect(html).toContain("data-cellexia-onetime-price");
      expect(text).toMatch(/or buy once for CHF \d/);
      if (preset === "subscription_ultra_max") {
        // The quiet line doubles as the relocatable satellite.
        expect(html).toContain("cx-buybox-satellite");
        expect(html).toContain("data-cellexia-satellite");
        expect(html).toContain("data-cellexia-for");
      }
      break;

    default:
      expect(html).toContain('data-cellexia-option="subscription"');
      expect(html).toContain('data-cellexia-option="one_time"');
      expect(html).toContain("data-cellexia-onetime-price");
      expect(text).toContain("One-time purchase");
      break;
  }
}

/** (f) The frequency control appears exactly when it is switched on. */
function expectFrequencyControl(
  html: string,
  preset: PresetKey,
  showFrequency: boolean,
): void {
  const selects = tagsWithAttribute(html, "data-cellexia-freq");
  const chips = tagsWithAttribute(html, "data-cellexia-freq-chip");

  if (!showFrequency) {
    expect(selects).toHaveLength(0);
    expect(chips).toHaveLength(0);
    expect(html).not.toContain("cx-buybox__freq-select");
    expect(html).not.toContain("cx-buybox__chips");
    expect(html).not.toContain("cx-buybox__chip-label");
    if (preset === "planner") {
      // The planner keeps a single recommended-cadence line instead.
      expect(html).toContain("cx-buybox__planner-cadence");
      expect(visibleText(html)).toContain("Delivery every 8 weeks");
    }
    // …and the default plan is still what add-to-cart will use.
    expect(
      attributeValue(tagsWithAttribute(html, "data-cellexia-selling-plan")[0], "value"),
    ).toBe(DEFAULT_PLAN_ID);
    return;
  }

  // The planner always uses chips; every other preset follows
  // layout.frequencyStyle, which defaults to the dropdown.
  if (preset === "planner") {
    expect(chips).toHaveLength(ALL_PLAN_IDS.length);
    expect(chips.map((chip) => attributeValue(chip, "value"))).toEqual(
      ALL_PLAN_IDS,
    );
    const checked = chips.filter((chip) => /(?:^|\s)checked(?=[\s>]|$)/.test(chip));
    expect(checked).toHaveLength(1);
    expect(attributeValue(checked[0], "value")).toBe(DEFAULT_PLAN_ID);
    expect(html).toContain("cx-buybox__chips");
  } else {
    expect(selects).toHaveLength(1);
    expect(selects[0].startsWith("<select")).toBe(true);
    const options = html.match(/<option value="\d+"[^>]*>/g) ?? [];
    expect(options).toHaveLength(ALL_PLAN_IDS.length);
    expect(
      options.map((option) => attributeValue(option, "value")),
    ).toEqual(ALL_PLAN_IDS);
    const selected = options.filter((option) => /\bselected\b/.test(option));
    expect(selected).toHaveLength(1);
    expect(attributeValue(selected[0], "value")).toBe(DEFAULT_PLAN_ID);
  }
}

/** Everything that must hold for every render, in every configuration. */
function expectUniversalInvariants(html: string): void {
  expectNoAppSnippetLeak(html);
  expectNoDoubleEscaping(html);
  expectNoUnresolvedPlaceholders(html);
  expectRawTemplateAttributes(html);
  // Never leak a Liquid delimiter into the output.
  expect(html).not.toContain("{%");
  expect(html).not.toContain("%}");
}

// ── The matrix ───────────────────────────────────────────────────────────────

describe("buy box golden renders", () => {
  for (const preset of PRESET_KEYS) {
    for (const launchStatus of ["live", "setup"] as const) {
      for (const showFrequency of [true, false]) {
        for (const hasSavings of [true, false]) {
          const name =
            `${preset} · ${launchStatus} · ` +
            `frequency:${showFrequency ? "on" : "off"} · ` +
            `savings:${hasSavings ? "yes" : "no"}`;

          it(name, async () => {
            const html = await renderWidget({
              config: designConfig(preset, { showFrequency }),
              launchStatus,
              hasSavings,
            });

            expectUniversalInvariants(html);
            expectLaunchGate(html, launchStatus === "live");
            expectStructure(html, preset);
            expectPurchaseOptions(html, preset);
            expectFrequencyControl(html, preset, showFrequency);

            expectLiteralAmpersandLabel(html);

            // Savings copy exists only when there is a saving to claim.
            // (inline is the one preset with no savings node — its whole
            // pitch is the "Subscribe & save {percent}" label.)
            const saveNodes = tagsWithAttribute(html, "data-cellexia-save");
            expect(saveNodes.length === 0).toBe(preset === "inline");
            const savingsText = elementTexts(html, "data-cellexia-save");
            const thenText = elementTexts(html, "data-cellexia-then");
            if (hasSavings) {
              for (const value of savingsText) expect(value).toBe("Save 20%");
              for (const value of thenText) {
                expect(value).toBe("then CHF 57.60 every 8 weeks");
              }
            } else {
              for (const value of savingsText) expect(value).toBe("");
              for (const value of thenText) expect(value).toBe("");
              // …and the nodes are hidden, directly or through their row.
              const hiddenish = /(?:^|\s)hidden(?=[\s>]|$)/;
              for (const node of saveNodes) {
                const hidden =
                  hiddenish.test(node) ||
                  tagsWithAttribute(html, "data-cellexia-save-row").some((row) =>
                    hiddenish.test(row),
                  );
                expect(hidden).toBe(true);
              }
            }

            const island = parseJsonIsland(html);
            const plan =
              island.variants[String(FIXTURE.variantIds.small)].plans[
                DEFAULT_PLAN_ID
              ];
            if (hasSavings) {
              expect(plan.savePct).toBe("20%");
              expect(plan.save).toBe("Save 20%");
              expect(plan.then).toBe("then CHF 57.60 every 8 weeks");
              expect(visibleText(html)).toContain("CHF 51.20");
            } else {
              expect(plan.savePct).toBe("");
              expect(plan.save).toBe("");
              expect(plan.then).toBe("");
              expect(visibleText(html)).toContain("CHF 64.00");
            }
          });
        }
      }
    }
  }
});

// ── Launch gate, asserted on its own for every preset ────────────────────────

describe("launch gate", () => {
  it.each([...PRESET_KEYS])(
    "%s renders [hidden][data-cellexia-gated] until the shop is live",
    async (preset) => {
      const gated = await renderWidget({
        config: designConfig(preset),
        launchStatus: "setup",
      });
      expectLaunchGate(gated, false);

      const live = await renderWidget({
        config: designConfig(preset),
        launchStatus: "live",
      });
      expectLaunchGate(live, true);
    },
  );

  it("fails closed when the launch_status metafield is missing entirely", async () => {
    const html = await renderWidget({ launchStatus: null });
    expectLaunchGate(html, false);
  });

  it("fails closed on an unknown launch_status value", async () => {
    const html = await renderWidget({ launchStatus: "paused" });
    expectLaunchGate(html, false);
  });

  /**
   * The gate is a plain Liquid `== 'live'`: no trim, no downcase. A flag that
   * only LOOKS live is dark, and this is the half of the contract the admin
   * side has to model — launchFlagDiverged() in app/lib/launch/launch.server.ts
   * must call every one of these values a divergence while the app is LIVE,
   * and tests/launch-sync.test.ts asserts exactly that over the same list.
   * Until v1.2.3 that function normalised the value first, so " Live " was
   * reported as in-sync while every product page rendered the widget hidden.
   * Both halves are pinned here so they cannot drift apart again.
   */
  it.each([" live ", "live ", " live", "Live", "LIVE", "live\n", ""])(
    "fails closed on a near-miss launch_status value (%j)",
    async (launchStatus) => {
      const html = await renderWidget({ launchStatus });
      expectLaunchGate(html, false);
    },
  );
});

// ── Widget root attribute hygiene ────────────────────────────────────────────

/**
 * The widget root carries two CONDITIONAL attributes — data-section-id (section
 * context only) and the `hidden data-cellexia-gated` pair (gated shops only) — so its
 * opening tag has four shapes. Each conditional sits on its own source line,
 * which puts it one whitespace-control mistake away from either of two bugs:
 *
 *   - trim nothing, and a false condition leaves a whitespace-only line in the
 *     tag. Browsers ignore it, but it is emitted on EVERY render and so lands
 *     in the byte-stable snapshot, adding permanent noise to future diffs.
 *   - trim both sides, and the newline separating two attributes disappears
 *     with the tag, gluing them into one token (id="…"class="…") and silently
 *     dropping an attribute the JS depends on.
 *
 * These assertions pin both edges in all four shapes at once, so neither can
 * come back unnoticed.
 */
describe("widget root attribute list", () => {
  const SHAPES: Array<{
    name: string;
    render: (o: MakeContextOptions) => Promise<string>;
    launchStatus: string;
    sectionId: boolean;
    gated: boolean;
  }> = [
    {
      name: "section + live",
      render: renderWidget,
      launchStatus: "live",
      sectionId: true,
      gated: false,
    },
    {
      name: "section + gated",
      render: renderWidget,
      launchStatus: "setup",
      sectionId: true,
      gated: true,
    },
    {
      name: "embed + live",
      render: renderEmbed,
      launchStatus: "live",
      sectionId: false,
      gated: false,
    },
    {
      name: "embed + gated",
      render: renderEmbed,
      launchStatus: "setup",
      sectionId: false,
      gated: true,
    },
  ];

  it.each(SHAPES)(
    "$name emits no blank attribute slot and no glued attributes",
    async ({ render, launchStatus, sectionId, gated }) => {
      const tag = rootTag(await render({ launchStatus }));
      expect(tag).toBeTruthy();
      const open = tag as string;

      // 1. No whitespace-only line anywhere inside the opening tag. This is
      //    the blank-slot bug; it is what the snapshot would record forever.
      const lines = open.split("\n");
      const blanks = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line, i }) => i > 0 && line.trim() === "");
      expect(
        blanks.map(({ i }) => `line ${i + 1}`),
        `widget root has ${blanks.length} whitespace-only attribute line(s)`,
      ).toEqual([]);

      // 2. The conditional attributes appear exactly when they should, and
      //    each still starts its own line — proof the separating newline
      //    travelled with the attribute rather than being trimmed away.
      const startsOwnLine = (attr: string) =>
        lines.some((line) => line.trim().startsWith(attr));

      expect(open.includes("data-section-id"), "data-section-id").toBe(
        sectionId,
      );
      if (sectionId) expect(startsOwnLine("data-section-id")).toBe(true);

      expect(open.includes("data-cellexia-gated"), "data-cellexia-gated").toBe(gated);
      if (gated) expect(startsOwnLine("hidden data-cellexia-gated")).toBe(true);

      // 3. Nothing glued: an attribute value's closing quote is never followed
      //    immediately by the next attribute name on the same line.
      expect(open.match(/"[a-zA-Z-]+=/g) ?? []).toEqual([]);

      // 4. The attributes the theme price-sync reads survive every shape.
      for (const attr of [
        "data-cellexia-money-onetime",
        "data-cellexia-money-sub",
        "data-cellexia-price-sync",
        "data-cellexia-price-selector",
        "data-cellexia-price-sync-main",
        "data-cellexia-main-selector",
      ]) {
        expect(startsOwnLine(attr), `${attr} on its own line`).toBe(true);
      }
    },
  );
});

// ── Zero-config fallback ─────────────────────────────────────────────────────

describe("zero-config shop (no cellexia.buybox_design metafield)", () => {
  const zeroConfig: MakeContextOptions = { config: null, launchStatus: "live" };

  it("renders the classic preset with the v1.0.0 defaults", async () => {
    const html = await renderWidget(zeroConfig);
    expectUniversalInvariants(html);
    expectStructure(html, "classic");
    expectPurchaseOptions(html, "classic");
    expectFrequencyControl(html, "classic", true);
    expect(attributeValue(rootTag(html) as string, "data-cellexia-preset")).toBe(
      "classic",
    );
    // The block setting's accent (its schema default), not a config accent —
    // and that default must be the brand near-black, identical to the app
    // embed's accent, to --cx-accent in buy-box.css and to
    // DEFAULT_DESIGN_CONFIG.style.accent. The accent is ALWAYS emitted inline
    // and therefore beats the stylesheet, so a sample-palette default here
    // would repaint a no-config install (and every "Force preset: …"
    // override, which discards the published style block) in a colour the
    // brand does not use.
    expect(rootTag(html)).toContain("--cx-accent: #1d1d1b");
  });

  it("defaults the block accent to the same value as the embed", async () => {
    const [section, embed] = await Promise.all([
      renderWidget(zeroConfig),
      renderEmbed({ config: null, launchStatus: "live" }),
    ]);
    const accentOf = (html: string) =>
      /--cx-accent:\s*([^;"]+)/.exec(rootTag(html) as string)?.[1]?.trim().toLowerCase();
    expect(accentOf(section)).toBe("#1d1d1b");
    expect(accentOf(embed)).toBe(accentOf(section));
  });

  it("is byte-stable", async () => {
    const html = await renderWidget(zeroConfig);
    expect(html).toMatchSnapshot();
  });

  it("renders nothing at all for a product with no selling plans", async () => {
    const html = await renderWidget({ noSellingPlans: true });
    // Shopify still emits the app-snippet comment wrapper around an empty
    // render — that is exactly why it must never be captured into a string.
    expect(html.trim()).toBe(
      "<!-- BEGIN app snippet: cx-buybox-core --><!-- END app snippet -->",
    );
    expect(visibleText(html)).toBe("");
    expect(html).not.toContain("data-cellexia-buybox");

    // The embed guards in the block itself, so it emits literally nothing.
    const embed = await renderEmbed({ noSellingPlans: true });
    expect(embed.trim()).toBe("");
  });
});

// ── The widget root's inline style attribute ─────────────────────────────────

/**
 * A published design whose `style` block is overridden. `designConfig` only
 * reaches layout/text; the colour slots need their own door.
 */
function styledConfig(
  style: Partial<WidgetDesignConfig["style"]>,
): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    style: { ...DEFAULT_DESIGN_CONFIG.style, ...style },
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** The widget root's inline style attribute, still escaped. */
function inlineStyle(html: string): string {
  return attributeValue(rootTag(html) as string, "style") ?? "";
}

/** The CSS custom properties it declares, in source order, with duplicates. */
function declaredProperties(html: string): string[] {
  return [...inlineStyle(html).matchAll(/(--[\w-]+)\s*:/g)].map(
    (match) => match[1],
  );
}

/** One property's declared value. */
function declaredValue(html: string, property: string): string | null {
  const match = new RegExp(`${property}\\s*:\\s*([^;]*)`).exec(
    inlineStyle(html),
  );
  return match ? match[1].trim() : null;
}

describe("inline style attribute", () => {
  /**
   * Every custom property gets exactly ONE declaration. Declaring one twice
   * still renders correctly today (last-wins is the CSS rule), but it makes
   * the widget's colours depend on a theme, CDN or minifier preserving the
   * order and both copies of an inline declaration. --cx-accent-soft was the
   * offender: the accent at 7% alpha in the fixed slot, then style.bgTint
   * appended after it, so every shop with a published design shipped both.
   */
  it.each(PRESET_KEYS)(
    "%s declares every custom property exactly once",
    async (preset) => {
      for (const config of [
        null,
        designConfig(preset),
        styledConfig({ bgTint: "", text: "", badgeBg: "" }),
        styledConfig({ bgTint: "#FFEEDD", fontScale: 1.1 }),
      ]) {
        const html = await renderWidget({ config, launchStatus: "live" });
        const properties = declaredProperties(html);
        expect(properties.length).toBeGreaterThan(0);
        expect(
          properties.filter(
            (property, index) => properties.indexOf(property) !== index,
          ),
          `${preset} declares a custom property twice: ${properties.join(", ")}`,
        ).toEqual([]);
      }
    },
  );

  it("resolves --cx-accent-soft to style.bgTint when the merchant set one", async () => {
    const html = await renderWidget({
      config: styledConfig({ accent: "#1D1D1B", bgTint: "#FFEEDD" }),
      launchStatus: "live",
    });
    expect(declaredValue(html, "--cx-accent-soft")).toBe("#FFEEDD");
  });

  it('falls back to the accent at 7% alpha when bgTint is "" (inherit)', async () => {
    const html = await renderWidget({
      config: styledConfig({ accent: "#1D1D1B", bgTint: "" }),
      launchStatus: "live",
    });
    expect(declaredValue(html, "--cx-accent-soft")).toBe(
      "rgba(29, 29, 27, 0.07)",
    );
  });

  it("uses the accent-derived fallback on a zero-config shop", async () => {
    const html = await renderWidget({ config: null, launchStatus: "live" });
    expect(declaredValue(html, "--cx-accent")).toBe("#1d1d1b");
    expect(declaredValue(html, "--cx-accent-soft")).toBe(
      "rgba(29, 29, 27, 0.07)",
    );
  });

  it("matches the admin preview's rule (bgTint || accent at 7%)", () => {
    // The designer's live preview must not disagree with the storefront about
    // which of the two values wins, or the merchant designs against a lie.
    const source = readFileSync(
      join(REPO_ROOT, "app", "components", "buybox-preview.tsx"),
      "utf8",
    );
    expect(
      source,
      "app/components/buybox-preview.tsx no longer resolves --cx-accent-soft " +
        "as bgTint || accent@7%; cx-buybox-core.liquid still does",
    ).toMatch(
      /"--cx-accent-soft":\s*style\.bgTint\s*\|\|\s*hexToRgba\(\s*style\.accent\s*,\s*0\.07\s*\)/,
    );
  });

  /**
   * color_modify returns its input UNCHANGED when the value is not a colour,
   * so the soft fill needs the same escape the accent has: without it a
   * hand-edited cellexia.buybox_design metafield breaks out of the attribute.
   * The zod schema rejects this value on publish — this is the belt the file's
   * own strip_html/escape comment promises for the metafield edited by hand.
   */
  it("escapes a hand-edited accent in BOTH slots", async () => {
    const html = await renderWidget({
      config: {
        preset: "classic",
        style: { accent: '#000" onmouseover="alert(1)', bgTint: "" },
      },
      launchStatus: "live",
    });
    expect(html).toContain(
      '--cx-accent: #000&quot; onmouseover=&quot;alert(1); ' +
        '--cx-accent-soft: #000&quot; onmouseover=&quot;alert(1);',
    );
    expect(html).not.toContain('onmouseover="alert(1)');
  });
});

// ── Locale + merchant text overrides ─────────────────────────────────────────

describe("copy resolution", () => {
  it("follows the storefront locale (fr)", async () => {
    const html = await renderWidget({
      config: designConfig("classic"),
      locale: "fr",
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    const text = visibleText(html);
    expect(text).toContain("Abonnez-vous et économisez");
    expect(text).toContain("Achat unique");
    expect(text).toContain("Économisez 20%");
    expect(text).not.toContain("translation missing");
  });

  it("prefers a locale-keyed config override over the locale file", async () => {
    const html = await renderWidget({
      config: designConfig(
        "classic",
        {},
        {
          en: { heading: "Choose your ritual" },
          fr: {
            heading: "Choisissez votre rituel & économisez",
            subscribeLabel: "Abonnement & économies",
          },
        },
      ),
      locale: "fr",
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    const text = visibleText(html);
    // Single-escaped: the ampersand survives as one character.
    expect(text).toContain("Choisissez votre rituel & économisez");
    expect(text).toContain("Abonnement & économies");
    expect(text).not.toContain("Choose your ritual");
  });

  it("applies config.text overrides, keeping placeholders resolvable", async () => {
    const html = await renderWidget({
      config: designConfig(
        "value_stack",
        { showBenefits: true, benefitCount: 3 },
        {
          en: {
            heading: "Your ritual & your rhythm",
            subheading: "Save {percent} on every delivery",
            subscribeLabel: "Subscribe & save {percent}",
            savingsTemplate: "You keep {amount}",
            oneTimeLinkLabel: "or buy once for {amount}",
            benefits: ["First delivery bonus", "Ongoing savings", "Free gifts"],
          },
        },
      ),
      launchStatus: "live",
    });

    expectUniversalInvariants(html);
    const text = visibleText(html);
    expect(text).toContain("Your ritual & your rhythm");
    expect(text).toContain("Save 20% on every delivery");
    expect(text).toContain("Subscribe & save 20%");
    expect(text).toContain("or buy once for CHF 64.00");
    expect(text).toContain("First delivery bonus");
    expect(text).toContain("Free gifts");

    // The RAW templates travel to buy-box.js in data-cellexia-tpl, unescaped once.
    const templates = attributeValues(html, "data-cellexia-tpl").map(
      decodeEntitiesOnce,
    );
    expect(templates).toContain("Subscribe & save {percent}");
    expect(templates).toContain("or buy once for {amount}");
    expect(templates).toContain("You keep {amount}");
  });

  it("overrides the reassurance line on the presets that show one", async () => {
    const html = await renderWidget({
      config: designConfig(
        "classic",
        {},
        { en: { reassurance: "Skip, pause & cancel anytime" } },
      ),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(visibleText(html)).toContain("Skip, pause & cancel anytime");
    expect(visibleText(html)).not.toContain("Skip, pause or cancel anytime.");
  });

  it("ignores blank overrides instead of blanking storefront copy", async () => {
    const html = await renderWidget({
      config: designConfig("classic", {}, { en: { heading: "   " } }),
      launchStatus: "live",
    });
    expect(visibleText(html)).toContain("Choose your ritual");
  });

  it("keeps a savings template out of the page when there is no saving", async () => {
    const html = await renderWidget({
      config: designConfig(
        "classic",
        {},
        { en: { savingsTemplate: "You keep {amount}" } },
      ),
      hasSavings: false,
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    const saveNode = tagsWithAttribute(html, "data-cellexia-save")[0];
    expect(saveNode).toMatch(/(?:^|\s)hidden(?=[\s>]|$)/);
    expect(visibleText(html)).not.toContain("You keep");
  });
});

// ── Layout knobs that carry their own markup ─────────────────────────────────

describe("layout knobs", () => {
  it("showCompareAt struck-prices the one-time price next to the subscription", async () => {
    const html = await renderWidget({
      config: designConfig("classic", { showCompareAt: true }),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(html).toContain("data-cellexia-compare");
    expect(html).toContain('<s class="cx-price__compare">');
    // buy-box.js recreates this node on variant change with the same class.
    expect(readAsset("buy-box.js")).toContain("cx-price__compare");
  });

  it("order=one_time_first swaps the cards without changing the plan", async () => {
    const html = await renderWidget({
      config: designConfig("classic", { order: "one_time_first" }),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    const subIndex = html.indexOf('data-cellexia-option-wrap="subscription"');
    const oneTimeIndex = html.indexOf('data-cellexia-option-wrap="one_time"');
    expect(oneTimeIndex).toBeGreaterThan(-1);
    expect(oneTimeIndex).toBeLessThan(subIndex);
    expect(
      attributeValue(tagsWithAttribute(html, "data-cellexia-selling-plan")[0], "value"),
    ).toBe(DEFAULT_PLAN_ID);
  });

  it("frequencyStyle=chips renders chips instead of the select", async () => {
    const html = await renderWidget({
      config: designConfig("classic", { frequencyStyle: "chips" }),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(tagsWithAttribute(html, "data-cellexia-freq-chip")).toHaveLength(3);
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
  });

  it("showBadge=false and showSavings=false remove their nodes", async () => {
    const html = await renderWidget({
      config: designConfig("classic", {
        showBadge: false,
        showSavings: false,
      }),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(html).not.toContain("cx-buybox__badge");
    expect(tagsWithAttribute(html, "data-cellexia-save")).toHaveLength(0);
  });

  it("a single-plan group never renders a frequency control", async () => {
    const html = await renderWidget({
      config: designConfig("planner"),
      planCount: 1,
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(tagsWithAttribute(html, "data-cellexia-freq")).toHaveLength(0);
    expect(tagsWithAttribute(html, "data-cellexia-freq-chip")).toHaveLength(0);
    expect(
      attributeValue(tagsWithAttribute(html, "data-cellexia-selling-plan")[0], "value"),
    ).toBe(String(FIXTURE.planIds.weeks4));
  });

  it("a prepaid plan states the per-delivery price", async () => {
    const html = await renderWidget({
      config: designConfig("classic"),
      prepaid: true,
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    const perDelivery = tagsWithAttribute(html, "data-cellexia-per-delivery")[0];
    expect(perDelivery).not.toMatch(/(?:^|\s)hidden(?=[\s>]|$)/);
    expect(visibleText(html)).toContain("CHF 25.60 per delivery");
  });

  /**
   * A real catalog can hand the block an allocation with NO per_delivery_price
   * (nil, not 0). The widget then knows of no per-delivery price, so it must
   * claim none — and where it prints one unconditionally (the tiles compare
   * row, the planner row) it must fall back to the charge price, which is what
   * buy-box.js does for every variant/plan change after the first render.
   */
  describe("an allocation that states no per-delivery price", () => {
    const noPd: MakeContextOptions = {
      omitPerDeliveryPrice: true,
      launchStatus: "live",
    };

    it("never claims a per-delivery price it was not given", async () => {
      const html = await renderWidget({ ...noPd, config: designConfig("classic") });
      expectUniversalInvariants(html);
      const perDelivery = tagsWithAttribute(html, "data-cellexia-per-delivery")[0];
      expect(perDelivery).toMatch(/(?:^|\s)hidden(?=[\s>]|$)/);
      expect(elementTexts(html, "data-cellexia-per-delivery")).toEqual([""]);
      expect(visibleText(html)).not.toContain("per delivery");
    });

    it("falls back to the charge price in the rows that always print one", async () => {
      for (const preset of ["tiles", "planner"] as const) {
        const html = await renderWidget({ ...noPd, config: designConfig(preset) });
        expectUniversalInvariants(html);
        const rows = elementTexts(html, "data-cellexia-pd-price");
        // CHF 51.20 is the first-order charge for the 30 ml variant.
        for (const row of rows) expect(row).toBe("CHF 51.20");
        expect(visibleText(html)).not.toContain("CHF 0.00");
      }
    });

    it("keeps the JSON island honest (empty perDelivery, pd = first)", async () => {
      const html = await renderWidget({ ...noPd, config: designConfig("classic") });
      const island = parseJsonIsland(html);
      for (const variant of Object.values(island.variants)) {
        for (const plan of Object.values(variant.plans)) {
          expect(plan.perDelivery).toBe("");
          expect(plan.pd).toBe(plan.first);
        }
      }
    });

    it("still states it for a real prepaid plan", async () => {
      const html = await renderWidget({
        config: designConfig("classic"),
        prepaid: true,
        launchStatus: "live",
      });
      expect(visibleText(html)).toContain("CHF 25.60 per delivery");
    });
  });

  /**
   * A product only partly added to the selling plan group: the variant the
   * page opens on has no allocation, so no subscription exists for it. The
   * markup still lists the group's cadences (buy-box.js needs them for the
   * variants that DO subscribe), so the root has to carry the class the CSS
   * hides the subscription fragments with — from the server, not only after
   * buy-box.js repaints.
   */
  describe("a variant with no allocation in the group", () => {
    it.each(PRESET_KEYS)("%s marks the root cx-buybox--no-sub", async (preset) => {
      const html = await renderWidget({
        config: designConfig(preset),
        selectedVariantHasNoAllocations: true,
        launchStatus: "live",
      });
      expectUniversalInvariants(html);
      expect(rootTag(html)).toContain("cx-buybox--no-sub");
      // The JSON island agrees: no plans for that variant, plans for the other.
      const island = parseJsonIsland(html);
      expect(Object.keys(island.variants[island.initialVariant].plans)).toEqual(
        [],
      );
      const other = Object.entries(island.variants).find(
        ([id]) => id !== island.initialVariant,
      );
      expect(Object.keys(other?.[1].plans ?? {})).toEqual(ALL_PLAN_IDS);
    });

    it("keeps the class off a variant that does subscribe", async () => {
      const html = await renderWidget({
        config: designConfig("classic"),
        launchStatus: "live",
      });
      expect(rootTag(html)).not.toContain("cx-buybox--no-sub");
    });

    it.each(PRESET_KEYS)(
      "%s leaves data-cellexia-money-sub EMPTY (nothing to promise the theme)",
      async (preset) => {
        /* The theme price-sync reads these two attributes verbatim:
           buy-box.js does `root.getAttribute('data-cellexia-money-sub') || ''`
           and swaps the theme's add-to-cart price to it. For a variant with no
           allocation there IS no subscription price, so a non-empty value here
           would put a price on the theme's button that the shopper can never
           be charged. The snippet documents the attribute as empty in this
           state; this is that sentence made executable. */
        const tag = rootTag(
          await renderWidget({
            config: designConfig(preset),
            selectedVariantHasNoAllocations: true,
            launchStatus: "live",
          }),
        ) as string;
        expect(attributeValue(tag, "data-cellexia-money-sub")).toBe("");
        // The one-time string is still there — the sync's "restore" side.
        expect(
          attributeValue(tag, "data-cellexia-money-onetime"),
        ).not.toBe("");
      },
    );

    it("populates data-cellexia-money-sub when the variant does subscribe", async () => {
      /* Vacuity guard for the rule above: the empty assertion must fail when
         a subscription genuinely exists, or it proves nothing. */
      const tag = rootTag(
        await renderWidget({
          config: designConfig("classic"),
          launchStatus: "live",
        }),
      ) as string;
      const sub = attributeValue(tag, "data-cellexia-money-sub");
      expect(sub).not.toBe("");
      expect(sub).not.toBeNull();
      expect(attributeValue(tag, "data-cellexia-money-onetime")).not.toBe(sub);
    });

    it("is the same class buy-box.js toggles", () => {
      expect(readAsset("buy-box.js")).toContain("'cx-buybox--no-sub'");
      expect(readAsset("buy-box.css")).toContain(".cx-buybox--no-sub");
    });
  });

  it("a subscription-only product drops the one-time option entirely", async () => {
    const html = await renderWidget({
      config: designConfig("classic"),
      requiresSellingPlan: true,
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expect(html).not.toContain('data-cellexia-option="one_time"');
    expect(html).toContain('data-cellexia-option="subscription"');
    expect(parseJsonIsland(html).requiresSellingPlan).toBe(true);
    expect(
      attributeValue(tagsWithAttribute(html, "data-cellexia-selling-plan")[0], "value"),
    ).toBe(DEFAULT_PLAN_ID);
  });
});

// ── (h) Liquid ⇄ JS contract ─────────────────────────────────────────────────

/**
 * DOM hooks buy-box.js looks up that are NOT rendered by Liquid, with the
 * reason each one is exempt. Anything else the JS queries must exist in the
 * markup, or the widget is silently inert on the storefront.
 */
const JS_MANAGED_HOOKS: Record<string, string> = {
  "data-cellexia-init": "set by buy-box.js on the root to make init() idempotent",
  "data-cellexia-preview":
    "set by buy-box.js when a validated ?cx_preview= token reveals the widget",
  "data-cellexia-design-prop":
    "the properties[_cellexia_design] input buy-box.js injects into the THEME's form",
  "data-cellexia-plan-input":
    "the ONE selling_plan field buy-box.js owns in the THEME's form " +
    "(created there, or the theme's own input adopted) — the widget's own " +
    "server-rendered mirror is nameless and never submitted",
  "data-cellexia-mounted":
    "set by buy-box-embed.js on the embed wrapper once it has been moved " +
    "into the buy column",
  "data-cellexia-unsynced":
    "set by buy-box.js when the theme switches to a variant the island has " +
    "no row for (added after plan sync): the widget parks — [hidden], form " +
    "released — until a known variant returns",
};

/** Hooks that live on the embed wrapper, not on the widget itself. */
const EMBED_WRAPPER_HOOKS = new Set([
  "data-cellexia-embed",
  "data-cellexia-anchor",
  "data-cellexia-anchor-pos",
  // buy-box.js qualifies its wrapper lookups with the wrapper's own class
  // (.cx-buybox-embed[data-cellexia-embed]) so a foreign [data-*] element can
  // never be adopted; the class is rendered by blocks/buy-box-embed.liquid.
  ".cx-buybox-embed",
]);

describe("Liquid ⇄ JS DOM contract", () => {
  /** Markup covering every branch that can emit a hook. */
  async function renderAllMarkup(): Promise<string> {
    const renders = await Promise.all([
      ...PRESET_KEYS.map((preset) =>
        renderWidget({
          config: designConfig(preset, {
            showBenefits: true,
            showCompareAt: true,
          }),
          launchStatus: "live",
        }),
      ),
      // Gated markup carries the launch-gate + preview-ribbon hooks.
      renderWidget({ config: designConfig("classic"), launchStatus: "setup" }),
      // Chips on a non-planner preset.
      renderWidget({
        config: designConfig("classic", { frequencyStyle: "chips" }),
        launchStatus: "live",
      }),
      // A merchant savingsTemplate emits data-cellexia-tpl on the savings node.
      renderWidget({
        config: designConfig(
          "classic",
          {},
          { en: { savingsTemplate: "You keep {amount}" } },
        ),
        launchStatus: "live",
      }),
      // A product carrying only ANOTHER app's selling plan group: the widget
      // renders nothing but the admin-only no-owned-group marker, which
      // buy-box.js looks up to raise its diagnostic.
      renderWidget({ foreignGroupOnly: true, launchStatus: "live" }),
    ]);
    return renders.join("\n");
  }

  it("renders every data-cellexia-* hook assets/buy-box.js looks up", async () => {
    const markup = await renderAllMarkup();
    const tokens = domContractTokens(readAsset("buy-box.js"));
    expect(tokens.length).toBeGreaterThan(10);

    const missing = tokens.filter((token) => {
      if (token in JS_MANAGED_HOOKS) return false;
      if (EMBED_WRAPPER_HOOKS.has(token)) return false;
      return !markup.includes(token.startsWith(".") ? token.slice(1) : token);
    });

    expect(
      missing,
      `assets/buy-box.js queries DOM hooks the Liquid never renders: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("renders every data-cellexia-* hook assets/buy-box-embed.js looks up", async () => {
    const [embed, widget, ultra] = await Promise.all([
      renderEmbed({ config: designConfig("classic"), launchStatus: "live" }),
      renderWidget({ config: designConfig("classic"), launchStatus: "live" }),
      // The subscription_ultra_max satellite (.cx-buybox-satellite
      // [data-cellexia-satellite]) is markup the embed's variant scan must
      // SKIP as "ours" — its hooks render only in that preset.
      renderWidget({
        config: designConfig("subscription_ultra_max"),
        launchStatus: "live",
      }),
    ]);
    const markup = `${embed}\n${widget}\n${ultra}`;
    const tokens = domContractTokens(readAsset("buy-box-embed.js"));

    const missing = tokens.filter((token) => {
      if (token in JS_MANAGED_HOOKS) return false;
      return !markup.includes(token.startsWith(".") ? token.slice(1) : token);
    });

    expect(
      missing,
      `assets/buy-box-embed.js queries DOM hooks the Liquid never renders: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("keeps the JS-managed exemption list honest", () => {
    const source = readAsset("buy-box.js");
    for (const hook of Object.keys(JS_MANAGED_HOOKS)) {
      expect(source).toContain(hook);
    }
  });
});

// ── App embed (the install path used on cellexialabs.com) ────────────────────

describe("app embed", () => {
  it("wraps the identical widget in a hidden, anchored mount point", async () => {
    const html = await renderEmbed({
      config: designConfig("classic"),
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expectStructure(html, "classic");

    const wrapper = tagsWithAttribute(html, "data-cellexia-embed")[0];
    expect(wrapper).toBeDefined();
    expect(wrapper).toMatch(/(?:^|\s)hidden(?=[\s>]|$)/);
    expect(attributeValue(wrapper, "data-cellexia-anchor")).toBe("");
    expect(attributeValue(wrapper, "data-cellexia-anchor-pos")).toBe("before");

    // The embed has no section to scope the product-form lookup to.
    expect(rootTag(html)).not.toContain("data-section-id");
    expect(html).toContain("buy-box.js");
    expect(html).toContain("buy-box-embed.js");
  });

  it("keeps the launch gate on the inner widget, not just the wrapper", async () => {
    const html = await renderEmbed({
      config: designConfig("classic"),
      launchStatus: "setup",
    });
    expectLaunchGate(html, false);
  });

  it("takes its anchor from the published placement config", async () => {
    const config = designConfig("classic");
    config.placement = { mode: "selector", selector: ".pdp__grey", position: "before" };
    const html = await renderEmbed({ config, launchStatus: "live" });
    const wrapper = tagsWithAttribute(html, "data-cellexia-embed")[0];
    expect(attributeValue(wrapper, "data-cellexia-anchor")).toBe(".pdp__grey");
  });

  it("lets the theme-editor anchor setting win over the config", async () => {
    const config = designConfig("classic");
    config.placement = { mode: "selector", selector: ".pdp__grey", position: "before" };
    const html = await renderEmbed({
      config,
      launchStatus: "live",
      blockSettings: {
        custom_anchor_selector: ".pdp__info",
        anchor_position: "append",
      },
    });
    const wrapper = tagsWithAttribute(html, "data-cellexia-embed")[0];
    expect(attributeValue(wrapper, "data-cellexia-anchor")).toBe(".pdp__info");
    expect(attributeValue(wrapper, "data-cellexia-anchor-pos")).toBe("append");
  });

  it("renders nothing off the product page", async () => {
    const html = await renderEmbed({ pageType: "collection" });
    expect(html.trim()).toBe("");
  });

  /**
   * cellexialabs.com installs the EMBED (its product section takes no app
   * blocks), so the embed path gets the same golden treatment as the block.
   */
  describe.each([...PRESET_KEYS])("%s preset", (preset) => {
    it.each(["live", "setup"] as const)("renders correctly (%s)", async (launchStatus) => {
      const html = await renderEmbed({
        config: designConfig(preset),
        launchStatus,
      });
      expectUniversalInvariants(html);
      expectLiteralAmpersandLabel(html);
      expectLaunchGate(html, launchStatus === "live");
      expectStructure(html, preset);
      expectPurchaseOptions(html, preset);
      expectFrequencyControl(html, preset, true);
    });
  });

  it("renders markup identical to the app block", async () => {
    const config = designConfig("classic");
    const [section, embed] = await Promise.all([
      renderWidget({
        config,
        launchStatus: "live",
        blockSettings: { accent_color: "#1D1D1B" },
      }),
      renderEmbed({ config, launchStatus: "live" }),
    ]);

    // Same snippet, same settings ⇒ the only permitted difference is the
    // data-section-id the embed cannot have (it has no section to scope the
    // product-form lookup to).
    const widgetOnly = (html: string) =>
      html
        .slice(
          html.indexOf("<!-- BEGIN app snippet"),
          html.lastIndexOf("<!-- END app snippet -->"),
        )
        .replace(/\s+data-section-id="[^"]*"/g, "")
        .replace(/\s+/g, " ");

    expect(widgetOnly(embed)).toBe(widgetOnly(section));
  });
});

// ── Forced presets (the theme-editor emergency override) ─────────────────────

describe("design_source override", () => {
  it.each([...PRESET_KEYS])("forces the %s preset over the published config", async (preset) => {
    const html = await renderWidget({
      config: designConfig("classic"),
      blockSettings: { design_source: preset },
      launchStatus: "live",
    });
    expectUniversalInvariants(html);
    expectStructure(html, preset);
  });

  it("falls back to classic for an unknown preset key", async () => {
    const html = await renderWidget({
      blockSettings: { design_source: "not_a_preset" },
      launchStatus: "live",
    });
    expectStructure(html, "classic");
  });
});

// ── Money formats that legitimately contain HTML entities ────────────────────

/**
 * Shopify's stock money_format embeds HTML entities for several currencies
 * ("&pound;{{amount}}", "&euro;{{amount_with_comma_separator}}", and the
 * widely used "{{amount}}&nbsp;<code>"), and `strip_html` removes TAGS, never
 * entities. So a money string is SAFE the moment it is formatted, and any
 * pipeline that escapes it a second time prints the entity as literal page
 * text — the same defect the client already saw with "Subscribe &amp; Save",
 * one currency away.
 *
 * The trap is `| t` with named arguments: the filter escapes what it
 * interpolates, so `'then_price' | t: price: <money>` double-escapes the
 * money. The templates therefore pass t inert "{price}"/"{amount}"
 * placeholders and substitute the real values afterwards; these tests hold
 * that line for the two composed lines that carry money.
 */
describe("entity-bearing money formats", () => {
  const moneyFormat = "{{amount}}&nbsp;CHF";

  it("never escapes a money entity a second time", async () => {
    const html = await renderWidget({
      config: designConfig("classic"),
      launchStatus: "live",
      moneyFormat,
    });

    expectUniversalInvariants(html);
    // The signature of the bug: the entity's "&" escaped again.
    expect(html).not.toContain("&amp;nbsp;");

    // Decoding the page ONCE yields a real non-breaking space, not an entity.
    const text = visibleText(html);
    expect(text).not.toContain("&nbsp;");
    expect(text).toContain("then 57.60 CHF every 8 weeks");
    expect(text).toContain("Save 20%");
  });

  it("keeps the composed money lines readable in every preset", async () => {
    for (const preset of PRESET_KEYS) {
      const html = await renderWidget({
        config: designConfig(preset),
        launchStatus: "live",
        moneyFormat,
      });
      expect(html, preset).not.toContain("&amp;nbsp;");
      for (const value of elementTexts(html, "data-cellexia-then")) {
        expect(value, preset).toBe("then 57.60 CHF every 8 weeks");
      }
    }
  });

  it("carries no double-escaped money into the JSON island", async () => {
    const html = await renderWidget({
      config: designConfig("classic"),
      launchStatus: "live",
      moneyFormat,
    });
    const island = parseJsonIsland(html);
    const plan =
      island.variants[String(FIXTURE.variantIds.small)].plans[DEFAULT_PLAN_ID];
    // buy-box.js writes these with textContent, so "&amp;" would surface as
    // literal characters exactly like the reported defect.
    for (const value of [plan.first, plan.then, plan.save, plan.pd, plan.freq]) {
      expect(value).not.toContain("&amp;");
    }
    expect(plan.save).toBe("Save 20%");
    expect(plan.then.startsWith("then 57.60")).toBe(true);
    expect(plan.then.endsWith("CHF every 8 weeks")).toBe(true);
  });

  it("island money is parser-decoded RAW (real NBSP) — never the literal entity", async () => {
    // <script> is a raw-text element: the browser decodes entities in the
    // data-cellexia-money-* attributes (getAttribute) and in the theme's own
    // text nodes, but NEVER inside the island. If the island shipped SAFE
    // money, JSON.parse would yield "64.00&nbsp;CHF" with a literal ampersand:
    // render() paints "&nbsp;" as six visible characters on every price line
    // and the theme add-to-cart swap's indexOf never matches the button.
    const NBSP = " ";
    const html = await renderWidget({
      config: designConfig("classic"),
      launchStatus: "live",
      moneyFormat,
    });
    const island = parseJsonIsland(html);
    const variant = island.variants[String(FIXTURE.variantIds.small)];
    const plan = variant.plans[DEFAULT_PLAN_ID];

    // Byte-for-byte the strings the browser decodes elsewhere on the page.
    expect(variant.oneTime).toBe(`64.00${NBSP}CHF`);
    expect(plan.first).toBe(`51.20${NBSP}CHF`);
    expect(plan.pd).toBe(`51.20${NBSP}CHF`);
    expect(plan.then).toBe(`then 57.60${NBSP}CHF every 8 weeks`);

    for (const value of [
      variant.oneTime,
      plan.first,
      plan.then,
      plan.save,
      plan.pd,
      plan.perDelivery,
      plan.freq,
    ]) {
      expect(String(value)).not.toContain("&nbsp;");
    }

    // The island pair must equal the browser-decoded root attributes — the
    // two sources priceSync mixes (island preferred, attributes fallback).
    expect(variant.oneTime).toBe(
      decodeEntitiesOnce(attributeValues(html, "data-cellexia-money-onetime")[0] ?? ""),
    );
    expect(plan.first).toBe(
      decodeEntitiesOnce(attributeValues(html, "data-cellexia-money-sub")[0] ?? ""),
    );
  });

  it("decodes the currency-symbol entities of Shopify's stock formats", async () => {
    for (const [format, expected] of [
      ["&pound;{{amount}}", "£64.00"],
      ["&euro;{{amount}}", "€64.00"],
    ] as const) {
      const html = await renderWidget({
        config: designConfig("classic"),
        launchStatus: "live",
        moneyFormat: format,
      });
      const island = parseJsonIsland(html);
      expect(
        island.variants[String(FIXTURE.variantIds.small)].oneTime,
        format,
      ).toBe(expected);
    }
  });
});

// ── Group ownership: running alongside another subscription app ──────────────

/**
 * THE BUG THIS SUITE EXISTS FOR (reported live, cellexialabs.com).
 *
 * The client's store already runs Joy Subscriptions, whose selling plan group
 * sits FIRST on the product and offers 5% off. The widget used to take
 * `product.selling_plan_groups | first` and then look for a group whose NAME
 * contained "cellexia", so on that product it resolved to JOY's group: Joy's
 * discount on the page, Joy's frequencies in the selector, and Joy's selling
 * plan id in the hidden mirror, in the JSON island and therefore in the cart.
 * Every subscription bought through our buy box would have become a contract
 * belonging to another app, and editing our own plan changed nothing —
 * exactly what the merchant reported.
 *
 * The fix is an allow-list published by the app (shop metafield
 * cellexia.plan_groups), and one absolute rule: render OUR group, or render
 * NOTHING. There is no "closest match", and no fallback to the first group.
 *
 * WHAT PROVES A GROUP OURS: its PLAN ids. Storefront Liquid exposes selling
 * plan GROUP ids in a different id space than the Admin API (opaque
 * storefront identifiers vs the numeric admin ids the metafield carries), so
 * the published groupIds can never match a Liquid group id — plan ids are
 * numeric and identical in both APIs, and the intersection with planIds is
 * the ownership test. The legacy group-id equality survives only as a
 * harmless secondary OR. tests/liquid/two-apps.test.ts owns the full id-space
 * story; the harness models both spaces.
 */
describe("selling plan group ownership", () => {
  /** The plan ids the rendered markup would put in a cart. */
  function planIdsInMarkup(html: string): string[] {
    const island = parseJsonIsland(html);
    const fromIsland = new Set<string>();
    for (const variant of Object.values(island.variants)) {
      for (const planId of Object.keys(variant.plans)) fromIsland.add(planId);
    }
    for (const value of attributeValues(html, "value")) {
      if (/^\d{6,}$/.test(value)) fromIsland.add(value);
    }
    return [...fromIsland].sort();
  }

  const FOREIGN_PLAN_ID = String(FIXTURE.foreignPlanIds.monthly);

  /**
   * Our plan ids, in the string form the metafield carries.
   *
   * These are the load-bearing field: a group is rendered only when `planIds`
   * names one of the plans it actually contains (or, residually, when
   * `groupIds` names its exact Liquid-visible id — a form the app never
   * publishes). An allow-list with no plan ids unlocks nothing at all, so
   * `planIds: []` is a second way of saying "render nothing", and using it
   * would make these tests vacuous.
   */
  const OUR_PLAN_IDS = [...ALL_PLAN_IDS].map(String);

  it("renders OUR group when another app's group comes first", async () => {
    const html = await renderWidget({
      foreignGroupFirst: true,
      launchStatus: "live",
    });

    // The widget renders, and every plan id it can hand the cart is ours.
    expect(rootTag(html)).not.toBeNull();
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(DEFAULT_PLAN_ID);
    expect(planIdsInMarkup(html)).toEqual([...ALL_PLAN_IDS].sort());
    expect(html).not.toContain(FOREIGN_PLAN_ID);
    expect(html).not.toContain(String(FIXTURE.foreignGroupId));

    // Ours discounts 20% on the first order; Joy's group discounts 5%. The
    // page must promise OUR price, from OUR allocation.
    const small = island.variants[String(FIXTURE.variantIds.small)];
    expect(small.plans[DEFAULT_PLAN_ID].first).toBe("CHF 51.20");
    expect(small.plans[DEFAULT_PLAN_ID].save).toBe("Save 20%");
    expect(elementTexts(html, "data-cellexia-save")).toContain("Save 20%");
    // 5% off CHF 64.00 — the number the old code put on the page.
    expect(html).not.toContain("60.80");
  });

  it("VACUITY GUARD: the fixture can render the foreign group", async () => {
    /* Every assertion above is "Joy's plan is not on the page". They would
       all pass just as well against a fixture whose foreign group Liquid
       cannot render at all — and then the suite would be pinning nothing.
       Forge the FULL allow-list — Joy's plan id AND Joy's app id — and the
       widget renders Joy's 5% plan at CHF 60.80: the client's reported
       symptom, reproduced. The ONLY thing standing between that render and
       a shopper is the allow-list.

       Since v1.6.9 TWO fields decide together: `planIds` AND `appId` (the
       forged groupIds entry is admin-numeric and matches no Liquid group id
       — inert either way), so reaching this render means someone wrote a
       metafield naming another app's PLAN and that app's app_id at once —
       nothing this app can produce, since buildPlanGroupsValue() only ever
       emits ids read off our own SellingPlanConfig rows and the publish
       path writes only our own appId. The allow-list cannot make a
       merchant-writable metafield unforgeable, and that is the residual. */
    const html = await renderWidget({
      foreignGroupFirst: true,
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.foreignGroupId)],
        planIds: [FOREIGN_PLAN_ID],
        planSets: [[FOREIGN_PLAN_ID]],
        appId: JOY_GROUP.appId,
      },
      launchStatus: "live",
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(FOREIGN_PLAN_ID);
    expect(
      island.variants[String(FIXTURE.variantIds.small)].plans[FOREIGN_PLAN_ID]
        .save,
    ).toBe("Save 5%");
  });

  it("renders NOTHING when the product carries only another app's group", async () => {
    const html = await renderWidget({
      foreignGroupOnly: true,
      launchStatus: "live",
    });

    // Identical to the "no selling plans" path, plus the invisible marker.
    expect(html).not.toContain("data-cellexia-buybox");
    expect(html).not.toContain("data-cellexia-data");
    expect(html).not.toContain("data-cellexia-selling-plan");
    expect(html).not.toContain("cx-buybox__");
    expect(html).not.toContain("<style");
    expect(html).not.toContain(FOREIGN_PLAN_ID);
    expect(visibleText(html)).toBe("");
  });

  it("never falls back to a foreign group when the allow-list misses", async () => {
    // Our plan was synced to a DIFFERENT product: the allow-list exists and
    // names a group id this product does not carry.
    const html = await renderWidget({
      foreignGroupOnly: true,
      planGroups: {
        v: 1,
        groupIds: ["9999999999999"],
        planIds: ["1"],
        appId: FIXTURE.appId,
      },
      launchStatus: "live",
    });
    expect(html).not.toContain("data-cellexia-buybox");
    expect(visibleText(html)).toBe("");
  });

  it("group ids live in different id spaces — the exact ADMIN id matches nothing, plan ids decide", async () => {
    // The exact admin-numeric group id with planIds naming nothing: NOTHING
    // renders, because Liquid's group ids are opaque storefront identifiers
    // the admin id can never equal…
    const adminIdOnly = await renderWidget({
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: ["424242424242"],
        planSets: [["424242424242"]],
        appId: FIXTURE.appId,
      },
      launchStatus: "live",
    });
    expect(rootTag(adminIdOnly)).toBeNull();

    // …while the production shape — the same admin-numeric groupIds plus the
    // real plan ids — renders through the plan-id intersection. An ownership
    // rule that requires the group-id match fails THIS assertion.
    const production = await renderWidget({
      planGroups: {
        v: 1,
        groupIds: [String(FIXTURE.groupId)],
        planIds: OUR_PLAN_IDS,
        planSets: [OUR_PLAN_IDS],
        appId: FIXTURE.appId,
      },
      launchStatus: "live",
    });
    expect(rootTag(production)).not.toBeNull();
    expect(parseJsonIsland(production).initialPlan).toBe(DEFAULT_PLAN_ID);
  });

  it("accepts a numeric id in the metafield (both sides are normalised)", async () => {
    // Numbers on ALL fields: JSON may carry either form and the snippet
    // normalises each with an empty append before comparing.
    const html = await renderWidget({
      planGroups: {
        v: 1,
        groupIds: [FIXTURE.groupId],
        planIds: [...ALL_PLAN_IDS].map(Number),
        planSets: [[...ALL_PLAN_IDS].map(Number)],
        appId: Number(FIXTURE.appId),
      },
      launchStatus: "live",
    });
    expect(rootTag(html)).not.toBeNull();
  });

  describe("before the first plan sync (no allow-list metafield)", () => {
    /**
     * NO ALLOW-LIST, NO WIDGET. There is no name heuristic left and no "first
     * group" fallback: the allow-list is the only thing that can make a group
     * ours. A group is on the product because a plan was synced, and syncing
     * is what publishes the allow-list — so this state means a metafield write
     * failed, and the answer to that is to re-sync, not to guess.
     */
    it("renders nothing even for our OWN group, whatever it is named", async () => {
      for (const options of [
        {}, // ours alone, named "Cellexia Ritual" — the old name match
        { groupName: "Ritual Club" }, // ours alone, no token in the name
        { foreignGroupFirst: true }, // ours plus a competitor's
        { foreignGroupOnly: true }, // only a competitor's
        { foreignGroupFirst: true, groupName: "Ritual Club" },
      ] as MakeContextOptions[]) {
        const html = await renderWidget({
          ...options,
          planGroups: null,
          launchStatus: "live",
        });
        expect(rootTag(html), JSON.stringify(options)).toBeNull();
        expect(html, JSON.stringify(options)).not.toContain(
          "data-cellexia-buybox",
        );
        expect(html, JSON.stringify(options)).not.toContain(FOREIGN_PLAN_ID);
      }
    });

    it("…and publishing the allow-list is what turns the widget on", async () => {
      // The vacuity guard for the loop above: same product, same names, one
      // metafield later.
      const synced = await renderWidget({
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.groupId)],
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(rootTag(synced)).not.toBeNull();
      expect(parseJsonIsland(synced).initialPlan).toBe(DEFAULT_PLAN_ID);
      expect(synced).not.toContain(FOREIGN_PLAN_ID);
    });

    it("treats an allow-list that is present but empty exactly like a missing one", async () => {
      // "We own no group on this shop" and "we have not published yet" are the
      // same instruction to the widget: render nothing.
      const html = await renderWidget({
        planGroups: { v: 1, groupIds: [], planIds: [] },
        launchStatus: "live",
      });
      expect(rootTag(html)).toBeNull();
    });
  });

  describe("a malformed or hostile allow-list", () => {
    it.each([
      ["a bare string", "not json at all"],
      ["an empty string", ""],
      ["the wrong shape", { v: 1, groups: ["6612300000009"] }],
      ["groupIds as an object", { v: 1, groupIds: { a: "6612300000009" } }],
    ])("%s renders nothing at all", async (_label, value) => {
      const html = await renderWidget({
        planGroups: value,
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      // No shape-tolerance and no guessing: a value this snippet cannot read
      // as a list of group ids is the same as having no allow-list.
      expect(rootTag(html)).toBeNull();
      expect(html).not.toContain("data-cellexia-buybox");
      expect(html).not.toContain(FOREIGN_PLAN_ID);
      expect(html).not.toContain(String(FIXTURE.foreignGroupId));
    });

    it("groupIds as a bare string still cannot reach a foreign group", async () => {
      // Liquid's `size` on a string is its length, so this shape survives the
      // `> 0` guard where the ones above do not. It is pinned separately
      // because what protects us here is the EXACT string comparison, not the
      // emptiness check: the value below is our own group id.
      const html = await renderWidget({
        planGroups: {
          v: 1,
          groupIds: String(FIXTURE.groupId),
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(html).not.toContain(FOREIGN_PLAN_ID);
      expect(html).not.toContain(String(FIXTURE.foreignGroupId));
      expect(parseJsonIsland(html).initialPlan).toBe(DEFAULT_PLAN_ID);
    });
  });

  describe("planIds + appId decide ownership (groupIds cannot, by construction)", () => {
    /**
     * TWO mandatory ownership factors: the PLAN-id intersection (plan ids
     * are the one id space storefront Liquid and the Admin API share, and
     * they name plans THIS APP created through the API) AND the appId match
     * (the group's stamped `app_id` equal to the allow-list's `appId` —
     * v1.6.9). The groupIds field still travels in the metafield, but it is
     * admin-numeric and Liquid's group ids are opaque, so it can neither
     * pick a group nor veto one; the storefront no longer reads it at all
     * (tests/liquid/two-apps.test.ts pins the removed legacy OR).
     */
    it("refuses a foreign group even when the allow-list names its admin id", async () => {
      // Doubly dead: the admin-numeric id matches no Liquid group id, and
      // Joy's plans are not in planIds.
      const html = await renderWidget({
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.foreignGroupId)],
          planIds: OUR_PLAN_IDS,
          appId: FIXTURE.appId,
        },
        foreignGroupOnly: true,
        launchStatus: "live",
      });
      expect(rootTag(html)).toBeNull();
      expect(html).not.toContain(FOREIGN_PLAN_ID);
      expect(html).not.toContain("data-cellexia-buybox");
    });

    it("skips the foreign entry and still renders ours when both are listed", async () => {
      // A group matching nothing must not abort the scan: the product may
      // carry a group that is genuinely ours further down the list.
      const html = await renderWidget({
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.foreignGroupId), String(FIXTURE.groupId)],
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(rootTag(html)).not.toBeNull();
      expect(parseJsonIsland(html).initialPlan).toBe(DEFAULT_PLAN_ID);
      expect(html).not.toContain(FOREIGN_PLAN_ID);
    });

    it("a forged planIds entry ALONE no longer renders the foreign group (v1.6.9)", async () => {
      /* Until v1.6.9 planIds naming the OTHER app's plan rendered the other
         app's group, whatever groupIds said — ownership rested on the one
         field, so one forged or corrupted entry was sufficient by itself.
         The appId second factor closes exactly this: Joy's group fails the
         app-id comparison (its app_id is Joy's, not ours), ours fails the
         plan-id comparison, and NOTHING renders. The full forgery — both
         fields at once — still renders, and two-apps.test.ts pins that as
         the honest residual of a merchant-writable metafield. */
      const html = await renderWidget({
        planGroups: {
          v: 1,
          groupIds: [String(FIXTURE.groupId)],
          planIds: [FOREIGN_PLAN_ID],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(rootTag(html)).toBeNull();
      expect(html).not.toContain(FOREIGN_PLAN_ID);
      expect(html).not.toContain(String(FIXTURE.planIds.weeks8));
      expect(visibleText(html)).toBe("");
    });

    it("renders normally in the steady state (all fields ours)", async () => {
      // Vacuity guard for the three refusals above.
      const html = await renderWidget({
        planGroups: {
          v: 2,
          groupIds: [String(FIXTURE.groupId)],
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(rootTag(html)).not.toBeNull();
      expect(parseJsonIsland(html).initialPlan).toBe(DEFAULT_PLAN_ID);
      expect(planIdsInMarkup(html)).toEqual([...ALL_PLAN_IDS].sort());
    });

    it.each([
      ["absent", undefined],
      ["an empty list", []],
    ])(
      "renders NOTHING when planIds is %s — plan ids are mandatory",
      async (_label, planIds) => {
        /* This used to render on the group id alone, on the reasoning that a
           shop upgraded from a build without SellingPlanConfig.shopifyPlanIds
           would otherwise lose its buy box until the repair ran. That made the
           plan ids a veto rather than a requirement, and it was a hole:
           "planIds is empty" is a state THIS APP EMITS — publishOwnGroupsMetafield()
           writes {"groupIds":["77"],"planIds":[]} whenever the plan-id repair
           cannot read the group back (see tests/ownership.test.ts, "publishes
           group ids anyway when the repair cannot read the group"). In that
           state one corrupt or forged field — groupIds naming another app's
           group — was enough to render that app's group in full. Today the
           plan ids are the ownership factor itself, so without them there is
           no evidence to render on at all.

           So the cost is paid in the other direction now: an allow-list with
           no plan ids unlocks nothing, and the widget is briefly absent rather
           than briefly wrong. A missing widget sells nothing; a widget showing
           a competitor's plan sells THEIR subscription through our buy box.
           The window stays narrow because publishing repairs the plan ids
           first and any plan sync restores them. */
        const html = await renderWidget({
          planGroups: {
            v: 1,
            groupIds: [String(FIXTURE.groupId)],
            appId: FIXTURE.appId,
            ...(planIds === undefined ? {} : { planIds }),
          },
          foreignGroupFirst: true,
          launchStatus: "live",
        });
        expect(rootTag(html)).toBeNull();
        expect(html).not.toContain("data-cellexia-buybox");
        // Above all: failing closed must not fall through to the other app.
        expect(html).not.toContain(FOREIGN_PLAN_ID);
        expect(html).not.toContain(String(FIXTURE.foreignGroupId));
        expect(visibleText(html)).toBe("");
      },
    );

    it("renders again as soon as the plan ids are republished", async () => {
      // Vacuity guard for the pair above: the ONLY difference is the plan
      // fields being republished in full.
      const html = await renderWidget({
        planGroups: {
          v: 2,
          groupIds: [String(FIXTURE.groupId)],
          planIds: OUR_PLAN_IDS,
          planSets: [OUR_PLAN_IDS],
          appId: FIXTURE.appId,
        },
        foreignGroupFirst: true,
        launchStatus: "live",
      });
      expect(rootTag(html)).not.toBeNull();
      expect(parseJsonIsland(html).initialPlan).toBe(DEFAULT_PLAN_ID);
      expect(html).not.toContain(FOREIGN_PLAN_ID);
    });
  });

  describe("the admin-only 'no owned group' marker", () => {
    it("is an empty hidden template a shopper cannot perceive", async () => {
      const html = await renderWidget({
        foreignGroupOnly: true,
        launchStatus: "live",
      });
      const marker = tagsWithAttribute(html, "data-cellexia-no-owned-group");
      expect(marker).toHaveLength(1);
      expect(marker[0]).toContain("<template");
      expect(marker[0]).toContain("cx-buybox-nogroup");
      expect(marker[0]).toContain("hidden");
      // Nothing inside it, and no widget hook on it — only the fixed hiding
      // attributes plus the data-cellexia-diag-* attributes that say why
      // nothing matched (pinned in tests/liquid/two-apps.test.ts).
      expect(html).toMatch(
        /<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden style="display:none!important"(?: data-cellexia-diag-[a-z-]+="[^"]*")*><\/template>/,
      );
      expect(attributeValue(marker[0], "data-cellexia-diag-group-count")).toBe(
        "1",
      );
      expect(attributeValue(marker[0], "data-cellexia-diag-allowlist")).toBe(
        "present",
      );
      expect(visibleText(html)).toBe("");
      // The English hint itself lives in the JS, never in the served markup.
      expect(html).not.toContain("Sync your Cellexia plan");
    });

    it("is the ONLY thing the snippet emits, in both install shapes", async () => {
      const section = await renderWidget({
        foreignGroupOnly: true,
        launchStatus: "live",
      });
      expect(section.trim()).toMatch(
        /^<!-- BEGIN app snippet: cx-buybox-core --><template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden style="display:none!important"(?: data-cellexia-diag-[a-z-]+="[^"]*")*><\/template><!-- END app snippet -->$/,
      );

      // The embed still ships its wrapper + scripts (that is what turns the
      // marker into a diagnostic), but the wrapper is empty and [hidden], so
      // buy-box-embed.js treats it as dormant and never moves it.
      const embed = await renderEmbed({
        foreignGroupOnly: true,
        launchStatus: "live",
      });
      expect(embed).toContain("data-cellexia-no-owned-group");
      expect(embed).not.toContain("data-cellexia-buybox");
      expect(visibleText(embed)).toBe("");
      const wrapper = tagsWithAttribute(embed, "data-cellexia-embed")[0];
      expect(wrapper).toContain("hidden");
    });

    it("is absent whenever a widget renders, and on a product with no plans", async () => {
      const rendered = await renderWidget({ launchStatus: "live" });
      expect(rendered).not.toContain("data-cellexia-no-owned-group");

      const noPlans = await renderWidget({ noSellingPlans: true });
      expect(noPlans).not.toContain("data-cellexia-no-owned-group");
      expect(noPlans.trim()).toBe(
        "<!-- BEGIN app snippet: cx-buybox-core --><!-- END app snippet -->",
      );
    });
  });

  it("keeps the launch gate independent of ownership", async () => {
    // Setup mode + our group: gated as always. Setup mode + no owned group:
    // nothing at all, so there is nothing to gate.
    const gated = await renderWidget({
      foreignGroupFirst: true,
      launchStatus: "setup",
    });
    expect(rootTag(gated)).toContain('data-cellexia-gated="true"');

    const nothing = await renderWidget({
      foreignGroupOnly: true,
      launchStatus: "setup",
    });
    expect(nothing).not.toContain("data-cellexia-gated");
  });
});
