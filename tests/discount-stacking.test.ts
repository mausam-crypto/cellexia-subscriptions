import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultFor } from "~/lib/settings/registry.server";

/**
 * Discount-stacking cap tests (~/lib/billing/stacking.server).
 *
 * The cap (settings.discountStacking.maxTotalDiscountPct) bounds the SUM of
 * the plan's baked-in ongoing discount (SellingPlanConfig.ongoingDiscountPct)
 * and the single live DiscountGrant. `clampGrantPercent` is the pure math;
 * `clampGrantPercentForContract` resolves the setting + the contract's plan
 * discount through prisma, so the DB is mocked here the same way the other
 * suites do it (see tests/klaviyo-map.test.ts):
 *  - ~/db.server → setting + sellingPlanConfig lookups
 *  - ~/shopify.server → never called; mocked so importing the contracts
 *    module tree does not initialize the Shopify app at module load.
 */

const mocks = vi.hoisted(() => ({
  settingFindUnique: vi.fn(async (): Promise<unknown> => null),
  sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    setting: { findUnique: mocks.settingFindUnique },
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => {
    throw new Error("adminClientForShop must not be called by stacking logic");
  }),
}));

import {
  clampGrantPercent,
  clampGrantPercentForContract,
  contractOngoingDiscountPct,
  type StackableLine,
} from "~/lib/billing/stacking.server";

const SHOP_ID = "shop_1";

function line(productId: string, isGift = false): StackableLine {
  return { productId, isGift };
}

/** Shape getSetting() reads back for a stored discountStacking row. */
function storedStacking(maxTotalDiscountPct: number): { value: unknown } {
  return {
    value: {
      allowPromoCodesOnFirstOrder: true,
      allowPromoCodesOnRenewals: false,
      referralCreditStacksWithSubscription: true,
      maxTotalDiscountPct,
    },
  };
}

/** Minimal SellingPlanConfig rows (fields ongoingDiscountPctForProduct reads). */
function planConfig(productIds: string[], ongoingDiscountPct: number) {
  return { productIds, ongoingDiscountPct };
}

beforeEach(() => {
  mocks.settingFindUnique.mockReset();
  mocks.settingFindUnique.mockResolvedValue(null); // defaults unless a test stores a row
  mocks.sellingPlanConfigFindMany.mockReset();
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
});

describe("clampGrantPercent (pure)", () => {
  it("passes a grant through untouched when plan + grant fit under the cap", () => {
    const r = clampGrantPercent(15, 10, 45);
    expect(r.percent).toBe(15);
    expect(r.clamped).toBe(false);
    expect(r.headroomPct).toBe(35);
  });

  it("allows a grant that lands exactly on the cap", () => {
    const r = clampGrantPercent(35, 10, 45);
    expect(r.percent).toBe(35);
    expect(r.clamped).toBe(false);
  });

  it("clamps so ongoing + grant never exceeds the cap", () => {
    const r = clampGrantPercent(25, 25, 45);
    expect(r.percent).toBe(20);
    expect(r.clamped).toBe(true);
    expect(r.ongoingDiscountPct + r.percent).toBeLessThanOrEqual(
      r.maxTotalDiscountPct,
    );
    expect(r.requestedPercent).toBe(25);
  });

  it("returns 0 when the plan discount already consumes the whole cap", () => {
    const r = clampGrantPercent(20, 45, 45);
    expect(r.percent).toBe(0);
    expect(r.clamped).toBe(true);
    expect(r.headroomPct).toBe(0);
  });

  it("returns 0 when the plan discount exceeds the cap (never negative)", () => {
    const r = clampGrantPercent(20, 60, 45);
    expect(r.percent).toBe(0);
    expect(r.headroomPct).toBe(0);
  });

  it("a zero request stays zero and is not marked clamped", () => {
    const r = clampGrantPercent(0, 10, 45);
    expect(r.percent).toBe(0);
    expect(r.clamped).toBe(false);
  });

  it("normalizes junk input: fractions floor, negatives and NaN become 0", () => {
    expect(clampGrantPercent(12.9, 10.7, 45.9).percent).toBe(12);
    expect(clampGrantPercent(-5, 10, 45).percent).toBe(0);
    expect(clampGrantPercent(Number.NaN, 10, 45).percent).toBe(0);
    expect(clampGrantPercent(20, Number.NaN, 45).percent).toBe(20);
    expect(clampGrantPercent(20, 10, Number.NaN).percent).toBe(0);
    expect(clampGrantPercent(500, 0, 45).percent).toBe(45); // requests cap at 100 then headroom
  });

  it("invariant: ongoing + granted <= cap across a grid of inputs", () => {
    for (let requested = 0; requested <= 50; requested += 5) {
      for (let ongoing = 0; ongoing <= 50; ongoing += 5) {
        for (const cap of [0, 10, 45, 90]) {
          const r = clampGrantPercent(requested, ongoing, cap);
          expect(r.percent).toBeGreaterThanOrEqual(0);
          expect(
            Math.min(ongoing, 100) + r.percent,
            `requested=${requested} ongoing=${ongoing} cap=${cap}`,
          ).toBeLessThanOrEqual(Math.max(cap, Math.min(ongoing, 100)));
        }
      }
    }
  });
});

