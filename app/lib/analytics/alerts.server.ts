import prisma from "~/db.server";
import { subDays, subHours } from "date-fns";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { shopDayStartUtc } from "~/lib/dates.server";
import { requireShopById } from "./queries.server";

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

  const checks: [string, () => Promise<boolean | null>][] = [
    ["BILLING_RUN_FAILED", () => checkBillingRunFailed(shopId, now)],
    ["WEBHOOK_FAILURES", () => checkWebhookFailures(shopId, shopDomain, now)],
    ["STUCK_CONTRACTS", () => checkStuckContracts(shopId, now)],
    ["FAILURE_SPIKE", () => checkFailureSpike(shopId, tz, now)],
    ["CHURN_SPIKE", () => checkChurnSpike(shopId, tz, now)],
    ["FAST_SHIPPING_SKIPS", () => checkFastShippingSkips(shopId, now)],
    [
      "STOCKOUT_RENEWALS",
      () => checkStockoutRenewals(shopId, now, opts.variantAvailability),
    ],
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

// ── Individual checks (return true = alert created, false = all clear, null = skipped) ──

/** CRITICAL when any billing_run JobRun FAILED in the last 24h. */
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

/** CRITICAL when ≥5 webhook receipts FAILED processing within the last hour. */
async function checkWebhookFailures(
  shopId: string,
  shopDomain: string,
  now: Date,
): Promise<boolean> {
  const failed = await prisma.webhookReceipt.count({
    where: {
      shopDomain,
      status: "FAILED",
      receivedAt: { gte: subHours(now, 1) },
    },
  });
  if (failed < 5) return false;

  return raiseAlert({
    shopId,
    type: "WEBHOOK_FAILURES",
    severity: "CRITICAL",
    message: `${failed} webhook deliveries failed processing in the last hour. Local contract state may be drifting from Shopify.`,
    context: { failedLastHour: failed },
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
      isDemo: false, // preview fixtures are never billed, so never "stuck"
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
        contract: { shopId },
        status: "FAILED",
        completedAt: { gte: todayStart, lte: now },
      },
    }),
    prisma.billingAttempt.count({
      where: {
        contract: { shopId },
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

  const [todayCancels, baselineCancels] = await Promise.all([
    prisma.subscriptionContract.count({
      where: { shopId, isDemo: false, cancelledAt: { gte: todayStart, lte: now } },
    }),
    prisma.subscriptionContract.count({
      where: {
        shopId,
        isDemo: false,
        cancelledAt: { gte: baselineStart, lt: todayStart },
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
    where: { shopId, status: "ACTIVE", isDemo: false, skipCount: { gte: 2 } },
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
      isDemo: false,
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

// ── Alert creation + notification ─────────────────────────────────────────────

interface RaiseAlertInput {
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
 */
async function raiseAlert(input: RaiseAlertInput): Promise<boolean> {
  const existing = await prisma.alert.findFirst({
    where: { shopId: input.shopId, type: input.type, resolvedAt: null },
    select: { id: true },
  });
  if (existing) return false;

  const alert = await prisma.alert.create({
    data: {
      shopId: input.shopId,
      type: input.type,
      severity: input.severity,
      message: input.message,
      context: (input.context ?? {}) as object,
    },
  });

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
