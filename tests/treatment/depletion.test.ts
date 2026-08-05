import { describe, expect, it, vi } from "vitest";

// Keep the unit tests free of a real Prisma client — only pure exports are used.
vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/shopify.server", () => ({}));

import {
  predictRunOutDate,
  updateEstimateFromSignal,
  SIGNAL_USAGE_MULTIPLIERS,
} from "~/services/treatment/depletion.server";
import type { EstimateState } from "~/services/treatment/depletion.server";

const D = (s: string) => new Date(s);

describe("predictRunOutDate", () => {
  it("adds unitsDelivered / dailyUsage days to deliveredAt", () => {
    const runOut = predictRunOutDate({
      deliveredAt: D("2026-01-01T00:00:00Z"),
      unitsDelivered: 60,
      dailyUsage: 2,
    });
    expect(runOut).toEqual(D("2026-01-31T00:00:00Z"));
  });

  it("multiplies by unitContents when provided", () => {
    const runOut = predictRunOutDate({
      deliveredAt: D("2026-01-01T00:00:00Z"),
      unitsDelivered: 2,
      dailyUsage: 2,
      unitContents: 30,
    });
    expect(runOut).toEqual(D("2026-01-31T00:00:00Z"));
  });

  it("handles fractional day results", () => {
    const runOut = predictRunOutDate({
      deliveredAt: D("2026-01-01T00:00:00Z"),
      unitsDelivered: 3,
      dailyUsage: 2,
    });
    expect(runOut).toEqual(D("2026-01-02T12:00:00Z"));
  });

  it("guards against dailyUsage <= 0", () => {
    expect(() =>
      predictRunOutDate({
        deliveredAt: D("2026-01-01T00:00:00Z"),
        unitsDelivered: 30,
        dailyUsage: 0,
      }),
    ).toThrow();
    expect(() =>
      predictRunOutDate({
        deliveredAt: D("2026-01-01T00:00:00Z"),
        unitsDelivered: 30,
        dailyUsage: -1,
      }),
    ).toThrow();
  });

  it("guards against negative unitsDelivered and non-positive unitContents", () => {
    expect(() =>
      predictRunOutDate({
        deliveredAt: D("2026-01-01T00:00:00Z"),
        unitsDelivered: -1,
        dailyUsage: 1,
      }),
    ).toThrow();
    expect(() =>
      predictRunOutDate({
        deliveredAt: D("2026-01-01T00:00:00Z"),
        unitsDelivered: 1,
        dailyUsage: 1,
        unitContents: 0,
      }),
    ).toThrow();
  });
});

describe("updateEstimateFromSignal — behavioural multipliers", () => {
  const base: EstimateState = {
    estimatedDailyUsage: 2,
    confidence: 0.5,
    unitsOnHand: null,
    lastDeliveryAt: null,
  };

  it("EARLY_DELAY lowers usage by 15%", () => {
    const out = updateEstimateFromSignal(base, "EARLY_DELAY", {
      now: D("2026-02-01T00:00:00Z"),
    });
    expect(out.estimatedDailyUsage).toBeCloseTo(1.7);
  });

  it("BROUGHT_FORWARD raises usage by 15%", () => {
    const out = updateEstimateFromSignal(base, "BROUGHT_FORWARD", {
      now: D("2026-02-01T00:00:00Z"),
    });
    expect(out.estimatedDailyUsage).toBeCloseTo(2.3);
  });

  it("REPEATED_SKIPS lowers usage by 25%", () => {
    const out = updateEstimateFromSignal(base, "REPEATED_SKIPS", {
      now: D("2026-02-01T00:00:00Z"),
    });
    expect(out.estimatedDailyUsage).toBeCloseTo(1.5);
  });

  it("EXTRA_ONE_TIME_PURCHASE raises usage by 20%", () => {
    const out = updateEstimateFromSignal(base, "EXTRA_ONE_TIME_PURCHASE", {
      now: D("2026-02-01T00:00:00Z"),
    });
    expect(out.estimatedDailyUsage).toBeCloseTo(2.4);
  });

  it("documents its multipliers", () => {
    expect(SIGNAL_USAGE_MULTIPLIERS.EARLY_DELAY).toBe(0.85);
    expect(SIGNAL_USAGE_MULTIPLIERS.BROUGHT_FORWARD).toBe(1.15);
    expect(SIGNAL_USAGE_MULTIPLIERS.REPEATED_SKIPS).toBe(0.75);
    expect(SIGNAL_USAGE_MULTIPLIERS.EXTRA_ONE_TIME_PURCHASE).toBe(1.2);
  });

  it("keeps confidence within bounds under repeated signals", () => {
    let state: EstimateState = { ...base, confidence: 0.08 };
    for (let i = 0; i < 10; i++) {
      const out = updateEstimateFromSignal(state, "EARLY_DELAY", {
        now: D("2026-02-01T00:00:00Z"),
      });
      state = { ...state, confidence: out.confidence };
      expect(out.confidence).toBeGreaterThanOrEqual(0.05);
      expect(out.confidence).toBeLessThanOrEqual(0.95);
    }
  });
});

