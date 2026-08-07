import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BEHAVIOURAL regression tests for the webhook-driven dunning notification
 * dedupe (sendCaseNotificationOnce) — the crash-window duplicate-send audit
 * finding. The emailsSent/lastNotifiedAt cursor on a DunningCase is committed
 * only AFTER sendNotification, so a crash between the send and the cursor
 * write re-enters the same code path on webhook redelivery (or on the day-0
 * sweep rung). The engine must treat that re-entry as a cursor advance, never
 * as a second "payment failed" email.
 *
 * The real engine runs (onBillingAttemptFailed / onBillingAttemptChallenged /
 * runDunningSweep) against a mocked persistence seam. NotificationLog is
 * modeled as a set of already-SENT dedupe keys, exactly what the engine's
 * `payload.vars.dunning_dedupe` lookup reads; the sendNotification mock adds
 * the key it was called with, mirroring the SENT log row the real sender
 * writes.
 *
 * Invariants pinned here:
 *  1. First HARD-failure processing sends payment_failed_1 stamped with the
 *     ladder's own rung-0 key `{caseId}:EMAIL:0` and advances the cursor.
 *  2. Crash-window replay (SENT row exists, cursor missing): NO second send,
 *     cursor still advanced.
 *  3. The day-0 sweep rung sees the webhook path's send as its own (same
 *     template + key) — mutual dedupe, cursor advance only.
 *  4. The AUTH_REQUIRED fallback link and the CHALLENGED real 3DS link use
 *     DIFFERENT keys: the intentional two-email sequence still works, while
 *     each individual email deduplicates against its own redelivery.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: Record<string, unknown>): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => null),
  sendNotification: vi.fn(
    async (_input: {
      template: string;
      vars?: Record<string, unknown>;
    }): Promise<unknown> => ({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    }),
  ),
  dunningCaseFindMany: vi.fn(async (_a?: unknown): Promise<unknown[]> => []),
  dunningCaseFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  dunningCaseCreate: vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: "case_new",
    openedAt: new Date(),
    emailsSent: 0,
    smsSent: 0,
    ...args.data,
  })),
  dunningCaseUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  attemptFindUnique: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
  attemptUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  // The failure engine's atomic entry claim (dunningClaimedAt lease): the
  // single-invocation default is a won claim.
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

