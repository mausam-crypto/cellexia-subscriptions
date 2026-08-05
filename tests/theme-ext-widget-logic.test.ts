/**
 * [theme-ext] — unit tests for the pure decision logic shipped inside
 * extensions/treatment-widgets/assets/cellexia-widgets.js.
 *
 * The asset is an ES5 IIFE that exposes its pure helpers on
 * window.CellexiaWidgets and returns before touching the DOM when
 * window.document is absent — so we can evaluate the real shipped file
 * in Node and test the exact code the storefront runs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface NormalizedPlan {
  id: number;
  name: string;
  percentOff: number;
  intervalWeeks: number | null;
}

interface CellexiaWidgetsNs {
  DEFAULT_CADENCE: Record<number, number>;
  cadenceForQuantity(
    qty: number,
    defaults?: Record<string | number, number | string> | null,
  ): number;
  parseIntervalWeeks(text: string | null | undefined): number | null;
  normalizePlans(
    raw: Array<Record<string, unknown>> | null | undefined,
  ): NormalizedPlan[];
  pickPlanForWeeks(
    plans: NormalizedPlan[] | null | undefined,
    weeks: number,
  ): NormalizedPlan | null;
  maxPercentOff(plans: Array<{ percentOff: number }> | null | undefined): number;
  planPriceCents(unitPriceCents: number, percentOff: number): number;
  computeSavingsPercent(oneTimeCents: number, planCents: number | null): number;
  cyclesPerYear(intervalWeeks: number | null): number;
  estimateAnnualSavingCents(
    unitPriceCents: number,
    percentOff: number,
    quantity: number,
    intervalWeeks: number | null,
  ): number;
  formatMoney(cents: number, format?: string): string;
  idTail(id: unknown): string;
  splitPlans(
    plans: NormalizedPlan[] | null | undefined,
    ids: Array<number | string> | null | undefined,
    match: string | null | undefined,
  ): { committed: NormalizedPlan[]; standard: NormalizedPlan[] };
  initialMode(
    opts: {
      hasPlans?: boolean;
      committedEnabled?: boolean;
      committedPosition?: string | number | null;
      style?: string | null;
    } | null,
  ): "treatment" | "basic" | "committed";
  resolveStyle(
    liquidStyle: string | null | undefined,
    configStyle: string | null | undefined,
  ): "choice" | "max" | "ultra";
  planUnitCents(
    variant: {
      priceCents: number;
      planPrices?: Record<string, number> | null;
    } | null,
    plan: { id: number | string; percentOff: number } | null,
  ): number;
  fillPriceToken(
    template: string | null | undefined,
    priceText: string | null | undefined,
  ): string;
  ATTR_MAX: number;
  CONTEXT_TTL_MS: number;
  clipAttr(value: unknown): string;
  parseTrackingParams(search: string | null | undefined): Record<string, string>;
  sanitizeFirstTouch(
    referrer: string | null | undefined,
    ownHost: string | null | undefined,
    utm: Record<string, string> | null | undefined,
  ): { referrer: string; utm: Record<string, string> };
  firstTouch(
    existing: { firstSeenAt?: string } | null | undefined,
    candidate: FirstTouchContext,
    nowMs: number,
  ): FirstTouchContext | { firstSeenAt?: string };
  safeJsonAttr(obj: Record<string, unknown> | null | undefined, maxLen?: number): string;
  buildCartAttributes(ctx: {
    visitor?: string | null;
    firstSeenAt?: string | null;
    referrer?: string | null;
    landing?: string | null;
    utm?: Record<string, string> | null;
    widgetType?: string | null;
    experimentKey?: string | null;
    device?: string | null;
    qty?: number | null;
    discountPercent?: number | null;
  } | null): Record<string, string>;
}

interface FirstTouchContext {
  firstSeenAt: string;
  referrer: string;
  landing: string;
  utm: Record<string, string>;
}

const assetPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../extensions/treatment-widgets/assets/cellexia-widgets.js",
);

let CX: CellexiaWidgetsNs;

beforeAll(() => {
  const src = readFileSync(assetPath, "utf8");
  const sandbox: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "self", src);
  run(sandbox, sandbox);
  CX = sandbox.CellexiaWidgets as CellexiaWidgetsNs;
});

describe("cadenceForQuantity", () => {
  it("falls back to the built-in defaults 1→4, 2→8, 3→12", () => {
    expect(CX.cadenceForQuantity(1, {})).toBe(4);
    expect(CX.cadenceForQuantity(2, {})).toBe(8);
    expect(CX.cadenceForQuantity(3, null)).toBe(12);
  });

  it("prefers merchant/app-provided defaults (string or number keys)", () => {
    expect(CX.cadenceForQuantity(2, { "2": 6 })).toBe(6);
    expect(CX.cadenceForQuantity(1, { 1: 2 })).toBe(2);
  });

  it("coerces string week values and rejects invalid ones", () => {
    expect(CX.cadenceForQuantity(1, { "1": "3" })).toBe(3);
    expect(CX.cadenceForQuantity(1, { "1": 0 })).toBe(4);
    expect(CX.cadenceForQuantity(1, { "1": "not-a-number" })).toBe(4);
  });

  it("uses 4 weeks for quantities outside the default map", () => {
    expect(CX.cadenceForQuantity(5, {})).toBe(4);
  });
});

describe("parseIntervalWeeks", () => {
  it("parses week-based plan names", () => {
    expect(CX.parseIntervalWeeks("Delivery every 4 weeks")).toBe(4);
    expect(CX.parseIntervalWeeks("12 Week(s)")).toBe(12);
  });

  it("converts months (×4) and days (÷7, min 1)", () => {
    expect(CX.parseIntervalWeeks("Every 2 months")).toBe(8);
    expect(CX.parseIntervalWeeks("30 Day(s)")).toBe(4);
    expect(CX.parseIntervalWeeks("3 days")).toBe(1);
  });

  it("returns null when no interval can be read", () => {
    expect(CX.parseIntervalWeeks("Subscribe & save")).toBeNull();
    expect(CX.parseIntervalWeeks("")).toBeNull();
    expect(CX.parseIntervalWeeks(null)).toBeNull();
  });
});

describe("normalizePlans", () => {
  it("keeps percentage adjustments and zeroes non-percentage ones", () => {
    const plans = CX.normalizePlans([
      { id: 1, name: "Every 4 weeks", option: "4 Weeks", valueType: "percentage", value: 10 },
      { id: 2, name: "Every 8 weeks", option: "8 Weeks", valueType: "fixed_amount", value: 500 },
    ]);
    expect(plans[0]).toEqual({
      id: 1,
      name: "Every 4 weeks",
      percentOff: 10,
      intervalWeeks: 4,
    });
    expect(plans[1].percentOff).toBe(0);
    expect(plans[1].intervalWeeks).toBe(8);
  });

  it("falls back to the plan name when the option carries no interval", () => {
    const plans = CX.normalizePlans([
      { id: 3, name: "Deliver every 6 weeks", option: "Auto", valueType: "percentage", value: 5 },
    ]);
    expect(plans[0].intervalWeeks).toBe(6);
  });

  it("handles empty input", () => {
    expect(CX.normalizePlans([])).toEqual([]);
    expect(CX.normalizePlans(null)).toEqual([]);
  });
});

describe("pickPlanForWeeks", () => {
  const plans: NormalizedPlan[] = [
    { id: 1, name: "4w", percentOff: 10, intervalWeeks: 4 },
    { id: 2, name: "8w", percentOff: 12, intervalWeeks: 8 },
    { id: 3, name: "12w", percentOff: 15, intervalWeeks: 12 },
  ];

  it("returns the exact interval match", () => {
    expect(CX.pickPlanForWeeks(plans, 8)?.id).toBe(2);
  });

  it("returns the closest plan when no exact match exists", () => {
    expect(CX.pickPlanForWeeks(plans, 7)?.id).toBe(2);
    expect(CX.pickPlanForWeeks(plans, 5)?.id).toBe(1);
  });

  it("prefers plans with a known interval over unknown ones", () => {
    const mixed: NormalizedPlan[] = [
      { id: 9, name: "?", percentOff: 20, intervalWeeks: null },
      { id: 1, name: "4w", percentOff: 10, intervalWeeks: 4 },
    ];
    expect(CX.pickPlanForWeeks(mixed, 4)?.id).toBe(1);
  });

  it("returns null for an empty plan list", () => {
    expect(CX.pickPlanForWeeks([], 4)).toBeNull();
    expect(CX.pickPlanForWeeks(null, 4)).toBeNull();
  });
});

describe("price math (integer cents)", () => {
  it("planPriceCents applies the percent discount with rounding", () => {
    expect(CX.planPriceCents(4500, 15)).toBe(3825);
    expect(CX.planPriceCents(4500, 0)).toBe(4500);
    expect(CX.planPriceCents(999, 10)).toBe(899); // 899.1 → 899
  });

  it("computeSavingsPercent inverts the discount", () => {
    expect(CX.computeSavingsPercent(4500, 3825)).toBe(15);
    expect(CX.computeSavingsPercent(4500, 4500)).toBe(0);
    expect(CX.computeSavingsPercent(0, 100)).toBe(0);
    expect(CX.computeSavingsPercent(4500, null)).toBe(0);
  });

  it("maxPercentOff finds the best plan discount", () => {
    expect(
      CX.maxPercentOff([{ percentOff: 5 }, { percentOff: 12 }, { percentOff: 8 }]),
    ).toBe(12);
    expect(CX.maxPercentOff([])).toBe(0);
  });
});

describe("estimateAnnualSavingCents", () => {
  it("computes per-cycle saving × cycles per year", () => {
    // unit 45.00, 15% off → 6.75 saved per unit; qty 2 → 13.50/cycle;
    // every 8 weeks → 6.5 cycles/year → 87.75
    expect(CX.estimateAnnualSavingCents(4500, 15, 2, 8)).toBe(8775);
  });

  it("is zero without a discount or without a cadence", () => {
    expect(CX.estimateAnnualSavingCents(4500, 0, 2, 8)).toBe(0);
    expect(CX.estimateAnnualSavingCents(4500, 15, 2, null)).toBe(0);
    expect(CX.cyclesPerYear(0)).toBe(0);
  });
});

describe("committed card (splitPlans / initialMode / pool selection)", () => {
  // Mirrors the demo harness: 15% standard plans + 20% committed plans.
  const group: NormalizedPlan[] = [
    { id: 101, name: "Every 4 weeks", percentOff: 15, intervalWeeks: 4 },
    { id: 102, name: "Every 8 weeks", percentOff: 15, intervalWeeks: 8 },
    { id: 103, name: "Every 12 weeks", percentOff: 15, intervalWeeks: 12 },
    { id: 201, name: "Committed — every 4 weeks", percentOff: 20, intervalWeeks: 4 },
    { id: 202, name: "Committed — every 8 weeks", percentOff: 20, intervalWeeks: 8 },
    { id: 203, name: "Committed — every 12 weeks", percentOff: 20, intervalWeeks: 12 },
  ];

  it("splits by explicit id list (string/number ids compared as strings)", () => {
    const split = CX.splitPlans(group, ["201", 202, 203], null);
    expect(split.committed.map((p) => p.id)).toEqual([201, 202, 203]);
    expect(split.standard.map((p) => p.id)).toEqual([101, 102, 103]);
  });

  it("idTail reduces GIDs to their numeric tail and passes bare ids through", () => {
    expect(CX.idTail("gid://shopify/SellingPlan/201")).toBe("201");
    expect(CX.idTail(201)).toBe("201");
    expect(CX.idTail("201")).toBe("201");
    expect(CX.idTail("no-slash")).toBe("no-slash");
  });

  it("splits by GID id list against Liquid's numeric plan ids", () => {
    // Regression: resolveWidget attaches committed.planIds as GraphQL GIDs
    // (pushSellingPlanConfig writes shopifyPlanId back as a GID) while the
    // plans hydrated from Liquid carry numeric ids. A raw string compare
    // never matched, the committed pool came back EMPTY, and enabling the
    // committed card in the admin HID the Liquid-rendered card on the
    // storefront. Both sides must reduce to the numeric tail.
    const split = CX.splitPlans(
      group,
      [
        "gid://shopify/SellingPlan/201",
        "gid://shopify/SellingPlan/202",
        "gid://shopify/SellingPlan/203",
      ],
      "commit",
    );
    expect(split.committed.map((p) => p.id)).toEqual([201, 202, 203]);
    expect(split.standard.map((p) => p.id)).toEqual([101, 102, 103]);
  });

  it("falls back to case-insensitive name matching when no ids are given", () => {
    const split = CX.splitPlans(group, [], "COMMIT");
    expect(split.committed.map((p) => p.id)).toEqual([201, 202, 203]);
    expect(split.standard.map((p) => p.id)).toEqual([101, 102, 103]);
  });

  it("prefers the id list over name matching and handles no criteria", () => {
    // an id list that names only one plan wins over a broader name match
    const split = CX.splitPlans(group, [202], "commit");
    expect(split.committed.map((p) => p.id)).toEqual([202]);
    expect(split.standard).toHaveLength(5);
    // no ids + no match → everything standard
    const none = CX.splitPlans(group, [], "");
    expect(none.committed).toEqual([]);
    expect(none.standard).toHaveLength(6);
  });

  it("committed mode + 8-week cadence picks the committed 8-week plan", () => {
    const split = CX.splitPlans(group, [201, 202, 203], "");
    expect(CX.pickPlanForWeeks(split.committed, 8)?.id).toBe(202);
    // the treatment pool still resolves to its own 8-week plan
    expect(CX.pickPlanForWeeks(split.standard, 8)?.id).toBe(102);
  });

  it("initialMode: committed at position 1 is the pre-selected default", () => {
    expect(
      CX.initialMode({ hasPlans: true, committedEnabled: true, committedPosition: "1" }),
    ).toBe("committed");
    expect(
      CX.initialMode({ hasPlans: true, committedEnabled: true, committedPosition: "2" }),
    ).toBe("treatment");
    expect(
      CX.initialMode({ hasPlans: true, committedEnabled: false, committedPosition: "1" }),
    ).toBe("treatment");
    expect(
      CX.initialMode({ hasPlans: false, committedEnabled: true, committedPosition: "1" }),
    ).toBe("basic");
    expect(CX.initialMode(null)).toBe("basic");
  });

  it("prices the 20% committed plan (7900 → 6320, savings read back as 20%)", () => {
    expect(CX.planPriceCents(7900, 20)).toBe(6320);
    expect(CX.computeSavingsPercent(7900, 6320)).toBe(20);
    // committed % must be set higher than standard, so per-unit never worsens
    expect(CX.planPriceCents(7900, 20)).toBeLessThan(CX.planPriceCents(7900, 15));
  });
});

describe("Subscription Max style", () => {
  describe("resolveStyle (Liquid ↔ widget-config seam)", () => {
    it("config style wins over the Liquid-resolved style", () => {
      expect(CX.resolveStyle("choice", "max")).toBe("max");
      expect(CX.resolveStyle("max", "choice")).toBe("choice");
    });

    it("falls back to the Liquid style without a config override", () => {
      expect(CX.resolveStyle("max", null)).toBe("max");
      expect(CX.resolveStyle("choice", undefined)).toBe("choice");
    });

    it("ignores unrecognised values layer by layer, defaulting to choice", () => {
      // bad config → Liquid style survives
      expect(CX.resolveStyle("max", "mega")).toBe("max");
      // bad config + bad Liquid → safe default
      expect(CX.resolveStyle("fancy", "mega")).toBe("choice");
      expect(CX.resolveStyle(null, null)).toBe("choice");
    });

    it("tolerates case and whitespace on both sides", () => {
      expect(CX.resolveStyle(" MAX ", null)).toBe("max");
      expect(CX.resolveStyle(null, "Choice ")).toBe("choice");
    });
  });

  describe("fillPriceToken (basic-link templates)", () => {
    it("fills the __PRICE__ token in the demote/return templates", () => {
      expect(
        CX.fillPriceToken("Prefer a single delivery? Buy once for __PRICE__", "€79,00"),
      ).toBe("Prefer a single delivery? Buy once for €79,00");
      expect(
        CX.fillPriceToken(
          "Buying once at __PRICE__ — switch back to Continuous Treatment",
          "€79,00",
        ),
      ).toBe("Buying once at €79,00 — switch back to Continuous Treatment");
    });

    it("fills every occurrence and survives missing inputs", () => {
      expect(CX.fillPriceToken("__PRICE__ and __PRICE__", "x")).toBe("x and x");
      expect(CX.fillPriceToken("no token", "€1,00")).toBe("no token");
      expect(CX.fillPriceToken(null, "€1,00")).toBe("");
      expect(CX.fillPriceToken("__PRICE__", null)).toBe("");
    });
  });

  describe("DOM-layer seams (source contract, node env — no DOM to boot)", () => {
    const src = readFileSync(assetPath, "utf8");

    it("stamps the style into every choice-widget telemetry payload", () => {
      // tele() builds the payload for impression / select_* / nudge_* /
      // add_to_cart alike, so one stamp covers them all.
      expect(src).toMatch(/style:\s*state\.style/);
    });

    it("suppresses the Widget E nudge in max style unless opted back in", () => {
      expect(src).toMatch(/state\.style === 'max' && !state\.nudgeInMax/);
    });

    it("consumes the widget-config style override via restyleTo", () => {
      expect(src).toMatch(/if \(s\.style\) restyleTo\(s\.style\);/);
      expect(src).toMatch(/function restyleTo\(style\)/);
    });

    it("keeps the basic link a real button with aria-pressed state", () => {
      expect(src).toMatch(/data-cxw-basic-back-template/);
      expect(src).toMatch(/setAttribute\('aria-pressed', inBasic \? 'true' : 'false'\)/);
    });

    it("routes the first-touch candidate through sanitizeFirstTouch", () => {
      // own-store referrers must be harvested + blanked before persisting
      expect(src).toMatch(/CX\.sanitizeFirstTouch\(\s*doc\.referrer/);
    });

    it("sends the block's market handle to the widget-config fetch", () => {
      expect(src).toMatch(/market:\s*ga\(root,\s*'data-market'\)/);
      expect(src).toMatch(
        /'&market=' \+ encodeURIComponent\(state\.market\)/,
      );
    });

    it("keeps hidden cards out of the roving radiogroup and repairs tab reach", () => {
      // arrows walk past hidden items…
      expect(src).toMatch(/function visibleFrom\(idx, dir\)/);
      expect(src).toMatch(/if \(el\.hasAttribute\('hidden'\)\) return;/);
      // …and render() re-anchors tabindex when the mode lives on no visible card
      expect(src).toMatch(
        /if \(!tabReachable && tabAnchor\) tabAnchor\.setAttribute\('tabindex', '0'\);/,
      );
    });

    it("returns the quiet basic link to the plan mode the shopper left", () => {
      expect(src).toMatch(
        /if \(state\.mode !== 'basic'\) state\.lastPlanMode = state\.mode;/,
      );
      expect(src).toMatch(
        /state\.lastPlanMode === 'committed' && committedOn\(\)/,
      );
    });
  });
});

describe("Subscription Max Ultra style", () => {
  describe("resolveStyle accepts ultra (Liquid ↔ widget-config seam)", () => {
    it("resolves ultra from either layer, config winning", () => {
      expect(CX.resolveStyle("ultra", null)).toBe("ultra");
      expect(CX.resolveStyle("choice", "ultra")).toBe("ultra");
      expect(CX.resolveStyle("max", "ultra")).toBe("ultra");
      // explicit-only override preserved: config can also pull BACK out
      expect(CX.resolveStyle("ultra", "choice")).toBe("choice");
      expect(CX.resolveStyle("ultra", "max")).toBe("max");
    });

    it("collapse rules: near-misses are not ultra", () => {
      // bad config → Liquid ultra survives
      expect(CX.resolveStyle("ultra", "mega")).toBe("ultra");
      // anything that is not exactly choice/max/ultra collapses to choice
      expect(CX.resolveStyle("ultrb", null)).toBe("choice");
      expect(CX.resolveStyle("maxultra", null)).toBe("choice");
      expect(CX.resolveStyle(null, "ultra!")).toBe("choice");
    });

    it("tolerates case and whitespace", () => {
      expect(CX.resolveStyle(" ULTRA ", null)).toBe("ultra");
      expect(CX.resolveStyle(null, "Ultra ")).toBe("ultra");
    });
  });

  describe("initialMode in ultra (no cards, no radiogroup)", () => {
    it("is treatment even when committed sits at position 1", () => {
      // committed is choice-framing — NEVER the ultra default
      expect(
        CX.initialMode({
          hasPlans: true,
          committedEnabled: true,
          committedPosition: "1",
          style: "ultra",
        }),
      ).toBe("treatment");
      expect(CX.initialMode({ hasPlans: true, style: "ultra" })).toBe("treatment");
    });

    it("stays basic without plans and leaves other styles untouched", () => {
      expect(CX.initialMode({ hasPlans: false, style: "ultra" })).toBe("basic");
      expect(
        CX.initialMode({
          hasPlans: true,
          committedEnabled: true,
          committedPosition: "1",
          style: "max",
        }),
      ).toBe("committed");
    });
  });

  describe("planUnitCents (drives the ultra price line)", () => {
    const variant = {
      priceCents: 7900,
      planPrices: { "101": 6715, "201": 6320 },
    };

    it("prefers the variant's allocation price for the plan", () => {
      expect(CX.planUnitCents(variant, { id: 101, percentOff: 15 })).toBe(6715);
      expect(CX.planUnitCents(variant, { id: "201", percentOff: 20 })).toBe(6320);
    });

    it("falls back to percent math when no allocation exists", () => {
      expect(CX.planUnitCents(variant, { id: 999, percentOff: 15 })).toBe(6715);
      expect(
        CX.planUnitCents({ priceCents: 7900 }, { id: 1, percentOff: 20 }),
      ).toBe(6320);
    });

    it("returns the one-time price without a plan and 0 without a variant", () => {
      expect(CX.planUnitCents(variant, null)).toBe(7900);
      expect(CX.planUnitCents(null, { id: 101, percentOff: 15 })).toBe(0);
    });
  });

  describe("ultra link templates (neutral copy, both states)", () => {
    // the shipped locale defaults (cellexia.ultra.*)
    const link = "Prefer a single delivery? Buy once for __PRICE__";
    const back = "Buying once at __PRICE__ — switch back";

    it("fills the neutral demote/return templates", () => {
      expect(CX.fillPriceToken(link, "€79,00")).toBe(
        "Prefer a single delivery? Buy once for €79,00",
      );
      expect(CX.fillPriceToken(back, "€79,00")).toBe(
        "Buying once at €79,00 — switch back",
      );
    });

    it("never names the plan — no subscription concept leaks", () => {
      for (const copy of [CX.fillPriceToken(link, "€79,00"), CX.fillPriceToken(back, "€79,00")]) {
        expect(copy.toLowerCase()).not.toContain("treatment");
        expect(copy.toLowerCase()).not.toContain("subscription");
        expect(copy.toLowerCase()).not.toContain("plan");
        expect(copy.toLowerCase()).not.toContain("save");
      }
    });
  });

  describe("locale defaults (en.default.json)", () => {
    const locales = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../extensions/treatment-widgets/locales/en.default.json",
        ),
        "utf8",
      ),
    ) as { cellexia: { ultra: { basic_link: string; basic_back: string } } };

    it("ships neutral ultra link keys, distinct from the max back copy", () => {
      expect(locales.cellexia.ultra.basic_link).toBe(
        "Prefer a single delivery? Buy once for {{ price }}",
      );
      expect(locales.cellexia.ultra.basic_back).toBe(
        "Buying once at {{ price }} — switch back",
      );
      expect(locales.cellexia.ultra.basic_back.toLowerCase()).not.toContain(
        "treatment",
      );
    });
  });

  describe("DOM-layer seams (source contract, node env — no DOM to boot)", () => {
    const src = readFileSync(assetPath, "utf8");

    it("suppresses the Widget E nudge in ultra unconditionally", () => {
      // before the max check, with no opt-back-in setting
      expect(src).toMatch(/if \(state\.style === 'ultra'\) return;/);
    });

    it("keeps committed out of play in ultra (committedOn gate)", () => {
      expect(src).toMatch(
        /return state\.style !== 'ultra' && state\.cmEnabled && !!state\.pools\.committed\.length;/,
      );
    });

    it("restyles across all three styles and drops committed → treatment", () => {
      expect(src).toMatch(/root\.classList\.remove\('cxw--ultra'\);/);
      expect(src).toMatch(
        /if \(state\.mode === 'committed'\) \{\s*state\.mode = 'treatment';/,
      );
      // committed options in the rhythm select are disabled in ultra
      expect(src).toMatch(/function setCommittedOptions\(off\)/);
    });

    it("syncs the ultra price line to the plan UNIT price (never a total)", () => {
      expect(src).toMatch(/data-cxw-ultra-price/);
      expect(src).toMatch(
        /setText\(els\.ultraPrice, money\(state\.mode !== 'basic' && state\.plan \? planUnit : unit\)\);/,
      );
    });

    it("honors the show_* line toggles in every style", () => {
      expect(src).toMatch(/ga\(root,'data-show-cadence-line'\) !== 'false'/);
      expect(src).toMatch(/ga\(root,'data-show-permonth-line'\) !== 'false'/);
      expect(src).toMatch(/ga\(root,'data-show-price-line'\) !== 'false'/);
      expect(src).toMatch(/state\.showPermonth/);
      expect(src).toMatch(/state\.showCadence/);
      expect(src).toMatch(/state\.showPriceLine/);
    });

    it("swaps to the NEUTRAL ultra link templates when the style is ultra", () => {
      expect(src).toMatch(/data-cxw-ultra-back-template/);
      expect(src).toMatch(/data-cxw-ultra-link-template/);
    });

    it("telemetry style stamp covers ultra (same tele() field as max)", () => {
      // style: state.style flows through CX.resolveStyle, which now emits
      // 'ultra' — every impression/select_*/add_to_cart event carries it
      expect(src).toMatch(/style:\s*state\.style/);
      expect(CX.resolveStyle("ultra", null)).toBe("ultra");
    });
  });
});

