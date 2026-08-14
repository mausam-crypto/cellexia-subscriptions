import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Consolidation + stockout collection fixes (data-collection audit):
 *
 *  - runAutoConsolidation clusters on the EXACT cadence token
 *    (contractFrequency → "{count}:{unit}"), never the intervalWeeks
 *    approximation: MONTH×4 / DAY-ceil-÷7 map DISTINCT cadences to the same
 *    integer, and this grouping feeds a DESTRUCTIVE merge (sources are
 *    cancelled) — an approximation collision must never decide that.
 *  - runAutoConsolidation additionally clusters on delivery ROUTING
 *    (normalized address + payment method): the automatic path must never
 *    silently reroute a customer's parcels or switch whose card is charged.
 *    Null vs set compares different (fail-safe: don't merge what we cannot
 *    prove); null vs null compares equal.
 *  - mergeContracts carries sellingPlanId/sellingPlanName onto the primary
 *    (Shopify draft input AND local mirror), so per-line plan attribution
 *    survives a merge.
 *  - mergeContracts is retry-safe: `mergeGroupId = primary.id` is stamped on
 *    each source AFTER the Shopify draft commit and BEFORE the cancel phase,
 *    so a retry after a failed source cancel resumes with cancel only and
 *    NEVER re-copies the lines (a re-copy is a recurring double charge).
 *  - mergeContracts moves the source's live DiscountGrants onto the primary
 *    (re-clamped under the stacking cap; zero headroom = dropped audibly) —
 *    an accepted cancel-save / win-back promise survives consolidation.
 *  - evaluateStockoutForContract skips with initiator STOCKOUT and the
 *    policy reason (SKIP_NOTIFY vs MAX_DELAYS_REACHED escalation).
 */

const store = vi.hoisted(() => ({
  contracts: [] as Array<Record<string, unknown>>,
  byId: new Map<string, Record<string, unknown>>(),
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getSetting: vi.fn(async (): Promise<unknown> => ({
    autoMergeAlignedContracts: true,
    alignmentWindowDays: 3,
  })),
  cancelContract: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      ops: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<unknown> => {
      await ops("draft_1", {});
      return { contractId: "c" };
    },
  ),
  draftLineAdd: vi.fn(
    async (
      _run: unknown,
      _draftId: unknown,
      _input?: unknown,
    ): Promise<string | null> => "gid://shopify/SubscriptionLine/new",
  ),
  lineCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  contractUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  grantFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  grantUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  // Pass-through stacking clamp by default (full headroom); tests override
  // with mockResolvedValueOnce to exercise the clamped / zero-headroom paths.
  clampGrant: vi.fn(
    async (_shopId: unknown, _lines: unknown, percent: number) => ({
      percent,
      requestedPercent: percent,
      clamped: false,
      ongoingDiscountPct: 0,
      maxTotalDiscountPct: 100,
      headroomPct: 100 - percent,
    }),
  ),
  loadContractContext: vi.fn(async (_domain: string, id: string) => ({
    shop: {
      id: "shop_1",
      domain: "cellexia.myshopify.com",
      ianaTimezone: "Europe/Zurich",
    },
    contract: store.byId.get(id),
    admin: {},
  })),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 4,
    skipped: false,
  })),
  subscriberEventCount: vi.fn(async (): Promise<number> => 0),
  productCadenceFindFirst: vi.fn(async (): Promise<unknown> => null),
  stockoutSettings: { policy: "DELAY", delayDays: 7, maxDelays: 2, notifyCustomer: false },
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: vi.fn(async (): Promise<unknown[]> => store.contracts),
      findUnique: vi.fn(
        async (args: { where: { id: string } }): Promise<unknown> =>
          store.byId.get(args.where.id) ?? null,
      ),
      findUniqueOrThrow: vi.fn(
        async (args: { where: { id: string } }): Promise<unknown> =>
          store.byId.get(args.where.id),
      ),
      update: mocks.contractUpdate,
    },
    contractLine: { create: mocks.lineCreate },
    discountGrant: { findMany: mocks.grantFindMany, update: mocks.grantUpdate },
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
      })),
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
    productCadence: { findFirst: mocks.productCadenceFindFirst },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "consolidation") {
      return { autoMergeAlignedContracts: true, alignmentWindowDays: 3 };
    }
    return mocks.stockoutSettings;
  }),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineAdd: mocks.draftLineAdd,
  withContractDraft: mocks.withContractDraft,
  getVariants: mocks.getVariants,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
}));
vi.mock("~/lib/ownership/ownership.server", () => ({
  OURS_ONLY: { ownership: "OURS" },
  isBillableOwnership: (o: string): boolean => o === "OURS",
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: mocks.clampGrant,
}));
vi.mock("~/lib/contracts/service.server", () => ({
  cancelContract: mocks.cancelContract,
  skipNextCycle: mocks.skipNextCycle,
  delayNextCycle: mocks.delayNextCycle,
  swapLineVariant: mocks.swapLineVariant,
}));
vi.mock("~/lib/contracts/shared.server", () => ({
  eventIdentity: (
    shop: { id: string },
    contract: { id: string; customerId: string; email: string },
  ) => ({
    shopId: shop.id,
    contractId: contract.id,
    customerId: contract.customerId,
    email: contract.email,
  }),
  loadContractContext: mocks.loadContractContext,
  reloadContract: vi.fn(async (id: string): Promise<unknown> => ({ id, lines: [] })),
  resolveActor: (): string => "system",
  resolveSource: (): string => "SCHEDULER",
  withMirrorGuard: async <T,>(
    _fn: string,
    _ctx: unknown,
    _opts: unknown,
    mutate: () => Promise<T>,
  ): Promise<T> => mutate(),
}));

