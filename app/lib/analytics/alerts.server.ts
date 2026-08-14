import prisma from "~/db.server";
import { subDays, subHours } from "date-fns";
import { getEventWriteFailureStats, logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { shopDayStartUtc } from "~/lib/dates.server";
import {
  COUNTABLE_CONTRACT,
  requireShopById,
  shopDayLabelUtc,
} from "./queries.server";
import { OURS_ONLY, numericIdFromGid } from "~/lib/ownership/ownership.server";
import { isKlaviyoConfigured } from "~/lib/klaviyo/client.server";

/**
 * Operational alert scan. Creates Alert rows for anomalies, deduped on an
 * open (unresolved) alert of the same type, and emails admins for CRITICAL
 * severities via the notifications module (template "admin_alert").
 *
 * Every check is individually wrapped — a broken query in one check must
 * never suppress the others, and the scan itself never throws.
 */

type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/** Minimum absolute count before a spike check can fire (noise guard on tiny books). */
const MIN_SPIKE_COUNT = 3;

/** How far ahead we look for renewals billed against out-of-stock variants. */
const STOCKOUT_LOOKAHEAD_DAYS = 7;

/** Max contract ids embedded in alert context (full lists live in the queries themselves). */
const CONTEXT_SAMPLE = 20;

export interface AlertScanOptions {
  /**
   * variantId (full GID) → availableForSale, fed by the billing module which
   * already holds fresh product data. When absent the STOCKOUT_RENEWALS check
   * is skipped entirely (we never guess availability).
   */
  variantAvailability?: ReadonlyMap<string, boolean>;
  now?: Date;
}

export interface AlertScanResult {
  created: number;
  skipped: string[];
  errors: string[];
}

/**
 * Run all alert checks for a shop. Resilient by contract: returns a summary,
 * never throws.
 */
export async function runAlertScan(
  shopId: string,
  opts: AlertScanOptions = {},
): Promise<AlertScanResult> {
  const now = opts.now ?? new Date();
  const result: AlertScanResult = { created: 0, skipped: [], errors: [] };

  let shopDomain = "";
  let tz = "Europe/London";
  try {
    const shop = await requireShopById(shopId);
    shopDomain = shop.domain;
    tz = shop.ianaTimezone;
  } catch (err) {
    result.errors.push(`shop_lookup: ${String(err)}`);
    return result;
  }

  // ── Availability history, before any alert logic ────────────────────────
  // The variant feed the STOCKOUT_RENEWALS check consumes is otherwise
  // ephemeral — each 15-minute scan overwrites the last one's knowledge, so
  // "was this variant out of stock last Tuesday?" was unanswerable. Persist
  // what this scan saw as one AvailabilitySnapshot row per shop-day before
  // the checks run (a check failure must not lose the observation). Contained
  // like every check: a snapshot failure only costs history, never the scan.
  if (opts.variantAvailability) {
    try {
      await recordAvailabilitySnapshot(shopId, tz, now, opts.variantAvailability);
    } catch (err) {
      console.error("[alerts] availability snapshot failed", err);
      result.errors.push(`availability_snapshot: ${String(err)}`);
    }
  }

  const checks: [string, () => Promise<boolean | null>][] = [
    ["BILLING_RUN_FAILED", () => checkBillingRunFailed(shopId, now)],
    ["WEBHOOK_FAILURES", () => checkWebhookFailures(shopId, shopDomain, now)],
    ["ORIGIN_BACKFILL_FAILURES", () => checkOriginBackfillFailures(shopId, now)],
    ["ATTEMPT_AMOUNT_MISSING", () => checkAttemptAmountMissing(shopId, now)],
    ["EVENT_WRITE_FAILURES", () => checkEventWriteFailures(shopId)],
    ["STUCK_CONTRACTS", () => checkStuckContracts(shopId, now)],
    ["FAILURE_SPIKE", () => checkFailureSpike(shopId, tz, now)],
    ["CHURN_SPIKE", () => checkChurnSpike(shopId, tz, now)],
    ["FAST_SHIPPING_SKIPS", () => checkFastShippingSkips(shopId, now)],
    [
      "STOCKOUT_RENEWALS",
      () => checkStockoutRenewals(shopId, now, opts.variantAvailability),
    ],
    ["FOREIGN_CONTRACTS", () => checkForeignContracts(shopId)],
    ["KLAVIYO_OUTBOX_BACKLOG", () => checkKlaviyoOutboxBacklog(shopId, now)],
    ["KLAVIYO_FLOW_COVERAGE", () => checkKlaviyoFlowCoverage(shopId, now)],
    ["PLAN_GROUP_DRIFT", () => checkPlanGroupDrift(shopId, shopDomain, now)],
  ];

  for (const [name, check] of checks) {
    try {
      const created = await check();
      if (created === true) result.created += 1;
      if (created === null) result.skipped.push(name);
    } catch (err) {
      console.error(`[alerts] check ${name} failed`, err);
      result.errors.push(`${name}: ${String(err)}`);
    }
  }

  return result;
}

/**
 * Persist what the variant feed saw as the shop-day's availability history:
 * one row per (shop, day) in DailyRollup's label space (`shopDayLabelUtc` —
 * the synthetic UTC midnight of the shop-tz calendar day, so availability
 * history joins rollup days without timezone drift).
 *
 * The unavailable set is the UNION across the day's scans — the row answers
 * "was this variant out of stock at any point that day", not "at the last
 * scan", so a morning stockout restocked by noon stays visible to whoever
 * correlates skipped/delayed cycles with availability. `checkedVariants`
 * keeps the widest coverage any scan achieved (the feed only carries variants
 * renewing within the lookahead, so per-scan coverage varies through the
 * day; unioned unavailable ids can therefore legitimately exceed a later,
 * narrower scan's coverage). Read-then-upsert is race-free in practice: the
 * alerts_run JobLock lease serializes scans.
 */
async function recordAvailabilitySnapshot(
  shopId: string,
  tz: string,
  now: Date,
  availability: ReadonlyMap<string, boolean>,
): Promise<void> {
  const date = shopDayLabelUtc(now, tz);
  const unavailableNow = [...availability.entries()]
    .filter(([, availableForSale]) => !availableForSale)
    .map(([variantId]) => variantId);

  const existing = await prisma.availabilitySnapshot.findUnique({
    where: { shopId_date: { shopId, date } },
    select: { unavailableVariantIds: true, checkedVariants: true },
  });
  const prior = Array.isArray(existing?.unavailableVariantIds)
    ? (existing.unavailableVariantIds as unknown[]).filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const unavailable = [...new Set([...prior, ...unavailableNow])];

  await prisma.availabilitySnapshot.upsert({
    where: { shopId_date: { shopId, date } },
    create: {
      shopId,
      date,
      unavailableVariantIds: unavailable,
      checkedVariants: availability.size,
    },
    update: {
      unavailableVariantIds: unavailable,
      checkedVariants: Math.max(existing?.checkedVariants ?? 0, availability.size),
    },
  });
}

// ── Individual checks (return true = alert created, false = all clear, null = skipped) ──

/**
 * CRITICAL when any billing_run JobRun FAILED in the last 24h.
 *
 * SINGLE-TENANT ASSUMPTION (documented, deliberate): JobRun has no shopId
 * column — jobs run per-process for the one installed shop, so this query is
 * global. If this app ever hosts a second shop, JobRun needs a shopId (additive
 * migration) and this filter must scope by it, or each shop alerts on the
 * other's failures.
 */
async function checkBillingRunFailed(
  shopId: string,
  now: Date,
): Promise<boolean> {
  const failedRuns = await prisma.jobRun.findMany({
    where: {
      jobName: "billing_run",
      status: "FAILED",
      startedAt: { gte: subHours(now, 24) },
    },
    orderBy: { startedAt: "desc" },
    take: 5,
    select: { id: true, startedAt: true, error: true },
  });
  if (failedRuns.length === 0) return false;

  return raiseAlert({
    shopId,
    type: "BILLING_RUN_FAILED",
    severity: "CRITICAL",
    message: `The billing run failed ${failedRuns.length} time(s) in the last 24 hours. Renewal charges may not be going out — investigate immediately.`,
    context: {
      failedRuns: failedRuns.map((r) => ({
        jobRunId: r.id,
        startedAt: r.startedAt.toISOString(),
        error: r.error,
      })),
    },
  });
}

/**
 * WARNING when the most recent COMPLETED origin_order_backfill run reported
 * contained per-contract failures (stats.failed / stats.acqFailed > 0). Those
 * failures never throw — the job itself records SUCCESS — so without this
 * check they are invisible to every recovery surface, and a capped
 * oldest-first window quietly filling with failing rows is exactly how the
 * origin-money queue starves (each night burns its whole cap on the same
 * failing fetches and captures nothing). Terminal retirements
 * (stats.exhausted, migration 0011) are NOT failures and never alert.
 *
 * Same SINGLE-TENANT JobRun assumption as checkBillingRunFailed above.
 */
async function checkOriginBackfillFailures(
  shopId: string,
  now: Date,
): Promise<boolean> {
  const lastRun = await prisma.jobRun.findFirst({
    where: {
      jobName: "origin_order_backfill",
      status: "SUCCESS",
      startedAt: { gte: subHours(now, 48) },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, stats: true },
  });
  if (!lastRun) return false;

  const stats = (lastRun.stats ?? {}) as Record<string, unknown>;
  const asCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const failed = asCount(stats.failed);
  const acqFailed = asCount(stats.acqFailed);
  if (failed === 0 && acqFailed === 0) return false;

  return raiseAlert({
    shopId,
    type: "ORIGIN_BACKFILL_FAILURES",
    severity: "WARNING",
    message: `The last origin-order backfill run left ${failed} money capture(s) and ${acqFailed} acquisition pickup(s) failing. These retry nightly, but persistent failures can starve the capped backfill window and leave first-payment revenue missing from cohort/rollup analytics — check the job log.`,
    context: {
      jobRunId: lastRun.id,
      startedAt: lastRun.startedAt.toISOString(),
      failed,
      acqFailed,
      captured: asCount(stats.captured),
      exhausted: asCount(stats.exhausted),
      scanned: asCount(stats.scanned),
    },
  });
}

/**
 * How far back the missing-amount scan looks. Settlement copies the charged
 * amount from the order onto the attempt; a SUCCESS attempt that finished
 * settlement (settledAt stamped) with amountCents still NULL means that copy
 * failed — the customer WAS charged, but the charge is invisible to every
 * revenue surface (rollup, cohorts, lifetimeRevenueCents) that sums
 * amountCents. The window keeps a historical, no-longer-fixable row from
 * re-raising the alert forever after the merchant resolves it; a settlement
 * path that is actively dropping amounts produces fresh rows inside the
 * window every day.
 */
const AMOUNT_MISSING_LOOKBACK_DAYS = 7;

/**
 * WARNING when settled SUCCESS attempts carry no amount — money collected
 * that analytics cannot see (the one shape the settlement redrive cannot
 * fix, because the attempt looks fully settled).
 */
async function checkAttemptAmountMissing(
  shopId: string,
  now: Date,
): Promise<boolean> {
  const missing = await prisma.billingAttempt.findMany({
    where: {
      contract: { shopId, ...COUNTABLE_CONTRACT },
      status: "SUCCESS",
      settledAt: { gte: subDays(now, AMOUNT_MISSING_LOOKBACK_DAYS) },
      amountCents: null,
    },
    select: { id: true, contractId: true, orderId: true, settledAt: true },
    take: 200,
  });
  if (missing.length === 0) return false;

  return raiseAlert({
    shopId,
    type: "ATTEMPT_AMOUNT_MISSING",
    severity: "WARNING",
    message: `${missing.length} successful charge(s) settled in the last ${AMOUNT_MISSING_LOOKBACK_DAYS} days with no amount recorded. The customers were charged, but these charges are invisible to revenue analytics (rollup, cohorts, lifetime revenue) — check the settlement log for the order lookups that failed.`,
    context: {
      count: missing.length,
      lookbackDays: AMOUNT_MISSING_LOOKBACK_DAYS,
      sample: missing.slice(0, CONTEXT_SAMPLE).map((a) => ({
        attemptId: a.id,
        contractId: a.contractId,
        orderId: a.orderId,
        settledAt: a.settledAt?.toISOString() ?? null,
      })),
    },
  });
}

/**
 * WARNING when this process has swallowed SubscriberEvent write failures
 * (logEvent's never-throw containment — see the counter's doc block in
 * events/log.server.ts for why each lost write is permanent undercounting).
 *
 * The counter is in-process, so this check re-raises only on NEW loss: a
 * higher count from the same process, or any nonzero count from a new process
 * (`processStartedAt` changed — a restart RESETS the counter, so a lower
 * count means restart, never recovery). The comparison baseline is the most
 * recent EVENT_WRITE_FAILURES alert row, open or resolved — durable where the
 * counter is not. Multi-instance honesty: only the instance holding the
 * alerts_run lease is inspected; losses in a sibling instance surface when it
 * wins a later scan.
 */
async function checkEventWriteFailures(shopId: string): Promise<boolean> {
  const stats = getEventWriteFailureStats();
  if (stats.count === 0) return false;

  const last = await prisma.alert.findFirst({
    where: { shopId, type: "EVENT_WRITE_FAILURES" },
    orderBy: { createdAt: "desc" },
    select: { context: true },
  });
  if (last) {
    const ctx = (last.context ?? {}) as Record<string, unknown>;
    const prevCount = typeof ctx.count === "number" ? ctx.count : 0;
    if (ctx.processStartedAt === stats.processStartedAt && stats.count <= prevCount) {
      return false; // nothing lost since the last raise
    }
  }

  return raiseAlert({
    shopId,
    type: "EVENT_WRITE_FAILURES",
    severity: "WARNING",
    message: `${stats.count} subscriber event write(s) failed and were swallowed since the app process started (last: ${stats.lastType ?? "unknown"}). Each lost event permanently understates event-sourced analytics (refunds, take rate, skips, saves) and can weaken behavioral guards (winback/lifecycle dedupe, rate limits) — check database health and the app logs around the failure time.`,
    context: {
      count: stats.count,
      lastAt: stats.lastAt?.toISOString() ?? null,
      lastType: stats.lastType,
      processStartedAt: stats.processStartedAt,
    },
  });
}

/**
 * How old a claimed-but-unfinished receipt (processedAt NULL) must be before
 * it counts as crash residue. Handlers finish in seconds and the webhook
 * route's redelivery redrive normally completes such receipts within a couple
 * of Shopify retries; anything still unfinished after this window means the
 * redrive is not landing (retries exhausted, or the handler keeps dying).
 */
const STUCK_RECEIPT_MINUTES = 15;

/**
 * How far back the FAILED-residue arm looks. A handler ERROR answers 200
 * (routes/webhooks.tsx must, or Shopify disables the webhook), which ENDS the
 * retry train for that delivery — so a FAILED receipt whose 200 reached
 * Shopify will never flip to PROCESSED and would re-raise this alert forever
 * with nothing left for the merchant to flip. Two days covers Shopify's own
 * ~48h retry horizon and gives the settlement_redrive job (the attempt-level
 * recovery for billing webhooks) and the merchant ample alert exposure;
 * beyond it the receipt is historical evidence, not an active incident.
 */
const FAILED_RESIDUE_LOOKBACK_HOURS = 48;

/**
 * CRITICAL when any of three shapes shows up:
 *  - ≥5 webhook receipts FAILED processing within the last hour (a burst —
 *    something is broken across deliveries);
 *  - ANY receipt stuck claimed-but-unfinished (status PROCESSED, processedAt
 *    NULL) for more than STUCK_RECEIPT_MINUTES — the crash-residue shape a
 *    first delivery leaves when the process dies mid-handler. Shopify's
 *    same-id retries normally re-drive those (see routes/webhooks.tsx); one
 *    persisting this long means that recovery is not happening;
 *  - ANY receipt FAILED (processedAt NULL) older than STUCK_RECEIPT_MINUTES
 *    within the lookback. A handler that THREW (rather than crashed) was
 *    answered 200 FAILED, which permanently ends Shopify's retry train for
 *    that id — so even a single such receipt is unrecoverable by redelivery
 *    and must alert. The old ≥5-in-an-hour threshold alone let 1-4 failures
 *    age out of the window silently, orphaning half-settled attempts (the
 *    settledAt-NULL / declineCategory-NULL redrive contracts) forever.
 */
async function checkWebhookFailures(
  shopId: string,
  shopDomain: string,
  now: Date,
): Promise<boolean> {
  const stuckBefore = new Date(now.getTime() - STUCK_RECEIPT_MINUTES * 60_000);
  const failed = await prisma.webhookReceipt.count({
    where: {
      shopDomain,
      status: "FAILED",
      receivedAt: { gte: subHours(now, 1) },
    },
  });
  // status PROCESSED only: FAILED rows also carry processedAt NULL but have
  // their own residue count below — the status filters keep these disjoint.
  const stuck = await prisma.webhookReceipt.count({
    where: {
      shopDomain,
      status: "PROCESSED",
      processedAt: null,
      receivedAt: { lt: stuckBefore },
    },
  });
  // FAILED residue: past the stuck window (young FAILED rows may still be
  // re-driven by a retry whose 200 never landed), inside the lookback (see
  // FAILED_RESIDUE_LOOKBACK_HOURS). Threshold is ONE — a 200 FAILED receipt
  // has no retry train left, so there is no count below which it self-heals.
  const failedStuck = await prisma.webhookReceipt.count({
    where: {
      shopDomain,
      status: "FAILED",
      processedAt: null,
      receivedAt: {
        lt: stuckBefore,
        gte: subHours(now, FAILED_RESIDUE_LOOKBACK_HOURS),
      },
    },
  });
  if (failed < 5 && stuck === 0 && failedStuck === 0) return false;

  const parts: string[] = [];
  if (failed >= 5) {
    parts.push(`${failed} webhook deliveries failed processing in the last hour`);
  }
  if (stuck > 0) {
    parts.push(
      `${stuck} webhook receipt(s) are claimed but unfinished for over ${STUCK_RECEIPT_MINUTES} min (first delivery died mid-handler and no retry has re-driven it)`,
    );
  }
  if (failedStuck > 0) {
    parts.push(
      `${failedStuck} webhook receipt(s) FAILED processing and were answered 200, so Shopify will never redeliver them (handler error — the settlement redrive sweep recovers billing attempts, but other topics may need manual re-sync)`,
    );
  }
  return raiseAlert({
    shopId,
    type: "WEBHOOK_FAILURES",
    severity: "CRITICAL",
    message: `${parts.join("; ")}. Local contract state may be drifting from Shopify.`,
    context: {
      failedLastHour: failed,
      stuckUnfinished: stuck,
      failedUnrecoverable: failedStuck,
    },
  });
}

/**
 * WARNING when ACTIVE contracts sit past their nextBillingDate by more than
 * settings.alerts.stuckContractHours with no PENDING billing attempt — the
 * scheduler is not picking them up.
 */
async function checkStuckContracts(shopId: string, now: Date): Promise<boolean> {
  const alertSettings = await getSetting(shopId, "alerts");
  const threshold = subHours(now, alertSettings.stuckContractHours);

  const stuck = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      // preview fixtures are never billed, so never "stuck"; another app's
      // contracts are not ours to bill at all, so they are never "stuck" either
      isDemo: false,
      ...OURS_ONLY,
      nextBillingDate: { lt: threshold },
      billingAttempts: { none: { status: "PENDING" } },
    },
    select: { id: true, shopifyContractId: true, nextBillingDate: true },
    take: 200,
  });
  if (stuck.length === 0) return false;

  return raiseAlert({
    shopId,
    type: "STUCK_CONTRACTS",
    severity: "WARNING",
    message: `${stuck.length} active contract(s) are more than ${alertSettings.stuckContractHours}h past their next billing date with no pending billing attempt.`,
    context: {
      count: stuck.length,
      stuckContractHours: alertSettings.stuckContractHours,
      sample: stuck.slice(0, CONTEXT_SAMPLE).map((c) => ({
        contractId: c.id,
        shopifyContractId: c.shopifyContractId,
        nextBillingDate: c.nextBillingDate?.toISOString() ?? null,
      })),
    },
  });
}

