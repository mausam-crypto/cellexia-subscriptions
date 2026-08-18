import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PORTAL HOME RENDER FIXES (v1.29.0) — pins for the merchant-reported home
 * page defects:
 *
 *  1. Rewards roadmap rows had NO CSS (mark/label/meta ran together) and were
 *     built in "rungs then day-N" order, so "Rewards unlock · around Aug 28,
 *     2026" trailed the 2029 rungs. Now: .cxs-roadmap__* styles live in the
 *     portal shell CSS; rows are sorted chronologically (reached first, then
 *     by aroundDate); the base rung follows the SAME truth rule as the ladder
 *     (rule-driven — no rule ⇒ nothing, which is exactly what the engine
 *     grants; the ladder's "a free product" comes from the pool the engine
 *     picks from).
 *  2. Home "NEXT ORDER" block: heading date + ONE subline "{amount} · {card}"
 *     (the date is never repeated), and the cut-off is worded by the shared
 *     formatter — shop midnight reads as the END of the previous day
 *     ("August 19, 2026, 11:59 PM"), any other moment prints its local time.
 *     Home card, detail hero and reminder {edit_cutoff} all use it.
 *  3. Value tiles: one style (.cxs-value__*), the member-since date compact,
 *     "delivery/deliveries" pluralised by count via two keys.
 *  4. Gift row "Gift from us": rendered only for a committed (isGift mirror)
 *     line — scheduled_gift estimate rows are filtered out of the home card;
 *     the demo persona's gift line reads "Free gift — thank you".
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
    shop: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  authenticate: {},
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

import {
  buildRewardsRoadmap,
  sortRoadmapRows,
  type RoadmapContract,
  type RoadmapRow,
} from "~/lib/portal/growth.server";
import { formatEditCutoff, editCutoffSync } from "~/lib/billing/timing.server";
import { cutoffLabel } from "~/lib/portal/next-delivery.server";
import { reminderCutoffVars } from "~/lib/billing/reminders.server";
import { portalPage } from "~/lib/portal/layout.server";
import { t } from "~/lib/i18n/i18n.server";
import en from "~/lib/i18n/locales/en.json";

const TZ = "Europe/Zurich";
const NOW = new Date("2026-08-17T12:00:00Z");

function contract(over: Partial<RoadmapContract> = {}): RoadmapContract {
  return {
    id: "c_1",
    ordersCount: 2,
    nextBillingDate: new Date("2026-08-20T00:00:00Z"),
    firstChargeAt: new Date("2026-05-30T00:00:00Z"),
    createdAt: new Date("2026-05-30T00:00:00Z"),
    intervalWeeks: 8,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 8,
    ...over,
  };
}
const lifecycle = {
  milestoneGiftCycle: 6,
  milestoneLadder: [12, 18, 24],
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
  mocks.getSetting.mockResolvedValue({ pool: [{ variantId: "v1" }] });
});

// ── 1. Rewards roadmap ───────────────────────────────────────────────────────

describe("rewards roadmap — CSS present in the portal shell", () => {
  it("the shell CSS the home page loads styles every roadmap part (flex row, fixed mark, muted meta)", () => {
    const html = portalPage({ locale: "en", title: "t", body: "" });
    expect(html).toContain(".cxs-roadmap__list{");
    expect(html).toMatch(/\.cxs-roadmap__row\{[^}]*display:flex/);
    expect(html).toMatch(/\.cxs-roadmap__row\{[^}]*gap:2px 10px/);
    expect(html).toMatch(/\.cxs-roadmap__row\{[^}]*align-items:baseline/);
    expect(html).toMatch(/\.cxs-roadmap__mark\{[^}]*width:18px/);
    expect(html).toContain(".cxs-roadmap__label{");
    expect(html).toContain(".cxs-roadmap__meta{");
    // Narrow screens: meta drops to its own line, indented past the mark
    // (logical property → RTL safe).
    expect(html).toMatch(/@media \(max-width:479px\)\{[^@]*\.cxs-roadmap__meta\{[^}]*flex-basis:100%/);
    expect(html).toMatch(/\.cxs-roadmap__meta\{[^}]*padding-inline-start:28px/);
    // The .cxs-rewards__* family lives in the same sheet — same delivery path.
    expect(html).toContain(".cxs-rewards__num{");
    // Roadmap tiles (three short counts) sit three-across at 375px; the
    // classic strip (progress bars + longer labels) keeps its 150px cells.
    expect(html).toContain(".cxs-roadmap .cxs-rewards__cell{flex:1 1 80px;min-width:0}");
    expect(html).toContain(".cxs-rewards__cell{flex:1;min-width:150px}");
  });

  it("the route no longer carries the list styles inline; row markup uses the styled classes only", () => {
    // v1.29.0: the roadmap markup moved to the shared rewards-card module.
    const src = readSource("app/lib/portal/rewards-card.server.ts");
    expect(src).toContain('<ul class="cxs-roadmap__list" aria-label=');
    expect(src).not.toContain('class="cxs-roadmap__list" style=');
    expect(src).toContain('class="cxs-roadmap__mark" aria-hidden="true"');
    expect(src).toContain('class="cxs-roadmap__label"');
    expect(src).toContain("cxs-roadmap__meta");
    // Meta parts are joined with the middle-dot separator.
    expect(src).toContain('[when, gift].filter(Boolean).join(" · ")');
    // No stray non-cxs class in the roadmap section.
    const section = src.slice(src.indexOf("function rewardsRoadmapHtml"), src.indexOf("export async function rewardsSectionHtml"));
    for (const cls of section.matchAll(/class="([^"]+)"/g)) {
      for (const c of cls[1].split(/\s+/)) {
        // Template fragments (`${row.reached ? " cxs-…" : ""}`) are not class names.
        if (!/^[a-z][a-z0-9_-]*$/.test(c)) continue;
        expect(c.startsWith("cxs-"), `class ${c}`).toBe(true);
      }
    }
  });
});

