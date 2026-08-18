import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * v1.28.0 Stage B review fixes — pinning tests.
 *
 *  1. followingBillingDate is schedule-aware: after a "just this once" delay
 *     the following order is the anchor the delay recorded (what the toast
 *     said), not delayed + interval; a re-anchor delay / a moved schedule
 *     falls back to next + interval.
 *  2. The estimate's grant arithmetic is the SWEEP's (per unit × quantity —
 *     applyGrantToCycle), pinned on a half-cent case; grantDiscountCents is
 *     the shared helper.
 *  3. Dunning parity: a FAILED / CHALLENGED / EXPIRED newest attempt + the
 *     cycle_discount_applied marker → the estimate shows the applied percent
 *     and cyclesRemaining + 1 (the retry bills the discounted cycle).
 *  4. Scheduled-gift hint follows the newest BillingAttempt's cycleIndex, so a
 *     save-flow gift written on the real Shopify index after skips is still a
 *     next-order row.
 *  5. "Preparing your order" has an upper bound (billing.preparingWindowHours)
 *     when no attempt claimed the day; an in-flight PENDING attempt is
 *     unbounded.
 *  6. Undo: "past" is the CHARGE MOMENT (a same-day-morning delay before the
 *     charge hour stays undoable); the frequency undo is stale when the next
 *     date moved and "past" (never touching the cadence) when the previous
 *     date's charge moment passed; the SMS-reachable "skip" spec unskips.
 *  7. Source pins: undo is preparing-blocked in the dispatcher; magic links,
 *     SMS and the cancel flow enforce the same preparing gate; the ladder
 *     has the downsize row; the run-out prompt posts mode=once.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  shopFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => ({ ianaTimezone: "Europe/Zurich" })),
  getActiveDiscountForCycle: vi.fn(async (_id?: string): Promise<unknown> => null),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "billing") return { chargeHourLocal: 9, preparingWindowHours: 6 };
    return {};
  }),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  changeFrequency: vi.fn(),
  revertDelayedCycle: vi.fn(),
  setNextBillingDate: vi.fn(),
  unskipNextCycle: vi.fn(),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriberEvent: { findMany: mocks.eventFindMany, findFirst: mocks.eventFindFirst },
    billingAttempt: { findFirst: mocks.attemptFindFirst },
    giftGrant: { findMany: mocks.giftGrantFindMany },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/contracts/service.server", () => ({
  changeFrequency: mocks.changeFrequency,
  revertDelayedCycle: mocks.revertDelayedCycle,
  setNextBillingDate: mocks.setNextBillingDate,
  unskipNextCycle: mocks.unskipNextCycle,
}));

import {
  followingFromDelayEvent,
  resolveFollowingBillingDate,
} from "~/lib/billing/following-date.server";
import {
  estimateNextCharge,
  grantDiscountCents,
  loadParkedCycleDiscount,
} from "~/lib/billing/estimate.server";
import { isPreparingOrderSync } from "~/lib/billing/timing.server";
import { performUndo, undoSpecFromEvent, type UndoSpec } from "~/lib/portal/undo.server";
import { addIntervalTz, shopDayStartUtc } from "~/lib/dates.server";
import { applyDiscountPct, discountAmount } from "~/lib/money";

const TZ = "Europe/Zurich";
const SHOP = { id: "shop_1", ianaTimezone: TZ };
const NEXT = new Date("2026-08-30T22:00:00.000Z"); // Aug 31 Zurich
const DELAYED = new Date("2026-09-13T22:00:00.000Z"); // Sep 14 Zurich (+2w)
const ANCHOR_FOLLOWING = addIntervalTz(NEXT, "WEEK", 4, TZ); // Sep 28

function line(over: Record<string, unknown> = {}) {
  return {
    variantId: "gid://shopify/ProductVariant/1",
    title: "Serum",
    variantTitle: null,
    imageUrl: null,
    quantity: 1,
    currentPriceCents: 4900,
    isGift: false,
    isOneTimeAddon: false,
    addonCycleIndex: null,
    ...over,
  };
}

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    ordersCount: 3,
    nextBillingDate: NEXT,
    deliveryPriceCents: 0,
    currencyCode: "CHF",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    lines: [line()],
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const est = (c: Record<string, unknown>, opts?: Record<string, unknown>) =>
  estimateNextCharge(SHOP, c as any, opts as any);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. following date ────────────────────────────────────────────────────────

