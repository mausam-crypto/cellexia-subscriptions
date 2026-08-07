import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CLAIMED IS NOT PROCESSED — the webhook receipt pre-claim, evaluated.
 *
 * The route claims the X-Shopify-Webhook-Id by inserting a WebhookReceipt row
 * BEFORE the handler runs, and used to answer every P2002 on that insert with
 * SKIPPED_DUPLICATE. But Shopify retries a delivery that got no 2xx under the
 * SAME webhook id — so when the first delivery died mid-handler (pod restart
 * between handleBillingAttemptSuccess's settlement commit and
 * finishSuccessSettlement's tail), every retry hit the P2002 path and the
 * handler never ran again. That permanently voided BOTH crash-recovery
 * contracts the handlers define: the success path's settledAt-NULL redrive and
 * the failure path's declineCategory-NULL redrive — an open dunning case for a
 * customer who PAID (ladder emails, and eventually the exhaustion sweep
 * pausing the paid subscriber's contract).
 *
 * The fix: processedAt is the completion marker. A P2002 whose existing
 * receipt has processedAt set is a true duplicate; processedAt NULL with a
 * STALE liveness signal is crash residue and the retry re-claims (atomic
 * compare-and-swap on receivedAt) and re-runs the handler (handlers are
 * idempotent by design — each carries its own claim/dedupe).
 *
 * Liveness is receivedAt, heartbeat-renewed while a handler runs — so
 * "stale" means the claiming process is DEAD, not merely slow. And an
 * in-flight duplicate (fresh receivedAt) answers 503, never 2xx: a 2xx would
 * permanently end Shopify's redelivery train for the id while the live run
 * can still crash — the exact recovery carrier this design exists to keep.
 *
 * These tests drive the REAL route action with a mocked authenticate/db seam.
 */

const mocks = vi.hoisted(() => ({
  receiptCreate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  receiptFindUnique: vi.fn(async (_args?: unknown): Promise<unknown> => null),
  receiptUpdate: vi.fn(async (_args?: unknown): Promise<unknown> => ({})),
  receiptUpdateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
  handler: vi.fn(async (_ctx?: unknown): Promise<void> => {}),
  authenticateWebhook: vi.fn(async (_req?: unknown): Promise<unknown> => ({})),
}));

vi.mock("~/db.server", () => ({
  default: {
    webhookReceipt: {
      create: mocks.receiptCreate,
      findUnique: mocks.receiptFindUnique,
      update: mocks.receiptUpdate,
      updateMany: mocks.receiptUpdateMany,
    },
  },
}));

vi.mock("~/shopify.server", () => ({
  authenticate: { webhook: mocks.authenticateWebhook },
}));

vi.mock("~/lib/webhooks/handlers.server", () => ({
  webhookHandlers: {
    SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS: mocks.handler,
  },
}));

import { action } from "~/routes/webhooks";

const TOPIC = "SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS";
const SHOP = "cellexia.myshopify.com";
const WEBHOOK_ID = "wh_delivery_1";
const PAYLOAD = {
  admin_graphql_api_id: "gid://shopify/SubscriptionBillingAttempt/900",
};
const PAYLOAD_HASH = createHash("sha256")
  .update(JSON.stringify(PAYLOAD))
  .digest("hex");

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`webhookId`)",
    { code: "P2002", clientVersion: "6.6.0" },
  );
}

async function deliver(): Promise<Response> {
  return (await action({
    request: new Request("https://app.example.com/webhooks", {
      method: "POST",
    }),
    params: {},
    context: {},
  })) as Response;
}

/** A pre-existing receipt row, as the redelivery's findUnique sees it. */
function receipt(over: Record<string, unknown> = {}) {
  return {
    id: "rcpt_1",
    topic: TOPIC,
    shopDomain: SHOP,
    webhookId: WEBHOOK_ID,
    payloadHash: PAYLOAD_HASH,
    status: "PROCESSED", // the provisional claim value
    error: null,
    receivedAt: new Date(Date.now() - 30 * 60_000), // well past the grace window
    processedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateWebhook.mockResolvedValue({
    topic: TOPIC,
    shop: SHOP,
    payload: PAYLOAD,
    webhookId: WEBHOOK_ID,
  });
  mocks.receiptCreate.mockResolvedValue({});
  mocks.receiptFindUnique.mockResolvedValue(null);
  mocks.receiptUpdate.mockResolvedValue({});
  mocks.receiptUpdateMany.mockResolvedValue({ count: 1 }); // re-claim wins
});