describe("rewards roadmap — chronological row order", () => {
  const row = (over: Partial<RoadmapRow>): RoadmapRow => ({
    kind: "milestone",
    orderNumber: 6,
    reached: false,
    aroundDate: null,
    gift: { kind: "none" },
    ...over,
  });

  it("sortRoadmapRows: reached first (build order kept), then by aroundDate ascending, undated last", () => {
    const rows = [
      row({ orderNumber: 6, aroundDate: new Date("2027-02-04") }),
      row({ orderNumber: 12, aroundDate: new Date("2028-01-06") }),
      row({ orderNumber: 24, aroundDate: new Date("2029-11-15") }),
      row({ kind: "rewards", orderNumber: null, aroundDate: new Date("2026-08-28") }),
      row({ orderNumber: 4, reached: true }),
      row({ orderNumber: 99, aroundDate: null }),
      row({ orderNumber: 2, reached: true }),
    ];
    const sorted = sortRoadmapRows(rows);
    expect(sorted.map((r) => r.kind === "rewards" ? "rewards" : `${r.reached ? "✓" : "○"}${r.orderNumber}`)).toEqual([
      "✓4",
      "✓2",
      "rewards",
      "○6",
      "○12",
      "○24",
      "○99",
    ]);
    // Pure: the input is not mutated.
    expect(rows[0].orderNumber).toBe(6);
  });

  it("buildRewardsRoadmap: the day-N reward lands where its date falls — before the 2027+ rungs (the merchant's screenshot case)", async () => {
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract(), // 2 orders, next Aug 20 2026, every 8 weeks
      lifecycle,
      now: NOW,
    });
    const labels = r.rows.map((x) => (x.kind === "rewards" ? "rewards" : `o${x.orderNumber}`));
    expect(labels).toEqual(["rewards", "o6", "o12", "o18", "o24"]);
    // firstChargeAt May 30 + 90 d = Aug 28 — first; order 6 = Aug 20 + 3×8 w = Feb 4 2027.
    expect(r.rows[0].aroundDate?.toISOString().slice(0, 10)).toBe("2026-08-28");
    expect(r.rows[1].aroundDate?.toISOString().slice(0, 10)).toBe("2027-02-04");
    const dates = r.rows.map((x) => x.aroundDate!.getTime());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });

  it("buildRewardsRoadmap: reached rows come first, then the dated ones in order", async () => {
    mocks.eventFindMany.mockResolvedValue([{ payload: { ordersCount: 6, giftGranted: true } }]);
    const r = await buildRewardsRoadmap({
      shopId: "shop_1",
      tz: TZ,
      contract: contract({ ordersCount: 7, firstChargeAt: new Date("2025-01-01T00:00:00Z") }),
      lifecycle,
      now: NOW,
    });
    expect(r.rows[0].reached).toBe(true);
    expect(r.rows[1].reached).toBe(true);
    expect(r.rows.slice(0, 2).map((x) => x.kind).sort()).toEqual(["milestone", "rewards"]);
    const ahead = r.rows.slice(2);
    expect(ahead.every((x) => !x.reached && x.aroundDate)).toBe(true);
    const dates = ahead.map((x) => x.aroundDate!.getTime());
    expect([...dates].sort((a, b) => a - b)).toEqual(dates);
  });
});

