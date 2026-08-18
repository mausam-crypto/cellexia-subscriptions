import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Per-line "Not this time" (v1.28.0, P2.5) — skipLineThisCycle /
 * unskipLineThisCycle, their invalidation hooks, the portal actions and Undo.
 *
 *  Service (REAL functions, Shopify seams mocked):
 *   - resolves the UPCOMING cycle by date, opens a billing-cycle contract
 *     edit on that index and removes the line's draft line; mirror
 *     skippedCycleIndex = the resolved index; event cycle.line_skipped;
 *   - refuses (typed LAST_LINE) to empty the cycle — nothing mutated;
 *   - idempotent when already skipped for that cycle;
 *   - a skip wins over a one-cycle quantity tweak on the same cycle;
 *   - unskip re-adds the same variant / plan qty / plan price on the SAME
 *     cycle and nulls the flag; a stale flag (older cycle) is just dropped;
 *   - re-skip after an unskip targets the RE-ADDED draft line (cycle-scoped
 *     id resolved by variant), not the contract line id;
 *   - whole-cycle skip restores the per-line edit on Shopify BEFORE skipping
 *     and clears every flag ≤ the skipped cycle (clearStaleCycleOverrides);
 *   - re-anchor / next-date change / frequency change reconcile the flags
 *     against the cycle now at the new date.
 *  Portal dispatcher: line_skip is lock-blocked (reduction), line_unskip is
 *   not; LAST_LINE → toast skip_line_last_line; the merchant switch holds;
 *   the confirming toast carries an Undo token (line_skip spec).
 *  Undo: performUndo(line_skip) → unskipLineThisCycle when the flag still
 *   matches; stale otherwise; the toast resolver renders the Undo form.
 */

process.env.APP_SIGNING_SECRET = "test-secret-for-line-skip";

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
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 5,
    skipped: false,
  })),
  skipBillingCycle: vi.fn(async (): Promise<unknown> => ({})),
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
  draftLineUpdate: vi.fn(async (): Promise<void> => {}),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
  getContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: NEXT })),
  clearStaleCycleOverrides: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  lineUpdate: vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const line = store.contract.lines.find((l) => l.id === args.where.id);
      if (line) Object.assign(line, args.data);
      return line;
    },
  ),
  lineUpdateMany: vi.fn(async (): Promise<{ count: number }> => ({ count: 0 })),
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
      update: mocks.lineUpdate,
      updateMany: mocks.lineUpdateMany,
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    subscriberEvent: {
      findMany: vi.fn(async () => []),
    },
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
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/billing/estimate.server", () => ({
  clearStaleCycleOverrides: mocks.clearStaleCycleOverrides,
  nextCycleIndex: vi.fn(async () => 5),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async () => {}),
  onCycleDelayed: vi.fn(async () => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {
    constructor(message: string, _errors: unknown[] = []) {
      super(message);
    }
  }
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
    getContract: mocks.getContract,
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: mocks.skipBillingCycle,
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: mocks.withBillingCycleEdit,
    withContractDraft: vi.fn(
      async (
        _admin: unknown,
        _gid: unknown,
        fn: (draftId: string, run: unknown) => Promise<void>,
      ): Promise<void> => fn("cdraft_1", {}),
    ),
  };
});
vi.mock("~/lib/crypto/tokens.server", () => {
  const signed = new Map<string, unknown>();
  return {
    sha256: (data: string) => createHash("sha256").update(data).digest("hex"),
    createSignedPayload: vi.fn((kind: string, data: unknown) => {
      const token = `${kind}.${signed.size + 1}`;
      signed.set(token, data);
      return token;
    }),
    verifySignedPayload: vi.fn((token: string, kind: string) => {
      const data = signed.get(token);
      if (!data || !token.startsWith(`${kind}.`)) return { ok: false, reason: "INVALID" };
      return { ok: true, payload: { data } };
    }),
  };
});

