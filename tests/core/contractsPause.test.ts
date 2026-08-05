/**
 * pauseUntil resilience tests (mocked prisma / Shopify) — regression coverage
 * for the "orphaned pause" bug class:
 *
 *  - A half-committed prior run (Shopify pause committed + mirror synced to
 *    PAUSED, process died before the pausedUntil stamp) leaves a contract
 *    the pause-resume job can never resume. A retry must SELF-HEAL: skip the
 *    pause mutation (it would die on Shopify's "already paused" userError)
 *    and complete the pausedUntil stamp.
 *  - An "already paused"-class userError from the mutation (external pause
 *    racing us) is treated as success, not a failure.
 *  - finalizeOp post-commit containment: once the Shopify mutation has
 *    committed, audit/sync failures must NOT throw out of the idempotency
 *    closure (a released guard lets a retry re-issue the committed mutation).
 *  - The pause-while-paused guard (PAUSED + pausedUntil set) still throws
 *    AlreadyPausedError.
 *  - The pausedUntil stamp is an ATOMIC CONDITIONAL write (updateMany where
 *    pausedUntil is still null): two pause paths racing within one mutation
 *    round-trip (dunning grace pause vs portal pause accept) must not let
 *    the loser silently overwrite the winner's resume date — the loser
 *    throws AlreadyPausedError before any PAUSE_STARTED emit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  subscriptionContract: {
    findFirstOrThrow: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  contractLine: { findMany: vi.fn() },
  depletionEstimate: { deleteMany: vi.fn() },
  dunningState: { updateMany: vi.fn() },
}));
vi.mock("~/db.server", () => ({ default: db }));

const audit = vi.hoisted(() => ({ appendAudit: vi.fn() }));
vi.mock("~/services/audit.server", () => audit);

const events = vi.hoisted(() => ({ emitLifecycleEvent: vi.fn() }));
vi.mock("~/services/events.server", () => events);

// Pass-through: the guard semantics themselves are not under test here.
vi.mock("~/services/idempotency.server", () => ({
  withIdempotency: vi.fn(
    async (_key: string, _scope: string, fn: () => Promise<unknown>) => ({
      result: await fn(),
      replayed: false,
    }),
  ),
}));

const shopifyClient = vi.hoisted(() => {
  class ShopifyGraphqlError extends Error {
    constructor(
      message: string,
      public readonly errors: unknown,
      public readonly userErrors?: Array<{ field?: string[]; message: string }>,
    ) {
      super(message);
      this.name = "ShopifyGraphqlError";
    }
  }
  return {
    ShopifyGraphqlError,
    runGraphql: vi.fn(),
    // Same contract as production: userErrors → ShopifyGraphqlError.
    assertNoUserErrors: (
      operation: string,
      userErrors: Array<{ field?: string[] | null; message: string }> | undefined,
    ) => {
      if (userErrors && userErrors.length > 0) {
        throw new ShopifyGraphqlError(
          `${operation}: ${userErrors.map((e) => e.message).join("; ")}`,
          null,
          userErrors.map((e) => ({
            field: e.field ?? undefined,
            message: e.message,
          })),
        );
      }
    },
    getOfflineAdmin: vi.fn(),
    toGid: (type: string, id: string) => `gid://shopify/${type}/${id}`,
  };
});
vi.mock("~/services/core/shopifyClient.server", () => shopifyClient);

import {
  GET_CONTRACT_QUERY,
  SUBSCRIPTION_CONTRACT_PAUSE_MUTATION,
} from "~/graphql/contracts";
import {
  AlreadyPausedError,
  isAlreadyPausedUserError,
  pauseUntil,
} from "~/services/core/contracts.server";

const SHOP = "cellexia-demo.myshopify.com";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/9001";
const RESUME_DATE = new Date("2026-09-01T00:00:00.000Z");

function localContract(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    shop: SHOP,
    shopifyContractId: CONTRACT_GID,
    shopifyCustomerId: "gid://shopify/Customer/777",
    customerEmail: "marie@example.com",
    status: "ACTIVE",
    pausedUntil: null,
    initialDiscountPercent: null,
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function remoteContract(status = "PAUSED") {
  return {
    id: CONTRACT_GID,
    status,
    createdAt: "2026-07-01T00:00:00Z",
    nextBillingDate: null,
    note: null,
    customAttributes: [],
    currencyCode: "EUR",
    customer: { id: "gid://shopify/Customer/777", email: "marie@example.com" },
    customerPaymentMethod: null,
    billingPolicy: { interval: "WEEK", intervalCount: 4 },
    deliveryPolicy: { interval: "WEEK", intervalCount: 4 },
    deliveryMethod: null,
    originOrder: null,
    lines: { edges: [] },
  };
}

const graphqlStub = (() => {}) as never;

/** Route runGraphql calls by document; `pause` controls the mutation result. */
function wireGraphql(
  pause: () => { userErrors: Array<{ message: string }> } | never = () => ({
    userErrors: [],
  }),
) {
  shopifyClient.runGraphql.mockImplementation(
    async (_graphql: unknown, query: string) => {
      if (query === SUBSCRIPTION_CONTRACT_PAUSE_MUTATION) {
        const { userErrors } = pause();
        return {
          subscriptionContractPause: {
            contract: { id: CONTRACT_GID, status: "PAUSED" },
            userErrors,
          },
        };
      }
      if (query === GET_CONTRACT_QUERY) {
        return { subscriptionContract: remoteContract() };
      }
      throw new Error(`unexpected GraphQL document:\n${query.slice(0, 80)}`);
    },
  );
}

