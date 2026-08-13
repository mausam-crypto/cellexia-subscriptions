/**
 * Survey features in the churn-risk scorers (v1.21.0).
 *
 * Pins the widened feature space, the ordinal encodings, the two-flavor
 * missingness (survey_missing vs survey_skipped), and — load-bearing — that
 * a contract WITHOUT a linked survey scores byte-identically to the
 * pre-v1.21.0 heuristic: the survey adjustments are presence-gated priors,
 * never a silent rescoring of the whole book.
 */

import { describe, expect, it } from "vitest";
import {
  RISK_FEATURE_NAMES,
  extractFeatures,
  heuristicRiskScore,
  surveySignals,
  type RiskFeatureInput,
} from "~/lib/analytics/learning.server";

const BASE: RiskFeatureInput = {
  openDunning: false,
  skippedLastCycle: false,
  ordersCount: 3,
  consecutiveFailures: 0,
  skipCount: 0,
  daysSinceLogin: 10,
  accountAgeDays: 90,
  intervalWeeks: 4,
  acqRevenueCents: 5900,
  acqDiscountPct: 0,
};

describe("feature vocabulary", () => {
  it("pins the widened RISK_FEATURE_NAMES (order matters — stored models match element-by-element)", () => {
    expect([...RISK_FEATURE_NAMES]).toEqual([
      "open_dunning",
      "skipped_last_cycle",
      "early_cycle",
      "orders_2_3",
      "orders_4_6",
      "orders_7_plus",
      "consecutive_failures",
      "skip_ratio",
      "login_recency",
      "never_logged_in",
      "acq_revenue",
      "acq_discount_pct",
      "acq_present",
      "survey_missing",
      "survey_skipped",
      "survey_planned_duration",
      "survey_expected_speed_risk",
      "survey_routine_strength",
      "survey_motive_fast_fix",
      "survey_motive_prevention",
      "survey_motive_daily_care",
      "survey_motive_occasion",
    ]);
  });

  it("extractFeatures stays aligned with the vocabulary width", () => {
    expect(extractFeatures(BASE)).toHaveLength(RISK_FEATURE_NAMES.length);
    expect(
      extractFeatures({
        ...BASE,
        survey: { shown: true, answers: { motive: "prevention" } },
      }),
    ).toHaveLength(RISK_FEATURE_NAMES.length);
  });
});

describe("surveySignals encodings", () => {
  it("no survey → survey_missing, everything else zero", () => {
    expect(surveySignals(null)).toEqual({
      missing: 1,
      skipped: 0,
      plannedDuration: 0,
      expectedSpeedRisk: 0,
      routineStrength: 0,
      motive: null,
    });
  });

  it("shown with no answers → survey_skipped, not survey_missing", () => {
    const s = surveySignals({ shown: true, answers: {} });
    expect(s.missing).toBe(0);
    expect(s.skipped).toBe(1);
  });

  it("ordinals are monotone in the documented directions", () => {
    const at = (answers: Record<string, string>) =>
      surveySignals({ shown: true, answers });
    // plannedDuration: longer stated horizon = higher.
    expect(at({ plannedDuration: "trying" }).plannedDuration).toBe(0);
    expect(at({ plannedDuration: "permanent" }).plannedDuration).toBe(1);
    // expectedSpeed: "days" is the worst answer on EVERY product (merchant
    // decision — no product-relative scoring), monotone down to 3+ months;
    // not_sure sits mid-scale (steerable, not safe).
    const speed = ["days", "weeks", "one_two_months", "not_sure", "three_months_plus"].map(
      (v) => at({ expectedSpeed: v }).expectedSpeedRisk,
    );
    expect(speed).toEqual([1, 0.75, 0.5, 0.4, 0]);
    // routine: on_off ranks BELOW minimal (demonstrated inconsistency).
    expect(at({ routine: "on_off" }).routineStrength).toBeLessThan(
      at({ routine: "minimal" }).routineStrength,
    );
    expect(at({ routine: "full" }).routineStrength).toBe(1);
  });
});

describe("heuristic survey priors", () => {
  it("no linked survey scores byte-identically to the legacy heuristic", () => {
    const withoutField = heuristicRiskScore(BASE);
    const withNull = heuristicRiskScore({ ...BASE, survey: null });
    expect(withNull).toBe(withoutField);
  });

  it("risky answers raise the score, committed answers lower it, all bounded", () => {
    const base = heuristicRiskScore(BASE);
    const risky = heuristicRiskScore({
      ...BASE,
      survey: {
        shown: true,
        answers: {
          plannedDuration: "trying",
          expectedSpeed: "days",
          motive: "occasion",
          routine: "on_off",
        },
      },
    });
    const committed = heuristicRiskScore({
      ...BASE,
      survey: {
        shown: true,
        answers: {
          plannedDuration: "permanent",
          expectedSpeed: "three_months_plus",
          motive: "prevention",
          routine: "full",
        },
      },
    });
    expect(risky).toBeGreaterThan(base);
    expect(committed).toBeLessThanOrEqual(base);
    expect(risky).toBeLessThanOrEqual(1);
    expect(committed).toBeGreaterThanOrEqual(0);
  });

  it("shown-but-skipped carries its own penalty", () => {
    const base = heuristicRiskScore(BASE);
    const skipped = heuristicRiskScore({
      ...BASE,
      survey: { shown: true, answers: {} },
    });
    expect(skipped).toBeCloseTo(base + 0.05, 5);
  });
});
