import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";

/**
 * Vacation hold with dates (v1.28.0, P2.6) — contracts service:
 *
 *  - pauseUntil(resumeAt, { reason }): bounds (after today, ≤ pause.maxMonths
 *    × 30 days), shop-tz day-start normalisation, pausedReason enum
 *    (TRAVEL | TOO_MUCH | BUDGET | OTHER | null), contract.paused
 *    { until: true, resumeAt, reason }, idempotent on the same day, refuses
 *    to silently move an existing hold;
 *  - extendPause(newResumeAt): PAUSED only, later only, clamp measured from
 *    pausedAt, no Shopify call, contract.pause_extended { from, to, days };
 *  - resumeContract({ billOn }): the auto-resume job bills ON the promised
 *    resume day (no +3d drift) and never before; "resume now" keeps +3d;
 *  - runPauseAutoResume passes billOn = the contract's resumeAt.
 *
 * Scaffold: tests/aud-contracts-skip-pause-cancel.test.ts (real service
 * module, seams mocked).
 */

const TZ = "Europe/Zurich";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
// 2026-08-17 10:00 Zurich (CEST, UTC+2) = 08:00Z.
const NOW = new Date("2026-08-17T08:00:00.000Z");
/** Shop-tz day start (DST-aware — Zurich is +02:00 in August, +01:00 in November). */
const ZURICH_DAY = (ymd: string) => fromZonedTime(`${ymd}T00:00:00`, TZ);

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: unknown[] },
  pauseSettings: { maxMonths: 3, resumeReminderDaysBefore: 7 },
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  contractPause: vi.fn(async (): Promise<unknown> => ({})),
  contractActivate: vi.fn(async (): Promise<unknown> => ({})),
  setNextBillingDate: vi.fn(
    async (_a: unknown, _g: string, date: Date): Promise<unknown> => ({
      nextBillingDate: date,
    }),
  ),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      Object.assign(store.contract, args.data);
      return store.contract;
    },
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
    },
    billingAttempt: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
    dunningCase: { findFirst: vi.fn(async (): Promise<unknown> => null) },
    contractLine: {
      updateMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: TZ,
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "pause") return store.pauseSettings;
    if (key === "billing") return { chargeHourLocal: 0 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async (): Promise<boolean> => false),
  onCycleDelayed: vi.fn(async (): Promise<boolean> => false),
  onPaymentMethodUpdated: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: mocks.contractActivate,
    contractCancel: vi.fn(),
    contractPause: mocks.contractPause,
    draftLineAdd: vi.fn(),
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftLines: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdateNote: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
    getContract: vi.fn(),
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: vi.fn(),
    withContractDraft: vi.fn(),
  };
});

import {
  PauseUntilError,
  extendPause,
  normalizePauseUntilReason,
  pauseUntil,
  resumeContract,
} from "~/lib/contracts/service.server";

function baseContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    intervalWeeks: 4,
    nextBillingDate: new Date("2026-09-01T00:00:00Z"),
    pausedAt: null,
    resumeAt: null,
    pausedReason: null,
    lines: [],
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; source?: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.contract = baseContract();
  store.pauseSettings = { maxMonths: 3, resumeReminderDaysBefore: 7 };
});
afterEach(() => {
  vi.useRealTimers();
});