describe("followingBillingDate is schedule-aware", () => {
  const onceEvent = {
    type: "cycle.delayed",
    payload: {
      mode: "once",
      previousNextBillingDate: NEXT.toISOString(),
      nextBillingDate: DELAYED.toISOString(),
      followingBillingDate: ANCHOR_FOLLOWING.toISOString(),
    },
  };

  it("pure: a once-delay that produced the current next date → its recorded anchor; reanchor / mismatch / legacy shapes → null", () => {
    expect(followingFromDelayEvent(onceEvent, DELAYED)?.toISOString()).toBe(
      ANCHOR_FOLLOWING.toISOString(),
    );
    // Legacy pre-v1.28 rows have no mode → one-cycle delays.
    const { mode: _m, ...legacy } = onceEvent.payload;
    expect(followingFromDelayEvent({ payload: legacy }, DELAYED)?.toISOString()).toBe(
      ANCHOR_FOLLOWING.toISOString(),
    );
    expect(followingFromDelayEvent({ ...onceEvent, payload: { ...onceEvent.payload, mode: "reanchor" } }, DELAYED)).toBeNull();
    // The schedule moved on since (skip / next_date / charge): not this event's date.
    expect(followingFromDelayEvent(onceEvent, NEXT)).toBeNull();
    expect(followingFromDelayEvent(null, DELAYED)).toBeNull();
    expect(followingFromDelayEvent({ payload: null }, DELAYED)).toBeNull();
  });

  it("estimate: after 'just this once' the hero/reminder following date is the anchor the toast named — not delayed + interval", async () => {
    mocks.eventFindMany.mockResolvedValue([onceEvent]);
    const e = await est(contract({ nextBillingDate: DELAYED }));
    expect(e.followingBillingDate?.toISOString()).toBe(ANCHOR_FOLLOWING.toISOString());
    expect(e.followingBillingDate?.toISOString()).not.toBe(
      addIntervalTz(DELAYED, "WEEK", 4, TZ).toISOString(),
    );
  });

  it("estimate: no delay event / a re-anchor delay → next + one interval; a failed event read degrades to the same", async () => {
    const plain = await est(contract());
    expect(plain.followingBillingDate?.toISOString()).toBe(ANCHOR_FOLLOWING.toISOString());
    mocks.eventFindMany.mockResolvedValue([
      { ...onceEvent, payload: { ...onceEvent.payload, mode: "reanchor" } },
    ]);
    const re = await est(contract({ nextBillingDate: DELAYED }));
    expect(re.followingBillingDate?.toISOString()).toBe(addIntervalTz(DELAYED, "WEEK", 4, TZ).toISOString());
    mocks.eventFindMany.mockRejectedValue(new Error("db down"));
    const degraded = await resolveFollowingBillingDate(contract({ nextBillingDate: DELAYED }) as never, TZ);
    expect(degraded?.toISOString()).toBe(addIntervalTz(DELAYED, "WEEK", 4, TZ).toISOString());
  });

  it("source pins: delayNextCycle and the api dispatcher's once-toast read the same anchor", () => {
    const service = readSource("app/lib/contracts/service.server.ts");
    expect(service).toContain("followingFromDelayEvent(");
    expect(service).toContain("loadNewestDelayEvent(contract.id)");
    const api = readSource("app/routes/proxy.api.$action.tsx");
    expect(api).toContain("followingFromDelayEvent(");
    expect(api).toContain("?? followingOf(before))");
  });
});

// ── 2. per-unit grant arithmetic ─────────────────────────────────────────────

describe("estimate discount = the sweep's per-unit arithmetic", () => {
  it("half-cent case: 10.05 × 3 at 10% → 27.15 (3 × 9.05), never the aggregate 27.14", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({ id: "dg", percent: 10, cyclesRemaining: 2 });
    const e = await est(contract({ lines: [line({ currentPriceCents: 1005, quantity: 3 })] }));
    expect(e.subtotalCents).toBe(3015);
    expect(e.discountCents).toBe(300);
    expect(e.totalCents).toBe(2715);
    expect(e.totalCents).toBe(3 * applyDiscountPct(1005, 10));
    // The old aggregate rounding would have said 2714 / 301.
    expect(applyDiscountPct(3015, 10)).toBe(2714);
    expect(grantDiscountCents([{ currentPriceCents: 1005, quantity: 3 }], 10)).toBe(300);
    expect(grantDiscountCents([{ currentPriceCents: 1005, quantity: 3 }], 10)).toBe(
      discountAmount(1005, 10) * 3,
    );
    // Gift lines and a zero percent contribute nothing.
    expect(grantDiscountCents([{ currentPriceCents: 1005, quantity: 3, isGift: true }], 10)).toBe(0);
    expect(grantDiscountCents([{ currentPriceCents: 1005, quantity: 3 }], 0)).toBe(0);
  });
});

