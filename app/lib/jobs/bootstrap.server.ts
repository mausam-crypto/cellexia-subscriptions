/**
 * Internal scheduler bootstrap.
 *
 * SCHEDULER_MODE=internal (default): a 60s loop inside the web process runs all
 * due jobs. Safe on single-instance hosts; JobLock rows make it safe even with
 * multiple instances (only one wins each lease).
 *
 * SCHEDULER_MODE=external: the loop is disabled; point an external cron at
 * POST /api/jobs/run with header `x-cron-secret: $CRON_SECRET` every 5 minutes.
 */

declare global {
  // eslint-disable-next-line no-var
  var __cellexiaSchedulerStarted: boolean | undefined;
}

const TICK_MS = 60_000;

export function startInternalScheduler(): void {
  if (process.env.SCHEDULER_MODE === "external") return;
  if (global.__cellexiaSchedulerStarted) return;
  global.__cellexiaSchedulerStarted = true;

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const { runAllDueJobs } = await import("~/lib/jobs/runner.server");
      await runAllDueJobs(new Date());
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, TICK_MS);
  // First tick shortly after boot, once migrations/env are certainly ready.
  setTimeout(tick, 10_000);
  console.log("[scheduler] internal scheduler started (60s tick)");
}
