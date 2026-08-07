import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADMIN RESUME × CYCLE-HISTORY GUARD — the reactivated-but-never-billed trap,
 * round two: the entry point migration 0013's win-back fix did NOT cover.
 *
 * The admin subscriber page renders "Resume" for FAILED contracts (dunning
 * exhausted with exhaustedAction=PAUSE). resumeContract reactivates on
 * Shopify and parks nextBillingDate = now+3d — typically INSIDE the failed
 * cycle's still-unbilled window. The dunning case is EXHAUSTED (closed) and
 * can only be reopened by onPaymentMethodUpdated while the contract is still
 * FAILED — resumed, it is ACTIVE, so nothing ever reopens it. Without the
 * shared release (releaseHeldCycleAttempts), every billing sweep re-resolves
 * the cycle, finds the terminal FAILED/EXPIRED attempt at the b2 guard,
 * counts cycleHeld and returns: the admin was told "next charge in ~3 days",
 * the customer is never billed and never shipped.
 *
 * These tests drive the REAL resumeContract and the REAL runBillingSweep over
 * one shared in-memory attempt store — the exact fail → exhaust(PAUSE) →
 * admin Resume → sweep strand from the finding.
 */

const EFFECTIVE_NEXT = new Date("2026-08-09T09:00:00Z");
const SWEEP_NOW = new Date("2026-08-09T11:00:00Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/901";

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
    attemptId: "gid://shopify/SubscriptionBillingAttempt/901",
    ready: true,
  })),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: EFFECTIVE_NEXT,
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
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
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
// The contract-services GraphQL seam (only the resume path is exercised, but
// the module's full import surface must exist).
vi.mock("~/lib/graphql/index.server", () => ({
  ShopifyUserError: class ShopifyUserError extends Error {},
  contractActivate: mocks.contractActivate,
  contractCancel: vi.fn(),
  contractPause: vi.fn(),
  draftLineAdd: vi.fn(),
  draftLineRemove: vi.fn(),
  draftLineUpdate: vi.fn(),
  draftUpdateAddress: vi.fn(),
  draftUpdateBillingPolicy: vi.fn(),
  draftUpdateDeliveryPolicy: vi.fn(),
  draftUpdatePaymentMethod: vi.fn(),
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  getContract: vi.fn(),
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
  scheduleEditBillingCycle: vi.fn(),
  setNextBillingDate: mocks.setNextBillingDate,
  skipBillingCycle: vi.fn(),
  unskipBillingCycle: vi.fn(),
  withBillingCycleEdit: vi.fn(),
  withContractDraft: vi.fn(),
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

import { resumeContract } from "~/lib/contracts/service.server";
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

function failedContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "FAILED",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    currencyCode: "CHF",
    locale: "en",
    ordersCount: 6,
    intervalWeeks: 4,
    isPrepaid: false,
    originOrderId: "gid://shopify/Order/1",
    cancelledAt: null,
    cancelReason: null,
    cancelSource: null,
    failedAt: new Date("2026-08-02T00:00:00Z"),
    pausedAt: null,
    resumeAt: null,
    nextBillingDate: new Date("2026-07-01T00:00:00Z"),
    winbackEligibleAt: null,
    lines: [],
    ...over,
  };
}

function resumedEvents() {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === "contract.resumed");
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = failedContract();
  store.attempts = [failedAttempt()];
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.setNextBillingDate.mockResolvedValue({ nextBillingDate: EFFECTIVE_NEXT });
  mocks.getBillingCycleByDate.mockResolvedValue({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  });
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/901",
    ready: true,
  });
});

describe("admin Resume of a FAILED contract releases the failed cycle", () => {
  it("fail → exhaust(PAUSE) → Resume → sweep bills a fresh FIRST attempt", async () => {
    // ── The admin clicks Resume on the FAILED subscriber. ───────────────────
    await resumeContract("cellexia.myshopify.com", "c_1", {
      source: "ADMIN",
      actor: "admin",
    });

    // The contract is live again with the promised near-term billing date,
    // and failedAt is cleared — LIVE-STATE, like the cancel columns.
    expect(store.contract.status).toBe("ACTIVE");
    expect(store.contract.nextBillingDate).toEqual(EFFECTIVE_NEXT);
    expect(store.contract.failedAt).toBeNull();
    expect(mocks.contractActivate).toHaveBeenCalledTimes(1);

    // The closed episode's FAILED attempt was stamped superseded — history
    // preserved (row still FAILED), guard power retired.
    const failRow = store.attempts.find((r) => r.id === "att_fail")!;
    expect(failRow.status).toBe("FAILED");
    expect(failRow.supersededAt).toBeInstanceOf(Date);

    // The release is auditable on the resume event.
    const events = resumedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      resumedFrom: "FAILED",
      releasedFailedAttempts: 1,
    });

    // ── Sweep on the promised date: cycle 7 is UNBILLED and due. ────────────
    const stats = await runBillingSweep(SWEEP_NOW);

    // Before the fix: cycleHeld=1 forever, no attempt, no order, no signal —
    // while the admin log said "next charge in ~3 days".
    expect(stats.cycleHeld).toBe(0);
    expect(stats.attempted).toBe(1);

    // A true FIRST attempt for the resumed episode — numbering still counts
    // the superseded row, so the idempotency key is new and unique.
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

    await resumeContract("cellexia.myshopify.com", "c_1");

    expect(store.contract.status).toBe("ACTIVE");
    const failRow = store.attempts.find((r) => r.id === "att_fail")!;
    expect(failRow.supersededAt).toBeNull();
    expect(resumedEvents()[0].payload).toMatchObject({
      resumedFrom: "FAILED",
      releasedFailedAttempts: 0,
    });

    const stats = await runBillingSweep(SWEEP_NOW);
    expect(stats.cycleHeld).toBe(1);
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });

  it("a PAUSED resume never touches attempt history (no failed episode to close)", async () => {
    store.contract = failedContract({
      status: "PAUSED",
      failedAt: null,
      pausedAt: new Date("2026-07-15T00:00:00Z"),
      resumeAt: new Date("2026-09-15T00:00:00Z"),
    });
    // A stale terminal attempt from an OLD, still-owned episode must keep its
    // guard power on a plain pause/resume — only FAILED resumes release.
    await resumeContract("cellexia.myshopify.com", "c_1");

    expect(store.contract.status).toBe("ACTIVE");
    expect(store.contract.pausedAt).toBeNull();
    expect(store.contract.resumeAt).toBeNull();
    expect(
      store.attempts.find((r) => r.id === "att_fail")!.supersededAt,
    ).toBeNull();
    expect(mocks.dunningCaseFindFirst).not.toHaveBeenCalled();
    const events = resumedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).not.toHaveProperty("resumedFrom");
    expect(events[0].payload).not.toHaveProperty("releasedFailedAttempts");
  });
});
