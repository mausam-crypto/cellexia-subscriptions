import { describe, expect, it } from "vitest";
import {
  buildOffersForReason,
  maxRationalSaveCostCents,
  offerRank,
  orderValueCents,
} from "~/services/retention/saveOffers.server";
import type { SaveOfferContext } from "~/services/retention/saveOffers.server";
import { CANCEL_REASONS, SAVE_OFFER_TYPES } from "~/types/domain";
import type { ContractLineSummary, SaveOfferType } from "~/types/domain";

const lines: ContractLineSummary[] = [
  {
    id: "line1",
    shopifyProductId: "gid://shopify/Product/1",
    shopifyVariantId: "gid://shopify/ProductVariant/11",
    title: "Cell Renewal Serum",
    quantity: 2,
    currentPriceCents: 4900,
  },
  {
    id: "line2",
    shopifyProductId: "gid://shopify/Product/2",
    shopifyVariantId: "gid://shopify/ProductVariant/22",
    title: "Barrier Cream",
    quantity: 1,
    currentPriceCents: 3900,
  },
];

const GIFT_VARIANT = "gid://shopify/ProductVariant/777";

function ctx(overrides: Partial<SaveOfferContext> = {}): SaveOfferContext {
  return {
    expectedFutureContributionCents: 100_000,
    pRetain: 0.3,
    lines,
    intervalWeeks: 4,
    hasExcessInventory: false,
    alternatives: { productSwapCandidates: ["gid://shopify/Product/9"] },
    giftVariantGid: null,
    ...overrides,
  };
}

const DISCOUNT_TYPES: SaveOfferType[] = [
  "ACCOUNT_CREDIT",
  "FREE_GIFT",
  "TEMPORARY_DISCOUNT",
  "PERMANENT_DISCOUNT",
];

describe("maxRationalSaveCostCents", () => {
  it("is pRetain × expected future contribution, rounded to the cent", () => {
    expect(maxRationalSaveCostCents(0.3, 100_000)).toBe(30_000);
    // 0.25 × 999 = 249.75 → 250 (rounding, not flooring — flooring float
    // products also turned exact multiples like 0.25 × 30000 into 7499).
    expect(maxRationalSaveCostCents(0.25, 999)).toBe(250);
    expect(maxRationalSaveCostCents(0.25, 30_000)).toBe(7_500);
  });

  it("clamps pRetain into [0, 1]", () => {
    expect(maxRationalSaveCostCents(1.7, 10_000)).toBe(10_000);
    expect(maxRationalSaveCostCents(-0.4, 10_000)).toBe(0);
  });

  it("treats negative contribution as zero", () => {
    expect(maxRationalSaveCostCents(0.5, -5_000)).toBe(0);
  });

  it("handles non-finite pRetain", () => {
    expect(maxRationalSaveCostCents(Number.NaN, 10_000)).toBe(0);
  });
});

describe("orderValueCents", () => {
  it("sums quantity × price", () => {
    expect(orderValueCents(lines)).toBe(2 * 4900 + 3900);
  });
});

describe("hierarchy ordering", () => {
  it("orders every reason's offers by the SAVE_OFFER_TYPES cost hierarchy", () => {
    for (const reason of CANCEL_REASONS) {
      const offers = buildOffersForReason(reason, ctx());
      const ranks = offers.map((o) => offerRank(o.type));
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
      }
    }
  });

  it("presents each offer type at most once per list", () => {
    for (const reason of CANCEL_REASONS) {
      const offers = buildOffersForReason(reason, ctx());
      const types = offers.map((o) => o.type);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  it("never generates a PERMANENT_DISCOUNT for any reason", () => {
    for (const reason of CANCEL_REASONS) {
      const offers = buildOffersForReason(reason, ctx());
      expect(offers.some((o) => o.type === "PERMANENT_DISCOUNT")).toBe(false);
    }
  });
});

describe("profit-aware cap filtering", () => {
  it("keeps costed offers under a generous cap", () => {
    const offers = buildOffersForReason("TOO_EXPENSIVE", ctx());
    expect(offers.some((o) => o.type === "ACCOUNT_CREDIT")).toBe(true);
    expect(offers.some((o) => o.type === "TEMPORARY_DISCOUNT")).toBe(true);
  });

  it("drops offers whose cost exceeds pRetain × contribution", () => {
    const offers = buildOffersForReason(
      "TOO_EXPENSIVE",
      ctx({ expectedFutureContributionCents: 2_000, pRetain: 0.1 }), // cap 200
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.costCents).toBeLessThanOrEqual(200);
    }
    expect(offers.some((o) => o.type === "ACCOUNT_CREDIT")).toBe(false);
    expect(offers.some((o) => o.type === "TEMPORARY_DISCOUNT")).toBe(false);
  });

  it("keeps free structural offers even when the cap is zero", () => {
    const offers = buildOffersForReason(
      "TOO_MUCH_PRODUCT",
      ctx({ expectedFutureContributionCents: 0, pRetain: 0 }),
    );
    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(offer.costCents).toBe(0);
    }
  });
});

