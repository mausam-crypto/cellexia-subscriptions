import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mirror-fidelity guards in syncContractFromShopify (data-collection audit).
 *
 * The sync is the single writer of contract mirrors, so every value it drops,
 * invents or erases is dropped/invented/erased for EVERY downstream consumer
 * — permanently, when the source is behind Shopify's access horizons. These
 * tests pin the audit fixes:
 *
 *  - keep-guards: compareAtPriceCents / productId / variantId are never
 *    erased by a transient enrichment failure or a product deletion;
 *  - pricingPolicy (migration 0016) is mirrored per line, and min/maxCycles
 *    per contract;
 *  - locale refreshes on the update path (keep-if-absent);
 *  - card metadata is cleared when the payment method is GONE, kept when the
 *    method merely arrived without instrument details;
 *  - prepaidDeliveriesRemaining is seeded once, never reset;
 *  - webhook-observed cancels stamp cancelSource EXTERNAL (not SYSTEM), and
 *    EXPIRED transitions stamp expiredAt (flagged as observation-time);
 *  - a backfill (source SYSTEM) create of an already-terminal contract does
 *    NOT invent transition dates;
 *  - origin-order tax rides both origin-money capture paths;
 *  - a LATE firstChargeAt backfill re-upserts both affected rollup day
 *    labels (backfill mode, existing rows only) so the arrival does not
 *    vanish from the daily series.
 *
 * Scaffold: contract-ownership-sync.test.ts (everything DB/Shopify mocked).
 */

const mocks = vi.hoisted(() => ({
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ...args.data,
    }),
  ),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "local_1",
      customerId: "gid://shopify/Customer/1",
      email: "a@b.c",
      ...args.data,
    }),
  ),
  contractUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  lineCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  lineDeleteMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  planConfigFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  rollupFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  runDailyRollup: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_input: unknown): Promise<void> => {}),
  getContract: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({ createdAt: new Date() })),
  getSellingPlanGroupPlanIds: vi.fn(async (): Promise<string[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      create: mocks.contractCreate,
      update: mocks.contractUpdate,
      updateMany: mocks.contractUpdateMany,
      findMany: vi.fn(async (): Promise<unknown[]> => []),
    },
    contractLine: {
      create: mocks.lineCreate,
      update: mocks.lineUpdate,
      deleteMany: mocks.lineDeleteMany,
    },
    sellingPlanConfig: {
      findMany: mocks.planConfigFindMany,
      findFirst: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    dailyRollup: {
      findMany: mocks.rollupFindMany,
    },
  },
}));

// The sync's late-firstChargeAt rollup repair imports these lazily; stub them
// so the repair's CONTRACT (which labels, which mode) is pinned without
// transforming/running the whole analytics engine against this file's narrow
// db mock (the real graph is heavy enough to time the test out under full-
// suite load). The label stand-in mirrors shopDayLabelUtc exactly: the
// shop-tz calendar day as a synthetic UTC midnight.
vi.mock("~/lib/analytics/rollup.server", () => ({
  runDailyRollup: mocks.runDailyRollup,
}));
vi.mock("~/lib/analytics/queries.server", () => ({
  shopDayLabelUtc: (date: Date, tz: string) => {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    return new Date(`${ymd}T00:00:00.000Z`);
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/London",
    currencyCode: "CHF",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getContract: mocks.getContract,
  getVariants: mocks.getVariants,
  getOrderSummary: mocks.getOrderSummary,
  listContractGids: vi.fn(),
}));

vi.mock("~/lib/graphql/sellingPlans.server", () => ({
  getSellingPlanGroupPlanIds: mocks.getSellingPlanGroupPlanIds,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async (): Promise<unknown> => ({})),
  getShopMetafield: vi.fn(),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/contracts/shared.server", () => ({
  reloadContract: vi.fn(async (id: string): Promise<unknown> => ({ id, lines: [] })),
  resolveActor: vi.fn((): string => "system"),
}));

vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));

import { syncContractFromShopify } from "~/lib/contracts/sync.server";
import { normalizeLocale } from "~/lib/i18n/i18n.server";

