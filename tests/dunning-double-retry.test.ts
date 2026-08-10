import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BEHAVIOURAL regression tests for the double-retry idempotency path — the
 * audit finding tests/cancel-save-guards.test.ts pins only as source text.
 * Here the real dunning engine runs (runDunningSweep / onPaymentMethodUpdated
 * with mocked seams) and the invariant is observed, not grepped:
 *
 *   A due retry NEVER mints a second Shopify billing attempt for the same
 *   (contract, cycle, attempt). The un-started PENDING row — including one
 *   left by a crash or a transient Shopify error — is reused with its ORIGINAL
 *   idempotency key, so Shopify's dedupe makes a double charge impossible even
 *   when two sweeps collide with a payment-method-updated immediate retry.
 *
 * The scenarios mirror the incident write-up: (1) crash-left PENDING row is
 * reused; (2) fresh rows get priors+1 keys; (3) a settled sweep is not
 * re-fireable; (4) onPaymentMethodUpdated leaves RETRYING cases alone;
 * (5) a transient create failure backs off and RE-USES the same key on the
 * next pass.
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
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
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
      update: mocks.dunningCaseUpdate,
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
import {
  onPaymentMethodUpdated,
  runDunningSweep,
} from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-05T10:00:00.000Z");

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
    originOrderId: "gid://shopify/Order/1",
    lines: [],
    ...over,
  };
}

/**
 * A RETRYING case whose scheduled rung is due NOW. Notification cursors sit
 * past the day-0 email rung (emailsSent 1, opened 1h ago) so the sweep's
 * notification phase is quiet and only the retry path runs.
 */
function dueCase(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    contract: contractFixture(),
    state: "RETRYING",
    openedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    resolvedAt: null,
    resolution: null,
    nextRetryAt: new Date(NOW.getTime() - 60 * 1000),
    triggerAttemptId: "att_trigger",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 1,
    emailsSent: 1,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
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

/** The crash-left / transient-error-left row the engine must reuse. */
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

function wireAttemptLookups(pendingRow: Record<string, unknown> | null) {
  mocks.attemptFindUnique.mockImplementation(async (args: any) =>
    args?.where?.id === "att_trigger" ? { cycleIndex: 5 } : null,
  );
  mocks.attemptFindFirst.mockImplementation(async (args: any) => {
    const status = args?.where?.status;
    if (status === "FAILED") return FAILED_ATTEMPT;
    if (status === "PENDING") return pendingRow;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  mocks.createBillingAttempt.mockResolvedValue({
    attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
  });
  mocks.dunningCaseFindMany.mockResolvedValue([]);
  mocks.subscriberEventCount.mockResolvedValue(0);
  mocks.attemptCount.mockResolvedValue(2);
});

describe("fireRetry reuses the un-started PENDING row (the collision guard)", () => {
  it("fires the EXISTING row's idempotency key and never mints a second attempt", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    wireAttemptLookups(PENDING_ROW);

    const stats = await runDunningSweep(NOW);
    expect(stats.retriesScheduled).toBe(1);

    // Shopify was called exactly once, with the reused key — this is the
    // dedupe surface that makes the double charge impossible.
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);
    const [, , createArgs] = mocks.createBillingAttempt.mock.calls[0] as [
      unknown,
      string,
      { idempotencyKey: string; cycleIndex: number },
    ];
    expect(createArgs.idempotencyKey).toBe("cm_c1:5:2");
    expect(createArgs.cycleIndex).toBe(5);

    // No new BillingAttempt row was minted…
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
    // …the reused row was claimed with the Shopify attempt id…
    expect(mocks.attemptUpdate).toHaveBeenCalledWith({
      where: { id: "att_pending" },
      data: {
        shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/900",
        startedAt: NOW,
      },
    });
    // …and the case advanced off its schedule.
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledWith({
      where: { id: "case_1" },
      data: { ladderStep: { increment: 1 }, nextRetryAt: null },
    });

    const started = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "billing.attempt_started");
    expect(started?.payload).toMatchObject({
      idempotencyKey: "cm_c1:5:2",
      originatingAction: "DUNNING_RETRY",
      attemptNumber: 2,
    });
  });

  it("with no reusable row it mints attempt priors+1 — same key contract as the scheduler", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    wireAttemptLookups(null); // nothing pending
    mocks.attemptCount.mockResolvedValue(2); // the scheduled charge + 1 retry

    await runDunningSweep(NOW);

    expect(mocks.attemptCreate).toHaveBeenCalledTimes(1);
    const created = mocks.attemptCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data).toMatchObject({
      contractId: "cm_c1",
      cycleIndex: 5,
      attemptNumber: 3,
      idempotencyKey: "cm_c1:5:3",
      status: "PENDING",
      originatingAction: "DUNNING_RETRY",
    });
    // Stored-credential evidence rides along on every attempt.
    expect(created.data.mitEvidence).toMatchObject({
      originatingAction: "DUNNING_RETRY",
    });
    const [, , createArgs] = mocks.createBillingAttempt.mock.calls[0] as [
      unknown,
      string,
      { idempotencyKey: string },
    ];
    expect(createArgs.idempotencyKey).toBe("cm_c1:5:3");
  });

  it("a second sweep over the settled case fires nothing (nextRetryAt cleared)", async () => {
    // Sweep #1 fired and cleared the schedule; sweep #2 sees the updated case.
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    wireAttemptLookups(PENDING_ROW);
    await runDunningSweep(NOW);
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1);

    mocks.dunningCaseFindMany.mockResolvedValue([dueCase({ nextRetryAt: null })]);
    const second = await runDunningSweep(new Date(NOW.getTime() + 60_000));
    expect(second.retriesScheduled).toBe(0);
    expect(mocks.createBillingAttempt).toHaveBeenCalledTimes(1); // still once
  });

  it("a permanent refusal parks the case AND keeps the structured reason on the EXPIRED row", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    wireAttemptLookups(PENDING_ROW);
    // Shopify refuses the create with a machine-readable code (the GraphQL
    // layer surfaces it on ShopifyUserError.errors once its userErrors
    // selection carries `code`).
    const { ShopifyUserError } = await import("~/lib/graphql/index.server");
    const refusal = new ShopifyUserError("refused", []);
    (refusal as unknown as { errors: unknown }).errors = [
      { field: null, message: "Contract is paused", code: "contract_paused" },
    ];
    mocks.createBillingAttempt.mockRejectedValueOnce(refusal);

    const stats = await runDunningSweep(NOW);
    expect(stats.retriesScheduled).toBe(0);

    // The terminal row itself carries the refusal reason — a bare EXPIRED
    // reads as an unknown outcome and categorizeDeclineCode(null) files it
    // under UNKNOWN/SOFT in every analytics surface.
    expect(mocks.attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "att_pending", shopifyAttemptId: null, startedAt: null },
      data: {
        status: "EXPIRED",
        completedAt: NOW,
        errorCode: "CONTRACT_PAUSED",
        errorMessage: expect.stringContaining("refused"),
      },
    });
    // Case parked for the customer window, reason in the audit event too.
    expect(mocks.dunningCaseUpdate).toHaveBeenCalledWith({
      where: { id: "case_1" },
      data: { state: "AWAITING_CUSTOMER", nextRetryAt: null },
    });
    const awaiting = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "dunning.awaiting_customer");
    expect(awaiting?.payload).toMatchObject({
      reason: "attempt_create_failed_permanently",
      errorCode: "CONTRACT_PAUSED",
    });
  });

  it("a transient Shopify error backs off and the SAME key is reused on the next pass", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    wireAttemptLookups(PENDING_ROW);
    mocks.createBillingAttempt.mockRejectedValueOnce(new Error("503 from Shopify"));

    const stats = await runDunningSweep(NOW);
    expect(stats.retriesScheduled).toBe(0);

    // The PENDING row was NOT expired and NOT claimed — it survives for reuse.
    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    // The case backed off about an hour instead of exhausting a ladder rung.
    const backoff = mocks.dunningCaseUpdate.mock.calls.at(-1)![0] as {
      data: { nextRetryAt: Date };
    };
    expect(backoff.data.nextRetryAt.getTime()).toBe(NOW.getTime() + 60 * 60 * 1000);
    const rescheduled = mocks.logEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === "dunning.retry_scheduled");
    expect(rescheduled?.payload).toMatchObject({
      reason: "attempt_create_failed",
      idempotencyKey: "cm_c1:5:2",
    });

    // Next pass (Shopify healthy): the SAME key goes out — dedupe holds even
    // if the failed call had actually been accepted server-side.
    mocks.dunningCaseFindMany.mockResolvedValue([dueCase()]);
    await runDunningSweep(new Date(NOW.getTime() + 61 * 60 * 1000));
    const keys = mocks.createBillingAttempt.mock.calls.map(
      (c) => (c[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual(["cm_c1:5:2", "cm_c1:5:2"]);
    expect(mocks.attemptCreate).not.toHaveBeenCalled();
  });
});

