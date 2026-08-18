import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One-cycle quantity tweak "Just this order" (v1.28.0, P2.5) —
 * setLineQuantityThisCycle + the surfaces that must honour the override.
 *
 *  Service (REAL, Shopify seams mocked):
 *   - opens a billing-cycle contract edit on the UPCOMING cycle and updates
 *     the line's draft quantity; mirror cycleQuantityOverride(+Index); the
 *     plan quantity is untouched; event cycle.line_quantity_set;
 *   - quantity = plan (or null) clears the override (the Undo / restore);
 *   - idempotent on an equal value; ≥1 only (0 is skipLineThisCycle);
 *   - an increase works the same way (never blocked anywhere);
 *   - a line missing from the draft is re-added at the requested quantity.
 *  Undo: performUndo(line_qty_once) restores the previous override (or the
 *   plan quantity) when the flag still matches; stale otherwise.
 *  Grant application (applyGrantToCycle): a line skipped for the cycle is
 *   left out of the per-cycle price edit; discount cents use the billed
 *   quantity.
 *  Hero: a skipped line is struck-through / "not this time"; a tweaked one
 *   says "this order only · usually N".
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-line-qty";

const SHOP_DOMAIN = "cellexia.myshopify.com";
const NEXT = new Date("2026-09-14T22:00:00.000Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
const LINE_1_GID = "gid://shopify/SubscriptionLine/1";
const LINE_2_GID = "gid://shopify/SubscriptionLine/2";
const V1 = "gid://shopify/ProductVariant/11";
const V2 = "gid://shopify/ProductVariant/22";

type LineRow = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: LineRow[] },
  draftLines: [] as Array<{ id: string; variantId: string; quantity: number }>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({ cycleIndex: 5, skipped: false })),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      _sel: unknown,
      fn: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<void> => fn("draft_1", {}),
  ),
  draftLines: vi.fn(async () => store.draftLines),
  draftLineRemove: vi.fn(async (): Promise<void> => {}),
  draftLineAdd: vi.fn(async (): Promise<string> => "gid://shopify/SubscriptionLine/readded"),
  draftLineUpdate: vi.fn(
    async (_run: unknown, _draftId: string, _lineId: string, _patch: unknown): Promise<void> => {},
  ),
  lineUpdate: vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const line = store.contract.lines.find((l) => l.id === args.where.id);
      if (line) Object.assign(line, args.data);
      return line;
    },
  ),
  lineFindFirst: vi.fn(async (args: { where: { id: string } }) =>
    store.contract.lines.find((l) => l.id === args.where.id) ?? null,
  ),
  markerCreate: vi.fn(async (_args: unknown) => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: vi.fn(async () => store.contract),
    },
    contractLine: {
      update: mocks.lineUpdate,
      updateMany: vi.fn(async () => ({ count: 0 })),
      findFirst: mocks.lineFindFirst,
    },
    subscriberEvent: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    discountGrant: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        discountGrant: { updateMany: vi.fn(async () => ({ count: 1 })) },
        subscriberEvent: { create: mocks.markerCreate },
      }),
    ),
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: SHOP_DOMAIN,
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 0, clamped: false })),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async () => {}),
  onCycleDelayed: vi.fn(async () => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: mocks.draftLineAdd,
    draftLineRemove: mocks.draftLineRemove,
    draftLineUpdate: mocks.draftLineUpdate,
    draftLines: mocks.draftLines,
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getContract: vi.fn(async () => ({ nextBillingDate: NEXT })),
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: vi.fn(),
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: mocks.withBillingCycleEdit,
    withContractDraft: vi.fn(),
  };
});
// discounts.server imports the graphql modules directly (not the index).
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  withBillingCycleEdit: mocks.withBillingCycleEdit,
}));
vi.mock("~/lib/graphql/contracts.server", () => ({
  draftLineUpdate: mocks.draftLineUpdate,
  draftLines: mocks.draftLines,
}));

import {
  CycleLineEditError,
  setLineQuantityThisCycle,
} from "~/lib/contracts/service.server";
import { performUndo } from "~/lib/portal/undo.server";
import { applyGrantToCycle } from "~/lib/billing/discounts.server";
import { nextDeliveryHeroHtml } from "~/lib/portal/next-delivery.server";

