import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * v1.28.0 audit pins — the dunning engine's answers to Shopify's "not now"
 * refusals, the customer-retry launch gate, the atomic fire claim, and the
 * skip / delay reconciliation of open cases:
 *
 *  - THROTTLED (and the other transient BillingAttemptUserError codes) keep
 *    the case RETRYING with its ladder — a customer tap re-arms the rung it
 *    displaced and hears too_soon, never a parked AWAITING_CUSTOMER + a
 *    blanket "started";
 *  - BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE re-arms at the cycle's date;
 *  - BILLING_CYCLE_SKIPPED closes the case (CYCLE_SKIPPED) — nothing left;
 *  - a permanent code still parks the case and the customer hears
 *    unavailable/refused;
 *  - SETUP launch mode refuses at the engine choke point (SMS RETRY path);
 *  - fireRetry claims the case row atomically: a lost claim never touches
 *    Shopify (sweep vs. customer tap can no longer mint two attempts);
 *  - onCycleSkipped / onCycleDelayed reconcile the case anchored on the
 *    cycle the contracts service just skipped / moved;
 *  - onPaymentMethodUpdated: an expiry-only change is a real change for a
 *    RETRYING case; an AWAITING_3DS case with a live challenge is not
 *    re-armed on top of it.
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
  contractActivate: vi.fn(async (): Promise<void> => {}),
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
  class ShopifyUserError extends Error {
    errors: Array<{ field?: string[] | null; message: string; code?: string | null }> = [];
  }
  return {
    ShopifyUserError,
    contractActivate: mocks.contractActivate,
    contractFail: vi.fn(async (): Promise<void> => {}),
    createBillingAttempt: mocks.createBillingAttempt,
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import { ShopifyUserError } from "~/lib/graphql/index.server";
import {
  onCycleDelayed,
  onCycleSkipped,
  onPaymentMethodUpdated,
  requestCustomerRetry,
  runDunningSweep,
} from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-17T10:00:00.000Z");
const OPENED = new Date("2026-08-15T09:00:00.000Z");
const RUNG = new Date("2026-08-19T09:00:00.000Z");
const HOUR = 60 * 60_000;

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
    cardBrand: "visa",
    cardLast4: "4242",
    cardExpiryMonth: 8,
    cardExpiryYear: 2026,
    nextBillingDate: new Date("2026-08-15T09:00:00.000Z"),
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
    nextRetryAt: RUNG,
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

const PENDING_ROW = {
  id: "att_pending",
  contractId: "cm_c1",
  cycleIndex: 5,
  attemptNumber: 2,
  status: "PENDING",
  idempotencyKey: "cm_c1:5:2",
  shopifyAttemptId: null,
  startedAt: null,
  usedBackupPayment: false,
};

function wireAttempts(
  opts: { pending?: Record<string, unknown> | null; challenged?: boolean; inFlight?: boolean } = {},
) {
  mocks.attemptFindUnique.mockImplementation(async (args: any) =>
    args?.where?.id === "att_trigger" ? { cycleIndex: 5 } : null,
  );
  mocks.attemptFindFirst.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.status === "FAILED") return FAILED_ATTEMPT;
    if (where.status === "CHALLENGED") {
      return opts.challenged
        ? { id: "att_ch", shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/55" }
        : null;
    }
    if (where.status === "PENDING") {
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

function refusal(code: string, message = `refused ${code}`) {
  const err = new ShopifyUserError("subscriptionBillingAttemptCreate", []);
  (err as unknown as { errors: unknown }).errors = [{ field: null, message, code }];
  return err;
}

function events(type: string) {
  return mocks.logEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === type);
}

function caseUpdates() {
  return mocks.dunningCaseUpdate.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}

const OPTS = { source: "CUSTOMER_PORTAL" as const, actor: "customer", now: NOW };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    key === "launch"
      ? { ...(defaultFor("launch" as never) as object), mode: "LIVE" }
      : defaultFor(key as never),
  );
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
  });
  mocks.dunningCaseUpdateMany.mockResolvedValue({ count: 1 });
  mocks.subscriberEventCount.mockResolvedValue(0);
  mocks.attemptCount.mockResolvedValue(1);
  wireAttempts({ pending: PENDING_ROW });
});

