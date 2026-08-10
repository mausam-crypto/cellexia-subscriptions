import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * completeCancel — the resolved fallback reason must land on the
 * CancelSession ROW, not only on the cancel.completed event.
 *
 * The admin cancel-flow analytics read reasons from CancelSession rows and
 * drop reason-null sessions from the histogram entirely (no OTHER bucket).
 * A quick re-entry ("I still want to cancel" after sessionFreshMinutes but
 * within 7 days) completes on a reason-null session while the 7-day-lookback
 * fallback reached only the event — the DB and the event stream disagreed
 * about the same cancel, and exactly the decided cancellers vanished from
 * reasonBreakdown. The claim now writes the resolved reason atomically with
 * the outcome, and the failure revert restores the pre-claim value.
 *
 * Drives the REAL completeCancel over a mocked db.
 */

const store = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  recentReason: null as Record<string, unknown> | null,
  claims: [] as Array<Record<string, unknown>>,
  reverts: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  cancelContract: vi.fn(async (): Promise<unknown> => ({
    id: "c_1",
    status: "CANCELLED",
    lines: [],
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    cancelSession: {
      findUnique: vi.fn(async (): Promise<unknown> => store.session),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.session),
      findFirst: vi.fn(async (): Promise<unknown> => store.recentReason),
      updateMany: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          store.claims.push(args.data);
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          store.reverts.push(args.data);
          return store.session;
        },
      ),
    },
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => ({
        id: "c_1",
        shopId: "shop_1",
        customerId: "gid://shopify/Customer/1",
        email: "sub@example.com",
        status: "ACTIVE",
        ownership: "OURS",
        lines: [],
      })),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "c_1",
        status: "CANCELLED",
        lines: [],
      })),
      update: vi.fn(async (): Promise<unknown> => ({})),
    },
    shop: {
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => ({
        id: "shop_1",
        domain: "cellexia.myshopify.com",
        ianaTimezone: "Europe/Zurich",
      })),
    },
  },
}));

vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/graphql/client.server", () => ({
  gql: (strings: TemplateStringsArray) => strings.join(""),
}));
vi.mock("~/lib/graphql/billingCycles.server", () => ({
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
  getBillingCycleByIndex: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock("~/lib/contracts/service.server", () => ({
  applyDiscountGrant: vi.fn(async (): Promise<unknown> => ({})),
  cancelContract: mocks.cancelContract,
  changeFrequency: vi.fn(async (): Promise<unknown> => ({})),
  pauseContract: vi.fn(async (): Promise<unknown> => ({})),
  skipNextCycle: vi.fn(async (): Promise<unknown> => ({})),
  swapLineVariant: vi.fn(async (): Promise<unknown> => ({})),
}));

import { completeCancel } from "~/lib/cancel/engine.server";

function sessionFixture(over: Record<string, unknown> = {}) {
  return {
    id: "cs_1",
    contractId: "c_1",
    startedAt: new Date(),
    channel: "PORTAL",
    reason: null,
    reasonDetail: null,
    savesShown: null,
    saveAccepted: null,
    outcome: null,
    completedAt: null,
    ...over,
  };
}

function completedEvent(): Record<string, unknown> | undefined {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .find((e) => e.type === "cancel.completed")?.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.session = sessionFixture();
  store.recentReason = null;
  store.claims = [];
  store.reverts = [];
  mocks.cancelContract.mockResolvedValue({
    id: "c_1",
    status: "CANCELLED",
    lines: [],
  });
});

describe("completeCancel persists the resolved reason on the session row", () => {
  it("re-entry fallback: the recent stated reason rides the claim AND the event", async () => {
    store.recentReason = { reason: "TOO_EXPENSIVE" };

    await completeCancel("cs_1");

    expect(store.claims).toHaveLength(1);
    expect(store.claims[0]).toMatchObject({
      outcome: "CANCELLED",
      reason: "TOO_EXPENSIVE",
    });
    expect(completedEvent()).toMatchObject({ reason: "TOO_EXPENSIVE" });
  });

  it("no recent reason: OTHER lands on the row (the loader's histogram no longer drops the session)", async () => {
    store.recentReason = null;

    await completeCancel("cs_1");

    expect(store.claims[0]).toMatchObject({ reason: "OTHER" });
    expect(completedEvent()).toMatchObject({ reason: "OTHER" });
  });

  it("a session with its own recorded reason keeps it verbatim", async () => {
    store.session = sessionFixture({ reason: "NOT_SEEING_RESULTS" });

    await completeCancel("cs_1");

    expect(store.claims[0]).toMatchObject({ reason: "NOT_SEEING_RESULTS" });
    expect(completedEvent()).toMatchObject({ reason: "NOT_SEEING_RESULTS" });
  });

  it("a failed Shopify cancel reverts the reason to its pre-claim value", async () => {
    store.recentReason = { reason: "TOO_EXPENSIVE" };
    mocks.cancelContract.mockRejectedValueOnce(new Error("shopify down"));

    await expect(completeCancel("cs_1")).rejects.toThrow("shopify down");

    // The session is open again — a fallback written by the claim must not
    // masquerade as customer-stated on it.
    expect(store.reverts).toHaveLength(1);
    expect(store.reverts[0]).toEqual({
      outcome: null,
      completedAt: null,
      reason: null,
    });
  });
});
