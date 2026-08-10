import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ASK SHOPIFY BEFORE CANCELLING A PAYING CUSTOMER — the dunning sweep's
 * pre-exhaustion 3DS re-check (phase (c)).
 *
 * An AWAITING_3DS case whose outcome webhook was lost used to exhaust purely
 * on daysOpen: the contract of a customer who COMPLETED the challenge got
 * FAILED/CANCELLED, the paid cycle stayed unrecorded, and win-back emails
 * went to someone in good standing. Phase (c) now probes Shopify (through
 * the billing module's status-guarded re-query, recheckAttemptOutcome) one
 * last time before the irreversible step:
 *  - SUCCESS/FAILED → the settlement/failure hooks already re-owned the
 *    case; this sweep pass exhausts nothing;
 *  - UNRESOLVED (or no challenged attempt left) → the timeout stands.
 * AWAITING_CUSTOMER cases never probe — their outcome was never in doubt.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  dunningCaseUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  contractFail: vi.fn(async (): Promise<void> => {}),
  recheckAttemptOutcome: vi.fn(async (): Promise<string> => "UNRESOLVED"),
}));

vi.mock("~/db.server", () => {
  const db: Record<string, unknown> = {
    dunningCase: {
      findMany: mocks.dunningCaseFindMany,
      findFirst: mocks.dunningCaseFindFirst,
      update: mocks.dunningCaseUpdate,
      updateMany: mocks.dunningCaseUpdateMany,
    },
    subscriptionContract: { update: mocks.contractUpdate },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findFirst: mocks.attemptFindFirst,
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
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
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
      attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    })),
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(),
  };
});
// The engine lazy-imports the billing scheduler for the probe — intercept it
// so the probe's outcome is scriptable per test.
vi.mock("~/lib/billing/scheduler.server", () => ({
  recheckAttemptOutcome: mocks.recheckAttemptOutcome,
}));

import { defaultFor } from "~/lib/settings/registry.server";
import { runDunningSweep } from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-06T10:00:00.000Z");
const DAY_MS = 86_400_000;

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
    deliveryPriceCents: 0,
    lines: [],
    ...over,
  };
}

/** A case parked 40 days ago — past cancelAfterFailedDays (default 30). */
function timedOutCase(over: Record<string, unknown> = {}) {
  return {
    id: "case_3ds",
    contractId: "cm_c1",
    contract: contractFixture(),
    state: "AWAITING_3DS",
    openedAt: new Date(NOW.getTime() - 40 * DAY_MS),
    resolvedAt: null,
    resolution: null,
    nextRetryAt: null,
    triggerAttemptId: "att_trigger",
    declineCode: "AUTHENTICATION_ERROR",
    declineCategory: "AUTH_REQUIRED",
    ladderStep: 0,
    // Ladder cursors past every rung/SMS so phase (b) stays quiet.
    emailsSent: 3,
    smsSent: 1,
    ladderCursor: 3,
    lastNotifiedAt: null,
    paydayAligned: false,
    amountAtRiskCents: 5400,
    amountAtRiskCurrencyCode: "CHF",
    originalPaymentMethodId: "pm_main",
    ...over,
  };
}

const CHALLENGED_ROW = {
  id: "att_ch",
  contractId: "cm_c1",
  cycleIndex: 5,
  attemptNumber: 1,
  status: "CHALLENGED",
  shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/77",
};

function exhaustedWrites(): Array<Record<string, unknown>> {
  return mocks.dunningCaseUpdate.mock.calls
    .map((c) => (c[0] as { data: Record<string, unknown> }).data)
    .filter((d) => d.state === "EXHAUSTED");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  // The trigger attempt anchors the case's cycle; the newest CHALLENGED
  // attempt is what the probe re-checks.
  mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { id?: string } })?.where;
    return where?.id === "att_trigger" ? { cycleIndex: 5 } : null;
  });
  mocks.attemptFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: Record<string, unknown> })?.where ?? {};
    return where.status === "CHALLENGED" ? CHALLENGED_ROW : null;
  });
  mocks.recheckAttemptOutcome.mockResolvedValue("UNRESOLVED");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("phase (c) pre-exhaustion re-check", () => {
  it("a re-check that finds SUCCESS stops the exhaustion — nothing is failed or cancelled", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);
    mocks.recheckAttemptOutcome.mockResolvedValue("SUCCESS");

    const stats = await runDunningSweep(NOW);

    expect(mocks.recheckAttemptOutcome).toHaveBeenCalledWith("att_ch");
    expect(stats.exhausted).toBe(0);
    expect(exhaustedWrites()).toHaveLength(0);
    expect(mocks.contractFail).not.toHaveBeenCalled();
    // The settlement path (driven inside the re-check) owns the case now —
    // and this pass must not ladder notifications at it either.
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });

  it("a re-check that finds FAILED also yields — the failure engine re-owned the case", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);
    mocks.recheckAttemptOutcome.mockResolvedValue("FAILED");

    const stats = await runDunningSweep(NOW);

    expect(stats.exhausted).toBe(0);
    expect(exhaustedWrites()).toHaveLength(0);
    expect(mocks.contractFail).not.toHaveBeenCalled();
  });

  it("an UNRESOLVED re-check falls through to the timeout (exhausted, contract failed)", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);

    const stats = await runDunningSweep(NOW);

    expect(mocks.recheckAttemptOutcome).toHaveBeenCalledWith("att_ch");
    expect(stats.exhausted).toBe(1);
    expect(exhaustedWrites()).toHaveLength(1);
    expect(mocks.contractFail).toHaveBeenCalledTimes(1); // default action PAUSE
  });

  it("with no challenged attempt left there is nothing to probe — the timeout stands", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);
    mocks.attemptFindFirst.mockResolvedValue(null);

    const stats = await runDunningSweep(NOW);

    expect(mocks.recheckAttemptOutcome).not.toHaveBeenCalled();
    expect(stats.exhausted).toBe(1);
  });

  it("a probe failure is contained — logged, treated as nothing-new, timeout stands", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);
    mocks.recheckAttemptOutcome.mockRejectedValue(new Error("shopify down"));

    const stats = await runDunningSweep(NOW);

    expect(stats.exhausted).toBe(1);
    expect(exhaustedWrites()).toHaveLength(1);
  });

  it("AWAITING_CUSTOMER cases never probe Shopify — their outcome was never in doubt", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([
      timedOutCase({
        id: "case_cust",
        state: "AWAITING_CUSTOMER",
        declineCode: "EXPIRED_PAYMENT_METHOD",
        declineCategory: "HARD",
      }),
    ]);

    const stats = await runDunningSweep(NOW);

    expect(mocks.recheckAttemptOutcome).not.toHaveBeenCalled();
    expect(stats.exhausted).toBe(1);
  });

  it("the exhausted event reports the case's frozen money and the cursor/count split", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([timedOutCase()]);

    await runDunningSweep(NOW);

    const exhausted = mocks.logEvent.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.type === "dunning.exhausted");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].payload).toMatchObject({
      amountAtRiskCents: 5400,
      currencyCode: "CHF",
      emailsSent: 3,
      ladderCursor: 3,
    });
  });
});
