import type { Shop } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting } from "~/lib/settings/settings.server";
import { OURS_ONLY } from "~/lib/ownership/ownership.server";
import { addDaysTz, formatShopDate, shopDayStartUtc } from "~/lib/dates.server";
import {
  DEFAULT_REPLY_PROMISE,
  resolveReplyPromise,
  type ReplyPromise,
} from "~/lib/support/channels.server";
import { readReplyPromise, supportReplyPromise } from "~/lib/support/reply-promise.server";
import { getPrimaryShop } from "~/lib/shop/install.server";
import { CANCEL_SCHEDULED, SAVED_PENDING } from "./config.server";

/**
 * Scheduled cancellation + concierge follow-through (v1.28.0, P3.7 / P3.8).
 *
 * ── Scheduled cancel (locked contracts) ─────────────────────────────────────
 * `scheduleCancel` (engine.server.ts) stamps `cancelScheduledAt` = the plan
 * lock window's unlock moment. From then on:
 *  - the billing sweep never bills a contract whose scheduled moment has
 *    passed (`cancelScheduledAt <= now` is excluded from the due query —
 *    scheduler.server.ts), so a charge can never land after the customer's
 *    chosen end even if this job is late;
 *  - `runScheduledCancels` (hourly, `cancel_scheduled_run`) sends the
 *    cancel_upcoming email `cancelFlow.scheduledCancelNoticeDays` before the
 *    moment (once — NotificationLog dedupe) with a one-tap KEEP magic link,
 *    then completes every due cancel through the normal `cancelContract`
 *    path (source CUSTOMER_PORTAL, cancelSource CUSTOMER, the reason the
 *    session recorded). Each row is RE-READ right before cancelling: a
 *    contract the customer kept (cancelScheduledAt cleared — portal button,
 *    KEEP verb, admin) is never cancelled, whatever the candidate scan saw.
 *  - `cancelContract` clears `cancelScheduledAt`; a whole-order skip or a
 *    pause leaves it standing (the decision was to end, not to move).
 *
 * ── Concierge SLA (P3.7) ─────────────────────────────────────────────────────
 * `runConciergeSla` (every 10 minutes, `concierge_sla_run`): a SUPPORT_REQUEST
 * alert carrying `saveRequest: true` that is still unresolved past the reply
 * promise (`support.replyWithinValue/Unit/alwaysOn`, v1.29.0 — minutes and
 * hours on the wall clock, weekends skipped unless alwaysOn; business days
 * Mon–Fri) raises ONE SUPPORT_SLA_BREACH alert per request (CRITICAL — the
 * customer was told "a human replies within 30 minutes, 24/7" and is one
 * broken promise from cancelling; dedupe on requestAlertId). The 10-minute
 * cadence exists for that default: an hourly tick would notice a 30-minute
 * breach up to an hour late. Once the merchant
 * resolves the request alert while the contract still lives, the session's
 * SAVED_PENDING is promoted to SAVED (a soft save becomes a save when the
 * human actually answered) — `cancel.save_confirmed` is logged.
 *
 * Every step is contained; nothing here can break billing.
 */

const DAY_MS = 86_400_000;
/** cancel_upcoming never follows a cancel_scheduled younger than this. */
const UPCOMING_MIN_AGE_MS = 24 * 3600_000;
/** SUPPRESSED reasons that may clear on a later run (never dedupe on them). */
const TRANSIENT_SUPPRESS_REASONS: ReadonlySet<string> = new Set([
  "foreign_contract",
  "setup_mode",
]);

// ── Emails ───────────────────────────────────────────────────────────────────

/** Fallback for an unreadable settings row — the merchant value is
 * cancelFlow.keepLinkTtlDays (golden rule 7). */
const KEEP_LINK_TTL_DAYS_DEFAULT = 60;

