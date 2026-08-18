import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Scheduled cancel for locked contracts (v1.28.0, P3.8).
 *
 * Pins:
 *  - scheduleCancel refuses an unlocked contract (immediate cancel is the
 *    path), writes cancelScheduledAt = the lock's unlock moment, closes the
 *    session CANCEL_SCHEDULED with the resolved reason, logs cancel.scheduled
 *    and sends cancel_scheduled (contained);
 *  - keepScheduledCancel clears the column atomically and logs
 *    cancel.schedule_kept; a contract with nothing scheduled is a no-op;
 *  - the hourly job: sends cancel_upcoming ONCE inside the notice window,
 *    cancels a due contract through cancelContract (source CUSTOMER_PORTAL,
 *    cancelSource CUSTOMER, the session's reason), and NEVER cancels a
 *    contract whose cancelScheduledAt was cleared between the candidate scan
 *    and the fresh re-read (race with keep / admin);
 *  - the billing sweep excludes contracts whose scheduled moment has passed
 *    (a charge can never land after the customer's chosen end);
 *  - cancelContract / Shopify-side cancel / reactivation clear the column;
 *    a whole-order skip or a pause does not touch it;
 *  - the KEEP_SUBSCRIPTION magic verb exists (mutating, never lock-blocked)
 *    with its i18n keys; the emails have templates, catalog entries and copy;
 *  - the portal: locked contracts enter the flow when
 *    cancelFlow.scheduledCancelEnabled, the intro hides the pause CTA and
 *    states the commitment end, the confirm CTA reads "schedule … for
 *    {date}", the scheduled page carries the keep button; the reducing saves
 *    are hidden (LOCK_BLOCKED_SAVES) and refused at accept.
 */

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  cancelFlow: {} as Record<string, unknown>,
  locked: true,
  claims: [] as Array<Record<string, unknown>>,
  reverts: [] as Array<Record<string, unknown>>,
  contractUpdates: [] as Array<Record<string, unknown>>,
  contractUpdateManys: [] as Array<Record<string, unknown>>,
  candidates: [] as Array<Record<string, unknown>>,
  freshRows: [] as Array<Record<string, unknown> | null>,
  notificationLogs: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  cancelContract: vi.fn(async (): Promise<unknown> => ({ status: "CANCELLED" })),
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://app.example.com/magic/keep-token"),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
    sellingPlanConfig: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriptionContract: {
      findUnique: vi.fn(async (args: { where: { id: string }; select?: Record<string, unknown> }): Promise<unknown> => {
        // The job re-reads by id: serve the scripted fresh rows in order when
        // a select is asked for (candidate detail then fresh read).
        if (store.freshRows.length > 0 && args.select) return store.freshRows.shift() ?? null;
        return store.contract;
      }),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      findMany: vi.fn(async (): Promise<unknown[]> => store.candidates),
      update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.contractUpdates.push(args.data);
        return { ...store.contract, ...args.data };
      }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown> => {
        store.contractUpdateManys.push({ ...args.where, ...args.data });
        return { count: (store.contract as { cancelScheduledAt?: Date | null }).cancelScheduledAt ? 1 : 0 };
      }),
    },
    discountGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    giftGrant: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    subscriberEvent: {
      findFirst: vi.fn(async (): Promise<unknown> => ({ createdAt: new Date("2026-08-01T00:00:00Z") })),
    },
    notificationLog: {
      findFirst: vi.fn(async (): Promise<unknown> => store.notificationLogs[0] ?? null),
      findMany: vi.fn(async (): Promise<unknown[]> => store.notificationLogs),
    },
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      findFirst: vi.fn(async (): Promise<unknown> => ({ id: "cs_1", reason: "TOO_EXPENSIVE" })),
      updateMany: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.claims.push(args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }): Promise<unknown> => {
        store.reverts.push(args.data);
        return store.session;
      }),
    },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "cancelFlow") return store.cancelFlow;
    if (key === "portal") return { delayReanchors: true };
    if (key === "pause") return { maxMonths: 3 };
    return {};
  }),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/notifications/send.server", () => ({ sendNotification: mocks.sendNotification }));
