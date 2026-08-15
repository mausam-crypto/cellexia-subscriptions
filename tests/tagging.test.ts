import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SHOPIFY TAGGING (tagging settings group, v1.23.0)
 *
 * Customer subscriber tag + subscription order tags, merchant-toggleable and
 * ON by default. Pinned here:
 *
 *  1. Registry contract: both toggles default ON with the documented tag
 *     values; a partially stored value backfills; tag values are trimmed,
 *     non-empty, comma-free.
 *  2. The subscriber-tag recompute: membership = ANY live (ACTIVE/PAUSED)
 *     owned non-demo contract; add/remove/rename driven by the byte-exact
 *     CustomerTagState diff; no Shopify call when nothing changed; never a
 *     removal without a ledger row (own-tags-only rule); redacted
 *     identities and SETUP mode and uninstalled shops are never written to.
 *  3. Order tags: first vs repeat value, ours-only + non-demo gating, the
 *     taggedOrderId event guard (redrive/replay idempotency), containment.
 *  4. The reconcile sweep: union of live customers + ledger-tagged
 *     customers, capped, stats logged as one admin.action.
 *  5. Source pins: the sync-tail recompute, the cancelContract hook, the
 *     create-tail + catch-up origin-order tagging, the settlement-tail
 *     repeat tagging (before the settledAt marker), the settings-save
 *     reconcile, and the OURS_ONLY + isDemo filter in the membership query.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8");

const TAGGING_DEFAULTS = {
  customerTagEnabled: true,
  customerTag: "Active Subscriber",
  orderTagsEnabled: true,
  firstOrderTag: "Subscription First Order",
  repeatOrderTag: "Subscription Recurring Order",
};

const dbMocks = vi.hoisted(() => ({
  contractFindMany: vi.fn(async (): Promise<unknown[]> => []),
  tagStateFindUnique: vi.fn(async (): Promise<unknown> => null),
  tagStateFindMany: vi.fn(async (): Promise<unknown[]> => []),
  tagStateUpsert: vi.fn(async (): Promise<unknown> => ({})),
  shopFindUnique: vi.fn(
    async (): Promise<unknown> => ({
      id: "shop1",
      domain: "test.myshopify.com",
      uninstalledAt: null,
    }),
  ),
  eventFindFirst: vi.fn(async (): Promise<unknown> => null),
}));

const seamMocks = vi.hoisted(() => ({
  getSetting: vi.fn(async (): Promise<unknown> => ({})),
  isSetupMode: vi.fn(async (): Promise<boolean> => false),
  logEvent: vi.fn(async (): Promise<void> => {}),
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({ graphql: vi.fn() })),
  addNodeTags: vi.fn(async (): Promise<void> => {}),
  removeNodeTags: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => {
  const models = {
    subscriptionContract: { findMany: dbMocks.contractFindMany },
    customerTagState: {
      findUnique: dbMocks.tagStateFindUnique,
      findMany: dbMocks.tagStateFindMany,
      upsert: dbMocks.tagStateUpsert,
    },
    shop: { findUnique: dbMocks.shopFindUnique },
    subscriberEvent: { findFirst: dbMocks.eventFindFirst },
  };
  return {
    default: {
      ...models,
      // The subscriber-tag recompute runs under an advisory-locked
      // interactive transaction; the tx handle exposes the same models.
      $transaction: vi.fn(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ ...models, $executeRaw: vi.fn(async () => 0) }),
      ),
    },
  };
});

vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: seamMocks.getSetting,
}));

vi.mock("~/lib/launch/launch.server", () => ({
  isSetupMode: seamMocks.isSetupMode,
}));

vi.mock("~/lib/events/log.server", () => ({
  logEvent: seamMocks.logEvent,
}));

vi.mock("~/shopify.server", () => ({
  adminClientForShop: seamMocks.adminClientForShop,
}));

vi.mock("~/lib/graphql/tags.server", () => ({
  addNodeTags: seamMocks.addNodeTags,
  removeNodeTags: seamMocks.removeNodeTags,
}));

import {
  maybeSyncSubscriberTag,
  maybeTagSubscriptionOrder,
  reconcileAllSubscriberTags,
} from "~/lib/tagging/tags.server";
import { settingsSchemas } from "~/lib/settings/registry.server";

