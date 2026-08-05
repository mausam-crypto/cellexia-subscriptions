import { describe, expect, it } from "vitest";
import {
  bucketForSubject,
  cadenceDefaultForQuantity,
  cadenceDefaultsForProduct,
  cadenceFromDefaults,
  DEFAULT_WIDGET_SETTINGS,
  hashSubjectKey,
  matchesTargeting,
  mergeSettings,
  pickFirstMatchPerType,
} from "~/services/offers/widgets.server";

describe("bucketForSubject (deterministic experiment bucketing)", () => {
  const variants = [
    { key: "control", weight: 50 },
    { key: "treatment", weight: 50 },
  ];

  it("is deterministic for the same subject", () => {
    for (let i = 0; i < 20; i++) {
      const subject = `visitor-${i}`;
      expect(bucketForSubject(subject, variants)).toBe(
        bucketForSubject(subject, variants),
      );
    }
  });

  it("hashSubjectKey is stable and 32-bit unsigned", () => {
    const h = hashSubjectKey("visitor-abc");
    expect(h).toBe(hashSubjectKey("visitor-abc"));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(0x100000000);
    expect(hashSubjectKey("visitor-abd")).not.toBe(h);
  });

  it("always picks a variant with positive weight", () => {
    const weighted = [
      { key: "a", weight: 1 },
      { key: "b", weight: 0 },
    ];
    for (let i = 0; i < 50; i++) {
      expect(bucketForSubject(`subject-${i}`, weighted)).toBe("a");
    }
  });

  it("falls back to the first variant when no weight is positive", () => {
    expect(
      bucketForSubject("anyone", [
        { key: "x", weight: 0 },
        { key: "y", weight: -5 },
      ]),
    ).toBe("x");
  });

  it("splits traffic across variants roughly by weight", () => {
    const counts: Record<string, number> = { control: 0, treatment: 0 };
    for (let i = 0; i < 500; i++) {
      counts[bucketForSubject(`subject-${i}`, variants)] += 1;
    }
    // 50/50 split over 500 deterministic subjects: both sides well populated.
    expect(counts.control).toBeGreaterThan(100);
    expect(counts.treatment).toBeGreaterThan(100);

    const skewed = [
      { key: "big", weight: 90 },
      { key: "small", weight: 10 },
    ];
    const skewCounts: Record<string, number> = { big: 0, small: 0 };
    for (let i = 0; i < 500; i++) {
      skewCounts[bucketForSubject(`subject-${i}`, skewed)] += 1;
    }
    expect(skewCounts.big).toBeGreaterThan(skewCounts.small);
  });

  it("throws with no variants", () => {
    expect(() => bucketForSubject("s", [])).toThrow();
  });
});

describe("cadenceDefaultForQuantity", () => {
  const config = {
    plansJson: JSON.stringify([
      { name: "Every 6 weeks", intervalWeeks: 6, percentOff: 15 },
    ]),
    quantityDefaultsJson: JSON.stringify({
      default: { "1": 4, "2": 8, "3": 12 },
      byProduct: { "gid://shopify/Product/111": { "1": 6 } },
    }),
  };

  it("reads the default quantity map", () => {
    expect(cadenceDefaultForQuantity(config, "gid://shopify/Product/999", 1)).toBe(4);
    expect(cadenceDefaultForQuantity(config, "gid://shopify/Product/999", 2)).toBe(8);
    expect(cadenceDefaultForQuantity(config, "gid://shopify/Product/999", 3)).toBe(12);
  });

  it("applies per-product overrides over the default map", () => {
    expect(cadenceDefaultForQuantity(config, "gid://shopify/Product/111", 1)).toBe(6);
    // Quantity 2 has no override — falls back to the default map.
    expect(cadenceDefaultForQuantity(config, "gid://shopify/Product/111", 2)).toBe(8);
    // Bare numeric product ids match GID keys.
    expect(cadenceDefaultForQuantity(config, "111", 1)).toBe(6);
  });

  it("uses the nearest lower quantity when the exact one is missing", () => {
    expect(cadenceDefaultForQuantity(config, "999", 5)).toBe(12);
  });

  it("uses the smallest configured quantity when qty is below all keys", () => {
    expect(cadenceDefaultForQuantity(config, "999", 0)).toBe(4);
  });

  it("supports the legacy flat map shape", () => {
    const legacy = {
      plansJson: "[]",
      quantityDefaultsJson: JSON.stringify({ "1": 3, "2": 6 }),
    };
    expect(cadenceDefaultForQuantity(legacy, "any", 2)).toBe(6);
  });

  it("falls back to the first plan interval, then 4 weeks", () => {
    const noDefaults = {
      plansJson: JSON.stringify([
        { name: "Every 6 weeks", intervalWeeks: 6, percentOff: 10 },
      ]),
      quantityDefaultsJson: "{}",
    };
    expect(cadenceDefaultForQuantity(noDefaults, "any", 2)).toBe(6);

    const nothing = { plansJson: "[]", quantityDefaultsJson: "{}" };
    expect(cadenceDefaultForQuantity(nothing, "any", 1)).toBe(4);
  });

  it("cadenceDefaultsForProduct merges override keys over defaults", () => {
    expect(cadenceDefaultsForProduct(config, "gid://shopify/Product/111")).toEqual({
      "1": 6,
      "2": 8,
      "3": 12,
    });
    expect(cadenceFromDefaults({ "2": 8 }, 2)).toBe(8);
    expect(cadenceFromDefaults({}, 2)).toBeNull();
  });
});

