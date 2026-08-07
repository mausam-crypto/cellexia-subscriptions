import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHOSE CHARGE WAS THAT — the billing-attempt webhooks, evaluated.
 *
 * SUBSCRIPTION_BILLING_ATTEMPTS_* fires for EVERY contract on the shop,
 * whoever created it, and the client's store runs Joy Subscriptions next to
 * this app. When one of Joy's subscribers renews, Shopify sends us the success
 * webhook for a charge we did not make.
 *
 * `resolveBillingAttempt` looks the attempt up by Shopify attempt id, then by
 * idempotency key. Neither matches for a charge this app did not originate, so
 * it falls through to a last resort: RECONSTRUCT a BillingAttempt row from the
 * contract on the payload. That path exists for a real case — a merchant
 * charging one of OUR contracts by hand in the Shopify admin — but it used to
 * run for any contract at all. On Joy's contracts it put Joy's charges on our
 * book: the success handler increments `ordersCount` and
 * `lifetimeRevenueCents` on the mirror, the reconstructed row lands in the
 * PENDING gauge the health endpoint reads, and every foreign renewal cost a
 * Shopify order-summary round trip.
 *
 * These tests drive the REAL handler out of `webhookHandlers` with a mocked
 * Prisma, so what is asserted is what the webhook actually does — not a
 * source-text match on a guard that could be reordered into uselessness.
 */

const mocks = vi.hoisted(() => ({
  attemptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptCreate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptUpdateMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({ count: 0 })),
  attemptFindUniqueOrThrow: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  lineFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  lineDeleteMany: vi.fn(async (_args?: unknown): Promise<unknown> => ({ count: 0 })),
  subscriberEventFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({
    totalCents: 5760,
    name: "#1001",
    currencyCode: "CHF",
  })),
  getContract: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  warn: vi.fn(),
}));

vi.mock("~/db.server", () => {
  // The models this test asserts on. Everything else the success handler
  // touches downstream (gift grants, events, …) is auto-stubbed below, so the
  // OURS path can run to completion and the assertions stay about ownership.
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

  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );

  // The success settlement runs its claim + accounting through an interactive
  // transaction; the mock hands the callback the same client, so every model
  // spy above observes the writes exactly as before.
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
  adminClientForShop: mocks.adminClientForShop,
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async () => ({ id: "shop_1" })),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  sendTemplate: vi.fn(async () => ({ status: "SENT" })),
  hasSentForCycle: mocks.hasSentForCycle,
}));

vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: vi.fn(async () => ({})),
  getShopMetafield: vi.fn(async () => null),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  getOrderSummary: mocks.getOrderSummary,
  getContract: mocks.getContract,
  getCustomer: vi.fn(async () => ({})),
  getVariants: vi.fn(async () => []),
  getSellingPlanGroupPlanIds: vi.fn(async () => []),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const OURS = "OURS";
const FOREIGN = "FOREIGN";
const UNKNOWN = "UNKNOWN";

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";

/** A billing-attempt success payload for a charge we did not originate. */
function successPayload() {
  return {
    admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
    admin_graphql_api_subscription_contract_id: CONTRACT_GID,
    admin_graphql_api_order_id: "gid://shopify/Order/700",
  };
}

function contractRow(ownership: string) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "someone@example.com",
    ownership,
    ordersCount: 4,
    lifetimeRevenueCents: 20_000,
    firstChargeAt: new Date("2026-01-01T00:00:00Z"),
    currencyCode: "CHF",
    originOrderId: null,
    locale: "en",
    status: "ACTIVE",
    consecutiveFailures: 0,
  };
}

async function deliverSuccess(ownership: string) {
  mocks.contractFindUnique.mockResolvedValue(contractRow(ownership));
  await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
    shopDomain: "cellexia.myshopify.com",
    payload: successPayload(),
    webhookId: "wh_1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Nothing matches by attempt id or idempotency key: this app did not
  // originate the charge, which is what sends resolveBillingAttempt down the
  // reconstruction path.
  mocks.attemptFindUnique.mockResolvedValue(null);
  mocks.lineFindMany.mockResolvedValue([]);
  // The handler reads the row back off every update (currency, counters), so
  // the mock has to answer with a contract, not with its own arguments.
  mocks.contractUpdate.mockResolvedValue(contractRow(OURS));
  vi.spyOn(console, "warn").mockImplementation(mocks.warn);
});