vi.mock("~/lib/magiclinks/builder.server", () => ({ buildMagicUrl: mocks.buildMagicUrl }));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({ percent: 15 })),
}));
vi.mock("~/lib/billing/timing.server", () => ({
  isPreparingOrder: vi.fn(async (): Promise<boolean> => false),
  resolveChargeTiming: vi.fn(async (): Promise<unknown> => ({ chargeHourLocal: 0 })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({ gql: vi.fn(async () => ({})) }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/gifts/picker.server", () => ({
  pickGiftForContract: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/experiments/index.server", () => ({
  settingOverride: vi.fn(async (a: { current: unknown }) => a.current),
}));
vi.mock("~/lib/contracts/lock.server", () => ({
  resolveLockState: vi.fn(async () => ({
    locked: store.locked,
    until: store.locked ? new Date("2026-09-30T22:00:00Z") : null,
    lockDays: store.locked ? 60 : 0,
  })),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  getPortalCatalog: vi.fn(async (): Promise<unknown> => []),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: mocks.cancelContract,
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  changeLineQuantity: vi.fn(async (): Promise<unknown> => ({})),
  delayNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  delaySchedule: vi.fn(async (): Promise<unknown> => ({})),
  extendPause: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipLineThisCycle: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
  swapPriceCentsFor: vi.fn(async (): Promise<number> => 0),
  CycleLineEditError: class extends Error {},
}));

import { CANCEL_SCHEDULED, LOCK_BLOCKED_SAVES } from "~/lib/cancel/config.server";
import {
  acceptSave,
  getSavesForReason,
  keepScheduledCancel,
  scheduleCancel,
} from "~/lib/cancel/engine.server";
import { pageConfirm, pageIntro, pageScheduled } from "~/lib/cancel/pages.server";
import { runScheduledCancels } from "~/lib/cancel/scheduled.server";
import { TEMPLATES } from "~/lib/notifications/templates.server";
import { EMAIL_CATALOG } from "~/lib/notifications/catalog.server";
import en from "~/lib/i18n/locales/en.json";
import { settingsSchemas } from "~/lib/settings/registry.server";
import dbModule from "~/db.server";

const db = dbModule as unknown as {
  subscriptionContract: { findMany: ReturnType<typeof vi.fn> };
  subscriberEvent: { findFirst: ReturnType<typeof vi.fn> };
};

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
const UNLOCK = new Date("2026-09-30T22:00:00Z"); // shop-tz midnight Oct 1

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    customerId: "gid://shopify/Customer/1",
    email: "sub@example.com",
    firstName: "Anna",
    locale: "en",
    status: "ACTIVE",
    ownership: "OURS",
    currencyCode: "CHF",
    intervalWeeks: 4,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 4,
    ordersCount: 1,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    cancelScheduledAt: null,
    lines: [],
    ...over,
  };
}

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: "TOO_EXPENSIVE",
    reasonDetail: null,
    savesShown: [],
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.claims = [];
  store.reverts = [];
  store.contractUpdates = [];
  store.contractUpdateManys = [];
  store.candidates = [];
  store.freshRows = [];
  store.notificationLogs = [];
  store.locked = true;
  store.contract = contractFixture();
  store.session = sessionFixture();
  store.cancelFlow = {
    enabled: true,
    maxSavesShown: 2,
    scheduledCancelEnabled: true,
    scheduledCancelNoticeDays: 3,
    delaySaveEnabled: true,
    delaySaveMaxDays: 42,
    downsizeSaveEnabled: false,
    giftSaveEnabled: false,
    reasonOfferPctDefault: 15,
    reasonOfferCyclesDefault: 2,
    reasonOfferCooldownDays: 90,
    sessionFreshMinutes: 60,
  };
});