vi.mock("~/db.server", () => ({
  default: {
    dunningCase: {
      findMany: mocks.dunningCaseFindMany,
      findFirst: mocks.dunningCaseFindFirst,
      create: mocks.dunningCaseCreate,
      update: mocks.dunningCaseUpdate,
    },
    subscriptionContract: { update: mocks.contractUpdate },
    billingAttempt: {
      findUnique: mocks.attemptFindUnique,
      findFirst: mocks.attemptFindFirst,
      update: mocks.attemptUpdate,
      updateMany: mocks.attemptUpdateMany,
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
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
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({
      attemptId: "gid://shopify/SubscriptionBillingAttempt/900",
    })),
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import {
  onBillingAttemptChallenged,
  onBillingAttemptFailed,
  runDunningSweep,
} from "~/lib/dunning/engine.server";

const NOW = new Date("2026-08-06T10:00:00.000Z");

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
    cardBrand: "visa",
    paymentMethodId: "pm_main",
    backupPaymentMethodId: null,
    originOrderId: "gid://shopify/Order/1",
    deliveryPriceCents: 0,
    lines: [],
    ...over,
  };
}

/** An unprocessed failed attempt as loadAttempt returns it. */
function attemptFixture(over: Record<string, unknown> = {}) {
  return {
    id: "att_h1",
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex: 5,
    attemptNumber: 1,
    status: "FAILED",
    declineCategory: null, // processing-complete marker absent → full reprocess
    errorCode: "EXPIRED_PAYMENT_METHOD",
    amountCents: 5400,
    currencyCode: "CHF",
    completedAt: null,
    mitEvidence: null,
    usedBackupPayment: false,
    idempotencyKey: "cm_c1:5:1",
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
    ...over,
  };
}

function openCaseFixture(over: Record<string, unknown> = {}) {
  return {
    id: "case_1",
    contractId: "cm_c1",
    contract: contractFixture(),
    state: "AWAITING_CUSTOMER",
    openedAt: new Date(NOW.getTime() - 60 * 60 * 1000), // 1h ago → day 0
    resolvedAt: null,
    resolution: null,
    nextRetryAt: null,
    triggerAttemptId: "att_h1",
    declineCode: "EXPIRED_PAYMENT_METHOD",
    declineCategory: "HARD",
    ladderStep: 0,
    emailsSent: 0,
    smsSent: 0,
    lastNotifiedAt: null,
    paydayAligned: false,
    ...over,
  };
}

/**
 * NotificationLog modeled as the set of dedupe keys with a SENT row. The
 * engine's lookup shape is
 *   { where: { …, payload: { path: ["vars","dunning_dedupe"], equals: key } } }
 * and the sendNotification mock records the key it sends, mirroring the SENT
 * row the real sender writes to NotificationLog.
 */
const sentKeys = new Set<string>();

function keyFromWhere(args: unknown): string | undefined {
  const where = (args as { where?: { payload?: { equals?: unknown } } })?.where;
  const key = where?.payload?.equals;
  return typeof key === "string" ? key : undefined;
}

/** Dedupe keys sendNotification was actually invoked with, in order. */
function sentDedupeKeys(): Array<string | undefined> {
  return mocks.sendNotification.mock.calls.map(
    (call) =>
      (call[0] as { vars?: Record<string, unknown> })?.vars?.dunning_dedupe as
        | string
        | undefined,
  );
}

/** Cursor commits: dunningCase.update calls that advance emailsSent. */
function cursorWrites(): Array<Record<string, unknown>> {
  return mocks.dunningCaseUpdate.mock.calls
    .map((call) => (call[0] as { data: Record<string, unknown> }).data)
    .filter((data) => data.emailsSent !== undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  sentKeys.clear();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  mocks.notificationLogFindFirst.mockImplementation(async (args: unknown) => {
    const key = keyFromWhere(args);
    return key !== undefined && sentKeys.has(key) ? { id: "nl_1" } : null;
  });
  mocks.sendNotification.mockImplementation(
    async (input: { template: string; vars?: Record<string, unknown> }) => {
      const key = input.vars?.dunning_dedupe;
      if (typeof key === "string") sentKeys.add(key);
      return { status: "SENT", klaviyoEnqueued: true, directEmailSent: false };
    },
  );
});

describe("HARD failure notification (handleHardFailure via onBillingAttemptFailed)", () => {
  beforeEach(() => {
    mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { id?: string } })?.where;
      return where?.id === "att_h1" ? attemptFixture() : null;
    });
    // No open case → ensureOpenCase creates one; no succeeded attempt for the cycle.
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    mocks.attemptFindFirst.mockResolvedValue(null);
    mocks.dunningCaseCreate.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        openCaseFixture({ id: "case_new", ...args.data }),
    );
  });

  it("first processing sends payment_failed_1 with the ladder rung-0 key and advances the cursor", async () => {
    await onBillingAttemptFailed("att_h1");

    expect(sentDedupeKeys()).toEqual(["case_new:EMAIL:0"]);
    const templates = mocks.sendNotification.mock.calls.map(
      (call) => (call[0] as { template: string }).template,
    );
    expect(templates).toEqual(["payment_failed_1"]);

    const cursors = cursorWrites();
    expect(cursors).toHaveLength(1);
    expect(cursors[0].emailsSent).toBe(1);
    expect(cursors[0].lastNotifiedAt).toBeInstanceOf(Date);
  });

  it("crash-window replay (SENT row exists, cursor missing) advances the cursor WITHOUT a second send", async () => {
    sentKeys.add("case_new:EMAIL:0"); // the pre-crash send's NotificationLog row

    await onBillingAttemptFailed("att_h1");

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const cursors = cursorWrites();
    expect(cursors).toHaveLength(1);
    expect(cursors[0].emailsSent).toBe(1);
  });
});

