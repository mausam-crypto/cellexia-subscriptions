import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * The refund ledger's crash-safety and unmatched-window contracts.
 *
 * WH-01: handleRefundsCreate's only replay guard is the admin.action event
 * carrying the refundId. The money mutation (refundedCents increment,
 * lifetimeRevenueCents decrement, originOrderRefundedCents increment) must
 * commit IN ONE TRANSACTION with that event — via logEventOrThrow, so a
 * refused event insert rolls the counters back and surfaces as a FAILED
 * receipt instead of committing an unguarded increment a redelivery would
 * repeat.
 *
 * WH-03: a refund arriving before the attempt/mirror exists used to return
 * silently — invisible forever, and a post-settlement manual replay would
 * then double-net. Now it logs a refund_unmatched guard event, and the daily
 * reconcileUnmatchedRefunds pass (jobs: refund_reconcile) re-attempts the
 * match: money-only refunds are netted (the later capture never absorbed
 * them), item-linked refunds get a terminal absorbed-by-capture verdict, and
 * origin matches get the same pre-capture verdict the live branch applies.
 *
 * Driven through the REAL handler/job over the analytics-db interpreter, so
 * the row-level gates and guard queries are what decide the outcomes.
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => ({
  // Both log entry points land shaped rows in the store's subscriberEvents,
  // exactly like production (guards + reconcile read them back through the
  // fake db). logEventOrThrow can be armed to refuse, modelling a failed
  // insert inside the transaction.
  events: [] as Row[],
  refuseEventWrite: { current: false },
  record: (e: Record<string, unknown>): void => {
    mocks.events.push({
      shopId: e.shopId,
      contractId: e.contractId ?? null,
      customerId: e.customerId ?? null,
      email: e.email ?? null,
      type: e.type,
      source: e.source,
      payload: e.payload ?? {},
      createdAt: new Date(),
    });
  },
  logEvent: vi.fn(async (e: Record<string, unknown>): Promise<void> => {
    mocks.record(e);
  }),
  logEventOrThrow: vi.fn(
    async (
      e: Record<string, unknown>,
      _opts?: { tx?: unknown },
    ): Promise<void> => {
      if (mocks.refuseEventWrite.current) {
        throw new Error("subscriber event insert refused");
      }
      mocks.record(e);
    },
  ),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => null),
  requireShop: vi.fn(async (): Promise<unknown> => null),
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

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  logEventOrThrow: mocks.logEventOrThrow,
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/lib/notifications/send.server", () => ({
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));

vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  // Conversion read (v1.16.0): a CONCLUSIVE non-answer by default, so the
  // mismatch tests keep pinning the terminal skip verdict; the transient
  // path (a throw) is pinned separately.
  getRefundShopMoney: vi.fn(async (): Promise<unknown> => null),
  gql: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

import {
  reconcileUnmatchedRefunds,
  webhookHandlers,
} from "~/lib/webhooks/handlers.server";

const SHOP_ID = "shop_1";
const SHOP: Row = {
  id: SHOP_ID,
  domain: "cellexia.myshopify.com",
  currencyCode: "CHF",
  ianaTimezone: "Europe/Zurich",
};
const RENEWAL_ORDER = "gid://shopify/Order/700";

function buildStore(): {
  store: AnalyticsStore;
  contract: Row;
} {
  const store = emptyStore();
  store.shops.push({ ...SHOP });
  const contract: Row = {
    id: "c_1",
    shopId: SHOP_ID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/7",
    email: "sub@example.com",
    currencyCode: "CHF",
    lifetimeRevenueCents: 5000,
    originOrderId: null,
    originOrderTotalCents: null,
    originOrderRefundedCents: 0,
    originOrderCurrencyCode: null,
  };
  store.subscriptionContracts.push(contract);
  store.subscriberEvents = mocks.events as Row[];
  dbHolder.current = createAnalyticsDb(store) as unknown as Record<
    string,
    unknown
  >;
  return { store, contract };
}

/** A settled attempt whose order the refund matches. Embeds the contract. */
function attachAttempt(store: AnalyticsStore, contract: Row): Row {
  const attempt: Row = {
    id: "att_1",
    contractId: contract.id,
    contract, // same reference: counter moves are visible on both reads
    cycleIndex: 3,
    attemptNumber: 1,
    status: "SUCCESS",
    orderId: RENEWAL_ORDER,
    orderName: "#1001",
    amountCents: 5000,
    currencyCode: "CHF",
    refundedCents: 0,
  };
  store.billingAttempts.push(attempt);
  return attempt;
}

function refundPayload(
  refundNumericId: number,
  amount: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: refundNumericId,
    admin_graphql_api_id: `gid://shopify/Refund/${refundNumericId}`,
    order_id: 700,
    transactions: [
      { kind: "refund", status: "success", amount, currency: "CHF" },
    ],
    ...over,
  };
}

async function deliverRefund(
  payload: Record<string, unknown>,
  webhookId: string,
): Promise<void> {
  await webhookHandlers.REFUNDS_CREATE({
    shopDomain: "cellexia.myshopify.com",
    payload,
    webhookId,
  });
}

