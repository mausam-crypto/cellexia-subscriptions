import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Background flow task runner (v1.25.0, app/lib/klaviyo/setup-task.server.ts).
 *
 * Pinned here:
 *  - START RETURNS IMMEDIATELY: startFlowTask registers a running task and
 *    returns before the work finishes; progress and completion are visible
 *    through getFlowTask (in-process map first, persisted copy second).
 *  - ONE TASK PER SHOP: a second start while one runs (any kind) is
 *    `already_running` and returns the running task — including two starts
 *    IN FLIGHT at the same instant (no await between the map re-check and
 *    the registration).
 *  - CROSS-INSTANCE LEASE: a start claims the JobLock lease
 *    `klaviyo_flow_task:<shopId>` (owner = task id, 90 s) before running,
 *    renews it from the heartbeat and releases it at the end; a lease held
 *    elsewhere → already_running, nothing runs.
 *  - STALE RUNNING → FAILED + RESTARTABLE: a persisted "running" record not
 *    touched for > 90 s is reported failed ("interrupted") and no longer
 *    blocks a new start; a fresh one from another instance does block.
 *  - HEARTBEAT + THROTTLE: progress persists at most once per second; a
 *    silent run still refreshes its persisted updatedAt every 15 s, so the
 *    90 s rule never fires on a live task.
 *  - ORPHANS ARE WRITE-INERT: a run that lost its map slot to a newer start
 *    never persists again — the live task's record cannot be resurrected.
 *  - PERSISTED TASK FIELD: the record rides `klaviyoFlowSetup.task` (start,
 *    end) without clobbering the coverage rows next to it; a failed READ
 *    inside the write chain aborts that write (never rebuilds the record
 *    from an empty cache).
 *  - AUDIT: setup completion logs admin.action klaviyo_flow_setup with the
 *    actor who clicked (moved here from the route).
 *  - ERRORS ARE CONTAINED: a throwing job ends in state "failed" with the
 *    message; the next start is allowed.
 */

const mocks = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  verify: vi.fn(),
  setup: vi.fn(),
  /** Default read: the in-memory settings table (re-installed before each test). */
  defaultGetSetting: async (_shopId: string, key: string): Promise<unknown> => {
    return (
      mocks.settings.get(key) ?? {
        checkedAt: null,
        lastAttemptAt: null,
        setupRanAt: null,
        rows: [],
        task: null,
      }
    );
  },
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  setSetting: vi.fn(async (_shopId: string, key: string, value: unknown): Promise<void> => {
    mocks.settings.set(key, value);
  }),
  // JobLock lease seam (app/lib/jobs/runner.server.ts) — a single in-memory
  // lease table so "held elsewhere" can be simulated.
  leases: new Map<string, { owner: string; until: number }>(),
  acquireLock: vi.fn(
    async (name: string, now: Date, owner: string, leaseMs: number): Promise<boolean> => {
      const held = mocks.leases.get(name);
      if (held && held.until > now.getTime() && held.owner !== owner) return false;
      mocks.leases.set(name, { owner, until: now.getTime() + leaseMs });
      return true;
    },
  ),
  renewLock: vi.fn(async (name: string, owner: string, leaseMs: number): Promise<void> => {
    const held = mocks.leases.get(name);
    if (held && held.owner === owner) held.until = Date.now() + leaseMs;
  }),
  releaseLock: vi.fn(async (name: string, owner: string): Promise<void> => {
    const held = mocks.leases.get(name);
    if (held && held.owner === owner) mocks.leases.delete(name);
  }),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));
vi.mock("~/lib/jobs/runner.server", () => ({
  acquireLock: mocks.acquireLock,
  renewLock: mocks.renewLock,
  releaseLock: mocks.releaseLock,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/notifications/mailer.server", () => ({
  resolveMailConfig: vi.fn(async () => ({ from: "Cellexia <care@cellexia.com>" })),
}));
vi.mock("~/lib/klaviyo/flows.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/lib/klaviyo/flows.server")>();
  return {
    ...original, // real persistence helpers (readCachedCoverage, updateFlowSetupSetting…)
    verifyFlowCoverage: mocks.verify,
    runGuidedSetup: mocks.setup,
  };
});

