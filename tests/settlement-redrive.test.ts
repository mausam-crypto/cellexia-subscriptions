import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A DEAD RETRY TRAIN STILL HEALS — the settlement redrive sweep, evaluated.
 *
 * The webhook route answers 200 FAILED when a handler THROWS (a 5xx would get
 * the webhook subscription disabled), and any 2xx permanently ends Shopify's
 * redelivery train for that webhook id. The route's crash-residue redrive
 * (tests/webhook-receipt-redrive.test.ts) therefore only covers process DEATH
 * — a mid-tail ERROR left the attempt half-settled with NO carrier to finish
 * it:
 *
 *  - SUCCESS + settledAt NULL: the claim transaction committed but the tail
 *    (dunning close, order confirmation, events) died. The dunning case for
 *    the now-PAID cycle sat open as a zombie RETRYING case (nextRetryAt null
 *    → the sweep's phase (a) never fires and phase (c) never exhausts) while
 *    phase (b) laddered payment_failed_2/3 to a customer whose charge
 *    SUCCEEDED.
 *  - FAILED + declineCategory NULL: onBillingAttemptFailed died before its
 *    written-LAST marker; the OPEN case held the cycle via the billing
 *    sweep's guard and the subscriber silently stopped billing.
 *
 * `sweepUnsettledAttempts` (jobs registry: settlement_redrive) is the second
 * carrier: it re-drives both shapes through the SAME idempotent entry points
 * a webhook redelivery would have used. These tests drive the REAL sweep with
 * mocked seams and pin the queries (scope + age gates) and the hand-offs.
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  finishSuccessSettlement: vi.fn(async (): Promise<void> => {}),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
}));

const DUNNING_LEASE_MS = 10 * 60 * 1000;

vi.mock("~/db.server", () => {
  const stubFor = (method: string) => async () => {
    if (method === "findMany" || method === "groupBy") return [];
    if (method === "count") return 0;
    if (method.endsWith("Many")) return { count: 0 };
    if (method === "aggregate") return { _sum: {}, _count: {}, _max: {} };
    return null;
  };
  const autoModel = new Proxy(
    {},
    { get: (_t, method: string) => stubFor(method) },
  );
  const explicit: Record<string, unknown> = {
    billingAttempt: { findMany: mocks.attemptFindMany },
  };
  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );
  return { default: db };
});

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => ({})),
}));

vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
  requireShop: vi.fn(async () => ({ id: "shop_1" })),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: vi.fn(async () => {}),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));

// The scheduler's own GraphQL seams (top-level imports of the module).
vi.mock("~/lib/graphql/client.server", () => ({
  gql: vi.fn(async () => ({})),
}));
vi.mock("~/lib/graphql/orders.server", () => ({
  getOrderSummary: vi.fn(async () => ({})),
}));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  createBillingAttempt: vi.fn(async () => ({})),
  getBillingCycleByDate: vi.fn(async () => null),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  applyGrantToCycle: vi.fn(async () => ({ applied: false })),
  getActiveDiscountForCycle: vi.fn(async () => null),
}));

// The two redrive entry points the sweep hands attempts to.
vi.mock("~/lib/webhooks/handlers.server", () => ({
  finishSuccessSettlement: mocks.finishSuccessSettlement,
  consumeCycleOnSuccess: vi.fn(async () => ({ addonTitles: [] })),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  DUNNING_CLAIM_LEASE_MS: 10 * 60 * 1000,
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
  onBillingAttemptSucceeded: vi.fn(async () => {}),
  onBillingAttemptChallenged: vi.fn(async () => {}),
}));

import { sweepUnsettledAttempts } from "~/lib/billing/scheduler.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const DAY_MS = 86_400_000;
/** completedAt gate for the success arm: backdate cap (24h) + 30 min. */
const SUCCESS_MIN_AGE_MS = DAY_MS + 30 * 60_000;

type Where = Record<string, unknown>;

/** The captured where of the nth billingAttempt.findMany call. */
function whereOfCall(index: number): Where {
  const args = mocks.attemptFindMany.mock.calls[index]?.[0] as
    | { where?: Where }
    | undefined;
  return args?.where ?? {};
}

/** Answer the two arm queries by their status filter. */
function primeAttempts({
  success = [] as Array<{ id: string }>,
  failed = [] as Array<{ id: string }>,
}) {
  mocks.attemptFindMany.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: Where })?.where ?? {};
    if (where.status === "SUCCESS") return success;
    if (where.status === "FAILED") return failed;
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  });
  primeAttempts({});
});