describe("customer Retry now vs. Shopify's transient refusals (THROTTLED & co.)", () => {
  it("THROTTLED keeps the case RETRYING, re-arms the rung the tap displaced, keeps the PENDING row, and answers too_soon", async () => {
    wireCase(caseFixture());
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal("THROTTLED"));

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "too_soon", caseId: "case_1", retryAgainAt: RUNG });

    // Never parked, never expired.
    for (const data of caseUpdates()) {
      expect(data.state).not.toBe("AWAITING_CUSTOMER");
    }
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    // The rung it held before the tap is restored (not now+1h).
    expect(caseUpdates().at(-1)).toEqual({ nextRetryAt: RUNG });
    // The audit says what happened; the throttle does not count as a fault.
    const rescheduled = events("dunning.retry_scheduled").at(-1);
    expect(rescheduled?.payload).toMatchObject({
      reason: "attempt_create_throttled",
      errorCode: "THROTTLED",
      idempotencyKey: "cm_c1:5:2",
    });
    expect(events("dunning.awaiting_customer")).toHaveLength(0);
    expect(events("portal.payment_retry").at(-1)?.payload).toMatchObject({
      outcome: "too_soon",
      fired: "transient",
      errorCode: "THROTTLED",
    });
  });

  it("THROTTLED on a FAILED contract does NOT reactivate it (that branch is for the 'contract failed' refusal only)", async () => {
    wireCase(
      caseFixture({ state: "EXHAUSTED", resolvedAt: NOW, resolution: "EXHAUSTED" }),
      contractFixture({ status: "FAILED" }),
    );
    // findOpenCase → null, then the EXHAUSTED lookup.
    mocks.dunningCaseFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        caseFixture({ state: "EXHAUSTED", resolvedAt: NOW, resolution: "EXHAUSTED" }),
      );
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal("THROTTLED"));

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome.kind).toBe("too_soon");
    expect(mocks.contractActivate).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
  });

  it("BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE re-arms the retry at the cycle's (delayed) date, not an hourly backoff", async () => {
    const delayedTo = new Date("2026-08-24T09:00:00.000Z");
    wireCase(caseFixture(), contractFixture({ nextBillingDate: delayedTo }));
    mocks.createBillingAttempt.mockRejectedValueOnce(
      refusal("BILLING_CYCLE_CHARGE_BEFORE_EXPECTED_DATE"),
    );

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "too_soon", retryAgainAt: delayedTo });
    expect(caseUpdates().at(-1)).toEqual({ nextRetryAt: delayedTo });
    expect(events("dunning.retry_scheduled").at(-1)?.payload).toMatchObject({
      reason: "attempt_create_before_expected_date",
    });
    expect(events("dunning.awaiting_customer")).toHaveLength(0);
  });

  it("BILLING_CYCLE_SKIPPED closes the case as CYCLE_SKIPPED (nothing left to collect) and the customer hears cycle_skipped", async () => {
    wireCase(caseFixture());
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal("BILLING_CYCLE_SKIPPED"));

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "cycle_skipped" });

    const closes = mocks.dunningCaseUpdateMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
      .filter((c) => c.data.state === "CANCELLED");
    expect(closes).toHaveLength(1);
    expect(closes[0].data).toMatchObject({ resolution: "CYCLE_SKIPPED", nextRetryAt: null });
    expect(events("dunning.case_closed")[0]?.payload).toMatchObject({
      resolution: "CYCLE_SKIPPED",
      cycleIndex: 5,
    });
    // Un-started row expired with the code — no blind re-fire later.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "EXPIRED", errorCode: "BILLING_CYCLE_SKIPPED" }),
      }),
    );
    for (const data of caseUpdates()) expect(data.state).not.toBe("AWAITING_CUSTOMER");
  });

  it("a permanent code (CONTRACT_TERMINATED) still parks the case and the customer hears unavailable/refused — never 'started'", async () => {
    wireCase(caseFixture());
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal("CONTRACT_TERMINATED"));

    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "refused" });
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledWith({
      where: { id: "case_1" },
      data: { state: "AWAITING_CUSTOMER", nextRetryAt: null },
    });
    expect(events("dunning.awaiting_customer")[0]?.payload).toMatchObject({
      errorCode: "CONTRACT_TERMINATED",
    });
  });

  it("the sweep: THROTTLED backs off with the same key instead of parking; the next pass re-fires it", async () => {
    const due = {
      ...caseFixture({ nextRetryAt: new Date(NOW.getTime() - 60_000) }),
      contract: contractFixture(),
    };
    mocks.dunningCaseFindMany.mockResolvedValue([due]);
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal("THROTTLED"));

    const stats = await runDunningSweep(NOW);
    expect(stats.retriesScheduled).toBe(0);
    for (const data of caseUpdates()) expect(data.state).not.toBe("AWAITING_CUSTOMER");
    expect(caseUpdates().at(-1)).toEqual({ nextRetryAt: new Date(NOW.getTime() + HOUR) });
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();

    await runDunningSweep(new Date(NOW.getTime() + HOUR + 60_000));
    const keys = mocks.createBillingAttempt.mock.calls.map(
      (c) => (c[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual(["cm_c1:5:2", "cm_c1:5:2"]);
  });
});