describe("treatment-choice.liquid seam contracts", () => {
  const liquid = readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../extensions/treatment-widgets/blocks/treatment-choice.liquid",
    ),
    "utf8",
  );

  it("stamps the market handle for the widget-config fetch", () => {
    expect(liquid).toMatch(
      /data-market="\{\{ localization\.market\.handle \}\}"/,
    );
  });

  it("mirrors the JS stdPool() rule for the default-plan pick", () => {
    // pass 1 always filters committed-named plans (not only when the
    // committed card is on)…
    expect(liquid).toMatch(/cxw_pass == 1 and cxw_cm_match != blank/);
    // …and pass 2 reruns without the filter only when nothing was picked,
    // matching the JS fallback `standard.length ? standard : plans`
    expect(liquid).toMatch(/cxw_pass == 2 and cxw_default_plan_id != 0/);
  });

  it("offers ultra everywhere a style is chosen, collapsing near-misses", () => {
    // block select
    expect(liquid).toMatch(/"value": "ultra"/);
    // market_styles whitelist
    expect(liquid).toMatch(
      /cxw_pair_style == 'max' or cxw_pair_style == 'choice' or cxw_pair_style == 'ultra'/,
    );
    // final collapse rule
    expect(liquid).toMatch(/unless cxw_style == 'max' or cxw_style == 'ultra'/);
  });

  it("ultra renders no heading, no cards and no nudge", () => {
    expect(liquid).toMatch(/unless cxw_style == 'ultra' -%\}\s*<h3 class="cxw-heading"/);
    expect(liquid).toMatch(
      /enable_widget_a and cxw_has_plans and customer\.b2b\? != true and cxw_style != 'ultra'/,
    );
    expect(liquid).toMatch(
      /\{%- if cxw_style == 'ultra' -%\}\s*\{%- assign cxw_nudge_ok = false -%\}/,
    );
  });

  it("ultra never pre-selects committed and keeps it out of the rhythm select", () => {
    expect(liquid).toMatch(/cxw_cm_on and cxw_cm_pos == '1' and cxw_style != 'ultra'/);
    expect(liquid).toMatch(/cxw_style == 'ultra' and cxw_cm_match != blank/);
  });

  it("renders the minimal price line, hidden outside ultra/show_price_line", () => {
    expect(liquid).toMatch(/data-cxw-ultra-price/);
    expect(liquid).toMatch(
      /unless cxw_style == 'ultra' and block\.settings\.show_price_line %\}hidden/,
    );
    expect(liquid).toMatch(/data-show-price-line="\{\{ block\.settings\.show_price_line \}\}"/);
  });

  it("wraps the cadence and per-month lines in their show_* settings", () => {
    expect(liquid).toMatch(/\{%- if block\.settings\.show_cadence_line -%\}/);
    expect(liquid).toMatch(/\{%- if block\.settings\.show_permonth_line -%\}/);
    expect(liquid).toMatch(/data-show-cadence-line="\{\{ block\.settings\.show_cadence_line \}\}"/);
    expect(liquid).toMatch(/data-show-permonth-line="\{\{ block\.settings\.show_permonth_line \}\}"/);
  });

  it("labels the quantity pills from quantity_label in every style", () => {
    expect(liquid).toMatch(
      /if block\.settings\.quantity_label != blank -%\}\{\{ block\.settings\.quantity_label \}\}/,
    );
  });

  it("stamps BOTH link template sets — the ultra pair from the neutral locale keys", () => {
    expect(liquid).toMatch(/data-cxw-ultra-link-template/);
    expect(liquid).toMatch(/data-cxw-ultra-back-template/);
    expect(liquid).toMatch(/cellexia\.ultra\.basic_link/);
    expect(liquid).toMatch(/cellexia\.ultra\.basic_back/);
    // merchant overrides use {price}, held in a variable so the literal
    // brace never sits inside a {{ }} output tag (breaks Shopify's validator)
    expect(liquid).toMatch(/assign cxw_price_placeholder = '\{price\}'/);
    expect(liquid).toMatch(
      /ultra_link_copy \| replace: cxw_price_placeholder, '__PRICE__'/,
    );
    expect(liquid).toMatch(
      /ultra_link_back_copy \| replace: cxw_price_placeholder, '__PRICE__'/,
    );
    // the link renders (hidden or not) for max AND ultra
    expect(liquid).toMatch(/unless cxw_style == 'max' or cxw_style == 'ultra' %\}hidden/);
  });
});

