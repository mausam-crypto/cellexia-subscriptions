/**
 * Webhook handler flow tests (mocked prisma / Shopify) — regression coverage
 * for the final-sweep fixes:
 *
 *  1. ORDERS_CREATE stamping works against the REAL REST payload shape:
 *     order webhook line_items carry NO selling-plan field
 *     (selling_plan_allocation is a Cart AJAX / Liquid concept), so any gate
 *     on it makes the whole stamping step dead code.
 *  2. Order-side acquisition enrichment survives BOTH webhook orderings:
 *     contract-first (merge without clobbering a stamped AOV) and
 *     order-first (ACQUISITION_ORDER_CAPTURE stash → contract-create merge).
 *  3. The null-origin fallback arm is time-windowed so a new order can never
 *     cross-stamp a back-book/imported contract of the same customer.
 *  4. Quality-score acquisitionSource reads the v2 record (the widget packs
 *     UTMs into _cellexia_utm; top-level utm_* attributes never exist).
 *  5. Billing-failure replay gate: a redelivery after a mid-handler crash
 *     must still start dunning (state-driven gate, not `replayed` alone).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionContract: {
    findMany: vi.fn(),
    update: vi.fn(),
  },
  analyticsEvent: {
    findFirst: vi.fn(),
    create: vi.fn(),
  },
  dunningState: { findUnique: vi.fn() },
  contractLine: { findMany: vi.fn() },
  scoreSnapshot: { create: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

const shopifyClient = vi.hoisted(() => {
  class ShopifyGraphqlError extends Error {
    constructor(
      message: string,
      public readonly errors: unknown,
      public readonly userErrors?: Array<{ field?: string[]; message: string }>,
    ) {
      super(message);
      this.name = "ShopifyGraphqlError";
    }
  }
  return {
    ShopifyGraphqlError,
    toGid: (type: string, id: string) => `gid://shopify/${type}/${id}`,
    getOfflineAdmin: vi.fn(async () => ({ graphql: { __tag: "graphql" } })),
    runGraphql: vi.fn(),
    assertNoUserErrors: vi.fn(),
  };
});
vi.mock("~/services/core/shopifyClient.server", () => shopifyClient);

const core = vi.hoisted(() => ({
  fetchShopifyContract: vi.fn(),
  syncContractFromShopify: vi.fn(),
}));
vi.mock("~/services/core/contracts.server", () => core);

const billing = vi.hoisted(() => ({ recordAttemptOutcome: vi.fn() }));
vi.mock("~/services/core/billing.server", () => billing);

// Faithful mini-implementation of the documented contract (a live episode,
// except the grace-pause-resume handoff FINAL_NOTICE/nextRetryAt-null state,
// whose next failure must open a fresh episode) so this suite stays hermetic.
const dunning = vi.hoisted(() => ({
  onBillingFailure: vi.fn(),
  onBillingSuccess: vi.fn(),
  isLiveEpisodeForFailure: (phase: string, nextRetryAt: Date | null) =>
    ["RETRYING", "GRACE", "FINAL_NOTICE"].includes(phase) &&
    !(phase === "FINAL_NOTICE" && nextRetryAt == null),
}));
vi.mock("~/services/retention/dunning.server", () => dunning);

const fulfillment = vi.hoisted(() => ({ consumeAddOnsAfterCharge: vi.fn() }));
vi.mock("~/services/offers/addOnFulfillment.server", () => fulfillment);

const quality = vi.hoisted(() => ({
  computeQualityScore: vi.fn((_features: { acquisitionSource: string }) => ({
    score: 55,
    factors: {},
  })),
}));
vi.mock("~/services/treatment/quality.server", () => quality);

const depletion = vi.hoisted(() => ({ registerDepletionSignal: vi.fn() }));
vi.mock("~/services/treatment/depletion.server", () => depletion);

import {
  ACQUISITION_ORDER_CAPTURE,
  handleBillingAttemptFailure,
  handleOrdersCreate,
  handleSubscriptionContractCreate,
} from "~/services/core/webhooks/handlers.server";

const SHOP = "cellexia-demo.myshopify.com";
const ORDER_GID = "gid://shopify/Order/5551234";
const CUSTOMER_GID = "gid://shopify/Customer/777";
const ORDER_CREATED_AT = "2026-08-02T10:00:00Z";

/**
 * A real orders/create REST serialization: line_items carry price, sku,
 * properties, discount_allocations… and NO selling-plan field of any kind.
 */
function ordersCreatePayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 5551234,
    admin_graphql_api_id: ORDER_GID,
    name: "#1042",
    source_name: "web",
    total_price: "89.90",
    created_at: ORDER_CREATED_AT,
    customer_locale: "fr-FR",
    customer: { id: 777 },
    note_attributes: [
      { name: "_cellexia_widget", value: "B" },
      { name: "_cellexia_utm", value: '{"utm_source":"tiktok"}' },
      { name: "_cellexia_qty", value: "2" },
    ],
    shipping_address: { country_code: "FR", city: "Lyon", zip: "69003" },
    line_items: [
      {
        id: 1,
        price: "39.95",
        product_id: 11,
        variant_id: 111,
        quantity: 2,
        sku: "CLX-01",
        properties: [],
        discount_allocations: [],
      },
    ],
    ...overrides,
  };
}

function makeTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    shopifyCustomerId: CUSTOMER_GID,
    acquisitionJson: null,
    originOrderId: null,
    firstOrderAovCents: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.subscriptionContract.findMany.mockResolvedValue([]);
  db.subscriptionContract.update.mockResolvedValue({});
  db.analyticsEvent.findFirst.mockResolvedValue(null);
  db.analyticsEvent.create.mockResolvedValue({});
  db.dunningState.findUnique.mockResolvedValue(null);
  db.contractLine.findMany.mockResolvedValue([]);
  db.scoreSnapshot.create.mockResolvedValue({});
});