describe("scheduleCancel", () => {
  it("writes cancelScheduledAt = unlock moment, closes the session CANCEL_SCHEDULED, logs + emails", async () => {
    const result = await scheduleCancel("cs_1", "customer");
    expect(result.scheduledAt.toISOString()).toBe(UNLOCK.toISOString());
    expect(store.claims[0]).toEqual(
      expect.objectContaining({ outcome: CANCEL_SCHEDULED, reason: "TOO_EXPENSIVE" }),
    );
    expect(store.contractUpdates[0]).toEqual({ cancelScheduledAt: UNLOCK });
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.scheduled",
        source: "CUSTOMER_PORTAL",
        payload: expect.objectContaining({ scheduledAt: UNLOCK.toISOString(), reason: "TOO_EXPENSIVE", lockDays: 60 }),
      }),
    );
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "cancel_scheduled",
        contractId: "c_1",
        vars: expect.objectContaining({
          cancel_date_iso: UNLOCK.toISOString(),
          keep_url: "https://app.example.com/magic/keep-token",
        }),
      }),
    );
    expect(mocks.buildMagicUrl).toHaveBeenCalledWith(
      expect.objectContaining({ action: "KEEP_SUBSCRIPTION", contractId: "c_1" }),
    );
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("refuses an unlocked contract (immediate cancel is the path) and honours the admin toggle", async () => {
    store.locked = false;
    await expect(scheduleCancel("cs_1")).rejects.toThrow(/not inside a plan lock window/);
    expect(store.claims).toHaveLength(0);
    store.locked = true;
    store.cancelFlow = { ...store.cancelFlow, scheduledCancelEnabled: false };
    await expect(scheduleCancel("cs_1")).rejects.toThrow(/scheduledCancelEnabled/);
  });

  it("a failed column write reverts the session claim", async () => {
    store.session = sessionFixture();
    const db = (await import("~/db.server")).default as unknown as {
      subscriptionContract: { update: ReturnType<typeof vi.fn> };
    };
    db.subscriptionContract.update.mockRejectedValueOnce(new Error("db down"));
    await expect(scheduleCancel("cs_1")).rejects.toThrow(/db down/);
    expect(store.reverts).toContainEqual(expect.objectContaining({ outcome: null, completedAt: null }));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("an email failure never breaks the schedule (contained)", async () => {
    mocks.sendNotification.mockRejectedValueOnce(new Error("smtp down"));
    const result = await scheduleCancel("cs_1");
    expect(result.scheduledAt).toEqual(UNLOCK);
    expect(store.reverts).toHaveLength(0);
  });
});

