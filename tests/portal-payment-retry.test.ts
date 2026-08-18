import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Customer "Retry now" (v1.28.0, P1.3) — requestCustomerRetry, the engine
 * entry point behind the portal button, the RETRY_PAYMENT magic link and the
 * SMS RETRY keyword — plus the onPaymentMethodUpdated early-return fix.
 *
 *  - open case → RETRYING now, customerRetryAt stamped, fired INLINE through
 *    fireRetry (same idempotency-key / PENDING-row bookkeeping as the sweep);
 *  - per-case cooldown (setting dunning.customerRetryCooldownMinutes) →
 *    too_soon, nothing fired;
 *  - FAILED contract + newest EXHAUSTED case → reopened exactly like
 *    onPaymentMethodUpdated (resolvedAt/resolution cleared);
 *  - no ladder rung is consumed: rung selection is time-anchored, so a later
 *    soft failure schedules the same offset it would have without the tap;
 *  - PAUSED / challenge-pending / in-flight refusals;
 *  - onPaymentMethodUpdated: a RETRYING case retries immediately when the
 *    mirrored card actually changed, and stays put when it did not.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  createBillingAttempt: vi.fn(
    async (..._args: unknown[]): Promise<{ attemptId: string }> => ({
      attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    }),
  ),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  contractFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptCount: vi.fn(async (_a?: unknown): Promise<number> => 0),
  attemptCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "att_minted",
    ...args.data,
  })),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  subscriberEventCount: vi.fn(async (_a?: unknown): Promise<number> => 0),
}));

vi.mock("~/db.server", () => ({
  default: {
    dunningCase: {
      findMany: mocks.dunningCaseFindMany,
      findFirst: mocks.dunningCaseFindFirst,
      findUnique: mocks.dunningCaseFindUnique,
      update: mocks.dunningCaseUpdate,
      updateMany: mocks.dunningCaseUpdateMany,
    },
    subscriptionContract: { findUnique: mocks.contractFindUnique },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findFirst: mocks.attemptFindFirst,
      count: mocks.attemptCount,
      create: mocks.attemptCreate,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
    },
    subscriberEvent: { count: mocks.subscriberEventCount },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({ getSetting: mocks.getSetting }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/magiclinks/builder.server", () => ({
  buildMagicUrl: vi.fn(async (): Promise<string> => "https://example.test/magic"),
  buildActionLinkBundle: vi.fn(async (): Promise<Record<string, string>> => ({})),
  buildPortalUrl: vi.fn(async (): Promise<string> => "https://example.test/portal"),
}));
vi.mock("~/lib/notifications/index.server", () => ({
  sendNotification: mocks.sendNotification,
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(async (): Promise<void> => {}),
    contractFail: vi.fn(async (): Promise<void> => {}),
    createBillingAttempt: mocks.createBillingAttempt,
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import { selectNextRetryOffsetDays } from "~/lib/dunning/ladder.server";
import {
  onPaymentMethodUpdated,
  requestCustomerRetry,
} from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-17T10:00:00.000Z");
const OPENED = new Date("2026-08-15T09:00:00.000Z");

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: "Europe/Zurich",
  currencyCode: "CHF",
  contactEmail: "merchant@example.com",
};

function contractFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cm_c1",
    shopId: SHOP.id,
    shop: SHOP,
    shopifyContractId: "gid://shopify/SubscriptionContract/1",
    status: "ACTIVE",
    ownership: "OURS",
    isDemo: false,
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    phone: null,
    locale: "en",
    currencyCode: "CHF",
    intervalWeeks: 4,
    paymentMethodId: "pm_main",
    backupPaymentMethodId: null,
    cardLast4: "4242",
    originOrderId: "gid://shopify/Order/1",
    lines: [],
    ...over,
  };
}

function caseFixture(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    state: "RETRYING",
    openedAt: OPENED,
    resolvedAt: null,
    resolution: null,
    nextRetryAt: new Date("2026-08-19T09:00:00.000Z"), // rung due in 2 days
    triggerAttemptId: "att_trigger",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 1,
    ladderCursor: 1,
    emailsSent: 1,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
    originalPaymentMethodId: "pm_main",
    customerRetryAt: null,
    ...over,
  };
}

const FAILED_ATTEMPT = {
  id: "att_trigger",
  contractId: "cm_c1",
  cycleIndex: 5,
  attemptNumber: 1,
  status: "FAILED",
  idempotencyKey: "cm_c1:5:1",
  shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
};