async function keepUrlFor(contract: {
  id: string;
  customerId: string;
  email: string;
  shopId?: string;
}): Promise<string | null> {
  try {
    let ttlDays = KEEP_LINK_TTL_DAYS_DEFAULT;
    if (contract.shopId) {
      try {
        ttlDays =
          (await getSetting(contract.shopId, "cancelFlow") as { keepLinkTtlDays?: number })
            .keepLinkTtlDays ?? KEEP_LINK_TTL_DAYS_DEFAULT;
      } catch (err) {
        console.error("[cancel] KEEP link ttl: settings read failed", contract.id, err);
      }
    }
    const { buildMagicUrl } = await import("~/lib/magiclinks/builder.server");
    return await buildMagicUrl({
      action: "KEEP_SUBSCRIPTION",
      contractId: contract.id,
      customerId: contract.customerId,
      email: contract.email,
      ttlSeconds: ttlDays * 24 * 3600,
      // A customer who taps it twice (or after the job already ran) must
      // land on an honest page, not a dead link.
      maxUses: 5,
      createdVia: "cancel_scheduled",
    });
  } catch (err) {
    console.error("[cancel] KEEP link mint failed", contract.id, err);
    return null;
  }
}

/** The moment-of-scheduling confirmation (sent by scheduleCancel, contained). */
export async function sendCancelScheduledEmail(
  shop: Pick<Shop, "id" | "ianaTimezone">,
  contract: { id: string; customerId: string; email: string; locale: string | null },
  scheduledAt: Date,
): Promise<void> {
  const { sendNotification } = await import("~/lib/notifications/send.server");
  const keepUrl = await keepUrlFor({ ...contract, shopId: shop.id });
  await sendNotification({
    shopId: shop.id,
    contractId: contract.id,
    template: "cancel_scheduled",
    locale: contract.locale,
    vars: {
      cancel_date: formatShopDate(scheduledAt, shop.ianaTimezone, contract.locale ?? undefined),
      cancel_date_iso: scheduledAt.toISOString(),
      ...(keepUrl ? { keep_url: keepUrl, cta_url: keepUrl } : {}),
    },
  });
}

// ── Job: scheduled cancels ───────────────────────────────────────────────────

export interface ScheduledCancelStats {
  scanned: number;
  noticesSent: number;
  cancelled: number;
  keptSinceScan: number;
  errors: number;
  skipped?: string;
}

/**
 * Hourly job body (`cancel_scheduled_run`). Exported for tests. `now` is the
 * only clock — the sweep never bills past `cancelScheduledAt`, so a late run
 * only delays the goodbye email, never a charge.
 */
