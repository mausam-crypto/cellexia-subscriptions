import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHARGE TIMING (v1.28.0, P2.1) — settings.billing.chargeHourLocal.
 *
 * The sweep used to bill a contract in the first 5-minute run after shop
 * midnight of nextBillingDate. It now bills at/after
 * `shopDayStartUtc(nextBillingDate) + chargeHourLocal` hours, and the SAME
 * instant is the customer's edit cut-off everywhere. Pinned here:
 *
 *  - hour 0 is byte-identical to the old behaviour: `dueBeforeUtc` equals
 *    the old `addDaysTz(shopDayStartUtc(now), 1)` window and `isChargeDue`
 *    equals the old `isDueNow` for every probe;
 *  - hour 6: the REAL runBillingSweep does not bill a contract due today
 *    before 06:00 shop time (neither the candidate window nor the per-
 *    contract check lets it through), bills it at/after 06:00, and an
 *    OVERDUE contract is billed regardless of the hour (overdue handling
 *    untouched);
 *  - the reminder's cut-off vars render the charge moment in the shop tz
 *    ("… until {date}, {time}"), collapsing to "" on failure;
 *  - `isPreparingOrderSync` is truthful about in-flight attempts, the
 *    post-cut-off gap, and dunning-owned cycles.
 *
 * Scaffold: tests/billing-cycle-guard.test.ts (real sweep, mocked seams) plus
 * a settings mock for the new `billing` key.
 */

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  attemptCount: vi.fn(async (): Promise<number> => 0),
  attemptCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "att_new",
    ...args.data,
  })),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
  logEvent: vi.fn(async (_event?: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  })),
  createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  })),
  evaluateStockoutForContract: vi.fn(async (): Promise<unknown> => null),
  ensureGiftsForUpcomingCycle: vi.fn(async (): Promise<void> => {}),
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
  applyGrantToCycle: vi.fn(async (): Promise<boolean> => false),
  onBillingAttemptFailed: vi.fn(async (): Promise<void> => {}),
  billingSetting: { chargeHourLocal: 0 } as Record<string, unknown>,
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "billing") return mocks.billingSetting;
    return {};
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findMany: mocks.contractFindMany,
      update: mocks.contractUpdate,
    },
    billingAttempt: {
      findFirst: mocks.attemptFindFirst,
      count: mocks.attemptCount,
      create: mocks.attemptCreate,
      update: mocks.attemptUpdate,
    },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: mocks.getPrimaryShop,
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  createBillingAttempt: mocks.createBillingAttempt,
}));
vi.mock("~/lib/contracts/stockout.server", () => ({
  evaluateStockoutForContract: mocks.evaluateStockoutForContract,
}));
vi.mock("~/lib/gifts/engine.server", () => ({
  ensureGiftsForUpcomingCycle: mocks.ensureGiftsForUpcomingCycle,
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: mocks.getActiveDiscountForCycle,
  applyGrantToCycle: mocks.applyGrantToCycle,
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onBillingAttemptFailed: mocks.onBillingAttemptFailed,
}));

import { runBillingSweep } from "~/lib/billing/scheduler.server";
import {
  chargeMomentUtcSync,
  dueBeforeUtc,
  editCutoffSync,
  isChargeDue,
  isPreparingOrderSync,
  normalizeChargeHour,
} from "~/lib/billing/timing.server";
import { reminderCutoffVars } from "~/lib/billing/reminders.server";
import {
  addDaysTz,
  formatShopDate,
  formatShopTime,
  isDueNow,
  shopDayStartUtc,
} from "~/lib/dates.server";

const ZURICH = "Europe/Zurich";
const LONDON = "Europe/London";
// Aug 5 2026 in Zurich (CEST, UTC+2): shop midnight = Aug 4 22:00Z.
const AUG5_SHOP_MIDNIGHT = new Date("2026-08-04T22:00:00.000Z");
const AUG5_0500 = new Date("2026-08-05T03:00:00.000Z"); // 05:00 Zurich
const AUG5_0559 = new Date("2026-08-05T03:59:00.000Z");
const AUG5_0600 = new Date("2026-08-05T04:00:00.000Z"); // 06:00 Zurich
const AUG5_0900 = new Date("2026-08-05T07:00:00.000Z");
const AUG4_DUE = new Date("2026-08-04T06:00:00.000Z"); // overdue by a day

