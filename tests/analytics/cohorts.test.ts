/**
 * Regression tests for the pure cohort helpers in
 * app/services/analytics/cohorts.server.ts.
 *
 * The only writer of SubscriptionContract.acquisitionJson stores the
 * parseAcquisitionAttributes shape (UTM keys nested under `utm`, other
 * `_cellexia_*` keys under `custom`); cohort dimensions must resolve through
 * that nested shape as well as flat legacy/seed shapes.
 *
 * Formula regressions follow the "assert the WRONG number the bug produced,
 * then the right one" convention.
 */
import { describe, expect, it } from "vitest";
import {
  cohortKeyFor,
  cumulativeRevenueCents,
  effectiveCancelledAt,
  ltvCell,
  monthOffset,
  retentionCell,
  subscribersCell,
  withOriginPayment,
} from "~/services/analytics/cohorts.server";
import type {
  CohortKeyInput,
  CohortMember,
} from "~/services/analytics/cohorts.server";
import { parseAcquisitionAttributes } from "~/services/core/pure";

const DAY_MS = 86_400_000;
const ANCHOR = new Date(Date.UTC(2026, 0, 15)); // 15 Jan 2026
const NOW = new Date(Date.UTC(2026, 7, 1)); // 1 Aug 2026 → month offset 6

function input(acquisitionJson: string | null): CohortKeyInput {
  return {
    createdAt: ANCHOR,
    acquisitionJson,
    deliveryAddressJson: null,
    widgetVersion: null,
    initialDiscountPercent: null,
    firstOrderAovCents: null,
    intervalWeeks: 4,
    contributionFraction: 0.6,
    lines: [],
  };
}

function member(overrides: Partial<CohortMember> = {}): CohortMember {
  return {
    createdAt: ANCHOR,
    cancelledAt: null,
    mergedAt: null,
    contributionFraction: 0.6,
    payments: [],
    ...overrides,
  };
}

describe("cohortKeyFor — nested writer shape (parseAcquisitionAttributes)", () => {
  const acquisition = parseAcquisitionAttributes([
    { key: "utm_source", value: "klaviyo" },
    { key: "utm_campaign", value: "spring" },
    { key: "_cellexia_landing_page", value: "/pages/x" },
  ]);
  const c = input(JSON.stringify(acquisition));

  it("resolves acquisitionChannel from utm.utm_source", () => {
    expect(cohortKeyFor("acquisitionChannel", c)).toBe("klaviyo");
  });

  it("resolves campaign from utm.utm_campaign", () => {
    expect(cohortKeyFor("campaign", c)).toBe("spring");
  });

  it("resolves landingPage from custom._cellexia_landing_page", () => {
    expect(cohortKeyFor("landingPage", c)).toBe("/pages/x");
  });
});

describe("cohortKeyFor — flat shape (legacy/seed data)", () => {
  const c = input(
    JSON.stringify({
      channel: "meta-ads",
      landingPage: "/pages/firmness-study",
      campaign: "spring-firmness",
      device: "mobile",
    }),
  );

  it("keeps resolving top-level keys", () => {
    expect(cohortKeyFor("acquisitionChannel", c)).toBe("meta-ads");
    expect(cohortKeyFor("landingPage", c)).toBe("/pages/firmness-study");
    expect(cohortKeyFor("campaign", c)).toBe("spring-firmness");
    expect(cohortKeyFor("device", c)).toBe("mobile");
  });

  it("falls back to unknown/none when acquisitionJson is absent", () => {
    const empty = input(null);
    expect(cohortKeyFor("acquisitionChannel", empty)).toBe("unknown");
    expect(cohortKeyFor("advertorial", empty)).toBe("none");
  });
});

