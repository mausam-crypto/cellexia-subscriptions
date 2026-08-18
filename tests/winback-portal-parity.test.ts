import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Win-back offer parity in the portal + welcome-back landing (v1.28.0, P3.5).
 *
 *  - deriveCurrentWinbackOffer re-derives the CURRENT offer server-side from
 *    WinbackState + the engine's own events (discount_offered / perk_offered
 *    since cancelledAt, newest first), with the SAME expiry the emailed
 *    one-tap link had (sunset − stage offset + grace days), the settings cap
 *    + stacking clamp for discounts, and the gift truth gate for perks;
 *  - never trusts the form: reactivateWithCurrentOffer feeds the derived
 *    offer (or a plain restart) into reactivateFromWinback;
 *  - /api/reactivate goes through reactivateWithCurrentOffer;
 *  - the landing lists only proven preserved benefits and only the derived
 *    offer, with one Restart form posting to /api/reactivate and returning
 *    to the detail page (toast `restarted`).
 */

const NOW = new Date("2026-09-01T12:00:00Z");
const DAY = 86_400_000;

const settings = {
  enabled: true,
  softTouchOffsetDays: -7,
  perkOffsetDays: 3,
  discountOffsetDays: 21,
  sunsetOffsetDays: 60,
  discountPct: 20,
  discountCycles: 2,
  reactivationBillDelayDays: 3,
  linkGraceDays: 14,
  restartLinkTtlDays: 60,
};

