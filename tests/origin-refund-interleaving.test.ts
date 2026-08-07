import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Origin-order refunds vs. money capture — the interleaving contract.
 *
 * originMoneyFields (contracts/sync.server.ts) documents that refunds are
 * netted "from capture onward, so a refund can never be netted twice": a LATE
 * capture stores the order's CURRENT total, which is already net of any
 * refund reductions. That only holds if the REFUNDS_CREATE handler actually
 * refuses to increment originOrderRefundedCents while originOrderTotalCents
 * is still null — otherwise a refund arriving BEFORE the capture (mirror
 * created while the order fetch failed, or contract classified OURS late) is
 * subtracted twice: once inside the captured current total, once again as
 * refundedCents.
 *
 * These tests drive the REAL webhook handler and the REAL backfill job over
 * the analytics-db interpreter, so the row-level gate (`updateMany` where
 * originOrderTotalCents is not null) is what decides the outcome — a
 * reordered or dropped gate changes the numbers.
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => ({
  // logEvent mirrors the real side effect the replay guard depends on: every
  // logged event lands in the store's subscriberEvents, so a redelivered
  // refund id is visible to alreadyRecorded exactly like in production.
  events: [] as Row[],
  logEvent: vi.fn(async (e: Record<string, unknown>): Promise<void> => {
    mocks.events.push(e as Row);
  }),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  getOrderSummary: vi.fn(async (_admin: unknown, _gid: string): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: new Proxy(
    {},
    {
      get(_target, prop) {
        const client = dbHolder.current;
        if (!client) {
          throw new Error(`fake db not initialised (accessed ${String(prop)})`);
        }
        return client[prop as string];
      },
    },
  ),
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: mocks.requireShop,
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

// Keeps the Klaviyo/session-storage graph out (forecast.test.ts pattern).
vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: mocks.getOrderSummary,
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  listContractGids: vi.fn(async (): Promise<unknown[]> => []),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

import { webhookHandlers } from "~/lib/webhooks/handlers.server";
import { runOriginOrderBackfill } from "~/lib/contracts/sync.server";

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};
const ORIGIN_ORDER = "gid://shopify/Order/501";

function buildStore(originOverrides: Row = {}): {
  store: AnalyticsStore;
  contract: Row;
} {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  const contract: Row = {
    id: "c_org",
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    createdAt: new Date("2026-06-01T08:00:00Z"),
    customerId: "gid://shopify/Customer/7",
    email: "sub@example.com",
    locale: "en",
    currencyCode: "CHF",
    originOrderId: ORIGIN_ORDER,
    originOrderTotalCents: null,
    originOrderRefundedCents: 0,
    originOrderCurrencyCode: null,
    // Non-null: keeps the backfill's independent acquisition pickup out of
    // this test's frame.
    acqRaw: { captured: true },
    ...originOverrides,
  };
  store.subscriptionContracts.push(contract);
  // The store's event log backs the handler's refund-id replay guard.
  store.subscriberEvents = mocks.events as Row[];
  dbHolder.current = createAnalyticsDb(store) as unknown as Record<string, unknown>;
  return { store, contract };
}

function refundPayload(
  refundNumericId: number,
  amount: string,
  currency: string | null = "CHF",
): Record<string, unknown> {
  return {
    id: refundNumericId,
    admin_graphql_api_id: `gid://shopify/Refund/${refundNumericId}`,
    order_id: 501,
    transactions: [
      {
        kind: "refund",
        status: "success",
        amount,
        ...(currency != null ? { currency } : {}),
      },
    ],
  };
}

async function deliverRefund(
  refundNumericId: number,
  amount: string,
  webhookId: string,
  currency: string | null = "CHF",
) {
  await webhookHandlers.REFUNDS_CREATE({
    shopDomain: "cellexia.myshopify.com",
    payload: refundPayload(refundNumericId, amount, currency),
    webhookId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [];
  dbHolder.current = null;
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.getPrimaryShop.mockResolvedValue({ ...SHOP });
});

describe("REFUNDS_CREATE before origin capture (webhook-before-backfill interleaving)", () => {
  it("skips the pre-capture refund; the later capture's current total is the single source of netting", async () => {
    const { contract } = buildStore();

    // 1. Merchant refunds CHF 20 of the CHF 50 origin order — the mirror has
    //    no captured money yet (capture-at-sync order fetch failed).
    await deliverRefund(9001, "20.00", "wh_r1");

    expect(contract.originOrderRefundedCents).toBe(0); // NOT incremented
    const skip = mocks.events.find(
      (e) => (e.payload as Row)?.action === "refund_skipped_pre_capture",
    );
    expect(skip).toBeDefined();
    expect((skip!.payload as Row).refundId).toBe("gid://shopify/Refund/9001");
    expect((skip!.payload as Row).amountCents).toBe(2000);

    // 2. The nightly backfill captures the order AFTER the refund: Shopify's
    //    current total is already net (5000 − 2000 = 3000).
    mocks.getOrderSummary.mockResolvedValue({
      totalCents: 3000,
      discountsCents: 0,
      shippingCents: 0,
      processedAt: new Date("2026-06-10T10:00:00Z"),
      createdAt: new Date("2026-06-10T09:59:00Z"),
      currencyCode: "CHF",
    });
    const result = await runOriginOrderBackfill();
    expect(result).toMatchObject({ captured: 1, failed: 0 });

    // 3. Money actually kept = 3000, netted exactly once. Before the gate,
    //    cohorts/rollups would have booked 3000 − 2000 = 1000.
    expect(contract.originOrderTotalCents).toBe(3000);
    expect(contract.originOrderRefundedCents).toBe(0);
  });

  it("a manual redelivery of the skipped refund AFTER capture cannot net it a second time", async () => {
    const { contract } = buildStore();
    await deliverRefund(9001, "20.00", "wh_r1"); // skipped pre-capture

    mocks.getOrderSummary.mockResolvedValue({
      totalCents: 3000,
      discountsCents: 0,
      shippingCents: 0,
      processedAt: new Date("2026-06-10T10:00:00Z"),
      createdAt: null,
      currencyCode: "CHF",
    });
    await runOriginOrderBackfill(); // capture absorbs the refund

    // Manual redelivery: NEW webhook id, same refund. The skip event armed
    // the refund-id replay guard, so nothing moves.
    await deliverRefund(9001, "20.00", "wh_r1_redelivery");
    expect(contract.originOrderTotalCents).toBe(3000);
    expect(contract.originOrderRefundedCents).toBe(0);
  });
});

describe("REFUNDS_CREATE after origin capture", () => {
  it("nets the refund exactly once from capture onward (idempotent under redelivery)", async () => {
    const { contract } = buildStore({
      originOrderTotalCents: 5000,
      originOrderProcessedAt: new Date("2026-06-10T10:00:00Z"),
      originOrderCurrencyCode: "CHF",
    });

    await deliverRefund(9002, "20.00", "wh_r2");
    expect(contract.originOrderRefundedCents).toBe(2000);
    const recorded = mocks.events.find(
      (e) => (e.payload as Row)?.action === "refund_recorded",
    );
    expect(recorded).toBeDefined();
    expect((recorded!.payload as Row).originOrder).toBe(true);

    // Same refund, new webhook id (manual redelivery): the replay guard holds.
    await deliverRefund(9002, "20.00", "wh_r2_redelivery");
    expect(contract.originOrderRefundedCents).toBe(2000);

    // A genuinely new refund still accumulates.
    await deliverRefund(9003, "5.00", "wh_r3");
    expect(contract.originOrderRefundedCents).toBe(2500);
  });
});

describe("REFUNDS_CREATE currency agreement (Shopify Markets multi-currency)", () => {
  // CHF shop selling to Germany: the origin order's shopMoney total is CHF
  // while the customer paid EUR — REST refund transactions carry the PAYMENT
  // currency. Netting EUR cents against a CHF total mis-nets by the FX delta,
  // so the handler must skip (and log) rather than sum raw — the same rule
  // rollup applies to mixed-currency revenue.

  it("origin branch: a foreign-presentment refund is skipped, never mixed into the CHF total", async () => {
    const { contract } = buildStore({
      originOrderTotalCents: 9350, // CHF 93.50 (shopMoney)
      originOrderProcessedAt: new Date("2026-06-10T10:00:00Z"),
      originOrderCurrencyCode: "CHF",
    });

    // Merchant refunds EUR 30 of the EUR 100 the customer actually paid.
    await deliverRefund(9101, "30.00", "wh_fx1", "EUR");

    expect(contract.originOrderRefundedCents).toBe(0); // NOT incremented
    const skip = mocks.events.find(
      (e) => (e.payload as Row)?.action === "refund_skipped_currency_mismatch",
    );
    expect(skip).toBeDefined();
    expect((skip!.payload as Row).refundId).toBe("gid://shopify/Refund/9101");
    expect((skip!.payload as Row).amountCents).toBe(3000);
    expect((skip!.payload as Row).currencyCode).toBe("EUR");
    expect((skip!.payload as Row).expectedCurrencyCode).toBe("CHF");
    expect((skip!.payload as Row).originOrder).toBe(true);

    // The skip event arms the refund-id replay guard: a manual redelivery of
    // the same refund cannot sneak the EUR cents in either.
    await deliverRefund(9101, "30.00", "wh_fx1_redelivery", "EUR");
    expect(contract.originOrderRefundedCents).toBe(0);
    expect(
      mocks.events.filter(
        (e) => (e.payload as Row)?.refundId === "gid://shopify/Refund/9101",
      ),
    ).toHaveLength(1);

    // A shop-currency refund on the same order still nets normally.
    await deliverRefund(9102, "10.00", "wh_fx2", "CHF");
    expect(contract.originOrderRefundedCents).toBe(1000);
  });

  it("origin branch: a refund with NO currency in the payload still nets (mismatch must be provable)", async () => {
    const { contract } = buildStore({
      originOrderTotalCents: 5000,
      originOrderProcessedAt: new Date("2026-06-10T10:00:00Z"),
      originOrderCurrencyCode: "CHF",
    });

    await deliverRefund(9103, "20.00", "wh_fx3", null);
    expect(contract.originOrderRefundedCents).toBe(2000);
    const recorded = mocks.events.find(
      (e) => (e.payload as Row)?.action === "refund_recorded",
    );
    expect(recorded).toBeDefined();
  });

  it("attempt branch: a foreign-presentment refund neither increments refundedCents nor decrements lifetime revenue", async () => {
    const { store, contract } = buildStore({ lifetimeRevenueCents: 5760 });
    // The refunded order is a RENEWAL billed by this app — the attempt match
    // takes precedence over the origin match, exercising branch 1.
    const attempt: Row = {
      id: "ba_1",
      contractId: contract.id,
      contract,
      orderId: ORIGIN_ORDER,
      status: "SUCCESS",
      amountCents: 5760, // CHF (shopMoney), stamped with currencyCode below
      currencyCode: "CHF",
      refundedCents: 0,
      cycleIndex: 3,
    };
    store.billingAttempts.push(attempt);

    await deliverRefund(9201, "30.00", "wh_fx4", "EUR");

    expect(attempt.refundedCents).toBe(0);
    expect(contract.lifetimeRevenueCents).toBe(5760); // untouched
    const skip = mocks.events.find(
      (e) => (e.payload as Row)?.action === "refund_skipped_currency_mismatch",
    );
    expect(skip).toBeDefined();
    expect((skip!.payload as Row).attemptId).toBe("ba_1");
    expect((skip!.payload as Row).currencyCode).toBe("EUR");
    expect((skip!.payload as Row).expectedCurrencyCode).toBe("CHF");

    // Redelivery of the skipped refund stays blocked by the replay guard.
    await deliverRefund(9201, "30.00", "wh_fx4_redelivery", "EUR");
    expect(attempt.refundedCents).toBe(0);
    expect(contract.lifetimeRevenueCents).toBe(5760);

    // A shop-currency refund on the same attempt still nets and decrements.
    await deliverRefund(9202, "10.00", "wh_fx5", "CHF");
    expect(attempt.refundedCents).toBe(1000);
    expect(contract.lifetimeRevenueCents).toBe(4760);
  });
});
