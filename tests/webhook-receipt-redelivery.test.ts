import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * Webhook receipt claim vs. crash recovery (routes/webhooks.tsx).
 *
 * Every v1.4/1.5 crash contract — finishSuccessSettlement's settledAt-NULL
 * redrive, the dunning engine's declineCategory-written-last marker and
 * lease-expiry redrive — depends on Shopify's automatic redelivery (same
 * X-Shopify-Webhook-Id, sent because a crashed process never responded)
 * REACHING the handler again. The receipt table used to claim the id as
 * terminally processed BEFORE any work: a process death mid-handler left the
 * claim committed, the retry hit the P2002 and was answered
 * SKIPPED_DUPLICATE without running anything, and the half-settled attempt
 * was orphaned forever (a paid customer could keep receiving dunning emails
 * from a case only the redelivered webhook could close).
 *
 * The contract pinned here: claimed ≠ completed. `processedAt` is the
 * completion marker; a same-id redelivery that finds the claim without the
 * marker (outside the in-flight grace window) re-runs the idempotent handler
 * — and claims the re-run ATOMICALLY (a receivedAt-refreshing updateMany), so
 * two late retries can never re-run it concurrently.
 *
 * The symmetric half: an IN-FLIGHT duplicate is answered 503, never 2xx. Any
 * 2xx permanently ends Shopify's redelivery train for that webhook id, and
 * the in-flight run may still crash — answering an inside-the-window retry
 * with 200 SKIPPED_DUPLICATE forfeited the automatic crash recovery this
 * whole design exists for (the receipt then sat stuck until the
 * WEBHOOK_FAILURES alert and a MANUAL replay). And "in-flight" is decided by
 * LIVENESS, not age: receivedAt is heartbeat-renewed while the handler runs
 * (the JobLock lease-renewal pattern), so a slow-but-alive settlement is
 * still in-flight at t+65s and a late retry cannot re-run it concurrently.
 */

vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

vi.mock("~/db.server", () => ({
  default: {
    webhookReceipt: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("~/lib/webhooks/handlers.server", () => ({
  webhookHandlers: {
    TEST_TOPIC: vi.fn(async (): Promise<void> => {}),
  },
}));

import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { webhookHandlers } from "~/lib/webhooks/handlers.server";
import { action } from "~/routes/webhooks";

const db = prisma as unknown as {
  webhookReceipt: {
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};
const webhookMock = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const handlerMock = webhookHandlers.TEST_TOPIC as unknown as ReturnType<
  typeof vi.fn
>;

const PAYLOAD = { admin_graphql_api_id: "gid://shopify/X/1" };
const PAYLOAD_HASH = createHash("sha256")
  .update(JSON.stringify(PAYLOAD))
  .digest("hex");

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`webhookId`)",
    { code: "P2002", clientVersion: "6.6.0" },
  );
}

function delivery(topic = "TEST_TOPIC") {
  webhookMock.mockResolvedValue({
    topic,
    shop: "cellexia-dev.myshopify.com",
    payload: PAYLOAD,
    webhookId: "wh_1",
  });
  return action({
    request: new Request("https://app.example/webhooks", { method: "POST" }),
  } as never);
}

/** Receipt row as the route's findUnique would return it. */
function receiptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "receipt_1",
    topic: "TEST_TOPIC",
    shopDomain: "cellexia-dev.myshopify.com",
    webhookId: "wh_1",
    payloadHash: PAYLOAD_HASH,
    status: "PROCESSED", // provisional claim value
    error: null,
    receivedAt: new Date(Date.now() - 30 * 60_000), // claimed well past grace
    processedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  handlerMock.mockResolvedValue(undefined);
  db.webhookReceipt.create.mockResolvedValue({});
  db.webhookReceipt.update.mockResolvedValue({});
  db.webhookReceipt.updateMany.mockResolvedValue({ count: 1 }); // re-claim wins
});

describe("first delivery", () => {
  it("claims the receipt, runs the handler, stamps processedAt", async () => {
    const response = await delivery();
    expect(await response.text()).toBe("PROCESSED");
    expect(response.status).toBe(200);

    expect(handlerMock).toHaveBeenCalledExactlyOnceWith({
      shopDomain: "cellexia-dev.myshopify.com",
      payload: PAYLOAD,
      webhookId: "wh_1",
    });
    // Claim happens BEFORE the handler…
    expect(db.webhookReceipt.create.mock.invocationCallOrder[0]).toBeLessThan(
      handlerMock.mock.invocationCallOrder[0],
    );
    // …and the completion marker only lands after it.
    const update = db.webhookReceipt.update.mock.calls.at(-1)![0];
    expect(update.where).toEqual({ webhookId: "wh_1" });
    expect(update.data.status).toBe("PROCESSED");
    expect(update.data.processedAt).toBeInstanceOf(Date);
  });

  it("a thrown handler records FAILED + error and still answers 200", async () => {
    handlerMock.mockRejectedValue(new Error("kaboom"));
    const response = await delivery();
    expect(await response.text()).toBe("FAILED");
    expect(response.status).toBe(200); // 5xx would get the webhook disabled

    const update = db.webhookReceipt.update.mock.calls.at(-1)![0];
    expect(update.data.status).toBe("FAILED");
    expect(String(update.data.error)).toContain("kaboom");
    // No completion marker: a same-id retry may still re-drive it.
    expect(update.data.processedAt).toBeUndefined();
  });
});

