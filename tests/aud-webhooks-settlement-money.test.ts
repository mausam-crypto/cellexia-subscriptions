import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settlement-time money collection and its repair lane.
 *
 * WH-09/CM-6 (I8): the success claim persists the renewal order's money
 * breakdown (discount/tax/shipping/subtotal) and its REAL processedAt
 * (CM-5: uncapped — completedAt carries the clamped instant for rollup day
 * placement) from the summary already in hand, and increments the contract's
 * lifetimeDiscountCents (renewals-only, the discount twin of
 * lifetimeRevenueCents).
 *
 * C3 (I2): the claim freezes the charge's cost basis into
 * BillingAttempt.costSnapshot via computeChargeCostSnapshot — gift lines
 * excluded, add-ons scoped to the settling cycle, contained so a snapshot
 * failure can never fail a settlement.
 *
 * CM-8: a settled prepaid cycle consumes one slot of the seeded
 * prepaidDeliveriesRemaining countdown, clamped at zero.
 *
 * WH-02/BD-2: a SUCCESS attempt whose settlement-time summary fetch failed is
 * booked at amountCents NULL (zero revenue everywhere). The replay path must
 * true it up while NULL — the immutability rule protects only non-null
 * amounts — claimed row-level so concurrent replays true-up once.
 *
 * WH-05: billing.attempt_failed dedupes on the ATTEMPT's event existence,
 * not on the pre-run status — a crash between the FAILED write and the event
 * log must be repaired by the redelivery, not skipped forever.
 *
 * EVT-7: billing.* payloads carry currencyCode wherever they carry
 * amountCents (mixed-currency Markets shops make a bare amount unusable).
 */

const mocks = vi.hoisted(() => ({
  attemptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptCreate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({ count: 1 })),
  attemptFindUniqueOrThrow: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  lineFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  lineDeleteMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({ count: 0 })),
  subscriberEventFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({})),
  getContract: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  })),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
  onBillingAttemptSucceeded: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const explicit: Record<string, unknown> = {
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      create: mocks.attemptCreate,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
      findUniqueOrThrow: mocks.attemptFindUniqueOrThrow,
    },
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      update: mocks.contractUpdate,
    },
    contractLine: {
      findMany: mocks.lineFindMany,
      deleteMany: mocks.lineDeleteMany,
    },
    subscriberEvent: {
      findFirst: mocks.subscriberEventFindFirst,
    },
  };
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    if (method === "aggregate") return { _sum: {}, _count: {}, _max: {} };
    return null;
  };
  const autoModel = new Proxy({}, { get: (_t, method: string) => stubFor(method) });
  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );
  return { default: db };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async () => ({ id: "shop_1" })),
}));

// A REAL-shaped cost model, so the genuine computeChargeCostSnapshot path
// runs end to end (loadCostContext reads this via the settings seam).
const COST_MODEL = {
  cogsFallbackPctOfPrice: 30,
  shippingCostPerShipmentCents: { mode: "flat", flatCents: 500 },
  fulfillmentCostPerShipmentCents: 200,
  paymentFeePct: 2.9,
  paymentFeeFixedCents: 30,
};

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string) =>
    key === "costModel" ? COST_MODEL : {},
  ),
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: mocks.hasSentForCycle,
}));

vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
  onBillingAttemptSucceeded: mocks.onBillingAttemptSucceeded,
  onBillingAttemptChallenged: vi.fn(async () => {}),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getOrderSummary: mocks.getOrderSummary,
  getContract: mocks.getContract,
  gql: vi.fn(),
  getCustomer: vi.fn(async () => ({})),
  getVariants: vi.fn(async () => []),
  getBillingCycleByDate: vi.fn(async () => null),
  listCustomerPaymentMethods: vi.fn(async () => []),
  draftUpdatePaymentMethod: vi.fn(),
  withContractDraft: vi.fn(),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";
const ORDER_GID = "gid://shopify/Order/700";

function contractRow(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "someone@example.com",
    ownership: "OURS",
    ordersCount: 4,
    lifetimeRevenueCents: 20_000,
    lifetimeDiscountCents: 0,
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
    currencyCode: "CHF",
    originOrderId: null,
    locale: "en",
    status: "ACTIVE",
    consecutiveFailures: 0,
    deliveryPriceCents: 0,
    isPrepaid: false,
    prepaidDeliveriesPerCharge: null,
    prepaidDeliveriesRemaining: null,
    ...over,
  };
}

