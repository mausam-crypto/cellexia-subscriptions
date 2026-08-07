import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CONTAINED BACKFILL FAILURES MUST BE VISIBLE — checkOriginBackfillFailures.
 *
 * runOriginOrderBackfill contains every per-contract failure (result.failed /
 * result.acqFailed) so one dead order can never abort the run — which also
 * means the JobRun records SUCCESS and nothing downstream ever noticed:
 * BILLING_RUN_FAILED-style checks only see THROWN jobs. A capped oldest-first
 * window quietly filling with failing rows is exactly how the origin-money
 * queue starves (each night burns the whole cap on the same failing fetches
 * and captures nothing), so the failure counters now surface as a WARNING
 * alert. Terminal retirements (stats.exhausted, migration 0011) are the FIX
 * for starvation, not a failure — they must never alert.
 *
 * Drives the REAL runAlertScan over a mocked db, like
 * tests/webhook-stuck-receipt-alert.test.ts.
 */

const mocks = vi.hoisted(() => ({
  jobRunFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  alertCreate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
      id: "alert_1",
      ...args.data,
    }),
  ),
  alertFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  logEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  // Every check runAlertScan fires other than the one under test gets silent
  // all-clear answers from the auto-stub, so the scan runs end to end and the
  // assertions stay about the backfill check.
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
    jobRun: {
      findFirst: mocks.jobRunFindFirst,
      findMany: async () => [],
    },
    alert: { create: mocks.alertCreate, findFirst: mocks.alertFindFirst },
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
  COUNTABLE_CONTRACT: {},
  requireShopById: vi.fn(async () => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({
    stuckContractHours: 24,
    failureSpikeThresholdPct: 100,
    churnSpikeThresholdPct: 100,
    emailTo: [],
  })),
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));

import { runAlertScan } from "~/lib/analytics/alerts.server";

const NOW = new Date("2026-08-05T09:00:00.000Z");

/** The latest completed origin_order_backfill JobRun as the check reads it. */
function lastRun(stats: Record<string, unknown> | null) {
  return {
    id: "run_1",
    startedAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
    stats,
  };
}

/** Answer only the check's own query; every other jobRun read stays silent. */
function primeLastRun(stats: Record<string, unknown> | null): void {
  mocks.jobRunFindFirst.mockImplementation(async (args?: unknown) => {
    const where =
      (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    if (where.jobName === "origin_order_backfill") return lastRun(stats);
    return null;
  });
}

function raisedBackfillAlert(): Record<string, unknown> | undefined {
  return mocks.alertCreate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => d.type === "ORIGIN_BACKFILL_FAILURES");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alertFindFirst.mockResolvedValue(null);
  mocks.jobRunFindFirst.mockResolvedValue(null);
});

describe("ORIGIN_BACKFILL_FAILURES", () => {
  it("a run whose contained money-capture failures were swallowed by SUCCESS raises the WARNING", async () => {
    primeLastRun({
      scanned: 200,
      captured: 0,
      failed: 200, // the starvation shape: whole cap burned, nothing captured
      exhausted: 0,
      acqScanned: 0,
      acqApplied: 0,
      acqFailed: 0,
      acqExhausted: 0,
    });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedBackfillAlert();
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(raised?.context).toMatchObject({
      jobRunId: "run_1",
      failed: 200,
      acqFailed: 0,
      captured: 0,
      scanned: 200,
    });
    expect(String(raised?.message)).toContain("starve");

    // And it asked for exactly the latest COMPLETED run of THIS job — a
    // thrown run is BILLING_RUN_FAILED territory, not this check's.
    const call = mocks.jobRunFindFirst.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown>; orderBy: unknown })
      .find(
        (args) => args.where.jobName === "origin_order_backfill",
      );
    expect(call?.where.status).toBe("SUCCESS");
    expect(call?.orderBy).toEqual({ startedAt: "desc" });
  });

  it("acquisition-pass failures alone raise it too", async () => {
    primeLastRun({ failed: 0, acqFailed: 3 });
    await runAlertScan("shop_1", { now: NOW });
    expect(raisedBackfillAlert()).toMatchObject({
      context: { failed: 0, acqFailed: 3 },
    });
  });

  it("a clean run stays silent — including one that only RETIRED unfetchable rows", async () => {
    primeLastRun({
      scanned: 200,
      captured: 150,
      failed: 0,
      exhausted: 50, // the 0011 fix doing its job is not a failure
      acqFailed: 0,
    });
    const result = await runAlertScan("shop_1", { now: NOW });
    expect(result.errors).toEqual([]);
    expect(raisedBackfillAlert()).toBeUndefined();
  });

  it("no completed run in the window (job never ran / skipped shop) stays silent", async () => {
    const result = await runAlertScan("shop_1", { now: NOW });
    expect(result.errors).toEqual([]);
    expect(raisedBackfillAlert()).toBeUndefined();
  });

  it("malformed or missing stats never crash the scan and never alert", async () => {
    primeLastRun(null);
    let result = await runAlertScan("shop_1", { now: NOW });
    expect(result.errors).toEqual([]);
    expect(raisedBackfillAlert()).toBeUndefined();

    primeLastRun({ skipped: "no_shop" }); // the job's skip shape has no counters
    result = await runAlertScan("shop_1", { now: NOW });
    expect(result.errors).toEqual([]);
    expect(raisedBackfillAlert()).toBeUndefined();
  });
});
