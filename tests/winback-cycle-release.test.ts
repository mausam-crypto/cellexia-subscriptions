import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WIN-BACK REACTIVATION × CYCLE-HISTORY GUARD — the reactivated-but-never-
 * billed trap.
 *
 * The billing sweep may only ever open the FIRST attempt for a cycle
 * (scheduler b2): a cycle whose newest attempt is FAILED / CHALLENGED /
 * EXPIRED is held for the dunning engine. But a win-back reactivation breaks
 * the guard's assumption that dunning will pick the cycle up: the subscriber
 * whose cycle-N renewal FAILED, who cancelled (case auto-closed CANCELLED /
 * EXHAUSTED), then tapped "Restart my subscription" or the win-back magic
 * link, comes back ACTIVE with nextBillingDate typically INSIDE cycle N's
 * still-unbilled window. Every sweep then re-resolved cycle N, found the
 * FAILED attempt, counted cycleHeld and returned; onPaymentMethodUpdated
 * only reopens EXHAUSTED cases while the contract is FAILED — so NO code
 * path ever billed again. winback.reactivated + contract.activated promised
 * an order that never shipped.
 *
 * The fix (migration 0013): reactivateFromWinback stamps the closed
 * episode's terminal attempts with `supersededAt` (only when no dunning case
 * is open), and the b2 guard ignores superseded rows — attempt numbering
 * still counts them, so the fresh first attempt gets a new unique
 * idempotency key. These tests drive the REAL reactivateFromWinback and the
 * REAL runBillingSweep over ONE shared in-memory attempt store — the exact
 * fail → cancel → reactivate → sweep strand from the finding.
 */

const EFFECTIVE_NEXT = new Date("2026-08-09T09:00:00Z");
const SWEEP_NOW = new Date("2026-08-09T11:00:00Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";

type AttemptRow = Record<string, unknown> & {
  id: string;
  contractId: string;
  cycleIndex: number;
  attemptNumber: number;
  status: string;
  supersededAt: Date | null;
};

const store = vi.hoisted(() => ({
  attempts: [] as Array<Record<string, unknown>>,
  contract: {} as Record<string, unknown>,
}));

function matches(row: Record<string, unknown>, where: Record<string, unknown>) {
  for (const [key, cond] of Object.entries(where)) {
    if (cond !== null && typeof cond === "object" && "in" in (cond as object)) {
      if (!((cond as { in: unknown[] }).in ?? []).includes(row[key])) return false;
    } else if (row[key] !== cond) {
      return false;
    }
  }
  return true;
}

const mocks = vi.hoisted(() => ({
  dunningCaseFindFirst: vi.fn(async (): Promise<unknown> => null),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  })),
  createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  })),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: EFFECTIVE_NEXT,
  })),
}));

vi.mock("~/db.server", () => {
  const client = {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          Object.assign(store.contract, args.data);
          return store.contract;
        },
      ),
      // Sweep: first call (select) = candidate ids, second = hydrated batch.
      findMany: vi.fn(async (args?: unknown): Promise<unknown[]> => {
        const a = args as { select?: unknown } | undefined;
        return a?.select ? [{ id: store.contract.id }] : [store.contract];
      }),
    },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    winbackState: {
      findUnique: vi.fn(async (): Promise<unknown> => null),
      update: vi.fn(async (args: unknown): Promise<unknown> => args),
    },
    dunningCase: { findFirst: mocks.dunningCaseFindFirst },
    billingAttempt: {
      findFirst: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<unknown> => {
          const rows = (store.attempts as AttemptRow[])
            .filter((r) => matches(r, args.where))
            .sort((a, b) => b.attemptNumber - a.attemptNumber);
          return rows[0] ?? null;
        },
      ),
      count: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<number> =>
          store.attempts.filter((r) => matches(r, args.where)).length,
      ),
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          const row = {
            id: `att_${store.attempts.length + 1}`,
            startedAt: null,
            shopifyAttemptId: null,
            supersededAt: null,
            ...args.data,
          };
          store.attempts.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<unknown> => {
          const row = store.attempts.find((r) => r.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }): Promise<{ count: number }> => {
          const hit = store.attempts.filter((r) => matches(r, args.where));
          for (const row of hit) Object.assign(row, args.data);
          return { count: hit.length };
        },
      ),
    },
    // Interactive-transaction shim: the ACTIVE mirror write + step-1b release
    // commit together in the real engine; the mock just runs the closure
    // against the same store (rollback fidelity is not what these tests pin —
    // the replay tests below cover the separated-halves crash directly).
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { default: client };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({
    reactivationBillDelayDays: 3,
    linkGraceDays: 7,
    discountPct: 15,
    discountCycles: 2,
  })),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://magic"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
}));
// Winback engine's GraphQL seam.
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: mocks.contractActivate,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  setNextBillingDate: mocks.setNextBillingDate,
}));
// Scheduler's GraphQL + engine seams.
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  createBillingAttempt: mocks.createBillingAttempt,
}));
vi.mock("~/lib/graphql/orders.server", () => ({
  getOrderSummary: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/contracts/stockout.server", () => ({
  evaluateStockoutForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
  applyGrantToCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
}));

