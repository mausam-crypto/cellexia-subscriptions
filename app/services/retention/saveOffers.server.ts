/**
 * [retention] Save-offer decision core — PURE functions only, no I/O.
 *
 * Given a cancellation reason and contract context, produce the ordered list
 * of save offers the cancellation flow presents. Rules encoded here:
 *
 *  - Structural changes before money. Every returned list is ordered by the
 *    SAVE_OFFER_TYPES hierarchy (array index = cost-to-Cellexia order,
 *    cheapest first). Discounts, credits and gifts only appear where the
 *    reason spec allows them, and always after every structural option.
 *  - Profit-aware cap. An offer is only rational when its expected cost does
 *    not exceed the expected value of retaining the subscriber:
 *      maxRationalSaveCostCents = floor(clamp01(pRetain) × max(0, expectedFutureContributionCents))
 *    Offers whose costCents exceed the cap are dropped.
 *  - Reason-specific exclusions: IRRITATION and TOO_MUCH_PRODUCT (and every
 *    other reason except TOO_EXPENSIVE) never see a discount/credit;
 *    NOT_SEEING_IMPROVEMENT gets education + support, no immediate discount.
 *  - Pauses are always bounded: 30 / 60 / 90 days or an explicit resume date
 *    chosen by the customer — never indefinite.
 *  - Each SaveOfferType appears at most once per list; choice ranges live in
 *    `params` (e.g. delayWeeksOptions) so `acceptOffer(sessionId, offerType)`
 *    is unambiguous. `default*` params are what acceptOffer executes.
 *
 * Customer copy follows the Continuous Treatment voice (docs/BRAND.md):
 * treatment plan / delivery / routine — calm, premium, zero pressure.
 */
import type {
  CancelReason,
  ContractLineSummary,
  SaveOffer,
  SaveOfferType,
} from "~/types/domain";
import { PAUSE_OPTIONS_DAYS, SAVE_OFFER_TYPES } from "~/types/domain";

// ─────────────────────────────── Context ──────────────────────────────────

export interface SaveOfferContext {
  /** Expected future gross contribution of this subscriber, in cents. */
  expectedFutureContributionCents: number;
  /** Probability (0..1) that a save offer retains the subscriber. */
  pRetain: number;
  lines: ContractLineSummary[];
  intervalWeeks: number;
  /** Depletion engine says the customer likely has surplus product at home. */
  hasExcessInventory: boolean;
  alternatives: {
    /** Shopify product ids suitable as swap targets. */
    productSwapCandidates: string[];
  };
  /**
   * Merchant-configured complimentary gift variant
   * (ShopSettings.settingsJson.retentionGiftVariantGid). null = no gift is
   * configured, so FREE_GIFT is never presented — an offer the fulfilment
   * engine cannot deliver must never reach a customer.
   */
  giftVariantGid: string | null;
}

// ─────────────────────────────── Tunables ─────────────────────────────────

/** Delay choices offered when moving a delivery back, in weeks. */
export const DELAY_WEEK_OPTIONS = [2, 4, 6, 8] as const;

/** Estimated cost of a complimentary sample/booster product, in cents. */
const COMPLIMENTARY_SAMPLE_COST_CENTS = 800;

/** Account credit: 10% of one order value, floor €5. */
const ACCOUNT_CREDIT_PERCENT = 10;
const ACCOUNT_CREDIT_MIN_CENTS = 500;

/** Temporary discount (absolute last resort): 15% off the next delivery. */
const TEMPORARY_DISCOUNT_PERCENT = 15;

// ─────────────────────────────── Pure helpers ─────────────────────────────

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The profit-aware ceiling on what a save offer may cost:
 * expected value of retention = P(retain) × expected future contribution.
 * Spending more than this to save the subscriber destroys value.
 */
export function maxRationalSaveCostCents(
  pRetain: number,
  expectedFutureContributionCents: number,
): number {
  const contribution = Math.max(0, expectedFutureContributionCents);
  // Round to the cent: flooring a float product turns 0.25 × 30000 into 7499
  // (0.25·30000 = 7499.999… in IEEE754) and understates the cap by a cent.
  return Math.round(clamp01(pRetain) * contribution);
}

/** Position of an offer type in the cost hierarchy (lower = cheaper). */
export function offerRank(type: SaveOfferType): number {
  return SAVE_OFFER_TYPES.indexOf(type);
}

