/**
 * Unit tests for the pure cost-model engine (ANALYTICS-V2 §1) in
 * app/services/analytics/costModel.server.ts: settings parsing + percent
 * normalisation, COGS precedence, and the full per-order LTGP formula.
 */
import { describe, expect, it } from "vitest";
import {
  orderContribution,
  parseCostModel,
  productCogsCents,
  UNCONFIGURED_COST_MODEL,
} from "~/services/analytics/costModel.server";
import type { CostModel } from "~/services/analytics/costModel.server";

function model(overrides: Partial<CostModel> = {}): CostModel {
  return {
    defaultMarginFraction: 0.7,
    shippingPerDeliveryCents: 0,
    fulfillmentPerDeliveryCents: 0,
    paymentFeeFraction: 0,
    paymentFeeFixedCents: 0,
    configured: true,
    ...overrides,
  };
}

describe("parseCostModel — unit rule (percents 0-100 in, fractions 0..1 out)", () => {
  it("returns unconfigured defaults when nothing was ever saved", () => {
    for (const raw of [null, undefined, "", "{}", "not json"]) {
      const m = parseCostModel(raw);
      expect(m).toEqual({
        defaultMarginFraction: 0.7,
        shippingPerDeliveryCents: 0,
        fulfillmentPerDeliveryCents: 0,
        paymentFeeFraction: 0,
        paymentFeeFixedCents: 0,
        configured: false,
      });
    }
    expect(UNCONFIGURED_COST_MODEL.configured).toBe(false);
  });

  it("marks configured once a costModel object exists, even an empty one", () => {
    const m = parseCostModel(JSON.stringify({ costModel: {} }));
    expect(m.configured).toBe(true);
    expect(m.defaultMarginFraction).toBe(0.7); // defaults still apply
  });

  it("normalises percents to fractions and keeps cents as integers", () => {
    const m = parseCostModel(
      JSON.stringify({
        costModel: {
          defaultGrossMarginPercent: 65,
          shippingPerDeliveryCents: 350,
          fulfillmentPerDeliveryCents: 120,
          paymentFeePercent: 1.9,
          paymentFeeFixedCents: 30,
        },
      }),
    );
    expect(m.defaultMarginFraction).toBeCloseTo(0.65, 10);
    expect(m.shippingPerDeliveryCents).toBe(350);
    expect(m.fulfillmentPerDeliveryCents).toBe(120);
    expect(m.paymentFeeFraction).toBeCloseTo(0.019, 10);
    expect(m.paymentFeeFixedCents).toBe(30);
    expect(m.configured).toBe(true);
  });

  it("clamps garbage instead of letting it poison profit math", () => {
    const m = parseCostModel(
      JSON.stringify({
        costModel: {
          defaultGrossMarginPercent: 250, // > 100% margin is impossible
          shippingPerDeliveryCents: -50, // negative costs are not costs
          paymentFeePercent: "abc",
          paymentFeeFixedCents: 29.6,
        },
      }),
    );
    expect(m.defaultMarginFraction).toBe(1);
    expect(m.shippingPerDeliveryCents).toBe(0);
    expect(m.paymentFeeFraction).toBe(0);
    expect(m.paymentFeeFixedCents).toBe(30); // rounded to integer cents
  });

  it("ignores a non-object costModel value", () => {
    expect(parseCostModel(JSON.stringify({ costModel: true })).configured).toBe(
      false,
    );
    expect(
      parseCostModel(JSON.stringify({ costModel: [1, 2] })).configured,
    ).toBe(false);
  });
});

