/**
 * Recurring billing scheduler [core] — the heartbeat that actually charges
 * subscriptions.
 *
 * Shopify does NOT auto-bill app-owned subscription contracts: the app must
 * call subscriptionBillingAttemptCreate for every due cycle (Shopify's own
 * reference subscriptions app runs exactly this kind of scheduled job).
 * Without this job, checkout's first order succeeds and then every contract
 * sits past nextBillingDate forever — no charges, no failure webhooks, no
 * dunning. This was caught in the pre-deployment audit; the demo fleet's
 * seeded BillingAttempt rows had masked it.
 *
 * Division of labour:
 *  - THIS job creates the FIRST attempt of each billing cycle for ACTIVE
 *    contracts whose nextBillingDate has arrived.
 *  - Dunning (services/retention/dunning.server.ts) owns every retry after a
 *    failure — the scheduler never re-attempts a cycle that already has any
 *    attempt row, and it skips contracts inside an active dunning episode.
 *  - Webhooks record outcomes (recordAttemptOutcome) and advance
 *    successfulOrders, which moves the cycle index forward.
 *
 * Idempotency: cycle index = successfulOrders + 1; the underlying
 * createBillingAttempt uses the bill:<contractId>:<cycleIndex> key, and the
 * scheduler additionally skips any cycle that already has an attempt row
 * (any status), so hourly runs and concurrent duplicate runs are safe.
 *
 * Registered in the jobs registry as "billing" (RUNBOOK: every 15 minutes;
 * hourly minimum).
 */
import prisma from "~/db.server";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import { getOfflineAdmin } from "~/services/core/shopifyClient.server";
import { createBillingAttempt } from "~/services/core/billing.server";
import { billingIdempotencyKey } from "~/services/core/pure";

/** Dunning phases during which the scheduler must not touch the contract. */
const DUNNING_OWNED_PHASES: ReadonlySet<string> = new Set([
  "RETRYING",
  "GRACE",
  "FINAL_NOTICE",
]);

/**
 * Contracts more than this many days overdue are surfaced instead of billed:
 * a very stale nextBillingDate means the store ran without the scheduler (or
 * the contract predates the app) and a surprise catch-up charge months later
 * is a chargeback machine. CS reviews BILLING_STALE_SKIPPED audit rows and
 * uses the console to reschedule.
 */
const MAX_OVERDUE_DAYS = 45;

export interface BillingRunSummary {
  shop: string;
  due: number;
  attempted: number;
  skippedExistingAttempt: number;
  skippedDunning: number;
  skippedStale: number;
  failed: number;
}

export async function runBillingJob(
  shop?: string,
): Promise<BillingRunSummary[]> {
  const now = new Date();
  const staleCutoff = new Date(
    now.getTime() - MAX_OVERDUE_DAYS * 24 * 60 * 60 * 1000,
  );

  const shops = shop
    ? [shop]
    : (
        await prisma.subscriptionContract.findMany({
          where: { status: "ACTIVE", nextBillingDate: { lte: now } },
          select: { shop: true },
          distinct: ["shop"],
        })
      ).map((row) => row.shop);

  const summaries: BillingRunSummary[] = [];

  for (const currentShop of shops) {
    const summary: BillingRunSummary = {
      shop: currentShop,
      due: 0,
      attempted: 0,
      skippedExistingAttempt: 0,
      skippedDunning: 0,
      skippedStale: 0,
      failed: 0,
    };

    const due = await prisma.subscriptionContract.findMany({
      where: {
        shop: currentShop,
        status: "ACTIVE",
        nextBillingDate: { lte: now },
      },
      include: { dunningState: true },
      orderBy: { nextBillingDate: "asc" },
    });
    summary.due = due.length;

    for (const contract of due) {
      try {
        // Dunning owns the unpaid cycle — never create a competing attempt.
        if (
          contract.dunningState &&
          DUNNING_OWNED_PHASES.has(contract.dunningState.phase)
        ) {
          summary.skippedDunning += 1;
          continue;
        }

        // Long-dead schedule: surface for human review, never surprise-bill.
        if (
          contract.nextBillingDate &&
          contract.nextBillingDate < staleCutoff
        ) {
          summary.skippedStale += 1;
          await appendAudit({
            shop: currentShop,
            actorType: "SYSTEM",
            action: "BILLING_STALE_SKIPPED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: {
              nextBillingDate: contract.nextBillingDate.toISOString(),
              maxOverdueDays: MAX_OVERDUE_DAYS,
            },
          });
          continue;
        }

        // First attempt of the next unpaid cycle only. Any existing attempt
        // row for this cycle (PENDING / SUCCESS / FAILURE / CHALLENGED) means
        // either the outcome is still in flight or dunning owns the retries.
        const cycleIndex = contract.successfulOrders + 1;
        const cycleKey = billingIdempotencyKey(contract.id, cycleIndex);
        // Exact key = the scheduler's own first attempt; key + ":" prefix =
        // dunning retries of the same cycle. A bare startsWith would be wrong:
        // "bill:c1:2" is also a string-prefix of cycle 20's keys.
        const existing = await prisma.billingAttempt.findFirst({
          where: {
            contractId: contract.id,
            OR: [
              { idempotencyKey: cycleKey },
              { idempotencyKey: { startsWith: `${cycleKey}:` } },
            ],
          },
          select: { id: true },
        });
        if (existing) {
          summary.skippedExistingAttempt += 1;
          continue;
        }

        const { graphql } = await getOfflineAdmin(currentShop);
        await createBillingAttempt(graphql, currentShop, contract.id, {
          billingCycleIndex: cycleIndex,
        });
        summary.attempted += 1;
      } catch (error) {
        // Fail-soft per contract: one broken contract or Shopify hiccup must
        // never block the rest of the billing queue.
        summary.failed += 1;
        logger.error("billing job failed for contract", {
          shop: currentShop,
          contractId: contract.id,
          error: String(error),
        });
      }
    }

    if (summary.due > 0) {
      await appendAudit({
        shop: currentShop,
        actorType: "SYSTEM",
        action: "BILLING_RUN",
        subjectType: "Shop",
        subjectId: currentShop,
        payload: { ...summary },
      });
    }
    logger.info("billing job run", { ...summary });
    summaries.push(summary);
  }

  return summaries;
}
