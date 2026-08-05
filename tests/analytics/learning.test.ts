/**
 * Learning engine tests — app/services/analytics/learning.server.ts
 * (docs/LEARNING-DATA-V2.md §1).
 *
 * Pure math: empirical-Bayes shrinkage, calibration-bucket fitting with PAV
 * monotonicity, calibration interpolation edges (score 0, score 1, empty
 * buckets), Brier score, decile lift, retry-offset ranking with the minN
 * gate, propensity blending toward STATIC_PROPENSITY_PRIORS, and
 * failure→retry episode reconstruction.
 *
 * Job: `runLearningJob` over a mocked prisma — verifies the per-domain
 * minimum-sample-size gates, append-only version increments (including the
 * P2002 unique-race retry), learned-parameter payload shapes, and the
 * `learning.recalibrated` audit entry with per-model n + metrics.
 *
 * db.server and audit.server are mocked so the suite never touches Prisma;
 * forecast.server is imported REAL so the STATIC_PROPENSITY_PRIORS seam is
 * exercised end to end (one source of defaults on both sides).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  modelState: { findFirst: vi.fn(), create: vi.fn() },
  subscriptionContract: { findMany: vi.fn() },
  billingAttempt: { findMany: vi.fn() },
  scoreSnapshot: { findMany: vi.fn() },
  analyticsEvent: { findMany: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

import {
  applyCalibration,
  bestRetryOffsets,
  brierScore,
  buildRetryEpisodes,
  CALIBRATION_BUCKET_COUNT,
  CALIBRATION_MAX_CHURN_RATE,
  CALIBRATION_MIN_CHURN_RATE,
  decileLift,
  degenerateCalibrationSample,
  fitCalibrationBuckets,
  getLearnedDunningOffsets,
  getModelState,
  LEARNED_MODELS,
  learnedPropensities,
  MIN_CALIBRATION_PAIRS,
  MIN_PROPENSITY_CYCLES,
  MIN_RETRY_EPISODES_PER_CATEGORY,
  PRIOR_WEIGHT,
  runLearningJob,
  shrinkRate,
} from "~/services/analytics/learning.server";
import type { CalibrationBucket } from "~/services/analytics/learning.server";
import { STATIC_PROPENSITY_PRIORS } from "~/services/analytics/forecast.server";
import { addDays } from "~/lib/dates";

const SHOP = "learning-test.myshopify.com";

function seedDb(overrides: {
  contracts?: unknown[];
  attempts?: unknown[];
  snapshots?: unknown[];
  events?: unknown[];
}): void {
  db.subscriptionContract.findMany.mockResolvedValue(overrides.contracts ?? []);
  db.billingAttempt.findMany.mockResolvedValue(overrides.attempts ?? []);
  db.scoreSnapshot.findMany.mockResolvedValue(overrides.snapshots ?? []);
  db.analyticsEvent.findMany.mockResolvedValue(overrides.events ?? []);
  db.modelState.findFirst.mockResolvedValue(null);
  db.modelState.create.mockResolvedValue({});
  audit.appendAudit.mockResolvedValue(undefined);
}

/** data payloads of every modelState.create call, keyed by model. */
function createdByModel(): Map<string, Record<string, unknown>> {
  const byModel = new Map<string, Record<string, unknown>>();
  for (const call of db.modelState.create.mock.calls) {
    const data = (call[0] as { data: Record<string, unknown> }).data;
    byModel.set(String(data.model), data);
  }
  return byModel;
}