function contract(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    shopId: "shop_1",
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    ownership: "OURS",
    status: "ACTIVE",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    currencyCode: "CHF",
    intervalWeeks: 4,
    isPrepaid: false,
    originOrderId: "gid://shopify/Order/1",
    nextBillingDate: AUG5_SHOP_MIDNIGHT,
    lines: [],
    ...over,
  };
}

/** The `where.nextBillingDate.lt` the candidate scan was called with. */
function candidateWindow(): Date {
  const call = mocks.contractFindMany.mock.calls.find((c) => {
    const a = c[0] as { select?: unknown } | undefined;
    return a?.select != null;
  });
  const where = (call![0] as { where: { nextBillingDate: { lt: Date } } }).where;
  return where.nextBillingDate.lt;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.billingSetting = { chargeHourLocal: 0 };
  mocks.getPrimaryShop.mockResolvedValue({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: ZURICH,
  });
  mocks.adminClientForShop.mockResolvedValue({});
  mocks.getBillingCycleByDate.mockResolvedValue({
    cycleIndex: 7,
    skipped: false,
    status: "UNBILLED",
  });
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    ready: true,
  });
  mocks.evaluateStockoutForContract.mockResolvedValue(null);
  mocks.getActiveDiscountForCycle.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptCount.mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("hour 0 is byte-identical to the pre-v1.28 sweep window", () => {
  const probes = [
    "2026-08-05T03:00:00.000Z",
    "2026-08-04T22:00:00.000Z",
    "2026-08-04T21:59:59.000Z",
    "2026-03-29T00:30:00.000Z", // DST switch day (Europe)
    "2026-10-25T00:30:00.000Z",
    "2026-12-31T23:59:59.000Z",
  ].map((s) => new Date(s));

  it("dueBeforeUtc(now) === addDaysTz(shopDayStartUtc(now), 1) in every tz probed", () => {
    for (const tz of [ZURICH, LONDON, "America/New_York", "Asia/Tokyo", "UTC"]) {
      for (const now of probes) {
        expect(dueBeforeUtc(now, { tz, chargeHourLocal: 0 }).toISOString()).toBe(
          addDaysTz(shopDayStartUtc(now, tz), 1, tz).toISOString(),
        );
      }
    }
  });

  it("isChargeDue(hour 0) === isDueNow for every (date, now) pair", () => {
    const dates = probes;
    for (const tz of [ZURICH, LONDON, "America/Los_Angeles"]) {
      for (const d of dates) {
        for (const now of probes) {
          expect(isChargeDue(d, { tz, chargeHourLocal: 0 }, now)).toBe(
            isDueNow(d, tz, now),
          );
        }
      }
    }
  });

  it("chargeMoment(hour 0) is shop midnight; editCutoff is the charge moment; garbage hours mean 0", () => {
    const t0 = { tz: ZURICH, chargeHourLocal: 0 };
    expect(chargeMomentUtcSync(AUG5_0900, t0).toISOString()).toBe(
      AUG5_SHOP_MIDNIGHT.toISOString(),
    );
    expect(editCutoffSync(AUG5_0900, t0).toISOString()).toBe(
      chargeMomentUtcSync(AUG5_0900, t0).toISOString(),
    );
    expect(normalizeChargeHour(undefined)).toBe(0);
    expect(normalizeChargeHour(24)).toBe(0);
    expect(normalizeChargeHour(-1)).toBe(0);
    expect(normalizeChargeHour(6.5)).toBe(0);
    expect(normalizeChargeHour(6)).toBe(6);
  });

  it("the REAL sweep at hour 0 bills a contract due today (unchanged behaviour)", async () => {
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [contract()];
    });
    const stats = await runBillingSweep(AUG5_0500);
    expect(stats.attempted).toBe(1);
    expect(candidateWindow().toISOString()).toBe(
      addDaysTz(shopDayStartUtc(AUG5_0500, ZURICH), 1, ZURICH).toISOString(),
    );
  });
});