describe("a billing attempt we did not originate", () => {
  it("is ignored for another app's contract — Joy's charge stays off our book", async () => {
    await deliverSuccess(FOREIGN);

    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    // The two counters the success handler would have moved.
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    // No Shopify round trip was spent on it either.
    expect(mocks.getOrderSummary).not.toHaveBeenCalled();
    expect(mocks.getContract).not.toHaveBeenCalled();
    // Nothing customer-facing, and nothing on the event log.
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("is ignored for an UNKNOWN contract too (absence of proof is not proof)", async () => {
    // Migration 0003 backfills every pre-existing contract to UNKNOWN. Our own
    // scheduler only ever charges OURS, so an attempt we did not originate on
    // a contract we cannot vouch for is never ours to record.
    await deliverSuccess(UNKNOWN);

    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("says why, so a missing charge is answerable from the logs", async () => {
    await deliverSuccess(FOREIGN);

    const said = mocks.warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(said).toContain("non-owned contract");
    expect(said).toContain(CONTRACT_GID);
    expect(said).toContain(FOREIGN);
  });

  /**
   * The guard must not swallow the case the reconstruction path exists for: a
   * merchant charging one of OUR contracts by hand in the Shopify admin also
   * arrives with no local attempt row. Without this, the whole describe block
   * above would pass just as happily if the handler had been broken outright.
   */
  it("VACUITY GUARD: the identical webhook IS recorded when the contract is ours", async () => {
    mocks.attemptCreate.mockResolvedValue({
      id: "att_1",
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      orderId: null,
      orderName: null,
      amountCents: null,
      currencyCode: "CHF",
      contract: contractRow(OURS),
    });
    // The handler claims PENDING→SUCCESS atomically (status-guarded
    // updateMany), then reads the settled row back.
    mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
    mocks.attemptFindUniqueOrThrow.mockResolvedValue({
      id: "att_1",
      status: "SUCCESS",
      cycleIndex: 5,
      attemptNumber: 1,
      shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
      amountCents: 5760,
      currencyCode: "CHF",
      orderId: "gid://shopify/Order/700",
      orderName: "#1001",
      contract: contractRow(OURS),
    });

    await deliverSuccess(OURS);

    expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.contractId).toBe("c_1");
    expect(created.data.originatingAction).toBe("ADMIN_MANUAL");
    // …and it is processed as a real charge: counters move.
    expect(mocks.contractUpdate).toHaveBeenCalled();
    // The settlement marker is stamped once the side-effect tail completed —
    // the write that lets a replay take the mirror-refresh-only path.
    const markerCalls = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "settledAt" in data && data.settledAt != null;
    });
    expect(markerCalls).toHaveLength(1);
  });

  /**
   * Concurrency guard: two DISTINCT webhook ids for the same attempt (route
   * receipts only dedupe exact redeliveries). The second delivery loses the
   * status-guarded claim (updateMany matches 0 rows) and must not touch the
   * counters — before the fix this path double-incremented ordersCount and
   * lifetimeRevenueCents.
   */
  it("a delivery that loses the SUCCESS claim never increments counters", async () => {
    mocks.attemptFindUnique.mockResolvedValue({
      id: "att_1",
      status: "PENDING", // read before the rival delivery committed
      startedAt: null,
      completedAt: null,
      orderId: null,
      orderName: null,
      amountCents: null,
      currencyCode: "CHF",
      contract: contractRow(OURS),
    });
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 }); // rival won

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: successPayload(),
      webhookId: "wh_2",
    });

    // The status guard was actually in the claim's WHERE.
    const claim = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(claim.where).toMatchObject({ id: "att_1", status: { not: "SUCCESS" } });
    // Counters untouched; only the nextBillingDate mirror refresh ran.
    const counterCalls = mocks.contractUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "ordersCount" in data || "lifetimeRevenueCents" in data;
    });
    expect(counterCalls).toHaveLength(0);
  });

  /**
   * Replay guard: an attempt already settled SUCCESS (admin redelivery under a
   * new webhook id). The originally charged amountCents must survive — the
   * order's currentTotalPriceSet is REDUCED after a refund while refundedCents
   * is subtracted separately, so rewriting the amount would double-count it.
   */
  it("a replay of a settled attempt never rewrites amountCents (post-refund double-count)", async () => {
    mocks.attemptFindUnique.mockResolvedValue({
      id: "att_1",
      status: "SUCCESS",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      completedAt: new Date("2026-08-01T00:00:00Z"),
      settledAt: new Date("2026-08-01T00:00:05Z"), // side effects fully driven
      orderId: "gid://shopify/Order/700",
      orderName: "#1001",
      amountCents: 5760, // original charge; order now shows 3760 after refund
      currencyCode: "CHF",
      contract: contractRow(OURS),
    });

    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: successPayload(),
      webhookId: "wh_3",
    });

    // No write path that could touch amountCents ran at all.
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    // And no order-summary round trip was spent re-reading the reduced total.
    expect(mocks.getOrderSummary).not.toHaveBeenCalled();
    // Counters stayed still; only the nextBillingDate mirror refresh may run.
    const counterCalls = mocks.contractUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "ordersCount" in data || "lifetimeRevenueCents" in data;
    });
    expect(counterCalls).toHaveLength(0);
    // Nothing customer-facing re-fired, nothing re-logged.
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

