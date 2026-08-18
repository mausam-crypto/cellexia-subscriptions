import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-cycle line edits in the next-order estimate (v1.28.0 Stage D
 * foundation, migration 0028).
 *
 * Pinned:
 *  - `nextCycleIndex`: ordersCount + 1, pushed up by the newest attempt
 *    (+1 on SUCCESS, same index on FAILED / PENDING), by staged add-on
 *    indexes and by per-line skip / override indexes; a broken attempt read
 *    degrades to the local joins (contained);
 *  - a line whose `skippedCycleIndex` === upcoming index is
 *    `skippedThisCycle: true`, keeps its plan quantity for display and bills
 *    0 (subtotal, grant discount and total all exclude it); a stale skip
 *    (index below the upcoming one) is ignored;
 *  - a line whose `cycleQuantityOverrideIndex` === upcoming index bills
 *    `cycleQuantityOverride` units (`quantity` = billed, `planQuantity` =
 *    the recurring one) — subtotal / discount follow; a stale override is
 *    ignored; an override equal to the plan quantity is a no-op;
 *  - gift lines are never skipped / overridden;
 *  - the REAL upcoming-order reminder omits skipped lines from
 *    items_summary / item_count and quotes the reduced total — the estimate
 *    is the reminder's only source of truth;
 *  - `clearStaleCycleOverrides` nulls skips / overrides BELOW the current
 *    index only, and is contained (a failed write reports ok:false).
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractLineUpdateMany: vi.fn(async (_a?: unknown): Promise<unknown> => ({ count: 0 })),
  shopFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => ({
    ianaTimezone: "Europe/London",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return {
        channels: { email: true, sms: true },
        upcomingOrderDaysBefore: 3,
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
      };
    }
    if (key === "portal") return { allowAddProducts: false };
    if (key === "billing") return { chargeHourLocal: 6 };
    return {};
  }),
  getActiveDiscountForCycle: vi.fn(async (_id?: string): Promise<unknown> => null),
  sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({
    status: "SENT",
    klaviyoEnqueued: true,
    directEmailSent: false,
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    giftGrant: { findMany: mocks.giftGrantFindMany },
    subscriberEvent: { findMany: mocks.eventFindMany, findFirst: mocks.eventFindFirst },
    billingAttempt: { findFirst: mocks.attemptFindFirst },
    contractLine: { updateMany: mocks.contractLineUpdateMany },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  discountedCents: (cents: number, _pct: number) => cents,
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(
    async (): Promise<Map<string, number>> => new Map(),
  ),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));

import {
  clearStaleCycleOverrides,
  estimateNextCharge,
  nextCycleIndex,
} from "~/lib/billing/estimate.server";
import { runUpcomingOrderReminders } from "~/lib/billing/reminders.server";
import { discountAmount } from "~/lib/money";

const SHOP = { id: "shop_1", ianaTimezone: "Europe/London" };
const NOW = new Date("2026-08-17T09:00:00.000Z");
const CHARGE = new Date("2026-08-19T09:00:00.000Z");

function line(over: Row = {}): Row {
  return {
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    title: "Cellexia Renewal Serum",
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

/** ordersCount 5 → upcoming index 6 (no attempts / staged indexes). */
function contractFixture(over: Row = {}): Row {
  return {
    id: "cm_c1",
    shopId: "shop_1",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    ordersCount: 5,
    nextBillingDate: CHARGE,
    deliveryPriceCents: 0,
    currencyCode: "GBP",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    paymentInstrumentType: "CREDIT_CARD",
    cardBrand: "visa",
    cardLast4: "4242",
    deliveryAddress: null,
    lines: [line()],
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const est = (c: Row, opts?: Row) => estimateNextCharge(SHOP, c as any, opts as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const idx = (c: Row) => nextCycleIndex(c as any);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.contractLineUpdateMany.mockResolvedValue({ count: 0 });
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("nextCycleIndex — the upcoming Shopify cycle, from local evidence", () => {
  it("ordersCount + 1 when nothing else is known", async () => {
    expect(await idx(contractFixture())).toBe(6);
  });

  it("the newest attempt owns its cycle: SUCCESS → +1, FAILED / PENDING → same index", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 8, status: "SUCCESS" });
    expect(await idx(contractFixture())).toBe(9);
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 8, status: "FAILED" });
    expect(await idx(contractFixture())).toBe(8);
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 8, status: "PENDING" });
    expect(await idx(contractFixture())).toBe(8);
    // Never moves the hint DOWN.
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 2, status: "SUCCESS" });
    expect(await idx(contractFixture())).toBe(6);
    // Superseded rows are excluded from the read.
    const where = (mocks.attemptFindFirst.mock.calls[0][0] as { where: Row }).where;
    expect(where).toMatchObject({ contractId: "cm_c1", supersededAt: null });
  });

  it("staged add-on / skip / override indexes push the hint up (a resolved cycle beats the counter); stale ones do not", async () => {
    expect(
      await idx(contractFixture({ lines: [line({ isOneTimeAddon: true, addonCycleIndex: 7 })] })),
    ).toBe(7);
    expect(await idx(contractFixture({ lines: [line({ skippedCycleIndex: 9 })] }))).toBe(9);
    expect(
      await idx(contractFixture({ lines: [line({ cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 8 })] })),
    ).toBe(8);
    expect(await idx(contractFixture({ lines: [line({ skippedCycleIndex: 3 })] }))).toBe(6);
  });

  it("a broken attempt read degrades to the local joins (contained)", async () => {
    mocks.attemptFindFirst.mockRejectedValue(new Error("db down"));
    expect(await idx(contractFixture({ lines: [line({ skippedCycleIndex: 7 })] }))).toBe(7);
  });
});

