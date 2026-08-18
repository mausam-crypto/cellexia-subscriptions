import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cancel flow on already-PAUSED contracts + per-line SKIP hardening
 * (v1.28.0 Stage D review fixes).
 *
 *  - A PAUSED contract never sees / records a no-op "Pause instead": the
 *    intro renders the exit ramp ("extend my break until {date}") from the
 *    portal's pauseExtendChoices, and acceptSave refuses PAUSE on a PAUSED
 *    contract BEFORE anything is closed as SAVED (claim reverted).
 *  - EXTEND_PAUSE is a real save: offered in PAUSE's slot on PAUSED
 *    contracts, executed through extendPause with the exact offered day,
 *    value-gated to an offered choice, refused on non-PAUSED contracts.
 *  - The per-line SKIP option honours portal.perLineCycleEdits and never
 *    offers a line already "not this time" for the upcoming cycle; a
 *    LAST_LINE refusal falls back to the whole-order skip.
 *
 * Harness: tests/cancel-skip-line-save.test.ts (real engine + pages over a
 * mocked db and mocked contract services).
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  portal: {} as Record<string, unknown>,
  claims: [] as Array<Record<string, unknown>>,
  reverts: 0,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  skipNextCycle: vi.fn(async (): Promise<unknown> => store.contract),
  skipLineThisCycle: vi.fn(async (): Promise<unknown> => store.contract),
  pauseContract: vi.fn(async (): Promise<unknown> => store.contract),
  extendPause: vi.fn(async (): Promise<unknown> => store.contract),
  attemptFindFirst: vi.fn(async (): Promise<unknown> => null),
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
    billingAttempt: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: mocks.attemptFindFirst,
    },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.claims.push(args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        if (args.data.outcome === null) store.reverts += 1;
        return store.session;
      }),
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") return store.cancelFlow;
    if (key === "pause") return { maxMonths: 3 };
    if (key === "portal") return store.portal;
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 6 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 15,
    clamped: false,
    requestedPercent: 15,
  })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
}));
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
  resolveLockState: vi.fn(async () => ({ locked: false, until: null })),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("~/lib/contracts/service.server", () => {
  class CycleLineEditError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "CycleLineEditError";
      this.code = code;
    }
  }
  return {
    CycleLineEditError,
    swapPriceCentsFor: vi.fn(async () => 0),
    applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
    cancelContract: vi.fn(async (): Promise<unknown> => ({})),
    changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
    changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
    extendPause: mocks.extendPause,
    pauseContract: mocks.pauseContract,
    skipLineThisCycle: mocks.skipLineThisCycle,
    skipNextCycle: mocks.skipNextCycle,
    swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  };
});

import { CycleLineEditError } from "~/lib/contracts/service.server";
import {
  acceptSave,
  getSavesForReason,
  type SaveOffer,
} from "~/lib/cancel/engine.server";
import { pageIntro, pageSaves } from "~/lib/cancel/pages.server";
import { SAVE_KINDS } from "~/lib/cancel/config.server";
import { pauseExtendChoices } from "~/lib/portal/flex.server";
import en from "~/lib/i18n/locales/en.json";

type Skip = Extract<SaveOffer, { kind: "SKIP" }>;
type Extend = Extract<SaveOffer, { kind: "EXTEND_PAUSE" }>;

const TZ = "Europe/Zurich";
const PAUSED_AT = new Date("2026-08-01T10:00:00Z");
const RESUME_AT = new Date("2026-09-30T22:00:00Z"); // 2026-10-01 00:00 Zurich

function line(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    contractId: "c_1",
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/11",
    title: "Serum",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 2,
    currentPriceCents: 4000,
    compareAtPriceCents: 5000,
    unitCostCents: null,
    isGift: false,
    isOneTimeAddon: false,
    addedVia: null,
    addonCycleIndex: null,
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    currencyCode: "CHF",
    grandfatheredPricing: false,
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 3,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    pausedAt: null,
    resumeAt: null,
    lines: [
      line(),
      line({ id: "l2", shopifyLineId: "gid://shopify/SubscriptionLine/2", variantId: "gid://shopify/ProductVariant/22", title: "Cream" }),
    ],
    ...over,
  };
}

