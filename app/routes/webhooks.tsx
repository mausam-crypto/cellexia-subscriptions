/**
 * Single webhook endpoint for every topic declared in shopify.app.toml.
 *
 * Flow: authenticate.webhook → replay guard (ProcessedWebhook by webhookId)
 * → dispatch → 200 fast. Handler errors are logged; only retryable failures
 * (transient infra) return 500 so Shopify redelivers — and the replay-guard
 * row is released first so the redelivery is not skipped.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "~/db.server";
import { authenticate } from "~/shopify.server";
import {
  dispatchWebhook,
  isRetryableWebhookError,
} from "~/services/core/webhooks/handlers.server";
import type { AdminGraphql } from "~/services/core/shopifyClient.server";
import { logger } from "~/lib/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin, webhookId } =
    await authenticate.webhook(request);

  // Replay protection: first delivery wins; duplicates return 200 untouched.
  if (webhookId) {
    try {
      await prisma.processedWebhook.create({
        data: { webhookId, topic, shop },
      });
    } catch (e: unknown) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") {
        logger.info("webhook replay skipped", { topic, shop, webhookId });
        return new Response(null, { status: 200 });
      }
      throw e;
    }
  }

  try {
    await dispatchWebhook({
      topic,
      shop,
      payload: (payload ?? {}) as Record<string, unknown>,
      graphql: admin ? (admin.graphql as unknown as AdminGraphql) : null,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (isRetryableWebhookError(e)) {
      logger.error("webhook handler failed (retryable)", {
        topic,
        shop,
        webhookId,
        error: message,
      });
      // Release the replay guard so Shopify's redelivery is processed.
      if (webhookId) {
        await prisma.processedWebhook
          .delete({ where: { webhookId } })
          .catch(() => undefined);
      }
      return new Response(null, { status: 500 });
    }
    logger.error("webhook handler failed (non-retryable, acked)", {
      topic,
      shop,
      webhookId,
      error: message,
    });
  }

  return new Response(null, { status: 200 });
};
