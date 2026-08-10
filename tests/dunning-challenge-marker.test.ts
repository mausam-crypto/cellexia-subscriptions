import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 3DS CHALLENGE STAMP × FAILURE-ENGINE MARKER (stability pass).
 *
 * BillingAttempt.declineCategory is onBillingAttemptFailed's written-LAST
 * "processing complete" marker: its early-return guard (status FAILED +
 * category non-null) and its atomic entry claim (gated on category null) both
 * key on it. The challenge claims (onBillingAttemptChallenged, and the stale
 * sweep's CHALLENGED branch) used to stamp the ATTEMPT's declineCategory =
 * AUTH_REQUIRED at challenge time — so when the challenged attempt's real
 * FAILURE webhook later arrived (customer abandoned 3DS; bank declined after
 * authentication), the engine treated it as an already-processed redelivery
 * and never ran: no soft-retry ladder for recoverable post-3DS declines, no
 * consecutiveFailures increment, the wasChallenged mitEvidence fold
 * unreachable, and the settlement_redrive FAILED arm (category-NULL filter)
 * unable to repair the row. Auto-recovery revenue was silently lost on every
 * challenged renewal.
 *
 * The fix: challenge claims write the CASE's declineCategory and the
 * attempt's mitEvidence fold only — the attempt column stays null until the
 * failure engine has truly finished. These tests drive the REAL
 * onBillingAttemptChallenged → onBillingAttemptFailed sequence over one
 * stateful attempt/case store (dunning-concurrency harness).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  sendNotification: vi.fn(
    async (): Promise<unknown> => ({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    }),
  ),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  attempt: {} as Row,
  kase: null as Row | null,
}));

const db = vi.hoisted(() => {
  const matchesAttempt = (where: Row): boolean => {
    const a = state.attempt;
    if (where.id !== undefined && where.id !== a.id) return false;
    if ("declineCategory" in where && where.declineCategory === null) {
      if (a.declineCategory !== null) return false;
    }
    const status = where.status as unknown;
    if (typeof status === "string" && a.status !== status) return false;
    if (
      status !== null &&
      typeof status === "object" &&
      "in" in (status as Row) &&
      !((status as { in: unknown[] }).in ?? []).includes(a.status)
    ) {
      return false;
    }
    const or = where.OR as Array<Row> | undefined;
    if (or) {
      const ok = or.some((cond) => {
        if ("dunningClaimedAt" in cond) {
          const c = cond.dunningClaimedAt as { lt: Date } | null;
          if (c === null) return a.dunningClaimedAt == null;
          return (
            a.dunningClaimedAt instanceof Date &&
            a.dunningClaimedAt.getTime() < c.lt.getTime()
          );
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  };
  return {
    matchesAttempt,
    attemptUpdateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      if (!matchesAttempt(args.where)) return { count: 0 };
      Object.assign(state.attempt, args.data);
      return { count: 1 };
    }),
    attemptUpdate: vi.fn(async (args: { where: { id: string }; data: Row }) => {
      if (args.where.id === state.attempt.id) {
        Object.assign(state.attempt, args.data);
      }
      return state.attempt;
    }),
    caseCreate: vi.fn(async (args: { data: Row }) => {
      state.kase = {
        id: "case_1",
        state: "OPEN",
        openedAt: new Date(),
        emailsSent: 0,
        smsSent: 0,
        lastNotifiedAt: null,
        ladderStep: 0,
        paydayAligned: false,
        nextRetryAt: null,
        ...args.data,
      };
      return state.kase;
    }),
    caseUpdate: vi.fn(async (args: { data: Row }) => {
      if (state.kase) Object.assign(state.kase, args.data);
      return state.kase;
    }),
    // The exactly-once marker+counter transaction claims the case by id and
    // moves emailsSent via an atomic { increment } — mirror both semantics.
    caseUpdateMany: vi.fn(async (args: { where: Row; data: Row }) => {
      const k = state.kase;
      if (!k || (args.where.id !== undefined && args.where.id !== k.id)) {
        return { count: 0 };
      }
      const data: Row = { ...args.data };
      const inc = (data.emailsSent as { increment?: number } | undefined)
        ?.increment;
      if (typeof inc === "number") {
        data.emailsSent = ((k.emailsSent as number | undefined) ?? 0) + inc;
      }
      Object.assign(k, data);
      return { count: 1 };
    }),
  };
});

vi.mock("~/db.server", () => {
  const client = {
    dunningCase: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (args: unknown): Promise<unknown> => {
        const where = (args as { where?: { state?: { in?: string[] } } })?.where;
        if (!state.kase) return null;
        const states = where?.state?.in;
        if (states && !states.includes(state.kase.state as string)) return null;
        return state.kase;
      }),
      create: db.caseCreate,
      update: db.caseUpdate,
      updateMany: db.caseUpdateMany,
    },
    subscriptionContract: { update: mocks.contractUpdate },
    billingAttempt: {
      findUnique: vi.fn(async (args: unknown): Promise<unknown> => {
        const where = (args as { where?: { id?: string } })?.where;
        if (where?.id !== state.attempt.id) return null;
        return { ...state.attempt };
      }),
      // Only two findFirst shapes reach this harness: the cycle-SUCCESS
      // sibling check (none exists) — its where carries `status: "SUCCESS"`.
      findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
      update: db.attemptUpdate,
      updateMany: db.attemptUpdateMany,
      count: vi.fn(async (): Promise<number> => 0),
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    // The engine's marker+counter tx runs its callback over the same client.
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(client),
  };
  return { default: client };
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
} from "~/lib/dunning/engine.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: "Europe/Zurich",
  currencyCode: "CHF",
  contactEmail: "merchant@example.com",
};

function contractFixture() {
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
  };
}

