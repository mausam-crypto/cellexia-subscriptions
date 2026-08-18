import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromZonedTime } from "date-fns-tz";

/**
 * sendNextOrderTomorrow (v1.28.0, P2.7 — the run-out "I'm already out"
 * branch):
 *
 *  - moves Shopify's nextBillingDate to TOMORROW's shop-tz day start through
 *    the same setNextBillingDate primitive (Shopify + mirror agree), never
 *    "now";
 *  - logs contract.next_date_changed { reason: "send_tomorrow", previous… }
 *    (Undo can restore the previous date) and cycle.rushed { from, to };
 *  - refuses (typed SendTomorrowError) when not ACTIVE, when the billing day
 *    is being prepared (isPreparingOrder), when an open dunning case owns the
 *    cycle, or when the next date is already tomorrow or earlier — with no
 *    Shopify call and no event in every refusal.
 *
 * Scaffold: tests/contracts-pause-until.test.ts.
 */

const TZ = "Europe/Zurich";
const CONTRACT_GID = "gid://shopify/SubscriptionContract/901";
const NOW = new Date("2026-08-17T08:00:00.000Z"); // 10:00 Zurich
const ZURICH_DAY = (ymd: string) => fromZonedTime(`${ymd}T00:00:00`, TZ);
const TOMORROW = ZURICH_DAY("2026-08-18");

const store = vi.hoisted(() => ({
  contract: {} as Record<string, unknown> & { lines: unknown[] },
  attempts: [] as Array<Record<string, unknown>>,
  openCase: null as Record<string, unknown> | null,
}));

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(async (_e: unknown): Promise<void> => {}),
  setNextBillingDate: vi.fn(
    async (_a: unknown, _g: string, date: Date): Promise<unknown> => ({
      nextBillingDate: date,
    }),
  ),
  contractUpdate: vi.fn(
    async (args: { data: Record<string, unknown> }): Promise<unknown> => {
      Object.assign(store.contract, args.data);
      return store.contract;
    },
  ),
  attemptFindMany: vi.fn(async (): Promise<unknown[]> => store.attempts),
  dunningFindFirst: vi.fn(async (): Promise<unknown> => store.openCase),
}));