describe("TOO_MUCH_PRODUCT", () => {
  it("offers delay 2/4/6/8 weeks, quantity, cadence and pause — no discounts", () => {
    const offers = buildOffersForReason("TOO_MUCH_PRODUCT", ctx());
    const types = offers.map((o) => o.type);
    expect(types).toContain("CHANGE_DELIVERY_DATE");
    expect(types).toContain("CHANGE_FREQUENCY");
    expect(types).toContain("CHANGE_QUANTITY");
    expect(types).toContain("TEMPORARY_PAUSE");
    for (const d of DISCOUNT_TYPES) {
      expect(types).not.toContain(d);
    }
    const delay = offers.find((o) => o.type === "CHANGE_DELIVERY_DATE");
    expect(delay?.params.delayWeeksOptions).toEqual([2, 4, 6, 8]);
  });

  it("omits CHANGE_QUANTITY when every line already has quantity 1", () => {
    const singleQty = lines.map((l) => ({ ...l, quantity: 1 }));
    const offers = buildOffersForReason(
      "TOO_MUCH_PRODUCT",
      ctx({ lines: singleQty }),
    );
    expect(offers.some((o) => o.type === "CHANGE_QUANTITY")).toBe(false);
  });
});

describe("NOT_SEEING_IMPROVEMENT", () => {
  it("leads with education (timeline + usage + consultation), no discount or credit", () => {
    const offers = buildOffersForReason("NOT_SEEING_IMPROVEMENT", ctx());
    expect(offers[0].type).toBe("EDUCATION");
    expect(offers[0].params.topics).toContain("EXPECTED_TIMELINE");
    expect(offers[0].params.consultationRoute).toBe(true);
    const types = offers.map((o) => o.type);
    expect(types).not.toContain("TEMPORARY_DISCOUNT");
    expect(types).not.toContain("PERMANENT_DISCOUNT");
    expect(types).not.toContain("ACCOUNT_CREDIT");
  });

  it("NEVER presents the complimentary gift without a configured gift variant (unfulfillable promise)", () => {
    const offers = buildOffersForReason("NOT_SEEING_IMPROVEMENT", ctx());
    expect(offers.some((o) => o.type === "FREE_GIFT")).toBe(false);
  });

  it("presents the gift with the concrete fulfilment variant when configured", () => {
    const offers = buildOffersForReason(
      "NOT_SEEING_IMPROVEMENT",
      ctx({ giftVariantGid: GIFT_VARIANT }),
    );
    const gift = offers.find((o) => o.type === "FREE_GIFT");
    expect(gift).toBeDefined();
    expect(gift?.params.variantGid).toBe(GIFT_VARIANT);
  });
});

describe("TOO_EXPENSIVE", () => {
  it("puts the discount strictly last, after all structural offers", () => {
    const offers = buildOffersForReason("TOO_EXPENSIVE", ctx());
    expect(offers[offers.length - 1].type).toBe("TEMPORARY_DISCOUNT");
    const firstCostedIdx = offers.findIndex((o) => o.costCents > 0);
    for (let i = 0; i < firstCostedIdx; i++) {
      expect(offers[i].costCents).toBe(0);
    }
  });

  it("includes structural cost levers: cadence, quantity, swap, remove", () => {
    const types = buildOffersForReason("TOO_EXPENSIVE", ctx()).map(
      (o) => o.type,
    );
    expect(types).toContain("CHANGE_FREQUENCY");
    expect(types).toContain("CHANGE_QUANTITY");
    expect(types).toContain("PRODUCT_SWAP");
    expect(types).toContain("REMOVE_ITEM");
  });

  it("omits REMOVE_ITEM for a single-line contract", () => {
    const offers = buildOffersForReason(
      "TOO_EXPENSIVE",
      ctx({ lines: [lines[0]] }),
    );
    expect(offers.some((o) => o.type === "REMOVE_ITEM")).toBe(false);
  });
});

