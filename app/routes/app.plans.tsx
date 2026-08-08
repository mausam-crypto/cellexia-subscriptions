import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  Divider,
  EmptyState,
  InlineError,
  InlineStack,
  Layout,
  Modal,
  Page,
  Select,
  Tag,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { z } from "zod";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { applyDiscountPct, formatMoney } from "~/lib/money";
import {
  deleteSellingPlanGroup,
  findProductsMissingFromGroup,
  getProducts,
  getVariants,
  searchProducts,
  syncSellingPlanGroupFromConfig,
} from "~/lib/graphql/index.server";
import {
  publishOwnGroupsMetafield,
  recordSellingPlanSync,
} from "~/lib/ownership/ownership.server";
import { scanForeignSellingPlanGroups } from "~/lib/ownership/foreign-groups.server";
import { COUNTABLE_CONTRACT } from "~/lib/analytics/queries.server";
import { getSetting } from "~/lib/settings/settings.server";

/**
 * Admin — Subscription plans.
 *
 * Manages SellingPlanConfig rows (the local source of truth for the offer
 * architecture) and their sync into Shopify selling plan groups, plus the
 * per-product cadence table (estimated days-to-empty, recommended frequency,
 * stockout substitution) that powers real-empty-date scheduling and the
 * stockout policy.
 */

// ── Shared view types (loader/action → component) ────────────────────────────

interface PlanView {
  id: string;
  name: string;
  productIds: string[];
  productTitles: string[];
  frequenciesWeeks: number[];
  defaultFrequencyWeeks: number;
  allowFrequencyChoice: boolean;
  firstOrderDiscountPct: number;
  ongoingDiscountPct: number;
  firstOrderGiftVariantId: string | null;
  firstOrderGiftLabel: string | null;
  prepaidEnabled: boolean;
  prepaidDeliveriesPerCharge: number;
  prepaidDiscountPct: number;
  badgeText: string | null;
  showBadge: boolean;
  preselectSubscription: boolean;
  active: boolean;
  syncStatus: string;
  syncError: string | null;
  shopifyGroupId: string | null;
  /**
   * Products in this plan that ALSO carry another subscription app's selling
   * plan group, as "<product title> — <other group name>" strings. Empty when
   * there is no clash, or when Shopify could not be read (we never guess).
   */
  foreignGroupClashes: string[];
}

interface CadenceView {
  productId: string;
  title: string;
  estDaysToEmpty: number;
  recommendedWeeks: number;
  substituteVariantId: string;
  stockoutPolicy: string;
}

interface CostRowView {
  productId: string;
  title: string;
  /** COGS mirrored from Shopify inventoryItem cost onto billed lines; null when Shopify has none. */
  syncedUnitCostCents: number | null;
  /** Merchant override on the product-level ProductCadence row; null when unset. */
  overrideCents: number | null;
  /** Where the effective COGS for NEW resolution comes from: SHOPIFY | OVERRIDE | ESTIMATED. */
  effectiveSource: "SHOPIFY" | "OVERRIDE" | "ESTIMATED";
}

interface SearchVariantView {
  id: string;
  title: string;
  priceCents: number;
  availableForSale: boolean;
}

interface SearchProductView {
  id: string;
  title: string;
  variants: SearchVariantView[];
}

interface ActionData {
  intent: string;
  ok: boolean;
  toast?: string;
  planId?: string;
  errors?: Record<string, string>;
  searchResults?: SearchProductView[];
}

// ── Validation ───────────────────────────────────────────────────────────────

const planSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(120),
    productIds: z
      .array(z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/))
      .min(1, "Pick at least one product"),
    frequenciesWeeks: z
      .array(
        z
          .number()
          .int("Frequencies must be whole weeks")
          .min(1, "Frequencies must be between 1 and 26 weeks")
          .max(26, "Frequencies must be between 1 and 26 weeks"),
      )
      .min(1, "At least one frequency is required"),
    defaultFrequencyWeeks: z.number().int().min(1).max(26),
    allowFrequencyChoice: z.boolean(),
    firstOrderDiscountPct: z
      .number()
      .int("Whole percentages only")
      .min(0, "0–90%")
      .max(90, "0–90%"),
    ongoingDiscountPct: z
      .number()
      .int("Whole percentages only")
      .min(0, "0–90%")
      .max(90, "0–90%"),
    firstOrderGiftVariantId: z
      .string()
      .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "Invalid variant")
      .nullable(),
    prepaidEnabled: z.boolean(),
    prepaidDeliveriesPerCharge: z
      .number()
      .int()
      .min(2, "2–6 deliveries per charge")
      .max(6, "2–6 deliveries per charge"),
    prepaidDiscountPct: z.number().int().min(0, "0–90%").max(90, "0–90%"),
    badgeText: z.string().trim().max(40, "Keep badges under 40 characters").nullable(),
    showBadge: z.boolean(),
    preselectSubscription: z.boolean(),
    active: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (!value.frequenciesWeeks.includes(value.defaultFrequencyWeeks)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultFrequencyWeeks"],
        message: "Default frequency must be one of the offered frequencies",
      });
    }
  });

type PlanFormValues = z.infer<typeof planSchema>;

const stringArraySchema = z.array(z.string());
const intArraySchema = z.array(z.number().int());

function parseJsonStringArray(value: unknown): string[] {
  const parsed = stringArraySchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function parseJsonIntArray(value: unknown): number[] {
  const parsed = intArraySchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function boolFrom(formData: FormData, name: string): boolean {
  return formData.get(name) === "true";
}

function intFrom(formData: FormData, name: string): number {
  const raw = String(formData.get(name) ?? "").trim();
  return raw === "" ? Number.NaN : Number(raw);
}

/**
 * Product titles for an error message, falling back to the GID per product —
 * a title lookup failure must never hide WHICH products lost the plan.
 */
async function bestEffortProductTitles(
  admin: Parameters<typeof getProducts>[0],
  productIds: string[],
): Promise<string[]> {
  try {
    const titleById = new Map(
      (await getProducts(admin, productIds)).map((p) => [p.id, p.title]),
    );
    return productIds.map((id) => titleById.get(id) ?? id);
  } catch (err) {
    console.error("[plans] product title lookup for attach error failed", err);
    return productIds;
  }
}

function actorFromSession(session: {
  shop: string;
  onlineAccessInfo?: { associated_user?: { email?: string | null } } | null;
}): string {
  return session.onlineAccessInfo?.associated_user?.email ?? `admin@${session.shop}`;
}

function parsePlanForm(formData: FormData): {
  values?: PlanFormValues;
  errors?: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  let productIds: string[] = [];
  try {
    productIds = stringArraySchema.parse(
      JSON.parse(String(formData.get("productIds") ?? "[]")),
    );
  } catch {
    errors.productIds = "Invalid product selection";
  }

  const frequencies: number[] = [];
  const freqText = String(formData.get("frequenciesWeeks") ?? "");
  for (const part of freqText.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!/^\d+$/.test(part)) {
      errors.frequenciesWeeks = `"${part}" is not a whole number of weeks`;
      break;
    }
    frequencies.push(Number(part));
  }
  const uniqueFrequencies = [...new Set(frequencies)].sort((a, b) => a - b);

  const giftRaw = String(formData.get("firstOrderGiftVariantId") ?? "").trim();
  const badgeRaw = String(formData.get("badgeText") ?? "").trim();

  const candidate = {
    name: String(formData.get("name") ?? ""),
    productIds,
    frequenciesWeeks: uniqueFrequencies,
    defaultFrequencyWeeks: intFrom(formData, "defaultFrequencyWeeks"),
    allowFrequencyChoice: boolFrom(formData, "allowFrequencyChoice"),
    firstOrderDiscountPct: intFrom(formData, "firstOrderDiscountPct"),
    ongoingDiscountPct: intFrom(formData, "ongoingDiscountPct"),
    firstOrderGiftVariantId: giftRaw === "" ? null : giftRaw,
    prepaidEnabled: boolFrom(formData, "prepaidEnabled"),
    prepaidDeliveriesPerCharge: intFrom(formData, "prepaidDeliveriesPerCharge"),
    prepaidDiscountPct: intFrom(formData, "prepaidDiscountPct"),
    badgeText: badgeRaw === "" ? null : badgeRaw,
    showBadge: boolFrom(formData, "showBadge"),
    preselectSubscription: boolFrom(formData, "preselectSubscription"),
    active: boolFrom(formData, "active"),
  };

  const parsed = planSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!errors[key]) errors[key] = issue.message;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { values: parsed.success ? parsed.data : undefined };
}

// ── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }

  const [configs, cadenceRows] = await Promise.all([
    prisma.sellingPlanConfig.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.productCadence.findMany({
      where: { shopId: shop.id, variantId: null },
    }),
  ]);

  const parsedConfigs = configs.map((c) => ({
    config: c,
    productIds: parseJsonStringArray(c.productIds),
    frequenciesWeeks: parseJsonIntArray(c.frequenciesWeeks),
  }));

  // Best-effort title enrichment from Shopify — a lookup failure must never
  // break the page (failures are contained).
  const allProductIds = [
    ...new Set([
      ...parsedConfigs.flatMap((p) => p.productIds),
      ...cadenceRows.map((r) => r.productId),
    ]),
  ];
  const titleById = new Map<string, string>();
  try {
    for (const product of await getProducts(admin, allProductIds)) {
      titleById.set(product.id, product.title);
    }
  } catch (err) {
    console.error("[plans] product title lookup failed", err);
  }

  const giftVariantIds = [
    ...new Set(
      parsedConfigs
        .map((p) => p.config.firstOrderGiftVariantId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const giftLabelById = new Map<string, string>();
  try {
    for (const variant of await getVariants(admin, giftVariantIds)) {
      giftLabelById.set(
        variant.id,
        variant.title && variant.title !== "Default Title"
          ? `${variant.productTitle} — ${variant.title}`
          : variant.productTitle,
      );
    }
  } catch (err) {
    console.error("[plans] gift variant lookup failed", err);
  }

  // Which of these products already carry ANOTHER subscription app's selling
  // plan group? Both widgets would render on that product page, and the
  // customer buys whichever one they happen to click — so the merchant has to
  // know. Contained: a Shopify failure yields readable:false and no warning
  // at all rather than a wrong one.
  const foreignByProduct = new Map<string, string[]>();
  try {
    const scan = await scanForeignSellingPlanGroups(admin, shop.id);
    if (scan.readable) {
      for (const [productId, groups] of scan.foreignGroupsByProduct) {
        foreignByProduct.set(
          productId,
          groups.map((g) => g.name || g.merchantCode || g.id),
        );
      }
    }
  } catch (err) {
    console.error("[plans] foreign selling plan group scan failed", err);
  }

  const plans: PlanView[] = parsedConfigs.map(({ config, productIds, frequenciesWeeks }) => ({
    id: config.id,
    name: config.name,
    productIds,
    productTitles: productIds.map((id) => titleById.get(id) ?? id),
    frequenciesWeeks,
    defaultFrequencyWeeks: config.defaultFrequencyWeeks,
    allowFrequencyChoice: config.allowFrequencyChoice,
    firstOrderDiscountPct: config.firstOrderDiscountPct,
    ongoingDiscountPct: config.ongoingDiscountPct,
    firstOrderGiftVariantId: config.firstOrderGiftVariantId,
    firstOrderGiftLabel: config.firstOrderGiftVariantId
      ? (giftLabelById.get(config.firstOrderGiftVariantId) ??
        config.firstOrderGiftVariantId)
      : null,
    prepaidEnabled: config.prepaidEnabled,
    prepaidDeliveriesPerCharge: config.prepaidDeliveriesPerCharge,
    prepaidDiscountPct: config.prepaidDiscountPct,
    badgeText: config.badgeText,
    showBadge: config.showBadge,
    preselectSubscription: config.preselectSubscription,
    active: config.active,
    syncStatus: config.syncStatus,
    syncError: config.syncError,
    shopifyGroupId: config.shopifyGroupId,
    foreignGroupClashes: productIds.flatMap((productId) => {
      const groups = foreignByProduct.get(productId);
      if (!groups || groups.length === 0) return [];
      const title = titleById.get(productId) ?? productId;
      return [`${title} — ${groups.join(", ")}`];
    }),
  }));

  // Cadence table: every product covered by a plan config, plus any existing
  // cadence rows for products no longer in a plan (they still drive win-back).
  const cadenceByProduct = new Map(cadenceRows.map((r) => [r.productId, r]));
  const cadenceProductIds = [
    ...new Set([
      ...parsedConfigs.flatMap((p) => p.productIds),
      ...cadenceRows.map((r) => r.productId),
    ]),
  ];
  const cadences: CadenceView[] = cadenceProductIds.map((productId) => {
    const row = cadenceByProduct.get(productId);
    return {
      productId,
      title: titleById.get(productId) ?? row?.title ?? productId,
      estDaysToEmpty: row?.estDaysToEmpty ?? 56,
      recommendedWeeks: row?.recommendedWeeks ?? 8,
      substituteVariantId: row?.substituteVariantId ?? "",
      stockoutPolicy: row?.stockoutPolicy ?? "",
    };
  });

  // ── Costs & margins: effective COGS per subscribable product ───────────────
  // "Synced cost" = the latest Shopify inventoryItem cost mirrored onto a
  // billed line of that product (what the analytics actually see). Resolution
  // for profit math: synced line cost → this page's override → the costModel
  // percentage fallback (Settings → Costs & profit).
  const [costModel, syncedCostLines] = await Promise.all([
    getSetting(shop.id, "costModel"),
    prisma.contractLine.findMany({
      where: {
        productId: { in: cadenceProductIds },
        unitCostCents: { not: null },
        contract: { shopId: shop.id, ...COUNTABLE_CONTRACT },
      },
      orderBy: { createdAt: "desc" },
      distinct: ["productId"],
      select: { productId: true, unitCostCents: true },
    }),
  ]);
  const syncedCostByProduct = new Map(
    syncedCostLines.map((l) => [l.productId, l.unitCostCents]),
  );
  const costRows: CostRowView[] = cadenceProductIds.map((productId) => {
    const syncedUnitCostCents = syncedCostByProduct.get(productId) ?? null;
    const overrideCents =
      cadenceByProduct.get(productId)?.unitCostCentsOverride ?? null;
    return {
      productId,
      title:
        titleById.get(productId) ??
        cadenceByProduct.get(productId)?.title ??
        productId,
      syncedUnitCostCents,
      overrideCents,
      effectiveSource:
        syncedUnitCostCents != null
          ? "SHOPIFY"
          : overrideCents != null
            ? "OVERRIDE"
            : "ESTIMATED",
    };
  });

  return json({
    currencyCode: shop.currencyCode,
    plans,
    cadences,
    costRows,
    cogsFallbackPctOfPrice: costModel.cogsFallbackPctOfPrice,
  });
};

// ── Action ───────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await getPrimaryShop();
  if (!shop) {
    throw new Response("App is not installed on any shop", { status: 503 });
  }
  const actor = actorFromSession(session);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "search-products") {
    const query = String(formData.get("query") ?? "").trim();
    if (!query) return json<ActionData>({ intent, ok: true, searchResults: [] });
    try {
      const results = await searchProducts(admin, query, 12);
      return json<ActionData>({
        intent,
        ok: true,
        searchResults: results.map((p) => ({
          id: p.id,
          title: p.title,
          variants: p.variants.map((v) => ({
            id: v.id,
            title: v.title,
            priceCents: v.priceCents,
            availableForSale: v.availableForSale,
          })),
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Product search failed: ${message}`,
      });
    }
  }

  if (intent === "save-plan") {
    const { values, errors } = parsePlanForm(formData);
    if (!values) {
      return json<ActionData>(
        { intent, ok: false, errors: errors ?? { form: "Invalid form" } },
        { status: 422 },
      );
    }

    const planId = String(formData.get("planId") ?? "");
    const data = {
      name: values.name,
      productIds: values.productIds,
      frequenciesWeeks: values.frequenciesWeeks,
      defaultFrequencyWeeks: values.defaultFrequencyWeeks,
      allowFrequencyChoice: values.allowFrequencyChoice,
      firstOrderDiscountPct: values.firstOrderDiscountPct,
      ongoingDiscountPct: values.ongoingDiscountPct,
      firstOrderGiftVariantId: values.firstOrderGiftVariantId,
      prepaidEnabled: values.prepaidEnabled,
      prepaidDeliveriesPerCharge: values.prepaidDeliveriesPerCharge,
      prepaidDiscountPct: values.prepaidDiscountPct,
      badgeText: values.badgeText,
      showBadge: values.showBadge,
      preselectSubscription: values.preselectSubscription,
      active: values.active,
      // Any edit requires a re-sync to be reflected on Shopify.
      syncStatus: "PENDING",
      syncError: null,
    };

    let saved;
    if (planId) {
      const existing = await prisma.sellingPlanConfig.findFirst({
        where: { id: planId, shopId: shop.id },
      });
      if (!existing) {
        return json<ActionData>(
          { intent, ok: false, toast: "Plan not found" },
          { status: 404 },
        );
      }
      saved = await prisma.sellingPlanConfig.update({
        where: { id: planId },
        data,
      });
    } else {
      saved = await prisma.sellingPlanConfig.create({
        data: { shopId: shop.id, ...data },
      });
    }

    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: planId
          ? "selling_plan_config_updated"
          : "selling_plan_config_created",
        planConfigId: saved.id,
        name: saved.name,
        productCount: values.productIds.length,
        frequenciesWeeks: values.frequenciesWeeks,
        firstOrderDiscountPct: values.firstOrderDiscountPct,
        ongoingDiscountPct: values.ongoingDiscountPct,
        prepaidEnabled: values.prepaidEnabled,
      },
    });

    return json<ActionData>({
      intent,
      ok: true,
      planId: saved.id,
      toast: 'Plan saved — click "Sync to Shopify" to publish it',
    });
  }

  if (intent === "sync-plan") {
    const planId = String(formData.get("planId") ?? "");
    const config = await prisma.sellingPlanConfig.findFirst({
      where: { id: planId, shopId: shop.id },
    });
    if (!config) {
      return json<ActionData>(
        { intent, ok: false, toast: "Plan not found" },
        { status: 404 },
      );
    }
    try {
      const result = await syncSellingPlanGroupFromConfig(admin, config);

      // Post-sync attachment verification. The mutations returning without
      // userErrors is not proof the storefront agrees: another subscription
      // app's product sync can detach our group from products it also manages
      // (observed live), and a deleted product vanishes silently. SYNCED is
      // only ever written after the Admin API confirms the group sits on
      // EVERY product in the config — anything else is ATTACH_FAILED with the
      // products named, so the merchant never trusts a widget that is not
      // there. Verification reads admin GIDs against admin GIDs (one id
      // space, reliable — unlike storefront Liquid group ids).
      const configProductIds = parseJsonStringArray(config.productIds);
      let syncStatus = "SYNCED";
      let syncError: string | null = null;
      let missingProductIds: string[] = [];
      try {
        missingProductIds = await findProductsMissingFromGroup(
          admin,
          result.groupId,
          configProductIds,
        );
        if (missingProductIds.length > 0) {
          const names = await bestEffortProductTitles(admin, missingProductIds);
          syncStatus = "ATTACH_FAILED";
          syncError = `Synced to Shopify, but the plan is not attached to: ${names.join(
            ", ",
          )}. Another subscription app's sync may be reconciling products it manages — re-sync, and exclude these products from the other app's management.`;
        }
      } catch (verifyErr) {
        // Unverifiable is not SYNCED: the whole point of this check is that
        // the merchant never sees SYNCED while the storefront may disagree.
        const message =
          verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        syncStatus = "ATTACH_FAILED";
        syncError = `Synced to Shopify, but product attachment could not be verified (${message}). Re-sync to verify.`;
      }

      await prisma.sellingPlanConfig.update({
        where: { id: config.id },
        data: {
          shopifyGroupId: result.groupId,
          syncStatus,
          syncError,
        },
      });
      // Ownership evidence: remember this group's plan ids (append-only) and
      // republish the storefront allow-list metafield, so the buy box renders
      // OUR group only and the contract sync can tell our subscribers from
      // another subscription app's. Never throws. Recorded even on
      // ATTACH_FAILED — the group and its plans DO exist on Shopify, and the
      // allow-list staying current is what keeps the widget correct on the
      // products that are still attached.
      const ownership = await recordSellingPlanSync({
        shopId: shop.id,
        shopDomain: shop.domain,
        configId: config.id,
        groupId: result.groupId,
        planIds: result.planIds,
      });
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "selling_plan_synced",
          planConfigId: config.id,
          shopifyGroupId: result.groupId,
          planCount: result.planIds.length,
          ownedPlanIds: ownership.storedPlanIds.length,
          planGroupsMetafield: ownership.metafield.ok
            ? "published"
            : `failed: ${ownership.metafield.error ?? "unknown error"}`,
          syncStatus,
          ...(syncStatus === "ATTACH_FAILED"
            ? { attachMissingProductIds: missingProductIds, attachError: syncError }
            : {}),
        },
      });
      if (syncStatus === "ATTACH_FAILED") {
        return json<ActionData>({
          intent,
          ok: false,
          toast:
            missingProductIds.length > 0
              ? `"${config.name}" synced, but ${missingProductIds.length} product(s) are missing the plan — see the Plans row`
              : `"${config.name}" synced, but attachment could not be verified — re-sync to verify`,
        });
      }
      return json<ActionData>({
        intent,
        ok: true,
        toast: `"${config.name}" synced to Shopify`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.sellingPlanConfig
        .update({
          where: { id: config.id },
          data: { syncStatus: "ERROR", syncError: message },
        })
        .catch((updateErr) =>
          console.error("[plans] failed to record sync error", updateErr),
        );
      await logEvent({
        shopId: shop.id,
        type: "admin.action",
        source: "ADMIN",
        actor,
        payload: {
          action: "selling_plan_sync_failed",
          planConfigId: config.id,
          error: message,
        },
      });
      return json<ActionData>({
        intent,
        ok: false,
        toast: `Sync failed: ${message}`,
      });
    }
  }

  if (intent === "delete-plan") {
    const planId = String(formData.get("planId") ?? "");
    const config = await prisma.sellingPlanConfig.findFirst({
      where: { id: planId, shopId: shop.id },
    });
    if (!config) {
      return json<ActionData>(
        { intent, ok: false, toast: "Plan not found" },
        { status: 404 },
      );
    }
    if (config.shopifyGroupId) {
      // Best effort — a group already deleted in Shopify admin must not block
      // the local delete. Existing contracts are unaffected either way.
      try {
        await deleteSellingPlanGroup(admin, config.shopifyGroupId);
      } catch (err) {
        console.error(
          "[plans] best-effort selling plan group delete failed",
          config.shopifyGroupId,
          err,
        );
      }
    }
    await prisma.sellingPlanConfig.delete({ where: { id: config.id } });
    // Keep the storefront allow-list truthful: a deleted config must not leave
    // its group id in cellexia.plan_groups. Never throws.
    await publishOwnGroupsMetafield(shop.domain);
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "selling_plan_config_deleted",
        planConfigId: config.id,
        name: config.name,
        shopifyGroupId: config.shopifyGroupId,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast: "Plan deleted — existing subscriber contracts are unaffected",
    });
  }

  if (intent === "save-cogs-override") {
    const productId = String(formData.get("productId") ?? "");
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
      return json<ActionData>(
        { intent, ok: false, toast: "Invalid product" },
        { status: 422 },
      );
    }
    // Money field: decimal currency units ("24.00"), empty clears the override.
    const raw = String(formData.get("unitCost") ?? "").trim().replace(",", ".");
    let unitCostCentsOverride: number | null = null;
    if (raw !== "") {
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
        return json<ActionData>({
          intent,
          ok: false,
          toast: "Cost must be a positive amount (or empty to clear)",
        });
      }
      unitCostCentsOverride = Math.round(amount * 100);
    }
    const title = String(formData.get("title") ?? "").trim() || null;

    const existing = await prisma.productCadence.findFirst({
      where: { shopId: shop.id, productId, variantId: null },
    });
    if (existing) {
      await prisma.productCadence.update({
        where: { id: existing.id },
        data: { unitCostCentsOverride, ...(title ? { title } : {}) },
      });
    } else {
      await prisma.productCadence.create({
        data: {
          shopId: shop.id,
          productId,
          variantId: null,
          title,
          unitCostCentsOverride,
        },
      });
    }
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "product_cogs_override_updated",
        productId,
        unitCostCentsOverride,
      },
    });
    return json<ActionData>({
      intent,
      ok: true,
      toast:
        unitCostCentsOverride == null
          ? "Cost override cleared"
          : "Cost override saved — analytics use it from the next nightly recompute",
    });
  }

  if (intent === "save-cadence") {
    const productId = String(formData.get("productId") ?? "");
    if (!/^gid:\/\/shopify\/Product\/\d+$/.test(productId)) {
      return json<ActionData>(
        { intent, ok: false, toast: "Invalid product" },
        { status: 422 },
      );
    }
    const estDaysToEmpty = intFrom(formData, "estDaysToEmpty");
    const recommendedWeeks = intFrom(formData, "recommendedWeeks");
    if (
      !Number.isInteger(estDaysToEmpty) ||
      estDaysToEmpty < 1 ||
      estDaysToEmpty > 365
    ) {
      return json<ActionData>({
        intent,
        ok: false,
        toast: "Days to empty must be a whole number between 1 and 365",
      });
    }
    if (
      !Number.isInteger(recommendedWeeks) ||
      recommendedWeeks < 1 ||
      recommendedWeeks > 26
    ) {
      return json<ActionData>({
        intent,
        ok: false,
        toast: "Recommended weeks must be between 1 and 26",
      });
    }
    let substituteVariantId: string | null = String(
      formData.get("substituteVariantId") ?? "",
    ).trim();
    if (substituteVariantId === "") {
      substituteVariantId = null;
    } else if (/^\d+$/.test(substituteVariantId)) {
      substituteVariantId = `gid://shopify/ProductVariant/${substituteVariantId}`;
    } else if (
      !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(substituteVariantId)
    ) {
      return json<ActionData>({
        intent,
        ok: false,
        toast:
          "Substitute variant must be a numeric variant ID or a gid://shopify/ProductVariant/… GID",
      });
    }
    const stockoutRaw = String(formData.get("stockoutPolicy") ?? "");
    const stockoutPolicy =
      stockoutRaw === "" ? null : stockoutRaw;
    if (
      stockoutPolicy !== null &&
      !["DELAY", "SKIP_NOTIFY", "SUBSTITUTE"].includes(stockoutPolicy)
    ) {
      return json<ActionData>({
        intent,
        ok: false,
        toast: "Invalid stockout policy",
      });
    }
    const title = String(formData.get("title") ?? "").trim() || null;

    const existing = await prisma.productCadence.findFirst({
      where: { shopId: shop.id, productId, variantId: null },
    });
    const data = {
      title,
      estDaysToEmpty,
      recommendedWeeks,
      substituteVariantId,
      stockoutPolicy,
    };
    if (existing) {
      await prisma.productCadence.update({ where: { id: existing.id }, data });
    } else {
      await prisma.productCadence.create({
        data: { shopId: shop.id, productId, variantId: null, ...data },
      });
    }
    await logEvent({
      shopId: shop.id,
      type: "admin.action",
      source: "ADMIN",
      actor,
      payload: {
        action: "product_cadence_updated",
        productId,
        estDaysToEmpty,
        recommendedWeeks,
        substituteVariantId,
        stockoutPolicy,
      },
    });
    return json<ActionData>({ intent, ok: true, toast: "Cadence saved" });
  }

  return json<ActionData>(
    { intent, ok: false, toast: "Unknown action" },
    { status: 400 },
  );
};

// ── Product / variant pickers (fetcher-driven search) ────────────────────────

interface SelectedProduct {
  id: string;
  title: string;
  examplePriceCents: number | null;
}

function useProductSearch() {
  const fetcher = useFetcher<ActionData>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const handle = setTimeout(() => {
      fetcher.submit(
        { intent: "search-products", query: q },
        { method: "post" },
      );
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return {
    query,
    setQuery,
    results: fetcher.data?.searchResults ?? [],
    loading: fetcher.state !== "idle",
  };
}

function ProductMultiPicker({
  selected,
  onChange,
  error,
}: {
  selected: SelectedProduct[];
  onChange: (next: SelectedProduct[]) => void;
  error?: string;
}) {
  const { query, setQuery, results, loading } = useProductSearch();
  const selectedIds = useMemo(
    () => new Set(selected.map((s) => s.id)),
    [selected],
  );

  return (
    <BlockStack gap="200">
      <TextField
        label="Products"
        autoComplete="off"
        value={query}
        onChange={setQuery}
        placeholder="Search products to add…"
        helpText="Products this plan (and its subscribe option) applies to."
        loading={loading}
        error={error}
      />
      {results.length > 0 && query.trim().length >= 2 ? (
        <Box
          borderColor="border"
          borderWidth="025"
          borderRadius="200"
          padding="150"
        >
          <BlockStack gap="100">
            {results
              .filter((p) => !selectedIds.has(p.id))
              .map((product) => (
                <Button
                  key={product.id}
                  variant="tertiary"
                  textAlign="left"
                  fullWidth
                  onClick={() =>
                    onChange([
                      ...selected,
                      {
                        id: product.id,
                        title: product.title,
                        examplePriceCents:
                          product.variants[0]?.priceCents ?? null,
                      },
                    ])
                  }
                >
                  {product.title}
                </Button>
              ))}
          </BlockStack>
        </Box>
      ) : null}
      {selected.length > 0 ? (
        <InlineStack gap="150" wrap>
          {selected.map((product) => (
            <Tag
              key={product.id}
              onRemove={() =>
                onChange(selected.filter((s) => s.id !== product.id))
              }
            >
              {product.title}
            </Tag>
          ))}
        </InlineStack>
      ) : (
        <Text as="p" tone="subdued" variant="bodySm">
          No products selected yet.
        </Text>
      )}
    </BlockStack>
  );
}

function VariantPicker({
  label,
  helpText,
  currencyCode,
  selectedId,
  selectedLabel,
  onSelect,
  onClear,
}: {
  label: string;
  helpText: string;
  currencyCode: string;
  selectedId: string | null;
  selectedLabel: string | null;
  onSelect: (variantId: string, label: string) => void;
  onClear: () => void;
}) {
  const { query, setQuery, results, loading } = useProductSearch();

  return (
    <BlockStack gap="200">
      {selectedId ? (
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="medium">
            {label}
          </Text>
          <InlineStack gap="150">
            <Tag onRemove={onClear}>{selectedLabel ?? selectedId}</Tag>
          </InlineStack>
          <Text as="p" tone="subdued" variant="bodySm">
            {helpText}
          </Text>
        </BlockStack>
      ) : (
        <>
          <TextField
            label={label}
            autoComplete="off"
            value={query}
            onChange={setQuery}
            placeholder="Search for a product…"
            helpText={helpText}
            loading={loading}
          />
          {results.length > 0 && query.trim().length >= 2 ? (
            <Box
              borderColor="border"
              borderWidth="025"
              borderRadius="200"
              padding="150"
            >
              <BlockStack gap="100">
                {results.flatMap((product) =>
                  product.variants.map((variant) => {
                    const variantLabel =
                      variant.title && variant.title !== "Default Title"
                        ? `${product.title} — ${variant.title}`
                        : product.title;
                    return (
                      <Button
                        key={variant.id}
                        variant="tertiary"
                        textAlign="left"
                        fullWidth
                        onClick={() => onSelect(variant.id, variantLabel)}
                      >
                        {`${variantLabel} (${formatMoney(variant.priceCents, currencyCode)})`}
                      </Button>
                    );
                  }),
                )}
              </BlockStack>
            </Box>
          ) : null}
        </>
      )}
    </BlockStack>
  );
}

// ── Plan form modal ──────────────────────────────────────────────────────────

const EXAMPLE_FALLBACK_CENTS = 6000;

function PlanFormModal({
  plan,
  open,
  currencyCode,
  errors,
  saving,
  onClose,
  onSave,
}: {
  plan: PlanView | null;
  open: boolean;
  currencyCode: string;
  errors: Record<string, string>;
  saving: boolean;
  onClose: () => void;
  onSave: (fd: FormData) => void;
}) {
  const [name, setName] = useState(plan?.name ?? "");
  const [selectedProducts, setSelectedProducts] = useState<SelectedProduct[]>(
    plan
      ? plan.productIds.map((id, i) => ({
          id,
          title: plan.productTitles[i] ?? id,
          examplePriceCents: null,
        }))
      : [],
  );
  const [freqText, setFreqText] = useState(
    plan ? plan.frequenciesWeeks.join(", ") : "4, 6, 8, 10, 12",
  );
  const [defaultFreq, setDefaultFreq] = useState(
    String(plan?.defaultFrequencyWeeks ?? 8),
  );
  const [allowChoice, setAllowChoice] = useState(
    plan?.allowFrequencyChoice ?? true,
  );
  const [firstPct, setFirstPct] = useState(
    String(plan?.firstOrderDiscountPct ?? 20),
  );
  const [ongoingPct, setOngoingPct] = useState(
    String(plan?.ongoingDiscountPct ?? 10),
  );
  const [giftVariantId, setGiftVariantId] = useState<string | null>(
    plan?.firstOrderGiftVariantId ?? null,
  );
  const [giftLabel, setGiftLabel] = useState<string | null>(
    plan?.firstOrderGiftLabel ?? null,
  );
  const [prepaidEnabled, setPrepaidEnabled] = useState(
    plan?.prepaidEnabled ?? false,
  );
  const [prepaidDeliveries, setPrepaidDeliveries] = useState(
    String(plan?.prepaidDeliveriesPerCharge ?? 3),
  );
  const [prepaidPct, setPrepaidPct] = useState(
    String(plan?.prepaidDiscountPct ?? 15),
  );
  const [badgeText, setBadgeText] = useState(plan?.badgeText ?? "Most popular");
  const [showBadge, setShowBadge] = useState(plan?.showBadge ?? true);
  const [preselect, setPreselect] = useState(
    plan?.preselectSubscription ?? true,
  );
  const [active, setActive] = useState(plan?.active ?? true);

  const parsedFrequencies = useMemo(
    () =>
      [
        ...new Set(
          freqText
            .split(",")
            .map((s) => s.trim())
            .filter((s) => /^\d+$/.test(s))
            .map(Number)
            .filter((n) => n >= 1 && n <= 26),
        ),
      ].sort((a, b) => a - b),
    [freqText],
  );

  const examplePriceCents =
    selectedProducts.find((p) => p.examplePriceCents != null)
      ?.examplePriceCents ?? EXAMPLE_FALLBACK_CENTS;
  const firstPctNum = Number(firstPct) || 0;
  const ongoingPctNum = Number(ongoingPct) || 0;
  const prepaidPctNum = Number(prepaidPct) || 0;

  const handleSave = () => {
    const fd = new FormData();
    fd.set("intent", "save-plan");
    if (plan) fd.set("planId", plan.id);
    fd.set("name", name);
    fd.set("productIds", JSON.stringify(selectedProducts.map((p) => p.id)));
    fd.set("frequenciesWeeks", freqText);
    fd.set("defaultFrequencyWeeks", defaultFreq);
    fd.set("allowFrequencyChoice", String(allowChoice));
    fd.set("firstOrderDiscountPct", firstPct);
    fd.set("ongoingDiscountPct", ongoingPct);
    fd.set("firstOrderGiftVariantId", giftVariantId ?? "");
    fd.set("prepaidEnabled", String(prepaidEnabled));
    fd.set("prepaidDeliveriesPerCharge", prepaidDeliveries);
    fd.set("prepaidDiscountPct", prepaidPct);
    fd.set("badgeText", badgeText);
    fd.set("showBadge", String(showBadge));
    fd.set("preselectSubscription", String(preselect));
    fd.set("active", String(active));
    onSave(fd);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={plan ? `Edit "${plan.name}"` : "Create subscription plan"}
      primaryAction={{
        content: "Save plan",
        onAction: handleSave,
        loading: saving,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onClose }]}
      size="large"
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Plan name"
            autoComplete="off"
            value={name}
            onChange={setName}
            error={errors.name}
            helpText='Internal + storefront group name, e.g. "Cellexia Subscribe & Save".'
          />
          <ProductMultiPicker
            selected={selectedProducts}
            onChange={setSelectedProducts}
            error={errors.productIds}
          />
          <Divider />
          <Text as="h3" variant="headingSm">
            Delivery frequency
          </Text>
          <TextField
            label="Offered frequencies (weeks, comma-separated)"
            autoComplete="off"
            value={freqText}
            onChange={setFreqText}
            error={errors.frequenciesWeeks}
            helpText="Whole weeks between 1 and 26, e.g. 4, 6, 8, 10, 12. Real cadences beat arbitrary monthly."
          />
          <Select
            label="Default frequency"
            options={
              parsedFrequencies.length > 0
                ? parsedFrequencies.map((w) => ({
                    label: `Every ${w} weeks`,
                    value: String(w),
                  }))
                : [{ label: "Add frequencies first", value: defaultFreq }]
            }
            value={defaultFreq}
            onChange={setDefaultFreq}
            error={errors.defaultFrequencyWeeks}
            helpText="Preselected in the buy box — match it to the product's real days-to-empty."
          />
          <Checkbox
            label="Let customers choose their frequency"
            checked={allowChoice}
            onChange={setAllowChoice}
          />
          <Divider />
          <Text as="h3" variant="headingSm">
            Discounts
          </Text>
          <InlineStack gap="400" wrap>
            <Box minWidth="200px">
              <TextField
                label="First-order discount %"
                autoComplete="off"
                type="number"
                min={0}
                max={90}
                value={firstPct}
                onChange={setFirstPct}
                suffix="%"
                error={errors.firstOrderDiscountPct}
                helpText="Acquisition lever — recovered over the subscriber lifetime."
              />
            </Box>
            <Box minWidth="200px">
              <TextField
                label="Ongoing discount %"
                autoComplete="off"
                type="number"
                min={0}
                max={90}
                value={ongoingPct}
                onChange={setOngoingPct}
                suffix="%"
                error={errors.ongoingDiscountPct}
                helpText="Every renewal — this compounds into LTGP, keep it lean."
              />
            </Box>
          </InlineStack>
          <Banner tone="info">
            <Text as="p" variant="bodySm">
              {`Example at ${formatMoney(examplePriceCents, currencyCode)}: first order ${formatMoney(
                applyDiscountPct(examplePriceCents, firstPctNum),
                currencyCode,
              )}, then ${formatMoney(
                applyDiscountPct(examplePriceCents, ongoingPctNum),
                currencyCode,
              )} per renewal.`}
              {prepaidEnabled
                ? ` Prepaid: ${formatMoney(
                    applyDiscountPct(examplePriceCents, prepaidPctNum),
                    currencyCode,
                  )} per delivery, billed ${prepaidDeliveries} deliveries at a time.`
                : ""}
            </Text>
          </Banner>
          <VariantPicker
            label="First-order gift (optional)"
            helpText="A free variant added to the first order — an alternative (or addition) to a deep first-order discount."
            currencyCode={currencyCode}
            selectedId={giftVariantId}
            selectedLabel={giftLabel}
            onSelect={(id, label) => {
              setGiftVariantId(id);
              setGiftLabel(label);
            }}
            onClear={() => {
              setGiftVariantId(null);
              setGiftLabel(null);
            }}
          />
          {errors.firstOrderGiftVariantId ? (
            <InlineError
              message={errors.firstOrderGiftVariantId}
              fieldID="firstOrderGiftVariantId"
            />
          ) : null}
          <Divider />
          <Text as="h3" variant="headingSm">
            Prepaid (bill once, ship several times)
          </Text>
          <Checkbox
            label="Offer a prepaid option"
            checked={prepaidEnabled}
            onChange={setPrepaidEnabled}
            helpText="Locks in revenue up front and removes per-cycle payment failure risk."
          />
          {prepaidEnabled ? (
            <InlineStack gap="400" wrap>
              <Box minWidth="200px">
                <Select
                  label="Deliveries per charge"
                  options={[2, 3, 4, 5, 6].map((n) => ({
                    label: `${n} deliveries`,
                    value: String(n),
                  }))}
                  value={prepaidDeliveries}
                  onChange={setPrepaidDeliveries}
                  error={errors.prepaidDeliveriesPerCharge}
                />
              </Box>
              <Box minWidth="200px">
                <TextField
                  label="Prepaid discount %"
                  autoComplete="off"
                  type="number"
                  min={0}
                  max={90}
                  value={prepaidPct}
                  onChange={setPrepaidPct}
                  suffix="%"
                  error={errors.prepaidDiscountPct}
                />
              </Box>
            </InlineStack>
          ) : null}
          <Divider />
          <Text as="h3" variant="headingSm">
            Buy-box presentation
          </Text>
          <TextField
            label="Badge text"
            autoComplete="off"
            value={badgeText}
            onChange={setBadgeText}
            error={errors.badgeText}
            helpText='Shown on the subscription option, e.g. "Most popular".'
          />
          <Checkbox
            label="Show the badge"
            checked={showBadge}
            onChange={setShowBadge}
          />
          <Checkbox
            label="Preselect the subscription option"
            checked={preselect}
            onChange={setPreselect}
            helpText="Preselecting subscription is the single biggest take-rate lever on the PDP."
          />
          <Checkbox
            label="Plan is active"
            checked={active}
            onChange={setActive}
          />
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

// ── Cadence row ──────────────────────────────────────────────────────────────

const STOCKOUT_OPTIONS = [
  { label: "Shop default", value: "" },
  { label: "Delay the renewal", value: "DELAY" },
  { label: "Skip + notify", value: "SKIP_NOTIFY" },
  { label: "Substitute variant", value: "SUBSTITUTE" },
];

function CadenceRow({ row }: { row: CadenceView }) {
  const fetcher = useFetcher<ActionData>();
  const [est, setEst] = useState(String(row.estDaysToEmpty));
  const [weeks, setWeeks] = useState(String(row.recommendedWeeks));
  const [substitute, setSubstitute] = useState(row.substituteVariantId);
  const [policy, setPolicy] = useState(row.stockoutPolicy);

  const estNum = Number(est);
  const suggestion =
    Number.isFinite(estNum) && estNum > 0
      ? `≈ ${Math.max(1, Math.round(estNum / 7))}w to empty`
      : "";

  const save = () => {
    const fd = new FormData();
    fd.set("intent", "save-cadence");
    fd.set("productId", row.productId);
    fd.set("title", row.title);
    fd.set("estDaysToEmpty", est);
    fd.set("recommendedWeeks", weeks);
    fd.set("substituteVariantId", substitute);
    fd.set("stockoutPolicy", policy);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Box paddingBlock="200">
      <InlineStack gap="300" blockAlign="end" wrap>
        <Box minWidth="180px">
          <BlockStack gap="050">
            <Text as="p" variant="bodyMd" fontWeight="medium" truncate>
              {row.title}
            </Text>
            <Text as="p" tone="subdued" variant="bodySm">
              {suggestion}
            </Text>
          </BlockStack>
        </Box>
        <Box minWidth="120px">
          <TextField
            label="Days to empty"
            autoComplete="off"
            type="number"
            min={1}
            max={365}
            value={est}
            onChange={setEst}
          />
        </Box>
        <Box minWidth="130px">
          <TextField
            label="Recommended weeks"
            autoComplete="off"
            type="number"
            min={1}
            max={26}
            value={weeks}
            onChange={setWeeks}
          />
        </Box>
        <Box minWidth="220px">
          <TextField
            label="Substitute variant"
            autoComplete="off"
            value={substitute}
            onChange={setSubstitute}
            placeholder="gid://shopify/ProductVariant/… or numeric ID"
          />
        </Box>
        <Box minWidth="170px">
          <Select
            label="Stockout policy"
            options={STOCKOUT_OPTIONS}
            value={policy}
            onChange={setPolicy}
          />
        </Box>
        <Button
          onClick={save}
          loading={fetcher.state !== "idle"}
          size="medium"
        >
          Save
        </Button>
      </InlineStack>
      {fetcher.data && !fetcher.data.ok && fetcher.data.toast ? (
        <Box paddingBlockStart="100">
          <InlineError
            message={fetcher.data.toast}
            fieldID={`cadence-${row.productId}`}
          />
        </Box>
      ) : null}
    </Box>
  );
}

// ── Costs & margins row ──────────────────────────────────────────────────────

function costSourceBadge(
  row: CostRowView,
  fallbackPct: number,
): { tone: "success" | "info" | "attention"; label: string } {
  if (row.effectiveSource === "SHOPIFY") {
    return { tone: "success", label: "Shopify cost" };
  }
  if (row.effectiveSource === "OVERRIDE") {
    return { tone: "info", label: "Override" };
  }
  return { tone: "attention", label: `Estimated ${fallbackPct}%` };
}

function CostRow({
  row,
  currencyCode,
  fallbackPct,
}: {
  row: CostRowView;
  currencyCode: string;
  fallbackPct: number;
}) {
  const fetcher = useFetcher<ActionData>();
  const [value, setValue] = useState(
    row.overrideCents != null ? (row.overrideCents / 100).toFixed(2) : "",
  );
  const badge = costSourceBadge(row, fallbackPct);

  const save = () => {
    const fd = new FormData();
    fd.set("intent", "save-cogs-override");
    fd.set("productId", row.productId);
    fd.set("title", row.title);
    fd.set("unitCost", value);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <Box paddingBlock="200">
      <InlineStack gap="300" blockAlign="end" wrap>
        <Box minWidth="220px">
          <BlockStack gap="050">
            <Text as="p" variant="bodyMd" fontWeight="medium" truncate>
              {row.title}
            </Text>
            <InlineStack gap="150" blockAlign="center">
              <Badge tone={badge.tone}>{badge.label}</Badge>
              <Text as="span" tone="subdued" variant="bodySm">
                {row.syncedUnitCostCents != null
                  ? `Shopify: ${formatMoney(row.syncedUnitCostCents, currencyCode)}`
                  : "No cost in Shopify"}
              </Text>
            </InlineStack>
          </BlockStack>
        </Box>
        <Box minWidth="180px">
          <TextField
            label="Cost per unit (override)"
            autoComplete="off"
            type="number"
            min={0}
            step={0.01}
            value={value}
            onChange={setValue}
            prefix={currencyCode}
            placeholder="e.g. 24.00"
          />
        </Box>
        <Button onClick={save} loading={fetcher.state !== "idle"} size="medium">
          Save
        </Button>
      </InlineStack>
      {fetcher.data && !fetcher.data.ok && fetcher.data.toast ? (
        <Box paddingBlockStart="100">
          <InlineError
            message={fetcher.data.toast}
            fieldID={`cogs-${row.productId}`}
          />
        </Box>
      ) : null}
    </Box>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function syncBadge(plan: PlanView) {
  if (plan.syncStatus === "SYNCED") {
    return <Badge tone="success">Synced</Badge>;
  }
  if (plan.syncStatus === "ATTACH_FAILED") {
    // The group exists on Shopify but is NOT attached to every product in the
    // config (or that could not be verified) — the buy box is missing on
    // those product pages. Never rendered as Synced; the tooltip names the
    // products so the merchant knows exactly where to look.
    return (
      <Tooltip
        content={
          plan.syncError ??
          "The plan is not attached to every product — re-sync, and exclude these products from the other subscription app's management"
        }
      >
        <Badge tone="critical">Attach failed</Badge>
      </Tooltip>
    );
  }
  if (plan.syncStatus === "ERROR") {
    return (
      <Tooltip content={plan.syncError ?? "Unknown sync error"}>
        <Badge tone="critical">Error</Badge>
      </Tooltip>
    );
  }
  return <Badge tone="attention">Needs sync</Badge>;
}

export default function PlansPage() {
  const { currencyCode, plans, cadences, costRows, cogsFallbackPctOfPrice } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PlanView | null>(null);

  const editingPlan = plans.find((p) => p.id === editingPlanId) ?? null;

  useEffect(() => {
    if (!actionData) return;
    if (actionData.toast) {
      shopify.toast.show(actionData.toast, { isError: !actionData.ok });
    }
    if (actionData.ok && actionData.intent === "save-plan") {
      setModalOpen(false);
      setEditingPlanId(null);
    }
    if (actionData.ok && actionData.intent === "delete-plan") {
      setDeleteTarget(null);
    }
  }, [actionData, shopify]);

  const navIntent = navigation.formData?.get("intent");
  const navPlanId = navigation.formData?.get("planId");
  const busy = navigation.state !== "idle";

  const planErrors =
    actionData && actionData.intent === "save-plan" && !actionData.ok
      ? (actionData.errors ?? {})
      : {};

  const clashingPlans = plans.filter((p) => p.foreignGroupClashes.length > 0);

  const planRows = plans.map((plan) => [
    <BlockStack key={`${plan.id}-name`} gap="050">
      <InlineStack gap="150" blockAlign="center">
        <Text as="span" fontWeight="medium">
          {plan.name}
        </Text>
        {plan.active ? null : <Badge tone="info">Inactive</Badge>}
      </InlineStack>
      {plan.firstOrderGiftLabel ? (
        <Text as="span" tone="subdued" variant="bodySm">
          {`First-order gift: ${plan.firstOrderGiftLabel}`}
        </Text>
      ) : null}
      {plan.foreignGroupClashes.length > 0 ? (
        <Tooltip content={plan.foreignGroupClashes.join(" · ")}>
          <Badge tone="warning">Shares products with another app</Badge>
        </Tooltip>
      ) : null}
    </BlockStack>,
    <Tooltip
      key={`${plan.id}-products`}
      content={plan.productTitles.join(", ") || "No products"}
    >
      <Text as="span">{String(plan.productIds.length)}</Text>
    </Tooltip>,
    plan.frequenciesWeeks.map((w) => `${w}w`).join(" / "),
    `${plan.firstOrderDiscountPct}% → ${plan.ongoingDiscountPct}%`,
    plan.prepaidEnabled ? (
      <Badge key={`${plan.id}-prepaid`} tone="info">
        {`${plan.prepaidDeliveriesPerCharge}× @ ${plan.prepaidDiscountPct}%`}
      </Badge>
    ) : (
      "—"
    ),
    plan.showBadge && plan.badgeText ? plan.badgeText : "—",
    syncBadge(plan),
    <InlineStack key={`${plan.id}-actions`} gap="200" wrap={false}>
      <Button
        size="slim"
        onClick={() => {
          setEditingPlanId(plan.id);
          setModalOpen(true);
        }}
      >
        Edit
      </Button>
      <Button
        size="slim"
        variant="primary"
        loading={busy && navIntent === "sync-plan" && navPlanId === plan.id}
        onClick={() =>
          submit({ intent: "sync-plan", planId: plan.id }, { method: "post" })
        }
      >
        Sync to Shopify
      </Button>
      <Button
        size="slim"
        tone="critical"
        onClick={() => setDeleteTarget(plan)}
      >
        Delete
      </Button>
    </InlineStack>,
  ]);

  return (
    <Page
      title="Subscription plans"
      subtitle="Offer architecture: frequencies, discounts, prepaid, buy-box presentation."
      primaryAction={{
        content: "Create plan",
        onAction: () => {
          setEditingPlanId(null);
          setModalOpen(true);
        },
      }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Another subscription app has plans on the same products. Not an
                error and not blocking — but on those product pages BOTH apps'
                widgets can render, and each sells its own plan. */}
            {clashingPlans.length > 0 ? (
              <Banner
                tone="warning"
                title="Some of these products also have plans from another subscription app"
              >
                <BlockStack gap="200">
                  <p>
                    On those product pages customers will see whichever widget
                    each app renders, and a purchase through the other app's
                    widget creates a subscription that app owns — Cellexia will
                    never bill, email or manage it. Disable the other app's
                    product-page widget on these products before you go live.
                  </p>
                  <BlockStack gap="050">
                    {clashingPlans.map((plan) => (
                      <Text as="p" variant="bodySm" key={plan.id}>
                        {`${plan.name}: ${plan.foreignGroupClashes.join(" · ")}`}
                      </Text>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Banner>
            ) : null}
            <Card>
              {plans.length === 0 ? (
                <EmptyState
                  heading="Create your first subscription plan"
                  action={{
                    content: "Create plan",
                    onAction: () => {
                      setEditingPlanId(null);
                      setModalOpen(true);
                    },
                  }}
                  image=""
                >
                  <p>
                    A plan defines the frequencies, discounts and presentation
                    of the subscribe option. Saving stores it locally; “Sync to
                    Shopify” publishes it as a selling plan group.
                  </p>
                </EmptyState>
              ) : (
                <DataTable
                  columnContentTypes={[
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Plan",
                    "Products",
                    "Frequencies",
                    "Discounts (first → ongoing)",
                    "Prepaid",
                    "Badge",
                    "Sync",
                    "Actions",
                  ]}
                  rows={planRows}
                />
              )}
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Product cadence intelligence
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Estimated days-to-empty drives the recommended frequency,
                    real-empty-date win-back timing and skip alerts. The
                    substitute variant + policy control what happens when a
                    renewal hits a stockout.
                  </Text>
                </BlockStack>
                <Divider />
                {cadences.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Add products to a plan to configure their cadence.
                  </Text>
                ) : (
                  <BlockStack gap="0">
                    {cadences.map((row) => (
                      <CadenceRow key={row.productId} row={row} />
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Costs &amp; margins
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Product cost (COGS) per unit, used by the profitability
                    analytics (LTGP, gross profit). Cellexia uses the cost from
                    Shopify (&ldquo;Cost per item&rdquo; on the variant) when it
                    exists; enter an override here for products without one.
                    Products with neither are estimated at{" "}
                    {cogsFallbackPctOfPrice}% of price — set real costs so LTGP
                    stops being an estimate. Shipping, fulfillment and payment
                    fees are configured in Settings → Costs &amp; profit.
                  </Text>
                </BlockStack>
                <Divider />
                {costRows.length === 0 ? (
                  <Text as="p" tone="subdued">
                    Add products to a plan to set their costs.
                  </Text>
                ) : (
                  <BlockStack gap="0">
                    {costRows.map((row) => (
                      <CostRow
                        key={row.productId}
                        row={row}
                        currencyCode={currencyCode}
                        fallbackPct={cogsFallbackPctOfPrice}
                      />
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      {modalOpen ? (
        <PlanFormModal
          key={editingPlan?.id ?? "new"}
          plan={editingPlan}
          open={modalOpen}
          currencyCode={currencyCode}
          errors={planErrors}
          saving={busy && navIntent === "save-plan"}
          onClose={() => {
            setModalOpen(false);
            setEditingPlanId(null);
          }}
          onSave={(fd) => submit(fd, { method: "post" })}
        />
      ) : null}

      <Modal
        open={deleteTarget != null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget ? `Delete "${deleteTarget.name}"?` : "Delete plan"}
        primaryAction={{
          content: "Delete plan",
          destructive: true,
          loading: busy && navIntent === "delete-plan",
          onAction: () => {
            if (deleteTarget) {
              submit(
                { intent: "delete-plan", planId: deleteTarget.id },
                { method: "post" },
              );
            }
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteTarget(null) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              This removes the plan configuration and (best-effort) its selling
              plan group on Shopify, so the subscribe option disappears from the
              product page.
            </Text>
            <Banner tone="warning">
              Existing subscriber contracts are <strong>not</strong> affected —
              they keep billing on their current schedule and pricing.
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