// ── 3. dunning parity ────────────────────────────────────────────────────────

describe("dunning owns the cycle → the applied marker is the estimate's truth", () => {
  const marker = {
    payload: {
      action: "cycle_discount_applied",
      grantId: "dg",
      percent: 20,
      cycleIndex: 7,
      discountCents: 980,
      cyclesRemaining: 0,
    },
  };

  it("FAILED newest attempt + marker → percent from the marker, cyclesRemaining + 1, discounted total (grant row exhausted)", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 7, status: "FAILED" });
    mocks.eventFindFirst.mockResolvedValue(marker);
    const parked = await loadParkedCycleDiscount("cm_1");
    expect(parked).toEqual({ percent: 20, cyclesRemaining: 1, cycleIndex: 7 });
    // getActiveDiscountForCycle finds nothing (1-cycle grant exhausted at pre-charge).
    const e = await est(contract());
    expect(e.discountPercent).toBe(20);
    expect(e.discountCyclesRemaining).toBe(1);
    expect(e.discountCents).toBe(980);
    expect(e.totalCents).toBe(4900 - 980);
    expect(e.discountLabel).toBe("20% off — 1 discounted order left");
  });

  it("no parked cycle when the newest attempt SUCCEEDED / is PENDING, or without a marker; opts.parkedDiscount:false skips the read", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 7, status: "SUCCESS" });
    mocks.eventFindFirst.mockResolvedValue(marker);
    expect(await loadParkedCycleDiscount("cm_1")).toBeNull();
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 7, status: "PENDING" });
    expect(await loadParkedCycleDiscount("cm_1")).toBeNull();
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 7, status: "CHALLENGED" });
    mocks.eventFindFirst.mockResolvedValue(null);
    expect(await loadParkedCycleDiscount("cm_1")).toBeNull();
    mocks.eventFindFirst.mockResolvedValue(marker);
    mocks.eventFindFirst.mockClear();
    const e = await est(contract(), { parkedDiscount: false, includeScheduledGifts: false });
    expect(e.discountPercent).toBeNull();
    expect(mocks.eventFindFirst).not.toHaveBeenCalled();
    // A pre-resolved parked discount is used as is (no read).
    const pre = await est(contract(), { parkedDiscount: { percent: 5, cyclesRemaining: 2, cycleIndex: 7 }, includeScheduledGifts: false });
    expect(pre.discountPercent).toBe(5);
    expect(pre.discountCyclesRemaining).toBe(2);
  });

  it("marker wins over a still-live multi-cycle grant (3-cycle grant applied → row says 2, truth for this cycle is 3)", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({ id: "dg", percent: 20, cyclesRemaining: 2 });
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 7, status: "EXPIRED" });
    mocks.eventFindFirst.mockResolvedValue({ payload: { ...marker.payload, cyclesRemaining: 2 } });
    const e = await est(contract());
    expect(e.discountCyclesRemaining).toBe(3);
  });

  it("source pin: the retention summary reads the same parked-cycle discount", () => {
    expect(readSource("app/lib/cancel/summary.server.ts")).toContain("loadParkedCycleDiscount(contract.id)");
  });
});

// ── 4. scheduled-gift hint ───────────────────────────────────────────────────

describe("scheduled-gift hint follows the newest attempt's cycle index", () => {
  it("ordersCount 3 + two skips (newest attempt SUCCESS at index 4 → upcoming 6): a SAVE_FLOW gift on cycle 6 is a next-order row", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([
      { id: "gg", cycleIndex: 6, status: "SCHEDULED", variantId: "gid://v/gift", rule: { name: "Save gift", variantTitle: "Hydra Mask" } },
    ]);
    // Newest attempt: SUCCESS on cycle 5 → upcoming index ≥ 6.
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 5, status: "SUCCESS" });
    const e = await est(contract());
    expect(e.lines.some((l) => l.kind === "scheduled_gift" && l.title === "Hydra Mask")).toBe(true);
    // Without that knowledge (hint = ordersCount + 1 = 4) the grant is filtered.
    mocks.attemptFindFirst.mockResolvedValue(null);
    const e2 = await est(contract());
    expect(e2.lines.some((l) => l.kind === "scheduled_gift")).toBe(false);
  });
});

