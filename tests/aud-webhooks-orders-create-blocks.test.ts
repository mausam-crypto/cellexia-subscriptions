import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ORDERS_CREATE per-family idempotency, the test-order gate, and the two
 * feed-parity fixes.
 *
 * WH-04/EVT-2/SP-06/ACQ-3: the handler writes three event families in
 * sequence (acquisition stash → widget.design_attributed per key →
 * checkout.subscribable LAST). The old guard early-returned when ANY event
 * existed for the order, so a crash or swallowed insert between families
 * armed the guard and made every redelivery a clean skip — the missing
 * takeRateDen row / sibling design keys / acquisition bundle were
 * unrepairable by ANY path. Each family now dedupes on its OWN existence, so
 * a redelivery re-completes exactly what is missing.
 *
 * WH-11: payload.test orders never enter take-rate, design or acquisition —
 * only an auditable order_skipped_test marker.
 *
 * WH-12/SP-05: the design feed accepts the marker-less REST payload variant
 * whenever the same containsSubscribable fallback the denominator uses
 * matched — the two feeds computed from one order can no longer disagree.
 *
 * SP-15: checkout.subscribable carries the presentment currency and the
 * order's design keys, the join context per-market take-rate needs.
 *
 * v1.26.0 (design measurement): every subscribable order ALSO writes one
 * SubscribableOrder fact through recordSubscribableOrder — even on a
 * redelivery where checkout.subscribable already exists (the fact upsert is
 * idempotent, so this is the repair path for a lost row), with the per-line
 * design/seen properties, selling plan ids, isOurProduct and the promo flag;
 * a throwing writer never fails the webhook; the checkout.subscribable payload
 * gains the distinct `seen` markers; renewal/test/non-subscribable orders
 * never record a fact. A ONE-TIME-only order of our product (the take-rate
 * denominator) records a fact too — pinned explicitly, since gating the fact
 * write on hasSellingPlanLine would otherwise survive every other case here.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(
    async (): Promise<unknown> => ({
      id: "shop_1",
      domain: "cellexia-test.myshopify.com",
    }),
  ),
  sellingPlanConfigFindMany: vi.fn(async (): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  recordSubscribableOrder: vi.fn(
    async (_input: unknown): Promise<unknown> => ({
      designKey: null,
      designPreselect: null,
      designSource: "none",
      created: true,
    }),
  ),
  linkContractDesign: vi.fn(
    async (_shopId: string, _contractId: string): Promise<unknown> => ({
      stamped: false,
      designKey: null,
      designSource: null,
    }),
  ),
}));

vi.mock("~/lib/design-measurement/facts.server", () => ({
  recordSubscribableOrder: mocks.recordSubscribableOrder,
  linkContractDesign: mocks.linkContractDesign,
}));

