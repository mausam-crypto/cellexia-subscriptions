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
 *   means this delivery was already accepted (Shopify retry or double
 *   delivery) → 200 SKIPPED_DUPLICATE immediately, no handler runs.
 * - Outcomes land on the receipt: success → PROCESSED + processedAt; failure
 *   → FAILED + error. Failures STILL return 200: Shopify disables webhooks
 *   that keep 5xx-ing, so recovery is driven by our own alerting over FAILED
 *   receipts (see the alerts job), not by Shopify retries.
 * - Handlers run inline and must stay under a few seconds; anything heavier
 *   belongs in the jobs pipeline.
 */

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
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
    if (isUniqueViolation(err)) {
      return new Response("SKIPPED_DUPLICATE", { status: 200 });
    }
    // Receipt table unavailable (DB down): nothing was processed, so a 5xx is
    // safe here and lets Shopify redeliver later.
    throw err;
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
    // 200 on purpose — see module note: our alert-based recovery owns retries.
    return new Response("FAILED", { status: 200 });
  }
};
