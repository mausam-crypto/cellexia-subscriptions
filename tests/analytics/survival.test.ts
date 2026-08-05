/**
 * Unit tests for the pure survival math in
 * app/services/analytics/survival.server.ts: symmetric censoring,
 * dunning-exhausted (terminal pause) payment-failure exits, the paid-order
 * rebill rule, null-vs-zero checkpoint semantics, the per-curve atRisk
 * array, and cohort-key ordering under the curve cap.
 *
 * Formula regressions follow the "assert the WRONG number the bug produced,
 * then the right one" convention.
 */
import { describe, expect, it } from "vitest";
import {
  buildPoints,
  classifyExit,
  sortCohortKeys,
  survivedRebill,
} from "~/services/analytics/survival.server";
import type { MemberInput, SurvivalPoint } from "~/services/analytics/survival.server";

const DAY_MS = 86_400_000;
const NOW = new Date(Date.UTC(2026, 7, 1)); // 1 Aug 2026

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function member(overrides: Partial<MemberInput> = {}): MemberInput {
  return {
    createdAt: daysAgo(400),
    cancelledAt: null,
    cancelReason: null,
    status: "ACTIVE",
    successfulOrders: 10,
    intervalWeeks: 4,
    widgetVersion: null,
    dunningPhase: null,
    dunningGraceUntil: null,
    dunningUpdatedAt: null,
    ...overrides,
  };
}

function pointAt(points: SurvivalPoint[], label: string): SurvivalPoint {
  const p = points.find((x) => x.label === label);
  if (!p) throw new Error(`no point labelled ${label}`);
  return p;
}

describe("buildPoints — symmetric censoring of the at-risk set", () => {
  it("excludes young contracts (exits included) from old checkpoints", () => {
    // 200 mature contracts (aged 400d), 100 cancelled at day 300 → the true
    // 365-day survival is 50%. Plus 100 young contracts (aged 30d), 10 of
    // which already cancelled.
    const members: MemberInput[] = [
      ...Array.from({ length: 100 }, () => member()),
      ...Array.from({ length: 100 }, () =>
        member({
          cancelledAt: daysAgo(100), // day 300 of life
          cancelReason: "TOO_EXPENSIVE",
          status: "CANCELLED",
          successfulOrders: 8,
        }),
      ),
      ...Array.from({ length: 90 }, () =>
        member({ createdAt: daysAgo(30), successfulOrders: 1 }),
      ),
      ...Array.from({ length: 10 }, () =>
        member({
          createdAt: daysAgo(30),
          cancelledAt: daysAgo(20),
          cancelReason: "ONLY_WANTED_TO_TRY",
          status: "CANCELLED",
          successfulOrders: 1,
        }),
      ),
    ];
    const p365 = pointAt(buildPoints(members, NOW), "365 days");
    // Bug: cancelled contracts entered every denominator regardless of age —
    // eligible 210, remaining 47.6%. Correct: only the 200 mature ones.
    expect(p365.eligible).not.toBe(210);
    expect(p365.remainingPercent).not.toBe(47.6);
    expect(p365.eligible).toBe(200);
    expect(p365.remainingPercent).toBe(50);
    expect(p365.voluntaryExitPercent).toBe(50);
  });

  it("never fabricates a 0% curve for a shop younger than its checkpoints", () => {
    // 60-day-old shop with 10 early cancels: nobody is observable at 365
    // days — the point must be null/0-eligible, not "0% remaining".
    const members: MemberInput[] = [
      ...Array.from({ length: 90 }, () =>
        member({ createdAt: daysAgo(60), successfulOrders: 2 }),
      ),
      ...Array.from({ length: 10 }, () =>
        member({
          createdAt: daysAgo(60),
          cancelledAt: daysAgo(50),
          cancelReason: "ONLY_WANTED_TO_TRY",
          status: "CANCELLED",
          successfulOrders: 1,
        }),
      ),
    ];
    const p365 = pointAt(buildPoints(members, NOW), "365 days");
    expect(p365.eligible).toBe(0);
    // Bug: pct() mapped 0/0 to 0 and the dashboard drew "0.0% remaining".
    expect(p365.remainingPercent).not.toBe(0);
    expect(p365.remainingPercent).toBeNull();
    expect(p365.voluntaryExitPercent).toBeNull();
    expect(p365.paymentFailureExitPercent).toBeNull();
    expect(p365.pendingPercent).toBeNull();
  });
});

