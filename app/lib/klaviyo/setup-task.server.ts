import { randomUUID } from "node:crypto";

import { logEvent } from "~/lib/events/log.server";
import { acquireLock, releaseLock, renewLock } from "~/lib/jobs/runner.server";
import {
  cachedCoverageRows,
  FLOW_TASK_STALE_MS,
  isFreshRunningTask,
  readCachedCoverage,
  runGuidedSetup,
  updateFlowSetupSetting,
  verifyFlowCoverage,
  type FlowTaskRecord,
  type SetupProgress,
  type SetupReport,
} from "./flows.server";

/**
 * Background runner for the Klaviyo flow verification / guided setup
 * (v1.25.0).
 *
 * Both jobs talk to Klaviyo under its rate limits — a full setup creates
 * ~27 flows at one POST every ≥ 4.1 s — so they must not run inside a web
 * request: the old synchronous action hit request timeouts, offered no
 * progress, and needed a per-click cap with "click again in a minute".
 * Now the route STARTS a task and returns immediately; the page polls
 * `/app/emails/setup/status` every 1.5 s and renders the progress line.
 *
 * State lives in two places, deliberately:
 *  - an in-process map (`global.__cellexiaFlowTasks`, so it survives Vite
 *    HMR) — the authoritative, instantly fresh copy on the instance that
 *    runs the task;
 *  - the persisted `task` field of the `klaviyoFlowSetup` setting — written
 *    on start, throttled (≥ 1 s) during progress, by a 15 s heartbeat, and
 *    always at the end — so another instance, another tab or a reload sees
 *    it. A persisted "running" record whose updatedAt is older than 90 s
 *    can only be a task whose process died: it is reported as failed
 *    ("interrupted — start again") and no longer blocks a new start.
 *
 * One task per shop at a time (verify or setup), enforced at two levels:
 * the in-process map (fast path, race-free within one process) and a
 * per-shop DB lease (`JobLock` "klaviyo_flow_task:<shopId>", owner = task
 * id, 90 s, renewed by the heartbeat, released at the end) — the read of
 * the persisted record and the write of a new one are not atomic across
 * instances, and two concurrent setups would both list-then-create and
 * double every flow. A run that lost its map slot (a stale-marked task
 * superseded by a new start) becomes WRITE-INERT: it never persists again,
 * so it can never resurrect itself over the live task's record.
 *
 * Every failure is caught into state "failed" — a detached promise must
 * never surface as an unhandled rejection.
 */

export type FlowTaskKind = "verify" | "setup";
export type FlowTaskState = FlowTaskRecord;

export { cachedCoverageRows, FLOW_TASK_STALE_MS };

declare global {
  // eslint-disable-next-line no-var
  var __cellexiaFlowTasks: Map<string, FlowTaskState> | undefined;
}

function taskMap(): Map<string, FlowTaskState> {
  if (!global.__cellexiaFlowTasks) global.__cellexiaFlowTasks = new Map();
  return global.__cellexiaFlowTasks;
}

const PERSIST_THROTTLE_MS = 1_000;
const HEARTBEAT_MS = 15_000;
const INTERRUPTED_ERROR =
  "The previous run was interrupted (the app restarted while it was working) — start it again.";

/** DB lease name — one per shop; owner is the task id. */
export function flowTaskLeaseName(shopId: string): string {
  return `klaviyo_flow_task:${shopId}`;
}

function snapshot(task: FlowTaskState): FlowTaskState {
  return { ...task, report: task.report ? { ...task.report } : null };
}

function markIfStale(task: FlowTaskState, now: Date): FlowTaskState {
  if (task.state !== "running" || isFreshRunningTask(task, now)) return task;
  return {
    ...task,
    state: "failed",
    finishedAt: now.toISOString(),
    error: INTERRUPTED_ERROR,
  };
}

/**
 * The current (or last) task for the shop: the in-process copy when it is
 * running here, otherwise the persisted copy (another instance may be the
 * one running it) — falling back to the local finished copy.
 */
export async function getFlowTask(
  shopId: string,
  now: Date = new Date(),
): Promise<FlowTaskState | null> {
  const local = taskMap().get(shopId);
  if (local && local.state === "running") return markIfStale(snapshot(local), now);
  const persisted = (await readCachedCoverage(shopId)).task;
  if (persisted && (!local || persisted.updatedAt >= local.updatedAt)) {
    return markIfStale(persisted, now);
  }
  return local ? snapshot(local) : null;
}

async function persistTask(shopId: string, task: FlowTaskState): Promise<void> {
  const copy = snapshot(task);
  try {
    await updateFlowSetupSetting(shopId, (previous) => ({ ...previous, task: copy }));
  } catch (err) {
    console.error("[klaviyo-setup-task] task persist failed", err);
  }
}

export interface StartFlowTaskInput {
  /** Recipient of metric seed events (setup only) — a real merchant address. */
  seedEmail?: string;
  /** Admin who clicked — recorded on the audit event. */
  actor: string;
}

export interface StartFlowTaskResult {
  started: boolean;
  reason?: "already_running";
  task: FlowTaskState;
}

/**
 * Registers and starts a task, returning immediately. The work runs
 * detached; follow it with getFlowTask (or the status route).
 */
