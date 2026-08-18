import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * v1.28.0 cross-stage audit (chunk 2) — money/date truth across surfaces.
 *
 *  1. Card label parity: `paymentMethodShortLabel` is null once the method is
 *     REVOKED and capitalises Shopify's lower-case brand; the home card's
 *     next-charge line reads the shared estimate's (revoke-aware) cardLabel.
 *  2. `runUpcomingOrderReminders` skips contracts with an OPEN dunning case
 *     (the held order's reminder is the dunning ladder).
 *  3. "Preparing" with an in-flight attempt: the order date printed is the
 *     attempt's own `scheduledFor` (the mirror pointer is already the
 *     following cycle) and the "following delivery" note is the mirror's date.
 *  4. Skip-and-resume keeps its promise: Shopify's own date is kept only when
 *     it lands on the promised day (see tests/portal-payment-skip-resume.test.ts
 *     for the execution-side pins).
 *  5. Docs state the price-change / estimate seam.
 */

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  attemptFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
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
    if (key === "dunning") return { preExpiryNoticeDays: 30 };
    return {};
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    billingAttempt: { findMany: mocks.attemptFindMany },
    notificationLog: { findFirst: vi.fn(async () => null) },
    subscriberEvent: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    giftGrant: { findMany: vi.fn(async () => []) },
    shop: { findUnique: vi.fn(async () => ({ ianaTimezone: "Europe/London" })) },
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
  ongoingDiscountPctByProduct: vi.fn(async (): Promise<Map<string, number>> => new Map()),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));

import {
  displayCardBrand,
  paymentMethodLabel,
  paymentMethodShortLabel,
} from "~/lib/portal/payment.server";
import { estimateNextCharge } from "~/lib/billing/estimate.server";
import { runUpcomingOrderReminders } from "~/lib/billing/reminders.server";
import { OPEN_CASE_STATES } from "~/lib/dunning/states";
import {
  isPreparingOrderSync,
  preparingOrderDate,
  type ChargeTiming,
} from "~/lib/billing/timing.server";
import {
  nextDeliveryHeroHtml,
  preparingByContract,
  preparingOrderDateByContract,
} from "~/lib/portal/next-delivery.server";

const TZ = "Europe/London";
const TIMING: ChargeTiming = { tz: TZ, chargeHourLocal: 0, preparingWindowHours: 6 } as ChargeTiming;

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    status: "ACTIVE",
    ordersCount: 2,
    nextBillingDate: new Date("2026-10-01T00:00:00.000Z"),
    deliveryPriceCents: 0,
    currencyCode: "EUR",
    locale: "en",
    intervalWeeks: 4,
    billingIntervalUnit: "MONTH",
    billingIntervalCount: 1,
    paymentInstrumentType: "CARD",
    cardBrand: "visa",
    cardLast4: "4242",
    paymentMethodRevokedAt: null,
    deliveryAddress: null,
    lines: [
      {
        id: "l1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Serum",
        variantTitle: null,
        imageUrl: null,
        quantity: 1,
        currentPriceCents: 4900,
        isGift: false,
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
  mocks.contractFindMany.mockResolvedValue([]);
  mocks.attemptFindMany.mockResolvedValue([]);
});