describe("parseTrackingParams", () => {
  it("keeps only utm_*, gclid and fbclid, decoding values", () => {
    expect(
      CX.parseTrackingParams(
        "?utm_source=facebook&utm_campaign=summer%20launch&gclid=g1&fbclid=f1&irrelevant=x",
      ),
    ).toEqual({
      utm_source: "facebook",
      utm_campaign: "summer launch",
      gclid: "g1",
      fbclid: "f1",
    });
  });

  it("drops empty values, tolerates missing '?' and bad encodings", () => {
    expect(CX.parseTrackingParams("utm_source=tiktok&utm_medium=")).toEqual({
      utm_source: "tiktok",
    });
    expect(CX.parseTrackingParams("utm_source=%E0%A4%A")).toEqual({});
    expect(CX.parseTrackingParams("")).toEqual({});
    expect(CX.parseTrackingParams(null)).toEqual({});
  });
});

describe("sanitizeFirstTouch (own-store referrers never poison first touch)", () => {
  it("blanks a same-host referrer and recovers its tracking params", () => {
    // ad → widget-less homepage (?utm...) → internal click to a product page:
    // the entry UTMs live only on the referrer URL, which same-origin
    // referrer policy keeps in full
    const out = CX.sanitizeFirstTouch(
      "https://shop.example.com/?utm_source=facebook&fbclid=f1",
      "shop.example.com",
      {},
    );
    expect(out.referrer).toBe("");
    expect(out.utm).toEqual({ utm_source: "facebook", fbclid: "f1" });
  });

  it("current-page params win over recovered referrer params", () => {
    const out = CX.sanitizeFirstTouch(
      "https://shop.example.com/collections/all?utm_source=facebook&utm_campaign=old",
      "shop.example.com",
      { utm_source: "google" },
    );
    expect(out.referrer).toBe("");
    expect(out.utm).toEqual({ utm_source: "google", utm_campaign: "old" });
  });

  it("blanks a bare same-host referrer so 'direct' derives server-side", () => {
    const out = CX.sanitizeFirstTouch("https://shop.example.com/", "shop.example.com", {});
    expect(out.referrer).toBe("");
    expect(out.utm).toEqual({});
  });

  it("matches the host case-insensitively, ignoring port and userinfo", () => {
    expect(
      CX.sanitizeFirstTouch("https://Shop.Example.com:443/x", "shop.example.com", {})
        .referrer,
    ).toBe("");
    expect(
      CX.sanitizeFirstTouch("https://user@shop.example.com/x", "shop.example.com", {})
        .referrer,
    ).toBe("");
  });

  it("leaves external referrers and their params untouched", () => {
    const out = CX.sanitizeFirstTouch(
      "https://some-magazine.fr/article?utm_source=mag",
      "shop.example.com",
      { utm_source: "google" },
    );
    expect(out.referrer).toBe("https://some-magazine.fr/article?utm_source=mag");
    expect(out.utm).toEqual({ utm_source: "google" });
  });

  it("harvests only utm_* / gclid / fbclid, ignoring the fragment", () => {
    const out = CX.sanitizeFirstTouch(
      "https://shop.example.com/?utm_source=meta&other=x#utm_medium=nope",
      "shop.example.com",
      {},
    );
    expect(out.utm).toEqual({ utm_source: "meta" });
  });

  it("survives blank or unparseable inputs", () => {
    expect(CX.sanitizeFirstTouch("", "shop.example.com", {})).toEqual({
      referrer: "",
      utm: {},
    });
    expect(CX.sanitizeFirstTouch(null, "shop.example.com", null)).toEqual({
      referrer: "",
      utm: {},
    });
    expect(
      CX.sanitizeFirstTouch("not a url", "shop.example.com", {}).referrer,
    ).toBe("not a url");
    // no own host known → nothing is blanked
    expect(
      CX.sanitizeFirstTouch("https://shop.example.com/", "", {}).referrer,
    ).toBe("https://shop.example.com/");
  });
});

