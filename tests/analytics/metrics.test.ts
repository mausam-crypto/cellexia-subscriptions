/**
 * Regression tests for the executive-metric formulas fixed in the V2 pass
 * (app/services/analytics/metrics.server.ts) and the isRetry semantics behind
 * paymentRecoveryRate (app/services/core/billing.server.ts).
 *
 * Prisma is mocked at the module boundary (~/db.server) so every formula is
 * exercised through the real getExecutiveMetrics computation. Each test notes
 * the WRONG number the original bug produced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Prisma mock ─────────────────────────────────────────────────────────────

interface MockState {
  settings: { currencyCode: string; settingsJson: string } | null;
  contracts: Array<Record<string, unknown>>;
  metas: Array<Record<string, unknown>>;
  eventCounts: Array<{ name: string; _count: { _all: number } }>;
  widgetRows: Array<{ id: string; name: string; payloadJson: string }>;
  attempts: Array<{ status: string; isRetry: boolean; amountCents: number | null }>;
  successAttemptsToDate: number;
  lifetimeSuccessAttempt: { id: string } | null;
}

const state = vi.hoisted<{ db: MockState }>(() => ({
  db: {
    settings: null,
    contracts: [],
    metas: [],
    eventCounts: [],
    widgetRows: [],
    attempts: [],
    successAttemptsToDate: 0,
    lifetimeSuccessAttempt: null,
  },
}));

vi.mock("~/db.server", () => ({
  default: {
    shopSettings: {
      findUnique: vi.fn(async () => state.db.settings),
    },
    subscriptionContract: {
      findMany: vi.fn(async () => state.db.contracts),
    },
    productMeta: {
      findMany: vi.fn(async () => state.db.metas),
    },
    analyticsEvent: {
      groupBy: vi.fn(async () => state.db.eventCounts),
      findMany: vi.fn(async () => state.db.widgetRows),
    },
    billingAttempt: {
      findMany: vi.fn(async () => state.db.attempts),
      count: vi.fn(async () => state.db.successAttemptsToDate),
      findFirst: vi.fn(async () => state.db.lifetimeSuccessAttempt),
    },
  },
}));

// billing.server imports shopifyClient.server → shopify.server, whose
// PrismaSessionStorage constructor validates a session table the db mock
// doesn't have — stub the whole module (pattern from tests/portal/auth.test.ts).
vi.mock("~/shopify.server", () => ({
  default: {},
  authenticate: {},
  unauthenticated: {},
  apiVersion: "2025-01",
}));

import { getExecutiveMetrics } from "~/services/analytics/metrics.server";
import { isRetryAfter } from "~/services/core/billing.server";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FROM = new Date(Date.UTC(2026, 6, 1));
const TO = new Date(Date.UTC(2026, 6, 31));
const OLD = new Date(Date.UTC(2026, 0, 10));
const MID_RANGE = new Date(Date.UTC(2026, 6, 15));

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "c1",
    status: "ACTIVE",
    createdAt: OLD,
    cancelledAt: null,
    cancelReason: null,
    successfulOrders: 0,
    totalRevenueCents: 0,
    currencyCode: "EUR",
    dunningState: null,
    lines: [],
    ...overrides,
  };
}

function configuredSettings(): { currencyCode: string; settingsJson: string } {
  return {
    currencyCode: "EUR",
    settingsJson: JSON.stringify({
      costModel: {
        defaultGrossMarginPercent: 70,
        shippingPerDeliveryCents: 200,
        fulfillmentPerDeliveryCents: 100,
        paymentFeePercent: 2,
        paymentFeeFixedCents: 30,
      },
    }),
  };
}

beforeEach(() => {
  state.db.settings = null;
  state.db.contracts = [];
  state.db.metas = [];
  state.db.eventCounts = [];
  state.db.widgetRows = [];
  state.db.attempts = [];
  state.db.successAttemptsToDate = 0;
  state.db.lifetimeSuccessAttempt = null;
});

const run = () => getExecutiveMetrics("shop.example.com", { from: FROM, to: TO });

// ── isRetry semantics (billing.server.ts) ───────────────────────────────────

describe("isRetryAfter — retry means the previous charge of the cycle failed", () => {
  it("a prior SUCCESS makes the next attempt a routine renewal, NOT a retry", () => {
    // Old bug: isRetry = priorAttempts > 0 flagged every 2nd+ routine renewal
    // as a recovered retry, so paymentRecoveryRate displayed thousands of %.
    expect(isRetryAfter({ status: "SUCCESS" })).toBe(false);
  });

  it("a prior FAILURE or CHALLENGED makes the new attempt a retry", () => {
    expect(isRetryAfter({ status: "FAILURE" })).toBe(true);
    expect(isRetryAfter({ status: "CHALLENGED" })).toBe(true);
  });

  it("the contract's first-ever attempt is never a retry", () => {
    expect(isRetryAfter(null)).toBe(false);
    expect(isRetryAfter(undefined)).toBe(false);
  });

  it("a prior PENDING attempt does not mark a retry", () => {
    expect(isRetryAfter({ status: "PENDING" })).toBe(false);
  });
});

// ── paymentRecoveryRate cap ─────────────────────────────────────────────────

describe("paymentRecoveryRate — capped at 1 (defense-in-depth)", () => {
  it("legacy over-flagged isRetry rows can no longer push the rate past 100%", async () => {
    state.db.attempts = [
      ...Array.from({ length: 140 }, () => ({
        status: "SUCCESS",
        isRetry: true, // historical rows still carry the wrong flag
        amountCents: 9600,
      })),
      ...Array.from({ length: 6 }, () => ({
        status: "FAILURE",
        isRetry: false,
        amountCents: null,
      })),
    ];
    const metrics = await run();
    // Old code returned the raw ratio — 140/6 ≈ 23.33, rendered as "2333.3%".
    expect(140 / 6).toBeGreaterThan(1);
    expect(metrics.paymentRecoveryRate).toBe(1);
    expect(metrics.counts.retriesRecovered).toBe(140);
    expect(metrics.counts.chargesFailed).toBe(6);
  });

  it("a genuine recovery ratio below 1 passes through unchanged", async () => {
    state.db.attempts = [
      ...Array.from({ length: 4 }, () => ({
        status: "SUCCESS",
        isRetry: true,
        amountCents: 9600,
      })),
      ...Array.from({ length: 6 }, () => ({
        status: "FAILURE",
        isRetry: false,
        amountCents: null,
      })),
    ];
    const metrics = await run();
    expect(metrics.paymentRecoveryRate).toBeCloseTo(4 / 6, 10);
  });
});

// ── reactivationRate ────────────────────────────────────────────────────────

describe("reactivationRate — counts PAUSE_ENDED (actual resumes)", () => {
  it("uses PAUSE_ENDED, not the PAUSE_ENDING reminder trigger", async () => {
    state.db.eventCounts = [
      { name: "PAUSE_STARTED", _count: { _all: 4 } },
      { name: "PAUSE_ENDED", _count: { _all: 3 } },
      // Legacy reminder event — must NOT be what the metric counts.
      { name: "PAUSE_ENDING", _count: { _all: 5 } },
    ];
    const metrics = await run();
    // Old code: countOf("PAUSE_ENDING") — permanently 0 in production (never
    // emitted), and even if emitted it counted reminders, not resumes.
    expect(metrics.reactivationRate).toBeCloseTo(3 / 4, 10);
    expect(metrics.counts.pausesEnded).toBe(3);
    expect(metrics.counts.pausesStarted).toBe(4);
  });

  it("is 0, not NaN, when nobody paused", async () => {
    const metrics = await run();
    expect(metrics.reactivationRate).toBe(0);
  });
});

// ── widget rates from full-range aggregates ─────────────────────────────────

describe("widget rates — computed from the unbounded groupBy, not a 50k sample", () => {
  it("derives impressions/conversions from event-name counts", async () => {
    state.db.eventCounts = [
      { name: "WIDGET_A_IMPRESSION", _count: { _all: 80000 } },
      { name: "WIDGET_A_CONVERSION", _count: { _all: 4000 } },
      { name: "CHARGE_COMPLETED", _count: { _all: 9 } }, // non-widget: ignored
    ];
    // The row fetch returns only a tiny biased subset — under the old
    // take:50000 sampling this could render anywhere from ~0% to far above
    // the true 5%. The rate must ignore it entirely.
    state.db.widgetRows = [
      { id: "e1", name: "WIDGET_A_IMPRESSION", payloadJson: "{}" },
      { id: "e2", name: "WIDGET_A_IMPRESSION", payloadJson: "{}" },
      { id: "e3", name: "WIDGET_A_CONVERSION", payloadJson: "{}" },
    ];
    const metrics = await run();
    expect(metrics.counts.widgetImpressions).toBe(80000);
    expect(metrics.counts.widgetConversions).toBe(4000);
    expect(metrics.widgetConversionRate).toBeCloseTo(0.05, 10);
  });

  it("still reads payloads for attach/one-time splits", async () => {
    state.db.eventCounts = [
      { name: "WIDGET_A_CONVERSION", _count: { _all: 2 } },
      { name: "WIDGET_B_IMPRESSION", _count: { _all: 1 } },
    ];
    state.db.widgetRows = [
      {
        id: "e1",
        name: "WIDGET_A_CONVERSION",
        payloadJson: JSON.stringify({ sellingPlanId: "sp1" }),
      },
      { id: "e2", name: "WIDGET_A_CONVERSION", payloadJson: "{}" },
      {
        id: "e3",
        name: "WIDGET_B_IMPRESSION",
        payloadJson: JSON.stringify({ widgetType: "POST_ONE_TIME" }),
      },
    ];
    const metrics = await run();
    expect(metrics.attachRate).toBeCloseTo(1 / 2, 10);
    expect(metrics.oneTimeToSubscriptionRate).toBe(0); // 0 POST_ONE_TIME conversions / 1 impression
  });
});

// ── subscriberAovCents fallback gating ──────────────────────────────────────

describe("subscriberAovCents — plan-value fallback only before ANY billing history", () => {
  const activeContract = () =>
    contract({
      lines: [
        { shopifyProductId: "p1", quantity: 1, currentPriceCents: 12000 },
      ],
    });

  it("shows 0 for an off-billing range when lifetime history exists", async () => {
    state.db.contracts = [activeContract()];
    state.db.lifetimeSuccessAttempt = { id: "b1" }; // shop HAS billed before
    const metrics = await run();
    // Old code silently switched to the undiscounted plan value (12000).
    expect(metrics.subscriberAovCents).toBe(0);
  });

  it("falls back to average plan value before any billing history exists", async () => {
    state.db.contracts = [activeContract()];
    state.db.lifetimeSuccessAttempt = null; // never billed anything
    const metrics = await run();
    expect(metrics.subscriberAovCents).toBe(12000);
  });

  it("uses real billed amounts when the range has charges", async () => {
    state.db.contracts = [activeContract()];
    state.db.attempts = [
      { status: "SUCCESS", isRetry: false, amountCents: 9600 },
      { status: "SUCCESS", isRetry: false, amountCents: 9800 },
    ];
    const metrics = await run();
    expect(metrics.subscriberAovCents).toBe(9700);
  });
});

// ── paidOrdersPerSubscriber look-ahead ──────────────────────────────────────

describe("paidOrdersPerSubscriber — as-of-`to` numerator, no look-ahead", () => {
  it("counts SUCCESS attempts occurred ≤ to, not today's lifetime counters", async () => {
    state.db.contracts = [
      contract({ id: "c1", successfulOrders: 99 }), // today's counter: ignored
      contract({ id: "c2", successfulOrders: 99 }),
    ];
    state.db.successAttemptsToDate = 6; // orders that existed by window end
    const metrics = await run();
    // Old code summed CURRENT successfulOrders (99+99)/2 = 99 — crediting the
    // previous window with orders that happened after it (fake red deltas).
    expect(metrics.paidOrdersPerSubscriber).toBe(3);
  });
});

// ── MERGED exclusion ────────────────────────────────────────────────────────

describe("netGrowth — contract merges are not churn", () => {
  it("excludes cancelReason MERGED from cancellations in range", async () => {
    state.db.contracts = [
      contract({ id: "c1" }),
      contract({
        id: "c2",
        status: "CANCELLED",
        cancelledAt: MID_RANGE,
        cancelReason: "MERGED", // consolidation — customer continues on target
      }),
      contract({
        id: "c3",
        status: "CANCELLED",
        cancelledAt: MID_RANGE,
        cancelReason: "EXTERNAL", // real churn (Shopify-admin cancel)
      }),
    ];
    const metrics = await run();
    // Old code counted both: netGrowth −2. Only the EXTERNAL cancel is churn.
    expect(metrics.netGrowth).toBe(-1);
  });
});

// ── Cost-model wiring ───────────────────────────────────────────────────────

describe("profit metrics — every figure flows through the cost model", () => {
  it("gross profit = revenue − COGS; contribution = full LTGP formula", async () => {
    state.db.settings = configuredSettings();
    state.db.contracts = [
      contract({
        successfulOrders: 5,
        totalRevenueCents: 50000,
        lines: [
          { shopifyProductId: "p1", quantity: 1, currentPriceCents: 10000 },
        ],
      }),
    ];
    state.db.metas = [
      { shopifyProductId: "p1", grossMarginPercent: null, unitCostCents: 3000 },
    ];
    const metrics = await run();
    expect(metrics.activeSubscriptionRevenueCents).toBe(10000);
    // revenue − COGS
    expect(metrics.grossProfitCents).toBe(7000);
    expect(metrics.recurringGrossProfitCents).toBe(7000); // back-compat alias
    // 10000 − 3000 − 200 − 100 − (200 + 30)
    expect(metrics.contributionCents).toBe(6470);
    expect(metrics.costConfigured).toBe(true);
    // LTV uses the cost-model gross margin: 50000 × (10000−3000)/10000.
    expect(metrics.grossMarginLtvCents).toBe(35000);
  });

  it("flags costConfigured false (and defaults 70% margin) when never saved", async () => {
    state.db.contracts = [
      contract({
        lines: [
          { shopifyProductId: "p1", quantity: 1, currentPriceCents: 10000 },
        ],
      }),
    ];
    const metrics = await run();
    expect(metrics.costConfigured).toBe(false);
    expect(metrics.grossProfitCents).toBe(7000);
    expect(metrics.contributionCents).toBe(7000); // no configured extra costs
  });
});
