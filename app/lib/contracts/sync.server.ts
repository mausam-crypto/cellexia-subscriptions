import type { ContractStatus, Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";
import {
  getContract,
  getOrderSummary,
  getVariants,
  listContractGids,
  type ShopifyContract,
  type ShopifyContractLine,
  type ShopifyVariant,
} from "~/lib/graphql/index.server";
import type { LocalContractWithLines, ServiceOptions } from "./shared.server";
import { reloadContract, resolveActor } from "./shared.server";

/**
 * Shopify → local mirror synchronization. Webhook truth: whatever Shopify
 * says about a contract wins over local assumptions. Called by the webhook
 * dispatcher on SUBSCRIPTION_CONTRACTS_* topics and by the initial backfill.
 *
 * Local-only extension state (skipCount, pause bookkeeping, discount grants,
 * gift/one-time-addon flags, analytics fields) is preserved; only the fields
 * Shopify owns are overwritten.
 */

// ── Mapping helpers ──────────────────────────────────────────────────────────

function mapStatus(shopifyStatus: string): ContractStatus {
  switch (shopifyStatus) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "PAUSED";
    case "CANCELLED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    case "FAILED":
    case "STALE": // STALE = billing overdue/abandoned — treat as failed locally
      return "FAILED";
    default:
      return "ACTIVE";
  }
}

/** Billing policy → whole weeks. MONTH×4 and DAY/7 are approximations. */
function intervalWeeksFromPolicy(policy: {
  interval: string;
  intervalCount: number;
}): number {
  const count = Math.max(1, policy.intervalCount);
  switch (policy.interval) {
    case "WEEK":
      return count;
    case "MONTH":
      // Approximation: 1 month ≈ 4 weeks (scheduling math elsewhere uses the
      // mirrored Shopify nextBillingDate, so drift never compounds).
      return count * 4;
    case "DAY":
      return Math.max(1, Math.ceil(count / 7));
    case "YEAR":
      return count * 52;
    default:
      return count;
  }
}

interface CardData {
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpiryMonth: number | null;
  cardExpiryYear: number | null;
}

function cardDataFromContract(sc: ShopifyContract): CardData | null {
  const instrument = sc.customerPaymentMethod?.instrument;
  if (!instrument) return null;
  return {
    cardBrand: instrument.brand,
    cardLast4: instrument.lastDigits,
    cardExpiryMonth: instrument.expiryMonth,
    cardExpiryYear: instrument.expiryYear,
  };
}

function lineData(
  line: ShopifyContractLine,
  variant: ShopifyVariant | undefined,
): {
  shopifyLineId: string;
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  currentPriceCents: number;
  compareAtPriceCents: number | null;
  unitCostCents: number | null;
} {
  const baseCents =
    line.pricingPolicy && line.pricingPolicy.basePriceCents > 0
      ? line.pricingPolicy.basePriceCents
      : (variant?.priceCents ?? null);
  return {
    shopifyLineId: line.id,
    productId: line.productId ?? variant?.productId ?? "",
    variantId: line.variantId ?? "",
    title: line.title || (variant?.productTitle ?? ""),
    variantTitle: line.variantTitle,
    sku: line.sku ?? variant?.sku ?? null,
    imageUrl: line.imageUrl ?? variant?.imageUrl ?? null,
    quantity: line.quantity,
    currentPriceCents: line.currentPriceCents,
    compareAtPriceCents: baseCents,
    unitCostCents: variant?.unitCostCents ?? null,
  };
}

// ── Sync one contract ────────────────────────────────────────────────────────

/**
 * Fetch one contract from Shopify and upsert the local mirror (contract +
 * lines). Preserves isGift / isOneTimeAddon / addedVia on lines matched by
 * shopifyLineId (falling back to variantId), and never deletes
 * isOneTimeAddon mirror lines (they live on a billing cycle, not on the
 * contract, so Shopify's contract lines never contain them).
 */
