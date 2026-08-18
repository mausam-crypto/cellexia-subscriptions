import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `estimateNextCharge` (v1.28.0, P2.4) — the ONE next-order estimate.
 *
 * Pinned:
 *  - the money is the upcoming-order reminder's pre-v1.28 arithmetic, byte
 *    for byte: Σ non-gift lines × qty, the live grant percent applied to the
 *    AGGREGATE (applyDiscountPct), plus delivery — with `discountCents`,
 *    `discountPercent`, `discountCyclesRemaining` and the localized label
 *    ("10% off — 2 discounted orders left" / "… 1 discounted order left");
 *  - line kinds: recurring, one_time_addon (billed this cycle, in the
 *    subtotal), gift (attached isGift mirror — free), scheduled_gift (a
 *    SCHEDULED GiftGrant the engine has committed to but not yet attached —
 *    free, titled from the rule / the producer's gift_scheduled event /
 *    generic); a SCHEDULED grant on a LATER cycle than the upcoming one is
 *    NOT a next-order row; an ADDED grant's variant is not listed twice;
 *  - followingBillingDate = nextBillingDate + one interval (shop tz);
 *  - card label / address summary; contained reads (a broken gift read
 *    drops the gift rows, never the money);
 *  - PARITY: the REAL runUpcomingOrderReminders (its own scaffold, see
 *    tests/billing-reminders-skip-dedupe.test.ts) now routes through the
 *    estimate and sends the SAME total_estimate_cents the old inline formula
 *    produced for the same fixtures, with the same items_summary shape, plus
 *    the new edit-cutoff / following-date vars.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
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
    subscriberEvent: { findMany: mocks.eventFindMany },
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
  addressSummaryOf,
  discountLabelFor,
  estimateNextCharge,
} from "~/lib/billing/estimate.server";
import { runUpcomingOrderReminders } from "~/lib/billing/reminders.server";
import { applyDiscountPct, discountAmount } from "~/lib/money";
import { addIntervalTz } from "~/lib/dates.server";

const TZ = "Europe/London";
const SHOP = { id: "shop_1", ianaTimezone: TZ };
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
    ...over,
  };
}

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
    cardExpiryMonth: 12,
    cardExpiryYear: 2028,
    deliveryAddress: {
      address1: "12 High St",
      city: "London",
      zip: "W1A 1AA",
      countryCode: "GB",
    },
    lines: [line()],
    ...over,
  };
}

/**
 * The SWEEP's arithmetic (applyGrantToCycle) — the parity oracle: the grant
 * percent is applied per unit price and multiplied by the quantity, which is
 * what Shopify bills. (Pre-review this oracle was the aggregate rounding the
 * old reminder used; the two differ by a cent on half-cent cases.)
 */
