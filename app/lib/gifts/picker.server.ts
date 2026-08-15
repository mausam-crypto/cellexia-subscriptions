import type { AdminClient } from "~/lib/graphql/client.server";
import prisma from "~/db.server";
import { getSetting } from "~/lib/settings/settings.server";
import { getVariants } from "~/lib/graphql/index.server";
import { raiseAlert } from "~/lib/analytics/alerts.server";
import {
  sanitizeSurveyAnswers,
  SURVEY_QUESTION_KEYS,
} from "~/lib/survey/shared";

/**
 * Dynamic gift picker (v1.24.0) — resolves WHICH product a gift grant should
 * carry, per customer, at the moment the grant is created.
 *
 * Why per customer: with a ~10-product catalog a fixed gift variant lands on
 * something the customer already receives often enough to burn the moment
 * (they skip the next box, or the "surprise" is a duplicate). The picker's
 * contract, in priority order:
 *
 *   1. NEW TO THEM — never a product on any of their contracts (gift lines
 *      excluded) and never a variant already granted to them. Identity is the
 *      customer EMAIL across all their contracts, not the single contract: a
 *      two-contract customer must not receive the same "new" gift twice.
 *   2. LIKELY WANTED — ranked by the merchant's pairings map (subscribed
 *      product → gifts that pair with it), then by survey-answer pairings,
 *      then by pool order. All ranking inputs are merchant-defined settings;
 *      Shopify order history is deliberately NOT consulted (without
 *      read_all_orders the API forgets everything older than 60 days, which
 *      would silently violate rule 1 — local contract + grant rows are the
 *      only honest sources).
 *   3. DETERMINISTIC — no RNG anywhere (the house invariant): same inputs,
 *      same pick. Ties break on pool order, then variantId.
 *
 * When every pool product fails rule 1 the picker degrades honestly: it
 * re-gifts the variant granted LONGEST AGO (still never a product they
 * subscribe to) and raises a deduped INFO alert telling the merchant the pool
 * is too small. Returning null instead would silently break gift promises
 * already emailed — a repeat gift beats a broken promise.
 *
 * Callers fall back to the rule's fixed variantId when the picker returns
 * null (empty pool, Shopify read failure, or nothing giftable at all), so a
 * DYNAMIC rule can never grant less than a FIXED one.
 */

// Raised (deduped per shop by raiseAlert) when a pick had to repeat a
// previously gifted variant because the pool held nothing new for a customer.
export const GIFT_POOL_EXHAUSTED_ALERT = "GIFT_POOL_EXHAUSTED";

/** A pool entry resolved against live Shopify data. */
export interface GiftCandidate {
  variantId: string;
  productId: string | null;
  /** Display label: product title (+ variant title when meaningful). */
  label: string;
  poolIndex: number;
  retailCents: number;
  imageUrl: string | null;
  /** Merchant pool override when set (> 0), else Shopify cost, else null. */
  unitCostCents: number | null;
  availableForSale: boolean;
}

export interface GiftRankInput {
  candidates: GiftCandidate[];
  /** Product GIDs on any of the customer's contracts (non-gift lines). */
  subscribedProductIds: ReadonlySet<string>;
  /** Variant GIDs on any of the customer's contracts (non-gift lines). */
  subscribedVariantIds: ReadonlySet<string>;
  /** Variant GIDs already granted to this customer (received or in flight). */
  giftedVariantIds: ReadonlySet<string>;
  /** variantId → epoch ms of the most recent grant (for the repeat fallback). */
  lastGiftedAtMs: Readonly<Record<string, number>>;
  /**
   * The customer's subscribed product GIDs in contract-line order — the order
   * pairings lists are consulted in, so the FIRST product's pairings outrank
   * the second's.
   */
  subscribedProductIdsRanked: readonly string[];
  /** Subscribed product GID → ranked gift variant GIDs (gifts.pairings). */
  pairings: Readonly<Record<string, readonly string[]>>;
  /** "question:option" keys from the customer's survey answers, in
   * SURVEY_QUESTION_KEYS order. Empty for holdout contracts. */
  surveyKeys: readonly string[];
  /** "question:option" → ranked gift variant GIDs (gifts.surveyPairings). */
  surveyPairings: Readonly<Record<string, readonly string[]>>;
  /** Extra variant GIDs to exclude for this pick (e.g. already on the cycle). */
  excludeVariantIds?: ReadonlySet<string>;
}

