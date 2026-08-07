import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnalyticsDb,
  emptyStore,
  type AnalyticsStore,
  type Row,
} from "./helpers/analytics-db";

/**
 * Per-cycle DiscountGrant consumption — the save-offer promise.
 *
 * A cancel-flow save grants N discounted cycles; the billing sweep applies the
 * grant one cycle at a time (applyGrantToCycle) and marks each application
 * with a "contract.updated / cycle_discount_applied" event that doubles as the
 * idempotency key (grantAppliedToCycle). This file pins the crash-safety of
 * that consume:
 *
 *  - the decrement and the applied-marker commit in ONE transaction, AFTER the
 *    Shopify cycle edit — the three-write shape this replaced (edit →
 *    decrement → marker, marker LAST) had a crash window in which the sweep's
 *    next tick found no marker, re-ran the step and decremented AGAIN,
 *    silently halving the cycles the customer accepted to stay subscribed;
 *  - the decrement is a compare-and-swap on the cyclesRemaining read at sweep
 *    start, so a replayed/concurrent application of the SAME cycle consumes
 *    nothing and writes no second marker;
 *  - the sweep-visible outcome: a 2-cycle grant delivers exactly 2 discounted
 *    cycles even with a duplicate tick in between;
 *  - re-application lands on the same ABSOLUTE price (computed from the
 *    mirror's currentPriceCents), never a compounded one;
 *  - getActiveDiscountForCycle's selection rules (no stacking: highest percent
 *    wins, oldest first on ties; applied cycles are skipped).
 */

