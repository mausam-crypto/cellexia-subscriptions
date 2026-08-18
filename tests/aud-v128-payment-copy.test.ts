import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 audit pins — customer-facing payment copy must only claim what the
 * code guarantees:
 *
 *  - payment_method_updated: FAILED / open-case contracts hear "we'll retry
 *    your held payment", never "everything is set for your next order" +
 *    a stale past date; PAUSED hears "nothing is charged until you resume";
 *    a merchant-made change is not voiced as the customer's own; a backup
 *    switch with no mirrored card label never renders a hole;
 *  - portal payment state: "before your next order on {date}" only when the
 *    card is dead by that date (beforeNextOrder), and the expiry moment is
 *    the shop's local month boundary (Europe/Zurich, 1 Sep 00:00 local);
 *  - reminders: a revoked method is never named as THE payment method with
 *    "nothing to do";
 *  - the dunning banner: PAUSED + update-card case says the card must be
 *    fixed before resume; the retry cooldown note is "waiting for your bank"
 *    only while an attempt is in flight; the portal view exposes inFlight;
 *  - the next-charge estimate applies the live grant like the reminder.
 */

const mocks = vi.hoisted(() => ({
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  sendNotification: vi.fn(async (_args?: unknown): Promise<unknown> => ({ status: "SENT" })),
  buildPortalUrl: vi.fn(
    async (_shopId: string, path = "/"): Promise<string> =>
      `https://shop.example/apps/cellexia${path}`,
  ),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst, findMany: vi.fn(async () => []) },
    billingAttempt: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    subscriberEvent: { findFirst: vi.fn(async () => null) },
  },
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: mocks.buildPortalUrl,
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
// reminders.server.ts imports the Shopify app module + shop/install; only
// the pure reminderCardVars is exercised here.
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));

import { paymentMethodUpdatedVars } from "~/lib/notifications/payment-method.server";
import {
  derivePortalPaymentState,
  nextChargeEstimateCents,
} from "~/lib/portal/payment.server";
import { cardExpiryMoment } from "~/lib/dates.server";
import { reminderCardVars } from "~/lib/billing/reminders.server";
import { buildPortalDunningView } from "~/lib/portal/dunning.server";
import { dunningBannerHtml } from "~/lib/portal/dunning-banner.server";
import en from "../app/lib/i18n/locales/en.json";

const NOW = new Date("2026-08-17T10:00:00.000Z");

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    paymentMethodId: "gid://shopify/CustomerPaymentMethod/new",
    paymentInstrumentType: "CREDIT_CARD" as string | null,
    cardBrand: "visa" as string | null,
    cardLast4: "1111" as string | null,
    nextBillingDate: new Date("2026-09-12T09:00:00Z") as Date | null,
    currencyCode: "CHF",
    status: "ACTIVE" as string | null,
    ...over,
  };
}

const PREVIOUS = { cardBrand: "visa", cardLast4: "4242", paymentInstrumentType: "CREDIT_CARD" };

