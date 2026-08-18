import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 Stage D adversarial-review fixes — contracts service side.
 *
 *  1. Contract-level edits vs. staged billing-cycle edits: when Shopify
 *     refuses a source-contract draft (userError) AND the mirror shows staged
 *     per-cycle edits, the service throws a typed ContractEditBlockedError
 *     (CYCLE_EDITS_PENDING) — a plain user error otherwise; success is
 *     untouched.
 *  2. Whole-cycle unskip restores per-line edits staged on LATER cycles on
 *     their own Shopify cycle and nulls the flags (the estimate hint would
 *     otherwise point past the real upcoming cycle).
 *  3. resumeContract reconciles per-line flags against the cycle at the new
 *     date (like every other schedule mover) and asks Shopify for a safe
 *     margin when the promised day already passed.
 *  4. Delivery instructions merge into the contract's existing note /
 *     customAttributes (foreign attributes and notes survive save + clear);
 *     the attribute key is underscore-prefixed (hidden on order pages).
 *  5. Country / region tables behind the address selects: normalisation and
 *     localisation.
 *
 * Scaffold: tests/portal-line-skip.test.ts (real service, Shopify seams
 * mocked).
 */

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
  shopifyNote: { note: null as string | null, customAttributes: [] as Array<{ key: string; value: string }> },
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(
    async (_admin?: unknown, _gid?: unknown, _date?: unknown): Promise<unknown> => ({
      cycleIndex: 5,
      skipped: false,
    }),
  ),
  skipBillingCycle: vi.fn(async (): Promise<unknown> => ({})),
  unskipBillingCycle: vi.fn(async (): Promise<unknown> => ({})),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      _sel: unknown,
      fn: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<void> => fn("draft_1", {}),
  ),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      fn: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<unknown> => {
      await fn("cdraft_1", {});
      return { contractId: CONTRACT_GID };
    },
  ),
  draftLines: vi.fn(async () => store.draftLines),
  draftLineRemove: vi.fn(async (): Promise<void> => {}),
  draftLineAdd: vi.fn(async (): Promise<string> => "gid://shopify/SubscriptionLine/readded"),
  draftLineUpdate: vi.fn(async (): Promise<void> => {}),
  draftUpdateNote: vi.fn(async (): Promise<void> => {}),
  draftUpdateAddress: vi.fn(async (): Promise<void> => {}),
  getContractNoteAndAttributes: vi.fn(async (_admin?: unknown, _gid?: unknown) => store.shopifyNote),
  setNextBillingDate: vi.fn(
    async (_admin?: unknown, _gid?: unknown, _date?: unknown): Promise<unknown> => ({
      nextBillingDate: null,
    }),
  ),
  getContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: NEXT })),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  clearStaleCycleOverrides: vi.fn(async (_id?: unknown, _idx?: unknown): Promise<unknown> => ({ ok: true })),
  loadParkedCycleDiscount: vi.fn(async (_id?: unknown): Promise<unknown> => null),
  lineFindMany: vi.fn(async (): Promise<unknown[]> => store.contract.lines),
  lineUpdate: vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const line = store.contract.lines.find((l) => l.id === args.where.id);
      if (line) Object.assign(line, args.data);
      return line;
    },
  ),
  lineUpdateMany: vi.fn(
    async (args: { where: { id?: { in: string[] } }; data: Record<string, unknown> }) => {
      const ids = args.where.id?.in ?? [];
      let count = 0;
      for (const l of store.contract.lines) {
        if (ids.includes(l.id)) {
          Object.assign(l, args.data);
          count += 1;
        }
      }
      return { count };
    },
  ),
  contractUpdate: vi.fn(async (args: { data: Record<string, unknown> }) => {
    Object.assign(store.contract, args.data);
    return store.contract;
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
    },
    contractLine: {
      findMany: mocks.lineFindMany,
      update: mocks.lineUpdate,
      updateMany: mocks.lineUpdateMany,
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    subscriberEvent: { findMany: vi.fn(async () => []) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    dunningCase: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    shop: { findUnique: vi.fn(async (): Promise<unknown> => ({ ianaTimezone: "Europe/Zurich" })) },
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
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "billing") return { chargeHourLocal: 8 };
    if (key === "portal") return { deliveryInstructionsMaxChars: 250 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 0, clamped: false })),
}));
vi.mock("~/lib/billing/estimate.server", () => ({
  clearStaleCycleOverrides: mocks.clearStaleCycleOverrides,
  nextCycleIndex: vi.fn(async () => 5),
  loadParkedCycleDiscount: mocks.loadParkedCycleDiscount,
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async () => {}),
  onCycleDelayed: vi.fn(async () => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {
    errors: unknown[];
    constructor(message: string, errors: unknown[] = []) {
      super(message);
      this.name = "ShopifyUserError";
      this.errors = errors;
    }
  }
  return {
    ShopifyUserError,
    contractActivate: mocks.contractActivate,
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: mocks.draftLineAdd,
    draftLineRemove: mocks.draftLineRemove,
    draftLineUpdate: mocks.draftLineUpdate,
    draftLines: mocks.draftLines,
    draftUpdateAddress: mocks.draftUpdateAddress,
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdateNote: mocks.draftUpdateNote,
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getContract: mocks.getContract,
    getContractNoteAndAttributes: mocks.getContractNoteAndAttributes,
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: mocks.skipBillingCycle,
    unskipBillingCycle: mocks.unskipBillingCycle,
    withBillingCycleEdit: mocks.withBillingCycleEdit,
    withContractDraft: mocks.withContractDraft,
  };
});

import { ShopifyUserError } from "~/lib/graphql/index.server";
import {
  ContractEditBlockedError,
  DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY,
  hasPendingCycleEdits,
  mergeDeliveryInstructions,
  resumeContract,
  setDeliveryInstructions,
  unskipLineThisCycle,
  unskipNextCycle,
  updateDeliveryAddress,
} from "~/lib/contracts/service.server";
import {
  countryOptions,
  countryRequiresProvince,
  isKnownCountry,
  normalizeProvinceCode,
} from "~/lib/portal/countries";
import { TOAST_ALERT_KEYS, TOAST_KEYS } from "~/lib/portal/layout.server";
import en from "~/lib/i18n/locales/en.json";

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

function baseContract(lines: LineRow[], over: Record<string, unknown> = {}) {
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
    skipCount: 1,
    merchantSkipCount: 0,
    ordersCount: 4,
    nextBillingDate: NEXT,
    deliveryInstructions: null,
    lines,
    ...over,
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
  store.shopifyNote = { note: null, customAttributes: [] };
  mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
  mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: null });
  mocks.getContract.mockResolvedValue({ nextBillingDate: NEXT });
  mocks.withContractDraft.mockImplementation(async (_a, _g, fn) => {
    await fn("cdraft_1", {});
    return { contractId: CONTRACT_GID };
  });
});

