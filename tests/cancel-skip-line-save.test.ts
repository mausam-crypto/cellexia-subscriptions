import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cancel flow — "Skip just {product}" on the SKIP save card (v1.28.0, P2.5).
 *
 *  - TOO_MUCH_PRODUCT on a multi-product subscription: the SKIP offer carries
 *    the recurring lines (id + title) so the card renders one secondary
 *    button per product; single-line contracts and other reasons carry none;
 *  - acceptSave("SKIP", { lineId }) executes skipLineThisCycle (never the
 *    whole-order skip) with the save-flow source, value-gated to a line the
 *    card actually offered; without lineId it is the whole-order skip as
 *    before; the confirmation carries skippedLineTitle;
 *  - the saves page renders the per-line buttons posting kind=SKIP + lineId.
 *
 * Drives the REAL getSavesForReason / acceptSave / pageSaves over a mocked db
 * (tests/cancel-downsize-save.test.ts harness).
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  claims: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  skipNextCycle: vi.fn(async (): Promise<unknown> => store.contract),
  skipLineThisCycle: vi.fn(async (): Promise<unknown> => store.contract),
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
    if (key === "pause") return { maxMonths: 3 };
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
vi.mock("~/lib/contracts/service.server", () => ({
  swapPriceCentsFor: vi.fn(async () => 0),
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: vi.fn(async (): Promise<unknown> => ({})),
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipLineThisCycle: mocks.skipLineThisCycle,
  skipNextCycle: mocks.skipNextCycle,
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
}));

import {
  acceptSave,
  getSavesForReason,
  type SaveOffer,
} from "~/lib/cancel/engine.server";
import { pageSaves } from "~/lib/cancel/pages.server";
import en from "~/lib/i18n/locales/en.json";

type Skip = Extract<SaveOffer, { kind: "SKIP" }>;

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
    skippedCycleIndex: null,
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
    lines: [
      line(),
      line({ id: "l2", shopifyLineId: "gid://shopify/SubscriptionLine/2", variantId: "gid://shopify/ProductVariant/22", title: "Cream" }),
      line({ id: "gift", isGift: true, shopifyLineId: "gid://shopify/SubscriptionLine/g", title: "Gift" }),
      line({ id: "addon", isOneTimeAddon: true, shopifyLineId: "gid://shopify/SubscriptionLine/a", title: "Addon" }),
    ],
    ...over,
  };
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
  store.contract = contractFixture();
  store.session = sessionFixture();
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

describe("SKIP offer — per-line lines", () => {
  it("TOO_MUCH_PRODUCT + several recurring products → the SKIP offer carries the recurring lines only", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    const skip = offers.find((o) => o.kind === "SKIP") as Skip;
    expect(skip.lines).toEqual([
      { lineId: "l1", title: "Serum" },
      { lineId: "l2", title: "Cream" },
    ]);
  });

  it("single recurring product / other reasons → no per-line option (whole-order skip only)", async () => {
    store.contract = contractFixture({ lines: [line()] });
    let offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect((offers.find((o) => o.kind === "SKIP") as Skip).lines).toBeUndefined();

    store.contract = contractFixture();
    offers = await getSavesForReason("shop_1", "OTHER", contract());
    const skip = offers.find((o) => o.kind === "SKIP") as Skip | undefined;
    if (skip) expect(skip.lines).toBeUndefined();
  });
});

describe("acceptSave SKIP with lineId", () => {
  async function shownSkip(): Promise<Skip> {
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    return offers.find((o) => o.kind === "SKIP") as Skip;
  }

  it("executes skipLineThisCycle for an offered line, never the whole-order skip", async () => {
    const card = await shownSkip();
    store.session = sessionFixture({ savesShown: [card] });
    const confirmation = await acceptSave("cs_1", "SKIP", { lineId: "l2" });
    expect(mocks.skipLineThisCycle).toHaveBeenCalledTimes(1);
    expect(mocks.skipLineThisCycle.mock.calls[0].slice(0, 3)).toEqual([
      "cellexia.myshopify.com",
      "c_1",
      "l2",
    ]);
    expect((mocks.skipLineThisCycle.mock.calls[0] as unknown[])[3]).toMatchObject({
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
    expect(confirmation.kind).toBe("SKIP");
    expect(confirmation.skippedLineTitle).toBe("Cream");
    const accepted = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .find((e) => e.type === "cancel.save_accepted");
    expect(accepted?.payload).toMatchObject({ saveKind: "SKIP", lineId: "l2", perLine: true, skippedLineTitle: "Cream" });
  });

  it("refuses a lineId the card never offered (crafted POST) and reverts the claim", async () => {
    const card = await shownSkip();
    store.session = sessionFixture({ savesShown: [{ ...card, lines: [{ lineId: "l1", title: "Serum" }] }] });
    await expect(acceptSave("cs_1", "SKIP", { lineId: "l2" })).rejects.toThrow(/not offered/);
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
  });

  it("without lineId the SKIP save is the whole-order skip, exactly as before", async () => {
    const card = await shownSkip();
    store.session = sessionFixture({ savesShown: [card] });
    const confirmation = await acceptSave("cs_1", "SKIP", {});
    expect(mocks.skipNextCycle).toHaveBeenCalledTimes(1);
    expect(mocks.skipLineThisCycle).not.toHaveBeenCalled();
    expect(confirmation.skippedLineTitle).toBeUndefined();
  });
});

describe("saves page", () => {
  it("renders one 'Skip just {product}' secondary button per offered line, posting kind=SKIP + lineId", () => {
    const page = pageSaves({
      locale: "en",
      csrf: "csrf",
      contractId: "c_1",
      reason: "TOO_MUCH_PRODUCT",
      offers: [
        {
          kind: "SKIP",
          currentNextDate: "2026-09-01T00:00:00.000Z",
          newNextDate: "2026-09-29T00:00:00.000Z",
          lines: [
            { lineId: "l1", title: "Serum" },
            { lineId: "l2", title: "Cream" },
          ],
        },
      ],
      tz: "Europe/Zurich",
      showError: false,
      finalOfferEligible: false,
    } as never);
    const html = page.body;
    expect(html).toContain("Skip just Serum");
    expect(html).toContain("Skip just Cream");
    expect(html).toContain('name="lineId" value="l2"');
    expect(html).toContain((en as Record<string, string>)["cancel.saves.skip.line_hint"]);
    // The whole-order CTA stays primary and first.
    expect(html.indexOf("Skip my next delivery")).toBeLessThan(html.indexOf("Skip just Serum"));
    // Growth copy never names cancellation on the save cards themselves.
    expect((en as Record<string, string>)["cancel.saves.skip.line_cta"]).not.toMatch(/cancel/i);
    expect((en as Record<string, string>)["cancel.saved.skip_line"]).not.toMatch(/cancel/i);
  });
});
