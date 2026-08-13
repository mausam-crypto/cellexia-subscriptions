/**
 * Predicted LTGP — pure math (predicted-ltgp.server.ts, v1.21.0).
 *
 * Everything here is deterministic and I/O-free: the conditional tilted
 * survival accumulation, cycle-per-horizon arithmetic, tail extrapolation,
 * the refund haircut, the honesty grades, and the defensive parser.
 */

import { describe, expect, it } from "vitest";
import {
  LTGP_PREDICTION_HORIZONS,
  computePredictedLtgp,
  contractCycleDays,
  ltgpHorizonGrade,
  parsePredictedLtgp,
  type ComputePredictedLtgpInput,
} from "~/lib/analytics/predicted-ltgp.server";

const BASE: ComputePredictedLtgpInput = {
  // ordersCount semantics: RENEWALS billed (origin charge never included).
  currentCycle: 1,
  cycleGpCents: 2000, // £20 gross profit per charge
  cycleDays: 30,
  // Renewal-space KM: S(1)=1 (everyone reaches renewal 1 in this fixture),
  // then a constant 0.8 per-renewal survival.
  overallSurvival: [1, 0.8, 0.64, 0.512],
  curveContracts: 500,
  riskScore: null,
  bookMeanRisk: null,
  refundHaircutPct: 0,
  observedSpanDays: 3000,
  estimatedCosts: false,
  scorer: "heuristic",
  currencyCode: "GBP",
  computedAt: new Date("2026-08-12T00:00:00Z"),
};

describe("computePredictedLtgp", () => {
  it("d90 on a 30-day cadence = origin + 3 renewals; realized charges count fully, future renewals decay", () => {
    const value = computePredictedLtgp(BASE);
    // totalRenewals = floor(90/30) = 3, totalCharges = 4 (origin + 3).
    // 1 renewal already billed → realized charges = 2 (origin + renewal 1).
    // Future renewals 2..3 at s(2)=S[1]/S[0]=0.8, s(3)=S[2]/S[1]=0.8:
    // expected = 2 + 0.8 + 0.64 = 3.44
    expect(value.horizons.d90.expectedCycles).toBeCloseTo(3.44, 2);
    expect(value.horizons.d90.cents).toBe(Math.round(3.44 * 2000));
  });

  it("a brand-new contract (zero renewals billed) still counts its paid origin charge as realized", () => {
    const fresh = computePredictedLtgp({ ...BASE, currentCycle: 0 });
    // realized = 1 (origin); renewals 1..3 at s(1)=S[0]=1, s(2)=0.8, s(3)=0.8:
    // expected = 1 + 1 + 0.8 + 0.64 = 3.44 (S(1)=1 in this fixture).
    expect(fresh.horizons.d90.expectedCycles).toBeCloseTo(3.44, 2);
    // With a real first-renewal hazard the difference shows:
    const risky = computePredictedLtgp({
      ...BASE,
      currentCycle: 0,
      overallSurvival: [0.6, 0.48, 0.384],
    });
    // expected = 1 + 0.6 + 0.48 + 0.384 = 2.464 — the steep origin→renewal-1
    // hazard applies to the FIRST future renewal, not skipped.
    expect(risky.horizons.d90.expectedCycles).toBeCloseTo(2.46, 2);
  });

  it("already-billed renewals count with probability 1 (conditioning on current state)", () => {
    const young = computePredictedLtgp({ ...BASE, currentCycle: 1 });
    const veteran = computePredictedLtgp({ ...BASE, currentCycle: 4 });
    // d90 holds 4 charges max (origin + 3 renewals); the veteran banked more
    // than that, so the window is fully realized.
    expect(veteran.horizons.d90.expectedCycles).toBe(4);
    expect(veteran.horizons.d90.cents).toBe(4 * 2000);
    expect(veteran.horizons.d90.cents).toBeGreaterThan(young.horizons.d90.cents);
  });

  it("risk tilt raises hazard for risky contracts and is clamped both ways", () => {
    const risky = computePredictedLtgp({
      ...BASE,
      riskScore: 0.9,
      bookMeanRisk: 0.15,
    });
    const safe = computePredictedLtgp({
      ...BASE,
      riskScore: 0.01,
      bookMeanRisk: 0.15,
    });
    const neutral = computePredictedLtgp(BASE);
    expect(risky.riskTilt).toBe(4); // 0.9/0.15 = 6 → clamped to 4
    expect(safe.riskTilt).toBe(0.25); // 0.067 → clamped up to 0.25
    expect(risky.horizons.y1.cents).toBeLessThan(neutral.horizons.y1.cents);
    expect(safe.horizons.y1.cents).toBeGreaterThan(neutral.horizons.y1.cents);
    // Tilted hazard caps at 0.95 — survival never goes negative.
    expect(risky.horizons.y5.cents).toBeGreaterThanOrEqual(
      Math.round(1 * 2000),
    );
  });

  it("a tiny book mean disables the tilt instead of exploding it", () => {
    const value = computePredictedLtgp({
      ...BASE,
      riskScore: 0.5,
      bookMeanRisk: 0.001,
    });
    expect(value.riskTilt).toBe(1);
  });

  it("tail extrapolation continues the last observed ratio, capped conservatively", () => {
    // Curve depth 4 cycles; y1 needs 13 cycles on a 30-day cadence — the
    // tail keeps decaying (no immortal flat tail).
    const value = computePredictedLtgp(BASE);
    const y1 = value.horizons.y1.expectedCycles;
    const d180 = value.horizons.d180.expectedCycles;
    expect(y1).toBeGreaterThan(d180);
    // Strictly less than an undecayed count of 13 cycles.
    expect(y1).toBeLessThan(6);
  });

  it("an empty curve falls back to the default per-cycle survival", () => {
    const value = computePredictedLtgp({
      ...BASE,
      overallSurvival: [],
      curveContracts: 0,
    });
    // realized = 2 (origin + 1 renewal); renewals 2..3 at 0.9 each:
    // 2 + 0.9 + 0.81 = 3.71
    expect(value.horizons.d90.expectedCycles).toBeCloseTo(3.71, 2);
  });

  it("refund haircut scales the money, not the cycles", () => {
    const cut = computePredictedLtgp({ ...BASE, refundHaircutPct: 10 });
    const full = computePredictedLtgp(BASE);
    expect(cut.horizons.d90.expectedCycles).toBe(full.horizons.d90.expectedCycles);
    // cents scale by exactly (1 - haircut); expectedCycles in the stored
    // value is display-rounded, so compare against the unrounded relation.
    expect(cut.horizons.d90.cents).toBeCloseTo(full.horizons.d90.cents * 0.9, -1);
  });

  it("negative per-cycle GP predicts negative LTGP (honest, not clamped)", () => {
    const value = computePredictedLtgp({ ...BASE, cycleGpCents: -500 });
    expect(value.horizons.d90.cents).toBeLessThan(0);
  });

  it("round-trips through the defensive parser; junk is rejected", () => {
    const value = computePredictedLtgp(BASE);
    expect(parsePredictedLtgp(JSON.parse(JSON.stringify(value)))).not.toBeNull();
    expect(parsePredictedLtgp(null)).toBeNull();
    expect(parsePredictedLtgp({ v: 2 })).toBeNull();
    expect(
      parsePredictedLtgp({ v: 1, horizons: { d90: { cents: "x" } } }),
    ).toBeNull();
  });
});

