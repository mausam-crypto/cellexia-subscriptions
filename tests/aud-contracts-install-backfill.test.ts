import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Initial contract backfill wiring (data-collection audit, CM-1).
 *
 * backfillAllContracts was exported but never called: contracts that existed
 * before install (or whose CREATE webhook was permanently missed) were never
 * mirrored, silently excluded from every count/rollup/backfill — while
 * Shop.lastFullSyncAt was stamped at install-metadata time, asserting a full
 * sync that had not happened. The fix wires the sweep into onAppInstalled
 * (fire-and-forget — afterAuth must answer the OAuth callback promptly),
 * gated on lastFullSyncAt, which only backfillAllContracts itself now stamps
 * ON COMPLETION: install runs it once, a crash leaves the gate open for the
 * next auth, and the daily full_sync_reconcile job covers drift after that.
 */

const store = vi.hoisted(() => ({
  shopRow: {} as Record<string, unknown>,
}));

const mocks = vi.hoisted(() => ({
  backfillAllContracts: vi.fn(async (): Promise<unknown> => ({
    total: 0,
    synced: 0,
    failed: 0,
    errors: [],
  })),
  shopUpdate: vi.fn(async (args: { data: Record<string, unknown> }) => {
    Object.assign(store.shopRow, args.data);
    return store.shopRow;
  }),
  logEvent: vi.fn(async (): Promise<void> => {}),
  graphql: vi.fn(async (): Promise<unknown> => ({
    json: async () => ({
      data: {
        shop: {
          name: "Cellexia",
          currencyCode: "GBP",
          ianaTimezone: "Europe/London",
          contactEmail: "hello@cellexia.test",
          primaryDomain: { host: "cellexialabs.com" },
        },
        shopLocales: [],
      },
    }),
  })),
}));

vi.mock("~/db.server", () => ({
  default: {
    shop: {
      upsert: vi.fn(async (): Promise<unknown> => store.shopRow),
      update: mocks.shopUpdate,
      findUnique: vi.fn(async (): Promise<unknown> => store.shopRow),
    },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({
    graphql: mocks.graphql,
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/launch/launch.server", () => ({
  getLaunchState: vi.fn(async (): Promise<unknown> => ({ mode: "SETUP" })),
  syncLaunchMetafield: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/contracts/sync.server", () => ({
  backfillAllContracts: mocks.backfillAllContracts,
}));

import { onAppInstalled } from "~/lib/shop/install.server";

/** The backfill is fire-and-forget — drain the microtask queue to observe it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  store.shopRow = {
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    lastFullSyncAt: null,
  };
});

describe("onAppInstalled — initial contract backfill", () => {
  it("runs the full backfill on a shop that never completed one", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await onAppInstalled("cellexia.myshopify.com");
    await settle();

    expect(mocks.backfillAllContracts).toHaveBeenCalledWith(
      "cellexia.myshopify.com",
    );
    logSpy.mockRestore();
  });

  it("a re-auth after a completed sweep never re-runs it", async () => {
    store.shopRow.lastFullSyncAt = new Date("2026-08-01T00:00:00Z");

    await onAppInstalled("cellexia.myshopify.com");
    await settle();

    expect(mocks.backfillAllContracts).not.toHaveBeenCalled();
  });

  it("metadata sync no longer stamps lastFullSyncAt (only the sweep's completion does)", async () => {
    await onAppInstalled("cellexia.myshopify.com");
    await settle();

    for (const call of mocks.shopUpdate.mock.calls) {
      const { data } = call[0] as { data: Record<string, unknown> };
      expect(Object.keys(data)).not.toContain("lastFullSyncAt");
    }
  });

  it("a failed backfill is contained — install completes and the gate stays open", async () => {
    mocks.backfillAllContracts.mockRejectedValueOnce(new Error("shopify down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      onAppInstalled("cellexia.myshopify.com"),
    ).resolves.toBeUndefined();
    await settle();

    // Nothing stamped lastFullSyncAt, so the next auth retries the sweep.
    expect(store.shopRow.lastFullSyncAt).toBeNull();
    errSpy.mockRestore();
  });
});
