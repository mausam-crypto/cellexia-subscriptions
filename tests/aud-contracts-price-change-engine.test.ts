import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Price-change engine — outcome ledger, currency guard, honest notice trail
 * (data-collection audit, migration 0016).
 *
 * The batch used to keep one aggregate (contractsAffected) and stamp itself
 * APPLIED regardless of per-contract failures, log the "advance notice sent"
 * event even when the send failed, and apply shop-currency cents to any
 * matching contract whatever it was billed in. These tests pin the fixes:
 *
 *  - the batch is stamped with the shop currency at creation;
 *  - notice + apply refuse contracts billed in another currency, RECORDING
 *    the exclusion in PriceChangeContractOutcome (never a silent skip);
 *  - contract.price_propagated {scheduled:true} is logged ONLY when the
 *    notice actually sent; failures record NOTICE_FAILED and a re-run
 *    retries exactly those;
 *  - apply records APPLIED / FAILED+error / SKIPPED_NULL_LINE per contract,
 *    stamps the batch APPLIED only when nothing failed, and a re-run skips
 *    contracts already APPLIED.
 *
 * DB-free: every seam mocked (price-change-notice-days.test.ts pattern).
 */

interface BatchRow extends Record<string, unknown> {
  id: string;
}

const store = vi.hoisted(() => ({
  batch: {} as BatchRow,
  contracts: [] as Array<Record<string, unknown>>,
  outcomes: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(
    async (): Promise<unknown> => ({ mode: "PROPAGATE_WITH_NOTICE", noticeDays: 30 }),
  ),
  batchCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "batch_1",
      ...args.data,
    }),
  ),
  batchUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      Object.assign(store.batch, args.data);
      return store.batch;
    },
  ),
  outcomeCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      const row = {
        id: `out_${store.outcomes.length + 1}`,
        createdAt: new Date(2026, 0, 1, 0, 0, store.outcomes.length),
        ...args.data,
      };
      store.outcomes.push(row);
      return row;
    },
  ),
  outcomeFindMany: vi.fn(
    async (args: {
      where: { status?: { in: string[] } };
    }): Promise<unknown[]> => {
      const allowed = args.where.status?.in;
      return store.outcomes.filter(
        (o) => !allowed || allowed.includes(o.status as string),
      );
    },
  ),
  sendNotification: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_input?: unknown): Promise<void> => {}),
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
  draftLineUpdate: vi.fn(async (): Promise<string | null> => "line_gid"),
  lineUpdate: vi.fn(async (): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    priceChangeBatch: {
      create: mocks.batchCreate,
      update: mocks.batchUpdate,
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.batch),
    },
    priceChangeContractOutcome: {
      create: mocks.outcomeCreate,
      findMany: mocks.outcomeFindMany,
    },
    subscriptionContract: {
      count: vi.fn(async (): Promise<number> => store.contracts.length),
      findMany: vi.fn(async (): Promise<unknown[]> => store.contracts),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    contractLine: { update: mocks.lineUpdate },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        currencyCode: "GBP",
        ianaTimezone: "Europe/London",
      })),
    },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftLineUpdate: mocks.draftLineUpdate,
  withContractDraft: mocks.withContractDraft,
}));
vi.mock("~/lib/contracts/shared.server", () => ({
  ongoingDiscountPctForProduct: vi.fn(async (): Promise<number | null> => 10),
  proportionalPriceCents: vi.fn((cents: number): number => cents),
  resolveActor: (): string => "system",
  resolveSource: (): string => "ADMIN",
}));
vi.mock("~/lib/ownership/ownership.server", () => ({
  OURS_ONLY: { ownership: "OURS" },
}));

import {
  applyPriceChangeBatch,
  createPriceChangeBatch,
  sendPriceChangeNotices,
} from "~/lib/contracts/priceChanges.server";

