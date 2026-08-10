import { describe, expect, it, vi } from "vitest";
import type { SellingPlanConfig } from "@prisma/client";

import { syncSellingPlanGroupFromConfig } from "~/lib/graphql/sellingPlans.server";

/**
 * MULTI-UNIT SELLING PLAN SYNC (v1.8.0).
 *
 * A SellingPlanConfig can now offer DAY / WEEK / MONTH cadences in one group.
 * This suite pins the Shopify-facing contract of that change at the same
 * AdminClient seam as the appId suite:
 *
 *   a. each frequency becomes a plan whose billing AND delivery policy carry
 *      the exact unit + count (no week conversion anywhere), ordered
 *      shortest-cadence-first;
 *   b. WEEK plans keep the byte-identical pre-v1.8.0 option value
 *      ("Every N weeks") as name, option AND reconcile key, so re-syncing an
 *      existing week-only group UPDATES its plans in place — plan GIDs
 *      stable, no storefront allow-list churn (tested via sellingPlansToUpdate
 *      vs ToCreate/ToDelete on a group that already carries the plan);
 *   c. a legacy config row (multi-unit columns NULL, pre-v1.8.0) still syncs
 *      exactly what it synced before, through the week-column fallback;
 *   d. prepaid bills in the DEFAULT frequency's own unit at count × deliveries
 *      (a monthly default prepays N months, not N×4 weeks).
 */

const APP_GID = "gid://shopify/App/4477001";
const GROUP_GID = "gid://shopify/SellingPlanGroup/661";

interface RecordedCall {
  query: string;
  variables: Record<string, unknown>;
}

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

const CREATE_DATA = () => ({
  sellingPlanGroupCreate: {
    sellingPlanGroup: {
      id: GROUP_GID,
      sellingPlans: { nodes: [{ id: "gid://shopify/SellingPlan/1" }] },
    },
    userErrors: [],
  },
});

function config(overrides: Record<string, unknown>): SellingPlanConfig {
  return {
    name: "Serum Ritual",
    merchantCode: "cellexia-serum",
    productIds: ["gid://shopify/Product/1"],
    frequencies: null,
    defaultFrequency: null,
    frequenciesWeeks: [4],
    defaultFrequencyWeeks: 4,
    firstOrderDiscountPct: 20,
    ongoingDiscountPct: 10,
    prepaidEnabled: false,
    prepaidDeliveriesPerCharge: 1,
    prepaidDiscountPct: 0,
    shopifyGroupId: null,
    ...overrides,
  } as unknown as SellingPlanConfig;
}

type PlanInput = {
  name: string;
  options: string[];
  billingPolicy: { recurring: { interval: string; intervalCount: number } };
  deliveryPolicy: { recurring: { interval: string; intervalCount: number } };
};

async function createdPlans(cfg: SellingPlanConfig): Promise<PlanInput[]> {
  const { admin, calls } = fakeAdmin([
    ["CellexiaCurrentAppId", CURRENT_APP_DATA],
    ["CellexiaSellingPlanGroupCreate", CREATE_DATA],
  ]);
  await syncSellingPlanGroupFromConfig(admin, cfg);
  const create = calls.find((c) => c.query.includes("SellingPlanGroupCreate"));
  const input = create!.variables.input as { sellingPlansToCreate: PlanInput[] };
  return input.sellingPlansToCreate;
}

