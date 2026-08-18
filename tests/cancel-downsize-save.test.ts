import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DOWNSIZE save (v1.28.0) + the one-pricing-helper swap fix.
 *
 * Pins:
 *  - reason ordering: TOO_EXPENSIVE leads with DOWNSIZE (before PAUSE and
 *    DISCOUNT), TOO_MUCH_PRODUCT places it right after SKIP — both inside the
 *    default maxSavesShown cap, so the card is never silently cut;
 *  - options: fewer units → smaller/cheaper variant of the same product
 *    (price ascending, strictly cheaper only) → cheaper product from the
 *    same catalog group; every option carries the concrete new per-order
 *    total computed with the service's swapPriceCentsFor;
 *  - the card is skipped (not an empty promise) when nothing is cheaper or
 *    the merchant toggle is off — DISCOUNT then fills the cap;
 *  - SWAP options carry EXACTLY the price swapPriceCentsFor returns (the
 *    price swapLineVariant applies), sorted ascending — grandfathered
 *    same-product swaps show the line's own price;
 *  - accept executes through the contract service (changeLineQuantity /
 *    swapLineVariant) with the save-flow source, value-gated to the shown
 *    option, and logs cancel.save_accepted.
 *
 * Drives the REAL getSavesForReason / acceptSave / swapPriceCentsFor over a
 * mocked db (tests/aud-portal-cancel-reason.test.ts mock style).
 */

const PRODUCT_1 = "gid://shopify/Product/1";
const PRODUCT_2 = "gid://shopify/Product/2";
const PRODUCT_3 = "gid://shopify/Product/3";
const V11 = "gid://shopify/ProductVariant/11"; // current: 50ml, 50.00 catalog
const V12 = "gid://shopify/ProductVariant/12"; // 30ml, 30.00 catalog
const V13 = "gid://shopify/ProductVariant/13"; // 100ml, 80.00 catalog
const V21 = "gid://shopify/ProductVariant/21"; // Cleanser, 25.00 catalog
const V31 = "gid://shopify/ProductVariant/31"; // Mask (other group), 10.00

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  configs: [] as Array<Record<string, unknown>>,
  catalog: [] as Array<Record<string, unknown>>,
  siblings: [] as Array<Record<string, unknown>>,
  claims: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => store.contract),
  swapLineVariant: vi.fn(async (): Promise<unknown> => store.contract),
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
    sellingPlanConfig: {
      findMany: vi.fn(async (): Promise<unknown[]> => store.configs),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      findMany: vi.fn(async (): Promise<unknown[]> => [{ id: "c_1" }]),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    discountGrant: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    giftGrant: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      updateMany: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          store.claims.push(args.data);
          return { count: 1 };
        },
      ),
      update: vi.fn(async (): Promise<unknown> => store.session),
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") return store.cancelFlow;
    if (key === "pause") return { maxMonths: 3 };
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
  gql: vi.fn(async (_admin: unknown, query: string): Promise<unknown> => {
    if (query.includes("CellexiaCancelSwapSiblings")) {
      return {
        product: {
          id: PRODUCT_1,
          title: "Serum",
          variants: { nodes: store.siblings },
        },
      };
    }
    return {};
  }),
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
  getPortalCatalog: vi.fn(async (): Promise<unknown> => store.catalog),
}));
// The REAL swapPriceCentsFor (the one rule) over the mocked db; the mutating
// services are spies.
vi.mock("~/lib/contracts/service.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/lib/contracts/service.server")
  >("~/lib/contracts/service.server");
  return {
    swapPriceCentsFor: actual.swapPriceCentsFor,
    applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
    cancelContract: vi.fn(async (): Promise<unknown> => ({})),
    changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
    changeLineQuantity: mocks.changeLineQuantity,
    pauseContract: vi.fn(async (): Promise<unknown> => ({})),
    skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
    swapLineVariant: mocks.swapLineVariant,
  };
});

import { applyDiscountPct } from "~/lib/money";
import { swapPriceCentsFor } from "~/lib/contracts/service.server";
import { REASONS } from "~/lib/cancel/config.server";
import {
  acceptSave,
  getSavesForReason,
  type SaveOffer,
} from "~/lib/cancel/engine.server";

