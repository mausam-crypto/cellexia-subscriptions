/**
 * runDunningQueueJob CANCEL-guard tests (mocked prisma / Shopify / core) —
 * regression coverage for "after AlreadyPausedError skips the PAUSE step,
 * the scheduled CANCEL fires against a customer-paused contract":
 *
 *  - A LOST_OR_STOLEN episode whose PAUSE step hit a contract the CUSTOMER
 *    had already paused (AlreadyPausedError → deterministic skip, graceUntil
 *    never set) must NOT cancel that contract when the scheduled CANCEL
 *    comes due — the customer was promised a resume date, and the
 *    pause-resume handoff owns the episode from there. The step resolves
 *    the episode with CANCEL_SKIPPED_NON_DUNNING_PAUSE instead.
 *  - A genuine dunning grace pause (graceUntil equal to pausedUntil) still
 *    falls through to cancel — the terminal behaviour for LOST_OR_STOLEN /
 *    PERMANENT_FAILURE is preserved.
 *
 * The DunningState row is a stateful in-memory mock honouring the job's
 * optimistic-concurrency contract (updateMany guarded on phase + updatedAt),
 * so the two queue passes exercise the real scheduling arithmetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  dunningState: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  subscriptionContract: { findUnique: vi.fn(), findMany: vi.fn() },
  billingAttempt: { findFirst: vi.fn() },
  shopSettings: { findUnique: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

// Stateful withIdempotency stand-in with release-on-error (production
// contract): a throwing step releases its key so the next pass can retry.
const idem = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock("~/services/idempotency.server", () => ({
  withIdempotency: vi.fn(
    async (key: string, _scope: string, fn: () => Promise<unknown>) => {
      if (idem.store.has(key)) {
        return { result: idem.store.get(key), replayed: true };
      }
      try {
        const result = await fn();
        idem.store.set(key, result);
        return { result, replayed: false };
      } catch (e) {
        idem.store.delete(key);
        throw e;
      }
    },
  ),
}));

const shopifyClient = vi.hoisted(() => {
  class ShopifyGraphqlError extends Error {
    constructor(
      message: string,
      public readonly errors: unknown,
      public readonly userErrors?: Array<{ field?: string[]; message: string }>,
    ) {
      super(message);
      this.name = "ShopifyGraphqlError";
    }
  }
  return {
    ShopifyGraphqlError,
    getOfflineAdmin: vi.fn(async () => ({ graphql: { __tag: "graphql" } })),
  };
});
vi.mock("~/services/core/shopifyClient.server", () => shopifyClient);

const core = vi.hoisted(() => {
  class AlreadyPausedError extends Error {
    constructor(message = "already paused") {
      super(message);
      this.name = "AlreadyPausedError";
    }
  }
  return {
    AlreadyPausedError,
    cancelContract: vi.fn(),
    pauseUntil: vi.fn(),
    sendPaymentUpdateEmail: vi.fn(),
  };
});
vi.mock("~/services/core/contracts.server", () => core);

vi.mock("~/services/core/billing.server", () => ({
  createBillingAttempt: vi.fn(),
}));

vi.mock("~/services/analytics/learning.server", () => ({
  getLearnedDunningOffsets: vi.fn(async () => null),
}));

import {
  runDunningQueueJob,
  strategyFor,
} from "~/services/retention/dunning.server";
import type { DunningHistoryEntry } from "~/services/retention/dunning.server";

const SHOP = "cellexia-demo.myshopify.com";
const T0 = new Date("2026-08-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = ["RETRYING", "GRACE", "FINAL_NOTICE"];

// LOST_OR_STOLEN: EMAIL@0, SMS@2, EMAIL@7, PAUSE@10, CANCEL@40 (cumulative).
const LOST_STEPS = strategyFor("LOST_OR_STOLEN", false);

interface StateRow {
  id: string;
  contractId: string;
  phase: string;
  declineCategory: string;
  retryCount: number;
  nextRetryAt: Date | null;
  lastFailureAt: Date | null;
  graceUntil: Date | null;
  historyJson: string;
  updatedAt: Date;
}

let stateRow: StateRow;
let contractRow: Record<string, unknown>;

/** History: EPISODE_START (pinned steps) + the first `executed` STEP entries. */
function seedHistory(executed: number): string {
  const entries: DunningHistoryEntry[] = [
    {
      at: T0.toISOString(),
      type: "EPISODE_START",
      errorCode: "stolen_card",
      declineCategory: "LOST_OR_STOLEN",
      steps: LOST_STEPS,
    },
  ];
  for (let i = 0; i < executed; i++) {
    entries.push({
      at: T0.toISOString(),
      type: "STEP",
      stepIndex: i,
      action: LOST_STEPS[i].action,
      template: LOST_STEPS[i].template,
    });
  }
  return JSON.stringify(entries);
}

