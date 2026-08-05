/**
 * Committed Treatment Plan settings — shared-contract regression tests.
 *
 * 1. DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE carries NO `committed` block:
 *    the block reaches the storefront only when a config/variant explicitly
 *    sets it, so the widget-config fetch can never stomp a Liquid-enabled
 *    committed card (mirrors the `style` rule).
 * 2. discountMonotonicityWarning runs separately per track: committed plans
 *    legitimately discount more than standard ones at the same interval, but
 *    a decreasing discount WITHIN a track still warns.
 *
 * discountMonotonicityWarning is imported from the pure offers module
 * (app/services/offers/planWarnings.ts) rather than the app.plans route —
 * the route drags server-only imports (shopify.server, db.server, Polaris)
 * into vitest; the route re-exports the same function.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WIDGET_SETTINGS } from "~/services/offers/widgets.server";
import {
  discountMonotonicityWarning,
  isCommittedPlan,
} from "~/services/offers/planWarnings";

describe("DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE committed block", () => {
  it("is INTENTIONALLY absent from the wire defaults", () => {
    // Regression (sweep 2): a default committed:{enabled:false, termsShort,
    // termsFull, ...} rode along on every widget-config response —
    // resolveWidget merges DEFAULT_WIDGET_SETTINGS under the (possibly
    // absent) admin config. The storefront's `cm.enabled === false` hide then
    // switched every Liquid-enabled committed card OFF ~0.5s after first
    // paint (flipping a position-1 committed pre-selection to treatment with
    // a visible ATC price jump) and the default terms copy overwrote the
    // merchant's Liquid-block committed terms. Same failure class as the
    // removed default `style` — the block must reach the storefront only
    // when a config/variant explicitly sets it.
    expect(
      Object.keys(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE),
    ).not.toContain("committed");
    expect(DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE.committed).toBeUndefined();
  });
});

describe("discountMonotonicityWarning — two tracks (standard vs committed)", () => {
  const standard = (name: string, intervalWeeks: number, percentOff: number) => ({
    name,
    intervalWeeks,
    percentOff,
  });
  const committedPlan = (
    name: string,
    intervalWeeks: number,
    percentOff: number,
    minDeliveries = 3,
  ) => ({ name, intervalWeeks, percentOff, minDeliveries, committed: true });

  it("does not warn when a committed plan discounts more than a standard plan at the same interval", () => {
    expect(
      discountMonotonicityWarning([
        committedPlan("Committed every 4 weeks", 4, 20),
        standard("Every 4 weeks", 4, 15),
      ]),
    ).toBeNull();
  });

  it("does not warn across tracks even when the standard plan at a longer interval discounts less than a shorter committed plan", () => {
    expect(
      discountMonotonicityWarning([
        committedPlan("Committed every 4 weeks", 4, 20),
        standard("Every 4 weeks", 4, 10),
        standard("Every 8 weeks", 8, 12),
        committedPlan("Committed every 8 weeks", 8, 22),
      ]),
    ).toBeNull();
  });

  it("warns on a decreasing discount within the committed track", () => {
    const warning = discountMonotonicityWarning([
      committedPlan("Committed every 4 weeks", 4, 25),
      committedPlan("Committed every 8 weeks", 8, 20),
    ]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("Committed every 8 weeks");
  });

  it("still warns on a decreasing discount within the standard track", () => {
    const warning = discountMonotonicityWarning([
      standard("Every 4 weeks", 4, 10),
      standard("Every 8 weeks", 8, 5),
    ]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("Every 8 weeks");
  });

  it("treats minDeliveries >= 2 as committed even without the explicit flag", () => {
    expect(isCommittedPlan({ name: "x", intervalWeeks: 4, percentOff: 20, minDeliveries: 2 })).toBe(
      true,
    );
    expect(isCommittedPlan({ name: "x", intervalWeeks: 4, percentOff: 20, minDeliveries: 1 })).toBe(
      false,
    );
    expect(
      discountMonotonicityWarning([
        { name: "Committed every 4 weeks", intervalWeeks: 4, percentOff: 20, minDeliveries: 3 },
        standard("Every 4 weeks", 4, 15),
      ]),
    ).toBeNull();
  });
});
