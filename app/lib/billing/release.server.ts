import type { Prisma } from "@prisma/client";
import prisma from "~/db.server";

/**
 * Cycle-history release for reactivated contracts — the shared half of the
 * reactivated-but-never-billed fix (migration 0013).
 *
 * The billing sweep may only ever open the FIRST attempt for a cycle: a cycle
 * whose newest non-superseded attempt is FAILED / CHALLENGED / EXPIRED is
 * held for the dunning engine (scheduler b2). That hand-off assumes a live
 * dunning case will pick the cycle up — but every REACTIVATION of a
 * payment-failed contract breaks the assumption: the dunning case was closed
 * when the contract failed/cancelled (auto-closed CANCELLED, or EXHAUSTED),
 * and onPaymentMethodUpdated only reopens EXHAUSTED cases while the contract
 * is still FAILED. Reactivated, the contract is ACTIVE with nextBillingDate
 * typically INSIDE the still-unbilled failed cycle — so without this release
 * NO code path ever bills again: the sweep re-resolves the cycle, finds the
 * terminal attempt, counts cycleHeld and returns, forever.
 *
 * Every reactivation entry point must therefore stamp the closed episode's
 * terminal attempts with `supersededAt` (the b2 guard ignores superseded
 * rows; attempt numbering still counts them, so the fresh first attempt gets
 * a new unique idempotency key):
 *  - reactivateFromWinback (magic link / cancel-flow restart),
 *  - resumeContract on a FAILED contract (the admin "Resume" button),
 *  - syncContractFromShopify when the mirror moves CANCELLED/FAILED → ACTIVE
 *    (a merchant reactivating the contract directly in the Shopify admin).
 *
 * Contract-scoped rather than resolved-cycle-scoped ON PURPOSE: resolving
 * the upcoming cycle costs another Shopify round trip whose failure would
 * leave the exact stuck state this exists to prevent, while a superseded
 * attempt on any OTHER cycle is inert — billed/skipped cycles short-circuit
 * at b1 before the history guard, and the sweep only ever inspects the one
 * cycle nextBillingDate resolves to. Guarded on no open dunning case: while
 * one exists, the ladder owns every further attempt for its cycle (PENDING
 * rows are never touched for the same reason — an in-flight or un-started
 * attempt's charge fate is unknown, and superseding it could double-charge).
 *
 * Returns the number of attempts released (0 = clean history or an open
 * dunning case still owns its cycle).
 *
 * Naturally idempotent (the where clause filters supersededAt: null), and
 * transaction-aware: pass the enclosing `tx` as `db` to commit the release
 * atomically with the status flip that makes the reactivation locally real —
 * reactivateFromWinback binds it to its ACTIVE mirror write so a crash can
 * never leave "mirror says ACTIVE" without "cycle released" (no replay would
 * reach the release again: every caller pre-checks CANCELLED/FAILED against
 * that same mirror).
 */
export async function releaseHeldCycleAttempts(
  contractId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const openCase = await db.dunningCase.findFirst({
    where: {
      contractId,
      state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] },
    },
    select: { id: true },
  });
  if (openCase) return 0;

  const released = await db.billingAttempt.updateMany({
    where: {
      contractId,
      status: { in: ["FAILED", "CHALLENGED", "EXPIRED"] },
      supersededAt: null,
    },
    data: { supersededAt: new Date() },
  });
  return released.count;
}