function pendingAttempt(over: Record<string, unknown> = {}) {
  return {
    id: "att_1",
    contractId: "c_1",
    status: "PENDING",
    cycleIndex: 5,
    attemptNumber: 1,
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    startedAt: null,
    completedAt: null,
    settledAt: null,
    orderId: null,
    orderName: null,
    amountCents: null,
    currencyCode: null,
    contract: contractRow(),
    ...over,
  };
}

const PROCESSED_AT = new Date("2026-08-09T07:58:00Z");
const SUMMARY = {
  id: ORDER_GID,
  name: "#1001",
  createdAt: new Date("2026-08-09T08:00:00Z"),
  processedAt: PROCESSED_AT,
  financialStatus: "PAID",
  fulfillmentStatus: null,
  currencyCode: "CHF",
  totalCents: 5760,
  subtotalCents: 5660,
  discountsCents: 300,
  taxCents: 400,
  shippingCents: 500,
  refundedCents: 0,
  customerId: null,
  customerEmail: null,
};

/** Lines answered per query shape: the snapshot read (no add-on filter) vs
 * consumeCycleOnSuccess's cycle-scoped add-on read. */
const RECURRING_LINE = {
  id: "line_r",
  productId: "gid://shopify/Product/1",
  variantId: "gid://shopify/ProductVariant/11",
  title: "Serum",
  quantity: 2,
  currentPriceCents: 3000,
  unitCostCents: 1000,
  isGift: false,
  isOneTimeAddon: false,
  addonCycleIndex: null,
};
const GIFT_LINE = {
  id: "line_g",
  productId: "gid://shopify/Product/2",
  variantId: "gid://shopify/ProductVariant/22",
  title: "Gift",
  quantity: 1,
  currentPriceCents: 0,
  unitCostCents: 700,
  isGift: true,
  isOneTimeAddon: false,
  addonCycleIndex: null,
};
const ADDON_THIS_CYCLE = {
  id: "line_a5",
  productId: "gid://shopify/Product/3",
  variantId: "gid://shopify/ProductVariant/33",
  title: "Collagen Boost",
  quantity: 1,
  currentPriceCents: 1500,
  unitCostCents: null,
  isGift: false,
  isOneTimeAddon: true,
  addonCycleIndex: 5,
};
const ADDON_NEXT_CYCLE = {
  id: "line_a6",
  productId: "gid://shopify/Product/4",
  variantId: "gid://shopify/ProductVariant/44",
  title: "Future add-on",
  quantity: 1,
  currentPriceCents: 900,
  unitCostCents: 300,
  isGift: false,
  isOneTimeAddon: true,
  addonCycleIndex: 6,
};

function wireLines(): void {
  mocks.lineFindMany.mockImplementation(async (args?: unknown) => {
    const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
    const all = [RECURRING_LINE, GIFT_LINE, ADDON_THIS_CYCLE, ADDON_NEXT_CYCLE];
    if (where.isOneTimeAddon === true) {
      // consumeCycleOnSuccess's cycle-scoped read
      return [ADDON_THIS_CYCLE];
    }
    return all;
  });
}

async function deliverSuccess(): Promise<void> {
  await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
    shopDomain: "cellexia.myshopify.com",
    payload: {
      admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
      admin_graphql_api_order_id: ORDER_GID,
    },
    webhookId: "wh_s1",
  });
}

function claimCall(): { where: Record<string, unknown>; data: Record<string, unknown> } {
  const call = mocks.attemptUpdateMany.mock.calls.find((c) => {
    const where = (c[0] as { where?: Record<string, unknown> }).where ?? {};
    return "status" in where;
  });
  expect(call, "claim updateMany not found").toBeDefined();
  return call![0] as { where: Record<string, unknown>; data: Record<string, unknown> };
}

