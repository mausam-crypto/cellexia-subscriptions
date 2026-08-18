import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "ON BACKUP" POINTER MARKER — collapse when the case closes (Stage G review
 * fix, v1.28.0).
 *
 * The engine's backup swap keeps both pointers equal (paymentMethodId ===
 * backupPaymentMethodId) so the same case can revert. Nothing ever
 * re-pointed them on the success path, so after ANY recovery on the backup
 * card the contract read "on backup" forever: the portal hid the
 * Set-as-backup toggle and printed "we're using your backup card while your
 * main card is fixed", setBackupPaymentMethod refused with BACKUP_IN_USE and
 * the next cycle had no backup coverage.
 *
 * Driven against the REAL engine (mocked seams):
 *  - onBillingAttemptSucceeded on a backup-charged attempt with an open case
 *    → the case resolves AND the marker collapses: the old primary (the
 *    case's originalPaymentMethodId) becomes the backup, `contract.backup_promoted`
 *    is logged with the case id;
 *  - no distinct original known → the backup is cleared (`contract.backup_payment_cleared`);
 *  - pointers not equal → nothing is touched;
 *  - exhaustCase on a case still on the backup → the same collapse;
 *  - the collapse is contained (a failed write never breaks the recovery).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(async (_args?: unknown): Promise<unknown> => ({ status: "SENT" })),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  attemptCount: vi.fn(async (_a?: unknown) => 0),
  subscriberEventFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFail: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const db: Record<string, unknown> = {
    dunningCase: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: mocks.dunningCaseFindFirst,
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
    notificationLog: { findFirst: vi.fn(async (): Promise<unknown> => null) },
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
    contractFail: mocks.contractFail,
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({ attemptId: "gid://x/1" })),
    draftUpdatePaymentMethod: vi.fn(async (): Promise<void> => {}),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(async (): Promise<void> => {}),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import { exhaustCase, onBillingAttemptSucceeded } from "~/lib/dunning/engine.server";

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
    cardLast4: "1111",
    cardBrand: "Mastercard",
    cardExpiryMonth: 12,
    cardExpiryYear: 2028,
    // Engine swapped: both pointers on the backup.
    paymentMethodId: "pm_backup",
    backupPaymentMethodId: "pm_backup",
    originOrderId: "gid://shopify/Order/1",
    deliveryPriceCents: 0,
    consecutiveFailures: 2,
    lines: [{ currentPriceCents: 5400, quantity: 1 }],
    ...over,
  };
}

function successAttempt(over: Record<string, unknown> = {}) {
  return {
    id: "att_s3",
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex: 5,
    attemptNumber: 3,
    status: "SUCCESS",
    declineCategory: null,
    dunningClaimedAt: null,
    errorCode: null,
    amountCents: 5400,
    currencyCode: "CHF",
    completedAt: new Date(),
    mitEvidence: null,
    usedBackupPayment: true,
    idempotencyKey: "cm_c1:5:3",
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/3",
    ...over,
  };
}

function openCase(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    state: "RETRYING",
    openedAt: new Date(Date.now() - 3 * 86_400_000),
    resolvedAt: null,
    resolution: null,
    nextRetryAt: null,
    triggerAttemptId: "att_trigger",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 2,
    emailsSent: 2,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
    amountAtRiskCents: 5400,
    amountAtRiskCurrencyCode: "CHF",
    originalPaymentMethodId: "pm_main",
    ladderCursor: 2,
    ...over,
  };
}