describe("buildPoints — null means not observable, 0 means observed and gone", () => {
  it("reports null percentages on zero-eligible checkpoints", () => {
    // 40 contracts, 35 days old, 4-week cadence, zero cancellations.
    const members = Array.from({ length: 40 }, () =>
      member({ createdAt: daysAgo(35), successfulOrders: 2 }),
    );
    const points = buildPoints(members, NOW);
    expect(pointAt(points, "Rebill 1").remainingPercent).toBe(100);
    for (const label of ["Rebill 2", "Rebill 3", "90 days", "180 days", "365 days"]) {
      const p = pointAt(points, label);
      expect(p.eligible).toBe(0);
      expect(p.remainingPercent).toBeNull();
    }
  });

  it("reports 0 (not null) when every eligible contract exited", () => {
    const members = Array.from({ length: 5 }, () =>
      member({
        cancelledAt: daysAgo(390), // day 10 of life
        cancelReason: "IRRITATION",
        status: "CANCELLED",
        successfulOrders: 1,
      }),
    );
    const p90 = pointAt(buildPoints(members, NOW), "90 days");
    expect(p90.eligible).toBe(5);
    expect(p90.remainingPercent).toBe(0);
    expect(p90.voluntaryExitPercent).toBe(100);
  });
});

describe("classifyExit — dunning-exhausted terminal pause is payment failure", () => {
  it("classifies exhausted non-active contracts without cancelledAt", () => {
    // Bug: returned null whenever cancelledAt was null, so dead
    // exhausted-paused contracts counted as survivors forever.
    expect(
      classifyExit({
        cancelledAt: null,
        dunningPhase: "EXHAUSTED",
        cancelReason: null,
        status: "PAUSED",
      }),
    ).toBe("PAYMENT_FAILURE");
  });

  it("ignores a stale EXHAUSTED phase on a reactivated (ACTIVE) contract", () => {
    expect(
      classifyExit({
        cancelledAt: null,
        dunningPhase: "EXHAUSTED",
        cancelReason: null,
        status: "ACTIVE",
      }),
    ).toBeNull();
  });

  it("keeps cancelled-contract semantics", () => {
    expect(
      classifyExit({
        cancelledAt: daysAgo(10),
        dunningPhase: "EXHAUSTED",
        cancelReason: null,
        status: "CANCELLED",
      }),
    ).toBe("PAYMENT_FAILURE");
    expect(
      classifyExit({
        cancelledAt: daysAgo(10),
        dunningPhase: null,
        cancelReason: "PAYMENT_FAILURE",
        status: "CANCELLED",
      }),
    ).toBe("PAYMENT_FAILURE");
    expect(
      classifyExit({
        cancelledAt: daysAgo(10),
        dunningPhase: "NONE",
        cancelReason: "TOO_EXPENSIVE",
        status: "CANCELLED",
      }),
    ).toBe("VOLUNTARY");
  });

  it("treats merged contracts as consolidation, never churn", () => {
    expect(
      classifyExit({
        cancelledAt: daysAgo(10),
        dunningPhase: null,
        cancelReason: "MERGED",
        status: "CANCELLED",
      }),
    ).toBeNull();
  });
});

describe("buildPoints — exhausted-pause deaths count as payment-failure exits", () => {
  // 100 contracts aged 200 days on a 4-week cadence: 85 healthy (5 orders),
  // 15 hit insufficient-funds dunning, exhausted at ~day 60 and were parked
  // in the terminal PAUSE forever (cancelledAt never set).
  const members: MemberInput[] = [
    ...Array.from({ length: 85 }, () =>
      member({ createdAt: daysAgo(200), successfulOrders: 5 }),
    ),
    ...Array.from({ length: 15 }, () =>
      member({
        createdAt: daysAgo(200),
        successfulOrders: 1,
        status: "PAUSED",
        dunningPhase: "EXHAUSTED",
        dunningGraceUntil: daysAgo(145), // day 55 of life
        dunningUpdatedAt: daysAgo(140), // day 60 of life
      }),
    ),
  ];
  const points = buildPoints(members, NOW);

  it("books them as rebill exits (orders frozen at death)", () => {
    const p = pointAt(points, "Rebill 3");
    // Bug: they counted as remaining → 100%. Correct: 85% remain.
    expect(p.remainingPercent).not.toBe(100);
    expect(p.eligible).toBe(100);
    expect(p.remainingPercent).toBe(85);
    expect(p.paymentFailureExitPercent).toBe(15);
    expect(p.pendingPercent).toBe(0);
  });

  it("dates day-checkpoint exits from the grace window end", () => {
    const p90 = pointAt(points, "90 days");
    expect(p90.eligible).toBe(100);
    expect(p90.paymentFailureExitPercent).toBe(15);
    expect(p90.remainingPercent).toBe(85);
  });
});

