import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure-engine concurrency (stability pass).
 *
 * The reported race: an attempt stuck PENDING >2h is resolved by the
 * stale_attempt_sweep (marks FAILED, invokes onBillingAttemptFailed) while
 * the delayed FAILURE webhook lands mid-sweep and invokes it too. The old
 * redelivery guard (status=FAILED && declineCategory != null) is read-then-
 * act with declineCategory written LAST after seconds of work, so BOTH
 * invocations used to run the whole engine: consecutiveFailures twice, two
 * open DunningCases, duplicate payment-failed emails, and eventually two
 * same-day charge attempts — with the zombie case exhausting into a cancel
 * of a PAYING subscriber.
 *
 * Two independent fixes, both pinned here against the REAL engine
 * (dunning-send-dedupe harness):
 *   1. an atomic entry claim — updateMany stamping dunningClaimedAt, gated
 *      on declineCategory IS NULL and a null/expired lease — so only one
 *      invocation proceeds;
 *   2. a DATABASE invariant "one open case per contract" (partial unique
 *      index, migration 0008) with the engine treating P2002 as "lost the
 *      race → reuse the winner's case".
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
  attemptUpdateMany: vi.fn(async (_a?: unknown) => ({ count: 1 })),
  attemptCount: vi.fn(async (_a?: unknown) => 0),
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
      count: mocks.attemptCount,
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
  DUNNING_CLAIM_LEASE_MS,
  onBillingAttemptFailed,
} from "~/lib/dunning/engine.server";

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
    declineCategory: null,
    dunningClaimedAt: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSetting.mockImplementation(async (_shopId: string, key: string) =>
    defaultFor(key as never),
  );
  mocks.attemptFindUnique.mockImplementation(async (args: unknown) => {
    const where = (args as { where?: { id?: string } })?.where;
    return where?.id === "att_h1" ? attemptFixture() : null;
  });
  mocks.attemptFindFirst.mockResolvedValue(null); // cycle has no SUCCESS sibling
  mocks.dunningCaseFindFirst.mockResolvedValue(null);
  mocks.attemptUpdateMany.mockResolvedValue({ count: 1 });
});

// ── The atomic entry claim ───────────────────────────────────────────────────

describe("onBillingAttemptFailed entry claim", () => {
  it("claims the attempt with declineCategory-null + lease gates BEFORE any engine work", async () => {
    await onBillingAttemptFailed("att_h1");

    expect(mocks.attemptUpdateMany).toHaveBeenCalledTimes(1);
    const claim = mocks.attemptUpdateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(claim.where.id).toBe("att_h1");
    // A finished attempt can never be re-claimed…
    expect(claim.where.declineCategory).toBeNull();
    // …and a live lease blocks a duplicate while an expired one lets a
    // redelivery re-drive a crashed run (crash-resumability preserved).
    const or = claim.where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    expect(or[0]).toEqual({ dunningClaimedAt: null });
    const expiry = (or[1].dunningClaimedAt as { lt: Date }).lt;
    expect(Date.now() - expiry.getTime()).toBeGreaterThanOrEqual(
      DUNNING_CLAIM_LEASE_MS - 5_000,
    );
    expect(claim.data.dunningClaimedAt).toBeInstanceOf(Date);

    // The claim won → the engine actually ran.
    expect(mocks.dunningCaseCreate).toHaveBeenCalledTimes(1);
    expect(mocks.contractUpdate).toHaveBeenCalledTimes(1);
  });

  it("the losing invocation does NOTHING — the sweep/webhook race is closed", async () => {
    // The delayed FAILURE webhook lands while the stale-attempt sweep's
    // invocation holds the lease: updateMany matches no row.
    mocks.attemptUpdateMany.mockResolvedValue({ count: 0 });

    await onBillingAttemptFailed("att_h1");

    expect(mocks.dunningCaseCreate).not.toHaveBeenCalled(); // no second case
    expect(mocks.contractUpdate).not.toHaveBeenCalled(); // no double failure count
    expect(mocks.sendNotification).not.toHaveBeenCalled(); // no duplicate email
    expect(mocks.attemptUpdate).not.toHaveBeenCalled(); // no engine writes at all
  });

  it("a fully processed attempt still short-circuits before even claiming", async () => {
    mocks.attemptFindUnique.mockResolvedValue(
      attemptFixture({ declineCategory: "HARD" }),
    );
    await onBillingAttemptFailed("att_h1");
    expect(mocks.attemptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.dunningCaseCreate).not.toHaveBeenCalled();
  });
});

