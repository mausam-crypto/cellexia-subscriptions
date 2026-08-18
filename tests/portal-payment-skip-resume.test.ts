import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Skip that order and continue from {date}" (v1.28.0, P1.9) —
 * skipFailedCycleAndResume, the case-aware exit for a FAILED (dunning-
 * exhausted) contract behind the portal verb payment_skip_and_resume and the
 * SKIP_FAILED_CYCLE magic link — plus the banner CTA and the toast keys.
 *
 *  - held cycle = the newest EXHAUSTED case's trigger-attempt cycle; Shopify
 *    skip on it (idempotent), contractActivate, mirror ACTIVE with
 *    failedAt/consecutiveFailures cleared, next date = first cycle date
 *    after the held one still ahead (explicitly set when Shopify's is not);
 *  - the case gets resolution CUSTOMER_SKIPPED; a re-armed open case goes
 *    through the engine's onCycleSkipped; terminal attempts are released;
 *  - events: cycle.skipped {initiator CUSTOMER, reason skip_failed_cycle},
 *    contract.activated {reason skip_failed_cycle}, dunning.case_closed,
 *    portal.payment_skip_resume {outcome} on every call;
 *  - refusals: hard-dead card (revoked / expired / none), attempt in flight,
 *    not FAILED, no case, cycle already BILLED — nothing touches Shopify;
 *  - computeSkipResumeDate never returns the held date or a past date;
 *  - banner: the CTA renders only for EXHAUSTED + FAILED + a resume date.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractFindUniqueOrThrow: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  requireShop: vi.fn(async (): Promise<unknown> => null),
  contractActivate: vi.fn(async (): Promise<void> => {}),
  skipBillingCycle: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  setNextBillingDate: vi.fn(
    async (_a: unknown, _g: string, date: Date): Promise<unknown> => ({
      contractId: "gid",
      nextBillingDate: date,
    }),
  ),
  getContract: vi.fn(async (): Promise<unknown> => ({ nextBillingDate: null })),
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 2),
  onCycleSkipped: vi.fn(async (): Promise<boolean> => true),
  contractLineUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 0 })),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: mocks.contractFindUnique,
      update: mocks.contractUpdate,
      findUniqueOrThrow: mocks.contractFindUniqueOrThrow,
    },
    dunningCase: {
      findFirst: mocks.dunningCaseFindFirst,
      updateMany: mocks.dunningCaseUpdateMany,
    },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findFirst: mocks.attemptFindFirst,
    },
    contractLine: { updateMany: mocks.contractLineUpdateMany },
  },
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/shop/install.server", () => ({ requireShop: mocks.requireShop }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  contractActivate: mocks.contractActivate,
  skipBillingCycle: mocks.skipBillingCycle,
  getBillingCycleByIndex: mocks.getBillingCycleByIndex,
  getBillingCycleByDate: mocks.getBillingCycleByDate,
  setNextBillingDate: mocks.setNextBillingDate,
  getContract: mocks.getContract,
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: mocks.releaseHeldCycleAttempts,
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: mocks.onCycleSkipped,
}));

import {
  cardHardDeadReason,
  computeSkipResumeDate,
  skipFailedCycleAndResume,
} from "~/lib/dunning/skip-resume.server";
import { dunningBannerHtml } from "~/lib/portal/dunning-banner.server";
import type { PortalDunningView } from "~/lib/portal/dunning.server";
import { TOAST_ALERT_KEYS, TOAST_KEYS } from "~/lib/portal/layout.server";
import { t } from "~/lib/i18n/i18n.server";

const NOW = new Date("2026-08-17T10:00:00.000Z");
const HELD = new Date("2026-07-20T08:00:00.000Z"); // 4 weeks before "now" (weekly plan → past dates)
const OPENED = new Date("2026-07-20T08:05:00.000Z");
const EXHAUSTED_AT = new Date("2026-08-10T08:00:00.000Z");
const TZ = "Europe/Zurich";

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: TZ,
  currencyCode: "CHF",
};

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_c1",
    shopId: SHOP.id,
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    status: "FAILED",
    ownership: "OURS",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    locale: "en",
    currencyCode: "CHF",
    intervalWeeks: 1,
    billingIntervalUnit: "WEEK",
    billingIntervalCount: 1,
    nextBillingDate: HELD,
    paymentMethodId: "pm_main",
    paymentMethodRevokedAt: null,
    cardBrand: "Visa",
    cardLast4: "4242",
    cardExpiryMonth: 12,
    cardExpiryYear: 2030,
    consecutiveFailures: 4,
    failedAt: EXHAUSTED_AT,
    lines: [],
    ...over,
  };
}

