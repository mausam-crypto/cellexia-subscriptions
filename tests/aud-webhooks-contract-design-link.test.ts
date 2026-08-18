import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Design measurement join wiring on the CONTRACT side (v1.26.0, docs/
 * ARCHITECTURE.md "Design measurement", CONTRACT §Webhook wiring):
 *
 *   - the SUBSCRIPTION_CONTRACTS_CREATE tail calls linkContractDesign(shopId,
 *     contractId) AFTER enrichAcquisitionOnContractCreate (the fact row must
 *     be joined at the create moment, like acquisition / survey / tags);
 *   - the SUBSCRIPTION_CONTRACTS_UPDATE catch-up branch (an update for a
 *     contract we never mirrored — the lost-create case) calls it once with
 *     the AFTER row's id, because that catch-up IS the create moment;
 *   - a plain status-transition update never calls it (nothing to join);
 *   - a rejecting linkContractDesign is CONTAINED: the handler resolves and
 *     the failure is logged as "[webhooks] design link failed" (the catch-up
 *     branch prefixes "catch-up ").
 *
 * WHY a dedicated file: the suites that exercise these two handlers
 * (aud-webhooks-new-topics, contract-ownership-sync, sync-first-sync-race) do
 * not mock ~/lib/design-measurement/facts.server, and the wiring helper
 * swallows every error — so deleting either call would fail zero tests. This
 * is the primary path by which a subscribed order's fact gets subscribed=true
 * and the contract its write-once originDesign* stamp whenever the order
 * webhook won the race; the ORDERS_CREATE side is pinned in
 * tests/aud-webhooks-orders-create-blocks.test.ts.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  surveyResponseFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  getContract: vi.fn(async (): Promise<unknown> => ({
    customer: { locale: null },
    nextBillingDate: new Date("2026-09-05T00:00:00Z"),
  })),
  syncContractFromShopify: vi.fn(async (): Promise<void> => {}),
  maybeTagSubscriptionOrder: vi.fn(async (): Promise<void> => {}),
  recordSubscribableOrder: vi.fn(async (_input: unknown): Promise<unknown> => null),
  linkContractDesign: vi.fn(
    async (_shopId: string, _contractId: string): Promise<unknown> => ({
      stamped: true,
      designKey: "subscription_max",
      designSource: "seen",
    }),
  ),
}));

vi.mock("~/lib/design-measurement/facts.server", () => ({
  recordSubscribableOrder: mocks.recordSubscribableOrder,
  linkContractDesign: mocks.linkContractDesign,
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      update: mocks.contractUpdate,
    },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
    surveyResponse: { findUnique: mocks.surveyResponseFindUnique },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEvent,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  gql: vi.fn(async (): Promise<unknown> => ({})),
  getContract: mocks.getContract,
  getOrderSummary: vi.fn(),
  getBillingCycleByDate: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  draftUpdatePaymentMethod: vi.fn(),
  withContractDraft: vi.fn(),
}));

vi.mock("~/lib/contracts/service.server", () => ({
  syncContractFromShopify: mocks.syncContractFromShopify,
}));

vi.mock("~/lib/gifts/firstOrderGift.server", () => ({
  ensureFirstOrderGift: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/lib/tagging/tags.server", () => ({
  maybeTagSubscriptionOrder: mocks.maybeTagSubscriptionOrder,
}));

