import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Concierge SLA on a minutes/hours promise (v1.29.0) — the default is now
 * "a human replies within 30 minutes, 24/7", so the breach job must reason
 * on the wall clock, not on business days.
 *
 * Pins:
 *  - replyPromiseElapsed: minutes/hours = wall clock (24/7) or Mon–Fri time
 *    only (not 24/7); business_days = the Stage C business-day count;
 *  - the job raises the CRITICAL SUPPORT_SLA_BREACH once the promise is
 *    exceeded — 31 minutes after a 30-minute promise — with an honest
 *    "unanswered for {elapsed}" message and the promise sentence, dedupes on
 *    the request (at most one alert per request however many ticks pass),
 *    and stays quiet inside the promise;
 *  - a not-24/7 hours promise does not count the weekend;
 *  - concierge_sla_run ticks every 10 minutes (an hourly tick would notice
 *    a 30-minute breach up to an hour late);
 *  - the legacy stored slaBusinessDays still drives a business-day check.
 */

const store = vi.hoisted(() => ({
  support: {} as Record<string, unknown>,
  alerts: [] as unknown[],
}));

const mocks = vi.hoisted(() => ({
  raiseAlert: vi.fn(async (_input: unknown): Promise<boolean> => true),
  logEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    alert: { findMany: vi.fn(async (): Promise<unknown[]> => store.alerts) },
    subscriptionContract: { findUnique: vi.fn(async (): Promise<unknown> => null) },
    cancelSession: { updateMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })) },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> =>
    key === "support" ? store.support : {},
  ),
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
}));
vi.mock("~/lib/analytics/alerts.server", () => ({ raiseAlert: mocks.raiseAlert }));

import {
  formatElapsed,
  replyPromiseElapsed,
  runConciergeSla,
  weekdayMsBetween,
} from "~/lib/cancel/scheduled.server";
import type { ReplyPromise } from "~/lib/support/channels.server";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const src = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");
const TZ = "Europe/Zurich";
const MIN = 60_000;
const HOUR = 3_600_000;

const P = (value: number, unit: ReplyPromise["unit"], alwaysOn: boolean): ReplyPromise => ({
  value,
  unit,
  alwaysOn,
});

const requestAlert = (createdAt: Date, over: Record<string, unknown> = {}) => ({
  id: "al_1",
  shopId: "shop_1",
  type: "SUPPORT_REQUEST",
  createdAt,
  resolvedAt: null,
  context: {
    contractId: "c_1",
    cancelSessionId: "cs_1",
    cancelReason: "SHIPPING_ISSUES",
    saveRequest: true,
  },
  ...over,
});

beforeEach(() => {
  store.support = {};
  store.alerts = [];
  mocks.raiseAlert.mockClear();
});

describe("replyPromiseElapsed (pure)", () => {
  it("minutes, 24/7: wall clock — 30 min is kept, 31 min is breached, weekends count", () => {
    const from = new Date("2026-08-15T10:00:00Z"); // Saturday
    const p = P(30, "minutes", true);
    expect(replyPromiseElapsed(from, new Date(from.getTime() + 30 * MIN), TZ, p).breached).toBe(false);
    const late = replyPromiseElapsed(from, new Date(from.getTime() + 31 * MIN), TZ, p);
    expect(late.breached).toBe(true);
    expect(late.elapsedMs).toBe(31 * MIN);
    expect(late.label).toBe("31 min");
  });

  it("hours, 24/7: 2 h is kept, 2 h 1 min is breached", () => {
    const from = new Date("2026-08-17T10:00:00Z"); // Monday
    const p = P(2, "hours", true);
    expect(replyPromiseElapsed(from, new Date(from.getTime() + 2 * HOUR), TZ, p).breached).toBe(false);
    const late = replyPromiseElapsed(from, new Date(from.getTime() + 2 * HOUR + MIN), TZ, p);
    expect(late.breached).toBe(true);
    expect(late.label).toBe("2 h 1 min");
  });

  it("hours, NOT 24/7: Saturday and Sunday do not count against the promise", () => {
    // Friday 17:00 Zurich (15:00Z) → Monday 08:00 Zurich (06:00Z): the only
    // weekday time is Fri 17:00–24:00 (7 h) + Mon 00:00–08:00 (8 h) = 15 h.
    const fri = new Date("2026-08-14T15:00:00Z");
    const mon = new Date("2026-08-17T06:00:00Z");
    expect(weekdayMsBetween(fri, mon, TZ)).toBe(15 * HOUR);
    const notAlways = replyPromiseElapsed(fri, mon, TZ, P(24, "hours", false));
    expect(notAlways.breached).toBe(false);
    expect(notAlways.elapsedMs).toBe(15 * HOUR);
    // The same window IS a breach for a 24/7 promise (63 h on the clock).
    const always = replyPromiseElapsed(fri, mon, TZ, P(24, "hours", true));
    expect(always.breached).toBe(true);
    expect(always.label).toBe("2 d 15 h");
    // Entirely inside the weekend ⇒ nothing elapsed.
    expect(weekdayMsBetween(new Date("2026-08-15T10:00:00Z"), new Date("2026-08-16T10:00:00Z"), TZ)).toBe(0);
    expect(weekdayMsBetween(mon, fri, TZ)).toBe(0);
  });

  it("business_days: the Stage C rule (whole Mon–Fri days in the shop timezone)", () => {
    const wed = new Date("2026-08-12T09:00:00Z");
    const mon = new Date("2026-08-17T10:00:00Z");
    const r = replyPromiseElapsed(wed, mon, TZ, P(2, "business_days", false));
    expect(r.breached).toBe(true);
    expect(r.elapsedBusinessDays).toBe(3);
    expect(r.label).toBe("3 business day(s)");
    expect(
      replyPromiseElapsed(wed, new Date("2026-08-14T09:00:00Z"), TZ, P(2, "business_days", false)).breached,
    ).toBe(false);
  });

  it("formatElapsed is honest at every scale", () => {
    expect(formatElapsed(0)).toBe("0 min");
    expect(formatElapsed(45 * MIN)).toBe("45 min");
    expect(formatElapsed(3 * HOUR + 5 * MIN)).toBe("3 h 5 min");
    expect(formatElapsed(26 * HOUR)).toBe("1 d 2 h");
  });
});