type Downsize = Extract<SaveOffer, { kind: "DOWNSIZE" }>;
type Swap = Extract<SaveOffer, { kind: "SWAP" }>;

function line(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    contractId: "c_1",
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    productId: PRODUCT_1,
    variantId: V11,
    title: "Serum",
    variantTitle: "50ml",
    sku: null,
    imageUrl: null,
    quantity: 2,
    currentPriceCents: 4000, // 50.00 catalog at 20% ongoing discount
    compareAtPriceCents: 5000,
    unitCostCents: null,
    isGift: false,
    isOneTimeAddon: false,
    addedVia: null,
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
    lines: [line()],
    ...over,
  };
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "TOO_EXPENSIVE",
    reasonDetail: null,
    savesShown: null,
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

function siblingsFixture() {
  return [
    { id: V11, title: "50ml", availableForSale: true, price: "50.00", image: null },
    { id: V13, title: "100ml", availableForSale: true, price: "80.00", image: null },
    { id: V12, title: "30ml", availableForSale: true, price: "30.00", image: null },
    // Unavailable siblings never appear.
    { id: "gid://shopify/ProductVariant/14", title: "OOS", availableForSale: false, price: "1.00", image: null },
  ];
}

function catalogFixture() {
  return [
    {
      id: PRODUCT_1,
      title: "Serum",
      imageUrl: null,
      variants: [{ id: V11, title: "50ml", priceCents: 5000, availableForSale: true }],
    },
    {
      id: PRODUCT_2,
      title: "Cleanser",
      imageUrl: "https://cdn/cleanser.png",
      variants: [
        { id: V21, title: "Default Title", priceCents: 2500, availableForSale: true },
        { id: "gid://shopify/ProductVariant/22", title: "XL", priceCents: 9000, availableForSale: true },
      ],
    },
    {
      // Not in the line's selling-plan group → never offered.
      id: PRODUCT_3,
      title: "Mask",
      imageUrl: null,
      variants: [{ id: V31, title: "Default Title", priceCents: 1000, availableForSale: true }],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claims = [];
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
    downsizeSaveEnabled: true,
    sessionFreshMinutes: 60,
  };
  store.configs = [
    {
      id: "spc_1",
      shopId: "shop_1",
      active: true,
      ongoingDiscountPct: 20,
      productIds: [PRODUCT_1, PRODUCT_2],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  store.catalog = catalogFixture();
  store.siblings = siblingsFixture();
});

const contract = () => store.contract as unknown as Parameters<typeof getSavesForReason>[2];

// ── Ordering per reason ──────────────────────────────────────────────────────

describe("DOWNSIZE ordering per reason", () => {
  it("TOO_EXPENSIVE: DOWNSIZE leads, PAUSE follows, DISCOUNT falls outside the default cap", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).toEqual(["DOWNSIZE", "PAUSE"]);
  });

  it("TOO_MUCH_PRODUCT: DOWNSIZE sits right after SKIP", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", contract());
    expect(offers.map((o) => o.kind)).toEqual(["SKIP", "DOWNSIZE"]);
  });

  it("the config places DOWNSIZE inside the default cap for both reasons", () => {
    // TOO_EXPENSIVE leads with it; TOO_MUCH_PRODUCT places it right after
    // SKIP — behind DELAY (v1.28.0, P3.3), which only renders when the churn
    // model knows a run-out day after the next charge, so DOWNSIZE still
    // sits inside the default cap whenever DELAY does not apply.
    expect(REASONS.find((r) => r.key === "TOO_EXPENSIVE")!.savesOrder.indexOf("DOWNSIZE")).toBe(0);
    const surplus = REASONS.find((r) => r.key === "TOO_MUCH_PRODUCT")!.savesOrder;
    expect(surplus.indexOf("DOWNSIZE")).toBe(surplus.indexOf("SKIP") + 1);
    expect(surplus.filter((k) => k !== "DELAY").indexOf("DOWNSIZE")).toBeLessThan(2);
    // No other reason offers it — a "not seeing results" subscriber is not
    // answered with "buy less".
    for (const cfg of REASONS) {
      if (cfg.key === "TOO_EXPENSIVE" || cfg.key === "TOO_MUCH_PRODUCT") continue;
      expect(cfg.savesOrder).not.toContain("DOWNSIZE");
    }
  });

  it("merchant toggle off → no DOWNSIZE card; DISCOUNT fills the cap", async () => {
    store.cancelFlow = { ...store.cancelFlow, downsizeSaveEnabled: false };
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).toEqual(["PAUSE", "DISCOUNT"]);
  });

  it("nothing cheaper (qty 1, no cheaper sibling, no group product) → card skipped, never empty", async () => {
    store.contract = contractFixture({ lines: [line({ quantity: 1 })] });
    store.siblings = [
      { id: V11, title: "50ml", availableForSale: true, price: "50.00", image: null },
      { id: V13, title: "100ml", availableForSale: true, price: "80.00", image: null },
    ];
    store.catalog = [];
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).toEqual(["PAUSE", "DISCOUNT"]);
  });

  it("a paused contract is not offered a downsize (nothing to make lighter)", async () => {
    store.contract = contractFixture({ status: "PAUSED" });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    expect(offers.map((o) => o.kind)).not.toContain("DOWNSIZE");
  });
});