describe("ONLY_WANTED_TO_TRY", () => {
  it("offers no-obligation messaging, skip, longer interval and pause", () => {
    const offers = buildOffersForReason("ONLY_WANTED_TO_TRY", ctx());
    const education = offers.find((o) => o.type === "EDUCATION");
    expect(education?.params.topics).toContain("NO_OBLIGATION");
    const skip = offers.find((o) => o.type === "CHANGE_DELIVERY_DATE");
    expect(skip?.params.action).toBe("SKIP_NEXT");
    expect(offers.some((o) => o.type === "CHANGE_FREQUENCY")).toBe(true);
    expect(offers.some((o) => o.type === "TEMPORARY_PAUSE")).toBe(true);
  });
});

describe("IRRITATION", () => {
  it("never offers a retention discount, credit or gift (even with a gift configured)", () => {
    const offers = buildOffersForReason(
      "IRRITATION",
      ctx({ giftVariantGid: GIFT_VARIANT }),
    );
    const types = offers.map((o) => o.type);
    for (const d of DISCOUNT_TYPES) {
      expect(types).not.toContain(d);
    }
  });

  it("collects details and routes to customer care, with swap per policy", () => {
    const offers = buildOffersForReason("IRRITATION", ctx());
    const education = offers.find((o) => o.type === "EDUCATION");
    expect(education?.params.collectDetails).toBe(true);
    expect(education?.params.route).toBe("CUSTOMER_CARE");
    expect(offers.some((o) => o.type === "PRODUCT_SWAP")).toBe(true);
  });

  it("omits the swap when there are no candidates", () => {
    const offers = buildOffersForReason(
      "IRRITATION",
      ctx({ alternatives: { productSwapCandidates: [] } }),
    );
    expect(offers.some((o) => o.type === "PRODUCT_SWAP")).toBe(false);
  });
});

describe("TRAVELLING", () => {
  it("offers address change, chooseable date moves and a bounded pause", () => {
    const offers = buildOffersForReason("TRAVELLING", ctx());
    const education = offers.find((o) => o.type === "EDUCATION");
    expect(education?.params.route).toBe("CHANGE_ADDRESS");
    const dateMove = offers.find((o) => o.type === "CHANGE_DELIVERY_DATE");
    expect(dateMove?.params.delayWeeksOptions).toEqual([2, 4, 6, 8]);
    const pause = offers.find((o) => o.type === "TEMPORARY_PAUSE");
    expect(pause?.params.customResumeDateAllowed).toBe(true);
  });

  it("no longer advertises unhonoured choices (old broken-promise flags are gone)", () => {
    // The launch copy promised "bring it forward, or pick the exact date"
    // while acceptOffer executed a hidden 4-week default. The flags that
    // made that promise must not exist on the delay offer any more.
    const offers = buildOffersForReason("TRAVELLING", ctx());
    const dateMove = offers.find((o) => o.type === "CHANGE_DELIVERY_DATE");
    expect(dateMove?.params.bringForwardAllowed).toBeUndefined();
    expect(dateMove?.params.chooseDateAllowed).toBeUndefined();
    expect(dateMove?.description).not.toContain("bring it forward");
  });
});

describe("WANT_DIFFERENT_PRODUCT", () => {
  it("offers a swap without cancelling", () => {
    const offers = buildOffersForReason("WANT_DIFFERENT_PRODUCT", ctx());
    const swap = offers.find((o) => o.type === "PRODUCT_SWAP");
    expect(swap).toBeDefined();
    expect(swap?.params.candidates).toEqual(["gid://shopify/Product/9"]);
  });

  it("omits the swap when there are no candidates", () => {
    const offers = buildOffersForReason(
      "WANT_DIFFERENT_PRODUCT",
      ctx({ alternatives: { productSwapCandidates: [] } }),
    );
    expect(offers.some((o) => o.type === "PRODUCT_SWAP")).toBe(false);
  });
});

describe("pause offers are never indefinite", () => {
  it("every pause offer carries 30/60/90 options and forbids indefinite", () => {
    for (const reason of CANCEL_REASONS) {
      const pause = buildOffersForReason(reason, ctx()).find(
        (o) => o.type === "TEMPORARY_PAUSE",
      );
      if (!pause) continue;
      expect(pause.params.daysOptions).toEqual([30, 60, 90]);
      expect(pause.params.indefiniteAllowed).toBe(false);
    }
  });
});

describe("sanity: offer shape", () => {
  it("all offers carry title, description and non-negative integer cost", () => {
    for (const reason of CANCEL_REASONS) {
      for (const offer of buildOffersForReason(reason, ctx())) {
        expect(SAVE_OFFER_TYPES).toContain(offer.type);
        expect(offer.title.length).toBeGreaterThan(0);
        expect(offer.description.length).toBeGreaterThan(0);
        expect(Number.isInteger(offer.costCents)).toBe(true);
        expect(offer.costCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
