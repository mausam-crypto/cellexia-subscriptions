/**
 * Retention policy-gate unit tests — pure window math, settings clamping and
 * commitment matching.
 *
 * db.server is mocked so importing the policy module never touches Prisma;
 * the two thin I/O readers exercised here (settings, first-subscription
 * check) run against vi.fn() stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  shopSettings: { findUnique: vi.fn() },
  subscriptionContract: { findFirst: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

import {
  commitmentFromPlanEntries,
  getPauseCancelWindowSettings,
  isFirstSubscriptionForCustomer,
  normalizePauseCancelWindowSettings,
  pauseCancelLockState,
} from "~/services/retention/policy.server";
import type {
  PauseCancelWindowSettings,
  SellingPlanEntryLike,
} from "~/services/retention/policy.server";

const NOW = new Date("2026-07-21T10:00:00.000Z");
const SHOP = "cellexia-demo.myshopify.com";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────── Window settings ──────────────────────────

describe("normalizePauseCancelWindowSettings", () => {
  it("is OFF with 10 days by default", () => {
    expect(normalizePauseCancelWindowSettings(undefined)).toEqual({
      enabled: false,
      days: 10,
    });
    expect(normalizePauseCancelWindowSettings("junk")).toEqual({
      enabled: false,
      days: 10,
    });
    expect(normalizePauseCancelWindowSettings({})).toEqual({
      enabled: false,
      days: 10,
    });
  });

  it("clamps days into [1, 90]", () => {
    expect(normalizePauseCancelWindowSettings({ enabled: true, days: 0 })).toEqual(
      { enabled: true, days: 1 },
    );
    expect(
      normalizePauseCancelWindowSettings({ enabled: true, days: 365 }),
    ).toEqual({ enabled: true, days: 90 });
    expect(
      normalizePauseCancelWindowSettings({ enabled: true, days: 14.9 }),
    ).toEqual({ enabled: true, days: 14 });
  });

  it("falls back to 10 days on non-numeric input and requires enabled === true", () => {
    expect(
      normalizePauseCancelWindowSettings({ enabled: true, days: "soon" }),
    ).toEqual({ enabled: true, days: 10 });
    expect(
      normalizePauseCancelWindowSettings({ enabled: "yes", days: 5 }),
    ).toEqual({ enabled: false, days: 5 });
  });
});

describe("getPauseCancelWindowSettings", () => {
  it("reads settingsJson.minPauseCancelWindow and clamps", async () => {
    db.shopSettings.findUnique.mockResolvedValueOnce({
      settingsJson: JSON.stringify({
        minPauseCancelWindow: { enabled: true, days: 200 },
      }),
    });
    await expect(getPauseCancelWindowSettings(SHOP)).resolves.toEqual({
      enabled: true,
      days: 90,
    });
    expect(db.shopSettings.findUnique).toHaveBeenCalledWith({
      where: { shop: SHOP },
    });
  });

  it("defaults when the row, the key or valid JSON is missing", async () => {
    db.shopSettings.findUnique.mockResolvedValueOnce(null);
    await expect(getPauseCancelWindowSettings(SHOP)).resolves.toEqual({
      enabled: false,
      days: 10,
    });

    db.shopSettings.findUnique.mockResolvedValueOnce({
      settingsJson: "not-json",
    });
    await expect(getPauseCancelWindowSettings(SHOP)).resolves.toEqual({
      enabled: false,
      days: 10,
    });
  });
});

// ─────────────────────────────── Window lock math ─────────────────────────

describe("pauseCancelLockState", () => {
  const enabled: PauseCancelWindowSettings = { enabled: true, days: 10 };
  const anchor = new Date("2026-07-15T00:00:00.000Z"); // unlocks 2026-07-25

  it("locks a first subscription inside the window, with the unlock date", () => {
    const state = pauseCancelLockState({
      anchor,
      isFirst: true,
      settings: enabled,
      now: NOW,
    });
    expect(state.locked).toBe(true);
    expect(state.unlocksAt?.toISOString()).toBe("2026-07-25T00:00:00.000Z");
  });

  it("unlocks exactly at the boundary instant (strictly-in-the-future rule)", () => {
    const unlockInstant = new Date("2026-07-25T00:00:00.000Z");
    expect(
      pauseCancelLockState({
        anchor,
        isFirst: true,
        settings: enabled,
        now: new Date(unlockInstant.getTime() - 1),
      }).locked,
    ).toBe(true);
    expect(
      pauseCancelLockState({
        anchor,
        isFirst: true,
        settings: enabled,
        now: unlockInstant,
      }),
    ).toEqual({ locked: false, unlocksAt: null });
  });

  it("never locks when the policy is disabled", () => {
    expect(
      pauseCancelLockState({
        anchor,
        isFirst: true,
        settings: { enabled: false, days: 10 },
        now: NOW,
      }),
    ).toEqual({ locked: false, unlocksAt: null });
  });

  it("never locks a returning subscriber", () => {
    expect(
      pauseCancelLockState({
        anchor,
        isFirst: false,
        settings: enabled,
        now: NOW,
      }),
    ).toEqual({ locked: false, unlocksAt: null });
  });
});

describe("isFirstSubscriptionForCustomer", () => {
  const contract = {
    id: "c1",
    shopifyCustomerId: "gid://shopify/Customer/123",
    createdAt: NOW,
  };

  it("is true when no earlier contract exists for the customer", async () => {
    db.subscriptionContract.findFirst.mockResolvedValueOnce(null);
    await expect(
      isFirstSubscriptionForCustomer(SHOP, contract),
    ).resolves.toBe(true);
    expect(db.subscriptionContract.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          shop: SHOP,
          shopifyCustomerId: contract.shopifyCustomerId,
          id: { not: "c1" },
          createdAt: { lt: NOW },
        }),
      }),
    );
  });

  it("is false for a returning subscriber (any earlier contract counts)", async () => {
    db.subscriptionContract.findFirst.mockResolvedValueOnce({ id: "older" });
    await expect(
      isFirstSubscriptionForCustomer(SHOP, contract),
    ).resolves.toBe(false);
  });
});

// ─────────────────────────────── Commitment matching ──────────────────────

const PLAN_ENTRIES: SellingPlanEntryLike[] = [
  {
    name: "Every 4 weeks",
    intervalWeeks: 4,
    percentOff: 15,
    shopifyPlanId: "gid://shopify/SellingPlan/100",
  },
  {
    name: "Committed",
    intervalWeeks: 4,
    percentOff: 20,
    shopifyPlanId: "gid://shopify/SellingPlan/200",
    committed: true,
    minDeliveries: 3,
  },
  {
    name: "Committed long",
    intervalWeeks: 8,
    percentOff: 25,
    shopifyPlanId: "gid://shopify/SellingPlan/300",
    minDeliveries: 5, // committed implied by minDeliveries >= 2
  },
  {
    name: "Committed unspecified",
    shopifyPlanId: "gid://shopify/SellingPlan/400",
    committed: true, // no minDeliveries → default 3
  },
];

describe("commitmentFromPlanEntries", () => {
  it("is not committed for flexible plans, unmatched ids or no lines", () => {
    const flexible = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/100"],
      PLAN_ENTRIES,
      1,
    );
    expect(flexible).toEqual({
      committed: false,
      minDeliveries: 0,
      completedDeliveries: 1,
      remainingDeliveries: 0,
      met: true,
    });
    expect(
      commitmentFromPlanEntries(["gid://shopify/SellingPlan/999"], PLAN_ENTRIES, 0)
        .committed,
    ).toBe(false);
    expect(commitmentFromPlanEntries([], PLAN_ENTRIES, 0).committed).toBe(false);
  });

  it("detects a committed plan and reports remaining deliveries", () => {
    const status = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/200"],
      PLAN_ENTRIES,
      1,
    );
    expect(status).toEqual({
      committed: true,
      minDeliveries: 3,
      completedDeliveries: 1,
      remainingDeliveries: 2,
      met: false,
    });
  });

  it("meets the commitment exactly at the threshold", () => {
    expect(
      commitmentFromPlanEntries(["gid://shopify/SellingPlan/200"], PLAN_ENTRIES, 2)
        .met,
    ).toBe(false);
    const met = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/200"],
      PLAN_ENTRIES,
      3,
    );
    expect(met.met).toBe(true);
    expect(met.remainingDeliveries).toBe(0);
  });

  it("treats minDeliveries >= 2 as committed even without the flag, and takes the max across lines", () => {
    const status = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/200", "gid://shopify/SellingPlan/300"],
      PLAN_ENTRIES,
      4,
    );
    expect(status.committed).toBe(true);
    expect(status.minDeliveries).toBe(5); // max(3, 5)
    expect(status.met).toBe(false);
    expect(status.remainingDeliveries).toBe(1);
  });

  it("defaults to 3 deliveries when committed without a minimum", () => {
    const status = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/400"],
      PLAN_ENTRIES,
      0,
    );
    expect(status.minDeliveries).toBe(3);
    expect(status.remainingDeliveries).toBe(3);
  });

  it("matches bare numeric ids against GID plan ids", () => {
    expect(
      commitmentFromPlanEntries(["200"], PLAN_ENTRIES, 0).committed,
    ).toBe(true);
  });

  it("ignores junk entries and junk order counts defensively", () => {
    const status = commitmentFromPlanEntries(
      ["gid://shopify/SellingPlan/200"],
      [
        ...PLAN_ENTRIES,
        null as unknown as SellingPlanEntryLike,
        { committed: true } as SellingPlanEntryLike, // no shopifyPlanId
      ],
      Number.NaN,
    );
    expect(status.completedDeliveries).toBe(0);
    expect(status.committed).toBe(true);
  });
});