function assertNonDecreasing(buckets: CalibrationBucket[]): void {
  for (let i = 1; i < buckets.length; i++) {
    expect(buckets[i].calibrated).toBeGreaterThanOrEqual(
      buckets[i - 1].calibrated - 1e-9,
    );
  }
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ───────────────────────────── shrinkRate ───────────────────────────────────

describe("shrinkRate — empirical-Bayes shrinkage", () => {
  it("implements (observed*n + prior*k) / (n + k)", () => {
    expect(shrinkRate(0.5, 10, 0.1, 20)).toBeCloseTo(
      (0.5 * 10 + 0.1 * 20) / 30,
      12,
    );
  });

  it("k = 20 observations move the estimate exactly halfway off the prior", () => {
    // Documented contract: with n = k = 20, result is the midpoint.
    expect(PRIOR_WEIGHT).toBe(20);
    expect(shrinkRate(1, 20, 0)).toBeCloseTo(0.5, 12);
    expect(shrinkRate(0.8, 20, 0.2)).toBeCloseTo(0.5, 12);
  });

  it("returns the prior when there are no observations", () => {
    expect(shrinkRate(0.99, 0, 0.07)).toBe(0.07);
  });

  it("returns the observed rate when the prior weight is zero", () => {
    expect(shrinkRate(0.42, 5, 0.9, 0)).toBeCloseTo(0.42, 12);
  });

  it("returns the prior when both weights are zero", () => {
    expect(shrinkRate(0.42, 0, 0.9, 0)).toBe(0.9);
  });

  it("thin data barely moves the prior", () => {
    // 1 observation of 100% against prior 5% must stay near the prior.
    const blended = shrinkRate(1, 1, 0.05);
    expect(blended).toBeLessThan(0.1);
    expect(blended).toBeCloseTo((1 + 0.05 * 20) / 21, 12);
  });

  it("treats non-finite inputs defensively", () => {
    expect(shrinkRate(Number.NaN, 10, 0.3)).toBeCloseTo(0.3, 12);
    expect(shrinkRate(0.5, Number.NaN, 0.3)).toBeCloseTo(0.3, 12);
  });
});

// ───────────────────────────── fitCalibrationBuckets ───────────────────────

describe("fitCalibrationBuckets — 10 buckets, identity prior, PAV monotone", () => {
  it("always returns 10 equal-width buckets over [0, 1]", () => {
    const buckets = fitCalibrationBuckets([]);
    expect(buckets).toHaveLength(CALIBRATION_BUCKET_COUNT);
    buckets.forEach((bucket, i) => {
      expect(bucket.lo).toBeCloseTo(i / 10, 12);
      expect(bucket.hi).toBeCloseTo((i + 1) / 10, 12);
    });
  });

  it("empty input calibrates every bucket to its own midpoint (identity prior)", () => {
    const buckets = fitCalibrationBuckets([]);
    buckets.forEach((bucket, i) => {
      expect(bucket.n).toBe(0);
      expect(bucket.observed).toBe(0);
      expect(bucket.calibrated).toBeCloseTo((2 * i + 1) / 20, 12);
    });
    assertNonDecreasing(buckets);
  });

  it("score = 1 lands in the last bucket, not an out-of-range 11th", () => {
    const buckets = fitCalibrationBuckets([{ score: 1, churned: true }], 0);
    expect(buckets[9].n).toBe(1);
    expect(buckets[9].observed).toBe(1);
    expect(buckets.reduce((sum, b) => sum + b.n, 0)).toBe(1);
  });

  it("clamps out-of-range scores into the edge buckets", () => {
    const buckets = fitCalibrationBuckets(
      [
        { score: -0.2, churned: false },
        { score: 1.7, churned: true },
      ],
      0,
    );
    expect(buckets[0].n).toBe(1);
    expect(buckets[9].n).toBe(1);
  });

  it("enforces monotone non-decreasing calibration via pool-adjacent-violators", () => {
    // Inverted signal: low scores churn, high scores do not.
    const pairs = [
      ...Array.from({ length: 100 }, () => ({ score: 0.05, churned: true })),
      ...Array.from({ length: 100 }, () => ({ score: 0.95, churned: false })),
    ];
    const buckets = fitCalibrationBuckets(pairs);
    assertNonDecreasing(buckets);
    // The raw (pre-PAV) estimates would be wildly decreasing; pooled they
    // cannot be.
    expect(buckets[0].calibrated).toBeLessThanOrEqual(buckets[9].calibrated);
  });

  it("PAV pools violators into exact weighted means (priorWeight = 0 keeps the math clean)", () => {
    const pairs = [
      // Bucket 1 (0.1-0.2): 100 pairs, 80% churn.
      ...Array.from({ length: 80 }, () => ({ score: 0.15, churned: true })),
      ...Array.from({ length: 20 }, () => ({ score: 0.15, churned: false })),
      // Bucket 2 (0.2-0.3): 100 pairs, 20% churn — a violator.
      ...Array.from({ length: 20 }, () => ({ score: 0.25, churned: true })),
      ...Array.from({ length: 80 }, () => ({ score: 0.25, churned: false })),
    ];
    const buckets = fitCalibrationBuckets(pairs, 0);
    // With zero prior weight the empty buckets are weightless midpoints, so
    // the pooled sequence is fully deterministic:
    const expected = [0.05, 0.5, 0.5, 0.5, 0.5, 0.55, 0.65, 0.75, 0.85, 0.95];
    buckets.forEach((bucket, i) => {
      expect(bucket.calibrated).toBeCloseTo(expected[i], 12);
    });
    // Raw observations are preserved for the admin's predicted-vs-observed table.
    expect(buckets[1].observed).toBeCloseTo(0.8, 12);
    expect(buckets[2].observed).toBeCloseTo(0.2, 12);
  });

  it("heavily observed buckets win pooling disputes (weight = n + priorWeight)", () => {
    const pairs = [
      // Bucket 2: 200 pairs at 90% churn (heavy).
      ...Array.from({ length: 180 }, () => ({ score: 0.25, churned: true })),
      ...Array.from({ length: 20 }, () => ({ score: 0.25, churned: false })),
      // Bucket 3: 2 pairs at 0% churn (light violator).
      ...Array.from({ length: 2 }, () => ({ score: 0.35, churned: false })),
    ];
    const buckets = fitCalibrationBuckets(pairs);
    assertNonDecreasing(buckets);
    expect(buckets[2].calibrated).toBeCloseTo(buckets[3].calibrated, 12);
    // The pooled value stays close to the heavy bucket's shrunk 0.84, far
    // from the light bucket's 0.32.
    expect(buckets[2].calibrated).toBeGreaterThan(0.6);
  });
});

// ───────────────────────────── applyCalibration ────────────────────────────

describe("applyCalibration — interpolation and edges", () => {
  const twoBuckets: CalibrationBucket[] = [
    { lo: 0, hi: 0.5, observed: 0.1, n: 50, calibrated: 0.2 },
    { lo: 0.5, hi: 1, observed: 0.7, n: 50, calibrated: 0.6 },
  ];

  it("null or empty buckets leave the score unchanged", () => {
    expect(applyCalibration(0.37, null)).toBe(0.37);
    expect(applyCalibration(0.37, [])).toBe(0.37);
  });

  it("score 0 maps to the first bucket's calibrated value", () => {
    expect(applyCalibration(0, twoBuckets)).toBeCloseTo(0.2, 12);
  });

  it("score 1 maps to the last bucket's calibrated value", () => {
    expect(applyCalibration(1, twoBuckets)).toBeCloseTo(0.6, 12);
  });

  it("interpolates linearly between bucket midpoints", () => {
    // Midpoints 0.25 and 0.75; halfway between them blends 50/50.
    expect(applyCalibration(0.5, twoBuckets)).toBeCloseTo(0.4, 12);
    expect(applyCalibration(0.375, twoBuckets)).toBeCloseTo(0.3, 12);
  });

  it("scores outside the midpoint range clamp to the edge calibrations", () => {
    expect(applyCalibration(0.1, twoBuckets)).toBeCloseTo(0.2, 12);
    expect(applyCalibration(0.9, twoBuckets)).toBeCloseTo(0.6, 12);
  });

  it("clamps the input score into [0, 1]", () => {
    expect(applyCalibration(-3, twoBuckets)).toBeCloseTo(0.2, 12);
    expect(applyCalibration(42, twoBuckets)).toBeCloseTo(0.6, 12);
  });

  it("an identity fit over empty data is a near-no-op mid-range", () => {
    const identity = fitCalibrationBuckets([]);
    expect(applyCalibration(0.5, identity)).toBeCloseTo(0.5, 12);
    expect(applyCalibration(0.3, identity)).toBeCloseTo(0.3, 12);
    // Below the first midpoint the first bucket's value applies.
    expect(applyCalibration(0, identity)).toBeCloseTo(0.05, 12);
    expect(applyCalibration(1, identity)).toBeCloseTo(0.95, 12);
  });

  it("clamps calibrated outputs into [0, 1]", () => {
    const broken: CalibrationBucket[] = [
      { lo: 0, hi: 1, observed: 1, n: 1, calibrated: 1.4 },
    ];
    expect(applyCalibration(0.5, broken)).toBe(1);
  });
});

// ───────────────────────────── brierScore / decileLift ─────────────────────

describe("brierScore", () => {
  it("is 0 for empty input and perfect predictions", () => {
    expect(brierScore([])).toBe(0);
    expect(
      brierScore([
        { score: 1, churned: true },
        { score: 0, churned: false },
      ]),
    ).toBe(0);
  });

  it("is 0.25 for coin-flip scores and 1 for perfectly wrong ones", () => {
    expect(
      brierScore([
        { score: 0.5, churned: true },
        { score: 0.5, churned: false },
      ]),
    ).toBeCloseTo(0.25, 12);
    expect(
      brierScore([
        { score: 0, churned: true },
        { score: 1, churned: false },
      ]),
    ).toBeCloseTo(1, 12);
  });
});

describe("decileLift", () => {
  it("returns neutral 1 for empty input or zero observed churn", () => {
    expect(decileLift([])).toBe(1);
    expect(decileLift([{ score: 0.9, churned: false }])).toBe(1);
  });

  it("rewards models that rank churners into the top decile", () => {
    // 20 pairs; the 2 top-scored ones churned → top decile rate 1, overall 0.1.
    const pairs = [
      { score: 0.95, churned: true },
      { score: 0.9, churned: true },
      ...Array.from({ length: 18 }, (_, i) => ({
        score: 0.4 - i * 0.01,
        churned: false,
      })),
    ];
    expect(decileLift(pairs)).toBeCloseTo(10, 12);
  });

  it("is 1 when churn is spread uniformly", () => {
    // Every pair churned → top decile rate equals overall rate.
    const pairs = Array.from({ length: 30 }, (_, i) => ({
      score: i / 30,
      churned: true,
    }));
    expect(decileLift(pairs)).toBeCloseTo(1, 12);
  });
});

// ───────────────────────────── bestRetryOffsets ────────────────────────────

describe("bestRetryOffsets — minN gate and shrunk ranking", () => {
  const episode = (category: string, offsetDays: number, recovered: boolean) => ({
    category,
    offsetDays,
    recovered,
  });

  it("omits categories with fewer than minN episodes (callers keep the static strategy)", () => {
    expect(MIN_RETRY_EPISODES_PER_CATEGORY).toBe(30);
    const under = Array.from({ length: 29 }, () =>
      episode("INSUFFICIENT_FUNDS", 3, true),
    );
    expect(bestRetryOffsets(under)).toEqual({});
    const at = [...under, episode("INSUFFICIENT_FUNDS", 3, true)];
    expect(bestRetryOffsets(at)).toEqual({ INSUFFICIENT_FUNDS: [3] });
  });

  it("respects an explicit minN override", () => {
    const five = Array.from({ length: 5 }, () => episode("EXPIRED_CARD", 7, true));
    expect(bestRetryOffsets(five, 5)).toEqual({ EXPIRED_CARD: [7] });
    expect(bestRetryOffsets(five, 6)).toEqual({});
  });

  it("picks at most 3 offsets, ranked by shrunk recovery rate, returned ascending", () => {
    const episodes = [
      // offset 3: 30/30 recovered — best.
      ...Array.from({ length: 30 }, () => episode("GENERIC_DECLINE", 3, true)),
      // offset 5: 0/30 — worst, must be dropped.
      ...Array.from({ length: 30 }, () => episode("GENERIC_DECLINE", 5, false)),
      // offset 7: 15/30.
      ...Array.from({ length: 15 }, () => episode("GENERIC_DECLINE", 7, true)),
      ...Array.from({ length: 15 }, () => episode("GENERIC_DECLINE", 7, false)),
      // offset 9: 2/30.
      ...Array.from({ length: 2 }, () => episode("GENERIC_DECLINE", 9, true)),
      ...Array.from({ length: 28 }, () => episode("GENERIC_DECLINE", 9, false)),
    ];
    // Top 3 by shrunk rate are offsets 3, 7, 9 — offset 5 is omitted — and
    // the schedule comes back chronological (ascending), not rank order.
    expect(bestRetryOffsets(episodes)).toEqual({ GENERIC_DECLINE: [3, 7, 9] });
  });

  it("shrinks per-offset rates toward the category rate so thin offsets cannot dominate on luck alone", () => {
    const episodes = [
      // Solid offset 3: 20/40.
      ...Array.from({ length: 20 }, () => episode("PROCESSOR_ERROR", 3, true)),
      ...Array.from({ length: 20 }, () => episode("PROCESSOR_ERROR", 3, false)),
      // Weak offset 9: 0/2 raw, but shrinkage pulls it to the category rate
      // rather than 0.
      ...Array.from({ length: 2 }, () => episode("PROCESSOR_ERROR", 9, false)),
    ];
    const result = bestRetryOffsets(episodes);
    // Both offsets survive (max 3 slots) and come back ascending.
    expect(result.PROCESSOR_ERROR).toEqual([3, 9]);
  });

  it("ignores malformed episodes (negative, non-finite, empty category)", () => {
    const good = Array.from({ length: 30 }, () => episode("FRAUD", 4, true));
    const noisy = [
      ...good,
      episode("FRAUD", -1, true),
      episode("FRAUD", Number.NaN, true),
      episode("", 4, true),
    ];
    expect(bestRetryOffsets(noisy)).toEqual({ FRAUD: [4] });
  });

  it("keys categories independently", () => {
    const episodes = [
      ...Array.from({ length: 30 }, () => episode("INSUFFICIENT_FUNDS", 3, true)),
      ...Array.from({ length: 10 }, () => episode("EXPIRED_CARD", 5, true)),
    ];
    const result = bestRetryOffsets(episodes);
    expect(result.INSUFFICIENT_FUNDS).toEqual([3]);
    expect(result.EXPIRED_CARD).toBeUndefined();
  });
});

// ───────────────────────────── learnedPropensities ─────────────────────────

describe("learnedPropensities — blending toward the shared priors", () => {
  it("returns the priors unchanged with zero observations", () => {
    const priors = { skip: 0.05, pause: 0.03, churn: 0.0525 };
    expect(
      learnedPropensities({ cycles: 0, skips: 0, pauses: 0, churns: 0 }, priors),
    ).toEqual(priors);
    // Churns without any completed cycles cannot move the per-cycle hazard.
    expect(
      learnedPropensities({ cycles: 0, skips: 0, pauses: 0, churns: 9 }, priors)
        .churn,
    ).toBe(priors.churn);
  });

  it("blends observed rates with the priors via shrinkRate (opportunity denominators for skip/pause, cycles for churn)", () => {
    const priors = { skip: 0.05, pause: 0.03, churn: 0.0525 };
    const result = learnedPropensities(
      { cycles: 20, skips: 10, pauses: 2, churns: 1 },
      priors,
    );
    // skip: 10 skips over 30 opportunities (20 successes + 10 skips),
    // shrunk with n = 30: (10 + 0.05·20) / 50.
    expect(result.skip).toBeCloseTo((10 + 0.05 * 20) / 50, 12);
    // pause: 2 pauses over 22 opportunities: (2 + 0.03·20) / 42.
    expect(result.pause).toBeCloseTo((2 + 0.03 * 20) / 42, 12);
    // churn keeps the completed-cycle denominator: n = k = 20 → midpoint.
    expect(result.churn).toBeCloseTo((0.05 + 0.0525) / 2, 12);
  });

  it("heavy history dominates the prior", () => {
    const result = learnedPropensities(
      { cycles: 2000, skips: 400, pauses: 0, churns: 0 },
      { skip: 0.05, pause: 0.03, churn: 0.05 },
    );
    // observed 400/2400 ≈ 0.167, barely shrunk
    expect(result.skip).toBeCloseTo(401 / 2420, 12);
    expect(result.pause).toBeLessThan(0.001);
  });

  it("clamps degenerate counts into [0, 1]", () => {
    const result = learnedPropensities(
      { cycles: 5, skips: 50, pauses: 0, churns: 0 },
      { skip: 0.05, pause: 0.03, churn: 0.05 },
    );
    expect(result.skip).toBeLessThanOrEqual(1);
    expect(result.skip).toBeGreaterThan(0);
  });

  it("skip-every-other-cycle trains toward 0.5, not 1.0 (opportunity denominator regression)", () => {
    // 50 skips + 50 successes in the window: the true per-opportunity skip
    // rate is 0.5. The old cycles-only denominator read 50/50 = 1.0 and
    // shrunk it to ~0.73; the opportunity denominator observes 50/100 and
    // shrinks with n = 100 toward the 0.05 prior: (50 + 1) / 120.
    const result = learnedPropensities(
      { cycles: 50, skips: 50, pauses: 0, churns: 0 },
      { skip: 0.05, pause: 0.03, churn: 0.05 },
    );
    expect(result.skip).toBeCloseTo(51 / 120, 12);
    // Shrinkage toward a lower prior can never push the estimate ABOVE the
    // observed opportunity rate.
    expect(result.skip).toBeLessThan(0.5);
  });

  it("matches forecast.server's per-contract convention (skips / (successes + skips))", () => {
    // Same observations, same prior — the shop-level blend and the
    // per-contract blend in forecast.server must land on the same number,
    // otherwise the learned prior arrives on a different scale than the
    // observed rate it is blended with.
    const cycles = 30;
    const skips = 10;
    const prior = 0.05;
    const shopLevel = learnedPropensities(
      { cycles, skips, pauses: 0, churns: 0 },
      { skip: prior, pause: 0.03, churn: 0.05 },
    ).skip;
    const skipCycles = cycles + skips; // forecast.server.ts per-contract path
    const perContract = shrinkRate(skips / skipCycles, skipCycles, prior);
    expect(shopLevel).toBeCloseTo(perContract, 12);
  });

  it("works against the real STATIC_PROPENSITY_PRIORS seam", () => {
    // The forecast module must export usable launch defaults for the blend.
    expect(STATIC_PROPENSITY_PRIORS.skip).toBeGreaterThan(0);
    expect(STATIC_PROPENSITY_PRIORS.skip).toBeLessThan(1);
    expect(STATIC_PROPENSITY_PRIORS.pause).toBeGreaterThan(0);
    expect(STATIC_PROPENSITY_PRIORS.pause).toBeLessThan(1);
    expect(STATIC_PROPENSITY_PRIORS.churn).toBeGreaterThan(0);
    expect(STATIC_PROPENSITY_PRIORS.churn).toBeLessThan(1);
    const result = learnedPropensities(
      { cycles: 0, skips: 0, pauses: 0, churns: 0 },
      STATIC_PROPENSITY_PRIORS,
    );
    expect(result).toEqual({
      skip: STATIC_PROPENSITY_PRIORS.skip,
      pause: STATIC_PROPENSITY_PRIORS.pause,
      churn: STATIC_PROPENSITY_PRIORS.churn,
    });
  });
});

// ───────────────────────────── buildRetryEpisodes ──────────────────────────

describe("buildRetryEpisodes — failure→retry reconstruction", () => {
  const base = new Date("2026-05-01T00:00:00Z");
  const row = (
    contractId: string,
    status: string,
    isRetry: boolean,
    dayOffset: number,
    declineCategory: string | null = "INSUFFICIENT_FUNDS",
  ) => ({
    contractId,
    status,
    isRetry,
    occurredAt: addDays(base, dayOffset),
    declineCategory,
  });

  it("records offsetDays from the opening failure and closes on a recovered retry", () => {
    const episodes = buildRetryEpisodes([
      row("c1", "FAILURE", false, 0),
      row("c1", "SUCCESS", true, 3),
    ]);
    expect(episodes).toEqual([
      { category: "INSUFFICIENT_FUNDS", offsetDays: 3, recovered: true },
    ]);
  });

  it("keeps the episode open across failed retries and pins the opening category", () => {
    const episodes = buildRetryEpisodes([
      row("c1", "FAILURE", false, 0, "EXPIRED_CARD"),
      row("c1", "FAILURE", true, 3, "GENERIC_DECLINE"),
      row("c1", "SUCCESS", true, 7),
    ]);
    expect(episodes).toEqual([
      { category: "EXPIRED_CARD", offsetDays: 3, recovered: false },
      { category: "EXPIRED_CARD", offsetDays: 7, recovered: true },
    ]);
  });

  it("a routine (non-retry) success closes an open episode without an observation", () => {
    const episodes = buildRetryEpisodes([
      row("c1", "FAILURE", false, 0),
      row("c1", "SUCCESS", false, 28),
      row("c1", "SUCCESS", true, 30), // retry with no open episode → ignored
    ]);
    expect(episodes).toEqual([]);
  });

  it("null decline codes fall back to GENERIC_DECLINE and contracts are independent", () => {
    const episodes = buildRetryEpisodes([
      row("c1", "FAILURE", false, 0, null),
      row("c1", "SUCCESS", true, 5),
      row("c2", "FAILURE", false, 1),
      row("c2", "FAILURE", true, 4),
    ]);
    expect(episodes).toContainEqual({
      category: "GENERIC_DECLINE",
      offsetDays: 5,
      recovered: true,
    });
    expect(episodes).toContainEqual({
      category: "INSUFFICIENT_FUNDS",
      offsetDays: 3,
      recovered: false,
    });
    expect(episodes).toHaveLength(2);
  });

  it("sorts out-of-order rows per contract before reconstructing", () => {
    const episodes = buildRetryEpisodes([
      row("c1", "SUCCESS", true, 3),
      row("c1", "FAILURE", false, 0),
    ]);
    expect(episodes).toEqual([
      { category: "INSUFFICIENT_FUNDS", offsetDays: 3, recovered: true },
    ]);
  });
});

// ───────────────────────────── getModelState / offsets ─────────────────────

describe("getModelState / getLearnedDunningOffsets", () => {
  it("returns null when the model has never been trained", async () => {
    db.modelState.findFirst.mockResolvedValue(null);
    expect(await getModelState(SHOP, "CHURN_CALIBRATION")).toBeNull();
    expect(db.modelState.findFirst).toHaveBeenCalledWith({
      where: { shop: SHOP, model: "CHURN_CALIBRATION" },
      orderBy: { version: "desc" },
    });
  });

  it("parses the newest version's params and metrics", async () => {
    const computedAt = new Date("2026-08-01T00:00:00Z");
    db.modelState.findFirst.mockResolvedValue({
      shop: SHOP,
      model: "FORECAST_PROPENSITY",
      version: 5,
      paramsJson: JSON.stringify({ skip: 0.1, pause: 0.02, churn: 0.04 }),
      metricsJson: JSON.stringify({ n: 120 }),
      sampleSize: 120,
      computedAt,
    });
    const state = await getModelState(SHOP, "FORECAST_PROPENSITY");
    expect(state).toEqual({
      shop: SHOP,
      model: "FORECAST_PROPENSITY",
      version: 5,
      params: { skip: 0.1, pause: 0.02, churn: 0.04 },
      metrics: { n: 120 },
      sampleSize: 120,
      computedAt,
    });
  });

  it("getLearnedDunningOffsets returns null without a trained model or category", async () => {
    db.modelState.findFirst.mockResolvedValue(null);
    expect(await getLearnedDunningOffsets(SHOP, "EXPIRED_CARD")).toBeNull();

    db.modelState.findFirst.mockResolvedValue({
      shop: SHOP,
      model: "DUNNING_RECOVERY",
      version: 1,
      paramsJson: JSON.stringify({
        offsets: { INSUFFICIENT_FUNDS: [3, 5, 7] },
        perCategoryN: { INSUFFICIENT_FUNDS: 44 },
      }),
      metricsJson: "{}",
      sampleSize: 44,
      computedAt: new Date(),
    });
    expect(await getLearnedDunningOffsets(SHOP, "EXPIRED_CARD")).toBeNull();
    expect(await getLearnedDunningOffsets(SHOP, "INSUFFICIENT_FUNDS")).toEqual([
      3, 5, 7,
    ]);
  });

  it("filters malformed stored offsets and returns null when nothing valid remains", async () => {
    db.modelState.findFirst.mockResolvedValue({
      shop: SHOP,
      model: "DUNNING_RECOVERY",
      version: 2,
      paramsJson: JSON.stringify({
        offsets: { EXPIRED_CARD: [-1, "x", null, 6], FRAUD: ["bad"] },
        perCategoryN: {},
      }),
      metricsJson: "{}",
      sampleSize: 10,
      computedAt: new Date(),
    });
    expect(await getLearnedDunningOffsets(SHOP, "EXPIRED_CARD")).toEqual([6]);
    expect(await getLearnedDunningOffsets(SHOP, "FRAUD")).toBeNull();
  });
});

// ───────────────────────────── runLearningJob ──────────────────────────────

describe("runLearningJob — sample-size gates", () => {
  it("writes nothing below every gate but still appends the audit entry", async () => {
    seedDb({});
    const result = await runLearningJob(SHOP);

    expect(db.modelState.create).not.toHaveBeenCalled();
    expect(result.shops).toBe(1);
    const models = result.results[0].models;
    for (const model of LEARNED_MODELS) {
      expect(models[model].written).toBe(false);
      expect(models[model].version).toBeNull();
    }

    expect(audit.appendAudit).toHaveBeenCalledTimes(1);
    const entry = audit.appendAudit.mock.calls[0][0] as {
      shop: string;
      actorType: string;
      action: string;
      payload: { models: Record<string, { n: number; written: boolean }> };
    };
    expect(entry.shop).toBe(SHOP);
    expect(entry.actorType).toBe("SYSTEM");
    expect(entry.action).toBe("learning.recalibrated");
    for (const model of LEARNED_MODELS) {
      expect(entry.payload.models[model].written).toBe(false);
    }
  });

  it("stays below the gates at n-1 (39 calibration pairs, 19 cycles)", async () => {
    expect(MIN_CALIBRATION_PAIRS).toBe(40);
    expect(MIN_PROPENSITY_CYCLES).toBe(20);
    const now = new Date();
    seedDb({
      snapshots: Array.from({ length: 39 }, (_, i) => ({
        contractId: `c${i}`,
        value: 0.5,
        computedAt: addDays(now, -100),
      })),
      attempts: Array.from({ length: 19 }, (_, i) => ({
        contractId: `c${i}`,
        status: "SUCCESS",
        isRetry: false,
        occurredAt: addDays(now, -1 - i),
        declineCategory: null,
      })),
    });

    const result = await runLearningJob(SHOP);
    expect(db.modelState.create).not.toHaveBeenCalled();
    const models = result.results[0].models;
    expect(models.CHURN_CALIBRATION).toMatchObject({ n: 39, written: false });
    expect(models.FORECAST_PROPENSITY.written).toBe(false);
    expect(models.FORECAST_PROPENSITY.metrics).toMatchObject({ cycles: 19 });
  });
});

describe("runLearningJob — full recalibration over mocked prisma", () => {
  function seedFullScenario(now: Date): void {
    const contracts = [
      {
        id: "c1",
        status: "ACTIVE",
        cancelledAt: null,
        updatedAt: now,
        intervalWeeks: 4,
        lines: [{ shopifyProductId: "gid://shopify/Product/101" }],
      },
      {
        id: "c2",
        status: "CANCELLED",
        cancelledAt: addDays(now, -70),
        updatedAt: addDays(now, -70),
        intervalWeeks: 4,
        lines: [],
      },
    ];

    const attempts = [
      // c1: 7 successes 42 days apart (28-day cadence → stretch 1.5). The
      // last 5 land inside the 180-day propensity window.
      ...Array.from({ length: 7 }, (_, i) => ({
        contractId: "c1",
        status: "SUCCESS",
        isRetry: false,
        occurredAt: addDays(now, -252 + 42 * i),
        declineCategory: null,
      })),
      // c2: 15 recent successes (propensity cycles; no lines → no depletion).
      ...Array.from({ length: 15 }, (_, i) => ({
        contractId: "c2",
        status: "SUCCESS",
        isRetry: false,
        occurredAt: addDays(now, -20 + i),
        declineCategory: null,
      })),
      // 30 dunning episodes, all outside the propensity window: failure at
      // day -200, recovered retry 3 days later.
      ...Array.from({ length: 30 }, (_, i) => [
        {
          contractId: `e${i}`,
          status: "FAILURE",
          isRetry: false,
          occurredAt: addDays(now, -200),
          declineCategory: "INSUFFICIENT_FUNDS",
        },
        {
          contractId: `e${i}`,
          status: "SUCCESS",
          isRetry: true,
          occurredAt: addDays(now, -197),
          declineCategory: null,
        },
      ]).flat(),
    ];

    const snapshots = [
      // 20 churned pairs: c2 exited 30 days after the snapshot (≤ 90-day window).
      ...Array.from({ length: 20 }, () => ({
        contractId: "c2",
        value: 0.9,
        computedAt: addDays(now, -100),
      })),
      // 20 retained pairs on the live contract.
      ...Array.from({ length: 20 }, () => ({
        contractId: "c1",
        value: 0.1,
        computedAt: addDays(now, -100),
      })),
    ];

    const events = [
      { name: "ORDER_SKIPPED", payloadJson: "{}" },
      { name: "ORDER_SKIPPED", payloadJson: "{}" },
      { name: "ORDER_SKIPPED", payloadJson: "{}" },
      { name: "PAUSE_STARTED", payloadJson: "{}" },
      // Dunning grace pause — must be excluded from the pause propensity.
      { name: "PAUSE_STARTED", payloadJson: JSON.stringify({ dunning: true }) },
    ];

    seedDb({ contracts, attempts, snapshots, events });
  }

  it("writes all four model domains with correct params, versions and audit", async () => {
    const now = new Date();
    seedFullScenario(now);

    const result = await runLearningJob(SHOP);

    expect(db.modelState.create).toHaveBeenCalledTimes(4);
    const created = createdByModel();
    expect([...created.keys()].sort()).toEqual([...LEARNED_MODELS].sort());

    // Every domain starts its append-only history at version 1.
    for (const model of LEARNED_MODELS) {
      expect(created.get(model)).toMatchObject({ shop: SHOP, version: 1 });
    }

    // CHURN_CALIBRATION: 40 pairs, brier 0.01, top decile all churned → lift 2.
    const churn = created.get("CHURN_CALIBRATION")!;
    expect(churn.sampleSize).toBe(40);
    const churnParams = JSON.parse(String(churn.paramsJson)) as {
      buckets: CalibrationBucket[];
    };
    expect(churnParams.buckets).toHaveLength(10);
    assertNonDecreasing(churnParams.buckets);
    const churnMetrics = JSON.parse(String(churn.metricsJson)) as {
      brier: number;
      decileLift: number;
      n: number;
    };
    expect(churnMetrics.n).toBe(40);
    expect(churnMetrics.brier).toBeCloseTo(0.01, 6);
    expect(churnMetrics.decileLift).toBeCloseTo(2, 6);

    // DUNNING_RECOVERY: 30 recovered day-3 retries for INSUFFICIENT_FUNDS.
    const dunning = created.get("DUNNING_RECOVERY")!;
    expect(dunning.sampleSize).toBe(30);
    expect(JSON.parse(String(dunning.paramsJson))).toEqual({
      offsets: { INSUFFICIENT_FUNDS: [3] },
      perCategoryN: { INSUFFICIENT_FUNDS: 30 },
    });

    // FORECAST_PROPENSITY: 20 cycles (5 from c1 in-window + 15 from c2),
    // 3 skips, 1 customer pause (dunning pause excluded), 1 exit — blended
    // toward the REAL STATIC_PROPENSITY_PRIORS from forecast.server.
    const propensity = created.get("FORECAST_PROPENSITY")!;
    expect(propensity.sampleSize).toBe(20);
    const expected = learnedPropensities(
      { cycles: 20, skips: 3, pauses: 1, churns: 1 },
      STATIC_PROPENSITY_PRIORS,
    );
    const propensityParams = JSON.parse(String(propensity.paramsJson)) as {
      skip: number;
      pause: number;
      churn: number;
    };
    expect(propensityParams.skip).toBeCloseTo(expected.skip, 12);
    expect(propensityParams.pause).toBeCloseTo(expected.pause, 12);
    expect(propensityParams.churn).toBeCloseTo(expected.churn, 12);
    // Lock the arithmetic: 3 skips over 23 opportunities (20 cycles + 3
    // skips) shrunk toward the 0.05 static prior → (3 + 0.05·20) / 43.
    expect(propensityParams.skip).toBeCloseTo(4 / 43, 12);
    const propensityMetrics = JSON.parse(String(propensity.metricsJson)) as {
      pauses: number;
    };
    expect(propensityMetrics.pauses).toBe(1);

    // DEPLETION_USAGE: 6 stretches of 1.5 → suggested multiplier 1/1.5 ≈ 0.67.
    const depletion = created.get("DEPLETION_USAGE")!;
    expect(JSON.parse(String(depletion.paramsJson))).toEqual({
      products: {
        "gid://shopify/Product/101": {
          multiplier: 0.67,
          medianStretch: 1.5,
          n: 6,
        },
      },
    });
    expect(depletion.sampleSize).toBe(6);

    // Job summary mirrors the writes.
    const models = result.results[0].models;
    for (const model of LEARNED_MODELS) {
      expect(models[model].written).toBe(true);
      expect(models[model].version).toBe(1);
    }

    // Audit: one learning.recalibrated entry with per-model n + metrics.
    expect(audit.appendAudit).toHaveBeenCalledTimes(1);
    const entry = audit.appendAudit.mock.calls[0][0] as {
      action: string;
      payload: {
        models: Record<string, { n: number; written: boolean; version: number }>;
      };
    };
    expect(entry.action).toBe("learning.recalibrated");
    expect(entry.payload.models.CHURN_CALIBRATION).toMatchObject({
      n: 40,
      written: true,
      version: 1,
    });
    expect(entry.payload.models.DUNNING_RECOVERY).toMatchObject({
      n: 30,
      written: true,
      version: 1,
    });
  });
});

describe("runLearningJob — calibration trains on raw scores (feedback-loop regression)", () => {
  it("pairs use factorsJson.raw, not the calibrated snapshot value", async () => {
    const now = new Date();
    seedDb({
      contracts: [
        {
          id: "c1",
          status: "ACTIVE",
          cancelledAt: null,
          cancelReason: null,
          updatedAt: now,
          intervalWeeks: 4,
          lines: [],
        },
        // One genuinely churned contract keeps the sample two-label (the
        // degenerate-sample guard skips single-label corpora by design).
        {
          id: "x1",
          status: "CANCELLED",
          cancelledAt: addDays(now, -70),
          cancelReason: "CUSTOMER_REQUEST",
          updatedAt: addDays(now, -70),
          intervalWeeks: 4,
          lines: [],
        },
      ],
      snapshots: [
        // Post-calibration snapshots: value stores the CALIBRATED 0.85 while
        // the raw model output 0.25 lives in factorsJson.
        ...Array.from({ length: 20 }, () => ({
          contractId: "c1",
          value: 0.85,
          factorsJson: JSON.stringify({ raw: 0.25, calibrated: 0.85 }),
          computedAt: addDays(now, -100),
        })),
        // Legacy pre-calibration snapshots: no raw key — value IS the raw
        // score and must remain a usable fallback.
        ...Array.from({ length: 20 }, () => ({
          contractId: "c1",
          value: 0.65,
          factorsJson: "{}",
          computedAt: addDays(now, -100),
        })),
        // Churned pairs (x1 exited 30 days after the snapshot) in bucket 9.
        ...Array.from({ length: 2 }, () => ({
          contractId: "x1",
          value: 0.95,
          factorsJson: "{}",
          computedAt: addDays(now, -100),
        })),
      ],
    });

    await runLearningJob(SHOP);

    const churn = createdByModel().get("CHURN_CALIBRATION")!;
    const { buckets } = JSON.parse(String(churn.paramsJson)) as {
      buckets: CalibrationBucket[];
    };
    // raw 0.25 → bucket 2; legacy value 0.65 → bucket 6. The calibrated 0.85
    // must land NOWHERE (bucket 8 stays empty) — training on it would fit
    // each version on the previous version's outputs.
    expect(buckets[2].n).toBe(20);
    expect(buckets[6].n).toBe(20);
    expect(buckets[8].n).toBe(0);
  });
});

describe("runLearningJob — merges and involuntary exits are not churn", () => {
  const contract = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    status: "ACTIVE",
    cancelledAt: null,
    cancelReason: null,
    updatedAt: new Date(),
    intervalWeeks: 4,
    lines: [],
    ...overrides,
  });

  it("censors calibration pairs whose outcome window a merge interrupted and never counts merges as churn", async () => {
    const now = new Date();
    const mergeAt = addDays(now, -70);
    seedDb({
      contracts: [
        contract("m1", {
          status: "CANCELLED",
          cancelledAt: mergeAt,
          cancelReason: "MERGED",
          updatedAt: mergeAt,
        }),
      ],
      // Merge lands 30 days into every snapshot's 90-day outcome window →
      // the outcome is unobservable (the customer kept subscribing on the
      // target contract): drop, do not label churned OR retained.
      snapshots: Array.from({ length: 40 }, () => ({
        contractId: "m1",
        value: 0.5,
        factorsJson: "{}",
        computedAt: addDays(now, -100),
      })),
    });

    const result = await runLearningJob(SHOP);

    expect(result.results[0].models.CHURN_CALIBRATION).toMatchObject({
      n: 0,
      written: false,
    });
    // The merge is consolidation, not an exit, for the propensity model too.
    expect(result.results[0].models.FORECAST_PROPENSITY.metrics).toMatchObject({
      churns: 0,
    });
    expect(db.modelState.create).not.toHaveBeenCalled();
  });

  it("keeps pairs as retained when the 90-day window completed before the merge", async () => {
    const now = new Date();
    seedDb({
      contracts: [
        contract("m1", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -50),
          cancelReason: "MERGED",
          updatedAt: addDays(now, -50),
        }),
        // A genuinely churned contract keeps the corpus two-label (the
        // degenerate-sample guard refuses single-label fits by design).
        contract("v1", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -70),
          cancelReason: "CUSTOMER_REQUEST",
          updatedAt: addDays(now, -70),
        }),
      ],
      // Window closed at day -70, before the day -50 merge → a fully
      // observed retention outcome.
      snapshots: [
        ...Array.from({ length: 40 }, () => ({
          contractId: "m1",
          value: 0.5,
          factorsJson: "{}",
          computedAt: addDays(now, -160),
        })),
        // Churned pairs land in bucket 9, keeping bucket 5 purely retained.
        ...Array.from({ length: 2 }, () => ({
          contractId: "v1",
          value: 0.95,
          factorsJson: "{}",
          computedAt: addDays(now, -100),
        })),
      ],
    });

    const result = await runLearningJob(SHOP);

    expect(result.results[0].models.CHURN_CALIBRATION).toMatchObject({
      n: 42,
      written: true,
    });
    const churn = createdByModel().get("CHURN_CALIBRATION")!;
    const { buckets } = JSON.parse(String(churn.paramsJson)) as {
      buckets: CalibrationBucket[];
    };
    expect(buckets[5].n).toBe(40);
    expect(buckets[5].observed).toBe(0); // retained, never churned
  });

  it("excludes payment-failure and merged exits from the learned churn count (voluntary hazard only)", async () => {
    const now = new Date();
    seedDb({
      contracts: [
        contract("v1", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -30),
          cancelReason: "CUSTOMER_REQUEST",
          updatedAt: addDays(now, -30),
        }),
        contract("p1", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -40),
          cancelReason: "PAYMENT_FAILURE",
          updatedAt: addDays(now, -40),
        }),
        contract("p2", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -45),
          cancelReason: "payment_failed", // case-insensitive involuntary test
          updatedAt: addDays(now, -45),
        }),
        contract("m1", {
          status: "CANCELLED",
          cancelledAt: addDays(now, -50),
          cancelReason: "MERGED",
          updatedAt: addDays(now, -50),
        }),
      ],
      attempts: Array.from({ length: 20 }, (_, i) => ({
        contractId: "v1",
        status: "SUCCESS",
        isRetry: false,
        occurredAt: addDays(now, -60 - i),
        declineCategory: null,
      })),
    });

    const result = await runLearningJob(SHOP);

    // 4 exits in the window, but only the voluntary cancel is churn: the
    // forecast models involuntary loss separately (pFail × FAILURE_LOSS_SHARE)
    // and a merge is consolidation.
    expect(result.results[0].models.FORECAST_PROPENSITY.metrics).toMatchObject({
      cycles: 20,
      churns: 1,
    });
    const propensity = createdByModel().get("FORECAST_PROPENSITY")!;
    const params = JSON.parse(String(propensity.paramsJson)) as {
      churn: number;
    };
    const expected = learnedPropensities(
      { cycles: 20, skips: 0, pauses: 0, churns: 1 },
      STATIC_PROPENSITY_PRIORS,
    );
    expect(params.churn).toBeCloseTo(expected.churn, 12);
  });
});