describe("keepScheduledCancel", () => {
  it("clears the column atomically and logs cancel.schedule_kept", async () => {
    store.contract = contractFixture({ cancelScheduledAt: UNLOCK });
    const kept = await keepScheduledCancel("c_1", { source: "MAGIC_LINK", actor: "customer" });
    expect(kept).toBe(true);
    expect(store.contractUpdateManys[0]).toEqual(
      expect.objectContaining({ id: "c_1", cancelScheduledAt: null }),
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.schedule_kept",
        source: "MAGIC_LINK",
        payload: { previousScheduledAt: UNLOCK.toISOString() },
      }),
    );
    // The scheduling session settles as a save (KEEP) — kept and executed
    // schedules are distinguishable at the session level.
    expect(store.claims).toContainEqual(
      expect.objectContaining({ outcome: "SAVED", saveAccepted: "KEEP" }),
    );
  });

  it("is a no-op when nothing is scheduled", async () => {
    const kept = await keepScheduledCancel("c_1", { source: "CUSTOMER_PORTAL" });
    expect(kept).toBe(false);
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe("cancel_scheduled_run job", () => {
  it("sends cancel_upcoming once inside the notice window, nothing earlier", async () => {
    store.candidates = [{ id: "c_1" }];
    const detail = { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK };
    store.freshRows = [detail];
    // 2 days before: inside the 3-day window.
    let stats = await runScheduledCancels(new Date("2026-09-28T22:00:00Z"));
    expect(stats.noticesSent).toBe(1);
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "cancel_upcoming",
        vars: expect.objectContaining({ keep_url: "https://app.example.com/magic/keep-token", cta_url: "https://app.example.com/magic/keep-token" }),
      }),
    );
    expect(mocks.cancelContract).not.toHaveBeenCalled();
    // Already sent since the scheduling ⇒ not again.
    mocks.sendNotification.mockClear();
    store.freshRows = [detail];
    store.notificationLogs = [{ id: "nl_1", status: "SENT", payload: null }];
    stats = await runScheduledCancels(new Date("2026-09-29T22:00:00Z"));
    expect(stats.noticesSent).toBe(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    // A non-transient SUPPRESSED verdict (merchant disabled the template)
    // dedupes too — no hourly re-attempt piling up rows for the whole window…
    store.freshRows = [detail];
    store.notificationLogs = [{ id: "nl_2", status: "SUPPRESSED", payload: { reason: "template_disabled" } }];
    stats = await runScheduledCancels(new Date("2026-09-29T22:00:00Z"));
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    // …while a transient one (foreign_contract, setup_mode) never blocks.
    store.freshRows = [detail];
    store.notificationLogs = [{ id: "nl_3", status: "SUPPRESSED", payload: { reason: "setup_mode" } }];
    stats = await runScheduledCancels(new Date("2026-09-29T22:00:00Z"));
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    // Scheduled less than 24h ago (a lock ending inside the notice window):
    // cancel_scheduled just went out — no cancel_upcoming an hour later.
    mocks.sendNotification.mockClear();
    store.freshRows = [detail];
    store.notificationLogs = [];
    db.subscriberEvent.findFirst.mockResolvedValueOnce({ createdAt: new Date("2026-09-28T21:00:00Z") });
    stats = await runScheduledCancels(new Date("2026-09-28T22:00:00Z"));
    expect(stats.noticesSent).toBe(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    // 10 days before: outside the window, nothing.
    store.freshRows = [detail];
    store.notificationLogs = [];
    stats = await runScheduledCancels(new Date("2026-09-20T22:00:00Z"));
    expect(stats.noticesSent).toBe(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("cancels a due contract through the normal service path with the session's reason", async () => {
    store.candidates = [{ id: "c_1" }];
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK },
      { cancelScheduledAt: UNLOCK, status: "ACTIVE" }, // fresh re-read: still scheduled
    ];
    const stats = await runScheduledCancels(new Date("2026-10-01T00:30:00Z"));
    expect(stats.cancelled).toBe(1);
    expect(mocks.cancelContract).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
      "c_1",
      "TOO_EXPENSIVE",
      { source: "CUSTOMER_PORTAL", actor: "customer", cancelSource: "CUSTOMER" },
    );
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cancel.completed",
        payload: expect.objectContaining({ scheduled: true, executedBy: "cancel_scheduled_run", reason: "TOO_EXPENSIVE" }),
      }),
    );
    // The scheduling session settles as CANCELLED (funnel + insights).
    expect(store.claims).toContainEqual(expect.objectContaining({ outcome: "CANCELLED" }));
  });

  it("scans FAILED contracts too (dunning-exhausted before the moment) and reads the KEEP link TTL from settings", async () => {
    store.candidates = [{ id: "c_1" }];
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "FAILED", cancelScheduledAt: UNLOCK },
      { cancelScheduledAt: UNLOCK, status: "FAILED" },
    ];
    const stats = await runScheduledCancels(new Date("2026-10-01T00:30:00Z"));
    expect(stats.cancelled).toBe(1);
    const where = (db.subscriptionContract.findMany.mock.calls[0][0] as { where: { status: { in: string[] } } }).where;
    expect(where.status.in).toEqual(["ACTIVE", "PAUSED", "FAILED"]);
    // TTL: setting, not a constant.
    store.cancelFlow = { ...store.cancelFlow, keepLinkTtlDays: 120 };
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK },
    ];
    await runScheduledCancels(new Date("2026-09-28T22:00:00Z"));
    expect(mocks.buildMagicUrl).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "KEEP_SUBSCRIPTION", ttlSeconds: 120 * 24 * 3600 }),
    );
    expect(settingsSchemas.cancelFlow.parse(undefined).keepLinkTtlDays).toBe(60);
  });

  it("NEVER cancels a contract whose schedule was cleared between the scan and the fresh re-read (race with keep)", async () => {
    store.candidates = [{ id: "c_1" }];
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK },
      { cancelScheduledAt: null, status: "ACTIVE" }, // kept meanwhile
    ];
    const stats = await runScheduledCancels(new Date("2026-10-01T00:30:00Z"));
    expect(stats.cancelled).toBe(0);
    expect(stats.keptSinceScan).toBe(1);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
  });

  it("a contract already CANCELLED (webhook first) is left alone; a future moment does nothing", async () => {
    store.candidates = [{ id: "c_1" }];
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK },
      { cancelScheduledAt: UNLOCK, status: "CANCELLED" },
    ];
    let stats = await runScheduledCancels(new Date("2026-10-01T00:30:00Z"));
    expect(stats.cancelled).toBe(0);
    expect(mocks.cancelContract).not.toHaveBeenCalled();
    store.freshRows = [
      { id: "c_1", customerId: "cust", email: "sub@example.com", locale: "en", status: "ACTIVE", cancelScheduledAt: UNLOCK },
    ];
    stats = await runScheduledCancels(new Date("2026-09-01T00:00:00Z"));
    expect(stats.cancelled).toBe(0);
    expect(stats.noticesSent).toBe(0);
  });
});

