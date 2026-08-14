import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSION (v1.22.0): concurrency guards use WALL time, not tick time.
 *
 * runAllDueJobs(now) threads one tick-start timestamp through a sequential
 * pass over every registry job. The lease horizon, the dueness checks and
 * the RUNNING JobRun's startedAt used to be anchored to that stale `now`: by
 * the time job N acquired its lock, real time was tick-start + (duration of
 * jobs 1..N-1), so a job acquired >5 real minutes into a long tick held a
 * lease that expired BEFORE its first heartbeat renewal, and its backdated
 * startedAt made a rival invocation classify the live run as crash residue —
 * two sweeps then ran concurrently (duplicate dunning emails, double ladder
 * increments). Job BODIES keep receiving the logical tick `now`.
 *
 * The harness simulates a slow tick by advancing the fake system clock every
 * time a JobRun row is created (i.e. "each job takes SLOW_JOB_MS to start
 * the next one") and asserts the SECOND job's lease and startedAt are
 * anchored to the advanced wall clock, not the tick start.
 */

const SLOW_JOB_MS = 6 * 60_000; // > LOCK_RENEW_MS (5m): the dangerous zone

const mocks = vi.hoisted(() => ({
  jobRunFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  jobRunCreate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  jobRunUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  lockUpdateMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({ count: 0 })),
  lockFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  lockCreate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => {
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    if (method === "aggregate") return { _sum: {}, _count: {}, _max: {} };
    return null;
  };
  const autoModel = new Proxy({}, { get: (_t, m: string) => stubFor(m) });
  const explicit: Record<string, unknown> = {
    jobRun: {
      findFirst: mocks.jobRunFindFirst,
      create: mocks.jobRunCreate,
      update: mocks.jobRunUpdate,
    },
    jobLock: {
      updateMany: mocks.lockUpdateMany,
      findUnique: mocks.lockFindUnique,
      create: mocks.lockCreate,
    },
  };
  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        if (model === "$queryRaw") return async () => [];
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );
  return { default: db };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => ({})),
}));

// No shop: setup mode resolves true (fail-dark), gated bodies skip without
// importing their modules, ungated bodies short-circuit on no_shop.
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async () => {
    throw new Error("no shop");
  }),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: vi.fn(async () => {}),
}));

import {
  JOB_SCHEDULE,
  LOCK_LEASE_MS,
  runAllDueJobs,
} from "~/lib/jobs/runner.server";

interface CapturedStart {
  jobName: string;
  startedAt: Date;
  /** Wall clock at the moment the JobRun row was created. */
  wallAtCreate: number;
}

const starts: CapturedStart[] = [];
const leases: Array<{ name: string; lockedUntil: Date; wallAtClaim: number }> =
  [];

beforeEach(() => {
  vi.clearAllMocks();
  starts.length = 0;
  leases.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T06:00:00Z"));

  // Only the first two registry jobs are due; the rest report a recent run.
  const dueNames = new Set(JOB_SCHEDULE.slice(0, 2).map((j) => j.name));
  mocks.jobRunFindFirst.mockImplementation(async (rawArgs?: unknown) => {
    const args = rawArgs as { where?: { jobName?: string } } | undefined;
    const name = args?.where?.jobName;
    if (name && dueNames.has(name)) return null; // never ran → due
    if (name) {
      return {
        status: "SUCCESS",
        startedAt: new Date(Date.now() - 30_000),
        error: null,
        stats: null,
      };
    }
    return { id: "jr_any" };
  });
  mocks.lockCreate.mockImplementation(async (rawArgs?: unknown) => {
    const args = rawArgs as { data: { name: string; lockedUntil: Date } };
    leases.push({
      name: args.data.name,
      lockedUntil: args.data.lockedUntil,
      wallAtClaim: Date.now(),
    });
    return args.data;
  });
  mocks.jobRunCreate.mockImplementation(async (rawArgs?: unknown) => {
    const args = rawArgs as { data: { jobName: string; startedAt: Date } };
    starts.push({
      jobName: args.data.jobName,
      startedAt: args.data.startedAt,
      wallAtCreate: Date.now(),
    });
    // Simulate this job's body (and bookkeeping) consuming real time
    // before the NEXT job acquires its lock.
    vi.setSystemTime(new Date(Date.now() + SLOW_JOB_MS));
    return { id: `jr_${starts.length}` };
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("job lock leases and JobRun.startedAt anchor to wall time", () => {
  it("a job acquired late in a slow tick gets a fresh lease and a fresh startedAt", async () => {
    const tickStart = new Date();

    await runAllDueJobs(tickStart);

    expect(starts.length).toBeGreaterThanOrEqual(2);
    const second = starts[1];
    const secondLease = leases.find((l) => l.name === second.jobName);

    // startedAt reflects when the job ACTUALLY started (wall clock), never
    // the tick start — a rival's isDue must see a fresh RUNNING row.
    expect(second.startedAt.getTime()).toBe(second.wallAtCreate);
    expect(second.startedAt.getTime()).toBeGreaterThanOrEqual(
      tickStart.getTime() + SLOW_JOB_MS,
    );

    // The lease reaches LOCK_LEASE_MS past the CLAIM instant — anchored to
    // the stale tick start it would already be half-expired at birth.
    expect(secondLease).toBeDefined();
    expect(secondLease!.lockedUntil.getTime()).toBe(
      secondLease!.wallAtClaim + LOCK_LEASE_MS,
    );
    expect(secondLease!.lockedUntil.getTime()).toBeGreaterThanOrEqual(
      tickStart.getTime() + SLOW_JOB_MS + LOCK_LEASE_MS,
    );
  });
});
