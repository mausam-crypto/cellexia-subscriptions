import type { BillingAttempt, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import {
  addDaysTz,
  addWeeksTz,
  isDueNow,
  shopDayStartUtc,
} from "~/lib/dates.server";
import { gql, type AdminClient } from "~/lib/graphql/client.server";
import {
  createBillingAttempt,
  getBillingCycleByDate,
} from "~/lib/graphql/billingCycles.server";
import {
  applyGrantToCycle,
  getActiveDiscountForCycle,
  type ContractWithLines,
} from "./discounts.server";
import { buildMitEvidence, withThreeDsOutcome } from "./mit-evidence.server";

/**
 * Billing scheduler — the heart of the app.
 *
 * `runBillingSweep(now)` finds every ACTIVE contract of the primary shop whose
 * nextBillingDate is due (shop-timezone day semantics) with no PENDING attempt,
 * and pushes each through the pre-charge pipeline:
 *
 *   1. stockout evaluation (may delay/skip the cycle and stop here)
 *   2. resolve the Shopify billing cycle for the due date (skipped cycles
 *      advance the local mirror and stop here)
 *   3. gift engine — make sure earned gifts ride along on this cycle
 *   4. per-cycle DiscountGrant application (save offers / win-back / retention)
 *   5. subscriptionBillingAttemptCreate with the idempotency key
 *      "{contractId}:{cycleIndex}:{attemptNumber}" — double charges are
 *      impossible even if this process crashes mid-run, because Shopify
 *      dedupes on the key and the key is unique in our DB too.
 *
 * Every step is try/caught so one broken contract can never abort the sweep.
 * Attempt outcomes arrive via SUBSCRIPTION_BILLING_ATTEMPTS_* webhooks; the
 * companion `sweepStalePendingAttempts` resolves rows whose webhook never came.
 *
 * PREPAID contracts are charged exactly the same way: their selling plan's
 * billing interval already spans N deliveries (e.g. bill every 24 weeks,
 * deliver every 8), so one billing attempt pays for the whole prepaid block
 * and Shopify's delivery policy splits it into N scheduled fulfillment orders.
 * Nothing special to do here beyond charging on the billing cadence.
 */

const BATCH_SIZE = 25;
const STALE_EXPIRE_HOURS = 24;

// ── Cross-module seams (lazy imports so module graphs stay acyclic) ──────────

/** Stockout evaluation lives in the contracts module; result shape is defensive. */
type StockoutEvalFn = (shopDomain: string, contractId: string) => Promise<unknown>;

/** Did the stockout evaluation delay/skip/substitute (i.e. act) for this cycle? */
function stockoutActed(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === "boolean") return result;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.acted === "boolean") return r.acted;
    for (const key of ["action", "outcome", "policy"]) {
      const v = r[key];
      if (typeof v === "string") return v !== "NONE" && v !== "PROCEED";
    }
  }
  return false;
}

// ── Sweep ────────────────────────────────────────────────────────────────────

export interface BillingSweepStats {
  scanned: number;
  attempted: number;
  stockoutActed: number;
  cycleSkipped: number;
  discountsApplied: number;
  attemptErrors: number;
  contractErrors: number;
  skipped?: string;
}

export async function runBillingSweep(now: Date): Promise<BillingSweepStats> {
  const stats: BillingSweepStats = {
    scanned: 0,
    attempted: 0,
    stockoutActed: 0,
    cycleSkipped: 0,
    discountsApplied: 0,
    attemptErrors: 0,
    contractErrors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  // A global failure (no offline session, Shopify down) must surface as a
  // FAILED JobRun so the BILLING_RUN_FAILED alert fires — so we let it throw.
  const admin = await adminClientForShop(shop.domain);

  // Due = nextBillingDate on or before today's end in the shop timezone.
  const dueBefore = addDaysTz(shopDayStartUtc(now, tz), 1, tz);
  const candidates = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      isDemo: false, // portal-preview fixtures are never billed
      nextBillingDate: { not: null, lt: dueBefore },
      billingAttempts: { none: { status: "PENDING" } },
    },
    orderBy: { nextBillingDate: "asc" },
    select: { id: true },
  });

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batchIds = candidates.slice(i, i + BATCH_SIZE).map((c) => c.id);
    const batch = await prisma.subscriptionContract.findMany({
      where: { id: { in: batchIds } },
      include: { lines: true },
    });

    for (const contract of batch) {
      stats.scanned += 1;
      try {
        await processDueContract(
          admin,
          { id: shop.id, domain: shop.domain, tz },
          contract,
          now,
          stats,
        );
      } catch (err) {
        stats.contractErrors += 1;
        console.error("[billing] sweep failed for contract", contract.id, err);
      }
    }
  }

  return stats;
}

