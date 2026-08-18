import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * v1.28.0 cross-stage audit fixes (money / date truth) — pinning tests.
 *
 *  1. Dunning money parity: the held order's amount for the DunningCase, the
 *     payment_failed_* / parked emails and the portal banner is THE next-order
 *     estimate (grant / parked cycle_discount_applied marker / per-line edits
 *     applied) — the same figure as the hero, the items card and the
 *     reminder — never the mirror's undiscounted plan sum. Plan-sum fallback
 *     only when the estimate itself fails.
 *  2. Home card rows reconcile with the card total: Σ estimate line totals −
 *     discount + delivery === total after a per-line skip / one-order
 *     quantity; the card renders from the estimate's lines (source pin).
 *  3. Cancel intro: "Your next delivery is scheduled for {date}" only for a
 *     healthy ACTIVE contract — never for PAUSED (paused note owns the date)
 *     or a held (open dunning case) contract.
 *  4. Payment section: the "next order on {date}" note names the EFFECTIVE
 *     next charge (resumeAt when PAUSED, none while a case holds the order);
 *     beforeNextOrder follows the same date.
 *  5. Ladder "Skip — next order {date}" uses the estimate's schedule-aware
 *     followingBillingDate (source pin).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const mocks = vi.hoisted(() => ({
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptGroupBy: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  giftGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  giftGrantCount: vi.fn(async (_a?: unknown): Promise<number> => 0),
  discountGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  shopFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => ({ ianaTimezone: "Europe/Zurich" })),
  getActiveDiscountForCycle: vi.fn(async (_id?: string): Promise<unknown> => null),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "lifecycle") {
      return { milestoneGiftCycle: 6, milestoneLadder: [12, 18, 24], rewardsUnlockDay: 90 };
    }
    return {};
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriberEvent: { findMany: mocks.eventFindMany, findFirst: mocks.eventFindFirst },
    billingAttempt: { findFirst: mocks.attemptFindFirst, groupBy: mocks.attemptGroupBy },
    giftGrant: { findMany: mocks.giftGrantFindMany, count: mocks.giftGrantCount },
    discountGrant: { findMany: mocks.discountGrantFindMany },
    subscriptionContract: { findMany: mocks.contractFindMany },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
}));

import { estimateNextCharge } from "~/lib/billing/estimate.server";
import { estimateHeldAmountCents, planSumCents } from "~/lib/dunning/held-amount.server";
import { buildPortalDunningView } from "~/lib/portal/dunning.server";
import { buildRetentionSummary } from "~/lib/cancel/summary.server";
import {
  derivePortalPaymentState,
  effectiveNextChargeDate,
} from "~/lib/portal/payment.server";

const TZ = "Europe/Zurich";
const SHOP = { id: "shop_1", ianaTimezone: TZ };
const NEXT = new Date("2026-09-02T22:00:00.000Z"); // 3 Sep Zurich

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
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    status: "ACTIVE",
    ordersCount: 3,
    nextBillingDate: NEXT,
    resumeAt: null,
    deliveryPriceCents: 0,
    currencyCode: "EUR",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "MONTH",
    billingIntervalCount: 1,
    lines: [line()],
    ...over,
  };
}