describe("productCogsCents — precedence unitCostCents → grossMarginPercent → default", () => {
  const line = { priceCents: 10000, quantity: 2 };

  it("prefers explicit unit costs (× quantity)", () => {
    expect(
      productCogsCents(line, { unitCostCents: 3000, grossMarginPercent: 0.9 }, model()),
    ).toBe(6000);
  });

  it("falls back to the grossMarginPercent FRACTION", () => {
    expect(
      productCogsCents(line, { unitCostCents: null, grossMarginPercent: 0.75 }, model()),
    ).toBe(5000); // 20000 × (1 − 0.75)
  });

  it("falls back to the model default margin when meta has nothing", () => {
    expect(productCogsCents(line, null, model())).toBe(6000); // 20000 × 0.3
    expect(productCogsCents(line, {}, model({ defaultMarginFraction: 0.5 }))).toBe(
      10000,
    );
  });

  it("clamps a percent-style grossMarginPercent (unit-rule guard)", () => {
    // 72 is out of the 0..1 domain: clamped to 1 → zero COGS, never negative.
    expect(
      productCogsCents(line, { grossMarginPercent: 72 }, model()),
    ).toBe(0);
  });

  it("treats zero/negative quantity as no units", () => {
    expect(
      productCogsCents(
        { priceCents: 10000, quantity: 0 },
        { unitCostCents: 3000 },
        model(),
      ),
    ).toBe(0);
  });
});

describe("orderContribution — full LTGP per order", () => {
  it("applies the documented formula: revenue − COGS − shipping − fulfillment − fees", () => {
    const oc = orderContribution(
      {
        lines: [
          { priceCents: 10000, quantity: 1, meta: { unitCostCents: 3000 } },
          { priceCents: 5000, quantity: 2, meta: { grossMarginPercent: 0.8 } },
        ],
      },
      model({
        shippingPerDeliveryCents: 400,
        fulfillmentPerDeliveryCents: 150,
        paymentFeeFraction: 0.019,
        paymentFeeFixedCents: 30,
      }),
    );
    expect(oc.revenueCents).toBe(20000);
    expect(oc.cogsCents).toBe(3000 + 2000); // unit cost + 10000×0.2
    expect(oc.shippingCents).toBe(400);
    expect(oc.fulfillmentCents).toBe(150);
    expect(oc.paymentFeeCents).toBe(Math.round(20000 * 0.019) + 30); // 410
    expect(oc.contributionCents).toBe(20000 - 5000 - 400 - 150 - 410);
    expect(oc.contributionFraction).toBeCloseTo(14040 / 20000, 10);
  });

  it("per-delivery costs apply once per order, not per line", () => {
    const m = model({ shippingPerDeliveryCents: 500, fulfillmentPerDeliveryCents: 250 });
    const oc = orderContribution(
      {
        lines: [
          { priceCents: 1000, quantity: 1, meta: null },
          { priceCents: 1000, quantity: 1, meta: null },
          { priceCents: 1000, quantity: 1, meta: null },
        ],
      },
      m,
    );
    expect(oc.shippingCents).toBe(500);
    expect(oc.fulfillmentCents).toBe(250);
  });

  it("guards revenue 0: no payment fee, fraction 0", () => {
    const oc = orderContribution(
      { lines: [{ priceCents: 0, quantity: 1, meta: null }] },
      model({ paymentFeeFraction: 0.02, paymentFeeFixedCents: 30 }),
    );
    expect(oc.revenueCents).toBe(0);
    expect(oc.paymentFeeCents).toBe(0);
    expect(oc.contributionFraction).toBe(0);
  });

  it("returns all zeros for an order with no lines (no delivery, no fees)", () => {
    const oc = orderContribution(
      { lines: [] },
      model({ shippingPerDeliveryCents: 400, paymentFeeFixedCents: 30 }),
    );
    expect(oc).toEqual({
      revenueCents: 0,
      cogsCents: 0,
      shippingCents: 0,
      fulfillmentCents: 0,
      paymentFeeCents: 0,
      contributionCents: 0,
      contributionFraction: 0,
    });
  });

  it("never returns a fraction below −1 even when costs dwarf revenue", () => {
    const oc = orderContribution(
      { lines: [{ priceCents: 100, quantity: 1, meta: { unitCostCents: 5000 } }] },
      model({ shippingPerDeliveryCents: 900 }),
    );
    expect(oc.contributionCents).toBe(100 - 5000 - 900);
    expect(oc.contributionFraction).toBe(-1);
  });

  it("unconfigured shop degrades to the pure default-margin model", () => {
    const oc = orderContribution(
      { lines: [{ priceCents: 10000, quantity: 1, meta: null }] },
      UNCONFIGURED_COST_MODEL,
    );
    expect(oc.cogsCents).toBe(3000);
    expect(oc.contributionCents).toBe(7000);
    expect(oc.contributionFraction).toBeCloseTo(0.7, 10);
  });
});
