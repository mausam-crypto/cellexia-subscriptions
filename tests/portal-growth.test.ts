import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PORTAL GROWTH FEATURES (portalGrowth settings group, v1.20.0)
 *
 * Behavioral-design levers on the customer portal, each merchant-toggleable
 * and ON by default. Pinned here:
 *
 *  1. Registry contract: every toggle defaults ON, and a stored pre-v1.20.0
 *     portal book gets the defaults via the zod field defaults.
 *  2. The pure helpers' honesty rules: savings never invented (only captured
 *     discounts count), milestone math matches the lifecycle engine's fire
 *     condition, "slower" means the CLOSEST strictly-slower plan option,
 *     the runout prediction requires a real gap ahead of now.
 *  3. Source pins: each route branch keys on its own toggle; the classic
 *     rendering stays reachable as the else path; skip remains present in
 *     ladder mode (reactance rule: reorder, never remove).
 *  4. Copy hygiene: the growth copy never names cancellation (priming
 *     hygiene) and never uses pressure words the design explicitly bans.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const dbMocks = vi.hoisted(() => ({
  attemptGroupBy: vi.fn(async (): Promise<unknown[]> => []),
  contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
  eventCount: vi.fn(async (): Promise<number> => 0),
  eventFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    billingAttempt: { groupBy: dbMocks.attemptGroupBy },
    subscriptionContract: { findMany: dbMocks.contractFindMany },
    subscriberEvent: {
      count: dbMocks.eventCount,
      findMany: dbMocks.eventFindMany,
    },
  },
}));

import {
  MOMENTUM_TOAST_KEYS,
  memberSavingsCents,
  milestoneRemaining,
  nextSlowerFrequency,
  popularAddonProductIds,
  runsOutBeforeNextDelivery,
} from "~/lib/portal/growth.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 1. Registry contract ─────────────────────────────────────────────────────

describe("portalGrowth settings group", () => {
  it("every growth toggle ships ON by default", () => {
    expect(settingsSchemas.portalGrowth.parse(undefined)).toEqual({
      homeValueCard: true,
      addonUpsell: true,
      postActionUpsell: true,
      concessionLadder: true,
      cadenceNudge: true,
      runoutPrompt: true,
      // v1.28.0 (P2.9): days-of-supply meter.
      supplyMeter: true,
      // v1.28.0 (P4.1 / P4.3 / P4.5): value cards.
      resultsTimeline: true,
      rewardsRoadmap: true,
      onboardingCard: true,
      // v1.28.0 (P4.2): "Your deliveries" on the Account tab.
      deliveriesList: true,
    });
    // A partially stored value keeps parsing (field-level defaults).
    const partial = settingsSchemas.portalGrowth.safeParse({
      homeValueCard: false,
    });
    expect(partial.success).toBe(true);
    if (partial.success) {
      expect(partial.data.homeValueCard).toBe(false);
      expect(partial.data.concessionLadder).toBe(true);
    }
  });
});

// ── 2. Pure helpers (honesty rules) ──────────────────────────────────────────

describe("memberSavingsCents", () => {
  it("sums captured attempt discounts plus the origin discount, per contract", async () => {
    dbMocks.attemptGroupBy.mockResolvedValueOnce([
      { contractId: "c1", _sum: { discountCents: 4800 } },
    ]);
    dbMocks.contractFindMany.mockResolvedValueOnce([
      { id: "c1", originOrderDiscountCents: 1200 },
      { id: "c2", originOrderDiscountCents: null },
    ]);
    const savings = await memberSavingsCents(["c1", "c2"]);
    expect(savings.get("c1")).toBe(6000);
    // Nothing captured → absent, so callers hide the tile (never "CHF 0").
    expect(savings.get("c2")).toBeUndefined();
  });

  it("returns an empty map for an empty id list without touching the db", async () => {
    expect((await memberSavingsCents([])).size).toBe(0);
    expect(dbMocks.attemptGroupBy).not.toHaveBeenCalled();
  });
});

describe("milestoneRemaining", () => {
  it("counts down to the milestone and matches the engine's >= fire rule", () => {
    expect(milestoneRemaining(4, 6)).toBe(2);
    expect(milestoneRemaining(5, 6)).toBe(1);
    expect(milestoneRemaining(6, 6)).toBeNull(); // reached — engine fires AT 6
    expect(milestoneRemaining(9, 6)).toBeNull();
    expect(milestoneRemaining(2, 0)).toBeNull(); // system off
  });
});

describe("nextSlowerFrequency", () => {
  const wk = (count: number) => ({ unit: "WEEK" as const, count });

  it("picks the CLOSEST strictly-slower option, never a faster or equal one", () => {
    expect(nextSlowerFrequency([wk(2), wk(4), wk(6), wk(8)], wk(4))).toEqual(
      wk(6),
    );
    expect(nextSlowerFrequency([wk(2), wk(4)], wk(4))).toBeNull();
    expect(nextSlowerFrequency([wk(4)], wk(4))).toBeNull();
  });

  it("compares across units through the week approximation", () => {
    const monthly = { unit: "MONTH" as const, count: 1 };
    // Monthly approximates to 4 weeks: slower than 3 weeks (and closer than
    // the 6-week option), but NOT strictly slower than 4 weeks.
    expect(nextSlowerFrequency([monthly, wk(6)], wk(3))).toEqual(monthly);
    expect(nextSlowerFrequency([monthly, wk(6)], wk(4))).toEqual(wk(6));
  });
});