describe("cohortKeyFor — initialQuantity reads the acquisition attribute", () => {
  it("resolves the webhook writer's string _cellexia_initial_quantity", () => {
    const acquisition = parseAcquisitionAttributes([
      { key: "_cellexia_initial_quantity", value: "2" },
    ]);
    const c = {
      ...input(JSON.stringify(acquisition)),
      // Current lines say 3 units — the acquisition attribute must win.
      lines: [
        { title: "Serum", quantity: 3, sellingPlanName: null, createdAt: ANCHOR },
      ],
    };
    // Bug: string values failed the typeof === "number" check, so the
    // current-lines fallback produced "3". Correct: "2".
    expect(cohortKeyFor("initialQuantity", c)).not.toBe("3");
    expect(cohortKeyFor("initialQuantity", c)).toBe("2");
  });

  it("bands 4-and-up as 4+", () => {
    const acquisition = parseAcquisitionAttributes([
      { key: "_cellexia_initial_quantity", value: "5" },
    ]);
    expect(
      cohortKeyFor("initialQuantity", input(JSON.stringify(acquisition))),
    ).toBe("4+");
  });

  it("falls back to INITIAL lines only, ignoring later additions", () => {
    const c = {
      ...input(null),
      lines: [
        { title: "Serum", quantity: 1, sellingPlanName: null, createdAt: ANCHOR },
        {
          title: "Cream",
          quantity: 1,
          sellingPlanName: null,
          // Added by CS/autopilot in month 3 — must not move the cohort.
          createdAt: new Date(ANCHOR.getTime() + 90 * DAY_MS),
        },
      ],
    };
    // Bug: current-lines sum cohorted this contract as "2". Correct: "1".
    expect(cohortKeyFor("initialQuantity", c)).not.toBe("2");
    expect(cohortKeyFor("initialQuantity", c)).toBe("1");
  });

  it("windows the initial lines relative to the earliest LINE (imports)", () => {
    const importedAt = new Date(ANCHOR.getTime() + 200 * DAY_MS);
    const c = {
      ...input(null),
      lines: [
        { title: "A", quantity: 2, sellingPlanName: null, createdAt: importedAt },
        {
          title: "B",
          quantity: 1,
          sellingPlanName: null,
          createdAt: new Date(importedAt.getTime() + 3600_000),
        },
      ],
    };
    expect(cohortKeyFor("initialQuantity", c)).toBe("3");
  });
});

describe("cohortKeyFor — newVsReturning accepts the writer's string values", () => {
  it("maps _cellexia_returning 'true' to returning", () => {
    const acquisition = parseAcquisitionAttributes([
      { key: "_cellexia_returning", value: "true" },
    ]);
    const c = input(JSON.stringify(acquisition));
    // Bug: string values failed the typeof === "boolean" check and every
    // webhook-written contract collapsed into "unknown".
    expect(cohortKeyFor("newVsReturning", c)).not.toBe("unknown");
    expect(cohortKeyFor("newVsReturning", c)).toBe("returning");
  });

  it("maps _cellexia_returning 'false' to new", () => {
    const acquisition = parseAcquisitionAttributes([
      { key: "_cellexia_returning", value: "false" },
    ]);
    expect(cohortKeyFor("newVsReturning", input(JSON.stringify(acquisition)))).toBe(
      "new",
    );
  });

  it("normalises other string spellings and never leaks raw labels", () => {
    for (const [value, expected] of [
      ["1", "returning"],
      ["yes", "returning"],
      ["RETURNING", "returning"],
      ["0", "new"],
      ["no", "new"],
      ["New", "new"],
    ] as const) {
      expect(
        cohortKeyFor("newVsReturning", input(JSON.stringify({ returning: value }))),
      ).toBe(expected);
    }
  });

  it("still honours literal booleans from seeded data", () => {
    expect(
      cohortKeyFor("newVsReturning", input(JSON.stringify({ returning: true }))),
    ).toBe("returning");
  });
});

describe("effectiveCancelledAt — terminal statuses without a stamp", () => {
  const updatedAt = new Date(Date.UTC(2026, 5, 1));

  it("falls back to updatedAt for webhook-synced terminal statuses", () => {
    for (const status of ["CANCELLED", "EXPIRED", "FAILED"]) {
      expect(
        effectiveCancelledAt({ status, cancelledAt: null, updatedAt }),
      ).toEqual(updatedAt);
    }
  });

  it("returns null for live statuses", () => {
    for (const status of ["ACTIVE", "PAUSED"]) {
      expect(
        effectiveCancelledAt({ status, cancelledAt: null, updatedAt }),
      ).toBeNull();
    }
  });

  it("prefers the app-stamped cancelledAt when present", () => {
    const stamped = new Date(Date.UTC(2026, 2, 10));
    expect(
      effectiveCancelledAt({ status: "CANCELLED", cancelledAt: stamped, updatedAt }),
    ).toEqual(stamped);
  });
});

