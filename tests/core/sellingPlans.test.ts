import { describe, expect, it } from "vitest";
import {
  buildSellingPlanGroupInput,
  CELLEXIA_PLAN_GROUP_APP_ID,
} from "~/services/core/sellingPlans.server";

describe("buildSellingPlanGroupInput", () => {
  const plans = [
    { name: "Every 4 weeks", intervalWeeks: 4, percentOff: 15 },
    {
      name: "Committed — every 4 weeks",
      intervalWeeks: 4,
      percentOff: 20,
      committed: true,
      minDeliveries: 3,
      shopifyPlanId: "gid://shopify/SellingPlan/1",
    },
  ];

  it("stamps the cellexia appId so the storefront widget can select OUR group when another subscription app (e.g. Joy) also has groups on the product", () => {
    const input = buildSellingPlanGroupInput({
      name: "Continuous Treatment",
      merchantCode: "ct",
      plans,
    });
    expect(input.appId).toBe(CELLEXIA_PLAN_GROUP_APP_ID);
    expect(CELLEXIA_PLAN_GROUP_APP_ID).toBe("cellexia");
  });

  it("splits create vs update by shopifyPlanId and carries minCycles on committed plans", () => {
    const input = buildSellingPlanGroupInput({
      name: "Continuous Treatment",
      merchantCode: "ct",
      plans,
    }) as {
      sellingPlansToCreate: Array<Record<string, unknown>>;
      sellingPlansToUpdate: Array<{
        billingPolicy: { recurring: { minCycles?: number } };
      }>;
    };
    expect(input.sellingPlansToCreate).toHaveLength(1);
    expect(input.sellingPlansToUpdate).toHaveLength(1);
    expect(input.sellingPlansToUpdate[0].billingPolicy.recurring.minCycles).toBe(3);
  });
});