function caseFixture(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    state: "EXHAUSTED",
    openedAt: OPENED,
    resolvedAt: EXHAUSTED_AT,
    resolution: "EXHAUSTED",
    triggerAttemptId: "att_1",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    nextRetryAt: null,
    ...over,
  };
}

const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer", now: NOW };

function eventTypes(): string[] {
  return mocks.logEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
}
function eventOf(type: string): Record<string, unknown> | undefined {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireShop.mockResolvedValue(SHOP);
  mocks.contractFindUnique.mockResolvedValue(contractFixture());
  mocks.contractFindUniqueOrThrow.mockResolvedValue(contractFixture({ status: "ACTIVE" }));
  // findFirst is called for the EXHAUSTED case first, then for an OPEN one.
  mocks.dunningCaseFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { state?: unknown } }).where;
    if (where.state === "EXHAUSTED") return caseFixture();
    return null;
  });
  mocks.attemptFindUnique.mockResolvedValue({ cycleIndex: 7, scheduledFor: HELD });
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.getBillingCycleByIndex.mockResolvedValue({
    cycleIndex: 7,
    billingAttemptExpectedDate: HELD,
    skipped: false,
    edited: false,
    status: "UNBILLED",
  });
  mocks.getContract.mockResolvedValue({ nextBillingDate: null });
  mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 1 });
});

describe("computeSkipResumeDate", () => {
  const weekly = { unit: "WEEK" as const, count: 1 };

  it("returns the cycle right after the held one when it is still ahead", () => {
    const held = new Date("2026-08-15T08:00:00.000Z");
    const d = computeSkipResumeDate({ heldDate: held, frequency: weekly, tz: TZ, now: NOW });
    expect(d.toISOString()).toBe("2026-08-22T08:00:00.000Z");
  });

  it("steps past every date already in the past (a weekly plan exhausted weeks ago)", () => {
    const d = computeSkipResumeDate({ heldDate: HELD, frequency: weekly, tz: TZ, now: NOW });
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    expect(d.toISOString()).toBe("2026-08-24T08:00:00.000Z");
    // never the held date, never a date <= now
    expect(d.getTime()).not.toBe(HELD.getTime());
  });

  it("monthly plans step by calendar month in the shop timezone", () => {
    const d = computeSkipResumeDate({
      heldDate: new Date("2026-05-31T07:00:00.000Z"),
      frequency: { unit: "MONTH", count: 1 },
      tz: TZ,
      now: NOW,
    });
    expect(d.getTime()).toBeGreaterThan(NOW.getTime());
    // 3 months FROM THE ANCHOR (May 31 → Aug 31), not iterated (→ Aug 30 drift)
    expect(d.toISOString().slice(0, 10)).toBe("2026-08-31");
  });
});

describe("cardHardDeadReason", () => {
  it("revoked / expired / no method are hard-dead; a live card is not", () => {
    const base = contractFixture();
    expect(cardHardDeadReason(base as never, NOW, TZ)).toBeNull();
    expect(cardHardDeadReason({ ...base, paymentMethodId: null } as never, NOW, TZ)).toBe("no_card");
    expect(
      cardHardDeadReason({ ...base, paymentMethodRevokedAt: new Date() } as never, NOW, TZ),
    ).toBe("card_revoked");
    expect(
      cardHardDeadReason({ ...base, cardExpiryMonth: 7, cardExpiryYear: 2026 } as never, NOW, TZ),
    ).toBe("card_expired");
    // Expiring at the end of the current month is still alive today.
    expect(
      cardHardDeadReason({ ...base, cardExpiryMonth: 8, cardExpiryYear: 2026 } as never, NOW, TZ),
    ).toBeNull();
  });
});

