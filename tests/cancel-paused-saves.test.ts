import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PAUSED cancellers get real saves (v1.28.0, Stage D — cancel flow):
 *
 *  - savesOrderFor(): a PAUSED contract walks PAUSED_SAVES_LEAD (PAUSE →
 *    resolves to EXTEND_PAUSE, then FREQUENCY) BEFORE the reason's own order,
 *    deduped; ACTIVE contracts keep the reason's order untouched.
 *  - getSavesForReason on a PAUSED contract offers EXTEND_PAUSE + FREQUENCY
 *    for EVERY reason (within maxSavesShown); the FREQUENCY offer carries
 *    pausedResumeAt and estNextDate = the resume day (the first order after
 *    the hold — resumeContract bills ON it, nothing before).
 *  - The saves page renders the "resume later, slower" card copy for it and
 *    accepting runs changeFrequency on the paused contract (the hold stands).
 *  - Cooldown-style clamps still apply: no extend choices left ⇒ no
 *    EXTEND_PAUSE card, the FREQUENCY card remains.
 *  - The saved page copy for a paused FREQUENCY save never promises a
 *    "next delivery" date other than the resume day.
 *
 * Harness: copied from tests/cancel-paused-exit-ramp.test.ts (real engine +
 * pages over a mocked db and mocked contract services).
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
  changeFrequency: vi.fn(async (): Promise<unknown> => store.contract),
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
    changeFrequency: mocks.changeFrequency,
    changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
    extendPause: mocks.extendPause,
    pauseContract: mocks.pauseContract,
    skipLineThisCycle: mocks.skipLineThisCycle,
    skipNextCycle: mocks.skipNextCycle,
    swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  };
});

import {
  acceptSave,
  getSavesForReason,
  type SaveOffer,
} from "~/lib/cancel/engine.server";
import { pageIntro, pageSaves } from "~/lib/cancel/pages.server";
import {
  PAUSED_SAVES_LEAD,
  REASONS,
  savesOrderFor,
} from "~/lib/cancel/config.server";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import en from "~/lib/i18n/locales/en.json";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

type Freq = Extract<SaveOffer, { kind: "FREQUENCY" }>;

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
const enMap = en as Record<string, string>;

describe("savesOrderFor (config)", () => {
  it("ACTIVE keeps the reason's own order; PAUSED leads with PAUSE (→ EXTEND_PAUSE) + FREQUENCY, deduped", () => {
    expect(PAUSED_SAVES_LEAD).toEqual(["PAUSE", "FREQUENCY"]);
    for (const cfg of REASONS) {
      expect(savesOrderFor(cfg, "ACTIVE")).toBe(cfg.savesOrder);
      const paused = savesOrderFor(cfg, "PAUSED");
      expect(paused.slice(0, 2)).toEqual(["PAUSE", "FREQUENCY"]);
      expect(new Set(paused).size).toBe(paused.length);
      for (const kind of cfg.savesOrder) expect(paused).toContain(kind);
    }
    // TOO_MUCH_PRODUCT: DELAY/SKIP/DOWNSIZE follow the lead instead of leading.
    expect(savesOrderFor(REASONS[0], "PAUSED")).toEqual([
      "PAUSE",
      "FREQUENCY",
      "DELAY",
      "SKIP",
      "DOWNSIZE",
    ]);
  });
});