const ADDRESS = { address1: "1 High St", city: "London", zip: "N1", countryCode: "GB" };

// ── 1. Contract edits while cycle edits are staged ───────────────────────────

describe("contract-level edits vs. staged billing-cycle edits", () => {
  it("maps a Shopify userError to ContractEditBlockedError(CYCLE_EDITS_PENDING) when per-line cycle edits are staged", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    mocks.withContractDraft.mockRejectedValue(
      new ShopifyUserError("Shopify userErrors at subscriptionDraftCommit: contract has billing cycle edits", []),
    );
    await expect(
      updateDeliveryAddress(SHOP_DOMAIN, "c_1", ADDRESS, { source: "CUSTOMER_PORTAL" }),
    ).rejects.toMatchObject({ name: "ContractEditBlockedError", code: "CYCLE_EDITS_PENDING" });
    // The probe read the mirror lines of THIS contract, nothing was mirrored, no event.
    expect(mocks.lineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { contract: { shopifyContractId: CONTRACT_GID } } }),
    );
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("passes a Shopify userError through unchanged when nothing is staged (address typo, etc.)", async () => {
    mocks.withContractDraft.mockRejectedValue(new ShopifyUserError("invalid province", []));
    const err = await updateDeliveryAddress(SHOP_DOMAIN, "c_1", ADDRESS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyUserError);
    expect(err).not.toBeInstanceOf(ContractEditBlockedError);
  });

  it("infrastructure errors are never remapped, and success never probes the mirror", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    mocks.withContractDraft.mockRejectedValue(new Error("ECONNRESET"));
    await expect(updateDeliveryAddress(SHOP_DOMAIN, "c_1", ADDRESS)).rejects.toThrow("ECONNRESET");
    expect(mocks.lineFindMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.withContractDraft.mockImplementation(async (_a, _g, fn) => {
      await fn("cdraft_1", {});
      return { contractId: CONTRACT_GID };
    });
    await updateDeliveryAddress(SHOP_DOMAIN, "c_1", ADDRESS);
    expect(mocks.lineFindMany).not.toHaveBeenCalled();
    expect(mocks.draftUpdateAddress).toHaveBeenCalled();
  });

  it("hasPendingCycleEdits recognises per-line flags, staged add-ons and staged gifts only", () => {
    const base = line();
    expect(hasPendingCycleEdits([base] as never)).toBe(false);
    expect(hasPendingCycleEdits([line({ skippedCycleIndex: 5 })] as never)).toBe(true);
    expect(hasPendingCycleEdits([line({ cycleQuantityOverrideIndex: 5 })] as never)).toBe(true);
    expect(hasPendingCycleEdits([line({ isOneTimeAddon: true, addonCycleIndex: 5 })] as never)).toBe(true);
    // Legacy add-on with an unknown cycle: not provably staged on a cycle.
    expect(hasPendingCycleEdits([line({ isOneTimeAddon: true, addonCycleIndex: null })] as never)).toBe(false);
    expect(hasPendingCycleEdits([line({ isGift: true, shopifyLineId: null })] as never)).toBe(true);
  });

  it("the portal has a dedicated alert toast with honest copy", () => {
    expect(TOAST_KEYS.has("cycle_edits_pending")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("cycle_edits_pending")).toBe(true);
    const copy = (en as Record<string, string>)["portal.toast.cycle_edits_pending"];
    expect(copy).toMatch(/one-off/i);
    expect(copy).toMatch(/undo/i);
  });
});