describe("first delivery (receipt insert wins)", () => {
  it("runs the handler and stamps processedAt — the completion marker", async () => {
    const res = await deliver();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PROCESSED");
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(mocks.handler).toHaveBeenCalledWith({
      shopDomain: SHOP,
      payload: PAYLOAD,
      webhookId: WEBHOOK_ID,
    });
    expect(mocks.receiptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { webhookId: WEBHOOK_ID },
        data: expect.objectContaining({
          status: "PROCESSED",
          processedAt: expect.any(Date),
        }),
      }),
    );
  });
});

describe("redelivery under the same webhook id (P2002 on the claim)", () => {
  beforeEach(() => {
    mocks.receiptCreate.mockRejectedValue(p2002());
  });

  it("a COMPLETED receipt is a true duplicate: skipped, handler untouched", async () => {
    mocks.receiptFindUnique.mockResolvedValue(
      receipt({ processedAt: new Date() }),
    );

    const res = await deliver();

    expect(await res.text()).toBe("SKIPPED_DUPLICATE");
    expect(res.status).toBe(200);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  /**
   * The defect this file exists for: first delivery died mid-handler (no 2xx
   * reached Shopify), receipt says PROCESSED but processedAt is NULL. The
   * same-id retry used to be swallowed forever — the ONLY carrier of the
   * settledAt-NULL / declineCategory-NULL redrive contracts never ran.
   */
  it("CRASH RESIDUE (processedAt NULL, past grace) re-claims atomically, re-runs the handler and completes the receipt", async () => {
    const residue = receipt();
    mocks.receiptFindUnique.mockResolvedValue(residue);

    const res = await deliver();

    expect(mocks.handler).toHaveBeenCalledTimes(1);
    expect(mocks.handler).toHaveBeenCalledWith({
      shopDomain: SHOP,
      payload: PAYLOAD,
      webhookId: WEBHOOK_ID,
    });
    // The takeover is a conditional receivedAt bump — still-unfinished AND
    // receivedAt unchanged since this request read it — so of N concurrent
    // same-id retries exactly one can match. The bump also restarts the
    // in-flight grace window for this run.
    expect(mocks.receiptUpdateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        webhookId: WEBHOOK_ID,
        processedAt: null,
        receivedAt: residue.receivedAt,
      },
      data: { receivedAt: expect.any(Date) },
    });
    // The re-claim strictly precedes the handler — it is the gate, not a log.
    expect(mocks.receiptUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.handler.mock.invocationCallOrder[0],
    );
    // Completion is stamped, so the NEXT retry is a true duplicate.
    expect(mocks.receiptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { webhookId: WEBHOOK_ID },
        data: expect.objectContaining({
          status: "PROCESSED",
          processedAt: expect.any(Date),
        }),
      }),
    );
    expect(await res.text()).toBe("PROCESSED");
    expect(res.status).toBe(200);
  });

  it("a FAILED receipt whose 200 never reached Shopify is re-driveable too (processedAt NULL)", async () => {
    mocks.receiptFindUnique.mockResolvedValue(
      receipt({ status: "FAILED", error: "boom" }),
    );

    await deliver();

    expect(mocks.handler).toHaveBeenCalledTimes(1);
  });

  it("a receipt still INSIDE the grace window is in flight: answered 503 so the retry train survives, no concurrent double-run", async () => {
    mocks.receiptFindUnique.mockResolvedValue(
      receipt({ receivedAt: new Date() }),
    );

    const res = await deliver();

    // NOT a 2xx: a 200 here would end Shopify's redelivery for this id while
    // the in-flight run can still crash — the exact recovery this route
    // exists to keep. If the run completes, the NEXT retry finds processedAt
    // set and is a clean 200 duplicate.
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("IN_FLIGHT_RETRY_LATER");
    expect(mocks.handler).not.toHaveBeenCalled();
    expect(mocks.receiptUpdateMany).not.toHaveBeenCalled();
    expect(mocks.receiptUpdate).not.toHaveBeenCalled();
  });

  /**
   * The confirmed production shape: Shopify aborts deliveries after ~5s and
   * retries the SAME webhook id, so a slow-but-alive handler (contract sync
   * under Admin API throttling routinely exceeds a minute) is guaranteed to
   * see same-id retries while still running. Liveness — not a bigger grace
   * window — is what covers the worst legitimate runtime: the route
   * heartbeat-renews receivedAt every 30s for as long as the handler runs
   * (pinned in tests/webhook-receipt-redelivery.test.ts), so a retry ~70s in
   * finds a FRESH receivedAt and waits (503); it must never run the handler
   * alongside the first delivery (both would create the same missing
   * contract lines).
   */
  it("a retry while the first delivery is legitimately still running (70s in, heartbeat fresh) waits, not runs concurrently", async () => {
    mocks.receiptFindUnique.mockResolvedValue(
      // Claimed 70s ago, but the run is alive: its last heartbeat just
      // renewed receivedAt.
      receipt({ receivedAt: new Date(Date.now() - 5_000) }),
    );

    const res = await deliver();

    expect(res.status).toBe(503);
    expect(await res.text()).toBe("IN_FLIGHT_RETRY_LATER");
    expect(mocks.handler).not.toHaveBeenCalled();
    expect(mocks.receiptUpdateMany).not.toHaveBeenCalled();
  });

  it("70s of heartbeat SILENCE is death, not slowness — the retry re-claims and re-runs", async () => {
    // With a 30s heartbeat, a receivedAt stale by 70s means the claiming
    // process missed two beats: it is gone, and this retry is the recovery
    // carrier. (Pre-heartbeat, age alone had to arbitrate here, and a slow
    // run and a dead one were indistinguishable.)
    mocks.receiptFindUnique.mockResolvedValue(
      receipt({ receivedAt: new Date(Date.now() - 70_000) }),
    );

    const res = await deliver();

    expect(await res.text()).toBe("PROCESSED");
    expect(mocks.handler).toHaveBeenCalledTimes(1);
  });

  it("a retry that LOSES the atomic re-claim (another retry won the takeover) answers 503 — the redrive is single-flight", async () => {
    mocks.receiptFindUnique.mockResolvedValue(receipt());
    // Between this request's findUnique and its updateMany, a concurrent
    // same-id retry bumped receivedAt (or the runner completed): the
    // conditional write matches nothing.
    mocks.receiptUpdateMany.mockResolvedValue({ count: 0 });

    const res = await deliver();

    // The loser keeps its train scheduled too: if the WINNER crashes
    // mid-re-run, a later retry must still exist to recover it.
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("IN_FLIGHT_RETRY_LATER");
    expect(mocks.handler).not.toHaveBeenCalled();
    // And it never stamps anything on the receipt the winner now owns.
    expect(mocks.receiptUpdate).not.toHaveBeenCalled();
  });

  it("a payload-hash mismatch is never re-run — same id must mean same delivery", async () => {
    mocks.receiptFindUnique.mockResolvedValue(
      receipt({ payloadHash: "someone-elses-hash" }),
    );

    const res = await deliver();

    expect(await res.text()).toBe("SKIPPED_DUPLICATE");
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it("a redriven handler that fails again lands FAILED on the receipt, without a completion stamp", async () => {
    mocks.receiptFindUnique.mockResolvedValue(receipt());
    mocks.handler.mockRejectedValueOnce(new Error("still broken"));

    const res = await deliver();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("FAILED");
    // status FAILED, but processedAt is NOT stamped. NOTE what the 200 means:
    // Shopify treats it as delivered and never retries this id again, so the
    // retry train is DEAD from here — recovery is owned by the alert side
    // (checkWebhookFailures counts even ONE aged FAILED+processedAt-NULL
    // receipt, tests/webhook-stuck-receipt-alert.test.ts) and by the
    // settlement_redrive job (tests/settlement-redrive.test.ts), never by a
    // further redelivery. Leaving processedAt NULL is what keeps the row
    // visible to that alert arm.
    const update = mocks.receiptUpdate.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data.status).toBe("FAILED");
    expect(update.data.processedAt).toBeUndefined();
  });
});