function line(over: Record<string, unknown> = {}): LineRow {
  return {
    id: "line_1",
    shopifyLineId: LINE_1_GID,
    variantId: V1,
    productId: "gid://shopify/Product/1",
    title: "Serum",
    variantTitle: null,
    quantity: 2,
    currentPriceCents: 4900,
    isGift: false,
    isOneTimeAddon: false,
    addonCycleIndex: null,
    skippedCycleIndex: null,
    cycleQuantityOverride: null,
    cycleQuantityOverrideIndex: null,
    ...over,
  };
}

function baseContract(lines: LineRow[]) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    skipCount: 0,
    ordersCount: 4,
    nextBillingDate: NEXT,
    currencyCode: "CHF",
    deliveryPriceCents: 0,
    lines,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = baseContract([
    line(),
    line({ id: "line_2", shopifyLineId: LINE_2_GID, variantId: V2, title: "Cream", quantity: 1 }),
  ]);
  store.draftLines = [
    { id: LINE_1_GID, variantId: V1, quantity: 2 },
    { id: LINE_2_GID, variantId: V2, quantity: 1 },
  ];
  mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
});

describe("setLineQuantityThisCycle", () => {
  it("bills the tweaked quantity on the UPCOMING cycle only; plan quantity untouched", async () => {
    const updated = await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1, {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 5 },
      expect.any(Function),
    );
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_1_GID, {
      quantity: 1,
    });
    const l1 = updated.lines.find((l) => l.id === "line_1")!;
    expect(l1.quantity).toBe(2); // plan
    expect(l1.cycleQuantityOverride).toBe(1);
    expect(l1.cycleQuantityOverrideIndex).toBe(5);
    expect(eventsOfType("cycle.line_quantity_set")[0].payload).toMatchObject({
      lineId: "line_1",
      cycleIndex: 5,
      qty: 1,
      from: 2,
      planQuantity: 2,
      cleared: false,
    });
  });

  it("an INCREASE for one cycle works the same way (never blocked in the service)", async () => {
    const updated = await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 3);
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_1_GID, {
      quantity: 3,
    });
    expect(updated.lines.find((l) => l.id === "line_1")!.cycleQuantityOverride).toBe(3);
  });

  it("the plan quantity (or null) clears the override — the restore / Undo path", async () => {
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    store.draftLines[0].quantity = 1;
    const updated = await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 2);
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_1_GID, {
      quantity: 2,
    });
    const l1 = updated.lines.find((l) => l.id === "line_1")!;
    expect(l1.cycleQuantityOverride).toBeNull();
    expect(l1.cycleQuantityOverrideIndex).toBeNull();
    expect(eventsOfType("cycle.line_quantity_set")[0].payload).toMatchObject({
      qty: 2,
      from: 1,
      cleared: true,
    });

    // null = the same restore
    mocks.logEvent.mockClear();
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", null);
    expect(store.contract.lines[0].cycleQuantityOverride).toBeNull();
    expect(eventsOfType("cycle.line_quantity_set")).toHaveLength(1);
  });

  it("is idempotent on an equal value and refuses 0 / non-integers (typed INVALID_QUANTITY)", async () => {
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    // plan quantity with no override ⇒ no-op too
    store.contract.lines[0].cycleQuantityOverride = null;
    store.contract.lines[0].cycleQuantityOverrideIndex = null;
    await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 2);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();

    await expect(setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 0)).rejects.toMatchObject({
      code: "INVALID_QUANTITY",
    });
    await expect(setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1.5)).rejects.toBeInstanceOf(
      CycleLineEditError,
    );
  });

  it("re-adds a line missing from the cycle draft at the requested quantity instead of failing", async () => {
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 1 }];
    await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1);
    expect(mocks.draftLineAdd).toHaveBeenCalledWith(expect.anything(), "draft_1", {
      productVariantId: V1,
      quantity: 1,
      currentPriceCents: 4900,
    });
    expect(mocks.draftLineUpdate).not.toHaveBeenCalled();
    expect(store.contract.lines[0].cycleQuantityOverride).toBe(1);
  });

  it("targets a RE-ADDED cycle line (after an unskip) by variant, and refuses gifts / add-ons", async () => {
    store.draftLines = [
      { id: "gid://shopify/SubscriptionLine/readded", variantId: V1, quantity: 2 },
      { id: LINE_2_GID, variantId: V2, quantity: 1 },
    ];
    await setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1);
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(
      expect.anything(),
      "draft_1",
      "gid://shopify/SubscriptionLine/readded",
      { quantity: 1 },
    );
    store.contract.lines.push(line({ id: "addon", isOneTimeAddon: true }));
    await expect(setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "addon", 1)).rejects.toMatchObject({
      code: "NOT_RECURRING",
    });
  });
});