describe("firstTouch (30-day first-touch window)", () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const candidate: FirstTouchContext = {
    firstSeenAt: "2026-08-02T12:00:00.000Z",
    referrer: "https://new-referrer.example/",
    landing: "/pages/new",
    utm: { utm_source: "google" },
  };

  it("keeps a stored context that is still fresh", () => {
    const stored = { firstSeenAt: "2026-07-20T00:00:00.000Z" };
    expect(CX.firstTouch(stored, candidate, now)).toBe(stored);
  });

  it("replaces a context older than 30 days", () => {
    const stale = { firstSeenAt: "2026-06-01T00:00:00.000Z" };
    expect(CX.firstTouch(stale, candidate, now)).toBe(candidate);
  });

  it("replaces missing, malformed or future-dated contexts", () => {
    expect(CX.firstTouch(null, candidate, now)).toBe(candidate);
    expect(CX.firstTouch({}, candidate, now)).toBe(candidate);
    expect(CX.firstTouch({ firstSeenAt: "garbage" }, candidate, now)).toBe(
      candidate,
    );
    expect(
      CX.firstTouch({ firstSeenAt: "2026-09-01T00:00:00.000Z" }, candidate, now),
    ).toBe(candidate);
  });

  it("uses a 30-day TTL", () => {
    expect(CX.CONTEXT_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("safeJsonAttr (attribute-size-safe JSON)", () => {
  it("returns the full JSON when it fits", () => {
    const json = CX.safeJsonAttr({ utm_source: "facebook", gclid: "g1" });
    expect(JSON.parse(json)).toEqual({ utm_source: "facebook", gclid: "g1" });
  });

  it("drops tail keys until the JSON fits and always stays parseable", () => {
    const big: Record<string, string> = {
      utm_source: "facebook",
      utm_campaign: "x".repeat(400),
    };
    const json = CX.safeJsonAttr(big, 100);
    expect(json.length).toBeLessThanOrEqual(100);
    expect(JSON.parse(json)).toEqual({ utm_source: "facebook" });
  });

  it("degrades to '{}' when nothing fits", () => {
    expect(CX.safeJsonAttr({ k: "v".repeat(300) }, 10)).toBe("{}");
    expect(CX.safeJsonAttr(null)).toBe("{}");
  });
});

describe("buildCartAttributes (cart attribute contract)", () => {
  const fullCtx = {
    visitor: "v1abc123",
    firstSeenAt: "2026-08-02T10:29:00.000Z",
    referrer: "https://www.instagram.com/",
    landing: "/pages/serum",
    utm: { utm_source: "facebook", fbclid: "f1" },
    widgetType: "TREATMENT_CHOICE",
    experimentKey: "exp42:variant-b",
    device: "mobile",
    qty: 2,
    discountPercent: 15,
  };

  it("emits the full _cellexia_* attribute set from the data contract", () => {
    const attrs = CX.buildCartAttributes(fullCtx);
    expect(attrs["_cellexia_visitor"]).toBe("v1abc123");
    expect(attrs["_cellexia_first_seen"]).toBe("2026-08-02T10:29:00.000Z");
    expect(attrs["_cellexia_referrer"]).toBe("https://www.instagram.com/");
    expect(attrs["_cellexia_landing"]).toBe("/pages/serum");
    expect(JSON.parse(attrs["_cellexia_utm"])).toEqual({
      utm_source: "facebook",
      fbclid: "f1",
    });
    expect(attrs["_cellexia_widget"]).toBe("TREATMENT_CHOICE:variant-b");
    expect(attrs["_cellexia_experiment"]).toBe("exp42:variant-b");
    expect(attrs["_cellexia_device"]).toBe("mobile");
    expect(attrs["_cellexia_qty"]).toBe("2");
    expect(attrs["_cellexia_discount_percent"]).toBe("15");
  });

  it("keeps every value under 250 characters", () => {
    const attrs = CX.buildCartAttributes({
      ...fullCtx,
      referrer: "https://example.com/" + "a".repeat(500),
      utm: { utm_source: "facebook", utm_content: "y".repeat(500) },
    });
    for (const key of Object.keys(attrs)) {
      expect(attrs[key].length).toBeLessThan(250);
    }
    // the truncated utm JSON must still parse (whole keys dropped, not cut)
    expect(JSON.parse(attrs["_cellexia_utm"])).toEqual({ utm_source: "facebook" });
  });

  it("omits empty values so blanks never overwrite real cart data", () => {
    const attrs = CX.buildCartAttributes({
      visitor: "v1abc123",
      referrer: "",
      utm: {},
      qty: 0,
      discountPercent: 0,
    });
    expect(attrs["_cellexia_visitor"]).toBe("v1abc123");
    expect("_cellexia_referrer" in attrs).toBe(false);
    expect("_cellexia_utm" in attrs).toBe(false);
    expect("_cellexia_qty" in attrs).toBe(false);
    expect("_cellexia_discount_percent" in attrs).toBe(false);
    expect("_cellexia_experiment" in attrs).toBe(false);
  });

  it("defaults the widget identity to TREATMENT_CHOICE:v1", () => {
    expect(CX.buildCartAttributes({ visitor: "v1" })["_cellexia_widget"]).toBe(
      "TREATMENT_CHOICE:v1",
    );
    expect(
      CX.buildCartAttributes({ widgetType: "CART_CONVERSION" })[
        "_cellexia_widget"
      ],
    ).toBe("CART_CONVERSION:v1");
    expect(CX.buildCartAttributes(null)["_cellexia_widget"]).toBe(
      "TREATMENT_CHOICE:v1",
    );
  });

  it("writes the discount percent only when a plan discount applies", () => {
    // this is the source-side fix for the permanently blank savings tile:
    // initialDiscountPercent is parsed from _cellexia_discount_percent
    expect(
      CX.buildCartAttributes({ discountPercent: 20 })[
        "_cellexia_discount_percent"
      ],
    ).toBe("20");
    expect(
      "_cellexia_discount_percent" in CX.buildCartAttributes({ discountPercent: null }),
    ).toBe(false);
  });
});

describe("formatMoney", () => {
  it("renders the common Shopify money formats", () => {
    expect(CX.formatMoney(500, "${{amount}}")).toBe("$5.00");
    expect(CX.formatMoney(123456, "€{{amount_with_comma_separator}}")).toBe("€1.234,56");
    expect(CX.formatMoney(123456, "{{amount_no_decimals}} kr")).toBe("1,235 kr");
    expect(CX.formatMoney(123456, "CHF {{amount_with_apostrophe_separator}}")).toBe(
      "CHF 1'234.56",
    );
  });

  it("defaults to ${{amount}} and handles zero", () => {
    expect(CX.formatMoney(0)).toBe("$0.00");
  });
});