describe("degenerateCalibrationSample — single-label corpora are untrainable", () => {
  const pairs = (churned: number, retained: number) => [
    ...Array.from({ length: churned }, () => ({ churned: true })),
    ...Array.from({ length: retained }, () => ({ churned: false })),
  ];

  it("flags the censored-corpus shape (≈100% churned) and the all-retained shape", () => {
    expect(degenerateCalibrationSample(pairs(60, 0))).toEqual({
      degenerate: true,
      churnedRate: 1,
    });
    expect(degenerateCalibrationSample(pairs(59, 1)).degenerate).toBe(true); // ≈0.983
    expect(degenerateCalibrationSample(pairs(0, 60))).toEqual({
      degenerate: true,
      churnedRate: 0,
    });
    expect(degenerateCalibrationSample([])).toEqual({
      degenerate: true,
      churnedRate: 0,
    });
  });

  it("accepts anything inside the (min, max) band", () => {
    expect(degenerateCalibrationSample(pairs(10, 30))).toEqual({
      degenerate: false,
      churnedRate: 0.25,
    });
    // Exactly at the bounds is still acceptable (strict inequalities).
    expect(
      degenerateCalibrationSample(pairs(90, 10)).churnedRate,
    ).toBe(CALIBRATION_MAX_CHURN_RATE);
    expect(degenerateCalibrationSample(pairs(90, 10)).degenerate).toBe(false);
    expect(
      degenerateCalibrationSample(pairs(2, 98)).churnedRate,
    ).toBe(CALIBRATION_MIN_CHURN_RATE);
    expect(degenerateCalibrationSample(pairs(2, 98)).degenerate).toBe(false);
  });
});

