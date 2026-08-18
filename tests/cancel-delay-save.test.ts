import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DELAY save (v1.28.0, P3.3) — "push my next order to {predicted empty date}".
 *
 * Pins:
 *  - TOO_MUCH_PRODUCT leads with DELAY (before SKIP) and the card is offered
 *    ONLY when the churn model's predictedEmptyDate lies after the next
 *    charge (shop-tz days) and within cancelFlow.delaySaveMaxDays; the offer
 *    carries the whole-day count and the exact new date;
 *  - no prediction / prediction before or on the next charge / too far out /
 *    the admin toggle off ⇒ no DELAY card, SKIP leads as before;
 *  - the mode on the card follows portal.delayReanchors (reanchor / once);
 *  - accepting re-derives the mode from settings and applies the SHOWN day
 *    count through delaySchedule (reanchor) or delayNextCycle (once) — never
 *    a day count from the form; a moved next order refuses (the promise was
 *    computed on the old date); the toggle is re-checked at accept;
 *  - the card and the accept are lock-blocked (a delay is a reduction) and
 *    preparing-blocked like SKIP.
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  portal: {} as Record<string, unknown>,
  locked: false,
  claims: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  delaySchedule: vi.fn(async (): Promise<unknown> => ({ ...store.contract, nextBillingDate: new Date("2026-09-15T00:00:00Z") })),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({ ...store.contract, nextBillingDate: new Date("2026-09-15T00:00:00Z") })),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({ ...store.contract })),
  isPreparingOrder: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      findMany: vi.fn(async (): Promise<unknown[]> => [{ id: "c_1" }]),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriberEvent: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.claims.push(args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (): Promise<unknown> => store.session),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") return store.cancelFlow;
    if (key === "portal") return store.portal;
    if (key === "pause") return { maxMonths: 3 };
    if (key === "chargeTiming") return { chargeHourLocal: 0 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 15 })),
}));
vi.mock("~/lib/billing/timing.server", () => ({
  isPreparingOrder: mocks.isPreparingOrder,
  resolveChargeTiming: vi.fn(async (): Promise<unknown> => ({ chargeHourLocal: 0 })),
}));
vi.mock("~/lib/billing/estimate.server", () => ({
  grantDiscountCents: vi.fn(() => 0),
  loadParkedCycleDiscount: vi.fn(async (): Promise<unknown> => null),
  nextCycleIndex: vi.fn(async (): Promise<number> => 4),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: vi.fn(async () => ({})) }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (a: { current: unknown }) => a.current),
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: vi.fn(async () => ({
    locked: store.locked,
    until: store.locked ? new Date("2026-10-01T00:00:00Z") : null,
    lockDays: store.locked ? 60 : 0,
  })),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: vi.fn(async (): Promise<unknown> => ({})),
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
  delayNextCycle: mocks.delayNextCycle,
  delaySchedule: mocks.delaySchedule,
  extendPause: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipLineThisCycle: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  swapPriceCentsFor: vi.fn(async (): Promise<number> => 0),
  CycleLineEditError: class extends Error {},
}));

import { REASONS, LOCK_BLOCKED_SAVES } from "~/lib/cancel/config.server";
import { acceptSave, getSavesForReason, type SaveOffer } from "~/lib/cancel/engine.server";
import { pageSaves } from "~/lib/cancel/pages.server";

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    firstName: "Anna",
    status: "ACTIVE",
    ownership: "OURS",
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 3,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    // Predicted to run out two weeks AFTER the next charge.
    predictedEmptyDate: new Date("2026-09-15T10:00:00Z"),
    lines: [
      {
        id: "l_1",
        title: "Serum",
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        quantity: 1,
        currentPriceCents: 4900,
        isGift: false,
        isOneTimeAddon: false,
        shopifyLineId: "gid://shopify/SubscriptionLine/1",
        skippedCycleIndex: null,
      },
    ],
    ...over,
  };
}

function contract() {
  return store.contract as unknown as Parameters<typeof getSavesForReason>[2];
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "TOO_MUCH_PRODUCT",
    reasonDetail: null,
    savesShown: [],
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claims = [];
  store.locked = false;
  store.contract = contractFixture();
  store.session = sessionFixture();
  store.cancelFlow = {
    enabled: true,
    maxSavesShown: 2,
    frequencySuggestDeltaWeeks: 2,
    pauseSuggestMonths: 2,
    reasonOfferPctDefault: 15,
    reasonOfferCyclesDefault: 2,
    reasonOfferCooldownDays: 90,
    giftSaveEnabled: false,
    giftSaveCooldownDays: 180,
    downsizeSaveEnabled: false,
    delaySaveEnabled: true,
    delaySaveMaxDays: 42,
    sessionFreshMinutes: 60,
  };
  store.portal = { delayReanchors: true, perLineCycleEdits: true };
});