import {
  mergeContracts,
  runAutoConsolidation,
} from "~/lib/contracts/consolidation.server";
import { evaluateStockoutForContract } from "~/lib/contracts/stockout.server";

const OUR_PLAN = "gid://shopify/SellingPlan/111";

function contractRow(over: Record<string, unknown> = {}) {
  const row = {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: `gid://shopify/SubscriptionContract/${String(over.id ?? "c_1")}`,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    isPrepaid: false,
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: new Date("2026-08-20T09:00:00Z"),
    mergeGroupId: null,
    lines: [] as unknown[],
    ...over,
  };
  return row;
}

function movableLine(over: Record<string, unknown> = {}) {
  return {
    id: "ll_1",
    shopifyLineId: "gid://shopify/SubscriptionLine/7",
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/1",
    title: "Cream",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    sellingPlanId: OUR_PLAN,
    sellingPlanName: "Every 4 weeks",
    currentPriceCents: 6400,
    compareAtPriceCents: 8000,
    unitCostCents: 900,
    isGift: false,
    isOneTimeAddon: false,
    addedVia: "CHECKOUT",
    ...over,
  };
}

function seed(rows: Array<Record<string, unknown>>) {
  store.contracts = rows;
  store.byId = new Map(rows.map((r) => [r.id as string, r]));
}

/** The per-source contract.merged event logged for `contractId`, if any. */
function mergedEventFor(contractId: string) {
  return mocks.logEvent.mock.calls
    .map(
      (c) =>
        c[0] as {
          type: string;
          contractId: string;
          payload: Record<string, unknown>;
        },
    )
    .find((e) => e.type === "contract.merged" && e.contractId === contractId);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed([]);
  mocks.stockoutSettings = {
    policy: "DELAY",
    delayDays: 7,
    maxDelays: 2,
    notifyCustomer: false,
  };
  // clearAllMocks does not undo a mockResolvedValue — reset explicitly so
  // one test's grants never leak into the next.
  mocks.grantFindMany.mockResolvedValue([]);
});

