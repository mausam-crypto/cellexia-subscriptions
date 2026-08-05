/**
 * Recurring billing scheduler — the job that actually charges subscriptions.
 * Caught in the pre-deployment audit: without it no renewal is ever billed
 * (Shopify never auto-bills app-owned contracts). These tests pin the
 * division of labour (scheduler = first attempt of a cycle; dunning = every
 * retry) and the skip guards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionContract: {
    findMany: vi.fn(),
  },
  billingAttempt: {
    findFirst: vi.fn((..._args: unknown[]) => Promise.resolve(null as unknown)),
  },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({
  appendAudit: vi.fn(async (_entry: { action: string }) => {}),
}));
vi.mock("~/services/audit.server", () => audit);

const billing = vi.hoisted(() => ({
  createBillingAttempt: vi.fn(async (..._args: unknown[]) => ({ id: "attempt" })),
}));
vi.mock("~/services/core/billing.server", () => billing);

const client = vi.hoisted(() => ({
  getOfflineAdmin: vi.fn(async () => ({ graphql: async () => new Response() })),
}));
vi.mock("~/services/core/shopifyClient.server", () => client);

vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runBillingJob } from "~/services/core/billingScheduler.server";

const DAY = 24 * 60 * 60 * 1000;

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    shop: "s1.myshopify.com",
    status: "ACTIVE",
    successfulOrders: 1,
    nextBillingDate: new Date(Date.now() - DAY),
    dunningState: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.billingAttempt.findFirst.mockResolvedValue(null);
});

describe("runBillingJob", () => {
  it("creates the FIRST attempt of the due cycle (index = successfulOrders + 1)", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([contract()]);
    const [summary] = await runBillingJob("s1.myshopify.com");

    expect(billing.createBillingAttempt).toHaveBeenCalledTimes(1);
    expect(billing.createBillingAttempt.mock.calls[0][2]).toBe("c1");
    expect(billing.createBillingAttempt.mock.calls[0][3]).toEqual({
      billingCycleIndex: 2,
    });
    expect(summary).toMatchObject({ due: 1, attempted: 1, failed: 0 });
  });

  it("skips a cycle that already has ANY attempt row — and the existence query cannot confuse cycle 2 with cycle 20", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([contract()]);
    db.billingAttempt.findFirst.mockResolvedValue({ id: "existing" });

    const [summary] = await runBillingJob("s1.myshopify.com");
    expect(billing.createBillingAttempt).not.toHaveBeenCalled();
    expect(summary.skippedExistingAttempt).toBe(1);

    // The lookup must match the exact cycle key or the key + ":" retry
    // namespace — never a bare startsWith (bill:c1:2 prefixes bill:c1:20).
    const firstCall = db.billingAttempt.findFirst.mock.calls[0] as unknown[];
    const where = (firstCall[0] as { where: { OR: unknown } }).where;
    expect(where.OR).toEqual([
      { idempotencyKey: "bill:c1:2" },
      { idempotencyKey: { startsWith: "bill:c1:2:" } },
    ]);
  });

  it("never bills a contract inside an active dunning episode (dunning owns the unpaid cycle)", async () => {
    for (const phase of ["RETRYING", "GRACE", "FINAL_NOTICE"]) {
      vi.clearAllMocks();
      db.billingAttempt.findFirst.mockResolvedValue(null);
      db.subscriptionContract.findMany.mockResolvedValue([
        contract({ dunningState: { phase } }),
      ]);
      const [summary] = await runBillingJob("s1.myshopify.com");
      expect(billing.createBillingAttempt).not.toHaveBeenCalled();
      expect(summary.skippedDunning).toBe(1);
    }
  });

  it("bills normally when a past episode is RESOLVED", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      contract({ dunningState: { phase: "RESOLVED" } }),
    ]);
    const [summary] = await runBillingJob("s1.myshopify.com");
    expect(summary.attempted).toBe(1);
  });

  it("surfaces >45-day-overdue contracts for review instead of surprise-billing", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      contract({ nextBillingDate: new Date(Date.now() - 60 * DAY) }),
    ]);
    const [summary] = await runBillingJob("s1.myshopify.com");

    expect(billing.createBillingAttempt).not.toHaveBeenCalled();
    expect(summary.skippedStale).toBe(1);
    const staleAudit = audit.appendAudit.mock.calls.find(
      (c) => c[0].action === "BILLING_STALE_SKIPPED",
    );
    expect(staleAudit).toBeTruthy();
  });

  it("is fail-soft per contract: one Shopify error never blocks the rest of the queue", async () => {
    db.subscriptionContract.findMany.mockResolvedValue([
      contract({ id: "c-bad" }),
      contract({ id: "c-good" }),
    ]);
    billing.createBillingAttempt
      .mockRejectedValueOnce(new Error("shopify 500"))
      .mockResolvedValueOnce({ id: "ok" });

    const [summary] = await runBillingJob("s1.myshopify.com");
    expect(summary).toMatchObject({ due: 2, attempted: 1, failed: 1 });
    expect(billing.createBillingAttempt.mock.calls[1][2]).toBe("c-good");
  });
});
