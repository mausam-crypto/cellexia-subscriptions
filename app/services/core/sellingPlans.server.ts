/**
 * Selling plan configuration → Shopify SellingPlanGroup sync.
 *
 * Editing a selling plan NEVER changes existing subscribers (contracts detach
 * at purchase), which is why every push bumps SellingPlanConfig.version and
 * snapshots the config — we always know which rules a cohort signed up under.
 */
import type { SellingPlanConfig } from "@prisma/client";
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import {
  type AdminGraphql,
  assertNoUserErrors,
  runGraphql,
} from "~/services/core/shopifyClient.server";
import {
  SELLING_PLAN_GROUP_ADD_PRODUCTS_MUTATION,
  SELLING_PLAN_GROUP_CREATE_MUTATION,
  SELLING_PLAN_GROUP_UPDATE_MUTATION,
} from "~/graphql/sellingPlans";
import { parseJson } from "~/types/domain";
import { logger } from "~/lib/logger.server";

/** Shape of one entry in SellingPlanConfig.plansJson. */
export interface PlanDefinition {
  name: string;
  intervalWeeks: number;
  percentOff: number;
  shopifyPlanId?: string | null;
  /** Committed Treatment Plan: minimum deliveries (meaningful when >= 2). */
  minDeliveries?: number;
  /** Committed Treatment Plan marker. */
  committed?: boolean;
}

/**
 * Marker written to SellingPlanGroupInput.appId and matched (contains,
 * case-insensitive) by the theme extension's `plan_group_app_id` block
 * setting. Keep the two in sync.
 */
export const CELLEXIA_PLAN_GROUP_APP_ID = "cellexia";

/**
 * Pure: build the SellingPlanGroupInput for create/update. Plans without a
 * shopifyPlanId go to sellingPlansToCreate; the rest to sellingPlansToUpdate.
 * Recurring delivery + billing policies in exact weeks; PERCENTAGE pricing.
 */
export function buildSellingPlanGroupInput(config: {
  name: string;
  merchantCode: string;
  plans: PlanDefinition[];
}): Record<string, unknown> {
  const toPlanInput = (plan: PlanDefinition) => ({
    ...(plan.shopifyPlanId ? { id: plan.shopifyPlanId } : {}),
    name: plan.name,
    options: [`${plan.intervalWeeks} weeks`],
    category: "SUBSCRIPTION",
    billingPolicy: {
      recurring: {
        interval: "WEEK",
        intervalCount: plan.intervalWeeks,
        // Committed Treatment Plan: minCycles makes Shopify enforce the
        // minimum number of billing cycles at the contract level. Applies to
        // both sellingPlansToCreate and sellingPlansToUpdate (toPlanInput
        // feeds both). Note: Liquid does NOT expose minCycles on selling
        // plans, which is why the storefront widget learns committed plan ids
        // via widget-config settings (resolveWidget attaches
        // settings.committed.planIds for TREATMENT_CHOICE).
        ...(typeof plan.minDeliveries === "number" && plan.minDeliveries >= 2
          ? { minCycles: Math.round(plan.minDeliveries) }
          : {}),
      },
    },
    deliveryPolicy: {
      recurring: { interval: "WEEK", intervalCount: plan.intervalWeeks },
    },
    pricingPolicies:
      plan.percentOff > 0
        ? [
            {
              fixed: {
                adjustmentType: "PERCENTAGE",
                adjustmentValue: { percentage: plan.percentOff },
              },
            },
          ]
        : [],
  });

  return {
    name: config.name,
    merchantCode: config.merchantCode,
    // Exposed as selling_plan_group.app_id in Liquid and the Storefront API.
    // The storefront widget selects OUR group by this marker, so products that
    // also carry another subscription app's groups (Joy, Recharge, ...) never
    // render the other app's plans/discounts in the Cellexia widget.
    appId: CELLEXIA_PLAN_GROUP_APP_ID,
    options: ["Delivery every"],
    sellingPlansToCreate: config.plans
      .filter((p) => !p.shopifyPlanId)
      .map(toPlanInput),
    sellingPlansToUpdate: config.plans
      .filter((p) => p.shopifyPlanId)
      .map(toPlanInput),
  };
}

interface GroupPayload {
  sellingPlanGroup: {
    id: string;
    sellingPlans: { edges: Array<{ node: { id: string; name: string } }> };
  } | null;
  userErrors: Array<{ field?: string[] | null; message: string }>;
}