function legacyTotal(contract: Row, pct: number | null): number {
  const lines = contract.lines as Array<{
    isGift: boolean;
    currentPriceCents: number;
    quantity: number;
  }>;
  const billable = lines.filter((l) => !l.isGift);
  const subtotal = billable.reduce((s, l) => s + l.currentPriceCents * l.quantity, 0);
  const discount = pct
    ? billable.reduce((s, l) => s + discountAmount(l.currentPriceCents, pct) * l.quantity, 0)
    : 0;
  return subtotal - discount + (contract.deliveryPriceCents as number);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const est = (c: Row, opts?: Row) => estimateNextCharge(SHOP, c as any, opts as any);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("money — the reminder's arithmetic", () => {
  it("no grant: subtotal = Σ non-gift lines, discount 0, total = subtotal + delivery", async () => {
    const c = contractFixture({
      deliveryPriceCents: 495,
      lines: [
        line(),
        line({ variantId: "gid://shopify/ProductVariant/2", title: "Night Cream", quantity: 2, currentPriceCents: 3550 }),
        line({ variantId: "gid://shopify/ProductVariant/9", title: "Travel Kit", isGift: true, currentPriceCents: 0 }),
      ],
    });
    const e = await est(c);
    expect(e.subtotalCents).toBe(4900 + 2 * 3550);
    expect(e.discountCents).toBe(0);
    expect(e.discountPercent).toBeNull();
    expect(e.discountLabel).toBeNull();
    expect(e.deliveryCents).toBe(495);
    expect(e.totalCents).toBe(legacyTotal(c, null));
    expect(e.currency).toBe("GBP");
  });

  it("live grant: percent applied PER UNIT × quantity (the sweep's arithmetic), label with cycles left", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({
      id: "dg_1",
      percent: 10,
      cyclesRemaining: 2,
    });
    const c = contractFixture({
      deliveryPriceCents: 300,
      lines: [line({ currentPriceCents: 3333 }), line({ variantId: "v2", currentPriceCents: 1111, quantity: 3 })],
    });
    const e = await est(c);
    const subtotal = 3333 + 3 * 1111; // 6666
    expect(e.subtotalCents).toBe(subtotal);
    // per unit: 333 + 3 × 111 = 666 (the aggregate rounding would give 667)
    expect(e.discountCents).toBe(discountAmount(3333, 10) + 3 * discountAmount(1111, 10));
    expect(e.discountCents).toBe(666);
    expect(e.totalCents).toBe(subtotal - 666 + 300);
    expect(e.totalCents).toBe(legacyTotal(c, 10));
    expect(subtotal - applyDiscountPct(subtotal, 10)).toBe(667); // the old aggregate form
    expect(e.discountPercent).toBe(10);
    expect(e.discountCyclesRemaining).toBe(2);
    expect(e.discountLabel).toBe("10% off — 2 discounted orders left");
    expect(discountLabelFor("en", 15, 1)).toBe("15% off — 1 discounted order left");
    // Undiscounted line totals stay plan prices (the discount is a separate row).
    expect(e.lines.map((l) => l.lineTotalCents)).toEqual([3333, 3333]);
  });

  it("a pre-resolved grant is used as-is (no read); `null` means known none", async () => {
    const c = contractFixture();
    const e = await est(c, { grant: { id: "dg", percent: 20, cyclesRemaining: 4 } });
    expect(mocks.getActiveDiscountForCycle).not.toHaveBeenCalled();
    expect(e.totalCents).toBe(applyDiscountPct(4900, 20));
    const e2 = await est(c, { grant: null });
    expect(e2.totalCents).toBe(4900);
  });

  it("gift lines never change the money; a broken grant read means plan pricing (contained)", async () => {
    mocks.getActiveDiscountForCycle.mockRejectedValue(new Error("db down"));
    const c = contractFixture({
      lines: [line(), line({ variantId: "g", isGift: true, currentPriceCents: 0 })],
    });
    const e = await est(c);
    expect(e.totalCents).toBe(4900);
    expect(e.discountPercent).toBeNull();
  });
});