import {
  FLOW_TASK_STALE_MS,
  flowTaskLeaseName,
  getFlowTask,
  startFlowTask,
  type FlowTaskState,
} from "~/lib/klaviyo/setup-task.server";
import {
  updateFlowSetupSetting,
  type SetupProgress,
  type SetupReport,
} from "~/lib/klaviyo/flows.server";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const report = (over: Partial<SetupReport> = {}): SetupReport => ({
  ok: true,
  seeded: [],
  rows: [],
  checkedAt: new Date().toISOString(),
  ...over,
});

/** Waits until the shop's task leaves "running" (bounded). */
async function settled(shopId: string) {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    const task = await getFlowTask(shopId);
    if (task && task.state !== "running") return task;
  }
  throw new Error("task never settled");
}

function persistedTask(): FlowTaskState | null {
  return (
    (mocks.settings.get("klaviyoFlowSetup") as { task: FlowTaskState | null } | undefined)
      ?.task ?? null
  );
}

/** The in-process task map (the module's `global.__cellexiaFlowTasks`). */
function localMap(): Map<string, FlowTaskState> {
  const g = globalThis as { __cellexiaFlowTasks?: Map<string, FlowTaskState> };
  if (!g.__cellexiaFlowTasks) g.__cellexiaFlowTasks = new Map();
  return g.__cellexiaFlowTasks;
}

/** Drains chained promise work without touching (possibly fake) timers. */
async function flush(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(mocks.defaultGetSetting);
  mocks.settings = new Map();
  mocks.leases = new Map();
  (globalThis as { __cellexiaFlowTasks?: Map<string, unknown> }).__cellexiaFlowTasks =
    new Map();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("start / poll / done", () => {
  it("returns immediately with a running task; progress and completion are visible via getFlowTask and persisted", async () => {
    const job = deferred<SetupReport>();
    let onProgress: ((p: SetupProgress) => void) | undefined;
    mocks.verify.mockImplementation(async (_shop: string, opts: { onProgress?: typeof onProgress }) => {
      onProgress = opts.onProgress;
      return job.promise;
    });

    const started = await startFlowTask("shop_1", "verify", { actor: "merchant@example.com" });
    expect(started.started).toBe(true);
    expect(started.task.state).toBe("running");
    expect(started.task.kind).toBe("verify");
    expect(persistedTask()?.state).toBe("running"); // written on start

    const running = await getFlowTask("shop_1");
    expect(running?.state).toBe("running");
    expect(running?.id).toBe(started.task.id);

    await new Promise((r) => setTimeout(r, 0));
    expect(onProgress).toBeTypeOf("function");
    onProgress!({ step: "reading", done: 0, total: 0, message: "Reading your Klaviyo metrics and flows…" });
    const progressed = await getFlowTask("shop_1");
    expect(progressed?.step).toBe("reading");
    expect(progressed?.message).toContain("Reading");

    job.resolve(report({ rows: [] }));
    const done = await settled("shop_1");
    expect(done.state).toBe("done");
    expect(done.report?.ok).toBe(true);
    expect(done.finishedAt).toBeTruthy();
    expect(persistedTask()?.state).toBe("done"); // always written at the end
    expect(mocks.logEvent).not.toHaveBeenCalled(); // verify is not audited
  });

  it("one task per shop: a second start while one runs is already_running (any kind)", async () => {
    const job = deferred<SetupReport>();
    mocks.verify.mockImplementation(async () => job.promise);
    const first = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    const second = await startFlowTask("shop_1", "setup", {
      actor: "b@example.com",
      seedEmail: "b@example.com",
    });
    expect(second.started).toBe(false);
    expect(second.reason).toBe("already_running");
    expect(second.task.id).toBe(first.task.id);
    expect(mocks.setup).not.toHaveBeenCalled();
    job.resolve(report());
    await settled("shop_1");
    // Finished → a new start is allowed again.
    mocks.setup.mockResolvedValue(report());
    const third = await startFlowTask("shop_1", "setup", { actor: "b@example.com" });
    expect(third.started).toBe(true);
    await settled("shop_1");
  });

  it("two starts IN FLIGHT at the same instant register exactly one task (no await between the map re-check and the registration)", async () => {
    // Make the persisted read genuinely asynchronous so both starts are
    // past their first await when the second one re-checks the map.
    mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
      await new Promise((r) => setTimeout(r, 1));
      return (
        mocks.settings.get(key) ?? {
          checkedAt: null,
          lastAttemptAt: null,
          setupRanAt: null,
          rows: [],
          task: null,
        }
      );
    });
    const job = deferred<SetupReport>();
    mocks.setup.mockImplementation(async () => job.promise);
    const [a, b] = await Promise.all([
      startFlowTask("shop_1", "setup", { actor: "a@example.com", seedEmail: "a@example.com" }),
      startFlowTask("shop_1", "setup", { actor: "b@example.com", seedEmail: "b@example.com" }),
    ]);
    expect([a, b].filter((r) => r.started)).toHaveLength(1);
    const loser = a.started ? b : a;
    expect(loser.reason).toBe("already_running");
    expect(a.task.id).toBe(b.task.id);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1); // the loser never reached the lease
    job.resolve(report());
    await settled("shop_1");
  });
});

