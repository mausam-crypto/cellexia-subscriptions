/**
 * Klaviyo Events API client + outbox delivery.
 *
 * Lifecycle events are NEVER sent to Klaviyo directly by other modules — they
 * call emitLifecycleEvent (services/events.server.ts), which enqueues an
 * OutboundEvent row. This module drains that outbox (processOutboxJob) with
 * retry/backoff, and exposes trackEventNow for the rare time-critical direct
 * send (the payload still carries a stable dedupe key, so Klaviyo ingestion
 * stays idempotent via `unique_id`).
 *
 * API: POST https://a.klaviyo.com/api/events/ with the `revision` header
 * "2024-10-15" and `Authorization: Klaviyo-API-Key <key>`. The key is stored
 * encrypted at rest (ShopSettings.klaviyoApiKeyEncrypted, AES-256-GCM) and
 * decrypted only at send time.
 */
import prisma from "~/db.server";
import { decryptSecret, sha256Hex } from "~/lib/crypto.server";
import { humanDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import {
  parseJson,
  type LifecycleEvent,
  type OutboxStatus,
} from "~/types/domain";

export const KLAVIYO_EVENTS_URL = "https://a.klaviyo.com/api/events/";
export const KLAVIYO_API_REVISION = "2024-10-15";
/** An outbox row is abandoned (DEAD) once it has failed this many times. */
export const MAX_OUTBOX_ATTEMPTS = 8;

const OUTBOX_BATCH_SIZE = 100;
/** While a row is being delivered its nextAttemptAt is leased forward so a
 * concurrent job run cannot pick it up. If the process dies mid-delivery the
 * lease simply expires and the row is retried (at-least-once). */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

const STATUS_PENDING: OutboxStatus = "PENDING";
const STATUS_SENT: OutboxStatus = "SENT";
const STATUS_FAILED: OutboxStatus = "FAILED";
const STATUS_DEAD: OutboxStatus = "DEAD";

// ─────────────────────────── Pure decision logic ───────────────────────────

/**
 * Map a lifecycle event name to its human Klaviyo metric:
 * "CHARGE_FAILED" -> "Cellexia Charge Failed". Covers every member of
 * LIFECYCLE_EVENTS by construction (verified exhaustively in unit tests).
 */
export function eventNameToMetric(eventName: LifecycleEvent): string {
  const words = eventName
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return `Cellexia ${words.join(" ")}`;
}

/** Exponential backoff: after the n-th failure, wait 2^n minutes. */
export function backoffMinutes(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 20));
  return Math.pow(2, exponent);
}

/** When a row that has now failed `attempts` times should be retried. */
export function computeNextAttemptAt(
  attempts: number,
  from: Date = new Date(),
): Date {
  return new Date(from.getTime() + backoffMinutes(attempts) * 60_000);
}

/** ISO-8601-looking strings ("2026-08-04", "2026-08-04T12:00:00.000Z", …). */
const ISO_DATEISH =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && ISO_DATEISH.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * Enrich an event payload for Klaviyo templates (pure — does not mutate):
 * - `portalUrl`: deep link to the customer portal (PORTAL_BASE_URL + "/portal")
 *   so every email can say "Adjust, delay or cancel online".
 * - `<field>Human` companion for every date-valued field, formatted with
 *   humanDate ("4 August") for customer-facing copy.
 */
export function enrichPayload(
  payload: Record<string, unknown>,
  portalBase: string,
): Record<string, unknown> {
  const enriched: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(payload)) {
    const date = toDate(value);
    if (date) enriched[`${key}Human`] = humanDate(date);
  }
  enriched.portalUrl = `${portalBase.replace(/\/+$/, "")}/portal`;
  return enriched;
}

export interface KlaviyoEventBody {
  data: {
    type: "event";
    attributes: {
      properties: Record<string, unknown>;
      time?: string;
      unique_id: string;
      metric: { data: { type: "metric"; attributes: { name: string } } };
      profile: { data: { type: "profile"; attributes: { email: string } } };
    };
  };
}

export interface BuildKlaviyoEventInput {
  metricName: string;
  email: string;
  payload: Record<string, unknown>;
  /** Stable key: becomes Klaviyo's `unique_id`, so redelivery of the same
   * outbox row can never double-count the event. */
  dedupeKey: string;
  /** Original occurrence time; retries keep reporting the first occurrence. */
  time?: Date | string;
}