describe("lines — kinds, add-ons, gifts", () => {
  it("recurring / one_time_addon / gift kinds from the mirror; add-ons are billed (in the subtotal)", async () => {
    const c = contractFixture({
      lines: [
        line(),
        line({ variantId: "a1", title: "Eye Contour", isOneTimeAddon: true, addonCycleIndex: 6, currentPriceCents: 4200 }),
        line({ variantId: "g1", title: "Travel Kit", variantTitle: "Default Title", isGift: true, currentPriceCents: 0 }),
      ],
    });
    const e = await est(c);
    expect(e.lines.map((l) => [l.kind, l.free, l.lineTotalCents, l.skippedThisCycle])).toEqual([
      ["recurring", false, 4900, false],
      ["one_time_addon", false, 4200, false],
      ["gift", true, 0, false],
    ]);
    expect(e.subtotalCents).toBe(4900 + 4200);
    // Shopify's placeholder variant title is hidden.
    expect(e.lines[2].variantTitle).toBeNull();
  });

  it("SCHEDULED grants for the upcoming cycle become scheduled_gift rows; later-cycle grants and already-attached variants do not", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([
      // Committed save-flow gift on the next cycle (ordersCount 5 → cycle 6):
      { id: "gg_save", cycleIndex: 6, status: "SCHEDULED", variantId: "gid://v/save", rule: null },
      // Win-back perk stranded on an earlier index — the engine re-anchors it:
      { id: "gg_wb", cycleIndex: 4, status: "SCHEDULED", variantId: "gid://v/wb", rule: { name: "Win-back", variantTitle: "Lip Balm" } },
      // Admin gift placed on a LATER cycle — not next order:
      { id: "gg_later", cycleIndex: 9, status: "SCHEDULED", variantId: "gid://v/later", rule: null },
      // Already ADDED (mirror line exists) — must not duplicate:
      { id: "gg_added", cycleIndex: 6, status: "ADDED", variantId: "gid://v/added", rule: { name: "Milestone", variantTitle: "Travel Kit" } },
    ]);
    mocks.eventFindMany.mockResolvedValue([
      { payload: { grantId: "gg_save", variantTitle: "Hydra Mask" } },
    ]);
    const c = contractFixture({
      lines: [line(), line({ variantId: "gid://v/added", title: "Travel Kit", isGift: true, currentPriceCents: 0 })],
    });
    const e = await est(c);
    const scheduled = e.lines.filter((l) => l.kind === "scheduled_gift");
    expect(scheduled.map((l) => [l.title, l.variantId, l.free, l.lineTotalCents])).toEqual([
      ["Hydra Mask", "gid://v/save", true, 0],
      ["Lip Balm", "gid://v/wb", true, 0],
    ]);
    expect(e.lines.filter((l) => l.variantId === "gid://v/added")).toHaveLength(1);
    expect(e.lines.some((l) => l.variantId === "gid://v/later")).toBe(false);
    // Free rows never touch the money.
    expect(e.totalCents).toBe(4900);
  });

  it("the upcoming-cycle hint follows staged add-ons / ADDED grants past ordersCount + 1 (skips shift the cycle index)", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([
      { id: "gg_1", cycleIndex: 8, status: "SCHEDULED", variantId: "gid://v/x", rule: null },
    ]);
    const c = contractFixture({
      ordersCount: 5,
      lines: [line(), line({ variantId: "a1", isOneTimeAddon: true, addonCycleIndex: 8, currentPriceCents: 1000 })],
    });
    const e = await est(c);
    expect(e.lines.some((l) => l.kind === "scheduled_gift" && l.variantId === "gid://v/x")).toBe(true);
    // Generic title when neither rule nor event names it.
    expect(e.lines.find((l) => l.kind === "scheduled_gift")?.title).toBe("Free gift");
  });

  it("includeScheduledGifts:false skips the read; a broken gift read drops the rows, never the money", async () => {
    const c = contractFixture();
    await est(c, { includeScheduledGifts: false });
    expect(mocks.giftGrantFindMany).not.toHaveBeenCalled();
    mocks.giftGrantFindMany.mockRejectedValue(new Error("db down"));
    const e = await est(c);
    expect(e.lines).toHaveLength(1);
    expect(e.totalCents).toBe(4900);
  });
});

