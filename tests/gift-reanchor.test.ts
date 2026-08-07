import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stranded SCHEDULED gift grants are re-anchored to the cycle being charged.
 *
 * A SCHEDULED grant sitting on an EARLIER cycle index than the cycle being
 * ensured is a promise on its way to being broken: the pre-charge attach
 * matches SCHEDULED grants on the EXACT index, so once the grant's own cycle
 * can no longer charge (skipped or billed — the winback engine used to stamp
 * reactivation gifts in ordersCount space, which diverges from Shopify's
 * indexes after any skip) it would sit SCHEDULED forever and the promised
 * gift would never ship.
 *
 * ensureGiftsForUpcomingCycle now reads grants with cycleIndex <= the ensured
 * cycle and re-anchors the stale ones — but ONLY when their own cycle is
 * provably unbillable (skipped, billed or gone). A grant for an earlier
 * cycle that can still charge (the create-webhook ensures cycles 1 AND 2 —
 * cycle 1's grants must not be stolen by the ensure(2) call) keeps riding its
 * own cycle, and a transient Shopify read failure never triggers a re-anchor.
 *
 * These tests drive the REAL ensureGiftsForUpcomingCycle with every seam
 * mocked.
 */

const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
const GIFT_VARIANT = "gid://shopify/ProductVariant/77";

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  shopFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({})),
  giftRuleFindMany: vi.fn(async (): Promise<unknown[]> => []),
  giftGrantFindMany: vi.fn(async (): Promise<unknown[]> => []),
  giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantUpdate: vi.fn(
    async (_args: { data: Record<string, unknown> }): Promise<unknown> => ({}),
  ),
  giftGrantCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  subscriberEventFindFirst: vi.fn(
    async (_args?: unknown): Promise<unknown> => null,
  ),
  lineFindFirst: vi.fn(async (): Promise<unknown> => null),
  lineCreate: vi.fn(async (args: unknown): Promise<unknown> => args),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  getBillingCycleByIndex: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => null,
  ),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: string,
      _cycle: unknown,
      body: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      await body("draft_1", {});
    },
  ),
  draftLineAdd: vi.fn(async (): Promise<string> => "gid://shopify/Line/900"),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: { findUniqueOrThrow: mocks.shopFindUniqueOrThrow },
    giftRule: { findMany: mocks.giftRuleFindMany },
    giftGrant: {
      findMany: mocks.giftGrantFindMany,
      findFirst: mocks.giftGrantFindFirst,
      update: mocks.giftGrantUpdate,
      create: mocks.giftGrantCreate,
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    contractLine: {
      findFirst: mocks.lineFindFirst,
      create: mocks.lineCreate,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineAdd: mocks.draftLineAdd,
  getBillingCycleByIndex: mocks.getBillingCycleByIndex,
  getVariants: mocks.getVariants,
  withBillingCycleEdit: mocks.withBillingCycleEdit,
}));

import { ensureGiftsForUpcomingCycle } from "~/lib/gifts/engine.server";

function contractFixture() {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    ordersCount: 4,
    intervalWeeks: 4,
    firstChargeAt: new Date("2026-01-05T09:00:00Z"),
    nextBillingDate: new Date("2026-08-10T09:00:00Z"),
    currencyCode: "CHF",
    locale: "en",
    lines: [],
  };
}

/** The winback grant stranded in ordersCount space (cycle 5; real cycle 7). */
function strandedGrant(cycleIndex = 5) {
  return {
    id: "grant_stranded",
    contractId: "c_1",
    ruleId: "rule_1",
    cycleIndex,
    variantId: GIFT_VARIANT,
    status: "SCHEDULED",
    addedAt: null,
    removedAt: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    rule: null,
  };
}

/** A grant whose zero-priced line was COMMITTED onto its cycle (ADDED). */
function addedGrant(cycleIndex = 5) {
  return {
    ...strandedGrant(cycleIndex),
    id: "grant_added",
    status: "ADDED",
    addedAt: new Date("2026-08-02T00:00:00Z"),
  };
}

function cycle(index: number, over: Record<string, unknown> = {}) {
  return {
    cycleIndex: index,
    billingAttemptExpectedDate: new Date("2026-08-10T09:00:00Z"),
    skipped: false,
    edited: false,
    status: "UNBILLED",
    ...over,
  };
}