/** One full order's value in cents. */
export function orderValueCents(lines: ContractLineSummary[]): number {
  return lines.reduce((sum, l) => sum + l.quantity * l.currentPriceCents, 0);
}

// ─────────────────────────────── Offer builders ───────────────────────────

function delayOffer(opts: {
  excess?: boolean;
  travel?: boolean;
}): SaveOffer {
  // Copy promises exactly what acceptOffer honours: the customer chooses one
  // of the advertised week options. No "pick any date"/"bring forward" flags —
  // an unhonoured promise here is a broken promise at the resume moment.
  const description = opts.travel
    ? "Move your next delivery to line up with your trip — push it back two, four, six or eight weeks."
    : opts.excess
      ? "You seem well stocked. Push your next delivery back — two, four, six or eight weeks — so your deliveries catch up with your routine."
      : "Push your next delivery back — two, four, six or eight weeks — whenever suits your routine best.";
  return {
    type: "CHANGE_DELIVERY_DATE",
    title: opts.travel ? "Match deliveries to your trip" : "Delay your next delivery",
    description,
    costCents: 0,
    params: {
      delayWeeksOptions: [...DELAY_WEEK_OPTIONS],
      defaultDelayWeeks: 4,
    },
  };
}

function skipOffer(): SaveOffer {
  return {
    type: "CHANGE_DELIVERY_DATE",
    title: "Skip your next delivery",
    description:
      "Skip one delivery and pick up your routine again the cycle after. Nothing else about your plan changes.",
    costCents: 0,
    params: { action: "SKIP_NEXT" },
  };
}

function cadenceOffer(intervalWeeks: number, forCost: boolean): SaveOffer {
  const options = [intervalWeeks + 2, intervalWeeks + 4];
  return {
    type: "CHANGE_FREQUENCY",
    title: forCost ? "Same routine, fewer deliveries" : "Slow your rhythm down",
    description: forCost
      ? "Stretching the time between deliveries lowers what you spend, without giving up your results."
      : "Move to a slower delivery rhythm so what arrives matches what you actually use.",
    costCents: 0,
    params: {
      intervalWeeksOptions: options,
      defaultIntervalWeeks: options[0],
      currentIntervalWeeks: intervalWeeks,
    },
  };
}

function quantityOffer(lines: ContractLineSummary[]): SaveOffer | null {
  const candidates = lines.filter((l) => l.quantity > 1);
  if (candidates.length === 0) return null;
  const line = candidates.reduce((a, b) => (b.quantity > a.quantity ? b : a));
  return {
    type: "CHANGE_QUANTITY",
    title: "Receive a little less each time",
    description:
      "Drop to a smaller amount per delivery — your treatment plan continues, with less on the shelf.",
    costCents: 0,
    params: {
      lineId: line.id,
      currentQuantity: line.quantity,
      defaultQuantity: line.quantity - 1,
    },
  };
}

function pauseOffer(opts?: { travel?: boolean }): SaveOffer {
  return {
    type: "TEMPORARY_PAUSE",
    title: opts?.travel ? "Pause until you are home" : "Take a break",
    description: opts?.travel
      ? "Pause your treatment plan while you travel and pick the date it should resume. Everything else stays exactly as it is."
      : "Pause your treatment plan for 30, 60 or 90 days — or choose the date that suits you. We pick up right where you left off.",
    costCents: 0,
    params: {
      daysOptions: [...PAUSE_OPTIONS_DAYS],
      defaultDays: 30,
      customResumeDateAllowed: true,
      // Pauses always end: a resume date is required, indefinite is not offered.
      indefiniteAllowed: false,
    },
  };
}

function swapOffer(
  candidates: string[],
  mode: "LOWER_COST" | "GENTLER" | "EXPLORE",
): SaveOffer {
  const copy: Record<typeof mode, { title: string; description: string }> = {
    LOWER_COST: {
      title: "Switch to a lighter configuration",
      description:
        "Move to a lower-priced configuration of your routine — same care, easier on your budget.",
    },
    GENTLER: {
      title: "Swap for a gentler formula",
      description:
        "If a product is not agreeing with your skin, we will swap it for a gentler alternative — or arrange a refund under our policy.",
    },
    EXPLORE: {
      title: "Change the product, keep the plan",
      description:
        "Swap to a different treatment without starting over — your delivery schedule, pricing and milestones stay exactly as they are.",
    },
  };
  return {
    type: "PRODUCT_SWAP",
    title: copy[mode].title,
    description: copy[mode].description,
    costCents: 0,
    params: { candidates, mode },
  };
}

