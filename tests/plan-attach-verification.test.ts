import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * POST-SYNC ATTACHMENT VERIFICATION — the merchant must never see SYNCED
 * while the storefront disagrees.
 *
 * `sellingPlanGroupAddProducts` returning without userErrors is not proof the
 * product pages agree: another subscription app's own product sync can detach
 * our group from products it also manages (observed live with Joy on the
 * merchant's store), and a deleted product simply vanishes. The sync flow now
 * re-reads every product's sellingPlanGroups from the Admin API — admin GIDs
 * compared against admin GIDs, ONE id space, unlike storefront Liquid group
 * ids which live in a different (opaque) id space than the Admin API's — and
 * only a full attach may be recorded as SYNCED; anything else is
 * ATTACH_FAILED with the products named.
 *
 * Behavioural tests drive the real findProductsMissingFromGroup over a fake
 * AdminClient; source pins keep the Plans route on the verified path.
 */

import { findProductsMissingFromGroup } from "~/lib/graphql/sellingPlans.server";
import type { AdminClient } from "~/lib/graphql/client.server";

const GROUP = "gid://shopify/SellingPlanGroup/111";
const FOREIGN_GROUP = "gid://shopify/SellingPlanGroup/999";

function productGid(n: number): string {
  return `gid://shopify/Product/${n}`;
}

interface RecordedCall {
  query: string;
  variables?: Record<string, unknown>;
}

/**
 * AdminClient whose graphql() answers each call with the next canned `data`
 * page (last page repeats), recording every call for batching assertions.
 */
function fakeAdmin(pages: Array<Record<string, unknown>>): {
  admin: AdminClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const admin: AdminClient = {
    graphql: async (query, options) => {
      calls.push({ query, variables: options?.variables });
      const data = pages[Math.min(calls.length - 1, pages.length - 1)];
      return { json: async () => ({ data }) } as unknown as Response;
    },
  };
  return { admin, calls };
}

/** One product node carrying the given selling plan group ids. */
function node(productId: string, groupIds: string[]) {
  return {
    id: productId,
    sellingPlanGroups: { nodes: groupIds.map((id) => ({ id })) },
  };
}

describe("findProductsMissingFromGroup — admin-id-space attachment truth", () => {
  it("returns [] when every product carries the group", async () => {
    const { admin } = fakeAdmin([
      {
        nodes: [
          node(productGid(1), [GROUP]),
          node(productGid(2), [FOREIGN_GROUP, GROUP]),
        ],
      },
    ]);

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1), productGid(2)]),
    ).resolves.toEqual([]);
  });

  it("names the product whose groups no longer include ours", async () => {
    const { admin } = fakeAdmin([
      {
        nodes: [
          node(productGid(1), [GROUP]),
          // Detached by the other app's sync: only THEIR group remains.
          node(productGid(2), [FOREIGN_GROUP]),
        ],
      },
    ]);

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1), productGid(2)]),
    ).resolves.toEqual([productGid(2)]);
  });

  it("counts a product with NO groups at all as missing", async () => {
    const { admin } = fakeAdmin([
      { nodes: [{ id: productGid(1), sellingPlanGroups: { nodes: [] } }] },
    ]);

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1)]),
    ).resolves.toEqual([productGid(1)]);
  });

  it("counts an unreadable product (null node — deleted) as missing", async () => {
    const { admin } = fakeAdmin([
      { nodes: [null, node(productGid(2), [GROUP])] },
    ]);

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1), productGid(2)]),
    ).resolves.toEqual([productGid(1)]);
  });

  it("matches the group id EXACTLY — a different id form never counts as attached", async () => {
    // The whole live incident was an id-space conflation; this layer must
    // never quietly accept a bare numeric id as equal to the admin GID.
    const { admin } = fakeAdmin([{ nodes: [node(productGid(1), ["111"])] }]);

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1)]),
    ).resolves.toEqual([productGid(1)]);
  });

  it("batches large configs (26 products → two queries, ids split 25/1)", async () => {
    const ids = Array.from({ length: 26 }, (_, i) => productGid(i + 1));
    const { admin, calls } = fakeAdmin([
      { nodes: ids.slice(0, 25).map((id) => node(id, [GROUP])) },
      { nodes: [node(ids[25], [FOREIGN_GROUP])] },
    ]);

    await expect(findProductsMissingFromGroup(admin, GROUP, ids)).resolves.toEqual(
      [ids[25]],
    );
    expect(calls).toHaveLength(2);
    expect((calls[0].variables?.ids as string[]).length).toBe(25);
    expect(calls[1].variables?.ids).toEqual([ids[25]]);
  });

  it("makes no query at all for an empty product list", async () => {
    const { admin, calls } = fakeAdmin([{ nodes: [] }]);

    await expect(findProductsMissingFromGroup(admin, GROUP, [])).resolves.toEqual(
      [],
    );
    expect(calls).toHaveLength(0);
  });

  it("throws on GraphQL errors — the caller decides what unverifiable means", async () => {
    const admin: AdminClient = {
      graphql: async () =>
        ({
          json: async () => ({ errors: [{ message: "Throttled" }] }),
        }) as unknown as Response,
    };

    await expect(
      findProductsMissingFromGroup(admin, GROUP, [productGid(1)]),
    ).rejects.toThrow(/Throttled/);
  });
});

// ── Source pins: the Plans route stays on the verified path ──────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** Blank out comments so prose can neither satisfy nor defeat a rule. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("Plans route (app/routes/app.plans.tsx) — SYNCED only after verified attach", () => {
  const source = stripComments(read("app/routes/app.plans.tsx"));

  it("verifies attachment against the freshly synced group", () => {
    expect(source).toMatch(
      /findProductsMissingFromGroup\(\s*admin,\s*result\.groupId,\s*configProductIds,?\s*\)/,
    );
  });

  it("never writes the SYNCED literal unconditionally — status is computed by verification", () => {
    // The pre-fix shape was `syncStatus: "SYNCED"` straight after the sync
    // mutations; the row now stores the verification's verdict.
    expect(source).not.toMatch(/syncStatus:\s*"SYNCED"/);
    expect(source).toMatch(/let syncStatus = "SYNCED";/);
    expect(source).toMatch(/syncStatus = "ATTACH_FAILED";/);
    expect(source).toMatch(
      /data:\s*\{\s*shopifyGroupId:\s*result\.groupId,\s*syncStatus,\s*syncError,\s*\},/,
    );
  });

  it("treats an unverifiable attach as ATTACH_FAILED, not SYNCED", () => {
    expect(source).toMatch(
      /catch\s*\(verifyErr\)\s*\{[\s\S]{0,400}?syncStatus = "ATTACH_FAILED";/,
    );
  });

  it("surfaces ATTACH_FAILED on the row as an error badge with the message", () => {
    expect(source).toMatch(
      /plan\.syncStatus === "ATTACH_FAILED"[\s\S]{0,600}?<Badge tone="critical">/,
    );
  });
});