// v1.28.0: the welcome-email hook runs after the design link on both create
// paths; it is pinned in tests/subscription-started-email.test.ts and stays
// out of this suite's console.error assertions.
vi.mock("~/lib/notifications/subscription-started.server", () => ({
  maybeSendSubscriptionStarted: vi.fn(async (): Promise<string> => "sent"),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia.myshopify.com",
  name: "Cellexia",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};

const CONTRACT_GID = "gid://shopify/SubscriptionContract/500";
const ORDER_GID = "gid://shopify/Order/999001";

/**
 * A COUNTABLE mirror (OURS, not demo) with an origin order and no acquisition
 * yet, so enrichAcquisitionOnContractCreate actually runs its stash lookup —
 * the ordering marker the "after enrich" assertion keys on.
 */
function mirror(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    status: "ACTIVE",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    currencyCode: "CHF",
    nextBillingDate: null,
    isPrepaid: false,
    isDemo: false,
    locale: "en",
    originOrderId: ORDER_GID,
    originOrderName: "#1042",
    ownership: "OURS",
    acqRaw: null,
    lines: [],
    ...over,
  };
}

function loggedOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

/** The enrichment's stash lookup — the only acquisition.captured query here. */
function acquisitionStashLookupOrder(): number | undefined {
  const index = mocks.subscriberEventFindFirst.mock.calls.findIndex((c) => {
    const where = ((c[0] ?? {}) as { where?: Record<string, unknown> }).where ?? {};
    return where.type === "acquisition.captured";
  });
  return index === -1
    ? undefined
    : mocks.subscriberEventFindFirst.mock.invocationCallOrder[index];
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.contractFindUnique.mockResolvedValue(mirror());
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.surveyResponseFindUnique.mockResolvedValue(null);
  mocks.linkContractDesign.mockResolvedValue({
    stamped: true,
    designKey: "subscription_max",
    designSource: "seen",
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

// ── SUBSCRIPTION_CONTRACTS_CREATE tail ───────────────────────────────────────

describe("SUBSCRIPTION_CONTRACTS_CREATE links the design fact at the create moment", () => {
  async function deliver(): Promise<void> {
    await webhookHandlers.SUBSCRIPTION_CONTRACTS_CREATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: CONTRACT_GID, id: 500 },
      webhookId: "wh_cc_1",
    });
  }

  it("calls linkContractDesign(shop.id, contract.id) exactly once, after the acquisition enrichment", async () => {
    await deliver();

    expect(mocks.linkContractDesign).toHaveBeenCalledTimes(1);
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_1");

    // Ordering: the acquisition pickup ran (its stash lookup is the marker)
    // and the design link came after it — and after the canonical event.
    const enrichOrder = acquisitionStashLookupOrder();
    expect(enrichOrder, "enrichAcquisitionOnContractCreate ran").toBeDefined();
    const linkOrder = mocks.linkContractDesign.mock.invocationCallOrder[0];
    expect(enrichOrder!).toBeLessThan(linkOrder);
    const createdIndex = mocks.logEvent.mock.calls.findIndex(
      (c) => (c[0] as { type: string }).type === "contract.created",
    );
    expect(createdIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.logEvent.mock.invocationCallOrder[createdIndex]).toBeLessThan(linkOrder);
    // The rest of the tail is untouched by the addition.
    expect(loggedOfType("contract.created")).toHaveLength(1);
    expect(mocks.syncContractFromShopify).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still links on a manual replay (the link is idempotent; only the canonical event is guarded)", async () => {
    mocks.subscriberEventFindFirst.mockImplementation(async (args?: unknown) => {
      const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
      return where.type === "contract.created" ? { id: "evt_created" } : null;
    });
    await deliver();
    expect(loggedOfType("contract.created")).toHaveLength(0);
    expect(mocks.linkContractDesign).toHaveBeenCalledTimes(1);
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_1");
  });

  it("a rejecting linkContractDesign is contained: the handler resolves and logs the failure", async () => {
    mocks.linkContractDesign.mockRejectedValue(new Error("facts down"));
    await expect(deliver()).resolves.toBeUndefined();
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_1");
    expect(consoleError).toHaveBeenCalledWith(
      "[webhooks] design link failed",
      "c_1",
      expect.any(Error),
    );
    // Everything before it in the tail already landed.
    expect(loggedOfType("contract.created")).toHaveLength(1);
  });

  it("a synchronously throwing linkContractDesign is contained too", async () => {
    mocks.linkContractDesign.mockImplementation(() => {
      throw new Error("sync boom");
    });
    await expect(deliver()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[webhooks] design link failed",
      "c_1",
      expect.any(Error),
    );
  });

  it("does not link when the payload carries no contract id (nothing was mirrored)", async () => {
    await webhookHandlers.SUBSCRIPTION_CONTRACTS_CREATE({
      shopDomain: SHOP.domain,
      payload: {},
      webhookId: "wh_cc_2",
    });
    expect(mocks.linkContractDesign).not.toHaveBeenCalled();
    expect(mocks.syncContractFromShopify).not.toHaveBeenCalled();
  });
});

// ── SUBSCRIPTION_CONTRACTS_UPDATE: catch-up branch vs plain update ───────────

describe("SUBSCRIPTION_CONTRACTS_UPDATE", () => {
  async function deliver(): Promise<void> {
    await webhookHandlers.SUBSCRIPTION_CONTRACTS_UPDATE({
      shopDomain: SHOP.domain,
      payload: { admin_graphql_api_id: CONTRACT_GID, id: 500, status: "ACTIVE" },
      webhookId: "wh_cu_1",
    });
  }

  /**
   * The lost-create shape: the `before` lookup (select: { status }) finds no
   * mirror, the sync builds it, the `after` lookup returns it. Every id-keyed
   * lookup by the create-moment helpers (enrich, survey, tags) sees the
   * mirror too. The after row is given a DIFFERENT id from the create-side
   * fixture so the assertion below cannot pass on a stale "c_1".
   */
  function wireCatchUp(): void {
    mocks.contractFindUnique.mockImplementation(async (args?: unknown) => {
      const a = (args ?? {}) as { where?: Record<string, unknown>; select?: unknown };
      if (a.select && a.where?.shopifyContractId) return null; // `before`
      return mirror({ id: "c_after" });
    });
  }

  it("catch-up (no mirror before the sync): links once with the AFTER row's id, after the acquisition pickup", async () => {
    wireCatchUp();
    await deliver();

    // It IS the create moment: the canonical event, then the same tail.
    const created = loggedOfType("contract.created");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ shopifyContractId: CONTRACT_GID, catchUp: true });

    expect(mocks.linkContractDesign).toHaveBeenCalledTimes(1);
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_after");
    const enrichOrder = acquisitionStashLookupOrder();
    expect(enrichOrder, "catch-up acquisition enrichment ran").toBeDefined();
    expect(enrichOrder!).toBeLessThan(
      mocks.linkContractDesign.mock.invocationCallOrder[0],
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("catch-up: a rejecting link is contained and logged with the catch-up prefix", async () => {
    wireCatchUp();
    mocks.linkContractDesign.mockRejectedValue(new Error("facts down"));
    await expect(deliver()).resolves.toBeUndefined();
    expect(mocks.linkContractDesign).toHaveBeenCalledWith("shop_1", "c_after");
    expect(consoleError).toHaveBeenCalledWith(
      "[webhooks] catch-up design link failed",
      "c_after",
      expect.any(Error),
    );
    expect(loggedOfType("contract.created")).toHaveLength(1);
  });

  it("a plain update of an already-mirrored contract never links (not a create moment)", async () => {
    // `before` exists with the same status → contract.updated, no tail.
    mocks.contractFindUnique.mockImplementation(async (args?: unknown) => {
      const a = (args ?? {}) as { select?: unknown };
      return a.select ? { status: "ACTIVE" } : mirror();
    });
    await deliver();
    expect(loggedOfType("contract.created")).toHaveLength(0);
    expect(loggedOfType("contract.updated")).toHaveLength(1);
    expect(mocks.linkContractDesign).not.toHaveBeenCalled();
    expect(acquisitionStashLookupOrder()).toBeUndefined();
  });

  it("a status transition of an already-mirrored contract never links either", async () => {
    mocks.contractFindUnique.mockImplementation(async (args?: unknown) => {
      const a = (args ?? {}) as { select?: unknown };
      return a.select ? { status: "PAUSED" } : mirror({ status: "ACTIVE" });
    });
    await deliver();
    expect(loggedOfType("contract.activated")).toHaveLength(1);
    expect(mocks.linkContractDesign).not.toHaveBeenCalled();
  });
});