import { ShopifyUserError } from "~/lib/graphql/index.server";
import {
  CycleLineEditError,
  changeFrequency,
  delaySchedule,
  setLineQuantityThisCycle,
  setNextBillingDate,
  skipLineThisCycle,
  skipNextCycle,
  unskipLineThisCycle,
} from "~/lib/contracts/service.server";
import {
  mintUndoToken,
  normalizeSpec,
  performUndo,
  readUndoToken,
} from "~/lib/portal/undo.server";
import { TOAST_KEYS, resolveToast, toastTone } from "~/lib/portal/layout.server";
import { PORTAL_PROXY_BASE } from "~/lib/portal/proxy-path";
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
  mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: null });
  mocks.getContract.mockResolvedValue({ nextBillingDate: NEXT });
});

// ── skipLineThisCycle ────────────────────────────────────────────────────────

describe("skipLineThisCycle", () => {
  it("removes the line from the UPCOMING cycle only and mirrors the resolved index", async () => {
    const updated = await skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1", {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });

    // Cycle resolved by the mirror's next billing date …
    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith(expect.anything(), CONTRACT_GID, NEXT);
    // … the cycle edit opened on THAT index, the contract line's draft line removed.
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 5 },
      expect.any(Function),
    );
    expect(mocks.draftLineRemove).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_1_GID);

    // Mirror: the resolved index, never ordersCount+1; plan quantity untouched.
    const l1 = updated.lines.find((l) => l.id === "line_1")!;
    expect(l1.skippedCycleIndex).toBe(5);
    expect(l1.quantity).toBe(2);
    expect(mocks.contractUpdate).not.toHaveBeenCalled();

    const ev = eventsOfType("cycle.line_skipped");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({
      lineId: "line_1",
      variantId: V1,
      cycleIndex: 5,
      quantity: 2,
      removedOnShopify: true,
    });
  });

  it("refuses to empty the cycle with a typed LAST_LINE error — nothing mutated", async () => {
    store.contract = baseContract([line()]);
    store.draftLines = [{ id: LINE_1_GID, variantId: V1, quantity: 2 }];
    await expect(skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1")).rejects.toMatchObject({
      name: "CycleLineEditError",
      code: "LAST_LINE",
    });
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.lineUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("counts an already-skipped sibling as gone: the last billable line is refused too", async () => {
    store.contract.lines[1].skippedCycleIndex = 5;
    await expect(skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1")).rejects.toBeInstanceOf(
      CycleLineEditError,
    );
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("refuses gifts and one-time add-ons (typed NOT_RECURRING) and unknown lines", async () => {
    store.contract.lines.push(line({ id: "gift", isGift: true, variantId: "gid://shopify/ProductVariant/g" }));
    store.contract.lines.push(line({ id: "addon", isOneTimeAddon: true, addonCycleIndex: 5 }));
    await expect(skipLineThisCycle(SHOP_DOMAIN, "c_1", "gift")).rejects.toMatchObject({ code: "NOT_RECURRING" });
    await expect(skipLineThisCycle(SHOP_DOMAIN, "c_1", "addon")).rejects.toMatchObject({ code: "NOT_RECURRING" });
    await expect(skipLineThisCycle(SHOP_DOMAIN, "c_1", "nope")).rejects.toMatchObject({ code: "LINE_NOT_FOUND" });
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("is idempotent: already skipped for this cycle ⇒ no Shopify call, no event", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    await skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a skip wins over a one-cycle quantity tweak on the same cycle (override cleared)", async () => {
    store.contract.lines[0].cycleQuantityOverride = 1;
    store.contract.lines[0].cycleQuantityOverrideIndex = 5;
    const updated = await skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    const l1 = updated.lines.find((l) => l.id === "line_1")!;
    expect(l1.skippedCycleIndex).toBe(5);
    expect(l1.cycleQuantityOverride).toBeNull();
    expect(l1.cycleQuantityOverrideIndex).toBeNull();
  });

  it("targets the RE-ADDED cycle line after an unskip (resolved by variant, not the contract line id)", async () => {
    // After an unskip the cycle holds a re-added copy under a cycle-scoped id.
    store.draftLines = [
      { id: "gid://shopify/SubscriptionLine/readded", variantId: V1, quantity: 2 },
      { id: LINE_2_GID, variantId: V2, quantity: 1 },
    ];
    await skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.draftLineRemove).toHaveBeenCalledWith(
      expect.anything(),
      "draft_1",
      "gid://shopify/SubscriptionLine/readded",
    );
  });

  it("does not misread another mirrored line of the same variant as the target", async () => {
    // line_2 mirrors the same variant as line_1 (edge: duplicate variant lines).
    store.contract.lines[1].variantId = V1;
    store.draftLines = [{ id: LINE_2_GID, variantId: V1, quantity: 1 }];
    const updated = await skipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    // Nothing on the draft is line_1's — no removal, mirror still flagged
    // (the estimate reflects the customer's intent; Shopify already lacked it).
    expect(mocks.draftLineRemove).not.toHaveBeenCalled();
    expect(updated.lines.find((l) => l.id === "line_1")!.skippedCycleIndex).toBe(5);
    expect(eventsOfType("cycle.line_skipped")[0].payload.removedOnShopify).toBe(false);
  });
});

// ── unskipLineThisCycle ──────────────────────────────────────────────────────

describe("unskipLineThisCycle (Undo)", () => {
  it("re-adds the same variant / plan quantity / plan price on the SAME cycle and nulls the flag", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 1 }];
    const updated = await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 5 },
      expect.any(Function),
    );
    expect(mocks.draftLineAdd).toHaveBeenCalledWith(expect.anything(), "draft_1", {
      productVariantId: V1,
      quantity: 2,
      currentPriceCents: 4900,
    });
    expect(updated.lines.find((l) => l.id === "line_1")!.skippedCycleIndex).toBeNull();
    expect(eventsOfType("cycle.line_unskipped")[0].payload).toMatchObject({
      lineId: "line_1",
      cycleIndex: 5,
      restoredOnShopify: true,
    });
  });

  it("is idempotent without a flag, and just drops a STALE flag (older cycle) without a Shopify call", async () => {
    await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    store.contract.lines[0].skippedCycleIndex = 3; // upcoming is 5
    const updated = await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(updated.lines.find((l) => l.id === "line_1")!.skippedCycleIndex).toBeNull();
  });

  it("does not double-add when the line is already back on the cycle (concurrent undo)", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    // draft still holds line_1
    await unskipLineThisCycle(SHOP_DOMAIN, "c_1", "line_1");
    expect(mocks.draftLineAdd).not.toHaveBeenCalled();
    expect(store.contract.lines[0].skippedCycleIndex).toBeNull();
  });
});