describe("updateEstimateFromSignal — SURVEY_OVERRIDE", () => {
  it("recalibrates daily usage from reported consumption", () => {
    const state: EstimateState = {
      estimatedDailyUsage: 2,
      confidence: 0.5,
      unitsOnHand: 60,
      lastDeliveryAt: D("2026-01-01T00:00:00Z"),
    };
    const out = updateEstimateFromSignal(state, "SURVEY_OVERRIDE", {
      reportedUnitsRemaining: 30,
      now: D("2026-01-11T00:00:00Z"),
    });
    // 30 units consumed over 10 days -> 3/day.
    expect(out.estimatedDailyUsage).toBeCloseTo(3);
    expect(out.unitsOnHand).toBe(30);
    expect(out.confidence).toBe(0.9);
    expect(out.anchorAt).toEqual(D("2026-01-11T00:00:00Z"));
  });

  it("sets units on hand directly when no prior history exists", () => {
    const state: EstimateState = {
      estimatedDailyUsage: 2,
      confidence: 0.5,
      unitsOnHand: null,
      lastDeliveryAt: null,
    };
    const out = updateEstimateFromSignal(state, "SURVEY_OVERRIDE", {
      reportedUnitsRemaining: 45,
      now: D("2026-01-11T00:00:00Z"),
    });
    expect(out.unitsOnHand).toBe(45);
    expect(out.estimatedDailyUsage).toBe(2); // unchanged — nothing to recalibrate from
    expect(out.confidence).toBe(0.9);
  });

  it("requires a non-negative reported amount", () => {
    const state: EstimateState = {
      estimatedDailyUsage: 2,
      confidence: 0.5,
      unitsOnHand: null,
      lastDeliveryAt: null,
    };
    expect(() => updateEstimateFromSignal(state, "SURVEY_OVERRIDE", {})).toThrow();
    expect(() =>
      updateEstimateFromSignal(state, "SURVEY_OVERRIDE", {
        reportedUnitsRemaining: -5,
      }),
    ).toThrow();
  });
});

describe("updateEstimateFromSignal — DELIVERY_RECEIVED", () => {
  it("adds delivered units to the decayed carry-over", () => {
    const state: EstimateState = {
      estimatedDailyUsage: 1,
      confidence: 0.5,
      unitsOnHand: 10,
      lastDeliveryAt: D("2026-01-01T00:00:00Z"),
    };
    const out = updateEstimateFromSignal(state, "DELIVERY_RECEIVED", {
      unitsAdded: 30,
      deliveredAt: D("2026-01-06T00:00:00Z"),
    });
    // carry-over: 10 - 5 days × 1/day = 5, plus 30 delivered.
    expect(out.unitsOnHand).toBeCloseTo(35);
    expect(out.lastDeliveryAt).toEqual(D("2026-01-06T00:00:00Z"));
    expect(out.anchorAt).toEqual(D("2026-01-06T00:00:00Z"));
    expect(out.confidence).toBeCloseTo(0.55);
  });

  it("floors the carry-over at zero", () => {
    const state: EstimateState = {
      estimatedDailyUsage: 1,
      confidence: 0.5,
      unitsOnHand: 10,
      lastDeliveryAt: D("2026-01-01T00:00:00Z"),
    };
    const out = updateEstimateFromSignal(state, "DELIVERY_RECEIVED", {
      unitsAdded: 30,
      deliveredAt: D("2026-02-01T00:00:00Z"), // 31 days later, all consumed
    });
    expect(out.unitsOnHand).toBeCloseTo(30);
  });
});
