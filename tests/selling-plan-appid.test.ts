import { describe, expect, it, vi } from "vitest";
import type { SellingPlanConfig } from "@prisma/client";

import {
  getCurrentAppId,
  getSellingPlanGroupOwnershipStates,
  stampSellingPlanGroupAppIds,
  syncSellingPlanGroupFromConfig,
} from "~/lib/graphql/sellingPlans.server";

/**
 * THE APP-ID STAMP (v1.6.9) — the group-side half of the storefront's second
 * ownership factor, tested against the GraphQL layer itself.
 *
 * Storefront Liquid's `selling_plan_group.app_id` is NIL unless the owning
 * app writes `appId` into the group input — Shopify never fills it in. The
 * buy box refuses any group whose app_id differs from the published appId,
 * so a sync that forgot the stamp would produce a group that can never
 * render: this suite pins the stamp into every create AND update, plus the
 * publish-path heal for groups created before v1.6.9.
 *
 * Mocked at the AdminClient seam (the `graphql: () => Response` shape both
 * real clients satisfy), so the exact variables Shopify would receive are
 * what is asserted — no other module involved.
 */

const APP_GID = "gid://shopify/App/4477001";
const APP_ID = "4477001";
const GROUP_GID = "gid://shopify/SellingPlanGroup/661";

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
}

/** An AdminClient whose responses are scripted per matching query substring. */
function fakeAdmin(
  handlers: Array<[match: string, data: () => unknown]>,
): { admin: { graphql: ReturnType<typeof vi.fn> }; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const graphql = vi.fn(
    async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables ?? {} });
      const handler = handlers.find(([match]) => query.includes(match));
      if (!handler) throw new Error(`no handler for query: ${query.slice(0, 80)}`);
      return new Response(JSON.stringify({ data: handler[1]() }));
    },
  );
  return { admin: { graphql }, calls };
}

const CURRENT_APP_DATA = () => ({
  currentAppInstallation: { app: { id: APP_GID } },
});

/** A minimal config row — only the fields the sync layer reads. */
const CONFIG = {
  name: "Serum Monthly",
  merchantCode: "cellexia-serum",
  productIds: ["gid://shopify/Product/1"],
  frequenciesWeeks: [4],
  defaultFrequencyWeeks: 4,
  firstOrderDiscountPct: 20,
  ongoingDiscountPct: 10,
  prepaidEnabled: false,
  prepaidDeliveriesPerCharge: 1,
  prepaidDiscountPct: 0,
  shopifyGroupId: null,
} as unknown as SellingPlanConfig;

describe("getCurrentAppId", () => {
  it("returns the numeric id off the App gid", async () => {
    const { admin } = fakeAdmin([["CellexiaCurrentAppId", CURRENT_APP_DATA]]);
    await expect(getCurrentAppId(admin)).resolves.toBe(APP_ID);
  });

  it("throws when the id cannot be read — never a silent empty stamp", async () => {
    const { admin } = fakeAdmin([
      ["CellexiaCurrentAppId", () => ({ currentAppInstallation: null })],
    ]);
    await expect(getCurrentAppId(admin)).rejects.toThrow(
      "Could not read this app's own Shopify App id",
    );
  });
});

describe("syncSellingPlanGroupFromConfig stamps appId", () => {
  it("CREATE carries appId in the group input", async () => {
    const { admin, calls } = fakeAdmin([
      ["CellexiaCurrentAppId", CURRENT_APP_DATA],
      [
        "CellexiaSellingPlanGroupCreate",
        () => ({
          sellingPlanGroupCreate: {
            sellingPlanGroup: {
              id: GROUP_GID,
              sellingPlans: { nodes: [{ id: "gid://shopify/SellingPlan/1" }] },
            },
            userErrors: [],
          },
        }),
      ],
    ]);

    await syncSellingPlanGroupFromConfig(admin, CONFIG);

    const create = calls.find((c) =>
      c.query.includes("CellexiaSellingPlanGroupCreate"),
    );
    expect(create).toBeDefined();
    expect((create!.variables.input as Record<string, unknown>).appId).toBe(
      APP_ID,
    );
  });

  it("UPDATE carries appId too — the heal for groups created before v1.6.9", async () => {
    const { admin, calls } = fakeAdmin([
      ["CellexiaCurrentAppId", CURRENT_APP_DATA],
      [
        "query CellexiaSellingPlanGroup(",
        () => ({
          sellingPlanGroup: {
            id: GROUP_GID,
            sellingPlans: {
              nodes: [
                {
                  id: "gid://shopify/SellingPlan/1",
                  name: "Every 4 weeks",
                  options: ["Every 4 weeks"],
                },
              ],
            },
            products: { nodes: [{ id: "gid://shopify/Product/1" }] },
          },
        }),
      ],
      [
        "CellexiaSellingPlanGroupUpdate",
        () => ({
          sellingPlanGroupUpdate: {
            sellingPlanGroup: {
              id: GROUP_GID,
              sellingPlans: { nodes: [{ id: "gid://shopify/SellingPlan/1" }] },
            },
            userErrors: [],
          },
        }),
      ],
    ]);

    await syncSellingPlanGroupFromConfig(admin, {
      ...CONFIG,
      shopifyGroupId: GROUP_GID,
    } as SellingPlanConfig);

    const update = calls.find((c) =>
      c.query.includes("CellexiaSellingPlanGroupUpdate"),
    );
    expect(update).toBeDefined();
    expect((update!.variables.input as Record<string, unknown>).appId).toBe(
      APP_ID,
    );
  });

  it("fails the sync loudly when the app id cannot be read", async () => {
    // Fail-visible: without the stamp the group could never render, and a
    // sync error on the plan row beats a silently dark widget. Nothing may
    // be mutated on Shopify before the read succeeds.
    const { admin, calls } = fakeAdmin([
      ["CellexiaCurrentAppId", () => ({ currentAppInstallation: null })],
    ]);
    await expect(syncSellingPlanGroupFromConfig(admin, CONFIG)).rejects.toThrow(
      "Could not read this app's own Shopify App id",
    );
    expect(
      calls.some((c) => c.query.includes("mutation")),
    ).toBe(false);
  });
});