import prisma from "~/db.server";
import { reactivateFromWinback } from "~/lib/winback/engine.server";
import { runBillingSweep } from "~/lib/billing/scheduler.server";

function failedAttempt(over: Record<string, unknown> = {}) {
  return {
    id: "att_fail",
    contractId: "c_1",
    cycleIndex: 7,
    attemptNumber: 1,
    status: "FAILED",
    idempotencyKey: "c_1:7:1",
    originatingAction: "SCHEDULER",
    startedAt: new Date("2026-07-01T00:00:00Z"),
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
    supersededAt: null,
    ...over,
  };
}

function cancelledContract() {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "CANCELLED",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    currencyCode: "CHF",
    locale: "en",
    ordersCount: 6,
    intervalWeeks: 4,
    isPrepaid: false,
    originOrderId: "gid://shopify/Order/1",
    cancelledAt: new Date("2026-08-02T00:00:00Z"),
    cancelReason: "payment_failed",
    cancelSource: "SYSTEM",
    failedAt: null,
    nextBillingDate: null,
    winbackEligibleAt: null,
    lines: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = cancelledContract();
  store.attempts = [failedAttempt()];
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: EFFECTIVE_NEXT });
  mocks.getBillingCycleByDate.mockResolvedValue({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  });
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  });
});

describe("winback reactivation releases the failed cycle back to the sweep", () => {
  it("fail cycle N → cancel → reactivate → sweep past the new date bills a fresh FIRST attempt", async () => {
    // ── Reactivate (the magic link / cancel-flow restart). ──────────────────
    await reactivateFromWinback("c_1");

    // The contract is live again with the promised near-term billing date …
    expect(store.contract.status).toBe("ACTIVE");
    expect(store.contract.nextBillingDate).toEqual(EFFECTIVE_NEXT);

    // … and the closed episode's FAILED attempt was stamped superseded —
    // history preserved (row still FAILED), guard power retired.
    const failRow = store.attempts.find((r) => r.id === "att_fail")!;
    expect(failRow.status).toBe("FAILED");
    expect(failRow.supersededAt).toBeInstanceOf(Date);

    // The release is auditable on the reactivation event.
    const reactivated = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "winback.reactivated");
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].payload).toMatchObject({ releasedFailedAttempts: 1 });

    // ── Sweep on the promised date: cycle 7 is UNBILLED and due. ────────────
    const stats = await runBillingSweep(SWEEP_NOW);

    // Before the fix: cycleHeld=1 forever, no attempt, no order, no signal.
    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);

    // A true FIRST attempt for the reactivated episode — numbering still
    // counts the superseded row, so the idempotency key is new and unique.
    const fresh = store.attempts.find((r) => r.id !== "att_fail")!;
    expect(fresh).toMatchObject({
      cycleIndex: 7,
      attemptNumber: 2,
      idempotencyKey: "c_1:7:2",
    });
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
    expect(mocks.createBillingAttempt).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      expect.objectContaining({ idempotencyKey: "c_1:7:2", cycleIndex: 7 }),
    );
  });

  it("an OPEN dunning case still owns its cycle: nothing superseded, sweep still holds", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });

    await reactivateFromWinback("c_1");

    const failRow = store.attempts.find((r) => r.id === "att_fail")!;
    expect(failRow.supersededAt).toBeNull();
    const reactivated = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "winback.reactivated");
    expect(reactivated[0].payload).toMatchObject({ releasedFailedAttempts: 0 });

    const stats = await runBillingSweep(SWEEP_NOW);
    expect(stats.cycleHeld).toBe(1);
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });

  it("PENDING rows are never superseded — an unknown charge fate must keep holding the cycle", async () => {
    // An un-started dunning retry row survived the cancel: its charge fate is
    // unknown (superseding it and minting a NEW key could double-charge), so
    // the release stamps only terminal rows and the guard keeps holding.
    store.attempts = [
      failedAttempt(),
      failedAttempt({
        id: "att_pending",
        attemptNumber: 2,
        status: "PENDING",
        idempotencyKey: "c_1:7:2",
        originatingAction: "DUNNING_RETRY",
        startedAt: null,
        shopifyAttemptId: null,
      }),
    ];

    await reactivateFromWinback("c_1");

    expect(
      store.attempts.find((r) => r.id === "att_fail")!.supersededAt,
    ).toBeInstanceOf(Date);
    expect(
      store.attempts.find((r) => r.id === "att_pending")!.supersededAt,
    ).toBeNull();

    const stats = await runBillingSweep(SWEEP_NOW);
    // The un-started DUNNING_RETRY row is not the sweep's to resume (b2
    // exception is SCHEDULER-only) — held, exactly as before this fix.
    expect(stats.cycleHeld).toBe(1);
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });
});