describe("handleOrdersCreate — REST payload with no selling-plan fields", () => {
  it("stamps origin order, AOV and merged acquisition on the matched contract", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([makeTarget()]);

    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload(),
    });

    expect(db.subscriptionContract.update).toHaveBeenCalledTimes(1);
    const { where, data } = db.subscriptionContract.update.mock.calls[0][0];
    expect(where).toEqual({ id: "c1" });
    expect(data.originOrderId).toBe(ORDER_GID);
    expect(data.firstOrderAovCents).toBe(8990);
    const acquisition = JSON.parse(data.acquisitionJson as string);
    expect(acquisition.orderName).toBe("#1042");
    expect(acquisition.customerLocale).toBe("fr-FR");
    expect(acquisition.sourceName).toBe("web");
    expect(acquisition.channel).toBe("tiktok");
    expect(acquisition.geo).toMatchObject({ countryCode: "FR", zip3: "690" });
    // _cellexia_qty fallback (order line_items cannot identify plan lines).
    expect(acquisition.unitsInitial).toBe(2);

    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ORIGIN_ORDER_STAMPED",
        subjectId: ORDER_GID,
      }),
    );
  });

  it("time-windows the null-origin fallback arm (no back-book cross-stamping)", async () => {
    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload(),
    });

    const { where } = db.subscriptionContract.findMany.mock.calls[0][0];
    expect(where.shopifyCustomerId).toBe(CUSTOMER_GID);
    const [direct, fallback] = where.OR;
    expect(direct).toEqual({ originOrderId: ORDER_GID });
    expect(fallback.originOrderId).toBeNull();
    const windowMs = 48 * 60 * 60 * 1000;
    const orderAt = new Date(ORDER_CREATED_AT).getTime();
    expect(fallback.treatmentStartedAt.gte.getTime()).toBe(orderAt - windowMs);
    expect(fallback.treatmentStartedAt.lte.getTime()).toBe(orderAt + windowMs);
    // The old firstOrderAovCents:null filter must be gone — it discarded the
    // enrichment merge for every contract-first delivery.
    expect(where.firstOrderAovCents).toBeUndefined();
  });

  it("merges enrichment WITHOUT re-stamping AOV when the contract is already priced", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      makeTarget({ originOrderId: ORDER_GID, firstOrderAovCents: 4200 }),
    ]);

    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload(),
    });

    const { data } = db.subscriptionContract.update.mock.calls[0][0];
    expect(data.firstOrderAovCents).toBeUndefined();
    expect(data.originOrderId).toBeUndefined();
    const acquisition = JSON.parse(data.acquisitionJson as string);
    expect(acquisition.orderName).toBe("#1042");
  });

  it("REGRESSION: contract-first enrichment keeps stored contract-built keys authoritative (unitsInitial)", async () => {
    // SUBSCRIPTION_CONTRACTS_CREATE landed first and stamped unitsInitial=2
    // from the REAL contract lines. The customer picked qty 1 in the widget
    // and raised it to 2 in the cart, so the order-side record's
    // _cellexia_qty fallback says 1 — the enrichment merge must go UNDERNEATH
    // the stored record (mirroring the order-first stash path), not over it.
    db.subscriptionContract.findMany.mockResolvedValue([
      makeTarget({
        originOrderId: ORDER_GID,
        firstOrderAovCents: 8990,
        acquisitionJson: JSON.stringify({
          schemaVersion: 2,
          capturedAt: "2026-08-02T10:05:00.000Z",
          channel: "tiktok",
          widgetVersion: "B",
          unitsInitial: 2,
          linesInitial: 2,
        }),
      }),
    ]);

    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload({
        note_attributes: [
          { name: "_cellexia_widget", value: "B" },
          { name: "_cellexia_utm", value: '{"utm_source":"tiktok"}' },
          { name: "_cellexia_qty", value: "1" },
        ],
      }),
    });

    const { data } = db.subscriptionContract.update.mock.calls[0][0];
    const acquisition = JSON.parse(data.acquisitionJson as string);
    // Contract-built fields survive — before the fix the order record's
    // widget-qty fallback overwrote unitsInitial to 1, leaving
    // linesInitial=2 inconsistent and misfiling the initial-units cohort.
    expect(acquisition.unitsInitial).toBe(2);
    expect(acquisition.linesInitial).toBe(2);
    // …while order-only enrichment still gap-fills.
    expect(acquisition.orderName).toBe("#1042");
    expect(acquisition.customerLocale).toBe("fr-FR");
    expect(acquisition.sourceName).toBe("web");
    expect(acquisition.geo).toMatchObject({ countryCode: "FR", zip3: "690" });
  });

  it("stashes an ACQUISITION_ORDER_CAPTURE event for order-first arrival (idempotently)", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([]); // contract row not created yet

    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload(),
    });

    expect(db.analyticsEvent.create).toHaveBeenCalledTimes(1);
    const { data } = db.analyticsEvent.create.mock.calls[0][0];
    expect(data.name).toBe(ACQUISITION_ORDER_CAPTURE);
    const stash = JSON.parse(data.payloadJson as string);
    expect(stash.orderId).toBe(ORDER_GID);
    expect(stash.acquisition.customerLocale).toBe("fr-FR");

    // Redelivery: the stash already exists → no duplicate row.
    db.analyticsEvent.findFirst.mockResolvedValue({ id: "evt1" });
    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload(),
    });
    expect(db.analyticsEvent.create).toHaveBeenCalledTimes(1);
  });

  it("does not stash plain one-time orders (no _cellexia_* attributes)", async () => {
    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload({ note_attributes: [] }),
    });
    expect(db.analyticsEvent.create).not.toHaveBeenCalled();
  });

  it("ignores recurring orders entirely", async () => {
    await handleOrdersCreate({
      topic: "ORDERS_CREATE",
      shop: SHOP,
      payload: ordersCreatePayload({ source_name: "subscription_contract" }),
    });
    expect(db.subscriptionContract.findMany).not.toHaveBeenCalled();
    expect(db.analyticsEvent.create).not.toHaveBeenCalled();
  });
});