const mocks = vi.hoisted(() => ({
  winbackStateFindUnique: vi.fn(async (): Promise<unknown> => null),
  subscriberEventFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  giftRuleFindFirst: vi.fn(async (): Promise<unknown> => null),
  clamp: vi.fn(async (_s: string, _l: unknown, p: number): Promise<unknown> => ({
    percent: p,
    clamped: false,
    requestedPercent: p,
  })),
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
  reactivateFromWinback: vi.fn(async (): Promise<unknown> => ({ id: "c_1", status: "ACTIVE" })),
  getSetting: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: {
    winbackState: { findUnique: mocks.winbackStateFindUnique },
    subscriberEvent: { findMany: mocks.subscriberEventFindMany },
    giftRule: { findFirst: mocks.giftRuleFindFirst },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: mocks.clamp,
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: mocks.pickGiftForContract,
}));
vi.mock("~/lib/winback/engine.server", () => ({
  reactivateFromWinback: mocks.reactivateFromWinback,
}));

import {
  deriveCurrentWinbackOffer,
  offerExpiresAt,
  offerToReactivateInput,
  reactivateWithCurrentOffer,
} from "~/lib/winback/restart.server";
import {
  welcomeBackHtml,
  welcomeBackOfferLine,
  welcomeBackPreservedLines,
} from "~/lib/winback/welcome-back.server";
import type { RetentionSummary } from "~/lib/cancel/summary.server";
import { t } from "~/lib/i18n/i18n.server";
import { formatMoney } from "~/lib/money";

type Contract = Parameters<typeof deriveCurrentWinbackOffer>[0];

function contract(over: Record<string, unknown> = {}): Contract {
  return {
    id: "c_1",
    shopId: "shop_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    ownership: "OURS",
    isDemo: false,
    status: "CANCELLED",
    locale: "en",
    currencyCode: "CHF",
    ordersCount: 5,
    grandfatheredPricing: false,
    surveyHoldout: null,
    lines: [
      { id: "l1", title: "Renewal Serum", quantity: 1, isGift: false, isOneTimeAddon: false },
      { id: "l2", title: "Night Cream", quantity: 2, isGift: false, isOneTimeAddon: false },
      { id: "l3", title: "Gift mini", quantity: 1, isGift: true, isOneTimeAddon: false },
    ],
    ...over,
  } as unknown as Contract;
}

const state = {
  id: "wb_1",
  contractId: "c_1",
  cancelledAt: new Date("2026-06-01T00:00:00Z"),
  status: "ACTIVE",
  stage: 2,
};

function ev(type: string, daysAgo: number, payload: Record<string, unknown>) {
  return { id: `e_${type}_${daysAgo}`, type, createdAt: new Date(NOW.getTime() - daysAgo * DAY), payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.winbackStateFindUnique.mockResolvedValue(state);
  mocks.subscriberEventFindMany.mockResolvedValue([]);
  mocks.giftRuleFindFirst.mockResolvedValue(null);
  mocks.pickGiftForContract.mockResolvedValue(null);
  mocks.getSetting.mockResolvedValue(settings);
  mocks.clamp.mockImplementation(async (_s: string, _l: unknown, p: number) => ({
    percent: p,
    clamped: false,
    requestedPercent: p,
  }));
});

describe("deriveCurrentWinbackOffer — the same rules and TTLs as the emailed legs", () => {
  it("no WinbackState / not CANCELLED / foreign / demo → no offer (plain restart)", async () => {
    mocks.winbackStateFindUnique.mockResolvedValueOnce(null);
    expect(await deriveCurrentWinbackOffer(contract(), { now: NOW })).toBeNull();
    expect(await deriveCurrentWinbackOffer(contract({ status: "ACTIVE" }), { now: NOW })).toBeNull();
    expect(await deriveCurrentWinbackOffer(contract({ ownership: "OTHER_APP" }), { now: NOW })).toBeNull();
    expect(await deriveCurrentWinbackOffer(contract({ isDemo: true }), { now: NOW })).toBeNull();
  });

  it("reads only offers logged since the state's cancelledAt, newest first", async () => {
    await deriveCurrentWinbackOffer(contract(), { now: NOW });
    const args = mocks.subscriberEventFindMany.mock.calls[0][0] as {
      where: { contractId: string; type: { in: string[] }; createdAt: { gt: Date } };
      orderBy: { createdAt: string };
    };
    expect(args.where.contractId).toBe("c_1");
    expect(args.where.type.in.sort()).toEqual(["winback.discount_offered", "winback.perk_offered"]);
    expect(args.where.createdAt.gt).toEqual(state.cancelledAt);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("an unexpired discount_offered → DISCOUNT with the offered percent, its cycles and the emailed link's expiry", async () => {
    const offered = ev("winback.discount_offered", 10, { percent: 20, cycles: 2 });
    mocks.subscriberEventFindMany.mockResolvedValueOnce([offered]);
    const offer = await deriveCurrentWinbackOffer(contract(), { now: NOW });
    expect(offer).toMatchObject({ kind: "DISCOUNT", percent: 20, cycles: 2, gift: false, stage: 2 });
    // TTL of the discount leg = (sunset 60 − discount 21) + grace 14 = 53 days.
    expect(offer!.expiresAt.getTime()).toBe(offered.createdAt.getTime() + 53 * DAY);
    expect(offerExpiresAt(offered.createdAt, settings as never, 2).getTime()).toBe(
      offered.createdAt.getTime() + 53 * DAY,
    );
    expect(mocks.clamp).toHaveBeenCalledWith("shop_1", expect.any(Array), 20);
  });

  it("re-clamps the discount against the settings cap and the stacking cap; zero headroom = no discount offer", async () => {
    mocks.subscriberEventFindMany.mockResolvedValue([
      ev("winback.discount_offered", 5, { percent: 30, cycles: 2 }),
    ]);
    const capped = await deriveCurrentWinbackOffer(contract(), { now: NOW });
    expect(mocks.clamp).toHaveBeenLastCalledWith("shop_1", expect.any(Array), 20); // min(30, discountPct 20)
    expect(capped?.percent).toBe(20);

    mocks.clamp.mockResolvedValueOnce({ percent: 0, clamped: true, requestedPercent: 20 });
    expect(await deriveCurrentWinbackOffer(contract(), { now: NOW })).toBeNull();
  });

  it("an EXPIRED discount falls back to a still-valid perk; an expired perk yields nothing", async () => {
    // Discount link died at 53 days; perk link lives (60 − 3) + 14 = 71 days.
    mocks.subscriberEventFindMany.mockResolvedValueOnce([
      ev("winback.discount_offered", 54, { percent: 20, cycles: 2 }),
      ev("winback.perk_offered", 65, { gift: true, giftTitle: "Mini serum" }),
    ]);
    mocks.giftRuleFindFirst.mockResolvedValue({
      id: "rule_2",
      name: "Surprise",
      variantId: "gid://shopify/ProductVariant/2",
      variantTitle: "Mini serum",
    });
    const offer = await deriveCurrentWinbackOffer(contract(), { now: NOW });
    expect(offer).toMatchObject({ kind: "GIFT", gift: true, percent: 0, cycles: 0, stage: 1, giftTitle: "Mini serum" });
    expect(offer!.expiresAt.getTime()).toBe(NOW.getTime() - 65 * DAY + 71 * DAY);

    mocks.subscriberEventFindMany.mockResolvedValueOnce([
      ev("winback.perk_offered", 72, { gift: true, giftTitle: "Mini serum" }),
    ]);
    expect(await deriveCurrentWinbackOffer(contract(), { now: NOW })).toBeNull();
  });

  it("gift truth gate: a perk offer only stands when a gift can still be granted (dynamic pick with admin, else the ORDER_INDEX=2 rule)", async () => {
    mocks.subscriberEventFindMany.mockResolvedValue([
      ev("winback.perk_offered", 2, { gift: true, giftTitle: "Mini serum" }),
    ]);
    // Neither pool pick nor fallback rule → nothing to grant → no offer.
    expect(await deriveCurrentWinbackOffer(contract(), { now: NOW, admin: {} as never })).toBeNull();

    mocks.pickGiftForContract.mockResolvedValueOnce({ label: "Travel Set", variantId: "gid://shopify/ProductVariant/9" });
    const picked = await deriveCurrentWinbackOffer(contract(), { now: NOW, admin: {} as never });
    expect(picked).toMatchObject({ kind: "GIFT", giftTitle: "Travel Set" });

    // Without an admin client only the fallback rule can vouch.
    mocks.giftRuleFindFirst.mockResolvedValueOnce({ id: "r", name: "Surprise", variantId: "v", variantTitle: null });
    const viaRule = await deriveCurrentWinbackOffer(contract(), { now: NOW });
    expect(viaRule).toMatchObject({ kind: "GIFT", giftTitle: "Surprise" });
    expect(mocks.pickGiftForContract).toHaveBeenCalledTimes(2); // not called without admin
  });

  it("is contained: a failing read resolves to a plain restart, never a throw", async () => {
    mocks.subscriberEventFindMany.mockRejectedValueOnce(new Error("db down"));
    await expect(deriveCurrentWinbackOffer(contract(), { now: NOW })).resolves.toBeNull();
  });
});

describe("reactivateWithCurrentOffer — never trusts the form", () => {
  it("feeds the derived offer into reactivateFromWinback (discount / gift / plain)", async () => {
    mocks.subscriberEventFindMany.mockResolvedValueOnce([
      ev("winback.discount_offered", 10, { percent: 20, cycles: 2 }),
    ]);
    const c = contract();
    const r1 = await reactivateWithCurrentOffer(c, { source: "CUSTOMER_PORTAL", actor: "customer", now: NOW });
    expect(r1.offer?.kind).toBe("DISCOUNT");
    expect(mocks.reactivateFromWinback).toHaveBeenLastCalledWith(
      "c_1",
      { percent: 20, cycles: 2, gift: false },
      { source: "CUSTOMER_PORTAL", actor: "customer" },
    );

    mocks.subscriberEventFindMany.mockResolvedValueOnce([
      ev("winback.perk_offered", 2, { gift: true, giftTitle: "Mini serum" }),
    ]);
    mocks.giftRuleFindFirst.mockResolvedValueOnce({ id: "r", name: "Surprise", variantId: "v", variantTitle: "Mini serum" });
    await reactivateWithCurrentOffer(c, { source: "CUSTOMER_PORTAL", actor: "customer", now: NOW });
    expect(mocks.reactivateFromWinback).toHaveBeenLastCalledWith(
      "c_1",
      { percent: 0, gift: true },
      { source: "CUSTOMER_PORTAL", actor: "customer" },
    );

    await reactivateWithCurrentOffer(c, { source: "CUSTOMER_PORTAL", actor: "customer", now: NOW });
    expect(mocks.reactivateFromWinback).toHaveBeenLastCalledWith(
      "c_1",
      { percent: 0, gift: false },
      { source: "CUSTOMER_PORTAL", actor: "customer" },
    );
    expect(offerToReactivateInput(null)).toEqual({ percent: 0, gift: false });
  });

  it("the portal /api/reactivate goes through reactivateWithCurrentOffer (no bare percent-0 restart)", () => {
    const src = readFileSync(join(process.cwd(), "app/routes/proxy.api.$action.tsx"), "utf8");
    const at = src.indexOf('case "reactivate":');
    const block = src.slice(at, src.indexOf("case ", at + 20));
    expect(block).toContain("reactivateWithCurrentOffer(contract");
    expect(block).not.toContain("reactivateFromWinback(contract.id, {}");
    expect(block).toContain('return back("restarted")');
  });

  it("both CANCELLED Restart buttons open the welcome-back landing (subscription/:id/restart)", () => {
    for (const file of ["app/routes/proxy._index.tsx", "app/routes/proxy.subscription.$id.tsx"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src).toContain("/subscription/${contract.id}/restart");
    }
  });
});

describe("welcome-back landing content — only what is proven, only the derived offer", () => {
  const summaryBase: RetentionSummary = {
    currencyCode: "CHF",
    perCycleSavingsCents: 1500,
    annualSavingsCents: 19500,
    daysSubscribed: 120,
    ordersCount: 5,
    milestoneCycle: 6,
    nextMilestoneCycle: 6,
    ordersToMilestone: 1,
    nextMilestoneAt: null,
    rewardsUnlocked: true,
    rewardsUnlockDay: 90,
    daysToRewards: 0,
    nextBillingDate: null,
    memberSavingsCents: 4200,
    discountPercent: null,
    discountCyclesRemaining: null,
    giftsReceived: 2,
    lockedPrice: false,
    lockedPriceCents: 9800,
  };

  it("lists routine, price (locked when grandfathered, else saving), kept milestone progress, rewards and gifts", () => {
    const lines = welcomeBackPreservedLines({ locale: "en", contract: contract(), summary: summaryBase });
    expect(lines).toEqual([
      t("en", "portal.welcome_back.routine", { items: "Renewal Serum, 2× Night Cream" }),
      t("en", "portal.welcome_back.price_saving", { saving: formatMoney(1500, "CHF", "en") }),
      t("en", "portal.welcome_back.milestone", { orders: 5, target: 6 }),
      t("en", "portal.welcome_back.rewards"),
      t("en", "portal.welcome_back.gifts_many", { count: 2 }),
    ]);
    const locked = welcomeBackPreservedLines({
      locale: "en",
      contract: contract(),
      summary: { ...summaryBase, lockedPrice: true },
    });
    expect(locked[1]).toBe(t("en", "portal.welcome_back.price_locked", { price: formatMoney(9800, "CHF", "en") }));
    // Nothing proven → nothing rendered (no zero/unknown lines).
    const bare = welcomeBackPreservedLines({
      locale: "en",
      contract: contract({ lines: [] }),
      summary: {
        ...summaryBase,
        perCycleSavingsCents: 0,
        nextMilestoneCycle: null,
        ordersToMilestone: 0,
        rewardsUnlocked: false,
        giftsReceived: 0,
      },
    });
    expect(bare).toEqual([]);
  });

  it("the offer line renders the derived discount / gift with its expiry, and nothing without an offer or a nameable gift", () => {
    const expiresAt = new Date("2026-10-15T12:00:00Z");
    expect(
      welcomeBackOfferLine({
        locale: "en",
        tz: "Europe/Zurich",
        offer: { kind: "DISCOUNT", percent: 20, cycles: 2, gift: false, giftTitle: null, offeredAt: NOW, expiresAt, stage: 2 },
      }),
    ).toContain("20% off your next 2 order(s)");
    expect(
      welcomeBackOfferLine({
        locale: "en",
        tz: "Europe/Zurich",
        offer: { kind: "GIFT", percent: 0, cycles: 0, gift: true, giftTitle: "Mini serum", offeredAt: NOW, expiresAt, stage: 1 },
      }),
    ).toContain("A free Mini serum ships");
    expect(welcomeBackOfferLine({ locale: "en", tz: "Europe/Zurich", offer: null })).toBeNull();
    expect(
      welcomeBackOfferLine({
        locale: "en",
        tz: "Europe/Zurich",
        offer: { kind: "GIFT", percent: 0, cycles: 0, gift: true, giftTitle: null, offeredAt: NOW, expiresAt, stage: 1 },
      }),
    ).toBeNull();
  });

  it("renders one Restart form → /api/reactivate with contractId, CSRF and return_to = the detail page; no offer block when there is none", () => {
    const html = welcomeBackHtml({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract(),
      summary: summaryBase,
      offer: null,
      firstBillAt: new Date("2026-09-04T12:00:00Z"),
      csrf: "csrf_1",
      apiUrl: "/apps/cellexia-subs/api/reactivate?locale=en",
      returnTo: "/subscription/c_1",
      backHref: "/apps/cellexia-subs/subscription/c_1?locale=en",
    });
    expect(html).toContain('action="/apps/cellexia-subs/api/reactivate?locale=en"');
    expect(html).toContain('name="contractId" value="c_1"');
    expect(html).toContain('name="_csrf" value="csrf_1"');
    expect(html).toContain('name="return_to" value="/subscription/c_1"');
    expect((html.match(/<form /g) ?? []).length).toBe(1);
    expect(html).toContain(t("en", "portal.actions.restart"));
    expect(html).toContain(t("en", "portal.welcome_back.no_commitment"));
    expect(html).not.toContain("cxs-welcome__offer");
    // Portal DOM namespace: cxs- only, never a bare cx- class.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);

    const withOffer = welcomeBackHtml({
      locale: "en",
      tz: "Europe/Zurich",
      contract: contract(),
      summary: summaryBase,
      offer: { kind: "DISCOUNT", percent: 20, cycles: 2, gift: false, giftTitle: null, offeredAt: NOW, expiresAt: new Date("2026-10-15T12:00:00Z"), stage: 2 },
      firstBillAt: new Date("2026-09-04T12:00:00Z"),
      csrf: "csrf_1",
      apiUrl: "/apps/cellexia-subs/api/reactivate",
      returnTo: "/subscription/c_1",
      backHref: "/apps/cellexia-subs/subscription/c_1",
    });
    expect(withOffer).toContain('data-cellexia-offer="discount"');
    expect(withOffer).toContain("20% off your next 2 order(s)");
  });
});