describe("mixed-unit plan construction", () => {
  it("carries each frequency's exact unit + count into both policies, shortest first", async () => {
    const plans = await createdPlans(
      config({
        frequencies: [
          { unit: "MONTH", count: 1 },
          { unit: "DAY", count: 10 },
          { unit: "WEEK", count: 2 },
        ],
        defaultFrequency: { unit: "WEEK", count: 2 },
        // Legacy columns as every v1.8.0 writer stores them: the approxWeeks
        // projection — parseConfigFrequencies treats drift as a rollback-era
        // legacy edit and would ignore the multi-unit list.
        frequenciesWeeks: [2, 4],
        defaultFrequencyWeeks: 2,
      }),
    );

    expect(
      plans.map((p) => ({
        name: p.name,
        billing: p.billingPolicy.recurring,
        delivery: p.deliveryPolicy.recurring,
      })),
    ).toEqual([
      {
        name: "Every 10 days",
        billing: { interval: "DAY", intervalCount: 10 },
        delivery: { interval: "DAY", intervalCount: 10 },
      },
      {
        name: "Every 2 weeks",
        billing: { interval: "WEEK", intervalCount: 2 },
        delivery: { interval: "WEEK", intervalCount: 2 },
      },
      {
        name: "Every 1 month",
        billing: { interval: "MONTH", intervalCount: 1 },
        delivery: { interval: "MONTH", intervalCount: 1 },
      },
    ]);
    // The option value IS the reconcile key — one option per plan, equal to
    // the name.
    for (const plan of plans) {
      expect(plan.options).toEqual([plan.name]);
    }
  });

  it("a legacy week-only row (NULL multi-unit columns) syncs identically to pre-v1.8.0", async () => {
    const plans = await createdPlans(
      config({ frequenciesWeeks: [4, 8], defaultFrequencyWeeks: 8 }),
    );
    expect(plans.map((p) => p.name)).toEqual(["Every 4 weeks", "Every 8 weeks"]);
    expect(plans.map((p) => p.billingPolicy.recurring)).toEqual([
      { interval: "WEEK", intervalCount: 4 },
      { interval: "WEEK", intervalCount: 8 },
    ]);
  });
});

describe("week-key stability on update (GID preservation)", () => {
  it("an existing 'Every 4 weeks' plan is UPDATED in place, never recreated", async () => {
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

    // The same 4-week cadence, now stored in the multi-unit column, plus a
    // NEW monthly option: the week plan must reconcile by key, the month
    // plan must be the only creation, and nothing is deleted.
    await syncSellingPlanGroupFromConfig(
      admin,
      config({
        shopifyGroupId: GROUP_GID,
        frequencies: [
          { unit: "WEEK", count: 4 },
          { unit: "MONTH", count: 1 },
        ],
        defaultFrequency: { unit: "WEEK", count: 4 },
      }),
    );

    const update = calls.find((c) =>
      c.query.includes("CellexiaSellingPlanGroupUpdate"),
    );
    const input = update!.variables.input as {
      sellingPlansToCreate: PlanInput[];
      sellingPlansToUpdate: Array<PlanInput & { id: string }>;
      sellingPlansToDelete: string[];
    };
    expect(input.sellingPlansToUpdate.map((p) => ({ id: p.id, name: p.name }))).toEqual([
      { id: "gid://shopify/SellingPlan/1", name: "Every 4 weeks" },
    ]);
    expect(input.sellingPlansToCreate.map((p) => p.name)).toEqual([
      "Every 1 month",
    ]);
    expect(input.sellingPlansToDelete).toEqual([]);
  });
});

describe("prepaid follows the default frequency's unit", () => {
  it("a monthly default prepays N months — bills MONTH × deliveries, ships MONTH × count", async () => {
    const plans = await createdPlans(
      config({
        frequencies: [{ unit: "MONTH", count: 1 }],
        defaultFrequency: { unit: "MONTH", count: 1 },
        prepaidEnabled: true,
        prepaidDeliveriesPerCharge: 3,
        prepaidDiscountPct: 15,
      }),
    );

    const prepaid = plans.find((p) => p.name.includes("prepay"));
    expect(prepaid).toBeDefined();
    expect(prepaid!.name).toBe("Every 1 month, prepay 3 deliveries");
    expect(prepaid!.billingPolicy.recurring).toEqual({
      interval: "MONTH",
      intervalCount: 3,
    });
    expect(prepaid!.deliveryPolicy.recurring).toEqual({
      interval: "MONTH",
      intervalCount: 1,
    });
  });

  it("a week default keeps the byte-identical pre-v1.8.0 prepaid key", async () => {
    const plans = await createdPlans(
      config({
        prepaidEnabled: true,
        prepaidDeliveriesPerCharge: 3,
        prepaidDiscountPct: 15,
      }),
    );
    const prepaid = plans.find((p) => p.name.includes("prepay"));
    expect(prepaid!.name).toBe("Every 4 weeks, prepay 3 deliveries");
    expect(prepaid!.billingPolicy.recurring).toEqual({
      interval: "WEEK",
      intervalCount: 12,
    });
  });
});