/**
 * CRITICAL when today's failed billing attempts exceed the trailing 28-day
 * daily average by settings.alerts.failureSpikeThresholdPct percent (with an
 * absolute floor of MIN_SPIKE_COUNT so a single failure on a quiet book
 * doesn't page anyone).
 */
async function checkFailureSpike(
  shopId: string,
  tz: string,
  now: Date,
): Promise<boolean> {
  const alertSettings = await getSetting(shopId, "alerts");
  const todayStart = shopDayStartUtc(now, tz);
  const baselineStart = subDays(todayStart, 28);

  const [todayFailed, baselineFailed] = await Promise.all([
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "FAILED",
        completedAt: { gte: todayStart, lte: now },
      },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId, ...COUNTABLE_CONTRACT },
        status: "FAILED",
        completedAt: { gte: baselineStart, lt: todayStart },
      },
    }),
  ]);

  const avgDaily = baselineFailed / 28;
  const threshold = avgDaily * (1 + alertSettings.failureSpikeThresholdPct / 100);
  const spiking =
    todayFailed >= MIN_SPIKE_COUNT && (avgDaily === 0 || todayFailed > threshold);
  if (!spiking) return false;

  return raiseAlert({
    shopId,
    type: "FAILURE_SPIKE",
    severity: "CRITICAL",
    message: `Payment failures today (${todayFailed}) are above the 28-day daily average (${avgDaily.toFixed(2)}) by more than ${alertSettings.failureSpikeThresholdPct}%. A gateway or card-network issue may be in progress.`,
    context: {
      todayFailed,
      avgDaily28d: Math.round(avgDaily * 100) / 100,
      thresholdPct: alertSettings.failureSpikeThresholdPct,
    },
  });
}

