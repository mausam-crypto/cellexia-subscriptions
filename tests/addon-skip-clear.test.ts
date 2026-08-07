import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Skip × one-time add-ons — the phantom "with your next order" trap.
 *
 * The defect: skipNextCycle did nothing about add-on mirrors staged on the
 * cycle being skipped. The cycle-scoped clear in consumeCycleOnSuccess
 * (migration 0012) fires only when THAT exact cycle SETTLES — and a skipped
 * cycle never settles. So after "stage add-on for cycle N, then tap Skip":
 * cycle N+1 bills and clears only addonCycleIndex=N+1 rows, the N mirror and
 * its permanently-unique addClaimKey (addon:{contractId}:{variantId}) survive
 * forever, the portal keeps promising the add-on "with your next order" while
 * no future order ever contains it, and every later re-add of that variant is
 * a silent no-op (fast path finds the stale mirror; the P2002 path answers
 * "already staged"). No sweep or sync path repairs it — sync deliberately
 * never deletes isOneTimeAddon mirrors.
 *
 * The fix: skipNextCycle removes staged add-ons for the cycle being skipped
 * BEFORE the Shopify skip commits — Shopify cycle-edit line first (otherwise
 * a later unskip would re-expose a charging line with no mirror to remove),
 * mirror + claim key second, cycle.addon_removed(reason=cycle_skipped) event
 * per line. A non-user error aborts the whole skip while everything is still
 * consistent and retryable. unskipNextCycle needs no symmetric change: the
 * removal happens pre-skip, so an unskipped cycle carries no orphaned add-on
 * lines of ours.
 *
 * These tests drive the REAL skipNextCycle with the Shopify seams mocked.
 */

const NEXT = new Date("2026-08-10T09:00:00Z");
const NEW_NEXT = new Date("2026-09-07T09:00:00Z");
const CONTRACT_GID = "gid://shopify/SubscriptionContract/900";
const ADDON_LINE_GID = "gid://shopify/SubscriptionLine/addon2";

type LineRow = Record<string, unknown> & { id: string };

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: LineRow[] },
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  getBillingCycleByDate: vi.fn(async (): Promise<unknown> => ({
    cycleIndex: 5,
    skipped: false,
  })),
  skipBillingCycle: vi.fn(async (): Promise<unknown> => ({})),
  withBillingCycleEdit: vi.fn(
    async (
      _admin: unknown,
      _gid: unknown,
      _sel: unknown,
      fn: (draftId: string, run: unknown) => Promise<void>,
    ): Promise<void> => fn("draft_1", {}),
  ),
  draftLineRemove: vi.fn(async (): Promise<void> => {}),
  getContract: vi.fn(async (): Promise<unknown> => ({
    nextBillingDate: NEW_NEXT,
  })),
  lineDeleteMany: vi.fn(
    async (args: { where: { id: string } }): Promise<{ count: number }> => {
      const before = store.contract.lines.length;
      store.contract.lines = store.contract.lines.filter(
        (l) => l.id !== args.where.id,
      );
      return { count: before - store.contract.lines.length };
    },
  ),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: vi.fn(
        async (args: { data: Record<string, unknown> }): Promise<unknown> => {
          Object.assign(store.contract, args.data);
          return store.contract;
        },
      ),
    },
    contractLine: { deleteMany: mocks.lineDeleteMany },
  },
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: "Europe/Zurich",
  })),
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
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: vi.fn(),
    draftLineRemove: mocks.draftLineRemove,
    draftLineUpdate: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: mocks.getBillingCycleByDate,
    getContract: mocks.getContract,
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: vi.fn(),
    skipBillingCycle: mocks.skipBillingCycle,
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: mocks.withBillingCycleEdit,
    withContractDraft: vi.fn(),
  };
});

import { ShopifyUserError } from "~/lib/graphql/index.server";
import { skipNextCycle } from "~/lib/contracts/service.server";

function recurringLine(): LineRow {
  return {
    id: "line_1",
    shopifyLineId: "gid://shopify/SubscriptionLine/1",
    variantId: "gid://shopify/ProductVariant/10",
    title: "Cellexia Jar",
    isGift: false,
    isOneTimeAddon: false,
    addonCycleIndex: null,
  };
}

function addonLine(over: Record<string, unknown> = {}): LineRow {
  return {
    id: "line_addon",
    shopifyLineId: ADDON_LINE_GID,
    variantId: "gid://shopify/ProductVariant/77",
    title: "Collagen Boost",
    isGift: false,
    isOneTimeAddon: true,
    addonCycleIndex: 5,
    addClaimKey: "addon:c_1:gid://shopify/ProductVariant/77",
    ...over,
  };
}