function eventsWithAction(action: string): Row[] {
  return mocks.events.filter((e) => (e.payload as Row)?.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events = [];
  mocks.refuseEventWrite.current = false;
  dbHolder.current = null;
  mocks.requireShop.mockResolvedValue({ ...SHOP });
  mocks.getPrimaryShop.mockResolvedValue({ ...SHOP });
});

// ── WH-01: counter and guard commit together ─────────────────────────────────

describe("REFUNDS_CREATE attempt branch — money and guard are one unit", () => {
  it("records the refund once: counter, net lifetime revenue and guard event, with the currency on the event", async () => {
    const { store, contract } = buildStore();
    const attempt = attachAttempt(store, contract);

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");

    expect(attempt.refundedCents).toBe(2000);
    expect(contract.lifetimeRevenueCents).toBe(3000);
    const recorded = eventsWithAction("refund_recorded");
    expect(recorded).toHaveLength(1);
    expect((recorded[0].payload as Row).currencyCode).toBe("CHF");
    // The guard event rode the money transaction, not best-effort logEvent.
    expect(mocks.logEventOrThrow).toHaveBeenCalledTimes(1);
    const opts = mocks.logEventOrThrow.mock.calls[0][1] as { tx?: unknown };
    expect(opts?.tx).toBeDefined();
  });

  it("a manual redelivery (new webhook id) is blocked by the guard event", async () => {
    const { store, contract } = buildStore();
    const attempt = attachAttempt(store, contract);

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1_redelivery");

    expect(attempt.refundedCents).toBe(2000); // once, not twice
    expect(contract.lifetimeRevenueCents).toBe(3000);
    expect(eventsWithAction("refund_recorded")).toHaveLength(1);
  });

  it("a refused guard-event insert FAILS the delivery instead of committing an unguarded counter", async () => {
    // In production the insert failure aborts the surrounding Postgres
    // transaction (increment rolled back with it); the handler must let that
    // propagate so the receipt reads FAILED and the refund stays replayable —
    // swallowing it here would be exactly the crash window WH-01 closes.
    const { store, contract } = buildStore();
    attachAttempt(store, contract);
    mocks.refuseEventWrite.current = true;

    await expect(
      deliverRefund(refundPayload(9001, "20.00"), "wh_r1"),
    ).rejects.toThrow("subscriber event insert refused");
  });

  it("the lifetime clamp reads the contract INSIDE the transaction", async () => {
    const { store, contract } = buildStore();
    const attempt = attachAttempt(store, contract);
    contract.lifetimeRevenueCents = 1500; // less than the refund

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");

    expect(attempt.refundedCents).toBe(2000);
    expect(contract.lifetimeRevenueCents).toBe(0); // clamped, never negative
  });
});

// ── WH-01 (origin branch): same one-unit rule ────────────────────────────────

describe("REFUNDS_CREATE origin branch — netting and guard are one unit", () => {
  function withOriginCapture(contract: Row): void {
    contract.originOrderId = RENEWAL_ORDER;
    contract.originOrderTotalCents = 5000;
    contract.originOrderCurrencyCode = "CHF";
  }

  it("nets a post-capture refund once and arms the guard in the same transaction", async () => {
    const { contract } = buildStore();
    withOriginCapture(contract);

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1_redelivery");

    expect(contract.originOrderRefundedCents).toBe(2000); // once
    // lifetimeRevenueCents keeps its renewals-only meaning — untouched.
    expect(contract.lifetimeRevenueCents).toBe(5000);
    expect(eventsWithAction("refund_recorded")).toHaveLength(1);
    expect(mocks.logEventOrThrow).toHaveBeenCalledTimes(1);
  });

  it("a pre-capture refund still skips (row-level gate) — and the skip verdict rides the transaction too", async () => {
    const { contract } = buildStore();
    contract.originOrderId = RENEWAL_ORDER; // mirror exists, money not captured

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");

    expect(contract.originOrderRefundedCents).toBe(0);
    expect(eventsWithAction("refund_skipped_pre_capture")).toHaveLength(1);
    // The skip event is a replay guard exactly like a recorded refund: a
    // swallowed insert would let a post-capture redelivery double-net.
    expect(mocks.logEventOrThrow).toHaveBeenCalledTimes(1);
  });

  it("a refused guard-event insert fails the origin delivery instead of committing unguarded netting", async () => {
    const { contract } = buildStore();
    withOriginCapture(contract);
    mocks.refuseEventWrite.current = true;

    await expect(
      deliverRefund(refundPayload(9001, "20.00"), "wh_r1"),
    ).rejects.toThrow("subscriber event insert refused");
  });
});

// ── WH-03: the unmatched windows leave a reconcilable trace ──────────────────

