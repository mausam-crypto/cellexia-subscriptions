import { randomUUID } from "node:crypto";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { addDaysTz } from "~/lib/dates.server";

/**
 * Job registry + runner.
 *
 * Cadences are minutes between runs; the caller (60s internal tick from
 * bootstrap.server.ts, or an external cron POSTing /api/jobs/run) invokes
 * `runAllDueJobs` as often as it likes — due-checking makes extra invocations
 * free, JobLock leases make concurrent invocations safe (multi-instance
 * hosts included: only one owner wins each lease), and JobRun rows are the
 * audit trail the health endpoint and the BILLING_RUN_FAILED alert read.
 *
 * Every job body is lazily imported so this module never drags the whole app
 * graph in, and every job is individually try/caught — one failing job can
 * never stop billing.
 */

type JobFn = (now: Date) => Promise<unknown>;

/** Loose signature for cross-module sweeps whose exact typing lives elsewhere. */
type SweepFn = (now: Date) => Promise<unknown>;

interface JobDef {
  name: string;
  everyMinutes: number;
  /**
   * Customer-facing job gated by launch mode: while the shop is in SETUP the
   * runner records a SUCCESS JobRun with stats {skipped:"setup_mode"} without
   * executing — installing the app must never charge, notify or touch a
   * customer until the merchant explicitly goes live. Analytics, alerts and
   * outbox/sweep plumbing stay ungated.
   */
  gatedInSetup?: boolean;
  fn: JobFn;
}

const LOCK_LEASE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

// ── Inline job: 90-day retention outcome for saved cancels ───────────────────

/**
 * CancelSessions saved ~90 days ago get their retention verdict: was the save
 * real (contract still ACTIVE/PAUSED) or just a delayed churn? Feeds the
 * cancel-flow analytics ("saves that stick" is the metric that matters).
 */
async function runRetention90d(now: Date): Promise<unknown> {
  const cutoff = new Date(now.getTime() - 90 * DAY_MS);
  const sessions = await prisma.cancelSession.findMany({
    where: {
      outcome: "SAVED",
      retainedAt90d: null,
      completedAt: { lte: cutoff },
    },
    select: { id: true, contractId: true },
    take: 500,
  });

  let retained = 0;
  for (const session of sessions) {
    const contract = await prisma.subscriptionContract.findUnique({
      where: { id: session.contractId },
      select: { status: true },
    });
    const isRetained =
      contract?.status === "ACTIVE" || contract?.status === "PAUSED";
    await prisma.cancelSession.update({
      where: { id: session.id },
      data: { retainedAt90d: isRetained },
    });
    if (isRetained) retained += 1;
  }

  return { evaluated: sessions.length, retained };
}

// ── Registry ─────────────────────────────────────────────────────────────────