const OUR_PLAN = "gid://shopify/SellingPlan/111";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/5";
const VARIANT_GID = "gid://shopify/ProductVariant/1";
const PRODUCT_GID = "gid://shopify/Product/1";

interface ContractOverrides {
  status?: string;
  billingPolicy?: Record<string, unknown>;
  deliveryPolicy?: Record<string, unknown> | null;
  customerPaymentMethod?: Record<string, unknown> | null;
  customerLocale?: string | null;
  lines?: Array<Record<string, unknown>>;
  originOrder?: { id: string; name: string } | null;
}

function line(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "gid://shopify/SubscriptionLine/1",
    productId: PRODUCT_GID,
    variantId: VARIANT_GID,
    title: "Cream",
    variantTitle: null,
    sku: null,
    quantity: 1,
    sellingPlanId: OUR_PLAN,
    sellingPlanName: "Every 8 weeks",
    currentPrice: "64.00",
    currentPriceCents: 6400,
    currencyCode: "CHF",
    pricingPolicy: null,
    imageUrl: null,
    ...over,
  };
}

function shopifyContract(over: ContractOverrides = {}): unknown {
  return {
    id: CONTRACT_GID,
    status: over.status ?? "ACTIVE",
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    currencyCode: "CHF",
    billingPolicy: over.billingPolicy ?? {
      interval: "WEEK",
      intervalCount: 8,
      minCycles: null,
      maxCycles: null,
    },
    deliveryPolicy: over.deliveryPolicy ?? null,
    deliveryPriceCents: 0,
    customer: {
      id: "gid://shopify/Customer/1",
      email: "a@b.c",
      firstName: "A",
      lastName: "B",
      phone: null,
      locale: over.customerLocale === undefined ? "en" : over.customerLocale,
    },
    customerPaymentMethod:
      over.customerPaymentMethod === undefined
        ? null
        : over.customerPaymentMethod,
    deliveryMethod: null,
    originOrder: over.originOrder ?? null,
    lines: over.lines ?? [line()],
  };
}

/** An existing local mirror row (update path). */
function localRow(over: Record<string, unknown> = {}) {
  return {
    id: "local_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "a@b.c",
    status: "ACTIVE",
    ownership: "OURS",
    locale: "en",
    cancelledAt: null,
    cancelSource: null,
    failedAt: null,
    pausedAt: null,
    expiredAt: null,
    firstChargeAt: new Date("2026-06-01T00:00:00Z"),
    originOrderTotalCents: 1000,
    prepaidDeliveriesRemaining: null,
    currencyCode: "CHF",
    lines: [],
    ...over,
  };
}

function localLine(over: Record<string, unknown> = {}) {
  return {
    id: "ll_1",
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    productId: PRODUCT_GID,
    variantId: VARIANT_GID,
    sellingPlanId: OUR_PLAN,
    sellingPlanName: "Every 8 weeks",
    compareAtPriceCents: 8000,
    unitCostCents: 900,
    isOneTimeAddon: false,
    ...over,
  };
}

function updateData(): Record<string, unknown> {
  return (
    mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
  ).data;
}

function createData(): Record<string, unknown> {
  return (
    mocks.contractCreate.mock.calls[0][0] as { data: Record<string, unknown> }
  ).data;
}

function firstEventPayload(): Record<string, unknown> {
  return (mocks.logEvent.mock.calls[0][0] as { payload: Record<string, unknown> })
    .payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.contractFindUnique.mockResolvedValue(null);
  mocks.planConfigFindMany.mockResolvedValue([
    {
      shopifyGroupId: "gid://shopify/SellingPlanGroup/77",
      shopifyPlanIds: [OUR_PLAN],
    },
  ]);
  mocks.getVariants.mockResolvedValue([]);
});

