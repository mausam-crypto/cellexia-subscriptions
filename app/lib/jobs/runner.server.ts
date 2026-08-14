import { randomUUID } from "node:crypto";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { addDaysTz } from "~/lib/dates.server";
import { getSetting } from "~/lib/settings/settings.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";

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

/** Exported for the self-check's wedged-lock detection — a JobLock whose
 * lease reaches further into the future than this module could ever have set
 * it can never be reclaimed by acquireLock. */
export const LOCK_LEASE_MS = 10 * 60_000;
/**
 * While a job body runs, its lease is re-extended on this heartbeat. Without
 * renewal, any job that outlives LOCK_LEASE_MS (a launch-scale billing sweep,
 * a 90-day rollup backfill) is GUARANTEED a second concurrent runner once its
 * lease lapses — turning every find-then-act in the sweeps into a live race
 * (duplicate dunning emails, double ladder increments). Half the lease keeps
 * one missed beat from losing the lock.
 */
const LOCK_RENEW_MS = LOCK_LEASE_MS / 2;
const DAY_MS = 86_400_000;

/**
 * A FAILED run is retried after this many minutes instead of waiting out the
 * job's full cadence — a daily job (rollup, cohorts) whose last run failed
 * must not leave a 24h hole before the next attempt. Jobs whose cadence is
 * already shorter than this keep their own cadence.
 */
const FAILED_RETRY_MINUTES = 30;

/**
 * How far back rollup_run scans for missing DailyRollup days. Interior gaps
 * happen when the job is down for 2+ days: on resume, the trailing recompute
 * closes only the most recent days and everything older stayed permanently
 * missing. Days older than ROLLUP_RECOMPUTE_DAYS that already have a row are
 * NOT recomputed (closed days keep their historical snapshots); only absent
 * days are filled, and never from before the shop's first rollup ever ran.
 * Backfilled days are written with `backfill: true`: flow columns (charged,
 * new subscribers, churn) recompute from source exactly as a live run would,
 * but the SNAPSHOT columns (activeSubscribers, mrrCents, …) are unknowable
 * after the fact — a live count at backfill time would stamp the whole gap
 * flat with post-outage values and the forecast would train on fabricated
 * history as if observed. They stay zero with `snapshotFabricated = true`,
 * and the forecast treats fabricated days as carry-forward-filled, annotated
 * in its accuracy reasons, not as observations.
 */
const ROLLUP_BACKFILL_MAX_DAYS = 90;

/**
 * Trailing window (in days before today) rollup_run re-upserts on EVERY run,
 * whether or not the rows exist. A charge can settle with a completedAt
 * earlier than its webhook's arrival (the success path backdates to the
 * order's createdAt — see MAX_CHARGE_BACKDATE_MS in handlers/scheduler): with
 * backdating capped at 24h and up to 24h until the next rollup tick, the
 * charge's true day is at most 2 days old when recomputed, so it is never
 * stranded in a closed row. Snapshot-style metrics (activeSubscribers, MRR)
 * re-snapshot at recompute time — the same semantics "yesterday" always had,
 * now extending at most one day further back.
 */
const ROLLUP_RECOMPUTE_DAYS = 2;

/**
 * Refund-repair pass (v1.16.0, active only while
 * analytics.excludeRefundedPayments is on): repair candidates derive from
 * STATE (payments whose refundedCents > 0 with a charge day inside the
 * standing ROLLUP_BACKFILL_MAX_DAYS window — see
 * repairRefundAffectedRollupDays in rollup.server.ts), run oldest-first and
 * idempotently every night, so progress can never be starved by an event
 * window aging out. The cap equals the window size — it can only bind when
 * literally every day in the window holds a refunded payment, and even then
 * the same set re-runs next night (no lost days).
 */
const ROLLUP_REFUND_REPAIR_MAX_DAYS = ROLLUP_BACKFILL_MAX_DAYS;

// ── Inline job: 90-day retention outcome for saved cancels ───────────────────

