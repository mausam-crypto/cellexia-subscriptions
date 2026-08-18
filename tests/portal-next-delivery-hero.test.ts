import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * "Your next delivery" hero (v1.28.0, P2.4 + P2.1) — app/lib/portal/
 * next-delivery.server.ts and its wiring in the detail / home routes.
 *
 * Pinned:
 *  - the hero's total IS the shared estimate's discounted total (money-true:
 *    the reminder's figure), with the discount line + "k discounted orders
 *    left" label, delivery, ships-to, card, "After that";
 *  - lines render as they will bill: add-ons "this order only", gift rows
 *    "(free)", quantity × unit price;
 *  - the cut-off line is editCutoff (charge moment) in shop tz;
 *  - preparing: chip + note, NO cut-off line, NO line-up form; the route
 *    hides schedule / swap / one-tap skip-delay (source pins);
 *  - line-up CTA posts the existing next_date action with the sibling's date
 *    (yyyy-MM-dd shop tz), only inside the next_date bounds;
 *  - stock-out + price-change notices are role=status one-liners;
 *  - preparingByContract batches the attempts read; safeEstimateNextCharge
 *    never throws.
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  getActiveDiscountForCycle: vi.fn(async (_id?: string): Promise<unknown> => null),
  getSetting: vi.fn(async (_s: string, _k: string): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    billingAttempt: { findMany: mocks.attemptFindMany },
    subscriberEvent: {
      findFirst: mocks.eventFindFirst,
      findMany: mocks.eventFindMany,
    },
    giftGrant: { findMany: mocks.giftGrantFindMany },
    shop: { findUnique: vi.fn(async () => ({ ianaTimezone: "Europe/London" })) },
  },
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));

import { estimateNextCharge } from "~/lib/billing/estimate.server";
import {
  cutoffLabel,
  lineUpTarget,
  loadRecentStockoutDelay,
  nextDeliveryHeroHtml,
  outOfStockTitles,
  preparingByContract,
  safeEstimateNextCharge,
} from "~/lib/portal/next-delivery.server";
import en from "../app/lib/i18n/locales/en.json";

const TZ = "Europe/London";
const SHOP = { id: "shop_1", ianaTimezone: TZ };
const NEXT = new Date("2026-08-20T00:00:00.000Z"); // 01:00 BST 20 Aug
const NOW = new Date("2026-08-17T10:00:00.000Z");

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    status: "ACTIVE",
    ordersCount: 2,
    nextBillingDate: NEXT,
    deliveryPriceCents: 300,
    currencyCode: "GBP",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    paymentInstrumentType: "CARD",
    cardBrand: "Visa",
    cardLast4: "4242",
    paymentMethodRevokedAt: null,
    deliveryAddress: { address1: "12 High St", city: "London", zip: "W1A 1AA", countryCode: "GB" },
    lines: [
      {
        id: "l1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Serum",
        variantTitle: "30 ml",
        imageUrl: null,
        quantity: 2,
        currentPriceCents: 2000,
        isGift: false,
        isOneTimeAddon: false,
      },
      {
        id: "l2",
        variantId: "gid://shopify/ProductVariant/2",
        title: "Travel Kit",
        variantTitle: null,
        imageUrl: null,
        quantity: 1,
        currentPriceCents: 1000,
        isGift: false,
        isOneTimeAddon: true,
        addonCycleIndex: 3,
      },
      {
        id: "l3",
        variantId: "gid://shopify/ProductVariant/3",
        title: "Mini Cream",
        variantTitle: null,
        imageUrl: null,
        quantity: 1,
        currentPriceCents: 900,
        isGift: true,
        isOneTimeAddon: false,
      },
    ],
    ...over,
  };
}

const helpers = {
  apiUrl: (action: string) => `/apps/cellexia-subs/api/${action}`,
  hiddenFields: (fields: Array<[string, string]>) =>
    fields.map(([n, v]) => `<input type="hidden" name="${n}" value="${v}">`).join(""),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptFindMany.mockResolvedValue([]);
  mocks.eventFindFirst.mockResolvedValue(null);
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.eventFindMany.mockResolvedValue([]);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
});