describe("pauseUntil — bounds and normalisation", () => {
  it("pauses on Shopify, stores the shop-tz DAY START of the chosen date verbatim (no +3d) and logs contract.paused { until: true }", async () => {
    // Customer picked 2026-09-10 at 15:47 local — the hold ends at that day's start.
    await pauseUntil("cellexia.myshopify.com", "c_1", new Date("2026-09-10T13:47:00Z"), {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      reason: "TRAVEL",
    });

    expect(mocks.contractPause).toHaveBeenCalledWith({}, CONTRACT_GID);
    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.status).toBe("PAUSED");
    expect(data.pausedAt).toEqual(NOW);
    expect(data.resumeAt).toEqual(ZURICH_DAY("2026-09-10"));
    expect(data.pausedReason).toBe("TRAVEL");

    const [paused] = eventsOfType("contract.paused");
    expect(paused.source).toBe("CUSTOMER_PORTAL");
    expect(paused.payload).toMatchObject({
      until: true,
      resumeAt: ZURICH_DAY("2026-09-10").toISOString(),
      reason: "TRAVEL",
    });
    // 24 days → 1 "month" for the analytics stream that reads months.
    expect(paused.payload.months).toBe(1);
  });

  it("refuses a resume day that is today or earlier (RESUME_DATE_PAST) — nothing touches Shopify or the mirror", async () => {
    await expect(
      pauseUntil("cellexia.myshopify.com", "c_1", new Date("2026-08-17T20:00:00Z")),
    ).rejects.toMatchObject({ code: "RESUME_DATE_PAST" });
    await expect(
      pauseUntil("cellexia.myshopify.com", "c_1", new Date("2026-08-01T00:00:00Z")),
    ).rejects.toBeInstanceOf(PauseUntilError);
    expect(mocks.contractPause).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("accepts tomorrow (the earliest hold) and any date up to pause.maxMonths × 30 days; refuses one day beyond with the latest allowed day", async () => {
    await pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-08-18"));
    expect((mocks.contractUpdate.mock.calls[0][0] as { data: { resumeAt: Date } }).data.resumeAt).toEqual(
      ZURICH_DAY("2026-08-18"),
    );

    // maxMonths 3 → 90 days from 2026-08-17 = 2026-11-15.
    store.contract = baseContract();
    mocks.contractUpdate.mockClear();
    await pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-11-15"));
    expect((mocks.contractUpdate.mock.calls[0][0] as { data: { resumeAt: Date } }).data.resumeAt).toEqual(
      ZURICH_DAY("2026-11-15"),
    );

    store.contract = baseContract();
    mocks.contractPause.mockClear();
    const err = await pauseUntil(
      "cellexia.myshopify.com",
      "c_1",
      ZURICH_DAY("2026-11-16"),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PauseUntilError);
    expect((err as PauseUntilError).code).toBe("RESUME_DATE_TOO_FAR");
    expect((err as PauseUntilError).maxResumeAt).toEqual(ZURICH_DAY("2026-11-15"));
    expect(mocks.contractPause).not.toHaveBeenCalled();
  });

  it("the clamp is a SETTING: maxMonths 1 refuses day 31", async () => {
    store.pauseSettings = { maxMonths: 1, resumeReminderDaysBefore: 7 };
    await expect(
      pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-17")),
    ).rejects.toMatchObject({ code: "RESUME_DATE_TOO_FAR" });
    store.contract = baseContract();
    await expect(
      pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-16")),
    ).resolves.toBeTruthy();
  });

  it("reason is an enum-ish string: TRAVEL | TOO_MUCH | BUDGET | OTHER, anything else → null (never invented)", async () => {
    expect(normalizePauseUntilReason("TOO_MUCH")).toBe("TOO_MUCH");
    expect(normalizePauseUntilReason("BUDGET")).toBe("BUDGET");
    expect(normalizePauseUntilReason("OTHER")).toBe("OTHER");
    expect(normalizePauseUntilReason("holiday")).toBeNull();
    expect(normalizePauseUntilReason(undefined)).toBeNull();

    await pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-01"), {
      reason: "not-a-reason",
    });
    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data.pausedReason).toBeNull();
    expect(eventsOfType("contract.paused")[0].payload.reason).toBeNull();
  });

  it("is idempotent on the same resume day (no Shopify call, no event) and refuses to silently MOVE an existing hold", async () => {
    store.contract = baseContract({
      status: "PAUSED",
      pausedAt: NOW,
      resumeAt: ZURICH_DAY("2026-09-10"),
    });
    await pauseUntil("cellexia.myshopify.com", "c_1", new Date("2026-09-10T20:00:00Z"));
    expect(mocks.contractPause).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    await expect(
      pauseUntil("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-20")),
    ).rejects.toMatchObject({ code: "NOT_LATER" });
    expect(mocks.contractPause).not.toHaveBeenCalled();
  });
});

describe("extendPause", () => {
  beforeEach(() => {
    store.contract = baseContract({
      status: "PAUSED",
      pausedAt: new Date("2026-08-01T10:00:00Z"),
      resumeAt: ZURICH_DAY("2026-09-10"),
      pausedReason: "TRAVEL",
    });
  });

  it("moves resumeAt later on the mirror only (no Shopify call — already paused) and logs contract.pause_extended { from, to, days }", async () => {
    await extendPause("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-24"), {
      source: "MAGIC_LINK",
      actor: "customer",
    });
    expect(mocks.contractPause).not.toHaveBeenCalled();
    expect(mocks.contractActivate).not.toHaveBeenCalled();
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    const { data } = mocks.contractUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).toEqual({ resumeAt: ZURICH_DAY("2026-09-24") });
    // pausedReason / pausedAt untouched: same episode.
    expect(store.contract.pausedReason).toBe("TRAVEL");
    const [ev] = eventsOfType("contract.pause_extended");
    expect(ev.source).toBe("MAGIC_LINK");
    expect(ev.payload).toEqual({
      from: ZURICH_DAY("2026-09-10").toISOString(),
      to: ZURICH_DAY("2026-09-24").toISOString(),
      days: 14,
    });
  });

  it("requires PAUSED (NOT_PAUSED) and a LATER day (NOT_LATER); the same day is a no-op", async () => {
    await extendPause("cellexia.myshopify.com", "c_1", new Date("2026-09-10T18:00:00Z"));
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();

    await expect(
      extendPause("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-09-05")),
    ).rejects.toMatchObject({ code: "NOT_LATER" });

    store.contract = baseContract({ status: "ACTIVE" });
    await expect(
      extendPause("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-10-01")),
    ).rejects.toMatchObject({ code: "NOT_PAUSED" });
  });

  it("clamps from pausedAt, not from now: pausedAt 2026-08-01 + 90 days = 2026-10-30 is the latest; one tap at a time cannot extend forever", async () => {
    await extendPause("cellexia.myshopify.com", "c_1", ZURICH_DAY("2026-10-30"));
    expect(store.contract.resumeAt).toEqual(ZURICH_DAY("2026-10-30"));

    const err = await extendPause(
      "cellexia.myshopify.com",
      "c_1",
      ZURICH_DAY("2026-10-31"),
    ).catch((e: unknown) => e);
    expect((err as PauseUntilError).code).toBe("RESUME_DATE_TOO_FAR");
    expect((err as PauseUntilError).maxResumeAt).toEqual(ZURICH_DAY("2026-10-30"));
  });
});