/**
 * WARNING when today's cancellations exceed the trailing 28-day daily average
 * by settings.alerts.churnSpikeThresholdPct percent (same floor as above).
 */
async function checkChurnSpike(
  shopId: string,
  tz: string,
  now: Date,
): Promise<boolean> {
  const alertSettings = await getSetting(shopId, "alerts");
  const todayStart = shopDayStartUtc(now, tz);
  const baselineStart = subDays(todayStart, 28);

  // Consolidation merges are never churn (the queries.server.ts rollup rule)
  // — a bulk merge day would otherwise page the merchant with a phantom
  // churn spike.
  const [todayCancels, baselineCancels] = await Promise.all([
    prisma.subscriptionContract.count({
      where: {
        shopId,
        isDemo: false,
        ...OURS_ONLY,
        cancelledAt: { gte: todayStart, lte: now },
        NOT: { cancelReason: "MERGED" },
      },
    }),
    prisma.subscriptionContract.count({
      where: {
        shopId,
        isDemo: false, ...OURS_ONLY,
        cancelledAt: { gte: baselineStart, lt: todayStart },
        NOT: { cancelReason: "MERGED" },
      },
    }),
  ]);

  const avgDaily = baselineCancels / 28;
  const threshold = avgDaily * (1 + alertSettings.churnSpikeThresholdPct / 100);
  const spiking =
    todayCancels >= MIN_SPIKE_COUNT &&
    (avgDaily === 0 || todayCancels > threshold);
  if (!spiking) return false;

  return raiseAlert({
    shopId,
    type: "CHURN_SPIKE",
    severity: "WARNING",
    message: `Cancellations today (${todayCancels}) are above the 28-day daily average (${avgDaily.toFixed(2)}) by more than ${alertSettings.churnSpikeThresholdPct}%. Check recent price changes, emails or product issues.`,
    context: {
      todayCancels,
      avgDaily28d: Math.round(avgDaily * 100) / 100,
      thresholdPct: alertSettings.churnSpikeThresholdPct,
    },
  });
}

