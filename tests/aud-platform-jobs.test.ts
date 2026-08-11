import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * JOB-BODY CONTRACTS OF THE v1.9 PLATFORM AUDIT — runner.server, evaluated.
 *
 *  - runRollupJob: the self-heal backfill must pass `backfill: true` for gap
 *    days. A backfilled past day CANNOT know its historical actives/MRR; the
 *    old call stamped live post-outage counts over the whole gap, flattening
 *    real trends and leaking future values into the forecast's training
 *    history with no honesty annotation (rows existed, so the filledWeeks
 *    carry-forward flag never fired). The trailing-recompute days stay LIVE
 *    runs — re-snapshotting "yesterday" is the semantics it always had.
 *  - runStepsContained / the recorder-pair jobs: two independent analytics
 *    recorders share one nightly tick; a deterministic failure in the first
 *    must not permanently starve the second (a forecast-accuracy week that
 *    never records is a hole that can never be measured later), while the
 *    job itself still surfaces FAILED for the retry leash and audit trail.
 *  - runRetention90d: the verdict is AS OF completedAt+90d, derived from
 *    status timestamps — a backlog session evaluated at day 90+N must not
 *    label a subscriber who churned at day 150 as a failed save.
 *  - Registry: the reconcile jobs exist and stay ungated (recovery plumbing
 *    reads mirrors; it must run in SETUP too).
 */

const mocks = vi.hoisted(() => ({
  rollupFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  rollupFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  // Refund-repair pass inputs (v1.16.0): the stored analytics setting row
  // (null → the shipped exclude-ON default) and the repair delegate the
  // runner hands the day-resolution work to (its own behavior is pinned in
  // tests/refund-exclusion.test.ts against the fake analytics db).
  settingFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  repairRefundDays: vi.fn(async (_shopId?: unknown, _opts?: unknown): Promise<number> => 0),
  // Typed with the real (shopId, day, opts?) shape so the recorded calls'
  // day/opts tuple positions type-check in the assertions below.
  runDailyRollup: vi.fn(
    async (
      _shopId: string,
      _day: Date,
      _opts?: { backfill?: boolean },
    ): Promise<unknown> => ({}),
  ),
  sessionFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  sessionUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  runRiskLearning: vi.fn(async (): Promise<unknown> => ({ trained: true })),
  recordForecastAccuracyWeek: vi.fn(async (): Promise<unknown> => ({
    recorded: true,
  })),
  runChurnRiskScoring: vi.fn(async (): Promise<unknown> => ({ scored: 3 })),
  runPredictedEmptyDates: vi.fn(async (): Promise<unknown> => ({ updated: 2 })),
}));

vi.mock("~/db.server", () => {
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    return null;
  };
  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );
  const explicit: Record<string, unknown> = {
    dailyRollup: {
      findFirst: mocks.rollupFindFirst,
      findMany: mocks.rollupFindMany,
    },
    cancelSession: {
      findMany: mocks.sessionFindMany,
      update: mocks.sessionUpdate,
    },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    setting: { findUnique: mocks.settingFindUnique },
  };
  return {
    default: new Proxy(
      {},
      {
        get: (_t, model: string) =>
          model in explicit ? explicit[model] : autoModel,
      },
    ),
  };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    // UTC keeps the day-label math transparent in assertions; the tz plumbing
    // itself is queries.server's tested concern.
    ianaTimezone: "UTC",
  })),
}));

vi.mock("~/lib/analytics/rollup.server", () => ({
  runDailyRollup: mocks.runDailyRollup,
  repairRefundAffectedRollupDays: mocks.repairRefundDays,
}));

vi.mock("~/lib/analytics/learning.server", () => ({
  runRiskLearning: mocks.runRiskLearning,
}));

vi.mock("~/lib/analytics/forecast.server", () => ({
  recordForecastAccuracyWeek: mocks.recordForecastAccuracyWeek,
}));

vi.mock("~/lib/analytics/risk.server", () => ({
  runChurnRiskScoring: mocks.runChurnRiskScoring,
  runPredictedEmptyDates: mocks.runPredictedEmptyDates,
}));

