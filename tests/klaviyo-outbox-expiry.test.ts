import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE OUTBOX MUST NEVER FIRE STALE FLOWS, AND A DEAD OUTBOX MUST BE VISIBLE.
 *
 * Two halves of the same defect (KLAVIYO_PRIVATE_API_KEY unset for weeks):
 *
 *  1. flushKlaviyoOutbox left PENDING rows untouched while the key was
 *     missing, so configuring it later flushed the entire stale backlog —
 *     payment-failure and skip flows firing on moments resolved weeks ago.
 *     Now an age-out sweep runs FIRST (even — especially — when the key is
 *     missing): rows older than 24h go DEAD instead of delivering late.
 *
 *  2. No alert type watched the outbox at all: every customer lifecycle
 *     message rides it, and nothing anywhere said it was not draining. The
 *     KLAVIYO_OUTBOX_BACKLOG check now raises a WARNING on stalled PENDING
 *     rows or recent DEAD rows, with copy that names the missing key.
 *
 * Drives the REAL flushKlaviyoOutbox and runAlertScan over a mocked db
 * (tests/origin-backfill-alert.test.ts pattern).
 */

const mocks = vi.hoisted(() => {
  const isKlaviyoConfigured = vi.fn(async (): Promise<boolean> => false);
  return {
    isKlaviyoConfigured,
    // The flush resolves credentials via resolveKlaviyoAuth; deriving the
    // mock from isKlaviyoConfigured keeps each test's single
    // mockReturnValue/mockResolvedValue toggle driving both seams.
    resolveKlaviyoAuth: vi.fn(async () =>
      (await isKlaviyoConfigured())
        ? { apiKey: "pk_test", revision: "2024-10-15", source: "env" }
        : { apiKey: null, revision: "2024-10-15", source: null },
    ),
    createKlaviyoEvent: vi.fn(
      async (_input: unknown, _auth?: unknown): Promise<unknown> => ({
        ok: true,
        status: 202,
      }),
    ),
    outboxUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 0 })),
    outboxFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
    outboxUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
    outboxCount: vi.fn(async (_args?: unknown): Promise<number> => 0),
    alertCreate: vi.fn(
      async (args: { data: Record<string, unknown> }): Promise<unknown> => ({
        id: "alert_1",
        ...args.data,
      }),
    ),
    alertFindFirst: vi.fn(async (): Promise<unknown> => null),
    logEvent: vi.fn(async (): Promise<void> => {}),
  };
});

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
    klaviyoOutbox: {
      updateMany: mocks.outboxUpdateMany,
      findMany: mocks.outboxFindMany,
      update: mocks.outboxUpdate,
      count: mocks.outboxCount,
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

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
  resolveKlaviyoAuth: mocks.resolveKlaviyoAuth,
  createKlaviyoEvent: mocks.createKlaviyoEvent,
}));

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

vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
  // Consumed by runAlertScan's EVENT_WRITE_FAILURES check — zero keeps it
  // silent so these tests stay about the outbox backlog alone.
  getEventWriteFailureStats: () => ({ count: 0, processStartedAt: "t0" }),
}));

import { flushKlaviyoOutbox } from "~/lib/klaviyo/outbox.server";
import { runAlertScan } from "~/lib/analytics/alerts.server";

const DAY_MS = 24 * 60 * 60 * 1000;

function raisedBacklogAlert(): Record<string, unknown> | undefined {
  return mocks.alertCreate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .find((d) => d.type === "KLAVIYO_OUTBOX_BACKLOG");
}

