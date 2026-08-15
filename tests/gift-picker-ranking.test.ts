import { describe, expect, it, vi } from "vitest";

/**
 * The dynamic gift picker's ranking core (v1.24.0) — pure-logic tests over
 * rankGiftCandidates. The contract under test, in priority order:
 *
 *  1. NEW TO THEM: never a subscribed product/variant, never a previously
 *     granted variant, never unavailable or explicitly excluded.
 *  2. LIKELY WANTED: merchant pairings outrank survey pairings outrank pool
 *     order; within a pairing list, earlier is better; the FIRST subscribed
 *     product's pairings dominate the second's.
 *  3. DETERMINISTIC: ties break on pool order, then variantId — no RNG.
 *  4. HONEST DEGRADATION: when nothing new remains, repeat the variant
 *     granted longest ago (exhausted: true) — but still never a product the
 *     customer subscribes to; with nothing giftable at all, pick null.
 *
 * Seams mocked: the module's impure imports only (db, settings, graphql,
 * alerts) — rankGiftCandidates itself touches none of them.
 */

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async () => []),
}));
vi.mock("~/lib/analytics/alerts.server", () => ({
  raiseAlert: vi.fn(async () => true),
}));

import {
  rankGiftCandidates,
  type GiftCandidate,
} from "~/lib/gifts/picker.server";

const candidate = (
  overrides: Partial<GiftCandidate> & { variantId: string; poolIndex: number },
): GiftCandidate => ({
  productId: overrides.variantId.replace("Variant", "Product"),
  label: overrides.variantId,
  retailCents: 3900,
  imageUrl: null,
  unitCostCents: 600,
  availableForSale: true,
  ...overrides,
});

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const P = (n: number) => `gid://shopify/Product/${n}`;

const baseInput = () => ({
  candidates: [
    candidate({ variantId: V(1), productId: P(1), poolIndex: 0 }),
    candidate({ variantId: V(2), productId: P(2), poolIndex: 1 }),
    candidate({ variantId: V(3), productId: P(3), poolIndex: 2 }),
  ],
  subscribedProductIds: new Set<string>(),
  subscribedVariantIds: new Set<string>(),
  giftedVariantIds: new Set<string>(),
  lastGiftedAtMs: {} as Record<string, number>,
  subscribedProductIdsRanked: [] as string[],
  pairings: {} as Record<string, string[]>,
  surveyKeys: [] as string[],
  surveyPairings: {} as Record<string, string[]>,
  excludeVariantIds: undefined as ReadonlySet<string> | undefined,
});

describe("exclusions (rule 1 — new to them)", () => {
  it("never picks a product the customer subscribes to", () => {
    const input = baseInput();
    input.subscribedProductIds = new Set([P(1)]);
    const { pick } = rankGiftCandidates(input);
    expect(pick?.variantId).toBe(V(2));
  });

  it("never picks a subscribed variant even when its productId is unknown", () => {
    const input = baseInput();
    input.candidates[0] = candidate({
      variantId: V(1),
      poolIndex: 0,
      productId: null,
    });
    input.subscribedVariantIds = new Set([V(1)]);
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(2));
  });

  it("skips already-gifted variants while fresh ones remain", () => {
    const input = baseInput();
    input.giftedVariantIds = new Set([V(1)]);
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(2));
  });

  it("skips unavailable and explicitly excluded variants", () => {
    const input = baseInput();
    input.candidates[0] = candidate({
      variantId: V(1),
      poolIndex: 0,
      availableForSale: false,
    });
    input.excludeVariantIds = new Set([V(2)]);
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(3));
  });
});

describe("ranking (rule 2 — likely wanted)", () => {
  it("pairings of the subscribed product outrank pool order", () => {
    const input = baseInput();
    input.subscribedProductIdsRanked = [P(9)];
    input.pairings = { [P(9)]: [V(3), V(2)] };
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(3));
  });

  it("the FIRST subscribed product's pairings dominate the second's", () => {
    const input = baseInput();
    input.subscribedProductIdsRanked = [P(8), P(9)];
    input.pairings = { [P(8)]: [V(2)], [P(9)]: [V(3)] };
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(2));
  });

  it("survey pairings break ties the pairings map leaves open", () => {
    const input = baseInput();
    input.surveyKeys = ["motive:prevention"];
    input.surveyPairings = { "motive:prevention": [V(3)] };
    expect(rankGiftCandidates(input).pick?.variantId).toBe(V(3));
  });

  it("with no affinity signals the pool order decides — deterministically", () => {
    const input = baseInput();
    const first = rankGiftCandidates(input).pick?.variantId;
    const second = rankGiftCandidates(input).pick?.variantId;
    expect(first).toBe(V(1));
    expect(second).toBe(V(1));
  });
});

describe("exhausted fallback (rule 4 — honest degradation)", () => {
  it("repeats the variant gifted longest ago and flags it", () => {
    const input = baseInput();
    input.giftedVariantIds = new Set([V(1), V(2), V(3)]);
    input.lastGiftedAtMs = { [V(1)]: 300, [V(2)]: 100, [V(3)]: 200 };
    const result = rankGiftCandidates(input);
    expect(result.exhausted).toBe(true);
    expect(result.pick?.variantId).toBe(V(2));
  });

  it("the fallback still never gifts a subscribed product", () => {
    const input = baseInput();
    input.giftedVariantIds = new Set([V(1), V(2), V(3)]);
    input.lastGiftedAtMs = { [V(1)]: 100, [V(2)]: 200, [V(3)]: 300 };
    input.subscribedProductIds = new Set([P(1)]);
    const result = rankGiftCandidates(input);
    expect(result.exhausted).toBe(true);
    expect(result.pick?.variantId).toBe(V(2));
  });

  it("returns null when the whole pool is the customer's own products", () => {
    const input = baseInput();
    input.subscribedProductIds = new Set([P(1), P(2), P(3)]);
    const result = rankGiftCandidates(input);
    expect(result.pick).toBeNull();
    expect(result.exhausted).toBe(false);
  });
});