export async function startFlowTask(
  shopId: string,
  kind: FlowTaskKind,
  input: StartFlowTaskInput,
): Promise<StartFlowTaskResult> {
  const existing = await getFlowTask(shopId);
  if (existing && existing.state === "running") {
    return { started: false, reason: "already_running", task: existing };
  }
  // Re-check the in-process map with no await in between: two requests
  // (two tabs clicking within the same instant) must not both register.
  const local = taskMap().get(shopId);
  if (local && markIfStale(local, new Date()).state === "running") {
    return { started: false, reason: "already_running", task: snapshot(local) };
  }
  const nowIso = new Date().toISOString();
  const task: FlowTaskState = {
    id: randomUUID(),
    kind,
    state: "running",
    startedAt: nowIso,
    updatedAt: nowIso,
    finishedAt: null,
    step: "starting",
    message:
      kind === "setup"
        ? "Starting your flow setup…"
        : "Checking your Klaviyo flows…",
    done: 0,
    total: 0,
    report: null,
    error: null,
  };
  taskMap().set(shopId, task);
  // Cross-instance gate: the persisted record read above is not atomic
  // with the write below, so the lease decides. Held elsewhere → hand back
  // the slot and report the run that owns it.
  const leased = await acquireLock(
    flowTaskLeaseName(shopId),
    new Date(),
    task.id,
    FLOW_TASK_STALE_MS,
  );
  if (!leased) {
    if (taskMap().get(shopId) === task) taskMap().delete(shopId);
    const other = await getFlowTask(shopId);
    return {
      started: false,
      reason: "already_running",
      task:
        other && other.state === "running"
          ? other
          : {
              ...snapshot(task),
              message: "Another instance is starting this run…",
            },
    };
  }
  // Start the runner BEFORE waiting on the initial persist: its heartbeat
  // keeps updatedAt (and the lease) fresh, so a slow first upsert can never
  // make this task look interrupted. The per-shop write chain keeps the
  // start record ordered ahead of every progress write.
  const first = persistTask(shopId, task);
  void runTask(shopId, task, input);
  await first;
  return { started: true, task: snapshot(task) };
}

function summarize(report: SetupReport): string {
  if (report.fatal) return report.fatal;
  const live = report.rows.filter((r) => r.status === "live").length;
  const needsFlow = report.rows.filter(
    (r) => r.status !== "app_delivers" && r.status !== "off",
  ).length;
  return `${live} of ${needsFlow} emails are delivered by a live Klaviyo flow.`;
}

async function runTask(
  shopId: string,
  task: FlowTaskState,
  input: StartFlowTaskInput,
): Promise<void> {
  const lease = flowTaskLeaseName(shopId);
  // Ownership token: only the task registered in the map may write. A run
  // that was marked stale and superseded keeps working (nothing can stop
  // an in-flight Klaviyo call) but must never overwrite the live record.
  let orphanLogged = false;
  const owned = (): boolean => {
    if (taskMap().get(shopId) === task) return true;
    if (!orphanLogged) {
      orphanLogged = true;
      console.error(
        `[klaviyo-setup-task] ${task.kind} task ${task.id} lost its slot to a newer run — its writes are dropped`,
      );
    }
    return false;
  };
  let lastPersistAt = Date.now();
  const touch = (patch: Partial<FlowTaskState>): void => {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  };
  const persistThrottled = (force: boolean): void => {
    if (!force && Date.now() - lastPersistAt < PERSIST_THROTTLE_MS) return;
    lastPersistAt = Date.now();
    if (owned()) void persistTask(shopId, task);
  };
  // Heartbeat: long waits (a 30 s Retry-After, the 4.1 s create pacing)
  // report no progress, and a silent record would look "interrupted" to
  // other instances after 90 s — and the lease would lapse.
  const heartbeat = setInterval(() => {
    if (!owned()) {
      clearInterval(heartbeat);
      return;
    }
    touch({});
    void renewLock(lease, task.id, FLOW_TASK_STALE_MS);
    persistThrottled(true);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const onProgress = (p: SetupProgress): void => {
    touch({ step: p.step, done: p.done, total: p.total, message: p.message });
    persistThrottled(false);
  };

  try {
    let report: SetupReport;
    if (task.kind === "verify") {
      report = await verifyFlowCoverage(shopId, { onProgress });
    } else {
      report = await runGuidedSetup(shopId, input.seedEmail ?? input.actor, {
        onProgress,
      });
      const live = report.rows.filter((r) => r.status === "live").length;
      await logEvent({
        shopId,
        type: "admin.action",
        source: "ADMIN",
        actor: input.actor,
        payload: {
          action: "klaviyo_flow_setup",
          live,
          total: report.rows.length,
          seeded: report.seeded.length,
          fatal: report.fatal ?? null,
        },
      });
    }
    touch({
      state: "done",
      finishedAt: new Date().toISOString(),
      step: "done",
      message: summarize(report),
      report,
    });
  } catch (err) {
    console.error(`[klaviyo-setup-task] ${task.kind} failed`, err);
    touch({
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearInterval(heartbeat);
    if (owned()) await persistTask(shopId, task);
    // Owner-scoped: a lease reclaimed by a newer run is left untouched.
    await releaseLock(lease, task.id);
  }
}