describe("runAutoConsolidation — exact cadence clustering", () => {
  it("never merges cadences that only COLLIDE in the week approximation", async () => {
    // MONTH×1 and WEEK×4 both approximate to intervalWeeks 4 — merging them
    // would silently change what one of the two is billed on.
    seed([
      contractRow({
        id: "c_month",
        billingIntervalUnit: "MONTH",
        billingIntervalCount: 1,
      }),
      contractRow({
        id: "c_week",
        billingIntervalUnit: "WEEK",
        billingIntervalCount: 4,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(0);
    expect(result.contractsMerged).toBe(0);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("still merges genuinely identical cadences", async () => {
    seed([
      contractRow({ id: "c_a" }),
      contractRow({ id: "c_b", nextBillingDate: new Date("2026-08-21T09:00:00Z") }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(1);
    expect(result.contractsMerged).toBe(1);
    expect(mocks.cancelContract).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_b",
      "MERGED",
      expect.objectContaining({ cancelSource: "SYSTEM", scheduleWinback: false }),
    );
  });

  it("pre-v1.4.0 rows (null unit) group on their week mirror — all they know about themselves", async () => {
    seed([
      contractRow({ id: "c_old", billingIntervalUnit: null, billingIntervalCount: null }),
      contractRow({
        id: "c_new",
        nextBillingDate: new Date("2026-08-21T09:00:00Z"),
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    // contractFrequency degrades the null-unit row to WEEK×4 — the same
    // token as the exact-mirror row, so they still consolidate.
    expect(result.clustersMerged).toBe(1);
  });
});

describe("mergeContracts — plan lineage travels with moved lines", () => {
  it("passes sellingPlanId/Name to the Shopify draft and the mirror line", async () => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({
        id: "c_source",
        lines: [
          {
            id: "ll_1",
            shopifyLineId: "gid://shopify/SubscriptionLine/7",
            productId: "gid://shopify/Product/1",
            variantId: "gid://shopify/ProductVariant/1",
            title: "Cream",
            variantTitle: null,
            sku: null,
            imageUrl: null,
            quantity: 1,
            sellingPlanId: OUR_PLAN,
            sellingPlanName: "Every 4 weeks",
            currentPriceCents: 6400,
            compareAtPriceCents: 8000,
            unitCostCents: 900,
            isGift: false,
            isOneTimeAddon: false,
            addedVia: "CHECKOUT",
          },
        ],
      }),
    ]);

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    expect(mocks.draftLineAdd).toHaveBeenCalledTimes(1);
    expect(mocks.draftLineAdd.mock.calls[0][2]).toMatchObject({
      sellingPlanId: OUR_PLAN,
      sellingPlanName: "Every 4 weeks",
    });
    expect(mocks.lineCreate).toHaveBeenCalledTimes(1);
    const { data } = mocks.lineCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({
      sellingPlanId: OUR_PLAN,
      sellingPlanName: "Every 4 weeks",
    });
  });
});

describe("mergeContracts — retry safety (half-merged sources)", () => {
  it("a failed source cancel leaves the merge stamped: lines copied once, stamp written BEFORE the cancel attempt", async () => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({ id: "c_source", lines: [movableLine()] }),
    ]);
    mocks.cancelContract.mockRejectedValueOnce(new Error("shopify 5xx"));

    await expect(
      mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]),
    ).rejects.toThrow(/could not be cancelled/);

    // The lines were copied exactly once…
    expect(mocks.draftLineAdd).toHaveBeenCalledTimes(1);
    expect(mocks.lineCreate).toHaveBeenCalledTimes(1);
    // …and the source carries the merge stamp, written BEFORE the cancel was
    // attempted — the marker a retry resumes on instead of re-adding lines.
    const stampIndex = mocks.contractUpdate.mock.calls.findIndex((call) => {
      const arg = call[0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      return arg.where.id === "c_source" && arg.data.mergeGroupId === "c_primary";
    });
    expect(stampIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.contractUpdate.mock.invocationCallOrder[stampIndex]!).toBeLessThan(
      mocks.cancelContract.mock.invocationCallOrder[0]!,
    );
  });

  it("a retry resumes a half-merged source with cancel only — lines are NEVER copied twice", async () => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({
        id: "c_source",
        // Stamped by the prior attempt whose cancel failed: the lines are
        // already on the primary.
        mergeGroupId: "c_primary",
        lines: [movableLine()],
      }),
    ]);

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    expect(mocks.draftLineAdd).not.toHaveBeenCalled();
    expect(mocks.lineCreate).not.toHaveBeenCalled();
    expect(mocks.cancelContract).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_source",
      "MERGED",
      expect.objectContaining({ cancelSource: "SYSTEM", scheduleWinback: false }),
    );
    // Grants still ride the resumed merge (the prior attempt may have died
    // before moving them — the move is idempotent).
    expect(mocks.grantFindMany).toHaveBeenCalled();
    expect(mergedEventFor("c_source")?.payload).toMatchObject({
      mergedInto: "c_primary",
      resumed: true,
    });
  });

  it("refuses a source half-merged into a DIFFERENT contract (fail-safe: its lines live elsewhere)", async () => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({
        id: "c_source",
        mergeGroupId: "c_elsewhere",
        lines: [movableLine()],
      }),
    ]);

    await expect(
      mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]),
    ).rejects.toThrow(/half-merged into c_elsewhere/);

    expect(mocks.draftLineAdd).not.toHaveBeenCalled();
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("a former merge PRIMARY (mergeGroupId === own id) is still a fresh source", async () => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({
        id: "c_source",
        mergeGroupId: "c_source", // was the primary of an earlier merge
        lines: [movableLine()],
      }),
    ]);

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    expect(mocks.draftLineAdd).toHaveBeenCalledTimes(1);
    expect(mocks.cancelContract).toHaveBeenCalledTimes(1);
  });
});