const VARIANT = "gid://shopify/ProductVariant/1";
const ITEMS = [{ variantId: VARIANT, oldPriceCents: 1000, newPriceCents: 1200 }];

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    currencyCode: "GBP",
    locale: "en",
    grandfatheredPricing: false,
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    lines: [
      {
        id: "l_1",
        shopifyLineId: "gid://shopify/SubscriptionLine/1",
        variantId: VARIANT,
        productId: "gid://shopify/Product/1",
        title: "Cream",
        isGift: false,
        isOneTimeAddon: false,
        currentPriceCents: 900,
        compareAtPriceCents: 1000,
      },
    ],
    ...over,
  };
}

function noticeSentBatch(over: Record<string, unknown> = {}): BatchRow {
  return {
    id: "batch_1",
    shopId: "shop_1",
    mode: "PROPAGATE_WITH_NOTICE",
    noticeDays: 30,
    status: "NOTICE_SENT",
    items: ITEMS,
    effectiveAt: new Date("2026-07-01T00:00:00Z"),
    noticeSentAt: new Date("2026-06-01T00:00:00Z"),
    currencyCode: "GBP",
    contractsAffected: 1,
    ...over,
  };
}

function outcomesFor(contractId: string): string[] {
  return store.outcomes
    .filter((o) => o.contractId === contractId)
    .map((o) => o.status as string);
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.batch = noticeSentBatch();
  store.contracts = [contract()];
  store.outcomes = [];
});

describe("createPriceChangeBatch currency stamp", () => {
  it("stamps the shop currency on the batch row", async () => {
    const batch = (await createPriceChangeBatch("shop_1", ITEMS)) as {
      currencyCode: string;
    };
    expect(batch.currencyCode).toBe("GBP");
    const data = (
      mocks.batchCreate.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data.currencyCode).toBe("GBP");
  });
});