describe("skipFailedCycleAndResume — happy path", () => {
  it("skips the held cycle on Shopify, activates, clears the failure state and resolves the case", async () => {
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") return;
    expect(outcome.cycleIndex).toBe(7);
    expect(outcome.caseId).toBe("case_1");

    // Shopify: skip the case's cycle BY INDEX (never the mirror's next date), then activate.
    expect(mocks.skipBillingCycle).toHaveBeenCalledWith({}, "gid://shopify/SubscriptionContract/1", {
      index: 7,
    });
    expect(mocks.contractActivate).toHaveBeenCalledWith({}, "gid://shopify/SubscriptionContract/1");
    const skipOrder = mocks.skipBillingCycle.mock.invocationCallOrder[0];
    const activateOrder = mocks.contractActivate.mock.invocationCallOrder[0];
    expect(skipOrder).toBeLessThan(activateOrder);

    // Shopify's next date was unknown → set explicitly to the computed resume date (ahead of now).
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    const setDate = mocks.setNextBillingDate.mock.calls[0][2] as Date;
    expect(setDate.getTime()).toBeGreaterThan(NOW.getTime());
    expect(setDate.toISOString()).toBe("2026-08-24T08:00:00.000Z");
    expect(outcome.nextBillingDate.toISOString()).toBe("2026-08-24T08:00:00.000Z");

    // Mirror: ACTIVE, recovery-path clears, honest customer skip.
    const update = mocks.contractUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data).toMatchObject({
      status: "ACTIVE",
      failedAt: null,
      consecutiveFailures: 0,
      nextBillingDate: setDate,
      skipCount: { increment: 1 },
    });

    // Case: resolution CUSTOMER_SKIPPED on the EXHAUSTED case only.
    const caseUpdate = mocks.dunningCaseUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(caseUpdate.where).toMatchObject({ id: "case_1", state: "EXHAUSTED" });
    expect(caseUpdate.data).toMatchObject({ resolution: "CUSTOMER_SKIPPED" });

    // Reactivation entry point: the closed episode's terminal attempts are released.
    expect(mocks.releaseHeldCycleAttempts).toHaveBeenCalledWith("cm_c1");
    // No open case → the engine's reconciliation is not needed.
    expect(mocks.onCycleSkipped).not.toHaveBeenCalled();

    // Events.
    const types = eventTypes();
    expect(types).toEqual(
      expect.arrayContaining([
        "cycle.skipped",
        "contract.activated",
        "dunning.case_closed",
        "portal.payment_skip_resume",
      ]),
    );
    expect(eventOf("cycle.skipped")?.payload).toMatchObject({
      cycleIndex: 7,
      initiator: "CUSTOMER",
      reason: "skip_failed_cycle",
    });
    expect(eventOf("cycle.skipped")?.source).toBe("CUSTOMER_PORTAL");
    expect(eventOf("contract.activated")?.payload).toMatchObject({
      reason: "skip_failed_cycle",
      dunningCaseId: "case_1",
    });
    expect(eventOf("dunning.case_closed")?.payload).toMatchObject({
      resolution: "CUSTOMER_SKIPPED",
    });
    expect(eventOf("portal.payment_skip_resume")?.payload).toMatchObject({ outcome: "resumed" });
  });

  it("is idempotent on Shopify: an already-skipped held cycle is not skipped again", async () => {
    mocks.getBillingCycleByIndex.mockResolvedValue({
      cycleIndex: 7,
      billingAttemptExpectedDate: HELD,
      skipped: true,
      edited: false,
      status: "UNBILLED",
    });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.skipBillingCycle).not.toHaveBeenCalled();
    expect(mocks.contractActivate).toHaveBeenCalledTimes(1);
  });

  it("keeps Shopify's own next date when it already lands on the promised day (no needless re-anchor)", async () => {
    // Same shop day as the computed resume date (24 Aug), Shopify's own time-of-day.
    const shopifyNext = new Date("2026-08-24T10:30:00.000Z");
    mocks.getContract.mockResolvedValue({ nextBillingDate: shopifyNext });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    if (outcome.kind === "resumed") {
      expect(outcome.nextBillingDate.getTime()).toBe(shopifyNext.getTime());
    }
  });

  it("sets the PROMISED resume date when Shopify's own date is ahead but on a different day (aud-v128: banner label === outcome)", async () => {
    // Banner / parked email / confirm page said "continue from 24 August"
    // (computeSkipResumeDate); Shopify's contract carries 31 Aug. The verb
    // must keep the promise, not silently resume a week later.
    const shopifyNext = new Date("2026-08-31T08:00:00.000Z");
    mocks.getContract.mockResolvedValue({ nextBillingDate: shopifyNext });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    const setDate = mocks.setNextBillingDate.mock.calls[0][2] as Date;
    expect(setDate.toISOString()).toBe("2026-08-24T08:00:00.000Z");
    if (outcome.kind === "resumed") {
      expect(outcome.nextBillingDate.toISOString()).toBe("2026-08-24T08:00:00.000Z");
    }
  });

  it("reconciles stale per-line cycle edits like every other schedule mover (Stage G review fix): flags below the upcoming cycle are nulled", async () => {
    // Shopify's cycle at the effective next date is known → clear below it.
    mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 9, billingAttemptExpectedDate: null });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    const wheres = (mocks.contractLineUpdateMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>).map((c) => c[0].where);
    expect(wheres).toEqual([
      { contractId: "cm_c1", skippedCycleIndex: { lt: 9 } },
      { contractId: "cm_c1", cycleQuantityOverrideIndex: { lt: 9 } },
    ]);

    // Lookup fails / unknown → at least the held cycle (7) is gone: clear below held+1.
    vi.clearAllMocks();
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.contractFindUniqueOrThrow.mockResolvedValue(contractFixture());
    mocks.dunningCaseFindFirst.mockImplementation(async (a?: unknown) => {
      const w = (a as { where: Record<string, unknown> }).where;
      return w.state === "EXHAUSTED" ? caseFixture() : null;
    });
    mocks.getBillingCycleByIndex.mockResolvedValue({ cycleIndex: 7, status: "UNBILLED", skipped: false, billingAttemptExpectedDate: HELD });
    mocks.getBillingCycleByDate.mockRejectedValue(new Error("shopify"));
    mocks.getContract.mockResolvedValue({ nextBillingDate: null });
    const outcome2 = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome2.kind).toBe("resumed");
    const wheres2 = (mocks.contractLineUpdateMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>).map((c) => c[0].where);
    expect(wheres2).toEqual([
      { contractId: "cm_c1", skippedCycleIndex: { lt: 8 } },
      { contractId: "cm_c1", cycleQuantityOverrideIndex: { lt: 8 } },
    ]);
    mocks.getBillingCycleByDate.mockResolvedValue(null);
  });

  it("sets the date explicitly when Shopify's next date lies in the past — BEFORE activation (no ACTIVE + past-date window for the sync / sweep); after it only when Shopify refused the early set", async () => {
    mocks.getContract.mockResolvedValue({ nextBillingDate: new Date("2026-07-27T08:00:00.000Z") });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(1);
    expect(mocks.setNextBillingDate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.contractActivate.mock.invocationCallOrder[0],
    );

    vi.clearAllMocks();
    mocks.setNextBillingDate.mockRejectedValueOnce(new Error("contract is not active"));
    const again = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(again.kind).toBe("resumed");
    expect(mocks.setNextBillingDate).toHaveBeenCalledTimes(2);
    expect(mocks.setNextBillingDate.mock.invocationCallOrder[1]).toBeGreaterThan(
      mocks.contractActivate.mock.invocationCallOrder[0],
    );
    if (again.kind === "resumed") expect(again.nextBillingDate.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("closes a re-armed open case through the engine's own onCycleSkipped reconciliation", async () => {
    mocks.dunningCaseFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { state?: unknown } }).where;
      if (where.state === "EXHAUSTED") return null; // reopened in place by a "Retry now" that did not fire
      return caseFixture({ id: "case_1", state: "RETRYING", resolvedAt: null, resolution: null });
    });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.onCycleSkipped).toHaveBeenCalledWith("cm_c1", 7, "CUSTOMER_PORTAL");
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
  });

  it("two CONCURRENT calls (double tap / second tab): one skip, one activate, one cycle.skipped — the second lands on already_active (Stage G review fix)", async () => {
    // Stateful mirror: the first run's mirror write flips status to ACTIVE,
    // and the serialized second run re-reads that.
    const row: Record<string, unknown> = contractFixture();
    mocks.contractFindUnique.mockImplementation(async () => row);
    mocks.contractFindUniqueOrThrow.mockImplementation(async () => row);
    mocks.contractUpdate.mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      if (data.status) row.status = data.status;
      return row;
    });
    const [a, b] = await Promise.all([
      skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS),
      skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["already_active", "resumed"]);
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
    expect(mocks.contractActivate).toHaveBeenCalledTimes(1);
    expect(eventTypes().filter((t) => t === "cycle.skipped")).toHaveLength(1);
    expect(eventTypes().filter((t) => t === "contract.activated")).toHaveLength(1);
    // Reset the stateful mocks for the following tests.
    mocks.contractFindUnique.mockImplementation(async () => contractFixture());
    mocks.contractFindUniqueOrThrow.mockImplementation(async () => contractFixture({ status: "ACTIVE" }));
    mocks.contractUpdate.mockImplementation(async (args: unknown) => args);
  });

  it("a half-applied earlier run (Shopify already ACTIVE, mirror still FAILED): activate's refusal is tolerated and the run completes", async () => {
    mocks.contractActivate.mockRejectedValueOnce(new Error("Subscription contract is already active"));
    mocks.getContract.mockResolvedValue({ status: "ACTIVE", nextBillingDate: null });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    // A real refusal (Shopify NOT active) still surfaces.
    mocks.contractActivate.mockRejectedValueOnce(new Error("cannot activate"));
    mocks.getContract.mockResolvedValue({ status: "FAILED", nextBillingDate: null });
    await expect(skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS)).rejects.toThrow("cannot activate");
    mocks.getContract.mockResolvedValue({ nextBillingDate: null });
  });

  it("legacy case without a trigger attempt: the held cycle is the one at the mirror's next date", async () => {
    mocks.dunningCaseFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { state?: unknown } }).where;
      return where.state === "EXHAUSTED" ? caseFixture({ triggerAttemptId: null }) : null;
    });
    mocks.getBillingCycleByDate.mockResolvedValue({
      cycleIndex: 3,
      billingAttemptExpectedDate: HELD,
      skipped: false,
      edited: false,
      status: "UNBILLED",
    });
    mocks.getBillingCycleByIndex.mockResolvedValue({
      cycleIndex: 3,
      billingAttemptExpectedDate: HELD,
      skipped: false,
      edited: false,
      status: "UNBILLED",
    });
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome.kind).toBe("resumed");
    expect(mocks.getBillingCycleByDate).toHaveBeenCalledWith({}, "gid://shopify/SubscriptionContract/1", HELD);
    expect(mocks.skipBillingCycle).toHaveBeenCalledWith({}, "gid://shopify/SubscriptionContract/1", { index: 3 });
  });
});