describe("cross-instance lease (JobLock)", () => {
  it("a start claims klaviyo_flow_task:<shopId> for the task id (90 s), renews it from the heartbeat and releases it at the end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T10:00:00.000Z"));
    const job = deferred<SetupReport>();
    mocks.verify.mockImplementation(async () => job.promise);
    const started = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    expect(started.started).toBe(true);
    expect(mocks.acquireLock).toHaveBeenCalledTimes(1);
    const [name, , owner, leaseMs] = mocks.acquireLock.mock.calls[0];
    expect(name).toBe(flowTaskLeaseName("shop_1"));
    expect(name).toBe("klaviyo_flow_task:shop_1");
    expect(owner).toBe(started.task.id);
    expect(leaseMs).toBe(FLOW_TASK_STALE_MS);
    expect(mocks.releaseLock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_001);
    expect(mocks.renewLock).toHaveBeenCalledTimes(1);
    expect(mocks.renewLock).toHaveBeenLastCalledWith(
      "klaviyo_flow_task:shop_1",
      started.task.id,
      FLOW_TASK_STALE_MS,
    );

    job.resolve(report());
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect((await getFlowTask("shop_1"))?.state).toBe("done");
    expect(mocks.releaseLock).toHaveBeenCalledWith("klaviyo_flow_task:shop_1", started.task.id);
    expect(mocks.leases.has("klaviyo_flow_task:shop_1")).toBe(false);
    // Interval cleared: no renewals after the end.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.renewLock).toHaveBeenCalledTimes(1);
  });

  it("a lease held by another instance → already_running, nothing runs, no local slot kept; freed lease → a start succeeds", async () => {
    // Another instance owns the lease but its start record has not landed
    // (or the persisted read said nothing) — the lease alone must refuse.
    mocks.leases.set("klaviyo_flow_task:shop_1", {
      owner: "elsewhere-task",
      until: Date.now() + FLOW_TASK_STALE_MS,
    });
    const refused = await startFlowTask("shop_1", "setup", {
      actor: "a@example.com",
      seedEmail: "a@example.com",
    });
    expect(refused.started).toBe(false);
    expect(refused.reason).toBe("already_running");
    expect(refused.task.state).toBe("running");
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.setSetting).not.toHaveBeenCalled(); // no start record written
    expect(localMap().size).toBe(0); // the slot was handed back
    expect(persistedTask()).toBeNull();

    // When the other instance's record IS persisted, that record comes back.
    const now = new Date().toISOString();
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: null,
      rows: [],
      task: {
        id: "elsewhere-task",
        kind: "verify",
        state: "running",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        step: "reading",
        message: "…",
        done: 0,
        total: 0,
        report: null,
        error: null,
      },
    });
    const again = await startFlowTask("shop_1", "setup", { actor: "a@example.com" });
    expect(again.started).toBe(false);
    expect(again.task.id).toBe("elsewhere-task");

    // Lease released elsewhere + record finished → a start succeeds.
    mocks.leases.delete("klaviyo_flow_task:shop_1");
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: null,
      rows: [],
      task: null,
    });
    mocks.setup.mockResolvedValue(report());
    const ok = await startFlowTask("shop_1", "setup", { actor: "a@example.com" });
    expect(ok.started).toBe(true);
    await settled("shop_1");
    expect(mocks.setup).toHaveBeenCalledTimes(1);
  });
});