// ── Options computed ─────────────────────────────────────────────────────────

describe("DOWNSIZE options", () => {
  it("fewer units → smaller variant → cheaper group product, each with the concrete new total", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.kind).toBe("DOWNSIZE");
    expect(card.lineId).toBe("l1");
    expect(card.currentTotalCents).toBe(8000); // 2 × 40.00
    expect(card.currencyCode).toBe("CHF");
    expect(card.options.map((o) => o.mode)).toEqual(["QUANTITY", "VARIANT", "PRODUCT"]);

    const [qty, variant, product] = card.options;
    // (a) quantity − 1 at the line's own price
    expect(qty.quantity).toBe(1);
    expect(qty.unitPriceCents).toBe(4000);
    expect(qty.newTotalCents).toBe(4000);
    // (b) 30ml at 20% off catalog 30.00 = 24.00; the 100ml (64.00) is more
    //     expensive than today and never offered
    expect(variant.variantId).toBe(V12);
    expect(variant.unitPriceCents).toBe(applyDiscountPct(3000, 20));
    expect(variant.newTotalCents).toBe(applyDiscountPct(3000, 20) * 2);
    // (c) Cleanser (same selling-plan group) at 20% off 25.00 = 20.00; the
    //     Mask (other group) and Cleanser XL (dearer) never appear
    expect(product.variantId).toBe(V21);
    expect(product.title).toBe("Cleanser");
    expect(product.unitPriceCents).toBe(applyDiscountPct(2500, 20));
    expect(product.newTotalCents).toBe(applyDiscountPct(2500, 20) * 2);
    expect(card.options.some((o) => o.variantId === V31)).toBe(false);
    expect(card.options.some((o) => o.variantId === V13)).toBe(false);
  });

  it("every option total equals rest-of-order + swapPriceCentsFor × quantity (parity with the applied price)", async () => {
    store.contract = contractFixture({
      lines: [
        line(),
        line({ id: "l2", productId: PRODUCT_2, variantId: V21, title: "Cleanser", quantity: 1, currentPriceCents: 1500, compareAtPriceCents: 2500 }),
        line({ id: "g1", isGift: true, currentPriceCents: 0, quantity: 1 }),
      ],
    });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    // The biggest lever (Serum, 2 × 40.00) is the target; gifts never count.
    expect(card.lineId).toBe("l1");
    expect(card.currentTotalCents).toBe(8000 + 1500);
    for (const o of card.options) {
      if (o.mode === "QUANTITY") continue;
      const unit = await swapPriceCentsFor(
        "shop_1",
        { grandfatheredPricing: false },
        line(),
        { productId: o.mode === "VARIANT" ? PRODUCT_1 : PRODUCT_2, priceCents: o.mode === "VARIANT" ? 3000 : 2500 },
      );
      expect(o.unitPriceCents).toBe(unit);
      expect(o.newTotalCents).toBe(1500 + unit * 2);
    }
  });

  it("variant options are strictly cheaper and price-ascending; the list is capped at 3", async () => {
    store.contract = contractFixture({ lines: [line({ quantity: 1 })] });
    store.siblings = [
      { id: V11, title: "50ml", availableForSale: true, price: "50.00", image: null },
      { id: "gid://shopify/ProductVariant/15", title: "40ml", availableForSale: true, price: "40.00", image: null },
      { id: V12, title: "30ml", availableForSale: true, price: "30.00", image: null },
      { id: "gid://shopify/ProductVariant/16", title: "15ml", availableForSale: true, price: "15.00", image: null },
      { id: V13, title: "100ml", availableForSale: true, price: "80.00", image: null },
    ];
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.options).toHaveLength(3);
    expect(card.options.every((o) => o.mode === "VARIANT")).toBe(true);
    const prices = card.options.map((o) => o.unitPriceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(prices.every((p) => p < 4000)).toBe(true);
  });

  it("grandfathered contract: a smaller same-product size is offered at min(locked, repriced) — the lock never hides a genuinely cheaper size", async () => {
    store.contract = contractFixture({ grandfatheredPricing: true });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.options.map((o) => o.mode)).toEqual(["QUANTITY", "VARIANT", "PRODUCT"]);
    const variant = card.options[1];
    expect(variant.variantId).toBe(V12);
    expect(variant.unitPriceCents).toBe(applyDiscountPct(3000, 20)); // 2400 < locked 4000
    expect(card.options[2].variantId).toBe(V21);
  });

  it("a Shopify hiccup yields fewer options, never a thrown error", async () => {
    const { gql } = await import("~/lib/graphql/client.server");
    (gql as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.kind).toBe("DOWNSIZE");
    expect(card.options.map((o) => o.mode)).toEqual(["QUANTITY", "PRODUCT"]);
  });
});