describe("registry defaults compose under the default cap (policy sanity)", () => {
  // SellingPlanConfig.ongoingDiscountPct defaults to 10 (prisma/schema.prisma).
  const PLAN_ONGOING_DEFAULT = 10;
  const cap = defaultFor("discountStacking").maxTotalDiscountPct;

  it("default reason-save offer fits without clamping", () => {
    const pct = defaultFor("cancelFlow").reasonOfferPctDefault;
    expect(clampGrantPercent(pct, PLAN_ONGOING_DEFAULT, cap).clamped).toBe(false);
  });

  it("default final offer fits without clamping", () => {
    const pct = defaultFor("cancelFlow").finalOfferPct;
    expect(clampGrantPercent(pct, PLAN_ONGOING_DEFAULT, cap).clamped).toBe(false);
  });

  it("default win-back discount fits without clamping", () => {
    const pct = defaultFor("winback").discountPct;
    expect(clampGrantPercent(pct, PLAN_ONGOING_DEFAULT, cap).clamped).toBe(false);
  });
});

describe("contractOngoingDiscountPct", () => {
  it("takes the highest ongoing pct across the contract's non-gift lines", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/1"], 10),
      planConfig(["gid://shopify/Product/2"], 25),
    ]);
    const pct = await contractOngoingDiscountPct(SHOP_ID, [
      line("gid://shopify/Product/1"),
      line("gid://shopify/Product/2"),
    ]);
    expect(pct).toBe(25);
  });

  it("ignores gift lines (they are free — no discount to stack with)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/2"], 25),
    ]);
    const pct = await contractOngoingDiscountPct(SHOP_ID, [
      line("gid://shopify/Product/1"),
      line("gid://shopify/Product/2", true), // gift
    ]);
    expect(pct).toBe(0);
  });

  it("returns 0 when no active config covers any line", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/99"], 15),
    ]);
    const pct = await contractOngoingDiscountPct(SHOP_ID, [
      line("gid://shopify/Product/1"),
    ]);
    expect(pct).toBe(0);
  });

  it("returns 0 for a contract with no lines", async () => {
    expect(await contractOngoingDiscountPct(SHOP_ID, [])).toBe(0);
  });
});

describe("clampGrantPercentForContract", () => {
  it("clamps a save offer to the headroom left by the plan discount", async () => {
    mocks.settingFindUnique.mockResolvedValue(storedStacking(30));
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/1"], 25),
    ]);
    const r = await clampGrantPercentForContract(
      SHOP_ID,
      [line("gid://shopify/Product/1")],
      25,
    );
    expect(r.percent).toBe(5);
    expect(r.clamped).toBe(true);
    expect(r.ongoingDiscountPct).toBe(25);
    expect(r.maxTotalDiscountPct).toBe(30);
  });

  it("uses the registry default cap when no setting row is stored", async () => {
    mocks.settingFindUnique.mockResolvedValue(null);
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/1"], 10),
    ]);
    const r = await clampGrantPercentForContract(
      SHOP_ID,
      [line("gid://shopify/Product/1")],
      25,
    );
    expect(r.maxTotalDiscountPct).toBe(
      defaultFor("discountStacking").maxTotalDiscountPct,
    );
    expect(r.percent).toBe(25);
    expect(r.clamped).toBe(false);
  });

  it("returns 0 (grant refused) when the plan discount fills the cap", async () => {
    mocks.settingFindUnique.mockResolvedValue(storedStacking(20));
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      planConfig(["gid://shopify/Product/1"], 25),
    ]);
    const r = await clampGrantPercentForContract(
      SHOP_ID,
      [line("gid://shopify/Product/1")],
      15,
    );
    expect(r.percent).toBe(0);
    expect(r.clamped).toBe(true);
    expect(r.headroomPct).toBe(0);
  });

  it("falls back to the default cap when the stored row is corrupted", async () => {
    mocks.settingFindUnique.mockResolvedValue({ value: { bogus: true } });
    const r = await clampGrantPercentForContract(SHOP_ID, [], 25);
    expect(r.maxTotalDiscountPct).toBe(
      defaultFor("discountStacking").maxTotalDiscountPct,
    );
    expect(r.percent).toBe(25);
  });
});
