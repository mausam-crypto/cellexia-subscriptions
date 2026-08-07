import type { ActionFunctionArgs } from "@remix-run/node";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import { webhookHandlers } from "~/lib/webhooks/handlers.server";

/**
 * Single endpoint for every Shopify webhook topic (configured in
 * shopify.app.toml).
 *
 * Contract:
 * - `authenticate.webhook` verifies the HMAC. An invalid signature makes it
 *   throw the 401 Response Shopify expects — that Response propagates
 *   naturally and never reaches the receipt table.
 * - Idempotency: a WebhookReceipt row is created for the unique
 *   X-Shopify-Webhook-Id BEFORE any work happens. A P2002 unique violation
 *   means the id was already CLAIMED — which is not the same as PROCESSED.
 *   `processedAt` is the completion marker: only a claimed receipt whose
 *   processedAt is set is a true duplicate (→ 200 SKIPPED_DUPLICATE, no
 *   handler). A claimed receipt with processedAt still NULL is either a
 *   handler still running in another request, or crash residue — the first
 *   delivery died mid-handler (pod restart, OOM) and never answered Shopify,
 *   so Shopify is retrying under the SAME webhook id. That retry train is the
 *   ONLY carrier of the handlers' crash-recovery contracts (the success
 *   path's settledAt-NULL redrive and the failure path's declineCategory-NULL
 *   redrive in lib/webhooks/handlers.server.ts): swallowing it would orphan a
 *   half-settled attempt forever.
 * - Liveness, not age, decides which of the two a NULL-processedAt claim is:
 *   while a handler runs, the receipt's receivedAt is HEARTBEAT-renewed
 *   (RECEIPT_HEARTBEAT_MS, the JobLock lease-renewal pattern from
 *   lib/jobs/runner.server.ts), so "receivedAt within IN_FLIGHT_GRACE_MS"
 *   means a live run however long the handler takes — a slow settlement can
 *   never collide with a late retry re-running it concurrently.
 * - An IN-FLIGHT duplicate is answered **503**, never 2xx: any 2xx
 *   permanently ends Shopify's redelivery train for that webhook id, and the
 *   in-flight run may still crash — the train must survive it. The 5xx keeps
 *   the retry scheduled; if the run completes, the next retry finds
 *   processedAt set and is a clean 200 duplicate, and if it crashes, the
 *   retained train drives the re-run below. (Handler FAILURES still answer
 *   200 — see below — so this 503 only ever fires while a run is genuinely
 *   alive or just crashed: far too rare for Shopify's sustained-failure
 *   webhook removal to trigger.)
 * - Crash residue (claim stale for over IN_FLIGHT_GRACE_MS, processedAt still
 *   NULL) re-runs the handler — every handler is idempotent by design (each
 *   carries its own claim/dedupe), so a re-run can never double-book. The
 *   re-run itself is claimed ATOMICALLY: a compare-and-swap updateMany that
 *   refreshes receivedAt only while it still equals the stale value this
 *   request read, so two retries landing together can never both re-run; the
 *   loser answers 503 and keeps the train alive behind the winner.
 * - Outcomes land on the receipt: success → PROCESSED + processedAt; failure
 *   → FAILED + error. Failures STILL return 200: Shopify disables webhooks
 *   that keep 5xx-ing. That 200 permanently ENDS the retry train for the id,
 *   so recovery from handler ERRORS cannot come from Shopify retries (those
 *   exist to recover from process DEATH) — it is owned by our own plumbing:
 *   the WEBHOOK_FAILURES alert treats even a SINGLE FAILED receipt older
 *   than its stuck window as unrecoverable residue (see the alerts job), and
 *   the settlement_redrive job re-drives the attempt-shaped halves directly
 *   (SUCCESS+settledAt-NULL tails via finishSuccessSettlement,
 *   FAILED+declineCategory-NULL failures via onBillingAttemptFailed), so a
 *   half-settled attempt heals even if nobody reads the alert.
 * - Handlers run inline and must stay under a few seconds; anything heavier
 *   belongs in the jobs pipeline.
 */

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * How stale a claimed-but-unfinished receipt's receivedAt must be before the
 * claim counts as crash residue rather than a live run. receivedAt is renewed
 * on the heartbeat below for as long as the handler runs, so this is a bound
 * on "time since the claiming process last proved it was alive" — not on
 * handler duration.
 */
const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Heartbeat cadence for the receivedAt renewal — half the grace window, so
 * one missed beat never lets a live run be mistaken for crash residue
 * (mirrors LOCK_RENEW_MS = LOCK_LEASE_MS / 2 in lib/jobs/runner.server.ts).
 */
const RECEIPT_HEARTBEAT_MS = IN_FLIGHT_GRACE_MS / 2;