// ── SWAP price parity ────────────────────────────────────────────────────────

describe("SWAP card price = the price the swap applies", () => {
  it("options carry swapPriceCentsFor's price and are sorted ascending", async () => {
    store.contract = contractFixture({ status: "ACTIVE" });
    const offers = await getSavesForReason("shop_1", "NOT_SEEING_RESULTS", contract());
    const swap = offers.find((o) => o.kind === "SWAP") as Swap;
    expect(swap).toBeDefined();
    expect(swap.options.map((o) => o.variantId)).toEqual([V12, V13]);
    for (const o of swap.options) {
      const catalog = o.variantId === V12 ? 3000 : 8000;
      const applied = await swapPriceCentsFor(
        "shop_1",
        { grandfatheredPricing: false },
        line(),
        { productId: PRODUCT_1, priceCents: catalog },
      );
      expect(o.displayPriceCents).toBe(applied);
      // ...which is the plan's ongoing discount off catalog — the same
      // number the portal items card derives from the SellingPlanConfig.
      expect(o.displayPriceCents).toBe(applyDiscountPct(catalog, 20));
    }
  });

  it("grandfathered same-product swaps show what the service applies: a smaller size min(locked, repriced), a bigger size repriced (never the small-size locked price)", async () => {
    store.contract = contractFixture({ grandfatheredPricing: true });
    const offers = await getSavesForReason("shop_1", "NOT_SEEING_RESULTS", contract());
    const swap = offers.find((o) => o.kind === "SWAP") as Swap;
    for (const o of swap.options) {
      const catalog = o.variantId === V12 ? 3000 : 8000;
      const applied = await swapPriceCentsFor(
        "shop_1",
        { grandfatheredPricing: true },
        line(),
        { productId: PRODUCT_1, priceCents: catalog },
      );
      expect(o.displayPriceCents).toBe(applied);
    }
    const small = swap.options.find((o) => o.variantId === V12)!;
    const big = swap.options.find((o) => o.variantId === V13)!;
    expect(small.displayPriceCents).toBe(applyDiscountPct(3000, 20));
    expect(big.displayPriceCents).toBe(applyDiscountPct(8000, 20));
  });

  it("without a covering plan config the helper falls back to the line's proportional ratio", async () => {
    store.configs = [];
    const price = await swapPriceCentsFor(
      "shop_1",
      { grandfatheredPricing: false },
      line(), // 40.00 / 50.00 = 0.8
      { productId: PRODUCT_1, priceCents: 3000 },
    );
    expect(price).toBe(2400);
  });
});

// ── Accept applies through the contract service ──────────────────────────────

