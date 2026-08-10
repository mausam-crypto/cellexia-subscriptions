import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Service-layer collection fixes (data-collection audit, migration 0016):
 *
 *  - skipNextCycle initiators: CUSTOMER (default) keeps feeding the
 *    behavior columns (skipCount, lastSkippedAt); ADMIN/STOCKOUT count in
 *    merchantSkipCount instead — a stockout sweep or cockpit skip must not
 *    make a loyal subscriber look disengaged to the risk/win-back models.
 *    cycle.skipped always carries { initiator, reason }.
 *  - unskipNextCycle decrements the counter MATCHING the skip it reverses
 *    (read from the cycle.skipped event's initiator): an admin skip+unskip
 *    pair must not erase a customer's skipCount signal while
 *    merchantSkipCount stays overstated. cycle.unskipped carries
 *    { reversedInitiator }.
 *  - pauseContract stores pausedReason (cleared on resume) and carries the
 *    reason in contract.paused.
 *  - cancelContract with cancelSource ADMIN records a minimal CancelSession
 *    (channel ADMIN, outcome CANCELLED, the admin's reason) when no portal
 *    session is open — so admin cancels finally enter the reason histogram.
 *
 * Scaffold: addon-skip-clear.test.ts (real service module, seams mocked).
 */

const NEXT = new Date("2026-08-10T09:00:00Z");
const NEW_NEXT = new Date("2026-09-07T09:00:00Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: unknown[] },
  openCancelSession: null as Record<string, unknown> | null,
  createdCancelSessions: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 5,
    skipped: false,
  })),
  skipBillingCycle: vi.fn(async (): Promise<unknown> => ({})),
  contractPause: vi.fn(async (): Promise<unknown> => ({})),
  contractCancel: vi.fn(async (): Promise<unknown> => ({})),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  setNextBillingDate: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: NEW_NEXT,
  })),
  getContract: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: NEW_NEXT,
  })),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      Object.assign(store.contract, args.data);
      return store.contract;
    },
  ),
  cancelSessionFindFirst: vi.fn(
    async (): Promise<unknown> => store.openCancelSession,
  ),
  cancelSessionCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      const row = { id: `cs_${store.createdCancelSessions.length + 1}`, ...args.data };
      store.createdCancelSessions.push(row);
      return row;
    },
  ),
  scheduleWinback: vi.fn(async (): Promise<unknown> => ({})),
  subscriberEventFindMany: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
    },
    contractLine: {
      deleteMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    },
    cancelSession: {
      findFirst: mocks.cancelSessionFindFirst,
      create: mocks.cancelSessionCreate,
    },
    subscriberEvent: {
      findMany: mocks.subscriberEventFindMany,
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
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({ maxMonths: 3 })),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/winback/engine.server", () => ({
  scheduleWinback: mocks.scheduleWinback,
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: mocks.contractActivate,
    contractCancel: mocks.contractCancel,
    contractPause: mocks.contractPause,
    draftLineAdd: vi.fn(),
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getContract: mocks.getContract,
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: mocks.skipBillingCycle,
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: vi.fn(),
    withContractDraft: vi.fn(),
  };
});

import {
  cancelContract,
  pauseContract,
  resumeContract,
  skipNextCycle,
  unskipNextCycle,
} from "~/lib/contracts/service.server";

function baseContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    intervalWeeks: 4,
    skipCount: 0,
    nextBillingDate: NEXT,
    lines: [],
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = baseContract();
  store.openCancelSession = null;
  store.createdCancelSessions = [];
  mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
});

