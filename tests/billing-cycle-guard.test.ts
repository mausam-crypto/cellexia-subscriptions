import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CYCLE-HISTORY GUARD — why the 5-minute sweep can never become a retry
 * engine (re-billing audit, CRITICAL finding).
 *
 * Sweep eligibility used to hinge on `nextBillingDate` alone, a mirror field
 * the sweep does not control: it is NOT advanced when the attempt-create call
 * throws, and syncContractFromShopify / the billing-cycle-edit webhook rewrite
 * it to Shopify's value — which stays parked on an unbilled failed cycle. So a
 * failed cycle stayed "due" forever, and every 5-minute tick minted a FRESH
 * idempotency key (`{contractId}:{cycleIndex}:{attemptNumber+1}`) — a new,
 * real Shopify billing attempt outside the dunning ladder's pacing: ~288
 * card authorizations a day on a declining card.
 *
 * The fix (scheduler.server.ts, step b2): the sweep may only ever open the
 * FIRST attempt for a cycle. If ANY attempt exists for the resolved
 * cycleIndex, the contract is held (`stats.cycleHeld`) — a FAILED/CHALLENGED
 * newest attempt means the dunning engine owns every further attempt for the
 * cycle; a SUCCESS newest with a stale pointer means webhooks/sync own the
 * pointer advance (re-attempting would double-charge). These tests run the
 * REAL `runBillingSweep` against a mocked persistence/GraphQL seam and pin
 * both the hold and the untouched first-attempt path.
 */

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptCount: vi.fn(async (): Promise<number> => 0),
  attemptCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "att_new",
    ...args.data,
  })),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_event?: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  })),
  createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  })),
  evaluateStockoutForContract: vi.fn(async (): Promise<unknown> => null),
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
  applyGrantToCycle: vi.fn(async (): Promise<boolean> => false),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
    },
    billingAttempt: {
      findFirst: mocks.attemptFindFirst,
      count: mocks.attemptCount,
      create: mocks.attemptCreate,
      update: mocks.attemptUpdate,
    },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  createBillingAttempt: mocks.createBillingAttempt,
}));
vi.mock("~/lib/contracts/stockout.server", () => ({
  evaluateStockoutForContract: mocks.evaluateStockoutForContract,
}));
vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: mocks.ensureGiftsForUpcomingCycle,
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
  applyGrantToCycle: mocks.applyGrantToCycle,
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
}));

import { runBillingSweep } from "~/lib/billing/scheduler.server";
import { ShopifyUserError } from "~/lib/graphql/client.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const YESTERDAY = new Date("2026-08-04T06:00:00.000Z");

function dueContract(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    currencyCode: "CHF",
    intervalWeeks: 4,
    isPrepaid: false,
    originOrderId: "gid://shopify/Order/1",
    nextBillingDate: YESTERDAY,
    lines: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
  mocks.adminClientForShop.mockResolvedValue({});
  mocks.getBillingCycleByDate.mockResolvedValue({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  });
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  });
  mocks.evaluateStockoutForContract.mockResolvedValue(null);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptCount.mockResolvedValue(0);
  // First findMany call = candidate ids; second = the hydrated batch.
  mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
    const a = args as { select?: unknown } | undefined;
    return a?.select ? [{ id: "c1" }] : [dueContract()];
  });
});