/** attempt lookups: trigger cycle 5, one FAILED, no PENDING/CHALLENGED unless wired. */
function wireAttempts(opts: { pending?: Record<string, unknown> | null; challenged?: boolean; inFlight?: boolean } = {}) {
  mocks.attemptFindUnique.mockImplementation(async (args: any) =>
    args?.where?.id === "att_trigger" ? { cycleIndex: 5 } : null,
  );
  mocks.attemptFindFirst.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.status === "FAILED") return FAILED_ATTEMPT;
    if (where.status === "CHALLENGED") return opts.challenged ? { id: "att_ch" } : null;
    if (where.status === "PENDING") {
      // in-flight probe selects shopifyAttemptId: { not: null }; fireRetry's
      // reuse probe selects shopifyAttemptId: null.
      if (where.shopifyAttemptId && typeof where.shopifyAttemptId === "object") {
        return opts.inFlight
          ? { id: "att_inflight", shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/77" }
          : null;
      }
      return opts.pending ?? null;
    }
    return null;
  });
}

function wireCase(kase: Record<string, unknown> | null, contract = contractFixture()) {
  mocks.contractFindUnique.mockResolvedValue(contract);
  mocks.dunningCaseFindFirst.mockResolvedValue(kase);
  mocks.dunningCaseFindUnique.mockResolvedValue(
    kase ? { ...kase, state: "RETRYING", nextRetryAt: NOW, contract } : null,
  );
}

function events(type: string) {
  return mocks.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Store LIVE: the engine refuses customer retries in SETUP mode (v1.28.0
  // launch gate at the choke point — see the setup_mode test).
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    key === "launch" ? { ...(defaultFor("launch" as never) as object), mode: "LIVE" } : defaultFor(key as never),
  );
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
  });
  mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 1 });
  mocks.subscriberEventCount.mockResolvedValue(0);
  mocks.attemptCount.mockResolvedValue(1);
  wireAttempts();
});

const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer", now: NOW };

describe("requestCustomerRetry — the happy path", () => {
  it("claims the open case RETRYING/now with customerRetryAt, fires inline through fireRetry, logs both events", async () => {
    wireCase(caseFixture());

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "started", caseId: "case_1", reopened: false, inFlight: false });

    // Atomic claim: open-state guard + cooldown guard in ONE statement.
    const claim = mocks.dunningCaseUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where).toMatchObject({
      id: "case_1",
      contractId: "cm_c1",
      state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] },
    });
    expect(claim.where.OR).toEqual([
      { customerRetryAt: null },
      { customerRetryAt: { lt: new Date(NOW.getTime() - 60 * 60_000) } },
    ]);
    expect(claim.data).toEqual({ state: "RETRYING", nextRetryAt: NOW, customerRetryAt: NOW });

    // Fired inline through the sweep's path — Shopify called once with the
    // priors+1 idempotency key contract.
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
    const [, , createArgs] = mocks.createBillingAttempt.mock.calls[0] as [unknown, string, { idempotencyKey: string; cycleIndex: number }];
    expect(createArgs).toMatchObject({ idempotencyKey: "cm_c1:5:2", cycleIndex: 5 });
    expect(mocks.attemptCreate.mock.calls[0][0].data).toMatchObject({
      originatingAction: "DUNNING_RETRY",
      idempotencyKey: "cm_c1:5:2",
    });

    const scheduled = events("dunning.retry_scheduled");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({
      source: "CUSTOMER_PORTAL",
      actor: "customer",
      payload: { trigger: "customer", immediate: true, reopened: false, dunningCaseId: "case_1" },
    });
    const audit = events("portal.payment_retry");
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ outcome: "started", dunningCaseId: "case_1" });
    expect(events("billing.attempt_started")).toHaveLength(1);
  });

  it("reuses a crash-left PENDING row (never a second Shopify attempt for the same key)", async () => {
    wireCase(caseFixture());
    wireAttempts({
      pending: {
        id: "att_pending",
        contractId: "cm_c1",
        cycleIndex: 5,
        attemptNumber: 2,
        status: "PENDING",
        idempotencyKey: "cm_c1:5:2",
        shopifyAttemptId: null,
        startedAt: null,
        usedBackupPayment: false,
      },
    });
    await requestCustomerRetry("cm_c1", OPTS);
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    const [, , createArgs] = mocks.createBillingAttempt.mock.calls[0] as [unknown, string, { idempotencyKey: string }];
    expect(createArgs.idempotencyKey).toBe("cm_c1:5:2");
  });

  it("an inline-fire failure leaves the case RETRYING/due for the sweep and still reports started", async () => {
    wireCase(caseFixture());
    mocks.createBillingAttempt.mockRejectedValueOnce(new Error("503"));
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    // A transport error is "not now": the case backed off ~1h with the same
    // key, and the customer hears too_soon (with the re-arm time), not a
    // blanket "started" (v1.28.0 audit).
    expect(outcome).toMatchObject({ kind: "too_soon", caseId: "case_1" });
    expect((outcome as { retryAgainAt: Date }).retryAgainAt.getTime()).toBe(
      NOW.getTime() + 60 * 60_000,
    );
    // The customer claim + fireRetry's own atomic claim.
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledTimes(2);
  });
});

