import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P1.6 SMS leg (v1.28.0) — a 3-D Secure challenge texts the secure
 * confirmation link on day 0, next to the critical threeds_action email:
 *
 *  - contract with a phone + a real CONFIRM_3DS link → threeds_action_sms is
 *    sent through the router (the same consent path payment_failed_sms uses:
 *    phone on the contract, SMS channel toggle + template switch inside the
 *    router, Klaviyo SMS consent at delivery), with confirm_url = the
 *    CONFIRM_3DS magic link and the amount, deduped per attempt on
 *    `{caseId}:THREEDS_SMS:challenge:{attemptId}`;
 *  - no phone → no SMS (smsNotificationStatus "SKIPPED" on the
 *    dunning.threeds_link_sent event);
 *  - CONFIRM_3DS link build failed (email carries the update-card fallback)
 *    → NO SMS — only the real bank link is worth a text;
 *  - a redelivery finds the SENT row → DUPLICATE, no second text;
 *  - the SMS never touches the ladder's single smsDay text (case.smsSent
 *    stays 0) and a throwing SMS leg never breaks the challenge handling.
 *
 * Scaffold: tests/dunning-challenge-marker.test.ts (real
 * onBillingAttemptChallenged over a stateful attempt/case store).
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getSetting: vi.fn(async (_shopId: string, _key: string): Promise<unknown> => ({})),
  sendNotification: vi.fn(
    async (_input?: unknown): Promise<unknown> => ({
      status: "SENT",
      klaviyoEnqueued: true,
      directEmailSent: false,
    }),
  ),
  buildMagicUrl: vi.fn(
    async (input: { action: string }): Promise<string> =>
      `https://example.test/magic/${input.action}`,
  ),
  contractUpdate: vi.fn(async (args: unknown): Promise<unknown> => args),
  notificationLogFindFirst: vi.fn(async (_a?: unknown): Promise<unknown> => null),
}));

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  attempt: {} as Row,
  kase: null as Row | null,
}));

const db = vi.hoisted(() => ({
  attemptUpdateMany: vi.fn(async (args: { where: Row; data: Row }) => {
    const a = state.attempt;
    if (args.where.id !== undefined && args.where.id !== a.id) return { count: 0 };
    const status = args.where.status as { in?: string[] } | string | undefined;
    if (typeof status === "string" && a.status !== status) return { count: 0 };
    if (
      status &&
      typeof status === "object" &&
      !((status.in ?? []) as string[]).includes(a.status as string)
    ) {
      return { count: 0 };
    }
    Object.assign(a, args.data);
    return { count: 1 };
  }),
  caseCreate: vi.fn(async (args: { data: Row }) => {
    state.kase = {
      id: "case_1",
      state: "OPEN",
      openedAt: new Date(),
      emailsSent: 0,
      smsSent: 0,
      ladderCursor: null,
      lastNotifiedAt: null,
      nextRetryAt: null,
      ...args.data,
    };
    return state.kase;
  }),
  caseUpdate: vi.fn(async (args: { data: Row }) => {
    if (state.kase) Object.assign(state.kase, args.data);
    return state.kase;
  }),
  caseUpdateMany: vi.fn(async (args: { where: Row; data: Row }) => {
    const k = state.kase;
    if (!k || (args.where.id !== undefined && args.where.id !== k.id)) {
      return { count: 0 };
    }
    const data: Row = { ...args.data };
    const inc = (data.emailsSent as { increment?: number } | undefined)?.increment;
    if (typeof inc === "number") {
      data.emailsSent = ((k.emailsSent as number | undefined) ?? 0) + inc;
    }
    Object.assign(k, data);
    return { count: 1 };
  }),
}));

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
      findFirst: vi.fn(async (_args?: unknown): Promise<unknown> => null),
      update: vi.fn(async (args: { data: Row }) => {
        Object.assign(state.attempt, args.data);
        return state.attempt;
      }),
      updateMany: db.attemptUpdateMany,
      count: vi.fn(async (): Promise<number> => 0),
    },
    notificationLog: { findFirst: mocks.notificationLogFindFirst },
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
  buildMagicUrl: mocks.buildMagicUrl,
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
    createBillingAttempt: vi.fn(async (): Promise<unknown> => ({})),
    draftUpdatePaymentMethod: vi.fn(),
    listCustomerPaymentMethods: vi.fn(async (): Promise<unknown[]> => []),
    sendPaymentMethodUpdateEmail: vi.fn(async (): Promise<void> => {}),
    withContractDraft: vi.fn(),
  };
});

import { defaultFor } from "~/lib/settings/registry.server";
import { onBillingAttemptChallenged } from "~/lib/dunning/engine.server";

const SHOP = {
  id: "shop_1",
  domain: "cellexia-test.myshopify.com",
  ianaTimezone: "Europe/Zurich",
  currencyCode: "CHF",
  contactEmail: "merchant@example.com",
};