describe("line keep-guards (enrichment failure / product deletion)", () => {
  it("keeps compareAtPriceCents, productId and variantId when the incoming line lost them", async () => {
    // Product deleted on Shopify: line ids nulled, enrichment finds nothing,
    // and there is no pricingPolicy to fall back to for the base price.
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ lines: [localLine()] }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract({
        lines: [line({ productId: null, variantId: null, pricingPolicy: null })],
      }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.lineUpdate).toHaveBeenCalledTimes(1);
    const data = (
      mocks.lineUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.compareAtPriceCents).toBe(8000);
    expect(data.productId).toBe(PRODUCT_GID);
    expect(data.variantId).toBe(VARIANT_GID);
    // The pre-existing guards still hold alongside the new ones.
    expect(data.sellingPlanId).toBe(OUR_PLAN);
    expect(data.unitCostCents).toBe(900);
  });

  it("still overwrites with fresh values when the incoming line carries them", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ lines: [localLine()] }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract({
        lines: [
          line({
            pricingPolicy: { basePriceCents: 9000, cycleDiscounts: [] },
          }),
        ],
      }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.lineUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.compareAtPriceCents).toBe(9000);
    expect(data.productId).toBe(PRODUCT_GID);
  });
});

describe("pricingPolicy + billing cycle bounds mirrors (migration 0016)", () => {
  it("persists the full pricing policy on the mirrored line", async () => {
    const policy = {
      basePriceCents: 8000,
      cycleDiscounts: [
        {
          afterCycle: 1,
          adjustmentType: "PERCENTAGE",
          percentage: 10,
          amountCents: null,
          computedPriceCents: 7200,
        },
      ],
    };
    mocks.getContract.mockResolvedValue(
      shopifyContract({ lines: [line({ pricingPolicy: policy })] }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.lineCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.pricingPolicy).toEqual(policy);
  });

  it("a line without a policy does not erase the mirrored one (no pricingPolicy key)", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ lines: [localLine()] }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract({ lines: [line({ pricingPolicy: null })] }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = (
      mocks.lineUpdate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(Object.keys(data)).not.toContain("pricingPolicy");
  });

  it("mirrors billingPolicy min/maxCycles onto the contract", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow());
    mocks.getContract.mockResolvedValue(
      shopifyContract({
        billingPolicy: {
          interval: "WEEK",
          intervalCount: 8,
          minCycles: 2,
          maxCycles: 12,
        },
      }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(updateData()).toMatchObject({
      billingMinCycles: 2,
      billingMaxCycles: 12,
    });
  });
});

describe("locale refresh (update path)", () => {
  it("writes the customer's current locale on every sync", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow({ locale: "en" }));
    mocks.getContract.mockResolvedValue(
      shopifyContract({ customerLocale: "de" }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(updateData().locale).toBe(normalizeLocale("de"));
  });

  it("a response without a locale never erases the recorded one", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow({ locale: "fr" }));
    mocks.getContract.mockResolvedValue(
      shopifyContract({ customerLocale: null }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(Object.keys(updateData())).not.toContain("locale");
  });
});

describe("card metadata lifecycle", () => {
  it("clears the four card columns when the payment method is gone", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({
        cardBrand: "visa",
        cardLast4: "4242",
        cardExpiryMonth: 12,
        cardExpiryYear: 2026,
      }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract({ customerPaymentMethod: null }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(updateData()).toMatchObject({
      paymentMethodId: null,
      cardBrand: null,
      cardLast4: null,
      cardExpiryMonth: null,
      cardExpiryYear: null,
    });
  });

  it("keeps the mirrored card when the method is present without instrument details", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow());
    mocks.getContract.mockResolvedValue(
      shopifyContract({
        customerPaymentMethod: {
          id: "gid://shopify/CustomerPaymentMethod/9",
          revokedAt: null,
          instrument: null,
        },
      }),
    );

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = updateData();
    expect(data.paymentMethodId).toBe("gid://shopify/CustomerPaymentMethod/9");
    expect(Object.keys(data)).not.toContain("cardBrand");
  });
});