function counterCall(): { data: Record<string, unknown> } | undefined {
  const call = mocks.contractUpdate.mock.calls.find((c) => {
    const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
    return "ordersCount" in data || "lifetimeRevenueCents" in data;
  });
  return call?.[0] as { data: Record<string, unknown> } | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.getOrderSummary.mockResolvedValue(SUMMARY);
  mocks.getContract.mockResolvedValue({
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  });
  mocks.hasSentForCycle.mockResolvedValue(false);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  wireLines();
});

// ── WH-09 / CM-5 / C3: the claim collects everything in hand ─────────────────

describe("success claim — money breakdown, real processedAt, cost snapshot", () => {
  beforeEach(() => {
    mocks.attemptFindUnique.mockResolvedValue(pendingAttempt());
    mocks.attemptFindUniqueOrThrow.mockResolvedValue({
      ...pendingAttempt({ status: "SUCCESS", amountCents: 5760, currencyCode: "CHF", orderId: ORDER_GID, orderName: "#1001" }),
    });
    mocks.contractUpdate.mockResolvedValue(contractRow());
  });

  it("persists discount/tax/shipping/subtotal and the UNCAPPED orderProcessedAt on the attempt", async () => {
    await deliverSuccess();
    const { data } = claimCall();
    expect(data).toMatchObject({
      status: "SUCCESS",
      amountCents: 5760,
      currencyCode: "CHF",
      discountCents: 300,
      taxCents: 400,
      shippingCents: 500,
      subtotalCents: 5660,
    });
    // CM-5: the order's REAL processedAt instant, not the clamped chargedAt.
    expect(data.orderProcessedAt).toEqual(PROCESSED_AT);
  });

  it("freezes the charge's cost basis: gifts out, this-cycle add-ons in, other cycles out", async () => {
    await deliverSuccess();
    const { data } = claimCall();
    const snapshot = data.costSnapshot as {
      v: number;
      cogsCents: number;
      estimatedCogsCents: number;
      shippingCostCents: number;
      fulfillmentCostCents: number;
      deliveriesPerCharge: number;
      lines: Array<{ variantId: string }>;
    };
    expect(snapshot.v).toBe(1);
    // recurring: 2 × 1000 known; add-on cycle 5: 30% of 1500 = 450 estimated.
    expect(snapshot.cogsCents).toBe(2450);
    expect(snapshot.estimatedCogsCents).toBe(450);
    expect(snapshot.shippingCostCents).toBe(500);
    expect(snapshot.fulfillmentCostCents).toBe(200);
    expect(snapshot.deliveriesPerCharge).toBe(1);
    expect(snapshot.lines.map((l) => l.variantId)).toEqual([
      "gid://shopify/ProductVariant/11",
      "gid://shopify/ProductVariant/33",
    ]);
  });

  it("increments lifetimeDiscountCents alongside lifetimeRevenueCents (renewals-only twin)", async () => {
    await deliverSuccess();
    const counters = counterCall();
    expect(counters).toBeDefined();
    expect(counters!.data.lifetimeRevenueCents).toEqual({ increment: 5760 });
    expect(counters!.data.lifetimeDiscountCents).toEqual({ increment: 300 });
  });

  it("EVT-7: billing.attempt_succeeded / order_created carry the currency next to the amount", async () => {
    await deliverSuccess();
    const succeeded = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "billing.attempt_succeeded" || e.type === "billing.order_created");
    expect(succeeded.length).toBeGreaterThanOrEqual(2);
    for (const evt of succeeded) {
      expect(evt.payload.currencyCode).toBe("CHF");
    }
  });

  it("a failed summary fetch settles WITHOUT the breakdown but still freezes the cost snapshot", async () => {
    mocks.getOrderSummary.mockRejectedValue(new Error("throttled"));
    await deliverSuccess();
    const { data } = claimCall();
    expect(data.amountCents).toBeNull();
    expect("discountCents" in data).toBe(false);
    expect("orderProcessedAt" in data).toBe(false);
    expect(data.orderId).toBe(ORDER_GID); // refunds still match the attempt
    expect((data.costSnapshot as { v: number }).v).toBe(1);
  });

  it("a cost-context failure never fails the settlement (snapshot simply absent)", async () => {
    const { getSetting } = await import("~/lib/settings/settings.server");
    (getSetting as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("settings down"),
    );
    await deliverSuccess();
    const { data } = claimCall();
    expect("costSnapshot" in data).toBe(false);
    expect(data.status).toBe("SUCCESS"); // the claim itself landed
  });
});