/**
 * Keep the receipt's claim visibly alive while the handler runs. Never
 * throws (a renewal hiccup must not kill the handler mid-flight); the
 * processedAt-NULL guard makes a late beat after completion a no-op.
 * Returns the stop function; callers stop it in a finally.
 */
function startReceiptHeartbeat(webhookId: string): () => void {
  const heartbeat = setInterval(() => {
    prisma.webhookReceipt
      .updateMany({
        where: { webhookId, processedAt: null },
        data: { receivedAt: new Date() },
      })
      .catch((err: unknown) =>
        console.error(`[webhooks] receipt heartbeat failed for ${webhookId}`, err),
      );
  }, RECEIPT_HEARTBEAT_MS);
  // unref() (when available) so a live heartbeat never pins the process open.
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, webhookId } =
    await authenticate.webhook(request);

  const payloadRecord = (payload ?? {}) as Record<string, unknown>;
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(payloadRecord))
    .digest("hex");

  // Claim the webhook id before doing any work; the unique index is the lock.
  try {
    await prisma.webhookReceipt.create({
      data: {
        topic,
        shopDomain: shop,
        webhookId,
        payloadHash,
        status: "PROCESSED", // provisional; processedAt marks actual completion
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) {
      // Receipt table unavailable (DB down): nothing was processed, so a 5xx
      // is safe here and lets Shopify redeliver later.
      throw err;
    }

    // Already claimed. Claimed ≠ completed — decide which one this is.
    const existing = await prisma.webhookReceipt.findUnique({
      where: { webhookId },
    });
    const completed = existing?.processedAt != null;
    // Same webhook id must mean same delivery; a hash mismatch is not this
    // request's claim to re-run.
    const sameDelivery = existing?.payloadHash === payloadHash;
    if (existing == null || completed || !sameDelivery) {
      return new Response("SKIPPED_DUPLICATE", { status: 200 });
    }
    const inFlight =
      Date.now() - existing.receivedAt.getTime() < IN_FLIGHT_GRACE_MS;
    if (inFlight) {
      // A run is (or was moments ago) alive on this id. NOT a 2xx: answering
      // 200 here would end Shopify's redelivery train while the live run can
      // still crash — the exact recovery carrier this route exists to keep.
      return new Response("IN_FLIGHT_RETRY_LATER", { status: 503 });
    }
    // Crash residue (claimed long ago, never completed, heartbeat long dead —
    // status PROCESSED with processedAt NULL, or FAILED whose 200 never
    // reached Shopify): claim the re-run atomically. The takeover is a
    // compare-and-swap on exactly the stale liveness signal this request
    // READ — of N concurrent same-id retries at most one can match, because
    // any winner's refresh (or a heartbeat from a run that was not dead
    // after all) changes receivedAt and the rest miss. The refreshed
    // receivedAt also restarts the in-flight window for this run.
    const claimed = await prisma.webhookReceipt.updateMany({
      where: {
        webhookId,
        processedAt: null,
        receivedAt: existing.receivedAt,
      },
      data: { receivedAt: new Date() },
    });
    if (claimed.count === 0) {
      return new Response("IN_FLIGHT_RETRY_LATER", { status: 503 });
    }
    // Fall through and re-run the handler. Idempotent handlers make the
    // re-run safe; completing below stamps processedAt so the NEXT retry is
    // a true duplicate.
  }

  const handler = webhookHandlers[topic];
  if (!handler) {
    console.warn(`[webhooks] no handler registered for topic ${topic}`);
    await prisma.webhookReceipt
      .update({
        where: { webhookId },
        data: { processedAt: new Date() },
      })
      .catch((updateErr) =>
        console.error("[webhooks] receipt update failed", updateErr),
      );
    return new Response("UNHANDLED", { status: 200 });
  }

  const stopHeartbeat = startReceiptHeartbeat(webhookId);
  try {
    await handler({ shopDomain: shop, payload: payloadRecord, webhookId });
    await prisma.webhookReceipt.update({
      where: { webhookId },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    return new Response("PROCESSED", { status: 200 });
  } catch (err) {
    const message =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(`[webhooks] ${topic} handler failed`, err);
    await prisma.webhookReceipt
      .update({
        where: { webhookId },
        data: { status: "FAILED", error: message.slice(0, 4000) },
      })
      .catch((updateErr) =>
        console.error("[webhooks] receipt update failed", updateErr),
      );
    // 200 on purpose — see module note: this ends the retry train, and our
    // own recovery owns handler ERRORS from here (the single-receipt
    // WEBHOOK_FAILURES stuck arm + the settlement_redrive job); a 5xx here
    // would eventually get the webhook disabled.
    return new Response("FAILED", { status: 200 });
  } finally {
    stopHeartbeat();
  }
};
