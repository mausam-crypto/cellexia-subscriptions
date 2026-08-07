import { z } from "zod";
import type { Prisma, Shop } from "@prisma/client";
import prisma from "~/db.server";
import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { applyDiscountPct } from "~/lib/money";
import type { AdminClient, ShopifyVariant } from "~/lib/graphql/index.server";
import { getContract } from "~/lib/graphql/index.server";

/**
 * Internal plumbing shared by the contract services module.
 *
 * Every public service function follows the same shape: load the local mirror
 * + admin client via `loadContractContext`, mutate Shopify through the
 * graphql layer, then update the mirror inside `withMirrorGuard` so that a
 * mirror write failing after a successful Shopify mutation is never silent
 * (console.error + a `contract.updated` divergence event, then rethrow).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type LocalContractWithLines = Prisma.SubscriptionContractGetPayload<{
  include: { lines: true };
}>;

export type LocalContractLine = LocalContractWithLines["lines"][number];

/** Who initiated a service call; defaults to SYSTEM. */
export interface ServiceOptions {
  source?: EventSource;
  actor?: string | null;
}

export interface ContractContext {
  shop: Shop;
  contract: LocalContractWithLines;
  admin: AdminClient;
}

// ── Context loading ──────────────────────────────────────────────────────────

/**
 * Load shop + local contract (with lines) + an admin client for the shop.
 * Throws when the contract does not exist or belongs to another shop.
 */
export async function loadContractContext(
  shopDomain: string,
  contractLocalId: string,
): Promise<ContractContext> {
  const shop = await requireShop(shopDomain);
  const contract = await prisma.subscriptionContract.findUnique({
    where: { id: contractLocalId },
    include: { lines: true },
  });
  if (!contract) {
    throw new Error(`Subscription contract not found: ${contractLocalId}`);
  }
  if (contract.shopId !== shop.id) {
    throw new Error(
      `Subscription contract ${contractLocalId} does not belong to shop ${shopDomain}`,
    );
  }
  const admin = await adminClientForShop(shopDomain);
  return { shop, contract, admin };
}

/** Re-read the local contract with lines (the standard return value). */
export async function reloadContract(
  contractLocalId: string,
): Promise<LocalContractWithLines> {
  return prisma.subscriptionContract.findUniqueOrThrow({
    where: { id: contractLocalId },
    include: { lines: true },
  });
}

// ── Event helpers ────────────────────────────────────────────────────────────

export function resolveSource(options?: ServiceOptions): EventSource {
  return options?.source ?? "SYSTEM";
}

export function resolveActor(options?: ServiceOptions): string | null {
  return options?.actor ?? null;
}

/** Standard identity fields for a contract-scoped logEvent call. */
export function eventIdentity(
  shop: Shop,
  contract: LocalContractWithLines,
): {
  shopId: string;
  contractId: string;
  customerId: string;
  email: string;
} {
  return {
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  };
}

/**
 * Run the local-mirror update that follows a successful Shopify mutation.
 * If it fails, the mirror and Shopify have diverged: console.error + a
 * divergence event (best effort — logEvent never throws) and rethrow so the
 * caller knows the operation did not complete cleanly.
 */
export async function withMirrorGuard<T>(
  fnName: string,
  ctx: ContractContext,
  options: ServiceOptions | undefined,
  mutate: () => Promise<T>,
): Promise<T> {
  try {
    return await mutate();
  } catch (err) {
    console.error(
      `[contracts] ${fnName}: mirror update failed after Shopify mutation — local mirror may be stale for contract`,
      ctx.contract.id,
      err,
    );
    await logEvent({
      ...eventIdentity(ctx.shop, ctx.contract),
      type: "contract.updated",
      source: resolveSource(options),
      actor: resolveActor(options),
      payload: {
        action: "mirror_divergence",
        fn: fnName,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

// ── Ongoing-discount pricing ─────────────────────────────────────────────────

const productIdsSchema = z.array(z.string());

/**
 * The ongoing (recurring) discount pct configured for a product via the
 * shop's SellingPlanConfig rows. Null when no active config covers it.
 */
export async function ongoingDiscountPctForProduct(
  shopId: string,
  productId: string | null,
): Promise<number | null> {
  if (!productId) return null;
  const configs = await prisma.sellingPlanConfig.findMany({
    where: { shopId, active: true },
    orderBy: { createdAt: "asc" },
  });
  for (const config of configs) {
    const parsed = productIdsSchema.safeParse(config.productIds);
    if (parsed.success && parsed.data.includes(productId)) {
      return config.ongoingDiscountPct;
    }
  }
  return null;
}

/**
 * Fallback pricing when no SellingPlanConfig covers the product: preserve the
 * proportional discount ratio of an existing line (currentPrice/compareAt),
 * else charge the base price undiscounted.
 */
export function proportionalPriceCents(
  baseCents: number,
  referenceLine?: Pick<
    LocalContractLine,
    "currentPriceCents" | "compareAtPriceCents"
  > | null,
): number {
  const compareAt = referenceLine?.compareAtPriceCents ?? null;
  const current = referenceLine?.currentPriceCents ?? null;
  if (
    compareAt != null &&
    compareAt > 0 &&
    current != null &&
    current >= 0 &&
    current <= compareAt
  ) {
    return Math.round((baseCents * current) / compareAt);
  }
  return baseCents;
}

/**
 * Price a variant at the contract's ongoing subscription discount:
 * SellingPlanConfig.ongoingDiscountPct off the variant price when a config
 * covers the product, else the proportional ratio of `referenceLine`.
 */
export async function ongoingDiscountedPriceCents(
  shopId: string,
  variant: Pick<ShopifyVariant, "productId" | "priceCents">,
  referenceLine?: Pick<
    LocalContractLine,
    "currentPriceCents" | "compareAtPriceCents"
  > | null,
): Promise<number> {
  const pct = await ongoingDiscountPctForProduct(shopId, variant.productId);
  if (pct != null) return applyDiscountPct(variant.priceCents, pct);
  return proportionalPriceCents(variant.priceCents, referenceLine);
}

// ── Shopify contract refresh ─────────────────────────────────────────────────

/**
 * Best-effort re-read of the contract's nextBillingDate from Shopify after a
 * mutation. Returns `fallback` when the read fails — callers combine this
 * with local schedule math so the mirror never goes silently stale.
 */
export async function fetchNextBillingDate(
  admin: AdminClient,
  contractGid: string,
  fallback: Date | null,
): Promise<Date | null> {
  try {
    const contract = await getContract(admin, contractGid);
    return contract.nextBillingDate ?? fallback;
  } catch (err) {
    console.error(
      "[contracts] failed to re-read nextBillingDate from Shopify",
      contractGid,
      err,
    );
    return fallback;
  }
}