// ── CM-8: prepaid delivery countdown ─────────────────────────────────────────
//
// Assertion history: this suite originally pinned a decrement-per-CHARGE
// reading (3 → 2 → 1 → 0), which drove the cockpit badge to a permanent
// "Prepaid (0 left)" on a still-billing contract — each charge CONSUMED a
// slot when it actually PAYS FOR a fresh allotment. The pins below replace
// that buggy behavior with the re-arm semantics.

describe("prepaid settlement re-arms the per-charge delivery allotment", () => {
  function wirePrepaid(remaining: number | null): void {
    const contract = contractRow({
      isPrepaid: true,
      prepaidDeliveriesPerCharge: 3,
      prepaidDeliveriesRemaining: remaining,
    });
    mocks.attemptFindUnique.mockResolvedValue(pendingAttempt({ contract }));
    mocks.attemptFindUniqueOrThrow.mockResolvedValue(
      pendingAttempt({
        status: "SUCCESS",
        amountCents: 5760,
        currencyCode: "CHF",
        orderId: ORDER_GID,
        contract,
      }),
    );
    mocks.contractUpdate.mockResolvedValue(contract);
  }

  it("resets a partially-consumed countdown to the full allotment (the charge bought new deliveries)", async () => {
    wirePrepaid(2);
    await deliverSuccess();
    expect(counterCall()!.data.prepaidDeliveriesRemaining).toBe(3);
  });

  it("revives an exhausted countdown — no more permanent 'Prepaid (0 left)' on a billing contract", async () => {
    wirePrepaid(0);
    await deliverSuccess();
    expect(counterCall()!.data.prepaidDeliveriesRemaining).toBe(3);
  });

  it("seeds an unseeded countdown (null) — a settled charge is positive proof an allotment exists", async () => {
    wirePrepaid(null);
    await deliverSuccess();
    expect(counterCall()!.data.prepaidDeliveriesRemaining).toBe(3);
  });

  it("never touches the counter on a non-prepaid contract", async () => {
    mocks.attemptFindUnique.mockResolvedValue(pendingAttempt());
    mocks.attemptFindUniqueOrThrow.mockResolvedValue(
      pendingAttempt({ status: "SUCCESS", amountCents: 5760, contract: contractRow() }),
    );
    mocks.contractUpdate.mockResolvedValue(contractRow());
    await deliverSuccess();
    expect("prepaidDeliveriesRemaining" in counterCall()!.data).toBe(false);
  });
});

// ── WH-02 / BD-2: the null-amount true-up on replay ──────────────────────────