/**
 * CancelSessions saved ~90 days ago get their retention verdict: was the save
 * real (still subscribed at day 90) or just a delayed churn? Feeds the
 * cancel-flow analytics ("saves that stick" is the metric that matters).
 *
 * The verdict is AS OF completedAt+90d, derived from the contract's status
 * timestamps — NOT the status at evaluation time. The query has no upper
 * completedAt bound and drains backlogs 500 at a time, so a session can be
 * evaluated at day 90+N (job downtime, or old sessions present when the job
 * first shipped); reading today's status there would label a subscriber who
 * was retained at day 90 but churned at day 150 as a failed save. A terminal
 * timestamp (cancelledAt / failedAt / expiredAt) at or before day 90 means
 * the save did not stick; none means the contract was still ACTIVE or PAUSED
 * at day 90. Known approximation: reactivation clears cancelledAt
 * (winback/engine + contract sync transitions), so a churn-inside-90-days
 * that was later won back reads as retained — the same answer the old
 * status-at-evaluation read gave, so no label gets worse. Sessions already
 * labeled are NOT backfilled: the cleared-timestamp ambiguity makes old
 * labels unrecoverable in exactly the cases that would need correcting.
 *
 * Exported for tests — the as-of-day-90 derivation is the regression surface.
 */
export async function runRetention90d(now: Date): Promise<unknown> {
  const cutoff = new Date(now.getTime() - 90 * DAY_MS);
  const sessions = await prisma.cancelSession.findMany({
    where: {
      outcome: "SAVED",
      retainedAt90d: null,
      completedAt: { lte: cutoff },
    },
    select: { id: true, contractId: true, completedAt: true },
    take: 500,
  });

  let retained = 0;
  for (const session of sessions) {
    const contract = await prisma.subscriptionContract.findUnique({
      where: { id: session.contractId },
      select: { cancelledAt: true, failedAt: true, expiredAt: true },
    });
    // completedAt is non-null by the query filter; a deleted contract (demo
    // reset is the only deleter) is not a retained subscriber.
    const day90 = new Date(
      (session.completedAt?.getTime() ?? now.getTime()) + 90 * DAY_MS,
    );
    const churnedBy90 =
      contract == null ||
      [contract.cancelledAt, contract.failedAt, contract.expiredAt].some(
        (ts) => ts != null && ts.getTime() <= day90.getTime(),
      );
    const isRetained = !churnedBy90;
    await prisma.cancelSession.update({
      where: { id: session.id },
      data: { retainedAt90d: isRetained },
    });
    if (isRetained) retained += 1;
  }

  return { evaluated: sessions.length, retained };
}

// ── Inline job: per-step containment for multi-recorder jobs ─────────────────

/**
 * Run a job's independent sub-steps so one failing step cannot starve the
 * others (the between-modules half of "analytics failures are contained" —
 * each module contains its own internals, but a job that chains two
 * independent recorders with a bare `await` lets a DETERMINISTIC failure in
 * the first permanently suppress the second: it fails identically on every
 * 30-minute FAILED retry, and e.g. a forecast-accuracy week that never
 * records is a hole that can never be measured after the fact). Every step
 * runs; if any failed, the job still surfaces as FAILED (so the retry leash
 * and the BILLING_RUN_FAILED-style JobRun audit trail stay honest) with an
 * error naming each failed step AND what completed — a retry re-runs the
 * completed steps too, which is safe: all of them are idempotent recomputes.
 *
 * Exported for tests — the "second step runs after the first throws"
 * guarantee is the regression surface.
 */
