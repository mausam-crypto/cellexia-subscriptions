import type { ContractLine, DiscountGrant, SubscriptionContract } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { applyDiscountPct, discountAmount } from "~/lib/money";
import { type AdminClient } from "~/lib/graphql/client.server";
import { withBillingCycleEdit } from "~/lib/graphql/billingCycles.server";
import { draftLineUpdate } from "~/lib/graphql/contracts.server";

/**
 * Per-cycle DiscountGrant application.
 *
 * Grants (save offers, win-back, retention, manual) are NEVER discount codes —
 * they are applied one billing cycle at a time via a billing-cycle contract
 * edit (subscriptionBillingCycleContractEdit draft + commit), which changes the
 * upcoming cycle only and leaves the contract's recurring pricing untouched.
 *
 * The scheduler calls `getActiveDiscountForCycle` + `applyGrantToCycle` in the
 * pre-charge pipeline. Application is idempotent per (grant, cycleIndex): the
 * "contract.updated / cycle_discount_applied" event doubles as the applied
 * marker, so a sweep re-run after a Shopify attempt-create failure never
 * stacks the discount twice for the same cycle.
 */

export type ContractWithLines = SubscriptionContract & { lines: ContractLine[] };

const APPLIED_ACTION = "cycle_discount_applied";

/** Has this grant already been applied to this cycle? (event log marker) */
async function grantAppliedToCycle(
  contractId: string,
  grantId: string,
  cycleIndex: number,
): Promise<boolean> {
  const row = await prisma.subscriberEvent.findFirst({
    where: {
      contractId,
      type: "contract.updated",
      AND: [
        { payload: { path: ["action"], equals: APPLIED_ACTION } },
        { payload: { path: ["grantId"], equals: grantId } },
        { payload: { path: ["cycleIndex"], equals: cycleIndex } },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The single best live grant for the contract's upcoming cycle, or null.
 *
 * Grants never stack: when several are live we take the highest percent
 * (oldest first as tie-break). `settings.discountStacking.maxTotalDiscountPct`
 * is enforced at grant CREATION time by `applyDiscountGrant`
 * (app/lib/contracts/service.server.ts), which clamps every new grant so
 * plan ongoing discount + grant percent never exceeds the cap — see
 * app/lib/billing/stacking.server.ts. By the time a grant reaches this sweep
 * its percent is already within policy. When `cycleIndex` is given, a grant
 * that has already been applied to that cycle is not returned again
 * (idempotent sweep re-runs).
 */
export async function getActiveDiscountForCycle(
  contractId: string,
  cycleIndex?: number,
): Promise<DiscountGrant | null> {
  const grants = await prisma.discountGrant.findMany({
    where: {
      contractId,
      cyclesRemaining: { gt: 0 },
      exhaustedAt: null,
      percent: { gt: 0 },
    },
    orderBy: [{ percent: "desc" }, { createdAt: "asc" }],
  });
  if (grants.length === 0) return null;

  const best = grants[0];
  if (cycleIndex != null) {
    const applied = await grantAppliedToCycle(contractId, best.id, cycleIndex);
    if (applied) return null;
  }
  return best;
}

/**
 * Apply `grant.percent` to every non-gift line of the given billing cycle via
 * a billing-cycle contract edit, then consume one cycle from the grant.
 *
 * Prices are always computed from the local mirror's `currentPriceCents`
 * (the recurring plan price), so a re-application would land on the same
 * absolute price — never a compounded one.
 *
 * Returns true when a cycle edit was committed.
 */
export async function applyGrantToCycle(
  admin: AdminClient,
  shop: { id: string; domain: string },
  contract: ContractWithLines,
  grant: DiscountGrant,
  cycleIndex: number,
): Promise<boolean> {
  const eligibleLines = contract.lines.filter(
    (line) => !line.isGift && line.shopifyLineId,
  );
  if (eligibleLines.length === 0) return false;

  await withBillingCycleEdit(
    admin,
    contract.shopifyContractId,
    { index: cycleIndex },
    async (draftId, run) => {
      for (const line of eligibleLines) {
        await draftLineUpdate(run, draftId, line.shopifyLineId as string, {
          currentPriceCents: applyDiscountPct(line.currentPriceCents, grant.percent),
        });
      }
    },
  );

  const discountCents = eligibleLines.reduce(
    (sum, line) =>
      sum + discountAmount(line.currentPriceCents, grant.percent) * line.quantity,
    0,
  );

  const remaining = Math.max(0, grant.cyclesRemaining - 1);
  await prisma.discountGrant.update({
    where: { id: grant.id },
    data: {
      cyclesRemaining: remaining,
      exhaustedAt: remaining === 0 ? new Date() : null,
    },
  });

  await logEvent({
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
    type: "contract.updated",
    source: "SCHEDULER",
    actor: "system",
    payload: {
      action: APPLIED_ACTION,
      grantId: grant.id,
      grantType: grant.type,
      percent: grant.percent,
      cycleIndex,
      discountCents,
      cyclesRemaining: remaining,
    },
  });

  return true;
}
