import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { logEvent } from "~/lib/events/log.server";
import {
  type AdminClient,
  type ShopifyVariant,
  addFreeGiftToOrder,
  getVariants,
} from "~/lib/graphql/index.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";

/**
 * First-order gift — the runtime for SellingPlanConfig.firstOrderGiftVariantId.
 *
 * Offer architecture (docs/OFFER_PLAYBOOK.md §"Gift vs extra % on first
 * order"): instead of — or on top of — a deep first-order discount, a plan can
 * promise a free gift with the FIRST order. That first order is the checkout
 * (origin) order: it is billed by Shopify checkout, never by a billing
 * attempt, so the gift engine's cycle machinery (1-based billing cycles)
 * cannot reach it. This module closes that gap.
 *
 * Mechanics: SUBSCRIPTION_CONTRACTS_CREATE → ensureFirstOrderGift. When the
 * new contract's products match an active SellingPlanConfig whose
 * firstOrderGiftVariantId is set, the gift variant is added to the origin
 * order as a zero-priced line via order editing (orderEditBegin →
 * orderEditAddVariant → 100% line discount → orderEditCommit; see
 * addFreeGiftToOrder) and recorded as a GiftGrant on cycle 0 — the synthetic
 * index this module reserves for the origin order. When the origin order is
 * unknown or cannot be edited (archived, gateway restrictions, ...), the
 * grant falls back to SCHEDULED on cycle 1 and the gift engine attaches it to
 * the first renewal pre-charge, so the promise is still kept.
 *
 * Grant lifecycle for cycle-0 grants: SCHEDULED (claim row) → ADDED (order
 * edit committed) — terminal. The billing-success webhook only flips grants
 * whose cycleIndex matches a billed attempt (always ≥ 1) and the daily sweep
 * only touches SHIPPED grants, so a cycle-0 grant never gains a bogus
 * SHIPPED/REMOVED state and no ContractLine mirror is created (the gift is
 * not part of any upcoming delivery).
 *
 * Idempotency: one GiftGrant per (contract, gift variant) is the claim — a
 * webhook redelivery, a deferred cycle-1 grant or a manual admin grant for
 * the same variant all mean "handled". The route layer additionally dedupes
 * deliveries on X-Shopify-Webhook-Id.
 *
 * Policy source: the per-plan merchant config (SellingPlanConfig, edited in
 * the Plans admin) IS the setting — no separate global toggle to drift out of
 * sync. Failures are contained by the caller (gifts never fail a webhook).
 */

/** Synthetic cycle index reserved for the origin (checkout) order. */
export const FIRST_ORDER_GIFT_CYCLE_INDEX = 0;

/** First chargeable renewal — the fallback delivery vehicle for the gift. */
export const FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX = 1;

// ── Pure matching (unit-tested in tests/first-order-gift.test.ts) ────────────

/** Structural subset of SellingPlanConfig the matcher needs. */
export interface FirstOrderGiftPlanLike {
  id: string;
  active: boolean;
  /** Json column — expected shape ["gid://shopify/Product/..."]. */
  productIds: unknown;
  firstOrderGiftVariantId: string | null;
}