describe("DELAY offer for TOO_MUCH_PRODUCT", () => {
  it("is the reason's lead save, before SKIP", () => {
    expect(REASONS.find((r) => r.key === "TOO_MUCH_PRODUCT")?.savesOrder.slice(0, 2)).toEqual([
      "DELAY",
      "SKIP",
    ]);
  });

  it("offers DELAY first with the whole-day count to the predicted empty day and the exact new date", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.map((o) => o.kind)).toEqual(["DELAY", "SKIP"]);
    const delay = offers[0] as Extract<SaveOffer, { kind: "DELAY" }>;
    expect(delay.days).toBe(14);
    expect(delay.currentNextDate).toBe("2026-09-01T00:00:00.000Z");
    // Sept 1 + 14 shop-tz days = Sept 15 (same clock time — CEST both).
    expect(delay.newNextDate).toBe("2026-09-15T00:00:00.000Z");
    expect(delay.mode).toBe("reanchor");
  });

  it("carries mode once when portal.delayReanchors is off", async () => {
    store.portal = { delayReanchors: false };
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect((offers[0] as { mode: string }).mode).toBe("once");
  });

  it("no prediction ⇒ no DELAY card, SKIP leads", async () => {
    store.contract = contractFixture({ predictedEmptyDate: null });
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers[0].kind).toBe("SKIP");
    expect(offers.some((o) => o.kind === "DELAY")).toBe(false);
  });

  it("prediction on or before the next charge ⇒ no DELAY card", async () => {
    store.contract = contractFixture({ predictedEmptyDate: new Date("2026-09-01T12:00:00Z") });
    let offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY")).toBe(false);
    store.contract = contractFixture({ predictedEmptyDate: new Date("2026-08-20T00:00:00Z") });
    offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY")).toBe(false);
  });

  it("prediction beyond cancelFlow.delaySaveMaxDays ⇒ no DELAY card", async () => {
    store.cancelFlow = { ...store.cancelFlow, delaySaveMaxDays: 10 };
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY")).toBe(false);
    expect(offers[0].kind).toBe("SKIP");
  });

  it("admin toggle cancelFlow.delaySaveEnabled=false hides the card", async () => {
    store.cancelFlow = { ...store.cancelFlow, delaySaveEnabled: false };
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY")).toBe(false);
  });

  it("is preparing-blocked like SKIP and lock-blocked like every reduction", async () => {
    mocks.isPreparingOrder.mockResolvedValueOnce(true);
    let offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY" || o.kind === "SKIP")).toBe(false);
    expect(LOCK_BLOCKED_SAVES.has("DELAY")).toBe(true);
    store.locked = true;
    offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.some((o) => o.kind === "DELAY" || o.kind === "SKIP" || o.kind === "PAUSE")).toBe(false);
  });

  it("renders a card with the date and the mode-truthful copy", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [
        {
          kind: "DELAY",
          currentNextDate: "2026-09-01T00:00:00.000Z",
          newNextDate: "2026-09-15T00:00:00.000Z",
          days: 14,
          mode: "reanchor",
        },
      ],
      tz: "Europe/Zurich",
      currencyCode: "CHF",
      showError: false,
    });
    expect(page.body).toContain('name="kind" value="DELAY"');
    expect(page.body).toContain("Push my next order to September 15, 2026");
    expect(page.body).toContain("every order after it follows from there");
    expect(page.body).not.toContain("cancel.saves.delay");
  });
});

describe("accepting DELAY", () => {
  const shown = {
    kind: "DELAY",
    currentNextDate: "2026-09-01T00:00:00.000Z",
    newNextDate: "2026-09-15T00:00:00.000Z",
    days: 14,
    mode: "reanchor",
  };

  it("applies the SHOWN day count through delaySchedule when the shop re-anchors, records the save", async () => {
    store.session = sessionFixture({ savesShown: [shown] });
    const result = await acceptSave("cs_1", "DELAY", {});
    expect(mocks.delaySchedule).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      { days: 14 },
      expect.objectContaining({ source: "CUSTOMER_PORTAL" }),
    );
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
    expect(store.claims[0]).toEqual(expect.objectContaining({ outcome: "SAVED", saveAccepted: "DELAY" }));
    expect(result.nextBillingDate).toBe("2026-09-15T00:00:00.000Z");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.save_accepted",
        payload: expect.objectContaining({ saveKind: "DELAY" }),
      }),
    );
  });

  it("re-derives the mode at accept: delayReanchors off ⇒ delayNextCycle (this order only)", async () => {
    store.session = sessionFixture({ savesShown: [shown] });
    store.portal = { delayReanchors: false };
    await acceptSave("cs_1", "DELAY", {});
    expect(mocks.delayNextCycle).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      { days: 14 },
      expect.anything(),
    );
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
  });

  it("refuses when DELAY was never offered, when the toggle is off, or when the next order moved", async () => {
    store.session = sessionFixture({ savesShown: [{ kind: "SKIP" }] });
    await expect(acceptSave("cs_1", "DELAY", {})).rejects.toThrow(/never offered/);

    store.session = sessionFixture({ savesShown: [shown] });
    store.cancelFlow = { ...store.cancelFlow, delaySaveEnabled: false };
    await expect(acceptSave("cs_1", "DELAY", {})).rejects.toThrow(/delaySaveEnabled/);
    store.cancelFlow = { ...store.cancelFlow, delaySaveEnabled: true };

    store.contract = contractFixture({ nextBillingDate: new Date("2026-09-08T00:00:00Z") });
    store.session = sessionFixture({ savesShown: [shown] });
    await expect(acceptSave("cs_1", "DELAY", {})).rejects.toThrow(/moved since the offer/);
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
    expect(mocks.delayNextCycle).not.toHaveBeenCalled();
  });

  it("refuses inside the plan lock window (backstop) and while preparing", async () => {
    store.session = sessionFixture({ savesShown: [shown] });
    store.locked = true;
    await expect(acceptSave("cs_1", "DELAY", {})).rejects.toThrow(/lock window/);
    store.locked = false;
    store.session = sessionFixture({ savesShown: [shown] });
    mocks.isPreparingOrder.mockResolvedValueOnce(true);
    await expect(acceptSave("cs_1", "DELAY", {})).rejects.toThrow(/being prepared/);
    expect(mocks.delaySchedule).not.toHaveBeenCalled();
  });
});