describe("Undo — line_qty_once spec", () => {
  const timing = { chargeHourLocal: 0, tz: "Europe/Zurich", preparingWindowHours: 6 } as never;
  const opts = { source: "CUSTOMER_PORTAL" as const, actor: "customer", via: "portal" as const, timing };
  const NOW = new Date("2026-08-17T10:00:00Z");

  it("restores the plan quantity when the tweak still stands; stale once it changed", async () => {
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    store.draftLines[0].quantity = 1;
    const outcome = await performUndo(
      SHOP_DOMAIN,
      store.contract as never,
      { kind: "line_qty_once", lineId: "line_1", cycleIndex: 5, previousOverride: null, override: 1 },
      opts,
      NOW,
    );
    expect(outcome.kind).toBe("restored");
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_1_GID, {
      quantity: 2,
    });
    expect(store.contract.lines[0].cycleQuantityOverride).toBeNull();

    // A second tap: the override is no longer 1 → stale, nothing moves.
    mocks.draftLineUpdate.mockClear();
    const stale = await performUndo(
      SHOP_DOMAIN,
      store.contract as never,
      { kind: "line_qty_once", lineId: "line_1", cycleIndex: 5, previousOverride: null, override: 1 },
      opts,
      NOW,
    );
    expect(stale.kind).toBe("stale");
    expect(mocks.draftLineUpdate).not.toHaveBeenCalled();
  });

  it("undoing a RESTORE puts the previous override back", async () => {
    // The customer restored the plan quantity (override cleared); undo re-applies 1.
    store.draftLines[0].quantity = 2;
    const outcome = await performUndo(
      SHOP_DOMAIN,
      store.contract as never,
      { kind: "line_qty_once", lineId: "line_1", cycleIndex: 5, previousOverride: 1, override: null },
      opts,
      NOW,
    );
    expect(outcome.kind).toBe("restored");
    expect(store.contract.lines[0].cycleQuantityOverride).toBe(1);
    expect(store.contract.lines[0].cycleQuantityOverrideIndex).toBe(5);
  });

  it("is 'past' once the order's charge moment has passed", async () => {
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    const outcome = await performUndo(
      SHOP_DOMAIN,
      store.contract as never,
      { kind: "line_qty_once", lineId: "line_1", cycleIndex: 5, previousOverride: null, override: 1 },
      opts,
      new Date("2026-09-20T10:00:00Z"),
    );
    expect(outcome.kind).toBe("past");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });
});

