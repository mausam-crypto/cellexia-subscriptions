import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Gift grant REMOVED transitions — every flip logs cycle.gift_removed, and
 * none of them may touch shippedAt.
 *
 * Two silent paths (data-collection audit):
 *  - clearShippedGiftMirrors logged only when a mirror LINE came off; a
 *    grant whose variant was kept alive by a still-live grant (or whose
 *    mirror was already gone) flipped SHIPPED→REMOVED with no trace.
 *  - the duplicate-supersede path in ensureGiftsForUpcomingCycle retired a
 *    stranded ADDED grant with no event at all.
 *
 * shippedAt (migration 0016) is the durable "this gift left the building"
 * fact — analytics count gift COGS by it — so REMOVED flips write status
 * (+ removedAt) only and must never clear it.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  giftGrantFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "grant_1",
      rule: null,
      ...args.data,
    }),
  ),
  giftGrantUpdateMany: vi.fn(async (_args?: unknown): Promise<{ count: number }> => ({
    count: 1,
  })),
  giftRuleFindMany: vi.fn(async (): Promise<unknown[]> => []),
  contractLineDeleteMany: vi.fn(async (): Promise<{ count: number }> => ({
    count: 0,
  })),
  getBillingCycleByIndex: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => null,
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    giftGrant: {
      findMany: mocks.giftGrantFindMany,
      findFirst: mocks.giftGrantFindFirst,
      update: mocks.giftGrantUpdate,
      updateMany: mocks.giftGrantUpdateMany,
    },
    giftRule: { findMany: mocks.giftRuleFindMany },
    contractLine: { deleteMany: mocks.contractLineDeleteMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineAdd: vi.fn(async (): Promise<unknown> => ({})),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: mocks.getBillingCycleByIndex,
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  withBillingCycleEdit: vi.fn(async (): Promise<unknown> => ({})),
}));

import {
  clearShippedGiftMirrors,
  ensureGiftsForUpcomingCycle,
} from "~/lib/gifts/engine.server";

const VARIANT = "gid://shopify/ProductVariant/77";

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    ordersCount: 4,
    intervalWeeks: 4,
    nextBillingDate: new Date("2026-08-15T09:00:00Z"),
    lines: [],
    ...over,
  };
}

function removedEvents(): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === "cycle.gift_removed")
    .map((e) => e.payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.giftGrantFindMany.mockResolvedValue([]);
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  mocks.giftRuleFindMany.mockResolvedValue([]);
});

// ── clearShippedGiftMirrors ─────────────────────────────────────────────────