// The scenario of the finding: 1×Serum €49.00, grant consumed at pre-charge
// (cycle_discount_applied percent 10, cycle 4), charge FAILED.
const PARKED_MARKER = {
  payload: {
    action: "cycle_discount_applied",
    grantId: "dg",
    percent: 10,
    cycleIndex: 4,
    discountCents: 490,
    cyclesRemaining: 0,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptGroupBy.mockResolvedValue([]);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.giftGrantCount.mockResolvedValue(0);
  mocks.discountGrantFindMany.mockResolvedValue([]);
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. dunning money parity ─────────────────────────────────────────────────

describe("dunning quotes THE estimate's total for the held order", () => {
  it("held discounted cycle: banner / case amount === items-card total (€44.10), not the plan sum (€49.00)", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 4, status: "FAILED" });
    mocks.eventFindFirst.mockResolvedValue(PARKED_MARKER);
    const c = contract();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await estimateNextCharge(SHOP, c as any, { includeScheduledGifts: false });
    expect(est.totalCents).toBe(4410); // the items card / hero / reminder figure
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const held = await estimateHeldAmountCents(SHOP, c as any);
    expect(held).toBe(4410);
    expect(held).not.toBe(planSumCents(c));
    // The banner view: the caller's estimate total wins over the case's frozen
    // (possibly pre-fix, undiscounted) figure and the plan-sum fallback.
    const view = buildPortalDunningView({
      kase: {
        id: "case_1",
        contractId: "cm_1",
        openedAt: new Date("2026-09-02T23:00:00.000Z"),
        state: "RETRYING",
        triggerAttemptId: null,
        declineCode: "INSUFFICIENT_FUNDS",
        declineCategory: "SOFT",
        nextRetryAt: null,
        resolvedAt: null,
        amountAtRiskCents: 4900,
        amountAtRiskCurrencyCode: "EUR",
        customerRetryAt: null,
      } as never,
      contract: {
        id: "cm_1",
        status: "ACTIVE",
        paymentMethodId: "pm_1",
        backupPaymentMethodId: null,
        paymentMethodRevokedAt: null,
        currencyCode: "EUR",
        deliveryPriceCents: 0,
        lines: [{ currentPriceCents: 4900, quantity: 1 }],
      } as never,
      attempts: [],
      heldOrderTotalCents: est.totalCents,
    });
    expect(view.amountCents).toBe(4410);
    expect(view.currencyCode).toBe("EUR");
  });

  it("per-line 'not this time' on a 2-line box: the held amount is the reduced one", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 4, status: "FAILED" });
    const c = contract({
      lines: [
        line({ quantity: 2, currentPriceCents: 2000, skippedCycleIndex: 4 }),
        line({ variantId: "gid://shopify/ProductVariant/2", title: "Cream", currentPriceCents: 2000 }),
      ],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateHeldAmountCents(SHOP, c as any)).toBe(2000);
    expect(planSumCents(c)).toBe(6000);
  });

  it("no lines → null; estimate failure → plan-sum fallback (contained, never throws)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateHeldAmountCents(SHOP, contract({ lines: [] }) as any)).toBeNull();
    // Force the estimate to blow up (a line whose per-cycle field read throws
    // — the estimate's line loop is not guarded); the plan sum still answers.
    const poison = Object.defineProperty(line({ currentPriceCents: 4900 }), "isOneTimeAddon", {
      get() {
        throw new Error("boom");
      },
    });
    const c = contract({ deliveryPriceCents: 500, lines: [poison] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await estimateHeldAmountCents(SHOP, c as any)).toBe(5400);
  });

  it("source pins: case-open, failure vars, exhausted notice, parked email and the detail banner all read the shared helper", () => {
    const engine = readSource("app/lib/dunning/engine.server.ts");
    expect(engine).toContain('from "./held-amount.server"');
    expect(engine).toMatch(/const amountAtRiskCents = await estimateHeldAmountCents\(/);
    expect(engine).toMatch(/async function failureVars\(/);
    expect(engine).toMatch(/attempt\.amountCents \?\? \(await estimateContractAmountCents\(contract\)\)/);
    expect(engine).not.toMatch(/line\.currentPriceCents \* line\.quantity/);
    const parked = readSource("app/lib/dunning/post-exhaustion.server.ts");
    expect(parked).toContain("estimateHeldAmountCents(");
    expect(parked).toMatch(/const amountCents = await estimateAmountCents\(kase, contract\)/);
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(detail).toMatch(/loadPortalDunning\(contract, \{\s*heldOrderTotalCents: estimate\.totalCents,\s*\}\)/);
  });
});

// ── 2. home card rows reconcile with the total ──────────────────────────────