async function processDueContract(
  admin: AdminClient,
  shop: { id: string; domain: string; tz: string },
  contract: ContractWithLines,
  now: Date,
  stats: BillingSweepStats,
): Promise<void> {
  const nextBillingDate = contract.nextBillingDate;
  if (!nextBillingDate || !isDueNow(nextBillingDate, shop.tz, now)) return;

  // a. Stockout: the contracts module may delay the cycle, skip-and-notify or
  //    substitute the variant. When it acted, this cycle is no longer chargeable
  //    as-is — move on. A stockout failure must never block billing.
  try {
    const { evaluateStockoutForContract } = await import(
      "~/lib/contracts/stockout.server"
    );
    const result = await (
      evaluateStockoutForContract as unknown as StockoutEvalFn
    )(shop.domain, contract.id);
    if (stockoutActed(result)) {
      stats.stockoutActed += 1;
      return;
    }
  } catch (err) {
    console.error("[billing] stockout evaluation failed", contract.id, err);
  }

  // b. Resolve the Shopify billing cycle for the due date. Both the gift and
  //    the discount step target this exact cycle, and a skipped cycle must
  //    short-circuit before either of them mutates it.
  const cycle = await getBillingCycleByDate(
    admin,
    contract.shopifyContractId,
    nextBillingDate,
  );
  if (!cycle) {
    throw new Error(
      `No billing cycle resolved for ${contract.shopifyContractId} at ${nextBillingDate.toISOString()}`,
    );
  }
  const cycleIndex = cycle.cycleIndex;

  if (cycle.skipped || cycle.status === "BILLED") {
    // Customer skipped this cycle (or a missed webhook left the mirror behind
    // an already-billed cycle): advance the local pointer and let webhooks /
    // sync correct any drift.
    const newNext = addWeeksTz(
      nextBillingDate,
      Math.max(1, contract.intervalWeeks),
      shop.tz,
    );
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: newNext },
    });
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "contract.next_date_changed",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        reason: cycle.skipped ? "cycle_skipped" : "cycle_already_billed",
        cycleIndex,
        from: nextBillingDate.toISOString(),
        to: newNext.toISOString(),
      },
    });
    stats.cycleSkipped += 1;
    return;
  }

  // c. Gifts: make sure every earned gift grant is attached to this cycle
  //    before we charge. Gift failures never block billing.
  try {
    const { ensureGiftsForUpcomingCycle } = await import(
      "~/lib/gifts/engine.server"
    );
    await ensureGiftsForUpcomingCycle(contract.id, cycleIndex);
  } catch (err) {
    console.error("[billing] gift ensure failed", contract.id, err);
  }

  // d. Per-cycle discount: apply the best live DiscountGrant to this cycle
  //    only (billing-cycle contract edit — never a discount code).
  try {
    const grant = await getActiveDiscountForCycle(contract.id, cycleIndex);
    if (grant) {
      const applied = await applyGrantToCycle(
        admin,
        shop,
        contract,
        grant,
        cycleIndex,
      );
      if (applied) stats.discountsApplied += 1;
    }
  } catch (err) {
    console.error("[billing] discount application failed", contract.id, err);
  }

  // e. The attempt. idempotencyKey uses the LOCAL contract id per the golden
  //    rules; unique in DB and passed to Shopify, so a crash between the local
  //    insert and the API call can never double-charge.
  const priorAttempts = await prisma.billingAttempt.count({
    where: { contractId: contract.id, cycleIndex },
  });
  const attemptNumber = priorAttempts + 1;
  const idempotencyKey = `${contract.id}:${cycleIndex}:${attemptNumber}`;
  const scheduledFor = nextBillingDate;

  const attempt = await prisma.billingAttempt.create({
    data: {
      contractId: contract.id,
      idempotencyKey,
      cycleIndex,
      attemptNumber,
      status: "PENDING",
      scheduledFor,
      originatingAction: "SCHEDULER",
      mitEvidence: buildMitEvidence({
        consentOrder: contract.originOrderId,
        originatingAction: "SCHEDULER",
        timestamp: now,
      }),
    },
  });

  await logEvent({
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "billing.attempt_scheduled",
    source: "SCHEDULER",
    actor: "system",
    payload: {
      attemptId: attempt.id,
      cycleIndex,
      attemptNumber,
      idempotencyKey,
      scheduledFor: scheduledFor.toISOString(),
      isPrepaid: contract.isPrepaid,
    },
  });

  try {
    const originTime = scheduledFor <= now ? scheduledFor : now;
    const result = await createBillingAttempt(
      admin,
      contract.shopifyContractId,
      { idempotencyKey, originTime, cycleIndex },
    );

    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: { shopifyAttemptId: result.attemptId, startedAt: new Date() },
    });
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "billing.attempt_started",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        attemptId: attempt.id,
        shopifyAttemptId: result.attemptId,
        cycleIndex,
        attemptNumber,
        ready: result.ready,
      },
    });

    // Optimistically advance the local schedule pointer so the next sweep
    // doesn't re-process this contract; the CONTRACTS_UPDATE / billing-attempt
    // webhooks correct it whenever Shopify lands on a different date.
    const newNext = addWeeksTz(
      scheduledFor,
      Math.max(1, contract.intervalWeeks),
      shop.tz,
    );
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: newNext },
    });

    stats.attempted += 1;
  } catch (err) {
    // f. Shopify rejected the attempt creation itself (invalid payment method,
    //    contract state, API error): fail the local row and open dunning.
    const message = err instanceof Error ? err.message : String(err);
    stats.attemptErrors += 1;

    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorMessage: message,
      },
    });
    await logEvent({
      shopId: shop.id,
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      type: "billing.attempt_failed",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        attemptId: attempt.id,
        cycleIndex,
        attemptNumber,
        error: message,
        stage: "attempt_create",
      },
    });

    try {
      const { onBillingAttemptFailed } = await import(
        "~/lib/dunning/engine.server"
      );
      await onBillingAttemptFailed(attempt.id);
    } catch (dunningErr) {
      console.error("[billing] dunning hand-off failed", attempt.id, dunningErr);
    }
  }
}

