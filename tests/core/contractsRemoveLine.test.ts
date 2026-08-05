/**
 * removeLineFromContract keepOne guard tests (mocked prisma / Shopify) —
 * regression coverage for the "REMOVE_ITEM save offer can remove the
 * contract's last line" fix:
 *
 *  - keepOne re-counts the LIVE lines on Shopify (not the mirror snapshot)
 *    and throws KeepOneLineError BEFORE any draft mutation when removal
 *    would empty the plan — two racing tabs must not produce a dead but
 *    still-billed one-line contract.
 *  - keepOne with more than one live line proceeds normally.
 *  - Without opts the guard is opt-in: no extra live-count round-trip is
 *    issued (the add-on consumption sweep must not pay for one), and the
 *    removal proceeds.
 *
 * Harness mirrors tests/core/contractsPause.test.ts (hoisted ~/db.server
 * mock, pass-through withIdempotency, runGraphql routed by document).
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
  contractLine: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
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
  SUBSCRIPTION_CONTRACT_UPDATE_MUTATION,
  SUBSCRIPTION_DRAFT_COMMIT_MUTATION,
  SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION,
} from "~/graphql/contracts";
import {
  KeepOneLineError,
  removeLineFromContract,
} from "~/services/core/contracts.server";

const SHOP = "cellexia-demo.myshopify.com";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/9001";
const LINE_GID = "gid://shopify/SubscriptionLine/1";
const OTHER_LINE_GID = "gid://shopify/SubscriptionLine/2";

const graphqlStub = (() => {}) as never;

function localContract() {
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
  };
}

function localLine() {
  return {
    id: "l1",
    contractId: "c1",
    shopifyLineId: LINE_GID,
    shopifyVariantId: "gid://shopify/ProductVariant/11",
    title: "Serum",
    quantity: 1,
    currentPriceCents: 1900,
    sellingPlanId: null,
  };
}

function remoteLineNode(id: string) {
  return {
    id,
    productId: "gid://shopify/Product/1",
    variantId: "gid://shopify/ProductVariant/11",
    title: "Serum",
    quantity: 1,
    currentPrice: { amount: "19.00", currencyCode: "EUR" },
    sellingPlanId: null,
    sellingPlanName: null,
  };
}

function remoteContract(lineIds: string[]) {
  return {
    id: CONTRACT_GID,
    status: "ACTIVE",
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
    lines: { edges: lineIds.map((id) => ({ node: remoteLineNode(id) })) },
  };
}

/** Route runGraphql calls by document; `remoteLineIds` drives the live count. */
function wireGraphql(remoteLineIds: string[]) {
  shopifyClient.runGraphql.mockImplementation(
    async (_graphql: unknown, query: string) => {
      if (query === GET_CONTRACT_QUERY) {
        return { subscriptionContract: remoteContract(remoteLineIds) };
      }
      if (query === SUBSCRIPTION_CONTRACT_UPDATE_MUTATION) {
        return {
          subscriptionContractUpdate: {
            draft: { id: "gid://shopify/SubscriptionDraft/1" },
            userErrors: [],
          },
        };
      }
      if (query === SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION) {
        return {
          subscriptionDraftLineRemove: {
            lineRemoved: { id: LINE_GID },
            userErrors: [],
          },
        };
      }
      if (query === SUBSCRIPTION_DRAFT_COMMIT_MUTATION) {
        return {
          subscriptionDraftCommit: {
            contract: { id: CONTRACT_GID },
            userErrors: [],
          },
        };
      }
      throw new Error(`unexpected GraphQL document:\n${query.slice(0, 80)}`);
    },
  );
}

function callsFor(document: string): number {
  return shopifyClient.runGraphql.mock.calls.filter(
    ([, query]) => query === document,
  ).length;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.subscriptionContract.findFirstOrThrow.mockResolvedValue(localContract());
  db.subscriptionContract.upsert.mockResolvedValue(localContract());
  db.contractLine.findFirst.mockResolvedValue(localLine());
  db.contractLine.findMany.mockResolvedValue([]);
  db.contractLine.create.mockResolvedValue({});
  db.contractLine.update.mockResolvedValue({});
  db.contractLine.deleteMany.mockResolvedValue({ count: 0 });
  db.depletionEstimate.deleteMany.mockResolvedValue({ count: 0 });
});

describe("removeLineFromContract — keepOne last-line guard", () => {
  it("REGRESSION: keepOne on a one-line plan throws KeepOneLineError before ANY draft mutation", async () => {
    // Two tabs racing a two-line plan down to one: the live re-count on
    // Shopify (never the mirror snapshot) is what stops the second removal.
    wireGraphql([LINE_GID]);

    await expect(
      removeLineFromContract(graphqlStub, SHOP, "c1", "l1", { keepOne: true }),
    ).rejects.toBeInstanceOf(KeepOneLineError);

    // No draft was opened, no line removed, no commit — the plan is intact.
    expect(callsFor(SUBSCRIPTION_CONTRACT_UPDATE_MUTATION)).toBe(0);
    expect(callsFor(SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION)).toBe(0);
    expect(callsFor(SUBSCRIPTION_DRAFT_COMMIT_MUTATION)).toBe(0);
    expect(events.emitLifecycleEvent).not.toHaveBeenCalled();
  });

  it("keepOne with two live lines proceeds with the removal", async () => {
    wireGraphql([LINE_GID, OTHER_LINE_GID]);

    await removeLineFromContract(graphqlStub, SHOP, "c1", "l1", {
      keepOne: true,
    });

    expect(callsFor(SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION)).toBe(1);
    expect(callsFor(SUBSCRIPTION_DRAFT_COMMIT_MUTATION)).toBe(1);
    // Pre-count + post-commit mirror sync.
    expect(callsFor(GET_CONTRACT_QUERY)).toBe(2);
    expect(events.emitLifecycleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "PRODUCT_REMOVED" }),
    );
  });

  it("without opts the guard is opt-in: no live-count round-trip, removal proceeds", async () => {
    wireGraphql([LINE_GID, OTHER_LINE_GID]);

    await removeLineFromContract(graphqlStub, SHOP, "c1", "l1");

    expect(callsFor(SUBSCRIPTION_DRAFT_LINE_REMOVE_MUTATION)).toBe(1);
    // Only the post-commit mirror sync touches GET_CONTRACT_QUERY — the
    // add-on consumption sweep must not pay an extra Shopify round-trip.
    expect(callsFor(GET_CONTRACT_QUERY)).toBe(1);
  });
});