// ── 2. Whole-cycle unskip vs. later-cycle per-line flags ─────────────────────

describe("unskipNextCycle restores per-line edits staged on LATER cycles", () => {
  beforeEach(() => {
    // Cycle 5 was skipped; the mirror's next date is cycle 6's. Serum was
    // then set "not this time" for cycle 6, Cream ×3 for cycle 6.
    store.contract.lines[0].skippedCycleIndex = 6;
    store.contract.lines[1].cycleQuantityOverride = 3;
    store.contract.lines[1].cycleQuantityOverrideIndex = 6;
    mocks.getBillingCycleByDate.mockImplementation(async (_a: unknown, _g: unknown, date: unknown) => {
      // The probe one interval before NEXT finds the skipped cycle 5.
      const d = date as Date;
      return d.getTime() < NEXT.getTime()
        ? { cycleIndex: 5, skipped: true, billingAttemptExpectedDate: d }
        : { cycleIndex: 6, skipped: false };
    });
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 3 }]; // cycle 6 draft: Serum gone, Cream ×3
  });

  it("re-adds the skipped line / restores the plan quantity on cycle 6 BEFORE un-skipping cycle 5, then nulls the flags", async () => {
    const updated = await unskipNextCycle(SHOP_DOMAIN, "c_1", { source: "CUSTOMER_PORTAL" });

    // Restore happened on cycle 6 (the flags' own cycle), not on 5.
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 6 },
      expect.any(Function),
    );
    expect(mocks.draftLineAdd).toHaveBeenCalledWith(expect.anything(), "draft_1", {
      productVariantId: V1,
      quantity: 2,
      currentPriceCents: 4900,
    });
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_2_GID, {
      quantity: 1,
    });
    // Order: restore first, Shopify unskip after.
    const restoreOrder = mocks.withBillingCycleEdit.mock.invocationCallOrder[0];
    const unskipOrder = mocks.unskipBillingCycle.mock.invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(unskipOrder);
    expect(mocks.unskipBillingCycle).toHaveBeenCalledWith(expect.anything(), CONTRACT_GID, { index: 5 });

    // Mirror: flags gone, so the estimate's cycle hint points at 5 again.
    const l1 = updated.lines.find((l) => l.id === "line_1")!;
    const l2 = updated.lines.find((l) => l.id === "line_2")!;
    expect(l1.skippedCycleIndex).toBeNull();
    expect(l2.cycleQuantityOverride).toBeNull();
    expect(l2.cycleQuantityOverrideIndex).toBeNull();

    // Trail: one line_unskipped + one line_quantity_set (cleared), then the unskip.
    expect(eventsOfType("cycle.line_unskipped")[0].payload).toMatchObject({
      lineId: "line_1",
      cycleIndex: 6,
      reason: "cycle_unskipped",
    });
    expect(eventsOfType("cycle.line_quantity_set")[0].payload).toMatchObject({
      lineId: "line_2",
      cycleIndex: 6,
      cleared: true,
      reason: "cycle_unskipped",
    });
    expect(eventsOfType("cycle.unskipped")).toHaveLength(1);
  });

  it("a Shopify user error on the restore is tolerated (mirror catches up); an infrastructure error aborts before anything moves", async () => {
    mocks.withBillingCycleEdit.mockRejectedValueOnce(new ShopifyUserError("line gone", []));
    await unskipNextCycle(SHOP_DOMAIN, "c_1");
    expect(mocks.unskipBillingCycle).toHaveBeenCalled();
    expect(store.contract.lines[0].skippedCycleIndex).toBeNull();

    vi.clearAllMocks();
    store.contract.lines[0].skippedCycleIndex = 6;
    mocks.withBillingCycleEdit.mockRejectedValueOnce(new Error("timeout"));
    await expect(unskipNextCycle(SHOP_DOMAIN, "c_1")).rejects.toThrow("timeout");
    expect(mocks.unskipBillingCycle).not.toHaveBeenCalled();
    expect(store.contract.lines[0].skippedCycleIndex).toBe(6);
  });

  it("flags ON the un-skipped cycle or below are left to the estimate's normal invalidation (no restore call)", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    store.contract.lines[1].cycleQuantityOverride = null;
    store.contract.lines[1].cycleQuantityOverrideIndex = null;
    await unskipNextCycle(SHOP_DOMAIN, "c_1");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.lineUpdateMany).not.toHaveBeenCalled();
  });
});

