import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Portal dunning surface (v1.28.0, P1.2): the view-model the home cards, the
 * detail banner and the retry / 3DS verbs share, the banner's copy + CTAs
 * per decline category, the home ordering, and the rate-limited impression
 * event.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  eventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: {
    dunningCase: {
      findFirst: mocks.dunningCaseFindFirst,
      findMany: mocks.dunningCaseFindMany,
    },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findMany: mocks.attemptFindMany,
    },
    subscriberEvent: { findFirst: mocks.eventFindFirst },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

import {
  buildPortalDunningView,
  dunningCtaGroup,
  dunningReasonKey,
  dunningSortRank,
  loadPortalDunning,
  loadPortalDunningMany,
  logDunningBannerShown,
  type PortalDunningView,
} from "~/lib/portal/dunning.server";
import { dunningBannerHtml } from "~/lib/portal/dunning-banner.server";
import en from "../app/lib/i18n/locales/en.json";

/** HTML-escaped form of an en.json string, as the banner renders it. */
function esc(key: keyof typeof en): string {
  return (en[key] as string)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const NOW = new Date("2026-08-17T10:00:00.000Z");
const OPENED = new Date("2026-08-14T08:00:00.000Z");

function kaseFixture(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_1",
    openedAt: OPENED,
    state: "RETRYING",
    triggerAttemptId: "att_1",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 1,
    nextRetryAt: new Date("2026-08-19T08:00:00.000Z"),
    paydayAligned: false,
    emailsSent: 1,
    smsSent: 0,
    lastNotifiedAt: null,
    resolvedAt: null,
    resolution: null,
    recoveredAttemptId: null,
    recoveredCents: null,
    amountAtRiskCents: 4900,
    amountAtRiskCurrencyCode: "EUR",
    originalPaymentMethodId: "pm_main",
    ladderCursor: 1,
    customerRetryAt: null,
    ...over,
  } as never;
}

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_1",
    status: "ACTIVE",
    paymentMethodId: "pm_main",
    backupPaymentMethodId: null,
    paymentMethodRevokedAt: null,
    currencyCode: "EUR",
    deliveryPriceCents: 0,
    nextBillingDate: new Date("2026-08-14T08:00:00.000Z"),
    lines: [{ currentPriceCents: 4900, quantity: 1 }],
    ...over,
  } as never;
}

const TRIGGER_COMPLETED_AT = new Date("2026-08-14T07:59:00.000Z");
const TRIGGER = {
  id: "att_1",
  status: "FAILED",
  cycleIndex: 4,
  completedAt: TRIGGER_COMPLETED_AT,
  shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
} as never;

function bannerInput(
  view: PortalDunningView,
  over: Record<string, unknown> = {},
) {
  return {
    locale: "en",
    tz: "Europe/Paris",
    view,
    contract: { paymentMethodId: "pm_main", nextBillingDate: NOW },
    status: "ACTIVE",
    locked: false,
    liveMethodCount: 1,
    retryCooldownMinutes: 60,
    now: NOW,
    apiUrl: (action: string) => `/apps/cellexia-subs/api/${action}`,
    hiddenFields: (fields: Array<[string, string]>) =>
      fields.map(([n, v]) => `<input name="${n}" value="${v}">`).join(""),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventFindFirst.mockResolvedValue(null);
});