describe("sweep day-0 rung vs webhook send (mutual dedupe)", () => {
  it("the sweep sees the webhook path's payment_failed_1 as its own rung 0: cursor advance, no email", async () => {
    sentKeys.add("case_1:EMAIL:0"); // webhook-driven initial notice already SENT
    mocks.dunningCaseFindMany.mockResolvedValue([openCaseFixture()]);

    const stats = await runDunningSweep(NOW);

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(stats.emailsSent).toBe(0); // DUPLICATE is not a send
    const cursors = cursorWrites();
    expect(cursors).toHaveLength(1);
    expect(cursors[0].emailsSent).toBe(1);
  });

  it("without a prior SENT row the sweep sends rung 0 exactly once, stamped with the shared key", async () => {
    mocks.dunningCaseFindMany.mockResolvedValue([openCaseFixture()]);
    mocks.attemptFindFirst.mockResolvedValue(attemptFixture()); // lastFailed lookup

    const stats = await runDunningSweep(NOW);

    expect(sentDedupeKeys()).toEqual(["case_1:EMAIL:0"]);
    expect(stats.emailsSent).toBe(1);
    expect(cursorWrites()).toHaveLength(1);

    // A second sweep racing past the cursor (crash before the write): the
    // SENT row recorded above turns it into a cursor advance.
    mocks.sendNotification.mockClear();
    mocks.dunningCaseUpdate.mockClear();
    mocks.dunningCaseFindMany.mockResolvedValue([openCaseFixture()]); // stale cursor
    const second = await runDunningSweep(NOW);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(second.emailsSent).toBe(0);
    expect(cursorWrites()).toHaveLength(1);
  });
});

describe("3DS: fallback link and real challenge link", () => {
  function wireAuthAttempt(id: string, over: Record<string, unknown> = {}) {
    mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
      const where = (args as { where?: { id?: string } })?.where;
      return where?.id === id
        ? attemptFixture({ id, errorCode: "AUTHENTICATION_ERROR", ...over })
        : null;
    });
  }

  it("fallback (AUTH_REQUIRED failure) and challenge (CHALLENGED webhook) use different keys — both send", async () => {
    // 1. Failure webhook before any challenge → threeds_action fallback link.
    wireAuthAttempt("att_a1");
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    mocks.attemptFindFirst.mockResolvedValue(null);
    mocks.dunningCaseCreate.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        openCaseFixture({ id: "case_a", state: "AWAITING_3DS", ...args.data }),
    );
    await onBillingAttemptFailed("att_a1");
    expect(sentDedupeKeys()).toEqual(["case_a:THREEDS:fallback"]);

    // 2. CHALLENGED webhook delivers the real redirect URL → second
    //    threeds_action is INTENTIONAL (different key).
    mocks.dunningCaseFindFirst.mockResolvedValue(
      openCaseFixture({ id: "case_a", state: "AWAITING_CUSTOMER" }),
    );
    await onBillingAttemptChallenged("att_a1", "https://bank.example/3ds");
    expect(sentDedupeKeys()).toEqual([
      "case_a:THREEDS:fallback",
      "case_a:THREEDS:challenge:att_a1",
    ]);
  });

  it("a replayed CHALLENGED webhook that slips past the state guard never re-sends the link", async () => {
    // Both state writes committed and the email SENT, but the process died
    // before the cursor write; the redelivered webhook re-enters with the
    // case NOT yet AWAITING_3DS-guarded (e.g. concurrent delivery raced the
    // guard read). The per-attempt dedupe key must stop the second email.
    wireAuthAttempt("att_a1");
    sentKeys.add("case_a:THREEDS:challenge:att_a1");
    mocks.dunningCaseFindFirst.mockResolvedValue(
      openCaseFixture({ id: "case_a", state: "AWAITING_CUSTOMER" }),
    );

    await onBillingAttemptChallenged("att_a1", "https://bank.example/3ds");

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    const cursors = cursorWrites();
    expect(cursors).toHaveLength(1);
    expect(cursors[0].emailsSent).toBe(1);
  });

  it("a NEW attempt challenged later in the same case still gets its own fresh link", async () => {
    wireAuthAttempt("att_a2", { attemptNumber: 2 });
    sentKeys.add("case_a:THREEDS:challenge:att_a1"); // previous attempt's link
    mocks.dunningCaseFindFirst.mockResolvedValue(
      openCaseFixture({ id: "case_a", state: "AWAITING_3DS" }),
    );

    await onBillingAttemptChallenged("att_a2", "https://bank.example/3ds-2");

    expect(sentDedupeKeys()).toEqual(["case_a:THREEDS:challenge:att_a2"]);
  });
});