// ── 2b. Re-add price while dunning owns the cycle ────────────────────────────

describe("re-adding a skipped line prices from the cycle, not the plan, while a parked cycle discount exists", () => {
  it("unskipLineThisCycle re-adds at the parked-cycle discounted price for THAT cycle only", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 1 }];
    mocks.loadParkedCycleDiscount.mockResolvedValue({ percent: 20, cyclesRemaining: 1, cycleIndex: 5 });
    await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.draftLineAdd).toHaveBeenCalledWith(expect.anything(), "draft_1", {
      productVariantId: V1,
      quantity: 2,
      currentPriceCents: 3920, // 4900 − 20%
    });

    // A parked discount on ANOTHER cycle, or none: plan price.
    vi.clearAllMocks();
    store.contract.lines[0].skippedCycleIndex = 5;
    mocks.loadParkedCycleDiscount.mockResolvedValue({ percent: 20, cyclesRemaining: 1, cycleIndex: 4 });
    await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect((mocks.draftLineAdd.mock.calls[0] as unknown[])[2]).toMatchObject({ currentPriceCents: 4900 });

    // Read failure is contained: plan price, the undo still goes through.
    vi.clearAllMocks();
    store.contract.lines[0].skippedCycleIndex = 5;
    mocks.loadParkedCycleDiscount.mockRejectedValue(new Error("db"));
    await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect((mocks.draftLineAdd.mock.calls[0] as unknown[])[2]).toMatchObject({ currentPriceCents: 4900 });
  });
});

// ── 3. resumeContract ────────────────────────────────────────────────────────