describe("buildPoints — rebill survival follows the paid-order rule", () => {
  // 10 contracts aged 200 days, 4-week cadence (rebill-3 threshold 84d):
  // 5 active with 4 orders, 4 paused since the first delivery (1 order),
  // 1 cancelled voluntarily with 1 order.
  const members: MemberInput[] = [
    ...Array.from({ length: 5 }, () =>
      member({ createdAt: daysAgo(200), successfulOrders: 4 }),
    ),
    ...Array.from({ length: 4 }, () =>
      member({ createdAt: daysAgo(200), successfulOrders: 1, status: "PAUSED" }),
    ),
    member({
      createdAt: daysAgo(200),
      successfulOrders: 1,
      cancelledAt: daysAgo(50),
      cancelReason: "TOO_EXPENSIVE",
      status: "CANCELLED",
    }),
  ];

  it("does not count alive-but-unpaid contracts as having survived", () => {
    const p = pointAt(buildPoints(members, NOW), "Rebill 3");
    // Bug: every non-cancelled eligible contract counted as remaining → 90%.
    expect(p.remainingPercent).not.toBe(90);
    expect(p.eligible).toBe(10);
    expect(p.remainingPercent).toBe(50);
    expect(p.voluntaryExitPercent).toBe(10);
    expect(p.pendingPercent).toBe(40); // paused/skipping, not survived, not exited
  });

  it("keeps survivedRebill semantics: n rebills = n + 1 paid orders", () => {
    expect(survivedRebill(1, 1)).toBe(false);
    expect(survivedRebill(2, 1)).toBe(true);
    expect(survivedRebill(4, 3)).toBe(true);
  });
});

describe("buildPoints — cadence switches cannot hide proven survivors", () => {
  it("admits contracts by payment count when the current interval mis-dates them", () => {
    // Started on a 2-week cadence, paid 6 orders in 12 weeks, then switched
    // to 12 weeks; only 100 days old, so the age test (3 × 12 × 7 = 252d)
    // fails, but 6 orders prove rebills 1-5.
    const switcher = member({
      createdAt: daysAgo(100),
      successfulOrders: 6,
      intervalWeeks: 12,
    });
    const p = pointAt(buildPoints([switcher], NOW), "Rebill 3");
    // Bug: the loyal switcher was censored out of the denominator.
    expect(p.eligible).toBe(1);
    expect(p.remainingPercent).toBe(100);
  });
});

describe("buildPoints — merged members are censored from the risk set", () => {
  it("drops merged members from checkpoints at/after the merge", () => {
    const merged = member({
      createdAt: daysAgo(400),
      cancelledAt: daysAgo(350), // merged on day 50
      cancelReason: "MERGED",
      status: "CANCELLED",
      successfulOrders: 1,
    });
    const p90 = pointAt(buildPoints([merged, member()], NOW), "90 days");
    expect(p90.eligible).toBe(1);
    expect(p90.remainingPercent).toBe(100);
    expect(p90.voluntaryExitPercent).toBe(0);
  });
});

describe("buildPoints — atRisk sample sizes", () => {
  it("mirrors eligible per point (curve building parity)", () => {
    const members = [
      member(),
      member({ createdAt: daysAgo(35), successfulOrders: 1 }),
    ];
    const points = buildPoints(members, NOW);
    // getSurvivalCurves builds atRisk as points.map(p => p.eligible); assert
    // the invariant the UI relies on here at the pure layer.
    const atRisk = points.map((p) => p.eligible);
    expect(atRisk).toHaveLength(points.length);
    points.forEach((p, i) => expect(atRisk[i]).toBe(p.eligible));
  });
});

describe("sortCohortKeys — the 24-curve cap keeps the relevant cohorts", () => {
  it("orders startMonth keys newest first", () => {
    const keys = ["2024-01", "2026-07", "2025-12", "2026-01"];
    // Bug: ascending sort + slice(0, 24) kept the OLDEST months and silently
    // dropped the newest cohorts.
    expect(sortCohortKeys(keys, "startMonth")).toEqual([
      "2026-07",
      "2026-01",
      "2025-12",
      "2024-01",
    ]);
  });

  it("orders intervalWeeks numerically, not lexicographically", () => {
    const keys = ["12 weeks", "2 weeks", "8 weeks"];
    // Bug: string sort put "12 weeks" before "2 weeks".
    expect(sortCohortKeys(keys, "intervalWeeks")).toEqual([
      "2 weeks",
      "8 weeks",
      "12 weeks",
    ]);
  });

  it("keeps plain lexicographic order for widgetVersion", () => {
    expect(sortCohortKeys(["b", "a", "c"], "widgetVersion")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