describe("prepaid deliveries-remaining seeding", () => {
  const prepaidPolicies = {
    billingPolicy: {
      interval: "MONTH",
      intervalCount: 3,
      minCycles: null,
      maxCycles: null,
    },
    deliveryPolicy: { interval: "MONTH", intervalCount: 1 },
  };

  it("seeds the counter with the per-charge allotment on first mirror", async () => {
    mocks.getContract.mockResolvedValue(shopifyContract(prepaidPolicies));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(createData()).toMatchObject({
      isPrepaid: true,
      prepaidDeliveriesPerCharge: 3,
      prepaidDeliveriesRemaining: 3,
    });
  });

  it("seeds a null counter on re-sync, but never resets a live countdown", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ prepaidDeliveriesRemaining: null }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract(prepaidPolicies));
    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);
    expect(updateData().prepaidDeliveriesRemaining).toBe(3);

    vi.clearAllMocks();
    mocks.planConfigFindMany.mockResolvedValue([
      { shopifyGroupId: "g", shopifyPlanIds: [OUR_PLAN] },
    ]);
    mocks.getVariants.mockResolvedValue([]);
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ prepaidDeliveriesRemaining: 1 }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract(prepaidPolicies));
    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);
    expect(Object.keys(updateData())).not.toContain(
      "prepaidDeliveriesRemaining",
    );
  });
});

describe("external cancels and expiry transitions", () => {
  it("stamps cancelSource EXTERNAL for a webhook-observed cancel with no prior source", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow());
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "CANCELLED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = updateData();
    expect(data.cancelSource).toBe("EXTERNAL");
    expect(data.cancelledAt).toBeInstanceOf(Date);
  });

  it("never overwrites a source an engine path already stamped", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ cancelSource: "DUNNING" }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "CANCELLED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(Object.keys(updateData())).not.toContain("cancelSource");
  });

  it("stamps expiredAt on the EXPIRED transition and flags the approximation", async () => {
    mocks.contractFindUnique.mockResolvedValue(localRow());
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "EXPIRED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(updateData().expiredAt).toBeInstanceOf(Date);
    expect(firstEventPayload()).toMatchObject({ expiredAtApproximated: true });
  });

  it("does not re-stamp expiredAt when the transition was already recorded", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ status: "EXPIRED", expiredAt: new Date("2026-01-01") }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "EXPIRED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(Object.keys(updateData())).not.toContain("expiredAt");
  });
});

describe("first-mirror transition stamps", () => {
  it("a webhook-driven create of a cancelled contract stamps now + EXTERNAL", async () => {
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "CANCELLED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const data = createData();
    expect(data.cancelSource).toBe("EXTERNAL");
    expect(data.cancelledAt).toBeInstanceOf(Date);
  });

  it("a backfill create (source SYSTEM) leaves the unknowable dates null and records the gap", async () => {
    // An established-shop install mirrors a months-old cancelled contract:
    // stamping `now` would invent churn on the install day's rollup.
    mocks.getContract.mockResolvedValue(shopifyContract({ status: "CANCELLED" }));

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID, {
      source: "SYSTEM",
    });

    const data = createData();
    expect(data.cancelSource).toBe("EXTERNAL"); // classification still true
    expect(Object.keys(data)).not.toContain("cancelledAt");
    expect(firstEventPayload()).toMatchObject({ transitionDatesUnknown: true });
  });

  it("a backfill create of an ACTIVE contract records no gap", async () => {
    mocks.getContract.mockResolvedValue(shopifyContract());

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID, {
      source: "SYSTEM",
    });

    expect(Object.keys(firstEventPayload())).not.toContain(
      "transitionDatesUnknown",
    );
  });
});

describe("origin-order tax capture (migration 0016)", () => {
  const ORDER = { id: "gid://shopify/Order/900", name: "#1042" };
  const SUMMARY = {
    totalCents: 4200,
    subtotalCents: 3200,
    discountsCents: 0,
    taxCents: 700,
    shippingCents: 500,
    processedAt: new Date("2026-06-10T10:00:00Z"),
    createdAt: new Date("2026-06-10T09:59:00Z"),
    currencyCode: "CHF",
  };

  it("captures originOrderTaxCents on the create path", async () => {
    mocks.getContract.mockResolvedValue(shopifyContract({ originOrder: ORDER }));
    mocks.getOrderSummary.mockResolvedValue(SUMMARY);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(createData()).toMatchObject({
      originOrderTotalCents: 4200,
      originOrderTaxCents: 700,
    });
  });

  it("captures originOrderTaxCents through the atomic re-sync claim", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ originOrderTotalCents: null }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract({ originOrder: ORDER }));
    mocks.getOrderSummary.mockResolvedValue(SUMMARY);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    const claim = mocks.contractUpdateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(claim.data).toMatchObject({ originOrderTaxCents: 700 });
  });
});