describe("nextDeliveryHeroHtml — money-true", () => {
  it("renders the estimate's DISCOUNTED total, the discount label and every line as it will bill", async () => {
    const grant = { percent: 10, cyclesRemaining: 2 } as never;
    const contract = contractFixture();
    const estimate = await estimateNextCharge(SHOP, contract, { grant });
    // Subtotal 2×2000 + 1000 = 5000; 10% off → 4500; + 300 delivery = 4800.
    expect(estimate.totalCents).toBe(4800);

    const html = nextDeliveryHeroHtml({
      locale: "en",
      tz: TZ,
      contract,
      estimate,
      cutoff: new Date("2026-08-19T23:00:00.000Z"),
      preparing: false,
      lineUp: null,
      outOfStockTitles: [],
      stockoutDelay: null,
      priceChange: null,
      chip: { label: "Active", className: "cxs-chip--active" },
      ...helpers,
    });

    expect(html).toContain('class="cxs-price cxs-next__total">£48.00<');
    expect(html).toContain("10% off — 2 discounted orders left");
    expect(html).toContain("−£5.00");
    // Items subtotal + delivery rows.
    expect(html).toContain(">£50.00<");
    expect(html).toContain(">£3.00<");
    // Lines: recurring qty × unit, add-on marker, gift (free).
    expect(html).toContain("2 × £20.00");
    expect(html).toContain("this order only");
    expect(html).toContain("cxs-next__line--one_time_addon");
    expect(html).toContain("cxs-next__line--gift");
    expect(html).toContain("(free)");
    // Ships to / card / after that.
    expect(html).toContain("Ships to 12 High St, London W1A 1AA, GB");
    expect(html).toContain("Charged to");
    expect(html).toContain("4242");
    expect(html).toContain("After that: September 17, 2026");
    // Cut-off line in shop tz (00:00 BST on the billing day).
    expect(html).toContain("You can make changes until August 20, 2026, 12:00 AM.");
    // Title + date.
    expect(html).toContain(en["portal.next.title"]);
    expect(html).toContain('cxs-next__date">August 20, 2026<');
    // Not preparing → no chip / note.
    expect(html).not.toContain("cxs-next__preparing");
    expect(html).not.toContain("cxs-next__lineup");
    // Never a bare vendor .cx- class.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
  });

  it("without a grant there is no discount row and total = plan price + delivery", async () => {
    const contract = contractFixture();
    const estimate = await estimateNextCharge(SHOP, contract, { grant: null });
    const html = nextDeliveryHeroHtml({
      locale: "en", tz: TZ, contract, estimate, cutoff: null, preparing: false,
      lineUp: null, outOfStockTitles: [], stockoutDelay: null, priceChange: null,
      chip: null, ...helpers,
    });
    expect(estimate.totalCents).toBe(5300);
    expect(html).toContain('cxs-next__total">£53.00<');
    expect(html).not.toContain("cxs-next__discount");
    expect(html).not.toContain("discounted order");
  });
});

