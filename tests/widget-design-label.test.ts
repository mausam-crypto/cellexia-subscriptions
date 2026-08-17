import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Buy-box design revision labels (v1.26.0, WidgetDesignRevision.label) and
 * the post-publish measurement hooks in app/lib/widget/design.server.ts.
 *
 * Pinned here:
 *  - saveDraftRevision(shopId, config, actor, { label }) persists a
 *    normalised label (whitespace collapsed, 80 chars max, empty → null) and
 *    the pre-v1.26.0 call shape (no opts) still writes label null.
 *  - publishRevision(shopId, id, actor, { label }) patches the label when one
 *    is passed (null clears it), leaves it alone when opts are absent, and
 *    logs the label in the buybox_design_published audit event.
 *  - restoreRevision copies the source label onto the new revision.
 *  - After a successful publish, refreshMarketCountryMap(shopId, admin) and
 *    invalidateScoreboardCache(shopId) are called fire-and-forget; either
 *    throwing never fails the publish, and neither runs when the metafield
 *    write fails (the publish is rolled back first).
 *
 * All server seams are mocked; nothing touches a database or Shopify.
 */

const mocks = vi.hoisted(() => ({
  revisions: new Map<string, Record<string, unknown>>(),
  nextId: 1,
  create: vi.fn(async (args: { data: Record<string, unknown> }) => {
    const id = `rev_${mocks.nextId++}`;
    const row = {
      id,
      publishedAt: null,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      createdBy: null,
      label: null,
      ...args.data,
    };
    mocks.revisions.set(id, row);
    return row;
  }),
  update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = mocks.revisions.get(args.where.id);
    if (!row) throw new Error("not found");
    const next = { ...row, ...args.data };
    mocks.revisions.set(args.where.id, next);
    return next;
  }),
  findFirst: vi.fn(async (args: { where: { id?: string } }) => {
    if (args.where.id) return mocks.revisions.get(args.where.id) ?? null;
    return null;
  }),
  findMany: vi.fn(async () => [...mocks.revisions.values()]),
  shopFindUnique: vi.fn(async () => ({ id: "shop_1", domain: "cellexia.myshopify.com" })),
  adminClient: { graphql: vi.fn() },
  adminClientForShop: vi.fn(async (): Promise<unknown> => mocks.adminClient),
  setShopMetafield: vi.fn(async (): Promise<void> => {}),
  logEvent: vi.fn(async (): Promise<void> => {}),
  refreshMarketCountryMap: vi.fn(async (): Promise<number> => 3),
  invalidateScoreboardCache: vi.fn((): void => {}),
}));

vi.mock("~/db.server", () => ({
  default: {
    widgetDesignRevision: {
      create: mocks.create,
      update: mocks.update,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
    shop: { findUnique: mocks.shopFindUnique },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: mocks.adminClientForShop,
}));
vi.mock("~/lib/graphql/metafields.server", () => ({
  setShopMetafield: mocks.setShopMetafield,
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/design-measurement/markets.server", () => ({
  refreshMarketCountryMap: mocks.refreshMarketCountryMap,
}));
vi.mock("~/lib/design-measurement/scoreboard.server", () => ({
  invalidateScoreboardCache: mocks.invalidateScoreboardCache,
}));

const { DEFAULT_DESIGN_CONFIG } = await import("~/lib/widget/presets");
const {
  DESIGN_LABEL_MAX_LENGTH,
  normalizeDesignLabel,
  publishRevision,
  restoreRevision,
  saveDraftRevision,
} = await import("~/lib/widget/design.server");

/** The hooks are fire-and-forget (dynamic import + await inside); flush them. */
async function flushHooks(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.revisions.clear();
  mocks.nextId = 1;
});

describe("normalizeDesignLabel", () => {
  it("trims, collapses whitespace, caps at 80 chars, and maps empty/null to null", () => {
    expect(normalizeDesignLabel(undefined)).toBeNull();
    expect(normalizeDesignLabel(null)).toBeNull();
    expect(normalizeDesignLabel("")).toBeNull();
    expect(normalizeDesignLabel("   ")).toBeNull();
    expect(normalizeDesignLabel("  Test 1:   sub\n preselected ")).toBe("Test 1: sub preselected");
    expect(normalizeDesignLabel("x".repeat(200))).toHaveLength(DESIGN_LABEL_MAX_LENGTH);
    expect(DESIGN_LABEL_MAX_LENGTH).toBe(80);
  });
});

describe("saveDraftRevision label", () => {
  it("persists the normalised label when given, null otherwise (old call shape unchanged)", async () => {
    const named = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io", {
      label: "  Test 2:  one-time  first ",
    });
    expect(named.label).toBe("Test 2: one-time first");
    expect(mocks.create.mock.calls[0][0].data).toMatchObject({
      shopId: "shop_1",
      preset: DEFAULT_DESIGN_CONFIG.preset,
      createdBy: "owner@x.io",
      label: "Test 2: one-time first",
    });

    const unnamed = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io");
    expect(unnamed.label).toBeNull();
    const blank = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io", { label: "  " });
    expect(blank.label).toBeNull();
  });
});

