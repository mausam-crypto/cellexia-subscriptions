import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REWARDS ROADMAP (v1.28.0, P4.3) — the home rewards strip as the full
 * ladder with projected dates + deliveries/gifts tiles.
 *
 *  - Dates: projectOrderDate is the gift engine's schedule math (order-number
 *    space, intervals from nextBillingDate, shop tz); day-N reward =
 *    firstChargeAt + rewardsUnlockDay; reached rungs carry no date.
 *  - Gift NAME rules (truth gates): named only for a FIXED base rule with a
 *    variant title or a SCHEDULED/ADDED grant already on the upcoming
 *    cycle; DYNAMIC base rule ⇒ "a free product"; ladder rung ⇒ generic
 *    only when the engine can grant (pool or base rule), else no promise;
 *    day-N ⇒ generic only with rewardsGiftEnabled.
 *  - REACHED rows (Stage E review): the label comes from EVIDENCE of a
 *    grant only — the day-N row from a REWARDS grant, a milestone rung from
 *    its lifecycle.milestone_reached event's giftGranted — never from the
 *    current config (the engine's grants are best-effort; the email is
 *    truth-gated the same way).
 *  - Order-2 base rung (milestoneGiftCycle 2 = the gift2 slice): no teaser
 *    ⇒ no promise; with the surprise row present, no duplicate rung row.
 *  - Holdout safety: the cycle-2 "surprise" row appears ONLY when the
 *    teaser was actually SENT (teaserPromised) and order 2 is ahead —
 *    holdout arms never got a teaser, so they never see the row; the
 *    roadmap itself never touches the experiment kernel.
 *  - Tiles: deliveries so far = ordersCount; gifts received = SHIPPED /
 *    settlement-stamped grants.
 *  - Cancel intro seam: RetentionSummary.nextMilestoneAt via the same math.
 *  - Route pin: portalGrowth.rewardsRoadmap gates the roadmap, classic strip
 *    is the fallback.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const mocks = vi.hoisted(() => ({
  giftRuleFindFirst: vi.fn(async (_a: unknown): Promise<unknown> => null),
  giftGrantCount: vi.fn(async (_a: unknown): Promise<number> => 0),
  giftGrantFindFirst: vi.fn(async (_a: unknown): Promise<unknown> => null),
  eventFindFirst: vi.fn(async (_a: unknown): Promise<unknown> => null),
  eventFindMany: vi.fn(async (_a: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a: unknown): Promise<unknown> => null),
  getSetting: vi.fn(async (_s: string, _k: string): Promise<unknown> => ({ pool: [] })),
}));

