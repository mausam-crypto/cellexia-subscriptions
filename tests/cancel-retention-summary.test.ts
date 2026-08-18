import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * buildRetentionSummary / retentionLossLines (v1.28.0) — money-true and
 * ladder-aware loss aversion for the cancel intro + confirm pages.
 *
 * Pins:
 *  - the milestone countdown is the portal rewards strip's own
 *    milestoneRemaining over lifecycle.milestoneGiftCycle + milestoneLadder
 *    (past order 6 it re-anchors to 12, never the stale "(order 6)" line;
 *    exhausted ladder → no milestone line at all);
 *  - captured member savings (memberSavingsCents), the live DiscountGrant's
 *    cycles left, shipped gifts and the grandfathered price are read from
 *    real rows; each read is contained;
 *  - zero/unknown values produce NO line; the confirm ledger lists only what
 *    cancelling forfeits (tenure / banked savings / received gifts stay off).
 *
 * Drives the REAL summary module over a mocked db (the aud-portal-cancel-
 * reason mock style).
 */

const store = vi.hoisted(() => ({
  lifecycle: {} as Record<string, unknown>,
  attempts: [] as Array<Record<string, unknown>>,
  originDiscountCents: 0 as number | null,
  grants: [] as Array<Record<string, unknown>>,
  giftCount: 0,
  failGifts: false,
}));

vi.mock("~/db.server", () => ({
  default: {
    billingAttempt: {
      groupBy: vi.fn(async (): Promise<unknown[]> => store.attempts),
    },
    subscriptionContract: {
      findMany: vi.fn(async (): Promise<unknown[]> => [
        { id: "c_1", originOrderDiscountCents: store.originDiscountCents },
      ]),
    },
    discountGrant: {
      findMany: vi.fn(async (): Promise<unknown[]> => store.grants),
    },
    giftGrant: {
      count: vi.fn(async (): Promise<number> => {
        if (store.failGifts) throw new Error("db down");
        return store.giftCount;
      }),
    },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "lifecycle") return store.lifecycle;
    return {};
  }),
}));

import {
  buildRetentionSummary,
  retentionLossLines,
  type RetentionSummary,
} from "~/lib/cancel/summary.server";
import { milestoneRemaining } from "~/lib/portal/growth.server";

const shop = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  ianaTimezone: "Europe/Zurich",
} as unknown as Parameters<typeof buildRetentionSummary>[0];

function line(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    quantity: 1,
    currentPriceCents: 4000,
    compareAtPriceCents: 5000,
    isGift: false,
    isOneTimeAddon: false,
    ...over,
  };
}

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    currencyCode: "CHF",
    ordersCount: 3,
    grandfatheredPricing: false,
    intervalWeeks: 4,
    billingIntervalUnit: "MONTH",
    billingIntervalCount: 1,
    firstChargeAt: new Date(Date.now() - 100 * 86_400_000),
    createdAt: new Date(Date.now() - 101 * 86_400_000),
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    lines: [line()],
    ...over,
  } as unknown as Parameters<typeof buildRetentionSummary>[1];
}

const money = (cents: number) => `CHF ${(cents / 100).toFixed(2)}`;
const keys = (summary: RetentionSummary, mode: "intro" | "confirm" = "intro") =>
  retentionLossLines(summary, money, mode).map((l) => l.key);

beforeEach(() => {
  vi.clearAllMocks();
  store.lifecycle = {
    milestoneGiftCycle: 6,
    milestoneLadder: [12, 18, 24],
    rewardsUnlockDay: 90,
  };
  store.attempts = [];
  store.originDiscountCents = 0;
  store.grants = [];
  store.giftCount = 0;
  store.failGifts = false;
});

// ── Ladder-aware milestone ───────────────────────────────────────────────────