/** Build the Klaviyo Events API request body (pure, deterministic). */
export function buildKlaviyoEventBody(
  input: BuildKlaviyoEventInput,
): KlaviyoEventBody {
  const attributes: KlaviyoEventBody["data"]["attributes"] = {
    properties: input.payload,
    unique_id: input.dedupeKey,
    metric: {
      data: { type: "metric", attributes: { name: input.metricName } },
    },
    profile: {
      data: { type: "profile", attributes: { email: input.email } },
    },
  };
  if (input.time) {
    attributes.time =
      typeof input.time === "string" ? input.time : input.time.toISOString();
  }
  return { data: { type: "event", attributes } };
}

// ─────────────────────────── Shop configuration ────────────────────────────

function portalBaseUrl(): string {
  return (
    process.env.PORTAL_BASE_URL ||
    process.env.SHOPIFY_APP_URL ||
    ""
  ).replace(/\/+$/, "");
}

interface KlaviyoConfig {
  enabled: boolean;
  apiKey: string | null;
}

async function getKlaviyoConfig(shop: string): Promise<KlaviyoConfig> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  if (!settings?.klaviyoEnabled || !settings.klaviyoApiKeyEncrypted) {
    return { enabled: false, apiKey: null };
  }
  try {
    return { enabled: true, apiKey: decryptSecret(settings.klaviyoApiKeyEncrypted) };
  } catch (e) {
    logger.error("klaviyo key decryption failed", {
      shop,
      error: e instanceof Error ? e.message : String(e),
    });
    return { enabled: false, apiKey: null };
  }
}

/** Is Klaviyo delivery configured and switched on for this shop? */
export async function klaviyoEnabled(shop: string): Promise<boolean> {
  return (await getKlaviyoConfig(shop)).enabled;
}

// ─────────────────────────── HTTP delivery ─────────────────────────────────

interface SendResult {
  ok: boolean;
  status: number;
  errorText?: string;
}

async function sendToKlaviyo(
  apiKey: string,
  body: KlaviyoEventBody,
): Promise<SendResult> {
  const response = await fetch(KLAVIYO_EVENTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      revision: KLAVIYO_API_REVISION,
      "Content-Type": "application/json",
      Accept: "application/vnd.api+json",
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, status: response.status };
  const text = await response.text().catch(() => "");
  return {
    ok: false,
    status: response.status,
    errorText: `HTTP ${response.status}: ${text.slice(0, 400)}`,
  };
}

function truncateError(message: string): string {
  const text = message || "delivery failed";
  return text.length > 500 ? text.slice(0, 500) : text;
}

// ─────────────────────────── Direct send (time-critical) ───────────────────

export interface TrackEventNowInput {
  eventName: LifecycleEvent;
  email: string;
  payload?: Record<string, unknown>;
  /** Stable id for Klaviyo-side dedupe; defaults to a hash of the inputs. */
  dedupeKey?: string;
}

export interface TrackEventNowResult {
  delivered: boolean;
  status?: number;
  error?: string;
}

/**
 * Send a single event to Klaviyo immediately (bypassing the outbox). Reserve
 * for time-critical sends (e.g. magic-link sign-in); everything else should go
 * through emitLifecycleEvent + processOutboxJob.
 */
export async function trackEventNow(
  shop: string,
  input: TrackEventNowInput,
): Promise<TrackEventNowResult> {
  const config = await getKlaviyoConfig(shop);
  if (!config.enabled || !config.apiKey) {
    return { delivered: false, error: "klaviyo disabled" };
  }

  const payload = input.payload ?? {};
  const dedupeKey =
    input.dedupeKey ??
    sha256Hex(
      [shop, input.eventName, input.email, JSON.stringify(payload)].join("|"),
    );
  const body = buildKlaviyoEventBody({
    metricName: eventNameToMetric(input.eventName),
    email: input.email,
    payload: enrichPayload(payload, portalBaseUrl()),
    dedupeKey,
    time: new Date(),
  });

  try {
    const result = await sendToKlaviyo(config.apiKey, body);
    if (!result.ok) {
      logger.warn("klaviyo trackEventNow rejected", {
        shop,
        eventName: input.eventName,
        status: result.status,
      });
      return {
        delivered: false,
        status: result.status,
        error: result.errorText ?? "delivery failed",
      };
    }
    return { delivered: true, status: result.status };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn("klaviyo trackEventNow error", {
      shop,
      eventName: input.eventName,
      error: message,
    });
    return { delivered: false, error: message };
  }
}

// ─────────────────────────── Outbox delivery job ───────────────────────────

export interface OutboxRunSummary {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
}

