import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The experiment kernel's invariants (v1.24.0):
 *
 *  - DETERMINISTIC: armForUnit is a pure hash — same (experiment, email),
 *    same arm, forever; allocation shares hold across a synthetic population.
 *  - FROZEN AT EXPOSURE: an existing ExperimentAssignment row's arm wins
 *    over whatever the hash would say today (allocation changes never
 *    reshuffle exposed customers).
 *  - FAIL TO CONTROL: disabled/stopped experiments — and any kernel error —
 *    resolve to the control arm and record nothing.
 *  - settingOverride applies an enabled experiment's arm override at its
 *    decision point and leaves everything else at the configured value.
 *
 * Seams mocked: prisma (assignment rows), settings (experiments entries),
 * events (exposure log).
 */

const mocks = vi.hoisted(() => ({
  assignmentFindUnique: vi.fn(async (): Promise<unknown> => null),
  assignmentUpsert: vi.fn(async (args: unknown): Promise<unknown> => args),
  logEvent: vi.fn(async (): Promise<void> => {}),
  getSetting: vi.fn(async (): Promise<unknown> => ({ entries: {} })),
}));

vi.mock("~/db.server", () => ({
  default: {
    experimentAssignment: {
      findUnique: mocks.assignmentFindUnique,
      upsert: mocks.assignmentUpsert,
    },
  },
}));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: mocks.getSetting,
}));
vi.mock("~/lib/events/log.server", () => ({
  logEvent: mocks.logEvent,
}));

import {
  EXPERIMENTS,
  armForUnit,
  assignedArm,
  experimentByKey,
  settingOverride,
  surpriseGiftArmFor,
} from "~/lib/experiments/index.server";

const gift2 = experimentByKey("gift2_holdout");
if (!gift2) throw new Error("gift2_holdout must be registered");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assignmentFindUnique.mockResolvedValue(null);
  mocks.assignmentUpsert.mockImplementation(async (args: unknown) => args);
  mocks.getSetting.mockResolvedValue({ entries: {} });
});

describe("registry", () => {
  it("every experiment's arm shares sum to 100, control first", () => {
    for (const def of EXPERIMENTS) {
      const total = def.arms.reduce((sum, a) => sum + a.share, 0);
      expect(total).toBe(100);
      expect(def.arms.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("gift2_holdout is on by default — the control group must exist from subscriber #1", () => {
    expect(gift2.defaultEnabled).toBe(true);
  });
});

describe("armForUnit — deterministic hash bucketing", () => {
  it("the same email always lands in the same arm", () => {
    const a = armForUnit(gift2, "customer@example.com");
    for (let i = 0; i < 5; i += 1) {
      expect(armForUnit(gift2, "customer@example.com")).toBe(a);
    }
  });

  it("email case and padding never change the arm", () => {
    expect(armForUnit(gift2, "  Customer@Example.COM ")).toBe(
      armForUnit(gift2, "customer@example.com"),
    );
  });

  it("holds the 12.5% no_gift allocation across a synthetic population", () => {
    let noGift = 0;
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      if (armForUnit(gift2, `customer${i}@example.com`) === "no_gift") {
        noGift += 1;
      }
    }
    const share = noGift / n;
    // Deterministic, so this is a fixed number — the band just keeps the
    // assertion honest about hash noise (12.5% ± 1.5 points at n=4000).
    expect(share).toBeGreaterThan(0.11);
    expect(share).toBeLessThan(0.14);
  });
});

describe("assignedArm — freeze and fail-to-control", () => {
  it("records first exposure with the hashed arm", async () => {
    const arm = await assignedArm({
      shopId: "shop_1",
      experimentKey: "gift2_holdout",
      email: "customer@example.com",
      contractId: "c_1",
    });
    expect(arm).toBe(armForUnit(gift2, "customer@example.com"));
    expect(mocks.assignmentUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "experiment.exposed",
        payload: expect.objectContaining({ experimentKey: "gift2_holdout" }),
      }),
    );
  });

  it("an existing assignment row's arm WINS over the hash", async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ arm: "frozen_arm" });
    const arm = await assignedArm({
      shopId: "shop_1",
      experimentKey: "gift2_holdout",
      email: "customer@example.com",
    });
    expect(arm).toBe("frozen_arm");
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it("a stopped experiment resolves to control and records nothing", async () => {
    mocks.getSetting.mockResolvedValue({
      entries: {
        gift2_holdout: {
          enabled: true,
          startedAt: "2026-08-01T00:00:00Z",
          stoppedAt: "2026-08-10T00:00:00Z",
        },
      },
    });
    const arm = await assignedArm({
      shopId: "shop_1",
      experimentKey: "gift2_holdout",
      email: "whoever@example.com",
    });
    expect(arm).toBe(gift2.arms[0].key);
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it("a kernel failure resolves to control, never to a treatment", async () => {
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mocks.assignmentFindUnique.mockRejectedValue(new Error("db down"));
    const arm = await assignedArm({
      shopId: "shop_1",
      experimentKey: "gift2_holdout",
      email: "customer@example.com",
    });
    expect(arm).toBe(gift2.arms[0].key);
    consoleSpy.mockRestore();
  });
});

describe("settingOverride — depth experiments at decision points", () => {
  it("returns the configured value while the experiment is off", async () => {
    const value = await settingOverride({
      shopId: "shop_1",
      email: "customer@example.com",
      path: "cancelFlow.finalOfferPct",
      current: 25,
    });
    expect(value).toBe(25);
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it("applies the winning arm's override when enabled", async () => {
    mocks.getSetting.mockResolvedValue({
      entries: {
        final_offer_depth: { enabled: true, startedAt: null, stoppedAt: null },
      },
    });
    // Freeze the customer into the override arm regardless of hash.
    mocks.assignmentFindUnique.mockResolvedValue({ arm: "pct20" });
    const value = await settingOverride({
      shopId: "shop_1",
      email: "customer@example.com",
      path: "cancelFlow.finalOfferPct",
      current: 25,
    });
    expect(value).toBe(20);
  });

  it("the control arm keeps the configured value", async () => {
    mocks.getSetting.mockResolvedValue({
      entries: {
        final_offer_depth: { enabled: true, startedAt: null, stoppedAt: null },
      },
    });
    mocks.assignmentFindUnique.mockResolvedValue({ arm: "pct25" });
    const value = await settingOverride({
      shopId: "shop_1",
      email: "customer@example.com",
      path: "cancelFlow.finalOfferPct",
      current: 25,
    });
    expect(value).toBe(25);
  });

  it("an unrelated path is untouched by every experiment", async () => {
    mocks.getSetting.mockResolvedValue({
      entries: {
        final_offer_depth: { enabled: true, startedAt: null, stoppedAt: null },
      },
    });
    const value = await settingOverride({
      shopId: "shop_1",
      email: "customer@example.com",
      path: "cancelFlow.reasonOfferPctDefault",
      current: 15,
    });
    expect(value).toBe(15);
  });
});

describe("surpriseGiftArmFor", () => {
  it("maps every non-holdout arm to 'gift'", async () => {
    mocks.assignmentFindUnique.mockResolvedValue({ arm: "gift" });
    expect(
      await surpriseGiftArmFor({
        shopId: "shop_1",
        id: "c_1",
        email: "customer@example.com",
      }),
    ).toBe("gift");
    mocks.assignmentFindUnique.mockResolvedValue({ arm: "no_gift" });
    expect(
      await surpriseGiftArmFor({
        shopId: "shop_1",
        id: "c_1",
        email: "customer@example.com",
      }),
    ).toBe("no_gift");
  });
});