describe("mergeContracts — discount grants ride the merge", () => {
  function grantRow(over: Record<string, unknown> = {}) {
    return {
      id: "g_1",
      contractId: "c_source",
      type: "SAVE_OFFER",
      percent: 20,
      cyclesTotal: 3,
      cyclesRemaining: 2,
      grantedBy: "cancel_flow",
      reason: null,
      createdAt: new Date("2026-08-01T00:00:00Z"),
      exhaustedAt: null,
      ...over,
    };
  }

  beforeEach(() => {
    seed([
      contractRow({ id: "c_primary" }),
      contractRow({ id: "c_source", lines: [movableLine()] }),
    ]);
  });

  it("moves live grants onto the primary and logs them on the merge event", async () => {
    mocks.grantFindMany.mockResolvedValue([grantRow()]);

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    // Only LIVE grants are considered (remaining cycles, not exhausted).
    expect(mocks.grantFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contractId: "c_source",
          cyclesRemaining: { gt: 0 },
          exhaustedAt: null,
        }),
      }),
    );
    expect(mocks.grantUpdate).toHaveBeenCalledWith({
      where: { id: "g_1" },
      data: { contractId: "c_primary" },
    });
    expect(mergedEventFor("c_source")?.payload.movedGrants).toEqual([
      { grantId: "g_1", type: "SAVE_OFFER", percent: 20, cyclesRemaining: 2 },
    ]);
  });

  it("re-clamps the percent against the primary's post-merge stacking headroom", async () => {
    mocks.grantFindMany.mockResolvedValue([grantRow()]);
    mocks.clampGrant.mockResolvedValueOnce({
      percent: 10,
      requestedPercent: 20,
      clamped: true,
      ongoingDiscountPct: 15,
      maxTotalDiscountPct: 25,
      headroomPct: 10,
    });

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    expect(mocks.grantUpdate).toHaveBeenCalledWith({
      where: { id: "g_1" },
      data: { contractId: "c_primary", percent: 10 },
    });
    expect(mergedEventFor("c_source")?.payload.movedGrants).toEqual([
      {
        grantId: "g_1",
        type: "SAVE_OFFER",
        percent: 10,
        cyclesRemaining: 2,
        clampedFromPercent: 20,
      },
    ]);
  });

  it("zero stacking headroom drops the grant audibly — never a silent move past the cap", async () => {
    mocks.grantFindMany.mockResolvedValue([grantRow()]);
    mocks.clampGrant.mockResolvedValueOnce({
      percent: 0,
      requestedPercent: 20,
      clamped: true,
      ongoingDiscountPct: 30,
      maxTotalDiscountPct: 30,
      headroomPct: 0,
    });

    await mergeContracts("cellexia.myshopify.com", "c_primary", ["c_source"]);

    expect(mocks.grantUpdate).not.toHaveBeenCalled();
    const payload = mergedEventFor("c_source")?.payload;
    expect(payload?.movedGrants).toBeUndefined();
    expect(payload?.droppedGrants).toEqual([
      {
        grantId: "g_1",
        type: "SAVE_OFFER",
        percent: 20,
        cyclesRemaining: 2,
        reason: "stacking_cap",
      },
    ]);
  });
});