// ── 5. preparing upper bound ─────────────────────────────────────────────────

describe("'Preparing your order' upper bound", () => {
  const due = new Date("2026-08-16T22:00:00.000Z"); // Aug 17 Zurich, hour 0
  const timing = { tz: TZ, chargeHourLocal: 0, preparingWindowHours: 6 };
  const c = (attempts: unknown[] = []) => ({
    id: "cm_1",
    status: "ACTIVE",
    nextBillingDate: due,
    billingAttempts: attempts as never,
  });

  it("no attempt: preparing inside the window after the charge moment, classic controls back once it lapses", () => {
    const start = shopDayStartUtc(due, TZ).getTime();
    expect(isPreparingOrderSync(c(), timing, new Date(start + 5 * 60_000))).toBe(true);
    expect(isPreparingOrderSync(c(), timing, new Date(start + 5 * 3_600_000))).toBe(true);
    expect(isPreparingOrderSync(c(), timing, new Date(start + 6 * 3_600_000))).toBe(false);
    expect(isPreparingOrderSync(c(), timing, new Date(start + 16 * 86_400_000))).toBe(false);
    // Missing setting → default 6 h; a merchant value is honoured.
    expect(isPreparingOrderSync(c(), { tz: TZ, chargeHourLocal: 0 }, new Date(start + 7 * 3_600_000))).toBe(false);
    expect(isPreparingOrderSync(c(), { ...timing, preparingWindowHours: 24 }, new Date(start + 7 * 3_600_000))).toBe(true);
  });

  it("an in-flight PENDING attempt stays 'preparing' however long it lasts", () => {
    const start = shopDayStartUtc(due, TZ).getTime();
    const inflight = c([{ status: "PENDING", originatingAction: "SCHEDULER", startedAt: new Date(start), scheduledFor: due, supersededAt: null }]);
    expect(isPreparingOrderSync(inflight, timing, new Date(start + 3 * 86_400_000))).toBe(true);
  });
});

// ── 6. undo guards ───────────────────────────────────────────────────────────