describe("handleSubscriptionContractCreate — enrichment + quality source", () => {
  const CONTRACT_GID = "gid://shopify/SubscriptionContract/9001";

  function remotePayload(
    customAttributes: Array<{ key: string; value: string | null }>,
  ) {
    return {
      id: CONTRACT_GID,
      status: "ACTIVE",
      createdAt: "2026-08-02T10:05:00Z",
      nextBillingDate: null,
      note: null,
      customAttributes,
      currencyCode: "EUR",
      customer: { id: CUSTOMER_GID, email: "marie@example.com" },
      customerPaymentMethod: null,
      billingPolicy: { interval: "WEEK", intervalCount: 4 },
      deliveryPolicy: { interval: "WEEK", intervalCount: 4 },
      deliveryMethod: null,
      originOrder: {
        id: ORDER_GID,
        totalPriceSet: { shopMoney: { amount: "89.90", currencyCode: "EUR" } },
      },
      lines: { edges: [{ node: { quantity: 2 } }] },
    };
  }

  function localContract() {
    return {
      id: "c1",
      shop: SHOP,
      shopifyCustomerId: CUSTOMER_GID,
      customerEmail: "marie@example.com",
      acquisitionJson: null,
      originOrderId: null,
      firstOrderAovCents: null,
      intervalWeeks: 4,
    };
  }

  beforeEach(() => {
    core.syncContractFromShopify.mockResolvedValue(localContract());
  });

  it("merges the order-first ACQUISITION_ORDER_CAPTURE stash under the contract record", async () => {
    core.fetchShopifyContract.mockResolvedValue(
      remotePayload([{ key: "_cellexia_widget", value: "B" }]),
    );
    db.analyticsEvent.findFirst.mockResolvedValue({
      payloadJson: JSON.stringify({
        orderId: ORDER_GID,
        acquisition: {
          schemaVersion: 2,
          capturedAt: ORDER_CREATED_AT,
          channel: "tiktok",
          customerLocale: "fr-FR",
          orderName: "#1042",
          sourceName: "web",
        },
      }),
    });

    await handleSubscriptionContractCreate({
      topic: "SUBSCRIPTION_CONTRACTS_CREATE",
      shop: SHOP,
      payload: { admin_graphql_api_id: CONTRACT_GID },
    });

    const { data } = db.subscriptionContract.update.mock.calls[0][0];
    const acquisition = JSON.parse(data.acquisitionJson as string);
    // Order-only fields land from the stash…
    expect(acquisition.orderName).toBe("#1042");
    expect(acquisition.customerLocale).toBe("fr-FR");
    expect(acquisition.sourceName).toBe("web");
    // …and the contract-built fields stay authoritative.
    expect(acquisition.unitsInitial).toBe(2);
    expect(acquisition.widgetVersion).toBe("B");
    // Stash lookup was keyed by the exact-terminated origin-order gid.
    const stashWhere = db.analyticsEvent.findFirst.mock.calls[0][0].where;
    expect(stashWhere.name).toBe(ACQUISITION_ORDER_CAPTURE);
    expect(stashWhere.payloadJson).toEqual({ contains: `${ORDER_GID}"` });
  });

  it("feeds computeQualityScore the _cellexia_utm source, not the dead top-level utm map", async () => {
    core.fetchShopifyContract.mockResolvedValue(
      remotePayload([
        { key: "_cellexia_utm", value: '{"utm_source":"coupon_site"}' },
      ]),
    );

    await handleSubscriptionContractCreate({
      topic: "SUBSCRIPTION_CONTRACTS_CREATE",
      shop: SHOP,
      payload: { admin_graphql_api_id: CONTRACT_GID },
    });

    const features = quality.computeQualityScore.mock.calls[0][0];
    expect(features.acquisitionSource).toBe("coupon_site");
  });

  it("scores attribute-less contracts as 'direct', never 'unknown'", async () => {
    core.fetchShopifyContract.mockResolvedValue(remotePayload([]));

    await handleSubscriptionContractCreate({
      topic: "SUBSCRIPTION_CONTRACTS_CREATE",
      shop: SHOP,
      payload: { admin_graphql_api_id: CONTRACT_GID },
    });

    const features = quality.computeQualityScore.mock.calls[0][0];
    expect(features.acquisitionSource).toBe("direct");
  });
});