vi.mock("~/db.server", () => ({
  default: {
    sellingPlanConfig: { findMany: mocks.sellingPlanConfigFindMany },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    subscriptionContract: { findFirst: mocks.contractFindFirst },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));

vi.mock("~/lib/settings/settings.server", () => ({ getSetting: vi.fn() }));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  gql: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

vi.mock("~/lib/graphql/customers.server", () => ({
  getCustomer: vi.fn(async (): Promise<unknown> => null),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const ORDER_GID = "gid://shopify/Order/999001";

/**
 * Answer the per-family existence checks from a set of "already logged"
 * events, keyed the way the handler queries them (where.type + payload
 * paths). Unknown shapes answer null (nothing exists).
 */
function wireExistingEvents(
  existing: Array<{ type: string; designKey?: string; action?: string }>,
): void {
  mocks.subscriberEventFindFirst.mockImplementation(async (args?: unknown) => {
    const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
    const type = where.type as string | undefined;
    // Collect every payload-path equality in the query (top level or AND).
    const pathEquals = new Map<string, unknown>();
    const collect = (cond: unknown): void => {
      if (cond == null || typeof cond !== "object") return;
      const c = cond as Record<string, unknown>;
      const p = c.payload as { path?: string[]; equals?: unknown } | undefined;
      if (p?.path) pathEquals.set(p.path.join("."), p.equals);
      for (const sub of (c.AND as unknown[]) ?? []) collect(sub);
    };
    collect(where);
    const hit = existing.find((e) => {
      if (e.type !== type) return false;
      const designKey = pathEquals.get("designKey");
      if (designKey !== undefined && designKey !== e.designKey) return false;
      const action = pathEquals.get("action");
      if (action !== undefined && action !== e.action) return false;
      return true;
    });
    return hit ? { id: "evt_existing" } : null;
  });
}

function orderPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 999001,
    admin_graphql_api_id: ORDER_GID,
    name: "#1042",
    email: "buyer@cellexia.example",
    source_name: "web",
    currency: "CHF",
    presentment_currency: "EUR",
    total_price: "84.90",
    line_items: [
      {
        product_id: 111,
        selling_plan_id: 777,
        quantity: 1,
        properties: [{ name: "_cellexia_design", value: "value_stack" }],
      },
      {
        product_id: 222,
        selling_plan_id: 777,
        quantity: 1,
        properties: [{ name: "_cellexia_design", value: "toggle" }],
      },
    ],
    ...over,
  };
}

async function run(payload: Record<string, unknown>): Promise<void> {
  await webhookHandlers.ORDERS_CREATE({
    shopDomain: "cellexia-test.myshopify.com",
    payload,
    webhookId: "wh_oc_1",
  });
}

function loggedTypes(): string[] {
  return mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
}

function loggedOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

/** The single recordSubscribableOrder input of the last run (asserts exactly one call). */
function recordedFact(): Record<string, unknown> {
  expect(mocks.recordSubscribableOrder).toHaveBeenCalledTimes(1);
  return mocks.recordSubscribableOrder.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
  });
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
  mocks.recordSubscribableOrder.mockResolvedValue({
    designKey: null,
    designPreselect: null,
    designSource: "none",
    created: true,
  });
  mocks.linkContractDesign.mockResolvedValue({
    stamped: false,
    designKey: null,
    designSource: null,
  });
});

// ── WH-04 / EVT-2 / SP-06: partial runs re-complete ──────────────────────────