// ── Invalidation ─────────────────────────────────────────────────────────────

describe("invalidation — a per-line flag never outlives its cycle", () => {
  it("whole-cycle skip restores the per-line edit on Shopify FIRST, then clears flags ≤ the skipped cycle", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    store.contract.lines[1].cycleQuantityOverride = 3;
    store.contract.lines[1].cycleQuantityOverrideIndex = 5;
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 3 }];

    await skipNextCycle(SHOP_DOMAIN, "c_1");

    // Restored on the cycle before the skip committed.
    expect(mocks.draftLineAdd).toHaveBeenCalledWith(expect.anything(), "draft_1", {
      productVariantId: V1,
      quantity: 2,
      currentPriceCents: 4900,
    });
    expect(mocks.draftLineUpdate).toHaveBeenCalledWith(expect.anything(), "draft_1", LINE_2_GID, {
      quantity: 1,
    });
    expect(mocks.draftLineAdd.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.skipBillingCycle.mock.invocationCallOrder[0],
    );
    // Flags for the skipped cycle (5) are stale for the new upcoming cycle (6).
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 6);
    expect(mocks.skipBillingCycle).toHaveBeenCalledWith(expect.anything(), CONTRACT_GID, { index: 5 });
  });

  it("whole-cycle skip tolerates a Shopify user error on the restore and never queries when no flags exist", async () => {
    await skipNextCycle(SHOP_DOMAIN, "c_1");
    expect(mocks.draftLines).not.toHaveBeenCalled();
    expect(mocks.clearStaleCycleOverrides).not.toHaveBeenCalled();

    vi.clearAllMocks();
    store.contract = baseContract([line({ skippedCycleIndex: 5 }), line({ id: "line_2", shopifyLineId: LINE_2_GID, variantId: V2 })]);
    mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
    mocks.getContract.mockResolvedValue({ nextBillingDate: NEXT });
    mocks.withBillingCycleEdit.mockRejectedValueOnce(new ShopifyUserError("gone", []));
    await skipNextCycle(SHOP_DOMAIN, "c_1");
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 6);
  });

  it("re-anchor (delaySchedule) / next-date change / frequency change reconcile against the cycle at the new date", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    const NEW = new Date("2026-09-28T22:00:00.000Z");
    mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: NEW });
    // The cycle now at the new date is index 6 → flags on 5 are stale.
    mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 6, skipped: false });

    await setNextBillingDate(SHOP_DOMAIN, "c_1", NEW);
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 6);

    mocks.clearStaleCycleOverrides.mockClear();
    store.contract.nextBillingDate = NEXT;
    await delaySchedule(SHOP_DOMAIN, "c_1", { weeks: 2 });
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 6);

    mocks.clearStaleCycleOverrides.mockClear();
    mocks.getContract.mockResolvedValue({ nextBillingDate: NEW });
    await changeFrequency(SHOP_DOMAIN, "c_1", { unit: "WEEK", count: 6 });
    expect(mocks.clearStaleCycleOverrides).toHaveBeenCalledWith("c_1", 6);
  });

  it("when the cycle at the new date cannot be resolved, the flags are cleared outright (never trusted)", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    const NEW = new Date("2026-09-28T22:00:00.000Z");
    mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: NEW });
    mocks.getBillingCycleByDate.mockRejectedValue(new Error("shopify down"));
    await setNextBillingDate(SHOP_DOMAIN, "c_1", NEW);
    expect(mocks.clearStaleCycleOverrides).not.toHaveBeenCalled();
    expect(mocks.lineUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contractId: "c_1" }),
        data: {
          skippedCycleIndex: null,
          cycleQuantityOverride: null,
          cycleQuantityOverrideIndex: null,
        },
      }),
    );
    // The date change itself still landed.
    expect(store.contract.nextBillingDate).toEqual(NEW);
  });

  it("schedule moves without any flag do not touch the cycle-override columns", async () => {
    const NEW = new Date("2026-09-28T22:00:00.000Z");
    mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: NEW });
    await setNextBillingDate(SHOP_DOMAIN, "c_1", NEW);
    expect(mocks.clearStaleCycleOverrides).not.toHaveBeenCalled();
    expect(mocks.lineUpdateMany).not.toHaveBeenCalled();
  });
});