function wireAttempt(attempt: Record<string, unknown>): void {
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

function contractWrites(): Array<Record<string, unknown>> {
  return mocks.contractUpdate.mock.calls.map(
    (c) => (c[0] as { data: Record<string, unknown> }).data,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  mocks.dunningCaseFindFirst.mockResolvedValue(openCase());
  mocks.attemptFindFirst.mockResolvedValue(null);
  mocks.attemptCount.mockResolvedValue(1);
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("onBillingAttemptSucceeded — collapse of the on-backup marker", () => {
  it("backup-charged recovery: case RECOVERED, old primary demoted to backup, contract.backup_promoted logged", async () => {
    wireAttempt(successAttempt());
    await onBillingAttemptSucceeded("att_s3");

    // Case resolved.
    const caseWrite = mocks.dunningCaseUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(caseWrite.data).toMatchObject({ state: "RECOVERED", resolution: "RECOVERED" });

    // Marker collapsed: primary stays the (now proven) backup card, the old
    // primary becomes the backup so the next case can still fall back.
    const collapse = contractWrites().find((d) => "backupPaymentMethodId" in d);
    expect(collapse).toMatchObject({ backupPaymentMethodId: "pm_main", backupSetBy: "ENGINE" });
    expect(collapse?.backupSetAt).toBeInstanceOf(Date);
    expect(contractWrites().some((d) => "paymentMethodId" in d)).toBe(false);

    const [ev] = eventsOfType("contract.backup_promoted");
    expect(ev.payload).toMatchObject({
      dunningCaseId: "case_1",
      reason: "recovered",
      setBy: "ENGINE",
      paymentMethodId: "pm_backup",
      previousBackupPaymentMethodId: "pm_backup",
      backupPaymentMethodId: "pm_main",
    });
    expect(eventsOfType("contract.backup_payment_cleared")).toHaveLength(0);
    // The recovery bookkeeping still happened.
    expect(eventsOfType("dunning.recovered")).toHaveLength(1);
  });

  it("no distinct original known (case stamped with the backup itself / null): the backup is cleared instead", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(openCase({ originalPaymentMethodId: null }));
    wireAttempt(successAttempt());
    await onBillingAttemptSucceeded("att_s3");
    const collapse = contractWrites().find((d) => "backupPaymentMethodId" in d);
    expect(collapse).toMatchObject({ backupPaymentMethodId: null, backupSetBy: "ENGINE" });
    expect(eventsOfType("contract.backup_payment_cleared")[0].payload).toMatchObject({
      dunningCaseId: "case_1",
      reason: "recovered",
      previousBackupPaymentMethodId: "pm_backup",
    });

    vi.clearAllMocks();
    mocks.dunningCaseFindFirst.mockResolvedValue(openCase({ originalPaymentMethodId: "pm_backup" }));
    wireAttempt(successAttempt());
    await onBillingAttemptSucceeded("att_s3");
    expect(contractWrites().find((d) => "backupPaymentMethodId" in d)).toMatchObject({
      backupPaymentMethodId: null,
    });
  });

  it("pointers NOT equal (primary card recovered, backup merely configured): nothing is touched", async () => {
    wireAttempt(
      successAttempt({
        usedBackupPayment: false,
        contract: contractFixture({ paymentMethodId: "pm_main", backupPaymentMethodId: "pm_backup" }),
      }),
    );
    await onBillingAttemptSucceeded("att_s3");
    expect(contractWrites().some((d) => "backupPaymentMethodId" in d)).toBe(false);
    expect(eventsOfType("contract.backup_promoted")).toHaveLength(0);
    expect(eventsOfType("contract.backup_payment_cleared")).toHaveLength(0);
    expect(eventsOfType("dunning.recovered")).toHaveLength(1);
  });

  it("no backup configured at all: nothing is touched", async () => {
    wireAttempt(
      successAttempt({
        usedBackupPayment: false,
        contract: contractFixture({ paymentMethodId: "pm_main", backupPaymentMethodId: null }),
      }),
    );
    await onBillingAttemptSucceeded("att_s3");
    expect(contractWrites().some((d) => "backupPaymentMethodId" in d)).toBe(false);
  });

  it("the collapse is contained: a failed write leaves the recovery (case + events) intact", async () => {
    wireAttempt(successAttempt());
    mocks.contractUpdate.mockImplementation(async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      if ("backupPaymentMethodId" in data) throw new Error("db down");
      return args;
    });
    await expect(onBillingAttemptSucceeded("att_s3")).resolves.toBeUndefined();
    expect(mocks.dunningCaseUpdate).toHaveBeenCalled();
    expect(eventsOfType("dunning.recovered")).toHaveLength(1);
    expect(eventsOfType("contract.backup_promoted")).toHaveLength(0);
    mocks.contractUpdate.mockImplementation(async (args: unknown) => args);
  });
});

describe("exhaustCase — a case parked while still on the backup collapses the marker too", () => {
  it("EXHAUSTED with pointers equal → old primary becomes the backup (reason exhausted)", async () => {
    mocks.getSetting.mockImplementation(async (_shopId: string, key: string) => {
      const d = defaultFor(key as never) as Record<string, unknown>;
      return key === "dunning" ? { ...d, exhaustedAction: "PAUSE" } : d;
    });
    const contract = contractFixture() as never;
    await exhaustCase(openCase() as never, contract, "SCHEDULER");
    const collapse = contractWrites().find((d) => "backupPaymentMethodId" in d);
    expect(collapse).toMatchObject({ backupPaymentMethodId: "pm_main", backupSetBy: "ENGINE" });
    expect(eventsOfType("contract.backup_promoted")[0].payload).toMatchObject({
      dunningCaseId: "case_1",
      reason: "exhausted",
    });
    expect(eventsOfType("dunning.exhausted")).toHaveLength(1);
  });
});