describe("billing sweep + live-state clearing (source pins)", () => {
  it("the sweep never bills a contract whose scheduled moment has passed", () => {
    const sweep = src("app/lib/billing/scheduler.server.ts");
    expect(sweep).toContain("OR: [{ cancelScheduledAt: null }, { cancelScheduledAt: { gt: now } }]");
  });

  it("cancelContract, the Shopify-side cancel/reactivation mirror and win-back reactivation clear the column; skip/pause do not", () => {
    const service = src("app/lib/contracts/service.server.ts");
    expect(service).toMatch(/status: "CANCELLED",\s*cancelledAt: new Date\(\),\s*cancelReason: reason,\s*cancelSource,[\s\S]{0,400}cancelScheduledAt: null/);
    const sync = src("app/lib/contracts/sync.server.ts");
    expect((sync.match(/transitions\.cancelScheduledAt = null/g) ?? []).length).toBe(2);
    const winback = src("app/lib/winback/engine.server.ts");
    expect(winback).toMatch(/winbackEligibleAt: null,[\s\S]{0,200}cancelScheduledAt: null/);
    // Skip / pause paths never write the column.
    const skipAndPause = service.slice(service.indexOf("export async function skipNextCycle"), service.indexOf("export async function cancelContract"));
    expect(skipAndPause).not.toContain("cancelScheduledAt");
    // The Shopify mirror clears the column on CANCELLED → ACTIVE only: a
    // FAILED → ACTIVE echo is a payment RECOVERY, not a change of mind — the
    // customer's scheduled end stands (dunning recovery leaves it too).
    expect(sync).toContain('if (prior.status === "CANCELLED") transitions.cancelScheduledAt = null;');
    const dunning = src("app/lib/dunning/engine.server.ts");
    const recovery = dunning.slice(dunning.indexOf("export async function onBillingAttemptSucceeded("), dunning.indexOf('data: { status: "ACTIVE", failedAt: null },'));
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery).not.toContain("cancelScheduledAt: null");
  });

  it("dunning never retries (nor emails) past a scheduled moment; the job cancels FAILED contracts; admin can keep or cancel now", () => {
    const dunning = src("app/lib/dunning/engine.server.ts");
    const retryLoop = dunning.slice(dunning.indexOf("// (a) Fire due retries."), dunning.indexOf("// (c) Exhaust awaiting cases"));
    expect(retryLoop).toContain("kase.contract.cancelScheduledAt.getTime() <= now.getTime()");
    expect(retryLoop.indexOf("cancelScheduledAt")).toBeLessThan(retryLoop.indexOf("await fireRetry("));
    const admin = src("app/routes/app.subscribers.$id.tsx");
    expect(admin).toContain('case "keepScheduled"');
    expect(admin).toContain("keepScheduledCancel(contractId, opts)");
    expect(admin).toContain('submit("keepScheduled")');
    expect(admin).toContain('{c.cancelScheduledAt ? "Cancel now" : "Cancel"}');
    // Portal: the scheduled page's "cancel now" executes only when the lock
    // has lifted (a stale page inside the window changes nothing).
    const index = src("app/routes/proxy.cancel.$id.tsx");
    expect(index).toContain('if (intent === "cancel_now") {');
    expect(index).toContain('if (!contract.cancelScheduledAt || ctx.lock.locked) return redirect(to("scheduled"));');
    expect(index).toContain('await completeCancel(session.id, "customer");');
    const step = src("app/routes/proxy.cancel.$id.$step.tsx");
    expect(step).toContain("canCancelNow: !ctx.lock.locked && !ctx.portalSession.isPreview");
    // requireCancelContext lets a scheduled contract through whatever the
    // toggle says (tests/portal-lock-window.test.ts pins it behaviourally).
    const portal = src("app/lib/cancel/portal.server.ts");
    expect(portal).toContain("if (lock.locked && !contract.cancelScheduledAt) {");
  });
});

