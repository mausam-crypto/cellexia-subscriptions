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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
  });
  mocks.sellingPlanConfigFindMany.mockResolvedValue([]);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.contractFindFirst.mockResolvedValue(null);
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