describe("skipFailedCycleAndResume — refusals (nothing touches Shopify)", () => {
  async function expectRefusal(reason: string) {
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome).toEqual({ kind: "refused", reason });
    expect(mocks.skipBillingCycle).not.toHaveBeenCalled();
    expect(mocks.contractActivate).not.toHaveBeenCalled();
    expect(mocks.contractUpdate).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
    expect(eventOf("portal.payment_skip_resume")?.payload).toMatchObject({
      outcome: "refused",
      reason,
    });
  }

  it("ACTIVE contract → already_active (a double tap reports success)", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ status: "ACTIVE" }));
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "cm_c1", OPTS);
    expect(outcome).toEqual({ kind: "already_active" });
    expect(mocks.contractActivate).not.toHaveBeenCalled();
    expect(eventOf("portal.payment_skip_resume")?.payload).toMatchObject({ outcome: "already_active" });
  });

  it("CANCELLED / PAUSED contracts → contract_status", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ status: "CANCELLED" }));
    await expectRefusal("contract_status");
    vi.clearAllMocks();
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ status: "PAUSED" }));
    await expectRefusal("contract_status");
  });

  it("another app's contract → not_ours", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ ownership: "OTHER_APP" }));
    await expectRefusal("not_ours");
  });

  it("hard-dead card: revoked / expired / no method → refused before any read of the case", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ paymentMethodRevokedAt: new Date() }));
    await expectRefusal("card_revoked");
    expect(mocks.dunningCaseFindFirst).not.toHaveBeenCalled();
    vi.clearAllMocks();
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ cardExpiryMonth: 6, cardExpiryYear: 2026 }),
    );
    await expectRefusal("card_expired");
    vi.clearAllMocks();
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ paymentMethodId: null }));
    await expectRefusal("no_card");
  });

  it("no exhausted (or open) case → no_case", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    await expectRefusal("no_case");
  });

  it("an attempt of the held cycle in flight (PENDING / CHALLENGED) → attempt_in_flight", async () => {
    mocks.attemptFindFirst.mockResolvedValue({ id: "att_live" });
    await expectRefusal("attempt_in_flight");
    const where = (mocks.attemptFindFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({ contractId: "cm_c1", cycleIndex: 7 });
    expect(where.status).toEqual({ in: ["PENDING", "CHALLENGED"] });
    expect(where.shopifyAttemptId).toEqual({ not: null });
  });

  it("held cycle already BILLED on Shopify → cycle_billed (nothing to skip)", async () => {
    mocks.getBillingCycleByIndex.mockResolvedValue({
      cycleIndex: 7,
      billingAttemptExpectedDate: HELD,
      skipped: false,
      edited: false,
      status: "BILLED",
    });
    await expectRefusal("cycle_billed");
  });

  it("held cycle unknown on Shopify → no_cycle", async () => {
    mocks.getBillingCycleByIndex.mockResolvedValue(null);
    await expectRefusal("no_cycle");
  });

  it("unknown contract → not_found (never throws to the caller)", async () => {
    mocks.contractFindUnique.mockResolvedValue(null);
    const outcome = await skipFailedCycleAndResume(SHOP.domain, "nope", OPTS);
    expect(outcome).toEqual({ kind: "refused", reason: "not_found" });
  });
});