describe("launch gate at the engine choke point", () => {
  it("SETUP mode refuses the customer retry (setup_mode) before touching the case or Shopify — the SMS RETRY path has no upstream gate", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) =>
      defaultFor(key as never), // launch default = SETUP
    );
    wireCase(caseFixture());
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "setup_mode" });
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(events("portal.payment_retry")[0]?.payload).toMatchObject({ reason: "setup_mode" });
  });

  it("an unreadable launch state fails closed", async () => {
    mocks.getSetting.mockImplementation(async (_s: string, key: string) => {
      if (key === "launch") throw new Error("db down");
      return defaultFor(key as never);
    });
    wireCase(caseFixture());
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome).toMatchObject({ kind: "unavailable", reason: "setup_mode" });
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });
});

describe("fireRetry's atomic claim (sweep vs. customer tap)", () => {
  it("the sweep claims the row with the nextRetryAt it saw and leases it one backoff ahead", async () => {
    const seen = new Date(NOW.getTime() - 60_000);
    mocks.dunningCaseFindMany.mockResolvedValue([
      { ...caseFixture({ nextRetryAt: seen }), contract: contractFixture() },
    ]);
    await runDunningSweep(NOW);
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { id: "case_1", state: "RETRYING", nextRetryAt: seen },
      data: { nextRetryAt: new Date(NOW.getTime() + HOUR) },
    });
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
  });

  it("a lost claim (a customer tap already moved the row) never mints an attempt nor calls Shopify", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      { ...caseFixture({ nextRetryAt: new Date(NOW.getTime() - 60_000) }), contract: contractFixture() },
    ]);
    mocks.dunningCaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    const stats = await runDunningSweep(NOW);
    expect(stats.retriesScheduled).toBe(0);
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
  });

  it("a customer inline fire whose claim is lost still reports the retry as started (the winner is firing it)", async () => {
    wireCase(caseFixture());
    // 1st updateMany = the customer claim (wins), 2nd = fireRetry's claim (loses).
    mocks.dunningCaseUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const outcome = await requestCustomerRetry("cm_c1", OPTS);
    expect(outcome.kind).toBe("started");
    expect(mocks.createBillingAttempt).not.toHaveBeenCalled();
  });
});