describe("runConciergeSla with the 30-minute 24/7 default", () => {
  it("raises ONE CRITICAL breach 31 minutes in — with the elapsed time and the promise sentence — and never inside the promise", async () => {
    store.support = { replyWithinValue: 30, replyWithinUnit: "minutes", alwaysOn: true };
    const createdAt = new Date("2026-08-15T10:00:00Z"); // Saturday — 24/7 counts it
    store.alerts = [requestAlert(createdAt)];

    const early = await runConciergeSla(new Date(createdAt.getTime() + 25 * MIN));
    expect(early.breaches).toBe(0);
    expect(mocks.raiseAlert).not.toHaveBeenCalled();

    const late = await runConciergeSla(new Date(createdAt.getTime() + 31 * MIN));
    expect(late.breaches).toBe(1);
    expect(mocks.raiseAlert).toHaveBeenCalledTimes(1);
    const call = mocks.raiseAlert.mock.calls[0][0] as unknown as {
      type: string;
      severity: string;
      message: string;
      context: Record<string, unknown>;
      dedupe: Record<string, unknown>;
    };
    expect(call.type).toBe("SUPPORT_SLA_BREACH");
    expect(call.severity).toBe("CRITICAL");
    expect(call.message).toContain("unanswered for 31 min");
    expect(call.message).toContain("A human replies within 30 minutes, 24/7.");
    expect(call.message).toContain("/app/subscribers/c_1");
    expect(call.context).toEqual(
      expect.objectContaining({
        contractId: "c_1",
        requestAlertId: "al_1",
        cancelSessionId: "cs_1",
        replyWithin: { value: 30, unit: "minutes", alwaysOn: true },
        elapsedMs: 31 * MIN,
        elapsedLabel: "31 min",
      }),
    );
    expect(call.context).not.toHaveProperty("elapsedBusinessDays");
    // At most once per request: the dedupe key is the request alert.
    expect(call.dedupe).toEqual(expect.objectContaining({ key: "requestAlertId", value: "al_1" }));

    // A later tick still asks raiseAlert (which dedupes) — and reports no new
    // breach when raiseAlert says it was already raised.
    mocks.raiseAlert.mockResolvedValueOnce(false);
    const again = await runConciergeSla(new Date(createdAt.getTime() + 3 * HOUR));
    expect(again.breaches).toBe(0);
  });

  it("an hours promise that is not 24/7 stays quiet over the weekend and fires on Monday", async () => {
    store.support = { replyWithinValue: 4, replyWithinUnit: "hours", alwaysOn: false };
    // Fri 20:00 Zurich: 4 h of Friday remain — exactly the promise, not over.
    store.alerts = [requestAlert(new Date("2026-08-14T18:00:00Z"))];
    const sunday = await runConciergeSla(new Date("2026-08-16T12:00:00Z"));
    expect(sunday.breaches).toBe(0); // 4 h Fri evening = exactly the promise, not over
    const monday = await runConciergeSla(new Date("2026-08-17T06:30:00Z")); // Mon 08:30 Zurich
    expect(monday.breaches).toBe(1);
    const call = mocks.raiseAlert.mock.calls[0][0] as unknown as { message: string };
    expect(call.message).toContain("unanswered for 12 h 30 min");
    // The not-24/7 sentence NAMES business days — the customer never reads a
    // stronger promise than the weekday-only clock the job enforces.
    expect(call.message).toContain("A human replies within 4 hours on business days.");
  });

  it("judges each request against the promise the customer READ (alert context), not the current setting", async () => {
    // Recorded at submit time: 30 minutes 24/7. The merchant then loosens the
    // setting to 2 business days — the customer's broken promise must still
    // surface 31 minutes in.
    store.support = { replyWithinValue: 2, replyWithinUnit: "business_days", alwaysOn: false };
    const createdAt = new Date("2026-08-17T08:00:00Z"); // Monday
    store.alerts = [
      requestAlert(createdAt, {
        context: {
          contractId: "c_1",
          cancelSessionId: "cs_1",
          saveRequest: true,
          replyWithin: { value: 30, unit: "minutes", alwaysOn: true },
        },
      }),
    ];
    const late = await runConciergeSla(new Date(createdAt.getTime() + 31 * MIN));
    expect(late.breaches).toBe(1);
    const call = mocks.raiseAlert.mock.calls[0][0] as unknown as {
      message: string;
      context: Record<string, unknown>;
    };
    expect(call.message).toContain("A human replies within 30 minutes, 24/7.");
    expect(call.context).toEqual(
      expect.objectContaining({ replyWithin: { value: 30, unit: "minutes", alwaysOn: true } }),
    );

    // Reverse: recorded as 2 business days, setting tightened to 30 minutes
    // — no CRITICAL alert for a customer who was promised days.
    mocks.raiseAlert.mockClear();
    store.support = { replyWithinValue: 30, replyWithinUnit: "minutes", alwaysOn: true };
    store.alerts = [
      requestAlert(createdAt, {
        context: {
          contractId: "c_1",
          saveRequest: true,
          replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
        },
      }),
    ];
    expect((await runConciergeSla(new Date(createdAt.getTime() + 3 * HOUR))).breaches).toBe(0);
    expect(mocks.raiseAlert).not.toHaveBeenCalled();
    // Three business days later it fires against the recorded promise.
    expect((await runConciergeSla(new Date("2026-08-20T10:00:00Z"))).breaches).toBe(1);

    // A malformed / missing recorded promise (pre-1.29.0 rows) falls back to
    // the current setting.
    mocks.raiseAlert.mockClear();
    store.alerts = [requestAlert(createdAt, { context: { contractId: "c_1", saveRequest: true, replyWithin: "x" } })];
    expect((await runConciergeSla(new Date(createdAt.getTime() + 31 * MIN))).breaches).toBe(1);
  });

  it("submitSupportRequest records the promise on the request alert (source pin)", () => {
    const req = src("app/lib/support/request.server.ts");
    expect(req).toContain("replyWithin: channels.replyWithin,");
    expect(req).toContain("...(extra.replyWithin ? { replyWithin: extra.replyWithin } : {}),");
    const job = src("app/lib/cancel/scheduled.server.ts");
    expect(job).toContain("readReplyPromise(ctx.replyWithin) ?? currentPromise");
  });

  it("a legacy stored slaBusinessDays still runs the business-day check", async () => {
    store.support = { slaBusinessDays: 2 };
    store.alerts = [requestAlert(new Date("2026-08-12T09:00:00Z"))]; // Wednesday
    expect((await runConciergeSla(new Date("2026-08-14T09:00:00Z"))).breaches).toBe(0);
    expect((await runConciergeSla(new Date("2026-08-17T10:00:00Z"))).breaches).toBe(1);
    const call = mocks.raiseAlert.mock.calls[0][0] as unknown as {
      message: string;
      context: Record<string, unknown>;
    };
    expect(call.message).toContain("unanswered for 3 business day(s)");
    expect(call.message).toContain("A human replies within 2 business days.");
    expect(call.context).toEqual(
      expect.objectContaining({
        replyWithin: { value: 2, unit: "business_days", alwaysOn: false },
        elapsedBusinessDays: 3,
      }),
    );
  });

  it("an unreadable support setting falls back to the 30-minute default (never silence)", async () => {
    store.support = null as unknown as Record<string, unknown>;
    store.alerts = [requestAlert(new Date("2026-08-17T08:00:00Z"))];
    expect((await runConciergeSla(new Date("2026-08-17T08:45:00Z"))).breaches).toBe(1);
  });
});

describe("cadence", () => {
  it("concierge_sla_run ticks every 10 minutes", () => {
    const runner = src("app/lib/jobs/runner.server.ts");
    expect(runner).toMatch(/name: "concierge_sla_run",\s*everyMinutes: 10/);
  });
});