function contractFixture(over: Row = {}): Row {
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
    phone: "+41790000000",
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

function pendingAttempt(contractOver: Row = {}): Row {
  return {
    id: "att_1",
    contractId: "cm_c1",
    contract: contractFixture(contractOver),
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

function sendsOf(template: string) {
  return mocks.sendNotification.mock.calls
    .map((c) => c[0] as { template: string; vars: Row })
    .filter((s) => s.template === template);
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Row })
    .filter((e) => e.type === type);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.attempt = pendingAttempt();
  state.kase = null;
  // Implementations set by individual tests must not leak forward.
  mocks.notificationLogFindFirst.mockReset();
  mocks.notificationLogFindFirst.mockResolvedValue(null);
  mocks.sendNotification.mockReset();
  mocks.sendNotification.mockResolvedValue({
    status: "SENT",
    klaviyoEnqueued: true,
    directEmailSent: false,
  });
  mocks.buildMagicUrl.mockReset();
  mocks.buildMagicUrl.mockImplementation(
    async (input: { action: string }) => `https://example.test/magic/${input.action}`,
  );
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("3DS challenge day-0 SMS leg", () => {
  it("phone + real CONFIRM_3DS link → email AND SMS with the same confirmation link, per-attempt dedupe key", async () => {
    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    const emails = sendsOf("threeds_action");
    expect(emails).toHaveLength(1);
    expect(emails[0].vars.cta_url).toBe("https://example.test/magic/CONFIRM_3DS");
    expect(emails[0].vars.dunning_dedupe).toBe("case_1:THREEDS:challenge:att_1");

    const sms = sendsOf("threeds_action_sms");
    expect(sms).toHaveLength(1);
    expect(sms[0].vars).toMatchObject({
      confirm_url: "https://example.test/magic/CONFIRM_3DS",
      cta_url: "https://example.test/magic/CONFIRM_3DS",
      dunning_dedupe: "case_1:THREEDS_SMS:challenge:att_1",
      cycleIndex: 5,
    });
    expect(String(sms[0].vars.amount)).toContain("54");

    // Only ONE magic link is minted — the SMS reuses the email's.
    expect(mocks.buildMagicUrl).toHaveBeenCalledTimes(1);

    const [event] = eventsOfType("dunning.threeds_link_sent");
    expect(event.payload).toMatchObject({
      notificationStatus: "SENT",
      smsNotificationStatus: "SENT",
    });
    // The ladder's single smsDay text is untouched.
    expect(state.kase).toMatchObject({ smsSent: 0, state: "AWAITING_3DS" });
  });

  it("no phone → email only, SMS skipped", async () => {
    state.attempt = pendingAttempt({ phone: null });

    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    expect(sendsOf("threeds_action")).toHaveLength(1);
    expect(sendsOf("threeds_action_sms")).toHaveLength(0);
    expect(eventsOfType("dunning.threeds_link_sent")[0].payload).toMatchObject({
      smsNotificationStatus: "SKIPPED",
    });
  });

  it("CONFIRM_3DS link failed (email carries the update-card fallback) → no SMS", async () => {
    mocks.buildMagicUrl.mockImplementation(async (input: { action: string }) => {
      if (input.action === "CONFIRM_3DS") throw new Error("token store down");
      return `https://example.test/magic/${input.action}`;
    });

    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    const emails = sendsOf("threeds_action");
    expect(emails).toHaveLength(1);
    expect(emails[0].vars.cta_url).toBe("https://example.test/magic/UPDATE_CARD");
    expect(sendsOf("threeds_action_sms")).toHaveLength(0);
    expect(eventsOfType("dunning.threeds_link_sent")[0].payload).toMatchObject({
      smsNotificationStatus: "SKIPPED",
    });
  });

  it("redelivery: a SENT row for the SMS key → DUPLICATE, no second text", async () => {
    mocks.notificationLogFindFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: { payload: { equals: string } } }).where;
      return where.payload.equals === "case_1:THREEDS_SMS:challenge:att_1"
        ? { id: "nl_sms" }
        : null;
    });

    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    expect(sendsOf("threeds_action")).toHaveLength(1);
    expect(sendsOf("threeds_action_sms")).toHaveLength(0);
    expect(eventsOfType("dunning.threeds_link_sent")[0].payload).toMatchObject({
      smsNotificationStatus: "DUPLICATE",
    });
  });

  it("a throwing SMS send is contained — the challenge is still recorded and the email went out", async () => {
    mocks.sendNotification.mockImplementation(async (input?: unknown) => {
      if ((input as { template: string }).template === "threeds_action_sms") {
        throw new Error("router exploded");
      }
      return { status: "SENT", klaviyoEnqueued: true, directEmailSent: false };
    });

    await onBillingAttemptChallenged("att_1", "https://bank.example/3ds");

    expect(sendsOf("threeds_action")).toHaveLength(1);
    expect(state.attempt.status).toBe("CHALLENGED");
    expect(state.kase).toMatchObject({ state: "AWAITING_3DS" });
    expect(eventsOfType("billing.attempt_challenged")).toHaveLength(1);
    expect(eventsOfType("dunning.threeds_link_sent")[0].payload).toMatchObject({
      smsNotificationStatus: "FAILED",
    });
  });
});