describe("matchesTargeting", () => {
  it("matches everything when targeting is empty", () => {
    expect(matchesTargeting({}, {})).toBe(true);
    expect(matchesTargeting({}, { productId: "1", returning: true })).toBe(true);
  });

  it("matches product ids across gid and bare formats", () => {
    const targeting = { productIds: ["gid://shopify/Product/42"] };
    expect(matchesTargeting(targeting, { productId: "42" })).toBe(true);
    expect(
      matchesTargeting(targeting, { productId: "gid://shopify/Product/42" }),
    ).toBe(true);
    expect(matchesTargeting(targeting, { productId: "43" })).toBe(false);
    expect(matchesTargeting(targeting, {})).toBe(false);
  });

  it("markets and traffic sources are case-insensitive", () => {
    expect(matchesTargeting({ markets: ["DE"] }, { market: "de" })).toBe(true);
    expect(matchesTargeting({ markets: ["DE"] }, { market: "fr" })).toBe(false);
    expect(
      matchesTargeting({ trafficSources: ["Email"] }, { trafficSource: "email" }),
    ).toBe(true);
  });

  it("returningOnly requires a returning visitor", () => {
    expect(matchesTargeting({ returningOnly: true }, { returning: true })).toBe(true);
    expect(matchesTargeting({ returningOnly: true }, { returning: false })).toBe(false);
    expect(matchesTargeting({ returningOnly: true }, {})).toBe(false);
    expect(matchesTargeting({ returningOnly: false }, {})).toBe(true);
  });

  it("pickFirstMatchPerType keeps the first (highest-priority) match per type", () => {
    const configs = [
      {
        widgetType: "TREATMENT_CHOICE",
        targetingJson: JSON.stringify({ markets: ["FR"] }),
        settingsJson: "{}",
        priority: 10,
      },
      {
        widgetType: "TREATMENT_CHOICE",
        targetingJson: "{}",
        settingsJson: "{}",
        priority: 5,
      },
      {
        widgetType: "CART_CONVERSION",
        targetingJson: "{}",
        settingsJson: "{}",
        priority: 1,
      },
    ];
    const winners = pickFirstMatchPerType(configs, { market: "DE" });
    expect(winners.TREATMENT_CHOICE?.priority).toBe(5); // FR-targeted one skipped
    expect(winners.CART_CONVERSION?.priority).toBe(1);
  });
});

describe("mergeSettings", () => {
  it("deep-merges objects and replaces arrays and scalars", () => {
    const base = {
      title: "CHOOSE YOUR TREATMENT",
      continuous: { label: "A", bullets: ["one", "two"] },
    };
    const override = {
      continuous: { label: "B" },
      extra: true,
    };
    expect(mergeSettings(base, override)).toEqual({
      title: "CHOOSE YOUR TREATMENT",
      continuous: { label: "B", bullets: ["one", "two"] },
      extra: true,
    });
  });

  it("default treatment-choice settings carry NO style — the Liquid-resolved style must survive the config fetch", () => {
    const settings = DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE as {
      style?: string;
    };
    // Regression: a default style:"choice" here made resolveWidget send
    // `style` on EVERY config response, and the storefront JS restyles
    // whenever the config carries a style — reverting theme-editor
    // (default_style / market_styles) Subscription Max widgets back to
    // "choice" on every page view. Defaults must stay style-less so
    // CX.resolveStyle falls back to the Liquid-resolved style.
    expect(settings.style).toBeUndefined();
    // Per-market override recipe (admin path): a market-targeted config with
    // {"style": "max"} flows through the generic settings merge untouched —
    // no whitelist strips it.
    expect(
      (
        mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {
          style: "max",
        }) as { style?: string }
      ).style,
    ).toBe("max");
    // An explicit "choice" override still wins the same way.
    expect(
      (
        mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {
          style: "choice",
        }) as { style?: string }
      ).style,
    ).toBe("choice");
    // "ultra" (Subscription Max Ultra) rides the same explicit-only path:
    // the generic merge passes it through untouched.
    expect(
      (
        mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {
          style: "ultra",
        }) as { style?: string }
      ).style,
    ).toBe("ultra");
    // A config that never mentions style must not conjure one: the merged
    // settings stay style-less so the Liquid-resolved style (choice, max or
    // ultra from default_style / market_styles) survives the config fetch.
    expect(
      (
        mergeSettings(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE, {
          continuous: { label: "OVERRIDDEN" },
        }) as { style?: string }
      ).style,
    ).toBeUndefined();
  });

  it("default treatment-choice copy carries the mandated brand voice", () => {
    const settings = DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE as {
      title: string;
      continuous: { label: string; bullets: string[] };
      basic: { label: string; bullets: string[] };
    };
    expect(settings.title).toBe("CHOOSE YOUR TREATMENT");
    expect(settings.continuous.label).toBe("CONTINUOUS TREATMENT — RECOMMENDED");
    expect(settings.continuous.bullets).toEqual([
      "Designed for continued visible improvement",
      "Save {percent}%",
      "Adjust, delay or cancel online",
    ]);
    expect(settings.basic.label).toBe("BASIC PURCHASE");
    expect(settings.basic.bullets).toEqual([
      "One delivery",
      "Standard price",
      "No ongoing treatment benefits",
    ]);
  });
});