export interface GiftRankResult {
  pick: GiftCandidate | null;
  /** True when the pick repeats a previously gifted variant (pool too small). */
  exhausted: boolean;
}

const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Position-weighted lookup: the earliest list (by keys order) containing the
 * variant decides, weighted so list order dominates within-list position.
 * Lower is better; UNRANKED when no list mentions the variant.
 */
function affinityScore(
  variantId: string,
  keys: readonly string[],
  lists: Readonly<Record<string, readonly string[]>>,
): number {
  for (let k = 0; k < keys.length; k += 1) {
    const list = lists[keys[k]];
    if (!list) continue;
    const idx = list.indexOf(variantId);
    if (idx >= 0) return k * 1000 + idx;
  }
  return UNRANKED;
}

/** Pure ranking core — all data resolution lives in pickGiftForContract. */
export function rankGiftCandidates(input: GiftRankInput): GiftRankResult {
  const extraExcluded = input.excludeVariantIds ?? new Set<string>();

  // Never gift a product the customer subscribes to — doubling their stock
  // just pays them to skip the next delivery. This holds even in the
  // exhausted fallback.
  const giftable = input.candidates.filter(
    (c) =>
      c.availableForSale &&
      !extraExcluded.has(c.variantId) &&
      !input.subscribedVariantIds.has(c.variantId) &&
      (c.productId == null || !input.subscribedProductIds.has(c.productId)),
  );

  const fresh = giftable.filter((c) => !input.giftedVariantIds.has(c.variantId));

  const byAffinity = (a: GiftCandidate, b: GiftCandidate): number => {
    const pairA = affinityScore(
      a.variantId,
      input.subscribedProductIdsRanked,
      input.pairings,
    );
    const pairB = affinityScore(
      b.variantId,
      input.subscribedProductIdsRanked,
      input.pairings,
    );
    if (pairA !== pairB) return pairA - pairB;
    const svyA = affinityScore(a.variantId, input.surveyKeys, input.surveyPairings);
    const svyB = affinityScore(b.variantId, input.surveyKeys, input.surveyPairings);
    if (svyA !== svyB) return svyA - svyB;
    if (a.poolIndex !== b.poolIndex) return a.poolIndex - b.poolIndex;
    return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
  };

  if (fresh.length > 0) {
    return { pick: [...fresh].sort(byAffinity)[0], exhausted: false };
  }

  if (giftable.length > 0) {
    // Everything giftable was already gifted: repeat the one given longest
    // ago. Affinity is irrelevant here — freshness of the repeat is what the
    // customer feels.
    const oldestFirst = [...giftable].sort((a, b) => {
      const atA = input.lastGiftedAtMs[a.variantId] ?? 0;
      const atB = input.lastGiftedAtMs[b.variantId] ?? 0;
      if (atA !== atB) return atA - atB;
      if (a.poolIndex !== b.poolIndex) return a.poolIndex - b.poolIndex;
      return a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0;
    });
    return { pick: oldestFirst[0], exhausted: true };
  }

  return { pick: null, exhausted: false };
}

export interface PickedGift extends GiftCandidate {
  exhausted: boolean;
}

/**
 * Resolve the best gift for a contract's customer from the gifts.pool
 * setting. Returns null when the pool is empty, Shopify can't be read, or
 * nothing in the pool may be gifted to this customer — callers treat null as
 * "use the rule's fixed fallback variant". Never throws.
 */