// ── One open case per contract, enforced by the database ─────────────────────

describe("ensureOpenCase under the partial unique index", () => {
  it("reuses the winner's case when the create loses the race (P2002)", async () => {
    const winner = {
      id: "case_winner",
      contractId: "cm_c1",
      state: "OPEN",
      openedAt: new Date(),
      triggerAttemptId: "att_h1", // same cycle → reused as-is
      emailsSent: 0,
      smsSent: 0,
      lastNotifiedAt: null,
      ladderStep: 0,
      paydayAligned: false,
    };
    // First find (pre-create): no case yet. Re-fetch after P2002: the winner.
    mocks.dunningCaseFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValue(winner);
    mocks.dunningCaseCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique violation", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: "DunningCase_one_open_case_per_contract" },
      }),
    );

    await onBillingAttemptFailed("att_h1");

    // The engine carried on with the WINNER's case: no crash, no
    // case_opened event for a duplicate, and the failure notification is
    // keyed to the winner's case id (shared dedupe → one email ever).
    const opened = mocks.logEvent.mock.calls
      .map((c) => c[0] as { type: string })
      .filter((e) => e.type === "dunning.case_opened");
    expect(opened).toHaveLength(0);
    const sent = (mocks.sendNotification.mock.calls as unknown[][])[0]?.[0] as
      | { vars?: Record<string, unknown> }
      | undefined;
    expect(String(sent?.vars?.dunning_dedupe ?? "")).toContain("case_winner");
  });

  it("any other create failure still surfaces", async () => {
    mocks.dunningCaseFindFirst.mockResolvedValue(null);
    mocks.dunningCaseCreate.mockRejectedValue(new Error("db down"));
    await expect(onBillingAttemptFailed("att_h1")).rejects.toThrow("db down");
  });
});

// ── The migration really enforces what the engine assumes ────────────────────

describe("migration 0008 matches the engine's open-state list", () => {
  // Comment-free, so the prose explaining the rules cannot trip the checks.
  const sql = readFileSync(
    fileURLToPath(
      new URL(
        "../prisma/migrations/0008_dunning_concurrency/migration.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  )
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const engine = readFileSync(
    fileURLToPath(
      new URL("../app/lib/dunning/engine.server.ts", import.meta.url),
    ),
    "utf8",
  );

  it("creates the partial UNIQUE index over exactly the engine's OPEN_CASE_STATES", () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "DunningCase_one_open_case_per_contract"\s*\nON "DunningCase"\("contractId"\)\s*\nWHERE "state" IN \('OPEN', 'RETRYING', 'AWAITING_CUSTOMER', 'AWAITING_3DS'\)/,
    );
    // The engine's list — if a state is ever added to one side only, an open
    // case in that state either escapes the invariant or wrongly blocks it.
    const list = /OPEN_CASE_STATES: DunningState\[\] = \[([^\]]+)\]/.exec(engine);
    expect(list).not.toBeNull();
    const states = [...list![1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(states.sort()).toEqual(
      ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"].sort(),
    );
  });

  it("adds the lease column and stays additive (no DROP/RENAME/type change)", () => {
    expect(sql).toContain(
      'ALTER TABLE "BillingAttempt" ADD COLUMN "dunningClaimedAt" TIMESTAMP(3)',
    );
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/ALTER\s+COLUMN[^;]*TYPE/i);
    // The data repair touches ONLY duplicate open cases (rn > 1) and closes
    // them — it can never touch a contract's single healthy case.
    expect(sql).toMatch(/WHERE dup\."id" = ranked\."id" AND ranked\.rn > 1/);
  });
});