// ── Banner CTA + toasts ──────────────────────────────────────────────────────

function viewFixture(over: Partial<PortalDunningView> = {}): PortalDunningView {
  return {
    caseId: "case_1",
    state: "EXHAUSTED",
    caseState: "EXHAUSTED",
    openedAt: OPENED,
    failedAt: OPENED,
    amountCents: 4900,
    currencyCode: "CHF",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    customerAction: "NONE",
    declineHuman: "insufficient funds",
    reasonKey: "portal.dunning.reason.soft",
    ctaGroup: "SOFT",
    nextRetryAt: null,
    onBackup: false,
    challenged: false,
    challengedAttemptId: null,
    customerRetryAt: null,
    primaryRevoked: false,
    inFlight: false,
    heldCycleIndex: 7,
    heldCycleDate: HELD,
    ...over,
  };
}

function renderBanner(over: Partial<Parameters<typeof dunningBannerHtml>[0]> = {}): string {
  return dunningBannerHtml({
    locale: "en",
    tz: TZ,
    view: viewFixture(),
    contract: { paymentMethodId: "pm_main", nextBillingDate: HELD },
    status: "FAILED",
    locked: false,
    liveMethodCount: 1,
    retryCooldownMinutes: 60,
    now: NOW,
    apiUrl: (action) => `/apps/cellexia-subs/api/${action}`,
    hiddenFields: () => "",
    skipResumeDate: new Date("2026-08-24T08:00:00.000Z"),
    ...over,
  });
}