describe("payment_method_updated — what 'next' truthfully means", () => {
  it("ACTIVE without a case: thank-you line + the scheduled date (unchanged)", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich", contract: contract(), reason: "updated",
      previousCard: PREVIOUS, cardUpdatedBy: "customer", hasOpenCase: false, now: NOW,
    });
    expect(vars.change_line).toBe(
      "Thank you — your subscription now uses Visa ····1111, and everything is set for your next order.",
    );
    expect(vars.next_line).toContain("Your next order is scheduled for");
  });

  it("FAILED contract (card fixed months later): 'we'll retry your held payment shortly', NO stale past date", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich",
      contract: contract({ status: "FAILED", nextBillingDate: new Date("2026-06-03T09:00:00Z") }),
      reason: "updated", previousCard: PREVIOUS, cardUpdatedBy: "customer", hasOpenCase: false, now: NOW,
    });
    expect(vars.change_line).toBe(
      "Thank you — your subscription now uses Visa ····1111. We'll retry your held payment shortly.",
    );
    expect(vars.next_line).toBe("");
  });

  it("ACTIVE with an open case (looked up when the caller does not know): the retry line, no scheduled date", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich", contract: contract(), reason: "updated",
      previousCard: PREVIOUS, cardUpdatedBy: "customer", now: NOW,
    });
    expect(vars.change_line).toContain("We'll retry your held payment shortly.");
    expect(vars.next_line).toBe("");
    expect(mocks.dunningCaseFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contractId: "c_1", resolvedAt: null } }),
    );
  });

  it("PAUSED: 'nothing is charged until you resume' instead of a date that is not the real next charge", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich", contract: contract({ status: "PAUSED" }), reason: "updated",
      previousCard: PREVIOUS, cardUpdatedBy: "customer", hasOpenCase: false, now: NOW,
    });
    expect(vars.next_line).toBe(en["email.payment_method_updated.next_line_paused"]);
  });

  it("a past nextBillingDate on an ACTIVE contract without a case renders no scheduled-date line", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich",
      contract: contract({ nextBillingDate: new Date("2026-08-01T09:00:00Z") }),
      reason: "updated", previousCard: PREVIOUS, cardUpdatedBy: "customer", hasOpenCase: false, now: NOW,
    });
    expect(vars.next_line).toBe("");
  });

  it("a merchant-made change is voiced as the team's, not as the customer's 'thank you'", async () => {
    const vars = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich", contract: contract(), reason: "updated",
      previousCard: PREVIOUS, cardUpdatedBy: "merchant", hasOpenCase: false, now: NOW,
    });
    expect(vars.change_line).toBe("Our team has updated your subscription to use Visa ····1111.");
    expect(vars.change_line).not.toContain("Thank you");
  });

  it("backup switches with NO mirrored card label use the label-free variants (no hole in the sentence)", async () => {
    const promoted = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich",
      contract: contract({ cardBrand: null, cardLast4: null, paymentInstrumentType: null }),
      reason: "backup_promoted", previousCard: PREVIOUS, cardUpdatedBy: "system", hasOpenCase: false, now: NOW,
    });
    expect(promoted.change_line).toBe(
      "We've switched your subscription to your backup payment method because Visa ····4242 was removed from your account — nothing else changes.",
    );
    expect(promoted.change_line).not.toMatch(/  /);
    const failed = await paymentMethodUpdatedVars({
      locale: "en", tz: "Europe/Zurich",
      contract: contract({ cardBrand: null, cardLast4: null, paymentInstrumentType: null }),
      reason: "backup_failed", previousCard: PREVIOUS, cardUpdatedBy: "system", hasOpenCase: true, now: NOW,
    });
    expect(failed.change_line).toContain("switched your subscription to your backup payment method and will retry shortly");
    expect(failed.next_line).toBe("");
  });
});

