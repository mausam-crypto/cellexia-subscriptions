import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { sendNotification } from "~/lib/notifications/send.server";
import {
  getBillingCycleByDate,
  getVariants,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import { delayNextCycle, skipNextCycle, swapLineVariant } from "./service.server";
import {
  eventIdentity,
  loadContractContext,
  resolveActor,
  resolveSource,
  type LocalContractLine,
  type ServiceOptions,
} from "./shared.server";

/**
 * Stockout policy for renewals. The billing sweep calls
 * `evaluateStockoutForContract` before charging: if any line's variant is out
 * of stock the contract-level policy (per-product ProductCadence override,
 * else settings.stockout.policy) decides what happens —
 *
 *  - SUBSTITUTE: swap the line to ProductCadence.substituteVariantId (falls
 *    back to DELAY when no in-stock substitute is configured);
 *  - DELAY: push the cycle by delayDays, at most maxDelays times per cycle
 *    (then escalate to a skip so a customer is never delayed forever);
 *  - SKIP_NOTIFY: skip the cycle and tell the customer.
 *
 * Returns `{ ok, action }` so the sweep knows whether to proceed with the
 * charge (NONE / SUBSTITUTED) or stand down (DELAYED / SKIPPED).
 */

export type StockoutAction = "NONE" | "DELAYED" | "SKIPPED" | "SUBSTITUTED";

export interface StockoutEvaluation {
  ok: boolean;
  action: StockoutAction;
  stockedOutVariantIds: string[];
  error?: string;
}

type StockoutPolicy = "DELAY" | "SKIP_NOTIFY" | "SUBSTITUTE";

function isStockedOut(variant: ShopifyVariant | undefined): boolean {
  if (!variant) return true; // deleted/unknown variant cannot ship
  if (!variant.availableForSale) return true;
  return variant.inventoryQuantity != null && variant.inventoryQuantity <= 0;
}

interface LinePolicy {
  line: LocalContractLine;
  policy: StockoutPolicy;
  substituteVariantId: string | null;
}

async function resolveLinePolicy(
  shopId: string,
  line: LocalContractLine,
  defaultPolicy: StockoutPolicy,
): Promise<LinePolicy> {
  // Variant-specific cadence row wins over the product-level one.
  const cadence =
    (await prisma.productCadence.findFirst({
      where: { shopId, productId: line.productId, variantId: line.variantId },
    })) ??
    (await prisma.productCadence.findFirst({
      where: { shopId, productId: line.productId, variantId: null },
    }));

  const policy =
    cadence?.stockoutPolicy === "DELAY" ||
    cadence?.stockoutPolicy === "SKIP_NOTIFY" ||
    cadence?.stockoutPolicy === "SUBSTITUTE"
      ? cadence.stockoutPolicy
      : defaultPolicy;

  return {
    line,
    policy,
    substituteVariantId: cadence?.substituteVariantId ?? null,
  };
}

/**
 * Evaluate every line's stock and act per policy. Never throws — the billing
 * sweep needs a verdict, so failures come back as `{ ok: false }`.
 */
export async function evaluateStockoutForContract(
  shopDomain: string,
  contractLocalId: string,
  options?: ServiceOptions,
): Promise<StockoutEvaluation> {
  try {
    const ctx = await loadContractContext(shopDomain, contractLocalId);
    const { shop, contract, admin } = ctx;

    if (contract.status !== "ACTIVE" || !contract.nextBillingDate) {
      return { ok: true, action: "NONE", stockedOutVariantIds: [] };
    }

    const variantIds = [
      ...new Set(contract.lines.map((l) => l.variantId).filter(Boolean)),
    ];
    if (variantIds.length === 0) {
      return { ok: true, action: "NONE", stockedOutVariantIds: [] };
    }

    const variants = await getVariants(admin, variantIds);
    const variantById = new Map(variants.map((v) => [v.id, v]));

    const stockedOutLines = contract.lines.filter((l) =>
      isStockedOut(variantById.get(l.variantId)),
    );
    if (stockedOutLines.length === 0) {
      return { ok: true, action: "NONE", stockedOutVariantIds: [] };
    }
    const stockedOutVariantIds = [
      ...new Set(stockedOutLines.map((l) => l.variantId)),
    ];

    const settings = await getSetting(shop.id, "stockout");
    const linePolicies: LinePolicy[] = [];
    for (const line of stockedOutLines) {
      linePolicies.push(await resolveLinePolicy(shop.id, line, settings.policy));
    }

    const cycle = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      contract.nextBillingDate,
    );
    const cycleIndex = cycle?.cycleIndex ?? null;

    // ── 1. Substitutions (per line; contract keeps billing on schedule) ─────
    const substitutable = linePolicies.filter(
      (lp) => lp.policy === "SUBSTITUTE" && lp.substituteVariantId,
    );
    let substituted = 0;
    if (substitutable.length > 0) {
      // A substitute that is itself out of stock falls back to DELAY.
      const subVariants = await getVariants(admin, [
        ...new Set(substitutable.map((lp) => lp.substituteVariantId!)),
      ]);
      const subById = new Map(subVariants.map((v) => [v.id, v]));

      for (const lp of substitutable) {
        const substitute = subById.get(lp.substituteVariantId!);
        if (isStockedOut(substitute)) {
          lp.substituteVariantId = null; // triggers the DELAY fallback below
          continue;
        }
        await swapLineVariant(
          shopDomain,
          contract.id,
          lp.line.id,
          lp.substituteVariantId!,
          options,
        );
        substituted += 1;

        if (settings.notifyCustomer) {
          await sendNotification({
            shopId: shop.id,
            contractId: contract.id,
            template: "stockout_substitute",
            vars: {
              product_title: lp.line.title,
              substitute_title: substitute?.productTitle ?? "",
              ...(cycleIndex != null ? { cycleIndex } : {}),
            },
          });
        }
        await logEvent({
          ...eventIdentity(shop, contract),
          type: "stockout.substituted",
          source: resolveSource(options),
          actor: resolveActor(options),
          payload: {
            lineId: lp.line.id,
            fromVariantId: lp.line.variantId,
            toVariantId: lp.substituteVariantId,
            ...(cycleIndex != null ? { cycleIndex } : {}),
          },
        });
      }
    }

    // ── 2. Contract-level action for whatever is still out of stock ─────────
    const remaining = linePolicies.filter(
      (lp) => lp.policy !== "SUBSTITUTE" || !lp.substituteVariantId,
    );
    if (remaining.length === 0) {
      return {
        ok: true,
        action: substituted > 0 ? "SUBSTITUTED" : "NONE",
        stockedOutVariantIds,
      };
    }

    const remainingVariantIds = [
      ...new Set(remaining.map((lp) => lp.line.variantId)),
    ];
    let wantSkip = remaining.some((lp) => lp.policy === "SKIP_NOTIFY");

    if (!wantSkip) {
      // DELAY, capped: count this cycle's stockout delays; at the cap the
      // cycle is skipped instead so the customer is never strung along.
      let delaysThisCycle = 0;
      if (cycleIndex != null) {
        delaysThisCycle = await prisma.subscriberEvent.count({
          where: {
            contractId: contract.id,
            type: "stockout.delayed",
            payload: { path: ["cycleIndex"], equals: cycleIndex },
          },
        });
      }
      if (delaysThisCycle >= settings.maxDelays) wantSkip = true;
    }

    if (wantSkip) {
      await skipNextCycle(shopDomain, contract.id, options);
      if (settings.notifyCustomer) {
        await sendNotification({
          shopId: shop.id,
          contractId: contract.id,
          template: "stockout_skip",
          vars: {
            product_title: remaining[0]!.line.title,
            ...(cycleIndex != null ? { cycleIndex } : {}),
          },
        });
      }
      await logEvent({
        ...eventIdentity(shop, contract),
        type: "stockout.skipped",
        source: resolveSource(options),
        actor: resolveActor(options),
        payload: {
          variantIds: remainingVariantIds,
          ...(cycleIndex != null ? { cycleIndex } : {}),
        },
      });
      return { ok: true, action: "SKIPPED", stockedOutVariantIds };
    }

    await delayNextCycle(
      shopDomain,
      contract.id,
      { days: settings.delayDays },
      options,
    );
    if (settings.notifyCustomer) {
      await sendNotification({
        shopId: shop.id,
        contractId: contract.id,
        template: "stockout_delay",
        vars: {
          product_title: remaining[0]!.line.title,
          delay_days: settings.delayDays,
          ...(cycleIndex != null ? { cycleIndex } : {}),
        },
      });
    }
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "stockout.delayed",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        days: settings.delayDays,
        variantIds: remainingVariantIds,
        ...(cycleIndex != null ? { cycleIndex } : {}),
      },
    });
    return { ok: true, action: "DELAYED", stockedOutVariantIds };
  } catch (err) {
    console.error(
      "[contracts] evaluateStockoutForContract failed",
      contractLocalId,
      err,
    );
    return {
      ok: false,
      action: "NONE",
      stockedOutVariantIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