describe("runAutoConsolidation — routing gate (address + payment method)", () => {
  const HOME = {
    firstName: "Ada",
    lastName: "Lovelace",
    company: null,
    address1: "12 High Street",
    address2: null,
    city: "London",
    provinceCode: null,
    countryCode: "GB",
    zip: "N1 9GU",
    phone: null,
  };
  const LATER = new Date("2026-08-21T09:00:00Z");

  it("never merges contracts shipping to different addresses", async () => {
    seed([
      contractRow({ id: "c_home", deliveryAddress: HOME }),
      contractRow({
        id: "c_office",
        deliveryAddress: { ...HOME, address1: "99 Office Park" },
        nextBillingDate: LATER,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(0);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("trim/case/whitespace differences are still the SAME address", async () => {
    seed([
      contractRow({ id: "c_a", deliveryAddress: HOME }),
      contractRow({
        id: "c_b",
        deliveryAddress: {
          ...HOME,
          address1: "  12  HIGH street ",
          city: "LONDON",
          zip: "n1 9gu",
          countryCode: "gb",
        },
        nextBillingDate: LATER,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(1);
    expect(mocks.cancelContract).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_b",
      "MERGED",
      expect.objectContaining({ cancelSource: "SYSTEM" }),
    );
  });

  it("the sync mirror shape (code + full-name fields) matches the portal shape (code fields only)", async () => {
    seed([
      contractRow({
        id: "c_sync",
        deliveryAddress: {
          ...HOME,
          provinceCode: "ENG",
          province: "England",
          country: "United Kingdom",
        },
      }),
      contractRow({
        id: "c_portal",
        deliveryAddress: { ...HOME, provinceCode: "ENG" },
        nextBillingDate: LATER,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(1);
  });

  it("a null address vs a set address never auto-merges (fail-safe: cannot prove the same destination)", async () => {
    seed([
      contractRow({ id: "c_a", deliveryAddress: null }),
      contractRow({ id: "c_b", deliveryAddress: HOME, nextBillingDate: LATER }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(0);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("two null addresses compare equal — nothing distinguishes them", async () => {
    seed([
      contractRow({ id: "c_a", deliveryAddress: null }),
      contractRow({ id: "c_b", deliveryAddress: null, nextBillingDate: LATER }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(1);
  });

  it("different payment methods never auto-merge", async () => {
    seed([
      contractRow({
        id: "c_a",
        deliveryAddress: HOME,
        paymentMethodId: "gid://shopify/CustomerPaymentMethod/1",
      }),
      contractRow({
        id: "c_b",
        deliveryAddress: HOME,
        paymentMethodId: "gid://shopify/CustomerPaymentMethod/2",
        nextBillingDate: LATER,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(0);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("a different recipient at the same street address never auto-merges (the recurring-gift case)", async () => {
    seed([
      contractRow({ id: "c_a", deliveryAddress: HOME }),
      contractRow({
        id: "c_b",
        deliveryAddress: { ...HOME, firstName: "Grace" },
        nextBillingDate: LATER,
      }),
    ]);

    const result = await runAutoConsolidation("shop_1");

    expect(result.clustersMerged).toBe(0);
  });
});

describe("evaluateStockoutForContract — merchant-skip attribution", () => {
  function stockedOutContract() {
    return contractRow({
      id: "c_1",
      lines: [
        {
          id: "ll_1",
          productId: "gid://shopify/Product/1",
          variantId: "gid://shopify/ProductVariant/1",
          title: "Cream",
          isGift: false,
          isOneTimeAddon: false,
        },
      ],
    });
  }

  beforeEach(() => {
    seed([stockedOutContract()]);
    // The single variant is out of stock.
    mocks.getVariants.mockResolvedValue([
      {
        id: "gid://shopify/ProductVariant/1",
        availableForSale: false,
        inventoryQuantity: 0,
      },
    ]);
    // clearAllMocks does not undo a mockResolvedValue — reset explicitly so
    // one test's delay count never leaks into the next.
    mocks.subscriberEventCount.mockResolvedValue(0);
  });

  it("SKIP_NOTIFY policy skips with initiator STOCKOUT and the policy reason", async () => {
    mocks.stockoutSettings = {
      policy: "SKIP_NOTIFY",
      delayDays: 7,
      maxDelays: 2,
      notifyCustomer: false,
    };

    const result = await evaluateStockoutForContract(
      "cellexia.myshopify.com",
      "c_1",
    );

    expect(result.action).toBe("SKIPPED");
    expect(mocks.skipNextCycle).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      expect.objectContaining({ initiator: "STOCKOUT", reason: "SKIP_NOTIFY" }),
    );
  });

  it("the delay-cap escalation carries MAX_DELAYS_REACHED", async () => {
    mocks.subscriberEventCount.mockResolvedValue(2); // at maxDelays

    const result = await evaluateStockoutForContract(
      "cellexia.myshopify.com",
      "c_1",
    );

    expect(result.action).toBe("SKIPPED");
    expect(mocks.skipNextCycle).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      expect.objectContaining({
        initiator: "STOCKOUT",
        reason: "MAX_DELAYS_REACHED",
      }),
    );
  });

  it("an uncapped DELAY still delays — no skip, no initiator involved", async () => {
    const result = await evaluateStockoutForContract(
      "cellexia.myshopify.com",
      "c_1",
    );

    expect(result.action).toBe("DELAYED");
    expect(mocks.skipNextCycle).not.toHaveBeenCalled();
    expect(mocks.delayNextCycle).toHaveBeenCalled();
  });
});