describe("undo guards", () => {
  const SHOP_DOMAIN = "cellexia.myshopify.com";
  const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer", via: "portal" as const };
  const TIMING9 = { tz: TZ, chargeHourLocal: 9 };
  const TODAY = new Date("2026-08-16T22:00:00.000Z"); // Aug 17 Zurich 00:00
  const IN_A_WEEK = new Date("2026-08-23T22:00:00.000Z");
  const undoContract = (over: Record<string, unknown> = {}) => ({
    id: "ctr_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "a@b.c",
    status: "ACTIVE",
    nextBillingDate: IN_A_WEEK,
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ...over,
  });

  beforeEach(() => {
    mocks.revertDelayedCycle.mockImplementation(async (_s: string, _id: string, d: Date) => ({ nextBillingDate: d }));
    mocks.setNextBillingDate.mockImplementation(async (_s: string, _id: string, d: Date) => ({ nextBillingDate: d }));
    mocks.unskipNextCycle.mockImplementation(async () => ({ nextBillingDate: TODAY }));
    mocks.changeFrequency.mockImplementation(async () => ({ nextBillingDate: TODAY, billingIntervalUnit: "WEEK", billingIntervalCount: 4 }));
  });

  it("'past' is the charge moment: a same-day-morning delay (07:00, charge hour 9) is still undoable; after 09:00 it is not", async () => {
    const spec: UndoSpec = {
      kind: "delay",
      mode: "once",
      previousNextBillingDate: TODAY.toISOString(),
      nextBillingDate: IN_A_WEEK.toISOString(),
    };
    const at0700 = new Date("2026-08-17T05:00:00.000Z"); // 07:00 Zurich (CEST)
    const out = await performUndo(SHOP_DOMAIN, undoContract() as never, spec, { ...OPTS, timing: TIMING9 }, at0700);
    expect(out.kind).toBe("restored");
    expect(mocks.revertDelayedCycle).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", TODAY, expect.anything());
    vi.clearAllMocks();
    const at0930 = new Date("2026-08-17T07:30:00.000Z");
    const late = await performUndo(SHOP_DOMAIN, undoContract() as never, spec, { ...OPTS, timing: TIMING9 }, at0930);
    expect(late.kind).toBe("past");
    expect(mocks.revertDelayedCycle).not.toHaveBeenCalled();
  });

  it("frequency undo is 'stale' when the next date moved since (a later delay is never discarded)", async () => {
    const spec: UndoSpec = {
      kind: "frequency",
      oldUnit: "WEEK", oldCount: 4, newUnit: "WEEK", newCount: 8,
      previousNextBillingDate: IN_A_WEEK.toISOString(),
      nextBillingDate: "2026-09-13T22:00:00.000Z",
    };
    const c = undoContract({ billingIntervalCount: 8, nextBillingDate: new Date("2026-09-27T22:00:00.000Z") });
    const out = await performUndo(SHOP_DOMAIN, c as never, spec, { ...OPTS, timing: TIMING9 }, new Date("2026-08-17T10:00:00.000Z"));
    expect(out.kind).toBe("stale");
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });

  it("frequency undo is 'past' — cadence untouched — once the previous date's charge moment passed (no immediate-charge undo)", async () => {
    const spec: UndoSpec = {
      kind: "frequency",
      oldUnit: "WEEK", oldCount: 4, newUnit: "WEEK", newCount: 8,
      previousNextBillingDate: TODAY.toISOString(),
      nextBillingDate: "2026-09-13T22:00:00.000Z",
    };
    const c = undoContract({ billingIntervalCount: 8, nextBillingDate: new Date("2026-09-13T22:00:00.000Z") });
    const out = await performUndo(SHOP_DOMAIN, c as never, spec, { ...OPTS, timing: TIMING9 }, new Date("2026-08-25T10:00:00.000Z"));
    expect(out.kind).toBe("past");
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
    // Unknown previous date → nothing truthful to restore to either.
    const unknown = await performUndo(SHOP_DOMAIN, c as never, { ...spec, previousNextBillingDate: null }, { ...OPTS, timing: TIMING9 }, new Date("2026-08-17T10:00:00.000Z"));
    expect(unknown.kind).toBe("past");
    expect(mocks.changeFrequency).not.toHaveBeenCalled();
    // Ahead of the charge moment: restored (cadence + date).
    const ok = await performUndo(SHOP_DOMAIN, c as never, { ...spec, previousNextBillingDate: IN_A_WEEK.toISOString() }, { ...OPTS, timing: TIMING9 }, new Date("2026-08-17T10:00:00.000Z"));
    expect(ok.kind).toBe("restored");
    expect(mocks.changeFrequency).toHaveBeenCalledTimes(1);
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", IN_A_WEEK, expect.anything());
  });

  it("SMS 'skip' spec: cycle.skipped → unskipNextCycle when the schedule still sits on the skipped-to date", async () => {
    const spec = undoSpecFromEvent({
      type: "cycle.skipped",
      payload: { previousNextBillingDate: TODAY.toISOString(), nextBillingDate: IN_A_WEEK.toISOString(), initiator: "CUSTOMER" },
    });
    expect(spec).toEqual({ kind: "skip", previousNextBillingDate: TODAY.toISOString(), nextBillingDate: IN_A_WEEK.toISOString() });
    const out = await performUndo(SHOP_DOMAIN, undoContract() as never, spec!, { ...OPTS, via: "sms", timing: TIMING9 }, new Date("2026-08-16T10:00:00.000Z"));
    expect(out.kind).toBe("restored");
    expect(mocks.unskipNextCycle).toHaveBeenCalledWith(SHOP_DOMAIN, "ctr_1", expect.anything());
    // Moved on since → stale, nothing unskipped.
    vi.clearAllMocks();
    const stale = await performUndo(SHOP_DOMAIN, undoContract({ nextBillingDate: new Date("2026-10-01T22:00:00.000Z") }) as never, spec!, { ...OPTS, via: "sms", timing: TIMING9 }, new Date("2026-08-16T10:00:00.000Z"));
    expect(stale.kind).toBe("stale");
    expect(mocks.unskipNextCycle).not.toHaveBeenCalled();
  });
});

// ── 7. source pins ───────────────────────────────────────────────────────────