export async function runScheduledCancels(
  now: Date = new Date(),
): Promise<ScheduledCancelStats> {
  const stats: ScheduledCancelStats = {
    scanned: 0,
    noticesSent: 0,
    cancelled: 0,
    keptSinceScan: 0,
    errors: 0,
  };
  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  const tz = shop.ianaTimezone;

  let noticeDays = 3;
  try {
    noticeDays =
      (await getSetting(shop.id, "cancelFlow") as { scheduledCancelNoticeDays?: number })
        .scheduledCancelNoticeDays ?? 3;
  } catch (err) {
    console.error("[cancel] scheduled: settings read failed", err);
  }

  const candidates = await prisma.subscriptionContract.findMany({
    where: {
      shopId: shop.id,
      ...OURS_ONLY,
      isDemo: false,
      // FAILED too: a contract dunning exhausted before its scheduled moment
      // must still end on the day the customer was told (cancelContract
      // closes the dunning case; nothing bills a FAILED contract anyway).
      status: { in: ["ACTIVE", "PAUSED", "FAILED"] },
      cancelScheduledAt: { not: null },
    },
    orderBy: { cancelScheduledAt: "asc" },
    select: { id: true },
    take: 500,
  });

  for (const candidate of candidates) {
    stats.scanned += 1;
    try {
      // ── Upcoming notice ──────────────────────────────────────────────────
      const c = await prisma.subscriptionContract.findUnique({
        where: { id: candidate.id },
        select: {
          id: true,
          customerId: true,
          email: true,
          locale: true,
          status: true,
          cancelScheduledAt: true,
        },
      });
      if (!c?.cancelScheduledAt || c.status === "CANCELLED") continue;
      const scheduledAt = c.cancelScheduledAt;

      if (
        scheduledAt.getTime() > now.getTime() &&
        scheduledAt.getTime() - now.getTime() <= noticeDays * DAY_MS
      ) {
        // Once per scheduling: a KEEP followed by a fresh schedule gets a
        // fresh notice (dedupe window starts at the newest cancel.scheduled).
        const scheduledEvent = await prisma.subscriberEvent.findFirst({
          where: { contractId: c.id, type: "cancel.scheduled" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        // Scheduled less than a day ago (a lock ending inside the notice
        // window): cancel_scheduled just went out with the same KEEP link —
        // a second near-identical email an hour later helps nobody.
        if (
          scheduledEvent &&
          now.getTime() - scheduledEvent.createdAt.getTime() < UPCOMING_MIN_AGE_MS
        ) {
          continue;
        }
        // Dedupe on SENT and on non-transient SUPPRESSED (template disabled,
        // channel off…) — mirrors subscription-started: an hourly re-attempt
        // for the whole notice window would only pile up SUPPRESSED rows.
        const priorRows = await prisma.notificationLog.findMany({
          where: {
            contractId: c.id,
            template: "cancel_upcoming",
            status: { in: ["SENT", "SUPPRESSED"] },
            ...(scheduledEvent ? { createdAt: { gte: scheduledEvent.createdAt } } : {}),
          },
          select: { status: true, payload: true },
        });
        const alreadySent = priorRows.some((row) => {
          if (row.status === "SENT") return true;
          const reason = (row.payload as { reason?: unknown } | null)?.reason;
          return typeof reason !== "string" || !TRANSIENT_SUPPRESS_REASONS.has(reason);
        });
        if (!alreadySent) {
          const { sendNotification } = await import("~/lib/notifications/send.server");
          const keepUrl = await keepUrlFor({ ...c, shopId: shop.id });
          const result = await sendNotification({
            shopId: shop.id,
            contractId: c.id,
            template: "cancel_upcoming",
            locale: c.locale,
            vars: {
              cancel_date: formatShopDate(scheduledAt, tz, c.locale ?? undefined),
              cancel_date_iso: scheduledAt.toISOString(),
              ...(keepUrl ? { keep_url: keepUrl, cta_url: keepUrl } : {}),
            },
          });
          if (result.status === "SENT") stats.noticesSent += 1;
        }
        continue;
      }

      if (scheduledAt.getTime() > now.getTime()) continue;

      // ── Due: cancel through the normal path ──────────────────────────────
      // Fresh read under the job lock, immediately before the mutation: the
      // customer may have kept the subscription since the candidate scan
      // (portal, KEEP link, admin) — a cleared column means NO cancel.
      const fresh = await prisma.subscriptionContract.findUnique({
        where: { id: c.id },
        select: { cancelScheduledAt: true, status: true },
      });
      if (
        !fresh?.cancelScheduledAt ||
        fresh.cancelScheduledAt.getTime() > now.getTime() ||
        fresh.status === "CANCELLED"
      ) {
        if (!fresh?.cancelScheduledAt) stats.keptSinceScan += 1;
        continue;
      }
      const session = await prisma.cancelSession.findFirst({
        where: { contractId: c.id, outcome: CANCEL_SCHEDULED },
        orderBy: { completedAt: "desc" },
        select: { id: true, reason: true },
      });
      const { cancelContract } = await import("~/lib/contracts/service.server");
      await cancelContract(shop.domain, c.id, session?.reason ?? "OTHER", {
        source: "CUSTOMER_PORTAL",
        actor: "customer",
        cancelSource: "CUSTOMER",
      });
      stats.cancelled += 1;
      // The session's terminal outcome: an executed schedule IS a cancel
      // (admin funnel + insights denominator); the event below keeps
      // `scheduled: true`. Contained — the cancel already happened.
      if (session) {
        try {
          await prisma.cancelSession.updateMany({
            where: { id: session.id, outcome: CANCEL_SCHEDULED },
            data: { outcome: "CANCELLED", completedAt: now },
          });
        } catch (err) {
          console.error("[cancel] scheduled: session close failed", session.id, err);
        }
      }
      await logEvent({
        shopId: shop.id,
        contractId: c.id,
        customerId: c.customerId,
        email: c.email,
        type: "cancel.completed",
        source: "CUSTOMER_PORTAL",
        actor: "customer",
        payload: {
          sessionId: session?.id ?? null,
          reason: session?.reason ?? "OTHER",
          scheduled: true,
          scheduledAt: scheduledAt.toISOString(),
          executedBy: "cancel_scheduled_run",
        },
      });
    } catch (err) {
      stats.errors += 1;
      console.error("[cancel] scheduled cancel failed", candidate.id, err);
    }
  }
  return stats;
}

// ── Job: concierge SLA + promotion ───────────────────────────────────────────

export interface ConciergeSlaStats {
  checked: number;
  breaches: number;
  promoted: number;
  errors: number;
  skipped?: string;
}

/**
 * Whole business days (Mon–Fri) elapsed between two instants, counted in
 * the shop timezone: the SLA promise "we reply within N business days" is
 * breached when this exceeds N. Pure — exported for tests. Weekends are the
 * only non-business days (public holidays are not modelled).
 */
export function businessDaysBetween(from: Date, to: Date, tz: string): number {
  if (to.getTime() <= from.getTime()) return 0;
  const dayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  const weekdayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  let count = 0;
  let cursor = new Date(from.getTime());
  const endDay = dayOf(to);
  // Walk day by day from the day AFTER `from` up to and including `to`'s day.
  for (let i = 0; i < 400; i += 1) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (dayOf(cursor) > endDay) break;
    const wd = weekdayOf(cursor);
    if (wd !== "Sat" && wd !== "Sun") count += 1;
    if (dayOf(cursor) === endDay) break;
  }
  return count;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Wall-clock milliseconds between two instants that fall on Mon–Fri in the
 * shop timezone (weekend time does not count against a promise that is not
 * 24/7). Walks shop-day segments — bounded by the 60-day alert window.
 */
export function weekdayMsBetween(from: Date, to: Date, tz: string): number {
  if (to.getTime() <= from.getTime()) return 0;
  const weekdayOf = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  let total = 0;
  let cursor = from;
  for (let i = 0; i < 400 && cursor.getTime() < to.getTime(); i += 1) {
    const nextDayStart = addDaysTz(shopDayStartUtc(cursor, tz), 1, tz);
    const segEnd = nextDayStart.getTime() < to.getTime() ? nextDayStart : to;
    const wd = weekdayOf(cursor);
    if (wd !== "Sat" && wd !== "Sun") total += segEnd.getTime() - cursor.getTime();
    cursor = segEnd;
  }
  return total;
}

export interface ReplyPromiseElapsed {
  /** The promise is exceeded. */
  breached: boolean;
  /** Honest, human "unanswered for …" label (admin alert copy). */
  label: string;
  /** Wall-clock (or weekday-only when not 24/7) ms — minutes/hours units. */
  elapsedMs: number;
  /** Whole business days — business_days unit (0 otherwise). */
  elapsedBusinessDays: number;
}

/** "45 min" / "2 h 15 min" / "3 d 4 h" — admin-facing elapsed label. */
export function formatElapsed(ms: number): string {
  const totalMin = Math.floor(ms / MINUTE_MS);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${min} min`;
  return `${min} min`;
}

/**
 * Pure: has the reply promise been broken for a request made at `from`?
 * minutes/hours = wall clock (weekends skipped unless alwaysOn);
 * business_days = whole Mon–Fri days in the shop timezone (existing logic).
 * Exported for tests.
 */
export function replyPromiseElapsed(
  from: Date,
  now: Date,
  tz: string,
  promise: ReplyPromise,
): ReplyPromiseElapsed {
  if (promise.unit === "business_days") {
    const elapsedBusinessDays = businessDaysBetween(from, now, tz);
    return {
      breached: elapsedBusinessDays > promise.value,
      label: `${elapsedBusinessDays} business day(s)`,
      elapsedMs: Math.max(0, now.getTime() - from.getTime()),
      elapsedBusinessDays,
    };
  }
  const elapsedMs = promise.alwaysOn
    ? Math.max(0, now.getTime() - from.getTime())
    : weekdayMsBetween(from, now, tz);
  const limitMs = promise.value * (promise.unit === "minutes" ? MINUTE_MS : HOUR_MS);
  return {
    breached: elapsedMs > limitMs,
    label: formatElapsed(elapsedMs),
    elapsedMs,
    elapsedBusinessDays: 0,
  };
}

/** Job body (`concierge_sla_run`, every 10 minutes). Exported for tests. */
export async function runConciergeSla(now: Date = new Date()): Promise<ConciergeSlaStats> {
  const stats: ConciergeSlaStats = { checked: 0, breaches: 0, promoted: 0, errors: 0 };
  const shop = await getPrimaryShop();
  if (!shop) {
    stats.skipped = "no_shop";
    return stats;
  }
  // The CURRENT promise — the fallback for requests recorded before the
  // alert context carried `replyWithin` (pre-1.29.0 rows).
  let currentPromise: ReplyPromise = DEFAULT_REPLY_PROMISE;
  try {
    currentPromise = resolveReplyPromise(await getSetting(shop.id, "support"));
  } catch (err) {
    console.error("[cancel] concierge: support settings read failed", err);
  }

  const alerts = await prisma.alert.findMany({
    where: {
      shopId: shop.id,
      type: "SUPPORT_REQUEST",
      createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) },
      context: { path: ["saveRequest"], equals: true },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  for (const alert of alerts) {
    stats.checked += 1;
    try {
      const ctx = (alert.context ?? {}) as {
        contractId?: unknown;
        cancelSessionId?: unknown;
        cancelReason?: unknown;
        replyWithin?: unknown;
      };
      const contractId = typeof ctx.contractId === "string" ? ctx.contractId : null;
      const sessionId = typeof ctx.cancelSessionId === "string" ? ctx.cancelSessionId : null;
      if (!contractId) continue;

      if (alert.resolvedAt == null) {
        // ── SLA breach ────────────────────────────────────────────────────
        // Judge against the promise the customer READ (recorded on the
        // request alert by submitSupportRequest); a merchant editing the
        // setting afterwards neither silences nor invents breaches.
        const promise = readReplyPromise(ctx.replyWithin) ?? currentPromise;
        const elapsed = replyPromiseElapsed(alert.createdAt, now, shop.ianaTimezone, promise);
        if (!elapsed.breached) continue;
        const { raiseAlert } = await import("~/lib/analytics/alerts.server");
        // dedupe on requestAlertId ⇒ at most ONE breach alert per request,
        // however many ticks see it unanswered.
        const raised = await raiseAlert({
          shopId: shop.id,
          type: "SUPPORT_SLA_BREACH",
          severity: "CRITICAL",
          message: `A cancel-flow save request is unanswered for ${elapsed.label} (promise: ${supportReplyPromise("en", promise)}). The customer stayed on the promise of a reply — answer it now: /app/subscribers/${contractId}`,
          context: {
            contractId,
            subscriberUrl: `/app/subscribers/${contractId}`,
            requestAlertId: alert.id,
            ...(sessionId ? { cancelSessionId: sessionId } : {}),
            ...(typeof ctx.cancelReason === "string" ? { cancelReason: ctx.cancelReason } : {}),
            replyWithin: promise,
            elapsedMs: elapsed.elapsedMs,
            elapsedLabel: elapsed.label,
            ...(promise.unit === "business_days"
              ? { elapsedBusinessDays: elapsed.elapsedBusinessDays }
              : {}),
          },
          dedupe: { key: "requestAlertId", value: alert.id, since: alert.createdAt },
        });
        if (raised) stats.breaches += 1;
        continue;
      }

      // ── Answered: promote SAVED_PENDING → SAVED while the contract lives ──
      if (!sessionId) continue;
      const contract = await prisma.subscriptionContract.findUnique({
        where: { id: contractId },
        select: { id: true, shopId: true, customerId: true, email: true, status: true },
      });
      if (!contract || contract.status === "CANCELLED") continue;
      const promoted = await prisma.cancelSession.updateMany({
        where: { id: sessionId, outcome: SAVED_PENDING },
        data: { outcome: "SAVED" },
      });
      if (promoted.count === 0) continue;
      stats.promoted += 1;
      await logEvent({
        shopId: contract.shopId,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "cancel.save_confirmed",
        source: "SYSTEM",
        actor: "concierge_sla_run",
        payload: {
          sessionId,
          saveKind: "SUPPORT",
          requestAlertId: alert.id,
          answeredAt: alert.resolvedAt.toISOString(),
        },
      });
    } catch (err) {
      stats.errors += 1;
      console.error("[cancel] concierge sla check failed", alert.id, err);
    }
  }
  return stats;
}