describe("stampSellingPlanGroupAppIds", () => {
  it("stamps only the groups that need it, and reports every group's outcome", async () => {
    const stampedGid = "gid://shopify/SellingPlanGroup/1";
    const unstampedGid = "gid://shopify/SellingPlanGroup/2";
    const { admin, calls } = fakeAdmin([
      [
        "CellexiaSellingPlanGroupSetAppId",
        () => ({
          sellingPlanGroupUpdate: {
            sellingPlanGroup: { id: unstampedGid, appId: APP_ID },
            userErrors: [],
          },
        }),
      ],
    ]);
    const states = new Map([
      [stampedGid, { appId: APP_ID, planIds: [] }],
      [unstampedGid, { appId: null, planIds: [] }],
    ]);

    const result = await stampSellingPlanGroupAppIds(
      admin,
      states,
      [stampedGid, unstampedGid],
      APP_ID,
    );

    expect(result).toEqual({
      stamped: [unstampedGid],
      alreadyStamped: [stampedGid],
      failed: [],
    });
    const updates = calls.filter((c) =>
      c.query.includes("CellexiaSellingPlanGroupSetAppId"),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].variables).toEqual({
      id: unstampedGid,
      input: { appId: APP_ID },
    });
  });

  it("a group absent from the live read is FAILED, never mutated blind", async () => {
    const { admin, calls } = fakeAdmin([]);
    await expect(
      stampSellingPlanGroupAppIds(admin, new Map(), [GROUP_GID], APP_ID),
    ).resolves.toEqual({ stamped: [], alreadyStamped: [], failed: [GROUP_GID] });
    expect(calls).toHaveLength(0);
  });

  it("one failing stamp does not stop the others — and lands in failed, not silence", async () => {
    const g1 = "gid://shopify/SellingPlanGroup/1";
    const g2 = "gid://shopify/SellingPlanGroup/2";
    let updateCall = 0;
    const { admin } = fakeAdmin([
      [
        "CellexiaSellingPlanGroupSetAppId",
        () => {
          updateCall += 1;
          if (updateCall === 1) {
            return {
              sellingPlanGroupUpdate: {
                sellingPlanGroup: null,
                userErrors: [{ field: ["appId"], message: "boom" }],
              },
            };
          }
          return {
            sellingPlanGroupUpdate: {
              sellingPlanGroup: { id: g2, appId: APP_ID },
              userErrors: [],
            },
          };
        },
      ],
    ]);
    const states = new Map([
      [g1, { appId: null, planIds: [] }],
      [g2, { appId: "someone-else", planIds: [] }],
    ]);

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const result = await stampSellingPlanGroupAppIds(
        admin,
        states,
        [g1, g2],
        APP_ID,
      );
      expect(result).toEqual({
        stamped: [g2],
        alreadyStamped: [],
        failed: [g1],
      });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("getSellingPlanGroupOwnershipStates maps appId + live plans; unreadable groups are absent", async () => {
    const { admin } = fakeAdmin([
      [
        "CellexiaSellingPlanGroupOwnershipStates",
        () => ({
          nodes: [
            {
              id: GROUP_GID,
              appId: APP_ID,
              sellingPlans: {
                nodes: [{ id: "gid://shopify/SellingPlan/1" }],
              },
            },
            null,
          ],
        }),
      ],
    ]);
    const map = await getSellingPlanGroupOwnershipStates(admin, [
      GROUP_GID,
      "gid://shopify/SellingPlanGroup/999",
    ]);
    expect(map.get(GROUP_GID)).toEqual({
      appId: APP_ID,
      planIds: ["gid://shopify/SellingPlan/1"],
    });
    expect(map.has("gid://shopify/SellingPlanGroup/999")).toBe(false);
  });
});