async function markDead(
  rowId: string,
  shop: string,
  eventName: string,
  reason: string,
  attempts?: number,
): Promise<void> {
  await prisma.outboundEvent.update({
    where: { id: rowId },
    data: {
      status: STATUS_DEAD,
      lastError: truncateError(reason),
      ...(attempts !== undefined ? { attempts } : {}),
    },
  });
  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "outbox.event_dead",
    subjectType: "OutboundEvent",
    subjectId: rowId,
    payload: { eventName, reason: truncateError(reason) },
  });
}

/**
 * Drain the Klaviyo outbox: claim due PENDING/FAILED rows
 * (nextAttemptAt <= now, attempts < MAX_OUTBOX_ATTEMPTS), deliver each, and
 * mark SENT (with sentAt) or FAILED with exponential backoff (2^attempts
 * minutes); rows are DEAD after 8 failed attempts. Rows for shops without
 * Klaviyo configured are marked DEAD with lastError "klaviyo disabled".
 *
 * Registered in the jobs registry as `outbox` (POST /jobs/outbox).
 */
export async function processOutboxJob(shop?: string): Promise<OutboxRunSummary> {
  const now = new Date();
  const candidates = await prisma.outboundEvent.findMany({
    where: {
      ...(shop ? { shop } : {}),
      destination: "KLAVIYO",
      status: { in: [STATUS_PENDING, STATUS_FAILED] },
      nextAttemptAt: { lte: now },
      attempts: { lt: MAX_OUTBOX_ATTEMPTS },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: OUTBOX_BATCH_SIZE,
  });

  const summary: OutboxRunSummary = { claimed: 0, sent: 0, failed: 0, dead: 0 };
  const perShop = new Map<string, { sent: number; failed: number; dead: number }>();
  const configCache = new Map<string, KlaviyoConfig>();
  const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
  const portalBase = portalBaseUrl();

  for (const row of candidates) {
    // Optimistic claim: only one concurrent runner wins the lease.
    const claim = await prisma.outboundEvent.updateMany({
      where: {
        id: row.id,
        status: { in: [STATUS_PENDING, STATUS_FAILED] },
        nextAttemptAt: { lte: now },
      },
      data: { nextAttemptAt: leaseUntil },
    });
    if (claim.count !== 1) continue;
    summary.claimed += 1;

    let tally = perShop.get(row.shop);
    if (!tally) {
      tally = { sent: 0, failed: 0, dead: 0 };
      perShop.set(row.shop, tally);
    }

    let config = configCache.get(row.shop);
    if (!config) {
      config = await getKlaviyoConfig(row.shop);
      configCache.set(row.shop, config);
    }

    if (!config.enabled || !config.apiKey) {
      await markDead(row.id, row.shop, row.eventName, "klaviyo disabled");
      summary.dead += 1;
      tally.dead += 1;
      continue;
    }
    if (!row.profileEmail) {
      await markDead(row.id, row.shop, row.eventName, "missing profile email");
      summary.dead += 1;
      tally.dead += 1;
      continue;
    }

    const properties = enrichPayload(
      parseJson<Record<string, unknown>>(row.payloadJson, {}),
      portalBase,
    );
    const body = buildKlaviyoEventBody({
      metricName: eventNameToMetric(row.eventName as LifecycleEvent),
      email: row.profileEmail,
      payload: properties,
      dedupeKey: row.dedupeKey,
      time: row.createdAt,
    });

    let delivered = false;
    let errorText = "";
    try {
      const result = await sendToKlaviyo(config.apiKey, body);
      delivered = result.ok;
      if (!result.ok) errorText = result.errorText ?? "delivery failed";
    } catch (e) {
      errorText = e instanceof Error ? e.message : String(e);
    }

    if (delivered) {
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { status: STATUS_SENT, sentAt: new Date(), lastError: null },
      });
      summary.sent += 1;
      tally.sent += 1;
    } else {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await markDead(row.id, row.shop, row.eventName, errorText, attempts);
        summary.dead += 1;
        tally.dead += 1;
      } else {
        await prisma.outboundEvent.update({
          where: { id: row.id },
          data: {
            status: STATUS_FAILED,
            attempts,
            lastError: truncateError(errorText),
            nextAttemptAt: computeNextAttemptAt(attempts, new Date()),
          },
        });
        summary.failed += 1;
        tally.failed += 1;
      }
    }
  }

  for (const [shopDomain, tally] of perShop) {
    await appendAudit({
      shop: shopDomain,
      actorType: "SYSTEM",
      action: "outbox.processed",
      payload: { sent: tally.sent, failed: tally.failed, dead: tally.dead },
    });
  }

  logger.info("outbox run complete", { shop: shop ?? "all", ...summary });
  return summary;
}