/**
 * INFO when subscribers skip at or above settings.cadence.skipRatioThreshold
 * of their recent cycles (window = skipRatioWindowCycles × their interval) —
 * product is arriving faster than they use it; the fix is a longer default
 * frequency, not more skip emails. Returns null when the feature is disabled.
 */
async function checkFastShippingSkips(
  shopId: string,
  now: Date,
): Promise<boolean | null> {
  const cadence = await getSetting(shopId, "cadence");
  if (!cadence.fastShippingSkipAlert) return null;

  const candidates = await prisma.subscriptionContract.findMany({
    where: { shopId, status: "ACTIVE", isDemo: false, ...OURS_ONLY, skipCount: { gte: 2 } },
    select: { id: true, shopifyContractId: true, intervalWeeks: true },
  });
  if (candidates.length === 0) return false;

  // One events query + one attempts query across all candidates; per-contract
  // windows are applied in memory.
  const windowStartFor = (intervalWeeks: number): Date =>
    new Date(
      now.getTime() -
        cadence.skipRatioWindowCycles *
          Math.max(1, intervalWeeks) *
          7 *
          86_400_000,
    );
  const earliest = candidates.reduce(
    (min, c) => {
      const start = windowStartFor(c.intervalWeeks);
      return start < min ? start : min;
    },
    windowStartFor(candidates[0].intervalWeeks),
  );
  const candidateIds = candidates.map((c) => c.id);

  const [skipEvents, successes] = await Promise.all([
    prisma.subscriberEvent.findMany({
      where: {
        shopId,
        type: "cycle.skipped",
        contractId: { in: candidateIds },
        createdAt: { gte: earliest },
      },
      select: { contractId: true, createdAt: true },
    }),
    prisma.billingAttempt.findMany({
      where: {
        contractId: { in: candidateIds },
        status: "SUCCESS",
        completedAt: { gte: earliest },
      },
      select: { contractId: true, completedAt: true },
    }),
  ]);

  const affected: { contractId: string; shopifyContractId: string; skipRatio: number }[] = [];
  for (const contract of candidates) {
    const windowStart = windowStartFor(contract.intervalWeeks);
    const skips = skipEvents.filter(
      (e) => e.contractId === contract.id && e.createdAt >= windowStart,
    ).length;
    const billed = successes.filter(
      (a) =>
        a.contractId === contract.id &&
        a.completedAt != null &&
        a.completedAt >= windowStart,
    ).length;
    const cycles = skips + billed;
    if (cycles === 0 || skips < 2) continue;
    const ratio = skips / cycles;
    if (ratio >= cadence.skipRatioThreshold) {
      affected.push({
        contractId: contract.id,
        shopifyContractId: contract.shopifyContractId,
        skipRatio: Math.round(ratio * 100) / 100,
      });
    }
  }
  if (affected.length === 0) return false;

  const thresholdPct = Math.round(cadence.skipRatioThreshold * 100);
  return raiseAlert({
    shopId,
    type: "FAST_SHIPPING_SKIPS",
    severity: "INFO",
    message: `${affected.length} subscriber(s) skipped at least ${thresholdPct}% of their recent cycles — shipments are likely arriving faster than the product is used. Consider recommending a longer default frequency for their products.`,
    context: {
      count: affected.length,
      skipRatioThreshold: cadence.skipRatioThreshold,
      windowCycles: cadence.skipRatioWindowCycles,
      sample: affected.slice(0, CONTEXT_SAMPLE),
    },
  });
}