describe("getSavesForReason on a PAUSED contract", () => {
  it("offers EXTEND_PAUSE then FREQUENCY for every reason — never PAUSE / SKIP / DOWNSIZE", async () => {
    store.contract = pausedFixture();
    store.cancelFlow = { ...store.cancelFlow, maxSavesShown: 2 };
    for (const cfg of REASONS) {
      const offers = await getSavesForReason("shop_1", cfg.key, contract());
      expect(offers.map((o) => o.kind)).toEqual(["EXTEND_PAUSE", "FREQUENCY"]);
    }
  });

  it("the FREQUENCY offer on a paused contract carries pausedResumeAt and estNextDate = the resume day (first order after the hold)", async () => {
    store.contract = pausedFixture();
    const offers = await getSavesForReason("shop_1", "OTHER", contract());
    const freq = offers.find((o): o is Freq => o.kind === "FREQUENCY");
    expect(freq).toBeDefined();
    expect(freq?.pausedResumeAt).toBe(RESUME_AT.toISOString());
    expect(freq?.estNextDate).toBe(RESUME_AT.toISOString());
    expect(freq?.suggestedUnit).toBe("WEEK");
    expect(freq?.suggestedCount).toBe(6); // 4 + frequencySuggestDeltaWeeks(2)
  });

  it("ACTIVE FREQUENCY offers never carry pausedResumeAt (unchanged behaviour)", async () => {
    store.contract = contractFixture();
    const offers = await getSavesForReason("shop_1", "SHIPPING_ISSUES", contract());
    const freq = offers.find((o): o is Freq => o.kind === "FREQUENCY");
    expect(freq).toBeDefined();
    expect(freq?.pausedResumeAt).toBeUndefined();
    expect(freq?.estNextDate).not.toBe(RESUME_AT.toISOString());
  });

  it("no extend choices left (hold already at the maximum) ⇒ no EXTEND_PAUSE card, the FREQUENCY card remains", async () => {
    // maxMonths 3 × 30 = 90 days from PAUSED_AT (Aug 1) = Oct 30; resume Oct 29 → +2w/+4w both beyond.
    store.contract = pausedFixture({ resumeAt: new Date("2026-10-28T22:00:00Z") });
    const offers = await getSavesForReason("shop_1", "OTHER", contract());
    expect(offers.map((o) => o.kind)).not.toContain("EXTEND_PAUSE");
    expect(offers.map((o) => o.kind)).not.toContain("PAUSE");
    expect(offers[0]?.kind).toBe("FREQUENCY");
  });

  it("a PAUSED contract without a resume day gets neither (nothing to extend from; no first-order day to promise)", async () => {
    store.contract = pausedFixture({ resumeAt: null });
    const offers = await getSavesForReason("shop_1", "OTHER", contract());
    expect(offers.map((o) => o.kind)).not.toContain("EXTEND_PAUSE");
    expect(offers.map((o) => o.kind)).not.toContain("FREQUENCY");
    expect(offers.map((o) => o.kind)).not.toContain("PAUSE");
  });
});

describe("saves page + accept for the paused FREQUENCY save", () => {
  it("renders the 'resume later, slower' copy with the resume day and the same accept form", async () => {
    store.contract = pausedFixture();
    const offers = await getSavesForReason("shop_1", "OTHER", contract());
    const html = pageSaves({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      offers,
      tz: TZ,
      currencyCode: "CHF",
      showError: false,
    } as never).body;
    expect(html).toContain(enMap["cancel.saves.frequency_paused.title"]);
    expect(html).toContain("Stay paused until");
    expect(html).toContain("Stay paused until October 1, 2026");
    expect(html).toContain("every 6 weeks instead of every 4 weeks");
    expect(html).not.toContain(enMap["cancel.saves.frequency.title"]);
    expect(html).toContain('name="kind" value="FREQUENCY"');
    // Growth copy never names cancellation.
    for (const key of [
      "cancel.saves.frequency_paused.title",
      "cancel.saves.frequency_paused.desc",
      "cancel.saves.frequency_paused.cta",
      "cancel.saved.frequency_paused",
    ]) {
      expect(enMap[key]).toBeTruthy();
      expect(enMap[key].toLowerCase()).not.toMatch(/cancel/);
    }
  });

  it("acceptSave(FREQUENCY) on a PAUSED contract runs changeFrequency with the offered cadence — the hold is untouched", async () => {
    store.contract = pausedFixture();
    const offers = await getSavesForReason("shop_1", "OTHER", contract());
    store.session = sessionFixture({ reason: "OTHER", savesShown: offers });
    await acceptSave("cs_1", "FREQUENCY", { frequency: { unit: "WEEK", count: 6 } });
    expect(mocks.changeFrequency).toHaveBeenCalledTimes(1);
    expect((mocks.changeFrequency.mock.calls[0] as unknown[])[2]).toEqual({ unit: "WEEK", count: 6 });
    expect(mocks.extendPause).not.toHaveBeenCalled();
    expect(mocks.pauseContract).not.toHaveBeenCalled();
    expect(store.reverts).toBe(0);
  });

  it("the saved page picks the paused copy for a FREQUENCY save on a PAUSED contract (source pin)", () => {
    const src = readSource("app/routes/proxy.cancel.$id.$step.tsx");
    expect(src).toContain('"cancel.saved.frequency_paused"');
    expect(src).toMatch(/contract\.status === "PAUSED" && contract\.resumeAt\s*\?\s*"cancel\.saved\.frequency_paused"/);
    expect(enMap["cancel.saved.frequency_paused"]).toContain("{resumeDate}");
    expect(enMap["cancel.saved.frequency_paused"]).not.toContain("{date}");
  });
});