function pausedFixture(over: Record<string, unknown> = {}) {
  return contractFixture({ status: "PAUSED", pausedAt: PAUSED_AT, resumeAt: RESUME_AT, ...over });
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "TOO_MUCH_PRODUCT",
    reasonDetail: null,
    savesShown: null,
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claims = [];
  store.reverts = 0;
  store.contract = contractFixture();
  store.session = sessionFixture();
  store.portal = { perLineCycleEdits: true, pauseExtendChoicesWeeks: [2, 4] };
  store.cancelFlow = {
    enabled: true,
    maxSavesShown: 3,
    frequencySuggestDeltaWeeks: 2,
    pauseSuggestMonths: 2,
    reasonOfferPctDefault: 15,
    reasonOfferCyclesDefault: 2,
    reasonOfferCooldownDays: 90,
    giftSaveEnabled: false,
    giftSaveCooldownDays: 180,
    downsizeSaveEnabled: false,
    sessionFreshMinutes: 60,
  };
});

const contract = () => store.contract as unknown as Parameters<typeof getSavesForReason>[2];

describe("PAUSED contracts in the cancel flow", () => {
  it("EXTEND_PAUSE is a save kind; the intro renders the exit ramp instead of the one-tap pause", () => {
    expect(SAVE_KINDS).toContain("EXTEND_PAUSE");
    const choices = pauseExtendChoices({
      resumeAt: RESUME_AT,
      pausedAt: PAUSED_AT,
      weeks: [2, 4],
      maxMonths: 3,
      tz: TZ,
    });
    expect(choices.map((c) => c.weeks)).toEqual([2, 4]);
    const page = pageIntro({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      firstName: "Ana",
      summary: {
        nextBillingDate: null,
        tenureDays: 30,
        ordersCount: 3,
        yearlySavingsCents: 0,
        currencyCode: "CHF",
      } as never,
      tz: TZ,
      copyVariant: "a",
      pauseMonths: 2,
      showError: false,
      paused: { resumeAt: RESUME_AT, choices },
    });
    expect(page.body).toContain('name="intent" value="extend_pause"');
    expect(page.body).toContain('name="weeks" value="2"');
    expect(page.body).toContain('name="weeks" value="4"');
    expect(page.body).not.toContain('name="intent" value="pause"');
    expect(page.body).toContain("Your subscription is paused until");
    // Continue-to-cancel keeps its equal-weight full-size button.
    expect(page.body).toContain('name="intent" value="continue"');
    // Every copy string exists in the master catalog.
    for (const key of [
      "cancel.intro.paused_note",
      "cancel.intro.extend_pause_cta",
      "cancel.saves.extend_pause.title",
      "cancel.saves.extend_pause.desc",
      "cancel.saves.extend_pause.cta",
      "cancel.saved.extend_pause",
    ]) {
      expect((en as Record<string, string>)[key]).toBeTruthy();
    }
  });

  it("acceptSave(PAUSE) on a PAUSED contract is refused BEFORE anything is closed as SAVED — claim reverted, no service call", async () => {
    store.contract = pausedFixture();
    await expect(acceptSave("cs_1", "PAUSE", { months: 2 })).rejects.toThrow(/already paused/);
    expect(mocks.pauseContract).not.toHaveBeenCalled();
    expect(store.claims).toHaveLength(1); // the atomic claim …
    expect(store.reverts).toBe(1); // … was reverted
    expect(
      mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type),
    ).not.toContain("cancel.save_accepted");
  });

  it("getSavesForReason offers EXTEND_PAUSE (never PAUSE) in PAUSE's slot on a PAUSED contract, with the portal's choices", async () => {
    store.contract = pausedFixture();
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).not.toContain("PAUSE");
    const extend = offers.find((o) => o.kind === "EXTEND_PAUSE") as Extend;
    expect(extend).toBeTruthy();
    expect(extend.currentResumeAt).toBe(RESUME_AT.toISOString());
    expect(extend.choices.map((c) => c.weeks)).toEqual([2, 4]);
    // The card renders one button per choice posting kind=EXTEND_PAUSE + weeks.
    const page = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers,
      tz: TZ,
      currencyCode: "CHF",
      showError: false,
    } as never);
    expect(page.body).toContain('name="kind" value="EXTEND_PAUSE"');
    expect(page.body).toContain('name="weeks" value="2"');
    expect(page.body).toContain("Need a little longer?");
  });

  it("the saves page names the cycle-edits refusal (ContractEditBlockedError → ?error=cycle_edits) instead of the generic error", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [],
      tz: TZ,
      currencyCode: "CHF",
      showError: true,
      errorKind: "cycle_edits",
    } as never);
    expect(page.body).toContain((en as Record<string, string>)["portal.toast.cycle_edits_pending"].slice(0, 40));
    const generic = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers: [],
      tz: TZ,
      currencyCode: "CHF",
      showError: true,
    } as never);
    expect(generic.body).toContain((en as Record<string, string>)["cancel.error.generic"]);
  });

  it("no choices left (hold already at the maximum) ⇒ no EXTEND_PAUSE card, and still no PAUSE card", async () => {
    // pausedAt + 90 days = 2026-10-30; resumeAt already there ⇒ nothing to extend to.
    store.contract = pausedFixture({ resumeAt: new Date("2026-10-29T22:00:00Z") });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).not.toContain("PAUSE");
    expect(offers.map((o) => o.kind)).not.toContain("EXTEND_PAUSE");
  });

  it("acceptSave(EXTEND_PAUSE, { weeks }) executes extendPause with the exact offered day (save-flow source); other weeks refused", async () => {
    store.contract = pausedFixture();
    const confirmation = await acceptSave("cs_1", "EXTEND_PAUSE", { weeks: 2 });
    expect(mocks.extendPause).toHaveBeenCalledTimes(1);
    const [domain, id, day, opts] = mocks.extendPause.mock.calls[0] as unknown[];
    expect(domain).toBe("cellexia.myshopify.com");
    expect(id).toBe("c_1");
    expect((day as Date).toISOString()).toBe(
      pauseExtendChoices({ resumeAt: RESUME_AT, pausedAt: PAUSED_AT, weeks: [2, 4], maxMonths: 3, tz: TZ })[0]
        .resumeAt.toISOString(),
    );
    expect(opts).toMatchObject({ source: "CUSTOMER_PORTAL" });
    expect(confirmation.kind).toBe("EXTEND_PAUSE");
    expect(store.claims[0]).toMatchObject({ outcome: "SAVED", saveAccepted: "EXTEND_PAUSE" });

    vi.clearAllMocks();
    store.session = sessionFixture();
    await expect(acceptSave("cs_1", "EXTEND_PAUSE", { weeks: 9 })).rejects.toThrow(/not an offered choice/);
    expect(mocks.extendPause).not.toHaveBeenCalled();
  });

  it("acceptSave(EXTEND_PAUSE) on an ACTIVE contract is refused", async () => {
    await expect(acceptSave("cs_1", "EXTEND_PAUSE", { weeks: 2 })).rejects.toThrow(/not paused/);
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(store.reverts).toBe(1);
  });
});