describe("runsOutBeforeNextDelivery", () => {
  const now = new Date("2026-08-12T12:00:00Z");
  const day = (offset: number) =>
    new Date(now.getTime() + offset * 86_400_000);

  it("true only for a real gap: empty date ahead of now, delivery ≥ buffer later", () => {
    expect(runsOutBeforeNextDelivery(day(3), day(8), now)).toBe(true);
    // One-day overlap is noise, not a stockout at home.
    expect(runsOutBeforeNextDelivery(day(6), day(7), now)).toBe(false);
    // A stale (already-passed) prediction never prompts.
    expect(runsOutBeforeNextDelivery(day(-1), day(8), now)).toBe(false);
    // Running out AFTER the delivery is the standing push-it-back case.
    expect(runsOutBeforeNextDelivery(day(10), day(6), now)).toBe(false);
    expect(runsOutBeforeNextDelivery(null, day(8), now)).toBe(false);
    expect(runsOutBeforeNextDelivery(day(3), null, now)).toBe(false);
  });
});

describe("popularAddonProductIds", () => {
  it("badges only products with enough REAL add events — social proof needs proof", async () => {
    dbMocks.eventFindMany.mockResolvedValueOnce([
      ...Array.from({ length: 3 }, () => ({ payload: { variantId: "v1" } })),
      { payload: { variantId: "v2" } },
      { payload: { variantId: "unknown" } },
      { payload: null },
    ]);
    const popular = await popularAddonProductIds(
      "shop_1",
      new Map([
        ["v1", "p1"],
        ["v2", "p2"],
      ]),
    );
    expect(popular.has("p1")).toBe(true); // 3 real adds ≥ threshold
    expect(popular.has("p2")).toBe(false); // 1 add — no badge
  });

  it("degrades to no badges on a failed scan (decoration, not plumbing)", async () => {
    dbMocks.eventFindMany.mockRejectedValueOnce(new Error("db down"));
    const popular = await popularAddonProductIds("shop_1", new Map());
    expect(popular.size).toBe(0);
  });
});

describe("MOMENTUM_TOAST_KEYS", () => {
  it("contains only positive moments — never skip/delay, never adds", () => {
    expect([...MOMENTUM_TOAST_KEYS].sort()).toEqual([
      "address_updated",
      "resumed",
      "unskipped",
    ]);
  });
});

// ── 3. Source pins ───────────────────────────────────────────────────────────

describe("portal growth source pins", () => {
  it("the index card keys the value swap on homeValueCard and keeps classic skip/delay as the else path", () => {
    const source = readSource("app/routes/proxy._index.tsx");
    expect(source).toContain("growth.homeValueCard");
    expect(source).toContain("portal.value.saved");
    expect(source).toContain("portal.actions.add_products");
    // Classic one-tap skip/delay stay reachable when the toggle is off.
    expect(source).toContain('"portal.actions.skip"');
    expect(source).toContain('"portal.actions.delay_1w"');
  });

  it("the schedule ladder reorders but NEVER removes skip (the reactance rule)", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("growth.concessionLadder");
    expect(source).toContain("portal.ladder.delay_title");
    expect(source).toContain("portal.ladder.slower_title");
    // Skip is present in BOTH branches of the quick-actions rendering.
    const ladderBranch = source.slice(
      source.indexOf("if (ladder) {"),
      source.indexOf("quickActions = `<div>", source.indexOf("} else {")),
    );
    expect(ladderBranch).toContain('api(ctx, "skip")');
    // The truthful consequence: milestone note is conditional, not constant.
    expect(source).toContain("ladder.milestoneNote");
  });

  it("momentum, cadence and runout branches key on their own toggles", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("growth.postActionUpsell");
    expect(source).toContain("MOMENTUM_TOAST_KEYS.has(resolvedToast.key)");
    expect(source).toContain("growth.cadenceNudge");
    expect(source).toContain("growth.runoutPrompt");
    expect(source).toContain("growth.addonUpsell");
  });
});

// ── 4. Copy hygiene ──────────────────────────────────────────────────────────

describe("growth copy hygiene", () => {
  it("never names cancellation and never uses countdown-pressure words", () => {
    const catalog = JSON.parse(
      readSource("app/lib/i18n/locales/en.json"),
    ) as Record<string, string>;
    const growthKeys = Object.keys(catalog).filter(
      (key) =>
        key.startsWith("portal.value.") ||
        key.startsWith("portal.momentum.") ||
        key.startsWith("portal.ladder.") ||
        key.startsWith("portal.nudge.") ||
        key === "portal.actions.add_products" ||
        key === "portal.add.ships_with" ||
        key === "portal.add.try_once" ||
        key === "portal.add.every_time" ||
        key === "portal.add.popular",
    );
    // 30 (v1.20.0–v1.27.0) + 3 (v1.28.0 P2.7 "already out" branch:
    // portal.nudge.already_out / _cta / _hint).
    expect(growthKeys.length).toBe(33);
    for (const key of growthKeys) {
      expect(catalog[key], key).not.toMatch(/cancel/i);
      expect(catalog[key], key).not.toMatch(/hurry|last chance|only \d/i);
    }
  });
});