const registry: JobDef[] = [
  {
    name: "billing_run",
    gatedInSetup: true,
    everyMinutes: 5,
    fn: async (now) => {
      const { runBillingSweep } = await import("~/lib/billing/scheduler.server");
      return runBillingSweep(now);
    },
  },
  {
    name: "stale_attempt_sweep",
    everyMinutes: 30,
    fn: async () => {
      const { sweepStalePendingAttempts } = await import(
        "~/lib/billing/scheduler.server"
      );
      return sweepStalePendingAttempts();
    },
  },
  {
    name: "dunning_run",
    gatedInSetup: true,
    everyMinutes: 10,
    fn: async (now) => {
      const m = await import("~/lib/dunning/engine.server");
      return (m.runDunningSweep as unknown as SweepFn)(now);
    },
  },
  {
    name: "reminders_run",
    gatedInSetup: true,
    everyMinutes: 60,
    fn: async (now) => {
      const { runUpcomingOrderReminders } = await import(
        "~/lib/billing/reminders.server"
      );
      return runUpcomingOrderReminders(now);
    },
  },
  {
    name: "pause_autoresume",
    gatedInSetup: true,
    everyMinutes: 60,
    fn: async (now) => {
      const { runPauseAutoResume } = await import(
        "~/lib/billing/reminders.server"
      );
      return runPauseAutoResume(now);
    },
  },
  {
    name: "gifts_run",
    gatedInSetup: true,
    everyMinutes: 1440,
    fn: async (now) => {
      const m = await import("~/lib/gifts/engine.server");
      return (m.runGiftScheduling as unknown as SweepFn)(now);
    },
  },
  {
    name: "lifecycle_run",
    gatedInSetup: true,
    everyMinutes: 1440,
    fn: async (now) => {
      const m = await import("~/lib/lifecycle/engine.server");
      return (m.runLifecycleSweep as unknown as SweepFn)(now);
    },
  },
  {
    name: "winback_run",
    gatedInSetup: true,
    everyMinutes: 60,
    fn: async (now) => {
      const m = await import("~/lib/winback/engine.server");
      return (m.runWinbackSweep as unknown as SweepFn)(now);
    },
  },
  {
    name: "consolidation_run",
    gatedInSetup: true,
    everyMinutes: 1440,
    fn: async () => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { runAutoConsolidation } = await import(
        "~/lib/contracts/consolidation.server"
      );
      return runAutoConsolidation(shop.id);
    },
  },
  {
    name: "pre_expiry_notices",
    gatedInSetup: true,
    everyMinutes: 1440,
    fn: async (now) => {
      const m = await import("~/lib/dunning/engine.server");
      return (m.runPreExpiryNotices as unknown as SweepFn)(now);
    },
  },
  {
    name: "rollup_run",
    everyMinutes: 1440,
    fn: async (now) => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { runDailyRollup } = await import("~/lib/analytics/rollup.server");
      // Yesterday first (closes the finished day), then today-so-far; the
      // upsert on (shopId, date) makes both idempotent.
      const yesterday = addDaysTz(now, -1, shop.ianaTimezone);
      await runDailyRollup(shop.id, yesterday);
      await runDailyRollup(shop.id, now);
      return { days: 2 };
    },
  },
  {
    name: "cohort_run",
    everyMinutes: 1440,
    fn: async (now) => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { runCohortComputation } = await import(
        "~/lib/analytics/cohorts.server"
      );
      return runCohortComputation(shop.id, now);
    },
  },
  {
    name: "churn_risk_run",
    everyMinutes: 1440,
    fn: async (now) => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { runChurnRiskScoring, runPredictedEmptyDates } = await import(
        "~/lib/analytics/risk.server"
      );
      const risk = await runChurnRiskScoring(shop.id, now);
      const emptyDates = await runPredictedEmptyDates(shop.id, now);
      return { risk, emptyDates };
    },
  },
  {
    name: "retention_90d_run",
    everyMinutes: 1440,
    fn: (now) => runRetention90d(now),
  },
  {
    name: "klaviyo_flush",
    everyMinutes: 1,
    fn: async () => {
      const { flushKlaviyoOutbox } = await import("~/lib/klaviyo/outbox.server");
      return flushKlaviyoOutbox();
    },
  },
  {
    name: "alerts_run",
    everyMinutes: 15,
    fn: async (now) => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };

      // Feed the STOCKOUT_RENEWALS check with live availability for every
      // variant renewing in the next week; the scan skips that check when the
      // map is absent, so an availability fetch failure only narrows the scan.
      let variantAvailability: Map<string, boolean> | undefined;
      try {
        const horizon = new Date(now.getTime() + 7 * DAY_MS);
        const lines = await prisma.contractLine.findMany({
          where: {
            isGift: false,
            contract: {
              shopId: shop.id,
              status: "ACTIVE",
              nextBillingDate: { not: null, lte: horizon },
            },
          },
          select: { variantId: true },
          distinct: ["variantId"],
        });
        const variantIds = lines.map((l) => l.variantId).filter(Boolean);
        if (variantIds.length > 0) {
          const admin = await adminClientForShop(shop.domain);
          const { getVariants } = await import("~/lib/graphql/products.server");
          const variants = await getVariants(admin, variantIds);
          variantAvailability = new Map(
            variants.map((v) => [v.id, v.availableForSale]),
          );
        }
      } catch (err) {
        console.error("[jobs] variant availability fetch failed", err);
      }

      const { runAlertScan } = await import("~/lib/analytics/alerts.server");
      return runAlertScan(shop.id, { now, variantAvailability });
    },
  },
];