function baseContract(lines: LineRow[]) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    intervalWeeks: 4,
    skipCount: 0,
    nextBillingDate: NEXT,
    lines,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.contract = baseContract([recurringLine(), addonLine()]);
  mocks.getBillingCycleByDate.mockResolvedValue({ cycleIndex: 5, skipped: false });
  mocks.getContract.mockResolvedValue({ nextBillingDate: NEW_NEXT });
});

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

describe("skipNextCycle clears one-time add-ons staged on the skipped cycle", () => {
  it("removes the Shopify line, the mirror and the claim key — before the skip commits", async () => {
    await skipNextCycle("cellexia.myshopify.com", "c_1");

    // Shopify cycle edit removed the staged line from the SKIPPED cycle …
    expect(mocks.withBillingCycleEdit).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 5 },
      expect.any(Function),
    );
    expect(mocks.draftLineRemove).toHaveBeenCalledWith(
      expect.anything(),
      "draft_1",
      ADDON_LINE_GID,
    );
    // … BEFORE the skip itself (an aborted cleanup must abort the skip).
    expect(
      mocks.draftLineRemove.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.skipBillingCycle.mock.invocationCallOrder[0]);

    // Mirror + addClaimKey gone: the portal stops promising a phantom and the
    // variant can be staged again for a future cycle.
    expect(mocks.lineDeleteMany).toHaveBeenCalledWith({
      where: { id: "line_addon" },
    });
    expect(store.contract.lines.map((l) => l.id)).toEqual(["line_1"]);

    // Auditable, with the reason.
    const removed = eventsOfType("cycle.addon_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      lineId: "line_addon",
      variantId: "gid://shopify/ProductVariant/77",
      cycleIndex: 5,
      reason: "cycle_skipped",
    });

    // The skip itself still happened and logged as before.
    expect(mocks.skipBillingCycle).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_GID,
      { index: 5 },
    );
    expect(eventsOfType("cycle.skipped")).toHaveLength(1);
  });

  it("leaves add-ons staged for a LATER cycle untouched (they still ride their own cycle)", async () => {
    store.contract = baseContract([
      recurringLine(),
      addonLine({ addonCycleIndex: 6 }),
    ]);

    await skipNextCycle("cellexia.myshopify.com", "c_1");

    expect(mocks.draftLineRemove).not.toHaveBeenCalled();
    expect(mocks.lineDeleteMany).not.toHaveBeenCalled();
    expect(eventsOfType("cycle.addon_removed")).toHaveLength(0);
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
  });

  it("leaves legacy NULL-cycle mirrors alone — consumeCycleOnSuccess clears them on the next settlement", async () => {
    store.contract = baseContract([addonLine({ addonCycleIndex: null })]);

    await skipNextCycle("cellexia.myshopify.com", "c_1");

    expect(mocks.draftLineRemove).not.toHaveBeenCalled();
    expect(mocks.lineDeleteMany).not.toHaveBeenCalled();
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
  });

  it("tolerates a Shopify user error (line already gone): the mirror still catches up", async () => {
    mocks.draftLineRemove.mockRejectedValueOnce(
      new ShopifyUserError("subscriptionBillingCycleContractEdit", [
        { message: "line not found" },
      ]),
    );

    await skipNextCycle("cellexia.myshopify.com", "c_1");

    expect(mocks.lineDeleteMany).toHaveBeenCalledWith({
      where: { id: "line_addon" },
    });
    expect(eventsOfType("cycle.addon_removed")).toHaveLength(1);
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
  });

  it("an infrastructure error aborts the WHOLE skip — nothing half-cleaned, fully retryable", async () => {
    mocks.draftLineRemove.mockRejectedValueOnce(new Error("network down"));

    await expect(
      skipNextCycle("cellexia.myshopify.com", "c_1"),
    ).rejects.toThrow("network down");

    // The cycle was NOT skipped and the mirror line survived: a retry
    // re-runs the cleanup (idempotent) and then the skip.
    expect(mocks.skipBillingCycle).not.toHaveBeenCalled();
    expect(mocks.lineDeleteMany).not.toHaveBeenCalled();
    expect(store.contract.lines.map((l) => l.id)).toContain("line_addon");
    expect(eventsOfType("cycle.skipped")).toHaveLength(0);
  });

  it("a mirror line never staged on Shopify (shopifyLineId null) is cleaned without a cycle edit", async () => {
    store.contract = baseContract([addonLine({ shopifyLineId: null })]);

    await skipNextCycle("cellexia.myshopify.com", "c_1");

    expect(mocks.withBillingCycleEdit).not.toHaveBeenCalled();
    expect(mocks.lineDeleteMany).toHaveBeenCalledWith({
      where: { id: "line_addon" },
    });
    expect(eventsOfType("cycle.addon_removed")).toHaveLength(1);
    expect(mocks.skipBillingCycle).toHaveBeenCalledTimes(1);
  });
});
