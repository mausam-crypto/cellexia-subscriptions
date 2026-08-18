import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BACKUP-CARD SWITCH × "your payment method was updated" notification.
 *
 * changePaymentMethodToBackup switches the contract to the backup instrument
 * and refreshes the mirrored card metadata — but it used to do so only in the
 * DATABASE. handleSoftFailure then called notifyPaymentMethodChanged with the
 * STALE in-memory contract, so the trust email ("never silently bill a
 * different card") named the brand/last4 of the card that just FAILED: a
 * customer on Visa •4242 with backup Mastercard •1111 was told renewals
 * charge Visa •4242 while the actual charge landed on •1111.
 *
 * The contract now, driven against the REAL engine (real handleSoftFailure →
 * changePaymentMethodToBackup → refreshCardMirror → notifyPaymentMethodChanged
 * sequence, mocked seams):
 *  - the switch syncs the in-memory contract (pointer + card mirror), so the
 *    payment_method_updated vars carry the BACKUP card's brand/last4;
 *  - the dunning.backup_used event still records the PRE-switch instrument as
 *    previousPaymentMethodId (captured before the switch — the revert path's
 *    legacy fallback reads it);
 *  - a failed mirror refresh stays contained: the switch, the event and the
 *    notification all still happen (old best-effort behavior).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(
    async (_args?: unknown): Promise<unknown> => ({ status: "SENT" }),
  ),
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
      findMany: vi.fn(async (): Promise<unknown[]> => []),
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
import { onBillingAttemptFailed } from "~/lib/dunning/engine.server";

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
    cardLast4: "4242",
    cardBrand: "Visa",
    cardExpiryMonth: 4,
    cardExpiryYear: 2027,
    paymentMethodId: "pm_main",
    backupPaymentMethodId: "pm_backup",
    originOrderId: "gid://shopify/Order/1",
    deliveryPriceCents: 0,
    consecutiveFailures: 1,
    lines: [{ currentPriceCents: 5400, quantity: 1 }],
    ...over,
  };
}

/** SOFT failure #2 — the rung where the backup fallback kicks in. */
function attemptFixture(over: Record<string, unknown> = {}) {
  return {
    id: "att_s2",
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex: 5,
    attemptNumber: 2,
    status: "FAILED",
    declineCategory: null,
    dunningClaimedAt: null,
    errorCode: "INSUFFICIENT_FUNDS",
    amountCents: null,
    currencyCode: null,
    completedAt: null,
    mitEvidence: null,
    usedBackupPayment: false,
    idempotencyKey: "cm_c1:5:2",
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/2",
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
    ladderStep: 1,
    emailsSent: 1,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
    amountAtRiskCents: 5400,
    amountAtRiskCurrencyCode: "CHF",
    originalPaymentMethodId: "pm_main",
    ladderCursor: 1,
    ...over,
  };
}

function wireAttempt(attempt: Record<string, unknown>): void {
  mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { id?: string } })?.where;
    if (where?.id === attempt.id) return attempt;
    if (where?.id === "att_trigger") return { cycleIndex: 5 }; // same cycle
    return null;
  });
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

function sendsOfTemplate(template: string): Array<Record<string, unknown>> {
  return mocks.sendNotification.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((s) => s.template === template);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never), // backupPaymentFallback: true (registry default)
  );
  mocks.dunningCaseFindFirst.mockResolvedValue(openCase());
  mocks.attemptFindFirst.mockResolvedValue(null); // no SUCCESS sibling
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
  mocks.subscriberEventFindFirst.mockResolvedValue(null);
  mocks.attemptCount.mockImplementation(async (args?: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    if (where.usedBackupPayment) return 0; // backup untried this cycle
    return 1; // one prior failure → this schedules retry #2
  });
  // Shopify knows both instruments; the backup is the Mastercard.
  mocks.listCustomerPaymentMethods.mockResolvedValue([
    {
      id: "pm_main",
      instrument: {
        brand: "Visa",
        lastDigits: "4242",
        expiryMonth: 4,
        expiryYear: 2027,
      },
    },
    {
      id: "pm_backup",
      revoked: false,
      instrument: {
        type: "CREDIT_CARD",
        brand: "Mastercard",
        lastDigits: "1111",
        expiryMonth: 12,
        expiryYear: 2028,
      },
    },
  ]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the switch notification names the card ACTUALLY being charged", () => {
  it("payment_method_updated carries the BACKUP card's brand/last4, not the failed card's", async () => {
    wireAttempt(attemptFixture());

    await onBillingAttemptFailed("att_s2");

    const sends = sendsOfTemplate("payment_method_updated");
    expect(sends).toHaveLength(1);
    // The whole point of the email: the instrument renewals now charge.
    expect(sends[0].vars).toMatchObject({
      card_brand: "Mastercard",
      card_last4: "1111",
      via_backup: true,
    });

    // The card mirror was refreshed in the DB too (failure emails later in
    // the case read it from there).
    // v1.28.0 (migration 0027): the refresh also mirrors the instrument
    // type and clears the revoked stamp — the method just chosen is live.
    expect(mocks.contractUpdate).toHaveBeenCalledWith({
      where: { id: "cm_c1" },
      data: {
        cardBrand: "Mastercard",
        cardLast4: "1111",
        cardExpiryMonth: 12,
        cardExpiryYear: 2028,
        paymentInstrumentType: "CREDIT_CARD",
        paymentMethodRevokedAt: null,
      },
    });
  });

  it("dunning.backup_used still records the PRE-switch instrument (the revert's legacy fallback)", async () => {
    wireAttempt(attemptFixture());

    await onBillingAttemptFailed("att_s2");

    const used = eventsOfType("dunning.backup_used");
    expect(used).toHaveLength(1);
    expect(used[0].payload).toMatchObject({
      previousPaymentMethodId: "pm_main",
      backupPaymentMethodId: "pm_backup",
    });
    // And the Shopify-side switch targeted the backup.
    expect(mocks.draftUpdatePaymentMethod).toHaveBeenCalledWith(
      expect.anything(),
      "gid://shopify/SubscriptionDraft/1",
      "pm_backup",
    );
  });

  it("a failed mirror refresh stays contained: switch, event and notification all still happen", async () => {
    wireAttempt(attemptFixture());
    mocks.listCustomerPaymentMethods.mockRejectedValue(
      new Error("shopify down"),
    );

    await onBillingAttemptFailed("att_s2");

    expect(eventsOfType("dunning.backup_used")).toHaveLength(1);
    const sends = sendsOfTemplate("payment_method_updated");
    expect(sends).toHaveLength(1);
    // Best-effort: without a refreshed mirror the last-known metadata is all
    // there is — the old behavior, deliberately preserved.
    expect(sends[0].vars).toMatchObject({ via_backup: true });
    // The retry was still scheduled on the backup (1h delay path).
    expect(eventsOfType("dunning.retry_scheduled")).toHaveLength(1);
    expect(eventsOfType("dunning.retry_scheduled")[0].payload).toMatchObject({
      viaBackup: true,
    });
  });
});