describe("skipNextCycle initiators", () => {
  it("default (CUSTOMER) increments skipCount and stamps lastSkippedAt", async () => {
    await skipNextCycle("cellexia.myshopify.com", "c_1");

    const data = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.data.skipCount).toEqual({ increment: 1 });
    expect(data.data.lastSkippedAt).toBeInstanceOf(Date);
    expect(data.data).not.toHaveProperty("merchantSkipCount");

    const [skipped] = eventsOfType("cycle.skipped");
    expect(skipped.payload).toMatchObject({ initiator: "CUSTOMER", reason: null });
  });

  it.each(["ADMIN", "STOCKOUT"] as const)(
    "%s increments merchantSkipCount only — no behavior-column contamination",
    async (initiator) => {
      await skipNextCycle("cellexia.myshopify.com", "c_1", {
        initiator,
        reason: "stockout_tool",
      });

      const { data } = mocks.contractUpdate.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.merchantSkipCount).toEqual({ increment: 1 });
      expect(data).not.toHaveProperty("skipCount");
      expect(data).not.toHaveProperty("lastSkippedAt");

      const [skipped] = eventsOfType("cycle.skipped");
      expect(skipped.payload).toMatchObject({
        initiator,
        reason: "stockout_tool",
      });
    },
  );
});

describe("unskipNextCycle reverses the matching counter", () => {
  const skippedCycle = {
    cycleIndex: 5,
    skipped: true,
    billingAttemptExpectedDate: NEXT,
  };
  const skipEvent = (cycleIndex: number, initiator?: string) => ({
    payload: {
      cycleIndex,
      ...(initiator ? { initiator } : {}),
      reason: null,
    },
  });

  beforeEach(() => {
    store.contract = baseContract({ skipCount: 2, merchantSkipCount: 1 });
    mocks.getBillingCycleByDate.mockResolvedValue(skippedCycle);
  });

  it("a customer skip's reversal decrements skipCount (merchant counter untouched)", async () => {
    mocks.subscriberEventFindMany.mockResolvedValue([
      skipEvent(5, "CUSTOMER"),
    ]);

    await unskipNextCycle("cellexia.myshopify.com", "c_1");

    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.skipCount).toBe(1);
    expect(data).not.toHaveProperty("merchantSkipCount");

    const [unskipped] = eventsOfType("cycle.unskipped");
    expect(unskipped.payload).toMatchObject({ reversedInitiator: "CUSTOMER" });
  });

  it.each(["ADMIN", "STOCKOUT"] as const)(
    "a %s skip's reversal decrements merchantSkipCount — the customer's skipCount signal survives",
    async (initiator) => {
      mocks.subscriberEventFindMany.mockResolvedValue([
        skipEvent(5, initiator),
      ]);

      await unskipNextCycle("cellexia.myshopify.com", "c_1");

      const { data } = mocks.contractUpdate.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(data.merchantSkipCount).toBe(0);
      expect(data).not.toHaveProperty("skipCount");

      const [unskipped] = eventsOfType("cycle.unskipped");
      expect(unskipped.payload).toMatchObject({ reversedInitiator: initiator });
    },
  );

  it("prefers the skip staged on the unskipped cycle over a newer skip of another cycle", async () => {
    // Latest event: an ADMIN skip of cycle 6; the cycle being unskipped (5)
    // was a customer skip — the customer's counter is the one to reverse.
    mocks.subscriberEventFindMany.mockResolvedValue([
      skipEvent(6, "ADMIN"),
      skipEvent(5, "CUSTOMER"),
    ]);

    await unskipNextCycle("cellexia.myshopify.com", "c_1");

    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.skipCount).toBe(1);
    expect(data).not.toHaveProperty("merchantSkipCount");
  });

  it("legacy history (no initiator on the event, or no event at all) keeps the CUSTOMER floor-at-zero behavior", async () => {
    store.contract = baseContract({ skipCount: 0, merchantSkipCount: 0 });
    mocks.subscriberEventFindMany.mockResolvedValue([skipEvent(5)]);

    await unskipNextCycle("cellexia.myshopify.com", "c_1");
    let { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.skipCount).toBe(0); // floored, never negative

    vi.clearAllMocks();
    store.contract = baseContract({ skipCount: 1, merchantSkipCount: 0 });
    mocks.getBillingCycleByDate.mockResolvedValue(skippedCycle);
    mocks.subscriberEventFindMany.mockResolvedValue([]);

    await unskipNextCycle("cellexia.myshopify.com", "c_1");
    ({ data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    });
    expect(data.skipCount).toBe(0);
  });
});