// ── Stale PENDING attempt sweep ──────────────────────────────────────────────

const ATTEMPT_STATUS_QUERY = `#graphql
  query CellexiaBillingAttemptStatus($id: ID!) {
    subscriptionBillingAttempt(id: $id) {
      id
      ready
      errorCode
      errorMessage
      nextActionUrl
      order {
        id
        name
      }
    }
  }
`;

interface AttemptStatusResponse {
  subscriptionBillingAttempt?: {
    id?: string | null;
    ready?: boolean | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    nextActionUrl?: string | null;
    order?: { id?: string | null; name?: string | null } | null;
  } | null;
}

export interface StaleSweepStats {
  checked: number;
  succeeded: number;
  failed: number;
  challenged: number;
  expired: number;
  unresolved: number;
  skipped?: string;
}

type StaleAttempt = BillingAttempt & { contract: SubscriptionContract };

/**
 * Resolve local attempts stuck PENDING because their outcome webhook never
 * arrived (delivery failure, downtime during the delivery window). Re-queries
 * Shopify for the truth; anything unresolvable after 24h is marked EXPIRED
 * and raises an admin alert.
 */
export async function sweepStalePendingAttempts(
  olderThanHours = 2,
): Promise<StaleSweepStats> {
  const stats: StaleSweepStats = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    challenged: 0,
    expired: 0,
    unresolved: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanHours * 3_600_000);
  const stale = (await prisma.billingAttempt.findMany({
    where: {
      status: "PENDING",
      contract: { shopId: shop.id, isDemo: false },
      OR: [
        { startedAt: { lte: cutoff } },
        { startedAt: null, scheduledFor: { lte: cutoff } },
      ],
    },
    include: { contract: true },
    orderBy: { scheduledFor: "asc" },
    take: 100,
  })) as StaleAttempt[];

  if (stale.length === 0) return stats;

  // Status queries need an admin client; expiry of ancient rows does not.
  let admin: AdminClient | null = null;
  try {
    admin = await adminClientForShop(shop.domain);
  } catch (err) {
    console.error("[billing] stale sweep: no admin client", err);
  }

  for (const attempt of stale) {
    stats.checked += 1;
    try {
      await resolveStaleAttempt(
        admin,
        { id: shop.id, domain: shop.domain },
        attempt,
        now,
        stats,
      );
    } catch (err) {
      stats.unresolved += 1;
      console.error("[billing] stale attempt resolution failed", attempt.id, err);
    }
  }

  return stats;
}

