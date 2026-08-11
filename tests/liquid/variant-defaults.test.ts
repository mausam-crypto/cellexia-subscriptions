import { describe, expect, it } from "vitest";

import {
  FIXTURE,
  parseJsonIsland,
  renderWidget,
} from "./harness";

/**
 * PER-VARIANT DEFAULT FREQUENCY (v1.14.0) — the Liquid half.
 *
 * The shop metafield `cellexia.variant_defaults` maps NUMERIC variant ids to
 * `{unit, count}`. Two render-time duties, both pinned here:
 *
 *  1. INITIAL PRESELECT: the landing variant's entry overrides the
 *     recommended-frequency pick for the first paint (the widget must never
 *     flash the wrong cadence and fix it up in JS);
 *  2. ISLAND `defaultPlan`: every variant entry resolves its default to the
 *     plan id of OUR group's matching allocation — the value buy-box.js
 *     adopts on a variant switch. "" when the variant has no (usable)
 *     override.
 *
 * Matching parses the plan strings the same way the freq labels do — unit
 * word + first numeric token — and prepaid plans are EXCLUDED: "Every 8
 *  weeks, prepay 3 deliveries" bills 24 weeks at once; preselecting it from
 * a {WEEK,8} default would triple the charge the shopper expected.
 *
 * PRESENTATION ONLY, degrade-to-default: a missing, malformed or tampered
 * metafield must leave the recommended/first pick standing and must NEVER
 * crash the render or darken the widget (that is the allow-list's job, not
 * this field's).
 */

const JAR1 = String(FIXTURE.jarVariantIds.jar1);
const JAR2 = String(FIXTURE.jarVariantIds.jar2);
const JAR3 = String(FIXTURE.jarVariantIds.jar3);
const WEEKS4 = String(FIXTURE.planIds.weeks4);
const WEEKS6 = String(FIXTURE.planIds.weeks6);
const WEEKS8 = String(FIXTURE.planIds.weeks8);

function defaults(byVariant: Record<string, unknown>) {
  return { v: 1, byVariant };
}

/**
 * A plan set with a REAL prepaid plan sitting FIRST — the shape a prepaid-
 * enabled sync produces ("<planOptionValue>, prepay N deliveries"), ordered
 * so that a naive cadence match would hit the prepaid plan before the plain
 * one. The {WEEK,8} tests below are only meaningful against this: the
 * canned `prepaid` fixture option changes allocation prices but never adds
 * a prepay-named PLAN, so it can't catch a broken exclusion.
 */
const PREPAY_FIRST_SPECS = [
  {
    id: 6881100009,
    name: "Every 8 weeks, prepay 3 deliveries",
    optionValue: "Every 8 weeks, prepay 3 deliveries",
  },
  { id: FIXTURE.planIds.weeks4, name: "Delivery every 4 weeks", optionValue: "4 weeks" },
  { id: FIXTURE.planIds.weeks8, name: "Delivery every 8 weeks", optionValue: "8 weeks" },
];

describe("island defaultPlan — per-variant resolution", () => {
  it("resolves each variant's {unit,count} onto OUR group's matching plan id", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({
        [JAR2]: { unit: "WEEK", count: 4 },
        [JAR3]: { unit: "WEEK", count: 6 },
      }),
    });
    const island = parseJsonIsland(html);
    expect(String(island.variants[JAR2].defaultPlan)).toBe(WEEKS4);
    expect(String(island.variants[JAR3].defaultPlan)).toBe(WEEKS6);
    // No entry → empty string, the JS "no default" contract.
    expect(island.variants[JAR1].defaultPlan).toBe("");
  });

  it("an EARLIER variant's override never leaks into later variants (loop reset discipline)", async () => {
    // Liquid variables persist across forloop iterations; the island's
    // per-variant block must re-derive v_vd/v_dp for EVERY variant, so jar
    // 1's override cannot bleed into jar 2/3 (which have none).
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({ [JAR1]: { unit: "WEEK", count: 4 } }),
    });
    const island = parseJsonIsland(html);
    expect(String(island.variants[JAR1].defaultPlan)).toBe(WEEKS4);
    expect(island.variants[JAR2].defaultPlan).toBe("");
    expect(island.variants[JAR3].defaultPlan).toBe("");
  });

  it("absent metafield → every defaultPlan is '' (the pre-v1.14.0 shape rides on)", async () => {
    const html = await renderWidget({ jarVariants: true });
    const island = parseJsonIsland(html);
    for (const key of [JAR1, JAR2, JAR3]) {
      expect(island.variants[key].defaultPlan).toBe("");
    }
  });

  it("a cadence no live plan carries resolves to '' (stale override degrades, never invents)", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({ [JAR2]: { unit: "WEEK", count: 5 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.variants[JAR2].defaultPlan).toBe("");
  });

  it("multi-unit plans resolve by unit word + count — day, singular month included", async () => {
    const planSpecs = [
      { id: 771, name: "Every 10 days", optionValue: "Every 10 days" },
      { id: 772, name: "Every 2 weeks", optionValue: "Every 2 weeks" },
      { id: 773, name: "Every 1 month", optionValue: "Every 1 month" },
    ];
    const html = await renderWidget({
      jarVariants: true,
      planSpecs,
      variantDefaults: defaults({
        [JAR1]: { unit: "DAY", count: 10 },
        [JAR2]: { unit: "MONTH", count: 1 },
        [JAR3]: { unit: "WEEK", count: 2 },
      }),
    });
    const island = parseJsonIsland(html);
    expect(String(island.variants[JAR1].defaultPlan)).toBe("771");
    expect(String(island.variants[JAR2].defaultPlan)).toBe("773");
    expect(String(island.variants[JAR3].defaultPlan)).toBe("772");
  });

  it("NEVER resolves onto the prepaid plan: {WEEK,8} with a prepay plan FIRST picks the plain weeks-8 plan", async () => {
    const html = await renderWidget({
      jarVariants: true,
      planSpecs: PREPAY_FIRST_SPECS,
      variantDefaults: defaults({ [JAR2]: { unit: "WEEK", count: 8 } }),
    });
    const island = parseJsonIsland(html);
    // The prepay plan's own string ("Every 8 weeks, prepay 3 deliveries")
    // contains both the unit word and the count — only the explicit prepay
    // exclusion keeps it from matching, and it sits first in the group.
    expect(String(island.variants[JAR2].defaultPlan)).toBe(WEEKS8);
  });

  it.each([
    ["a bare string", "garbage"],
    ["an array", [1, 2, 3]],
    ["byVariant as a string", { v: 1, byVariant: "nope" }],
    ["an unknown unit", defaults({ [JAR2]: { unit: "FORTNIGHT", count: 2 } })],
    ["a missing count", defaults({ [JAR2]: { unit: "WEEK" } })],
    ["a missing unit", defaults({ [JAR2]: { count: 8 } })],
  ])(
    "malformed metafield (%s) renders, parses, and leaves defaults empty",
    async (_label, value) => {
      const html = await renderWidget({
        jarVariants: true,
        variantDefaults: value,
      });
      const island = parseJsonIsland(html); // throws on malformed JSON
      expect(island.variants[JAR2].defaultPlan).toBe("");
      expect(island.initialPlan).toBe(WEEKS8); // recommended pick stands
    },
  );

  it("an unknown variant id in the metafield changes nothing", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({ "999999999999": { unit: "WEEK", count: 4 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS8);
    for (const key of [JAR1, JAR2, JAR3]) {
      expect(island.variants[key].defaultPlan).toBe("");
    }
  });
});