function reanchorUpdates() {
  return mocks.giftGrantUpdate.mock.calls.filter(
    (c) =>
      "cycleIndex" in
      (c[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
  mocks.giftRuleFindMany.mockResolvedValue([]);
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  mocks.giftGrantUpdate.mockImplementation(
    async (args: { data: Record<string, unknown> }) => ({
      ...strandedGrant(),
      ...args.data,
      rule: null,
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("stranded SCHEDULED grants are re-anchored to the charged cycle", () => {
  it("re-anchors a grant whose own cycle was skipped, then attaches it to the REAL cycle", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { skipped: true }) : cycle(index as number),
    );

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    // The lte read is what surfaces the stranded promise at all.
    expect(mocks.giftGrantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cycleIndex: { lte: 7 } }),
      }),
    );

    // Re-anchored onto the cycle actually being charged...
    const reanchors = reanchorUpdates();
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0][0]).toMatchObject({
      where: { id: "grant_stranded" },
      data: { cycleIndex: 7 },
    });
    expect(result.reanchored).toBe(1);

    // ...audited...
    const rescheduled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "lifecycle.gift_rescheduled");
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0].payload).toMatchObject({
      grantId: "grant_stranded",
      fromCycleIndex: 5,
      toCycleIndex: 7,
    });

    // ...and ATTACHED to cycle 7 — the promise ships with the real charge.
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 7 },
      expect.any(Function),
    );
    expect(result.linesAdded).toBe(1);
  });

  it("re-anchors when the stale cycle is BILLED or gone entirely", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { status: "BILLED" }) : cycle(index as number),
    );
    await ensureGiftsForUpcomingCycle("c_1", 7);
    expect(reanchorUpdates()).toHaveLength(1);

    vi.clearAllMocks();
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.shopFindUniqueOrThrow.mockResolvedValue({
      id: "shop_1",
      domain: "cellexia.myshopify.com",
      ianaTimezone: "Europe/Zurich",
    });
    mocks.giftRuleFindMany.mockResolvedValue([]);
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(5)]);
    mocks.giftGrantFindFirst.mockResolvedValue(null);
    mocks.giftGrantUpdate.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({
        ...strandedGrant(),
        ...args.data,
        rule: null,
      }),
    );
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? null : cycle(index as number),
    );
    await ensureGiftsForUpcomingCycle("c_1", 7);
    expect(reanchorUpdates()).toHaveLength(1);
  });

  it("does NOT steal a grant whose earlier cycle can still charge (create-webhook ensures 1 AND 2)", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(1)]);
    // Cycle 1 is upcoming and chargeable — the ensure(2) call must leave it.
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        cycle(index as number),
    );

    const result = await ensureGiftsForUpcomingCycle("c_1", 2);

    expect(reanchorUpdates()).toHaveLength(0);
    expect(result.reanchored ?? 0).toBe(0);
    // Not attached to cycle 2 either — it rides its own cycle.
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("never re-anchors on a transient cycle-read failure", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) => {
        if (index === 5) throw new Error("shopify 500");
        return cycle(index as number);
      },
    );

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    expect(reanchorUpdates()).toHaveLength(0);
    expect(result.reanchored ?? 0).toBe(0);
    // Left SCHEDULED for the next ensure call — uncertainty is not license.
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("skips the re-anchor when the variant is already promised on the target cycle", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([strandedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { skipped: true }) : cycle(index as number),
    );
    // A grant for (contract, cycle 7, same variant) already exists.
    mocks.giftGrantFindFirst.mockResolvedValue({ id: "grant_target" });

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    expect(reanchorUpdates()).toHaveLength(0);
    expect(result.reanchored ?? 0).toBe(0);
  });
});

/**
 * ADDED grants stranded by a skip. A grant flips ADDED once its zero-priced
 * line is COMMITTED onto its cycle — but that edit is cycle-scoped, so when
 * the customer then skips that cycle the line dies with it while the grant
 * stays ADDED: consumeCycleOnSuccess only flips the settling cycle's grants,
 * clearShippedGiftMirrors only clears SHIPPED ones, and the SCHEDULED-only
 * re-anchor never saw it. The portal showed the free gift on every future
 * order, forever, while it never shipped.
 */
