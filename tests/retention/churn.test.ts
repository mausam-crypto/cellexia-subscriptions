import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHURN_THRESHOLD,
  computeChurnRisk,
  pickProactiveIntervention,
} from "~/services/retention/churn.server";
import type { ChurnFeatures } from "~/services/retention/churn.server";

function features(overrides: Partial<ChurnFeatures> = {}): ChurnFeatures {
  return {
    portalVisits30d: 0,
    delays90d: 0,
    skips90d: 0,
    failedCharges90d: 0,
    inferredExcessDays: 0,
    adherenceDiscomfort: false,
    addOnActivity90d: 0,
    aovTrendPct: 0,
    ...overrides,
  };
}

describe("computeChurnRisk — bounds and shape", () => {
  it("always returns a score in [0, 1]", () => {
    const extremes: ChurnFeatures[] = [
      features(),
      features({
        delays90d: 99,
        skips90d: 99,
        failedCharges90d: 99,
        inferredExcessDays: 999,
        adherenceDiscomfort: true,
        aovTrendPct: -100,
      }),
      features({
        portalVisits30d: 50,
        addOnActivity90d: 10,
        aovTrendPct: 100,
      }),
    ];
    for (const f of extremes) {
      const { score } = computeChurnRisk(f);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("returns a factor breakdown with a baseline and one entry per signal", () => {
    const { factors } = computeChurnRisk(
      features({ skips90d: 2, adherenceDiscomfort: true }),
    );
    expect(factors).toHaveProperty("baseline");
    expect(factors).toHaveProperty("skips90d");
    expect(factors).toHaveProperty("adherenceDiscomfort");
    expect(factors).toHaveProperty("portalVisits30d");
    expect(factors.skips90d).toBeGreaterThan(0);
    expect(factors.adherenceDiscomfort).toBeGreaterThan(0);
  });

  it("carries NO permanently-default features (old dead-weight model is gone)", () => {
    // The launch model spent ~39% of its positive weight on
    // refunds/tickets/ratings/email-engagement that nothing ever wrote,
    // which floored every real contract and made 0.7 unreachable. Those
    // features must not exist in the factor breakdown any more.
    const { factors } = computeChurnRisk(features());
    expect(factors).not.toHaveProperty("emailEngagementScore");
    expect(factors).not.toHaveProperty("supportTickets90d");
    expect(factors).not.toHaveProperty("lowProductRating");
    expect(factors).not.toHaveProperty("refunds180d");
  });
});

describe("computeChurnRisk — monotonicity", () => {
  it("more skips → higher risk", () => {
    const low = computeChurnRisk(features({ skips90d: 0 })).score;
    const high = computeChurnRisk(features({ skips90d: 3 })).score;
    expect(high).toBeGreaterThan(low);
  });

  it("more delays → higher risk", () => {
    const low = computeChurnRisk(features({ delays90d: 0 })).score;
    const high = computeChurnRisk(features({ delays90d: 3 })).score;
    expect(high).toBeGreaterThan(low);
  });

  it("more failed charges → higher risk", () => {
    const low = computeChurnRisk(features({ failedCharges90d: 0 })).score;
    const high = computeChurnRisk(features({ failedCharges90d: 2 })).score;
    expect(high).toBeGreaterThan(low);
  });

  it("more inferred excess inventory → higher risk", () => {
    const low = computeChurnRisk(features({ inferredExcessDays: 0 })).score;
    const mid = computeChurnRisk(features({ inferredExcessDays: 30 })).score;
    const high = computeChurnRisk(features({ inferredExcessDays: 60 })).score;
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });

  it("reported discomfort → higher risk", () => {
    const calm = computeChurnRisk(features({ adherenceDiscomfort: false })).score;
    const sore = computeChurnRisk(features({ adherenceDiscomfort: true })).score;
    expect(sore).toBeGreaterThan(calm);
  });

  it("portal engagement is protective", () => {
    const active = computeChurnRisk(features({ portalVisits30d: 6 })).score;
    const absent = computeChurnRisk(features({ portalVisits30d: 0 })).score;
    expect(active).toBeLessThan(absent);
  });

  it("add-on activity is protective", () => {
    const investing = computeChurnRisk(features({ addOnActivity90d: 2 })).score;
    const inert = computeChurnRisk(features({ addOnActivity90d: 0 })).score;
    expect(investing).toBeLessThan(inert);
  });

  it("declining spend → higher risk than growing spend", () => {
    const shrinking = computeChurnRisk(features({ aovTrendPct: -40 })).score;
    const growing = computeChurnRisk(features({ aovTrendPct: 20 })).score;
    expect(shrinking).toBeGreaterThan(growing);
  });
});

describe("computeChurnRisk — calibration sanity (production-feasible inputs only)", () => {
  it("scores a clean contract near the floor, well below threshold", () => {
    const { score } = computeChurnRisk(features());
    expect(score).toBeLessThan(0.2);
    expect(score).toBeLessThan(DEFAULT_CHURN_THRESHOLD);
  });

  it("scores a healthy engaged subscriber low", () => {
    const { score } = computeChurnRisk(
      features({ portalVisits30d: 5, addOnActivity90d: 2, aovTrendPct: 10 }),
    );
    expect(score).toBeLessThan(0.1);
  });

  it("FLAGS the textbook at-risk case using only live signals (old model never could)", () => {
    // 3 failed charges + 2 skips + 30 days of surplus — every one of these
    // comes from data the app records today. Under the launch model this
    // profile scored 0.57 against a 0.7 threshold and NO outreach ever
    // fired; it must flag now.
    const { score } = computeChurnRisk(
      features({ failedCharges90d: 3, skips90d: 2, inferredExcessDays: 30 }),
    );
    expect(score).toBeGreaterThanOrEqual(DEFAULT_CHURN_THRESHOLD);
  });

  it("flags a disengaged struggling subscriber decisively", () => {
    const { score } = computeChurnRisk(
      features({
        delays90d: 2,
        skips90d: 3,
        failedCharges90d: 2,
        adherenceDiscomfort: true,
        inferredExcessDays: 45,
        aovTrendPct: -40,
      }),
    );
    expect(score).toBeGreaterThan(0.8);
  });

  it("keeps a busy-but-happy subscriber below threshold despite one skip", () => {
    const { score } = computeChurnRisk(
      features({ skips90d: 1, portalVisits30d: 4, addOnActivity90d: 1 }),
    );
    expect(score).toBeLessThan(DEFAULT_CHURN_THRESHOLD);
  });
});

describe("pickProactiveIntervention", () => {
  it("suggests moving the delivery back for excess inventory (cheapest matching offer)", () => {
    const intervention = pickProactiveIntervention(
      features({ inferredExcessDays: 30 }),
    );
    expect(intervention.offerType).toBe("CHANGE_DELIVERY_DATE");
    expect(intervention.params.delayWeeks).toBe(4);
    expect(intervention.message.toLowerCase()).toContain("four weeks");
  });

  it("prioritises excess inventory over other drivers", () => {
    const intervention = pickProactiveIntervention(
      features({ inferredExcessDays: 30, failedCharges90d: 2, skips90d: 3 }),
    );
    expect(intervention.offerType).toBe("CHANGE_DELIVERY_DATE");
  });

  it("routes payment problems to a card update", () => {
    const intervention = pickProactiveIntervention(
      features({ failedCharges90d: 1 }),
    );
    expect(intervention.offerType).toBe("EDUCATION");
    expect(intervention.params.route).toBe("UPDATE_PAYMENT");
  });

  it("suggests a gentler swap when discomfort was reported", () => {
    const intervention = pickProactiveIntervention(
      features({ adherenceDiscomfort: true }),
    );
    expect(intervention.offerType).toBe("PRODUCT_SWAP");
    expect(intervention.params.mode).toBe("GENTLER");
  });

  it("suggests a slower cadence for repeated skips or delays", () => {
    expect(
      pickProactiveIntervention(features({ skips90d: 2 })).offerType,
    ).toBe("CHANGE_FREQUENCY");
    expect(
      pickProactiveIntervention(features({ delays90d: 2 })).offerType,
    ).toBe("CHANGE_FREQUENCY");
  });

  it("falls back to a gentle check-in", () => {
    const intervention = pickProactiveIntervention(features());
    expect(intervention.offerType).toBe("EDUCATION");
    expect(intervention.params.topics).toContain("CHECK_IN");
  });
});