describe("dunning banner — skip and continue CTA", () => {
  it("renders the case-aware skip verb with the resume date on an exhausted FAILED contract", () => {
    const html = renderBanner();
    expect(html).toContain('action="/apps/cellexia-subs/api/payment_skip_and_resume"');
    expect(html).toContain("Skip that order and continue from");
    expect(html).toContain("August 24, 2026");
    // Retry stays available too.
    expect(html).toContain('action="/apps/cellexia-subs/api/payment_retry"');
    // No bare .cx- classes.
    expect(html).not.toMatch(/class="[^"]*\bcx-/);
  });

  it("also rides the update-card group when the card is merely declined (not hard-dead)", () => {
    const html = renderBanner({ view: viewFixture({ ctaGroup: "UPDATE_CARD" }) });
    expect(html).toContain("payment_skip_and_resume");
    expect(html).toContain("payment_update");
  });

  it("is hidden without a resume date (hard-dead card — the route passes null)", () => {
    expect(renderBanner({ skipResumeDate: null })).not.toContain("payment_skip_and_resume");
  });

  it("is hidden while the case is still live (RETRYING / AWAITING_CUSTOMER on an ACTIVE contract)", () => {
    for (const state of ["RETRYING", "AWAITING_CUSTOMER"] as const) {
      const html = renderBanner({
        view: viewFixture({ state, caseState: state }),
        status: "ACTIVE",
      });
      expect(html).not.toContain("payment_skip_and_resume");
    }
  });
});

describe("toast keys", () => {
  it("skip_resumed is a confirmation; the two refusals are alerts", () => {
    expect(TOAST_KEYS.has("skip_resumed")).toBe(true);
    expect(TOAST_KEYS.has("skip_resume_card_dead")).toBe(true);
    expect(TOAST_KEYS.has("skip_resume_unavailable")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("skip_resumed")).toBe(false);
    expect(TOAST_ALERT_KEYS.has("skip_resume_card_dead")).toBe(true);
    expect(TOAST_ALERT_KEYS.has("skip_resume_unavailable")).toBe(true);
    expect(t("en", "portal.toast.skip_resumed_date", { date: "24 Aug 2026" })).toContain("24 Aug 2026");
    expect(t("en", "portal.dunning.skip_and_resume", { date: "x" })).not.toContain("portal.dunning");
  });
});