describe("KEEP_SUBSCRIPTION magic verb + emails", () => {
  it("is a mutating (throttled, launch-gated) verb that is never lock-blocked, with i18n copy", () => {
    const tokens = src("app/lib/crypto/tokens.server.ts");
    expect(tokens).toContain('| "KEEP_SUBSCRIPTION"');
    const handlers = src("app/lib/magiclinks/handlers.server.ts");
    const mutating = handlers.slice(handlers.indexOf("const MUTATING_MAGIC_ACTIONS"), handlers.indexOf("const LOCKED_MAGIC_ACTIONS"));
    expect(mutating).toContain('"KEEP_SUBSCRIPTION"');
    const lockedSet = handlers.slice(handlers.indexOf("const LOCKED_MAGIC_ACTIONS"), handlers.indexOf("const PREPARING_MAGIC_ACTIONS"));
    expect(lockedSet).not.toContain("KEEP_SUBSCRIPTION");
    expect(handlers).toContain('case "KEEP_SUBSCRIPTION"');
    expect(handlers).toContain("keepScheduledCancel(c.id, MAGIC_OPTS)");
    const dict = en as Record<string, string>;
    for (const key of [
      "magic.confirm.title.KEEP_SUBSCRIPTION",
      "magic.confirm.desc.KEEP_SUBSCRIPTION",
      "magic.keep.done",
      "magic.keep.nothing_scheduled",
      "magic.keep.already_cancelled",
    ]) {
      expect(dict[key], key).toBeTruthy();
    }
  });

  it("cancel_scheduled / cancel_upcoming are registered, catalogued, and copy references the keep link", () => {
    expect(TEMPLATES.cancel_scheduled.klaviyoMetric).toBe("Cellexia Cancellation Scheduled");
    expect(TEMPLATES.cancel_upcoming.klaviyoMetric).toBe("Cellexia Cancellation Upcoming");
    expect(EMAIL_CATALOG.cancel_upcoming.timing).toEqual(
      expect.objectContaining({ settingsKey: "cancelFlow", path: "scheduledCancelNoticeDays" }),
    );
    expect(EMAIL_CATALOG.cancel_scheduled.links).toContain("keep_url");
    const dict = en as Record<string, string>;
    expect(dict["email.cancel_scheduled.body"]).toContain("{keep_url}");
    expect(dict["email.cancel_upcoming.body"]).toContain("{keep_url}");
    expect(dict["email.cancel_upcoming.body"]).toContain("{cancel_date}");
  });
});