describe("per-line skip in the estimate", () => {
  it("skippedCycleIndex === upcoming → skippedThisCycle, plan quantity kept, bills 0", async () => {
    const c = contractFixture({
      deliveryPriceCents: 300,
      lines: [
        line({ quantity: 2, skippedCycleIndex: 6 }),
        line({ variantId: "v2", title: "Night Cream", currentPriceCents: 3550 }),
      ],
    });
    const e = await est(c);
    expect(e.lines[0]).toMatchObject({
      skippedThisCycle: true,
      quantity: 2,
      unitPriceCents: 4900,
      lineTotalCents: 0,
      kind: "recurring",
    });
    expect(e.lines[0].planQuantity).toBeUndefined();
    expect(e.lines[1].skippedThisCycle).toBe(false);
    expect(e.subtotalCents).toBe(3550);
    expect(e.totalCents).toBe(3550 + 300);
  });

  it("the grant discount excludes the skipped line too (money matches what the cycle will bill)", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({ id: "dg", percent: 10, cyclesRemaining: 2 });
    const c = contractFixture({
      lines: [
        line({ currentPriceCents: 3333, skippedCycleIndex: 6 }),
        line({ variantId: "v2", currentPriceCents: 1111, quantity: 3 }),
      ],
    });
    const e = await est(c);
    expect(e.subtotalCents).toBe(3 * 1111);
    expect(e.discountCents).toBe(3 * discountAmount(1111, 10));
    expect(e.totalCents).toBe(3 * 1111 - 3 * discountAmount(1111, 10));
    expect(e.discountLabel).toBe("10% off — 2 discounted orders left");
  });

  it("a stale skip (index below the upcoming one) is ignored; a skip on the attempt-derived index applies", async () => {
    const stale = await est(contractFixture({ lines: [line({ skippedCycleIndex: 4 })] }));
    expect(stale.lines[0].skippedThisCycle).toBe(false);
    expect(stale.totalCents).toBe(4900);

    // Failed cycle 8 owns the upcoming charge (dunning retry): a skip on 8 applies.
    mocks.attemptFindFirst.mockResolvedValue({ cycleIndex: 8, status: "FAILED" });
    const live = await est(contractFixture({ lines: [line({ skippedCycleIndex: 8 })] }));
    expect(live.lines[0].skippedThisCycle).toBe(true);
    expect(live.totalCents).toBe(0);
  });

  it("gift lines are never skipped or overridden (they are the engine's, and free anyway)", async () => {
    const c = contractFixture({
      lines: [
        line(),
        line({ variantId: "g", isGift: true, currentPriceCents: 0, skippedCycleIndex: 6, cycleQuantityOverride: 3, cycleQuantityOverrideIndex: 6 }),
      ],
    });
    const e = await est(c);
    expect(e.lines[1]).toMatchObject({ kind: "gift", free: true, skippedThisCycle: false, quantity: 1, lineTotalCents: 0 });
    expect(e.totalCents).toBe(4900);
  });
});

