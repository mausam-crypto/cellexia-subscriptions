import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * OPERATOR VISIBILITY FOR SILENT DATA LOSS — the two v1.9 alert checks and
 * the availability history, evaluated through the REAL runAlertScan.
 *
 *  - EVENT_WRITE_FAILURES: logEvent swallows SubscriberEvent insert failures
 *    by contract; the in-process counter (events/log.server.ts) is the only
 *    evidence. The check must raise on new loss, stay silent when nothing new
 *    was lost, and treat a process restart (counter reset) as loss, never as
 *    recovery.
 *  - ATTEMPT_AMOUNT_MISSING: a SUCCESS attempt that finished settlement with
 *    amountCents NULL is money collected that analytics cannot see — and the
 *    one shape the settlement redrive cannot fix (the attempt looks settled).
 *  - AvailabilitySnapshot: the 15-minute variant feed was ephemeral — each
 *    scan overwrote the last one's knowledge. One row per shop-day now keeps
 *    the UNION of out-of-stock observations, written before alert logic and
 *    contained (a snapshot failure only costs history, never the scan).
 */

const mocks = vi.hoisted(() => ({
  attemptFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  alertCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "alert_1",
      ...args.data,
    }),
  ),
  alertFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  snapshotFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  snapshotUpsert: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  logEvent: vi.fn(async (): Promise<void> => {}),
  eventStats: {
    value: {
      count: 0,
      lastAt: null as Date | null,
      lastType: null as string | null,
      processStartedAt: "2026-08-01T00:00:00.000Z",
    },
  },
}));

vi.mock("~/db.server", () => {
  // Every check runAlertScan fires other than the ones under test gets silent
  // all-clear answers from the auto-stub, so the scan runs end to end and the
  // assertions stay about the new checks.
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
    // count answers the FAILURE_SPIKE / FAST_SHIPPING checks all-clear; only
    // findMany is under test here.
    billingAttempt: { findMany: mocks.attemptFindMany, count: async () => 0 },
    alert: { create: mocks.alertCreate, findFirst: mocks.alertFindFirst },
    availabilitySnapshot: {
      findUnique: mocks.snapshotFindUnique,
      upsert: mocks.snapshotUpsert,
    },
  };
  let db: unknown;
  db = new Proxy(
    {},
    {
      get: (_t, model: string) => {
        if (model === "$transaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
        }
        if (model === "$queryRaw") return async () => [];
        return model in explicit ? explicit[model] : autoModel;
      },
    },
  );
  return { default: db };
});

