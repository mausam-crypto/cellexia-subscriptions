import { describe, expect, it, vi } from "vitest";

// Keep the unit tests free of a real Prisma client — only pure exports are used.
vi.mock("~/db.server", () => ({ default: {} }));

import {
  computeQualityScore,
  deriveOnboardingTier,
  dunningAggressiveness,
} from "~/services/treatment/quality.server";
import type { QualityFeatures } from "~/services/treatment/quality.server";

const baseline: QualityFeatures = {
  acquisitionSource: "direct",
  discountPercent: 10,
  quantity: 1,
  productMarginPercent: 0.6,
  hasPurchaseHistory: false,
  oneTimePurchases: 0,
  widgetEngaged: false,
  firstOrderMarginCents: 4000,
  refundRiskFlag: false,
};

describe("computeQualityScore", () => {
  it("stays within 0..100", () => {
    const worst = computeQualityScore({
      acquisitionSource: "deal_site",
      discountPercent: 90,
      quantity: 1,
      productMarginPercent: 0,
      hasPurchaseHistory: false,
      oneTimePurchases: 0,
      widgetEngaged: false,
      firstOrderMarginCents: -100000,
      refundRiskFlag: true,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);

    const best = computeQualityScore({
      acquisitionSource: "organic",
      discountPercent: 0,
      quantity: 5,
      productMarginPercent: 0.95,
      hasPurchaseHistory: true,
      oneTimePurchases: 10,
      widgetEngaged: true,
      firstOrderMarginCents: 100000,
      refundRiskFlag: false,
    });
    expect(best.score).toBeGreaterThan(worst.score);
    expect(best.score).toBeLessThanOrEqual(100);
  });

  it("equals base + factor contributions (rounded, clamped)", () => {
    const { score, factors } = computeQualityScore(baseline);
    const sum = Object.values(factors).reduce((total, v) => total + v, 0);
    expect(score).toBe(Math.min(100, Math.max(0, Math.round(sum))));
    expect(factors.base).toBe(50);
  });

  it("is monotonically decreasing in discountPercent", () => {
    const low = computeQualityScore({ ...baseline, discountPercent: 0 });
    const high = computeQualityScore({ ...baseline, discountPercent: 30 });
    expect(high.score).toBeLessThan(low.score);
  });

  it("rewards purchase history and one-time purchases", () => {
    const without = computeQualityScore(baseline);
    const withHistory = computeQualityScore({
      ...baseline,
      hasPurchaseHistory: true,
    });
    const withOneTimes = computeQualityScore({
      ...baseline,
      oneTimePurchases: 3,
    });
    expect(withHistory.score).toBeGreaterThan(without.score);
    expect(withOneTimes.score).toBeGreaterThan(without.score);
  });

  it("rewards larger quantities, capped", () => {
    const q1 = computeQualityScore({ ...baseline, quantity: 1 });
    const q3 = computeQualityScore({ ...baseline, quantity: 3 });
    const q4 = computeQualityScore({ ...baseline, quantity: 4 });
    const q9 = computeQualityScore({ ...baseline, quantity: 9 });
    expect(q3.score).toBeGreaterThan(q1.score);
    expect(q9.factors.quantity).toBe(q4.factors.quantity); // capped at +12
  });

  it("penalises refund risk by 20 points", () => {
    const clean = computeQualityScore(baseline);
    const flagged = computeQualityScore({ ...baseline, refundRiskFlag: true });
    expect(clean.score - flagged.score).toBe(20);
  });

  it("scores deal-site acquisition below organic", () => {
    const organic = computeQualityScore({ ...baseline, acquisitionSource: "organic" });
    const deal = computeQualityScore({ ...baseline, acquisitionSource: "deal_site" });
    expect(organic.score).toBeGreaterThan(deal.score);
  });

  it("treats unknown acquisition sources as neutral", () => {
    const { factors } = computeQualityScore({
      ...baseline,
      acquisitionSource: "something_new",
    });
    expect(factors.acquisitionSource).toBe(0);
  });

  it("scores the sources the webhook handler actually feeds it (v2 record)", () => {
    // Regression companion to the handlers.server fix: the widget's
    // _cellexia_utm utm_source flows through as-is (coupon_site → −10) and
    // attribute-less contracts arrive as deriveChannel's "direct" (+6),
    // never as the dead "unknown" (0) the legacy top-level utm map produced.
    const coupon = computeQualityScore({
      ...baseline,
      acquisitionSource: "coupon_site",
    });
    expect(coupon.factors.acquisitionSource).toBe(-10);
    const direct = computeQualityScore({
      ...baseline,
      acquisitionSource: "direct",
    });
    expect(direct.factors.acquisitionSource).toBe(6);
  });

  it("rewards widget engagement", () => {
    const engaged = computeQualityScore({ ...baseline, widgetEngaged: true });
    const not = computeQualityScore({ ...baseline, widgetEngaged: false });
    expect(engaged.score - not.score).toBe(5);
  });
});

describe("deriveOnboardingTier", () => {
  it("maps score bands to tiers", () => {
    expect(deriveOnboardingTier(85)).toBe("WHITE_GLOVE");
    expect(deriveOnboardingTier(70)).toBe("WHITE_GLOVE");
    expect(deriveOnboardingTier(69)).toBe("STANDARD");
    expect(deriveOnboardingTier(40)).toBe("STANDARD");
    expect(deriveOnboardingTier(39)).toBe("LIGHT");
    expect(deriveOnboardingTier(0)).toBe("LIGHT");
  });
});

describe("dunningAggressiveness", () => {
  it("treats high-quality subscribers gently and low-quality assertively", () => {
    expect(dunningAggressiveness(85)).toBe("GENTLE");
    expect(dunningAggressiveness(70)).toBe("GENTLE");
    expect(dunningAggressiveness(55)).toBe("STANDARD");
    expect(dunningAggressiveness(40)).toBe("STANDARD");
    expect(dunningAggressiveness(10)).toBe("ASSERTIVE");
  });
});
