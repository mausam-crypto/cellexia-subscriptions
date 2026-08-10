import { describe, expect, it } from "vitest";

import {
  parseJsonIsland,
  renderWidget,
  visibleText,
} from "./harness";

/**
 * MULTI-UNIT FREQUENCY RENDERING (v1.8.0).
 *
 * Plans can now mix DAY / WEEK / MONTH cadences inside one group. The widget
 * parses the count and unit out of each plan's option value / name (the app's
 * own planOptionValue vocabulary — "Every 10 days", "Every 2 weeks",
 * "Every 1 month") and composes localized labels from the per-unit locale
 * nouns. These renders pin:
 *
 *   a. every unit gets its localized noun — no plan is dumped back to the raw
 *      English plan name just because it is not week-denominated (the
 *      pre-v1.8.0 behavior this feature removes)
 *   b. count 1 uses the singular noun ("1 month", never "1 months")
 *   c. the island's per-plan freq strings match, so the JS re-resolves
 *      {frequency} templates with the same words on variant switches
 *   d. the selected-plan microcopy ("then {price} every {frequency}") speaks
 *      the selected plan's own unit
 */

const MIXED_PLAN_SPECS = [
  { id: 6881100011, name: "Every 10 days", optionValue: "Every 10 days" },
  { id: 6881100012, name: "Every 2 weeks", optionValue: "Every 2 weeks" },
  { id: 6881100013, name: "Every 1 month", optionValue: "Every 1 month" },
];

describe("mixed-unit plan group (10 days / 2 weeks / 1 month)", () => {
  it("renders each cadence with its localized unit noun in the dropdown", async () => {
    const html = await renderWidget({ planSpecs: MIXED_PLAN_SPECS });
    const text = visibleText(html);
    expect(text).toContain("Delivery every 10 days");
    expect(text).toContain("Delivery every 2 weeks");
    // Count 1 uses the singular every-phrase — "every month", never
    // "every 1 months" (and gendered languages get a unit-correct phrase,
    // e.g. French "tous les 10 jours" vs "toutes les 2 semaines").
    expect(text).toContain("Delivery every month");
    expect(text).not.toContain("1 months");
    // No plan fell back to the raw plan-name path: the option label and the
    // plan name coincide in this fixture, so instead pin that the localized
    // sentence prefix reached every option.
    expect(html.match(/Delivery every/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("the island carries per-plan freq strings in the plan's own unit", async () => {
    const html = await renderWidget({ planSpecs: MIXED_PLAN_SPECS });
    const island = parseJsonIsland(html);
    const allFreqs = new Set<string>();
    for (const variant of Object.values(island.variants) as Array<{
      plans: Record<string, { freq: string }>;
    }>) {
      for (const plan of Object.values(variant.plans)) {
        allFreqs.add(plan.freq);
      }
    }
    expect(allFreqs).toEqual(new Set(["10 days", "2 weeks", "1 month"]));
  });

  it("the selected plan's ongoing-price microcopy names its cadence", async () => {
    // First plan (10 days) is selected by default; savings are on, so the
    // "then {price} every {frequency}" sentence must carry the DAY wording.
    const html = await renderWidget({ planSpecs: MIXED_PLAN_SPECS });
    expect(visibleText(html)).toMatch(/then .+ every 10 days/);
  });

  it("a day-only group renders without any week vocabulary", async () => {
    const html = await renderWidget({
      planSpecs: [
        { id: 6881100021, name: "Every 5 days", optionValue: "Every 5 days" },
        { id: 6881100022, name: "Every 10 days", optionValue: "Every 10 days" },
      ],
    });
    const text = visibleText(html);
    expect(text).toContain("Delivery every 5 days");
    expect(text).not.toMatch(/\d+ weeks/);
  });

  it("a prepaid plan keeps its full distinguishing name, never a bare cadence label", async () => {
    // "Every 2 weeks" and "Every 2 weeks, prepay 3 deliveries" in one group:
    // reducing the prepaid plan to "2 weeks" would render two identical
    // options, and a subscriber could pick the 3-deliveries-upfront charge
    // believing it is the ordinary subscription.
    const html = await renderWidget({
      planSpecs: [
        { id: 6881100041, name: "Every 2 weeks", optionValue: "Every 2 weeks" },
        {
          id: 6881100042,
          name: "Every 2 weeks, prepay 3 deliveries",
          optionValue: "Every 2 weeks, prepay 3 deliveries",
        },
      ],
    });
    const text = visibleText(html);
    expect(text).toContain("Every 2 weeks, prepay 3 deliveries");
    // The plain plan still renders the localized cadence sentence.
    expect(text).toContain("Delivery every 2 weeks");
  });

  it("an unparseable plan still falls back to its raw name", async () => {
    // A plan named outside the app's vocabulary (no unit noun at all) keeps
    // the raw-name fallback rather than rendering a broken label.
    const html = await renderWidget({
      planSpecs: [
        { id: 6881100031, name: "Quarterly ritual", optionValue: "Quarterly ritual" },
        { id: 6881100032, name: "Every 2 weeks", optionValue: "Every 2 weeks" },
      ],
    });
    const text = visibleText(html);
    expect(text).toContain("Quarterly ritual");
    expect(text).toContain("Delivery every 2 weeks");
  });
});