describe("runBillingSweep cycle-history guard (the anti-retry-engine invariant)", () => {
  it("holds a cycle whose newest attempt FAILED — no new attempt, no new idempotency key, dunning owns it", async () => {
    // The create-throws path (or a decline + Shopify resync of
    // nextBillingDate) left the pointer parked on the unbilled failed cycle:
    // the candidate query still matches, but the FAILED row is the marker
    // that this cycle is no longer the sweep's to charge.
    mocks.attemptFindFirst.mockResolvedValue({ id: "a1", status: "FAILED" });

    const stats = await runBillingSweep(NOW);

    expect(stats.cycleHeld).toBe(1);
    expect(stats.attempted).toBe(0);
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    // The guard consults exactly this cycle's history — live rows only:
    // superseded attempts (win-back reactivation closed their churn episode,
    // migration 0013) no longer speak for the cycle.
    expect(mocks.attemptFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { contractId: "c1", cycleIndex: 7, supersededAt: null },
        orderBy: { attemptNumber: "desc" },
      }),
    );
    // Held ≠ processed: the pointer is left for webhooks/sync/dunning.
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
  });

  it("holds on ANY existing attempt for the cycle — SUCCESS with a stale pointer means webhooks own the advance", async () => {
    for (const status of ["SUCCESS", "CHALLENGED", "EXPIRED"]) {
      vi.clearAllMocks();
      mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
        const a = args as { select?: unknown } | undefined;
        return a?.select ? [{ id: "c1" }] : [dueContract()];
      });
      mocks.attemptFindFirst.mockResolvedValue({ id: "a1", status });

      const stats = await runBillingSweep(NOW);

      expect(stats.cycleHeld, `status ${status}`).toBe(1);
      expect(mocks.createBillingAttempt, `status ${status}`).not.toHaveBeenCalled();
    }
  });

  it("a fully SUPERSEDED history does not hold — the reactivated contract gets a fresh first attempt with a NEW unique key", async () => {
    // Win-back reactivation stamped the failed episode's rows with
    // supersededAt (migration 0013): the guard's live-rows query returns
    // nothing…
    mocks.attemptFindFirst.mockResolvedValue(null);
    // …but attempt NUMBERING still counts the superseded row — the fresh
    // attempt must never reuse the failed attempt's idempotency key.
    mocks.attemptCount.mockResolvedValue(1);

    const stats = await runBillingSweep(NOW);

    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: { idempotencyKey: string; attemptNumber: number };
    };
    expect(created.data.attemptNumber).toBe(2);
    expect(created.data.idempotencyKey).toBe("c1:7:2");
  });

  it("VACUITY GUARD: a cycle with no attempt history is charged exactly once, as attempt #1", async () => {
    const stats = await runBillingSweep(NOW);

    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);
    expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: { idempotencyKey: string; attemptNumber: number };
    };
    expect(created.data.attemptNumber).toBe(1);
    expect(created.data.idempotencyKey).toBe("c1:7:1");
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
    // The optimistic pointer advance still happens on the happy path.
    expect(mocks.contractUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" } }),
    );
  });

  it("create-throws leaves a FAILED marker and the next tick holds — the loop cannot spin", async () => {
    // Tick 1: Shopify REFUSES the attempt creation (invalid payment method —
    // a real userError, not a transport blip). The local row flips FAILED,
    // dunning is handed the case, and nextBillingDate is deliberately NOT
    // advanced.
    mocks.createBillingAttempt.mockRejectedValueOnce(
      new ShopifyUserError("subscriptionBillingAttemptCreate", [
        { message: "Payment method is invalid" },
      ]),
    );
    const first = await runBillingSweep(NOW);
    expect(first.attemptErrors).toBe(1);
    expect(mocks.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
    expect(mocks.onBillingAttemptFailed).toHaveBeenCalledTimes(1);
    expect(mocks.contractUpdate).not.toHaveBeenCalled(); // pointer untouched

    // Tick 2, five minutes later: the same contract is still a candidate, but
    // the FAILED row written above is exactly what the guard keys on.
    const failedRow = { id: "att_new", status: "FAILED" };
    vi.clearAllMocks();
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [dueContract()];
    });
    mocks.attemptFindFirst.mockResolvedValue(failedRow);

    const second = await runBillingSweep(new Date(NOW.getTime() + 5 * 60_000));
    expect(second.cycleHeld).toBe(1);
    expect(second.attempted).toBe(0);
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.onBillingAttemptFailed).not.toHaveBeenCalled(); // no case churn
  });
});

/**
 * THE TRANSPORT-ERROR TAXONOMY — a timeout is not a decline.
 *
 * processDueContract's catch used to treat EVERY createBillingAttempt error as
 * a payment failure: attempt FAILED with errorCode null, handed to
 * onBillingAttemptFailed → categorizeDeclineCode(null) = SOFT → dunning case
 * opens and the day-0 rung emails payment_failed_1 — a "your payment failed"
 * mail for a card that was NEVER attempted. One 30-second Shopify API hiccup
 * during the 5-minute sweep mass-emailed every contract in the batch; and when
 * the timed-out call had actually been ACCEPTED, the customer got a
 * payment-failed email AND a successful charge.
 *
 * The fix mirrors fireRetry's taxonomy (dunning engine): only a
 * ShopifyUserError — a real refusal — marks the row FAILED and enters dunning.
 * Anything else leaves the row PENDING with its idempotency key intact; the
 * next tick resumes exactly that row (b2 exception, same key, Shopify key
 * dedupe = charge-safe) and the stale sweep's 24h expiry is the backstop.
 */