describe("ladder-aware milestone countdown", () => {
  it("before the base rung: counts down to order 6", async () => {
    const s = await buildRetentionSummary(shop, contract({ ordersCount: 3 }));
    expect(s.nextMilestoneCycle).toBe(6);
    expect(s.ordersToMilestone).toBe(3);
    const line = retentionLossLines(s, money).find((l) => l.key === "cancel.intro.milestone_line");
    expect(line?.vars).toEqual({ ordersLeft: 3, milestoneCycle: 6 });
  });

  it("past order 6: re-anchors to the next ladder rung (12) — no stale '(order 6)' line", async () => {
    const s = await buildRetentionSummary(shop, contract({ ordersCount: 8 }));
    expect(s.nextMilestoneCycle).toBe(12);
    expect(s.ordersToMilestone).toBe(4);
    expect(s.ordersToMilestone).toBe(milestoneRemaining(8, 6, [12, 18, 24]));
    const line = retentionLossLines(s, money).find((l) => l.key === "cancel.intro.milestone_line");
    expect(line?.vars).toEqual({ ordersLeft: 4, milestoneCycle: 12 });
    // Base rung stays exposed for legacy consumers but never drives the copy.
    expect(s.milestoneCycle).toBe(6);
  });

  it("every rung behind them: no milestone line at all (nothing shown that is not ahead)", async () => {
    const s = await buildRetentionSummary(shop, contract({ ordersCount: 30 }));
    expect(s.nextMilestoneCycle).toBeNull();
    expect(s.ordersToMilestone).toBe(0);
    expect(keys(s)).not.toContain("cancel.intro.milestone_line");
    expect(keys(s)).not.toContain("cancel.intro.milestone_reached");
  });

  it("a legacy lifecycle setting without a ladder degrades to the base rung", async () => {
    store.lifecycle = { milestoneGiftCycle: 6, rewardsUnlockDay: 90 };
    const s = await buildRetentionSummary(shop, contract({ ordersCount: 8 }));
    expect(s.nextMilestoneCycle).toBeNull();
    expect(keys(s)).not.toContain("cancel.intro.milestone_line");
  });
});

// ── Money-true figures ───────────────────────────────────────────────────────

describe("money-true figures", () => {
  it("member savings = captured attempt discounts + origin-order discount (portal value-tile figure)", async () => {
    store.attempts = [{ contractId: "c_1", _sum: { discountCents: 1800 } }];
    store.originDiscountCents = 700;
    const s = await buildRetentionSummary(shop, contract());
    expect(s.memberSavingsCents).toBe(2500);
    const line = retentionLossLines(s, money).find((l) => l.key === "cancel.intro.member_savings_line");
    expect(line?.vars).toEqual({ saved: "CHF 25.00" });
  });

  it("active DiscountGrant → percent + cycles left ('2 discounted orders left'), singular key for 1", async () => {
    store.grants = [
      { id: "g1", contractId: "c_1", percent: 15, cyclesTotal: 2, cyclesRemaining: 2, exhaustedAt: null },
    ];
    let s = await buildRetentionSummary(shop, contract());
    expect(s.discountPercent).toBe(15);
    expect(s.discountCyclesRemaining).toBe(2);
    let line = retentionLossLines(s, money).find((l) => l.key.startsWith("cancel.intro.discount_line"));
    expect(line?.key).toBe("cancel.intro.discount_line");
    expect(line?.vars).toEqual({ percent: 15, count: 2 });

    store.grants = [
      { id: "g1", contractId: "c_1", percent: 15, cyclesTotal: 2, cyclesRemaining: 1, exhaustedAt: null },
    ];
    s = await buildRetentionSummary(shop, contract());
    line = retentionLossLines(s, money).find((l) => l.key.startsWith("cancel.intro.discount_line"));
    expect(line?.key).toBe("cancel.intro.discount_line_one");
  });

  it("gifts received counts shipped grants; singular/plural keys", async () => {
    store.giftCount = 2;
    let s = await buildRetentionSummary(shop, contract());
    expect(s.giftsReceived).toBe(2);
    expect(keys(s)).toContain("cancel.intro.gifts_line");
    store.giftCount = 1;
    s = await buildRetentionSummary(shop, contract());
    expect(keys(s)).toContain("cancel.intro.gifts_line_one");
  });

  it("grandfathered contract surfaces its locked per-order price (recurring lines only)", async () => {
    const s = await buildRetentionSummary(
      shop,
      contract({
        grandfatheredPricing: true,
        lines: [
          line({ quantity: 2 }),
          line({ id: "g", isGift: true, currentPriceCents: 0 }),
          line({ id: "a", isOneTimeAddon: true, currentPriceCents: 999 }),
        ],
      }),
    );
    expect(s.lockedPrice).toBe(true);
    expect(s.lockedPriceCents).toBe(8000);
    const l = retentionLossLines(s, money).find((x) => x.key === "cancel.intro.locked_price_line");
    expect(l?.vars).toEqual({ price: "CHF 80.00" });
  });

  it("annual savings use the exact cadence (monthly = 12 cycles/year)", async () => {
    const s = await buildRetentionSummary(shop, contract());
    expect(s.perCycleSavingsCents).toBe(1000);
    expect(s.annualSavingsCents).toBe(12_000);
  });

  it("a failed extra read hides that line, never the summary", async () => {
    store.failGifts = true;
    store.giftCount = 5;
    const s = await buildRetentionSummary(shop, contract());
    expect(s.giftsReceived).toBe(0);
    expect(keys(s)).not.toContain("cancel.intro.gifts_line");
    expect(s.perCycleSavingsCents).toBe(1000);
  });
});