describe("per-family redelivery repair", () => {
  it("a fresh order logs all three families", async () => {
    await run(orderPayload());
    const types = loggedTypes();
    expect(types).toContain("acquisition.captured");
    expect(types).toContain("widget.design_attributed");
    expect(types).toContain("checkout.subscribable");
  });

  it("crash after the design events: the redelivery still lands checkout.subscribable (the takeRateDen row)", async () => {
    // The exact partial state the old any-event guard made permanent: both
    // design events exist, the stash exists, the denominator row does NOT.
    wireExistingEvents([
      { type: "acquisition.captured" },
      { type: "widget.design_attributed", designKey: "value_stack" },
      { type: "widget.design_attributed", designKey: "toggle" },
    ]);

    await run(orderPayload());

    expect(loggedOfType("checkout.subscribable")).toHaveLength(1);
    // …and nothing that already exists is duplicated.
    expect(loggedOfType("widget.design_attributed")).toHaveLength(0);
    expect(loggedOfType("acquisition.captured")).toHaveLength(0);
  });

  it("crash between two design events: only the missing sibling key logs", async () => {
    wireExistingEvents([
      { type: "acquisition.captured" },
      { type: "widget.design_attributed", designKey: "value_stack" },
    ]);

    await run(orderPayload());

    const designs = loggedOfType("widget.design_attributed");
    expect(designs).toHaveLength(1);
    expect(designs[0].designKey).toBe("toggle");
  });

  it("a swallowed stash insert is repaired while the later events dedupe", async () => {
    // ACQ-3's silent variant: checkout.subscribable landed, the stash write
    // was swallowed. The old guard blocked the redelivery before the
    // acquisition block; per-family dedupe re-stashes.
    wireExistingEvents([
      { type: "checkout.subscribable" },
      { type: "widget.design_attributed", designKey: "value_stack" },
      { type: "widget.design_attributed", designKey: "toggle" },
    ]);

    await run(orderPayload());

    expect(loggedOfType("acquisition.captured")).toHaveLength(1);
    expect(loggedOfType("checkout.subscribable")).toHaveLength(0);
  });

  it("a fully processed order is a clean no-op", async () => {
    wireExistingEvents([
      { type: "acquisition.captured" },
      { type: "checkout.subscribable" },
      { type: "widget.design_attributed", designKey: "value_stack" },
      { type: "widget.design_attributed", designKey: "toggle" },
    ]);

    await run(orderPayload());

    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── WH-11: test orders ───────────────────────────────────────────────────────

describe("Shopify test orders", () => {
  it("count nowhere — only the auditable skip marker is logged", async () => {
    await run(orderPayload({ test: true }));

    expect(loggedOfType("checkout.subscribable")).toHaveLength(0);
    expect(loggedOfType("widget.design_attributed")).toHaveLength(0);
    expect(loggedOfType("acquisition.captured")).toHaveLength(0);

    const markers = loggedOfType("admin.action");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      action: "order_skipped_test",
      orderId: ORDER_GID,
      test: true,
    });
  });

  it("the skip marker itself dedupes on redelivery", async () => {
    wireExistingEvents([{ type: "admin.action", action: "order_skipped_test" }]);
    await run(orderPayload({ test: true }));
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── WH-12 / SP-05: marker-less design attribution ────────────────────────────

describe("design attribution on marker-less REST payloads", () => {
  const markerlessLine = {
    product_id: 111,
    quantity: 1,
    properties: [{ name: "_cellexia_design", value: "planner" }],
  };

  it("attributes the design when the containsSubscribable fallback matched (denominator parity)", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      { productIds: ["gid://shopify/Product/111"] },
    ]);
    await run(orderPayload({ line_items: [markerlessLine] }));

    const designs = loggedOfType("widget.design_attributed");
    expect(designs).toHaveLength(1);
    expect(designs[0].designKey).toBe("planner");
    // The same order counts in the denominator — the two feeds agree.
    expect(loggedOfType("checkout.subscribable")).toHaveLength(1);
  });

  it("still ignores the property on a provably one-time line (no marker, no fallback match)", async () => {
    await run(orderPayload({ line_items: [markerlessLine] }));
    expect(loggedOfType("widget.design_attributed")).toHaveLength(0);
    expect(loggedOfType("checkout.subscribable")).toHaveLength(0);
  });
});

// ── SP-15: per-market join context ───────────────────────────────────────────

describe("checkout.subscribable payload context", () => {
  it("carries the presentment currency and the order's design keys, sorted", async () => {
    await run(orderPayload());
    const [payload] = loggedOfType("checkout.subscribable");
    expect(payload).toMatchObject({
      orderId: ORDER_GID,
      orderName: "#1042",
      hasSellingPlanLine: true,
      presentmentCurrencyCode: "EUR",
      designKeys: ["toggle", "value_stack"],
    });
  });

  it("degrades to null/[] when the payload has neither", async () => {
    await run(
      orderPayload({
        presentment_currency: null,
        line_items: [{ product_id: 111, selling_plan_id: 777, quantity: 1, properties: [] }],
      }),
    );
    const [payload] = loggedOfType("checkout.subscribable");
    expect(payload.presentmentCurrencyCode).toBeNull();
    expect(payload.designKeys).toEqual([]);
  });
});

// ── v1.26.0: the SubscribableOrder fact write ────────────────────────────────

describe("design fact (recordSubscribableOrder) wiring", () => {
  /** Mixed order: our subscription line, our one-time line, a foreign vendor's plan line. */
  function mixedOrder(over: Record<string, unknown> = {}): Record<string, unknown> {
    return orderPayload({
      processed_at: "2026-09-03T10:15:00Z",
      created_at: "2026-09-03T10:14:00Z",
      shipping_address: { country_code: "FR", city: "Lyon" },
      billing_address: { country_code: "DE" },
      client_details: {
        user_agent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      },
      line_items: [
        {
          product_id: 111,
          variant_id: 1111,
          quantity: 2,
          selling_plan_allocation: {
            selling_plan: { id: 777, name: "Every 4 weeks" },
          },
          properties: [
            { name: "_cellexia_design", value: "subscription_max" },
            { name: "_cellexia_seen", value: "subscription_max|s" },
          ],
        },
        {
          product_id: 111,
          variant_id: 1112,
          quantity: 1,
          properties: [{ name: "_cellexia_seen", value: "subscription_max|s" }],
        },
        {
          product_id: 333,
          variant_id: 3333,
          quantity: 1,
          selling_plan_id: 42424242,
          properties: [],
        },
      ],
      ...over,
    });
  }

  beforeEach(() => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([
      { productIds: ["gid://shopify/Product/111"] },
    ]);
  });

  it("records one fact with the order shape: lines (seen/design props, isOurProduct, plan ids), promo false, hasSellingPlanLine", async () => {
    await run(mixedOrder());

    const fact = recordedFact();
    expect(fact).toMatchObject({
      shopId: "shop_1",
      orderId: ORDER_GID,
      orderName: "#1042",
      countryCode: "FR", // shipping wins over billing
      currencyCode: "EUR", // presentment currency, not the shop currency
      deviceType: "mobile", // reused from the acquisition capture
      sourceName: "web",
      orderTotalCents: 8490,
      units: 4,
      orderEmail: "buyer@cellexia.example",
      hasSellingPlanLine: true,
      promo: false,
    });
    expect((fact.processedAt as Date).toISOString()).toBe("2026-09-03T10:15:00.000Z");

    const lines = fact.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      variantId: "gid://shopify/ProductVariant/1111",
      productId: "gid://shopify/Product/111",
      sellingPlanId: "777", // selling_plan_allocation.selling_plan.id first
      designProp: "subscription_max",
      seenProp: "subscription_max|s",
      isOurProduct: true,
    });
    // One-time add of OUR product: seen but no design prop, no plan.
    expect(lines[1]).toMatchObject({
      variantId: "gid://shopify/ProductVariant/1112",
      productId: "gid://shopify/Product/111",
      sellingPlanId: null,
      designProp: null,
      seenProp: "subscription_max|s",
      isOurProduct: true,
    });
    // Foreign vendor's plan line: visible to the writer, flagged not ours.
    expect(lines[2]).toMatchObject({
      productId: "gid://shopify/Product/333",
      sellingPlanId: "42424242",
      designProp: null,
      seenProp: null,
      isOurProduct: false,
    });
  });

  /**
   * The take-rate DENOMINATOR: a one-time-only order of OUR product (no plan
   * marker anywhere, subscribable purely through the productIds fallback)
   * MUST write a fact with hasSellingPlanLine false. Every other positive
   * fact case in this file carries a subscription line, so without this case
   * a mutation of the guard before the design-fact block from `if (orderGid)`
   * to `if (orderGid && hasSellingPlanLine)` — silently dropping every
   * one-time order from SubscribableOrder and making take rate read 100% for
   * every design — survives the whole suite. This case fails it: the writer
   * is never called under the mutated guard.
   */
  it("a one-time-only order of our product (no plan marker) still records a fact: hasSellingPlanLine false, seen parsed, isOurProduct true", async () => {
    await run(
      orderPayload({
        line_items: [
          {
            product_id: 111,
            variant_id: 1111,
            quantity: 1,
            properties: [{ name: "_cellexia_seen", value: "classic|o" }],
          },
        ],
      }),
    );

    const fact = recordedFact();
    expect(fact).toMatchObject({
      shopId: "shop_1",
      orderId: ORDER_GID,
      hasSellingPlanLine: false,
      promo: false,
      units: 1,
    });
    const lines = fact.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      variantId: "gid://shopify/ProductVariant/1111",
      productId: "gid://shopify/Product/111",
      sellingPlanId: null,
      designProp: null,
      seenProp: "classic|o",
      isOurProduct: true,
    });
    // The denominator event agrees: counted, one-time, seen carried.
    const [payload] = loggedOfType("checkout.subscribable");
    expect(payload).toMatchObject({
      orderId: ORDER_GID,
      hasSellingPlanLine: false,
      designKeys: [],
      seen: ["classic|o"],
    });
    // The exposure marker alone never enters the design feed.
    expect(loggedOfType("widget.design_attributed")).toHaveLength(0);
  });

  it("isOurProduct is known even when a selling-plan marker already proved the order subscribable (config read hoisted)", async () => {
    // Before v1.26.0 the SellingPlanConfig read was skipped whenever a marker
    // existed; the fact needs the product set on every order.
    await run(mixedOrder());
    expect(mocks.sellingPlanConfigFindMany).toHaveBeenCalledTimes(1);
    const lines = recordedFact().lines as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.isOurProduct)).toEqual([true, true, false]);
  });

  it("promo is true with a discount code", async () => {
    await run(mixedOrder({ discount_codes: [{ code: "WELCOME10", amount: "8.49" }] }));
    expect(recordedFact().promo).toBe(true);
  });

  it("promo is true with an automatic discount application (no code)", async () => {
    await run(
      mixedOrder({
        discount_codes: [],
        discount_applications: [{ type: "automatic", title: "Summer" }],
      }),
    );
    expect(recordedFact().promo).toBe(true);
  });

  it("selling plan id falls back selling_plan_id → selling_plan.{id} → bare selling_plan", async () => {
    await run(
      orderPayload({
        line_items: [
          { product_id: 111, quantity: 1, selling_plan_id: 1, properties: [] },
          { product_id: 111, quantity: 1, selling_plan: { id: 2 }, properties: [] },
          { product_id: 111, quantity: 1, selling_plan: "gid://shopify/SellingPlan/3" },
        ],
      }),
    );
    const lines = recordedFact().lines as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.sellingPlanId)).toEqual([
      "1",
      "2",
      "gid://shopify/SellingPlan/3",
    ]);
  });

  it("processedAt falls back to created_at, then to now; sourceName is capped at 40 chars", async () => {
    await run(
      mixedOrder({
        processed_at: null,
        created_at: "2026-09-04T08:00:00Z",
        source_name: "x".repeat(60),
      }),
    );
    const fact = recordedFact();
    expect((fact.processedAt as Date).toISOString()).toBe("2026-09-04T08:00:00.000Z");
    expect(fact.sourceName).toBe("x".repeat(40));

    vi.clearAllMocks();
    const before = Date.now();
    await run(mixedOrder({ processed_at: null, created_at: "not-a-date" }));
    const at = (recordedFact().processedAt as Date).getTime();
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it("the fact is STILL written on a redelivery where checkout.subscribable already exists (idempotent repair path)", async () => {
    wireExistingEvents([
      { type: "acquisition.captured" },
      { type: "checkout.subscribable" },
      { type: "widget.design_attributed", designKey: "subscription_max" },
    ]);

    await run(mixedOrder());

    // The event dedupe itself is unchanged: nothing re-logs…
    expect(mocks.logEvent).not.toHaveBeenCalled();
    // …but the fact write is not gated by that decision.
    expect(mocks.recordSubscribableOrder).toHaveBeenCalledTimes(1);
    expect(recordedFact().orderId).toBe(ORDER_GID);
  });

  it("a throwing recordSubscribableOrder never fails the webhook, and the event families still landed", async () => {
    mocks.recordSubscribableOrder.mockRejectedValue(new Error("db down"));
    await expect(run(mixedOrder())).resolves.toBeUndefined();
    expect(loggedOfType("checkout.subscribable")).toHaveLength(1);
    expect(loggedOfType("acquisition.captured")).toHaveLength(1);
  });

  it("a rejected linkContractDesign never fails the webhook either", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "c_1",
      ownership: "OURS",
      acqRaw: { existing: true },
      originOrderId: ORDER_GID,
    });
    mocks.linkContractDesign.mockRejectedValue(new Error("boom"));
    await expect(run(mixedOrder())).resolves.toBeUndefined();
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_1");
  });

  it("links the fact to the contract when the mirror already exists (contract webhook won the race), after the fact write", async () => {
    mocks.contractFindFirst.mockResolvedValue({
      id: "c_1",
      ownership: "OURS",
      acqRaw: { existing: true },
      originOrderId: ORDER_GID,
    });
    await run(mixedOrder());
    expect(mocks.linkContractDesign).toHaveBeenCalledTimes(1);
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_1");
    const factOrder = mocks.recordSubscribableOrder.mock.invocationCallOrder[0];
    const linkOrder = mocks.linkContractDesign.mock.invocationCallOrder[0];
    expect(factOrder).toBeLessThan(linkOrder);
  });

  it("does not link when no contract mirror exists yet (the create tail will)", async () => {
    await run(mixedOrder());
    expect(mocks.linkContractDesign).not.toHaveBeenCalled();
  });

  it("seen values land in the checkout.subscribable payload, distinct and sorted", async () => {
    await run(
      mixedOrder({
        line_items: [
          {
            product_id: 111,
            quantity: 1,
            selling_plan_id: 777,
            properties: [
              { name: "_cellexia_design", value: "toggle" },
              { name: "_cellexia_seen", value: "toggle|s" },
            ],
          },
          {
            product_id: 111,
            quantity: 1,
            properties: { _cellexia_seen: "classic|o" },
          },
          {
            product_id: 111,
            quantity: 1,
            properties: [{ name: "_cellexia_seen", value: "toggle|s" }],
          },
        ],
      }),
    );
    const [payload] = loggedOfType("checkout.subscribable");
    expect(payload.seen).toEqual(["classic|o", "toggle|s"]);
    // The pre-existing fields are untouched by the addition.
    expect(payload).toMatchObject({
      orderId: ORDER_GID,
      hasSellingPlanLine: true,
      designKeys: ["toggle"],
    });
  });

  it("seen is [] when no line carries the marker", async () => {
    await run(orderPayload());
    const [payload] = loggedOfType("checkout.subscribable");
    expect(payload.seen).toEqual([]);
  });

  it("a renewal order (source_name subscription_contract) never records a fact", async () => {
    await run(mixedOrder({ source_name: "subscription_contract" }));
    expect(mocks.recordSubscribableOrder).not.toHaveBeenCalled();
    expect(mocks.linkContractDesign).not.toHaveBeenCalled();
  });

  it("a Shopify test order never records a fact", async () => {
    await run(mixedOrder({ test: true }));
    expect(mocks.recordSubscribableOrder).not.toHaveBeenCalled();
    expect(loggedOfType("admin.action")).toHaveLength(1);
  });

  it("a non-subscribable order (no marker, no product in the set) never records a fact", async () => {
    mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
    await run(
      orderPayload({
        line_items: [
          {
            product_id: 555,
            quantity: 1,
            properties: [{ name: "_cellexia_seen", value: "toggle|s" }],
          },
        ],
      }),
    );
    expect(mocks.recordSubscribableOrder).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("an order without any id records no fact (nothing to key it on) but still logs the events", async () => {
    await run(mixedOrder({ id: null, admin_graphql_api_id: null }));
    expect(mocks.recordSubscribableOrder).not.toHaveBeenCalled();
    expect(loggedOfType("checkout.subscribable")).toHaveLength(1);
  });
});
