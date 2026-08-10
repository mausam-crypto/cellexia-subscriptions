import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DURABLE CASE MONEY + INSTRUMENT PROVENANCE + THE 3DS SUCCESS FOLD.
 *
 * Three engine contracts pinned behaviorally (real engine, mocked seams):
 *
 *  1. ensureOpenCase freezes the money at stake (amountAtRiskCents +
 *     currency, priced from the contract's lines + delivery at case-open —
 *     failed attempts carry no amountCents, and the amount is
 *     unreconstructible once the lines change) and the instrument on file
 *     (originalPaymentMethodId) into REAL columns.
 *  2. The backup-card flow treats that column as the durable copy: stamped
 *     before the switch for pre-column cases, read FIRST by the revert — the
 *     dunning.backup_used event payload alone rides logEvent's never-throw
 *     contract, and one swallowed insert used to strand every remaining
 *     ladder rung on the dead backup card.
 *  3. onBillingAttemptSucceeded folds the 3DS SUCCEEDED outcome into
 *     mitEvidence even though every live caller reaches it AFTER the claim
 *     already stamped SUCCESS — the status-gated fold was dead code and
 *     every passed challenge stayed frozen at PENDING_CUSTOMER_ACTION.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "case_new",
    openedAt: new Date(),
    emailsSent: 0,
    smsSent: 0,
    ladderCursor: null,
    ...args.data,
  })),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  attemptCount: vi.fn(async (_a?: unknown) => 0),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  draftUpdatePaymentMethod: vi.fn(async (): Promise<void> => {}),
  withContractDraft: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      ops: (draftId: string, run: unknown) => Promise<void>,
    ) => {
      await ops("gid://shopify/SubscriptionDraft/1", vi.fn());
    },
  ),
  listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("~/db.server", () => {
  const db: Record<string, unknown> = {
    dunningCase: {
      findMany: mocks.dunningCaseFindMany,
      findFirst: mocks.dunningCaseFindFirst,
      create: mocks.dunningCaseCreate,
      update: mocks.dunningCaseUpdate,
      updateMany: mocks.dunningCaseUpdateMany,
    },
    subscriptionContract: { update: mocks.contractUpdate },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findFirst: mocks.attemptFindFirst,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
      count: mocks.attemptCount,
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    subscriberEvent: { findFirst: mocks.subscriberEventFindFirst },
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { default: db };
});

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
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
      attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    })),
    draftUpdatePaymentMethod: mocks.draftUpdatePaymentMethod,
    listCustomerPaymentMethods: mocks.listCustomerPaymentMethods,
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: mocks.withContractDraft,
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import {
  onBillingAttemptFailed,
  onBillingAttemptSucceeded,
} from "~/lib/dunning/engine.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: "Europe/Zurich",
  currencyCode: "CHF",
  contactEmail: "merchant@example.com",
};

const LINES = [
  { currentPriceCents: 2500, quantity: 2 },
  { currentPriceCents: 1000, quantity: 1 },
];

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
    cardLast4: "4242",
    cardBrand: "visa",
    paymentMethodId: "pm_main",
    backupPaymentMethodId: null,
    originOrderId: "gid://shopify/Order/1",
    deliveryPriceCents: 500,
    consecutiveFailures: 0,
    lines: LINES,
    ...over,
  };
}

function attemptFixture(over: Record<string, unknown> = {}) {
  return {
    id: "att_h1",
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex: 5,
    attemptNumber: 1,
    status: "FAILED",
    declineCategory: null,
    dunningClaimedAt: null,
    errorCode: "EXPIRED_PAYMENT_METHOD",
    amountCents: null,
    currencyCode: null,
    completedAt: null,
    mitEvidence: null,
    usedBackupPayment: false,
    idempotencyKey: "cm_c1:5:1",
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
    ...over,
  };
}

function openCase(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    state: "RETRYING",
    openedAt: new Date(),
    resolvedAt: null,
    resolution: null,
    nextRetryAt: null,
    triggerAttemptId: "att_trigger",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 0,
    emailsSent: 0,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
    amountAtRiskCents: 6500,
    amountAtRiskCurrencyCode: "CHF",
    originalPaymentMethodId: "pm_orig",
    ladderCursor: null,
    ...over,
  };
}