describe("buildPortalDunningView — state per case", () => {
  it("RETRYING soft decline: retrying state, next retry date, SOFT CTA group, amount at risk", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture(),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });
    expect(view).toMatchObject({
      caseId: "case_1",
      state: "RETRYING",
      ctaGroup: "SOFT",
      reasonKey: "portal.dunning.reason.soft",
      declineCategory: "SOFT",
      amountCents: 4900,
      currencyCode: "EUR",
      challenged: false,
      onBackup: false,
      primaryRevoked: false,
    });
    expect(view.failedAt).toEqual(TRIGGER_COMPLETED_AT);
    expect(view.nextRetryAt?.toISOString()).toBe("2026-08-19T08:00:00.000Z");
  });

  it("OPEN reads as RETRYING (nothing to do); AWAITING_CUSTOMER / AWAITING_3DS / EXHAUSTED map 1:1", () => {
    const states = ["OPEN", "AWAITING_CUSTOMER", "AWAITING_3DS", "EXHAUSTED"];
    const got = states.map(
      (state) =>
        buildPortalDunningView({
          kase: kaseFixture({ state, nextRetryAt: null }),
          contract: contractFixture(),
          attempts: [TRIGGER],
        }).state,
    );
    expect(got).toEqual(["RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS", "EXHAUSTED"]);
  });

  it("a CHALLENGED attempt of the case's cycle forces AWAITING_3DS and names the attempt", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture({ state: "RETRYING" }),
      contract: contractFixture(),
      attempts: [
        TRIGGER,
        {
          id: "att_ch",
          status: "CHALLENGED",
          cycleIndex: 4,
          completedAt: null,
          shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/2",
        } as never,
        // Another cycle's challenge is not this case's business.
        {
          id: "att_other",
          status: "CHALLENGED",
          cycleIndex: 3,
          completedAt: null,
          shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/3",
        } as never,
      ],
    });
    expect(view.state).toBe("AWAITING_3DS");
    expect(view.challenged).toBe(true);
    expect(view.challengedAttemptId).toBe("att_ch");
    expect(view.nextRetryAt).toBeNull();
  });

  it("HARD / update-card declines → UPDATE_CARD group; AUTH_REQUIRED → bank; revoked primary wins", () => {
    expect(dunningCtaGroup("HARD", "UPDATE_CARD", false)).toBe("UPDATE_CARD");
    expect(dunningCtaGroup("SOFT", "UPDATE_CARD", false)).toBe("UPDATE_CARD");
    expect(dunningCtaGroup("AUTH_REQUIRED", "AUTHENTICATE", false)).toBe("AUTH_REQUIRED");
    expect(dunningCtaGroup("SOFT", "NONE", false)).toBe("SOFT");
    expect(dunningCtaGroup("SOFT", "NONE", true)).toBe("UPDATE_CARD");
    expect(dunningReasonKey("SOFT", "NONE", true)).toBe("portal.dunning.reason.card_removed");
    expect(dunningReasonKey("HARD", "UPDATE_CARD", false)).toBe("portal.dunning.reason.update_card");
    expect(dunningReasonKey("AUTH_REQUIRED", "AUTHENTICATE", false)).toBe(
      "portal.dunning.reason.auth_required",
    );

    const expired = buildPortalDunningView({
      kase: kaseFixture({ declineCode: "EXPIRED_PAYMENT_METHOD", declineCategory: "HARD" }),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });
    expect(expired.ctaGroup).toBe("UPDATE_CARD");
    expect(expired.customerAction).toBe("UPDATE_CARD");
  });

  it("falls back to the current order total when the case has no amount, and reads backup/revoked from the contract", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture({ amountAtRiskCents: null, amountAtRiskCurrencyCode: null }),
      contract: contractFixture({
        deliveryPriceCents: 500,
        backupPaymentMethodId: "pm_backup",
        paymentMethodId: "pm_backup",
        paymentMethodRevokedAt: NOW,
      }),
      attempts: [],
    });
    expect(view.amountCents).toBe(5400);
    expect(view.currencyCode).toBe("EUR");
    expect(view.failedAt).toEqual(OPENED); // no trigger attempt → case openedAt
    expect(view.onBackup).toBe(true);
    expect(view.primaryRevoked).toBe(true);
    expect(view.ctaGroup).toBe("UPDATE_CARD");
  });

  it("onBackup only while the case is OPEN: a resolved (EXHAUSTED) case with equal pointers is a stale marker, not 'on backup' (Stage G review fix)", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture({ state: "EXHAUSTED", resolution: "EXHAUSTED", resolvedAt: NOW }),
      contract: contractFixture({ backupPaymentMethodId: "pm_backup", paymentMethodId: "pm_backup" }),
      attempts: [],
    });
    expect(view.onBackup).toBe(false);
  });
});