describe("handleBillingAttemptFailure — state-driven replay gate", () => {
  const ATTEMPT_GID = "gid://shopify/SubscriptionBillingAttempt/321";
  const failurePayload = {
    admin_graphql_api_id: ATTEMPT_GID,
    error_code: "card_declined",
  };
  const contract = {
    id: "c1",
    shop: SHOP,
    shopifyCustomerId: CUSTOMER_GID,
    customerEmail: "marie@example.com",
  };

  function outcome(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      attempt: {
        id: "a1",
        status: "FAILURE",
        occurredAt: new Date("2026-08-02T12:00:00Z"),
      },
      contract,
      replayed: false,
      ...overrides,
    };
  }

  async function run() {
    await handleBillingAttemptFailure({
      topic: "SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE",
      shop: SHOP,
      payload: failurePayload,
    });
  }

  it("starts dunning on the first delivery (baseline)", async () => {
    billing.recordAttemptOutcome.mockResolvedValue(outcome());
    await run();
    expect(dunning.onBillingFailure).toHaveBeenCalledWith(
      SHOP,
      "c1",
      "card_declined",
      { challenged: false },
    );
    expect(events.emitLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "CHARGE_FAILED",
        dedupeKey: `charge-failed:${ATTEMPT_GID}`,
      }),
    );
  });

  it("REGRESSION: a redelivery after a mid-handler crash still starts dunning", async () => {
    // First delivery flipped the attempt to FAILURE, then onBillingFailure
    // threw and webhooks.tsx released the replay guard. The redelivery sees
    // replayed=true and NO DunningState — the old `if (replayed) return`
    // abandoned the cycle forever.
    billing.recordAttemptOutcome.mockResolvedValue(outcome({ replayed: true }));
    db.dunningState.findUnique.mockResolvedValue(null);
    await run();
    expect(dunning.onBillingFailure).toHaveBeenCalledTimes(1);
    expect(events.emitLifecycleEvent).toHaveBeenCalledTimes(1);
  });

  it("skips dunning on a true replay when the episode is already live", async () => {
    billing.recordAttemptOutcome.mockResolvedValue(outcome({ replayed: true }));
    db.dunningState.findUnique.mockResolvedValue({
      phase: "RETRYING",
      nextRetryAt: new Date("2026-08-04T00:00:00Z"),
      updatedAt: new Date("2026-08-02T12:00:01Z"),
    });
    await run();
    expect(dunning.onBillingFailure).not.toHaveBeenCalled();
    // The emit still runs — its dedupeKey makes it exactly-once, healing the
    // crash-in-emit variant without double-mailing true replays.
    expect(events.emitLifecycleEvent).toHaveBeenCalledTimes(1);
  });

  it("skips dunning when the episode for this failure already completed", async () => {
    billing.recordAttemptOutcome.mockResolvedValue(outcome({ replayed: true }));
    db.dunningState.findUnique.mockResolvedValue({
      phase: "RESOLVED",
      nextRetryAt: null,
      updatedAt: new Date("2026-08-02T12:00:05Z"), // after attempt.occurredAt
    });
    await run();
    expect(dunning.onBillingFailure).not.toHaveBeenCalled();
  });

  it("falls through the grace-pause handoff state (FINAL_NOTICE, nextRetryAt null)", async () => {
    // The handoff's documented contract: the next failure opens a FRESH
    // episode — a redelivered post-resume failure must not be swallowed.
    billing.recordAttemptOutcome.mockResolvedValue(outcome({ replayed: true }));
    db.dunningState.findUnique.mockResolvedValue({
      phase: "FINAL_NOTICE",
      nextRetryAt: null,
      updatedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await run();
    expect(dunning.onBillingFailure).toHaveBeenCalledTimes(1);
  });

  it("never duns a paid attempt (late failure-family webhook after SUCCESS)", async () => {
    billing.recordAttemptOutcome.mockResolvedValue(
      outcome({
        attempt: {
          id: "a1",
          status: "SUCCESS",
          occurredAt: new Date("2026-08-02T12:00:00Z"),
        },
        replayed: true,
      }),
    );
    await run();
    expect(dunning.onBillingFailure).not.toHaveBeenCalled();
    expect(events.emitLifecycleEvent).not.toHaveBeenCalled();
  });
});