describe("heartbeat / persist throttle", () => {
  it("progress persists at most once per second; a silent run heartbeats every 15 s so the 90 s rule never fires on it (locally or from another instance)", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-08-15T10:00:00.000Z");
    vi.setSystemTime(t0);
    const job = deferred<SetupReport>();
    let onProgress: ((p: SetupProgress) => void) | undefined;
    mocks.verify.mockImplementation(async (_shop: string, opts: { onProgress?: typeof onProgress }) => {
      onProgress = opts.onProgress;
      return job.promise;
    });
    const started = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toBeTypeOf("function");
    const writesAfterStart = mocks.setSetting.mock.calls.length;
    expect(writesAfterStart).toBe(1); // the start record

    // Five progress ticks inside the first second → zero extra writes
    // (the local copy is updated instantly, only the DB write is throttled).
    for (let i = 0; i < 5; i += 1) {
      onProgress!({ step: "reading", done: i, total: 5, message: `tick ${i}` });
      await vi.advanceTimersByTimeAsync(20);
    }
    expect((await getFlowTask("shop_1"))?.message).toBe("tick 4");
    expect(mocks.setSetting.mock.calls.length).toBe(writesAfterStart);
    // Past the throttle window → exactly one more write, carrying the latest message.
    await vi.advanceTimersByTimeAsync(1_000);
    onProgress!({ step: "reading", done: 5, total: 5, message: "tick 5" });
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(mocks.setSetting.mock.calls.length).toBe(writesAfterStart + 1);
    expect(persistedTask()?.message).toBe("tick 5");

    // Silence: no progress for 100 s. The heartbeat keeps the persisted
    // record fresh (≤ 15 s old) so nothing reads it as interrupted.
    const beforeSilence = persistedTask()!.updatedAt;
    await vi.advanceTimersByTimeAsync(15_001);
    await flush();
    expect(persistedTask()!.updatedAt > beforeSilence).toBe(true);
    await vi.advanceTimersByTimeAsync(85_000);
    await flush();
    const persisted = persistedTask()!;
    expect(persisted.state).toBe("running");
    expect(Date.now() - Date.parse(persisted.updatedAt)).toBeLessThanOrEqual(15_000);
    expect(Date.now() - t0.getTime()).toBeGreaterThan(FLOW_TASK_STALE_MS);
    expect((await getFlowTask("shop_1"))?.state).toBe("running");

    // Another instance (empty local map) reads the same persisted record:
    // still running, and its start is refused.
    const mine = localMap();
    (globalThis as { __cellexiaFlowTasks?: Map<string, FlowTaskState> }).__cellexiaFlowTasks =
      new Map();
    const seenElsewhere = await getFlowTask("shop_1");
    expect(seenElsewhere?.state).toBe("running");
    expect(seenElsewhere?.id).toBe(started.task.id);
    const elsewhere = await startFlowTask("shop_1", "setup", { actor: "b@example.com" });
    expect(elsewhere.started).toBe(false);
    expect(elsewhere.reason).toBe("already_running");
    expect(mocks.setup).not.toHaveBeenCalled();
    (globalThis as { __cellexiaFlowTasks?: Map<string, FlowTaskState> }).__cellexiaFlowTasks =
      mine;

    job.resolve(report());
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(persistedTask()?.state).toBe("done");
    const writesAtEnd = mocks.setSetting.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.setSetting.mock.calls.length).toBe(writesAtEnd); // heartbeat stopped
  });
});

describe("orphaned run (lost its slot)", () => {
  it("a run superseded after being marked stale keeps working but never persists again — the persisted record is the newer task's", async () => {
    const jobA = deferred<SetupReport>();
    const jobB = deferred<SetupReport>();
    mocks.verify.mockImplementationOnce(async () => jobA.promise);
    mocks.verify.mockImplementationOnce(async () => jobB.promise);
    const a = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    expect(a.started).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // Force the local record stale (an event loop blocked > 90 s: no
    // heartbeat touched updatedAt — and, the same silence, no renewal kept
    // the lease alive). The status poll then reports A interrupted and a
    // new start is allowed.
    const localA = localMap().get("shop_1")!;
    localA.updatedAt = new Date(Date.now() - FLOW_TASK_STALE_MS - 1_000).toISOString();
    mocks.leases.get("klaviyo_flow_task:shop_1")!.until = Date.now() - 1;
    expect((await getFlowTask("shop_1"))?.state).toBe("failed");
    const b = await startFlowTask("shop_1", "verify", { actor: "b@example.com" });
    expect(b.started).toBe(true);
    expect(b.task.id).not.toBe(a.task.id);
    expect(persistedTask()?.id).toBe(b.task.id);

    // A finishes late: its completion must not overwrite B's record.
    const writesBefore = mocks.setSetting.mock.calls.length;
    jobA.resolve(report());
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.setSetting.mock.calls.length).toBe(writesBefore);
    expect(persistedTask()?.id).toBe(b.task.id);
    expect(persistedTask()?.state).toBe("running");
    expect((await getFlowTask("shop_1"))?.id).toBe(b.task.id);
    // A's release is owner-scoped: B's lease is untouched.
    expect(mocks.leases.get("klaviyo_flow_task:shop_1")?.owner).toBe(b.task.id);

    jobB.resolve(report());
    const done = await settled("shop_1");
    expect(done.id).toBe(b.task.id);
    expect(done.state).toBe("done");
    expect(persistedTask()?.id).toBe(b.task.id);
    expect(persistedTask()?.state).toBe("done");
  });
});