describe("pauseContract / resumeContract pausedReason", () => {
  it("stores the reason on pause and carries it in contract.paused", async () => {
    await pauseContract("cellexia.myshopify.com", "c_1", 1, {
      source: "ADMIN",
      reason: "ADMIN",
    });

    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({ status: "PAUSED", pausedReason: "ADMIN" });

    const [paused] = eventsOfType("contract.paused");
    expect(paused.payload).toMatchObject({ reason: "ADMIN" });
  });

  it("a caller without a reason records null — 'not recorded', never invented", async () => {
    await pauseContract("cellexia.myshopify.com", "c_1", 1);

    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.pausedReason).toBeNull();
    expect(eventsOfType("contract.paused")[0].payload).toMatchObject({
      reason: null,
    });
  });

  it("resume clears pausedReason with the other pause live-state", async () => {
    store.contract = baseContract({
      status: "PAUSED",
      pausedAt: new Date(),
      pausedReason: "ADMIN",
    });

    await resumeContract("cellexia.myshopify.com", "c_1");

    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({
      status: "ACTIVE",
      pausedAt: null,
      resumeAt: null,
      pausedReason: null,
    });
  });
});

describe("cancelContract — admin cancels enter the cancel funnel", () => {
  it("records a minimal ADMIN session when no portal session is open", async () => {
    await cancelContract("cellexia.myshopify.com", "c_1", "TOO_EXPENSIVE", {
      source: "ADMIN",
      cancelSource: "ADMIN",
    });

    expect(mocks.cancelSessionCreate).toHaveBeenCalledTimes(1);
    const { data } = mocks.cancelSessionCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({
      contractId: "c_1",
      channel: "ADMIN",
      reason: "TOO_EXPENSIVE",
      outcome: "CANCELLED",
    });
    expect(data.completedAt).toBeInstanceOf(Date);

    // The cancel event links to the session it minted.
    const [cancelled] = eventsOfType("contract.cancelled");
    expect(cancelled.payload).toMatchObject({
      cancelSource: "ADMIN",
      cancelSessionId: "cs_1",
    });
  });

  it("defers to an open portal session (its own flow owns the funnel verdict)", async () => {
    store.openCancelSession = { id: "cs_open" };

    await cancelContract("cellexia.myshopify.com", "c_1", "OTHER", {
      source: "ADMIN",
      cancelSource: "ADMIN",
    });

    expect(mocks.cancelSessionCreate).not.toHaveBeenCalled();
    const [cancelled] = eventsOfType("contract.cancelled");
    expect(Object.keys(cancelled.payload)).not.toContain("cancelSessionId");
  });

  it("non-ADMIN cancels never mint a session (the funnel measures cancel-intent conversations)", async () => {
    await cancelContract("cellexia.myshopify.com", "c_1", "MERGED", {
      cancelSource: "SYSTEM",
      scheduleWinback: false,
    });

    expect(mocks.cancelSessionFindFirst).not.toHaveBeenCalled();
    expect(mocks.cancelSessionCreate).not.toHaveBeenCalled();
  });

  it("session bookkeeping failure never breaks the cancel itself", async () => {
    mocks.cancelSessionCreate.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cancelContract("cellexia.myshopify.com", "c_1", "OTHER", {
      source: "ADMIN",
      cancelSource: "ADMIN",
    });

    // The mirror cancel landed and the event logged, sans session id.
    expect(store.contract.status).toBe("CANCELLED");
    const [cancelled] = eventsOfType("contract.cancelled");
    expect(Object.keys(cancelled.payload)).not.toContain("cancelSessionId");
    errSpy.mockRestore();
  });
});