describe("transient createBillingAttempt errors (transport ≠ decline)", () => {
  it("a timeout leaves the row PENDING: no FAILED flip, no dunning case, no payment-failed email path", async () => {
    mocks.createBillingAttempt.mockRejectedValueOnce(
      new Error("ETIMEDOUT: request to shopify timed out"),
    );

    const stats = await runBillingSweep(NOW);

    expect(stats.attemptErrors).toBe(1);
    expect(stats.attempted).toBe(0);
    // The row is never flipped FAILED…
    const failedFlips = mocks.attemptUpdate.mock.calls.filter((c) => {
      const data = (c[0] as { data?: Record<string, unknown> }).data ?? {};
      return data.status === "FAILED";
    });
    expect(failedFlips).toHaveLength(0);
    // …dunning never hears about it (that hand-off IS the false email)…
    expect(mocks.onBillingAttemptFailed).not.toHaveBeenCalled();
    // …the pointer is not advanced (the cycle is still unbilled)…
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    // …and no billing.attempt_failed lands on the audit log — the transient
    // is logged as a reschedule of the SAME idempotency key instead.
    const types = mocks.logEvent.mock.calls.map(
      (c) => (c[0] as { type: string }).type,
    );
    expect(types).not.toContain("billing.attempt_failed");
    const resched = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .find((e) => e.payload?.reason === "attempt_create_transient");
    expect(resched).toBeDefined();
    expect(resched?.payload).toMatchObject({
      idempotencyKey: "c1:7:1",
      rescheduled: true,
    });
  });

  it("the next tick RESUMES the un-started row: same idempotency key, no new row, no gift/discount re-run", async () => {
    // The residue tick 1 leaves behind: PENDING, never confirmed by Shopify.
    const residue = {
      id: "att_new",
      contractId: "c1",
      idempotencyKey: "c1:7:1",
      cycleIndex: 7,
      attemptNumber: 1,
      status: "PENDING",
      startedAt: null,
      shopifyAttemptId: null,
      originatingAction: "SCHEDULER",
      scheduledFor: YESTERDAY,
    };
    mocks.attemptFindFirst.mockResolvedValue(residue);

    const stats = await runBillingSweep(new Date(NOW.getTime() + 5 * 60_000));

    // The fire went out with the SAME key — Shopify's dedupe makes this safe
    // even if the timed-out original was actually accepted.
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
    const args = mocks.createBillingAttempt.mock.calls[0] as unknown[];
    expect(args[2]).toMatchObject({ idempotencyKey: "c1:7:1", cycleIndex: 7 });
    // No new local row, so no fresh idempotency key was ever minted…
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    // …and the pre-charge steps that already ran for this cycle are not
    // re-run (applyGrantToCycle consumes a grant cycle — a re-run could
    // double-apply the discount).
    expect(mocks.ensureGiftsForUpcomingCycle).not.toHaveBeenCalled();
    expect(mocks.getActiveDiscountForCycle).not.toHaveBeenCalled();
    // The resumed fire completes like any first attempt: row started,
    // pointer advanced.
    expect(stats.attempted).toBe(1);
    expect(stats.cycleHeld).toBe(0);
    expect(mocks.attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "att_new" },
        data: expect.objectContaining({
          shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
        }),
      }),
    );
    expect(mocks.contractUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1" } }),
    );
  });

  it("a dunning-owned un-started PENDING row is still HELD — the sweep never steals fireRetry's pacing", async () => {
    mocks.attemptFindFirst.mockResolvedValue({
      id: "att_dunning",
      idempotencyKey: "c1:7:2",
      cycleIndex: 7,
      attemptNumber: 2,
      status: "PENDING",
      startedAt: null,
      shopifyAttemptId: null,
      originatingAction: "DUNNING_RETRY",
      scheduledFor: YESTERDAY,
    });

    const stats = await runBillingSweep(NOW);

    expect(stats.cycleHeld).toBe(1);
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });

  it("candidate query: only a CONFIRMED in-flight attempt excludes a contract — sweep residue does not", async () => {
    await runBillingSweep(NOW);

    const firstCall = mocks.contractFindMany.mock.calls[0][0] as {
      where: { billingAttempts: unknown };
    };
    expect(firstCall.where.billingAttempts).toEqual({
      none: {
        status: "PENDING",
        OR: [
          { startedAt: { not: null } },
          { originatingAction: { not: "SCHEDULER" } },
        ],
      },
    });
  });
});