const dbHolder = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => ({
  withBillingCycleEdit: vi.fn(),
  draftLineUpdate: vi.fn(
    async (..._args: unknown[]): Promise<string | null> => "line_gid",
  ),
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

vi.mock("~/lib/graphql/billingCycles.server", () => ({
  withBillingCycleEdit: mocks.withBillingCycleEdit,
}));

vi.mock("~/lib/graphql/contracts.server", () => ({
  draftLineUpdate: mocks.draftLineUpdate,
}));

import type { AdminClient } from "~/lib/graphql/client.server";
import {
  applyGrantToCycle,
  getActiveDiscountForCycle,
  type ContractWithLines,
} from "~/lib/billing/discounts.server";

// ── Fixture ──────────────────────────────────────────────────────────────────

const SHOP = { id: "shop_1", domain: "cellexia.myshopify.com" };
const ADMIN = {} as AdminClient;
const RUN_TOKEN = { run: true };

function D(iso: string): Date {
  return new Date(iso);
}

/** Serum 4990 (eligible) + a gift line + a not-yet-synced line (no GID). */
const LINES: Row[] = [
  {
    id: "l1",
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    currentPriceCents: 4990,
    quantity: 1,
    isGift: false,
  },
  {
    id: "l_gift",
    shopifyLineId: "gid://shopify/SubscriptionLine/2",
    currentPriceCents: 0,
    quantity: 1,
    isGift: true, // gifts are never discounted (they are already free)
  },
  {
    id: "l_unsynced",
    shopifyLineId: null, // no Shopify GID yet — cannot be edited
    currentPriceCents: 1500,
    quantity: 2,
    isGift: false,
  },
];

const CONTRACT = {
  id: "c1",
  shopId: SHOP.id,
  shopifyContractId: "gid://shopify/SubscriptionContract/11",
  customerId: "gid://shopify/Customer/7",
  email: "sub@example.com",
  lines: LINES,
} as unknown as ContractWithLines;

/** 20% for 2 cycles — the cancel-flow save offer of the incident report. */
function saveOfferGrant(over: Row = {}): Row {
  return {
    id: "g1",
    contractId: "c1",
    type: "SAVE_OFFER",
    percent: 20,
    cyclesTotal: 2,
    cyclesRemaining: 2,
    grantedBy: "cancel_flow",
    reason: null,
    createdAt: D("2026-07-01T10:00:00Z"),
    exhaustedAt: null,
    ...over,
  };
}

interface Instrumented {
  store: AnalyticsStore;
  /** Ordered trace of the writes that matter: edit / consume / marker. */
  trace: string[];
  /** Whether each traced write ran inside the $transaction callback. */
  inTxAt: Record<string, boolean>;
}

/**
 * Fake prisma over a mutable store, instrumented to record WHERE the grant
 * decrement and the marker create happen relative to the Shopify edit and the
 * $transaction boundary — the whole point of the fix is that ordering.
 */
function instrumentedDb(grants: Row[], events: Row[] = []): Instrumented {
  const store = emptyStore();
  store.discountGrants.push(...grants);
  store.subscriberEvents.push(...events);
  const client = createAnalyticsDb(store) as unknown as Record<string, unknown>;
  const trace: string[] = [];
  const inTxAt: Record<string, boolean> = {};
  let inTx = false;

  const grantTable = client.discountGrant as { updateMany: (a: unknown) => unknown };
  const eventTable = client.subscriberEvent as { create: (a: unknown) => unknown };
  const rawGrantUpdateMany = grantTable.updateMany.bind(grantTable);
  const rawEventCreate = eventTable.create.bind(eventTable);
  grantTable.updateMany = (args: unknown) => {
    trace.push("consume");
    inTxAt.consume = inTx;
    return rawGrantUpdateMany(args);
  };
  eventTable.create = (args: unknown) => {
    trace.push("marker");
    inTxAt.marker = inTx;
    return rawEventCreate(args);
  };
  client.$transaction = async (ops: unknown) => {
    if (Array.isArray(ops)) return Promise.all(ops);
    inTx = true;
    try {
      return await (ops as (c: unknown) => unknown)(client);
    } finally {
      inTx = false;
    }
  };

  mocks.withBillingCycleEdit.mockImplementation(
    async (
      _admin: unknown,
      _gid: string,
      _selector: unknown,
      ops: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      trace.push("edit");
      inTxAt.edit = inTx;
      await ops("draft_1", RUN_TOKEN);
      return { contractId: "gid://shopify/SubscriptionContract/11" };
    },
  );

  dbHolder.current = client;
  return { store, trace, inTxAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.current = null;
});

// ── applyGrantToCycle ────────────────────────────────────────────────────────

describe("applyGrantToCycle", () => {
  it("edits every eligible line to the ABSOLUTE discounted price and consumes one cycle", async () => {
    const grant = saveOfferGrant();
    const { store } = instrumentedDb([grant]);

    const applied = await applyGrantToCycle(
      ADMIN, SHOP, CONTRACT, grant as never, 7,
    );
    expect(applied).toBe(true);

    // Only the eligible line is edited: gifts and GID-less lines never are.
    expect(mocks.draftLineUpdate.mock.calls).toEqual([
      [RUN_TOKEN, "draft_1", "gid://shopify/SubscriptionLine/1",
        { currentPriceCents: 3992 }], // 4990 − 20% — absolute, from the mirror
    ]);

    // One cycle consumed, not exhausted.
    expect(store.discountGrants[0]).toMatchObject({
      cyclesRemaining: 1,
      exhaustedAt: null,
    });

    // The applied marker carries the full vocabulary payload.
    expect(store.subscriberEvents).toHaveLength(1);
    expect(store.subscriberEvents[0]).toMatchObject({
      shopId: SHOP.id,
      contractId: "c1",
      customerId: "gid://shopify/Customer/7",
      email: "sub@example.com",
      type: "contract.updated",
      source: "SCHEDULER",
      actor: "system",
      payload: {
        action: "cycle_discount_applied",
        grantId: "g1",
        grantType: "SAVE_OFFER",
        percent: 20,
        cycleIndex: 7,
        discountCents: 998, // discountAmount(4990, 20) × qty 1
        cyclesRemaining: 1,
      },
    });
  });

  it("commits the decrement and the marker in ONE transaction, AFTER the Shopify edit", async () => {
    // The crash-safety contract: a death before the transaction leaves the
    // grant untouched and no marker (the next tick re-edits to the same
    // absolute price and consumes once); a death after leaves both durable
    // (the next tick's marker check skips the cycle). The pre-fix shape —
    // marker LAST as a separate write — let a crash decrement WITHOUT the
    // marker, and the retry decremented again: the save offer was halved.
    const grant = saveOfferGrant();
    const { trace, inTxAt } = instrumentedDb([grant]);

    await applyGrantToCycle(ADMIN, SHOP, CONTRACT, grant as never, 7);

    expect(trace).toEqual(["edit", "consume", "marker"]);
    expect(inTxAt.edit).toBe(false); // external call — never inside the tx
    expect(inTxAt.consume).toBe(true);
    expect(inTxAt.marker).toBe(true);
  });

  it("a replayed application with a stale grant snapshot consumes NOTHING (CAS)", async () => {
    // The duplicate-tick interleave: both ticks read the grant at
    // cyclesRemaining=2 before either committed. The winner consumes 2→1;
    // the loser's compare-and-swap (WHERE cyclesRemaining = 2) matches no
    // row — no second decrement, no second marker.
    const grant = saveOfferGrant();
    const { store } = instrumentedDb([grant]);

    const staleSnapshot = { ...grant }; // cyclesRemaining still 2 in memory
    expect(await applyGrantToCycle(ADMIN, SHOP, CONTRACT, grant as never, 7)).toBe(true);
    expect(await applyGrantToCycle(ADMIN, SHOP, CONTRACT, staleSnapshot as never, 7)).toBe(true);

    expect(store.discountGrants[0]).toMatchObject({
      cyclesRemaining: 1, // consumed ONCE — never 0
      exhaustedAt: null,
    });
    expect(store.subscriberEvents).toHaveLength(1);
    // And the replayed edit landed on the same absolute price — no compounding.
    for (const call of mocks.draftLineUpdate.mock.calls) {
      expect(call[3]).toEqual({ currentPriceCents: 3992 });
    }
  });

  it("consuming the final cycle stamps exhaustedAt", async () => {
    const grant = saveOfferGrant({ cyclesRemaining: 1 });
    const { store } = instrumentedDb([grant]);

    await applyGrantToCycle(ADMIN, SHOP, CONTRACT, grant as never, 8);

    expect(store.discountGrants[0].cyclesRemaining).toBe(0);
    expect(store.discountGrants[0].exhaustedAt).toBeInstanceOf(Date);
    expect(
      (store.subscriberEvents[0].payload as Row).cyclesRemaining,
    ).toBe(0);
  });

  it("no eligible lines → no Shopify edit, no consume, no marker, returns false", async () => {
    const grant = saveOfferGrant();
    const { store } = instrumentedDb([grant]);
    const giftOnly = {
      ...(CONTRACT as unknown as Row),
      lines: [LINES[1], LINES[2]], // gift + GID-less
    } as unknown as ContractWithLines;

    expect(await applyGrantToCycle(ADMIN, SHOP, giftOnly, grant as never, 7)).toBe(false);
    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(store.discountGrants[0].cyclesRemaining).toBe(2);
    expect(store.subscriberEvents).toHaveLength(0);
  });

  it("a 2-cycle save offer delivers EXACTLY 2 discounted cycles across sweep ticks with a duplicate in between", async () => {
    // The broken promise of the incident report, end to end: cancel-flow save
    // grants 20% for 2 cycles. Sweep applies cycle 7; a replayed tick re-runs
    // cycle 7 (stale snapshot); the next cycles 8 and 9 follow with fresh
    // reads, exactly as the scheduler does.
    const grant = saveOfferGrant();
    const { store } = instrumentedDb([grant]);

    const cycle7 = await getActiveDiscountForCycle("c1", 7);
    expect(cycle7).toMatchObject({ id: "g1", cyclesRemaining: 2 });
    await applyGrantToCycle(ADMIN, SHOP, CONTRACT, cycle7 as never, 7);

    // Replayed tick for cycle 7: the marker makes the sweep skip it entirely.
    expect(await getActiveDiscountForCycle("c1", 7)).toBeNull();
    // …and even a raw stale re-application could not consume (pinned above).

    const cycle8 = await getActiveDiscountForCycle("c1", 8);
    expect(cycle8).toMatchObject({ id: "g1", cyclesRemaining: 1 });
    await applyGrantToCycle(ADMIN, SHOP, CONTRACT, cycle8 as never, 8);

    // Both promised cycles delivered; the grant is spent — cycle 9 gets none.
    expect(await getActiveDiscountForCycle("c1", 9)).toBeNull();
    expect(store.discountGrants[0]).toMatchObject({ cyclesRemaining: 0 });
    expect(store.discountGrants[0].exhaustedAt).toBeInstanceOf(Date);
    const appliedCycles = store.subscriberEvents.map(
      (e) => (e.payload as Row).cycleIndex,
    );
    expect(appliedCycles).toEqual([7, 8]);
  });
});

// ── getActiveDiscountForCycle selection rules ────────────────────────────────

describe("getActiveDiscountForCycle", () => {
  it("grants never stack: highest percent wins, oldest first on ties; dead grants excluded", async () => {
    instrumentedDb([
      saveOfferGrant({ id: "g_small", percent: 10, createdAt: D("2026-05-01T00:00:00Z") }),
      saveOfferGrant({ id: "g_best_newer", percent: 20, createdAt: D("2026-07-02T00:00:00Z") }),
      saveOfferGrant({ id: "g_best_older", percent: 20, createdAt: D("2026-07-01T00:00:00Z") }),
      saveOfferGrant({ id: "g_spent", percent: 90, cyclesRemaining: 0 }),
      saveOfferGrant({
        id: "g_exhausted", percent: 95,
        exhaustedAt: D("2026-07-15T00:00:00Z"),
      }),
      saveOfferGrant({ id: "g_zero_pct", percent: 0 }),
    ]);
    const best = await getActiveDiscountForCycle("c1");
    expect(best).toMatchObject({ id: "g_best_older", percent: 20 });
  });

  it("returns null when no live grant exists", async () => {
    instrumentedDb([]);
    expect(await getActiveDiscountForCycle("c1", 4)).toBeNull();
  });
});