describe("dunningBannerHtml — copy per state and CTAs per category", () => {
  const soft = () =>
    buildPortalDunningView({
      kase: kaseFixture(),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });

  it("SOFT + RETRYING: title names amount/date/reason, state line names the retry date, CTAs = retry / pause (never delay/skip: they act on the mirror pointer, not the held cycle)", () => {
    const html = dunningBannerHtml(bannerInput(soft()));
    expect(html).toContain('id="cxs-dunning"');
    expect(html).toContain("cxs-dunning--retrying");
    expect(html).toContain("We couldn&#39;t take €49.00 on");
    expect(html).toContain(esc("portal.dunning.reason.soft"));
    expect(html).toContain("We&#39;ll try again on");
    for (const action of ["payment_retry", "pause"]) {
      expect(html).toContain(`/api/${action}"`);
    }
    // v1.28.0 audit: "Delay 1 week" / "Skip this order" would move or skip
    // whatever cycle the mirror's nextBillingDate points at (held cycle OR
    // the following one) while the ladder keeps charging the held one — the
    // banner must not promise "this order".
    expect(html).not.toContain("/api/delay");
    expect(html).not.toContain("/api/skip");
    expect(html).not.toContain("/api/payment_update");
    expect(html).not.toContain("/api/payment_3ds");
    // Pause 1 month.
    expect(html).toContain('name="months" value="1"');
  });

  it("the schedule off-ramps disappear inside the lock window and on non-ACTIVE contracts; retry stays", () => {
    const locked = dunningBannerHtml(bannerInput(soft(), { locked: true }));
    expect(locked).toContain("/api/payment_retry");
    expect(locked).not.toContain("/api/skip");
    expect(locked).not.toContain("/api/delay");
    expect(locked).not.toContain("/api/pause");

    const failed = buildPortalDunningView({
      kase: kaseFixture({ state: "EXHAUSTED", resolvedAt: NOW, resolution: "EXHAUSTED" }),
      contract: contractFixture({ status: "FAILED" }),
      attempts: [TRIGGER],
    });
    const html = dunningBannerHtml(bannerInput(failed, { status: "FAILED" }));
    expect(html).toContain(esc("portal.dunning.state.exhausted"));
    expect(html).toContain("/api/payment_retry");
    expect(html).not.toContain("/api/skip");
  });

  it("PAUSED: the paused state line, no retry (Shopify refuses attempts on paused contracts)", () => {
    const html = dunningBannerHtml(bannerInput(soft(), { status: "PAUSED" }));
    expect(html).toContain(esc("portal.dunning.state.paused"));
    expect(html).not.toContain("/api/payment_retry");
    expect(html).not.toContain("/api/skip");
  });

  it("inside the customer-retry cooldown the Retry button becomes the cooldown note", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture({ customerRetryAt: new Date(NOW.getTime() - 10 * 60_000) }),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });
    const html = dunningBannerHtml(bannerInput(view));
    expect(html).not.toContain("/api/payment_retry");
    // No attempt in flight (the retry's outcome already landed) → the note
    // names when the button returns, not "waiting for your bank's answer".
    expect(html).not.toContain(esc("portal.dunning.retry_cooldown"));
    expect(html).toContain("you can try again from");
    // While the retry IS in flight the bank-answer copy is truthful.
    const inFlight = dunningBannerHtml(bannerInput({ ...view, inFlight: true }));
    expect(inFlight).toContain(esc("portal.dunning.retry_cooldown"));
    // Past the window it is back.
    const later = dunningBannerHtml(
      bannerInput(view, { now: new Date(NOW.getTime() + 61 * 60_000) }),
    );
    expect(later).toContain("/api/payment_retry");
  });

  it("UPDATE_CARD: Update card (payment_update) + Use another card only with ≥2 live methods; retry only when exhausted", () => {
    const view = buildPortalDunningView({
      kase: kaseFixture({
        state: "AWAITING_CUSTOMER",
        nextRetryAt: null,
        declineCode: "EXPIRED_PAYMENT_METHOD",
        declineCategory: "HARD",
      }),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });
    const one = dunningBannerHtml(bannerInput(view, { liveMethodCount: 1 }));
    expect(one).toContain(esc("portal.dunning.state.awaiting_customer"));
    expect(one).toContain("/api/payment_update");
    expect(one).not.toContain(esc("portal.dunning.use_another_card"));
    expect(one).not.toContain("/api/payment_retry");
    expect(one).not.toContain("/api/skip");

    const two = dunningBannerHtml(bannerInput(view, { liveMethodCount: 2 }));
    expect(two).toContain(esc("portal.dunning.use_another_card"));
    expect(two).toContain('href="#cxs-payment"');

    // Revoked primary: no payment_update form (the resolver would refuse) —
    // the Update card CTA points at the payment section instead.
    const revoked = buildPortalDunningView({
      kase: kaseFixture({ state: "AWAITING_CUSTOMER", nextRetryAt: null }),
      contract: contractFixture({ paymentMethodRevokedAt: NOW }),
      attempts: [TRIGGER],
    });
    const html = dunningBannerHtml(bannerInput(revoked));
    expect(html).toContain(esc("portal.dunning.reason.card_removed"));
    expect(html).not.toContain("/api/payment_update");
    expect(html).toContain('href="#cxs-payment"');
    // Revoked primary + exactly ONE other live card: that card is not the
    // primary, so "Use another card" is offered (Stage G review fix — the
    // revoked primary is absent from the live count).
    expect(html).toContain(esc("portal.dunning.use_another_card"));
    expect(dunningBannerHtml(bannerInput(revoked, { liveMethodCount: 0 }))).not.toContain(
      esc("portal.dunning.use_another_card"),
    );

    // Exhausted hard decline: fix the card AND retry.
    const exhausted = buildPortalDunningView({
      kase: kaseFixture({
        state: "EXHAUSTED",
        declineCode: "EXPIRED_PAYMENT_METHOD",
        declineCategory: "HARD",
      }),
      contract: contractFixture({ status: "FAILED" }),
      attempts: [TRIGGER],
    });
    const ex = dunningBannerHtml(bannerInput(exhausted, { status: "FAILED" }));
    expect(ex).toContain("/api/payment_update");
    expect(ex).toContain("/api/payment_retry");
  });

  it("AUTH_REQUIRED / 3DS: Confirm with my bank while a challenge is pending, Retry now otherwise; backup note when on backup", () => {
    const pending = buildPortalDunningView({
      kase: kaseFixture({ state: "AWAITING_3DS", nextRetryAt: null, declineCategory: "AUTH_REQUIRED", declineCode: "AUTHENTICATION_ERROR" }),
      contract: contractFixture({ backupPaymentMethodId: "pm_b", paymentMethodId: "pm_b" }),
      attempts: [
        TRIGGER,
        { id: "att_ch", status: "CHALLENGED", cycleIndex: 4, completedAt: null, shopifyAttemptId: "gid://x/2" } as never,
      ],
    });
    const html = dunningBannerHtml(bannerInput(pending));
    expect(html).toContain(esc("portal.dunning.state.awaiting_3ds"));
    expect(html).toContain("/api/payment_3ds");
    expect(html).toContain(esc("portal.dunning.confirm_bank"));
    expect(html).not.toContain("/api/payment_retry");
    expect(html).toContain(esc("portal.dunning.on_backup"));

    const none = buildPortalDunningView({
      kase: kaseFixture({ state: "AWAITING_3DS", nextRetryAt: null, declineCategory: "AUTH_REQUIRED" }),
      contract: contractFixture(),
      attempts: [TRIGGER],
    });
    const html2 = dunningBannerHtml(bannerInput(none));
    expect(html2).not.toContain("/api/payment_3ds");
    expect(html2).toContain("/api/payment_retry");
  });

  it("never names cancellation and every string is a real en.json key", () => {
    const html = dunningBannerHtml(bannerInput(soft()));
    expect(html.toLowerCase()).not.toContain("cancel");
    for (const key of Object.keys(en).filter((k) => k.startsWith("portal.dunning."))) {
      expect(typeof (en as Record<string, string>)[key]).toBe("string");
    }
  });
});