describe("rewards roadmap — gift text truth rule (base rung vs ladder rungs)", () => {
  it("no base rule + a gift pool: the base rung promises NOTHING (the engine grants the base milestone by rule only) while ladder rungs read 'a free product' (the engine picks from the pool)", async () => {
    // This is the merchant's screenshot: 'Order 6 milestone' bare, 12/18/24
    // 'a free product'. It is the truthful rendering — the base
    // milestoneGiftCycle stays rule-driven in gifts/engine.server.ts
    // ("The base milestoneGiftCycle itself stays rule-driven"), so without a
    // GiftRule row on order 6 that box carries no gift; the ladder rungs are
    // granted directly from the pool.
    const engine = readSource("app/lib/gifts/engine.server.ts");
    expect(engine).toContain("targetOrderNumber !== lifecycle.milestoneGiftCycle");
    const r = await buildRewardsRoadmap({ shopId: "s", tz: TZ, contract: contract(), lifecycle, now: NOW });
    const byOrder = new Map(r.rows.map((x) => [x.orderNumber, x.gift]));
    expect(byOrder.get(6)).toEqual({ kind: "none" });
    expect(byOrder.get(12)).toEqual({ kind: "generic" });
    expect(byOrder.get(24)).toEqual({ kind: "generic" });
  });

  it("with a DYNAMIC base rule the base rung reads 'a free product' like the ladder; FIXED with a title names it; the ladder never names an uncommitted pick", async () => {
    mocks.giftRuleFindFirst.mockResolvedValue({ selection: "DYNAMIC", variantTitle: null, variantId: "v" });
    let r = await buildRewardsRoadmap({ shopId: "s", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)?.gift).toEqual({ kind: "generic" });
    expect(r.rows.find((x) => x.orderNumber === 12)?.gift).toEqual({ kind: "generic" });

    mocks.giftRuleFindFirst.mockResolvedValue({ selection: "FIXED", variantTitle: "Travel Kit", variantId: "v" });
    r = await buildRewardsRoadmap({ shopId: "s", tz: TZ, contract: contract(), lifecycle, now: NOW });
    expect(r.rows.find((x) => x.orderNumber === 6)?.gift).toEqual({ kind: "named", title: "Travel Kit" });
    // Ladder rungs are a per-customer pick — never the base rule's name.
    expect(r.rows.find((x) => x.orderNumber === 12)?.gift).toEqual({ kind: "generic" });
  });

  it("no rule AND no pool: neither the base rung nor a ladder rung promises anything", async () => {
    mocks.getSetting.mockResolvedValue({ pool: [] });
    const r = await buildRewardsRoadmap({ shopId: "s", tz: TZ, contract: contract(), lifecycle, now: NOW });
    for (const x of r.rows.filter((x) => x.kind === "milestone")) {
      expect(x.gift).toEqual({ kind: "none" });
    }
  });
});

// ── 2. Next-order block: single line + cut-off wording ───────────────────────

describe("home next-order block — one subline, no repeated date", () => {
  it("the schedule block prints heading date + '{amount} · {card}' (card only when known) and never the date twice", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    const block = src.slice(
      src.indexOf('} else if (contract.status === "ACTIVE" && contract.nextBillingDate) {'),
      src.indexOf('} else if (contract.status === "PAUSED" && contract.resumeAt) {'),
    );
    expect(block).toContain('const chargeLine = [total, params.estimate.cardLabel || null]');
    expect(block).toContain('.join(" · ")');
    // The old "{amount} on {date}" composer is gone from the home card.
    expect(block).not.toContain("nextChargeLine(");
    expect(src).not.toMatch(/import \{[^}]*\bnextChargeLine\b[^}]*\} from "~\/lib\/portal\/payment\.server"/);
    // Heading date, one subline, one cut-off line, ORDER TOTAL stays at right.
    expect(block).toContain('<strong>${escapeHtml(nextDate)}</strong><p class="cxs-muted cxs-small cxs-next-charge"');
    expect(block).toContain("cxs-next__cutoff");
    expect(src).toContain('portal.index.order_total"))}</span><strong class="cxs-price">${escapeHtml(total)}</strong>');
  });
});