import {
  JOB_NAMES,
  SETUP_GATED_JOB_NAMES,
  runChurnRiskJob,
  runRetention90d,
  runRiskLearningJob,
  runRollupJob,
  runStepsContained,
} from "~/lib/jobs/runner.server";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** UTC day label ("yyyy-MM-dd") of NOW minus `daysAgo` days. */
function dayKeyAgo(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rollupFindFirst.mockResolvedValue(null);
  mocks.rollupFindMany.mockResolvedValue([]);
  mocks.runDailyRollup.mockResolvedValue({});
  mocks.sessionFindMany.mockResolvedValue([]);
  mocks.sessionUpdate.mockResolvedValue({});
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.settingFindUnique.mockResolvedValue(null); // → shipped defaults apply
  mocks.repairRefundDays.mockResolvedValue(0);
  mocks.runRiskLearning.mockResolvedValue({ trained: true });
  mocks.recordForecastAccuracyWeek.mockResolvedValue({ recorded: true });
  mocks.runChurnRiskScoring.mockResolvedValue({ scored: 3 });
  mocks.runPredictedEmptyDates.mockResolvedValue({ updated: 2 });
});

describe("runRollupJob — backfill honesty (FR-3)", () => {
  it("backfills gap days with backfill:true and recomputes trailing days live", async () => {
    // Oldest rollup 8 days ago; rows exist for days -8, -7, -6, -4 → the
    // in-window gaps are day -5 and day -3 (the trailing window covers -2..0).
    mocks.rollupFindFirst.mockResolvedValue({
      date: new Date(`${dayKeyAgo(8)}T00:00:00.000Z`),
    });
    mocks.rollupFindMany.mockResolvedValue(
      [8, 7, 6, 4].map((d) => ({
        date: new Date(`${dayKeyAgo(d)}T00:00:00.000Z`),
      })),
    );

    const stats = await runRollupJob(NOW);

    const calls = mocks.runDailyRollup.mock.calls.map((c) => ({
      day: (c[1] as Date).toISOString().slice(0, 10),
      opts: c[2] as { backfill?: boolean } | undefined,
    }));

    // Gap days carry the honesty flag — their snapshot columns are
    // unknowable after the fact and must be fabrication-marked, not stamped
    // with live post-outage counts.
    expect(calls.filter((c) => c.opts?.backfill === true).map((c) => c.day))
      .toEqual([dayKeyAgo(5), dayKeyAgo(3)]);

    // Trailing recompute days (-2, -1, today) run LIVE: no backfill flag.
    expect(calls.filter((c) => c.opts === undefined).map((c) => c.day)).toEqual(
      [dayKeyAgo(2), dayKeyAgo(1), dayKeyAgo(0)],
    );

    expect(stats).toEqual({ days: 5, backfilled: 2, repairedDays: 0 });
  });

  it("never synthesizes pre-analytics history — days at or before the first rollup stay absent", async () => {
    mocks.rollupFindFirst.mockResolvedValue({
      date: new Date(`${dayKeyAgo(4)}T00:00:00.000Z`),
    });
    // Only the oldest row exists; days -3 will backfill, everything ≤ -4 must not.
    mocks.rollupFindMany.mockResolvedValue([
      { date: new Date(`${dayKeyAgo(4)}T00:00:00.000Z`) },
    ]);

    await runRollupJob(NOW);

    const backfilled = mocks.runDailyRollup.mock.calls
      .filter((c) => (c[2] as { backfill?: boolean } | undefined)?.backfill)
      .map((c) => (c[1] as Date).toISOString().slice(0, 10));
    expect(backfilled).toEqual([dayKeyAgo(3)]);
  });

  it("with no rollup history at all, only the trailing window runs (all live)", async () => {
    const stats = await runRollupJob(NOW);

    expect(mocks.runDailyRollup).toHaveBeenCalledTimes(3);
    expect(
      mocks.runDailyRollup.mock.calls.every((c) => c[2] === undefined),
    ).toBe(true);
    expect(stats).toEqual({ days: 3, backfilled: 0, repairedDays: 0 });
  });
});