/**
 * Create or update the Shopify SellingPlanGroup from a SellingPlanConfig,
 * write shopifyGroupId + per-plan shopifyPlanId back into plansJson, bump the
 * version and append a SellingPlanConfigVersion snapshot.
 */
export async function pushSellingPlanConfig(
  graphql: AdminGraphql,
  shop: string,
  configId: string,
  changedBy = "system",
): Promise<SellingPlanConfig> {
  const config = await prisma.sellingPlanConfig.findFirstOrThrow({
    where: { id: configId, shop },
  });
  const plans = parseJson<PlanDefinition[]>(config.plansJson, []);
  if (plans.length === 0) {
    throw new Error("Selling plan config has no plans to push");
  }

  const input = buildSellingPlanGroupInput({
    name: config.name,
    merchantCode: config.merchantCode,
    plans,
  });

  let payload: GroupPayload;
  if (config.shopifyGroupId) {
    const data = await runGraphql<{ sellingPlanGroupUpdate: GroupPayload }>(
      graphql,
      SELLING_PLAN_GROUP_UPDATE_MUTATION,
      { id: config.shopifyGroupId, input },
    );
    assertNoUserErrors(
      "sellingPlanGroupUpdate",
      data.sellingPlanGroupUpdate.userErrors,
    );
    payload = data.sellingPlanGroupUpdate;
  } else {
    const data = await runGraphql<{ sellingPlanGroupCreate: GroupPayload }>(
      graphql,
      SELLING_PLAN_GROUP_CREATE_MUTATION,
      { input, resources: { productIds: [], productVariantIds: [] } },
    );
    assertNoUserErrors(
      "sellingPlanGroupCreate",
      data.sellingPlanGroupCreate.userErrors,
    );
    payload = data.sellingPlanGroupCreate;
  }

  const group = payload.sellingPlanGroup;
  if (!group) {
    throw new Error("Shopify returned no selling plan group");
  }

  // Map returned plan ids back onto our definitions by name.
  const remotePlans = group.sellingPlans.edges.map((e) => e.node);
  const updatedPlans = plans.map((plan) => {
    const remote = remotePlans.find((r) => r.name === plan.name);
    return { ...plan, shopifyPlanId: remote?.id ?? plan.shopifyPlanId ?? null };
  });

  const newVersion = config.version + 1;
  const updated = await prisma.sellingPlanConfig.update({
    where: { id: config.id },
    data: {
      shopifyGroupId: group.id,
      plansJson: JSON.stringify(updatedPlans),
      version: newVersion,
    },
  });
  await prisma.sellingPlanConfigVersion.create({
    data: {
      configId: config.id,
      version: newVersion,
      snapshot: JSON.stringify({
        name: updated.name,
        merchantCode: updated.merchantCode,
        shopifyGroupId: updated.shopifyGroupId,
        plans: updatedPlans,
        quantityDefaults: parseJson<Record<string, unknown>>(
          updated.quantityDefaultsJson,
          {},
        ),
        active: updated.active,
      }),
      changedBy,
    },
  });

  await appendAudit({
    shop,
    actorType: changedBy === "system" ? "SYSTEM" : "STAFF",
    actorId: changedBy === "system" ? null : changedBy,
    action: "SELLING_PLAN_PUSHED",
    subjectType: "SellingPlanConfig",
    subjectId: config.id,
    payload: { version: newVersion, shopifyGroupId: group.id, plans: updatedPlans.length },
  });
  logger.info("selling plan config pushed", {
    shop,
    configId,
    version: newVersion,
  });
  return updated;
}

/** Attach products to the config's Shopify selling plan group. */
export async function assignProductsToConfig(
  graphql: AdminGraphql,
  shop: string,
  configId: string,
  productGids: string[],
): Promise<void> {
  const config = await prisma.sellingPlanConfig.findFirstOrThrow({
    where: { id: configId, shop },
  });
  if (!config.shopifyGroupId) {
    throw new Error(
      "Push the selling plan config to Shopify before assigning products",
    );
  }
  if (productGids.length === 0) return;

  const data = await runGraphql<{
    sellingPlanGroupAddProducts: {
      sellingPlanGroup: { id: string } | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(graphql, SELLING_PLAN_GROUP_ADD_PRODUCTS_MUTATION, {
    id: config.shopifyGroupId,
    productIds: productGids,
  });
  assertNoUserErrors(
    "sellingPlanGroupAddProducts",
    data.sellingPlanGroupAddProducts.userErrors,
  );

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "SELLING_PLAN_PRODUCTS_ASSIGNED",
    subjectType: "SellingPlanConfig",
    subjectId: config.id,
    payload: { productGids },
  });
}