describe("requestCustomerRetry — guards", () => {
  it("per-case cooldown: a retry inside dunning.customerRetryCooldownMinutes is too_soon and fires nothing", async () => {
    wireCase(caseFixture({ customerRetryAt: new Date(NOW.getTime() - 20 * 60_000) }));
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "too_soon", caseId: "case_1" });
    expect((outcome as { retryAgainAt: Date }).retryAgainAt.getTime()).toBe(
      NOW.getTime() + 40 * 60_000,
    );
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(events("dunning.retry_scheduled")).toHaveLength(0);
    expect(events("portal.payment_retry")[0]?.payload).toMatchObject({ outcome: "too_soon" });
  });

  it("the cooldown is a setting: 5 minutes lets a 20-minute-old retry through", async () => {
    wireCase(caseFixture({ customerRetryAt: new Date(NOW.getTime() - 20 * 60_000) }));
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      key === "dunning"
        ? { ...(defaultFor("dunning" as never) as object), customerRetryCooldownMinutes: 5 }
        : key === "launch"
          ? { ...(defaultFor("launch" as never) as object), mode: "LIVE" }
          : defaultFor(key as never),
    );
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome.kind).toBe("started");
  });

  it("a lost atomic claim (concurrent tap / recovery) refuses instead of firing", async () => {
    wireCase(caseFixture());
    mocks.dunningCaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "claim_lost" });
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });

  it("no case at all → no_case; PAUSED → contract_paused; CANCELLED → contract_status — nothing fired", async () => {
    wireCase(null);
    expect((await requestCustomerRetry("cm_c1", OPTS)).kind).toBe("no_case");

    wireCase(caseFixture(), contractFixture({ status: "PAUSED" }));
    expect(await requestCustomerRetry("cm_c1", OPTS)).toMatchObject({ kind: "unavailable", reason: "contract_paused" });

    wireCase(caseFixture(), contractFixture({ status: "CANCELLED" }));
    expect(await requestCustomerRetry("cm_c1", OPTS)).toMatchObject({ kind: "unavailable", reason: "contract_status" });
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
  });

  it("a CHALLENGED attempt of the case's cycle refuses (challenge_pending) — the bank must settle first", async () => {
    wireCase(caseFixture({ state: "AWAITING_3DS", nextRetryAt: null }));
    wireAttempts({ challenged: true });
    expect(await requestCustomerRetry("cm_c1", OPTS)).toMatchObject({ kind: "unavailable", reason: "challenge_pending" });
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });

  it("an in-flight PENDING attempt is reported as started without minting another one; the cooldown is stamped", async () => {
    wireCase(caseFixture({ nextRetryAt: null }));
    wireAttempts({ inFlight: true });
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "started", inFlight: true });
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { id: "case_1" },
      data: { customerRetryAt: NOW },
    });
  });

  it("a foreign / unknown contract is refused without touching anything", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ ownership: "FOREIGN" }));
    expect(await requestCustomerRetry("cm_c1", OPTS)).toMatchObject({ kind: "unavailable", reason: "not_ours" });
    mocks.contractFindUnique.mockResolvedValue(null);
    expect(await requestCustomerRetry("cm_c1", OPTS)).toMatchObject({ kind: "unavailable", reason: "not_found" });
    expect(mocks.dunningCaseFindFirst).not.toHaveBeenCalled();
  });
});