describe("publishRevision label", () => {
  it("keeps the draft's label when no opts are passed, and logs it in the publish event", async () => {
    const draft = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io", {
      label: "Test 1",
    });
    const published = await publishRevision("shop_1", draft.id, "owner@x.io");
    expect(published.label).toBe("Test 1");
    expect(published.publishedAt).toBeInstanceOf(Date);
    // The update never touched label (backward-compatible call).
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("label");
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "admin.action",
        payload: expect.objectContaining({
          action: "buybox_design_published",
          revisionId: draft.id,
          label: "Test 1",
        }),
      }),
    );
  });

  it("a label passed to publish wins over the draft's; null clears it", async () => {
    const draft = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io", {
      label: "Draft name",
    });
    const renamed = await publishRevision("shop_1", draft.id, "owner@x.io", {
      label: " Final   name ",
    });
    expect(renamed.label).toBe("Final name");
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({ label: "Final name" });

    const cleared = await publishRevision("shop_1", draft.id, "owner@x.io", { label: null });
    expect(cleared.label).toBeNull();
  });
});

describe("restoreRevision", () => {
  it("copies the source label onto the new published revision", async () => {
    const source = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io", {
      label: "Winner",
    });
    const restored = await restoreRevision("shop_1", source.id, "owner@x.io");
    expect(restored.id).not.toBe(source.id);
    expect(restored.label).toBe("Winner");
    expect(restored.publishedAt).toBeInstanceOf(Date);
    // Source untouched (append-only history).
    expect(mocks.revisions.get(source.id)?.publishedAt).toBeNull();
  });
});

describe("post-publish measurement hooks", () => {
  it("refreshes the market map with the admin client and clears the scoreboard cache after a successful publish", async () => {
    const draft = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io");
    await publishRevision("shop_1", draft.id, "owner@x.io");
    await flushHooks();
    expect(mocks.refreshMarketCountryMap).toHaveBeenCalledTimes(1);
    expect(mocks.refreshMarketCountryMap).toHaveBeenCalledWith("shop_1", mocks.adminClient);
    expect(mocks.invalidateScoreboardCache).toHaveBeenCalledWith("shop_1");
  });

  it("a throwing hook never fails the publish (contained, logged)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.refreshMarketCountryMap.mockRejectedValueOnce(new Error("markets api down"));
    mocks.invalidateScoreboardCache.mockImplementationOnce(() => {
      throw new Error("cache boom");
    });
    const draft = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io");
    const published = await publishRevision("shop_1", draft.id, "owner@x.io");
    expect(published.publishedAt).toBeInstanceOf(Date);
    await flushHooks();
    expect(errorSpy).toHaveBeenCalledWith(
      "[widget] market map refresh after publish failed",
      expect.any(Error),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[widget] scoreboard cache invalidation failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it("no hook runs when the metafield write fails (publish rolled back, error rethrown)", async () => {
    mocks.setShopMetafield.mockRejectedValueOnce(new Error("metafield write failed"));
    const draft = await saveDraftRevision("shop_1", DEFAULT_DESIGN_CONFIG, "owner@x.io");
    await expect(publishRevision("shop_1", draft.id, "owner@x.io")).rejects.toThrow(
      "metafield write failed",
    );
    await flushHooks();
    expect(mocks.revisions.get(draft.id)?.publishedAt).toBeNull();
    expect(mocks.refreshMarketCountryMap).not.toHaveBeenCalled();
    expect(mocks.invalidateScoreboardCache).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