describe("1. card label parity — revoked card never named on a next-charge line, brand capitalised", () => {
  it("paymentMethodShortLabel is null once paymentMethodRevokedAt is set", () => {
    expect(
      paymentMethodShortLabel("en", {
        paymentInstrumentType: "CARD",
        cardBrand: "visa",
        cardLast4: "4242",
        paymentMethodRevokedAt: new Date("2026-08-10T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("capitalises Shopify's lower-case brand the way the emails do", () => {
    expect(
      paymentMethodShortLabel("en", { paymentInstrumentType: "CARD", cardBrand: "visa", cardLast4: "4242" }),
    ).toBe("Visa ····4242");
    expect(
      paymentMethodLabel("en", { paymentInstrumentType: "CARD", cardBrand: "visa", cardLast4: "4242" }),
    ).toBe("Visa ending in 4242");
    expect(displayCardBrand("American Express")).toBe("American Express");
    expect(displayCardBrand("  ")).toBeNull();
  });

  it("the shared estimate blanks the card once revoked and the home card reads THAT label", async () => {
    const revoked = await estimateNextCharge(
      { id: "shop_1", ianaTimezone: TZ },
      contractFixture({ paymentMethodRevokedAt: new Date("2026-08-10T00:00:00.000Z") }) as never,
      { grant: null },
    );
    expect(revoked.cardLabel).toBe("");
    const live = await estimateNextCharge(
      { id: "shop_1", ianaTimezone: TZ },
      contractFixture() as never,
      { grant: null },
    );
    expect(live.cardLabel).toBe("Visa ····4242");

    const src = readSource("app/routes/proxy._index.tsx");
    expect(src).toContain("cardLabel: params.estimate.cardLabel || null");
    expect(src).not.toContain("cardLabel: paymentMethodShortLabel(locale, contract)");
  });
});

describe("2. upcoming_order reminder skips contracts with an OPEN dunning case", () => {
  it("the selection excludes any contract whose dunning case is in OPEN_CASE_STATES", async () => {
    await runUpcomingOrderReminders(new Date("2026-09-05T09:00:00.000Z"));
    expect(mocks.contractFindMany).toHaveBeenCalledTimes(1);
    const args = mocks.contractFindMany.mock.calls[0][0] as {
      where: { status: string; dunningCases?: { none?: { state?: { in?: string[] } } } };
    };
    expect(args.where.status).toBe("ACTIVE");
    expect(args.where.dunningCases?.none?.state?.in).toEqual(OPEN_CASE_STATES);
    expect(OPEN_CASE_STATES).toEqual(expect.arrayContaining(["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"]));
  });
});

describe("3. preparing with an in-flight attempt prints the ORDER's date, not the advanced pointer", () => {
  // Monthly, charge day 1 Sep: the sweep created the attempt for 1 Sep and
  // advanced the mirror to 1 Oct; the outcome webhook is still on its way.
  const SEP1 = new Date("2026-09-01T00:00:00.000Z");
  const OCT1 = new Date("2026-10-01T00:00:00.000Z");
  const NOW = new Date("2026-09-01T00:30:00.000Z");
  const inFlight = {
    status: "PENDING",
    originatingAction: "SCHEDULER",
    startedAt: new Date("2026-09-01T00:05:00.000Z"),
    scheduledFor: SEP1,
    supersededAt: null,
  };

  it("preparingOrderDate answers the attempt's scheduledFor while in flight, nextBillingDate otherwise", () => {
    const c = { status: "ACTIVE", nextBillingDate: OCT1, billingAttempts: [inFlight] };
    expect(preparingOrderDate(c, TIMING, NOW)?.toISOString()).toBe(SEP1.toISOString());
    expect(isPreparingOrderSync(c, TIMING, NOW)).toBe(true);
    // Charge moment passed, no attempt yet: mirror not advanced → its own date.
    const c2 = { status: "ACTIVE", nextBillingDate: SEP1, billingAttempts: [] };
    expect(preparingOrderDate(c2, TIMING, new Date("2026-09-01T00:10:00.000Z"))?.toISOString()).toBe(
      SEP1.toISOString(),
    );
    // Not preparing → null (matches the boolean).
    const c3 = { status: "ACTIVE", nextBillingDate: OCT1, billingAttempts: [] };
    expect(preparingOrderDate(c3, TIMING, NOW)).toBeNull();
    expect(isPreparingOrderSync(c3, TIMING, NOW)).toBe(false);
  });

  it("hero header = 1 September, following delivery = 1 October (the mirror), never 1 November", async () => {
    const contract = contractFixture({ nextBillingDate: OCT1 });
    mocks.attemptFindMany.mockResolvedValue([inFlight]);
    const estimate = await estimateNextCharge(
      { id: "shop_1", ianaTimezone: TZ },
      contract as never,
      { grant: null },
    );
    const html = nextDeliveryHeroHtml({
      locale: "en",
      tz: TZ,
      contract: contract as never,
      estimate,
      cutoff: null,
      preparing: true,
      preparingOrderDate: SEP1,
      lineUp: null,
      outOfStockTitles: [],
      stockoutDelay: null,
      priceChange: null,
      chip: null,
      ...helpers,
    });
    expect(html).toContain('cxs-next__date">September 1, 2026<');
    expect(html).toContain("cxs-next__preparing");
    expect(html).toContain("October 1, 2026");
    expect(html).not.toContain("November 1, 2026");
  });

  it("without an in-flight date the hero keeps the classic rendering", async () => {
    const contract = contractFixture({ nextBillingDate: SEP1 });
    const estimate = await estimateNextCharge(
      { id: "shop_1", ianaTimezone: TZ },
      contract as never,
      { grant: null },
    );
    const html = nextDeliveryHeroHtml({
      locale: "en", tz: TZ, contract: contract as never, estimate, cutoff: null,
      preparing: true, preparingOrderDate: SEP1, lineUp: null, outOfStockTitles: [],
      stockoutDelay: null, priceChange: null, chip: null, ...helpers,
    });
    expect(html).toContain('cxs-next__date">September 1, 2026<');
    expect(html).toContain("October 1, 2026");
  });

  it("preparingOrderDateByContract shares the one attempts read; preparingByContract stays boolean", async () => {
    mocks.attemptFindMany.mockResolvedValue([{ contractId: "cm_1", ...inFlight }]);
    const contracts = [
      { id: "cm_1", status: "ACTIVE", nextBillingDate: OCT1 },
      { id: "cm_2", status: "ACTIVE", nextBillingDate: OCT1 },
    ];
    const dates = await preparingOrderDateByContract(contracts, TIMING, NOW);
    expect(dates.get("cm_1")?.toISOString()).toBe(SEP1.toISOString());
    expect(dates.get("cm_2")).toBeNull();
    const bools = await preparingByContract(contracts, TIMING, NOW);
    expect(bools.get("cm_1")).toBe(true);
    expect(bools.get("cm_2")).toBe(false);
  });

  it("the routes hand the order date to the hero and the home card", () => {
    const detail = readSource("app/routes/proxy.subscription.$id.tsx");
    expect(detail).toContain("preparingOrderDate: preparingDate");
    const home = readSource("app/routes/proxy._index.tsx");
    expect(home).toContain("preparingOrderDateByContract(contracts, timing)");
    expect(home).toContain("preparingOrderDate: preparingDates.get(contract.id) ?? null");
  });
});

describe("4. skip-and-resume keeps the promised date", () => {
  it("Shopify's own date is kept only when it lands on the promised shop day", () => {
    const src = readSource("app/lib/dunning/skip-resume.server.ts");
    expect(src).toContain("shopDayStartUtc(effectiveNext, shop.ianaTimezone).getTime() !==");
    expect(src).toContain("shopDayStartUtc(target, shop.ianaTimezone).getTime()");
  });
});

describe("5. docs state the estimate / price-change seam", () => {
  it("ARCHITECTURE + OPERATIONS say the estimate prices from the mirror and batches apply by hand", () => {
    const arch = readSource("docs/ARCHITECTURE.md");
    expect(arch).toContain("a pending price-change batch");
    expect(arch).toContain("is NOT folded in");
    const ops = readSource("docs/OPERATIONS.md");
    expect(ops).toContain("there is NO job that applies it for you");
    expect(ops).not.toContain("the batch applies automatically");
  });
});
