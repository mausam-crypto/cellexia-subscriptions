import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import {
  createKlaviyoEvent,
  resolveKlaviyoAuth,
  type KlaviyoAuth,
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
 *
 * A DEAD row is a delivery that will never happen. The notifications router
 * logged SENT at enqueue time (its promise: "handed to a working transport"),
 * so every DEAD transition reconciles the NotificationLog rows that reference
 * the outbox row (NotificationLog.outboxId): SENT flips to FAILED with the
 * dead reason and notification.failed is logged — hasSentForCycle dedupe and
 * dunning-ladder queries count only SENT, so the customer becomes eligible
 * for a resend instead of the audit trail lying forever (the classic trigger:
 * a rotated Klaviyo key turning every event into a permanent 4xx).
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
 * Inserts an event into the outbox and returns the row that will carry it —
 * the freshly created one, or the still-live duplicate when the dedupe window
 * suppressed a second insert (the caller's delivery rides THAT row, so its
 * NotificationLog reference must point there). Returns null when nothing was
 * (or will be) enqueued: no recipient, or the insert failed. Never throws (a
 * Klaviyo bookkeeping failure must never break the caller); logs and drops on
 * error.
 */
export async function enqueue(
  shopId: string,
  input: EnqueueKlaviyoInput,
  options: EnqueueOptions = {},
): Promise<{ id: string } | null> {
  try {
    if (!input.email && !input.phone) {
      console.warn(
        "[klaviyo] dropping outbox event without email/phone",
        input.eventName,
      );
      return null;
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
        select: { id: true, status: true, properties: true },
      });
      if (duplicate) {
        // Content graft (v1.16.0): the router's enqueue carries the
        // ready-rendered content_subject/content_html/content_text (Emails
        // tab), but for metrics ALSO fired by the event log the event-map row
        // often lands first — same metric, same profile, same contract —
        // and this dedupe would silently discard the content-carrying twin.
        // A flow built as `{{ event.content_html }}` would then render
        // empty. Graft the content keys onto the surviving row while it has
        // not been flushed yet; content-less duplicates (the common case)
        // change nothing. Failure-contained like the rest of this function.
        // cellexia_send rides along (v1.18.0): the auto-created flows
        // trigger-filter on it, so a content graft that left the surviving
        // row without the "true" verdict would render the flow silent.
        // Both writers (events-map.server.ts, send.server.ts) always stamp
        // cellexia_send atomically WITH its content — "true" never appears
        // without content, "false" never appears with it. So a row's
        // verdict is only trustworthy (and worth protecting) once that row
        // has actually received content: the add-only guard below is keyed
        // on `existing.content_text`, not on whether a verdict string is
        // merely present. A surviving row that is still contentless (e.g.
        // the canonical event-map's default "false" for milestone_gift /
        // rewards_unlocked / a hard-decline payment_failed_1, which never
        // gets content of its own) has no finalized verdict yet, so the
        // first content-bearing duplicate — router or canonical — legitimately
        // supersedes it, verdict included. Once a row has real content, its
        // verdict IS protected (e.g. a merge-cancel twin's provenance-gated
        // "false" can never be flipped to "true" after the fact).
        const CONTENT_KEYS = [
          "content_subject",
          "content_html",
          "content_text",
          "template",
          "cellexia_send",
        ] as const;
        const incoming = input.properties ?? {};
        const hasContent = CONTENT_KEYS.some(
          (k) => k !== "cellexia_send" && typeof incoming[k] === "string",
        );
        const existing = (duplicate.properties ?? {}) as Record<
          string,
          unknown
        >;
        if (
          hasContent &&
          duplicate.status === "PENDING" &&
          typeof existing.content_text !== "string"
        ) {
          const graft: Record<string, unknown> = {};
          for (const k of CONTENT_KEYS) {
            if (typeof incoming[k] !== "string") continue;
            graft[k] = incoming[k];
          }
          await prisma.klaviyoOutbox.update({
            where: { id: duplicate.id },
            data: {
              properties: JSON.parse(
                JSON.stringify({ ...existing, ...graft }),
              ) as object,
            },
          });
        }
        return { id: duplicate.id };
      }
    }

    // JSON round-trip drops `undefined` values (Prisma rejects them in Json)
    // and normalizes Dates to ISO strings before storage.
    const row = await prisma.klaviyoOutbox.create({
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
    return { id: row.id };
  } catch (err) {
    console.error("[klaviyo] outbox enqueue failed", input.eventName, err);
    return null;
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
   * true when no API key is available anywhere (Settings or
   * KLAVIYO_PRIVATE_API_KEY) — undelivered rows are left PENDING (until the
   * age-out sweep retires them) and nothing is sent.
   */
  skipped?: boolean;
}

function backoffMinutes(attempts: number): number {
  return Math.min(Math.pow(2, attempts), MAX_BACKOFF_MINUTES);
}

/**
 * Flip the NotificationLog rows that recorded SENT against now-DEAD outbox
 * rows to FAILED (error = the dead reason) and log notification.failed for
 * each — see the module doc. Klaviyo events enqueued straight from the event
 * map carry no NotificationLog row, so they simply find nothing to reconcile.
 * Contained per dead row: only fresh DEAD transitions reach this function
 * (there is no later catch-up scan), so one row's reconcile failure must
 * never abort the others' — and it never blocks or fails the flush itself.
 */
async function reconcileDeadNotificationLogs(
  deadRows: Array<{ id: string; lastError: string | null }>,
): Promise<void> {
  for (const dead of deadRows) {
    try {
      const logs = await prisma.notificationLog.findMany({
        where: { outboxId: dead.id, status: "SENT" },
      });
      for (const log of logs) {
        const reason = dead.lastError ?? "Klaviyo outbox row dead";
        await prisma.notificationLog.update({
          where: { id: log.id },
          data: { status: "FAILED", error: reason },
        });
        const cycleIndex = (log.payload as { cycleIndex?: unknown } | null)
          ?.cycleIndex;
        await logEvent({
          shopId: log.shopId,
          contractId: log.contractId,
          email: log.email,
          type: "notification.failed",
          source: "SYSTEM",
          payload: {
            template: log.template,
            klaviyoMetric: log.klaviyoEventName,
            outboxId: dead.id,
            error: reason,
            deadOutbox: true,
            ...(typeof cycleIndex === "number" ? { cycleIndex } : {}),
          },
        });
      }
    } catch (err) {
      console.error(
        "[klaviyo] dead-row NotificationLog reconcile failed",
        dead.id,
        err,
      );
    }
  }
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
    const expiredError =
      "expired: exceeded 24h max event age before delivery (Klaviyo key missing or flush stalled)";
    // Snapshot the ids before the bulk update: updateMany reports only a
    // count, and the reconcile below needs to know WHICH rows died. The
    // predicate is stable between the two statements (fixed cutoff; only this
    // flush — under its JobLock lease — moves rows out of PENDING/FAILED).
    const expiring = await prisma.klaviyoOutbox.findMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        eventTime: { lt: new Date(now.getTime() - MAX_EVENT_AGE_MS) },
      },
      select: { id: true },
    });
    const expired = await prisma.klaviyoOutbox.updateMany({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        eventTime: { lt: new Date(now.getTime() - MAX_EVENT_AGE_MS) },
      },
      data: {
        status: "DEAD",
        lastError: expiredError,
      },
    });
    stats.expired = expired.count;
    await reconcileDeadNotificationLogs(
      expiring.map((r) => ({ id: r.id, lastError: expiredError })),
    );
  } catch (err) {
    // Never let the age-out sweep block a flush that could still deliver.
    console.error("[klaviyo] outbox age-out sweep failed", err);
  }

  // Credentials resolve fresh every flush run (per-shop setting first, env
  // fallback) so an admin-saved key takes effect on the next 1-minute tick —
  // no restart, keeping the KLAVIYO_SETUP promise that queued rows "flush
  // automatically once the key appears". The pre-claim gate follows the
  // app's single-tenant convention (the primary shop decides whether ANY
  // delivery is possible); the per-row lookup below is the multi-shop-safe
  // belt over those braces.
  // Same predicate as getPrimaryShop (install.server), inlined because that
  // module drags in shopify.server; the flush must stay importable with only
  // db + client mocked.
  let primaryShopId: string | undefined;
  try {
    const primaryShop = await prisma.shop.findFirst({
      where: { uninstalledAt: null },
      orderBy: { installedAt: "desc" },
      select: { id: true },
    });
    primaryShopId = primaryShop?.id;
  } catch {
    // No shop context available — resolve from env alone.
  }
  const primaryAuth = await resolveKlaviyoAuth(primaryShopId);
  const authByShop = new Map<string, KlaviyoAuth>();
  if (primaryShopId) authByShop.set(primaryShopId, primaryAuth);
  const authFor = async (shopId: unknown): Promise<KlaviyoAuth> => {
    if (typeof shopId !== "string" || !shopId) return primaryAuth;
    const cached = authByShop.get(shopId);
    if (cached) return cached;
    const auth = await resolveKlaviyoAuth(shopId);
    authByShop.set(shopId, auth);
    return auth;
  };

  if (!primaryAuth.apiKey) {
    // Leave remaining rows PENDING; they flush once a key is configured
    // (Settings page or KLAVIYO_PRIVATE_API_KEY). The delivery claim below
    // must never run keyless.
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
    const auth = await authFor(row.shopId);
    if (!auth.apiKey) continue; // foreign shop without a key — leave PENDING
    let result: KlaviyoSendResult | null = null;
    let thrownMessage: string | null = null;

    try {
      result = await createKlaviyoEvent(
        {
          eventName: row.eventName,
          email: row.email,
          phone: row.phone,
          profileAttrs: (row.profileAttrs ?? {}) as Record<string, unknown>,
          properties: (row.properties ?? {}) as Record<string, unknown>,
          eventTime: row.eventTime,
        },
        auth,
      );
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
        const lastError =
          result.error ?? `Permanent failure (${result.status})`;
        await prisma.klaviyoOutbox.update({
          where: { id: row.id },
          data: {
            status: "DEAD",
            attempts: row.attempts + 1,
            lastError,
          },
        });
        stats.dead++;
        await reconcileDeadNotificationLogs([{ id: row.id, lastError }]);
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
          await reconcileDeadNotificationLogs([{ id: row.id, lastError }]);
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