function removeItemOffer(lines: ContractLineSummary[]): SaveOffer | null {
  if (lines.length < 2) return null;
  // Suggest dropping the line contributing least to the order value.
  const suggested = lines.reduce((a, b) =>
    b.quantity * b.currentPriceCents < a.quantity * a.currentPriceCents ? b : a,
  );
  return {
    type: "REMOVE_ITEM",
    title: "Keep only your essentials",
    description:
      "Remove one product from your deliveries and keep the rest of your routine going.",
    costCents: 0,
    params: {
      suggestedLineId: suggested.id,
      lineOptions: lines.map((l) => ({ lineId: l.id, title: l.title })),
    },
  };
}

function creditOffer(lines: ContractLineSummary[]): SaveOffer {
  const amountCents = Math.max(
    ACCOUNT_CREDIT_MIN_CENTS,
    Math.round((orderValueCents(lines) * ACCOUNT_CREDIT_PERCENT) / 100),
  );
  return {
    type: "ACCOUNT_CREDIT",
    title: "A credit toward your next delivery",
    description:
      "We will apply a one-time credit to your next delivery as a thank-you for staying with your treatment plan.",
    costCents: amountCents,
    params: { amountCents },
  };
}

function discountOffer(lines: ContractLineSummary[]): SaveOffer {
  const estimatedCostCents = Math.round(
    (orderValueCents(lines) * TEMPORARY_DISCOUNT_PERCENT) / 100,
  );
  return {
    type: "TEMPORARY_DISCOUNT",
    title: `${TEMPORARY_DISCOUNT_PERCENT}% off your next delivery`,
    description:
      "A one-time saving on your next delivery, applied automatically. Your plan and pricing otherwise stay the same.",
    costCents: estimatedCostCents,
    params: {
      percentOff: TEMPORARY_DISCOUNT_PERCENT,
      cycles: 1,
      estimatedCostCents,
    },
  };
}

function giftOffer(giftVariantGid: string): SaveOffer {
  return {
    type: "FREE_GIFT",
    title: "A complimentary booster with your next delivery",
    description:
      "We will add a complimentary product that supports your current routine — on us, with your next delivery.",
    costCents: COMPLIMENTARY_SAMPLE_COST_CENTS,
    // The concrete variant the fulfilment engine will place as a zero-priced
    // NEXT_ONLY add-on line (source RETENTION_GIFT) — never a vague promise.
    params: { note: "COMPLEMENTARY_SAMPLE", variantGid: giftVariantGid },
  };
}

function educationOffer(opts: {
  title: string;
  description: string;
  params: Record<string, unknown>;
}): SaveOffer {
  return {
    type: "EDUCATION",
    title: opts.title,
    description: opts.description,
    costCents: 0,
    params: opts.params,
  };
}

// ─────────────────────────────── Per-reason lists ─────────────────────────