function wireAttempt(attempt: Record<string, unknown>) {
  mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { id?: string } })?.where;
    if (where?.id === attempt.id) return attempt;
    if (where?.id === "att_trigger") return { cycleIndex: 5 };
    return null;
  });
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ensureOpenCase freezes the case's money and instrument (BD-5 / BD-10)", () => {
  it("stamps amountAtRiskCents from lines + delivery, the contract currency, and the payment method", async () => {
    wireAttempt(attemptFixture());

    await onBillingAttemptFailed("att_h1");

    expect(mocks.dunningCaseCreate).toHaveBeenCalledTimes(1);
    const created = mocks.dunningCaseCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    // 2 × 2500 + 1000 + 500 delivery = 6500, in the contract's own currency
    // (the estimate is priced from the contract's lines by construction).
    expect(created.data).toMatchObject({
      amountAtRiskCents: 6500,
      amountAtRiskCurrencyCode: "CHF",
      originalPaymentMethodId: "pm_main",
    });

    // The money dimension is auditable on the open event too.
    const opened = eventsOfType("dunning.case_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({
      amountAtRiskCents: 6500,
      currencyCode: "CHF",
    });
  });

  it("a contract with no lines stamps null amount AND null currency (never a currency without money)", async () => {
    wireAttempt(
      attemptFixture({ contract: contractFixture({ lines: [] }) }),
    );

    await onBillingAttemptFailed("att_h1");

    const created = mocks.dunningCaseCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(created.data.amountAtRiskCents).toBeNull();
    expect(created.data.amountAtRiskCurrencyCode).toBeNull();
  });
});

describe("backup-card switch and revert use the durable column (BD-10)", () => {
  it("a pre-column case gets originalPaymentMethodId stamped BEFORE the switch", async () => {
    // SOFT failure #2 on the original card, backup configured and untried,
    // legacy case predating the column (null).
    wireAttempt(
      attemptFixture({
        attemptNumber: 2,
        errorCode: "INSUFFICIENT_FUNDS",
        contract: contractFixture({ backupPaymentMethodId: "pm_backup" }),
      }),
    );
    mocks.dunningCaseFindFirst.mockResolvedValue(
      openCase({ originalPaymentMethodId: null }),
    );
    mocks.attemptCount.mockImplementation(async (args?: unknown) => {
      const where = (args as { where?: Record<string, unknown> })?.where ?? {};
      if (where.usedBackupPayment) return 0; // backup never tried this cycle
      return 1; // one prior failure → this schedules retry #2
    });

    await onBillingAttemptFailed("att_h1");

    // The column write precedes the Shopify-side switch: if the switch (or
    // anything after it) dies, the original id already survives in a column.
    const stampCall = mocks.dunningCaseUpdate.mock.calls.findIndex(
      (c) =>
        (c[0] as { data: Record<string, unknown> }).data
          .originalPaymentMethodId === "pm_main",
    );
    expect(stampCall).toBeGreaterThanOrEqual(0);
    expect(
      mocks.dunningCaseUpdate.mock.invocationCallOrder[stampCall],
    ).toBeLessThan(mocks.draftUpdatePaymentMethod.mock.invocationCallOrder[0]);

    // The audit event still carries the same id (belt and braces, not the
    // only copy anymore).
    const used = eventsOfType("dunning.backup_used");
    expect(used).toHaveLength(1);
    expect(used[0].payload).toMatchObject({
      previousPaymentMethodId: "pm_main",
      backupPaymentMethodId: "pm_backup",
    });
  });

  it("the revert reads the column FIRST — no event lookup needed", async () => {
    // The backup also failed: contract is "on backup" (both pointers equal).
    wireAttempt(
      attemptFixture({
        attemptNumber: 3,
        errorCode: "INSUFFICIENT_FUNDS",
        usedBackupPayment: true,
        contract: contractFixture({
          paymentMethodId: "pm_backup",
          backupPaymentMethodId: "pm_backup",
        }),
      }),
    );
    mocks.dunningCaseFindFirst.mockResolvedValue(openCase());
    mocks.attemptCount.mockResolvedValue(1);

    await onBillingAttemptFailed("att_h1");

    // Restored from the case column, not from the lossy event channel.
    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/SubscriptionDraft/1",
      "pm_orig",
    );
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "cm_c1" },
      data: { paymentMethodId: "pm_orig" },
    });
    const backupUsedLookups = mocks.subscriberEventFindFirst.mock.calls.filter(
      (c) =>
        (c[0] as { where?: { type?: string } })?.where?.type ===
        "dunning.backup_used",
    );
    expect(backupUsedLookups).toHaveLength(0);

    const reverted = eventsOfType("dunning.backup_reverted");
    expect(reverted).toHaveLength(1);
    expect(reverted[0].payload).toMatchObject({
      restoredPaymentMethodId: "pm_orig",
    });
  });

  it("a legacy case without the column still falls back to the backup_used event payload", async () => {
    wireAttempt(
      attemptFixture({
        attemptNumber: 3,
        errorCode: "INSUFFICIENT_FUNDS",
        usedBackupPayment: true,
        contract: contractFixture({
          paymentMethodId: "pm_backup",
          backupPaymentMethodId: "pm_backup",
        }),
      }),
    );
    mocks.dunningCaseFindFirst.mockResolvedValue(
      openCase({ originalPaymentMethodId: null }),
    );
    mocks.attemptCount.mockResolvedValue(1);
    mocks.subscriberEventFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { type?: string } })?.where;
      if (where?.type === "dunning.backup_used") {
        return { payload: { previousPaymentMethodId: "pm_event_orig" } };
      }
      return null;
    });

    await onBillingAttemptFailed("att_h1");

    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "cm_c1" },
      data: { paymentMethodId: "pm_event_orig" },
    });
  });
});

