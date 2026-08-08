import { describe, expect, it } from "vitest";

import {
  DEFAULT_DESIGN_CONFIG,
  widgetDesignConfigSchema,
} from "~/lib/widget/presets";

import {
  DEFAULT_MONEY_FORMAT,
  FIXTURE,
  formatMoney,
  parseJsonIsland,
  renderWidget,
} from "./harness";
import type { JsonIsland } from "./harness";

/**
 * THE PER-VARIANT PRICE MATRIX (v1.6.8) — the data half of the live bug.
 *
 * The merchant's theme ("Sleepify", cellexialabs.com) sells jar packs as
 * three SEPARATE VARIANTS at three different prices, switched by the theme's
 * own pill buttons. When the shopper lands on "1 Jar" and clicks "2 Jars",
 * every price the widget shows must come from the island — client JS never
 * formats money — so the island has to carry, for EVERY available variant ×
 * every plan of OUR group: the variant one-time price, the first-order
 * (allocation) price, the ongoing/recurring price, the per-delivery price
 * and the compare-at, as pre-formatted shop-money strings, plus the cents
 * the JS needs for exact comparisons, plus per-variant availability and the
 * selected-variant id.
 *
 * This suite is the golden render for that matrix, over the jar fixture
 * (three variants: distinct prices, one compare-at-less, one sold out) and
 * over the classic two-variant fixture, for both the preset the merchant
 * runs (subscription_max) and the default (classic).
 */

const JARS = FIXTURE.jarVariantIds;
const JAR_IDS = [String(JARS.jar1), String(JARS.jar2), String(JARS.jar3)];
const PLAN_IDS = [
  String(FIXTURE.planIds.weeks4),
  String(FIXTURE.planIds.weeks6),
  String(FIXTURE.planIds.weeks8),
];

const money = (cents: number): string =>
  formatMoney(cents, DEFAULT_MONEY_FORMAT);

/** The fixture discount model: 20% off the first order, 10% off ongoing. */
const first = (price: number): number => Math.round(price * 0.8);
const ongoing = (price: number): number => Math.round(price * 0.9);

function submaxConfig(): Record<string, unknown> {
  const config = widgetDesignConfigSchema.parse({
    ...DEFAULT_DESIGN_CONFIG,
    preset: "subscription_max",
  });
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

/** Every matrix field for one variant, asserted against the fixture maths. */
function expectVariantRow(
  island: JsonIsland,
  variantId: string,
  price: number,
  compareAt: number | null,
  available: boolean,
): void {
  const variant = island.variants[variantId];
  expect(variant, `variant ${variantId} missing from the island`).toBeDefined();
  expect(variant.available).toBe(available);
  expect(variant.oneTime).toBe(money(price));
  expect(variant.oneTimeCents).toBe(price);
  expect(variant.compareAt).toBe(compareAt === null ? "" : money(compareAt));
  expect(Object.keys(variant.plans)).toEqual(PLAN_IDS);
  for (const planId of PLAN_IDS) {
    const plan = variant.plans[planId];
    expect(plan.first, `${variantId}/${planId} first`).toBe(money(first(price)));
    expect(plan.firstCents).toBe(first(price));
    expect(plan.ongoing, `${variantId}/${planId} ongoing`).toBe(
      money(ongoing(price)),
    );
    expect(plan.then).toContain(money(ongoing(price)));
    expect(plan.save).toBe("Save 20%");
    expect(plan.savePct).toBe("20%");
    // Fixture default: per-delivery equals the charge, so the perDelivery
    // LINE is empty while pd (the money the tiles/planner hooks re-render
    // from) is the charge price.
    expect(plan.perDelivery).toBe("");
    expect(plan.pd).toBe(money(first(price)));
  }
}

describe("the island's per-variant price matrix (jar fixture)", () => {
  for (const [name, options] of [
    ["classic (zero-config)", { jarVariants: true }],
    [
      "subscription_max (the merchant's preset)",
      { jarVariants: true, config: submaxConfig() },
    ],
  ] as const) {
    it(`${name}: every variant × every plan, prices, cents, compare-at, availability`, async () => {
      const html = await renderWidget(options);
      const island = parseJsonIsland(html);

      expect(Object.keys(island.variants)).toEqual(JAR_IDS);
      // The selected-variant id is in the island (the page opened on jar 1).
      expect(island.initialVariant).toBe(String(JARS.jar1));

      expectVariantRow(island, String(JARS.jar1), FIXTURE.jarPrices.jar1, null, true);
      expectVariantRow(
        island,
        String(JARS.jar2),
        FIXTURE.jarPrices.jar2,
        FIXTURE.jarCompareAt.jar2,
        true,
      );
      // Sold out — the row is still priced (the widget stays consistent and
      // leaves add-to-cart behaviour to the theme), but availability says so.
      expectVariantRow(
        island,
        String(JARS.jar3),
        FIXTURE.jarPrices.jar3,
        FIXTURE.jarCompareAt.jar3,
        false,
      );

      // Three variants, three DIFFERENT price rows — the matrix cannot be a
      // copy of the initially selected variant's prices (the pre-fix defect
      // class this suite exists to hold shut).
      const firsts = JAR_IDS.map(
        (id) => island.variants[id].plans[PLAN_IDS[0]].first,
      );
      expect(new Set(firsts).size).toBe(3);
    });
  }
});

describe("byte-golden island snapshots (jar fixture)", () => {
  // The field-by-field suite above proves the VALUES; these snapshots pin
  // the BYTES, so any change to the island's shape, key order, formatting or
  // escaping over the three-variant matrix shows up as a reviewable diff —
  // the same guarantee render.test.ts's zero-config snapshot gives the
  // two-variant fixture.
  const rawIsland = (html: string): string => {
    const match =
      /<script type="application\/json" data-cellexia-data>([\s\S]*?)<\/script>/.exec(
        html,
      );
    if (!match) throw new Error("no JSON island rendered");
    return match[1];
  };

  it("classic (zero-config), three jar variants", async () => {
    const html = await renderWidget({ jarVariants: true });
    expect(rawIsland(html)).toMatchSnapshot();
  });

  it("subscription_max (the merchant's preset), three jar variants", async () => {
    const html = await renderWidget({
      jarVariants: true,
      config: submaxConfig(),
    });
    expect(rawIsland(html)).toMatchSnapshot();
  });
});

describe("the matrix on the standard two-variant fixture", () => {
  it("carries cents, ongoing and compare-at for both variants", async () => {
    const html = await renderWidget({});
    const island = parseJsonIsland(html);
    for (const [variantId, price] of [
      [String(FIXTURE.variantIds.small), FIXTURE.prices.small],
      [String(FIXTURE.variantIds.large), FIXTURE.prices.large],
    ] as const) {
      expectVariantRow(island, variantId, price, null, true);
    }
  });

  it("absolute savings format lands per-variant in the matrix", async () => {
    // Each variant's absolute saving differs, which is what makes the
    // savings label re-renderable from matrix STRINGS on variant change
    // (no client-side percentage math).
    const html = await renderWidget({
      jarVariants: true,
      blockSettings: { savings_format: "absolute" },
    });
    const island = parseJsonIsland(html);
    expect(
      island.variants[String(JARS.jar1)].plans[PLAN_IDS[0]].save,
    ).toBe(`Save ${money(FIXTURE.jarPrices.jar1 - first(FIXTURE.jarPrices.jar1))}`);
    expect(
      island.variants[String(JARS.jar2)].plans[PLAN_IDS[0]].save,
    ).toBe(`Save ${money(FIXTURE.jarPrices.jar2 - first(FIXTURE.jarPrices.jar2))}`);
  });
});