describe("sweepUnsettledAttempts", () => {
  it("re-drives a SUCCESS + settledAt-NULL tail through finishSuccessSettlement(redrive: true)", async () => {
    primeAttempts({ success: [{ id: "a_success" }] });

    const stats = await sweepUnsettledAttempts(NOW);

    expect(mocks.finishSuccessSettlement).toHaveBeenCalledExactlyOnceWith(
      "shop_1",
      "a_success",
      { redrive: true, source: "SCHEDULER", resolvedBy: "settlement_redrive" },
    );
    expect(stats).toMatchObject({
      successRedriven: 1,
      failureRedriven: 0,
      errors: 0,
    });
  });

  it("scopes the success arm to OURS, non-demo, half-settled and PROVABLY-dead ages", async () => {
    primeAttempts({ success: [{ id: "a_success" }] });

    await sweepUnsettledAttempts(NOW);

    const where = whereOfCall(0);
    expect(where).toMatchObject({
      status: "SUCCESS",
      settledAt: null,
      contract: { shopId: "shop_1", isDemo: false, ownership: "OURS" },
    });
    // completedAt is the CHARGE instant and may be backdated by up to the
    // 24h cap — only "older than cap + 30 min" PROVES the claim transaction
    // committed over 30 minutes ago (i.e. a live webhook tail cannot still
    // be running, so the redrive can never race a first-run confirmation
    // send). The lookback floor keeps historical rows out.
    const range = (where as { completedAt: { lt: Date; gte: Date } })
      .completedAt;
    expect(range.lt.getTime()).toBe(NOW.getTime() - SUCCESS_MIN_AGE_MS);
    expect(range.gte.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it("re-drives a FAILED + declineCategory-NULL attempt through onBillingAttemptFailed", async () => {
    primeAttempts({ failed: [{ id: "a_failed" }] });

    const stats = await sweepUnsettledAttempts(NOW);

    expect(mocks.onBillingAttemptFailed).toHaveBeenCalledExactlyOnceWith(
      "a_failed",
    );
    expect(stats).toMatchObject({
      successRedriven: 0,
      failureRedriven: 1,
      errors: 0,
    });
  });

  it("gates the failure arm on the dunning claim lease and the same scope", async () => {
    primeAttempts({ failed: [{ id: "a_failed" }] });

    await sweepUnsettledAttempts(NOW);

    const where = whereOfCall(1);
    expect(where).toMatchObject({
      status: "FAILED",
      declineCategory: null,
      contract: { shopId: "shop_1", isDemo: false, ownership: "OURS" },
    });
    // Older than the engine's entry-claim lease: a LIVE onBillingAttemptFailed
    // run still holds its lease (and would refuse the sweep's claim anyway);
    // only a dead one is re-drivable.
    const range = (where as { completedAt: { lt: Date; gte: Date } })
      .completedAt;
    expect(range.lt.getTime()).toBe(NOW.getTime() - DUNNING_LEASE_MS);
    expect(range.gte.getTime()).toBe(NOW.getTime() - 7 * DAY_MS);
  });

  it("contains a throwing tail: counts the error, keeps the marker unstamped semantics, drives the rest", async () => {
    primeAttempts({
      success: [{ id: "a_broken" }, { id: "a_fine" }],
      failed: [{ id: "a_failed" }],
    });
    mocks.finishSuccessSettlement.mockRejectedValueOnce(
      new Error("tail still broken"),
    );

    const stats = await sweepUnsettledAttempts(NOW);

    // Both success rows were attempted, the failure arm still ran.
    expect(mocks.finishSuccessSettlement).toHaveBeenCalledTimes(2);
    expect(mocks.onBillingAttemptFailed).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({
      successRedriven: 1,
      failureRedriven: 1,
      errors: 1,
    });
  });

  it("skips with no shop and touches nothing", async () => {
    mocks.getPrimaryShop.mockResolvedValue(null);

    const stats = await sweepUnsettledAttempts(NOW);

    expect(stats.skipped).toBe("no_shop");
    expect(mocks.attemptFindMany).not.toHaveBeenCalled();
    expect(mocks.finishSuccessSettlement).not.toHaveBeenCalled();
    expect(mocks.onBillingAttemptFailed).not.toHaveBeenCalled();
  });
});