describe("home card rows come from the estimate and add up to its total", () => {
  const upcoming = 4;
  const twoLineBox = () =>
    contract({
      lines: [
        line({ quantity: 2, currentPriceCents: 2000 }),
        line({ variantId: "gid://shopify/ProductVariant/2", title: "Cream", currentPriceCents: 2000 }),
      ],
      deliveryPriceCents: 300,
    });
  const reconcile = (est: Awaited<ReturnType<typeof estimateNextCharge>>) =>
    est.lines.reduce((s, l) => s + l.lineTotalCents, 0) - est.discountCents + (est.deliveryCents ?? 0);

  it("line_skip: skipped row bills 0, is flagged, and Σ rows − discount + delivery === total", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: upcoming, status: "SUCCESS" });
    const c = twoLineBox();
    (c.lines[0] as Record<string, unknown>).skippedCycleIndex = upcoming + 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await estimateNextCharge(SHOP, c as any, { includeScheduledGifts: false });
    expect(est.lines[0].skippedThisCycle).toBe(true);
    expect(est.lines[0].lineTotalCents).toBe(0);
    expect(est.lines[0].quantity).toBe(2); // plan quantity kept for display
    expect(est.totalCents).toBe(2300);
    expect(reconcile(est)).toBe(est.totalCents);
  });

  it("line_qty_once: row shows the billed quantity with planQuantity, and reconciles", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: upcoming, status: "SUCCESS" });
    const c = twoLineBox();
    Object.assign(c.lines[0] as Record<string, unknown>, {
      cycleQuantityOverride: 1,
      cycleQuantityOverrideIndex: upcoming + 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const est = await estimateNextCharge(SHOP, c as any, { includeScheduledGifts: false });
    expect(est.lines[0].quantity).toBe(1);
    expect(est.lines[0].planQuantity).toBe(2);
    expect(est.lines[0].lineTotalCents).toBe(2000);
    expect(est.totalCents).toBe(4300);
    expect(reconcile(est)).toBe(est.totalCents);
  });

  it("source pin: the home card renders estimate.lines (lineTotalCents, not-this-time / usually-N meta)", () => {
    const home = readSource("app/routes/proxy._index.tsx");
    const fn = home.slice(home.indexOf("function itemsHtml("), home.indexOf("function contractCardHtml("));
    expect(fn).toContain("estimate.lines");
    expect(fn).toContain("line.lineTotalCents");
    expect(fn).toContain("line.skippedThisCycle");
    expect(fn).toContain('"portal.next.not_this_time"');
    expect(fn).toContain('"portal.next.qty_once"');
    expect(fn).not.toContain("line.currentPriceCents * line.quantity");
    expect(home).toContain("${itemsHtml(contract, locale, params.estimate)}");
  });
});

// ── 3. cancel intro next-delivery line ──────────────────────────────────────

describe("cancel intro: 'next delivery scheduled for' only for a healthy ACTIVE contract", () => {
  const shop = { id: "shop_1", domain: "x.myshopify.com", ianaTimezone: TZ } as never;
  const summaryContract = (over: Record<string, unknown> = {}) =>
    ({
      ...contract(),
      shopId: "shop_1",
      grandfatheredPricing: false,
      firstChargeAt: new Date(Date.now() - 100 * 86_400_000),
      createdAt: new Date(Date.now() - 101 * 86_400_000),
      lines: [{ id: "l1", quantity: 1, currentPriceCents: 4900, compareAtPriceCents: null, isGift: false, isOneTimeAddon: false }],
      ...over,
    }) as never;

  it("ACTIVE without a case → the date; PAUSED → null (the paused note owns the date)", async () => {
    expect((await buildRetentionSummary(shop, summaryContract())).nextBillingDate).toEqual(NEXT);
    const paused = await buildRetentionSummary(
      shop,
      summaryContract({ status: "PAUSED", resumeAt: new Date("2026-09-20T00:00:00Z") }),
    );
    expect(paused.nextBillingDate).toBeNull();
    expect((await buildRetentionSummary(shop, summaryContract({ status: "FAILED" }))).nextBillingDate).toBeNull();
  });

  it("ACTIVE with an open dunning case → null (the order is held); a failed case read keeps the date", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    expect((await buildRetentionSummary(shop, summaryContract())).nextBillingDate).toBeNull();
    mocks.dunningCaseFindFirst.mockRejectedValue(new Error("db down"));
    expect((await buildRetentionSummary(shop, summaryContract())).nextBillingDate).toEqual(NEXT);
  });
});