export async function pickGiftForContract(opts: {
  shopId: string;
  admin: AdminClient;
  contract: {
    id: string;
    email: string;
    customerId: string;
    surveyHoldout?: boolean | null;
  };
  excludeVariantIds?: readonly string[];
}): Promise<PickedGift | null> {
  try {
    const gifts = await getSetting(opts.shopId, "gifts");
    if (gifts.pool.length === 0) return null;

    const live = await getVariants(
      opts.admin,
      gifts.pool.map((p) => p.variantId),
    );
    const liveById = new Map(live.map((v) => [v.id, v]));

    const candidates: GiftCandidate[] = [];
    gifts.pool.forEach((entry, poolIndex) => {
      const v = liveById.get(entry.variantId);
      // Deleted variants and non-ACTIVE products silently drop out of the
      // pool — gifting a retired product breaks the parcel.
      if (!v || (v.productStatus != null && v.productStatus !== "ACTIVE")) {
        return;
      }
      candidates.push({
        variantId: v.id,
        productId: v.productId,
        label:
          v.title && v.title !== "Default Title"
            ? `${v.productTitle} — ${v.title}`
            : v.productTitle || (entry.variantTitle ?? "Gift"),
        poolIndex,
        retailCents: v.priceCents,
        imageUrl: v.imageUrl,
        unitCostCents:
          entry.unitCostCents > 0 ? entry.unitCostCents : v.unitCostCents,
        availableForSale: v.availableForSale,
      });
    });
    if (candidates.length === 0) return null;

    // The customer's whole local footprint — every contract on this email,
    // whatever its status. A cancelled contract's product is still not "new
    // to them", and grants on a sibling contract still count as gifted.
    const contracts = await prisma.subscriptionContract.findMany({
      // Case-insensitive, matching the app's email-lookup convention — a
      // sibling contract that mirrored with different casing must not escape
      // the never-regift / never-gift-subscribed rules. Explicit ordering
      // makes the "FIRST subscribed product's pairings win" promise real
      // (unordered reads gave whatever the planner felt like).
      where: {
        shopId: opts.shopId,
        email: { equals: opts.contract.email, mode: "insensitive" },
        isDemo: false,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        lines: {
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { productId: true, variantId: true, isGift: true },
        },
      },
    });
    const contractIds = contracts.map((c) => c.id);

    const subscribedProductIds = new Set<string>();
    const subscribedVariantIds = new Set<string>();
    const subscribedProductIdsRanked: string[] = [];
    for (const c of contracts) {
      for (const line of c.lines) {
        if (line.isGift) continue;
        subscribedVariantIds.add(line.variantId);
        if (!subscribedProductIds.has(line.productId)) {
          subscribedProductIds.add(line.productId);
          subscribedProductIdsRanked.push(line.productId);
        }
      }
    }

    const grants = await prisma.giftGrant.findMany({
      where: {
        contractId: { in: contractIds },
        OR: [
          { status: { in: ["SCHEDULED", "ADDED", "SHIPPED"] } },
          { shippedAt: { not: null } },
        ],
      },
      select: { variantId: true, createdAt: true },
    });
    const giftedVariantIds = new Set<string>();
    const lastGiftedAtMs: Record<string, number> = {};
    for (const g of grants) {
      giftedVariantIds.add(g.variantId);
      const at = g.createdAt.getTime();
      if ((lastGiftedAtMs[g.variantId] ?? 0) < at) {
        lastGiftedAtMs[g.variantId] = at;
      }
    }

    // Survey answers refine the ranking — but never for holdout contracts:
    // the holdout exists so answer-segment behavior stays measurable against
    // an untreated control, and "your answers changed which gift you got" is
    // treatment (see app/lib/survey/service.server.ts holdout notes).
    let surveyKeys: string[] = [];
    if (!opts.contract.surveyHoldout) {
      const survey = await prisma.surveyResponse.findFirst({
        where: {
          shopId: opts.shopId,
          contractId: { in: contractIds },
          answeredAt: { not: null },
        },
        orderBy: { answeredAt: "desc" },
        select: { answers: true },
      });
      if (survey) {
        const answers = sanitizeSurveyAnswers(survey.answers);
        surveyKeys = SURVEY_QUESTION_KEYS.filter((k) => answers[k]).map(
          (k) => `${k}:${answers[k]}`,
        );
      }
    }

    const ranked = rankGiftCandidates({
      candidates,
      subscribedProductIds,
      subscribedVariantIds,
      giftedVariantIds,
      lastGiftedAtMs,
      subscribedProductIdsRanked,
      pairings: gifts.pairings,
      surveyKeys,
      surveyPairings: gifts.surveyPairings,
      excludeVariantIds: new Set(opts.excludeVariantIds ?? []),
    });

    if (!ranked.pick) return null;

    if (ranked.exhausted) {
      await raiseAlert({
        shopId: opts.shopId,
        type: GIFT_POOL_EXHAUSTED_ALERT,
        severity: "INFO",
        message:
          "The gift pool held nothing new for at least one customer — a previously gifted product was repeated. Add more products to the pool on the Gifts page so long-tenure subscribers keep discovering something new.",
        context: { contractId: opts.contract.id },
      });
    }

    return { ...ranked.pick, exhausted: ranked.exhausted };
  } catch (err) {
    // A picker failure must never block a grant — callers fall back to the
    // rule's fixed variant, exactly as if the pool were empty.
    console.error("[gifts] dynamic pick failed", opts.contract.id, err);
    return null;
  }
}