function history(): DunningHistoryEntry[] {
  return JSON.parse(stateRow.historyJson) as DunningHistoryEntry[];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  idem.store.clear();

  contractRow = {
    id: "c1",
    shop: SHOP,
    shopifyContractId: "gid://shopify/SubscriptionContract/77",
    shopifyCustomerId: "gid://shopify/Customer/9",
    customerEmail: "marie@example.com",
    status: "PAUSED",
    // Customer-initiated 60-day portal pause during the live episode.
    pausedUntil: new Date(T0.getTime() + 60 * DAY_MS),
    totalRevenueCents: 0,
    expectedLtvCents: null,
    successfulOrders: 2,
  };
  stateRow = {
    id: "ds1",
    contractId: "c1",
    phase: "RETRYING",
    declineCategory: "LOST_OR_STOLEN",
    retryCount: 0,
    nextRetryAt: new Date(T0.getTime() - 60 * 60 * 1000), // due now
    lastFailureAt: new Date(T0.getTime() - 10 * DAY_MS),
    graceUntil: null, // dunning never created a pause
    historyJson: seedHistory(3), // next step: idx 3 = PAUSE
    updatedAt: new Date(T0.getTime() - 60 * 60 * 1000),
  };

  db.dunningState.findMany.mockImplementation(async () => {
    const now = new Date();
    return ACTIVE.includes(stateRow.phase) &&
      stateRow.nextRetryAt != null &&
      stateRow.nextRetryAt.getTime() <= now.getTime()
      ? [{ ...stateRow, contract: { ...contractRow } }]
      : [];
  });
  db.dunningState.findUnique.mockImplementation(async () => ({ ...stateRow }));
  db.dunningState.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      if (where.id !== undefined && where.id !== stateRow.id) {
        return { count: 0 };
      }
      const phaseIn = (where.phase as { in?: string[] } | undefined)?.in;
      if (phaseIn && !phaseIn.includes(stateRow.phase)) return { count: 0 };
      if (
        where.updatedAt instanceof Date &&
        where.updatedAt.getTime() !== stateRow.updatedAt.getTime()
      ) {
        return { count: 0 };
      }
      Object.assign(stateRow, data);
      stateRow.updatedAt = new Date();
      return { count: 1 };
    },
  );
  db.subscriptionContract.findUnique.mockImplementation(async () => ({
    ...contractRow,
  }));
  db.billingAttempt.findFirst.mockResolvedValue(null);
  db.shopSettings.findUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runDunningQueueJob — CANCEL never fires against a pause dunning did not create", () => {
  it("REGRESSION: customer-paused contract survives the skipped-PAUSE → CANCEL schedule; episode resolves", async () => {
    // Day 10 (relative): the PAUSE step hits the customer's own pause.
    core.pauseUntil.mockRejectedValue(new core.AlreadyPausedError());

    const first = await runDunningQueueJob(SHOP);

    // Deterministic skip: recorded as executed-with-failure, CANCEL
    // scheduled 30 days out, graceUntil still null.
    expect(first.processed).toBe(1);
    expect(core.pauseUntil).toHaveBeenCalledTimes(1);
    expect(stateRow.phase).toBe("RETRYING");
    expect(stateRow.graceUntil).toBeNull();
    expect(stateRow.nextRetryAt?.getTime()).toBe(T0.getTime() + 30 * DAY_MS);
    expect(
      history().some((h) => h.note?.startsWith("STEP_FAILED_SKIPPED")),
    ).toBe(true);

    // Day 40: the CANCEL step comes due against the still-paused contract.
    vi.setSystemTime(new Date(T0.getTime() + 31 * DAY_MS));
    const second = await runDunningQueueJob(SHOP);

    expect(second.processed).toBe(1);
    // OLD BUG: cancelContract ran here with reason PAYMENT_FAILURE while the
    // customer was promised resumption on day 60.
    expect(core.cancelContract).not.toHaveBeenCalled();
    expect(stateRow.phase).toBe("RESOLVED");
    expect(stateRow.nextRetryAt).toBeNull();
    expect(
      history().some(
        (h) =>
          h.type === "RESOLVED" && h.note === "CANCEL_SKIPPED_NON_DUNNING_PAUSE",
      ),
    ).toBe(true);
    expect(audit.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DUNNING_STEP_EXECUTED",
        payload: expect.objectContaining({
          skipped: "NON_DUNNING_PAUSE",
          phase: "RESOLVED",
        }),
      }),
    );

    // Resolved episodes leave the queue: a third pass processes nothing.
    vi.setSystemTime(new Date(T0.getTime() + 32 * DAY_MS));
    const third = await runDunningQueueJob(SHOP);
    expect(third.processed).toBe(0);
  });

  it("a genuine dunning grace pause (graceUntil == pausedUntil) still falls through to CANCEL", async () => {
    // The PAUSE step succeeded on day 10: graceUntil === pausedUntil, the
    // pause never resumed, and the terminal CANCEL is due.
    const graceDate = new Date(T0.getTime() + 30 * DAY_MS);
    contractRow.pausedUntil = graceDate;
    stateRow.phase = "GRACE";
    stateRow.graceUntil = graceDate;
    stateRow.historyJson = seedHistory(4); // next step: idx 4 = CANCEL
    core.cancelContract.mockResolvedValue({ id: "c1" });

    const result = await runDunningQueueJob(SHOP);

    expect(result.executed).toBe(1);
    expect(core.cancelContract).toHaveBeenCalledWith(
      expect.anything(),
      SHOP,
      "c1",
      "PAYMENT_FAILURE",
      "SYSTEM",
      { emitEvent: false },
    );
    expect(stateRow.phase).toBe("EXHAUSTED");
  });
});