const CUSTOMER = "gid://shopify/Customer/1";
const ORDER = "gid://shopify/Order/9";

const oursContract = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  status: "ACTIVE",
  email: "a@b.test",
  customerId: CUSTOMER,
  isDemo: false,
  ownership: "OURS",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  seamMocks.getSetting.mockResolvedValue(TAGGING_DEFAULTS);
  seamMocks.isSetupMode.mockResolvedValue(false);
  dbMocks.shopFindUnique.mockResolvedValue({
    id: "shop1",
    domain: "test.myshopify.com",
    uninstalledAt: null,
  });
  dbMocks.contractFindMany.mockResolvedValue([]);
  dbMocks.tagStateFindUnique.mockResolvedValue(null);
  dbMocks.tagStateFindMany.mockResolvedValue([]);
  dbMocks.eventFindFirst.mockResolvedValue(null);
});

// ── 1. Registry contract ─────────────────────────────────────────────────────

describe("tagging settings group", () => {
  it("ships ON by default with the documented tag values", () => {
    expect(settingsSchemas.tagging.parse(undefined)).toEqual(TAGGING_DEFAULTS);
    // A partially stored value keeps parsing (field-level defaults).
    const partial = settingsSchemas.tagging.safeParse({
      customerTagEnabled: false,
    });
    expect(partial.success).toBe(true);
    if (partial.success) {
      expect(partial.data.customerTagEnabled).toBe(false);
      expect(partial.data.orderTagsEnabled).toBe(true);
      expect(partial.data.customerTag).toBe("Active Subscriber");
    }
  });

  it("rejects empty and comma-carrying tag values, trims whitespace", () => {
    expect(
      settingsSchemas.tagging.safeParse({ customerTag: "" }).success,
    ).toBe(false);
    expect(
      settingsSchemas.tagging.safeParse({ firstOrderTag: "a,b" }).success,
    ).toBe(false);
    const trimmed = settingsSchemas.tagging.safeParse({
      customerTag: "  VIP Subscriber  ",
    });
    expect(trimmed.success).toBe(true);
    if (trimmed.success) expect(trimmed.data.customerTag).toBe("VIP Subscriber");
  });
});

// ── 2. Subscriber tag recompute ──────────────────────────────────────────────