describe("portal payment state — beforeNextOrder and the shop-tz expiry moment", () => {
  const base = {
    paymentMethodId: "pm_1",
    backupPaymentMethodId: null,
    paymentMethodRevokedAt: null,
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 10,
    cardExpiryYear: 2026,
  };

  it("inside the notice window but the next order still charges fine → EXPIRING with beforeNextOrder=false", () => {
    const view = derivePortalPaymentState(
      { ...base, nextBillingDate: new Date("2026-10-20T09:00:00Z") },
      { now: new Date("2026-10-05T09:00:00Z"), preExpiryNoticeDays: 30, tz: "Europe/Zurich" },
    );
    expect(view.state).toBe("EXPIRING");
    expect(view.beforeNextOrder).toBe(false);
  });

  it("the card is dead by the next order's date → beforeNextOrder=true", () => {
    const view = derivePortalPaymentState(
      { ...base, nextBillingDate: new Date("2026-11-20T09:00:00Z") },
      { now: new Date("2026-10-05T09:00:00Z"), preExpiryNoticeDays: 30, tz: "Europe/Zurich" },
    );
    expect(view).toMatchObject({ state: "EXPIRING", beforeNextOrder: true });
  });

  it("expiry moment = shop-tz local midnight of the month after expiry (Zurich 1 Sep 00:00 = 31 Aug 22:00Z), UTC without tz", () => {
    expect(cardExpiryMoment(8, 2026, "Europe/Zurich")?.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(cardExpiryMoment(8, 2026)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(cardExpiryMoment(12, 2026, "Europe/Zurich")?.toISOString()).toBe("2026-12-31T23:00:00.000Z");
    expect(cardExpiryMoment(null, 2026, "Europe/Zurich")).toBeNull();
    // An order at local midnight on the 1st runs on an expired card — the
    // UTC month start would have missed it for a UTC+ shop.
    const localMidnightOrder = new Date("2026-08-31T22:00:00Z");
    const zurich = derivePortalPaymentState(
      { ...base, cardExpiryMonth: 8, nextBillingDate: localMidnightOrder },
      { now: new Date("2026-08-01T09:00:00Z"), preExpiryNoticeDays: 0, tz: "Europe/Zurich" },
    );
    expect(zurich.beforeNextOrder).toBe(true);
    const utc = derivePortalPaymentState(
      { ...base, cardExpiryMonth: 8, nextBillingDate: localMidnightOrder },
      { now: new Date("2026-08-01T09:00:00Z"), preExpiryNoticeDays: 0 },
    );
    expect(utc.beforeNextOrder).toBe(false);
  });
});

describe("reminder card vars — revoked method", () => {
  it("a revoked payment method is never named as the payment method for this order; the missing-method line renders instead", () => {
    const vars = reminderCardVars(
      {
        locale: "en",
        paymentInstrumentType: "CREDIT_CARD",
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpiryMonth: 8,
        cardExpiryYear: 2030,
        paymentMethodRevokedAt: new Date("2026-08-10T09:00:00Z"),
      },
      new Date("2026-08-20T09:00:00Z"),
      NOW,
      30,
      "Europe/Zurich",
    );
    expect(vars.card_label).toBe("");
    expect(vars.payment_line).toBe(en["email.upcoming_order.payment_line_missing"]);
    expect(vars.card_expiry_warning).toBe("");
  });

  it("the 'before this order' warning uses the shop-tz expiry moment (Zurich order at local midnight 1 Sep on an 08/2026 card)", () => {
    const vars = reminderCardVars(
      {
        locale: "en",
        paymentInstrumentType: "CREDIT_CARD",
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpiryMonth: 8,
        cardExpiryYear: 2026,
      },
      new Date("2026-08-31T22:00:00Z"),
      new Date("2026-08-28T09:00:00Z"),
      0,
      "Europe/Zurich",
    );
    expect(vars.card_expiry_warning).toContain("before this order");
  });
});

describe("dunning banner — paused update-card line, cooldown note, next-charge estimate", () => {
  const OPENED = new Date("2026-08-14T08:00:00.000Z");
  const kase = (over: Record<string, unknown> = {}) =>
    ({
      id: "case_1", contractId: "cm_1", openedAt: OPENED, state: "RETRYING", triggerAttemptId: "att_1",
      declineCode: "INSUFFICIENT_FUNDS", declineCategory: "SOFT", ladderStep: 1,
      nextRetryAt: new Date("2026-08-19T08:00:00.000Z"), paydayAligned: false, emailsSent: 1, smsSent: 0,
      lastNotifiedAt: null, resolvedAt: null, resolution: null, recoveredAttemptId: null, recoveredCents: null,
      amountAtRiskCents: 4900, amountAtRiskCurrencyCode: "EUR", originalPaymentMethodId: "pm_main",
      ladderCursor: 1, customerRetryAt: null, ...over,
    }) as never;
  const contractRow = (over: Record<string, unknown> = {}) =>
    ({
      id: "cm_1", status: "ACTIVE", paymentMethodId: "pm_main", backupPaymentMethodId: null,
      paymentMethodRevokedAt: null, currencyCode: "EUR", deliveryPriceCents: 0,
      nextBillingDate: new Date("2026-08-14T08:00:00.000Z"),
      lines: [{ currentPriceCents: 4900, quantity: 1 }], ...over,
    }) as never;
  const TRIGGER = {
    id: "att_1", status: "FAILED", cycleIndex: 4,
    completedAt: new Date("2026-08-14T07:59:00.000Z"),
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
  } as never;
  const input = (view: unknown, over: Record<string, unknown> = {}) =>
    ({
      locale: "en", tz: "Europe/Paris", view,
      contract: { paymentMethodId: "pm_main", nextBillingDate: NOW },
      status: "ACTIVE", locked: false, liveMethodCount: 1, retryCooldownMinutes: 60, now: NOW,
      apiUrl: (action: string) => `/apps/cellexia-subs/api/${action}`,
      hiddenFields: (fields: Array<[string, string]>) =>
        fields.map(([n, v]) => `<input name="${n}" value="${v}">`).join(""),
      ...over,
    }) as never;

  it("PAUSED + hard decline (update-card case): the state line says fix the card before resume; Update card stays", () => {
    const view = buildPortalDunningView({
      kase: kase({ state: "AWAITING_CUSTOMER", nextRetryAt: null, declineCode: "EXPIRED_CARD", declineCategory: "HARD" }),
      contract: contractRow({ status: "PAUSED" }),
      attempts: [TRIGGER],
    });
    const html = dunningBannerHtml(input(view, { status: "PAUSED" }));
    expect(html).toContain(esc(en["portal.dunning.state.paused_update_card"]));
    expect(html).not.toContain(esc(en["portal.dunning.state.paused"]));
    expect(html).toContain("/api/payment_update");
    // A SOFT case keeps the "we'll pick it back up" line (the sweep will).
    const soft = buildPortalDunningView({ kase: kase(), contract: contractRow({ status: "PAUSED" }), attempts: [TRIGGER] });
    expect(dunningBannerHtml(input(soft, { status: "PAUSED" }))).toContain(esc(en["portal.dunning.state.paused"]));
  });

  it("the view exposes inFlight from a PENDING attempt with a Shopify id on the case's cycle; the cooldown note follows it", () => {
    const retriedAt = new Date(NOW.getTime() - 10 * 60_000);
    const settled = buildPortalDunningView({
      kase: kase({ customerRetryAt: retriedAt }), contract: contractRow(), attempts: [TRIGGER],
    });
    expect(settled.inFlight).toBe(false);
    const html = dunningBannerHtml(input(settled));
    expect(html).not.toContain(esc(en["portal.dunning.retry_cooldown"]));
    expect(html).toContain("you can try again from");
    expect(html).not.toContain("/api/payment_retry");

    const live = buildPortalDunningView({
      kase: kase({ customerRetryAt: retriedAt }),
      contract: contractRow(),
      attempts: [
        TRIGGER,
        { id: "att_2", status: "PENDING", cycleIndex: 4, completedAt: null, shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/2" } as never,
      ],
    });
    expect(live.inFlight).toBe(true);
    expect(dunningBannerHtml(input(live))).toContain(esc(en["portal.dunning.retry_cooldown"]));
  });

  it("the next-charge estimate applies the live grant to non-gift lines like the reminder (49.00 → 39.20 at 20%)", () => {
    const c = {
      deliveryPriceCents: 0,
      lines: [
        { currentPriceCents: 4900, quantity: 1 },
        { currentPriceCents: 0, quantity: 1, isGift: true },
      ],
    };
    expect(nextChargeEstimateCents(c, null)).toBe(4900);
    expect(nextChargeEstimateCents(c, 20)).toBe(3920);
    expect(nextChargeEstimateCents({ ...c, deliveryPriceCents: 500 }, 20)).toBe(4420);
  });
});