describe("source pins — gates and rows", () => {
  it("undo is in the dispatcher's preparing-blocked set", () => {
    const src = readSource("app/routes/proxy.api.$action.tsx");
    const block = src.slice(src.indexOf("const PREPARING_BLOCKED"), src.indexOf('return back("preparing")'));
    expect(block).toContain('"undo"');
  });

  it("magic links, SMS and the cancel flow enforce the preparing gate", () => {
    const magic = readSource("app/lib/magiclinks/handlers.server.ts");
    expect(magic).toContain("PREPARING_MAGIC_ACTIONS");
    for (const verb of ["SKIP_NEXT", "DELAY_NEXT", "SWAP"]) {
      expect(magic.slice(magic.indexOf("const PREPARING_MAGIC_ACTIONS"), magic.indexOf("function setupGateResult"))).toContain(`"${verb}"`);
    }
    expect(magic).toContain('t(locale, "magic.preparing")');
    const sms = readSource("app/routes/api.sms.inbound.tsx");
    expect(sms).toContain('if (verb === "SKIP" || verb === "DELAY") {\n    const preparing = await isPreparingOrder(');
    expect(sms).toContain('t(locale, "magic.sms.preparing")');
    expect(sms).toContain("await isPreparingOrder(full, timing)"); // UNDO too
    const engine = readSource("app/lib/cancel/engine.server.ts");
    // v1.28.0 (P3.3): DELAY joins the preparing-blocked set (a moved cycle is
    // the cycle being billed too).
    expect(engine).toMatch(/const PREPARING_BLOCKED_SAVES = new Set<SaveKind>\(\[\s*"DELAY",\s*"SKIP",\s*"FREQUENCY",\s*"DOWNSIZE",\s*\]\)/);
    expect(engine).toContain("if (preparing && PREPARING_BLOCKED_SAVES.has(kind)) continue;");
    expect(engine).toContain("if (PREPARING_BLOCKED_SAVES.has(saveKind)) {");
  });

  it("the concession ladder has the downsize row (P2.3) behind cancelFlow.downsizeSaveEnabled, posting the quantity action", () => {
    const src = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(src).toContain("cxs-ladder__fewer");
    expect(src).toContain("cancelFlowSettings.downsizeSaveEnabled");
    // v1.28.0 Stage C follow-up added the smaller-size row after "fewer".
    expect(src).toContain('${delayRow}${slowerRow}${fewerRow}${downsizeRow}${skipRow}');
    expect(src).toContain('["quantity", String(ladder.fewer.quantity)]');
    const en = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    for (const k of ["portal.ladder.fewer_title", "portal.ladder.fewer_sub", "portal.ladder.fewer_cta"]) {
      expect(en[k]).toBeTruthy();
      expect(en[k].toLowerCase()).not.toMatch(/cancel/);
    }
  });

  it("the run-out prompt posts mode=once; the home card renders the discount row; preparing copy is per-verb truthful", () => {
    const index = readSource("app/routes/proxy._index.tsx");
    expect(index).toContain('{ name: "mode", value: "once" }');
    expect(index).toContain("${discountRowHtml}");
    const en = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    expect(en["portal.next.preparing_note"]).toContain("can no longer be skipped, delayed or rescheduled");
    expect(en["portal.next.preparing_note"]).not.toContain("changes apply from your following delivery");
    expect(en["portal.toast.preparing"]).not.toContain("changes apply from your following delivery");
    // Loss-ledger copy no longer asserts an enforcement the code does not have.
    expect(en["cancel.intro.discount_line"]).not.toMatch(/forfeits/);
    expect(en["cancel.intro.locked_price_line"]).not.toMatch(/releases/);
    // Downsize saved copy tells the truth per mode.
    expect(en["cancel.saved.downsize_swapped"]).toContain("{title}");
    expect(readSource("app/routes/proxy.cancel.$id.$step.tsx")).toContain('"cancel.saved.downsize_swapped"');
  });

  it("settings: preparingWindowHours is a registered billing setting with a Settings-page field; the charge-hour help warns about lowering", () => {
    const registry = readSource("app/lib/settings/registry.server.ts");
    expect(registry).toContain("preparingWindowHours: z.number().int().min(1).max(72).default(6)");
    const settings = readSource("app/routes/app.settings.tsx");
    expect(settings).toContain('path: "preparingWindowHours"');
    expect(settings).toMatch(/LOWERING it during the day/);
  });
});