vi.mock("~/db.server", () => ({
  default: {
    giftRule: { findFirst: mocks.giftRuleFindFirst },
    giftGrant: { count: mocks.giftGrantCount, findFirst: mocks.giftGrantFindFirst },
    subscriberEvent: { findFirst: mocks.eventFindFirst, findMany: mocks.eventFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    billingAttempt: { groupBy: vi.fn(async () => []) },
    subscriptionContract: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));

import {
  buildRewardsRoadmap,
  projectOrderDate,
  teaserPromisedFor,
  type RoadmapContract,
} from "~/lib/portal/growth.server";

const TZ = "Europe/Zurich";
const NOW = new Date("2026-08-17T12:00:00Z");

function contract(over: Partial<RoadmapContract> = {}): RoadmapContract {
  return {
    id: "c_1",
    ordersCount: 3,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    firstChargeAt: new Date("2026-06-01T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    intervalWeeks: 4,
    billingIntervalUnit: "MONTH",
    billingIntervalCount: 1,
    ...over,
  };
}
const lifecycle = {
  milestoneGiftCycle: 6,
  milestoneLadder: [12, 18],
  rewardsUnlockDay: 90,
  rewardsGiftEnabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.giftRuleFindFirst.mockResolvedValue(null);
  mocks.giftGrantCount.mockResolvedValue(0);
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.getSetting.mockResolvedValue({ pool: [] });
});

// ── Dates ────────────────────────────────────────────────────────────────────

describe("projectOrderDate — the gift engine's schedule math", () => {
  it("counts intervals from the next billing date in order-number space", () => {
    const c = contract();
    expect(projectOrderDate(c, 4, TZ)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // Monthly: order 6 = two months after the upcoming order 4.
    expect(projectOrderDate(c, 6, TZ)?.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(projectOrderDate(c, 12, TZ)?.toISOString().slice(0, 10)).toBe("2027-05-01");
  });
  it("null without a next date or for an order already behind", () => {
    expect(projectOrderDate(contract({ nextBillingDate: null }), 6, TZ)).toBeNull();
    expect(projectOrderDate(contract({ ordersCount: 8 }), 6, TZ)).toBeNull();
  });
});

// ── Rows + gift names ────────────────────────────────────────────────────────

describe("buildRewardsRoadmap", () => {
  it("lists every rung ascending + the day-N reward with 'around' dates; reached rungs carry a check and no date", async () => {
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 7 }),
      lifecycle,
      now: NOW,
    });
    const rungs = r.rows.filter((row) => row.kind === "milestone");
    expect(rungs.map((x) => x.orderNumber)).toEqual([6, 12, 18]);
    expect(rungs[0].reached).toBe(true);
    expect(rungs[0].aroundDate).toBeNull();
    expect(rungs[1].reached).toBe(false);
    // ordersCount 7 ⇒ upcoming 8 on Sep 1 ⇒ order 12 = +4 months.
    expect(rungs[1].aroundDate?.toISOString().slice(0, 10)).toBe("2027-01-01");
    const rewards = r.rows.find((row) => row.kind === "rewards")!;
    // firstChargeAt Jun 1 + 90 d = Aug 30 — ahead of NOW (Aug 17).
    expect(rewards.reached).toBe(false);
    expect(rewards.aroundDate?.toISOString().slice(0, 10)).toBe("2026-08-30");
    expect(rewards.gift).toEqual({ kind: "generic" });
    expect(r.deliveriesSoFar).toBe(7);
  });

  it("day-N reward: reached by event or by date; no gift promise when rewardsGiftEnabled is off", async () => {
    const byEvent = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract(),
      lifecycle: { ...lifecycle, rewardsGiftEnabled: false },
      now: NOW,
      rewardsUnlockedEvent: true,
    });
    const row = byEvent.rows.find((x) => x.kind === "rewards")!;
    expect(row.reached).toBe(true);
    expect(row.aroundDate).toBeNull();
    expect(row.gift).toEqual({ kind: "none" });
    const byDate = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ firstChargeAt: new Date("2026-01-01T00:00:00Z") }),
      lifecycle,
      now: NOW,
    });
    expect(byDate.rows.find((x) => x.kind === "rewards")!.reached).toBe(true);
  });

  it("REACHED rungs are labelled from the milestone event's giftGranted, never from the current rule/pool", async () => {
    // Config would promise: FIXED titled base rule + a non-empty pool.
    mocks.giftRuleFindFirst.mockResolvedValue({ selection: "FIXED", variantTitle: "Serum X", variantId: "v1" });
    mocks.getSetting.mockResolvedValue({ pool: [{ variantId: "v1" }] });
    // Order 6: event says no grant; order 12: event says granted; order 18: no event at all.
    mocks.eventFindMany.mockResolvedValue([
      { payload: { ordersCount: 6, giftGranted: false } },
      { payload: { ordersCount: 12, giftGranted: true } },
    ]);
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 20 }),
      lifecycle,
      now: NOW,
    });
    const rung = (n: number) => r.rows.find((x) => x.orderNumber === n)!;
    expect(rung(6).reached).toBe(true);
    expect(rung(6).gift).toEqual({ kind: "none" });
    expect(rung(12).gift).toEqual({ kind: "generic" });
    expect(rung(18).gift).toEqual({ kind: "none" });
    const where = (mocks.eventFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "c_1", type: "lifecycle.milestone_reached" });
    // The FUTURE label is still the config prediction (contract at order 3).
    const ahead = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(ahead.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "named", title: "Serum X" });
    // A failed event read degrades reached rungs to no promise.
    mocks.eventFindMany.mockRejectedValueOnce(new Error("db"));
    const failed = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract({ ordersCount: 7 }), lifecycle, now: NOW });
    expect(failed.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "none" });
  });

  it("day-N reward REACHED without a REWARDS grant promises nothing even with rewardsGiftEnabled on; with the grant it reads generic", async () => {
    const noGrant = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ firstChargeAt: new Date("2026-01-01T00:00:00Z") }),
      lifecycle,
      now: NOW,
    });
    const row = noGrant.rows.find((x) => x.kind === "rewards")!;
    expect(row.reached).toBe(true);
    expect(row.gift).toEqual({ kind: "none" });
    mocks.giftGrantFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, unknown> }).where;
      return where.source === "REWARDS" ? { id: "g_rewards" } : null;
    });
    const granted = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract(),
      lifecycle,
      now: NOW,
      rewardsUnlockedEvent: true,
    });
    expect(granted.rows.find((x) => x.kind === "rewards")!.gift).toEqual({ kind: "generic" });
  });

  it("milestoneGiftCycle 2 (the gift2 slice): no teaser ⇒ rung 2 promises nothing; teaser sent ⇒ only the surprise row, no duplicate rung", async () => {
    mocks.giftRuleFindFirst.mockResolvedValue({ selection: "FIXED", variantTitle: "Serum X", variantId: "v1" });
    const lc = { ...lifecycle, milestoneGiftCycle: 2, milestoneLadder: [6] };
    const holdout = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract({ ordersCount: 1 }), lifecycle: lc, now: NOW });
    expect(holdout.rows.filter((x) => x.orderNumber === 2)).toEqual([
      expect.objectContaining({ kind: "milestone", orderNumber: 2, reached: false, gift: { kind: "none" } }),
    ]);
    const teased = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract({ ordersCount: 1 }), lifecycle: lc, now: NOW, teaserPromised: true });
    const order2 = teased.rows.filter((x) => x.orderNumber === 2);
    expect(order2).toHaveLength(1);
    expect(order2[0].kind).toBe("surprise");
  });

  it("base rung: FIXED rule with a title ⇒ named; DYNAMIC ⇒ generic; no rule ⇒ no promise", async () => {
    mocks.giftRuleFindFirst.mockResolvedValueOnce({
      selection: "FIXED",
      variantTitle: "Cellexia Travel Set",
      variantId: "gid://shopify/ProductVariant/1",
    });
    let r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({
      kind: "named",
      title: "Cellexia Travel Set",
    });
    const ruleWhere = (mocks.giftRuleFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(ruleWhere).toMatchObject({ active: true, trigger: "ORDER_INDEX", orderIndex: 6 });

    mocks.giftRuleFindFirst.mockResolvedValueOnce({
      selection: "DYNAMIC",
      variantTitle: "Fallback Mask",
      variantId: "gid://shopify/ProductVariant/2",
    });
    r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "generic" });

    r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "none" });
  });

  it("ladder rungs: generic only when the engine can actually grant (pool or base rule)", async () => {
    let r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 12)!.gift).toEqual({ kind: "none" });
    mocks.getSetting.mockResolvedValueOnce({ pool: [{ variantId: "v1" }] });
    r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 12)!.gift).toEqual({ kind: "generic" });
    // Never a NAME for a dynamic ladder pick, even with a titled base rule.
    mocks.giftRuleFindFirst.mockResolvedValueOnce({ selection: "FIXED", variantTitle: "X", variantId: "v" });
    r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 12)!.gift).toEqual({ kind: "generic" });
  });

  it("a SCHEDULED grant on the upcoming cycle names the rung's gift from its scheduling event", async () => {
    // ordersCount 5 ⇒ upcoming order 6 = the base rung; grant scheduled on
    // Shopify cycle 7 (one skip drifted the index).
    mocks.giftGrantFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, unknown> }).where;
      if (where.cycleIndex === 7) return { id: "grant_9" };
      return null;
    });
    mocks.eventFindFirst.mockResolvedValueOnce({ payload: { grantId: "grant_9", variantTitle: "Renewal Serum" } });
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 5 }),
      lifecycle,
      now: NOW,
      upcomingCycleIndex: 7,
    });
    expect(r.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "named", title: "Renewal Serum" });
    // Event without a title ⇒ committed but unnamed ⇒ generic.
    mocks.eventFindFirst.mockResolvedValueOnce({ payload: { grantId: "grant_9" } });
    const r2 = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 5 }),
      lifecycle,
      now: NOW,
      upcomingCycleIndex: 7,
    });
    expect(r2.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "generic" });
  });

  it("gifts received counts SHIPPED / settlement-stamped grants", async () => {
    mocks.giftGrantCount.mockResolvedValueOnce(2);
    const r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.giftsReceived).toBe(2);
    const where = (mocks.giftGrantCount.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "c_1", OR: [{ status: "SHIPPED" }, { shippedAt: { not: null } }] });
  });

  it("degrades to generic/none on read failures — never a bolder promise", async () => {
    mocks.giftRuleFindFirst.mockRejectedValueOnce(new Error("db"));
    mocks.getSetting.mockRejectedValueOnce(new Error("settings"));
    mocks.giftGrantCount.mockRejectedValueOnce(new Error("db"));
    const r = await buildRewardsRoadmap({ shopId: "shop_1", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)!.gift).toEqual({ kind: "none" });
    expect(r.rows.find((x) => x.orderNumber === 12)!.gift).toEqual({ kind: "none" });
    expect(r.giftsReceived).toBe(0);
  });
});