/**
 * WARNING when contracts billing within 7 days contain variants that are not
 * available for sale. The availability map is supplied by the billing module
 * (which already fetches variant data); without it the check is skipped —
 * returns null.
 */
async function checkStockoutRenewals(
  shopId: string,
  now: Date,
  variantAvailability?: ReadonlyMap<string, boolean>,
): Promise<boolean | null> {
  if (!variantAvailability) return null;

  const upcoming = await prisma.subscriptionContract.findMany({
    where: {
      shopId,
      status: "ACTIVE",
      isDemo: false, ...OURS_ONLY,
      nextBillingDate: {
        gte: now,
        lte: new Date(now.getTime() + STOCKOUT_LOOKAHEAD_DAYS * 86_400_000),
      },
    },
    select: {
      id: true,
      shopifyContractId: true,
      nextBillingDate: true,
      lines: { select: { variantId: true, title: true, isGift: true } },
    },
  });

  const affected: {
    contractId: string;
    shopifyContractId: string;
    nextBillingDate: string | null;
    outOfStockVariantIds: string[];
  }[] = [];
  for (const contract of upcoming) {
    const oos = contract.lines
      .filter((l) => variantAvailability.get(l.variantId) === false)
      .map((l) => l.variantId);
    if (oos.length > 0) {
      affected.push({
        contractId: contract.id,
        shopifyContractId: contract.shopifyContractId,
        nextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
        outOfStockVariantIds: [...new Set(oos)],
      });
    }
  }
  if (affected.length === 0) return false;

  return raiseAlert({
    shopId,
    type: "STOCKOUT_RENEWALS",
    severity: "WARNING",
    message: `${affected.length} contract(s) billing within ${STOCKOUT_LOOKAHEAD_DAYS} days include out-of-stock variants. Restock or let the stockout policy (delay/skip/substitute) handle them.`,
    context: {
      count: affected.length,
      lookaheadDays: STOCKOUT_LOOKAHEAD_DAYS,
      sample: affected.slice(0, CONTEXT_SAMPLE),
    },
  });
}

/**
 * WARNING when contracts on this shop belong to another subscription app
 * (FOREIGN) or cannot be attributed (UNKNOWN).
 *
 * This is the "you are not alone on this store" signal. It must be impossible
 * to miss before go-live: FOREIGN contracts mean a second subscription app
 * (e.g. Joy) is billing customers on the same shop, and the one thing that
 * must never happen is both apps charging the same contract. Cellexia already
 * refuses to bill, email, analyse or expose them — the alert says so in plain
 * words so the merchant knows the isolation is deliberate, not a bug.
 *
 * Deduped like every other alert (one open row per type); it re-raises only
 * after the merchant resolves the previous one.
 */
async function checkForeignContracts(shopId: string): Promise<boolean> {
  const { getOwnershipCounts } = await import("~/lib/ownership/ownership.server");
  const counts = await getOwnershipCounts(shopId);
  if (counts.foreign === 0 && counts.unknown === 0) return false;

  const parts: string[] = [];
  if (counts.foreign > 0) {
    parts.push(
      `${counts.foreign} subscription${counts.foreign === 1 ? "" : "s"} on this store ${counts.foreign === 1 ? "is" : "are"} managed by another subscription app`,
    );
  }
  if (counts.unknown > 0) {
    parts.push(
      `${counts.unknown} subscription${counts.unknown === 1 ? "" : "s"} could not be attributed to any app`,
    );
  }

  return raiseAlert({
    shopId,
    type: "FOREIGN_CONTRACTS",
    severity: "WARNING",
    message: `${parts.join(", and ")}. Cellexia will never bill, email or modify them — they stay entirely with the other app. If you are migrating those subscribers over, claim them on the Subscribers page after cancelling them in the other app; never leave both apps billing the same subscription.`,
    context: {
      foreign: counts.foreign,
      unknown: counts.unknown,
      ours: counts.ours,
    },
  });
}