describe("maybeSyncSubscriberTag", () => {
  it("adds the tag for a live owned contract and records the ledger row", async () => {
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    const op = await maybeSyncSubscriberTag("shop1", CUSTOMER, {
      contractId: "c1",
    });
    expect(op).toBe("added");
    expect(seamMocks.addNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER,
      ["Active Subscriber"],
    );
    expect(seamMocks.removeNodeTags).not.toHaveBeenCalled();
    expect(dbMocks.tagStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          tagged: true,
          tagValue: "Active Subscriber",
        }),
      }),
    );
    expect(seamMocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contract.updated",
        contractId: "c1",
        payload: expect.objectContaining({
          action: "subscriber_tag_synced",
          op: "added",
        }),
      }),
    );
  });

  it("membership counts only billable-ownership contracts (FOREIGN/UNKNOWN never add the tag)", async () => {
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ ownership: "FOREIGN" }),
      oursContract({ id: "c2", ownership: "UNKNOWN" }),
    ]);
    // Live but not ours, no ledger row → never touch the customer.
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("noop");
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.removeNodeTags).not.toHaveBeenCalled();
    // Non-demo stays in the SQL where; ownership is filtered in JS so the
    // REMOVAL side survives an OURS→FOREIGN reclassification.
    expect(dbMocks.contractFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isDemo: false }),
      }),
    );
  });

  it("removes the ledger tag even when every contract was reclassified away from OURS", async () => {
    // The stranded-tag regression: tagged while OURS, then plan evidence
    // proves the contract FOREIGN. The OURS set is empty but the ledger row
    // must still drive the removal — and the audit event keeps a contract
    // link via the mirror fallback witness.
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ ownership: "FOREIGN", status: "ACTIVE" }),
    ]);
    dbMocks.tagStateFindUnique.mockResolvedValue({
      tagged: true,
      tagValue: "Active Subscriber",
    });
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("removed");
    expect(seamMocks.removeNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER,
      ["Active Subscriber"],
    );
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: "c1" }),
    );
  });

  it("PAUSED counts as live; FAILED / CANCELLED / EXPIRED do not", async () => {
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ status: "PAUSED" }),
    ]);
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("added");

    vi.clearAllMocks();
    seamMocks.getSetting.mockResolvedValue(TAGGING_DEFAULTS);
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ status: "FAILED" }),
      oursContract({ id: "c2", status: "CANCELLED" }),
      oursContract({ id: "c3", status: "EXPIRED" }),
    ]);
    dbMocks.tagStateFindUnique.mockResolvedValue(null);
    // Not live and never tagged by us → never touch the customer.
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("noop");
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.removeNodeTags).not.toHaveBeenCalled();
  });

  it("removes ONLY the ledger-recorded tag when the last live contract ends", async () => {
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ status: "CANCELLED" }),
    ]);
    dbMocks.tagStateFindUnique.mockResolvedValue({
      tagged: true,
      tagValue: "Old Subscriber Tag",
    });
    const op = await maybeSyncSubscriberTag("shop1", CUSTOMER);
    expect(op).toBe("removed");
    expect(seamMocks.removeNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER,
      ["Old Subscriber Tag"],
    );
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(dbMocks.tagStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ tagged: false }),
      }),
    );
  });

  it("renames by removing the old byte-exact value and adding the new one", async () => {
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    dbMocks.tagStateFindUnique.mockResolvedValue({
      tagged: true,
      tagValue: "Old Subscriber Tag",
    });
    const op = await maybeSyncSubscriberTag("shop1", CUSTOMER);
    expect(op).toBe("renamed");
    expect(seamMocks.removeNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER,
      ["Old Subscriber Tag"],
    );
    expect(seamMocks.addNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      CUSTOMER,
      ["Active Subscriber"],
    );
  });

  it("is a no-op without any Shopify round trip when the ledger already matches", async () => {
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    dbMocks.tagStateFindUnique.mockResolvedValue({
      tagged: true,
      tagValue: "Active Subscriber",
    });
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("noop");
    expect(seamMocks.adminClientForShop).not.toHaveBeenCalled();
    expect(dbMocks.tagStateUpsert).not.toHaveBeenCalled();
    expect(seamMocks.logEvent).not.toHaveBeenCalled();
  });

  it("skips: disabled, SETUP mode, redacted identity, uninstalled shop, empty customer", async () => {
    // Disabled.
    seamMocks.getSetting.mockResolvedValue({
      ...TAGGING_DEFAULTS,
      customerTagEnabled: false,
    });
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("skipped");

    // SETUP mode — checked before any Shopify write.
    seamMocks.getSetting.mockResolvedValue(TAGGING_DEFAULTS);
    seamMocks.isSetupMode.mockResolvedValue(true);
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("skipped");

    // Redacted identity — never pushed to Shopify post-redact.
    seamMocks.isSetupMode.mockResolvedValue(false);
    dbMocks.contractFindMany.mockResolvedValue([
      oursContract({ email: "redacted+123@example.invalid" }),
    ]);
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("skipped");

    // Uninstalled shop — the admin token is dead.
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    dbMocks.shopFindUnique.mockResolvedValue({
      id: "shop1",
      domain: "test.myshopify.com",
      uninstalledAt: new Date(),
    });
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("skipped");

    // Empty customer id (mirror default when Shopify omitted the customer).
    expect(await maybeSyncSubscriberTag("shop1", "")).toBe("skipped");

    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.removeNodeTags).not.toHaveBeenCalled();
  });

  it("contains Shopify failures (returns failed, ledger NOT advanced)", async () => {
    dbMocks.contractFindMany.mockResolvedValue([oursContract()]);
    seamMocks.addNodeTags.mockRejectedValueOnce(new Error("throttled"));
    expect(await maybeSyncSubscriberTag("shop1", CUSTOMER)).toBe("failed");
    // The ledger records only ACCEPTED writes — the next recompute retries.
    expect(dbMocks.tagStateUpsert).not.toHaveBeenCalled();
  });
});

// ── 3. Order tags ────────────────────────────────────────────────────────────