export async function syncContractFromShopify(
  shopDomain: string,
  shopifyContractGid: string,
  options?: ServiceOptions,
): Promise<LocalContractWithLines> {
  const shop = await requireShop(shopDomain);
  const admin = await adminClientForShop(shopDomain);
  const sc = await getContract(admin, shopifyContractGid);

  const existing = await prisma.subscriptionContract.findUnique({
    where: { shopifyContractId: shopifyContractGid },
    include: { lines: true },
  });

  // Variant enrichment (COGS + undiscounted price) — best effort.
  let variantsById = new Map<string, ShopifyVariant>();
  try {
    const variantIds = [
      ...new Set(
        sc.lines
          .map((l) => l.variantId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const variants = await getVariants(admin, variantIds);
    variantsById = new Map(variants.map((v) => [v.id, v]));
  } catch (err) {
    console.error(
      "[contracts] sync: variant enrichment failed",
      shopifyContractGid,
      err,
    );
  }

  // First charge detection from the origin order — best effort, once.
  let firstChargeAt: Date | null = existing?.firstChargeAt ?? null;
  if (!firstChargeAt && sc.originOrder) {
    try {
      const order = await getOrderSummary(admin, sc.originOrder.id);
      firstChargeAt = order.createdAt;
    } catch (err) {
      console.error(
        "[contracts] sync: origin order lookup failed",
        sc.originOrder.id,
        err,
      );
    }
  }

  const status = mapStatus(sc.status);
  const now = new Date();
  const customer = sc.customer;
  const card = cardDataFromContract(sc);
  const deliveryAddressJson = sc.deliveryMethod?.address
    ? (JSON.parse(JSON.stringify(sc.deliveryMethod.address)) as object)
    : undefined;

  const shared = {
    customerId: customer?.id ?? existing?.customerId ?? "",
    email: customer?.email ?? existing?.email ?? "",
    phone: customer?.phone ?? existing?.phone ?? null,
    firstName: customer?.firstName ?? existing?.firstName ?? null,
    lastName: customer?.lastName ?? existing?.lastName ?? null,
    status,
    currencyCode: sc.currencyCode,
    intervalWeeks: intervalWeeksFromPolicy(sc.billingPolicy),
    nextBillingDate: sc.nextBillingDate,
    paymentMethodId: sc.customerPaymentMethod?.id ?? null,
    ...(card ?? {}),
    ...(deliveryAddressJson !== undefined
      ? { deliveryAddress: deliveryAddressJson }
      : {}),
    deliveryPriceCents: sc.deliveryPriceCents,
    deliveryMethodTitle: sc.deliveryMethod?.title ?? null,
    originOrderId: sc.originOrder?.id ?? existing?.originOrderId ?? null,
    originOrderName: sc.originOrder?.name ?? existing?.originOrderName ?? null,
    firstChargeAt,
  };

  // Status-transition bookkeeping the webhook path must not lose.
  const transitions: Prisma.SubscriptionContractUpdateInput = {};
  if (status === "CANCELLED" && !existing?.cancelledAt) {
    transitions.cancelledAt = now;
    if (!existing?.cancelSource) transitions.cancelSource = "SYSTEM";
  }
  if (status === "FAILED" && !existing?.failedAt) {
    transitions.failedAt = now;
  }
  if (status === "PAUSED" && !existing?.pausedAt) {
    transitions.pausedAt = now;
  }
  if (status === "ACTIVE" && existing && existing.status === "PAUSED") {
    transitions.pausedAt = null;
    transitions.resumeAt = null;
  }

  const contractRow = existing
    ? await prisma.subscriptionContract.update({
        where: { id: existing.id },
        data: { ...shared, ...transitions },
      })
    : await prisma.subscriptionContract.create({
        data: {
          shopId: shop.id,
          shopifyContractId: shopifyContractGid,
          locale: normalizeLocale(customer?.locale ?? "en"),
          ...shared,
          ...(status === "CANCELLED"
            ? { cancelledAt: now, cancelSource: "SYSTEM" }
            : {}),
          ...(status === "FAILED" ? { failedAt: now } : {}),
          ...(status === "PAUSED" ? { pausedAt: now } : {}),
        },
      });

  // ── Replace lines, preserving local flags ─────────────────────────────────
  const localLines = existing?.lines ?? [];
  const matchedLocalIds = new Set<string>();

  for (const line of sc.lines) {
    const variant = line.variantId
      ? variantsById.get(line.variantId)
      : undefined;
    const data = lineData(line, variant);

    let match = localLines.find(
      (l) => l.shopifyLineId != null && l.shopifyLineId === line.id,
    );
    if (!match) {
      match = localLines.find(
        (l) =>
          !matchedLocalIds.has(l.id) &&
          !l.isOneTimeAddon &&
          l.variantId === line.variantId,
      );
    }

    if (match) {
      matchedLocalIds.add(match.id);
      await prisma.contractLine.update({
        where: { id: match.id },
        // isGift / isOneTimeAddon / addedVia preserved (not in `data`).
        data,
      });
    } else {
      await prisma.contractLine.create({
        data: {
          contractId: contractRow.id,
          ...data,
          // Zero-priced lines arriving from Shopify are gift lines.
          isGift: data.currentPriceCents === 0,
          isOneTimeAddon: false,
          addedVia: "CHECKOUT",
        },
      });
    }
  }

  // Drop local lines Shopify no longer has — except one-time-addon mirrors,
  // which by design never appear in the contract's line list.
  const staleIds = localLines
    .filter((l) => !matchedLocalIds.has(l.id) && !l.isOneTimeAddon)
    .map((l) => l.id);
  if (staleIds.length > 0) {
    await prisma.contractLine.deleteMany({ where: { id: { in: staleIds } } });
  }

  await logEvent({
    shopId: shop.id,
    contractId: contractRow.id,
    customerId: contractRow.customerId,
    email: contractRow.email,
    type: existing ? "contract.updated" : "contract.created",
    source: options?.source ?? "WEBHOOK",
    actor: resolveActor(options),
    payload: {
      action: "synced_from_shopify",
      shopifyContractId: shopifyContractGid,
      status,
      ...(existing && existing.status !== status
        ? { previousStatus: existing.status }
        : {}),
      lineCount: sc.lines.length,
    },
  });

  return reloadContract(contractRow.id);
}

// ── Backfill ─────────────────────────────────────────────────────────────────

export interface BackfillResult {
  total: number;
  synced: number;
  failed: number;
  errors: Array<{ gid: string; error: string }>;
}

/**
 * Initial-install backfill: page through every contract GID on Shopify and
 * mirror each one. Individual failures are recorded and skipped so one bad
 * contract cannot abort the whole import.
 */
export async function backfillAllContracts(
  shopDomain: string,
): Promise<BackfillResult> {
  const admin = await adminClientForShop(shopDomain);
  const result: BackfillResult = { total: 0, synced: 0, failed: 0, errors: [] };

  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const page = await listContractGids(admin, { cursor, first: 100 });
    for (const gid of page.gids) {
      result.total += 1;
      try {
        await syncContractFromShopify(shopDomain, gid, { source: "SYSTEM" });
        result.synced += 1;
      } catch (err) {
        result.failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ gid, error: message });
        console.error("[contracts] backfill: contract sync failed", gid, err);
      }
    }
    hasNextPage = page.hasNextPage;
    cursor = page.endCursor;
    if (!cursor) break;
  }

  return result;
}