/**
 * Event type that timestamps a completed plan-attachment drift sweep. The
 * alert scan runs every 15 minutes but this check talks to the Shopify Admin
 * API, so it self-gates to once per PLAN_DRIFT_CHECK_HOURS on the most recent
 * event of this type — a daily check riding the existing sweep, no new job.
 */
export const PLAN_DRIFT_CHECK_EVENT_TYPE = "system.plan_group_drift_check";
const PLAN_DRIFT_CHECK_HOURS = 24;

/**
 * WARNING when a SYNCED selling plan config's group is no longer attached to
 * every product in the config — drift the merchant cannot see: the Plans row
 * says SYNCED while the product page renders no Cellexia widget at all.
 *
 * The observed cause on the live store is another subscription app's product
 * sync reconciling products it also manages and detaching our group in the
 * process (a deleted product produces the same signature). The check runs
 * entirely in ADMIN id space (config product GIDs vs. the group GID the sync
 * recorded — reliable exact equality, unlike storefront Liquid group ids) and
 * re-uses the same batched verification the post-sync check uses.
 *
 * Since v1.6.9 the same daily budget also verifies the OWNERSHIP FACTORS the
 * storefront gate requires (published appId + exact plan sets, and the
 * group-side app_id stamp) — the other way a SYNCED row hides a dark
 * storefront, produced by upgrading in the wrong order or a hand-edited
 * metafield. That half SELF-HEALS first (publishOwnGroupsMetafield stamps
 * and republishes, never throws) and raises OWNERSHIP_FACTORS only when the
 * republish did not fix it.
 *
 * Resilient by construction: one config's failed verification is contained
 * (logged, counted, never blocks the others), the completed sweep is
 * timestamped even when partially failed so a broken store cannot turn this
 * into a 15-minute Shopify hammer, and the alert itself is deduped like every
 * other type (one open row). Returns null when gated (ran within the last
 * 24h) — the scan reports it as skipped, not silently clear.
 */
async function checkPlanGroupDrift(
  shopId: string,
  shopDomain: string,
  now: Date,
): Promise<boolean | null> {
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId, syncStatus: "SYNCED", shopifyGroupId: { not: null } },
    select: { id: true, name: true, shopifyGroupId: true, productIds: true },
  });
  if (configs.length === 0) return false;

  const recentSweep = await prisma.subscriberEvent.findFirst({
    where: {
      shopId,
      type: PLAN_DRIFT_CHECK_EVENT_TYPE,
      createdAt: { gte: subHours(now, PLAN_DRIFT_CHECK_HOURS) },
    },
    select: { id: true },
  });
  if (recentSweep) return null;

  // Lazy imports on purpose (see the module docs of ownership.server.ts):
  // this module is otherwise Shopify-free, and unit tests that mock the db
  // must not have to know about Shopify sessions unless this check runs.
  const { adminClientForShop } = await import("~/shopify.server");
  const admin = await adminClientForShop(shopDomain);
  const { findProductsMissingFromGroup } = await import(
    "~/lib/graphql/sellingPlans.server"
  );

  const drifted: Array<{
    configId: string;
    configName: string;
    groupId: string;
    missingProductIds: string[];
  }> = [];
  let checkErrors = 0;
  for (const config of configs) {
    try {
      const productIds = Array.isArray(config.productIds)
        ? config.productIds.filter(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          )
        : [];
      if (productIds.length === 0) continue;
      const missing = await findProductsMissingFromGroup(
        admin,
        config.shopifyGroupId!,
        productIds,
      );
      if (missing.length > 0) {
        drifted.push({
          configId: config.id,
          configName: config.name,
          groupId: config.shopifyGroupId!,
          missingProductIds: missing,
        });
      }
    } catch (err) {
      checkErrors += 1;
      console.error("[alerts] plan drift verification failed for config", config.id, err);
    }
  }

  // ── The v1.6.9 ownership factors, on the same daily API budget. ─────────
  // Attachment drift is only one way a SYNCED plan row can hide a dark
  // storefront: since v1.6.9 the widget also requires the published appId +
  // exact plan sets AND the group-side app_id stamp, and a store upgraded in
  // the wrong order (extension deployed before Sync) or a hand-edited
  // metafield fails those with every attachment intact. Verified against
  // the live state, SELF-HEALED by republishing (publishOwnGroupsMetafield
  // never throws and contains the stamp heal), and alerted only when the
  // republish did not fix it. Contained: a factor-check failure never
  // blocks the attachment verdict.
  let factorProblems: string[] = [];
  let factorsHealed = false;
  try {
    const [{ getShopMetafield }, sellingPlans, ownership] = await Promise.all([
      import("~/lib/graphql/metafields.server"),
      import("~/lib/graphql/sellingPlans.server"),
      import("~/lib/ownership/ownership.server"),
    ]);
    const gids = configs
      .map((c) => c.shopifyGroupId)
      .filter((id): id is string => id != null);
    const ourAppId = await sellingPlans.getCurrentAppId(admin);
    const states = await sellingPlans.getSellingPlanGroupOwnershipStates(
      admin,
      gids,
    );
    const metafield = await getShopMetafield(
      admin,
      ownership.PLAN_GROUPS_METAFIELD_NAMESPACE,
      ownership.PLAN_GROUPS_METAFIELD_KEY,
    );
    const describeProblems = (): string[] => {
      const problems: string[] = [];
      let parsed: {
        planSets?: unknown;
        appId?: unknown;
      } | null = null;
      if (metafield) {
        try {
          const raw: unknown = JSON.parse(metafield.value);
          parsed =
            typeof raw === "object" && raw !== null
              ? (raw as { planSets?: unknown; appId?: unknown })
              : null;
        } catch {
          parsed = null;
        }
      }
      if (!parsed) {
        problems.push("the cellexia.plan_groups allow-list is missing or malformed");
        return problems;
      }
      // Verbatim comparison, like the storefront: never trim.
      const appId =
        typeof parsed.appId === "string"
          ? parsed.appId
          : typeof parsed.appId === "number"
            ? String(parsed.appId)
            : null;
      if (appId !== ourAppId) {
        problems.push(
          appId == null || appId.trim() === ""
            ? "the allow-list has no appId (published before v1.6.9?)"
            : `the allow-list appId (${JSON.stringify(appId)}) is not this app's id (${ourAppId})`,
        );
      }
      const planSets = Array.isArray(parsed.planSets)
        ? parsed.planSets.map((set: unknown) =>
            Array.isArray(set) ? set.map(String) : [],
          )
        : [];
      if (planSets.length === 0) {
        problems.push("the allow-list has no planSets (published before v1.6.9?)");
      }
      const setKeys = new Set(
        planSets.map((set: string[]) => [...set].sort().join(",")),
      );
      for (const gid of gids) {
        const state = states.get(gid);
        const numeric = numericIdFromGid(gid) ?? gid;
        if (!state) {
          problems.push(`group ${numeric} cannot be read back from Shopify`);
          continue;
        }
        if (state.appId !== ourAppId) {
          problems.push(`group ${numeric} is not stamped with this app's id`);
        }
        const liveSet = state.planIds
          .map((id) => numericIdFromGid(id))
          .filter((id): id is string => id != null);
        if (liveSet.length === 0 || !setKeys.has([...liveSet].sort().join(","))) {
          problems.push(
            `group ${numeric}'s live plan set matches no published planSets entry`,
          );
        }
      }
      return problems;
    };
    factorProblems = describeProblems();
    if (factorProblems.length > 0) {
      const republished = await ownership.publishOwnGroupsMetafield(shopDomain);
      factorsHealed =
        republished.ok === true &&
        republished.value != null &&
        republished.value.appId === ourAppId &&
        republished.value.planSets.length > 0 &&
        (republished.heal?.failed ?? []).length === 0;
    }
  } catch (err) {
    checkErrors += 1;
    console.error("[alerts] ownership factor verification failed", err);
  }

  // Timestamp the sweep BEFORE deciding the verdict, clean or not: the gate
  // exists to bound Admin API traffic, and a sweep that found drift (or
  // partially failed) has still spent that budget for today.
  await logEvent({
    shopId,
    type: PLAN_DRIFT_CHECK_EVENT_TYPE,
    source: "SYSTEM",
    actor: "system",
    payload: {
      configsChecked: configs.length,
      driftedConfigs: drifted.length,
      checkErrors,
      ownershipFactorProblems: factorProblems.length,
      ownershipFactorsHealed: factorsHealed,
    },
  });

  let raised = false;
  if (factorProblems.length > 0 && !factorsHealed) {
    raised =
      (await raiseAlert({
        shopId,
        type: "OWNERSHIP_FACTORS",
        severity: "WARNING",
        message: `The storefront buy box is rendering nothing although your plans show SYNCED: ${factorProblems.join("; ")}. An automatic republish did not fix it — press Sync to Shopify on the Plans page, then run the Preview Doctor on Preview & launch.`,
        context: {
          problems: factorProblems.slice(0, CONTEXT_SAMPLE),
          republishAttempted: true,
        },
      })) || raised;
  }

  if (drifted.length === 0) return raised;

  // Name the detached products for the merchant; a title lookup failure
  // falls back to the GIDs rather than hiding which products are affected.
  const missingIds = [...new Set(drifted.flatMap((d) => d.missingProductIds))];
  let titleById = new Map<string, string>();
  try {
    const { getProducts } = await import("~/lib/graphql/products.server");
    titleById = new Map(
      (await getProducts(admin, missingIds)).map((p) => [p.id, p.title]),
    );
  } catch (err) {
    console.error("[alerts] plan drift title lookup failed", err);
  }
  const names = missingIds.map((id) => titleById.get(id) ?? id);

  const driftRaised = await raiseAlert({
    shopId,
    type: "PLAN_GROUP_DRIFT",
    severity: "WARNING",
    message: `Your Cellexia plan was detached from ${names.join(", ")} — another subscription app's sync may be reconciling products it manages. Re-sync on the Plans page, and exclude these products from the other app's management.`,
    context: {
      drifted: drifted.map((d) => ({
        configId: d.configId,
        configName: d.configName,
        groupId: d.groupId,
        missingProductIds: d.missingProductIds.slice(0, CONTEXT_SAMPLE),
      })),
      checkErrors,
    },
  });
  return driftRaised || raised;
}