describe("write chain (updateFlowSetupSetting)", () => {
  it("a failed READ aborts the write — the stored rows, checkedAt, lastAttemptAt and setupRanAt survive a DB blip; later writes flow again", async () => {
    const stored = {
      checkedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z",
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [{ metric: "M", status: "live", flowId: "f", flowName: "F", ours: true, detail: "" }],
      task: null,
    };
    mocks.settings.set("klaviyoFlowSetup", stored);
    mocks.getSetting.mockRejectedValueOnce(new Error("P2024 pool timeout"));
    await expect(
      updateFlowSetupSetting("shop_1", (previous) => ({
        ...previous,
        task: {
          id: "t",
          kind: "verify",
          state: "running",
          startedAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
          finishedAt: null,
          step: "starting",
          message: "…",
          done: 0,
          total: 0,
          report: null,
          error: null,
        },
      })),
    ).rejects.toThrow(/P2024/);
    expect(mocks.setSetting).not.toHaveBeenCalled();
    expect(mocks.settings.get("klaviyoFlowSetup")).toEqual(stored);

    // The chain is not poisoned: the next write reads and merges normally.
    await updateFlowSetupSetting("shop_1", (previous) => ({
      ...previous,
      lastAttemptAt: "2026-08-15T10:00:00.000Z",
    }));
    const after = mocks.settings.get("klaviyoFlowSetup") as typeof stored;
    expect(after.rows).toHaveLength(1);
    expect(after.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    expect(after.checkedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(after.lastAttemptAt).toBe("2026-08-15T10:00:00.000Z");
  });

  it("a blip during a running task's persist leaves the record intact and the task keeps going", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z",
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [{ metric: "M", status: "live", flowId: "f", flowName: "F", ours: true, detail: "" }],
      task: null,
    });
    const job = deferred<SetupReport>();
    mocks.verify.mockImplementation(async () => job.promise);
    // The start persist's read fails; the task must still start and finish.
    let failed = false;
    mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
      const value = mocks.settings.get(key);
      // The first read of the WRITE chain (after getFlowTask's lenient read).
      if (!failed && mocks.acquireLock.mock.calls.length > 0) {
        failed = true;
        throw new Error("P2024 pool timeout");
      }
      return value ?? { checkedAt: null, lastAttemptAt: null, setupRanAt: null, rows: [], task: null };
    });
    const started = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    expect(started.started).toBe(true);
    expect(failed).toBe(true);
    // Not rebuilt from an empty cache: nothing was written by the failed step.
    const mid = mocks.settings.get("klaviyoFlowSetup") as { rows: unknown[]; setupRanAt: string; task: unknown };
    expect(mid.rows).toHaveLength(1);
    expect(mid.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    job.resolve(report());
    const done = await settled("shop_1");
    expect(done.state).toBe("done");
    const end = mocks.settings.get("klaviyoFlowSetup") as { rows: unknown[]; setupRanAt: string; task: { state: string } };
    expect(end.rows).toHaveLength(1);
    expect(end.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    expect(end.task.state).toBe("done"); // the final persist succeeded
  });
});