describe("requestCustomerRetry — FAILED contract reopens its newest EXHAUSTED case", () => {
  it("clears resolvedAt/resolution in the claim (state guard EXHAUSTED) exactly like onPaymentMethodUpdated, and fires", async () => {
    const contract = contractFixture({ status: "FAILED" });
    const exhausted = caseFixture({
      state: "EXHAUSTED",
      resolvedAt: new Date("2026-08-16T00:00:00.000Z"),
      resolution: "EXHAUSTED",
      nextRetryAt: null,
    });
    mocks.contractFindUnique.mockResolvedValue(contract);
    mocks.dunningCaseFindFirst
      .mockResolvedValueOnce(null) // no open case
      .mockResolvedValueOnce(exhausted); // newest EXHAUSTED
    mocks.dunningCaseFindUnique.mockResolvedValue({
      ...exhausted,
      state: "RETRYING",
      nextRetryAt: NOW,
      resolvedAt: null,
      resolution: null,
      contract,
    });

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "started", reopened: true });

    expect(mocks.dunningCaseFindFirst.mock.calls[1][0]).toMatchObject({
      where: { contractId: "cm_c1", state: "EXHAUSTED" },
      orderBy: { openedAt: "desc" },
    });
    const claim = mocks.dunningCaseUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where.state).toBe("EXHAUSTED");
    expect(claim.data).toEqual({
      state: "RETRYING",
      nextRetryAt: NOW,
      customerRetryAt: NOW,
      resolvedAt: null,
      resolution: null,
    });
    expect(events("dunning.retry_scheduled")[0].payload).toMatchObject({
      trigger: "customer",
      reopened: true,
    });
    // fireRetry's FAILED branch reactivates on Shopify's refusal — here the
    // create succeeds directly, so a plain attempt went out.
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
  });
});

describe("no ladder rung is consumed by a customer retry", () => {
  it("rung selection is anchored to openedAt + now — the same offset is picked whether or not the customer tapped", () => {
    const softRetryDays = [0, 3, 7, 14];
    const tz = "Europe/Zurich";
    // Ladder rung the engine would pick for a soft failure observed NOW…
    const withoutTap = selectNextRetryOffsetDays(softRetryDays, OPENED, NOW, tz);
    // …and for one observed right after a customer retry fired (same instant
    // + a few minutes: the tap changed nothing about the case's anchor).
    const afterTap = selectNextRetryOffsetDays(
      softRetryDays,
      OPENED,
      new Date(NOW.getTime() + 5 * 60_000),
      tz,
    );
    expect(withoutTap).toBe(afterTap);
    expect(withoutTap).toBe(3); // day-3 rung is still ahead of a day-2 tap
  });

  it("the claim writes no ladderStep / ladderCursor and the sweep-side bookkeeping is fireRetry's own", async () => {
    wireCase(caseFixture());
    await requestCustomerRetry("cm_c1", OPTS);
    const claim = mocks.dunningCaseUpdateMany.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(claim.data).not.toHaveProperty("ladderStep");
    expect(claim.data).not.toHaveProperty("ladderCursor");
    // fireRetry counts the retry it performed (its existing increment) —
    // ladderCursor (which rung the ladder reads next) is untouched.
    const updates = mocks.dunningCaseUpdate.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    expect(updates.some((d) => "ladderCursor" in d)).toBe(false);
  });
});

describe("onPaymentMethodUpdated — RETRYING cases retry immediately only when the card actually changed", () => {
  it("same method id + same last4 (a re-upsert) leaves the schedule alone", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("same method id, NEW last4 (Shopify's hosted replace flow) → RETRYING/now with cardChanged", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ cardLast4: "1881" }));
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.dunningCaseUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data.state).toBe("RETRYING");
    expect(update.data.nextRetryAt).toBeInstanceOf(Date);
    expect(events("dunning.retry_scheduled")[0].payload).toMatchObject({
      trigger: "payment_method_updated",
      immediate: true,
      cardChanged: true,
    });
  });

  it("new method id → immediate retry; without a snapshot the case's original method id is the comparison", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ paymentMethodId: "pm_new" }));
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ originalPaymentMethodId: "pm_main" }));
    await onPaymentMethodUpdated("cm_c1");
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    // Engine-on-backup (both pointers equal) is NOT a customer card change.
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ paymentMethodId: "pm_backup", backupPaymentMethodId: "pm_backup" }),
    );
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ originalPaymentMethodId: "pm_main" }));
    await onPaymentMethodUpdated("cm_c1");
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
  });

  it("a changed card never queues on top of an in-flight attempt", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ cardLast4: "1881" }));
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ nextRetryAt: null }));
    wireAttempts({ inFlight: true });
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
  });

  it("AWAITING_CUSTOMER still wakes regardless of the snapshot (unchanged behaviour)", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ state: "AWAITING_CUSTOMER", nextRetryAt: null }));
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledTimes(1);
  });
});