describe("redelivery against an existing claim", () => {
  it("completed receipt (processedAt set): true duplicate, handler never runs", async () => {
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(
      receiptRow({ processedAt: new Date() }),
    );

    const response = await delivery();
    expect(await response.text()).toBe("SKIPPED_DUPLICATE");
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("crash residue (claimed, processedAt NULL, past the grace window): the handler RE-RUNS — the defect this pins", async () => {
    // First delivery died mid-handler after committing the claim; Shopify
    // retries under the same webhook id. Pre-fix this returned
    // SKIPPED_DUPLICATE and the half-settled attempt was orphaned forever.
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(receiptRow());

    const response = await delivery();
    expect(await response.text()).toBe("PROCESSED");
    expect(handlerMock).toHaveBeenCalledTimes(1);

    // The re-run completes the receipt so the NEXT retry is a true duplicate.
    const update = db.webhookReceipt.update.mock.calls.at(-1)![0];
    expect(update.data.processedAt).toBeInstanceOf(Date);
  });

  it("the re-run is CLAIMED atomically first: a compare-and-swap on the exact stale receivedAt this request read", async () => {
    const residue = receiptRow();
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(residue);

    await delivery();

    // The claim precedes the handler — it is the gate, not a log…
    expect(db.webhookReceipt.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      handlerMock.mock.invocationCallOrder[0],
    );
    // …and is exclusive by construction: only an UNFINISHED receipt whose
    // liveness signal still EQUALS what this request observed can be
    // re-claimed. Any winner's refresh (or a heartbeat from a run that was
    // not dead after all) changes receivedAt, so every racer loses.
    expect(db.webhookReceipt.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        webhookId: "wh_1",
        processedAt: null,
        receivedAt: residue.receivedAt,
      },
      data: { receivedAt: expect.any(Date) },
    });
  });

  it("a LOST re-run claim (another retry won the race) answers 503 and runs nothing", async () => {
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(receiptRow());
    db.webhookReceipt.updateMany.mockResolvedValue({ count: 0 }); // racer won

    const response = await delivery();
    // NOT 2xx: the loser's retry train must survive in case the WINNER
    // crashes too.
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("IN_FLIGHT_RETRY_LATER");
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("FAILED residue whose 200 never reached Shopify is also re-driven", async () => {
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(
      receiptRow({ status: "FAILED", error: "earlier failure" }),
    );

    const response = await delivery();
    expect(await response.text()).toBe("PROCESSED");
    expect(handlerMock).toHaveBeenCalledTimes(1);
  });

  it("a claim still inside the in-flight grace window answers 503 — the retry train MUST survive a live run", async () => {
    // Pre-fix this answered 200 SKIPPED_DUPLICATE: Shopify marked the
    // delivery successful and never retried again, so when the in-flight
    // handler was OOM-killed a minute later, the stuck receipt's ONLY
    // automatic recovery carrier was already spent — manual replay territory.
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(
      receiptRow({ receivedAt: new Date(Date.now() - 10_000) }),
    );

    const response = await delivery();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("IN_FLIGHT_RETRY_LATER");
    expect(handlerMock).not.toHaveBeenCalled();
    // And no state was touched: the in-flight run owns the receipt.
    expect(db.webhookReceipt.update).not.toHaveBeenCalled();
    expect(db.webhookReceipt.updateMany).not.toHaveBeenCalled();
  });

  it("heartbeats receivedAt while the handler runs, so a slow handler STAYS in-flight past the grace window", async () => {
    vi.useFakeTimers();
    try {
      let finishHandler: () => void = () => {};
      handlerMock.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishHandler = resolve;
          }),
      );

      const pending = delivery();
      await vi.advanceTimersByTimeAsync(0); // reach the handler
      expect(handlerMock).toHaveBeenCalledTimes(1);
      expect(db.webhookReceipt.updateMany).not.toHaveBeenCalled();

      // t+30s, t+60s: the lease-renewal beats. Each bump only touches a
      // still-unfinished receipt, so a beat can never resurrect a completed
      // one — and a retry arriving at t+65s now finds receivedAt 5s old:
      // in-flight, no concurrent re-run (failure mode (b), closed).
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);
      const beats = db.webhookReceipt.updateMany.mock.calls;
      expect(beats.length).toBe(2);
      for (const [args] of beats) {
        expect(args.where).toEqual({ webhookId: "wh_1", processedAt: null });
        expect(args.data.receivedAt).toBeInstanceOf(Date);
      }

      // Completion stops the heartbeat: no beats after the response.
      finishHandler();
      const response = await pending;
      expect(await response.text()).toBe("PROCESSED");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(db.webhookReceipt.updateMany.mock.calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a payload-hash mismatch is never this request's claim to re-run", async () => {
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(
      receiptRow({ payloadHash: "somebody-elses-hash" }),
    );

    const response = await delivery();
    expect(await response.text()).toBe("SKIPPED_DUPLICATE");
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("a vanished receipt row (P2002 but no row) degrades to skip, not crash", async () => {
    db.webhookReceipt.create.mockRejectedValue(uniqueViolation());
    db.webhookReceipt.findUnique.mockResolvedValue(null);

    const response = await delivery();
    expect(await response.text()).toBe("SKIPPED_DUPLICATE");
    expect(handlerMock).not.toHaveBeenCalled();
  });
});

describe("non-P2002 claim failures", () => {
  it("DB down on the claim propagates (5xx lets Shopify redeliver later)", async () => {
    db.webhookReceipt.create.mockRejectedValue(new Error("connection refused"));
    await expect(delivery()).rejects.toThrow("connection refused");
    expect(handlerMock).not.toHaveBeenCalled();
  });
});

describe("unhandled topics", () => {
  it("completes the receipt and answers UNHANDLED", async () => {
    const response = await delivery("SOME_UNKNOWN_TOPIC");
    expect(await response.text()).toBe("UNHANDLED");
    expect(handlerMock).not.toHaveBeenCalled();
    const update = db.webhookReceipt.update.mock.calls.at(-1)![0];
    expect(update.data.processedAt).toBeInstanceOf(Date);
  });
});