describe("chargeHourLocal 6 — nothing bills before 06:00 shop time", () => {
  beforeEach(() => {
    mocks.billingSetting = { chargeHourLocal: 6 };
  });

  it("chargeMoment = shop midnight + 6h; not due at 05:59, due at 06:00", () => {
    const t6 = { tz: ZURICH, chargeHourLocal: 6 };
    expect(chargeMomentUtcSync(AUG5_SHOP_MIDNIGHT, t6).toISOString()).toBe(
      AUG5_0600.toISOString(),
    );
    expect(isChargeDue(AUG5_SHOP_MIDNIGHT, t6, AUG5_0559)).toBe(false);
    expect(isChargeDue(AUG5_SHOP_MIDNIGHT, t6, AUG5_0600)).toBe(true);
    // The candidate window at 05:00 ends at TODAY's shop midnight — today's
    // contracts are outside it; at 06:00 it ends at tomorrow's.
    expect(dueBeforeUtc(AUG5_0500, t6).toISOString()).toBe(
      AUG5_SHOP_MIDNIGHT.toISOString(),
    );
    expect(dueBeforeUtc(AUG5_0600, t6).toISOString()).toBe(
      addDaysTz(AUG5_SHOP_MIDNIGHT, 1, ZURICH).toISOString(),
    );
  });

  it("the REAL sweep at 05:00 does not bill a contract due today — even when the store hands it over", async () => {
    // Belt and braces: the candidate window excludes it AND the per-contract
    // check refuses it (a stale candidate list must not slip through).
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [contract()];
    });
    const stats = await runBillingSweep(AUG5_0500);
    expect(candidateWindow().toISOString()).toBe(AUG5_SHOP_MIDNIGHT.toISOString());
    expect(stats.attempted).toBe(0);
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.getSetting).toHaveBeenCalledWith("shop_1", "billing");
  });

  it("the REAL sweep at 06:00 bills it", async () => {
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [contract()];
    });
    const stats = await runBillingSweep(AUG5_0600);
    expect(stats.attempted).toBe(1);
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
  });

  it("an OVERDUE contract is billed at 05:00 regardless of the hour (overdue handling untouched)", async () => {
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [contract({ nextBillingDate: AUG4_DUE })];
    });
    const stats = await runBillingSweep(AUG5_0500);
    expect(stats.attempted).toBe(1);
  });

  it("a broken settings read degrades to hour 0 — the sweep never stalls", async () => {
    mocks.getSetting.mockImplementationOnce(async () => {
      throw new Error("settings down");
    });
    mocks.contractFindMany.mockImplementation(async (args?: unknown) => {
      const a = args as { select?: unknown } | undefined;
      return a?.select ? [{ id: "c1" }] : [contract()];
    });
    const stats = await runBillingSweep(AUG5_0500);
    expect(stats.attempted).toBe(1);
  });
});

describe("reminder edit cut-off vars", () => {
  it("renders the charge moment as '{date}, {time}' in the shop tz and the composed line", () => {
    const due = new Date("2026-08-19T09:00:00.000Z");
    const timing = { tz: LONDON, chargeHourLocal: 6 };
    const cutoff = editCutoffSync(due, timing);
    // London Aug 19 00:00 BST = Aug 18 23:00Z; + 6h = Aug 19 05:00Z.
    expect(cutoff.toISOString()).toBe("2026-08-19T05:00:00.000Z");
    const vars = reminderCutoffVars("en", due, timing);
    const label = `${formatShopDate(cutoff, LONDON, "en")}, ${formatShopTime(cutoff, LONDON, "en")}`;
    expect(vars.edit_cutoff).toBe(label);
    expect(vars.edit_cutoff).toBe("August 19, 2026, 6:00 AM");
    expect(vars.edit_cutoff_iso).toBe("2026-08-19T05:00:00.000Z");
    expect(vars.edit_cutoff_line).toBe(`You can make changes until ${label}.`);
  });

  it("hour 0: the cut-off is shop midnight of the order day (changes close at the end of the previous day)", () => {
    const due = new Date("2026-08-19T09:00:00.000Z");
    const vars = reminderCutoffVars("en", due, { tz: LONDON, chargeHourLocal: 0 });
    expect(vars.edit_cutoff_iso).toBe("2026-08-18T23:00:00.000Z");
    // v1.29.0: shop midnight is worded as the end of the previous day (the
    // instant is unchanged) — the same string the portal card and hero print.
    expect(vars.edit_cutoff).toBe("August 18, 2026, 11:59 PM");
  });

  it("never throws — a bad timezone collapses the line to empty strings", () => {
    const vars = reminderCutoffVars("en", new Date("2026-08-19T09:00:00.000Z"), {
      tz: "Not/AZone",
      chargeHourLocal: 6,
    });
    expect(vars).toEqual({ edit_cutoff: "", edit_cutoff_iso: "", edit_cutoff_line: "" });
  });
});

