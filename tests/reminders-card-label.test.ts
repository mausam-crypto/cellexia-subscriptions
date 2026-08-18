import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.5 (non-portal half, v1.28.0) — the upcoming-order reminder carries the
 * card behind the charge and an expiring-card warning:
 *
 *  - vars.card_label ("Visa ····4242" / "Shop Pay ····4242" / "PayPal") and
 *    vars.payment_line (the localized "Payment method: …" line; "" when
 *    nothing is mirrored so the body line collapses);
 *  - vars.card_expiry_warning: "" normally; the "before this order" sentence
 *    when the card's expiry moment (first instant after the expiry month) is
 *    at or before the charge date — an already-expired card included; the
 *    "expires soon" sentence when the expiry falls within
 *    dunning.preExpiryNoticeDays of now but AFTER the charge; PayPal never
 *    warns;
 *  - every pre-existing var is untouched, and the English body renders
 *    placeholder-free with an EMPTY warning (templates must not throw on
 *    empty vars — the emails-preview / email_templates self-check contract).
 *
 * Scaffold: tests/billing-reminders-skip-dedupe.test.ts (real
 * runUpcomingOrderReminders, mocked seams) — with the REAL i18n catalog so
 * the sentences are pinned as customers read them.
 */

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  dunningSetting: { preExpiryNoticeDays: 30 } as Row,
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
    if (key === "dunning") return mocks.dunningSetting;
    return {};
  }),
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
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));

import {
  reminderCardVars,
  runUpcomingOrderReminders,
} from "~/lib/billing/reminders.server";
import { renderEmail } from "~/lib/notifications/templates.server";

const NOW = new Date("2026-08-17T09:00:00.000Z");
const CHARGE = new Date("2026-08-19T09:00:00.000Z"); // inside the 3-day window
const TZ = "Europe/London";

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
    lines: [
      {
        productId: "gid://shopify/Product/1",
        variantId: "gid://shopify/ProductVariant/1",
        title: "Cellexia Renewal Serum",
        variantTitle: null,
        quantity: 1,
        currentPriceCents: 4900,
        isGift: false,
      },
    ],
    ...over,
  };
}