describe("runRollupJob — refund repair under exclusion (v1.16.0)", () => {
  it("delegates to the state-derived repair with the standing window, trailing-skip and cap", async () => {
    // Closed history back to day -8, no gaps (rows for every day in window).
    mocks.rollupFindFirst.mockResolvedValue({
      date: new Date(`${dayKeyAgo(8)}T00:00:00.000Z`),
    });
    mocks.rollupFindMany.mockResolvedValue(
      [8, 7, 6, 5, 4, 3].map((d) => ({
        date: new Date(`${dayKeyAgo(d)}T00:00:00.000Z`),
      })),
    );
    mocks.repairRefundDays.mockResolvedValue(2);

    const stats = await runRollupJob(NOW);

    expect(mocks.repairRefundDays).toHaveBeenCalledTimes(1);
    const [shopId, opts] = mocks.repairRefundDays.mock.calls[0] as [
      string,
      { since: Date; skipAfter: Date; cap: number },
    ];
    expect(shopId).toBe("shop_1");
    // The standing 90-day backfill window bounds repair scope…
    expect(opts.since.toISOString().slice(0, 10)).toBe(dayKeyAgo(90));
    // …the live trailing recompute (days -2..0) is excluded…
    expect(opts.skipAfter.toISOString().slice(0, 10)).toBe(dayKeyAgo(2));
    // …and the cap equals the window, so it can never starve a day out.
    expect(opts.cap).toBe(90);
    expect(stats).toEqual({ days: 5, backfilled: 0, repairedDays: 2 });
  });

  it("stays fully inert when the exclude-refunded option is off", async () => {
    mocks.settingFindUnique.mockResolvedValueOnce({
      value: { excludeRefundedPayments: false },
    });
    mocks.rollupFindFirst.mockResolvedValue({
      date: new Date(`${dayKeyAgo(8)}T00:00:00.000Z`),
    });
    mocks.rollupFindMany.mockResolvedValue(
      [8, 7, 6, 5, 4, 3].map((d) => ({
        date: new Date(`${dayKeyAgo(d)}T00:00:00.000Z`),
      })),
    );

    const stats = await runRollupJob(NOW);
    // No repair at all — off-mode behavior is byte-identical to pre-v1.16.0
    // (closed days are never rewritten by the nightly job; a TOGGLE of the
    // setting runs its own full-history repair from the settings save).
    expect(mocks.repairRefundDays).not.toHaveBeenCalled();
    expect(stats).toEqual({ days: 3, backfilled: 0, repairedDays: 0 });
  });
});

describe("runStepsContained — per-step containment (FR-7)", () => {
  it("returns the keyed results when every step succeeds", async () => {
    await expect(
      runStepsContained([
        ["a", async () => 1],
        ["b", async () => 2],
      ]),
    ).resolves.toEqual({ a: 1, b: 2 });
  });

  it("runs the second step after the first throws, then surfaces FAILED naming both outcomes", async () => {
    const second = vi.fn(async () => "ok");

    await expect(
      runStepsContained([
        [
          "learning",
          async () => {
            throw new Error("bad data shape");
          },
        ],
        ["forecastHistory", second],
      ]),
    ).rejects.toThrow(/learning: bad data shape \(completed: forecastHistory\)/);

    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a second-step failure does not erase the first step's completion from the record", async () => {
    await expect(
      runStepsContained([
        ["risk", async () => "scored"],
        [
          "emptyDates",
          async () => {
            throw new Error("boom");
          },
        ],
      ]),
    ).rejects.toThrow(/emptyDates: boom \(completed: risk\)/);
  });
});

describe("recorder-pair job bodies wire through the containment", () => {
  it("risk_learning_run: a deterministic trainer failure no longer starves forecast-accuracy recording", async () => {
    mocks.runRiskLearning.mockRejectedValue(new Error("zod: bad riskModel"));

    await expect(runRiskLearningJob(NOW)).rejects.toThrow(
      /learning: zod: bad riskModel/,
    );

    // The starved-second-step bug, pinned: the recorder ran anyway.
    expect(mocks.recordForecastAccuracyWeek).toHaveBeenCalledTimes(1);
  });

  it("risk_learning_run keeps its JobRun stats shape on success", async () => {
    await expect(runRiskLearningJob(NOW)).resolves.toEqual({
      learning: { trained: true },
      forecastHistory: { recorded: true },
    });
  });

  it("churn_risk_run: a scoring failure no longer freezes predictedEmptyDate", async () => {
    mocks.runChurnRiskScoring.mockRejectedValue(new Error("feature drift"));

    await expect(runChurnRiskJob(NOW)).rejects.toThrow(/risk: feature drift/);

    expect(mocks.runPredictedEmptyDates).toHaveBeenCalledTimes(1);
  });
});