describe("portal flow for a locked contract", () => {
  it("requireCancelContext lets locked contracts in when scheduledCancelEnabled and exposes ctx.lock", () => {
    const portal = src("app/lib/cancel/portal.server.ts");
    expect(portal).toContain("scheduledCancelEnabled");
    expect(portal).toContain("if (lock.locked && !scheduledCancelEnabled) {");
    expect(portal).toContain("lock,\n  };");
    const routeStep = src("app/routes/proxy.cancel.$id.$step.tsx");
    expect(routeStep).toContain("if (ctx.lock.locked) {");
    expect(routeStep).toContain("await scheduleCancel(session.id, \"customer\")");
    const routeIntro = src("app/routes/proxy.cancel.$id.tsx");
    expect(routeIntro).toContain('intent === "keep_scheduled"');
    expect(routeIntro).toContain('if (contract.cancelScheduledAt) return redirect(to("scheduled"))');
  });

  it("the intro hides the one-tap pause and states the commitment end; the confirm CTA schedules; the scheduled page keeps", () => {
    const intro = pageIntro({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      firstName: "Anna",
      summary: {
        currencyCode: "CHF",
        nextBillingDate: null,
        nextMilestoneCycle: null,
        ordersToMilestone: 0,
        nextMilestoneAt: null,
      } as never,
      tz: "Europe/Zurich",
      copyVariant: "a",
      pauseMonths: 2,
      showError: false,
      locked: { until: UNLOCK },
    });
    expect(intro.body).not.toContain('name="intent" value="pause"');
    expect(intro.body).toContain("commitment period runs until October 1, 2026");
    expect(intro.body).toContain("Continue to schedule my cancellation");

    const confirm = pageConfirm({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      showError: false,
      scheduled: { date: UNLOCK, tz: "Europe/Zurich" },
    });
    expect(confirm.title).toBe("Schedule your cancellation");
    expect(confirm.body).toContain("Schedule my cancellation for October 1, 2026");
    expect(confirm.body).toContain("continues as agreed until October 1, 2026");
    expect(confirm.body).not.toContain("your subscription ends now");
    // Cancel stays reachable: the CTA is a full-size primary button, and
    // "keep" is the ghost twin — equal weight.
    expect(confirm.body).toContain('class="cxs-btn cxs-btn--full"');
    expect(confirm.body).toContain("Keep my subscription");

    const scheduled = pageScheduled({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      tz: "Europe/Zurich",
      scheduledAt: UNLOCK,
    });
    expect(scheduled.title).toBe("Your subscription cancels on October 1, 2026");
    expect(scheduled.body).toContain('name="intent" value="keep_scheduled"');
    // Still locked: no "cancel now" — the lock refuses an immediate cancel.
    expect(scheduled.body).not.toContain('value="cancel_now"');
    // Lock lifted since scheduling (lockDays lowered / plan changed): the
    // page offers "cancel now instead" — never keep-then-re-enter.
    const unlocked = pageScheduled({
      locale: "en",
      csrf: "tok",
      contractId: "c_1",
      tz: "Europe/Zurich",
      scheduledAt: UNLOCK,
      canCancelNow: true,
    });
    expect(unlocked.body).toContain('name="intent" value="cancel_now"');
    expect(unlocked.body).toContain("Cancel now instead");
    expect(unlocked.body).toContain('name="intent" value="keep_scheduled"');
    const kept = pageScheduled({ locale: "en", csrf: "tok", contractId: "c_1", tz: "Europe/Zurich", scheduledAt: null });
    expect(kept.title).toBe("You're staying — nothing changes");
    expect(kept.body).not.toContain("keep_scheduled");
  });

  it("prepaid contracts get only app-controlled facts on the confirm page (no claim about paid deliveries)", () => {
    const confirm = pageConfirm({ locale: "en", csrf: "tok", contractId: "c_1", showError: false, prepaid: true });
    expect(confirm.body).toContain("no new prepaid term will start");
    expect(confirm.body).not.toContain("No further deliveries will be scheduled");
    expect(confirm.body).not.toMatch(/paid deliveries/i);
  });

  it("reducing saves are hidden for a locked contract and refused at accept; additive ones stay", async () => {
    store.locked = true;
    const c = store.contract as unknown as Parameters<typeof getSavesForReason>[2];
    let offers = await getSavesForReason("shop_1", "TOO_MUCH_PRODUCT", c);
    expect(offers.filter((o) => LOCK_BLOCKED_SAVES.has(o.kind as never))).toHaveLength(0);
    offers = await getSavesForReason("shop_1", "SHIPPING_ISSUES", c);
    expect(offers.map((o) => o.kind)).toEqual(["SUPPORT"]);
    offers = await getSavesForReason("shop_1", "TOO_EXPENSIVE", c);
    expect(offers.map((o) => o.kind)).toEqual(["DISCOUNT"]);

    store.session = sessionFixture({ savesShown: [{ kind: "SKIP", currentNextDate: "x", newNextDate: "y" }] });
    await expect(acceptSave("cs_1", "SKIP", {})).rejects.toThrow(/lock window/);
    expect(store.reverts).toContainEqual(expect.objectContaining({ outcome: null, saveAccepted: null }));
  });
});
