import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Contract services behind delay semantics + Undo (v1.28.0, P2.2):
 *
 *  - delaySchedule (re-anchor): subscriptionContractSetNextBillingDate to
 *    next + N weeks (shop tz), mirror updated, cycle.delayed logged with
 *    mode "reanchor" and followingBillingDate = NEW next + one interval;
 *    dunning reconciled best-effort (contained).
 *  - delayNextCycle (once): unchanged cycle schedule edit; the event now
 *    carries mode "once" and followingBillingDate = ORIGINAL next + one
 *    interval (later orders keep their rhythm).
 *  - revertDelayedCycle: the cycle at the current next date is edited back
 *    to the given date (the exact inverse of the once-delay), mirror
 *    updated, cycle.delay_reverted logged; idempotent when already there.
 *  - changeFrequency's event stores previousNextBillingDate / nextBillingDate.
 *
 * Scaffold: aud-contracts-skip-pause-cancel.test.ts (real service, seams mocked).
 */

const NEXT = new Date("2026-09-07T22:00:00.000Z"); // Sep 8 00:00 Zurich
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: unknown[] },
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({ cycleIndex: 5, skipped: false })),
  scheduleEditBillingCycle: vi.fn(async (): Promise<unknown> => null),
  setNextBillingDate: vi.fn(async (_a: unknown, _g: string, date: Date): Promise<unknown> => ({
    contractId: CONTRACT_GID,
    nextBillingDate: date,
  })),
  getContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: new Date("2026-09-21T22:00:00.000Z") })),
  onCycleDelayed: vi.fn(async (): Promise<boolean> => false),
  // A NEW object per update (like Prisma): the service's loaded contract must
  // keep the pre-mutation values it logs as "previous".
  contractUpdate: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
    store.contract = { ...store.contract, ...args.data };
    return store.contract;
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
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
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 0, clamped: false })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async (): Promise<boolean> => false),
  onCycleDelayed: mocks.onCycleDelayed,
  onPaymentMethodUpdated: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: vi.fn(),
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(async () => ({})),
    draftUpdateDeliveryPolicy: vi.fn(async () => ({})),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getContract: mocks.getContract,
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: mocks.scheduleEditBillingCycle,
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: vi.fn(),
    withContractDraft: vi.fn(async (_admin: unknown, _gid: string, fn: (id: string, run: unknown) => Promise<void>) => {
      await fn("gid://shopify/SubscriptionDraft/1", {});
    }),
  };
});

import {
  changeFrequency,
  delayNextCycle,
  delaySchedule,
  revertDelayedCycle,
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
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    nextBillingDate: NEXT,
    lines: [],
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; source: string; actor: string | null; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer" };

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = baseContract();
  mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
  mocks.scheduleEditBillingCycle.mockResolvedValue(null);
});

describe("delaySchedule (re-anchor)", () => {
  it("sets the next billing date to next + N weeks and logs cycle.delayed{mode: reanchor} with the following date", async () => {
    const updated = await delaySchedule("cellexia.myshopify.com", "c_1", { weeks: 2 }, OPTS);
    const target = new Date("2026-09-21T22:00:00.000Z"); // +2 weeks, Zurich midnight
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith({}, CONTRACT_GID, target);
    expect(mocks.scheduleEditBillingCycle).not.toHaveBeenCalled();
    expect(updated.nextBillingDate).toEqual(target);
    const [ev] = eventsOfType("cycle.delayed");
    expect(ev.source).toBe("CUSTOMER_PORTAL");
    expect(ev.payload).toEqual({
      mode: "reanchor",
      previousNextBillingDate: NEXT.toISOString(),
      nextBillingDate: target.toISOString(),
      followingBillingDate: "2026-10-19T22:00:00.000Z", // new next + 4 weeks
      weeks: 2,
    });
    // Dunning reconciled on the moved cycle (looked up after the mutation).
    expect(mocks.onCycleDelayed).toHaveBeenCalledWith("c_1", 5, target, "CUSTOMER_PORTAL");
  });

  it("a failed dunning hook / cycle lookup never breaks the delay", async () => {
    mocks.getBillingCycleByDate.mockRejectedValueOnce(new Error("Shopify 502"));
    await expect(
      delaySchedule("cellexia.myshopify.com", "c_1", { weeks: 1 }, OPTS),
    ).resolves.toBeTruthy();
    expect(eventsOfType("cycle.delayed")).toHaveLength(1);
  });

  it("refuses a non-positive delta", async () => {
    await expect(delaySchedule("cellexia.myshopify.com", "c_1", { weeks: 0 }, OPTS)).rejects.toThrow(/positive/);
  });
});

describe("delayNextCycle (once) event", () => {
  it("logs mode 'once' and followingBillingDate = ORIGINAL next + interval", async () => {
    await delayNextCycle("cellexia.myshopify.com", "c_1", { weeks: 1 }, OPTS);
    expect(mocks.scheduleEditBillingCycle).toHaveBeenCalledWith(
      {},
      CONTRACT_GID,
      { index: 5 },
      { billingDate: new Date("2026-09-14T22:00:00.000Z") },
    );
    const [ev] = eventsOfType("cycle.delayed");
    expect(ev.payload).toMatchObject({
      mode: "once",
      cycleIndex: 5,
      previousNextBillingDate: NEXT.toISOString(),
      nextBillingDate: "2026-09-14T22:00:00.000Z",
      followingBillingDate: "2026-10-05T22:00:00.000Z", // Sep 8 + 4 weeks
      weeks: 1,
    });
  });
});

describe("revertDelayedCycle", () => {
  it("edits the cycle at the current next date back to the given date and logs cycle.delay_reverted", async () => {
    store.contract = baseContract({ nextBillingDate: new Date("2026-09-14T22:00:00.000Z") });
    const updated = await revertDelayedCycle("cellexia.myshopify.com", "c_1", NEXT, OPTS);
    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith({}, CONTRACT_GID, new Date("2026-09-14T22:00:00.000Z"));
    expect(mocks.scheduleEditBillingCycle).toHaveBeenCalledWith({}, CONTRACT_GID, { index: 5 }, { billingDate: NEXT });
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(updated.nextBillingDate).toEqual(NEXT);
    const [ev] = eventsOfType("cycle.delay_reverted");
    expect(ev.payload).toEqual({
      cycleIndex: 5,
      previousNextBillingDate: "2026-09-14T22:00:00.000Z",
      nextBillingDate: NEXT.toISOString(),
    });
    expect(mocks.onCycleDelayed).toHaveBeenCalledWith("c_1", 5, NEXT, "CUSTOMER_PORTAL");
  });

  it("is a no-op when the mirror already sits at the target date", async () => {
    await revertDelayedCycle("cellexia.myshopify.com", "c_1", NEXT, OPTS);
    expect(mocks.scheduleEditBillingCycle).not.toHaveBeenCalled();
    expect(eventsOfType("cycle.delay_reverted")).toHaveLength(0);
  });
});

describe("changeFrequency event", () => {
  it("stores the previous and the new next date alongside the cadence pair", async () => {
    await changeFrequency("cellexia.myshopify.com", "c_1", { unit: "WEEK", count: 6 }, OPTS);
    const [ev] = eventsOfType("contract.frequency_changed");
    expect(ev.payload).toMatchObject({
      oldUnit: "WEEK",
      oldCount: 4,
      newUnit: "WEEK",
      newCount: 6,
      previousNextBillingDate: NEXT.toISOString(),
      nextBillingDate: "2026-09-21T22:00:00.000Z",
    });
  });
});