describe("stranded ADDED grants (committed line died with a skipped cycle)", () => {
  it("re-anchors an ADDED grant off a skipped cycle and RE-COMMITS the line onto the ensured cycle", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([addedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { skipped: true }) : cycle(index as number),
    );
    mocks.giftGrantUpdate.mockImplementation(
      async (args: { data: Record<string, unknown> }) => ({
        ...addedGrant(),
        ...args.data,
        rule: null,
      }),
    );
    // The ORIGINAL commit's cycle.gift_added marker exists for cycle 5. The
    // idempotency check is per (grant, cycle), so it must NOT block the fresh
    // commit onto cycle 7 — a grant-only marker would strand the gift again.
    mocks.subscriberEventFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { AND?: Array<{ payload?: { equals?: unknown } }> } })
        .where;
      return where.AND?.[1]?.payload?.equals === 5 ? { id: "evt_cycle5" } : null;
    });
    // The isGift mirror from the original attach still exists — reused, never
    // duplicated.
    mocks.lineFindFirst.mockResolvedValue({ id: "line_gift_1" });

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    // Re-anchored AND reverted to SCHEDULED (retryable if the attach fails —
    // an ADDED grant claiming a line it never committed would be flipped
    // SHIPPED by the next settlement without ever shipping).
    const reanchors = reanchorUpdates();
    expect(reanchors).toHaveLength(1);
    expect(reanchors[0][0]).toMatchObject({
      where: { id: "grant_added" },
      data: { cycleIndex: 7, status: "SCHEDULED", addedAt: null },
    });
    expect(result.reanchored).toBe(1);

    // A FRESH zero-priced line is committed onto cycle 7 despite the cycle-5
    // marker, and the grant flips back to ADDED.
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 7 },
      expect.any(Function),
    );
    expect(mocks.draftLineAdd).toHaveBeenCalledTimes(1);
    expect(result.linesAdded).toBe(1);
    const addedFlips = mocks.giftGrantUpdate.mock.calls.filter(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.status === "ADDED",
    );
    expect(addedFlips).toHaveLength(1);

    // Mirror reused, not duplicated; the audit trail names the real reason.
    expect(mocks.lineCreate).not.toHaveBeenCalled();
    const rescheduled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "lifecycle.gift_rescheduled");
    expect(rescheduled).toHaveLength(1);
    expect(rescheduled[0].payload).toMatchObject({
      grantId: "grant_added",
      fromCycleIndex: 5,
      toCycleIndex: 7,
      reason: "added_grant_cycle_skipped",
    });
    const giftAdded = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "cycle.gift_added");
    expect(giftAdded).toHaveLength(1);
    expect(giftAdded[0].payload).toMatchObject({ cycleIndex: 7 });
  });

  it("flips a stranded ADDED grant SHIPPED when its cycle actually BILLED (lost settlement flip)", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([addedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { status: "BILLED" }) : cycle(index as number),
    );

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    // The line rode that billed order — SHIPPED, so mirror hygiene can clear.
    const shipped = mocks.giftGrantUpdate.mock.calls.filter(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.status === "SHIPPED",
    );
    expect(shipped).toHaveLength(1);
    expect(shipped[0][0]).toMatchObject({ where: { id: "grant_added" } });
    expect(reanchorUpdates()).toHaveLength(0);
    expect(result.reanchored ?? 0).toBe(0);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });

  it("leaves an ADDED grant alone when its cycle is gone or unreadable — a committed line is never moved on uncertainty", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([addedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? null : cycle(index as number),
    );
    const first = await ensureGiftsForUpcomingCycle("c_1", 7);
    expect(mocks.giftGrantUpdate).not.toHaveBeenCalled();
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(first.reanchored ?? 0).toBe(0);

    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) => {
        if (index === 5) throw new Error("shopify 500");
        return cycle(index as number);
      },
    );
    const second = await ensureGiftsForUpcomingCycle("c_1", 7);
    expect(mocks.giftGrantUpdate).not.toHaveBeenCalled();
    expect(second.reanchored ?? 0).toBe(0);
  });

  it("retires a stranded ADDED grant when the variant is already promised on the ensured cycle", async () => {
    mocks.giftGrantFindMany.mockResolvedValue([addedGrant(5)]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 5 ? cycle(5, { skipped: true }) : cycle(index as number),
    );
    // (contract, cycle 7, same variant) already has its own grant.
    mocks.giftGrantFindFirst.mockResolvedValue({ id: "grant_target" });

    const result = await ensureGiftsForUpcomingCycle("c_1", 7);

    // REMOVED — left ADDED it would hold the shared isGift mirror live
    // forever, even after the superseding grant ships.
    const removed = mocks.giftGrantUpdate.mock.calls.filter(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data.status === "REMOVED",
    );
    expect(removed).toHaveLength(1);
    expect(removed[0][0]).toMatchObject({ where: { id: "grant_added" } });
    expect(reanchorUpdates()).toHaveLength(0);
    expect(result.reanchored ?? 0).toBe(0);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
  });
});
