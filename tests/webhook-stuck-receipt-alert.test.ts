import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRASH RESIDUE MUST BE VISIBLE — checkWebhookFailures, evaluated.
 *
 * A first delivery that dies mid-handler leaves a receipt claimed but never
 * completed: status PROCESSED (the provisional claim value) with processedAt
 * NULL. The webhook route's redelivery redrive normally finishes these within
 * a couple of Shopify retries — but Shopify's retries are finite (~48h) and
 * can be exhausted while the app is down. Before this check, that residue was
 * invisible to every recovery surface: the WEBHOOK_FAILURES alert counted only
 * status FAILED, and the stale-attempt sweep only scans attempts still
 * PENDING — never a SUCCESS+settledAt-NULL row stranded behind a swallowed
 * redelivery.
 *
 * And FAILED receipts have a residue arm of their own: a handler that THREW
 * (rather than crashed) was answered 200 FAILED, which permanently ENDS the
 * retry train for that id — the old ≥5-failures-per-hour threshold let 1-4
 * such receipts age out silently, orphaning half-settled attempts forever.
 * A single FAILED receipt older than the stuck window (within the 48h
 * lookback) must therefore alert, threshold ONE.
 *
 * These tests drive the REAL runAlertScan over a mocked db and pin that stuck
 * and FAILED-residue receipts raise the alert (and that fresh, still-in-flight
 * or still-retryable receipts do not).
 */

const mocks = vi.hoisted(() => ({
  receiptCount: vi.fn(async (_args?: unknown): Promise<number> => 0),
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
  // assertions stay about the webhook check.
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
    webhookReceipt: { count: mocks.receiptCount },
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

/** Answer the three disjoint counts the check issues, by their where shape. */
function primeCounts({
  failed,
  stuck,
  failedStuck = 0,
}: {
  failed: number;
  stuck: number;
  failedStuck?: number;
}) {
  mocks.receiptCount.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if (where.status === "FAILED") {
      // Two disjoint FAILED counts: the last-hour spike (receivedAt.gte only)
      // and the answered-200 unrecoverable residue (processedAt NULL past the
      // stuck window) — told apart by the residue's processedAt filter.
      return "processedAt" in where ? failedStuck : failed;
    }
    if (where.status === "PROCESSED") return stuck;
    return 0;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alertFindFirst.mockResolvedValue(null);
  primeCounts({ failed: 0, stuck: 0 });
});

describe("WEBHOOK_FAILURES and claimed-but-unfinished receipts", () => {
  it("a single stuck receipt (processedAt NULL past the window) raises the alert even with zero FAILED", async () => {
    primeCounts({ failed: 0, stuck: 1 });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = mocks.alertCreate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.type === "WEBHOOK_FAILURES");
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("CRITICAL");
    expect(raised?.context).toMatchObject({
      failedLastHour: 0,
      stuckUnfinished: 1,
    });
    expect(String(raised?.message)).toContain("claimed but unfinished");

    // The stuck count asked exactly for the crash-residue shape: the
    // provisional claim value with no completion marker, older than the
    // window — NOT the FAILED rows the other count already covers.
    const stuckCall = mocks.receiptCount.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.status === "PROCESSED");
    expect(stuckCall).toMatchObject({
      shopDomain: "cellexia.myshopify.com",
      status: "PROCESSED",
      processedAt: null,
    });
    expect(
      (stuckCall as { receivedAt: { lt: Date } }).receivedAt.lt.getTime(),
    ).toBe(NOW.getTime() - 15 * 60_000);
  });

  it("no stuck receipts and few failures stays silent — the fresh in-flight claim window is not noise", async () => {
    primeCounts({ failed: 4, stuck: 0 });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = mocks.alertCreate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.type === "WEBHOOK_FAILURES");
    expect(raised).toBeUndefined();
  });

  it("the pre-existing failure threshold still fires on its own", async () => {
    primeCounts({ failed: 5, stuck: 0 });

    await runAlertScan("shop_1", { now: NOW });

    const raised = mocks.alertCreate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.type === "WEBHOOK_FAILURES");
    expect(raised).toBeDefined();
    expect(raised?.context).toMatchObject({
      failedLastHour: 5,
      stuckUnfinished: 0,
    });
  });

  it("a single answered-200 FAILED receipt past the window raises — no retry train is left, so the threshold is ONE", async () => {
    primeCounts({ failed: 1, stuck: 0, failedStuck: 1 });

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = mocks.alertCreate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => d.type === "WEBHOOK_FAILURES");
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("CRITICAL");
    expect(raised?.context).toMatchObject({
      failedLastHour: 1,
      stuckUnfinished: 0,
      failedUnrecoverable: 1,
    });
    expect(String(raised?.message)).toContain("never redeliver");

    // The residue count asked for exactly the unrecoverable shape: FAILED,
    // no completion marker, past the stuck window, inside the lookback.
    const residueCall = mocks.receiptCount.mock.calls
      .map((c) => (c[0] as { where: Record<string, unknown> }).where)
      .find((w) => w.status === "FAILED" && "processedAt" in w);
    expect(residueCall).toMatchObject({
      shopDomain: "cellexia.myshopify.com",
      status: "FAILED",
      processedAt: null,
    });
    const range = (residueCall as { receivedAt: { lt: Date; gte: Date } })
      .receivedAt;
    expect(range.lt.getTime()).toBe(NOW.getTime() - 15 * 60_000);
    expect(range.gte.getTime()).toBeLessThan(range.lt.getTime());
  });
});