/**
 * How long a PENDING outbox row may sit unflushed before it counts as stalled.
 * A healthy flush attempts every PENDING row within minutes of enqueue; a row
 * still PENDING after an hour means either no Klaviyo key is configured
 * anywhere (Settings or env — flushKlaviyoOutbox skips entirely) or the
 * klaviyo_flush job is not running.
 * Rows mid-retry are FAILED, not PENDING, so a Klaviyo outage riding its
 * backoff train never trips this arm — it surfaces through DEAD rows instead.
 */
const KLAVIYO_STALLED_MINUTES = 60;

/** Lookback for rows that died undelivered (permanent 4xx, retries exhausted, or aged out). */
const KLAVIYO_DEAD_LOOKBACK_HOURS = 48;

/**
 * WARNING when the Klaviyo outbox is not draining: PENDING rows stalled past
 * KLAVIYO_STALLED_MINUTES, or rows that went DEAD undelivered within the
 * lookback. Every customer-facing lifecycle message rides this outbox — before
 * this check existed, a missing/broken key meant the notification router and
 * dunning ladder recorded activity while nothing reached a single customer,
 * and no surface anywhere said so.
 */
async function checkKlaviyoOutboxBacklog(
  shopId: string,
  now: Date,
): Promise<boolean> {
  const stalledBefore = new Date(
    now.getTime() - KLAVIYO_STALLED_MINUTES * 60_000,
  );
  const [pendingStalled, deadRecent] = await Promise.all([
    prisma.klaviyoOutbox.count({
      where: { shopId, status: "PENDING", eventTime: { lt: stalledBefore } },
    }),
    prisma.klaviyoOutbox.count({
      where: {
        shopId,
        status: "DEAD",
        eventTime: { gte: subHours(now, KLAVIYO_DEAD_LOOKBACK_HOURS) },
      },
    }),
  ]);
  if (pendingStalled === 0 && deadRecent === 0) return false;

  const configured = await isKlaviyoConfigured(shopId);
  const parts: string[] = [];
  if (pendingStalled > 0) {
    parts.push(
      configured
        ? `${pendingStalled} Klaviyo event(s) have sat unflushed for over ${KLAVIYO_STALLED_MINUTES} minutes — is the klaviyo_flush job running?`
        : `${pendingStalled} Klaviyo event(s) are queued but undeliverable because no Klaviyo API key is configured (Settings → Klaviyo connection, or KLAVIYO_PRIVATE_API_KEY)`,
    );
  }
  if (deadRecent > 0) {
    parts.push(
      `${deadRecent} event(s) died undelivered in the last ${KLAVIYO_DEAD_LOOKBACK_HOURS}h (permanent rejection, retries exhausted, or dropped after 24h as stale)`,
    );
  }
  const tail = configured
    ? "Klaviyo flows are not receiving these moments — check the key's permissions, Klaviyo status and the job log."
    : "Customer lifecycle emails fall back to plain direct-SMTP delivery, but SMS and Klaviyo flows are NOT going out, and queued events are dropped after 24 hours rather than fired late.";
  return raiseAlert({
    shopId,
    type: "KLAVIYO_OUTBOX_BACKLOG",
    severity: "WARNING",
    message: `${parts.join("; ")}. ${tail}`,
    context: {
      pendingStalled,
      deadRecent,
      klaviyoConfigured: configured,
      stalledMinutes: KLAVIYO_STALLED_MINUTES,
      deadLookbackHours: KLAVIYO_DEAD_LOOKBACK_HOURS,
    },
  });
}