describe("maybeTagSubscriptionOrder", () => {
  it("tags first vs repeat with the configured values and logs the guard key", async () => {
    await maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "first");
    expect(seamMocks.addNodeTags).toHaveBeenCalledWith(
      expect.anything(),
      ORDER,
      ["Subscription First Order"],
    );
    expect(seamMocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "contract.updated",
        payload: expect.objectContaining({
          action: "order_tagged",
          taggedOrderId: ORDER,
          kind: "first",
        }),
      }),
    );

    await maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "repeat");
    expect(seamMocks.addNodeTags).toHaveBeenLastCalledWith(
      expect.anything(),
      ORDER,
      ["Subscription Recurring Order"],
    );
  });

  it("is idempotent across redrives via the taggedOrderId event guard — scoped to the contract's own events", async () => {
    dbMocks.eventFindFirst.mockResolvedValue({ id: "evt1" });
    await maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "repeat");
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.logEvent).not.toHaveBeenCalled();
    expect(dbMocks.eventFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          // contractId keeps the JSON predicate on the [contractId,
          // createdAt] index instead of scanning every contract.updated row.
          contractId: "c1",
          payload: { path: ["taggedOrderId"], equals: ORDER },
        }),
      }),
    );
  });

  it("skips: demo, foreign/unknown ownership, redacted identity, disabled, SETUP, missing order id", async () => {
    await maybeTagSubscriptionOrder(
      "shop1",
      oursContract({ email: "redacted+9@example.invalid" }),
      ORDER,
      "first",
    );
    await maybeTagSubscriptionOrder(
      "shop1",
      oursContract({ isDemo: true }),
      ORDER,
      "first",
    );
    await maybeTagSubscriptionOrder(
      "shop1",
      oursContract({ ownership: "FOREIGN" }),
      ORDER,
      "first",
    );
    await maybeTagSubscriptionOrder(
      "shop1",
      oursContract({ ownership: "UNKNOWN" }),
      ORDER,
      "first",
    );
    await maybeTagSubscriptionOrder("shop1", oursContract(), null, "first");
    seamMocks.getSetting.mockResolvedValue({
      ...TAGGING_DEFAULTS,
      orderTagsEnabled: false,
    });
    await maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "first");
    seamMocks.getSetting.mockResolvedValue(TAGGING_DEFAULTS);
    seamMocks.isSetupMode.mockResolvedValue(true);
    await maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "first");
    expect(seamMocks.addNodeTags).not.toHaveBeenCalled();
    expect(seamMocks.logEvent).not.toHaveBeenCalled();
  });

  it("contains Shopify failures (no throw, no event logged)", async () => {
    seamMocks.addNodeTags.mockRejectedValueOnce(new Error("order too old"));
    await expect(
      maybeTagSubscriptionOrder("shop1", oursContract(), ORDER, "repeat"),
    ).resolves.toBeUndefined();
    expect(seamMocks.logEvent).not.toHaveBeenCalled();
  });
});

// ── 4. Reconcile sweep ───────────────────────────────────────────────────────

describe("reconcileAllSubscriberTags", () => {
  it("unions live customers with ledger-tagged customers and logs one summary", async () => {
    dbMocks.contractFindMany
      // Sweep enumeration: distinct live customers.
      .mockResolvedValueOnce([
        { customerId: "gid://shopify/Customer/1" },
        { customerId: "gid://shopify/Customer/2" },
        { customerId: "" },
      ])
      // Per-customer membership loads (three customers in the union).
      .mockResolvedValue([oursContract()]);
    dbMocks.tagStateFindMany.mockResolvedValue([
      { customerId: "gid://shopify/Customer/2" },
      { customerId: "gid://shopify/Customer/3" },
    ]);
    const stats = await reconcileAllSubscriberTags("shop1", "admin@x.test");
    expect(stats).toMatchObject({ examined: 3, added: 3, capped: false });
    expect(seamMocks.logEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "admin.action",
        actor: "admin@x.test",
        payload: expect.objectContaining({
          action: "subscriber_tags_reconciled",
          examined: 3,
        }),
      }),
    );
  });

  it("does not run while disabled or in SETUP", async () => {
    seamMocks.getSetting.mockResolvedValue({
      ...TAGGING_DEFAULTS,
      customerTagEnabled: false,
    });
    expect(await reconcileAllSubscriberTags("shop1")).toBeNull();
    seamMocks.getSetting.mockResolvedValue(TAGGING_DEFAULTS);
    seamMocks.isSetupMode.mockResolvedValue(true);
    expect(await reconcileAllSubscriberTags("shop1")).toBeNull();
    expect(dbMocks.contractFindMany).not.toHaveBeenCalled();
  });
});