// ── 4. payment section effective date ───────────────────────────────────────

describe("payment notes name the effective next charge", () => {
  const RESUME = new Date("2026-09-19T22:00:00.000Z"); // 20 Sep
  const NOW = new Date("2026-08-25T10:00:00.000Z");
  const card = (over: Record<string, unknown> = {}) => ({
    paymentMethodId: "pm_1",
    backupPaymentMethodId: null,
    paymentMethodRevokedAt: null,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 8,
    cardExpiryYear: 2026,
    nextBillingDate: new Date("2026-08-19T22:00:00.000Z"), // stale, past
    status: "ACTIVE",
    resumeAt: null,
    ...over,
  });

  it("effectiveNextChargeDate: PAUSED → resumeAt; open case → null; else nextBillingDate", () => {
    expect(effectiveNextChargeDate(card({ status: "PAUSED", resumeAt: RESUME }))).toEqual(RESUME);
    expect(effectiveNextChargeDate(card({ status: "PAUSED", resumeAt: null }))).toBeNull();
    expect(effectiveNextChargeDate(card(), true)).toBeNull();
    expect(effectiveNextChargeDate(card(), false)).toEqual(card().nextBillingDate);
  });

  it("PAUSED + expired card: the view's date is resumeAt, never the stale nextBillingDate", () => {
    const view = derivePortalPaymentState(card({ status: "PAUSED", resumeAt: RESUME }), {
      now: NOW,
      preExpiryNoticeDays: 14,
      tz: TZ,
    });
    expect(view.state).toBe("EXPIRING");
    expect(view.nextChargeDate).toEqual(RESUME);
    // Card dead 1 Sep, resumed charge 20 Sep → "before your next order" is true
    // even though the stale nextBillingDate (20 Aug) precedes the expiry.
    expect(view.beforeNextOrder).toBe(true);
  });

  it("PAUSED, card expires before resumeAt but outside the notice window → EXPIRING (the resumed charge will fail)", () => {
    const view = derivePortalPaymentState(
      card({ status: "PAUSED", resumeAt: new Date("2026-12-01T00:00:00Z"), cardExpiryMonth: 10, cardExpiryYear: 2026, nextBillingDate: new Date("2026-08-19T22:00:00.000Z") }),
      { now: NOW, preExpiryNoticeDays: 14, tz: TZ },
    );
    expect(view.state).toBe("EXPIRING");
    expect(view.beforeNextOrder).toBe(true);
  });

  it("held order (open case): no date for the note; the state no longer keys on the held date", () => {
    const view = derivePortalPaymentState(card({ nextBillingDate: new Date("2026-10-01T00:00:00Z"), cardExpiryMonth: 9 }), {
      now: NOW,
      preExpiryNoticeDays: 3,
      tz: TZ,
      hasOpenCase: true,
    });
    expect(view.nextChargeDate).toBeNull();
    expect(view.beforeNextOrder).toBe(false);
    expect(view.state).toBe("OK");
  });

  it("source pins: paymentHtml formats payment.nextChargeDate; the detail page re-derives the view with hasOpenCase", () => {
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(detail).toMatch(/const nextDate = payment\.nextChargeDate\s*\?\s*formatShopDate\(payment\.nextChargeDate/);
    expect(detail).toMatch(/derivePortalPaymentState\(contract, \{[^}]*hasOpenCase,\s*\}\)/);
  });
});

// ── 5. ladder skip date ─────────────────────────────────────────────────────

describe("ladder 'Skip — next order {date}' is the estimate's following date", () => {
  it("source pin: estimate.followingBillingDate first, interval step only as fallback", () => {
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    const idx = detail.indexOf("const skipConsequenceDate =");
    expect(idx).toBeGreaterThan(0);
    const block = detail.slice(idx, idx + 600);
    expect(block).toMatch(/estimate\.followingBillingDate \?\?\s*addIntervalTz\(/);
  });
});