describe("resumeContract and per-line cycle flags", () => {
  it("reconciles staged flags against the cycle at the new date (like every other schedule mover)", async () => {
    store.contract = baseContract(
      [line({ skippedCycleIndex: 5 }), line({ id: "line_2", shopifyLineId: LINE_2_GID, variantId: V2 })],
      { status: "PAUSED", pausedAt: new Date("2026-06-01T00:00:00Z"), resumeAt: null },
    );
    mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: new Date("2026-08-20T08:00:00Z") });
    mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 7, skipped: false });
    await resumeContract(SHOP_DOMAIN, "c_1", { source: "ADMIN" });
    // The cycle now at the new date is 7 ⇒ flags below 7 are dropped.
    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      new Date("2026-08-20T08:00:00Z"),
    );
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 7);
  });

  it("does not touch the cycle-override machinery when no flag exists", async () => {
    store.contract = baseContract([line()], { status: "PAUSED" });
    await resumeContract(SHOP_DOMAIN, "c_1");
    expect(mocks.getBillingCycleByDate).not.toHaveBeenCalled();
    expect(mocks.clearStaleCycleOverrides).not.toHaveBeenCalled();
  });

  it("a promised day already passed → today's charge moment when still ahead, else now + 15 min (never +60s)", async () => {
    vi.useFakeTimers();
    try {
      // 2026-08-17 04:00 Zurich (02:00Z) — charge hour 8 is still ahead today.
      vi.setSystemTime(new Date("2026-08-17T02:00:00.000Z"));
      store.contract = baseContract([line()], { status: "PAUSED" });
      const billOn = new Date("2026-08-16T22:00:00.000Z"); // Zurich day start of Aug 17, already passed
      await resumeContract(SHOP_DOMAIN, "c_1", { source: "SYSTEM", billOn });
      let target = mocks.setNextBillingDate.mock.calls[0][2] as Date;
      expect(target.toISOString()).toBe("2026-08-17T06:00:00.000Z"); // 08:00 Zurich

      // 10:00 Zurich — the charge moment passed → now + 15 minutes.
      vi.clearAllMocks();
      vi.setSystemTime(new Date("2026-08-17T08:00:00.000Z"));
      store.contract = baseContract([line()], { status: "PAUSED" });
      await resumeContract(SHOP_DOMAIN, "c_1", { source: "SYSTEM", billOn });
      target = mocks.setNextBillingDate.mock.calls[0][2] as Date;
      expect(target.toISOString()).toBe("2026-08-17T08:15:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── 4. Delivery instructions merge ───────────────────────────────────────────

describe("delivery instructions never clobber foreign note / attributes", () => {
  it("attribute key is underscore-prefixed (hidden from order status page / notifications)", () => {
    expect(DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY.startsWith("_")).toBe(true);
  });

  it("mergeDeliveryInstructions keeps foreign attributes and a foreign note, replaces only ours (incl. the legacy key)", () => {
    const foreign = [
      { key: "gift_message", value: "Happy birthday" },
      { key: "cellexia_delivery_instructions", value: "old text" },
    ];
    const saved = mergeDeliveryInstructions({
      currentNote: "Ring bell twice",
      currentAttributes: foreign,
      previous: null,
      value: "Leave at reception",
    });
    expect(saved.customAttributes).toEqual([
      { key: "gift_message", value: "Happy birthday" },
      { key: DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY, value: "Leave at reception" },
    ]);
    expect(saved.note).toBe("Ring bell twice\nLeave at reception");

    // Later edit: only our line of the note is swapped.
    const edited = mergeDeliveryInstructions({
      currentNote: saved.note,
      currentAttributes: saved.customAttributes,
      previous: "Leave at reception",
      value: "Side door",
    });
    expect(edited.note).toBe("Ring bell twice\nSide door");

    // Clear: foreign attribute + foreign note survive, ours is gone.
    const cleared = mergeDeliveryInstructions({
      currentNote: edited.note,
      currentAttributes: edited.customAttributes,
      previous: "Side door",
      value: null,
    });
    expect(cleared.customAttributes).toEqual([{ key: "gift_message", value: "Happy birthday" }]);
    expect(cleared.note).toBe("Ring bell twice");

    // A note we own entirely clears to null.
    expect(
      mergeDeliveryInstructions({ currentNote: "Side door", currentAttributes: [], previous: "Side door", value: null }).note,
    ).toBeNull();
  });

  it("setDeliveryInstructions reads the contract's current note/attributes and writes the merged result; the mirror holds only our text", async () => {
    store.shopifyNote = {
      note: "Ring bell twice",
      customAttributes: [{ key: "gift_message", value: "Happy birthday" }],
    };
    const updated = await setDeliveryInstructions(SHOP_DOMAIN, "c_1", "Leave at reception", {
      source: "CUSTOMER_PORTAL",
    });
    expect(mocks.getContractNoteAndAttributes).toHaveBeenCalledWith(expect.anything(), CONTRACT_GID);
    expect(mocks.draftUpdateNote).toHaveBeenCalledWith(
      expect.anything(),
      "cdraft_1",
      "Ring bell twice\nLeave at reception",
      [
        { key: "gift_message", value: "Happy birthday" },
        { key: DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY, value: "Leave at reception" },
      ],
    );
    expect((updated as { deliveryInstructions?: string | null }).deliveryInstructions).toBe("Leave at reception");

    // Clear from that state: foreign parts survive.
    vi.clearAllMocks();
    store.shopifyNote = {
      note: "Ring bell twice\nLeave at reception",
      customAttributes: [
        { key: "gift_message", value: "Happy birthday" },
        { key: DELIVERY_INSTRUCTIONS_ATTRIBUTE_KEY, value: "Leave at reception" },
      ],
    };
    await setDeliveryInstructions(SHOP_DOMAIN, "c_1", null);
    expect(mocks.draftUpdateNote).toHaveBeenCalledWith(expect.anything(), "cdraft_1", "Ring bell twice", [
      { key: "gift_message", value: "Happy birthday" },
    ]);
  });

  it("when the current attributes cannot be read, the list is NOT sent at all (nothing wiped) and the note falls back to the mirror-owned merge", async () => {
    mocks.getContractNoteAndAttributes.mockRejectedValueOnce(new Error("boom"));
    await setDeliveryInstructions(SHOP_DOMAIN, "c_1", "Side door");
    expect(mocks.draftUpdateNote).toHaveBeenCalledWith(expect.anything(), "cdraft_1", "Side door", undefined);
  });
});

// ── 5. Country / region tables ───────────────────────────────────────────────

describe("address country / region tables", () => {
  it("knows Shopify's countries and which ones require a region", () => {
    expect(isKnownCountry("gb")).toBe(true);
    expect(isKnownCountry("XX")).toBe(false);
    expect(countryRequiresProvince("US")).toBe(true);
    expect(countryRequiresProvince("FR")).toBe(false);
  });

  it("normalises a region: code (any case) or name for listed countries, free text elsewhere, refusal for unknowns", () => {
    expect(normalizeProvinceCode("US", "ca")).toEqual({ ok: true, value: "CA" });
    expect(normalizeProvinceCode("US", "California")).toEqual({ ok: true, value: "CA" });
    expect(normalizeProvinceCode("US", "Bavaria")).toEqual({ ok: false });
    expect(normalizeProvinceCode("US", "")).toEqual({ ok: false });
    expect(normalizeProvinceCode("FR", "")).toEqual({ ok: true, value: null });
    expect(normalizeProvinceCode("FR", "Île-de-France")).toEqual({ ok: true, value: "Île-de-France" });
    expect(normalizeProvinceCode("MX", "q roo")).toEqual({ ok: true, value: "Q ROO" });
  });

  it("names countries in the customer's locale, sorted by name, every code present", () => {
    const fr = countryOptions("fr");
    expect(fr.find((c) => c.code === "DE")?.name).toBe("Allemagne");
    expect(fr.map((c) => c.code)).toContain("GB");
    const names = fr.map((c) => c.name);
    expect([...names].sort(new Intl.Collator("fr").compare)).toEqual(names);
    const en = countryOptions("en");
    expect(en.find((c) => c.code === "CH")?.name).toBe("Switzerland");
    expect(TOAST_ALERT_KEYS.has("address_region_invalid")).toBe(true);
  });
});
