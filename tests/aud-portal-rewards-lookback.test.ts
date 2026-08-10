import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runRewardsUnlock — an outage must never permanently skip a subscriber.
 *
 * The scan window used to be a fixed 3-day slice of firstChargeAt: any
 * contract whose day-N anniversary crossed during a >3-day outage scrolled
 * out of the window before the job came back and never got
 * lifecycle.rewards_unlocked (no portal rewards strip, no Klaviyo unlock
 * flow) — while the comment claimed downtime could not skip anyone. The
 * lookback now stretches to cover the gap since lifecycle_run's last SUCCESS
 * (JobRun), floored at 3 days; with no run history at all it stays at the
 * floor so a fresh install cannot blast "just unlocked!" at an imported
 * base. The event-existence dedupe is what makes the wider scan safe.
 *
 * Drives the REAL runRewardsUnlock and asserts the firstChargeAt window it
 * queries.
 */

const NOW = new Date("2026-08-09T06:00:00Z");
const TZ = "Europe/Zurich";
const UNLOCK_DAY = 90;

const mocks = vi.hoisted(() => ({
  jobRunFindFirst: vi.fn(async (): Promise<unknown> => null),
  contractFindMany: vi.fn(async (_args?: unknown): Promise<unknown[]> => []),
  subscriberEventFindFirst: vi.fn(async (): Promise<unknown> => null),
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
}));

vi.mock("~/db.server", () => ({
  default: {
    jobRun: { findFirst: mocks.jobRunFindFirst },
    subscriptionContract: { findMany: mocks.contractFindMany },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: TZ,
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({
    surpriseGiftOnCycle2: true,
    milestoneGiftCycle: 6,
    anniversaryGiftDays: 365,
    rewardsUnlockDay: UNLOCK_DAY,
    earlyCycleIncentivesEnabled: true,
  })),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));

import { addDaysTz } from "~/lib/dates.server";
import { runRewardsUnlock } from "~/lib/lifecycle/engine.server";

function queriedWindow(): { gt: Date; lte: Date } {
  const args = mocks.contractFindMany.mock.calls[0]?.[0] as {
    where: { firstChargeAt: { gt: Date; lte: Date } };
  };
  return args.where.firstChargeAt;
}

/** Window width in whole days (tz-aware bounds, so compare instants). */
function windowDays(w: { gt: Date; lte: Date }): number {
  return Math.round((w.lte.getTime() - w.gt.getTime()) / 86_400_000);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobRunFindFirst.mockResolvedValue(null);
  mocks.contractFindMany.mockResolvedValue([]);
});

describe("rewards-unlock lookback follows the job gap", () => {
  it("healthy daily cadence: the 3-day floor applies", async () => {
    mocks.jobRunFindFirst.mockResolvedValue({
      startedAt: new Date(NOW.getTime() - 24 * 3600_000), // ran yesterday
    });

    await runRewardsUnlock(NOW);

    // Only the previous lifecycle_run SUCCESS anchors the window.
    expect(mocks.jobRunFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobName: "lifecycle_run", status: "SUCCESS" },
        orderBy: { startedAt: "desc" },
      }),
    );
    const w = queriedWindow();
    expect(windowDays(w)).toBe(3);
    expect(w.lte).toEqual(addDaysTz(NOW, -UNLOCK_DAY, TZ));
  });

  it("a 10-day outage widens the window to cover the whole gap", async () => {
    mocks.jobRunFindFirst.mockResolvedValue({
      startedAt: new Date(NOW.getTime() - 10 * 24 * 3600_000),
    });

    await runRewardsUnlock(NOW);

    // gap (10) + 1 day of slack — every anniversary that crossed during the
    // outage is back inside the scan; the hasEvent dedupe absorbs overlap.
    expect(windowDays(queriedWindow())).toBe(11);
  });

  it("no run history (fresh install): stays at the floor — no stale unlock blast", async () => {
    mocks.jobRunFindFirst.mockResolvedValue(null);

    await runRewardsUnlock(NOW);

    expect(windowDays(queriedWindow())).toBe(3);
  });

  it("a JobRun read failure falls back to the floor instead of skipping the sweep", async () => {
    mocks.jobRunFindFirst.mockRejectedValue(new Error("db blip"));

    const stats = await runRewardsUnlock(NOW);

    expect(stats.skipped).toBeUndefined();
    expect(windowDays(queriedWindow())).toBe(3);
  });

  it("caught-up contracts still unlock exactly once (dedupe pins the wider window)", async () => {
    mocks.jobRunFindFirst.mockResolvedValue({
      startedAt: new Date(NOW.getTime() - 10 * 24 * 3600_000),
    });
    const firstChargeAt = addDaysTz(NOW, -UNLOCK_DAY - 6, TZ); // crossed mid-outage
    mocks.contractFindMany.mockResolvedValue([
      {
        id: "c_1",
        shopId: "shop_1",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        ordersCount: 4,
        firstChargeAt,
      },
    ]);

    const stats = await runRewardsUnlock(NOW);
    expect(stats.unlocked).toBe(1);
    const unlock = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "lifecycle.rewards_unlocked");
    expect(unlock).toHaveLength(1);

    // Second pass: the event now exists — nothing re-fires.
    mocks.subscriberEventFindFirst.mockResolvedValue({ id: "evt_1" });
    const again = await runRewardsUnlock(NOW);
    expect(again.unlocked).toBe(0);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });
});