/** Defensive parse of the productIds Json column. */
export function planProductIds(
  plan: Pick<FirstOrderGiftPlanLike, "productIds">,
): string[] {
  if (!Array.isArray(plan.productIds)) return [];
  return plan.productIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/**
 * First plan (caller order — pass createdAt asc for determinism) that is
 * active, has a first-order gift configured and covers at least one of the
 * contract's products. Null when no plan earns a gift.
 */
export function matchFirstOrderGiftPlan<T extends FirstOrderGiftPlanLike>(
  plans: readonly T[],
  contractProductIds: readonly string[],
): T | null {
  if (contractProductIds.length === 0) return null;
  const contractProducts = new Set(contractProductIds);
  for (const plan of plans) {
    if (!plan.active || !plan.firstOrderGiftVariantId) continue;
    if (planProductIds(plan).some((id) => contractProducts.has(id))) {
      return plan;
    }
  }
  return null;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export type FirstOrderGiftOutcome =
  | {
      status: "added";
      grantId: string;
      planConfigId: string;
      variantId: string;
      orderId: string;
    }
  | {
      status: "deferred";
      grantId: string;
      planConfigId: string;
      variantId: string;
      cycleIndex: number;
      reason: string;
    }
  | { status: "skipped"; reason: string };

/** Best-effort variant lookup for event metadata; null on any failure. */
async function fetchGiftVariant(
  admin: AdminClient,
  variantId: string,
): Promise<ShopifyVariant | null> {
  try {
    const [variant] = await getVariants(admin, [variantId]);
    return variant ?? null;
  } catch (err) {
    console.error("[gifts] first-order gift variant lookup failed", variantId, err);
    return null;
  }
}

/**
 * Grant + deliver the plan-configured first-order gift for a just-created
 * contract. Idempotent (grant claim per contract+variant); never gifts
 * catch-up mirrors of older contracts. Called from the
 * SUBSCRIPTION_CONTRACTS_CREATE webhook handler BEFORE the cycle-1/2 gift
 * scheduling, so a deferred grant is attached by the engine in the same
 * handler run.
 */
export async function ensureFirstOrderGift(
  shopDomain: string,
  contractLocalId: string,
): Promise<FirstOrderGiftOutcome> {
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Subscription contract not found: ${contractLocalId}`);
  }
  if (contract.status !== "ACTIVE") {
    return { status: "skipped", reason: "contract_not_active" };
  }
  // A contract created by another subscription app never earned OUR
  // first-order gift, and editing it is not ours to do.
  if (!isBillableOwnership(contract.ownership)) {
    return { status: "skipped", reason: "foreign_contract" };
  }
  // A mirror created late (catch-up sync) has already billed cycles — its
  // first order is long gone and must never be retro-gifted.
  if (contract.ordersCount > 0) {
    return { status: "skipped", reason: "not_first_order" };
  }

  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: contract.shopId },
  });

  const contractProductIds = [
    ...new Set(
      contract.lines
        .filter((line) => !line.isGift)
        .map((line) => line.productId)
        .filter((id) => id.length > 0),
    ),
  ];
  if (contractProductIds.length === 0) {
    return { status: "skipped", reason: "no_lines" };
  }

  const plans = await prisma.sellingPlanConfig.findMany({
    where: {
      shopId: shop.id,
      active: true,
      firstOrderGiftVariantId: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });
  const plan = matchFirstOrderGiftPlan(plans, contractProductIds);
  const variantId = plan?.firstOrderGiftVariantId ?? null;
  if (!plan || !variantId) {
    return { status: "skipped", reason: "no_matching_plan" };
  }

  // One first-order gift per (contract, variant), ever: any existing grant —
  // a webhook redelivery, an earlier deferred grant, a manual admin grant —
  // means this gift is already handled.
  const existing = await prisma.giftGrant.findFirst({
    where: { contractId: contract.id, variantId },
    select: { id: true },
  });
  if (existing) {
    return { status: "skipped", reason: "already_granted" };
  }

  // Claim row first — the idempotency anchor for redeliveries that race the
  // order edit below.
  const grant = await prisma.giftGrant.create({
    data: {
      contractId: contract.id,
      ruleId: null,
      cycleIndex: FIRST_ORDER_GIFT_CYCLE_INDEX,
      variantId,
      status: "SCHEDULED",
      source: "FIRST_ORDER",
    },
  });

  const eventBase = {
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };

  const deferToFirstRenewal = async (
    reason: string,
  ): Promise<FirstOrderGiftOutcome> => {
    await prisma.giftGrant.update({
      where: { id: grant.id },
      data: { cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX },
    });
    await logEvent({
      ...eventBase,
      type: "lifecycle.gift_scheduled",
      source: "SYSTEM",
      actor: "gift_engine",
      payload: {
        grantId: grant.id,
        ruleId: null,
        planConfigId: plan.id,
        trigger: "FIRST_ORDER_GIFT",
        firstOrderGift: true,
        cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX,
        variantId,
        reason,
      },
    });
    return {
      status: "deferred",
      grantId: grant.id,
      planConfigId: plan.id,
      variantId,
      cycleIndex: FIRST_ORDER_GIFT_FALLBACK_CYCLE_INDEX,
      reason,
    };
  };

  if (!contract.originOrderId) {
    return deferToFirstRenewal("origin_order_unknown");
  }

  const admin = await adminClientForShop(shop.domain);
  const variant = await fetchGiftVariant(admin, variantId);
  const title = variant?.productTitle || "Welcome gift";

  try {
    const edit = await addFreeGiftToOrder(
      admin,
      contract.originOrderId,
      variantId,
      {
        quantity: 1,
        discountDescription: "First-order subscription gift",
        staffNote: `Cellexia first-order gift (plan "${plan.name}")`,
        notifyCustomer: false,
      },
    );

    await prisma.giftGrant.update({
      where: { id: grant.id },
      data: { status: "ADDED", addedAt: new Date() },
    });

    await logEvent({
      ...eventBase,
      type: "cycle.gift_added",
      source: "SYSTEM",
      actor: "gift_engine",
      payload: {
        grantId: grant.id,
        ruleId: null,
        planConfigId: plan.id,
        firstOrderGift: true,
        cycleIndex: FIRST_ORDER_GIFT_CYCLE_INDEX,
        originOrderId: contract.originOrderId,
        originOrderName: contract.originOrderName,
        variantId,
        title,
        unitCostCents: variant?.unitCostCents ?? null,
      },
    });

    return {
      status: "added",
      grantId: grant.id,
      planConfigId: plan.id,
      variantId,
      orderId: edit.orderId,
    };
  } catch (err) {
    // Origin order not editable (archived, refunded, gateway rules, ...):
    // keep the promise via the first renewal instead.
    console.error(
      "[gifts] first-order gift order edit failed — deferring to cycle 1",
      contract.id,
      contract.originOrderId,
      err,
    );

    // ACCESS_DENIED is a different animal from "this order cannot be edited":
    // it means the install is missing the write_order_edits scope, so EVERY
    // subscriber's promised gift would silently defer a full billing interval
    // — forever, on every contract — and a console line is the only trace.
    // That error class is misconfiguration, not an uneditable order: raise a
    // deduped operator alert (CRITICAL → admin email) so it gets fixed
    // instead of discovered through customer complaints. Contained: alerting
    // must never break the deferral fallback that keeps the promise.
    const message = err instanceof Error ? err.message : String(err);
    if (/access.?denied|access scope/i.test(message)) {
      try {
        const { raiseAlert } = await import("~/lib/analytics/alerts.server");
        await raiseAlert({
          shopId: shop.id,
          type: "FIRST_ORDER_GIFT_ACCESS_DENIED",
          severity: "CRITICAL",
          message:
            "Shopify refused the order edit that attaches the first-order gift " +
            "(access denied). The app is most likely missing the " +
            "write_order_edits access scope — re-deploy the app configuration " +
            "and re-install/approve the new scopes. Until then, every " +
            "first-order gift is deferred to the first renewal instead of the " +
            "checkout order.",
          context: {
            contractId: contract.id,
            originOrderId: contract.originOrderId,
            error: message.slice(0, 500),
          },
        });
      } catch (alertErr) {
        console.error(
          "[gifts] failed to raise the access-denied alert",
          alertErr,
        );
      }
    }
    return deferToFirstRenewal("origin_order_edit_failed");
  }
}