// ── Undo (undo.server) ───────────────────────────────────────────────────────

describe("Undo — line_skip spec", () => {
  const binding = { shopId: "shop_1", contractId: "c_1", customerId: "gid://shopify/Customer/5" };
  const timing = { chargeHourLocal: 0, tz: "Europe/Zurich", preparingWindowHours: 6 } as never;

  it("normalizes / rejects the spec shape and round-trips through the signed token", () => {
    expect(normalizeSpec({ kind: "line_skip", lineId: "line_1", cycleIndex: 5 })).toEqual({
      kind: "line_skip",
      lineId: "line_1",
      cycleIndex: 5,
    });
    expect(normalizeSpec({ kind: "line_skip", lineId: "../x", cycleIndex: 5 })).toBeNull();
    expect(normalizeSpec({ kind: "line_skip", lineId: "line_1", cycleIndex: -1 })).toBeNull();
    const token = mintUndoToken({ kind: "line_skip", lineId: "line_1", cycleIndex: 5 }, binding, 60);
    expect(token).toBeTruthy();
    const read = readUndoToken(token as string, binding);
    expect(read).toEqual({ ok: true, spec: { kind: "line_skip", lineId: "line_1", cycleIndex: 5 } });
  });

  it("restores through unskipLineThisCycle when the flag still matches, is stale otherwise", async () => {
    const prismaMod = (await import("~/db.server")).default as unknown as {
      contractLine: { findFirst?: unknown };
    };
    // The undo path reads the line to re-check the flag.
    prismaMod.contractLine.findFirst = vi.fn(async () =>
      store.contract.lines.find((l) => l.id === "line_1"),
    );
    store.contract.lines[0].skippedCycleIndex = 5;
    store.draftLines = [{ id: LINE_2_GID, variantId: V2, quantity: 1 }];
    const contract = store.contract as never;

    const restored = await performUndo(
      SHOP_DOMAIN,
      contract,
      { kind: "line_skip", lineId: "line_1", cycleIndex: 5 },
      { source: "CUSTOMER_PORTAL", actor: "customer", via: "portal", timing },
      new Date("2026-08-17T10:00:00Z"),
    );
    expect(restored.kind).toBe("restored");
    expect(mocks.draftLineAdd).toHaveBeenCalledTimes(1);
    expect(store.contract.lines[0].skippedCycleIndex).toBeNull();

    // Flag gone (cycle settled / skipped whole / already undone) ⇒ stale, nothing moves.
    mocks.draftLineAdd.mockClear();
    const stale = await performUndo(
      SHOP_DOMAIN,
      contract,
      { kind: "line_skip", lineId: "line_1", cycleIndex: 5 },
      { source: "CUSTOMER_PORTAL", actor: "customer", via: "portal", timing },
      new Date("2026-08-17T10:00:00Z"),
    );
    expect(stale.kind).toBe("stale");
    expect(mocks.draftLineAdd).not.toHaveBeenCalled();
    const audits = eventsOfType("portal.undo").map((e) => e.payload.outcome);
    expect(audits).toEqual(["restored", "stale"]);
  });
});

