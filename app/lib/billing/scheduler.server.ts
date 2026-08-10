import type { BillingAttempt, Prisma, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import {
  addDaysTz,
  addIntervalTz,
  isDueNow,
  shopDayStartUtc,
} from "~/lib/dates.server";
import { contractFrequency } from "~/lib/frequency";
import {
  gql,
  ShopifyUserError,
  type AdminClient,
} from "~/lib/graphql/client.server";
import {
  createBillingAttempt,
  getBillingCycleByDate,
} from "~/lib/graphql/billingCycles.server";
import { getOrderSummary } from "~/lib/graphql/orders.server";
import { fetchNextBillingDate } from "~/lib/contracts/shared.server";
import {
  computeChargeCostSnapshot,
  loadCostContext,
  type ChargeCostSnapshot,
} from "~/lib/analytics/costs.server";
import { structuredUserErrorCode } from "~/lib/dunning/decline-codes.server";
import {
  applyGrantToCycle,
  getActiveDiscountForCycle,
  type ContractWithLines,
} from "./discounts.server";
import { buildMitEvidence, withThreeDsOutcome } from "./mit-evidence.server";
import {
  OURS_ONLY,
  isBillableOwnership,
} from "~/lib/ownership/ownership.server";

/**
 * Billing scheduler — the heart of the app.
 *
 * `runBillingSweep(now)` finds every ACTIVE contract of the primary shop whose
 * nextBillingDate is due (shop-timezone day semantics) with no in-flight
 * attempt (an un-started SCHEDULER residue row does not count — see the b2
 * resume exception), and pushes each through the pre-charge pipeline:
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
 * billing interval already spans N deliveries (the billing interval is N
 * delivery intervals long, whatever unit the plan uses), so one billing
 * attempt pays for the whole prepaid block and Shopify's delivery policy
 * splits it into N scheduled fulfillment orders. Nothing special to do here
 * beyond charging on the billing cadence.
 */

const BATCH_SIZE = 25;
const STALE_EXPIRE_HOURS = 24;
/**
 * How far back a sweep-settled success may backdate completedAt/firstChargeAt
 * to the order's real charge instant. Must stay within rollup_run's trailing
 * recompute window — see the same constant in webhooks/handlers.server.ts.
 */
const MAX_CHARGE_BACKDATE_MS = 86_400_000;
/**
 * How long past settings.dunning.cancelAfterFailedDays a CHALLENGED attempt
 * keeps its Shopify re-query lane in the stale sweep. The dunning case
 * chasing the challenge exhausts on that setting (measured from case open, ≈
 * attempt start for the trigger scenario) — beyond it plus this grace, a
 * still-CHALLENGED row is a closed case's residue, not worth a Shopify round
 * trip every sweep. Operational bound, not policy: the policy window itself
 * comes from the settings registry.
 */
const CHALLENGED_RECHECK_GRACE_DAYS = 7;

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
  /** Cycles skipped because their attempt history says the sweep no longer owns them. */
  cycleHeld: number;
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
    cycleHeld: 0,
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
      // Only OUR contracts are ever charged. The shop may run a second
      // subscription app whose contracts arrive on the same webhooks and get
      // mirrored here; billing one of those would charge the customer twice
      // (once by us, once by the other app). UNKNOWN is unbillable too.
      ...OURS_ONLY,
      status: "ACTIVE",
      isDemo: false, // portal-preview fixtures are never billed
      nextBillingDate: { not: null, lt: dueBefore },
      // No in-flight attempt may block a contract twice — but an un-started
      // SCHEDULER residue row (PENDING, never confirmed by Shopify: transport
      // error or crash between the local insert and the API call) is exactly
      // what the sweep must come back for, so it does NOT exclude. Dunning's
      // un-started PENDING rows (fireRetry backoff) still exclude: their
      // pacing belongs to the dunning engine.
      billingAttempts: {
        none: {
          status: "PENDING",
          OR: [
            { startedAt: { not: null } },
            { originatingAction: { not: "SCHEDULER" } },
          ],
        },
      },
    },
    orderBy: { nextBillingDate: "asc" },
    select: { id: true },
  });

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batchIds = candidates.slice(i, i + BATCH_SIZE).map((c) => c.id);
    const batch = await prisma.subscriptionContract.findMany({
      where: { id: { in: batchIds }, ...OURS_ONLY },
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
    // an already-billed cycle): advance the local pointer. Shopify's own
    // nextBillingDate is preferred — for MONTH cadences the local calendar
    // step clamps month-ends (Feb 28 + 1 month = Mar 28) while Shopify keeps
    // the contract's anchor (Mar 31), and a clamped pointer would resolve the
    // wrong cycle on the next sweep. The local unit step is the fallback when
    // the read fails or has not advanced past the stale pointer.
    const freq = contractFrequency(contract);
    const shopifyNext = await fetchNextBillingDate(
      admin,
      contract.shopifyContractId,
      null,
    );
    const newNext =
      shopifyNext && shopifyNext.getTime() > nextBillingDate.getTime()
        ? shopifyNext
        : addIntervalTz(nextBillingDate, freq.unit, freq.count, shop.tz);
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

  // b2. Cycle-history guard — the sweep may only ever open the FIRST attempt
  //     for a cycle. Sweep eligibility must not hinge on nextBillingDate: that
  //     mirror field is mutable in ways the sweep cannot control (it is not
  //     advanced when the attempt-create call throws, and syncContractFromShopify
  //     / the billing-cycle-edit webhook rewrite it to Shopify's value, which
  //     stays parked on an unbilled failed cycle). Without this check the
  //     5-minute sweep becomes an uncontrolled retry engine: every tick mints a
  //     fresh idempotency key (attemptNumber+1) for the same failed cycle and
  //     re-charges a declining card outside the dunning ladder's pacing.
  //     The attempt history is append-only ground truth:
  //       - newest FAILED / CHALLENGED → the dunning engine owns every further
  //         attempt for this cycle (fireRetry / onPaymentMethodUpdated);
  //       - newest EXPIRED → outcome unknown or parked by dunning; retrying
  //         blind risks a double charge, and the stale sweep / STUCK_CONTRACTS
  //         alert already surfaced it to the admin;
  //       - newest SUCCESS with the pointer still here → mirror lag; webhooks /
  //         sync own the pointer advance (re-attempting would double-charge);
  //       - newest PENDING that Shopify confirmed (startedAt/shopifyAttemptId
  //         set) never reaches here (candidate query excludes it), and a
  //         dunning-owned un-started PENDING row is held for fireRetry.
  //     ONE exception — the sweep's OWN un-started residue: a PENDING row with
  //     no shopifyAttemptId/startedAt whose originatingAction is SCHEDULER
  //     means the attempt-create call never confirmably reached Shopify
  //     (transport error, or a crash between the local insert and the API
  //     call). The card's fate is unknown, NOT failed — so the cycle is still
  //     the sweep's to fire, re-fired with the SAME idempotency key: Shopify's
  //     key dedupe makes the re-fire charge-safe even if the original call was
  //     actually accepted (the outcome webhook then matches this row by
  //     idempotency key). The stale sweep's 24h expiry remains the backstop if
  //     the transport never recovers.
  //     Superseded rows (supersededAt set, migration 0013) are invisible to
  //     this guard: they are terminal attempts of a CLOSED churn episode,
  //     stamped by win-back reactivation after the dunning case resolved —
  //     with the contract ACTIVE again no engine would EVER create another
  //     attempt for the cycle, so an unbilled failed cycle that the
  //     reactivation parked the pointer inside would otherwise be held
  //     forever (reactivated-but-never-billed). The fresh attempt this
  //     unlocks is a first attempt in every way that matters: attemptNumber
  //     still counts superseded rows, so its idempotency key is new and
  //     unique — and if it fails, dunning opens a new case exactly as for
  //     any first failure.
  const newestForCycle = await prisma.billingAttempt.findFirst({
    where: { contractId: contract.id, cycleIndex, supersededAt: null },
    orderBy: { attemptNumber: "desc" },
  });
  const resumable =
    newestForCycle != null &&
    newestForCycle.status === "PENDING" &&
    newestForCycle.startedAt == null &&
    newestForCycle.shopifyAttemptId == null &&
    newestForCycle.originatingAction === "SCHEDULER";
  if (newestForCycle && !resumable) {
    stats.cycleHeld += 1;
    return;
  }

  let attempt: BillingAttempt;
  if (newestForCycle) {
    // Resume the un-started row. Gifts/discounts (c, d) already ran when the
    // row was first opened — applyGrantToCycle consumes a grant cycle when it
    // applies the pre-charge edit, so re-running it here could double-apply.
    attempt = newestForCycle;
  } else {
    // c. Gifts: make sure every earned gift grant is attached to this cycle
    //    before we charge. Gift failures never block billing. Both index
    //    spaces are passed: cycleIndex is the resolved Shopify cycle (attach
    //    target), ordersCount + 1 is the ORDER this charge will become —
    //    ORDER_INDEX gift rules match on the latter, so "gift on your Nth
    //    order" survives skipped cycles (which shift the cycle index but not
    //    the order number).
    try {
      const { ensureGiftsForUpcomingCycle } = await import(
        "~/lib/gifts/engine.server"
      );
      await ensureGiftsForUpcomingCycle(
        contract.id,
        cycleIndex,
        contract.ordersCount + 1,
      );
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
    //    rules; unique in DB and passed to Shopify, so a crash between the
    //    local insert and the API call can never double-charge.
    const priorAttempts = await prisma.billingAttempt.count({
      where: { contractId: contract.id, cycleIndex },
    });
    const attemptNumber = priorAttempts + 1;

    attempt = await prisma.billingAttempt.create({
      data: {
        contractId: contract.id,
        idempotencyKey: `${contract.id}:${cycleIndex}:${attemptNumber}`,
        cycleIndex,
        attemptNumber,
        status: "PENDING",
        scheduledFor: nextBillingDate,
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
        idempotencyKey: attempt.idempotencyKey,
        scheduledFor: nextBillingDate.toISOString(),
        isPrepaid: contract.isPrepaid,
      },
    });
  }

  const scheduledFor = nextBillingDate;
  const idempotencyKey = attempt.idempotencyKey;
  const attemptNumber = attempt.attemptNumber;

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
    const freq = contractFrequency(contract);
    const newNext = addIntervalTz(scheduledFor, freq.unit, freq.count, shop.tz);
    await prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: { nextBillingDate: newNext },
    });

    stats.attempted += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stats.attemptErrors += 1;

    // f1. Transport-level error (timeout, 502, network reset — anything that
    //     is NOT a Shopify userError refusal): the card was never verifiably
    //     attempted, so this must not be recorded as a payment failure —
    //     marking it FAILED would open a dunning case with errorCode null
    //     (categorized SOFT) and email "your payment failed" to a customer
    //     whose card was never touched; and if Shopify actually accepted the
    //     timed-out call, the charge succeeds while the false alarm is
    //     already out. Mirror of fireRetry's transient branch (dunning
    //     engine): leave the row PENDING with its idempotency key intact —
    //     the next 5-minute tick resumes it (b2 exception) and Shopify's key
    //     dedupe makes the re-fire charge-safe; if the call DID land, the
    //     outcome webhook settles this row by idempotency key. The stale
    //     sweep expires a row that never resolves (24h) and raises
    //     STUCK_CONTRACTS — no customer email either way.
    if (!(err instanceof ShopifyUserError)) {
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
          rescheduled: true,
          reason: "attempt_create_transient",
          error: message,
        },
      });
      return;
    }

    // f2. Shopify refused the attempt creation itself (invalid payment
    //    method, contract state — a real userError): fail the local row and
    //    open dunning. nextBillingDate is deliberately NOT advanced here —
    //    the cycle is unbilled and dunning may still recover it — and the
    //    FAILED row we write below is exactly what the cycle-history guard
    //    (b2) keys on, so the next tick can never re-attempt this cycle.
    //    The structured refusal code is persisted alongside the message:
    //    errorCode null reads as an unknown SOFT decline downstream
    //    (categorizeDeclineCode), scheduling a retry ladder for refusals a
    //    retry can never fix. Read structurally — non-null once the GraphQL
    //    layer's userErrors selection carries `code`.
    const refusalCode = structuredUserErrorCode(err.errors);
    await prisma.billingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorCode: refusalCode,
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
        errorCode: refusalCode,
        error: message,
        stage: "attempt_create",
        // outcome/superseded discriminate the overloaded event type for
        // event-derived features: a create refusal is a REAL failure of the
        // cycle's charge, unlike the stale sweep's EXPIRED_UNKNOWN rows.
        outcome: "FAILED",
        superseded: false,
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
 * Resolve local attempts stuck in a non-terminal state because their outcome
 * webhook never arrived (delivery failure, downtime during the delivery
 * window). Re-queries Shopify for the truth. Two lanes:
 *  - PENDING rows: anything unresolvable after 24h is marked EXPIRED and
 *    raises an admin alert;
 *  - CHALLENGED rows: the 3DS outcome is webhook-ONLY (the CONFIRM_3DS magic
 *    link just redirects to the bank), so a lost SUCCESS webhook would leave
 *    a PAID charge permanently unrecorded while the dunning case times out
 *    and fails/cancels the paying customer. They get the same re-query lane
 *    within the window where the outcome still matters
 *    (cancelAfterFailedDays + grace), and are never expired here — the
 *    dunning sweep's timeout owns their case's lifetime.
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

  // The CHALLENGED lane's floor: past cancelAfterFailedDays (+ grace) a
  // still-CHALLENGED row is an exhausted case's residue and stops being worth
  // a Shopify round trip every sweep. A settings failure downgrades to the
  // PENDING-only sweep rather than aborting it.
  let challengedFloor: Date | null = null;
  try {
    const dunning = await getSetting(shop.id, "dunning");
    challengedFloor = new Date(
      now.getTime() -
        (dunning.cancelAfterFailedDays + CHALLENGED_RECHECK_GRACE_DAYS) *
          86_400_000,
    );
  } catch (err) {
    console.error("[billing] stale sweep: dunning settings unavailable", err);
  }

  const staleAge: Prisma.BillingAttemptWhereInput[] = [
    { startedAt: { lte: cutoff } },
    { startedAt: null, scheduledFor: { lte: cutoff } },
  ];
  const stale = (await prisma.billingAttempt.findMany({
    where: {
      // Another app's contracts can never have one of our attempts, but the
      // sweep resolves them against Shopify and can FAIL/EXPIRE them — keep it
      // strictly on our own book.
      contract: { shopId: shop.id, isDemo: false, ...OURS_ONLY },
      OR: [
        { status: "PENDING", OR: staleAge },
        ...(challengedFloor
          ? [
              {
                status: "CHALLENGED",
                OR: [
                  { startedAt: { lte: cutoff, gte: challengedFloor } },
                  {
                    startedAt: null,
                    scheduledFor: { lte: cutoff, gte: challengedFloor },
                  },
                ],
              } satisfies Prisma.BillingAttemptWhereInput,
            ]
          : []),
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
    // The success webhook never arrived, so this sweep owns the FULL success
    // bookkeeping the webhook would have done: the charged amount (or the
    // charge enters rollup/cohort revenue as 0) and the contract counters
    // (or cycle indexing and lifetime revenue stay stale).
    // Hoisted out of the transaction closure below: TS narrowing on the
    // `info?.order?.id` branch check does not survive into an async closure.
    const orderId = info.order.id;
    let amountCents: number | null = null;
    let orderCurrency: string | null = null;
    let orderName: string | null = info.order.name ?? null;
    // The charge instant: the order's createdAt is when Shopify actually
    // charged, and a stale sweep by definition runs HOURS after that —
    // stamping sweep time would push the charge into the wrong rollup day
    // (and a first charge into the wrong cohort month). Sweep time is only
    // the fallback when the summary fetch failed or the order is older than
    // MAX_CHARGE_BACKDATE_MS: backdating past rollup_run's trailing
    // recompute window would strand the charge in a closed rollup row that
    // is never recomputed.
    let chargedAt = now;
    // The renewal order's money breakdown (discount/tax/shipping/subtotal +
    // processedAt) rides the settlement onto the attempt row, so rollup and
    // cohort math report net-of-tax revenue and real discount spend instead
    // of estimating them — same capture the webhook settlement performs.
    let orderBreakdown: {
      discountCents: number;
      taxCents: number;
      shippingCents: number;
      subtotalCents: number;
      orderProcessedAt: Date | null;
    } | null = null;
    if (admin) {
      try {
        const summary = await getOrderSummary(admin, info.order.id);
        amountCents = summary.totalCents;
        orderCurrency = summary.currencyCode;
        orderName = summary.name || orderName;
        orderBreakdown = {
          discountCents: summary.discountsCents,
          taxCents: summary.taxCents,
          shippingCents: summary.shippingCents,
          subtotalCents: summary.subtotalCents,
          orderProcessedAt: summary.processedAt,
        };
        if (
          summary.createdAt != null &&
          now.getTime() - summary.createdAt.getTime() <= MAX_CHARGE_BACKDATE_MS
        ) {
          chargedAt = summary.createdAt;
        }
      } catch (err) {
        console.error(
          "[billing] stale sweep order summary failed",
          info.order.id,
          err,
        );
      }
    }

    // The charge's cost basis, frozen at settlement (BillingAttempt.
    // costSnapshot): rollup/cohorts PREFER the stored snapshot so
    // gross-profit history stops being repriced by later cost-setting edits,
    // and fall back to live resolution when it is absent. Strictly contained
    // — a cost-model failure must never block recording a real charge.
    let costSnapshot: ChargeCostSnapshot | null = null;
    try {
      const [costCtx, lines] = await Promise.all([
        loadCostContext(shop.id),
        prisma.contractLine.findMany({ where: { contractId: contract.id } }),
      ]);
      // Add-ons staged for OTHER cycles are excluded with the exact
      // cycle-scope rule consumeCycleOnSuccess applies below — the same
      // filter the webhook path's snapshot uses. Without it, a future-cycle
      // add-on mirror still staged during the stale window would book its
      // COGS into THIS charge's frozen basis and then book AGAIN when its
      // own cycle settles.
      const billedLines = lines.filter(
        (l) =>
          !l.isOneTimeAddon ||
          l.addonCycleIndex == null ||
          l.addonCycleIndex === attempt.cycleIndex,
      );
      costSnapshot = computeChargeCostSnapshot(costCtx, {
        deliveryPriceCents: contract.deliveryPriceCents,
        isPrepaid: contract.isPrepaid,
        prepaidDeliveriesPerCharge: contract.prepaidDeliveriesPerCharge,
        lines: billedLines,
      });
    } catch (err) {
      console.error("[billing] stale sweep cost snapshot failed", attempt.id, err);
    }

    // The settlement machinery is SHARED with handleBillingAttemptSuccess:
    // one settlement, two claim winners. The sweep must never hand-roll a
    // subset of the webhook's bookkeeping — that is exactly how a lost
    // success webhook used to strand a phantom one-time add-on mirror (its
    // permanently-unique addClaimKey then blocked every future re-add of the
    // variant) and leave the cycle's gift grants ADDED forever.
    const { consumeCycleOnSuccess, finishSuccessSettlement } = await import(
      "~/lib/webhooks/handlers.server"
    );

    // Status-guarded claim: the success webhook (or a rival sweep instance)
    // may settle this attempt between our read and this write — exactly one
    // writer wins the transition, so counters can never double-increment.
    // Claim + counter increment + cycle consumption (add-on mirror clearing,
    // gift ADDED → SHIPPED) commit in ONE transaction (the same crash
    // contract as handleBillingAttemptSuccess): a process death can never
    // strand a SUCCESS attempt whose contract accounting is lost forever.
    const claimed = await prisma.$transaction(async (tx) => {
      const claim = await tx.billingAttempt.updateMany({
        where: { id: attempt.id, status: { not: "SUCCESS" } },
        data: {
          status: "SUCCESS",
          completedAt: chargedAt,
          orderId,
          orderName,
          ...(amountCents != null
            ? {
                amountCents,
                currencyCode: orderCurrency ?? contract.currencyCode,
              }
            : {}),
          ...(orderBreakdown ?? {}),
          ...(costSnapshot
            ? { costSnapshot: costSnapshot as unknown as Prisma.InputJsonObject }
            : {}),
        },
      });
      if (claim.count === 0) return null;

      // The charged cycle consumed its one-time add-ons and shipped its
      // gifts — same helper, same transaction placement as the webhook path.
      const consumed = await consumeCycleOnSuccess(
        tx,
        contract.id,
        attempt.cycleIndex,
      );

      const contractRow = await tx.subscriptionContract.findUniqueOrThrow({
        where: { id: contract.id },
        select: { firstChargeAt: true },
      });
      await tx.subscriptionContract.update({
        where: { id: contract.id },
        data: {
          ordersCount: { increment: 1 },
          lifetimeRevenueCents: { increment: amountCents ?? 0 },
          // Renewals-only, mirroring lifetimeRevenueCents: origin (checkout)
          // discount is booked on the contract at sync, never here.
          ...(orderBreakdown
            ? {
                lifetimeDiscountCents: {
                  increment: orderBreakdown.discountCents,
                },
              }
            : {}),
          ...(contractRow.firstChargeAt ? {} : { firstChargeAt: chargedAt }),
          // Prepaid delivery countdown re-arm — the sweep is a claim winner
          // like the webhook path and must not hand-roll a subset of its
          // bookkeeping: a successful prepaid charge pays for a fresh
          // per-charge allotment (see the webhook claim's comment).
          ...(contract.isPrepaid && contract.prepaidDeliveriesPerCharge != null
            ? {
                prepaidDeliveriesRemaining:
                  contract.prepaidDeliveriesPerCharge,
              }
            : {}),
        },
      });
      return consumed;
    });
    if (!claimed) {
      // Already settled by the webhook — it owned the counters and events.
      stats.succeeded += 1;
      return;
    }

    if (claimed.addonTitles.length > 0) {
      await logEvent({
        ...eventBase,
        type: "cycle.addon_removed",
        source: "SCHEDULER",
        actor: "system",
        payload: {
          cycleIndex: attempt.cycleIndex,
          titles: claimed.addonTitles,
          reason: "consumed_by_successful_cycle",
          resolvedBy: "stale_sweep",
        },
      });
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

    // The FULL settlement tail the webhook would have driven — dunning
    // close, lifecycle milestones, order confirmation and the
    // billing.attempt_succeeded / billing.order_created events — then the
    // settledAt marker LAST (the helper's crash contract): if the sweep dies
    // mid-tail, the attempt stays SUCCESS + settledAt NULL and a redelivered
    // success webhook re-drives the remaining side effects through the same
    // helper's attemptId-keyed redrive dedupes. If the tail throws, the
    // sweep's per-attempt catch counts the row unresolved and the marker is
    // never stamped — the failure surfaces instead of being swallowed.
    await finishSuccessSettlement(shop.id, attempt.id, {
      redrive: false,
      source: "SCHEDULER",
      resolvedBy: "stale_sweep",
    });
    stats.succeeded += 1;
    return;
  }

  if (info?.nextActionUrl) {
    // Status-guarded claim, same one-writer rule as the SUCCESS branch above:
    // the outcome webhook can settle this attempt between the sweep's stale
    // read and this write, and an unguarded update would flip a settled
    // SUCCESS back to CHALLENGED (reopening dunning for a paid cycle). A lost
    // claim means the webhook owned the transition — hand off nothing.
    // declineCategory deliberately NOT stamped: it is the failure engine's
    // written-LAST processed marker (see onBillingAttemptChallenged) — a
    // challenge stamp would make the attempt's later FAILURE webhook look
    // like an already-processed redelivery and mute the retry ladder.
    const claimed = await prisma.billingAttempt.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: {
        status: "CHALLENGED",
        // Fold the 3DS outcome into the stored-credential evidence blob.
        mitEvidence: withThreeDsOutcome(attempt.mitEvidence, {
          challenged: true,
          redirectIssued: true,
          challengedAt: now.toISOString(),
          resolution: "PENDING_CUSTOMER_ACTION",
        }),
      },
    });
    if (claimed.count === 0) {
      // Settled by the webhook while the sweep was processing — its handler
      // owned the bookkeeping. Report the outcome it actually reached.
      const settled = await prisma.billingAttempt.findUnique({
        where: { id: attempt.id },
        select: { status: true },
      });
      if (settled?.status === "SUCCESS") stats.succeeded += 1;
      else if (settled?.status === "FAILED") stats.failed += 1;
      else stats.challenged += 1;
      return;
    }
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
    // Claimed like the branches above: if the FAILED webhook settled the
    // attempt during the sweep's window, its handler already drove dunning —
    // a second unguarded write + hand-off here would only re-drive it.
    // CHALLENGED claims too: a challenged attempt whose customer failed or
    // abandoned 3DS lands here when the FAILURE webhook was lost — exactly
    // what the FAILURE webhook handler itself would have settled — while a
    // concurrently-settled SUCCESS still loses the claim.
    const claimed = await prisma.billingAttempt.updateMany({
      where: { id: attempt.id, status: { in: ["PENDING", "CHALLENGED"] } },
      data: {
        status: "FAILED",
        completedAt: now,
        errorCode: info.errorCode ?? null,
        errorMessage: info.errorMessage ?? null,
      },
    });
    if (claimed.count === 0) {
      stats.failed += 1;
      return;
    }
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
        // outcome/superseded discriminate the overloaded event type: this
        // is a REAL decline Shopify reported, unlike the EXPIRED_UNKNOWN
        // rows below whose charge outcome was never learned.
        outcome: "FAILED",
        superseded: false,
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
  // Never a CHALLENGED row: the customer may legitimately take days to
  // complete the challenge (the CONFIRM_3DS link lives for 3), and its
  // lifetime belongs to the dunning case's cancelAfterFailedDays timeout —
  // which re-checks Shopify one last time before exhausting (runDunningSweep
  // phase (c)). Expiring it here would stomp an in-flight authentication.
  if (attempt.status === "CHALLENGED") {
    stats.unresolved += 1;
    return;
  }
  const ageBasis = attempt.startedAt ?? attempt.scheduledFor;
  const expireBefore = new Date(now.getTime() - STALE_EXPIRE_HOURS * 3_600_000);
  if (ageBasis > expireBefore) {
    stats.unresolved += 1;
    return;
  }

  // Claimed like every other transition out of PENDING: a webhook landing
  // during the sweep's processing window must never be stomped to EXPIRED.
  const expireClaimed = await prisma.billingAttempt.updateMany({
    where: { id: attempt.id, status: "PENDING" },
    data: {
      status: "EXPIRED",
      completedAt: now,
      errorMessage: `Unresolved after ${STALE_EXPIRE_HOURS}h (no webhook, no Shopify status)`,
    },
  });
  if (expireClaimed.count === 0) {
    stats.unresolved += 1;
    return;
  }
  await logEvent({
    ...eventBase,
    type: "billing.attempt_failed",
    source: "SCHEDULER",
    actor: "system",
    payload: {
      attemptId: attempt.id,
      cycleIndex: attempt.cycleIndex,
      reason: "expired_unresolved",
      // The charge OUTCOME was never learned — event-derived failure
      // features must not count this as a decline.
      outcome: "EXPIRED_UNKNOWN",
      superseded: false,
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

/** What a one-off Shopify re-check of a single attempt established. */
export type AttemptRecheckOutcome =
  | "SUCCESS"
  | "FAILED"
  | "CHALLENGED"
  | "EXPIRED"
  | "UNRESOLVED";

/**
 * Re-check ONE attempt against Shopify and settle it through the stale
 * sweep's status-guarded resolution branches (same claims, same settlement
 * tail, same dunning hand-offs). The dunning sweep calls this before
 * exhausting an AWAITING_3DS case: the 3DS outcome only ever arrives by
 * webhook, so with that webhook lost the case would otherwise time out and
 * fail/cancel a contract whose charge may have SUCCEEDED. Returns what the
 * re-check ESTABLISHED — "UNRESOLVED" covers a missing shop/admin client, a
 * foreign or demo contract, Shopify having nothing new, and re-check
 * failures (all logged, never thrown: the caller is deciding whether to
 * exhaust, and an error here must read as "nothing new", not abort it).
 */
export async function recheckAttemptOutcome(
  attemptLocalId: string,
): Promise<AttemptRecheckOutcome> {
  const shop = await getPrimaryShop();
  if (!shop) return "UNRESOLVED";
  const attempt = (await prisma.billingAttempt.findUnique({
    where: { id: attemptLocalId },
    include: { contract: true },
  })) as StaleAttempt | null;
  if (
    !attempt ||
    attempt.contract.shopId !== shop.id ||
    attempt.contract.isDemo ||
    !isBillableOwnership(attempt.contract.ownership)
  ) {
    return "UNRESOLVED";
  }

  let admin: AdminClient;
  try {
    admin = await adminClientForShop(shop.domain);
  } catch (err) {
    console.error("[billing] attempt re-check: no admin client", err);
    return "UNRESOLVED";
  }

  const stats: StaleSweepStats = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    challenged: 0,
    expired: 0,
    unresolved: 0,
  };
  try {
    await resolveStaleAttempt(
      admin,
      { id: shop.id, domain: shop.domain },
      attempt,
      new Date(),
      stats,
    );
  } catch (err) {
    console.error("[billing] attempt re-check failed", attemptLocalId, err);
    return "UNRESOLVED";
  }
  if (stats.succeeded > 0) return "SUCCESS";
  if (stats.failed > 0) return "FAILED";
  if (stats.challenged > 0) return "CHALLENGED";
  if (stats.expired > 0) return "EXPIRED";
  return "UNRESOLVED";
}

// ── Settlement redrive sweep ─────────────────────────────────────────────────

/**
 * Minimum age (measured on completedAt) before a SUCCESS + settledAt-NULL
 * attempt is redriven. completedAt is the CHARGE instant, which the claim
 * writers backdate to the order's createdAt by up to MAX_CHARGE_BACKDATE_MS —
 * so "completedAt older than backdate-cap + 30 min" is the earliest bound
 * that PROVES the claim transaction itself committed over 30 minutes ago.
 * A live settlement tail runs for seconds; 30 minutes of no settledAt after
 * a committed claim means the process died mid-tail. Anything younger may be
 * a webhook handler legitimately still running its tail (whose redrive:false
 * path sends the order confirmation UNCONDITIONALLY — racing it would
 * double-send), so the sweep waits it out. Recovery is therefore up to ~a day
 * late in the worst case, which is still earlier than the first wrongful
 * dunning ladder email (day 3) the zombie case would otherwise send.
 */
const SUCCESS_REDRIVE_MIN_AGE_MS = MAX_CHARGE_BACKDATE_MS + 30 * 60_000;

/**
 * Only attempts whose completedAt is within this window are redriven. Older
 * rows are historical: migration 0007 backfilled settledAt for every SUCCESS
 * row that predates the marker, and FAILED rows past the window have long
 * been superseded by later cycles — re-driving them would send stale
 * customer email. The bound also keeps the scan cheap.
 */
const REDRIVE_LOOKBACK_MS = 7 * 86_400_000;

export interface SettlementRedriveStats {
  successRedriven: number;
  failureRedriven: number;
  /** SUCCESS rows whose null amount was re-read from the order (third arm). */
  amountsTruedUp: number;
  errors: number;
  skipped?: string;
}

/**
 * Re-drive half-settled billing attempts whose webhook retry train is DEAD.
 *
 * The webhook route answers 200 FAILED when a handler THROWS (a 5xx would get
 * the webhook subscription disabled), and any 2xx permanently ends Shopify's
 * redelivery train for that webhook id. The route's crash-residue redrive
 * therefore only covers process DEATH (no 2xx sent); a mid-tail ERROR leaves
 * the attempt half-settled with no carrier left to finish it:
 *
 *  - status SUCCESS + settledAt NULL: the claim transaction committed
 *    (counters, add-on clearing, gift flip) but the tail died — the dunning
 *    case for the now-PAID cycle stays open as a zombie (its RETRYING state
 *    has nextRetryAt null, so the sweep never fires or exhausts it, and the
 *    ladder emails payment_failed_2/3 to a customer whose charge SUCCEEDED),
 *    and the order confirmation + billing.attempt_succeeded events are lost.
 *    → finishSuccessSettlement(redrive: true): every step re-checks its own
 *    marker, then stamps settledAt LAST.
 *  - status FAILED + declineCategory NULL: onBillingAttemptFailed died before
 *    its written-LAST marker — a case left OPEN holds the cycle via the
 *    billing sweep's attempt-history guard, so the subscriber silently stops
 *    billing. → onBillingAttemptFailed(id): its atomic entry claim
 *    (dunningClaimedAt lease) makes the re-invocation single-flight, exactly
 *    like a webhook redelivery would have been.
 *  - status SUCCESS + amountCents NULL: the order-summary fetch failed at
 *    claim time and the charge settled worth 0 in every revenue surface —
 *    with no other repair lane, since the replay path deliberately never
 *    re-reads a SETTLED attempt's amount. → the third arm below re-fetches
 *    the order and trues the money up exactly once.
 *
 * Belt-and-braces by design: the WEBHOOK_FAILURES alert (FAILED-residue arm)
 * tells the merchant, this sweep repairs the attempt-shaped subset without
 * anyone reading the alert. All arms are scoped to OURS + non-demo, like
 * every other sweep on this book.
 */
export async function sweepUnsettledAttempts(
  now = new Date(),
): Promise<SettlementRedriveStats> {
  const stats: SettlementRedriveStats = {
    successRedriven: 0,
    failureRedriven: 0,
    amountsTruedUp: 0,
    errors: 0,
  };

  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }

  const lookbackFloor = new Date(now.getTime() - REDRIVE_LOOKBACK_MS);

  // ── Success tail redrive ───────────────────────────────────────────────────
  const halfSettled = await prisma.billingAttempt.findMany({
    where: {
      status: "SUCCESS",
      settledAt: null,
      contract: { shopId: shop.id, isDemo: false, ...OURS_ONLY },
      completedAt: {
        lt: new Date(now.getTime() - SUCCESS_REDRIVE_MIN_AGE_MS),
        gte: lookbackFloor,
      },
    },
    orderBy: { completedAt: "asc" },
    take: 50,
    select: { id: true },
  });
  if (halfSettled.length > 0) {
    const { finishSuccessSettlement } = await import(
      "~/lib/webhooks/handlers.server"
    );
    for (const attempt of halfSettled) {
      try {
        await finishSuccessSettlement(shop.id, attempt.id, {
          redrive: true,
          source: "SCHEDULER",
          resolvedBy: "settlement_redrive",
        });
        stats.successRedriven += 1;
      } catch (err) {
        // Marker not stamped — the row stays eligible for the next run.
        stats.errors += 1;
        console.error(
          "[billing] settlement redrive (success tail) failed",
          attempt.id,
          err,
        );
      }
    }
  }

  // ── Failure engine redrive ─────────────────────────────────────────────────
  // Age gate = the dunning entry-claim lease: a run that died holds a lease
  // that expires after DUNNING_CLAIM_LEASE_MS, and onBillingAttemptFailed
  // itself refuses the claim while a lease is live — so the sweep can never
  // run the engine alongside a healthy invocation, only after a dead one.
  const { DUNNING_CLAIM_LEASE_MS, onBillingAttemptFailed } = await import(
    "~/lib/dunning/engine.server"
  );
  const unprocessedFailures = await prisma.billingAttempt.findMany({
    where: {
      status: "FAILED",
      declineCategory: null,
      contract: { shopId: shop.id, isDemo: false, ...OURS_ONLY },
      completedAt: {
        lt: new Date(now.getTime() - DUNNING_CLAIM_LEASE_MS),
        gte: lookbackFloor,
      },
    },
    orderBy: { completedAt: "asc" },
    take: 50,
    select: { id: true },
  });
  for (const attempt of unprocessedFailures) {
    try {
      await onBillingAttemptFailed(attempt.id);
      stats.failureRedriven += 1;
    } catch (err) {
      stats.errors += 1;
      console.error(
        "[billing] settlement redrive (failure engine) failed",
        attempt.id,
        err,
      );
    }
  }

  // ── Null-amount SUCCESS true-up ────────────────────────────────────────────
  // A transient order-summary failure at claim time commits a SUCCESS with
  // amountCents NULL — a real charge booked as 0 in rollup chargedCents,
  // cohorts, lifetimeRevenueCents and a recovered case's recoveredCents. The
  // webhook replay path deliberately never re-reads a SETTLED amount (a
  // post-refund current total would double-count the refund), but NULL is
  // proof no amount was ever read, so re-fetching here is the one safe
  // moment — and the amountCents-still-NULL claim makes every true-up (and
  // its counter increments) exactly-once even against a rival sweep run.
  const nullAmount = await prisma.billingAttempt.findMany({
    where: {
      status: "SUCCESS",
      amountCents: null,
      orderId: { not: null },
      contract: { shopId: shop.id, isDemo: false, ...OURS_ONLY },
      completedAt: { gte: lookbackFloor },
    },
    orderBy: { completedAt: "asc" },
    take: 50,
    include: { contract: true },
  });
  if (nullAmount.length > 0) {
    let admin: AdminClient | null = null;
    try {
      admin = await adminClientForShop(shop.domain);
    } catch (err) {
      console.error("[billing] amount true-up: no admin client", err);
    }
    for (const attempt of admin ? nullAmount : []) {
      try {
        const summary = await getOrderSummary(admin!, attempt.orderId!);
        // The order's CURRENT total is already reduced by any refund that
        // landed before this repair ran; refundedCents (webhook-tracked)
        // restores the amount AS CHARGED, keeping the same
        // net-of-refunds-at-read-time semantics as claim-time settlements.
        const chargedCents = summary.totalCents + attempt.refundedCents;
        const currencyCode =
          summary.currencyCode ?? attempt.contract.currencyCode;
        const claimed = await prisma.billingAttempt.updateMany({
          where: { id: attempt.id, status: "SUCCESS", amountCents: null },
          data: {
            amountCents: chargedCents,
            currencyCode,
            // The order money breakdown the claim would have captured.
            discountCents: summary.discountsCents,
            taxCents: summary.taxCents,
            shippingCents: summary.shippingCents,
            subtotalCents: summary.subtotalCents,
            orderProcessedAt: summary.processedAt,
          },
        });
        if (claimed.count === 0) continue; // a rival run trued it up first
        await prisma.subscriptionContract.update({
          where: { id: attempt.contractId },
          data: {
            lifetimeRevenueCents: { increment: chargedCents },
            lifetimeDiscountCents: { increment: summary.discountsCents },
          },
        });
        // A case this attempt recovered inherited the NULL — its recovered
        // money is this same charge.
        await prisma.dunningCase.updateMany({
          where: { recoveredAttemptId: attempt.id, recoveredCents: null },
          data: { recoveredCents: chargedCents },
        });
        await logEvent({
          shopId: shop.id,
          contractId: attempt.contractId,
          customerId: attempt.contract.customerId,
          email: attempt.contract.email,
          type: "billing.attempt_amount_backfilled",
          source: "SCHEDULER",
          actor: "system",
          payload: {
            attemptId: attempt.id,
            orderId: attempt.orderId,
            cycleIndex: attempt.cycleIndex,
            amountCents: chargedCents,
            currencyCode,
            refundedCentsIncluded: attempt.refundedCents,
            resolvedBy: "settlement_redrive",
          },
        });
        stats.amountsTruedUp += 1;
      } catch (err) {
        stats.errors += 1;
        console.error("[billing] amount true-up failed", attempt.id, err);
      }
    }
  }

  return stats;
}