describe("clearShippedGiftMirrors", () => {
  function primeGrants(params: {
    shipped: Array<Record<string, unknown>>;
    live: Array<Record<string, unknown>>;
  }): void {
    // Route by query shape (not call order — an early return would leave a
    // queued once-value behind for the NEXT test): the shipped query filters
    // status: "SHIPPED", the live query status: { in: [...] }.
    mocks.giftGrantFindMany.mockImplementation(
      async (args?: unknown): Promise<unknown[]> => {
        const status = (args as { where?: { status?: unknown } } | undefined)
          ?.where?.status;
        return status === "SHIPPED" ? params.shipped : params.live;
      },
    );
  }

  it("logs cycle.gift_removed even when no mirror line came off (variant still live)", async () => {
    primeGrants({
      shipped: [
        {
          id: "grant_1",
          contractId: "c_1",
          cycleIndex: 5,
          variantId: VARIANT,
          status: "SHIPPED",
          shippedAt: new Date("2026-08-01T00:00:00Z"),
        },
      ],
      // A SCHEDULED grant for the same variant keeps the mirror alive.
      live: [{ variantId: VARIANT }],
    });
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({
        lines: [
          {
            id: "line_1",
            isGift: true,
            variantId: VARIANT,
            title: "Travel Mask",
          },
        ],
      }),
    );

    const removed = await clearShippedGiftMirrors("c_1");

    expect(removed).toBe(0);
    expect(mocks.contractLineDeleteMany).not.toHaveBeenCalled();
    // The SHIPPED→REMOVED flip still happened — and still left a trace.
    expect(mocks.giftGrantUpdateMany).toHaveBeenCalledTimes(1);
    const eventsLogged = removedEvents();
    expect(eventsLogged).toHaveLength(1);
    expect(eventsLogged[0]).toMatchObject({
      grantIds: ["grant_1"],
      mirrorLinesCleared: 0,
      reason: "shipped_cycle_scoped_edit_expired",
    });
  });

  it("REMOVED flips write status + removedAt only — shippedAt survives", async () => {
    primeGrants({
      shipped: [
        {
          id: "grant_1",
          contractId: "c_1",
          cycleIndex: 5,
          variantId: VARIANT,
          status: "SHIPPED",
          shippedAt: new Date("2026-08-01T00:00:00Z"),
        },
      ],
      live: [],
    });

    await clearShippedGiftMirrors("c_1");

    const data = (
      mocks.giftGrantUpdateMany.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      }
    ).data;
    expect(Object.keys(data).sort()).toEqual(["removedAt", "status"]);
    expect(data.status).toBe("REMOVED");
  });

  it("clears the mirror line and reports it on the same event", async () => {
    primeGrants({
      shipped: [
        {
          id: "grant_1",
          contractId: "c_1",
          cycleIndex: 5,
          variantId: VARIANT,
          status: "SHIPPED",
        },
      ],
      live: [],
    });
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({
        lines: [
          {
            id: "line_1",
            isGift: true,
            variantId: VARIANT,
            title: "Travel Mask",
          },
        ],
      }),
    );

    const removed = await clearShippedGiftMirrors("c_1");

    expect(removed).toBe(1);
    expect(mocks.contractLineDeleteMany).toHaveBeenCalledTimes(1);
    expect(removedEvents()[0]).toMatchObject({
      titles: ["Travel Mask"],
      mirrorLinesCleared: 1,
    });
  });

  it("nothing shipped → no flip, no event", async () => {
    primeGrants({ shipped: [], live: [] });

    expect(await clearShippedGiftMirrors("c_1")).toBe(0);
    expect(mocks.giftGrantUpdateMany).not.toHaveBeenCalled();
    expect(removedEvents()).toHaveLength(0);
  });
});

// ── Duplicate-supersede path ────────────────────────────────────────────────

describe("ensureGiftsForUpcomingCycle duplicate supersede", () => {
  it("retiring a stranded ADDED grant logs cycle.gift_removed with its cause", async () => {
    // Stranded ADDED grant on cycle 3 (its cycle was skipped) whose variant
    // is already promised on the ensured cycle 5 by another grant.
    mocks.giftGrantFindMany.mockResolvedValue([
      {
        id: "grant_old",
        contractId: "c_1",
        ruleId: null,
        cycleIndex: 3,
        variantId: VARIANT,
        status: "ADDED",
        shippedAt: null,
        rule: null,
      },
    ]);
    mocks.getBillingCycleByIndex.mockImplementation(
      async (_admin: unknown, _gid: unknown, index: unknown) =>
        index === 3
          ? { cycleIndex: 3, skipped: true, status: "UNBILLED" }
          : { cycleIndex: 5, skipped: false, status: "UNBILLED", billingAttemptExpectedDate: null },
    );
    mocks.giftGrantFindFirst.mockResolvedValue({ id: "grant_dup" });

    await ensureGiftsForUpcomingCycle("c_1", 5);

    expect(mocks.giftGrantUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.giftGrantUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(update.where.id).toBe("grant_old");
    expect(Object.keys(update.data).sort()).toEqual(["removedAt", "status"]);
    expect(update.data.status).toBe("REMOVED");

    const eventsLogged = removedEvents();
    expect(eventsLogged).toHaveLength(1);
    expect(eventsLogged[0]).toMatchObject({
      grantIds: ["grant_old"],
      cycleIndexes: [3],
      variantId: VARIANT,
      supersededByGrantId: "grant_dup",
      reason: "superseded_by_target_cycle_grant",
    });
  });
});