// ── Toast resolver + copy ────────────────────────────────────────────────────

describe("toasts and copy", () => {
  it("line_skipped carries the order date and an Undo form; skip_line_last_line is an alert", () => {
    for (const key of ["line_skipped", "line_unskipped", "line_qty_once", "line_qty_restored", "skip_line_last_line"]) {
      expect(TOAST_KEYS.has(key)).toBe(true);
      expect((en as Record<string, string>)[`portal.toast.${key}`]).toBeTruthy();
    }
    expect(toastTone("skip_line_last_line")).toBe("alert");
    expect(toastTone("line_skipped")).toBe("status");

    const url = `https://cellexialabs.com${PORTAL_PROXY_BASE}/subscription/c_1?toast=line_skipped&d1=2026-09-15&undo=portal_undo.9&cid=c_1`;
    const resolved = resolveToast(new Request(url), "en", {
      csrfToken: "csrf",
      contractIds: new Set(["c_1"]),
    });
    expect(resolved?.toast.text).toContain("September 15, 2026");
    expect(resolved?.toast.html).toContain("/api/undo");
    expect(resolved?.toast.html).toContain('name="undo_token" value="portal_undo.9"');
  });

  it("the whole-order-skip refusal names the whole-order action the portal actually offers", () => {
    const copy = (en as Record<string, string>)["portal.toast.skip_line_last_line"];
    expect(copy).toContain((en as Record<string, string>)["portal.actions.skip"]);
  });

  it("items-card copy makes 'every order' vs 'just this order' explicit", () => {
    const e = en as Record<string, string>;
    expect(e["portal.items.qty_every_order"]).toBe("Change for every order");
    expect(e["portal.items.qty_this_order"]).toBe("Just this order");
    expect(e["portal.items.skip_line"]).toBe("Not this time");
    expect(e["portal.items.skipped_badge"]).toContain("{date}");
  });
});

// ── setLineQuantityThisCycle guard that belongs with the skip semantics ──────

describe("skip × one-cycle quantity", () => {
  it("a quantity tweak on a line skipped for this cycle is refused (typed SKIPPED_THIS_CYCLE)", async () => {
    store.contract.lines[0].skippedCycleIndex = 5;
    await expect(setLineQuantityThisCycle(SHOP_DOMAIN, "c_1", "line_1", 1)).rejects.toMatchObject({
      code: "SKIPPED_THIS_CYCLE",
    });
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });
});