describe("runRetention90d — verdict as of completedAt+90d (SP-13)", () => {
  function primeSession(completedDaysAgo: number) {
    mocks.sessionFindMany.mockResolvedValue([
      {
        id: "session_1",
        contractId: "contract_1",
        completedAt: new Date(NOW.getTime() - completedDaysAgo * DAY_MS),
      },
    ]);
  }

  function verdict(): boolean {
    const call = mocks.sessionUpdate.mock.calls[0][0] as {
      data: { retainedAt90d: boolean };
    };
    return call.data.retainedAt90d;
  }

  it("a late-evaluated session whose contract churned AFTER day 90 is retained (the mislabeling bug, pinned)", async () => {
    primeSession(200);
    // Churned at day 150 — the save DID stick at day 90; the old
    // status-at-run-time read labeled this false.
    mocks.contractFindUnique.mockResolvedValue({
      cancelledAt: new Date(NOW.getTime() - 50 * DAY_MS),
      failedAt: null,
      expiredAt: null,
    });

    const stats = await runRetention90d(NOW);

    expect(verdict()).toBe(true);
    expect(stats).toEqual({ evaluated: 1, retained: 1 });
  });

  it("a contract cancelled within the 90 days is not retained, however late the evaluation", async () => {
    primeSession(200);
    mocks.contractFindUnique.mockResolvedValue({
      cancelledAt: new Date(NOW.getTime() - 150 * DAY_MS), // day 50
      failedAt: null,
      expiredAt: null,
    });

    await runRetention90d(NOW);

    expect(verdict()).toBe(false);
  });

  it("failedAt and expiredAt are churn timestamps too (default exhausted action is PAUSE→FAILED, no cancelledAt)", async () => {
    primeSession(100);
    mocks.contractFindUnique.mockResolvedValue({
      cancelledAt: null,
      failedAt: new Date(NOW.getTime() - 11 * DAY_MS), // day 89
      expiredAt: null,
    });

    await runRetention90d(NOW);

    expect(verdict()).toBe(false);
  });

  it("a timestamp exactly at day 90 counts as churned-by-90 (boundary)", async () => {
    primeSession(100);
    mocks.contractFindUnique.mockResolvedValue({
      cancelledAt: null,
      failedAt: null,
      expiredAt: new Date(NOW.getTime() - 10 * DAY_MS), // exactly completedAt+90d
    });

    await runRetention90d(NOW);

    expect(verdict()).toBe(false);
  });

  it("no churn timestamps means the contract was still subscribed at day 90 — retained", async () => {
    primeSession(95);
    mocks.contractFindUnique.mockResolvedValue({
      cancelledAt: null,
      failedAt: null,
      expiredAt: null,
    });

    await runRetention90d(NOW);

    expect(verdict()).toBe(true);
  });

  it("a deleted contract (demo reset is the only deleter) is not a retained subscriber", async () => {
    primeSession(95);
    mocks.contractFindUnique.mockResolvedValue(null);

    await runRetention90d(NOW);

    expect(verdict()).toBe(false);
  });

  it("only unlabeled SAVED sessions past the 90-day cutoff are selected", async () => {
    await runRetention90d(NOW);

    const where = (
      mocks.sessionFindMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      }
    ).where;
    expect(where).toMatchObject({ outcome: "SAVED", retainedAt90d: null });
    expect(
      (where.completedAt as { lte: Date }).lte.getTime(),
    ).toBe(NOW.getTime() - 90 * DAY_MS);
  });
});

describe("reconcile jobs registry (I6)", () => {
  it("registers refund_reconcile and full_sync_reconcile", () => {
    expect(JOB_NAMES).toContain("refund_reconcile");
    expect(JOB_NAMES).toContain("full_sync_reconcile");
  });

  it("keeps both ungated — recovery plumbing over mirror data must run in SETUP too", () => {
    expect(SETUP_GATED_JOB_NAMES).not.toContain("refund_reconcile");
    expect(SETUP_GATED_JOB_NAMES).not.toContain("full_sync_reconcile");
  });
});
