import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SWALLOWED EVENT WRITE MUST NEVER BE INVISIBLE — logEvent, evaluated.
 *
 * logEvent's never-throw contract (an analytics write must never break a
 * billing operation) means a failed SubscriberEvent insert is a PERMANENT
 * loss: the surrounding webhook handler still reports success, the receipt is
 * stamped PROCESSED, and Shopify's retry train ends — while several numbers
 * (refundedCents, takeRateDen, skips/saves) and guards (winback/lifecycle
 * dedupe, stockout delay cap, portal rate limit) have the event log as their
 * ONLY source. These tests pin the three-part fix:
 *  - every swallowed failure is counted in-process
 *    (getEventWriteFailureStats feeds the EVENT_WRITE_FAILURES alert);
 *  - `logEvent(input, { tx })` rides the caller's transaction, so a marker
 *    event can commit atomically with the mutation it records;
 *  - `logEventOrThrow` propagates the insert failure (the discounts-marker
 *    need) and only enqueues Klaviyo AFTER a successful insert — the outbox
 *    can never receive an event the local audit log refused.
 */

const mocks = vi.hoisted(() => ({
  eventCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({
    id: "evt_1",
  })),
  enqueueKlaviyoForEvent: vi.fn(async (): Promise<void> => {}),
}));

vi.mock("~/db.server", () => ({
  default: { subscriberEvent: { create: mocks.eventCreate } },
}));

vi.mock("~/lib/klaviyo/events-map.server", () => ({
  enqueueKlaviyoForEvent: mocks.enqueueKlaviyoForEvent,
}));

import {
  getEventWriteFailureStats,
  logEvent,
  logEventOrThrow,
  type LogEventInput,
} from "~/lib/events/log.server";

const INPUT: LogEventInput = {
  shopId: "shop_1",
  type: "cycle.skipped",
  source: "CUSTOMER_PORTAL",
  contractId: "contract_1",
  payload: { reason: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.eventCreate.mockResolvedValue({ id: "evt_1" });
});

describe("logEvent", () => {
  it("writes the event with defaulted nullables and forwards to Klaviyo", async () => {
    await logEvent(INPUT);

    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);
    const args = mocks.eventCreate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(args.data).toMatchObject({
      shopId: "shop_1",
      contractId: "contract_1",
      customerId: null,
      email: null,
      type: "cycle.skipped",
      source: "CUSTOMER_PORTAL",
      actor: null,
      payload: { reason: "test" },
    });
    expect(mocks.enqueueKlaviyoForEvent).toHaveBeenCalledWith(INPUT);
  });

  it("uses the caller's transaction client for the insert when tx is provided", async () => {
    const txCreate = vi.fn(async () => ({ id: "evt_tx" }));
    const tx = { subscriberEvent: { create: txCreate } };

    await logEvent(INPUT, { tx: tx as never });

    // The insert rode the transaction — NOT the global client — so the event
    // commits or rolls back with the mutation it records.
    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(mocks.eventCreate).not.toHaveBeenCalled();
    // Klaviyo still enqueued after, outside the transaction, best-effort.
    expect(mocks.enqueueKlaviyoForEvent).toHaveBeenCalledTimes(1);
  });

  it("swallows an insert failure, counts it, and records the lost type", async () => {
    const before = getEventWriteFailureStats();
    mocks.eventCreate.mockRejectedValue(new Error("db down"));

    await expect(logEvent(INPUT)).resolves.toBeUndefined();

    const after = getEventWriteFailureStats();
    expect(after.count).toBe(before.count + 1);
    expect(after.lastType).toBe("cycle.skipped");
    expect(after.lastAt).toBeInstanceOf(Date);
    // The restart marker is stable for the life of the process — the alert
    // check uses it to tell "counter reset by restart" from "recovered".
    expect(after.processStartedAt).toBe(before.processStartedAt);
  });

  it("still enqueues Klaviyo after a swallowed insert failure (the documented pre-existing hazard, pinned)", async () => {
    mocks.eventCreate.mockRejectedValue(new Error("db down"));

    await logEvent(INPUT);

    // logEvent's contract keeps the enqueue best-effort and independent;
    // callers that must never let Klaviyo outrun the local audit log use
    // logEventOrThrow instead (asserted below).
    expect(mocks.enqueueKlaviyoForEvent).toHaveBeenCalledTimes(1);
  });

  it("a swallowed Klaviyo enqueue failure never surfaces and is NOT counted as an event-write loss", async () => {
    const before = getEventWriteFailureStats();
    mocks.enqueueKlaviyoForEvent.mockRejectedValue(new Error("klaviyo down"));

    await expect(logEvent(INPUT)).resolves.toBeUndefined();

    expect(getEventWriteFailureStats().count).toBe(before.count);
  });
});

describe("logEventOrThrow", () => {
  it("writes and forwards like logEvent on success", async () => {
    await logEventOrThrow(INPUT);

    expect(mocks.eventCreate).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueKlaviyoForEvent).toHaveBeenCalledTimes(1);
  });

  it("propagates the insert failure, skips Klaviyo, and does NOT count a swallowed loss", async () => {
    const before = getEventWriteFailureStats();
    mocks.eventCreate.mockRejectedValue(new Error("unique violation"));

    await expect(logEventOrThrow(INPUT)).rejects.toThrow("unique violation");

    // The caller saw the failure and owns the recovery — nothing was
    // swallowed, so the loss counter must not move.
    expect(getEventWriteFailureStats().count).toBe(before.count);
    // Audit-log-before-Klaviyo: the outbox never receives an event the local
    // log refused.
    expect(mocks.enqueueKlaviyoForEvent).not.toHaveBeenCalled();
  });

  it("rides the caller's transaction when tx is provided", async () => {
    const txCreate = vi.fn(async () => ({ id: "evt_tx" }));
    const tx = { subscriberEvent: { create: txCreate } };

    await logEventOrThrow(INPUT, { tx: tx as never });

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(mocks.eventCreate).not.toHaveBeenCalled();
  });
});

describe("getEventWriteFailureStats", () => {
  it("returns a snapshot, not the live counter (callers cannot corrupt it)", async () => {
    const snapshot = getEventWriteFailureStats();
    snapshot.count += 100;

    expect(getEventWriteFailureStats().count).not.toBe(snapshot.count);
  });
});