// ── Holdout safety ───────────────────────────────────────────────────────────

describe("cycle-2 surprise row — only what the teaser already promised", () => {
  it("absent by default (no teaser sent) and for anyone past order 2", async () => {
    let r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 1 }),
      lifecycle,
      now: NOW,
    });
    expect(r.rows.some((x) => x.kind === "surprise")).toBe(false);
    r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 2 }),
      lifecycle,
      now: NOW,
      teaserPromised: true,
    });
    expect(r.rows.some((x) => x.kind === "surprise")).toBe(false);
  });
  it("present, generic and dated for order 2 once the teaser was SENT", async () => {
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 1 }),
      lifecycle,
      now: NOW,
      teaserPromised: true,
    });
    const row = r.rows.find((x) => x.kind === "surprise")!;
    expect(row.orderNumber).toBe(2);
    expect(row.gift).toEqual({ kind: "generic" });
    expect(row.aroundDate?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    // v1.29.0: rows are chronological — the surprise (Sep 1) sits right after
    // the day-N reward (Aug 30) and before every milestone rung.
    const kinds = r.rows.map((x) => x.kind);
    expect(kinds.indexOf("surprise")).toBe(kinds.indexOf("rewards") + 1);
    expect(kinds.indexOf("surprise")).toBeLessThan(kinds.indexOf("milestone"));
  });
  it("teaserPromisedFor reads the SENT gift_teaser for cycle 2 — the holdout never has one", async () => {
    expect(await teaserPromisedFor("c_1")).toBe(false);
    const where = (mocks.notificationLogFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      contractId: "c_1",
      template: "gift_teaser",
      status: "SENT",
      payload: { path: ["cycleIndex"], equals: 2 },
    });
    mocks.notificationLogFindFirst.mockResolvedValueOnce({ id: "n1" });
    expect(await teaserPromisedFor("c_1")).toBe(true);
    mocks.notificationLogFindFirst.mockRejectedValueOnce(new Error("db"));
    expect(await teaserPromisedFor("c_1")).toBe(false);
  });
  it("the roadmap builder never imports the experiment kernel (no exposure from a read)", () => {
    const src = readSource("app/lib/portal/growth.server.ts");
    expect(src).not.toMatch(/experiments\/index\.server/);
  });
});