describe("cut-off wording — ONE shared formatter (timing.server.ts formatEditCutoff)", () => {
  it("shop midnight reads as the END of the previous day; any other moment prints its local time", () => {
    // Zurich: Aug 20 00:00 CEST = Aug 19 22:00Z.
    expect(formatEditCutoff(new Date("2026-08-19T22:00:00.000Z"), TZ, "en")).toBe("August 19, 2026, 11:59 PM");
    // Charge hour 6.
    expect(formatEditCutoff(new Date("2026-08-20T04:00:00.000Z"), TZ, "en")).toBe("August 20, 2026, 6:00 AM");
    // One minute past midnight is NOT midnight — printed as is.
    expect(formatEditCutoff(new Date("2026-08-19T22:01:00.000Z"), TZ, "en")).toBe("August 20, 2026, 12:01 AM");
    // Locale-neutral: null/undefined locale falls back to en.
    expect(formatEditCutoff(new Date("2026-08-19T22:00:00.000Z"), TZ, null)).toBe("August 19, 2026, 11:59 PM");
  });

  it("tz edges: London (BST), Los Angeles, Kolkata (+05:30), UTC, and a DST-change day", () => {
    // London Aug 20 00:00 BST = Aug 19 23:00Z.
    expect(formatEditCutoff(new Date("2026-08-19T23:00:00.000Z"), "Europe/London", "en")).toBe("August 19, 2026, 11:59 PM");
    // The same UTC instant is 01:00 CEST in Zurich — not midnight there.
    expect(formatEditCutoff(new Date("2026-08-19T23:00:00.000Z"), TZ, "en")).toBe("August 20, 2026, 1:00 AM");
    // Los Angeles Aug 20 00:00 PDT = Aug 20 07:00Z.
    expect(formatEditCutoff(new Date("2026-08-20T07:00:00.000Z"), "America/Los_Angeles", "en")).toBe("August 19, 2026, 11:59 PM");
    // Kolkata Aug 20 00:00 IST = Aug 19 18:30Z.
    expect(formatEditCutoff(new Date("2026-08-19T18:30:00.000Z"), "Asia/Kolkata", "en")).toBe("August 19, 2026, 11:59 PM");
    // UTC.
    expect(formatEditCutoff(new Date("2026-08-20T00:00:00.000Z"), "UTC", "en")).toBe("August 19, 2026, 11:59 PM");
    // Zurich DST end (Oct 25 2026, 03:00 CEST → 02:00 CET): midnight of Oct 26
    // is Oct 25 23:00Z; the previous minute is still Oct 25 23:59 local.
    expect(formatEditCutoff(new Date("2026-10-25T23:00:00.000Z"), TZ, "en")).toBe("October 25, 2026, 11:59 PM");
    // Month / year boundary.
    expect(formatEditCutoff(new Date("2026-12-31T23:00:00.000Z"), TZ, "en")).toBe("December 31, 2026, 11:59 PM");
  });

  it("the shared formatter agrees with editCutoffSync (hour 0 ⇒ previous day 11:59 PM; hour 6 ⇒ 6:00 AM)", () => {
    const due = new Date("2026-08-20T00:00:00.000Z");
    const midnight = editCutoffSync(due, { tz: TZ, chargeHourLocal: 0 });
    expect(formatEditCutoff(midnight, TZ, "en")).toBe("August 19, 2026, 11:59 PM");
    const six = editCutoffSync(due, { tz: TZ, chargeHourLocal: 6 });
    expect(formatEditCutoff(six, TZ, "en")).toBe("August 20, 2026, 6:00 AM");
  });

  it("hero/home (cutoffLabel) and the reminder ({edit_cutoff}) print the SAME string", () => {
    const due = new Date("2026-08-20T00:00:00.000Z");
    const timing = { tz: TZ, chargeHourLocal: 0 };
    const cutoff = editCutoffSync(due, timing);
    const label = cutoffLabel("en", cutoff, TZ);
    expect(label).toBe("August 19, 2026, 11:59 PM");
    const vars = reminderCutoffVars("en", due, timing);
    expect(vars.edit_cutoff).toBe(label);
    // The instant itself is untouched — the sweep still bills at midnight.
    expect(vars.edit_cutoff_iso).toBe("2026-08-19T22:00:00.000Z");
    expect(vars.edit_cutoff_line).toBe("You can make changes until August 19, 2026, 11:59 PM.");
    // Home card copy: "Changes until {cutoff}".
    expect(t("en", "portal.next.cutoff_short", { cutoff: label })).toBe("Changes until August 19, 2026, 11:59 PM");
  });

  it("source pins: every cut-off surface routes through formatEditCutoff", () => {
    expect(readSource("app/lib/portal/next-delivery.server.ts")).toContain("return formatEditCutoff(cutoff, tz, locale);");
    expect(readSource("app/lib/billing/reminders.server.ts")).toContain("formatEditCutoff(cutoff, timing.tz, locale)");
    const home = readSource("app/routes/proxy._index.tsx");
    expect(home).toContain("cutoffLabel(locale, params.cutoff, tz)");
    expect(home).not.toContain("formatShopTime(");
  });
});

