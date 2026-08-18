import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runPauseAutoResume (v1.28.0, P2.6 drift fix): the hourly job hands the
 * contract's own resumeAt to resumeContract as `billOn`, so the first
 * post-hold charge lands on the promised resume day (never +3d, never
 * before). Also pins that the resume reminder's send asks the notifications
 * layer for the pause-controls link bundle (resume_url / extend_pause_url)
 * — via the real reminder vars → sendNotification seam.
 *
 * Scaffold: tests/reminders-card-label.test.ts (real reminders module,
 * mocked seams).
 */

type Row = Record<string, unknown>;

const RESUME_AT = new Date("2026-08-17T00:00:00.000Z");
const NOW = new Date("2026-08-17T00:20:00.000Z");

const mocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  resumeContract: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({})),
  sendNotification: vi.fn(async (_input: unknown): Promise<unknown> => ({
    status: "SENT",
    klaviyoEnqueued: true,
    directEmailSent: false,
  })),
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "pause") return { maxMonths: 3, resumeReminderDaysBefore: 7 };
    if (key === "notifications") {
      return {
        addonSuggestionEnabled: false,
        addonSuggestionVariantId: "",
        upcomingOrderDaysBefore: 3,
      };
    }
    if (key === "portal") return { allowAddProducts: false };
    return {};
  }),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: { findMany: mocks.contractFindMany },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
  },
}));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia-test.myshopify.com",
    ianaTimezone: "Europe/London",
  })),
  requireShop: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock("~/lib/portal/catalog.server", () => ({
  discountedCents: (cents: number, _pct: number) => cents,
  getPortalCatalog: vi.fn(async (): Promise<unknown[]> => []),
  ongoingDiscountPctByProduct: vi.fn(
    async (): Promise<Map<string, number>> => new Map(),
  ),
}));
vi.mock("~/lib/billing/discounts.server", () => ({
  getActiveDiscountForCycle: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  resumeContract: mocks.resumeContract,
}));

import { runPauseAutoResume } from "~/lib/billing/reminders.server";

function pausedContract(over: Row = {}): Row {
  return {
    id: "c_paused",
    shopId: "shop_1",
    status: "PAUSED",
    ownership: "OURS",
    isDemo: false,
    resumeAt: RESUME_AT,
    pausedAt: new Date("2026-07-01T00:00:00Z"),
    locale: "en",
    intervalWeeks: 4,
    intervalUnit: "WEEK",
    intervalCount: 4,
    currencyCode: "GBP",
    lines: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runPauseAutoResume — bills ON the resume day", () => {
  it("passes billOn = the contract's resumeAt (source SYSTEM) to resumeContract for every due hold", async () => {
    mocks.contractFindMany
      .mockResolvedValueOnce([{ id: "c_paused", resumeAt: RESUME_AT }]) // due
      .mockResolvedValueOnce([]); // approaching (reminders)
    const stats = await runPauseAutoResume(NOW);
    expect(stats.resumed).toBe(1);
    expect(mocks.resumeContract).toHaveBeenCalledWith(
      "cellexia-test.myshopify.com",
      "c_paused",
      { source: "SYSTEM", billOn: RESUME_AT },
    );
    // The due query selects resumeAt (the job needs it for billOn).
    const dueArgs = mocks.contractFindMany.mock.calls[0][0] as {
      select?: Record<string, boolean>;
      where: Record<string, unknown>;
    };
    expect(dueArgs.select).toMatchObject({ id: true, resumeAt: true });
    expect(dueArgs.where).toMatchObject({ status: "PAUSED" });
  });

  it("a failing resume is contained (counted, the loop continues)", async () => {
    mocks.contractFindMany
      .mockResolvedValueOnce([
        { id: "c_bad", resumeAt: RESUME_AT },
        { id: "c_ok", resumeAt: RESUME_AT },
      ])
      .mockResolvedValueOnce([]);
    mocks.resumeContract.mockRejectedValueOnce(new Error("shopify down"));
    const stats = await runPauseAutoResume(NOW);
    expect(stats.resumed).toBe(1);
    expect(stats.resumeErrors).toBe(1);
    expect(mocks.resumeContract).toHaveBeenLastCalledWith(
      "cellexia-test.myshopify.com",
      "c_ok",
      { source: "SYSTEM", billOn: RESUME_AT },
    );
  });

  it("the resume reminder still sends resume_date + resume_date_iso (the vars the pause-controls email body renders next to resume_url / extend_pause_url)", async () => {
    const soon = new Date("2026-08-20T00:00:00.000Z");
    mocks.contractFindMany
      .mockResolvedValueOnce([]) // nothing due
      .mockResolvedValueOnce([pausedContract({ resumeAt: soon })]);
    const stats = await runPauseAutoResume(NOW);
    expect(stats.remindersSent).toBe(1);
    const input = mocks.sendNotification.mock.calls[0][0] as {
      template: string;
      vars: Record<string, unknown>;
    };
    expect(input.template).toBe("resume_reminder");
    expect(input.vars.resume_date_iso).toBe(soon.toISOString());
    expect(typeof input.vars.resume_date).toBe("string");
  });

  it("dedupes per RESUME DAY: a reminder sent before the hold was extended does not suppress the reminder for the new day (review fix)", async () => {
    // Reminder for the original day sent Aug 5; the customer extended on
    // Aug 12 (contract.pause_extended); the new resume day is now inside
    // the horizon. The dedupe floor moves to the extension instant, so the
    // Aug 5 row no longer counts as "already reminded".
    const sentAt = new Date("2026-08-05T09:00:00.000Z");
    const extendedAt = new Date("2026-08-12T09:00:00.000Z");
    const newDay = new Date("2026-08-20T00:00:00.000Z");
    mocks.contractFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pausedContract({ resumeAt: newDay })]);
    mocks.subscriberEventFindFirst.mockResolvedValueOnce({ createdAt: extendedAt });
    mocks.notificationLogFindFirst.mockImplementationOnce(
      async (args?: unknown) => {
        const gte = (args as { where: { createdAt: { gte: Date } } }).where.createdAt.gte;
        // The lookup floor must be the extension, not pausedAt (Jul 1).
        expect(gte.toISOString()).toBe(extendedAt.toISOString());
        return sentAt.getTime() >= gte.getTime() ? { id: "n_old" } : null;
      },
    );
    const stats = await runPauseAutoResume(NOW);
    expect(stats.remindersSent).toBe(1);
    expect(mocks.subscriberEventFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contractId: "c_paused", type: "contract.pause_extended" }),
      }),
    );

    // Without an extension, the per-episode floor still dedupes.
    vi.clearAllMocks();
    mocks.contractFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pausedContract({ resumeAt: newDay })]);
    mocks.notificationLogFindFirst.mockResolvedValueOnce({ id: "n_old" });
    const again = await runPauseAutoResume(NOW);
    expect(again.remindersSent).toBe(0);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