/** Registered job names, in run order (health endpoint reads this). */
export const JOB_NAMES: readonly string[] = registry.map((job) => job.name);

/** Job names the SETUP launch gate skips (launch checklist + tests read this). */
export const SETUP_GATED_JOB_NAMES: readonly string[] = registry
  .filter((job) => job.gatedInSetup)
  .map((job) => job.name);

// ── Lease + run machinery ────────────────────────────────────────────────────

async function isDue(job: JobDef, now: Date): Promise<boolean> {
  const last = await prisma.jobRun.findFirst({
    where: { jobName: job.name },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  if (!last) return true;
  return now.getTime() - last.startedAt.getTime() >= job.everyMinutes * 60_000;
}

async function acquireLock(
  name: string,
  now: Date,
  owner: string,
): Promise<boolean> {
  const lease = new Date(now.getTime() + LOCK_LEASE_MS);

  const claimed = await prisma.jobLock.updateMany({
    where: { name, lockedUntil: { lt: now } },
    data: { lockedUntil: lease, owner },
  });
  if (claimed.count > 0) return true;

  const existing = await prisma.jobLock.findUnique({ where: { name } });
  if (existing) return false; // live lease held by another owner

  try {
    await prisma.jobLock.create({ data: { name, lockedUntil: lease, owner } });
    return true;
  } catch {
    return false; // lost the create race
  }
}

async function releaseLock(name: string, owner: string): Promise<void> {
  try {
    // Only the current owner releases; an expired-and-reclaimed lease stays.
    await prisma.jobLock.updateMany({
      where: { name, owner },
      data: { lockedUntil: new Date(0) },
    });
  } catch (err) {
    console.error(`[jobs] lock release failed for ${name}`, err);
  }
}

/** JSON-safe copy of a job's returned stats; undefined for void/unserializable. */
function sanitizeStats(result: unknown): object | undefined {
  if (result == null || typeof result !== "object") return undefined;
  try {
    return JSON.parse(JSON.stringify(result)) as object;
  } catch {
    return undefined;
  }
}

async function runJob(job: JobDef, now: Date, setupMode: boolean): Promise<void> {
  if (!(await isDue(job, now))) return;

  const owner = randomUUID();
  if (!(await acquireLock(job.name, now, owner))) return;

  let runId: string | null = null;
  try {
    // Re-check under the lock: another instance may have started this job
    // between our due-check and the lease.
    if (!(await isDue(job, now))) return;

    const run = await prisma.jobRun.create({
      data: { jobName: job.name, status: "RUNNING", startedAt: now },
    });
    runId = run.id;

    // SETUP gate: record the run (health/audit contract intact) but never
    // execute a customer-facing job before the merchant goes live.
    const result =
      setupMode && job.gatedInSetup
        ? { skipped: "setup_mode" }
        : await job.fn(now);

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        stats: sanitizeStats(result),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] ${job.name} failed`, err);
    if (runId) {
      await prisma.jobRun
        .update({
          where: { id: runId },
          data: { status: "FAILED", finishedAt: new Date(), error: message },
        })
        .catch((updateErr) =>
          console.error(`[jobs] JobRun finalize failed for ${job.name}`, updateErr),
        );
    }
  } finally {
    await releaseLock(job.name, owner);
  }
}

/**
 * Run every due job, sequentially in registry order (billing first). Never
 * throws: each job is contained, so the scheduler tick / cron endpoint always
 * completes.
 */
export async function runAllDueJobs(now: Date): Promise<void> {
  // Launch mode resolved once per tick. No shop (or a failed read) is treated
  // as SETUP — when in doubt, stay dark: gated jobs skip, ungated jobs run.
  let setupMode = true;
  try {
    const shop = await getPrimaryShop();
    if (shop) {
      const { isSetupMode } = await import("~/lib/launch/launch.server");
      setupMode = await isSetupMode(shop.id);
    }
  } catch (err) {
    console.error("[jobs] launch mode resolution failed; assuming SETUP", err);
  }

  for (const job of registry) {
    try {
      await runJob(job, now, setupMode);
    } catch (err) {
      // runJob already contains job errors; this guards the machinery itself.
      console.error(`[jobs] runner machinery failed for ${job.name}`, err);
    }
  }
}