describe("preparing state", () => {
  it("shows the chip + following-delivery note and hides the cut-off and line-up form", async () => {
    const contract = contractFixture();
    const estimate = await estimateNextCharge(SHOP, contract, { grant: null });
    const html = nextDeliveryHeroHtml({
      locale: "en", tz: TZ, contract, estimate,
      cutoff: new Date("2026-08-19T23:00:00.000Z"),
      preparing: true,
      lineUp: { dateLabel: "25 August 2026", dateValue: "2026-08-25" },
      outOfStockTitles: [], stockoutDelay: null, priceChange: null,
      chip: { label: "Active", className: "cxs-chip--active" }, ...helpers,
    });
    expect(html).toContain("cxs-next__preparing");
    expect(html).toContain(en["portal.next.preparing_chip"]);
    expect(html).toContain(
      "This order is being prepared — it can no longer be skipped, delayed or rescheduled. Your following delivery is on September 17, 2026.",
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain("You can make changes until");
    expect(html).not.toContain("cxs-next__lineup");
    // The preparing chip replaces the status chip.
    expect(html).not.toContain(">Active<");
  });

  it("preparingByContract batches one attempts read and answers per contract", async () => {
    mocks.attemptFindMany.mockResolvedValue([
      {
        contractId: "cm_a",
        status: "PENDING",
        originatingAction: "SCHEDULER",
        startedAt: new Date("2026-08-17T00:05:00.000Z"),
        scheduledFor: new Date("2026-08-17T00:00:00.000Z"),
        supersededAt: null,
      },
    ]);
    const map = await preparingByContract(
      [
        { id: "cm_a", status: "ACTIVE", nextBillingDate: new Date("2026-08-17T00:00:00.000Z") },
        { id: "cm_b", status: "ACTIVE", nextBillingDate: NEXT },
        { id: "cm_c", status: "PAUSED", nextBillingDate: NEXT },
      ],
      { tz: TZ, chargeHourLocal: 0 },
      NOW,
    );
    expect(mocks.attemptFindMany).toHaveBeenCalledTimes(1);
    expect(map.get("cm_a")).toBe(true);
    expect(map.get("cm_b")).toBe(false);
    expect(map.has("cm_c")).toBe(false);
  });

  it("a failed attempts read means not preparing (controls stay)", async () => {
    mocks.attemptFindMany.mockRejectedValue(new Error("db down"));
    const map = await preparingByContract(
      [{ id: "cm_a", status: "ACTIVE", nextBillingDate: NEXT }],
      { tz: TZ, chargeHourLocal: 0 },
      NOW,
    );
    expect(map.get("cm_a")).toBeUndefined();
  });
});

describe("line-up CTA", () => {
  const bounds = {
    tz: TZ,
    locale: "en",
    minDate: new Date("2026-08-18T10:00:00.000Z"),
    maxDate: new Date("2026-11-15T10:00:00.000Z"),
  };

  it("targets the other ACTIVE contract's different next date, as yyyy-MM-dd shop tz", () => {
    const target = lineUpTarget(
      { id: "cm_1", nextBillingDate: NEXT },
      [
        { id: "cm_1", status: "ACTIVE", nextBillingDate: NEXT },
        { id: "cm_2", status: "PAUSED", nextBillingDate: new Date("2026-08-22T00:00:00.000Z") },
        { id: "cm_3", status: "ACTIVE", nextBillingDate: new Date("2026-08-25T00:00:00.000Z") },
      ],
      bounds,
    );
    expect(target).toEqual({ dateLabel: "August 25, 2026", dateValue: "2026-08-25" });
  });

  it("no CTA when the sibling shares the day, or its date is outside the next_date bounds", () => {
    expect(
      lineUpTarget(
        { id: "cm_1", nextBillingDate: NEXT },
        [{ id: "cm_3", status: "ACTIVE", nextBillingDate: new Date("2026-08-20T15:00:00.000Z") }],
        bounds,
      ),
    ).toBeNull();
    expect(
      lineUpTarget(
        { id: "cm_1", nextBillingDate: NEXT },
        [{ id: "cm_3", status: "ACTIVE", nextBillingDate: new Date("2027-01-05T00:00:00.000Z") }],
        bounds,
      ),
    ).toBeNull();
    expect(
      lineUpTarget(
        { id: "cm_1", nextBillingDate: NEXT },
        [{ id: "cm_3", status: "ACTIVE", nextBillingDate: new Date("2026-08-17T00:00:00.000Z") }],
        bounds,
      ),
    ).toBeNull();
  });

  it("renders as a form posting the existing next_date action", async () => {
    const contract = contractFixture();
    const estimate = await estimateNextCharge(SHOP, contract, { grant: null });
    const html = nextDeliveryHeroHtml({
      locale: "en", tz: TZ, contract, estimate, cutoff: null, preparing: false,
      lineUp: { dateLabel: "25 August 2026", dateValue: "2026-08-25" },
      outOfStockTitles: [], stockoutDelay: null, priceChange: null, chip: null, ...helpers,
    });
    expect(html).toContain('action="/apps/cellexia-subs/api/next_date"');
    expect(html).toContain('name="date" value="2026-08-25"');
    expect(html).toContain("Line up with your other delivery (25 August 2026)");
  });
});

describe("notices", () => {
  it("stock-out and price-change lines are role=status one-liners", async () => {
    const contract = contractFixture();
    const estimate = await estimateNextCharge(SHOP, contract, { grant: null });
    const html = nextDeliveryHeroHtml({
      locale: "en", tz: TZ, contract, estimate, cutoff: null, preparing: false,
      lineUp: null,
      outOfStockTitles: ["Serum"],
      stockoutDelay: { title: "Serum" },
      priceChange: {
        batchId: "b1",
        effectiveAt: new Date("2026-09-15T00:00:00.000Z"),
        currencyCode: "GBP",
        changes: [
          { variantId: "v1", title: "Serum", oldPriceCents: 2500, newPriceCents: 2700 },
          { variantId: "v4", title: "Cream", oldPriceCents: 1500, newPriceCents: 1600 },
        ],
      },
      chip: null, ...helpers,
    });
    expect(html).toContain("Serum is currently out of stock.");
    expect(html).toContain("This delivery was moved to August 20, 2026 because Serum was out of stock.");
    expect(html).toContain(
      "From September 15, 2026, Serum changes from £25.00 to £27.00, and 1 more item changes price.",
    );
    expect(html).toContain("30 ml · out of stock · 2 × £20.00"); // in-line marker on the row
    expect((html.match(/role="status"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("outOfStockTitles flags only unavailable non-gift variants", () => {
    const c = contractFixture();
    const availability = new Map<string, boolean>([
      ["gid://shopify/ProductVariant/1", false],
      ["gid://shopify/ProductVariant/2", true],
      ["gid://shopify/ProductVariant/3", false],
    ]);
    expect(outOfStockTitles(c.lines, availability)).toEqual(["Serum"]);
    expect(outOfStockTitles(c.lines, new Map())).toEqual([]);
  });

  it("loadRecentStockoutDelay only reports a delay newer than the last settled attempt", async () => {
    const c = contractFixture();
    mocks.eventFindFirst.mockResolvedValue({
      createdAt: new Date("2026-08-15T00:10:00.000Z"),
      payload: { variantIds: ["gid://shopify/ProductVariant/1"], days: 5 },
    });
    expect(
      await loadRecentStockoutDelay(c, [
        { status: "SUCCESS", completedAt: new Date("2026-07-20T00:00:00.000Z"), scheduledFor: new Date("2026-07-20T00:00:00.000Z") },
      ]),
    ).toEqual({ title: "Serum" });
    expect(
      await loadRecentStockoutDelay(c, [
        { status: "SUCCESS", completedAt: new Date("2026-08-16T00:00:00.000Z"), scheduledFor: new Date("2026-08-16T00:00:00.000Z") },
      ]),
    ).toBeNull();
    mocks.eventFindFirst.mockRejectedValue(new Error("db"));
    expect(await loadRecentStockoutDelay(c, [])).toBeNull();
  });
});

describe("safeEstimateNextCharge / cutoffLabel", () => {
  it("never throws — falls back to the plan-price estimate on a bug", async () => {
    // A contract with lines lacking currentPriceCents makes the helper's own
    // arithmetic produce NaN, but nothing throws — so simulate a throw via a
    // rejected grant read outside the contained path: pass a broken shop.
    const contract = contractFixture();
    const est = await safeEstimateNextCharge(
      // ianaTimezone undefined → addIntervalTz throws inside estimateNextCharge
      { id: "shop_1", ianaTimezone: undefined as unknown as string },
      contract,
      { grant: null, includeScheduledGifts: false },
    );
    expect(est.totalCents).toBe(5300);
    expect(est.lines.length).toBe(3);
  });

  it("formats the cut-off as date + time in the shop timezone", () => {
    expect(cutoffLabel("en", new Date("2026-08-19T23:00:00.000Z"), TZ)).toBe(
      "August 20, 2026, 12:00 AM",
    );
  });
});

describe("route wiring (source pins)", () => {
  it("the detail page renders the hero from the shared estimate and hides controls while preparing", () => {
    const source = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(source).toContain("nextDeliveryHeroHtml({");
    expect(source).toContain("safeEstimateNextCharge(");
    // preparingOrderDate (aud-v128): the boolean AND the order date being prepared.
    expect(source).toContain("preparingOrderDate(");
    // Schedule card (skip / delay / next_date / frequency) hidden while preparing.
    // (v1.28.0 audit: also hidden while a dunning case is open and when a
    // scheduled cancel leaves no further order.)
    expect(source).toMatch(
      /if \(!preparing && !dunning && !noFurtherOrders\) \{\s*body \+= scheduleHtml\(/,
    );
    // Swap hidden while preparing.
    expect(source).toContain("line.isOneTimeAddon || ctx.lock.locked || ctx.preparing");
    // Items card total comes from the estimate, not a local sum.
    expect(source).not.toContain("orderTotalCents(");
    expect(source).toContain("est.totalCents");
    // Cadence nudge / runout prompt wait too.
    expect(source).toContain("!lock.locked && !preparing");
    // No local money helper survives.
    expect(source).not.toContain("nextChargeEstimateCents(");
  });

  it("the home card shows the estimate total, the cut-off and the preparing chip; one-taps hide while preparing", () => {
    const source = readSource("app/routes/proxy._index.tsx");
    expect(source).toContain("params.estimate.totalCents");
    expect(source).toContain("portal.next.cutoff_short");
    expect(source).toContain("portal.next.preparing_chip");
    expect(source).toContain('contract.status === "ACTIVE" && !params.locked && !preparing');
    // preparingOrderDateByContract (aud-v128): one attempts read, date + boolean.
    expect(source).toContain("preparingOrderDateByContract(");
    expect(source).not.toContain("contractTotalCents(");
    expect(source).not.toContain("nextChargeEstimateCents(");
  });

  it("hero copy never names cancellation (growth-copy honesty rule)", () => {
    const catalog = JSON.parse(readSource("app/lib/i18n/locales/en.json")) as Record<string, string>;
    for (const [key, value] of Object.entries(catalog)) {
      if (!key.startsWith("portal.next.") && !key.startsWith("portal.price.")) continue;
      expect(value.toLowerCase(), key).not.toContain("cancel");
    }
  });
});