describe("home ordering + chip inputs", () => {
  it("contracts with a payment issue sort before everything else, ties keep status order", () => {
    const rows = [
      { id: "healthy", status: "ACTIVE", issue: false, rank: 0 },
      { id: "paused", status: "PAUSED", issue: false, rank: 1 },
      { id: "held", status: "ACTIVE", issue: true, rank: 0 },
      { id: "failed", status: "FAILED", issue: true, rank: 2 },
    ];
    rows.sort(
      (a, b) => dunningSortRank(a.issue, a.rank) - dunningSortRank(b.issue, b.rank),
    );
    expect(rows.map((r) => r.id)).toEqual(["held", "failed", "healthy", "paused"]);
  });
});

describe("loaders", () => {
  it("loadPortalDunning: open case wins; FAILED falls back to the newest EXHAUSTED case; healthy → null", async () => {
    mocks.dunningCaseFindFirst
      .mockResolvedValueOnce(null) // no open case
      .mockResolvedValueOnce(kaseFixture({ state: "EXHAUSTED" }));
    mocks.attemptFindUnique.mockResolvedValue(TRIGGER);
    const failed = await loadPortalDunning(contractFixture({ status: "FAILED" }));
    expect(failed?.state).toBe("EXHAUSTED");
    expect(mocks.dunningCaseFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.dunningCaseFindFirst.mock.calls[1][0]).toMatchObject({
      where: { contractId: "cm_1", state: "EXHAUSTED" },
      orderBy: { openedAt: "desc" },
    });

    vi.clearAllMocks();
    mocks.dunningCaseFindFirst.mockResolvedValueOnce(null);
    const active = await loadPortalDunning(contractFixture());
    expect(active).toBeNull();
    expect(mocks.dunningCaseFindFirst).toHaveBeenCalledTimes(1); // no EXHAUSTED lookup for ACTIVE
  });

  it("loadPortalDunningMany: one open-case query for the page, per-contract views, cancelled contracts skipped", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      kaseFixture({ id: "case_a", contractId: "a" }),
    ]);
    mocks.attemptFindUnique.mockResolvedValue(TRIGGER);
    const out = await loadPortalDunningMany([
      contractFixture({ id: "a" }),
      contractFixture({ id: "b" }),
      contractFixture({ id: "c", status: "CANCELLED" }),
    ]);
    expect([...out.keys()]).toEqual(["a"]);
    expect(out.get("a")?.caseId).toBe("case_a");
    const where = (mocks.dunningCaseFindMany.mock.calls[0][0] as { where: { contractId: { in: string[] } } }).where;
    expect(where.contractId.in).toEqual(["a", "b"]);
  });
});

