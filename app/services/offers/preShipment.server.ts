/**
 * Pre-shipment offer engine.
 *
 * `rankAddOnCandidates` is a PURE ranking function over plain inputs — no
 * Prisma, no Shopify — so the weighting and exclusion rules are directly
 * unit-testable.
 *
 * `runPreShipmentJob` (jobs registry: `pre-shipment`) opens the 3–7 day
 * pre-billing window per active contract and emits PRE_SHIPMENT_WINDOW_OPEN
 * with the ranked add-on candidates; Klaviyo composes and sends the actual
 * message. It also detects repeated one-time add-ons (upgrade prompt) and
 * gift-threshold proximity.
 */
import prisma from "~/db.server";
import { appendAudit } from "~/services/audit.server";
import { getCostModel } from "~/services/analytics/costModel.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { normalizeProductId } from "~/services/offers/widgets.server";
import { addDays, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { COMPATIBILITY_RELATIONS, parseJson } from "~/types/domain";
import type {
  AddOnMode,
  CompatibilityRelation,
  ContractStatus,
} from "~/types/domain";

// ─────────────────────────────── Pure ranking ─────────────────────────────

export interface AddOnCandidate {
  productId: string;
  variantId?: string;
  title: string;
  priceCents: number;
  /** Gross margin as a fraction of price (0..1). */
  marginPercent?: number | null;
  /** false = out of stock (hard exclusion); undefined = unknown. */
  inventoryAvailable?: boolean;
  concern?: string | null;
  repeatPurchaseProbability?: number | null;
  estimatedRetentionLift?: number | null;
  seasonalRelevance?: number | null;
}

export interface CompatibilityEdgeInput {
  fromProductId: string;
  toProductId: string;
  relation: CompatibilityRelation;
  strength: number;
}

export interface AddOnRankingInputs {
  /** Products already in the customer's routine (contract lines). */
  currentProductIds: string[];
  candidates: AddOnCandidate[];
  edges: CompatibilityEdgeInput[];
  previousPurchaseProductIds?: string[];
  /** Concern slugs the customer's current routine addresses. */
  customerConcerns?: string[];
  maxResults?: number;
}

export interface RankedAddOn {
  productId: string;
  variantId?: string;
  title: string;
  priceCents: number;
  score: number;
  /** Normalised factor breakdown (explainability / analytics). */
  factors: Record<string, number>;
  /** Customer-safe reason strings, Continuous Treatment voice. */
  reasons: string[];
}

export const RANKING_WEIGHTS = {
  routineFit: 0.22,
  previousPurchases: 0.12,
  marginPercent: 0.14,
  repeatPurchaseProbability: 0.14,
  inventoryAvailable: 0.08,
  concernMatch: 0.1,
  seasonalRelevance: 0.06,
  estimatedRetentionLift: 0.14,
} as const;

const DEFAULT_MAX_RESULTS = 3;

function clamp01(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function buildReasons(
  factors: Record<string, number>,
  candidate: AddOnCandidate,
): string[] {
  const reasons: string[] = [];
  if (factors.routineFit > 0) {
    reasons.push("Pairs well with your current routine");
  }
  if (factors.previousPurchases > 0) {
    reasons.push("You have enjoyed this before");
  }
  if (factors.concernMatch > 0 && candidate.concern) {
    reasons.push(`Supports your ${candidate.concern} goals`);
  }
  if (factors.seasonalRelevance >= 0.5) {
    reasons.push("Right for this time of year");
  }
  if (factors.estimatedRetentionLift >= 0.5) {
    reasons.push("A favourite of long-term treatment plans");
  }
  if (reasons.length === 0) {
    reasons.push("A considered addition to your treatment plan");
  }
  return reasons;
}

/**
 * Score, filter and order add-on candidates for one customer's routine.
 *
 * Exclusions: already in the routine; explicitly out of stock; connected to
 * the current routine by a REDUNDANT or SENSITIVITY_CONFLICT edge (either
 * direction).
 *
 * Score = weighted mix of routine fit (PAIRS_WITH edge strength), previous
 * purchases, margin, repeat purchase probability, inventory certainty,
 * concern match, seasonal relevance and estimated retention lift.
 */
export function rankAddOnCandidates(inputs: AddOnRankingInputs): RankedAddOn[] {
  const current = new Set(inputs.currentProductIds.map(normalizeProductId));
  const previous = new Set(
    (inputs.previousPurchaseProductIds ?? []).map(normalizeProductId),
  );
  const concerns = new Set(
    (inputs.customerConcerns ?? []).map((c) => c.toLowerCase()),
  );
  const maxResults = inputs.maxResults ?? DEFAULT_MAX_RESULTS;

  const ranked: RankedAddOn[] = [];

  for (const candidate of inputs.candidates) {
    const id = normalizeProductId(candidate.productId);
    if (current.has(id)) continue;
    if (candidate.inventoryAvailable === false) continue;

    let pairsWithStrength = 0;
    let blocked = false;
    for (const edge of inputs.edges) {
      const from = normalizeProductId(edge.fromProductId);
      const to = normalizeProductId(edge.toProductId);
      const touchesRoutine =
        (from === id && current.has(to)) || (to === id && current.has(from));
      if (!touchesRoutine) continue;
      if (
        edge.relation === "REDUNDANT" ||
        edge.relation === "SENSITIVITY_CONFLICT"
      ) {
        blocked = true;
        break;
      }
      if (edge.relation === "PAIRS_WITH") {
        pairsWithStrength += Number.isFinite(edge.strength)
          ? Math.max(0, edge.strength)
          : 0;
      }
    }
    if (blocked) continue;

    const factors: Record<string, number> = {
      routineFit: clamp01(pairsWithStrength / 2),
      previousPurchases: previous.has(id) ? 1 : 0,
      marginPercent: clamp01(candidate.marginPercent),
      repeatPurchaseProbability: clamp01(candidate.repeatPurchaseProbability),
      inventoryAvailable: candidate.inventoryAvailable === true ? 1 : 0.5,
      concernMatch:
        candidate.concern && concerns.has(candidate.concern.toLowerCase())
          ? 1
          : 0,
      seasonalRelevance: clamp01(candidate.seasonalRelevance),
      estimatedRetentionLift: clamp01(candidate.estimatedRetentionLift),
    };

    let score = 0;
    for (const [factor, weight] of Object.entries(RANKING_WEIGHTS)) {
      score += (factors[factor] ?? 0) * weight;
    }
    score = Math.round(score * 10000) / 10000;

    ranked.push({
      productId: candidate.productId,
      variantId: candidate.variantId,
      title: candidate.title,
      priceCents: candidate.priceCents,
      score,
      factors,
      reasons: buildReasons(factors, candidate),
    });
  }

  ranked.sort(
    (a, b) => b.score - a.score || a.productId.localeCompare(b.productId),
  );
  return ranked.slice(0, maxResults);
}

// ─────────────────────────────── Pure order-value / gift helpers ──────────

/**
 * Expected value of the next delivery in cents: contract lines plus every
 * add-on that still applies to the next order.
 */
export function expectedNextOrderValueCents(
  lines: Array<{ quantity: number; currentPriceCents: number }>,
  addOns: Array<{
    quantity: number;
    priceCents: number;
    mode: string;
    remainingDeliveries: number | null;
  }>,
): number {
  let total = 0;
  for (const line of lines) {
    total += line.quantity * line.currentPriceCents;
  }
  for (const addOn of addOns) {
    const applies =
      addOn.mode === "NEXT_ONLY" ||
      addOn.mode === "RECURRING" ||
      (addOn.mode === "N_DELIVERIES" && (addOn.remainingDeliveries ?? 0) > 0);
    if (applies) total += addOn.quantity * addOn.priceCents;
  }
  return total;
}

/**
 * Amount still needed to reach the shipment gift threshold, or null when no
 * threshold is configured, the order already qualifies, or the gap is too
 * large to be a credible nudge (more than `proximityFraction` of threshold).
 */
export function computeAmountToGiftCents(
  orderValueCents: number,
  giftThresholdCents: number | null | undefined,
  proximityFraction = 0.3,
): number | null {
  if (
    typeof giftThresholdCents !== "number" ||
    !Number.isFinite(giftThresholdCents) ||
    giftThresholdCents <= 0
  ) {
    return null;
  }
  if (orderValueCents >= giftThresholdCents) return null;
  const gap = giftThresholdCents - orderValueCents;
  if (gap > giftThresholdCents * proximityFraction) return null;
  return gap;
}

// ─────────────────────────────── Job ──────────────────────────────────────

const ACTIVE: ContractStatus = "ACTIVE";
const NEXT_ONLY: AddOnMode = "NEXT_ONLY";
const REPEAT_ADD_ON_THRESHOLD = 3;
const WINDOW_OPEN_DAYS = 3;
const WINDOW_CLOSE_DAYS = 7;

export interface PreShipmentJobResult {
  contractsScanned: number;
  windowsOpened: number;
  upgradePrompts: number;
}

function isCompatibilityRelation(value: string): value is CompatibilityRelation {
  return (COMPATIBILITY_RELATIONS as readonly string[]).includes(value);
}

/**
 * Open the pre-shipment window for contracts billing in 3–7 days.
 *
 * Per contract: emit PRE_SHIPMENT_WINDOW_OPEN (deduped per billing cycle)
 * carrying ranked add-on candidates, the expected order value, and
 * `amountToGiftCents` when the order is close to the shop's gift threshold
 * (`ShopSettings.settingsJson.giftThresholdCents`). Contracts with >= 3
 * NEXT_ONLY add-ons of the same product additionally get
 * REPEATED_ONE_TIME_ADD_ON (upgrade prompt).
 */
export async function runPreShipmentJob(
  shop?: string,
): Promise<PreShipmentJobResult> {
  const now = new Date();
  const windowStart = addDays(now, WINDOW_OPEN_DAYS);
  const windowEnd = addDays(now, WINDOW_CLOSE_DAYS);

  const contracts = await prisma.subscriptionContract.findMany({
    where: {
      ...(shop ? { shop } : {}),
      status: ACTIVE,
      nextBillingDate: { gte: windowStart, lte: windowEnd },
    },
    include: { lines: true, addOns: true },
  });

  const byShop = new Map<string, typeof contracts>();
  for (const contract of contracts) {
    const list = byShop.get(contract.shop) ?? [];
    list.push(contract);
    byShop.set(contract.shop, list);
  }

  let windowsOpened = 0;
  let upgradePrompts = 0;

  for (const [shopDomain, shopContracts] of byShop) {
    const [metas, edges, settingsRow, costModel] = await Promise.all([
      prisma.productMeta.findMany({ where: { shop: shopDomain, active: true } }),
      prisma.compatibilityEdge.findMany({ where: { shop: shopDomain } }),
      prisma.shopSettings.findUnique({ where: { shop: shopDomain } }),
      getCostModel(shopDomain),
    ]);

    const settings = parseJson<Record<string, unknown>>(
      settingsRow?.settingsJson ?? null,
      {},
    );
    const giftThresholdCents =
      typeof settings.giftThresholdCents === "number" &&
      Number.isFinite(settings.giftThresholdCents) &&
      settings.giftThresholdCents > 0
        ? Math.round(settings.giftThresholdCents)
        : null;

    const metaByProduct = new Map<string, (typeof metas)[number]>();
    for (const meta of metas) {
      metaByProduct.set(normalizeProductId(meta.shopifyProductId), meta);
    }

    const edgeInputs: CompatibilityEdgeInput[] = edges
      .filter((edge) => isCompatibilityRelation(edge.relation))
      .map((edge) => ({
        fromProductId: edge.fromProductId,
        toProductId: edge.toProductId,
        relation: edge.relation as CompatibilityRelation,
        strength: edge.strength,
      }));

    // Purchase history: everything the customer has had on any of their
    // contracts (lines + add-ons) in this shop.
    const customerIds = [
      ...new Set(shopContracts.map((c) => c.shopifyCustomerId)),
    ];
    const historyContracts = await prisma.subscriptionContract.findMany({
      where: { shop: shopDomain, shopifyCustomerId: { in: customerIds } },
      select: {
        shopifyCustomerId: true,
        lines: { select: { shopifyProductId: true } },
        addOns: { select: { shopifyProductId: true } },
      },
    });
    const previousByCustomer = new Map<string, string[]>();
    for (const history of historyContracts) {
      const list = previousByCustomer.get(history.shopifyCustomerId) ?? [];
      for (const line of history.lines) list.push(line.shopifyProductId);
      for (const addOn of history.addOns) list.push(addOn.shopifyProductId);
      previousByCustomer.set(history.shopifyCustomerId, list);
    }

    let shopWindows = 0;
    let shopUpgrades = 0;

    for (const contract of shopContracts) {
      const currentProductIds = contract.lines.map((l) => l.shopifyProductId);
      const customerConcerns = [
        ...new Set(
          currentProductIds
            .map(
              (id) => metaByProduct.get(normalizeProductId(id))?.concern ?? null,
            )
            .filter((c): c is string => Boolean(c)),
        ),
      ];

      const candidates: AddOnCandidate[] = metas
        .filter((meta) => meta.subscribable)
        .map((meta) => ({
          productId: meta.shopifyProductId,
          title: meta.title,
          // ProductMeta carries no price; Klaviyo resolves the live price.
          priceCents: 0,
          // Margin factor from the shop cost model: a product without its
          // own margin data ranks at the shop default fraction instead of
          // an (unfair) zero-margin factor.
          marginPercent:
            meta.grossMarginPercent ?? costModel.defaultMarginFraction,
          concern: meta.concern,
        }));

      const ranked = rankAddOnCandidates({
        currentProductIds,
        candidates,
        edges: edgeInputs,
        previousPurchaseProductIds:
          previousByCustomer.get(contract.shopifyCustomerId) ?? [],
        customerConcerns,
        maxResults: DEFAULT_MAX_RESULTS,
      });

      const orderValueCents = expectedNextOrderValueCents(
        contract.lines,
        contract.addOns,
      );
      const amountToGiftCents = computeAmountToGiftCents(
        orderValueCents,
        giftThresholdCents,
      );

      const cycleKey = contract.nextBillingDate
        ? isoDate(contract.nextBillingDate)
        : isoDate(now);

      await emitLifecycleEvent({
        shop: shopDomain,
        name: "PRE_SHIPMENT_WINDOW_OPEN",
        contractId: contract.id,
        shopifyCustomerId: contract.shopifyCustomerId,
        email: contract.customerEmail,
        dedupeKey: `pre-shipment:${contract.id}:${cycleKey}`,
        payload: {
          nextBillingDate: contract.nextBillingDate
            ? contract.nextBillingDate.toISOString()
            : null,
          intervalWeeks: contract.intervalWeeks,
          currencyCode: contract.currencyCode,
          expectedOrderValueCents: orderValueCents,
          candidates: ranked,
          ...(amountToGiftCents !== null
            ? { amountToGiftCents, giftThresholdCents }
            : {}),
        },
      });
      windowsOpened += 1;
      shopWindows += 1;

      // Repeated one-time add-ons → upgrade prompt.
      const nextOnlyCounts = new Map<
        string,
        { count: number; title: string; variantId: string }
      >();
      for (const addOn of contract.addOns) {
        if (addOn.mode !== NEXT_ONLY) continue;
        const key = normalizeProductId(addOn.shopifyProductId);
        const entry = nextOnlyCounts.get(key);
        if (entry) entry.count += 1;
        else
          nextOnlyCounts.set(key, {
            count: 1,
            title: addOn.title,
            variantId: addOn.shopifyVariantId,
          });
      }
      const currentSet = new Set(currentProductIds.map(normalizeProductId));
      for (const [productKey, entry] of nextOnlyCounts) {
        if (entry.count < REPEAT_ADD_ON_THRESHOLD) continue;
        if (currentSet.has(productKey)) continue; // already recurring
        await emitLifecycleEvent({
          shop: shopDomain,
          name: "REPEATED_ONE_TIME_ADD_ON",
          contractId: contract.id,
          shopifyCustomerId: contract.shopifyCustomerId,
          email: contract.customerEmail,
          dedupeKey: `repeated-add-on:${contract.id}:${productKey}:${entry.count}`,
          payload: {
            productId: productKey,
            variantId: entry.variantId,
            title: entry.title,
            timesAdded: entry.count,
          },
        });
        upgradePrompts += 1;
        shopUpgrades += 1;
      }
    }

    await appendAudit({
      shop: shopDomain,
      actorType: "SYSTEM",
      action: "PRE_SHIPMENT_JOB_RUN",
      subjectType: "Job",
      subjectId: "pre-shipment",
      payload: {
        contractsScanned: shopContracts.length,
        windowsOpened: shopWindows,
        upgradePrompts: shopUpgrades,
      },
    });
  }

  logger.info("pre-shipment job complete", {
    shop: shop ?? "(all)",
    contractsScanned: contracts.length,
    windowsOpened,
    upgradePrompts,
  });

  return { contractsScanned: contracts.length, windowsOpened, upgradePrompts };
}