describe("stale / persisted records", () => {
  it("a persisted 'running' record older than 90 s is reported failed (interrupted) and does not block a new start", async () => {
    const stale = new Date(Date.now() - FLOW_TASK_STALE_MS - 60_000).toISOString();
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: null,
      rows: [],
      task: {
        id: "old",
        kind: "setup",
        state: "running",
        startedAt: stale,
        updatedAt: stale,
        finishedAt: null,
        step: "creating",
        message: "Creating flow 3 of 12…",
        done: 2,
        total: 12,
        report: null,
        error: null,
      },
    });
    const seen = await getFlowTask("shop_1");
    expect(seen?.state).toBe("failed");
    expect(seen?.error).toMatch(/interrupted/i);
    expect(seen?.error).toMatch(/start it again/i);

    mocks.verify.mockResolvedValue(report());
    const started = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    expect(started.started).toBe(true);
    expect(started.task.id).not.toBe("old");
    await settled("shop_1");
  });

  it("a fresh persisted 'running' record (another instance is working) blocks a new start", async () => {
    const now = new Date().toISOString();
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: null,
      lastAttemptAt: null,
      setupRanAt: null,
      rows: [],
      task: {
        id: "elsewhere",
        kind: "verify",
        state: "running",
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        step: "reading",
        message: "…",
        done: 0,
        total: 0,
        report: null,
        error: null,
      },
    });
    const result = await startFlowTask("shop_1", "setup", { actor: "a@example.com" });
    expect(result.started).toBe(false);
    expect(result.reason).toBe("already_running");
    expect(result.task.id).toBe("elsewhere");
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("persisting the task never clobbers the coverage rows stored beside it", async () => {
    mocks.settings.set("klaviyoFlowSetup", {
      checkedAt: "2026-08-01T00:00:00.000Z",
      lastAttemptAt: "2026-08-01T00:00:00.000Z",
      setupRanAt: "2026-08-01T00:00:00.000Z",
      rows: [{ metric: "M", status: "live", flowId: "f", flowName: "F", ours: true, detail: "" }],
      task: null,
    });
    mocks.verify.mockResolvedValue(report());
    await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    await settled("shop_1");
    const stored = mocks.settings.get("klaviyoFlowSetup") as {
      rows: unknown[];
      setupRanAt: string;
      task: { state: string };
    };
    expect(stored.rows).toHaveLength(1);
    expect(stored.setupRanAt).toBe("2026-08-01T00:00:00.000Z");
    expect(stored.task.state).toBe("done");
  });
});

describe("setup completion", () => {
  it("logs admin.action klaviyo_flow_setup with the actor who clicked, and passes the seed address through", async () => {
    mocks.setup.mockResolvedValue(
      report({
        seeded: ["Cellexia Gift Teaser"],
        rows: [
          { key: "a", metric: "A", name: "Cellexia — A", templates: [], why: "", status: "live", flowId: "f", flowName: "Cellexia — A", ours: true, detail: "" },
          { key: "b", metric: "B", name: "Cellexia — B", templates: [], why: "", status: "missing", flowId: "", flowName: "", ours: false, detail: "" },
        ],
      }),
    );
    const started = await startFlowTask("shop_1", "setup", {
      actor: "merchant@example.com",
      seedEmail: "owner@example.com",
    });
    expect(started.started).toBe(true);
    const done = await settled("shop_1");
    expect(done.state).toBe("done");
    expect(done.message).toContain("1 of 2");
    expect(mocks.setup).toHaveBeenCalledWith(
      "shop_1",
      "owner@example.com",
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    const event = mocks.logEvent.mock.calls[0][0] as {
      type: string;
      actor: string;
      payload: Record<string, unknown>;
    };
    expect(event.type).toBe("admin.action");
    expect(event.actor).toBe("merchant@example.com");
    expect(event.payload).toEqual({
      action: "klaviyo_flow_setup",
      live: 1,
      total: 2,
      seeded: 1,
      fatal: null,
    });
  });

  it("a fatal report finishes as 'done' carrying the fatal (the UI banners it) — still audited", async () => {
    mocks.setup.mockResolvedValue(report({ ok: false, fatal: "No Klaviyo API key is connected yet", rows: [] }));
    await startFlowTask("shop_1", "setup", { actor: "a@example.com" });
    const done = await settled("shop_1");
    expect(done.state).toBe("done");
    expect(done.report?.fatal).toContain("No Klaviyo API key");
    expect(done.message).toContain("No Klaviyo API key");
    expect((mocks.logEvent.mock.calls[0][0] as { payload: { fatal: string } }).payload.fatal).toContain(
      "No Klaviyo API key",
    );
  });
});

describe("errors", () => {
  it("a throwing job ends in state failed with the message, is persisted, and the next start is allowed", async () => {
    mocks.verify.mockRejectedValueOnce(new Error("boom"));
    await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    const failed = await settled("shop_1");
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("boom");
    expect(failed.finishedAt).toBeTruthy();
    expect(persistedTask()?.state).toBe("failed");

    mocks.verify.mockResolvedValue(report());
    const again = await startFlowTask("shop_1", "verify", { actor: "a@example.com" });
    expect(again.started).toBe(true);
    await settled("shop_1");
  });
});