describe("retention respects terminal statuses (via effective churn dates)", () => {
  // 10 members; 4 were cancelled in the Shopify admin (status CANCELLED,
  // cancelledAt never stamped, updatedAt = the terminal sync ~70 days in).
  const cancelledVia = new Date(ANCHOR.getTime() + 70 * DAY_MS); // month 2
  const members: CohortMember[] = [
    ...Array.from({ length: 6 }, () => member()),
    ...Array.from({ length: 4 }, () =>
      member({
        cancelledAt: effectiveCancelledAt({
          status: "CANCELLED",
          cancelledAt: null,
          updatedAt: cancelledVia,
        }),
      }),
    ),
  ];

  it("counts webhook-cancelled members as churned at their exit month", () => {
    // Bug: status was ignored and cancelledAt stayed null, so M5 retention
    // read 1.0. Correct: 6 of 10 remain.
    expect(retentionCell(members, 5, NOW)).not.toBe(1);
    expect(retentionCell(members, 5, NOW)).toBeCloseTo(0.6, 10);
    expect(subscribersCell(members, 5, NOW)).toBe(6);
  });

  it("still counts them as retained before their exit month", () => {
    expect(retentionCell(members, 1, NOW)).toBe(1);
  });

  it("returns null when nobody is observable yet", () => {
    expect(retentionCell(members, 11, NOW)).toBeNull();
  });
});

describe("MERGED members are censored, not churned", () => {
  const mergeDate = new Date(ANCHOR.getTime() + 100 * DAY_MS); // month 3
  const members: CohortMember[] = [
    member(),
    member({ cancelledAt: mergeDate, mergedAt: mergeDate }),
  ];

  it("keeps merged members as survivors before the merge month", () => {
    expect(retentionCell(members, 2, NOW)).toBe(1);
    expect(subscribersCell(members, 2, NOW)).toBe(2);
  });

  it("removes merged members from the risk set from the merge month on", () => {
    // Bug (old behaviour): the merged member read as a cancellation → 0.5.
    expect(retentionCell(members, 3, NOW)).not.toBe(0.5);
    expect(retentionCell(members, 3, NOW)).toBe(1);
    expect(subscribersCell(members, 3, NOW)).toBe(1);
  });
});

describe("withOriginPayment — cycle-0 first order in LTV math", () => {
  it("prepends the origin order when no payment sits at the anchor", () => {
    const rebill = {
      amountCents: 8000,
      occurredAt: new Date(ANCHOR.getTime() + 42 * DAY_MS),
    };
    const payments = withOriginPayment([rebill], ANCHOR, 10000);
    expect(payments).toHaveLength(2);
    expect(payments[0]).toEqual({ amountCents: 10000, occurredAt: ANCHOR });
  });

  it("does not double-count a recorded cycle-0 payment (seeded data)", () => {
    const seeded = { amountCents: 10000, occurredAt: ANCHOR };
    expect(withOriginPayment([seeded], ANCHOR, 10000)).toHaveLength(1);
  });

  it("is a no-op without a stamped first-order AOV", () => {
    expect(withOriginPayment([], ANCHOR, null)).toHaveLength(0);
  });

  it("puts M0 LTV at one AOV instead of the buggy 0", () => {
    // Bug: payments were rebill BillingAttempts only, so with a 6-week
    // cadence M0 LTV read 0 for every cohort.
    const bare = member(); // rebill-only view of the same contract
    expect(ltvCell([bare], 0, NOW, false)).toBe(0); // the wrong number
    const fixed = member({ payments: withOriginPayment([], ANCHOR, 10000) });
    expect(ltvCell([fixed], 0, NOW, false)).toBe(10000);
    expect(cumulativeRevenueCents(fixed, 11)).toBe(10000);
  });

  it("applies the contribution fraction to origin + rebills", () => {
    const m = member({
      contributionFraction: 0.5,
      payments: withOriginPayment(
        [
          {
            amountCents: 8000,
            occurredAt: new Date(ANCHOR.getTime() + 42 * DAY_MS),
          },
        ],
        ANCHOR,
        10000,
      ),
    });
    // Through month 1 (42 days = offset 1): (10000 + 8000) × 0.5.
    expect(monthOffset(ANCHOR, new Date(ANCHOR.getTime() + 42 * DAY_MS))).toBe(1);
    expect(ltvCell([m], 1, NOW, true)).toBe(9000);
  });
});