// ── 3. Value tiles ───────────────────────────────────────────────────────────

describe("home value tiles — uniform style + pluralised milestone label", () => {
  it("tiles use one .cxs-value__* style family (no .cxs-rewards__num outside the rewards card)", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    const card = src.slice(src.indexOf("const valueCard = params.valueCard"), src.indexOf("const actions: string[] = [];"));
    expect(card).toContain('<div class="cxs-value" style="margin-top:12px">');
    expect(card).toContain('class="cxs-value__cell"');
    expect(card).toContain('class="cxs-value__num${numClass}"');
    expect(card).toContain('class="cxs-muted cxs-small cxs-value__label"');
    expect(card).toContain(' cxs-value__num--date');
    expect(card).not.toContain("cxs-rewards__num");
    expect(card).not.toContain("cxs-rewards__grid");
    // CSS present in the shell: same serif family + tabular numerals; the
    // date variant is smaller so it never dominates a bare count.
    const html = portalPage({ locale: "en", title: "t", body: "" });
    expect(html).toMatch(/\.cxs-value\{[^}]*display:flex/);
    expect(html).toMatch(/\.cxs-value__num\{[^}]*font-family:Georgia/);
    expect(html).toMatch(/\.cxs-value__num\{[^}]*font-size:22px/);
    expect(html).toMatch(/\.cxs-value__num--date\{[^}]*font-size:17px/);
    expect(html).toContain(".cxs-value__label{");
  });

  it("'delivery/deliveries to your milestone gift' is selected by count via two keys", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    expect(src).toContain('params.milestoneAway === 1\n              ? "portal.value.milestone_away_one"\n              : "portal.value.milestone_away_other"');
    expect(src).not.toContain('"portal.value.milestone_away"');
    expect(en["portal.value.milestone_away_one"]).toBe("delivery to your milestone gift");
    expect(en["portal.value.milestone_away_other"]).toBe("deliveries to your milestone gift");
    expect((en as Record<string, string>)["portal.value.milestone_away"]).toBeUndefined();
    expect(en["portal.value.milestone_away_one"]).not.toContain("(");
    expect(en["portal.value.milestone_away_other"]).not.toContain("(");
  });
});

// ── 4. Gift row ──────────────────────────────────────────────────────────────

describe("gift row 'Gift from us' — committed grants only", () => {
  it("the home items list renders estimate lines minus scheduled_gift rows; the 'gift' kind is the isGift mirror row (a committed cycle edit)", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    expect(src).toContain('.filter((line) => line.kind !== "scheduled_gift")');
    expect(src).toContain('if (line.kind === "gift") badges.push(t(locale, "portal.item.gift"));');
    const est = readSource("app/lib/billing/estimate.server.ts");
    // A "gift" line is derived from the mirror's isGift flag — an ADDED grant
    // already on the contract, never a holdout / uncommitted prediction.
    expect(est).toMatch(/const kind: EstimateLineKind = l\.isGift\s*\?\s*"gift"/);
  });

  it("the demo persona's gift line reads calmly ('Free gift — thank you')", () => {
    const demo = readSource("app/lib/portal/demo.server.ts");
    expect(demo).toContain('const DEMO_GIFT_TITLE = "Free gift — thank you";');
    expect(demo).not.toContain("Surprise gift");
  });
});

// ── 5. General pass ──────────────────────────────────────────────────────────

describe("general pass — .cxs-* only, growth copy hygiene", () => {
  it("every class in the home route's subscription card + roadmap is cxs-namespaced", () => {
    const src = readSource("app/routes/proxy._index.tsx");
    for (const m of src.matchAll(/class="([^"$]+)"/g)) {
      for (const c of m[1].split(/\s+/)) expect(c.startsWith("cxs-"), c).toBe(true);
    }
  });
  it("new copy never names cancellation", () => {
    for (const key of ["portal.value.milestone_away_one", "portal.value.milestone_away_other"]) {
      expect((en as Record<string, string>)[key]).not.toMatch(/cancel/i);
    }
  });
});
