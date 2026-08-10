import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Consolidation + stockout collection fixes (data-collection audit):
 *
 *  - runAutoConsolidation clusters on the EXACT cadence token
 *    (contractFrequency → "{count}:{unit}"), never the intervalWeeks
 *    approximation: MONTH×4 / DAY-ceil-÷7 map DISTINCT cadences to the same
 *    integer, and this grouping feeds a DESTRUCTIVE merge (sources are
 *    cancelled) — an approximation collision must never decide that.
 *  - mergeContracts carries sellingPlanId/sellingPlanName onto the primary
 *    (Shopify draft input AND local mirror), so per-line plan attribution
 *    survives a merge.
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
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    contractLine: { create: mocks.lineCreate },
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

function seed(rows: Array<Record<string, unknown>>) {
  store.contracts = rows;
  store.byId = new Map(rows.map((r) => [r.id as string, r]));
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