describe("runLearningJob — degenerate calibration samples are never fitted", () => {
  it("skips the CHURN_CALIBRATION write for a ~100%-churned corpus and records why", async () => {
    // The end-to-end shape from the snapshot-prune bug: only exited
    // contracts' final snapshots survived into the 60-180d window, so every
    // pair reads churned. Fitting it would calibrate every bucket near 1 and
    // flag the whole active base HIGH_CHURN_RISK on the next scan.
    const now = new Date();
    seedDb({
      contracts: Array.from({ length: 2 }, (_, i) => ({
        id: `dead${i}`,
        status: "CANCELLED",
        cancelledAt: addDays(now, -65),
        cancelReason: "CUSTOMER_REQUEST",
        updatedAt: addDays(now, -65),
        intervalWeeks: 4,
        lines: [],
      })),
      // 30 daily snapshots each from the month before the exits.
      snapshots: Array.from({ length: 60 }, (_, i) => ({
        contractId: `dead${i % 2}`,
        value: 0.6,
        factorsJson: "{}",
        computedAt: addDays(now, -95 + (i % 30)),
      })),
    });

    const result = await runLearningJob(SHOP);

    const summary = result.results[0].models.CHURN_CALIBRATION;
    expect(summary.written).toBe(false);
    expect(summary.version).toBeNull();
    expect(summary.metrics).toMatchObject({
      skipped: "degenerate_sample",
      churnedRate: 1,
      n: 60,
    });
    expect(db.modelState.create).not.toHaveBeenCalled();

    // The skip lands in the learning.recalibrated audit payload.
    const entry = audit.appendAudit.mock.calls[0][0] as {
      payload: { models: Record<string, { metrics: Record<string, unknown> }> };
    };
    expect(entry.payload.models.CHURN_CALIBRATION.metrics).toMatchObject({
      skipped: "degenerate_sample",
    });
  });
});