describe("per-line SKIP option hardening", () => {
  it("does not offer a line already 'not this time' for the upcoming cycle", async () => {
    // ordersCount 3 ⇒ upcoming cycle 4; Serum already skipped for it.
    store.contract = contractFixture({
      lines: [
        line({ skippedCycleIndex: 4 }),
        line({ id: "l2", shopifyLineId: "gid://shopify/SubscriptionLine/2", variantId: "gid://shopify/ProductVariant/22", title: "Cream" }),
        line({ id: "l3", shopifyLineId: "gid://shopify/SubscriptionLine/3", variantId: "gid://shopify/ProductVariant/33", title: "Mask" }),
      ],
    });
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    const skip = offers.find((o) => o.kind === "SKIP") as Skip;
    expect(skip.lines?.map((l) => l.lineId)).toEqual(["l2", "l3"]);
  });

  it("honours the merchant switch portal.perLineCycleEdits = false (whole-order skip only)", async () => {
    store.portal = { perLineCycleEdits: false };
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    const skip = offers.find((o) => o.kind === "SKIP") as Skip;
    expect(skip.lines).toBeUndefined();
  });

  it("a LAST_LINE refusal from the service falls back to the whole-order skip (the honest save)", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    const card = offers.find((o) => o.kind === "SKIP") as Skip;
    store.session = sessionFixture({ savesShown: [card] });
    mocks.skipLineThisCycle.mockRejectedValueOnce(
      new CycleLineEditError("LAST_LINE", "would empty the cycle"),
    );
    const confirmation = await acceptSave("cs_1", "SKIP", { lineId: "l2" });
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
    expect(confirmation.skippedLineTitle).toBeUndefined();
    expect(store.claims[0]).toMatchObject({ outcome: "SAVED", saveAccepted: "SKIP" });

    // Any other typed refusal still surfaces (no silent whole-order skip).
    vi.clearAllMocks();
    store.session = sessionFixture({ savesShown: [card] });
    mocks.skipLineThisCycle.mockRejectedValueOnce(
      new CycleLineEditError("NO_SHOPIFY_LINE", "resync first"),
    );
    await expect(acceptSave("cs_1", "SKIP", { lineId: "l2" })).rejects.toThrow(/resync/);
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });
});