export async function runStepsContained(
  steps: ReadonlyArray<readonly [name: string, step: () => Promise<unknown>]>,
): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  const failed: Array<{ name: string; message: string }> = [];
  for (const [name, step] of steps) {
    try {
      results[name] = await step();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[jobs] contained step "${name}" failed`, err);
      failed.push({ name, message });
    }
  }
  if (failed.length > 0) {
    const completed = steps
      .map(([name]) => name)
      .filter((name) => !failed.some((f) => f.name === name));
    throw new Error(
      failed.map((f) => `${f.name}: ${f.message}`).join("; ") +
        (completed.length > 0 ? ` (completed: ${completed.join(", ")})` : ""),
    );
  }
  return results;
}

// ── Inline job: daily rollup recompute + gap backfill ────────────────────────

/**
 * rollup_run body. Exported for tests — the backfill honesty contract (gap
 * days are written with `backfill: true`, see ROLLUP_BACKFILL_MAX_DAYS above)
 * and the trailing-recompute window are the regression surface.
 */
export async function runRollupJob(now: Date): Promise<unknown> {
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };
  const tz = shop.ianaTimezone;
  const { runDailyRollup } = await import("~/lib/analytics/rollup.server");
  const { shopDayLabelUtc, utcDayKey } = await import(
    "~/lib/analytics/queries.server"
  );

  // ── Self-heal: backfill days the job missed entirely ──────────────────────
  // A multi-day outage leaves interior gaps ("yesterday + today" on resume
  // only closes the most recent day). Fill any day label absent from
  // DailyRollup within the lookback window — but never before the shop's
  // first rollup (no synthesized pre-analytics history), and never a day
  // that already has a row (closed days keep their historical snapshots).
  // backfill:true keeps the synthesized rows honest: flow columns recompute
  // from source, snapshot columns are NOT stamped with post-outage live
  // counts (they are unknowable for a past day) — the row carries
  // snapshotFabricated instead so the forecast can carry forward and
  // annotate rather than train on fabricated history.
  let backfilled = 0;
  const oldest = await prisma.dailyRollup.findFirst({
    where: { shopId: shop.id },
    orderBy: { date: "asc" },
    select: { date: true },
  });
  if (oldest) {
    const windowStartLabel = shopDayLabelUtc(
      addDaysTz(now, -ROLLUP_BACKFILL_MAX_DAYS, tz),
      tz,
    );
    const existing = await prisma.dailyRollup.findMany({
      where: { shopId: shop.id, date: { gte: windowStartLabel } },
      select: { date: true },
    });
    const have = new Set(existing.map((row) => utcDayKey(row.date)));
    const oldestKey = utcDayKey(oldest.date);
    // Oldest-first so a crash mid-backfill leaves a shrinking gap, not a
    // moving one; days inside the trailing recompute window run below
    // unconditionally, so the backfill starts just beyond it.
    for (
      let daysAgo = ROLLUP_BACKFILL_MAX_DAYS;
      daysAgo > ROLLUP_RECOMPUTE_DAYS;
      daysAgo--
    ) {
      const day = addDaysTz(now, -daysAgo, tz);
      const key = utcDayKey(shopDayLabelUtc(day, tz));
      if (key <= oldestKey || have.has(key)) continue;
      await runDailyRollup(shop.id, day, { backfill: true });
      backfilled += 1;
    }
  }

  // Trailing recompute: oldest day first, today-so-far last; the upsert
  // on (shopId, date) makes every pass idempotent. Re-upserting the last
  // ROLLUP_RECOMPUTE_DAYS closed days picks up charges whose completedAt
  // was backdated to the order's real charge instant by a late webhook or
  // the stale sweep (see ROLLUP_RECOMPUTE_DAYS above). These are LIVE runs
  // (never backfill): within the trailing window a re-snapshot is the same
  // semantics "yesterday" always had.
  for (let daysAgo = ROLLUP_RECOMPUTE_DAYS; daysAgo >= 0; daysAgo--) {
    await runDailyRollup(shop.id, addDaysTz(now, -daysAgo, tz));
  }

  // ── Refund repair (v1.16.0, only under analytics.excludeRefundedPayments) ─
  // A refund usually lands days after its charge, i.e. after the charge's
  // rollup day left the trailing window. Excluding the payment then requires
  // re-upserting its CHARGE day; backfill mode confines the re-upsert to the
  // flow columns, so the closed day's snapshots survive (the same
  // flow-columns-only repair the firstChargeAt backfill uses). Candidates
  // derive from refund STATE inside the standing backfill window — see
  // repairRefundAffectedRollupDays — so runs are idempotent and no day can
  // be starved out. Gated on the setting: with exclusion off, closed days
  // are never rewritten — byte-identical to pre-v1.16.0 behavior (a TOGGLE
  // of the setting runs its own full-history repair from the settings save).
  let repairedDays = 0;
  const { excludeRefundedPayments } = await getSetting(shop.id, "analytics");
  // `oldest` gates repair like it gates the gap backfill: no rollup history
  // yet (first run ever) means there is no closed charge day to repair, and
  // synthesizing pre-analytics days would break the standing backfill rule.
  if (excludeRefundedPayments && oldest) {
    const { shopDayStartUtc } = await import("~/lib/dates.server");
    const { repairRefundAffectedRollupDays } = await import(
      "~/lib/analytics/rollup.server"
    );
    repairedDays = await repairRefundAffectedRollupDays(shop.id, {
      since: addDaysTz(now, -ROLLUP_BACKFILL_MAX_DAYS, tz),
      // The trailing window was recomputed live just above — skip it.
      skipAfter: shopDayStartUtc(addDaysTz(now, -ROLLUP_RECOMPUTE_DAYS, tz), tz),
      cap: ROLLUP_REFUND_REPAIR_MAX_DAYS,
    });
  }

  return {
    days: ROLLUP_RECOMPUTE_DAYS + 1 + backfilled + repairedDays,
    backfilled,
    repairedDays,
  };
}

// ── Inline jobs: nightly analytics recorder pairs ────────────────────────────

/**
 * risk_learning_run body: rebuild churn snapshots from history, train /
 * evaluate the risk model (promotion only on a proven holdout win — see
 * learning.server.ts), and persist this week's per-model forecast holdout
 * error. Two INDEPENDENT recorders on one tick, so each runs step-contained:
 * a deterministic trainer failure must not starve forecast-accuracy
 * recording — a week recordForecastAccuracyWeek never records is a permanent
 * hole in forecastModelHistory, unmeasurable after the fact — nor vice
 * versa. Exported for tests — that containment is the regression surface.
 */
export async function runRiskLearningJob(now: Date): Promise<unknown> {
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };
  const { runRiskLearning } = await import("~/lib/analytics/learning.server");
  const { recordForecastAccuracyWeek } = await import(
    "~/lib/analytics/forecast.server"
  );
  return runStepsContained([
    ["learning", () => runRiskLearning(shop.id, now)],
    ["forecastHistory", () => recordForecastAccuracyWeek(shop.id, now)],
  ]);
}

/**
 * churn_risk_run body: risk scores, then predicted empty dates. Same
 * step containment as risk_learning_run — a scoring failure must not freeze
 * predictedEmptyDate (win-back timing would silently go stale, with no alert
 * tied to the starved step). Exported for tests.
 */
export async function runChurnRiskJob(now: Date): Promise<unknown> {
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };
  const { runChurnRiskScoring, runPredictedEmptyDates } = await import(
    "~/lib/analytics/risk.server"
  );
  return runStepsContained([
    ["risk", () => runChurnRiskScoring(shop.id, now)],
    ["emptyDates", () => runPredictedEmptyDates(shop.id, now)],
  ]);
}

/**
 * survey_link_sweep body: links straggler SurveyResponse rows to their
 * contract mirror and flushes stale partial-answer emissions. Ungated:
 * derives internal state, and the Klaviyo enqueue it can trigger is already
 * suppressed at source in setup mode. Exported for tests.
 */
export async function runSurveyLinkJob(now: Date): Promise<unknown> {
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };
  const { runSurveyLinkSweep } = await import("~/lib/survey/service.server");
  return runSurveyLinkSweep(shop.id, now);
}

/**
 * predicted_ltgp_run body: per-contract predicted LTGP (nightly, after
 * churn_risk_run so the tilt reads fresh risk scores), then the accuracy
 * pass comparing matured actuals against frozen day-one predictions. Step
 * containment so a scoring failure cannot starve the accuracy ledger.
 * Exported for tests.
 */
export async function runPredictedLtgpJob(now: Date): Promise<unknown> {
  const shop = await getPrimaryShop();
  if (!shop) return { skipped: "no_shop" };
  const { runPredictedLtgpScoring, runLtgpAccuracy } = await import(
    "~/lib/analytics/predicted-ltgp.server"
  );
  return runStepsContained([
    ["scoring", () => runPredictedLtgpScoring(shop.id, now)],
    ["accuracy", () => runLtgpAccuracy(shop.id, now)],
  ]);
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
    // Re-drives half-settled attempts whose webhook retry train is dead: a
    // handler that THREW was answered 200 (which permanently ends Shopify's
    // redelivery for that id), so SUCCESS+settledAt-NULL tails and
    // FAILED+declineCategory-NULL failure processing would otherwise stay
    // broken forever (zombie dunning cases emailing PAID customers, cycles
    // held hostage by an OPEN case). Ungated like stale_attempt_sweep: it is
    // recovery plumbing, and in SETUP there are no billed attempts to redrive.
    name: "settlement_redrive",
    everyMinutes: 15,
    fn: async (now) => {
      const { sweepUnsettledAttempts } = await import(
        "~/lib/billing/scheduler.server"
      );
      return sweepUnsettledAttempts(now);
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
    name: "cancel_session_gc",
    everyMinutes: 60,
    fn: async (now) => {
      // Closes walked-away cancel flows as ABANDONED and emits the terminal
      // cancel.aborted event (internal hygiene — no customer contact).
      const { closeStaleCancelSessions } = await import(
        "~/lib/cancel/engine.server"
      );
      return closeStaleCancelSessions(now);
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
    fn: (now) => runRollupJob(now),
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
    // Self-improving analytics: rebuild churn snapshots from history, train /
    // evaluate the risk model (promotion only on a proven holdout win — see
    // learning.server.ts), and persist this week's per-model forecast
    // backtest errors. Runs BEFORE churn_risk_run so the same nightly tick
    // scores with the freshest promoted model. Ungated: derives analytics
    // state, touches no customer.
    name: "risk_learning_run",
    everyMinutes: 1440,
    fn: (now) => runRiskLearningJob(now),
  },
  {
    name: "churn_risk_run",
    everyMinutes: 1440,
    fn: (now) => runChurnRiskJob(now),
  },
  {
    // AFTER churn_risk_run (registry position = run order): the LTGP tilt
    // reads the risk scores that job just refreshed. Ungated: derives
    // analytics state, touches no customer.
    name: "predicted_ltgp_run",
    everyMinutes: 1440,
    fn: (now) => runPredictedLtgpJob(now),
  },
  {
    // Straggler survey→contract links + stale partial-answer emissions.
    // Ungated: internal state; Klaviyo is suppressed at source in setup mode.
    name: "survey_link_sweep",
    everyMinutes: 1440,
    fn: (now) => runSurveyLinkJob(now),
  },
  {
    name: "retention_90d_run",
    everyMinutes: 1440,
    fn: (now) => runRetention90d(now),
  },
  {
    // Origin (checkout) payment capture for OURS contracts still missing the
    // money mirror (pre-0006 rows, failed capture-at-sync fetches, contracts
    // classified OURS after create). Read-only against Shopify, capped at 200
    // contracts per run, oldest first. Ungated: analytics data capture, not a
    // customer-facing action — like the rollup/cohort jobs it feeds.
    name: "origin_order_backfill",
    everyMinutes: 1440,
    fn: async () => {
      const { runOriginOrderBackfill } = await import(
        "~/lib/contracts/sync.server"
      );
      return runOriginOrderBackfill();
    },
  },
  {
    // Re-attempts the refund matches the REFUNDS_CREATE handler had to give
    // up on: a refund can arrive before its attempt/origin mirror exists
    // (webhook race, pre-import history), and the unmatched-refund guard
    // event was previously a dead letter — logged once, never revisited, the
    // refund permanently missing from netting. Read-only against Shopify;
    // rewrites nothing that already matched. Ungated like the other recovery
    // plumbing: it only completes already-recorded money data.
    name: "refund_reconcile",
    everyMinutes: 1440,
    fn: async () => {
      const { reconcileUnmatchedRefunds } = await import(
        "~/lib/webhooks/handlers.server"
      );
      return reconcileUnmatchedRefunds();
    },
  },
  {
    // Full contract-mirror reconciliation: re-syncs every contract from
    // Shopify (paged 100 at a time) so a webhook the app never received —
    // delivery disabled, extended downtime past Shopify's ~48h retry horizon
    // — cannot leave a mirror row drifted forever. Ungated in SETUP like
    // origin_order_backfill: mirror-only reads + local upserts, no customer
    // contact, and a store being set up is exactly where drift accumulates.
    name: "full_sync_reconcile",
    everyMinutes: 1440,
    fn: async () => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { backfillAllContracts } = await import(
        "~/lib/contracts/sync.server"
      );
      const result = await backfillAllContracts(shop.domain);
      // JobRun.stats is an audit row, not an error archive — cap the
      // per-contract error list the way alert contexts cap their samples.
      return { ...result, errors: result.errors.slice(0, 20) };
    },
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

      const variantAvailability = await collectRenewalVariantAvailability(
        { id: shop.id, domain: shop.domain },
        now,
      );

      const { runAlertScan } = await import("~/lib/analytics/alerts.server");
      return runAlertScan(shop.id, { now, variantAvailability });
    },
  },
  {
    // Live self-check behind the admin Debug tab: probes the deployed store
    // end-to-end (billing pipeline, dunning, portal-through-proxy, webhooks,
    // jobs, Klaviyo, config/secrets, data integrity), persists the report and
    // keeps the SELF_CHECK_FAILED alert in sync. Ungated: it only READS —
    // catching a dead proxy or a drifted secret BEFORE go-live is its job.
    name: "selfcheck_run",
    everyMinutes: 30,
    fn: async () => {
      const shop = await getPrimaryShop();
      if (!shop) return { skipped: "no_shop" };
      const { runSelfCheck } = await import("~/lib/debug/selfcheck.server");
      const report = await runSelfCheck(shop.domain, { trigger: "job" });
      return {
        verdict: report.verdict,
        pass: report.passCount,
        warn: report.warnCount,
        fail: report.failCount,
      };
    },
  },
];

/**
 * Variant availability for every variant renewing within the STOCKOUT
 * lookahead — the feed for runAlertScan's STOCKOUT_RENEWALS check. The scan
 * skips that check when the map is absent (it never guesses availability),
 * so a fetch failure only narrows the scan.
 *
 * Scoped to isDemo:false + OURS_ONLY, and this is load-bearing, not hygiene:
 * a demo preview contract created before the first plan sync stores
 * placeholder lines whose variantId is a fake `gid://cellexia/demo/variant/…`
 * GID (portal/demo.server.ts), is ACTIVE with a static nextBillingDate that
 * is never advanced, and is reused forever. Once that date enters the
 * horizon, a single such id in the getVariants batch makes Shopify's
 * nodes(ids:) reject the WHOLE query ("invalid id" is a top-level GraphQL
 * error), the catch below blanks the map, and STOCKOUT_RENEWALS silently
 * never runs again for the life of the demo row. Foreign/unknown contracts
 * are excluded for the usual reason: they are never ours to alert on.
 * (getVariants also drops non-`gid://shopify/` ids as defence in depth.)
 *
 * Exported for tests — the query scoping IS the regression surface.
 */
export async function collectRenewalVariantAvailability(
  shop: { id: string; domain: string },
  now: Date,
): Promise<Map<string, boolean> | undefined> {
  try {
    const horizon = new Date(now.getTime() + 7 * DAY_MS);
    const lines = await prisma.contractLine.findMany({
      where: {
        isGift: false,
        contract: {
          shopId: shop.id,
          status: "ACTIVE",
          isDemo: false,
          ...OURS_ONLY,
          nextBillingDate: { not: null, lte: horizon },
        },
      },
      select: { variantId: true },
      distinct: ["variantId"],
    });
    const variantIds = lines.map((l) => l.variantId).filter(Boolean);
    if (variantIds.length === 0) return undefined;
    const admin = await adminClientForShop(shop.domain);
    const { getVariants } = await import("~/lib/graphql/products.server");
    const variants = await getVariants(admin, variantIds);
    return new Map(variants.map((v) => [v.id, v.availableForSale]));
  } catch (err) {
    console.error("[jobs] variant availability fetch failed", err);
    return undefined;
  }
}

/** Registered job names, in run order (health endpoint reads this). */
export const JOB_NAMES: readonly string[] = registry.map((job) => job.name);

/** Name + cadence + gate of every job, in run order — the self-check reads
 * this to judge per-job freshness without duplicating the registry. */
export const JOB_SCHEDULE: ReadonlyArray<{
  name: string;
  everyMinutes: number;
  gatedInSetup: boolean;
}> = registry.map((job) => ({
  name: job.name,
  everyMinutes: job.everyMinutes,
  gatedInSetup: job.gatedInSetup === true,
}));

/** Job names the SETUP launch gate skips (launch checklist + tests read this). */
export const SETUP_GATED_JOB_NAMES: readonly string[] = registry
  .filter((job) => job.gatedInSetup)
  .map((job) => job.name);

// ── Lease + run machinery ────────────────────────────────────────────────────

async function isDue(job: JobDef, now: Date): Promise<boolean> {
  const last = await prisma.jobRun.findFirst({
    where: { jobName: job.name },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, status: true },
  });
  if (!last) return true;
  const elapsedMs = now.getTime() - last.startedAt.getTime();
  const elapsedMinutes = elapsedMs / 60_000;
  // A RUNNING row younger than the lock lease is either a genuinely running
  // job (its heartbeat still holds the lease) or a crash inside the lease
  // window — never due either way, even when the job's cadence is shorter
  // than the lease (billing_run: 5 min). Beyond the lease the row is crash
  // residue (a live run would have kept renewing) and the normal cadence
  // bounds the recovery.
  if (last.status === "RUNNING" && elapsedMs < LOCK_LEASE_MS) {
    return false;
  }
  // A FAILED run retries on the shorter FAILED_RETRY_MINUTES leash — a daily
  // job that failed must not sit broken for ~24h before its next chance.
  if (last.status === "FAILED") {
    return elapsedMinutes >= Math.min(job.everyMinutes, FAILED_RETRY_MINUTES);
  }
  return elapsedMinutes >= job.everyMinutes;
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

/**
 * Owner-scoped lease extension, fired on the heartbeat while the job body
 * runs. Never throws (a renewal hiccup must not kill the job mid-flight);
 * losing the lease to another owner is loud in the logs because it means the
 * duplicate-runner protection is gone for the rest of this run.
 */
async function renewLock(name: string, owner: string): Promise<void> {
  try {
    const renewed = await prisma.jobLock.updateMany({
      where: { name, owner },
      data: { lockedUntil: new Date(Date.now() + LOCK_LEASE_MS) },
    });
    if (renewed.count === 0) {
      console.error(
        `[jobs] lease renewal for ${name} found the lock gone or re-owned — a concurrent runner may now be live`,
      );
    }
  } catch (err) {
    console.error(`[jobs] lease renewal failed for ${name}`, err);
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
  // WALL time vs LOGICAL time: `now` is the tick-start timestamp and stays
  // the logical time job BODIES receive (schedule math must see one coherent
  // instant per tick). Everything that guards CONCURRENCY — dueness, the
  // lease horizon, the RUNNING row's startedAt — must use fresh wall time
  // instead: jobs run sequentially, so by the time job N acquires its lock,
  // real time is tick-start + (jobs 1..N-1). A lease anchored to the stale
  // tick start can be expired before the first heartbeat renewal (renewals
  // use Date.now()), and a backdated startedAt makes a rival invocation
  // classify the live run as crash residue — both of which hand a second
  // runner the lock mid-flight, the exact race the lease exists to prevent
  // (duplicate dunning emails, double ladder increments).
  if (!(await isDue(job, new Date()))) return;

  const owner = randomUUID();
  if (!(await acquireLock(job.name, new Date(), owner))) return;

  let runId: string | null = null;
  // Keep the lease alive for as long as the body runs — a sweep that outlives
  // the initial lease must never hand a second runner the lock mid-flight.
  // unref() (when available) so a live heartbeat never pins the process open.
  const heartbeat = setInterval(() => {
    void renewLock(job.name, owner);
  }, LOCK_RENEW_MS);
  heartbeat.unref?.();
  try {
    // Re-check under the lock: another instance may have started this job
    // between our due-check and the lease.
    if (!(await isDue(job, new Date()))) return;

    const run = await prisma.jobRun.create({
      data: { jobName: job.name, status: "RUNNING", startedAt: new Date() },
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
    clearInterval(heartbeat);
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