describe("the release is part of the idempotent replay contract (ACTIVE early-return)", () => {
  function activeCrashGapContract() {
    // The crash-gap state: the mirror already says ACTIVE (the first pass —
    // or a concurrent contract-update webhook — wrote it), but the FAILED
    // attempt was never superseded and no bookkeeping ran. Before the fix,
    // every replay settled WON_BACK and returned WITHOUT the release: the b2
    // guard held the unbilled cycle forever with no self-healing path.
    return {
      ...cancelledContract(),
      status: "ACTIVE",
      cancelledAt: null,
      cancelReason: null,
      cancelSource: null,
      nextBillingDate: EFFECTIVE_NEXT,
    };
  }

  it("a replay against an ACTIVE mirror releases the strand and the sweep bills", async () => {
    store.contract = activeCrashGapContract();

    await reactivateFromWinback("c_1");

    // The replay ran step 1b: strand released …
    const failRow = store.attempts.find((r) => r.id === "att_fail")!;
    expect(failRow.status).toBe("FAILED");
    expect(failRow.supersededAt).toBeInstanceOf(Date);
    // … without touching Shopify (replay path is local-only).
    expect(mocks.contractActivate).not.toHaveBeenCalled();
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();

    // The heal is auditable — the first pass never logged its reactivation.
    const reactivated = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
      .filter((e) => e.type === "winback.reactivated");
    expect(reactivated).toHaveLength(1);
    expect(reactivated[0].payload).toMatchObject({
      replayRelease: true,
      releasedFailedAttempts: 1,
    });

    const stats = await runBillingSweep(SWEEP_NOW);
    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);
  });

  it("a pure replay (already released) stays silent — no duplicate reactivated event", async () => {
    store.contract = activeCrashGapContract();
    store.attempts = [
      failedAttempt({ supersededAt: new Date("2026-08-08T00:00:00Z") }),
    ];

    await reactivateFromWinback("c_1");

    const reactivated = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "winback.reactivated");
    expect(reactivated).toHaveLength(0);
  });

  it("an open dunning case is respected on the replay path too", async () => {
    store.contract = activeCrashGapContract();
    mocks.dunningCaseFindFirst.mockResolvedValue({ id: "case_1" });

    await reactivateFromWinback("c_1");

    expect(
      store.attempts.find((r) => r.id === "att_fail")!.supersededAt,
    ).toBeNull();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("a release query that throws on the first pass cannot strand the state: the retried link heals", async () => {
    // The finding's exact failure: prisma.billingAttempt.updateMany throws on
    // a transient DB error AFTER the mirror flip, propagating out of
    // reactivateFromWinback. (On a real database the enclosing transaction
    // also rolls the ACTIVE write back — either residual state must heal.)
    vi.mocked(prisma.billingAttempt.updateMany).mockRejectedValueOnce(
      new Error("db blip"),
    );
    await expect(reactivateFromWinback("c_1")).rejects.toThrow("db blip");
    expect(
      store.attempts.find((r) => r.id === "att_fail")!.supersededAt,
    ).toBeNull();

    // The customer retries the magic link.
    await reactivateFromWinback("c_1");

    expect(
      store.attempts.find((r) => r.id === "att_fail")!.supersededAt,
    ).toBeInstanceOf(Date);
    const stats = await runBillingSweep(SWEEP_NOW);
    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);
  });
});
