/**
 * Lifecycle event emission — the single entry point every service uses.
 *
 * Writes the event to the analytics warehouse (AnalyticsEvent) and enqueues an
 * outbox row (OutboundEvent) for Klaviyo delivery. Delivery itself is handled
 * by services/communications/klaviyo.server.ts (processOutbox); this module
 * never talks to Klaviyo directly, so emission stays fast and transactional.
 */
import prisma from "~/db.server";
import { sha256Hex } from "~/lib/crypto.server";
import { logger } from "~/lib/logger.server";
import type { LifecycleEvent } from "~/types/domain";

export interface EmitOptions {
  shop: string;
  name: LifecycleEvent;
  contractId?: string | null;
  shopifyCustomerId?: string | null;
  /** Customer email; required for the event to reach Klaviyo. */
  email?: string | null;
  payload?: Record<string, unknown>;
  /**
   * Extra payload fields written ONLY to the OutboundEvent outbox row (for
   * Klaviyo delivery), never to the AnalyticsEvent warehouse row. Use for
   * secrets such as magic-link URLs that analysts must not be able to read.
   * Callers passing this should also pass an explicit dedupeKey, since the
   * default key is derived from the analytics payload alone.
   */
  deliveryOnlyPayload?: Record<string, unknown>;
  /**
   * Stable key for deduplication. Defaults to a hash of
   * (shop, name, contractId, payload) — pass an explicit key for events that
   * may legitimately repeat with identical payloads (e.g. retries per cycle).
   *
   * An EXPLICIT key also dedupes the AnalyticsEvent warehouse row (unique
   * column), so a replayed webhook or re-run job can never double-count the
   * event in metrics. The default hash is deliberately NOT written there —
   * legitimately repeating events with identical payloads must keep landing
   * as separate warehouse rows.
   */
  dedupeKey?: string;
}

export async function emitLifecycleEvent(opts: EmitOptions): Promise<void> {
  const payloadJson = JSON.stringify(opts.payload ?? {});
  const dedupeKey =
    opts.dedupeKey ??
    sha256Hex(
      [opts.shop, opts.name, opts.contractId ?? "", payloadJson].join("|"),
    );

  // P2002 (duplicate explicit dedupeKey) = the warehouse row already exists
  // from a previous delivery of the same fact. Swallow it and continue to the
  // outbox step: the first delivery may have crashed between the two writes,
  // and the outbox insert has its own dedupe.
  await prisma.analyticsEvent
    .create({
      data: {
        shop: opts.shop,
        name: opts.name,
        contractId: opts.contractId ?? null,
        shopifyCustomerId: opts.shopifyCustomerId ?? null,
        payloadJson,
        dedupeKey: opts.dedupeKey ?? null,
      },
    })
    .catch((e: unknown) => {
      const code = (e as { code?: string }).code;
      if (code !== "P2002") throw e;
    });

  if (opts.email) {
    // Unique dedupeKey guarantees at-most-once enqueue even if the caller runs twice.
    await prisma.outboundEvent
      .create({
        data: {
          shop: opts.shop,
          destination: "KLAVIYO",
          eventName: opts.name,
          dedupeKey,
          profileEmail: opts.email,
          payloadJson: JSON.stringify({
            ...(opts.payload ?? {}),
            ...(opts.deliveryOnlyPayload ?? {}),
          }),
        },
      })
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code;
        if (code !== "P2002") throw e; // P2002 = duplicate dedupeKey: already enqueued
      });
  }

  logger.info("lifecycle event", {
    shop: opts.shop,
    event: opts.name,
    contractId: opts.contractId,
  });
}