function sentVars(): Row {
  expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  return (mocks.sendNotification.mock.calls[0][0] as { vars: Row }).vars;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.dunningSetting = { preExpiryNoticeDays: 30 };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("reminderCardVars", () => {
  const base = {
    locale: "en",
    paymentInstrumentType: "CREDIT_CARD" as string | null,
    cardBrand: "visa" as string | null,
    cardLast4: "4242" as string | null,
    cardExpiryMonth: 12 as number | null,
    cardExpiryYear: 2028 as number | null,
  };

  it("labels the instrument and renders the payment line; empty when nothing is mirrored", () => {
    expect(reminderCardVars(base, CHARGE, NOW, 30, TZ)).toEqual({
      card_label: "Visa ····4242",
      payment_line: "Payment method: Visa ····4242",
      card_expiry_warning: "",
    });
    expect(
      reminderCardVars({ ...base, paymentInstrumentType: "SHOP_PAY" }, CHARGE, NOW, 30, TZ)
        .card_label,
    ).toBe("Shop Pay ····4242");
    expect(
      reminderCardVars({ ...base, paymentInstrumentType: "PAYPAL" }, CHARGE, NOW, 30, TZ),
    ).toMatchObject({ card_label: "PayPal", payment_line: "Payment method: PayPal" });
    expect(
      reminderCardVars(
        { ...base, paymentInstrumentType: null, cardBrand: null, cardLast4: null, cardExpiryMonth: null, cardExpiryYear: null },
        CHARGE,
        NOW,
        30,
        TZ,
      ),
    ).toEqual({ card_label: "", payment_line: "", card_expiry_warning: "" });
  });

  it("card expiring BEFORE the charge (or already expired) → the 'before this order' sentence", () => {
    // Expiry month July 2026 → expiry moment 1 Aug 2026 < charge on 19 Aug.
    const before = reminderCardVars(
      { ...base, cardExpiryMonth: 7, cardExpiryYear: 2026 },
      CHARGE,
      NOW,
      30,
      TZ,
    );
    expect(before.card_expiry_warning).toBe(
      "Heads-up: your card ending 4242 expires 07/2026 — before this order. Please update it from your account to avoid an interruption.",
    );
    // Long expired.
    expect(
      reminderCardVars({ ...base, cardExpiryMonth: 1, cardExpiryYear: 2024 }, CHARGE, NOW, 30, TZ)
        .card_expiry_warning,
    ).toContain("before this order");
    // Expiry month = charge month: valid through the last day → NOT before.
    // Aug 2026 card, charge 19 Aug 2026, now 17 Aug: expiry moment 1 Sep is
    // within 30 days → the "soon" sentence instead.
    const sameMonth = reminderCardVars(
      { ...base, cardExpiryMonth: 8, cardExpiryYear: 2026 },
      CHARGE,
      NOW,
      30,
      TZ,
    );
    expect(sameMonth.card_expiry_warning).toContain("expires 08/2026.");
    expect(sameMonth.card_expiry_warning).not.toContain("before this order");
  });

  it("expiry within preExpiryNoticeDays but after the charge → the 'soon' sentence; outside → nothing; PayPal never warns", () => {
    // Sep 2026 → expiry moment 1 Oct; 17 Aug + 30 d = 16 Sep < 1 Oct → no warning.
    expect(
      reminderCardVars({ ...base, cardExpiryMonth: 9, cardExpiryYear: 2026 }, CHARGE, NOW, 30, TZ)
        .card_expiry_warning,
    ).toBe("");
    // Same card, a 60-day window → warns "soon".
    expect(
      reminderCardVars({ ...base, cardExpiryMonth: 9, cardExpiryYear: 2026 }, CHARGE, NOW, 60, TZ)
        .card_expiry_warning,
    ).toBe(
      "Heads-up: your card ending 4242 expires 09/2026. Please update it from your account when you have a moment, so later orders continue without interruption.",
    );
    // A zero / unknown window disables the "soon" sentence only.
    expect(
      reminderCardVars({ ...base, cardExpiryMonth: 8, cardExpiryYear: 2026 }, CHARGE, NOW, 0, TZ)
        .card_expiry_warning,
    ).toBe("");
    expect(
      reminderCardVars({ ...base, cardExpiryMonth: 7, cardExpiryYear: 2026 }, CHARGE, NOW, 0, TZ)
        .card_expiry_warning,
    ).toContain("before this order");
    // PayPal carries no expiry.
    expect(
      reminderCardVars(
        { ...base, paymentInstrumentType: "PAYPAL", cardExpiryMonth: 7, cardExpiryYear: 2026 },
        CHARGE,
        NOW,
        30,
        TZ,
      ).card_expiry_warning,
    ).toBe("");
  });
});

describe("runUpcomingOrderReminders sends the card vars", () => {
  it("adds card_label / payment_line / card_expiry_warning next to every existing var", async () => {
    mocks.contractFindMany.mockResolvedValue([contractFixture()]);

    await runUpcomingOrderReminders(NOW);

    const vars = sentVars();
    expect(vars).toMatchObject({
      card_label: "Visa ····4242",
      payment_line: "Payment method: Visa ····4242",
      card_expiry_warning: "",
      // pre-existing contract untouched
      cycleIndex: 6,
      reminder_dedupe: "upcoming_order:2026-08-19",
      items_summary: "Cellexia Renewal Serum × 1",
      total_estimate: expect.any(String),
      next_date_iso: CHARGE.toISOString(),
      frequency_unit: "WEEK",
      frequency_count: 4,
    });
    // dunning.preExpiryNoticeDays is read once (settings own the window).
    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "dunning");
  });

  it("an expiring card yields the warning sentence in the send vars", async () => {
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ cardExpiryMonth: 7, cardExpiryYear: 2026 }),
    ]);

    await runUpcomingOrderReminders(NOW);

    expect(sentVars().card_expiry_warning).toContain("expires 07/2026 — before this order");
  });

  it("a broken dunning settings read only drops the 'soon' sentence — the reminder still goes out", async () => {
    mocks.getSetting.mockImplementationOnce(async (_s: string, key: string) => {
      if (key === "notifications") {
        return {
          channels: { email: true, sms: true },
          upcomingOrderDaysBefore: 3,
          addonSuggestionEnabled: false,
          addonSuggestionVariantId: "",
        };
      }
      return {};
    });
    mocks.getSetting.mockImplementationOnce(async () => ({ allowAddProducts: false }));
    mocks.getSetting.mockImplementationOnce(async () => {
      throw new Error("settings down");
    });
    mocks.contractFindMany.mockResolvedValue([
      contractFixture({ cardExpiryMonth: 8, cardExpiryYear: 2026 }),
    ]);

    await runUpcomingOrderReminders(NOW);

    expect(sentVars().card_expiry_warning).toBe("");
  });
});

describe("upcoming_order body", () => {
  const PLACEHOLDER = /\{[a-z0-9_]+\}/i;
  const links = {
    portal_url: "https://example.com/account",
    skip_url: "https://example.com/skip",
    delay_3w_url: "https://example.com/delay",
  };
  const common = {
    next_date: "19 August 2026",
    items_summary: "Cellexia Renewal Serum × 1",
    total_estimate: "£49.00",
    // v1.28.0 P2.1: the reminder always supplies the composed cut-off line.
    edit_cutoff_line: "You can make changes until 19 August 2026, 00:00.",
    ...links,
  };

  it("renders placeholder-free with an EMPTY warning and payment line, and shows both when present", () => {
    const empty = renderEmail("upcoming_order", "en", {
      ...common,
      card_label: "",
      payment_line: "",
      card_expiry_warning: "",
    });
    expect(empty.text).not.toMatch(PLACEHOLDER);
    expect(empty.html).not.toMatch(PLACEHOLDER);
    expect(empty.text).not.toContain("Payment method");

    const full = renderEmail("upcoming_order", "en", {
      ...common,
      card_label: "Visa ····4242",
      payment_line: "Payment method: Visa ····4242",
      card_expiry_warning: "Heads-up: your card ending 4242 expires 07/2026 — before this order. Please update it from your account to avoid an interruption.",
    });
    expect(full.text).not.toMatch(PLACEHOLDER);
    expect(full.text).toContain("Estimated total: £49.00\nPayment method: Visa ····4242");
    expect(full.text).toContain("expires 07/2026 — before this order");
  });
});