function offersForReason(
  reason: CancelReason,
  ctx: SaveOfferContext,
): Array<SaveOffer | null> {
  const swapCandidates = ctx.alternatives.productSwapCandidates;

  switch (reason) {
    // Too much product at home: purely structural — delay, less, slower,
    // pause. Discounting someone who has surplus would only deepen the surplus.
    case "TOO_MUCH_PRODUCT":
      return [
        delayOffer({ excess: ctx.hasExcessInventory }),
        cadenceOffer(ctx.intervalWeeks, false),
        quantityOffer(ctx.lines),
        pauseOffer(),
      ];

    // Results take time: educate on the expected timeline and correct usage,
    // offer a complementary product and a consultation route. No immediate
    // discount — the problem is confidence, not price. The gift appears ONLY
    // when the shop has configured a real gift variant to fulfil it with.
    case "NOT_SEEING_IMPROVEMENT":
      return [
        educationOffer({
          title: "Where your skin should be by now",
          description:
            "Most treatments show their first visible change between weeks 4 and 8, with full results closer to week 12. See what to look for at your stage — and how to get the most from every application. Prefer to talk it through? Our skin experts are happy to review your routine with you.",
          params: {
            topics: ["EXPECTED_TIMELINE", "USAGE_GUIDANCE"],
            consultationRoute: true,
          },
        }),
        ctx.giftVariantGid ? giftOffer(ctx.giftVariantGid) : null,
      ];

    // Price pressure: exhaust every structural lever first; the discount is
    // the very last resort and the hierarchy sort keeps it last.
    case "TOO_EXPENSIVE":
      return [
        cadenceOffer(ctx.intervalWeeks, true),
        quantityOffer(ctx.lines),
        swapCandidates.length > 0 ? swapOffer(swapCandidates, "LOWER_COST") : null,
        removeItemOffer(ctx.lines),
        creditOffer(ctx.lines),
        discountOffer(ctx.lines),
      ];

    // Trial mindset: reassure there is no lock-in, then offer the lightest
    // possible touches — skip, slower rhythm, bounded pause.
    case "ONLY_WANTED_TO_TRY":
      return [
        educationOffer({
          title: "You are never locked in",
          description:
            "Adjust, delay or cancel online, any time — no commitments, no fees. Your plan simply follows your routine, and pausing keeps your pricing and milestones safe.",
          params: { topics: ["NO_OBLIGATION"] },
        }),
        skipOffer(),
        cadenceOffer(ctx.intervalWeeks, false),
        pauseOffer(),
      ];

    // Skin reaction: never a retention discount. Care first — usage-reduction
    // guidance, collect details, route to customer care, swap or refund per
    // policy.
    case "IRRITATION":
      return [
        educationOffer({
          title: "Let us look after your skin first",
          description:
            "Some actives need a gentler start — reducing to every other day often settles things within a week. Tell us what you experienced and our care team will review it with you. If a product is not right for your skin, we will swap it or arrange a refund under our policy.",
          params: {
            guidance: "USAGE_REDUCTION",
            collectDetails: true,
            route: "CUSTOMER_CARE",
            swapOrRefundPolicy: true,
          },
        }),
        swapCandidates.length > 0 ? swapOffer(swapCandidates, "GENTLER") : null,
      ];

    // Travelling: deliver to where they will be, move dates around the trip,
    // or pause until the return date.
    case "TRAVELLING":
      return [
        educationOffer({
          title: "Deliver to where you will be",
          description:
            "Travelling for a while? Update your delivery address online and your routine follows you.",
          params: { route: "CHANGE_ADDRESS" },
        }),
        delayOffer({ travel: true }),
        pauseOffer({ travel: true }),
      ];

    // Wrong product, right plan: swap without cancelling — but only when
    // there is actually something to swap to.
    case "WANT_DIFFERENT_PRODUCT":
      return [
        swapCandidates.length > 0 ? swapOffer(swapCandidates, "EXPLORE") : null,
      ];

    // Life changed / other: gentle structural flexibility only.
    case "CIRCUMSTANCES_CHANGED":
    case "OTHER":
      return [
        educationOffer({
          title: "Your plan bends around your life",
          description:
            "Adjust, delay or cancel online whenever you need to — your treatment plan is built to flex with you.",
          params: { topics: ["FLEXIBILITY"] },
        }),
        delayOffer({}),
        cadenceOffer(ctx.intervalWeeks, false),
        pauseOffer(),
      ];

    default: {
      // Exhaustiveness guard — new CancelReason values must be handled above.
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// ─────────────────────────────── Entry point ──────────────────────────────

/**
 * Build the reason-specific save offers: per-reason list → one offer per
 * type → sorted by the SAVE_OFFER_TYPES hierarchy → filtered by the
 * profit-aware cap.
 */
export function buildOffersForReason(
  reason: CancelReason,
  ctx: SaveOfferContext,
): SaveOffer[] {
  const cap = maxRationalSaveCostCents(
    ctx.pRetain,
    ctx.expectedFutureContributionCents,
  );

  const raw = offersForReason(reason, ctx).filter(
    (o): o is SaveOffer => o !== null,
  );

  // At most one offer per type (acceptOffer addresses offers by type).
  const seen = new Set<SaveOfferType>();
  const deduped = raw.filter((o) => {
    if (seen.has(o.type)) return false;
    seen.add(o.type);
    return true;
  });

  return deduped
    .sort((a, b) => offerRank(a.type) - offerRank(b.type))
    .filter((o) => o.costCents <= cap);
}
