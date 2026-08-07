import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cycle-scoped one-time add-on consumption (migration 0012).
 *
 * The defect: consumeCycleOnSuccess cleared add-on mirror lines
 * CONTRACT-scoped ({ contractId, isOneTimeAddon: true }). But an add-on can
 * be staged for cycle N+1 while cycle N's charge is still in flight —
 * runBillingSweep advances nextBillingDate optimistically at attempt
 * creation, so a portal "Add one-time add-on" during that window (hours wide
 * when the success webhook is lost and the stale sweep resolves the attempt)
 * targets cycle N+1 on Shopify. Cycle N's settlement then deleted the N+1
 * mirror too: the Shopify N+1 billing-cycle edit survived (the customer still
 * gets charged), the portal had nothing left to remove, and — because the
 * deletion freed the permanently-unique addClaimKey — the customer could
 * stage the same variant AGAIN and pay for it twice: exactly the
 * double-charge shape migration 0009 exists to prevent.
 *
 * The fix: addOneTimeAddon stamps addonCycleIndex at claim time (pinned in
 * addon-claim.test.ts) and consumeCycleOnSuccess consumes only mirrors whose
 * staged cycle equals the settling cycle — legacy NULL rows keep the old
 * cleared-on-any-settlement behavior. These tests drive the REAL helper with
 * a fake transaction client.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({ default: {} }));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({ id: "shop_1" })),
}));
vi.mock("~/lib/i18n/i18n.server", () => ({
  normalizeLocale: (v: string) => v,
}));
vi.mock("~/lib/billing/mit-evidence.server", () => ({
  buildMitEvidence: vi.fn(() => ({})),
}));
vi.mock("~/lib/notifications/send.server", () => ({
  sendNotification: vi.fn(async (): Promise<unknown> => ({ status: "SENT" })),
  hasSentForCycle: vi.fn(async (): Promise<boolean> => false),
}));
vi.mock("~/lib/graphql/index.server", () => ({
  draftUpdatePaymentMethod: vi.fn(),
  getContract: vi.fn(),
  getOrderSummary: vi.fn(),
  listCustomerPaymentMethods: vi.fn(),
  withContractDraft: vi.fn(),
}));

import { consumeCycleOnSuccess } from "~/lib/webhooks/handlers.server";

interface FakeTx {
  contractLine: {
    findMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  giftGrant: { updateMany: ReturnType<typeof vi.fn> };
}

function fakeTx(lines: Array<Record<string, unknown>>): FakeTx {
  return {
    contractLine: {
      findMany: vi.fn(async () => lines),
      deleteMany: vi.fn(async () => ({ count: lines.length })),
    },
    giftGrant: { updateMany: vi.fn(async () => ({ count: 0 })) },
  };
}

function asTx(tx: FakeTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consumeCycleOnSuccess is cycle-scoped", () => {
  it("selects only mirrors staged for the settling cycle (plus legacy NULL rows)", async () => {
    const tx = fakeTx([
      { id: "line_n", title: "Collagen Boost", addonCycleIndex: 5 },
    ]);

    const { addonTitles } = await consumeCycleOnSuccess(asTx(tx), "c_1", 5);

    // The WHERE is the whole fix: cycle N's settlement must never see the
    // add-on the customer staged for cycle N+1 during the in-flight window.
    expect(tx.contractLine.findMany).toHaveBeenCalledWith({
      where: {
        contractId: "c_1",
        isOneTimeAddon: true,
        OR: [{ addonCycleIndex: 5 }, { addonCycleIndex: null }],
      },
    });
    expect(tx.contractLine.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["line_n"] } },
    });
    expect(addonTitles).toEqual(["Collagen Boost"]);
  });

  it("deletes nothing when the settling cycle staged no add-ons — the N+1 mirror (and its addClaimKey) survives", async () => {
    // The DB-filtered read returns no rows for cycle 5: the only staged
    // add-on belongs to cycle 6 and is outside the WHERE above.
    const tx = fakeTx([]);

    const { addonTitles } = await consumeCycleOnSuccess(asTx(tx), "c_1", 5);

    expect(tx.contractLine.deleteMany).not.toHaveBeenCalled();
    expect(addonTitles).toEqual([]);
  });

  it("keeps the gift flip exact-cycle scoped, unchanged", async () => {
    const tx = fakeTx([]);
    await consumeCycleOnSuccess(asTx(tx), "c_1", 5);

    expect(tx.giftGrant.updateMany).toHaveBeenCalledWith({
      where: { contractId: "c_1", cycleIndex: 5, status: "ADDED" },
      data: { status: "SHIPPED" },
    });
  });
});