/**
 * THE HALF-SETTLED ATTEMPT — claim committed, process died, webhook redelivered.
 *
 * The defect these tests pin: the success path used to be claim-then-side-
 * effects across separate statements with a replay path that deliberately did
 * nothing. Kill the process between the status claim and the bookkeeping and
 * the redelivered webhook hit status=SUCCESS → mirror-refresh-only → the
 * dunning case stayed open FOREVER (later swept into a retry against the
 * already-billed cycle → parked → contract failed despite the customer having
 * paid), the confirmation never sent, and the day's rollup revenue
 * undercounted. The failure path was always re-driveable (declineCategory
 * written LAST); settledAt is the success path's equivalent marker.
 */
describe("a redelivered success for a half-settled attempt (SUCCESS, settledAt null)", () => {
  function halfSettledRow() {
    return {
      id: "att_1",
      status: "SUCCESS",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      completedAt: new Date("2026-08-01T00:00:00Z"),
      settledAt: null, // the marker never landed: side effects are missing
      cycleIndex: 5,
      attemptNumber: 1,
      shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
      orderId: "gid://shopify/Order/700",
      orderName: "#1001",
      amountCents: 5760,
      currencyCode: "CHF",
      usedBackupPayment: false,
      mitEvidence: null,
      contract: contractRow(OURS),
    };
  }

  beforeEach(() => {
    mocks.attemptFindUnique.mockResolvedValue(halfSettledRow());
    mocks.attemptFindUniqueOrThrow.mockResolvedValue(halfSettledRow());
  });

  async function redeliver(): Promise<void> {
    await webhookHandlers.SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS({
      shopDomain: "cellexia.myshopify.com",
      payload: successPayload(),
      webhookId: "wh_redrive_1",
    });
  }

  it("re-drives the missing side effects instead of returning", async () => {
    await redeliver();

    // The confirmation the crash swallowed finally reaches the customer…
    expect(mocks.hasSentForCycle).toHaveBeenCalledWith("c_1", "order_confirmed", 5);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    const sent = (mocks.sendNotification.mock.calls as unknown[][])[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(sent).toMatchObject({ contractId: "c_1", template: "order_confirmed" });

    // …the revenue event the rollup was undercounting is logged…
    const types = mocks.logEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types).toContain("billing.attempt_succeeded");
    expect(types).toContain("billing.order_created");

    // …and the marker is stamped LAST so the NEXT replay is refresh-only.
    const markerCalls = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "settledAt" in data && data.settledAt != null;
    });
    expect(markerCalls).toHaveLength(1);
  });

  it("never double-books: the committed accounting is not re-run", async () => {
    await redeliver();

    // The claim transaction is not re-entered (amountCents immutability and
    // the one-writer rule survive the redrive)…
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.getOrderSummary).not.toHaveBeenCalled();
    // …and the counters the transaction already committed stay still.
    const counterCalls = mocks.contractUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "ordersCount" in data || "lifetimeRevenueCents" in data;
    });
    expect(counterCalls).toHaveLength(0);
  });

  it("each re-driven step is individually deduped (crash AFTER events, BEFORE marker)", async () => {
    // The first delivery got all the way through notification + events and
    // died stamping the marker: the redrive must add nothing twice — only
    // finish the marker.
    mocks.hasSentForCycle.mockResolvedValue(true);
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });

    await redeliver();

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const types = mocks.logEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types).not.toContain("billing.attempt_succeeded");
    expect(types).not.toContain("billing.order_created");
    // The event dedupe was keyed on THIS attempt.
    const dedupe = mocks.subscriberEventFindFirst.mock.calls.find((c) => {
      const where = (c[0] as { where?: Record<string, unknown> }).where ?? {};
      return where.type === "billing.attempt_succeeded";
    });
    expect(dedupe).toBeDefined();
    expect(
      ((dedupe as unknown[])[0] as { where: { payload: unknown } }).where.payload,
    ).toEqual({ path: ["attemptId"], equals: "att_1" });
    // The marker still lands: the attempt leaves the half-settled state.
    const markerCalls = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return "settledAt" in data && data.settledAt != null;
    });
    expect(markerCalls).toHaveLength(1);
  });
});
