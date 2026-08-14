import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CHALLENGED path × cross-cycle case scoping.
 *
 * ensureOpenCase's cross-cycle supersede (pinned by dunning-ladder.test.ts)
 * says a case is never reused across billing cycles: the ladder anchors every
 * offset to case.openedAt, and the sweep's cancelAfterFailedDays timeout
 * measures from it too. onBillingAttemptChallenged used to bypass that
 * contract with `existing ?? ensureOpenCase(...)` — ANY open case for the
 * contract was hijacked. When cycle N+1 was challenged while cycle N's case
 * was still RETRYING, the old case flipped to AWAITING_3DS with nextRetryAt
 * null (cycle N's scheduled retry silently cancelled), kept its stale
 * openedAt (the sweep could exhaust — fail/cancel — the contract while the
 * customer was mid-3DS on the new cycle), and the eventual 3DS success closed
 * it CUSTOMER_FIXED with cycle N's revenue stranded behind the b2 guard.
 *
 * The contract now, driven against the REAL engine with a stateful case
 * store:
 *  - a challenge only REUSES an open case anchored to the SAME cycle (legacy
 *    cases without a trigger attempt count as any-cycle);
 *  - a cross-cycle case is superseded exactly like the failure path
 *    (dunning.case_superseded, state CANCELLED/SUPERSEDED) and a FRESH
 *    cycle-anchored case with a fresh openedAt parks AWAITING_3DS;
 *  - the redelivery early-return only short-circuits on a SAME-cycle
 *    AWAITING_3DS case — a redelivered new-cycle challenge still gets its
 *    case and its 3DS link;
 *  - the 3DS link flow itself is unchanged (attempt-keyed dedupe key).
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
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

type Row = Record<string, unknown>;

const OPEN_STATES = ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"];

/** Stateful stores: cases by id, attempts by id (trigger lookups included). */
const state = vi.hoisted(() => ({
  cases: new Map<string, Record<string, unknown>>(),
  attempts: new Map<string, Record<string, unknown>>(),
  caseSeq: 0,
}));

vi.mock("~/db.server", () => {
  const client = {
    dunningCase: {
      findMany: vi.fn(async (): Promise<unknown[]> => []),
      findFirst: vi.fn(async (args: unknown): Promise<unknown> => {
        const where = (args as {
          where?: { contractId?: string; state?: { in?: string[] } };
        })?.where;
        const states = where?.state?.in ?? OPEN_STATES;
        const open = [...state.cases.values()]
          .filter(
            (k) =>
              (where?.contractId === undefined ||
                k.contractId === where.contractId) &&
              states.includes(k.state as string),
          )
          .sort(
            (a, b) =>
              (b.openedAt as Date).getTime() - (a.openedAt as Date).getTime(),
          );
        return open[0] ?? null;
      }),
      create: vi.fn(async (args: { data: Row }) => {
        const id = `case_${++state.caseSeq}`;
        const row: Row = {
          id,
          state: "OPEN",
          openedAt: new Date(),
          resolvedAt: null,
          resolution: null,
          nextRetryAt: null,
          emailsSent: 0,
          smsSent: 0,
          lastNotifiedAt: null,
          ladderStep: 0,
          ladderCursor: null,
          paydayAligned: false,
          ...args.data,
        };
        state.cases.set(id, row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
        const row = state.cases.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row ?? null;
      }),
      updateMany: vi.fn(async (args: { where: { id?: string }; data: Row }) => {
        const row = args.where.id ? state.cases.get(args.where.id) : undefined;
        if (!row) return { count: 0 };
        const data: Row = { ...args.data };
        const inc = (data.emailsSent as { increment?: number } | undefined)
          ?.increment;
        if (typeof inc === "number") {
          data.emailsSent = ((row.emailsSent as number | undefined) ?? 0) + inc;
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    subscriptionContract: { update: mocks.contractUpdate },
    billingAttempt: {
      findUnique: vi.fn(async (args: unknown): Promise<unknown> => {
        const where = (args as { where?: { id?: string } })?.where;
        const row = where?.id ? state.attempts.get(where.id) : undefined;
        return row ? { ...row } : null;
      }),
      // Only the cycle-SUCCESS sibling check reaches this harness — none exists.
      findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
      update: vi.fn(async (args: { where: { id: string }; data: Row }) => {
        const row = state.attempts.get(args.where.id);
        if (row) Object.assign(row, args.data);
        return row ?? null;
      }),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        const row = state.attempts.get(args.where.id as string);
        if (!row) return { count: 0 };
        const status = args.where.status as { in?: string[] } | undefined;
        if (status?.in && !status.in.includes(row.status as string)) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      }),
      count: vi.fn(async (): Promise<number> => 0),
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
    subscriberEvent: {
      findFirst: vi.fn(async (): Promise<unknown> => null),
    },
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
import { onBillingAttemptChallenged } from "~/lib/dunning/engine.server";

const NOW_MINUS_20D = new Date(Date.now() - 20 * 86_400_000);

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
    consecutiveFailures: 1,
    lines: [{ currentPriceCents: 5400, quantity: 1 }],
  };
}

function seedAttempt(id: string, cycleIndex: number, over: Row = {}): void {
  state.attempts.set(id, {
    id,
    contractId: "cm_c1",
    contract: contractFixture(),
    cycleIndex,
    attemptNumber: 1,
    status: "PENDING",
    declineCategory: null,
    dunningClaimedAt: null,
    errorCode: null,
    amountCents: 5400,
    currencyCode: "CHF",
    completedAt: null,
    mitEvidence: null,
    usedBackupPayment: false,
    idempotencyKey: `cm_c1:${cycleIndex}:1`,
    shopifyAttemptId: `gid://shopify/SubscriptionBillingAttempt/${id}`,
    ...over,
  });
}

function seedCase(id: string, over: Row = {}): Row {
  const row: Row = {
    id,
    contractId: "cm_c1",
    state: "RETRYING",
    openedAt: NOW_MINUS_20D,
    resolvedAt: null,
    resolution: null,
    nextRetryAt: new Date(Date.now() + 86_400_000), // cycle N's scheduled retry
    triggerAttemptId: "att_old",
    declineCode: "INSUFFICIENT_FUNDS",
    declineCategory: "SOFT",
    ladderStep: 1,
    emailsSent: 1,
    smsSent: 0,
    lastNotifiedAt: null,
    ladderCursor: 1,
    paydayAligned: false,
    amountAtRiskCents: 5400,
    amountAtRiskCurrencyCode: "CHF",
    originalPaymentMethodId: "pm_main",
    ...over,
  };
  state.cases.set(id, row);
  return row;
}

function eventsOfType(type: string): Array<Record<string, unknown>> {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e.type === type);
}

function sentDedupeKeys(): Array<string | undefined> {
  return mocks.sendNotification.mock.calls.map(
    (call) =>
      (call[0] as { vars?: Record<string, unknown> })?.vars?.dunning_dedupe as
        | string
        | undefined,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.cases.clear();
  state.attempts.clear();
  state.caseSeq = 0;
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
});

describe("a challenge on a NEW cycle never hijacks an older cycle's open case", () => {
  it("supersedes the cycle-5 RETRYING case and parks a FRESH cycle-6 case on AWAITING_3DS", async () => {
    seedAttempt("att_old", 5, { status: "FAILED", declineCategory: "SOFT" });
    seedAttempt("att_new", 6);
    const oldCase = seedCase("case_old");

    await onBillingAttemptChallenged("att_new", "https://bank.example/3ds");

    // The old case was SUPERSEDED like the failure path does it — never
    // flipped to AWAITING_3DS, never left holding a cancelled retry.
    expect(oldCase.state).toBe("CANCELLED");
    expect(oldCase.resolution).toBe("SUPERSEDED");
    expect(oldCase.nextRetryAt).toBeNull();
    const superseded = eventsOfType("dunning.case_superseded");
    expect(superseded).toHaveLength(1);
    expect(superseded[0].payload).toMatchObject({
      dunningCaseId: "case_old",
      caseCycleIndex: 5,
      supersededByCycleIndex: 6,
    });

    // A fresh case, anchored to the challenged attempt and its cycle, with a
    // fresh openedAt (the exhaust timeout and any later ladder anchor here).
    const fresh = [...state.cases.values()].find((k) => k.id !== "case_old");
    expect(fresh).toBeDefined();
    expect(fresh).toMatchObject({
      state: "AWAITING_3DS",
      declineCategory: "AUTH_REQUIRED",
      triggerAttemptId: "att_new",
      nextRetryAt: null,
    });
    expect((fresh!.openedAt as Date).getTime()).toBeGreaterThan(
      (oldCase.openedAt as Date).getTime(),
    );
    const opened = eventsOfType("dunning.case_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0].payload).toMatchObject({ cycleIndex: 6 });

    // The 3DS link flow is intact and keyed to the FRESH case + attempt.
    expect(sentDedupeKeys()).toEqual([
      `${fresh!.id}:THREEDS:challenge:att_new`,
    ]);
    const linkSent = eventsOfType("dunning.threeds_link_sent");
    expect(linkSent).toHaveLength(1);
    expect(linkSent[0].payload).toMatchObject({
      dunningCaseId: fresh!.id,
      attemptId: "att_new",
      cycleIndex: 6,
      fallback: false,
    });
  });

  it("a redelivered new-cycle challenge is NOT swallowed by the old cycle's AWAITING_3DS case", async () => {
    // Old cycle-5 case already parked AWAITING_3DS; the new cycle's attempt
    // was already stamped CHALLENGED (state committed, then crash before the
    // send) — the old early-return used to drop this redelivery entirely.
    seedAttempt("att_old", 5, { status: "CHALLENGED" });
    seedAttempt("att_new", 6, { status: "CHALLENGED" });
    seedCase("case_old", { state: "AWAITING_3DS", nextRetryAt: null });

    await onBillingAttemptChallenged("att_new", "https://bank.example/3ds");

    expect(eventsOfType("dunning.case_superseded")).toHaveLength(1);
    const fresh = [...state.cases.values()].find((k) => k.id !== "case_old");
    expect(fresh).toMatchObject({ state: "AWAITING_3DS", triggerAttemptId: "att_new" });
    expect(sentDedupeKeys()).toEqual([
      `${fresh!.id}:THREEDS:challenge:att_new`,
    ]);
  });
});

describe("same-cycle reuse and the redelivery early-return still hold (3DS flow pinned)", () => {
  it("reuses the open case anchored to the SAME cycle — no supersede, no new case", async () => {
    seedAttempt("att_trigger", 6, { status: "FAILED" });
    seedAttempt("att_new", 6);
    seedCase("case_same", {
      state: "AWAITING_CUSTOMER",
      triggerAttemptId: "att_trigger",
      nextRetryAt: null,
    });

    await onBillingAttemptChallenged("att_new", "https://bank.example/3ds");

    expect(eventsOfType("dunning.case_superseded")).toHaveLength(0);
    expect(state.cases.size).toBe(1);
    expect(state.cases.get("case_same")).toMatchObject({
      state: "AWAITING_3DS",
      declineCategory: "AUTH_REQUIRED",
    });
    expect(sentDedupeKeys()).toEqual(["case_same:THREEDS:challenge:att_new"]);
  });

  it("a legacy case without a trigger attempt counts as any-cycle and is reused", async () => {
    seedAttempt("att_new", 6);
    seedCase("case_legacy", {
      state: "AWAITING_CUSTOMER",
      triggerAttemptId: null,
      nextRetryAt: null,
    });

    await onBillingAttemptChallenged("att_new", "https://bank.example/3ds");

    expect(eventsOfType("dunning.case_superseded")).toHaveLength(0);
    expect(state.cases.size).toBe(1);
    expect(state.cases.get("case_legacy")).toMatchObject({
      state: "AWAITING_3DS",
    });
  });

  it("a true redelivery (same-cycle case already AWAITING_3DS) still returns early", async () => {
    seedAttempt("att_trigger", 6, { status: "CHALLENGED" });
    seedAttempt("att_new", 6, { status: "CHALLENGED" });
    seedCase("case_same", {
      state: "AWAITING_3DS",
      triggerAttemptId: "att_trigger",
      nextRetryAt: null,
    });

    await onBillingAttemptChallenged("att_new", "https://bank.example/3ds");

    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
    expect(state.cases.size).toBe(1);
  });
});