describe("applyGrantToCycle honours per-line cycle edits", () => {
  const grant = {
    id: "g_1",
    percent: 10,
    cyclesRemaining: 2,
    cyclesTotal: 3,
    type: "SAVE_OFFER",
  } as never;

  it("leaves a line skipped for THIS cycle out of the price edit and counts billed units", async () => {
    store.contract.lines[0].skippedCycleIndex = 5; // Serum not this time
    store.contract.lines[1].cycleQuantityOverride = 3; // Cream ×3 this order
    store.contract.lines[1].cycleQuantityOverrideIndex = 5;
    await applyGrantToCycle({} as never, { id: "shop_1", domain: SHOP_DOMAIN }, store.contract as never, grant, 5);
    const updated = mocks.draftLineUpdate.mock.calls.map((c) => c[2]);
    expect(updated).toEqual([LINE_2_GID]);
    // discountCents on the applied marker: 10% of 4900 × 3 billed units = 1470
    // (NOT the plan quantity 1, NOT the skipped Serum).
    expect(mocks.markerCreate).toHaveBeenCalledTimes(1);
    const marker = mocks.markerCreate.mock.calls[0][0] as { data: { payload: { discountCents: number } } };
    expect(marker.data.payload.discountCents).toBe(1470);
  });

  it("a skip for another cycle does not exclude the line", async () => {
    store.contract.lines[0].skippedCycleIndex = 4;
    await applyGrantToCycle({} as never, { id: "shop_1", domain: SHOP_DOMAIN }, store.contract as never, grant, 5);
    const updated = mocks.draftLineUpdate.mock.calls.map((c) => c[2]);
    expect(updated).toEqual([LINE_1_GID, LINE_2_GID]);
  });

  it("updates a RE-ADDED line (unskip → cycle-scoped id) by variant, and leaves a line absent from the draft out — never a stale-id update that fails the whole edit", async () => {
    // Serum was skipped then undone: the draft holds it under a cycle id.
    store.draftLines = [
      { id: "gid://shopify/SubscriptionLine/readded", variantId: V1, quantity: 2 },
      { id: LINE_2_GID, variantId: V2, quantity: 1 },
    ];
    await applyGrantToCycle({} as never, { id: "shop_1", domain: SHOP_DOMAIN }, store.contract as never, grant, 5);
    expect(mocks.draftLineUpdate.mock.calls.map((c) => c[2])).toEqual([
      "gid://shopify/SubscriptionLine/readded",
      LINE_2_GID,
    ]);
    // Cream removed by a foreign cycle edit (no mirror flag): not updated,
    // not counted; the Serum edit still commits.
    vi.clearAllMocks();
    store.draftLines = [{ id: LINE_1_GID, variantId: V1, quantity: 2 }];
    await applyGrantToCycle({} as never, { id: "shop_1", domain: SHOP_DOMAIN }, store.contract as never, grant, 5);
    expect(mocks.draftLineUpdate.mock.calls.map((c) => c[2])).toEqual([LINE_1_GID]);
    const marker = mocks.markerCreate.mock.calls[0][0] as { data: { payload: { discountCents: number } } };
    expect(marker.data.payload.discountCents).toBe(980); // 10% × 4900 × 2 units, Serum only
  });

  it("returns false (no edit) when every billable line is skipped for the cycle", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    store.contract.lines[1].skippedCycleIndex = 5;
    const result = await applyGrantToCycle({} as never, { id: "shop_1", domain: SHOP_DOMAIN }, store.contract as never, grant, 5);
    expect(result).toBe(false);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });
});

describe("hero rendering", () => {
  const estimate = {
    lines: [
      {
        title: "Serum",
        variantTitle: null,
        quantity: 2,
        unitPriceCents: 4900,
        lineTotalCents: 0,
        kind: "recurring",
        free: false,
        skippedThisCycle: true,
        variantId: V1,
        imageUrl: null,
      },
      {
        title: "Cream",
        variantTitle: null,
        quantity: 3,
        planQuantity: 1,
        unitPriceCents: 3000,
        lineTotalCents: 9000,
        kind: "recurring",
        free: false,
        skippedThisCycle: false,
        variantId: V2,
        imageUrl: null,
      },
    ],
    subtotalCents: 9000,
    discountCents: 0,
    discountPercent: null,
    discountCyclesRemaining: null,
    discountLabel: null,
    totalCents: 9000,
    currency: "CHF",
    deliveryCents: 0,
  };

  it("strikes through a skipped line and labels a one-order quantity", () => {
    const html = nextDeliveryHeroHtml({
      locale: "en",
      tz: "Europe/Zurich",
      contract: store.contract as never,
      estimate: estimate as never,
      cutoff: null,
      preparing: false,
      lineUp: null,
      outOfStockTitles: [],
      stockoutDelay: null,
      priceChange: null,
      chip: null,
      apiUrl: (action: string) => `/apps/cellexia-subs/api/${action}`,
      hiddenFields: () => "",
    });
    expect(html).toContain("cxs-next__line--skipped");
    expect(html).toContain("<s>Serum</s>");
    expect(html).toContain("not this time");
    expect(html).toContain("this order only · usually 1");
    expect(html).not.toMatch(/\bcx-/);
  });
});