describe("resumeContract — bills ON the resume day (no +3d drift), never before", () => {
  it("auto-resume with billOn = resumeAt still ahead: nextBillingDate IS the resume day (Shopify + mirror agree), contract.resumed carries billOn", async () => {
    const resumeAt = ZURICH_DAY("2026-08-18");
    store.contract = baseContract({
      status: "PAUSED",
      pausedAt: NOW,
      resumeAt,
      pausedReason: "TRAVEL",
    });
    await resumeContract("cellexia.myshopify.com", "c_1", {
      source: "SYSTEM",
      billOn: resumeAt,
    });
    expect(mocks.contractActivate).toHaveBeenCalledWith({}, CONTRACT_GID);
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith({}, CONTRACT_GID, resumeAt);
    expect(store.contract).toMatchObject({
      status: "ACTIVE",
      nextBillingDate: resumeAt,
      pausedAt: null,
      resumeAt: null,
      pausedReason: null,
    });
    const [ev] = eventsOfType("contract.resumed");
    expect(ev.payload).toMatchObject({
      nextBillingDate: resumeAt.toISOString(),
      billOn: resumeAt.toISOString(),
    });
  });

  it("auto-resume running AFTER the resume instant (hourly job / late run): bills at the next sweep with a safe margin (today's charge moment when still ahead, else now + 15 min), never retroactively and never +3d", async () => {
    // Job runs 10:00 Zurich; the hold ended at that day's start (00:00).
    const resumeAt = ZURICH_DAY("2026-08-17");
    store.contract = baseContract({ status: "PAUSED", pausedAt: NOW, resumeAt });
    await resumeContract("cellexia.myshopify.com", "c_1", {
      source: "SYSTEM",
      billOn: resumeAt,
    });
    const target = mocks.setNextBillingDate.mock.calls[0][2] as Date;
    // Charge hour defaults to 00:00 shop time (already passed at 10:00) →
    // now + 15 min: wide enough that Shopify's own clock / one slow round
    // trip cannot turn the date into "in the past" (review fix — a refusal
    // here left Shopify ACTIVE with the mirror still PAUSED).
    expect(target.getTime()).toBe(NOW.getTime() + 15 * 60_000);
    // Same shop day as the promised resume day → charged at that day's
    // charge moment (already passed → next 5-minute sweep).
    expect(target.toISOString().slice(0, 10)).toBe("2026-08-17");
    // And crucially NOT the old drift.
    expect(target.getTime()).toBeLessThan(NOW.getTime() + 3 * 86_400_000);
  });

  it("'resume now' (no billOn — customer / admin / magic RESUME) keeps the quick-return rule: now + 3 days", async () => {
    store.contract = baseContract({
      status: "PAUSED",
      pausedAt: NOW,
      resumeAt: ZURICH_DAY("2026-10-01"),
    });
    await resumeContract("cellexia.myshopify.com", "c_1", {
      source: "MAGIC_LINK",
      actor: "customer",
    });
    const target = mocks.setNextBillingDate.mock.calls[0][2] as Date;
    expect(target).toEqual(new Date("2026-08-20T08:00:00.000Z"));
    expect(eventsOfType("contract.resumed")[0].payload.billOn).toBeNull();
  });

  it("an invalid billOn is ignored (falls back to +3d) — a bad mirror value must never break a resume", async () => {
    store.contract = baseContract({ status: "PAUSED", pausedAt: NOW, resumeAt: null });
    await resumeContract("cellexia.myshopify.com", "c_1", {
      source: "SYSTEM",
      billOn: new Date("not-a-date"),
    });
    const target = mocks.setNextBillingDate.mock.calls[0][2] as Date;
    expect(target).toEqual(new Date("2026-08-20T08:00:00.000Z"));
  });
});
