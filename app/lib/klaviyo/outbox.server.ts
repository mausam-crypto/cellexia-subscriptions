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
 *                PENDING/FAILED → DEAD (aged out past MAX_EVENT_AGE_MS —
 *                stale moments are dropped, never fired late)
 */

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MINUTES = 6 * 60; // cap 6h
/**
 * Rows older than this are aged out (DEAD) instead of delivered. A Klaviyo
 * event is a MOMENT — a payment-failed or order-skipped flow firing weeks
 * after the moment resolved (classically: KLAVIYO_PRIVATE_API_KEY configured
 * long after rows piled up PENDING) emails customers about ancient history.
 * A row that is genuinely retrying exhausts MAX_ATTEMPTS in ~14.5h of
 * continuous failure, so this cutoff only ever catches rows nothing was
 * flushing: key unset, or the flush job down. The sweep runs even when the
 * key is missing, precisely so configuring it later starts clean.
 */
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
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
  /** Rows aged out (DEAD) for exceeding MAX_EVENT_AGE_MS before delivery. */
  expired: number;
  /**
   * true when KLAVIYO_PRIVATE_API_KEY is unset — undelivered rows are left
   * PENDING (until the age-out sweep retires them) and nothing is sent.
   */
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
  const stats: FlushStats = { claimed: 0, sent: 0, retried: 0, dead: 0, expired: 0 };
  const now = new Date();

  // Age out stale rows FIRST — even (especially) when the key is missing —
  // so a key configured weeks late can never fire flows on long-resolved
  // moments, and so the alert scan sees the backlog as DEAD rows it watches.
  try {
    const expired = await prisma.klaviyoOutbox.updateMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        eventTime: { lt: new Date(now.getTime() - MAX_EVENT_AGE_MS) },
      },
      data: {
        status: "DEAD",
        lastError:
          "expired: exceeded 24h max event age before delivery (Klaviyo key missing or flush stalled)",
      },
    });
    stats.expired = expired.count;
  } catch (err) {
    // Never let the age-out sweep block a flush that could still deliver.
    console.error("[klaviyo] outbox age-out sweep failed", err);
  }

  if (!isKlaviyoConfigured()) {
    // Leave remaining rows PENDING; they flush once the key is configured.
    return { ...stats, skipped: true };
  }
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