describe("acceptSave DOWNSIZE", () => {
  async function shownDownsize(): Promise<Downsize> {
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    return offers[0] as Downsize;
  }

  it("fewer units → changeLineQuantity with the shown quantity and the save-flow source", async () => {
    const card = await shownDownsize();
    store.session = sessionFixture({ savesShown: [card, { kind: "PAUSE", months: 2, resumeDate: "2026-10-01T00:00:00.000Z" }] });
    const confirmation = await acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", quantity: 1 });
    expect(mocks.changeLineQuantity).toHaveBeenCalledTimes(1);
    expect(mocks.changeLineQuantity.mock.calls[0].slice(0, 4)).toEqual([
      "cellexia.myshopify.com",
      "c_1",
      "l1",
      1,
    ]);
    expect((mocks.changeLineQuantity.mock.calls[0] as unknown[])[4]).toMatchObject({
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(mocks.swapLineVariant).not.toHaveBeenCalled();
    expect(confirmation.kind).toBe("DOWNSIZE");
    expect(confirmation.downsize).toMatchObject({
      mode: "QUANTITY",
      quantity: 1,
      newTotalCents: 4000,
      currencyCode: "CHF",
    });
    // Session claimed SAVED with the kind, contract.savedAt stamped, event logged.
    expect(store.claims[0]).toMatchObject({ outcome: "SAVED", saveAccepted: "DOWNSIZE" });
    const accepted = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .find((e) => e.type === "cancel.save_accepted");
    expect(accepted?.payload).toMatchObject({
      saveKind: "DOWNSIZE",
      downsizeMode: "QUANTITY",
      quantity: 1,
      newTotalCents: 4000,
      sessionId: "cs_1",
    });
  });

  it("smaller size / cheaper product → swapLineVariant with the shown variant", async () => {
    const card = await shownDownsize();
    store.session = sessionFixture({ savesShown: [card] });
    await acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", variantId: V21 });
    expect(mocks.swapLineVariant).toHaveBeenCalledTimes(1);
    expect(mocks.swapLineVariant.mock.calls[0].slice(0, 4)).toEqual([
      "cellexia.myshopify.com",
      "c_1",
      "l1",
      V21,
    ]);
    expect(mocks.changeLineQuantity).not.toHaveBeenCalled();
  });

  it("value-gating: an option the card never showed is refused (and the claim reverted)", async () => {
    const card = await shownDownsize();
    store.session = sessionFixture({ savesShown: [card] });
    // The dearer 100ml sibling was never an option.
    await expect(
      acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", variantId: V13 }),
    ).rejects.toThrow(/was not offered/);
    // Nor an arbitrary quantity.
    store.session = sessionFixture({ savesShown: [card] });
    await expect(
      acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", quantity: 5 }),
    ).rejects.toThrow(/was not offered/);
    expect(mocks.swapLineVariant).not.toHaveBeenCalled();
    expect(mocks.changeLineQuantity).not.toHaveBeenCalled();
  });

  it("a DOWNSIZE that was never shown in the session is refused", async () => {
    store.session = sessionFixture({ savesShown: [{ kind: "PAUSE", months: 2, resumeDate: "x" }] });
    await expect(
      acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", quantity: 1 }),
    ).rejects.toThrow(/never offered/);
  });

  it("merchant toggle off at accept time refuses a stale card", async () => {
    const card = await shownDownsize();
    store.session = sessionFixture({ savesShown: [card] });
    store.cancelFlow = { ...store.cancelFlow, downsizeSaveEnabled: false };
    await expect(
      acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", quantity: 1 }),
    ).rejects.toThrow(/downsizeSaveEnabled/);
  });
});

// ── v1.28.0 review fixes ─────────────────────────────────────────────────────

describe("review fixes — cancel-flow save trust boundaries", () => {
  it("SWAP accept is value-gated like DOWNSIZE: an unshown / cross-product variant is refused and the claim reverted", async () => {
    const offers = await getSavesForReason("shop_1", "NOT_SEEING_RESULTS", contract());
    const swap = offers.find((o) => o.kind === "SWAP") as Swap;
    expect(swap).toBeDefined();
    store.session = sessionFixture({ savesShown: [swap] });
    await expect(
      acceptSave("cs_1", "SWAP", { lineId: "l1", variantId: V21 }),
    ).rejects.toThrow(/was not offered/);
    expect(mocks.swapLineVariant).not.toHaveBeenCalled();
    // The claim was written and then reverted (session stays open).
    expect(store.claims[0]).toMatchObject({ outcome: "SAVED", saveAccepted: "SWAP" });
    const { default: db } = await import("~/db.server");
    const update = db.cancelSession.update as unknown as ReturnType<typeof vi.fn>;
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { outcome: null, saveAccepted: null, completedAt: null },
    });
    // A shown option executes.
    store.session = sessionFixture({ savesShown: [swap] });
    await acceptSave("cs_1", "SWAP", { lineId: "l1", variantId: swap.options[0].variantId });
    expect(mocks.swapLineVariant).toHaveBeenCalledTimes(1);
  });

  it("DOWNSIZE value-gating reverts the claim (session reopened, no service ran)", async () => {
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    store.session = sessionFixture({ savesShown: [offers[0]] });
    await expect(
      acceptSave("cs_1", "DOWNSIZE", { lineId: "l1", quantity: 5 }),
    ).rejects.toThrow(/was not offered/);
    const { default: db } = await import("~/db.server");
    const update = db.cancelSession.update as unknown as ReturnType<typeof vi.fn>;
    expect(update.mock.calls.at(-1)?.[0]).toMatchObject({
      data: { outcome: null, saveAccepted: null, completedAt: null },
    });
  });

  it("no QUANTITY option for a line without a mirrored Shopify line id (accept would throw)", async () => {
    store.contract = contractFixture({ lines: [line({ shopifyLineId: null })] });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.kind).toBe("DOWNSIZE");
    expect(card.options.some((o) => o.mode === "QUANTITY")).toBe(false);
  });

  it("SWAP card keeps the merchant's variant order for the shown set (cap first), then sorts by price for display", async () => {
    // Four siblings in Shopify order: 30ml, 100ml, Intense (pricier), Intense 100ml.
    store.siblings = [
      { id: V11, title: "50ml", price: "50.00", availableForSale: true, image: null },
      { id: V12, title: "30ml", price: "30.00", availableForSale: true, image: null },
      { id: V13, title: "100ml", price: "80.00", availableForSale: true, image: null },
      { id: "gid://shopify/ProductVariant/14", title: "Intense", price: "95.00", availableForSale: true, image: null },
      { id: "gid://shopify/ProductVariant/15", title: "Intense 100ml", price: "120.00", availableForSale: true, image: null },
    ];
    const offers = await getSavesForReason("shop_1", "NOT_SEEING_RESULTS", contract());
    const swap = offers.find((o) => o.kind === "SWAP") as Swap;
    const ids = swap.options.map((o) => o.variantId);
    // The first three in merchant order (30ml, 100ml, Intense) — the pricier
    // Intense is on the card; the 4th (Intense 100ml) is what the cap drops.
    expect(new Set(ids)).toEqual(new Set([V12, V13, "gid://shopify/ProductVariant/14"]));
    const prices = swap.options.map((o) => o.displayPriceCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("DOWNSIZE card discloses a live grant next to its plan-price figures", async () => {
    const { default: db } = await import("~/db.server");
    (db.discountGrant as unknown as Record<string, unknown>).findMany = vi.fn(async () => [
      { id: "dg", percent: 20, cyclesRemaining: 2, exhaustedAt: null },
    ]);
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const card = offers[0] as Downsize;
    expect(card.discountPercent).toBe(20);
    expect(card.discountCyclesRemaining).toBe(2);
    // Plan-price figures unchanged (the grant is temporary and rides whatever the lines are).
    expect(card.currentTotalCents).toBe(8000);
    delete (db.discountGrant as unknown as Record<string, unknown>).findMany;
  });

  it("DISCOUNT card savings use the sweep's per-unit arithmetic (no third rounding)", async () => {
    store.cancelFlow = { ...store.cancelFlow, downsizeSaveEnabled: false, maxSavesShown: 3 };
    store.contract = contractFixture({
      lines: [line({ currentPriceCents: 1005, quantity: 3 })],
    });
    const offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", contract());
    const discount = offers.find((o) => o.kind === "DISCOUNT") as Extract<SaveOffer, { kind: "DISCOUNT" }>;
    expect(discount).toBeDefined();
    // 15% of 1005 per unit: 1005 − round(854.25)=854 → 151 × 3 = 453
    // (the aggregate form round(3015×0.15)=452 would disagree with the charge).
    expect(discount.estSavingsCentsPerCycle).toBe(453);
  });
});
