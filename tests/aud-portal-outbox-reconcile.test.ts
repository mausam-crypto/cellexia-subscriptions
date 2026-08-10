import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LOGGED SENT MUST STAY FALSIFIABLE — outbox DEAD rows reconcile the
 * NotificationLog.
 *
 * sendNotification logs SENT (channel KLAVIYO_EVENT) at enqueue time, which
 * is a pure DB insert: nothing has been delivered yet. When the outbox row
 * later dies (permanent 4xx — classically a rotated API key — attempts
 * exhausted, or the 24h age-out), that SENT row used to stay untrue forever:
 * hasSentForCycle dedupe stuck on messages the customer never received and
 * dunning ladders advanced on them.
 *
 * The fix (migration 0016, NotificationLog.outboxId): the SENT row stores
 * the outbox row that carries it, and every DEAD transition in
 * flushKlaviyoOutbox flips referencing SENT rows to FAILED (error = dead
 * reason) and logs notification.failed. These tests drive the REAL enqueue,
 * sendNotification, flushKlaviyoOutbox and hasSentForCycle over one shared
 * in-memory store — the exact enqueue → SENT → DEAD → resendable strand.
 */

type Row = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  outbox: [] as Row[],
  logs: [] as Row[],
  seq: 0,
}));

/** Tiny where-matcher for the exact query shapes these modules issue. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === null || cond === undefined) {
      if (row[key] != null) return false;
      continue;
    }
    if (typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        if (!(c.in as unknown[]).includes(row[key])) return false;
        continue;
      }
      if ("lt" in c || "lte" in c || "gt" in c || "gte" in c) {
        const v = row[key] as Date | undefined;
        if (!(v instanceof Date)) return false;
        if (c.lt instanceof Date && !(v.getTime() < c.lt.getTime())) return false;
        if (c.lte instanceof Date && !(v.getTime() <= c.lte.getTime())) return false;
        if (c.gt instanceof Date && !(v.getTime() > c.gt.getTime())) return false;
        if (c.gte instanceof Date && !(v.getTime() >= c.gte.getTime())) return false;
        continue;
      }
      if ("path" in c && "equals" in c) {
        const path = c.path as string[];
        let v: unknown = row[key];
        for (const p of path) v = (v as Record<string, unknown> | null)?.[p];
        if (v !== c.equals) return false;
        continue;
      }
      // Unrecognized operator object — treat as non-match to fail loudly.
      return false;
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

const mocks = vi.hoisted(() => ({
  isKlaviyoConfigured: vi.fn((): boolean => true),
  createKlaviyoEvent: vi.fn(
    async (_input: unknown): Promise<unknown> => ({ ok: true, status: 202 }),
  ),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "notifications") {
      return { channels: { email: true, sms: true } };
    }
    if (key === "alerts") return { emailTo: [] };
    return {};
  }),
  sendEmail: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const client = {
    klaviyoOutbox: {
      findFirst: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<unknown> => {
          // Dedupe probe: match on the scalar fields; the eventTime window
          // and status-in are honored by the generic matcher.
          const { properties, ...rest } = args.where;
          void properties;
          return store.outbox.find((r) => matches(r, rest)) ?? null;
        },
      ),
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<Row> => {
          const row: Row = {
            id: `obx_${++store.seq}`,
            status: "PENDING",
            attempts: 0,
            nextAttemptAt: new Date(0),
            sentAt: null,
            lastError: null,
            ...args.data,
          };
          store.outbox.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<Row[]> =>
          store.outbox.filter((r) => matches(r, args.where)),
      ),
      updateMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }): Promise<{ count: number }> => {
          const hit = store.outbox.filter((r) => matches(r, args.where));
          for (const row of hit) Object.assign(row, args.data);
          return { count: hit.length };
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<Row | undefined> => {
          const row = store.outbox.find((r) => r.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row;
        },
      ),
    },
    notificationLog: {
      create: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<Row> => {
          const row: Row = { id: `nlg_${++store.seq}`, ...args.data };
          store.logs.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<Row[]> =>
          store.logs.filter((r) => matches(r, args.where)),
      ),
      findFirst: vi.fn(
        async (args: { where: Record<string, unknown> }): Promise<unknown> =>
          store.logs.find((r) => matches(r, args.where)) ?? null,
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<Row | undefined> => {
          const row = store.logs.find((r) => r.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row;
        },
      ),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "ctr_1",
        shopId: "shop_1",
        customerId: "gid://shopify/Customer/1",
        email: "anna@example.com",
        phone: null,
        locale: "en",
        ownership: "OURS",
        isDemo: false,
        lines: [],
      })),
    },
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        ianaTimezone: "Europe/Zurich",
        contactEmail: null,
      })),
    },
  };
  return { default: client };
});

vi.mock("~/lib/klaviyo/client.server", () => ({
  isKlaviyoConfigured: mocks.isKlaviyoConfigured,
  createKlaviyoEvent: mocks.createKlaviyoEvent,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: mocks.isSetupMode,
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/notifications/mailer.server", () => ({
  sendEmail: mocks.sendEmail,
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://portal"),
  buildActionLinkBundle: vi.fn(
    async (): Promise<Record<string, string>> => ({}),
  ),
}));
// Snapshot builders read the shop and format dates — stub them so these
// tests stay about the outbox linkage, not property shapes.
vi.mock("~/lib/klaviyo/events-map.server", () => ({
  contractProfileAttrs: vi.fn((): Record<string, unknown> => ({})),
  contractSnapshotProperties: vi.fn(
    async (): Promise<Record<string, unknown>> => ({}),
  ),
}));

import { enqueue, flushKlaviyoOutbox } from "~/lib/klaviyo/outbox.server";
import {
  hasSentForCycle,
  sendNotification,
} from "~/lib/notifications/send.server";

function loggedEvents(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type)
    .map((e) => e.payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.outbox = [];
  store.logs = [];
  store.seq = 0;
  mocks.isKlaviyoConfigured.mockReturnValue(true);
  mocks.createKlaviyoEvent.mockResolvedValue({ ok: true, status: 202 });
  mocks.isSetupMode.mockResolvedValue(false);
});

// ── enqueue's row contract ───────────────────────────────────────────────────

describe("enqueue returns the row that will carry the event", () => {
  it("returns the created row's id", async () => {
    const row = await enqueue("shop_1", {
      eventName: "Cellexia Upcoming Order",
      email: "anna@example.com",
    });
    expect(row).toEqual({ id: "obx_1" });
    expect(store.outbox).toHaveLength(1);
  });

  it("a deduped duplicate returns the SURVIVING row, not null", async () => {
    // The caller's delivery rides the first row — its NotificationLog
    // reference must point there so a later DEAD still reconciles it.
    const first = await enqueue("shop_1", {
      eventName: "Cellexia Upcoming Order",
      email: "anna@example.com",
    });
    const second = await enqueue("shop_1", {
      eventName: "Cellexia Upcoming Order",
      email: "anna@example.com",
    });
    expect(second?.id).toBe(first?.id);
    expect(store.outbox).toHaveLength(1);
  });

  it("returns null when nothing was enqueued (no recipient)", async () => {
    expect(
      await enqueue("shop_1", { eventName: "Cellexia Upcoming Order" }),
    ).toBeNull();
  });
});

// ── The full strand: SENT → DEAD → FAILED + resendable ──────────────────────

describe("DEAD outbox rows reconcile the NotificationLog", () => {
  async function sendUpcomingOrder(): Promise<Row> {
    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { cycleIndex: 4 },
    });
    expect(result.status).toBe("SENT");
    const log = store.logs.find((l) => l.channel === "KLAVIYO_EVENT")!;
    expect(log).toBeDefined();
    return log;
  }

  it("sendNotification stamps the outbox row id onto the SENT log row", async () => {
    const log = await sendUpcomingOrder();
    expect(log.status).toBe("SENT");
    expect(log.outboxId).toBe(store.outbox[0]!.id);
  });

  it("permanent 4xx (rotated key): SENT flips FAILED, notification.failed logs, cycle dedupe unlocks", async () => {
    const log = await sendUpcomingOrder();

    // The dedupe would suppress a resend while the row claims SENT.
    expect(await hasSentForCycle("ctr_1", "upcoming_order", 4)).toBe(true);

    // Key rotated: every delivery is now a permanent 4xx.
    mocks.createKlaviyoEvent.mockResolvedValue({
      ok: false,
      permanent: true,
      status: 401,
      error: "401 revoked key",
    });
    const stats = await flushKlaviyoOutbox();
    expect(stats.dead).toBe(1);

    expect(log.status).toBe("FAILED");
    expect(String(log.error)).toContain("revoked");

    const failed = loggedEvents("notification.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      template: "upcoming_order",
      outboxId: store.outbox[0]!.id,
      deadOutbox: true,
      cycleIndex: 4,
    });

    // The audit trail is truthful again and the customer is resendable.
    expect(await hasSentForCycle("ctr_1", "upcoming_order", 4)).toBe(false);
  });

  it("the 24h age-out reconciles too — even with the key missing", async () => {
    const log = await sendUpcomingOrder();
    // Backdate the row past the age-out cutoff, then lose the key.
    store.outbox[0]!.eventTime = new Date(Date.now() - 25 * 3600_000);
    mocks.isKlaviyoConfigured.mockReturnValue(false);

    const stats = await flushKlaviyoOutbox();

    expect(stats.expired).toBe(1);
    expect(stats.skipped).toBe(true);
    expect(log.status).toBe("FAILED");
    expect(String(log.error)).toContain("expired");
    expect(loggedEvents("notification.failed")).toHaveLength(1);
  });

  it("attempts-exhausted rows reconcile on their final retry", async () => {
    const log = await sendUpcomingOrder();
    store.outbox[0]!.attempts = 9; // next failure is the tenth
    mocks.createKlaviyoEvent.mockRejectedValue(new Error("503 down"));

    const stats = await flushKlaviyoOutbox();

    expect(stats.dead).toBe(1);
    expect(log.status).toBe("FAILED");
    expect(loggedEvents("notification.failed")).toHaveLength(1);
  });

  it("a retryable failure does NOT reconcile — the row is still alive", async () => {
    const log = await sendUpcomingOrder();
    mocks.createKlaviyoEvent.mockRejectedValue(new Error("503 down"));

    const stats = await flushKlaviyoOutbox();

    expect(stats.retried).toBe(1);
    expect(log.status).toBe("SENT");
    expect(loggedEvents("notification.failed")).toHaveLength(0);
  });

  it("an enqueue that inserts nothing logs FAILED, never SENT", async () => {
    // A dropped enqueue means no row will ever deliver — a SENT log here
    // would be exactly the logged-SENT-but-undelivered lie.
    const db = (await import("~/db.server")).default as unknown as {
      klaviyoOutbox: { create: ReturnType<typeof vi.fn> };
    };
    db.klaviyoOutbox.create.mockRejectedValueOnce(new Error("db down"));

    const result = await sendNotification({
      shopId: "shop_1",
      contractId: "ctr_1",
      template: "upcoming_order",
      vars: { cycleIndex: 4 },
    });

    expect(result.status).toBe("FAILED");
    const log = store.logs.find((l) => l.channel === "KLAVIYO_EVENT")!;
    expect(log.status).toBe("FAILED");
    expect(await hasSentForCycle("ctr_1", "upcoming_order", 4)).toBe(false);
  });
});

// ── The dedupe's SENT-only pin ───────────────────────────────────────────────

describe("hasSentForCycle counts only SENT rows", () => {
  it("FAILED and SUPPRESSED rows never suppress a resend", async () => {
    store.logs.push(
      {
        id: "nlg_a",
        contractId: "ctr_1",
        template: "upcoming_order",
        status: "FAILED",
        payload: { cycleIndex: 7 },
      },
      {
        id: "nlg_b",
        contractId: "ctr_1",
        template: "upcoming_order",
        status: "SUPPRESSED",
        payload: { cycleIndex: 7 },
      },
    );
    expect(await hasSentForCycle("ctr_1", "upcoming_order", 7)).toBe(false);

    store.logs.push({
      id: "nlg_c",
      contractId: "ctr_1",
      template: "upcoming_order",
      status: "SENT",
      payload: { cycleIndex: 7 },
    });
    expect(await hasSentForCycle("ctr_1", "upcoming_order", 7)).toBe(true);
  });
});