describe("runLearningJob — append-only version allocation", () => {
  function seedCalibrationOnly(now: Date): void {
    seedDb({
      // Ten of the forty contracts churned (exit 10 days after the snapshot,
      // inside the 90-day outcome window) so the pair set is two-label and
      // clears the degenerate-sample guard.
      contracts: Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        status: "CANCELLED",
        cancelledAt: addDays(now, -80),
        cancelReason: "CUSTOMER_REQUEST",
        updatedAt: addDays(now, -80),
        intervalWeeks: 4,
        lines: [],
      })),
      snapshots: Array.from({ length: 40 }, (_, i) => ({
        contractId: `c${i}`,
        value: i / 40,
        computedAt: addDays(now, -90),
      })),
    });
  }

  it("increments from the newest stored version", async () => {
    const now = new Date();
    seedCalibrationOnly(now);
    db.modelState.findFirst.mockResolvedValue({ version: 7 });

    const result = await runLearningJob(SHOP);

    expect(db.modelState.create).toHaveBeenCalledTimes(1);
    const data = (db.modelState.create.mock.calls[0][0] as {
      data: { version: number };
    }).data;
    expect(data.version).toBe(8);
    expect(result.results[0].models.CHURN_CALIBRATION.version).toBe(8);
  });

  it("retries with a fresh version when a concurrent writer wins the unique race (P2002)", async () => {
    const now = new Date();
    seedCalibrationOnly(now);
    db.modelState.findFirst
      .mockResolvedValueOnce({ version: 2 })
      .mockResolvedValueOnce({ version: 3 });
    db.modelState.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({});

    const result = await runLearningJob(SHOP);

    expect(db.modelState.create).toHaveBeenCalledTimes(2);
    const versions = db.modelState.create.mock.calls.map(
      (call) => (call[0] as { data: { version: number } }).data.version,
    );
    expect(versions).toEqual([3, 4]);
    expect(result.results[0].models.CHURN_CALIBRATION.version).toBe(4);
  });

  it("propagates non-unique-constraint write failures", async () => {
    const now = new Date();
    seedCalibrationOnly(now);
    db.modelState.create.mockRejectedValue(new Error("disk full"));

    await expect(runLearningJob(SHOP)).rejects.toThrow("disk full");
  });

  it("gives up after repeated unique races instead of spinning forever", async () => {
    const now = new Date();
    seedCalibrationOnly(now);
    db.modelState.create.mockRejectedValue({ code: "P2002" });

    await expect(runLearningJob(SHOP)).rejects.toThrow(/could not allocate/);
    expect(db.modelState.create).toHaveBeenCalledTimes(3);
  });
});