describe("onPaymentMethodUpdated vs the scheduled retry (the immediate-retry side)", () => {
  it("leaves a RETRYING case's schedule untouched — no second retry is queued", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.dunningCaseFindFirst.mockResolvedValue(dueCase());

    await onPaymentMethodUpdated("cm_c1");

    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("wakes an AWAITING_CUSTOMER case with an immediate retry", async () => {
    mocks.contractFindUnique.mockResolvedValue(contractFixture());
    mocks.dunningCaseFindFirst.mockResolvedValue(
      dueCase({ state: "AWAITING_CUSTOMER", nextRetryAt: null }),
    );

    await onPaymentMethodUpdated("cm_c1");

    expect(mocks.dunningCaseUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.dunningCaseUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data.state).toBe("RETRYING");
    expect(update.data.nextRetryAt).toBeInstanceOf(Date);
    const event = mocks.logEvent.mock.calls[0][0];
    expect(event.type).toBe("dunning.retry_scheduled");
    expect(event.payload).toMatchObject({
      trigger: "payment_method_updated",
      immediate: true,
    });
  });

  it("resurrects an EXHAUSTED case for a FAILED contract (the fixed dead code path)", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ status: "FAILED" }),
    );
    mocks.dunningCaseFindFirst
      .mockResolvedValueOnce(null) // no open case
      .mockResolvedValueOnce(
        dueCase({ state: "EXHAUSTED", resolvedAt: NOW, resolution: "EXHAUSTED" }),
      );

    await onPaymentMethodUpdated("cm_c1");

    const update = mocks.dunningCaseUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data.state).toBe("RETRYING");
    expect(update.data.resolvedAt).toBeNull();
    expect(update.data.resolution).toBeNull();
    const event = mocks.logEvent.mock.calls[0][0];
    expect(event.payload).toMatchObject({ reopened: true });
  });

  it("never touches a contract that is not ours", async () => {
    mocks.contractFindUnique.mockResolvedValue(
      contractFixture({ ownership: "FOREIGN" }),
    );
    await onPaymentMethodUpdated("cm_c1");
    expect(mocks.dunningCaseFindFirst).not.toHaveBeenCalled();
    expect(mocks.dunningCaseUpdate).not.toHaveBeenCalled();
  });
});