// ── Zero / unknown lines omitted ─────────────────────────────────────────────

describe("zero/unknown values render nothing", () => {
  it("a bare contract (no compare-at, no savings, no grant, no gifts, day 0) yields only the milestone + rewards countdown", async () => {
    const s = await buildRetentionSummary(
      shop,
      contract({
        lines: [line({ compareAtPriceCents: null })],
        firstChargeAt: new Date(),
        createdAt: new Date(),
      }),
    );
    expect(keys(s)).toEqual([
      "cancel.intro.milestone_line",
      "cancel.intro.rewards_countdown",
    ]);
  });

  it("intro ledger order: locked price → subscriber savings → member savings → discount → milestone → gifts → rewards → tenure", async () => {
    store.attempts = [{ contractId: "c_1", _sum: { discountCents: 1800 } }];
    store.grants = [
      { id: "g1", contractId: "c_1", percent: 15, cyclesTotal: 2, cyclesRemaining: 2, exhaustedAt: null },
    ];
    store.giftCount = 1;
    const s = await buildRetentionSummary(shop, contract({ grandfatheredPricing: true }));
    expect(keys(s)).toEqual([
      "cancel.intro.locked_price_line",
      "cancel.intro.savings_line",
      "cancel.intro.member_savings_line",
      "cancel.intro.discount_line",
      "cancel.intro.milestone_line",
      "cancel.intro.gifts_line_one",
      "cancel.intro.rewards_unlocked",
      "cancel.intro.days_line",
    ]);
  });

  it("confirm ledger lists only what cancelling forfeits — tenure, banked savings and received gifts stay off", async () => {
    store.attempts = [{ contractId: "c_1", _sum: { discountCents: 1800 } }];
    store.grants = [
      { id: "g1", contractId: "c_1", percent: 15, cyclesTotal: 2, cyclesRemaining: 2, exhaustedAt: null },
    ];
    store.giftCount = 3;
    const s = await buildRetentionSummary(shop, contract({ grandfatheredPricing: true }));
    const confirm = keys(s, "confirm");
    expect(confirm).toEqual([
      "cancel.intro.locked_price_line",
      "cancel.intro.savings_line",
      "cancel.intro.discount_line",
      "cancel.intro.milestone_line",
      "cancel.intro.rewards_unlocked",
    ]);
    expect(confirm).not.toContain("cancel.intro.days_line");
    expect(confirm).not.toContain("cancel.intro.member_savings_line");
    expect(confirm).not.toContain("cancel.intro.gifts_line");
  });

  it("no compare-at → no savings line; exhausted grant → no discount line", async () => {
    store.grants = [
      { id: "g1", contractId: "c_1", percent: 15, cyclesTotal: 2, cyclesRemaining: 0, exhaustedAt: new Date() },
    ];
    const s = await buildRetentionSummary(shop, contract({ lines: [line({ compareAtPriceCents: 4000 })] }));
    expect(s.discountPercent).toBeNull();
    expect(keys(s)).not.toContain("cancel.intro.savings_line");
    expect(keys(s).some((k) => k.startsWith("cancel.intro.discount_line"))).toBe(false);
  });
});
