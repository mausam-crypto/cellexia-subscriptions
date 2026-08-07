import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Winback reactivation gift — cycle-index space (the stranded-promise bug).
 *
 * The defect: grantReactivationGift stamped the GiftGrant with
 * ordersCount + 1. Shopify billing-cycle indexes diverge from ordersCount
 * permanently after any skipped or unbilled cycle (a skipped cycle KEEPS its
 * index), so on such contracts the grant's index never matched the real
 * upcoming cycle: the pre-charge attach (ensureGiftsForUpcomingCycle) matches
 * SCHEDULED grants on the EXACT index and never found it, while the daily job
 * resolved the ordersCount-space index to an already skipped/billed cycle and
 * returned early. The customer was told on the magic-link page that a free
 * gift was coming — it silently never shipped.
 *
 * The fix: the grant's cycleIndex is resolved from Shopify — the cycle
 * containing effectiveNext, the billing date reactivation just set. When that
 * read fails, ordersCount + 1 remains the fallback and the gift engine's
 * stale-grant re-anchoring (gift-reanchor.test.ts) repairs it pre-charge.
 *
 * These tests drive the REAL reactivateFromWinback with every seam mocked.
 */

const EFFECTIVE_NEXT = new Date("2026-08-10T09:00:00Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
const GIFT_VARIANT = "gid://shopify/ProductVariant/77";

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (): Promise<unknown> => null),
  contractFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({})),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  shopFindUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  winbackStateFindUnique: vi.fn(async (): Promise<unknown> => null),
  winbackStateUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  giftRuleFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantFindFirst: vi.fn(async (): Promise<unknown> => null),
  giftGrantCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "grant_1",
    ...args.data,
  })),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getSetting: vi.fn(async (): Promise<unknown> => ({
    reactivationBillDelayDays: 3,
    linkGraceDays: 7,
    discountPct: 15,
    discountCycles: 2,
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: EFFECTIVE_NEXT,
  })),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => {
  const client = {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      findUniqueOrThrow: mocks.contractFindUniqueOrThrow,
      update: mocks.contractUpdate,
    },
    shop: { findUniqueOrThrow: mocks.shopFindUniqueOrThrow },
    winbackState: {
      findUnique: mocks.winbackStateFindUnique,
      update: mocks.winbackStateUpdate,
    },
    giftRule: { findFirst: mocks.giftRuleFindFirst },
    giftGrant: {
      findFirst: mocks.giftGrantFindFirst,
      create: mocks.giftGrantCreate,
    },
    // Failed-cycle release (step 1b, migration 0013) — no open case, nothing
    // to supersede in these fixtures; pinned by winback-cycle-release.test.ts.
    dunningCase: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    billingAttempt: {
      updateMany: vi.fn(async (): Promise<{ count: number }> => ({ count: 0 })),
    },
    // Interactive-transaction shim: the ACTIVE mirror write + step-1b release
    // commit together in the real engine; the mock just runs the closure.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { default: client };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: mocks.clampGrantPercentForContract,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://magic"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: mocks.contractActivate,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  setNextBillingDate: mocks.setNextBillingDate,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: mocks.applyDiscountGrant,
}));

import { reactivateFromWinback } from "~/lib/winback/engine.server";

function contractFixture() {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    status: "CANCELLED",
    ownership: "OURS",
    isDemo: false,
    // 4 successful orders — but the customer skipped a cycle before
    // cancelling, so Shopify's real upcoming cycle index is 7, not 5.
    ordersCount: 4,
    intervalWeeks: 4,
    currencyCode: "CHF",
    locale: "en",
    cancelledAt: new Date("2026-07-01T00:00:00Z"),
    cancelReason: "too_much_product",
    cancelSource: "PORTAL",
    failedAt: null,
    nextBillingDate: null,
    lines: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.contractFindUniqueOrThrow.mockResolvedValue(contractFixture());
  mocks.shopFindUniqueOrThrow.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
  mocks.setNextBillingDate.mockResolvedValue({
    nextBillingDate: EFFECTIVE_NEXT,
  });
  mocks.giftRuleFindFirst.mockResolvedValue({
    id: "rule_1",
    variantId: GIFT_VARIANT,
    name: "Surprise gift",
    variantTitle: "Mini Serum",
  });
  mocks.giftGrantFindFirst.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("grantReactivationGift stamps the REAL Shopify cycle index", () => {
  it("resolves the cycle containing the reactivation billing date — not ordersCount + 1", async () => {
    // The diverged contract: Shopify says the cycle at effectiveNext is 7.
    mocks.getBillingCycleByDate.mockResolvedValue({
      cycleIndex: 7,
      billingAttemptExpectedDate: EFFECTIVE_NEXT,
      skipped: false,
      edited: false,
      status: "UNBILLED",
    });

    await reactivateFromWinback("c_1", { gift: true });

    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      EFFECTIVE_NEXT,
    );
    expect(mocks.giftGrantCreate).toHaveBeenCalledTimes(1);
    const data = (mocks.giftGrantCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    // ordersCount + 1 would be 5 — the pre-charge attach (exact-index match)
    // would never find it and the promised gift would never ship.
    expect(data.cycleIndex).toBe(7);
    expect(data.variantId).toBe(GIFT_VARIANT);
    expect(data.status).toBe("SCHEDULED");

    const scheduled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "lifecycle.gift_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toMatchObject({ cycleIndex: 7 });

    // The reactivation event reports the gift as granted.
    const reactivated = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "winback.reactivated");
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].payload).toMatchObject({ gift: true });
  });

  it("replayed links dedupe on the RESOLVED index", async () => {
    mocks.getBillingCycleByDate.mockResolvedValue({
      cycleIndex: 7,
      billingAttemptExpectedDate: EFFECTIVE_NEXT,
      skipped: false,
      edited: false,
      status: "UNBILLED",
    });
    mocks.giftGrantFindFirst.mockResolvedValue({ id: "grant_existing" });

    await reactivateFromWinback("c_1", { gift: true });

    expect(mocks.giftGrantFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cycleIndex: 7 }),
      }),
    );
    expect(mocks.giftGrantCreate).not.toHaveBeenCalled();
  });

  it("falls back to ordersCount + 1 when the cycle read fails (repaired later by re-anchoring)", async () => {
    mocks.getBillingCycleByDate.mockRejectedValue(new Error("shopify 500"));

    await reactivateFromWinback("c_1", { gift: true });

    expect(mocks.giftGrantCreate).toHaveBeenCalledTimes(1);
    const data = (mocks.giftGrantCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.cycleIndex).toBe(5); // best local estimate, not a crash
  });

  it("falls back to ordersCount + 1 when Shopify has no cycle at the date", async () => {
    mocks.getBillingCycleByDate.mockResolvedValue(null);

    await reactivateFromWinback("c_1", { gift: true });

    const data = (mocks.giftGrantCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }).data;
    expect(data.cycleIndex).toBe(5);
  });
});