describe("isPreparingOrderSync — billing day reached", () => {
  const t6 = { tz: ZURICH, chargeHourLocal: 6 };
  const base = { id: "c1", status: "ACTIVE", nextBillingDate: AUG5_SHOP_MIDNIGHT };

  it("false before the charge moment with no attempt in flight", () => {
    expect(isPreparingOrderSync({ ...base, billingAttempts: [] }, t6, AUG5_0559)).toBe(false);
  });

  it("true after the charge moment while no attempt has claimed the day (the sweep gap)", () => {
    expect(isPreparingOrderSync({ ...base, billingAttempts: [] }, t6, AUG5_0600)).toBe(true);
    // A terminal attempt from an EARLIER cycle does not claim today.
    expect(
      isPreparingOrderSync(
        {
          ...base,
          billingAttempts: [
            { status: "SUCCESS", scheduledFor: new Date("2026-07-08T00:00:00Z"), startedAt: new Date() },
          ],
        },
        t6,
        AUG5_0600,
      ),
    ).toBe(true);
  });

  it("true while a PENDING attempt is in flight (started, or the sweep's un-started SCHEDULER residue) — even before the hour, even after the optimistic pointer advance", () => {
    const started = {
      status: "PENDING",
      originatingAction: "SCHEDULER",
      startedAt: AUG5_0600,
      scheduledFor: AUG5_SHOP_MIDNIGHT,
    };
    expect(
      isPreparingOrderSync(
        { ...base, nextBillingDate: new Date("2026-09-02T00:00:00Z"), billingAttempts: [started] },
        t6,
        AUG5_0900,
      ),
    ).toBe(true);
    const residue = {
      status: "PENDING",
      originatingAction: "SCHEDULER",
      startedAt: null,
      scheduledFor: AUG5_SHOP_MIDNIGHT,
    };
    expect(isPreparingOrderSync({ ...base, billingAttempts: [residue] }, t6, AUG5_0559)).toBe(true);
  });

  it("false for a dunning-owned cycle (newest FAILED / CHALLENGED / EXPIRED for today) and for an un-started dunning retry", () => {
    for (const status of ["FAILED", "CHALLENGED", "EXPIRED"]) {
      expect(
        isPreparingOrderSync(
          {
            ...base,
            billingAttempts: [
              { status, scheduledFor: AUG5_SHOP_MIDNIGHT, startedAt: AUG5_0600, originatingAction: "SCHEDULER" },
            ],
          },
          t6,
          AUG5_0900,
        ),
        status,
      ).toBe(false);
    }
    expect(
      isPreparingOrderSync(
        {
          ...base,
          billingAttempts: [
            { status: "PENDING", originatingAction: "DUNNING_RETRY", startedAt: null, scheduledFor: AUG5_0900 },
          ],
        },
        t6,
        AUG5_0559,
      ),
    ).toBe(false);
  });

  it("superseded rows are invisible; a SUCCESS for today means billed (mirror lag), not preparing", () => {
    expect(
      isPreparingOrderSync(
        {
          ...base,
          billingAttempts: [
            { status: "SUCCESS", scheduledFor: AUG5_SHOP_MIDNIGHT, startedAt: AUG5_0600 },
          ],
        },
        t6,
        AUG5_0900,
      ),
    ).toBe(false);
    expect(
      isPreparingOrderSync(
        {
          ...base,
          billingAttempts: [
            { status: "FAILED", scheduledFor: AUG5_SHOP_MIDNIGHT, startedAt: AUG5_0600, supersededAt: AUG5_0900 },
          ],
        },
        t6,
        AUG5_0900,
      ),
    ).toBe(true);
  });

  it("never true for a non-ACTIVE contract or without a next date", () => {
    expect(isPreparingOrderSync({ ...base, status: "PAUSED", billingAttempts: [] }, t6, AUG5_0900)).toBe(false);
    expect(isPreparingOrderSync({ ...base, nextBillingDate: null, billingAttempts: [] }, t6, AUG5_0900)).toBe(false);
  });
});