/**
 * Klaviyo flow coverage (v1.18.0): after the guided setup has run at least
 * once, hold the delivery checklist green — an accidentally deleted or
 * paused flow means a subscription email silently goes nowhere. The
 * underlying check refreshes its Klaviyo read at most once a day (the sweep
 * runs every 15 minutes; Klaviyo must not be polled that often) and returns
 * null whenever it cannot verify (no key, missing scopes, setup never ran)
 * — never guess, never nag.
 */
async function checkKlaviyoFlowCoverage(
  shopId: string,
  now: Date,
): Promise<boolean> {
  if (!(await isKlaviyoConfigured(shopId))) return false;
  const { staleOrMissingCoverage } = await import("~/lib/klaviyo/flows.server");
  const coverage = await staleOrMissingCoverage(shopId, now);
  if (!coverage || coverage.missing.length === 0) return false;
  return raiseAlert({
    shopId,
    type: "KLAVIYO_FLOW_COVERAGE",
    severity: "WARNING",
    message: `${coverage.missing.length} subscription email(s) have no LIVE Klaviyo flow delivering them — customers receive nothing for: ${coverage.missing.join(
      ", ",
    )}. Open Emails → Klaviyo delivery setup; one click restores them.`,
    context: { missing: coverage.missing, checkedAt: coverage.checkedAt },
  });
}

// ── Alert creation + notification ─────────────────────────────────────────────

export interface RaiseAlertInput {
  shopId: string;
  type: string;
  severity: AlertSeverity;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Create an Alert unless an unresolved one of the same type is already open
 * (dedupe), log `alert.raised`, and email admins when CRITICAL. Returns
 * whether a new alert row was created.
 *
 * Concurrency: the dedupe-then-create is serialized per (shopId, type) with a
 * Postgres transaction-scoped advisory lock (pg_advisory_xact_lock), so two
 * overlapping scans (the 15-minute runner racing a manual trigger, or two app
 * pods) can never both pass the open-alert check and create duplicates. The
 * lock is released automatically at commit/rollback. This replaces the audit's
 * find-then-create race without needing a partial unique index (which Prisma's
 * schema DSL cannot express, and which could fail to apply on books that
 * already hold historical duplicates). Advisory locks are Postgres-specific —
 * fine, the Prisma datasource is pinned to postgresql. hashtext() collisions
 * across unrelated (shop, type) pairs only cost momentary serialization, never
 * correctness.
 *
 * Exported for the few operational paths OUTSIDE the scheduled scan that must
 * surface a merchant-actionable failure (e.g. the first-order gift engine
 * hitting ACCESS_DENIED on order edits — a scope misconfiguration no scan
 * would ever notice). Callers lazy-import to keep module graphs decoupled and
 * must contain their own failures: raising an alert is never allowed to break
 * the flow that discovered the problem.
 */
export async function raiseAlert(input: RaiseAlertInput): Promise<boolean> {
  const alert = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${input.shopId}), hashtext(${input.type}))`;
    const existing = await tx.alert.findFirst({
      where: { shopId: input.shopId, type: input.type, resolvedAt: null },
      select: { id: true },
    });
    if (existing) return null;

    return tx.alert.create({
      data: {
        shopId: input.shopId,
        type: input.type,
        severity: input.severity,
        message: input.message,
        context: (input.context ?? {}) as object,
      },
    });
  });
  if (alert == null) return false;

  await logEvent({
    shopId: input.shopId,
    type: "alert.raised",
    source: "SYSTEM",
    actor: "system",
    payload: {
      alertId: alert.id,
      alertType: input.type,
      severity: input.severity,
      message: input.message,
    },
  });

  if (input.severity === "CRITICAL") {
    await notifyAdmins(alert.id, input);
  }
  return true;
}

/**
 * Email settings.alerts.emailTo via the notifications module (lazy import so
 * a broken/missing notifications build can never take alert creation down).
 * Marks Alert.notifiedAt once at least one send went through.
 */
async function notifyAdmins(alertId: string, input: RaiseAlertInput): Promise<void> {
  try {
    const alertSettings = await getSetting(input.shopId, "alerts");
    const recipients = alertSettings.emailTo.filter((e) => e.includes("@"));
    if (recipients.length === 0) return;

    const mod = (await import("~/lib/notifications/send.server")) as unknown as {
      sendNotification?: (args: {
        shopId: string;
        email: string;
        template: string;
        vars?: Record<string, unknown>;
      }) => Promise<unknown>;
    };
    if (typeof mod.sendNotification !== "function") {
      console.error("[alerts] notifications module has no sendNotification export");
      return;
    }

    let anySent = false;
    for (const email of recipients) {
      try {
        await mod.sendNotification({
          shopId: input.shopId,
          email,
          template: "admin_alert",
          vars: {
            alertId,
            alertType: input.type,
            severity: input.severity,
            message: input.message,
          },
        });
        anySent = true;
      } catch (err) {
        console.error(`[alerts] admin_alert send failed for ${email}`, err);
      }
    }

    if (anySent) {
      await prisma.alert.update({
        where: { id: alertId },
        data: { notifiedAt: new Date() },
      });
    }
  } catch (err) {
    // Notification failures are contained — the alert row itself is the record.
    console.error("[alerts] notifyAdmins failed", err);
  }
}