describe("replayed SUCCESS with amountCents NULL (settlement-time fetch had failed)", () => {
  function settledNullAmount(over: Record<string, unknown> = {}) {
    return pendingAttempt({
      status: "SUCCESS",
      settledAt: new Date("2026-08-09T08:01:00Z"), // side effects complete
      orderId: ORDER_GID,
      orderName: null,
      amountCents: null,
      currencyCode: "CHF",
      ...over,
    });
  }

  it("re-fetches the summary and trues up the amount, breakdown and lifetime counters", async () => {
    mocks.attemptFindUnique.mockResolvedValue(settledNullAmount());

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
        admin_graphql_api_order_id: ORDER_GID,
      },
      webhookId: "wh_replay_1",
    });

    // The true-up claim is row-guarded: SUCCESS and STILL null.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledTimes(1);
    const call = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({
      id: "att_1",
      status: "SUCCESS",
      amountCents: null,
    });
    expect(call.data).toMatchObject({
      amountCents: 5760,
      currencyCode: "CHF",
      orderName: "#1001",
      discountCents: 300,
      taxCents: 400,
      shippingCents: 500,
      subtotalCents: 5660,
    });
    expect(call.data.orderProcessedAt).toEqual(PROCESSED_AT);

    // The zero-booked revenue is added back exactly once.
    const counters = counterCall();
    expect(counters).toBeDefined();
    expect(counters!.data.lifetimeRevenueCents).toEqual({ increment: 5760 });
    expect(counters!.data.lifetimeDiscountCents).toEqual({ increment: 300 });
    // The completed-settlement marker means NO side-effect redrive.
    expect(mocks.sendNotification).not.toHaveBeenCalled();

    // The repair is auditable: the original billing.attempt_succeeded keeps
    // its null amount forever, so the ledger needs the same repair record the
    // sweep arm writes (stream-only revenue analysis and table/stream
    // reconciliation both key on it).
    const backfilled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "billing.attempt_amount_backfilled");
    expect(backfilled).toHaveLength(1);
    expect(backfilled[0].payload).toMatchObject({
      attemptId: "att_1",
      orderId: ORDER_GID,
      cycleIndex: 5,
      amountCents: 5760,
      currencyCode: "CHF",
      refundedCentsIncluded: 0,
      resolvedBy: "webhook_redelivery",
    });
  });

  it("a lost true-up race (another replay won) moves no counters", async () => {
    mocks.attemptFindUnique.mockResolvedValue(settledNullAmount());
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 });

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
        admin_graphql_api_order_id: ORDER_GID,
      },
      webhookId: "wh_replay_2",
    });

    expect(counterCall()).toBeUndefined();
    // No claim, no repair record — the winner logged it.
    const backfilled = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "billing.attempt_amount_backfilled");
    expect(backfilled).toHaveLength(0);
  });

  it("a replay with a NON-NULL amount never re-reads the order (post-refund immutability intact)", async () => {
    mocks.attemptFindUnique.mockResolvedValue(
      settledNullAmount({ amountCents: 5760 }),
    );

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
        admin_graphql_api_order_id: ORDER_GID,
      },
      webhookId: "wh_replay_3",
    });

    expect(mocks.getOrderSummary).not.toHaveBeenCalled();
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("a still-failing true-up fetch is contained — the row stays repairable", async () => {
    mocks.attemptFindUnique.mockResolvedValue(settledNullAmount());
    mocks.getOrderSummary.mockRejectedValue(new Error("still throttled"));

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
        admin_graphql_api_order_id: ORDER_GID,
      },
      webhookId: "wh_replay_4",
    });

    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(counterCall()).toBeUndefined();
  });
});

// ── WH-05: attempt_failed dedupe keyed on the event, not the status ──────────

describe("billing.attempt_failed after a crash between status write and event", () => {
  function failedAttempt() {
    return pendingAttempt({
      status: "FAILED", // the PREVIOUS run already wrote the status…
      errorCode: "card_declined",
      errorMessage: "Card declined",
    });
  }

  async function deliverFailure(): Promise<void> {
    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE({
      shopDomain: "cellexia.myshopify.com",
      payload: {
        admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
        error_code: "card_declined",
        error_message: "Card declined",
      },
      webhookId: "wh_f1",
    });
  }

  beforeEach(() => {
    mocks.attemptFindUnique.mockResolvedValue(failedAttempt());
    mocks.attemptUpdate.mockResolvedValue({
      ...failedAttempt(),
      contract: contractRow(),
    });
  });

  it("…but the event never landed: the redelivery logs it (the old status guard skipped forever)", async () => {
    mocks.subscriberEventFindFirst.mockResolvedValue(null);
    await deliverFailure();

    const failedEvents = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "billing.attempt_failed");
    expect(failedEvents).toHaveLength(1);
    // EVT-7 on the failure stream too.
    expect(failedEvents[0].payload.currencyCode).toBe("CHF");
    // The dedupe was keyed on THIS attempt's event existence.
    const dedupe = mocks.subscriberEventFindFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(dedupe.where.type).toBe("billing.attempt_failed");
    expect(dedupe.where.payload).toEqual({
      path: ["attemptId"],
      equals: "att_1",
    });
  });

  it("…and the event DID land: the redelivery adds nothing, the dunning hand-off still runs", async () => {
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });
    await deliverFailure();

    const failedEvents = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "billing.attempt_failed");
    expect(failedEvents).toHaveLength(0);
    // The engine owns its own completion marker — always re-driven.
    expect(mocks.onBillingAttemptFailed).toHaveBeenCalledWith("att_1");
  });
});
