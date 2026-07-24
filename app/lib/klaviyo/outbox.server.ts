import prisma from "~/db.server";
import {
  createKlaviyoEvent,
  isKlaviyoConfigured,
  type KlaviyoSendResult,
} from "./client.server";

/**
 * Klaviyo outbox — guaranteed at-least-once delivery of events to Klaviyo.
 *
 * Writers call `enqueue()` (cheap DB insert, never talks to Klaviyo inline);
 * the `klaviyo_flush` job calls `flushKlaviyoOutbox()` to drain the table with
 * exponential backoff. Nothing is lost if Klaviyo is briefly down, and a
 * Klaviyo outage can never slow down billing or portal actions.
 *
 * Row lifecycle: PENDING → SENT
 *                PENDING → FAILED (retryable, backoff) → SENT | DEAD
 *                PENDING → DEAD   (permanent 4xx, or attempts exhausted)
 */

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MINUTES = 6 * 60; // cap 6h
/**
 * Duplicate-suppression window. The same metric for the same profile+contract
 * enqueued twice within this window is treated as one customer-facing moment
 * (e.g. the event log and the notifications router both reacting to one skip).
 */
const DEDUPE_WINDOW_MS = 120_000;

export interface EnqueueKlaviyoInput {
  eventName: string;
  email?: string | null;
  phone?: string | null;
  profileAttrs?: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  eventTime?: Date;
}

export interface EnqueueOptions {
  /** Set false to bypass the short duplicate-suppression window. */
  dedupe?: boolean;
}

/**
 * Inserts an event into the outbox. Never throws (a Klaviyo bookkeeping
 * failure must never break the caller); logs and drops on error.
 */
export async function enqueue(
  shopId: string,
  input: EnqueueKlaviyoInput,
  options: EnqueueOptions = {},
): Promise<void> {
  try {
    if (!input.email && !input.phone) {
      console.warn(
        "[klaviyo] dropping outbox event without email/phone",
        input.eventName,
      );
      return;
    }

    if (options.dedupe !== false) {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
      const contractId =
        typeof input.properties?.contract_id === "string"
          ? input.properties.contract_id
          : undefined;
      const duplicate = await prisma.klaviyoOutbox.findFirst({
        where: {
          shopId,
          eventName: input.eventName,
          ...(input.email ? { email: input.email } : { phone: input.phone }),
          eventTime: { gte: since },
          status: { in: ["PENDING", "SENT", "FAILED"] },
          ...(contractId
            ? { properties: { path: ["contract_id"], equals: contractId } }
            : {}),
        },
        select: { id: true },
      });
      if (duplicate) return;
    }

    // JSON round-trip drops `undefined` values (Prisma rejects them in Json)
    // and normalizes Dates to ISO strings before storage.
    await prisma.klaviyoOutbox.create({
      data: {
        shopId,
        eventName: input.eventName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        profileAttrs: JSON.parse(
          JSON.stringify(input.profileAttrs ?? {}),
        ) as object,
        properties: JSON.parse(
          JSON.stringify(input.properties ?? {}),
        ) as object,
        eventTime: input.eventTime ?? new Date(),
      },
    });
  } catch (err) {
    console.error("[klaviyo] outbox enqueue failed", input.eventName, err);
  }
}

export interface FlushStats {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  /** true when KLAVIYO_PRIVATE_API_KEY is unset — rows are left PENDING. */
  skipped?: boolean;
}

function backoffMinutes(attempts: number): number {
  return Math.min(Math.pow(2, attempts), MAX_BACKOFF_MINUTES);
}

/**
 * Drains due outbox rows. Called by the job runner (job name "klaviyo_flush")
 * under a JobLock lease, so concurrent flushes are already excluded.
 */
export async function flushKlaviyoOutbox(limit = 100): Promise<FlushStats> {
  const stats: FlushStats = { claimed: 0, sent: 0, retried: 0, dead: 0 };

  if (!isKlaviyoConfigured()) {
    // Leave rows PENDING; they will flush once the key is configured.
    return { ...stats, skipped: true };
  }

  const now = new Date();
  const rows = await prisma.klaviyoOutbox.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: now },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  stats.claimed = rows.length;

  for (const row of rows) {
    let result: KlaviyoSendResult | null = null;
    let thrownMessage: string | null = null;

    try {
      result = await createKlaviyoEvent({
        eventName: row.eventName,
        email: row.email,
        phone: row.phone,
        profileAttrs: (row.profileAttrs ?? {}) as Record<string, unknown>,
        properties: (row.properties ?? {}) as Record<string, unknown>,
        eventTime: row.eventTime,
      });
    } catch (err) {
      // 5xx / network — retryable.
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    try {
      if (result?.ok) {
        await prisma.klaviyoOutbox.update({
          where: { id: row.id },
          data: { status: "SENT", sentAt: new Date(), lastError: null },
        });
        stats.sent++;
      } else if (result && result.permanent) {
        await prisma.klaviyoOutbox.update({
          where: { id: row.id },
          data: {
            status: "DEAD",
            attempts: row.attempts + 1,
            lastError: result.error ?? `Permanent failure (${result.status})`,
          },
        });
        stats.dead++;
      } else {
        // Retryable: thrown 5xx/network, or a non-permanent 4xx (429).
        const attempts = row.attempts + 1;
        const lastError =
          thrownMessage ?? result?.error ?? "Unknown retryable failure";
        if (attempts >= MAX_ATTEMPTS) {
          await prisma.klaviyoOutbox.update({
            where: { id: row.id },
            data: { status: "DEAD", attempts, lastError },
          });
          stats.dead++;
        } else {
          await prisma.klaviyoOutbox.update({
            where: { id: row.id },
            data: {
              status: "FAILED",
              attempts,
              lastError,
              nextAttemptAt: new Date(
                Date.now() + backoffMinutes(attempts) * 60_000,
              ),
            },
          });
          stats.retried++;
        }
      }
    } catch (err) {
      // DB bookkeeping failed — leave the row for the next flush.
      console.error("[klaviyo] outbox status update failed", row.id, err);
    }
  }

  return stats;
}