// ── 5. Source pins ───────────────────────────────────────────────────────────

describe("source pins", () => {
  it("the sync tail recomputes the subscriber tag (the catch-all choke point)", () => {
    const src = readSource("app/lib/contracts/sync.server.ts");
    expect(src).toContain('import("~/lib/tagging/tags.server")');
    expect(src).toContain("maybeSyncSubscriberTag(shop.id, contractRow.customerId");
  });

  it("the sync tail heals the first-order tag when ownership transitions into billable", () => {
    const src = readSource("app/lib/contracts/sync.server.ts");
    expect(src).toContain("!isBillableOwnership(existingRow.ownership)");
    expect(src).toContain("isBillableOwnership(persistedOwnership)");
    expect(src).toMatch(/maybeTagSubscriptionOrder\(\s*shop\.id,\s*contractRow,/);
  });

  it("cancelContract recomputes in the same request (headline promise)", () => {
    const src = readSource("app/lib/contracts/service.server.ts");
    const cancelBody = src.slice(
      src.indexOf("export async function cancelContract"),
      src.indexOf("// ── Address / next date / payment"),
    );
    expect(cancelBody).toContain("maybeSyncSubscriberTag");
  });

  it("origin-order tag rides the create tail AND the catch-up branch; repeat rides the settlement tail before the settledAt marker", () => {
    const src = readSource("app/lib/webhooks/handlers.server.ts");
    const createTail = src.slice(
      src.indexOf("async function handleSubscriptionContractsCreate"),
      src.indexOf("async function handleSubscriptionContractsUpdate"),
    );
    expect(createTail).toContain("maybeTagOriginOrder(shop.id, contract.id)");
    const updateHandler = src.slice(
      src.indexOf("async function handleSubscriptionContractsUpdate"),
      src.indexOf("// ── Billing attempts"),
    );
    expect(updateHandler).toContain("maybeTagOriginOrder(shop.id, after.id)");
    const settlement = src.slice(
      src.indexOf("export async function finishSuccessSettlement"),
    );
    const tagAt = settlement.indexOf("maybeTagSubscriptionOrder");
    const markerAt = settlement.indexOf("settledAt: new Date()");
    expect(tagAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(tagAt);
  });

  it("ownership + demo gating is present in source (mocked Prisma cannot catch a dropped filter)", () => {
    const src = readSource("app/lib/tagging/tags.server.ts");
    // Membership (ADD side): ownership filtered in JS via isBillableOwnership
    // so the REMOVAL side survives OURS→FOREIGN reclassification; the sweep's
    // live-customer enumeration spreads OURS_ONLY in SQL.
    expect(src).toContain(
      "contracts.filter((c) => isBillableOwnership(c.ownership))",
    );
    expect(src).toContain("...OURS_ONLY");
    expect(src).toMatch(/isDemo: false/);
    expect(src).toMatch(/status: \{ in: \[\.\.\.LIVE_STATUSES\] \}/);
    // Racing webhook echoes for one customer serialize on the advisory lock.
    expect(src).toContain("pg_advisory_xact_lock");
  });

  it("the Settings page renders the card and fires the reconcile WITHOUT awaiting it", () => {
    const src = readSource("app/routes/app.settings.tsx");
    expect(src).toContain('key: "tagging"');
    // Fire-and-forget (the sendConfirmations pattern): a 2000-customer sweep
    // must never hold the save POST.
    expect(src).toMatch(
      /import\("~\/lib\/tagging\/tags\.server"\)\s*\.then\(\(\{ reconcileAllSubscriberTags \}\)/,
    );
    expect(src).not.toMatch(/await reconcileAllSubscriberTags/);
  });
});