// ── Route + cancel seam pins ─────────────────────────────────────────────────

describe("wiring pins", () => {
  it("home route: roadmap behind growth.rewardsRoadmap, teaser-gated surprise, classic strip fallback", () => {
    // v1.29.0: the rewards card lives in the shared rewards-card module (the
    // home and the single-mode subscription page both call rewardsSectionHtml).
    const home = readSource("app/routes/proxy._index.tsx");
    expect(home).toContain("body += await rewardsSectionHtml({");
    const src = readSource("app/lib/portal/rewards-card.server.ts");
    expect(src).toContain("if (growth.rewardsRoadmap)");
    expect(src).toContain("teaserPromised: await teaserPromisedFor(primary.id)");
    // The upcoming Shopify cycle index is passed, so a rung whose gift is
    // already SCHEDULED/ADDED on the next order is named from its grant.
    expect(src).toContain("upcomingCycleIndex = await nextCycleIndex(primary)");
    expect(src).toMatch(/rewardsUnlockedEvent: rewardsEvent !== null,\s+upcomingCycleIndex,/);
    expect(src).toContain("return roadmapHtml || rewardsStripHtml({");
    expect(src).toContain("portal.roadmap.deliveries_so_far");
    expect(src).toContain("portal.roadmap.gifts_received");
    // Named gifts only through the builder's label; the surprise row never
    // renders a gift name.
    expect(src).toContain('row.kind === "surprise" ? "" : giftText(row)');
  });
  it("cancel intro seam: RetentionSummary.nextMilestoneAt via projectOrderDate, rendered as 'around {date}'", () => {
    const summary = readSource("app/lib/cancel/summary.server.ts");
    expect(summary).toContain("nextMilestoneAt = projectOrderDate(contract, nextMilestoneCycle, shop.ianaTimezone)");
    const pages = readSource("app/lib/cancel/pages.server.ts");
    expect(pages).toContain('"cancel.intro.milestone_around"');
    expect(pages).toContain("summary.ordersToMilestone > 0 &&");
  });
  it("roadmap copy hygiene: never names cancellation, 'around' hedges every date", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    const keys = Object.keys(catalog).filter((k) => k.startsWith("portal.roadmap."));
    expect(keys.length).toBeGreaterThanOrEqual(9);
    for (const key of keys) expect(catalog[key], key).not.toMatch(/cancel/i);
    expect(catalog["portal.roadmap.around"]).toMatch(/^around \{date\}$/);
    expect(catalog["portal.roadmap.gift_generic"]).toBe("a free product");
  });
});