describe("a late failure for a PAID cycle is discriminated, never dunned", () => {
  it("logs billing.attempt_failed with outcome FAILED + superseded true and opens nothing", async () => {
    wireAttempt(attemptFixture({ attemptNumber: 2 }));
    // The cycle already has a SUCCESS sibling: a 3DS challenge abandoned
    // days after a retry recovered the cycle lands here.
    mocks.attemptFindFirst.mockResolvedValue({ id: "att_success" });

    await onBillingAttemptFailed("att_h1");

    expect(mocks.dunningCaseCreate).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const failed = eventsOfType("billing.attempt_failed");
    expect(failed).toHaveLength(1);
    // The discriminators event-derived failure features filter on: a real
    // decline, but for a cycle that PAID.
    expect(failed[0].payload).toMatchObject({
      outcome: "FAILED",
      superseded: true,
      reason: "cycle_already_succeeded",
    });
  });
});

describe("the 3DS success fold survives an already-claimed SUCCESS (BD-3)", () => {
  it("folds resolution SUCCEEDED when the claim already stamped SUCCESS", async () => {
    wireAttempt(
      attemptFixture({
        status: "SUCCESS",
        amountCents: 5760,
        currencyCode: "CHF",
        mitEvidence: {
          type: "MIT",
          threeDS: {
            challenged: true,
            resolution: "PENDING_CUSTOMER_ACTION",
          },
        },
      }),
    );

    await onBillingAttemptSucceeded("att_h1");

    const evidenceWrites = mocks.attemptUpdate.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .filter((d) => d.mitEvidence !== undefined);
    expect(evidenceWrites).toHaveLength(1);
    const threeDS = (
      evidenceWrites[0].mitEvidence as {
        threeDS: Record<string, unknown>;
      }
    ).threeDS;
    expect(threeDS.resolution).toBe("SUCCEEDED");
    expect(typeof threeDS.resolvedAt).toBe("string");
    // The settled row's status is never rewritten by the fold.
    expect(evidenceWrites[0].status).toBeUndefined();
  });

  it("an already-SUCCEEDED resolution is left alone — redrives never restamp resolvedAt", async () => {
    wireAttempt(
      attemptFixture({
        status: "SUCCESS",
        amountCents: 5760,
        currencyCode: "CHF",
        mitEvidence: {
          type: "MIT",
          threeDS: {
            challenged: true,
            resolution: "SUCCEEDED",
            resolvedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      }),
    );

    await onBillingAttemptSucceeded("att_h1");

    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
  });

  it("an unchallenged success writes no evidence at all", async () => {
    wireAttempt(
      attemptFixture({
        status: "SUCCESS",
        amountCents: 5760,
        currencyCode: "CHF",
        mitEvidence: { type: "MIT" },
      }),
    );

    await onBillingAttemptSucceeded("att_h1");

    expect(mocks.attemptUpdate).not.toHaveBeenCalled();
  });
});