describe("late firstChargeAt backfill re-upserts the affected rollup labels", () => {
  const ORDER = { id: "gid://shopify/Order/900", name: "#1042" };
  // Shop tz Europe/London (see requireShop mock): both instants sit safely
  // mid-day, so their day labels are unambiguous.
  const ARRIVAL = new Date("2026-06-10T10:00:00Z"); // the order's real date
  const MIRROR_CREATED = new Date("2026-06-20T09:00:00Z"); // late mirror day

  function wireLateBackfill(rollupRows: Array<{ date: Date }>): void {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ firstChargeAt: null, createdAt: MIRROR_CREATED }),
    );
    mocks.getContract.mockResolvedValue(
      shopifyContract({ originOrder: ORDER }),
    );
    mocks.getOrderSummary.mockResolvedValue({ createdAt: ARRIVAL });
    mocks.rollupFindMany.mockResolvedValue(rollupRows);
  }

  it("re-upserts BOTH labels in backfill mode when their rollup rows exist", async () => {
    wireLateBackfill([
      { date: new Date("2026-06-10T00:00:00.000Z") },
      { date: new Date("2026-06-20T00:00:00.000Z") },
    ]);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    // The mirror write itself backfilled the column…
    expect(updateData().firstChargeAt).toEqual(ARRIVAL);
    // …and the repair asked for exactly the two affected labels…
    const lookup = mocks.rollupFindMany.mock.calls[0][0] as {
      where: { date: { in: Date[] } };
    };
    expect(lookup.where.date.in.map((d) => d.toISOString())).toEqual(
      expect.arrayContaining([
        "2026-06-10T00:00:00.000Z",
        "2026-06-20T00:00:00.000Z",
      ]),
    );
    // …then re-upserted each in backfill mode (existing snapshots preserved;
    // flow columns — newSubscribers among them — recompute from source).
    expect(mocks.runDailyRollup).toHaveBeenCalledTimes(2);
    const calls = mocks.runDailyRollup.mock.calls as unknown as Array<
      [string, Date, { backfill?: boolean }]
    >;
    for (const [shopId, , opts] of calls) {
      expect(shopId).toBe("shop_1");
      expect(opts).toEqual({ backfill: true });
    }
    expect(calls.map((c) => c[1].toISOString()).sort()).toEqual([
      ARRIVAL.toISOString(),
      MIRROR_CREATED.toISOString(),
    ]);
  });

  it("skips labels with no rollup row — never synthesizes pre-analytics history", async () => {
    wireLateBackfill([{ date: new Date("2026-06-20T00:00:00.000Z") }]);

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.runDailyRollup).toHaveBeenCalledTimes(1);
    const [onlyCall] = mocks.runDailyRollup.mock.calls as unknown as Array<
      [string, Date, { backfill?: boolean }]
    >;
    expect(onlyCall[1]).toEqual(MIRROR_CREATED);
  });

  it("does not run at all when firstChargeAt was already known", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      localRow({ createdAt: MIRROR_CREATED }),
    );
    mocks.getContract.mockResolvedValue(shopifyContract());

    await syncContractFromShopify("cellexia.myshopify.com", CONTRACT_GID);

    expect(mocks.rollupFindMany).not.toHaveBeenCalled();
    expect(mocks.runDailyRollup).not.toHaveBeenCalled();
  });

  it("a rollup failure is contained — the mirror sync still completes", async () => {
    wireLateBackfill([{ date: new Date("2026-06-10T00:00:00.000Z") }]);
    mocks.runDailyRollup.mockRejectedValueOnce(new Error("rollup down"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const result = await syncContractFromShopify(
      "cellexia.myshopify.com",
      CONTRACT_GID,
    );

    expect(result).toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("rollup repair"),
      CONTRACT_GID,
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