/** Answer the two backlog counts; every other klaviyoOutbox count is 0. */
function primeCounts(pendingStalled: number, deadRecent: number): void {
  mocks.outboxCount.mockImplementation(async (args?: unknown) => {
    const where =
      (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};
    if (where.status === "PENDING") return pendingStalled;
    if (where.status === "DEAD") return deadRecent;
    return 0;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isKlaviyoConfigured.mockResolvedValue(false);
  mocks.outboxUpdateMany.mockResolvedValue({ count: 0 });
  mocks.outboxFindMany.mockResolvedValue([]);
  mocks.alertFindFirst.mockResolvedValue(null);
  mocks.outboxCount.mockResolvedValue(0);
});

// ── flushKlaviyoOutbox age-out sweep ─────────────────────────────────────────

describe("flushKlaviyoOutbox age-out sweep", () => {
  it("ages out rows older than 24h even when the key is missing, then skips", async () => {
    mocks.outboxUpdateMany.mockResolvedValue({ count: 3 });
    const before = Date.now();

    const stats = await flushKlaviyoOutbox();

    expect(stats).toEqual({
      claimed: 0,
      sent: 0,
      retried: 0,
      dead: 0,
      expired: 3,
      skipped: true,
    });
    // No delivery attempt without the key — but the sweep DID run, so a key
    // configured weeks later starts from a clean outbox. (The sweep now also
    // snapshots the expiring ids for NotificationLog reconciliation, so
    // findMany itself IS called — what must never happen keyless is the
    // delivery CLAIM, recognizable by its nextAttemptAt window.)
    const claimCalls = mocks.outboxFindMany.mock.calls.filter(
      (c) =>
        (c[0] as { where?: Record<string, unknown> } | undefined)?.where
          ?.nextAttemptAt != null,
    );
    expect(claimCalls).toHaveLength(0);
    expect(mocks.createKlaviyoEvent).not.toHaveBeenCalled();

    const call = mocks.outboxUpdateMany.mock.calls[0]![0] as {
      where: {
        status: { in: string[] };
        eventTime: { lt: Date };
      };
      data: { status: string; lastError: string };
    };
    expect(call.where.status.in.sort()).toEqual(["FAILED", "PENDING"]);
    const cutoff = call.where.eventTime.lt.getTime();
    expect(Math.abs(before - DAY_MS - cutoff)).toBeLessThan(5_000);
    expect(call.data.status).toBe("DEAD");
    expect(call.data.lastError).toContain("expired");
  });

  it("with the key set, sweeps first and still delivers fresh rows", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(true);
    mocks.outboxUpdateMany.mockResolvedValue({ count: 2 });
    mocks.outboxFindMany.mockResolvedValue([
      {
        id: "row_1",
        eventName: "Cellexia Upcoming Order",
        email: "anna@example.com",
        phone: null,
        profileAttrs: {},
        properties: {},
        eventTime: new Date(),
        attempts: 0,
      },
    ]);

    const stats = await flushKlaviyoOutbox();

    expect(stats.expired).toBe(2);
    expect(stats.claimed).toBe(1);
    expect(stats.sent).toBe(1);
    expect(mocks.createKlaviyoEvent).toHaveBeenCalledTimes(1);
    // The resolved per-shop credentials ride along to the client — the key
    // that authenticates is the one resolveKlaviyoAuth chose (settings-or-
    // env), not whatever happens to sit in process.env at send time.
    expect(mocks.createKlaviyoEvent.mock.calls[0]![1]).toMatchObject({
      apiKey: "pk_test",
    });
    const update = mocks.outboxUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: { status: string };
    };
    expect(update.where.id).toBe("row_1");
    expect(update.data.status).toBe("SENT");
  });

  it("a broken sweep never blocks delivery", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(true);
    mocks.outboxUpdateMany.mockRejectedValue(new Error("db hiccup"));

    const stats = await flushKlaviyoOutbox();

    expect(stats.expired).toBe(0);
    // The delivery claim (nextAttemptAt window) still ran despite the sweep
    // failure — the age-out's own snapshot read doesn't count as a claim.
    const claimCalls = mocks.outboxFindMany.mock.calls.filter(
      (c) =>
        (c[0] as { where?: Record<string, unknown> } | undefined)?.where
          ?.nextAttemptAt != null,
    );
    expect(claimCalls).toHaveLength(1); // flush proceeded
  });
});

// ── KLAVIYO_OUTBOX_BACKLOG alert ─────────────────────────────────────────────

const NOW = new Date("2026-08-06T09:00:00.000Z");

describe("KLAVIYO_OUTBOX_BACKLOG", () => {
  it("stalled PENDING rows with no key raise a WARNING that names the missing key", async () => {
    primeCounts(5, 0);

    const result = await runAlertScan("shop_1", { now: NOW });

    expect(result.errors).toEqual([]);
    const raised = raisedBacklogAlert();
    expect(raised).toBeDefined();
    expect(raised?.severity).toBe("WARNING");
    expect(String(raised?.message)).toContain("KLAVIYO_PRIVATE_API_KEY");
    expect(raised?.context).toMatchObject({
      pendingStalled: 5,
      deadRecent: 0,
      klaviyoConfigured: false,
    });

    // The stalled arm looks only at PENDING rows older than an hour, scoped
    // to the shop — FAILED rows mid-backoff must not trip it.
    const countCall = mocks.outboxCount.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown> })
      .find((args) => args.where.status === "PENDING");
    expect(countCall?.where.shopId).toBe("shop_1");
    const lt = (countCall?.where.eventTime as { lt: Date }).lt;
    expect(NOW.getTime() - lt.getTime()).toBe(60 * 60_000);
  });

  it("recent DEAD rows alone raise it too", async () => {
    primeCounts(0, 2);

    await runAlertScan("shop_1", { now: NOW });

    const raised = raisedBacklogAlert();
    expect(raised).toBeDefined();
    expect(String(raised?.message)).toContain("died undelivered");
    expect(raised?.context).toMatchObject({ pendingStalled: 0, deadRecent: 2 });
  });

  it("with the key set, stalled rows point at the flush job instead", async () => {
    mocks.isKlaviyoConfigured.mockResolvedValue(true);
    primeCounts(4, 0);

    await runAlertScan("shop_1", { now: NOW });

    const raised = raisedBacklogAlert();
    expect(String(raised?.message)).toContain("klaviyo_flush");
    expect(raised?.context).toMatchObject({ klaviyoConfigured: true });
  });

  it("an empty outbox stays silent", async () => {
    const result = await runAlertScan("shop_1", { now: NOW });
    expect(result.errors).toEqual([]);
    expect(raisedBacklogAlert()).toBeUndefined();
  });
});