vi.mock("~/db.server", () => ({
  default: {
    subscriptionContract: {
      findUnique: vi.fn(async (): Promise<unknown> => store.contract),
      findUniqueOrThrow: vi.fn(async (): Promise<unknown> => store.contract),
      update: mocks.contractUpdate,
    },
    billingAttempt: { findMany: mocks.attemptFindMany },
    dunningCase: { findFirst: mocks.dunningFindFirst },
    contractLine: {
      updateMany: vi.fn(async (): Promise<unknown> => ({ count: 0 })),
    },
    shop: {
      findUnique: vi.fn(async (): Promise<unknown> => ({ ianaTimezone: TZ })),
    },
  },
}));
vi.mock("~/shopify.server", () => ({
  adminClientForShop: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("~/lib/shop/install.server", () => ({
  requireShop: vi.fn(async (): Promise<unknown> => ({
    id: "shop_1",
    domain: "cellexia.myshopify.com",
    ianaTimezone: TZ,
  })),
}));
vi.mock("~/lib/events/log.server", () => ({ logEvent: mocks.logEvent }));
vi.mock("~/lib/settings/settings.server", () => ({
  getSetting: vi.fn(async (_shopId: string, key: string): Promise<unknown> => {
    if (key === "billing") return { chargeHourLocal: 0, preparingWindowHours: 6 };
    if (key === "pause") return { maxMonths: 3 };
    return {};
  }),
}));
vi.mock("~/lib/billing/stacking.server", () => ({
  clampGrantPercentForContract: vi.fn(async (): Promise<unknown> => ({
    percent: 0,
    clamped: false,
  })),
}));
vi.mock("~/lib/billing/release.server", () => ({
  releaseHeldCycleAttempts: vi.fn(async (): Promise<number> => 0),
}));
vi.mock("~/lib/dunning/engine.server", () => ({
  onCycleSkipped: vi.fn(async (): Promise<boolean> => false),
  onCycleDelayed: vi.fn(async (): Promise<boolean> => false),
  onPaymentMethodUpdated: vi.fn(async (): Promise<void> => {}),
}));
vi.mock("~/lib/graphql/index.server", () => {
  class ShopifyUserError extends Error {}
  return {
    ShopifyUserError,
    contractActivate: vi.fn(),
    contractCancel: vi.fn(),
    contractPause: vi.fn(),
    draftLineAdd: vi.fn(),
    draftLineRemove: vi.fn(),
    draftLineUpdate: vi.fn(),
    draftLines: vi.fn(),
    draftUpdateAddress: vi.fn(),
    draftUpdateBillingPolicy: vi.fn(),
    draftUpdateDeliveryPolicy: vi.fn(),
    draftUpdateNote: vi.fn(),
    draftUpdatePaymentMethod: vi.fn(),
    getBillingCycleByDate: vi.fn(async (): Promise<unknown> => null),
    getContract: vi.fn(),
    getVariants: vi.fn(),
    listCustomerPaymentMethods: vi.fn(),
    scheduleEditBillingCycle: vi.fn(),
    setNextBillingDate: mocks.setNextBillingDate,
    skipBillingCycle: vi.fn(),
    unskipBillingCycle: vi.fn(),
    withBillingCycleEdit: vi.fn(),
    withContractDraft: vi.fn(),
  };
});

import {
  SendTomorrowError,
  sendNextOrderTomorrow,
} from "~/lib/contracts/service.server";

function baseContract(over: Record<string, unknown> = {}) {
  return {
    id: "c_1",
    shopId: "shop_1",
    shopifyContractId: CONTRACT_GID,
    ownership: "OURS",
    isDemo: false,
    status: "ACTIVE",
    customerId: "gid://shopify/Customer/5",
    email: "sub@example.com",
    intervalWeeks: 4,
    nextBillingDate: ZURICH_DAY("2026-09-01"),
    lines: [],
    ...over,
  };
}

function eventsOfType(type: string) {
  return mocks.logEvent.mock.calls
    .map((c) => c[0] as { type: string; source?: string; payload: Record<string, unknown> })
    .filter((e) => e.type === type);
}

async function refusal(): Promise<SendTomorrowError> {
  const err = await sendNextOrderTomorrow(
    "cellexia.myshopify.com",
    "c_1",
    { source: "CUSTOMER_PORTAL", actor: "customer" },
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SendTomorrowError);
  return err as SendTomorrowError;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  store.contract = baseContract();
  store.attempts = [];
  store.openCase = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sendNextOrderTomorrow", () => {
  it("moves Shopify's nextBillingDate to tomorrow's shop-day start via the setNextBillingDate primitive, mirrors it, and logs next_date_changed(send_tomorrow) + cycle.rushed", async () => {
    const previous = ZURICH_DAY("2026-09-01");
    const updated = await sendNextOrderTomorrow("cellexia.myshopify.com", "c_1", {
      source: "CUSTOMER_PORTAL",
      actor: "customer",
    });
    expect(mocks.setNextBillingDate).toHaveBeenCalledWith({}, CONTRACT_GID, TOMORROW);
    // Never "now" — the sweep bills at tomorrow's charge moment.
    expect(TOMORROW.getTime()).toBeGreaterThan(NOW.getTime());
    expect((updated as { nextBillingDate: Date }).nextBillingDate).toEqual(TOMORROW);

    const [changed] = eventsOfType("contract.next_date_changed");
    expect(changed.source).toBe("CUSTOMER_PORTAL");
    expect(changed.payload).toEqual({
      reason: "send_tomorrow",
      previousNextBillingDate: previous.toISOString(),
      nextBillingDate: TOMORROW.toISOString(),
    });
    const [rushed] = eventsOfType("cycle.rushed");
    expect(rushed.payload).toEqual({
      from: previous.toISOString(),
      to: TOMORROW.toISOString(),
    });
  });

  it("uses Shopify's effective date when it differs from the request (mirror never lies)", async () => {
    const effective = new Date("2026-08-18T05:00:00.000Z");
    mocks.setNextBillingDate.mockResolvedValueOnce({ nextBillingDate: effective });
    await sendNextOrderTomorrow("cellexia.myshopify.com", "c_1");
    expect(store.contract.nextBillingDate).toEqual(effective);
    expect(eventsOfType("cycle.rushed")[0].payload.to).toBe(effective.toISOString());
  });

  it("refuses when the contract is not ACTIVE (NOT_ACTIVE) — no Shopify call, no event", async () => {
    store.contract = baseContract({ status: "PAUSED" });
    expect((await refusal()).code).toBe("NOT_ACTIVE");
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it("refuses when the next date is already tomorrow or earlier (ALREADY_SOON) — nothing to pull", async () => {
    store.contract = baseContract({ nextBillingDate: TOMORROW });
    expect((await refusal()).code).toBe("ALREADY_SOON");
    store.contract = baseContract({ nextBillingDate: ZURICH_DAY("2026-08-17") });
    expect((await refusal()).code).toBe("ALREADY_SOON");
    // The day AFTER tomorrow is still worth pulling.
    store.contract = baseContract({ nextBillingDate: ZURICH_DAY("2026-08-19") });
    await expect(
      sendNextOrderTomorrow("cellexia.myshopify.com", "c_1"),
    ).resolves.toBeTruthy();
  });

  it("refuses while the order is being prepared (a PENDING attempt in flight — isPreparingOrder)", async () => {
    store.contract = baseContract({ nextBillingDate: ZURICH_DAY("2026-08-25") });
    store.attempts = [
      {
        status: "PENDING",
        originatingAction: "SCHEDULER",
        startedAt: NOW,
        scheduledFor: NOW,
        supersededAt: null,
      },
    ];
    expect((await refusal()).code).toBe("PREPARING");
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
  });

  it("refuses while an open dunning case owns the cycle (PAYMENT_ISSUE)", async () => {
    store.openCase = { id: "case_1" };
    expect((await refusal()).code).toBe("PAYMENT_ISSUE");
    expect(mocks.dunningFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          contractId: "c_1",
          state: { in: ["OPEN", "RETRYING", "AWAITING_CUSTOMER", "AWAITING_3DS"] },
        }),
      }),
    );
    expect(mocks.setNextBillingDate).not.toHaveBeenCalled();
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});