describe("skip / delay reconciliation of the held cycle", () => {
  it("onCycleSkipped closes the case anchored on the skipped cycle and expires its un-started retry rows", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    expect(await onCycleSkipped("cm_c1", 5, "CUSTOMER_PORTAL")).toBe(true);
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { id: "case_1", state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] } },
      data: expect.objectContaining({ state: "CANCELLED", resolution: "CYCLE_SKIPPED", nextRetryAt: null }),
    });
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cycleIndex: 5, status: "PENDING", shopifyAttemptId: null }),
        data: expect.objectContaining({ status: "EXPIRED", errorCode: "BILLING_CYCLE_SKIPPED" }),
      }),
    );
    expect(events("dunning.case_closed")[0]).toMatchObject({
      source: "CUSTOMER_PORTAL",
      payload: { reason: "cycle_skipped", cycleIndex: 5 },
    });
  });

  it("onCycleSkipped leaves a case anchored on ANOTHER cycle alone", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    expect(await onCycleSkipped("cm_c1", 6)).toBe(false);
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
  });

  it("onCycleDelayed moves a RETRYING case's next retry to the new expected date (Shopify refuses >24h early)", async () => {
    const newDate = new Date("2026-08-24T09:00:00.000Z");
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    expect(await onCycleDelayed("cm_c1", 5, newDate)).toBe(true);
    expect(mocks.dunningCaseUpdateMany).toHaveBeenCalledWith({
      where: { id: "case_1", state: "RETRYING", nextRetryAt: RUNG },
      data: { nextRetryAt: newDate },
    });
    expect(events("dunning.retry_scheduled")[0]?.payload).toMatchObject({
      reason: "cycle_delayed",
      nextRetryAt: newDate.toISOString(),
    });
  });

  it("onCycleDelayed leaves AWAITING_CUSTOMER cases and other cycles alone", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ state: "AWAITING_CUSTOMER", nextRetryAt: null }));
    expect(await onCycleDelayed("cm_c1", 5, new Date("2026-08-24T09:00:00.000Z"))).toBe(false);
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    expect(await onCycleDelayed("cm_c1", 6, new Date("2026-08-24T09:00:00.000Z"))).toBe(false);
    expect(mocks.dunningCaseUpdateMany).not.toHaveBeenCalled();
  });
});

describe("onPaymentMethodUpdated — expiry changes and live challenges", () => {
  it("same id + same last4 but a NEW expiry (the EXPIRED_CARD fix) is a real change → RETRYING case retries now", async () => {
    wireAttempts();
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ cardExpiryMonth: 8, cardExpiryYear: 2029 }),
    );
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture());
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242", cardExpiryMonth: 8, cardExpiryYear: 2026, cardBrand: "visa" },
    });
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledTimes(1);
    expect(caseUpdates()[0]).toMatchObject({ state: "RETRYING", nextRetryAt: expect.any(Date) });
    expect(events("dunning.retry_scheduled")[0]?.payload).toMatchObject({ cardChanged: true });
  });

  it("an AWAITING_3DS case with a live CHALLENGED attempt is NOT re-armed on a card change (two live attempts for one cycle)", async () => {
    wireAttempts({ challenged: true });
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ paymentMethodId: "pm_new" }));
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ state: "AWAITING_3DS", nextRetryAt: null }));
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
    expect(events("dunning.retry_deferred")[0]?.payload).toMatchObject({ reason: "challenge_pending" });
  });

  it("an AWAITING_CUSTOMER case with an attempt in flight waits for its outcome", async () => {
    wireAttempts({ inFlight: true });
    mocks.contractFindUnique.mockResolvedValue(contractFixture({ paymentMethodId: "pm_new" }));
    mocks.dunningCaseFindFirst.mockResolvedValue(caseFixture({ state: "AWAITING_CUSTOMER", nextRetryAt: null }));
    await onPaymentMethodUpdated("cm_c1", {
      previous: { paymentMethodId: "pm_main", cardLast4: "4242" },
    });
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
    expect(events("dunning.retry_deferred")[0]?.payload).toMatchObject({ reason: "attempt_in_flight" });
  });
});