describe("initial preselect — the landing variant's default beats the recommended pick", () => {
  it("landing variant (jar 1) with an override preselects ITS plan on first paint", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({ [JAR1]: { unit: "WEEK", count: 4 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS4);
    // The server-rendered controls agree with the island (no JS fix-up):
    // the hidden mirror already carries the plan the widget shows.
    expect(html).toContain(`value="${WEEKS4}"`);
  });

  it("an override for a NON-landing variant does not move the first paint", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: defaults({ [JAR2]: { unit: "WEEK", count: 4 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS8); // recommended "8 weeks" pick
  });

  it("the planner preset keeps its 'Recommended' tag on the RECOMMENDED plan while the default moves the selection", async () => {
    // The planner renders chips and tags cx_rec_plan_id (the block-setting
    // "8 weeks" handle match). The variant default must move the CHECKED
    // chip to weeks 4 while the tag stays with the weeks-8 chip.
    const html = await renderWidget({
      jarVariants: true,
      blockSettings: { design_source: "planner" },
      variantDefaults: defaults({ [JAR1]: { unit: "WEEK", count: 4 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS4);
    // Exactly one checked chip, and it is the weeks-4 one (attribute order
    // in the markup: value → data-cellexia-freq-chip → checked).
    const checkedChips = [
      ...html.matchAll(/value="(\d+)"\s+data-cellexia-freq-chip\s+checked/g),
    ].map((m) => m[1]);
    expect(checkedChips).toEqual([WEEKS4]);
    // Exactly one Recommended tag, and it sits AFTER the weeks-8 chip's
    // input (chips render 4w → 6w → 8w, so a tag belonging to weeks 8 must
    // appear after its value and after the other two).
    const tagCount = html.split("cx-buybox__chip-tag").length - 1;
    expect(tagCount).toBe(1);
    const tagAt = html.indexOf("cx-buybox__chip-tag");
    expect(tagAt).toBeGreaterThan(html.indexOf(`value="${WEEKS8}"`));
  });

  it("prepaid never preselects from a default: {WEEK,8} with a prepay plan FIRST lands on the plain weeks-8 plan", async () => {
    const html = await renderWidget({
      jarVariants: true,
      planSpecs: PREPAY_FIRST_SPECS,
      variantDefaults: defaults({ [JAR1]: { unit: "WEEK", count: 8 } }),
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS8);
  });
});

describe("the folded group default — the revert target for un-overridden variants", () => {
  const WITH_DEFAULT = {
    v: 1,
    default: { unit: "WEEK", count: 6 },
    byVariant: { [JAR2]: { unit: "WEEK", count: 4 } },
  };

  it("variants WITHOUT an override resolve defaultPlan to the group default's plan", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: WITH_DEFAULT,
    });
    const island = parseJsonIsland(html);
    expect(String(island.variants[JAR1].defaultPlan)).toBe(WEEKS6);
    expect(String(island.variants[JAR3].defaultPlan)).toBe(WEEKS6);
    // …while the override still wins where it exists.
    expect(String(island.variants[JAR2].defaultPlan)).toBe(WEEKS4);
  });

  it("the landing variant's preselect follows the folded default — the admin 'Default frequency' finally drives the storefront", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: WITH_DEFAULT,
    });
    // Without the fold the block-setting handle would pick weeks 8.
    expect(parseJsonIsland(html).initialPlan).toBe(WEEKS6);
  });

  it("a malformed group default degrades to '' — the handle pick stands, nothing crashes", async () => {
    const html = await renderWidget({
      jarVariants: true,
      variantDefaults: {
        v: 1,
        default: { unit: "FORTNIGHT", count: 2 },
        byVariant: {},
      },
    });
    const island = parseJsonIsland(html);
    expect(island.initialPlan).toBe(WEEKS8);
    expect(island.variants[JAR1].defaultPlan).toBe("");
  });
});