describe("portal.dunning_banner_shown — once per case per window", () => {
  const contract = { id: "cm_1", customerId: "gid://shopify/Customer/1", email: "a@b.c" };
  const view = { caseId: "case_1", state: "RETRYING", ctaGroup: "SOFT" } as const;

  it("logs when no event exists inside the window", async () => {
    const wrote = await logDunningBannerShown({
      shopId: "shop_1",
      contract,
      view,
      surface: "detail",
      windowHours: 6,
      now: NOW,
    });
    expect(wrote).toBe(true);
    expect(mocks.logEvent).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent.mock.calls[0][0]).toMatchObject({
      type: "portal.dunning_banner_shown",
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      contractId: "cm_1",
      payload: { caseId: "case_1", state: "RETRYING", surface: "detail" },
    });
    // The lookup is scoped to this case and the last 6h.
    const where = (mocks.eventFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      contractId: "cm_1",
      type: "portal.dunning_banner_shown",
      payload: { path: ["caseId"], equals: "case_1" },
    });
    expect((where.createdAt as { gte: Date }).gte.getTime()).toBe(
      NOW.getTime() - 6 * 3600_000,
    );
  });

  it("skips when the case was already logged inside the window, and is contained on failure", async () => {
    mocks.eventFindFirst.mockResolvedValueOnce({ id: "ev" });
    expect(
      await logDunningBannerShown({ shopId: "s", contract, view, surface: "home", windowHours: 6, now: NOW }),
    ).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();

    mocks.eventFindFirst.mockRejectedValueOnce(new Error("db down"));
    await expect(
      logDunningBannerShown({ shopId: "s", contract, view, surface: "home", windowHours: 6, now: NOW }),
    ).resolves.toBe(false);
  });
});