function pauseMutationCalls(): number {
  return shopifyClient.runGraphql.mock.calls.filter(
    ([, query]) => query === SUBSCRIPTION_CONTRACT_PAUSE_MUTATION,
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  wireGraphql();
  db.subscriptionContract.upsert.mockResolvedValue(
    localContract({ status: "PAUSED" }),
  );
  db.subscriptionContract.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) =>
      localContract({ status: "PAUSED", ...data }),
  );
  // Conditional stamp wins by default; the loser test overrides to count 0.
  db.subscriptionContract.updateMany.mockResolvedValue({ count: 1 });
  db.subscriptionContract.findUniqueOrThrow.mockResolvedValue(
    localContract({ status: "PAUSED", pausedUntil: RESUME_DATE }),
  );
  db.contractLine.findMany.mockResolvedValue([]);
});

describe("isAlreadyPausedUserError", () => {
  const { ShopifyGraphqlError } = shopifyClient;

  it("matches 'already paused'-class userErrors", () => {
    for (const message of [
      "Subscription contract is already paused.",
      "This contract is paused",
      "Contract currently paused",
    ]) {
      expect(
        isAlreadyPausedUserError(
          new ShopifyGraphqlError("subscriptionContractPause", null, [
            { message },
          ]),
        ),
      ).toBe(true);
    }
  });

  it("never matches real failures", () => {
    expect(
      isAlreadyPausedUserError(
        new ShopifyGraphqlError("subscriptionContractPause", null, [
          { message: "Subscription contract cannot be paused." },
        ]),
      ),
    ).toBe(false);
    expect(
      isAlreadyPausedUserError(
        new ShopifyGraphqlError("transport", { some: "error" }),
      ),
    ).toBe(false);
    expect(isAlreadyPausedUserError(new Error("already paused"))).toBe(false);
  });
});

describe("pauseUntil — orphan self-heal", () => {
  it("REGRESSION: retry after a half-committed run skips the mutation and stamps pausedUntil", async () => {
    // Prior run committed the Shopify pause and synced the mirror (PAUSED),
    // then died before writing pausedUntil.
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "PAUSED", pausedUntil: null }),
    );

    const result = await pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE);

    expect(pauseMutationCalls()).toBe(0);
    // The stamp is conditional on pausedUntil still being null — a genuine
    // orphan heal stamps normally; a concurrent winner makes it a no-op.
    expect(db.subscriptionContract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", pausedUntil: null },
      data: { pausedUntil: RESUME_DATE },
    });
    expect(result.pausedUntil).toEqual(RESUME_DATE);
  });

  it("treats Shopify's 'already paused' userError as success (external pause)", async () => {
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "ACTIVE" }),
    );
    wireGraphql(() => ({
      userErrors: [{ message: "Subscription contract is already paused." }],
    }));

    const result = await pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE);

    expect(pauseMutationCalls()).toBe(1);
    expect(db.subscriptionContract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", pausedUntil: null },
      data: { pausedUntil: RESUME_DATE },
    });
    expect(result.pausedUntil).toEqual(RESUME_DATE);
  });

  it("REGRESSION: a concurrent pause that already stamped makes the loser throw instead of overwriting the resume date", async () => {
    // Dunning grace PAUSE (+30d) and a portal TEMPORARY_PAUSE accept (+90d)
    // race within one mutation round-trip: the entry read still saw ACTIVE,
    // Shopify answers "already paused" (winner committed first), and the
    // loser reaches the stamp — where the winner's pausedUntil already sits.
    // OLD BUG: the unconditional update silently rewrote the winner's
    // resume date (a customer promised 90 days resumed after 30, or an
    // unpaid cycle parked for 90).
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "ACTIVE" }),
    );
    wireGraphql(() => ({
      userErrors: [{ message: "Subscription contract is already paused." }],
    }));
    db.subscriptionContract.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE),
    ).rejects.toBeInstanceOf(AlreadyPausedError);

    // Never an unconditional overwrite, and the loser emits nothing — the
    // throw sits before the PAUSE_STARTED emit.
    expect(db.subscriptionContract.update).not.toHaveBeenCalled();
    expect(events.emitLifecycleEvent).not.toHaveBeenCalled();
  });

  it("still rejects a pause on an already-tracked pause (guarded state)", async () => {
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "PAUSED", pausedUntil: new Date() }),
    );
    await expect(
      pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE),
    ).rejects.toBeInstanceOf(AlreadyPausedError);
    expect(pauseMutationCalls()).toBe(0);
  });

  it("still surfaces genuine pause failures", async () => {
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "ACTIVE" }),
    );
    wireGraphql(() => ({
      userErrors: [{ message: "Subscription contract cannot be paused." }],
    }));
    await expect(
      pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE),
    ).rejects.toThrow(/cannot be paused/);
    expect(db.subscriptionContract.update).not.toHaveBeenCalled();
    expect(db.subscriptionContract.updateMany).not.toHaveBeenCalled();
  });
});

describe("pauseUntil — finalizeOp post-commit containment", () => {
  it("REGRESSION: an audit failure after the committed mutation does not abort the op", async () => {
    db.subscriptionContract.findFirstOrThrow.mockResolvedValue(
      localContract({ status: "ACTIVE" }),
    );
    // Sequence-exhaustion shape: post-commit bookkeeping blows up.
    audit.appendAudit.mockRejectedValue(
      new Error("appendAudit: could not acquire audit sequence"),
    );

    const result = await pauseUntil(graphqlStub, SHOP, "c1", RESUME_DATE);

    // The committed pause is kept: the op completes, pausedUntil is stamped,
    // and the (mocked, pass-through) idempotency guard was never released by
    // a throw — a retry would replay instead of re-pausing.
    expect(pauseMutationCalls()).toBe(1);
    expect(db.subscriptionContract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", pausedUntil: null },
      data: { pausedUntil: RESUME_DATE },
    });
    expect(result.pausedUntil).toEqual(RESUME_DATE);
  });
});