describe("sendPriceChangeNotices — honest notice trail", () => {
  beforeEach(() => {
    store.batch = noticeSentBatch({
      status: "DRAFT",
      effectiveAt: null,
      noticeSentAt: null,
    });
  });

  it("records NOTICE_SENT and logs price_propagated only on a successful send", async () => {
    const result = await sendPriceChangeNotices("batch_1");

    expect(result.contractsNotified).toBe(1);
    expect(outcomesFor("c_1")).toEqual(["NOTICE_SENT"]);
    const scheduled = eventsOfType("contract.price_propagated");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].payload).toMatchObject({ scheduled: true });
  });

  it("a failed send records NOTICE_FAILED and logs NO price_propagated event", async () => {
    mocks.sendNotification.mockRejectedValueOnce(new Error("smtp down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendPriceChangeNotices("batch_1");

    expect(result.failures).toBe(1);
    expect(outcomesFor("c_1")).toEqual(["NOTICE_FAILED"]);
    // The event IS the compliance record that the subscriber was notified —
    // it must never exist for a send that did not happen.
    expect(eventsOfType("contract.price_propagated")).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("a contract billed in another currency is excluded AND recorded, never emailed", async () => {
    store.contracts = [contract({ currencyCode: "CHF" })];

    const result = await sendPriceChangeNotices("batch_1");

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(
      store.outcomes.filter(
        (o) => o.status === "NOTICE_FAILED" && o.error === "currency_mismatch",
      ),
    ).toHaveLength(1);
  });

  it("a re-run on a NOTICE_SENT batch retries only the NOTICE_FAILED contracts, reusing effectiveAt", async () => {
    store.contracts = [contract(), contract({ id: "c_2" })];
    mocks.sendNotification.mockRejectedValueOnce(new Error("smtp down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendPriceChangeNotices("batch_1"); // c_1 fails, c_2 sends
    expect(store.batch.status).toBe("NOTICE_SENT");
    const firstEffectiveAt = store.batch.effectiveAt;
    mocks.sendNotification.mockClear();
    mocks.batchUpdate.mockClear();

    const retry = await sendPriceChangeNotices("batch_1");

    // Exactly one re-send (the failed contract), no double-send to c_2,
    // and the batch row (window, count) is left untouched.
    expect(retry.contractsNotified).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    expect(store.batch.effectiveAt).toBe(firstEffectiveAt);
    expect(outcomesFor("c_1")).toEqual(["NOTICE_FAILED", "NOTICE_SENT"]);
    expect(outcomesFor("c_2")).toEqual(["NOTICE_SENT"]);
    errSpy.mockRestore();
  });
});

describe("applyPriceChangeBatch — outcome ledger + APPLIED gating", () => {
  it("records APPLIED per contract and stamps the batch when nothing failed", async () => {
    const result = await applyPriceChangeBatch("batch_1");

    expect(result.contractsUpdated).toBe(1);
    expect(outcomesFor("c_1")).toEqual(["APPLIED"]);
    expect(store.batch.status).toBe("APPLIED");
  });

  it("a failed contract records FAILED with the error and blocks the APPLIED stamp", async () => {
    mocks.withContractDraft.mockRejectedValueOnce(new Error("shopify 500"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyPriceChangeBatch("batch_1");

    expect(result.failures).toBe(1);
    expect(store.outcomes).toContainEqual(
      expect.objectContaining({
        contractId: "c_1",
        status: "FAILED",
        error: "shopify 500",
      }),
    );
    // Half-applied batches stay NOTICE_SENT so "Apply now" can retry.
    expect(store.batch.status).toBe("NOTICE_SENT");
    expect(mocks.batchUpdate).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a re-run retries only non-APPLIED contracts", async () => {
    store.contracts = [contract(), contract({ id: "c_2" })];
    mocks.withContractDraft.mockRejectedValueOnce(new Error("shopify 500"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await applyPriceChangeBatch("batch_1"); // c_1 fails, c_2 applies
    expect(store.batch.status).toBe("NOTICE_SENT");
    mocks.withContractDraft.mockClear();

    const retry = await applyPriceChangeBatch("batch_1");

    // Only the failed contract is re-attempted; with it landed, the batch
    // finally stamps APPLIED.
    expect(mocks.withContractDraft).toHaveBeenCalledTimes(1);
    expect(retry.contractsUpdated).toBe(1);
    expect(outcomesFor("c_1")).toEqual(["FAILED", "APPLIED"]);
    expect(outcomesFor("c_2")).toEqual(["APPLIED"]);
    expect(store.batch.status).toBe("APPLIED");
    errSpy.mockRestore();
  });

  it("a contract whose only matching line has no Shopify line id records SKIPPED_NULL_LINE", async () => {
    store.contracts = [
      contract({
        lines: [
          {
            id: "l_1",
            shopifyLineId: null,
            variantId: VARIANT,
            productId: "gid://shopify/Product/1",
            title: "Cream",
            isGift: false,
            isOneTimeAddon: false,
            currentPriceCents: 900,
            compareAtPriceCents: 1000,
          },
        ],
      }),
    ];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await applyPriceChangeBatch("batch_1");

    expect(result.failures).toBe(1);
    expect(outcomesFor("c_1")).toEqual(["SKIPPED_NULL_LINE"]);
    expect(store.batch.status).toBe("NOTICE_SENT");
    errSpy.mockRestore();
  });

  it("a currency-mismatched contract records FAILED currency_mismatch and is never written", async () => {
    store.contracts = [contract({ currencyCode: "CHF" })];

    const result = await applyPriceChangeBatch("batch_1");

    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(result.failures).toBe(1);
    expect(store.outcomes).toContainEqual(
      expect.objectContaining({
        contractId: "c_1",
        status: "FAILED",
        error: "currency_mismatch",
      }),
    );
    expect(store.batch.status).toBe("NOTICE_SENT");
  });

  it("a contract already at target price records APPLIED (convergent re-runs)", async () => {
    // e.g. an earlier run repriced it but its outcome write failed.
    store.contracts = [
      contract({
        lines: [
          {
            id: "l_1",
            shopifyLineId: "gid://shopify/SubscriptionLine/1",
            variantId: VARIANT,
            productId: "gid://shopify/Product/1",
            title: "Cream",
            isGift: false,
            isOneTimeAddon: false,
            currentPriceCents: 1080, // 1200 minus the 10% ongoing discount
            compareAtPriceCents: 1200,
          },
        ],
      }),
    ];

    const result = await applyPriceChangeBatch("batch_1");

    expect(mocks.withContractDraft).not.toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(outcomesFor("c_1")).toEqual(["APPLIED"]);
    expect(store.batch.status).toBe("APPLIED");
  });
});