describe("REFUNDS_CREATE with no attempt/mirror match", () => {
  it("logs a refund_unmatched guard event carrying everything the reconcile needs", async () => {
    buildStore(); // contract exists but has no originOrderId and no attempt

    await deliverRefund(
      refundPayload(9001, "20.00", {
        refund_line_items: [{ line_item_id: 1 }],
      }),
      "wh_r1",
    );

    const unmatched = eventsWithAction("refund_unmatched");
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0].payload).toMatchObject({
      refundId: "gid://shopify/Refund/9001",
      orderId: RENEWAL_ORDER,
      amountCents: 2000,
      currencyCode: "CHF",
      lineItemRefund: true,
    });
  });

  it("is idempotent under redelivery, and arms the guard against a post-settlement replay", async () => {
    const { store, contract } = buildStore();

    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1_redelivery");
    expect(eventsWithAction("refund_unmatched")).toHaveLength(1);

    // The attempt settles LATER (capture already net of any item reductions):
    // a manual replay of the refund must NOT net it — the reconcile job owns
    // this refund from the moment the guard event exists.
    const attempt = attachAttempt(store, contract);
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1_late_replay");
    expect(attempt.refundedCents).toBe(0);
    expect(contract.lifetimeRevenueCents).toBe(5000);
    expect(eventsWithAction("refund_recorded")).toHaveLength(0);
  });
});

// ── I6: reconcileUnmatchedRefunds ────────────────────────────────────────────

describe("reconcileUnmatchedRefunds (refund_reconcile job)", () => {
  it("nets a money-only unmatched refund once the attempt exists — atomically, with a verdict event", async () => {
    const { store, contract } = buildStore();
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1"); // unmatched
    const attempt = attachAttempt(store, contract); // settlement arrives later

    const result = await reconcileUnmatchedRefunds();
    expect(result).toEqual({ scanned: 1, matched: 1 });

    expect(attempt.refundedCents).toBe(2000);
    expect(contract.lifetimeRevenueCents).toBe(3000);
    const recorded = eventsWithAction("refund_recorded");
    expect(recorded).toHaveLength(1);
    expect((recorded[0].payload as Row).resolvedBy).toBe("refund_reconcile");
    // The netting rode a transaction with its verdict, like the live branch.
    expect(mocks.logEventOrThrow).toHaveBeenCalled();
  });

  it("is idempotent: a second run finds the verdict and moves nothing", async () => {
    const { store, contract } = buildStore();
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");
    const attempt = attachAttempt(store, contract);

    await reconcileUnmatchedRefunds();
    const second = await reconcileUnmatchedRefunds();

    expect(second.matched).toBe(0);
    expect(attempt.refundedCents).toBe(2000); // once
    expect(eventsWithAction("refund_recorded")).toHaveLength(1);
  });

  it("an ITEM-linked refund is absorbed by the later capture — terminal skip, no counter movement", async () => {
    const { store, contract } = buildStore();
    await deliverRefund(
      refundPayload(9001, "20.00", {
        refund_line_items: [{ line_item_id: 1 }],
      }),
      "wh_r1",
    );
    const attempt = attachAttempt(store, contract);
    // The settlement captured the CURRENT total — already reduced by the
    // item refund. Netting again would subtract the same money twice.
    attempt.amountCents = 3000;

    const result = await reconcileUnmatchedRefunds();
    expect(result.matched).toBe(1);

    expect(attempt.refundedCents).toBe(0);
    expect(contract.lifetimeRevenueCents).toBe(5000);
    expect(eventsWithAction("refund_skipped_absorbed_by_capture")).toHaveLength(1);
    expect(eventsWithAction("refund_recorded")).toHaveLength(0);
  });

  it("an origin match gets the pre-capture verdict (mirror postdates the refund), never a second netting", async () => {
    const { contract } = buildStore();
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1"); // no mirror yet
    // The mirror lands later with the captured (already net) origin total.
    contract.originOrderId = RENEWAL_ORDER;
    contract.originOrderTotalCents = 3000;
    contract.originOrderCurrencyCode = "CHF";

    const result = await reconcileUnmatchedRefunds();
    expect(result.matched).toBe(1);

    expect(contract.originOrderRefundedCents).toBe(0);
    const verdicts = eventsWithAction("refund_skipped_pre_capture");
    expect(verdicts).toHaveLength(1);
    expect((verdicts[0].payload as Row).resolvedBy).toBe("refund_reconcile");
  });

  it("a still-unmatched refund is scanned but left pending (retried next run)", async () => {
    buildStore();
    await deliverRefund(refundPayload(9001, "20.00"), "wh_r1");

    const result = await reconcileUnmatchedRefunds();
    expect(result).toEqual({ scanned: 1, matched: 0 });
    expect(eventsWithAction("refund_unmatched")).toHaveLength(1); // untouched
  });

  it("a currency-mismatched attempt match gets the mismatch verdict, never a raw mix", async () => {
    const { store, contract } = buildStore();
    await deliverRefund(
      refundPayload(9001, "20.00", {
        transactions: [
          { kind: "refund", status: "success", amount: "20.00", currency: "EUR" },
        ],
      }),
      "wh_r1",
    );
    const attempt = attachAttempt(store, contract); // CHF attempt

    const result = await reconcileUnmatchedRefunds();
    expect(result.matched).toBe(1);

    expect(attempt.refundedCents).toBe(0);
    expect(eventsWithAction("refund_skipped_currency_mismatch")).toHaveLength(1);
  });
});