describe("one-cycle quantity override in the estimate", () => {
  it("cycleQuantityOverrideIndex === upcoming → bills the override; quantity = billed, planQuantity = plan", async () => {
    const c = contractFixture({
      lines: [line({ quantity: 3, cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 6 })],
    });
    const e = await est(c);
    expect(e.lines[0]).toMatchObject({
      quantity: 1,
      planQuantity: 3,
      lineTotalCents: 4900,
      skippedThisCycle: false,
    });
    expect(e.subtotalCents).toBe(4900);
    expect(e.totalCents).toBe(4900);
  });

  it("an INCREASE for one cycle bills more; the grant applies per unit × the billed quantity", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({ id: "dg", percent: 20, cyclesRemaining: 1 });
    const c = contractFixture({
      lines: [line({ quantity: 1, currentPriceCents: 3333, cycleQuantityOverride: 2, cycleQuantityOverrideIndex: 6 })],
    });
    const e = await est(c);
    expect(e.lines[0]).toMatchObject({ quantity: 2, planQuantity: 1, lineTotalCents: 6666 });
    expect(e.discountCents).toBe(2 * discountAmount(3333, 20));
    expect(e.totalCents).toBe(6666 - 2 * discountAmount(3333, 20));
  });

  it("stale override ignored; override equal to the plan quantity is a no-op; a skip wins over an override", async () => {
    const stale = await est(contractFixture({ lines: [line({ quantity: 3, cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 5 })] }));
    expect(stale.lines[0]).toMatchObject({ quantity: 3, lineTotalCents: 3 * 4900 });
    expect(stale.lines[0].planQuantity).toBeUndefined();

    const same = await est(contractFixture({ lines: [line({ quantity: 2, cycleQuantityOverride: 2, cycleQuantityOverrideIndex: 6 })] }));
    expect(same.lines[0].planQuantity).toBeUndefined();
    expect(same.totalCents).toBe(2 * 4900);

    const both = await est(contractFixture({ lines: [line({ quantity: 2, skippedCycleIndex: 6, cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 6 })] }));
    expect(both.lines[0]).toMatchObject({ skippedThisCycle: true, quantity: 2, lineTotalCents: 0 });
    expect(both.totalCents).toBe(0);
  });
});

describe("the reminder reflects per-cycle edits automatically", () => {
  function sentVars(): Row {
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    return (mocks.sendNotification.mock.calls[0][0] as { vars: Row }).vars;
  }

  it("skipped line dropped from items_summary / item_count; total is the reduced one", async () => {
    const c = contractFixture({
      deliveryPriceCents: 495,
      lines: [
        line({ skippedCycleIndex: 6 }),
        line({ variantId: "v2", title: "Night Cream", variantTitle: "50 ml", quantity: 2, currentPriceCents: 3550 }),
      ],
    });
    mocks.contractFindMany.mockResolvedValue([c]);
    await runUpcomingOrderReminders(NOW);
    const vars = sentVars();
    expect(vars.items_summary).toBe("Night Cream (50 ml) × 2");
    expect(vars.item_count).toBe(1);
    expect(vars.total_estimate_cents).toBe(2 * 3550 + 495);
    expect(vars.total_estimate).toBe("£75.95");
  });

  it("one-cycle quantity tweak: the reminder lists the billed quantity", async () => {
    const c = contractFixture({
      lines: [line({ quantity: 3, cycleQuantityOverride: 1, cycleQuantityOverrideIndex: 6 })],
    });
    mocks.contractFindMany.mockResolvedValue([c]);
    await runUpcomingOrderReminders(NOW);
    const vars = sentVars();
    expect(vars.items_summary).toBe("Cellexia Renewal Serum × 1");
    expect(vars.item_count).toBe(1);
    expect(vars.total_estimate_cents).toBe(4900);
  });
});

describe("clearStaleCycleOverrides", () => {
  it("nulls skips and overrides BELOW the current index only, both override columns together", async () => {
    mocks.contractLineUpdateMany
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 1 });
    const r = await clearStaleCycleOverrides("cm_c1", 7);
    expect(r).toEqual({ skipsCleared: 2, overridesCleared: 1, ok: true });
    expect(mocks.contractLineUpdateMany).toHaveBeenCalledTimes(2);
    expect(mocks.contractLineUpdateMany.mock.calls[0][0]).toEqual({
      where: { contractId: "cm_c1", skippedCycleIndex: { lt: 7 } },
      data: { skippedCycleIndex: null },
    });
    expect(mocks.contractLineUpdateMany.mock.calls[1][0]).toEqual({
      where: { contractId: "cm_c1", cycleQuantityOverrideIndex: { lt: 7 } },
      data: { cycleQuantityOverride: null, cycleQuantityOverrideIndex: null },
    });
  });

  it("is contained: a failed write is logged and reported, never thrown", async () => {
    mocks.contractLineUpdateMany.mockRejectedValue(new Error("db down"));
    await expect(clearStaleCycleOverrides("cm_c1", 7)).resolves.toEqual({
      skipsCleared: 0,
      overridesCleared: 0,
      ok: false,
    });
  });
});