describe("dates, card, address", () => {
  it("followingBillingDate is one billing interval after nextBillingDate (shop tz); null without a next date", async () => {
    const e = await est(contractFixture());
    expect(e.nextBillingDate).toEqual(CHARGE);
    expect(e.followingBillingDate?.toISOString()).toBe(
      addIntervalTz(CHARGE, "WEEK", 4, TZ).toISOString(),
    );
    const monthly = await est(
      contractFixture({ billingIntervalUnit: "MONTH", billingIntervalCount: 1, nextBillingDate: new Date("2026-01-31T09:00:00.000Z") }),
    );
    expect(monthly.followingBillingDate?.toISOString()).toBe(
      addIntervalTz(new Date("2026-01-31T09:00:00.000Z"), "MONTH", 1, TZ).toISOString(),
    );
    const none = await est(contractFixture({ nextBillingDate: null }));
    expect(none.followingBillingDate).toBeNull();
  });

  it("card label from the mirror ('' when revoked) and a one-line address summary", async () => {
    const e = await est(contractFixture());
    expect(e.cardLabel).toBe("Visa ····4242");
    expect(e.addressSummary).toBe("12 High St, London W1A 1AA, GB");
    const revoked = await est(contractFixture({ paymentMethodRevokedAt: NOW }));
    expect(revoked.cardLabel).toBe("");
    expect(addressSummaryOf(null)).toBeNull();
    expect(addressSummaryOf({})).toBeNull();
    expect(addressSummaryOf({ address1: " 1 Rue X ", city: "Genève", zip: "1201", countryCode: "CH" })).toBe(
      "1 Rue X, Genève 1201, CH",
    );
  });

  it("shopId form loads the timezone (and falls back to UTC on failure)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = await estimateNextCharge("shop_1", contractFixture() as any);
    expect(mocks.shopFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "shop_1" } }),
    );
    expect(e.followingBillingDate?.toISOString()).toBe(
      addIntervalTz(CHARGE, "WEEK", 4, TZ).toISOString(),
    );
    mocks.shopFindUnique.mockRejectedValueOnce(new Error("db down"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e2 = await estimateNextCharge("shop_1", contractFixture() as any);
    expect(e2.totalCents).toBe(4900);
  });
});

describe("PARITY — the real reminder sends the estimate's numbers", () => {
  function sentVars(): Row {
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    return (mocks.sendNotification.mock.calls[0][0] as { vars: Row }).vars;
  }

  it("no grant: total_estimate_cents equals the legacy inline formula; items_summary keeps its shape", async () => {
    const c = contractFixture({
      deliveryPriceCents: 495,
      lines: [line(), line({ variantId: "v2", title: "Night Cream", variantTitle: "50 ml", quantity: 2, currentPriceCents: 3550 })],
    });
    mocks.contractFindMany.mockResolvedValue([c]);
    await runUpcomingOrderReminders(NOW);
    const vars = sentVars();
    expect(vars.total_estimate_cents).toBe(legacyTotal(c, null));
    expect(vars.total_estimate).toBe("£124.95");
    expect(vars.items_summary).toBe("Cellexia Renewal Serum × 1, Night Cream (50 ml) × 2");
    expect(vars.item_count).toBe(2);
    expect(vars.discount_percent).toBeUndefined();
  });

  it("with a grant: the discounted total, discount_percent, gift '(free)' rows and the cut-off / following-date vars", async () => {
    mocks.getActiveDiscountForCycle.mockResolvedValue({ id: "dg", percent: 10, cyclesRemaining: 3 });
    mocks.giftGrantFindMany.mockResolvedValue([
      { id: "gg", cycleIndex: 6, status: "SCHEDULED", variantId: "gid://v/gift", rule: { name: "Save gift", variantTitle: "Hydra Mask" } },
    ]);
    const c = contractFixture({
      deliveryPriceCents: 300,
      lines: [line({ currentPriceCents: 3333 }), line({ variantId: "v2", title: "Night Cream", currentPriceCents: 1111, quantity: 3 })],
    });
    mocks.contractFindMany.mockResolvedValue([c]);
    await runUpcomingOrderReminders(NOW);
    const vars = sentVars();
    expect(vars.total_estimate_cents).toBe(legacyTotal(c, 10));
    expect(vars.discount_percent).toBe(10);
    expect(vars.items_summary).toBe(
      "Cellexia Renewal Serum × 1, Night Cream × 3, Hydra Mask × 1 (free)",
    );
    expect(vars.item_count).toBe(3);
    // Cut-off = shop midnight of Aug 19 (London, BST) + 6h = 05:00Z.
    expect(vars.edit_cutoff_iso).toBe("2026-08-19T05:00:00.000Z");
    expect(vars.edit_cutoff).toBe("August 19, 2026, 6:00 AM");
    expect(vars.edit_cutoff_line).toBe("You can make changes until August 19, 2026, 6:00 AM.");
    expect(vars.following_date_iso).toBe(addIntervalTz(CHARGE, "WEEK", 4, TZ).toISOString());
    // The subject no longer claims the order SHIPS on the charge date.
    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "billing");
  });
});