function pendingAttempt(): Row {
  return {
    id: "att_1",
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex: 5,
    attemptNumber: 1,
    status: "PENDING",
    declineCategory: null,
    dunningClaimedAt: null,
    supersededAt: null,
    errorCode: null,
    amountCents: 5400,
    currencyCode: "CHF",
    completedAt: null,
    mitEvidence: null,
    usedBackupPayment: false,
    idempotencyKey: "cm_c1:5:1",
    shopifyAttemptId: "gid://shopify/SubscriptionBillingAttempt/1",
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.attempt = pendingAttempt();
  state.kase = null;
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
});

describe("3DS challenge must not stamp the failure engine's processed marker", () => {
  it("the challenge claim leaves attempt.declineCategory null (case + mitEvidence carry the 3DS state)", async () => {
    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    expect(state.attempt.status).toBe("CHALLENGED");
    // THE fix: the attempt-level marker is untouched at challenge time.
    expect(state.attempt.declineCategory).toBeNull();
    // The challenge state lives where it belongs.
    expect(state.kase).not.toBeNull();
    expect(state.kase).toMatchObject({
      state: "AWAITING_3DS",
      declineCategory: "AUTH_REQUIRED",
    });
    const evidence = state.attempt.mitEvidence as {
      threeDs?: Record<string, unknown>;
    } | null;
    expect(JSON.stringify(evidence)).toContain("PENDING_CUSTOMER_ACTION");
  });

  it("CHALLENGED → FAILURE(INSUFFICIENT_FUNDS) runs the engine: ladder scheduled, counter bumped, 3DS outcome folded, marker stamped LAST", async () => {
    // ── 1. The renewal is challenged; the case parks AWAITING_3DS. ──────────
    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");
    expect(state.attempt.declineCategory).toBeNull();

    // ── 2. Days later the customer never completed 3DS: Shopify delivers the
    //       FAILURE webhook. The handler settles the row FAILED (raw error
    //       only — the taxonomy is the engine's job) and hands off.
    Object.assign(state.attempt, {
      status: "FAILED",
      errorCode: "INSUFFICIENT_FUNDS",
      completedAt: new Date(),
    });
    await onBillingAttemptFailed("att_1");

    // Before the fix all of this was unreachable — the early-return guard saw
    // FAILED + AUTH_REQUIRED and treated the real failure as a redelivery.
    // The soft-retry ladder is scheduled on the SAME case:
    expect(state.kase).toMatchObject({
      state: "RETRYING",
      declineCategory: "SOFT",
      declineCode: "INSUFFICIENT_FUNDS",
    });
    expect(state.kase!.nextRetryAt).toBeInstanceOf(Date);
    expect(eventsOfType("dunning.retry_scheduled")).toHaveLength(1);

    // The failure counter moved exactly once:
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.contractUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { consecutiveFailures: { increment: 1 } },
      }),
    );

    // The wasChallenged branch folded the 3DS outcome into the compliance
    // evidence (this was dead code for every actually-challenged attempt):
    expect(JSON.stringify(state.attempt.mitEvidence)).toContain('"FAILED"');

    // And the processed marker was stamped LAST, with the REAL taxonomy of
    // the decline — not the challenge's AUTH_REQUIRED:
    expect(state.attempt.declineCategory).toBe("SOFT");
  });

  it("a FAILURE redelivery after full processing is still a no-op (the marker keeps its meaning)", async () => {
    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");
    Object.assign(state.attempt, {
      status: "FAILED",
      errorCode: "INSUFFICIENT_FUNDS",
      completedAt: new Date(),
    });
    await onBillingAttemptFailed("att_1");
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
    const retriesScheduled = eventsOfType("dunning.retry_scheduled").length;

    await onBillingAttemptFailed("att_1"); // Shopify redelivers

    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1); // no double count
    expect(eventsOfType("dunning.retry_scheduled")).toHaveLength(
      retriesScheduled, // no second rung
    );
  });
});