async function resolveStaleAttempt(
  admin: AdminClient | null,
  shop: { id: string; domain: string },
  attempt: StaleAttempt,
  now: Date,
  stats: StaleSweepStats,
): Promise<void> {
  const contract = attempt.contract;
  const shopId = shop.id;
  const eventBase = {
    shopId,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  } as const;

  let info: AttemptStatusResponse["subscriptionBillingAttempt"] = null;
  if (admin && attempt.shopifyAttemptId) {
    try {
      const data = await gql<AttemptStatusResponse>(admin, ATTEMPT_STATUS_QUERY, {
        id: attempt.shopifyAttemptId,
      });
      info = data.subscriptionBillingAttempt ?? null;
    } catch (err) {
      console.error(
        "[billing] stale sweep status query failed",
        attempt.shopifyAttemptId,
        err,
      );
    }
  }

  // ── Resolved on Shopify: mirror the outcome and run the dunning hooks ──────
  if (info?.order?.id) {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "SUCCESS",
        completedAt: now,
        orderId: info.order.id ?? null,
        orderName: info.order.name ?? null,
      },
    });
    await logEvent({
      ...eventBase,
      type: "billing.attempt_succeeded",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        orderId: info.order.id,
        resolvedBy: "stale_sweep",
      },
    });
    try {
      const { onBillingAttemptSucceeded } = await import(
        "~/lib/dunning/engine.server"
      );
      await onBillingAttemptSucceeded(attempt.id);
    } catch (err) {
      console.error("[billing] success hand-off failed", attempt.id, err);
    }
    try {
      // The success webhook was missed, so re-sync the mirror from Shopify.
      const svc = await import("~/lib/contracts/service.server");
      await (
        svc.syncContractFromShopify as unknown as (
          shopDomain: string,
          shopifyContractGid: string,
        ) => Promise<unknown>
      )(shop.domain, contract.shopifyContractId);
    } catch (err) {
      console.error("[billing] post-success sync failed", contract.id, err);
    }
    stats.succeeded += 1;
    return;
  }

  if (info?.nextActionUrl) {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "CHALLENGED",
        declineCategory: "AUTH_REQUIRED",
        // Fold the 3DS outcome into the stored-credential evidence blob.
        mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
          challenged: true,
          redirectIssued: true,
          challengedAt: now.toISOString(),
          resolution: "PENDING_CUSTOMER_ACTION",
        }),
      },
    });
    await logEvent({
      ...eventBase,
      type: "billing.attempt_challenged",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        redirectUrl: info.nextActionUrl,
        resolvedBy: "stale_sweep",
      },
    });
    try {
      const { onBillingAttemptChallenged } = await import(
        "~/lib/dunning/engine.server"
      );
      await onBillingAttemptChallenged(attempt.id, info.nextActionUrl);
    } catch (err) {
      console.error("[billing] challenge hand-off failed", attempt.id, err);
    }
    stats.challenged += 1;
    return;
  }

  if (info?.errorCode || info?.errorMessage) {
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        completedAt: now,
        errorCode: info.errorCode ?? null,
        errorMessage: info.errorMessage ?? null,
      },
    });
    await logEvent({
      ...eventBase,
      type: "billing.attempt_failed",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        attemptId: attempt.id,
        cycleIndex: attempt.cycleIndex,
        errorCode: info.errorCode,
        error: info.errorMessage,
        resolvedBy: "stale_sweep",
      },
    });
    try {
      const { onBillingAttemptFailed } = await import(
        "~/lib/dunning/engine.server"
      );
      await onBillingAttemptFailed(attempt.id);
    } catch (err) {
      console.error("[billing] failure hand-off failed", attempt.id, err);
    }
    stats.failed += 1;
    return;
  }

  // ── Still unresolved: expire after 24h and alert, otherwise wait ───────────
  const ageBasis = attempt.startedAt ?? attempt.scheduledFor;
  const expireBefore = new Date(now.getTime() - STALE_EXPIRE_HOURS * 3_600_000);
  if (ageBasis > expireBefore) {
    stats.unresolved += 1;
    return;
  }

  await prisma.billingAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "EXPIRED",
      completedAt: now,
      errorMessage: `Unresolved after ${STALE_EXPIRE_HOURS}h (no webhook, no Shopify status)`,
    },
  });
  await logEvent({
    ...eventBase,
    type: "billing.attempt_failed",
    source: "SCHEDULER",
    actor: "system",
    payload: {
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      reason: "expired_unresolved",
      shopifyAttemptId: attempt.shopifyAttemptId,
    },
  });

  try {
    const alert = await prisma.alert.create({
      data: {
        shopId,
        type: "STUCK_CONTRACTS",
        severity: "WARNING",
        message: `Billing attempt stuck PENDING for over ${STALE_EXPIRE_HOURS}h was marked EXPIRED (contract ${contract.shopifyContractId}).`,
        context: {
          attemptId: attempt.id,
          contractId: contract.id,
          shopifyAttemptId: attempt.shopifyAttemptId,
          cycleIndex: attempt.cycleIndex,
        },
      },
    });
    await logEvent({
      ...eventBase,
      type: "alert.raised",
      source: "SCHEDULER",
      actor: "system",
      payload: { alertId: alert.id, alertType: "STUCK_CONTRACTS", attemptId: attempt.id },
    });
  } catch (err) {
    console.error("[billing] expired-attempt alert failed", attempt.id, err);
  }

  stats.expired += 1;
}