describe("ltgpHorizonGrade — honesty caps", () => {
  it("grades by calendar coverage of the horizon", () => {
    // 2 years of history:
    const span = 730;
    expect(
      ltgpHorizonGrade({ horizonDays: 90, observedSpanDays: span, curveContracts: 500 }),
    ).toBe("A");
    expect(
      ltgpHorizonGrade({ horizonDays: 365, observedSpanDays: span, curveContracts: 500 }),
    ).toBe("A");
    expect(
      ltgpHorizonGrade({ horizonDays: 1095, observedSpanDays: span, curveContracts: 500 }),
    ).toBe("C"); // coverage 0.67
    expect(
      ltgpHorizonGrade({ horizonDays: 1825, observedSpanDays: span, curveContracts: 500 }),
    ).toBe("C"); // coverage 0.4
    expect(
      ltgpHorizonGrade({ horizonDays: 1825, observedSpanDays: 300, curveContracts: 500 }),
    ).toBe("D");
  });

  it("a thin curve degrades one notch", () => {
    expect(
      ltgpHorizonGrade({ horizonDays: 90, observedSpanDays: 730, curveContracts: 10 }),
    ).toBe("B");
  });
});

describe("contractCycleDays", () => {
  it("uses the exact mirrored cadence with the week fallback", () => {
    expect(
      contractCycleDays({ intervalWeeks: 4, billingIntervalUnit: "DAY", billingIntervalCount: 10 }),
    ).toBe(10);
    expect(
      contractCycleDays({ intervalWeeks: 4, billingIntervalUnit: "WEEK", billingIntervalCount: 6 }),
    ).toBe(42);
    expect(
      contractCycleDays({ intervalWeeks: 4, billingIntervalUnit: "MONTH", billingIntervalCount: 1 }),
    ).toBeCloseTo(30.4375, 3);
    // Legacy row without exact cadence falls back to intervalWeeks.
    expect(
      contractCycleDays({ intervalWeeks: 8, billingIntervalUnit: null, billingIntervalCount: null }),
    ).toBe(56);
  });
});

describe("horizon table", () => {
  it("pins the five contracted horizons", () => {
    expect(LTGP_PREDICTION_HORIZONS.map((h) => [h.key, h.days])).toEqual([
      ["d90", 90],
      ["d180", 180],
      ["y1", 365],
      ["y3", 1095],
      ["y5", 1825],
    ]);
  });
});