vi.mock("~/lib/analytics/queries.server", () => ({
  COUNTABLE_CONTRACT: { isDemo: false, ownership: "OURS" },
  requireShopById: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  // Pure label helper; at the 09:00Z test instant the Zurich day equals the
  // UTC day, so the UTC slice is the correct label.
  shopDayLabelUtc: vi.fn(
    (date: Date) => new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`),
  ),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({
    stuckContractHours: 24,
    failureSpikeThresholdPct: 100,
    churnSpikeThresholdPct: 100,
    emailTo: [],
  })),
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  getEventWriteFailureStats: vi.fn(() => ({ ...mocks.eventStats.value })),
}));

import { runAlertScan } from "~/lib/analytics/alerts.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");
const DAY_LABEL = new Date("2026-08-05T00:00:00.000Z");

function raisedOfType(type: string): Record<string, unknown> | undefined {
  return mocks.alertCreate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => d.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.attemptFindMany.mockResolvedValue([]);
  mocks.alertFindFirst.mockResolvedValue(null);
  mocks.snapshotFindUnique.mockResolvedValue(null);
  mocks.snapshotUpsert.mockResolvedValue({});
  mocks.eventStats.value = {
    count: 0,
    lastAt: null,
    lastType: null,
    processStartedAt: "2026-08-01T00:00:00.000Z",
  };
});

describe("EVENT_WRITE_FAILURES", () => {
  it("raises on swallowed losses with the counter's evidence in context", async () => {
    mocks.eventStats.value = {
      count: 3,
      lastAt: new Date("2026-08-05T08:55:00.000Z"),
      lastType: "cycle.skipped",
      processStartedAt: "2026-08-01T00:00:00.000Z",
    };

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedOfType("EVENT_WRITE_FAILURES");
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(raised?.context).toMatchObject({
      count: 3,
      lastAt: "2026-08-05T08:55:00.000Z",
      lastType: "cycle.skipped",
      processStartedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("stays silent at zero losses", async () => {
    await runAlertScan("shop_1", { now: NOW });
    expect(raisedOfType("EVENT_WRITE_FAILURES")).toBeUndefined();
  });

  it("does not re-raise when nothing was lost since the last alert (same process, same count)", async () => {
    mocks.eventStats.value.count = 3;
    mocks.alertFindFirst.mockImplementation(async (args?: unknown) => {
      const a = args as {
        where?: Record<string, unknown>;
        orderBy?: unknown;
      };
      // The check's baseline read is the latest row of the type regardless of
      // resolution (orderBy present); raiseAlert's dedupe read filters on
      // resolvedAt null — answer only the former, so dedupe cannot mask the
      // check's own decision.
      if (a?.orderBy && !("resolvedAt" in (a.where ?? {}))) {
        return {
          context: { count: 3, processStartedAt: "2026-08-01T00:00:00.000Z" },
        };
      }
      return null;
    });

    await runAlertScan("shop_1", { now: NOW });

    expect(raisedOfType("EVENT_WRITE_FAILURES")).toBeUndefined();
  });

  it("re-raises when the count grew past the last alert's", async () => {
    mocks.eventStats.value.count = 5;
    mocks.alertFindFirst.mockImplementation(async (args?: unknown) => {
      const a = args as { where?: Record<string, unknown>; orderBy?: unknown };
      if (a?.orderBy && !("resolvedAt" in (a.where ?? {}))) {
        return {
          context: { count: 3, processStartedAt: "2026-08-01T00:00:00.000Z" },
        };
      }
      return null;
    });

    await runAlertScan("shop_1", { now: NOW });

    expect(raisedOfType("EVENT_WRITE_FAILURES")).toMatchObject({
      context: expect.objectContaining({ count: 5 }),
    });
  });

  it("treats a restart-reset counter as loss, never recovery (lower count, new processStartedAt)", async () => {
    mocks.eventStats.value = {
      count: 1,
      lastAt: new Date("2026-08-05T08:00:00.000Z"),
      lastType: "portal.mutation_attempt",
      processStartedAt: "2026-08-05T07:00:00.000Z", // restarted after the last alert
    };
    mocks.alertFindFirst.mockImplementation(async (args?: unknown) => {
      const a = args as { where?: Record<string, unknown>; orderBy?: unknown };
      if (a?.orderBy && !("resolvedAt" in (a.where ?? {}))) {
        return {
          context: { count: 10, processStartedAt: "2026-08-01T00:00:00.000Z" },
        };
      }
      return null;
    });

    await runAlertScan("shop_1", { now: NOW });

    expect(raisedOfType("EVENT_WRITE_FAILURES")).toMatchObject({
      context: expect.objectContaining({
        count: 1,
        processStartedAt: "2026-08-05T07:00:00.000Z",
      }),
    });
  });
});

describe("ATTEMPT_AMOUNT_MISSING", () => {
  it("raises on settled SUCCESS attempts with no amount, pinning the query shape", async () => {
    mocks.attemptFindMany.mockImplementation(async (args?: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if (where.status !== "SUCCESS" || where.amountCents !== null) return [];
      return [
        {
          id: "attempt_1",
          contractId: "contract_1",
          orderId: "gid://shopify/Order/1",
          settledAt: new Date("2026-08-04T10:00:00.000Z"),
        },
      ];
    });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedOfType("ATTEMPT_AMOUNT_MISSING");
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(raised?.context).toMatchObject({
      count: 1,
      lookbackDays: 7,
      sample: [
        {
          attemptId: "attempt_1",
          contractId: "contract_1",
          orderId: "gid://shopify/Order/1",
          settledAt: "2026-08-04T10:00:00.000Z",
        },
      ],
    });

    // The scan asked for exactly the invisible-money shape: settled SUCCESS,
    // NULL amount, inside the lookback, countable contracts only (demo and
    // foreign contracts are never ours to alert on).
    const call = mocks.attemptFindMany.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.status === "SUCCESS" && w.amountCents === null);
    expect(call).toMatchObject({
      contract: { shopId: "shop_1", isDemo: false, ownership: "OURS" },
    });
    const settledAt = (call as { settledAt: { gte: Date } }).settledAt;
    expect(settledAt.gte.getTime()).toBe(NOW.getTime() - 7 * 86_400_000);
  });

  it("stays silent when every settled SUCCESS attempt carries an amount", async () => {
    await runAlertScan("shop_1", { now: NOW });
    expect(raisedOfType("ATTEMPT_AMOUNT_MISSING")).toBeUndefined();
  });
});

describe("availability history (AvailabilitySnapshot)", () => {
  const FEED = new Map<string, boolean>([
    ["gid://shopify/ProductVariant/1", true],
    ["gid://shopify/ProductVariant/2", false],
    ["gid://shopify/ProductVariant/3", false],
  ]);

  it("upserts one row per shop-day with the unavailable set and coverage", async () => {
    const result = await runAlertScan("shop_1", {
      now: NOW,
      variantAvailability: FEED,
    });

    expect(result.errors).toEqual([]);
    expect(mocks.snapshotUpsert).toHaveBeenCalledTimes(1);
    const args = mocks.snapshotUpsert.mock.calls[0][0] as {
      where: { shopId_date: { shopId: string; date: Date } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.where.shopId_date.shopId).toBe("shop_1");
    expect(args.where.shopId_date.date.getTime()).toBe(DAY_LABEL.getTime());
    expect(args.create).toMatchObject({
      shopId: "shop_1",
      unavailableVariantIds: [
        "gid://shopify/ProductVariant/2",
        "gid://shopify/ProductVariant/3",
      ],
      checkedVariants: 3,
    });
  });

  it("unions with the day's earlier observations — a restocked morning stockout stays recorded", async () => {
    mocks.snapshotFindUnique.mockResolvedValue({
      unavailableVariantIds: ["gid://shopify/ProductVariant/9"],
      checkedVariants: 5,
    });

    await runAlertScan("shop_1", { now: NOW, variantAvailability: FEED });

    const args = mocks.snapshotUpsert.mock.calls[0][0] as {
      update: { unavailableVariantIds: string[]; checkedVariants: number };
    };
    expect(args.update.unavailableVariantIds).toEqual([
      "gid://shopify/ProductVariant/9",
      "gid://shopify/ProductVariant/2",
      "gid://shopify/ProductVariant/3",
    ]);
    // Coverage keeps the widest scan of the day, never shrinks.
    expect(args.update.checkedVariants).toBe(5);
  });

  it("skips the snapshot when the scan has no availability feed (it never guesses)", async () => {
    await runAlertScan("shop_1", { now: NOW });
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
  });

  it("a snapshot failure is contained — the checks still run", async () => {
    mocks.snapshotUpsert.mockRejectedValue(new Error("db hiccup"));
    mocks.eventStats.value.count = 2;

    const result = await runAlertScan("shop_1", {
      now: NOW,
      variantAvailability: FEED,
    });

    expect(result.errors).toEqual([
      expect.stringContaining("availability_snapshot"),
    ]);
    // The scan went on to raise from its checks regardless.
    expect(raisedOfType("EVENT_WRITE_FAILURES")).toBeDefined();
  });
});
