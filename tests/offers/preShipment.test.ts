import { describe, expect, it } from "vitest";
import {
  computeAmountToGiftCents,
  expectedNextOrderValueCents,
  rankAddOnCandidates,
} from "~/services/offers/preShipment.server";
import type {
  AddOnCandidate,
  CompatibilityEdgeInput,
} from "~/services/offers/preShipment.server";

const CURRENT = ["gid://shopify/Product/1"];

const EDGES: CompatibilityEdgeInput[] = [
  {
    fromProductId: "gid://shopify/Product/1",
    toProductId: "gid://shopify/Product/2",
    relation: "PAIRS_WITH",
    strength: 2,
  },
  {
    fromProductId: "gid://shopify/Product/4",
    toProductId: "gid://shopify/Product/1",
    relation: "SENSITIVITY_CONFLICT",
    strength: 1,
  },
  {
    fromProductId: "gid://shopify/Product/1",
    toProductId: "gid://shopify/Product/5",
    relation: "REDUNDANT",
    strength: 1,
  },
];

function candidate(id: string, extra: Partial<AddOnCandidate> = {}): AddOnCandidate {
  return {
    productId: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    priceCents: 4900,
    ...extra,
  };
}

describe("rankAddOnCandidates — exclusions", () => {
  const candidates = [
    candidate("2"), // pairs with current routine
    candidate("3"), // neutral
    candidate("4"), // sensitivity conflict with current
    candidate("5"), // redundant with current
    candidate("1"), // already in the routine
    candidate("6", { inventoryAvailable: false }), // out of stock
  ];

  const ranked = rankAddOnCandidates({
    currentProductIds: CURRENT,
    candidates,
    edges: EDGES,
    maxResults: 10,
  });
  const ids = ranked.map((r) => r.productId);

  it("excludes SENSITIVITY_CONFLICT and REDUNDANT products", () => {
    expect(ids).not.toContain("gid://shopify/Product/4");
    expect(ids).not.toContain("gid://shopify/Product/5");
  });

  it("excludes products already in the routine", () => {
    expect(ids).not.toContain("gid://shopify/Product/1");
  });

  it("excludes out-of-stock products", () => {
    expect(ids).not.toContain("gid://shopify/Product/6");
  });

  it("keeps compatible and neutral products, pairing partner first", () => {
    expect(ids).toEqual([
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);
  });

  it("gives the pairing partner a routine-fit reason", () => {
    expect(ranked[0].reasons).toContain("Pairs well with your current routine");
    expect(ranked[0].factors.routineFit).toBe(1);
  });
});

describe("rankAddOnCandidates — scoring order", () => {
  it("previous purchases outrank otherwise identical candidates", () => {
    const ranked = rankAddOnCandidates({
      currentProductIds: CURRENT,
      candidates: [candidate("7"), candidate("8")],
      edges: [],
      previousPurchaseProductIds: ["gid://shopify/Product/8"],
    });
    expect(ranked[0].productId).toBe("gid://shopify/Product/8");
    expect(ranked[0].reasons).toContain("You have enjoyed this before");
  });

  it("higher margin outranks lower margin, all else equal", () => {
    const ranked = rankAddOnCandidates({
      currentProductIds: CURRENT,
      candidates: [
        candidate("7", { marginPercent: 0.1 }),
        candidate("8", { marginPercent: 0.9 }),
      ],
      edges: [],
    });
    expect(ranked[0].productId).toBe("gid://shopify/Product/8");
  });

  it("concern match adds score and a customer-safe reason", () => {
    const ranked = rankAddOnCandidates({
      currentProductIds: CURRENT,
      candidates: [
        candidate("7", { concern: "hydration" }),
        candidate("8", { concern: "firmness" }),
      ],
      edges: [],
      customerConcerns: ["hydration"],
    });
    expect(ranked[0].productId).toBe("gid://shopify/Product/7");
    expect(ranked[0].reasons).toContain("Supports your hydration goals");
  });

  it("respects maxResults and breaks score ties deterministically", () => {
    const ranked = rankAddOnCandidates({
      currentProductIds: [],
      candidates: [candidate("9"), candidate("8"), candidate("7")],
      edges: [],
      maxResults: 2,
    });
    expect(ranked).toHaveLength(2);
    // Identical scores → ordered by productId for stable output.
    expect(ranked[0].productId < ranked[1].productId).toBe(true);
  });

  it("returns a fallback reason when nothing specific applies", () => {
    const ranked = rankAddOnCandidates({
      currentProductIds: [],
      candidates: [candidate("7")],
      edges: [],
    });
    expect(ranked[0].reasons).toEqual([
      "A considered addition to your treatment plan",
    ]);
  });
});

describe("expectedNextOrderValueCents", () => {
  it("sums lines and add-ons that apply to the next delivery", () => {
    const lines = [{ quantity: 2, currentPriceCents: 4500 }];
    const addOns = [
      { quantity: 1, priceCents: 2000, mode: "NEXT_ONLY", remainingDeliveries: null },
      { quantity: 1, priceCents: 1000, mode: "RECURRING", remainingDeliveries: null },
      { quantity: 1, priceCents: 500, mode: "N_DELIVERIES", remainingDeliveries: 2 },
      { quantity: 1, priceCents: 9999, mode: "N_DELIVERIES", remainingDeliveries: 0 },
    ];
    expect(expectedNextOrderValueCents(lines, addOns)).toBe(
      9000 + 2000 + 1000 + 500,
    );
  });

  it("is zero for an empty contract", () => {
    expect(expectedNextOrderValueCents([], [])).toBe(0);
  });
});

describe("computeAmountToGiftCents", () => {
  it("returns the gap when the order is close to the threshold", () => {
    expect(computeAmountToGiftCents(8000, 10000)).toBe(2000);
  });

  it("returns null when already at or above the threshold", () => {
    expect(computeAmountToGiftCents(10000, 10000)).toBeNull();
    expect(computeAmountToGiftCents(12000, 10000)).toBeNull();
  });

  it("returns null when the gap is too large to be a credible nudge", () => {
    // Gap 5000 > 30% of 10000.
    expect(computeAmountToGiftCents(5000, 10000)).toBeNull();
  });

  it("returns null without a configured threshold", () => {
    expect(computeAmountToGiftCents(8000, null)).toBeNull();
    expect(computeAmountToGiftCents(8000, undefined)).toBeNull();
    expect(computeAmountToGiftCents(8000, 0)).toBeNull();
  });

  it("honours a custom proximity fraction", () => {
    expect(computeAmountToGiftCents(5000, 10000, 0.5)).toBe(5000);
  });
});
