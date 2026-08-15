import { describe, expect, it, vi } from "vitest";

/**
 * Milestone ladder purity (v1.24.0): the goal-gradient hook must never
 * exhaust while rungs remain, and every surface — lifecycle fires, portal
 * countdown, anniversary repeats — must agree on what "the next milestone"
 * means. Pure-function tests over milestoneCycles (lifecycle engine),
 * milestoneRemaining (portal growth) and anniversaryIndexForCycle (gift
 * engine); the modules' impure imports are mocked away.
 */

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/lib/shop/install.server", () => ({
  getPrimaryShop: vi.fn(async () => null),
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: vi.fn(async () => {}),
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async () => ({})),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: vi.fn(async () => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async () => false),
}));
vi.mock("~/lib/gifts/emailLines.server", () => ({
  giftEmailLines: vi.fn(() => ({
    gift_image_line: "",
    gift_worth_line: "",
    gift_date_line: "",
  })),
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  t: vi.fn((_locale: unknown, key: string) => key),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async () => ({})),
  authenticate: {},
}));
vi.mock("~/lib/graphql/index.server", () => ({
  getVariants: vi.fn(async () => []),
  getBillingCycleByDate: vi.fn(async () => null),
}));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async () => null),
}));
vi.mock("~/lib/analytics/alerts.server", () => ({
  raiseAlert: vi.fn(async () => true),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: vi.fn(async () => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async () => false),
}));

import { milestoneCycles } from "~/lib/lifecycle/engine.server";
import { milestoneRemaining } from "~/lib/portal/growth.server";
import { anniversaryIndexForCycle } from "~/lib/gifts/engine.server";

describe("milestoneCycles", () => {
  it("merges the base milestone into the ladder, sorted and deduped", () => {
    expect(
      milestoneCycles({ milestoneGiftCycle: 6, milestoneLadder: [18, 12, 6] }),
    ).toEqual([6, 12, 18]);
  });

  it("an empty ladder degrades to the pre-1.24 single milestone", () => {
    expect(
      milestoneCycles({ milestoneGiftCycle: 6, milestoneLadder: [] }),
    ).toEqual([6]);
  });
});

describe("milestoneRemaining — ladder-aware portal countdown", () => {
  it("counts to the base milestone first", () => {
    expect(milestoneRemaining(2, 6, [12, 18])).toBe(4);
  });

  it("re-anchors to the next rung once the base is passed", () => {
    expect(milestoneRemaining(6, 6, [12, 18])).toBe(6);
    expect(milestoneRemaining(13, 6, [12, 18])).toBe(5);
  });

  it("returns null only when every rung is behind the subscriber", () => {
    expect(milestoneRemaining(18, 6, [12, 18])).toBeNull();
  });

  it("keeps the pre-ladder behavior when no ladder is passed", () => {
    expect(milestoneRemaining(4, 6)).toBe(2);
    expect(milestoneRemaining(6, 6)).toBeNull();
  });
});

describe("anniversaryIndexForCycle — repeating anniversaries", () => {
  const TZ = "Europe/London";
  const contract = (firstChargeAt: string) =>
    ({
      firstChargeAt: new Date(firstChargeAt),
      intervalUnit: "WEEK",
      intervalCount: 8,
      intervalWeeks: 8,
      lines: [],
    }) as never;
  const rule = (daysSubscribed: number, repeatsAnnually: boolean) =>
    ({ trigger: "DAYS_SUBSCRIBED", daysSubscribed, repeatsAnnually }) as never;

  it("matches the first anniversary inside the cycle window", () => {
    // firstChargeAt + 365d = 2027-01-01; cycle bills 2027-01-20 with an
    // 8-week window reaching back before the milestone.
    const k = anniversaryIndexForCycle(
      rule(365, false),
      contract("2026-01-01T10:00:00Z"),
      new Date("2027-01-20T10:00:00Z"),
      TZ,
    );
    expect(k).toBe(1);
  });

  it("a non-repeating rule never matches the second anniversary", () => {
    const k = anniversaryIndexForCycle(
      rule(365, false),
      contract("2026-01-01T10:00:00Z"),
      new Date("2028-01-20T10:00:00Z"),
      TZ,
    );
    expect(k).toBeNull();
  });

  it("a repeating rule matches the second anniversary with k=2", () => {
    const k = anniversaryIndexForCycle(
      rule(365, true),
      contract("2026-01-01T10:00:00Z"),
      new Date("2028-01-20T10:00:00Z"),
      TZ,
    );
    expect(k).toBe(2);
  });

  it("returns null when no milestone falls inside the window", () => {
    const k = anniversaryIndexForCycle(
      rule(365, true),
      contract("2026-01-01T10:00:00Z"),
      new Date("2026-08-01T10:00:00Z"),
      TZ,
    );
    expect(k).toBeNull();
  });
});
