/**
 * [retention] Dunning — decline-aware payment recovery.
 *
 * Pure decision logic (exported for unit tests, no I/O):
 *   - categorizeDeclineCode: processor error code → DeclineCategory
 *   - strategyFor: category (+ high-value flag) → DunningStep[]
 *   - nextLikelySalaryDate / snapRetryToLikelySalary: 1st/15th salary snap
 *   - isHighValueContract
 *
 * Orchestration:
 *   - onBillingFailure / onBillingSuccess: state + schedule only. The
 *     customer-facing CHARGE_FAILED emission for the *initial* failure is
 *     core's job (webhook handler); here we only maintain the DunningState
 *     that drives the portal banner and the retry queue.
 *   - runDunningQueueJob: executes due steps (retry / email / sms / pause /
 *     cancel), never beyond the strategy length → EXHAUSTED. Optimistic
 *     concurrency: every state write is guarded on the phase AND the
 *     updatedAt snapshot, so a SUCCESS webhook landing mid-run can never be
 *     overwritten back into RETRYING (which used to re-charge paid cycles).
 *   - runPreDunningJob: card-expiry warnings before the next charge.
 *
 * Retry-offset precedence (LEARNING-DATA-V2 §3):
 *   merchant settingsJson.dunningOverrides[category]  (explicit, 1..30 days,
 *   max 4)  >  learned offsets (analytics/learning.server ModelState)  >
 *   the static STRATEGIES table.
 */
import prisma from "~/db.server";
import { addDays, daysBetween, humanDate, isoDate } from "~/lib/dates";
import { logger } from "~/lib/logger.server";
import { appendAudit } from "~/services/audit.server";
import { emitLifecycleEvent } from "~/services/events.server";
import { withIdempotency } from "~/services/idempotency.server";
import {
  getOfflineAdmin,
  ShopifyGraphqlError,
} from "~/services/core/shopifyClient.server";
import { createBillingAttempt } from "~/services/core/billing.server";
import {
  AlreadyPausedError,
  cancelContract,
  pauseUntil,
  sendPaymentUpdateEmail,
} from "~/services/core/contracts.server";
import { getLearnedDunningOffsets } from "~/services/analytics/learning.server";
import { parseJson } from "~/types/domain";
import type { DeclineCategory, DunningStep } from "~/types/domain";

// ─────────────────────────── Pure: decline taxonomy ───────────────────────

/**
 * Map a raw processor decline code onto our seven categories. Matching is
 * case-insensitive and substring-based; specific signals are checked before
 * generic card_declined-style codes. Unknown or missing codes are treated as
 * GENERIC_DECLINE (safe default: cautious spaced retries).
 */
export function categorizeDeclineCode(code: string | null): DeclineCategory {
  const c = (code ?? "").toLowerCase();
  if (!c) return "GENERIC_DECLINE";

  if (c.includes("insufficient")) return "INSUFFICIENT_FUNDS";
  if (c.includes("expired")) return "EXPIRED_CARD";
  if (c.includes("lost") || c.includes("stolen") || c.includes("pickup")) {
    return "LOST_OR_STOLEN";
  }
  if (
    c.includes("processing_error") ||
    c.includes("try_again") ||
    c.includes("issuer_unavailable") ||
    c.includes("timeout")
  ) {
    return "PROCESSOR_ERROR";
  }
  if (
    c.includes("authentication") ||
    c.includes("sca") ||
    c.includes("three_d") ||
    c.includes("3ds")
  ) {
    return "AUTHENTICATION_REQUIRED";
  }
  if (
    c.includes("invalid_account") ||
    c.includes("account_closed") ||
    c.includes("invalid_number") ||
    c.includes("incorrect_number") ||
    c.includes("no_account") ||
    c.includes("permanent")
  ) {
    return "PERMANENT_FAILURE";
  }
  // card_declined, generic_decline, do_not_honor, anything unrecognised.
  return "GENERIC_DECLINE";
}

// ─────────────────────────── Pure: salary snapping ────────────────────────

/**
 * Next likely salary date strictly after `from`: most subscribers are paid on
 * the 1st or the 15th of the month (UTC).
 */
export function nextLikelySalaryDate(from: Date): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const candidates = [
    new Date(Date.UTC(y, m, 1)),
    new Date(Date.UTC(y, m, 15)),
    new Date(Date.UTC(y, m + 1, 1)),
    new Date(Date.UTC(y, m + 1, 15)),
  ];
  for (const c of candidates) {
    if (c.getTime() > from.getTime()) return c;
  }
  return new Date(Date.UTC(y, m + 2, 1));
}

/** Snap window: retries landing within ±3 days of a payday move onto it. */
const SALARY_SNAP_WINDOW_DAYS = 3;

/**
 * If a candidate retry lands near the next likely salary date, charge the day
 * AFTER the salary date instead (funds have just arrived). Otherwise keep the
 * candidate unchanged.
 */
export function snapRetryToLikelySalary(candidate: Date, from: Date): Date {
  const salary = nextLikelySalaryDate(from);
  const dayAfterSalary = addDays(salary, 1);
  if (Math.abs(daysBetween(candidate, dayAfterSalary)) <= SALARY_SNAP_WINDOW_DAYS) {
    return dayAfterSalary;
  }
  return candidate;
}

// ─────────────────────────── Pure: strategies ─────────────────────────────

/**
 * High-value heuristic: subscribers who have already paid ≥ €250 or whose
 * expected LTV is ≥ €600 get extra grace before any PAUSE/CANCEL step.
 */
export function isHighValueContract(contract: {
  totalRevenueCents: number;
  expectedLtvCents: number | null;
}): boolean {
  return (
    contract.totalRevenueCents >= 25_000 ||
    (contract.expectedLtvCents ?? 0) >= 60_000
  );
}

/**
 * Per-category sequences. `afterDays` is relative to the PREVIOUS step (see
 * DunningStep). Cumulative retry offsets:
 *   INSUFFICIENT_FUNDS  → retries on day 3 / 5 / 7 (salary-snapped at
 *                         scheduling time via snapRetryToLikelySalary)
 *   EXPIRED_CARD        → no blind retries: update email + SMS, then a single
 *                         retry after the payment-method update window
 *   LOST_OR_STOLEN      → NEVER retried; immediate payment-update request
 *   PROCESSOR_ERROR     → quick retries at +6h and +24h
 *   AUTHENTICATION_REQUIRED → authentication link first, retry after
 *   GENERIC_DECLINE     → retries on day 2 / 4 / 8
 *   PERMANENT_FAILURE   → no retry: grace, then pause
 */
const STRATEGIES: Record<DeclineCategory, DunningStep[]> = {
  INSUFFICIENT_FUNDS: [
    { afterDays: 0, action: "EMAIL", template: "dunning-funds-notice" },
    { afterDays: 3, action: "RETRY" }, // day 3
    { afterDays: 0, action: "EMAIL", template: "dunning-funds-update-1" },
    { afterDays: 2, action: "RETRY" }, // day 5
    { afterDays: 0, action: "EMAIL", template: "dunning-funds-update-2" },
    { afterDays: 2, action: "RETRY" }, // day 7
    { afterDays: 1, action: "EMAIL", template: "dunning-funds-final" },
    { afterDays: 3, action: "PAUSE" },
  ],
  EXPIRED_CARD: [
    { afterDays: 0, action: "EMAIL", template: "dunning-card-expired" },
    { afterDays: 1, action: "SMS", template: "dunning-card-expired-sms" },
    { afterDays: 4, action: "RETRY" }, // single retry after the update window
    { afterDays: 2, action: "EMAIL", template: "dunning-card-expired-final" },
    { afterDays: 5, action: "PAUSE" },
  ],
  GENERIC_DECLINE: [
    { afterDays: 0, action: "EMAIL", template: "dunning-generic-notice" },
    { afterDays: 2, action: "RETRY" }, // day 2
    { afterDays: 2, action: "RETRY" }, // day 4
    { afterDays: 0, action: "EMAIL", template: "dunning-generic-update" },
    { afterDays: 4, action: "RETRY" }, // day 8
    { afterDays: 2, action: "EMAIL", template: "dunning-generic-final" },
    { afterDays: 3, action: "PAUSE" },
  ],
  LOST_OR_STOLEN: [
    { afterDays: 0, action: "EMAIL", template: "dunning-new-card-request" },
    { afterDays: 2, action: "SMS", template: "dunning-new-card-sms" },
    { afterDays: 5, action: "EMAIL", template: "dunning-new-card-final" },
    { afterDays: 3, action: "PAUSE" },
    { afterDays: 30, action: "CANCEL" },
  ],
  PROCESSOR_ERROR: [
    { afterDays: 0.25, action: "RETRY" }, // +6 hours
    { afterDays: 0.75, action: "RETRY" }, // +24 hours cumulative
    { afterDays: 0, action: "EMAIL", template: "dunning-processor-notice" },
    { afterDays: 3, action: "RETRY" },
    { afterDays: 4, action: "PAUSE" },
  ],
  AUTHENTICATION_REQUIRED: [
    { afterDays: 0, action: "EMAIL", template: "dunning-auth-link" },
    { afterDays: 2, action: "RETRY" },
    { afterDays: 0, action: "EMAIL", template: "dunning-auth-reminder" },
    { afterDays: 3, action: "RETRY" },
    { afterDays: 5, action: "PAUSE" },
  ],
  PERMANENT_FAILURE: [
    { afterDays: 0, action: "EMAIL", template: "dunning-method-invalid" },
    { afterDays: 7, action: "EMAIL", template: "dunning-method-grace" },
    { afterDays: 7, action: "PAUSE" },
    { afterDays: 30, action: "CANCEL" },
  ],
};

/** Extra grace step inserted for high-value subscribers. */
const HIGH_VALUE_GRACE_STEP: DunningStep = {
  afterDays: 7,
  action: "EMAIL",
  template: "dunning-grace-extension",
};

/** Default extra grace days for high-value subscribers (merchant-tunable
 *  via ShopSettings.settingsJson.highValueGraceDays). */
const DEFAULT_HIGH_VALUE_GRACE_DAYS = 7;

/** Merchant/learned offset bounds: whole days, 1..30, at most 4 retries. */
export const RETRY_OFFSET_MIN_DAYS = 1;
export const RETRY_OFFSET_MAX_DAYS = 30;
export const MAX_RETRY_OFFSETS = 4;

/**
 * PURE — validate a raw settingsJson.dunningOverrides value into clean
 * per-category retry offsets: whole days in [1..30], deduped, ascending, max
 * 4 per category. Anything malformed is dropped (never guessed).
 */
export function parseDunningOverrides(
  raw: unknown,
): Partial<Record<string, number[]>> {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Partial<Record<string, number[]>> = {};
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const clean = [
      ...new Set(
        value
          .map((v) => (typeof v === "string" ? Number(v) : v))
          .filter(
            (v): v is number =>
              typeof v === "number" &&
              Number.isInteger(v) &&
              v >= RETRY_OFFSET_MIN_DAYS &&
              v <= RETRY_OFFSET_MAX_DAYS,
          ),
      ),
    ]
      .sort((a, b) => a - b)
      .slice(0, MAX_RETRY_OFFSETS);
    if (clean.length > 0) out[category] = clean;
  }
  return out;
}

/**
 * PURE — re-base a strategy's RETRY steps onto explicit cumulative offsets
 * (days after the failure). Non-retry steps (notices, update emails, the
 * terminal PAUSE/CANCEL) keep their static cumulative positions, EXCEPT the
 * ones that statically follow the last RETRY: those are re-anchored to stay
 * after the last overridden retry with their original relative gaps —
 * otherwise offsets later than the static terminal day (e.g. 14/21/28 for a
 * strategy whose PAUSE sits on day 11) would schedule RETRYs after PAUSE,
 * which fire against a paused contract, deterministically fail, and silently
 * cost the merchant every configured retry. The merged sequence is
 * re-expressed as relative afterDays. Categories that never retry by design
 * (LOST_OR_STOLEN, PERMANENT_FAILURE) are returned unchanged — an override
 * must not make us charge a card we know is gone.
 */
export function applyRetryOffsets(
  base: DunningStep[],
  offsets: number[] | null | undefined,
): DunningStep[] {
  if (!offsets || offsets.length === 0) return base;
  if (!base.some((s) => s.action === "RETRY")) return base;
  const clean = [
    ...new Set(
      offsets.filter(
        (d) =>
          Number.isFinite(d) &&
          d >= RETRY_OFFSET_MIN_DAYS &&
          d <= RETRY_OFFSET_MAX_DAYS,
      ),
    ),
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_RETRY_OFFSETS);
  if (clean.length === 0) return base;

  // Static cumulative day of the strategy's last RETRY: anything after it
  // (final notice, terminal PAUSE/CANCEL) must trail the LAST override too.
  let staticLastRetryAt = 0;
  {
    let cum = 0;
    for (const step of base) {
      cum += step.afterDays;
      if (step.action === "RETRY") staticLastRetryAt = cum;
    }
  }
  const lastOffset = clean[clean.length - 1];

  // Timeline of non-retry steps at their static cumulative days — trailing
  // steps re-anchored to preserve their gap after the last retry…
  let cumulative = 0;
  let order = 0;
  const timed: Array<{ step: DunningStep; at: number; order: number }> = [];
  for (const step of base) {
    cumulative += step.afterDays;
    if (step.action !== "RETRY") {
      const at =
        cumulative > staticLastRetryAt
          ? Math.max(cumulative, lastOffset + (cumulative - staticLastRetryAt))
          : cumulative;
      timed.push({ step: { ...step }, at, order: order++ });
    }
  }
  // …plus a RETRY at each requested offset.
  for (const day of clean) {
    timed.push({ step: { afterDays: 0, action: "RETRY" }, at: day, order: order++ });
  }
  timed.sort((a, b) => a.at - b.at || a.order - b.order);

  let previous = 0;
  const out: DunningStep[] = [];
  for (const t of timed) {
    out.push({ ...t.step, afterDays: Math.max(0, t.at - previous) });
    previous = t.at;
  }
  return out;
}

export function strategyFor(
  category: DeclineCategory,
  isHighValue: boolean,
  graceDays: number = DEFAULT_HIGH_VALUE_GRACE_DAYS,
  retryOffsets: number[] | null = null,
): DunningStep[] {
  const base = applyRetryOffsets(
    STRATEGIES[category].map((s) => ({ ...s })),
    retryOffsets,
  );
  if (!isHighValue) return base;
  // High-value subscribers: one extra grace-period step (an email plus the
  // configured extra days) before the first PAUSE or CANCEL.
  const idx = base.findIndex(
    (s) => s.action === "PAUSE" || s.action === "CANCEL",
  );
  if (idx === -1) return base;
  base.splice(idx, 0, { ...HIGH_VALUE_GRACE_STEP, afterDays: graceDays });
  return base;
}

/**
 * Resolve the effective retry offsets for (shop, category):
 * merchant override > learned (analytics/learning.server) > null (static).
 */
export async function resolveRetryOffsets(
  shop: string,
  category: DeclineCategory,
): Promise<number[] | null> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const overrides = parseDunningOverrides(settingsObj.dunningOverrides);
  const merchant = overrides[category];
  if (merchant && merchant.length > 0) return merchant;
  return getLearnedDunningOffsets(shop, category);
}

/**
 * Merchant-configured extra grace for high-value subscribers, from
 * ShopSettings.settingsJson.highValueGraceDays (same validation pattern as
 * preDunningLeadDays); falls back to the 7-day default.
 */
async function highValueGraceDaysForShop(shop: string): Promise<number> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const settingsObj = parseJson<Record<string, unknown>>(
    settings?.settingsJson,
    {},
  );
  const raw = Number(settingsObj.highValueGraceDays);
  return Number.isInteger(raw) && raw >= 0
    ? raw
    : DEFAULT_HIGH_VALUE_GRACE_DAYS;
}

// ─────────────────────────── History bookkeeping ──────────────────────────

export interface DunningHistoryEntry {
  at: string;
  type:
    | "EPISODE_START"
    | "STEP"
    | "RETRY_FAILED"
    | "STEP_ERROR"
    | "RESOLVED"
    | "EXHAUSTED";
  stepIndex?: number;
  action?: DunningStep["action"];
  template?: string;
  errorCode?: string | null;
  declineCategory?: string;
  note?: string;
  /** EPISODE_START only: the resolved step schedule pinned for this episode. */
  steps?: DunningStep[];
}

function episodeCount(history: DunningHistoryEntry[]): number {
  return history.filter((h) => h.type === "EPISODE_START").length;
}

/** Steps already executed since the most recent EPISODE_START. */
export function stepsExecutedInEpisode(history: DunningHistoryEntry[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.type === "EPISODE_START") break;
    if (entry.type === "STEP") count++;
  }
  return count;
}

/**
 * PURE — the strategy category is PINNED for the lifetime of an episode: the
 * most recent EPISODE_START entry's declineCategory. A mid-episode failure
 * with a different code must not re-index the executed-step count into a
 * different category's step array (which could exhaust instantly, or skip
 * an EXPIRED_CARD update email and blind-charge a dead card). Falls back to
 * the given category for legacy rows without an EPISODE_START.
 */
export function episodeCategory(
  history: DunningHistoryEntry[],
  fallback: DeclineCategory,
): DeclineCategory {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "EPISODE_START") {
      const recorded = history[i].declineCategory;
      return recorded ? (recorded as DeclineCategory) : fallback;
    }
  }
  return fallback;
}

/**
 * PURE — the step SCHEDULE is pinned for the lifetime of an episode: the most
 * recent EPISODE_START entry's `steps` snapshot. Merchant override edits or a
 * freshly learned DUNNING_RECOVERY version reshape the rebuilt strategy
 * array, and indexing stepsExecutedInEpisode into a different-length array
 * exhausts in-flight episodes early (final notice + terminal PAUSE never
 * run), pauses them prematurely, or repeats a RETRY. New offsets therefore
 * apply only to episodes opened after they land. Falls back to the rebuilt
 * strategy for legacy histories without a pinned snapshot.
 */
export function episodeStrategy(
  history: DunningHistoryEntry[],
  rebuilt: DunningStep[],
): DunningStep[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "EPISODE_START") {
      const pinned = history[i].steps;
      return Array.isArray(pinned) && pinned.length > 0 ? pinned : rebuilt;
    }
  }
  return rebuilt;
}

/** PURE — consecutive trailing transient step errors (resets on any other entry). */
export function trailingStepErrors(history: DunningHistoryEntry[]): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].type === "STEP_ERROR") count++;
    else break;
  }
  return count;
}

/** Cap on consecutive transient failures before the episode is closed. */
export const MAX_TRANSIENT_STEP_FAILURES = 5;

/**
 * PURE — capped exponential backoff for transient step failures:
 * 1h · 2^(n−1), capped at 24h. n is the (1-based) consecutive failure count.
 */
export function transientBackoffMs(consecutiveFailures: number): number {
  const n = Math.max(1, Math.floor(consecutiveFailures));
  const hours = Math.min(24, Math.pow(2, n - 1));
  return hours * 60 * 60 * 1000;
}

const ACTIVE_PHASES = ["RETRYING", "GRACE", "FINAL_NOTICE"] as const;

/**
 * PURE — is this DunningState a live episode for the purposes of a NEW
 * billing failure? FINAL_NOTICE with nextRetryAt null is written in exactly
 * one place — the grace-pause auto-resume handoff (pauseResume.server) — and
 * that handoff's documented contract is that the next failure "opens a fresh
 * one". Routing it into the in-episode branch instead would count the whole
 * prior episode's steps, hit idx >= strategy.length on the next queue pass,
 * and flip straight to EXHAUSTED — zero retries, zero recovery emails for
 * the post-resume cycle.
 */
export function isLiveEpisodeForFailure(
  phase: string,
  nextRetryAt: Date | null,
): boolean {
  if (!(ACTIVE_PHASES as readonly string[]).includes(phase)) return false;
  return !(phase === "FINAL_NOTICE" && nextRetryAt == null);
}

/**
 * Internal sentinel: the state changed between the due-list snapshot and the
 * step closure, BEFORE any side effect ran. Thrown (not returned) so the
 * idempotency row is RELEASED — completing it would permanently replay the
 * skip and the step could never execute against the fresh state.
 */
class StaleDunningStateSkip extends Error {
  constructor() {
    super("dunning state changed since snapshot — step skipped");
    this.name = "StaleDunningStateSkip";
  }
}

// ─────────────────────────── Failure / success hooks ──────────────────────

/**
 * Record a billing failure: upsert the DunningState (phase RETRYING, decline
 * category, next step schedule, history append). Emission of the initial
 * CHARGE_FAILED customer event is handled by core's webhook flow — this
 * function only maintains portal-banner state and the retry schedule.
 */
export async function onBillingFailure(
  shop: string,
  contractId: string,
  errorCode: string | null,
  opts?: { challenged?: boolean },
): Promise<void> {
  const contract = await prisma.subscriptionContract.findFirstOrThrow({
    where: { id: contractId, shop },
  });
  // A 3DS challenge is an authentication problem regardless of the raw code —
  // route it to the AUTHENTICATION_REQUIRED strategy (auth-link email first,
  // never blind generic retries).
  const category = opts?.challenged
    ? "AUTHENTICATION_REQUIRED"
    : categorizeDeclineCode(errorCode);
  const graceDays = await highValueGraceDaysForShop(shop);
  // Precedence: merchant dunningOverrides > learned offsets > static table.
  const retryOffsets = await resolveRetryOffsets(shop, category);
  const strategy = strategyFor(
    category,
    isHighValueContract(contract),
    graceDays,
    retryOffsets,
  );
  const now = new Date();

  const state = await prisma.dunningState.findUnique({ where: { contractId } });
  const history = parseJson<DunningHistoryEntry[]>(state?.historyJson, []);

  // The grace-pause-resume handoff (FINAL_NOTICE, nextRetryAt null) is NOT a
  // live episode: the post-resume failure must open a fresh one.
  const inActiveEpisode =
    state != null && isLiveEpisodeForFailure(state.phase, state.nextRetryAt);

  if (state != null && inActiveEpisode) {
    // A retry we scheduled has failed: record it; the queue already scheduled
    // (or will schedule) the next step, so keep the existing nextRetryAt.
    history.push({
      at: now.toISOString(),
      type: "RETRY_FAILED",
      errorCode,
      declineCategory: category,
    });
    await prisma.dunningState.update({
      where: { contractId },
      data: {
        declineCategory: category,
        lastFailureAt: now,
        historyJson: JSON.stringify(history),
        nextRetryAt:
          state.nextRetryAt ??
          addDays(
            now,
            episodeStrategy(history, strategy)[0]?.afterDays ?? 0,
          ),
      },
    });
  } else {
    // New dunning episode. The resolved schedule is PINNED into the
    // EPISODE_START entry so later merchant/learned offset changes cannot
    // reshape the step array under this in-flight episode.
    history.push({
      at: now.toISOString(),
      type: "EPISODE_START",
      errorCode,
      declineCategory: category,
      steps: strategy,
    });
    const firstDue = addDays(now, strategy[0]?.afterDays ?? 0);
    await prisma.dunningState.upsert({
      where: { contractId },
      create: {
        contractId,
        phase: "RETRYING",
        declineCategory: category,
        retryCount: 0,
        nextRetryAt: firstDue,
        lastFailureAt: now,
        historyJson: JSON.stringify(history),
      },
      update: {
        phase: "RETRYING",
        declineCategory: category,
        retryCount: 0,
        nextRetryAt: firstDue,
        lastFailureAt: now,
        graceUntil: null,
        historyJson: JSON.stringify(history),
      },
    });
  }

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "DUNNING_FAILURE_RECORDED",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: { errorCode, declineCategory: category, newEpisode: !inActiveEpisode },
  });
}

/** A charge went through: resolve dunning and reset counters. */
export async function onBillingSuccess(
  shop: string,
  contractId: string,
): Promise<void> {
  const state = await prisma.dunningState.findUnique({ where: { contractId } });
  if (!state || state.phase === "NONE" || state.phase === "RESOLVED") return;

  const history = parseJson<DunningHistoryEntry[]>(state.historyJson, []);
  history.push({ at: new Date().toISOString(), type: "RESOLVED" });

  await prisma.dunningState.update({
    where: { contractId },
    data: {
      phase: "RESOLVED",
      retryCount: 0,
      nextRetryAt: null,
      graceUntil: null,
      historyJson: JSON.stringify(history),
    },
  });

  await appendAudit({
    shop,
    actorType: "SYSTEM",
    action: "DUNNING_RESOLVED",
    subjectType: "SubscriptionContract",
    subjectId: contractId,
    payload: { previousPhase: state.phase, retryCount: state.retryCount },
  });
}

// ─────────────────────────── Queue job ────────────────────────────────────

/**
 * Execute every due dunning step. Steps are idempotent per
 * (contract, episode, stepIndex) so an overlapping job run can never
 * double-charge or double-notify. A strategy is never exceeded: once the last
 * step has run, the state moves to EXHAUSTED.
 *
 * Correctness properties (each covered by a verified bug fix):
 *  - Stale-state guard: the closure re-reads DunningState first and every
 *    write is `updateMany` guarded on (active phase, updatedAt snapshot) — a
 *    SUCCESS webhook landing mid-run wins, and the queue can never resurrect
 *    dunning on a paid-up contract or re-charge it.
 *  - Episode pinning: the strategy category comes from the episode's
 *    EPISODE_START entry, so a mid-episode decline-code switch cannot
 *    re-index the step counter into a different category's array.
 *  - Pending-retry gate: a step that follows a RETRY never fires while that
 *    retry's outcome is unknown (latest BillingAttempt still PENDING).
 *  - Failure containment: a deterministically failing step (Shopify
 *    userErrors) is skipped past instead of retried forever; transient
 *    failures back off exponentially (1h·2^n, cap 24h) and close the episode
 *    after MAX_TRANSIENT_STEP_FAILURES.
 */
export async function runDunningQueueJob(
  shop?: string,
): Promise<{ processed: number; executed: number; exhausted: number; skipped: number }> {
  const now = new Date();
  const due = await prisma.dunningState.findMany({
    where: {
      phase: { in: [...ACTIVE_PHASES] },
      nextRetryAt: { lte: now },
      ...(shop ? { contract: { shop } } : {}),
    },
    include: { contract: true },
  });

  let executed = 0;
  let exhausted = 0;
  let skipped = 0;
  // The job can span shops; resolve per-shop settings once per run.
  const graceDaysByShop = new Map<string, number>();
  const offsetsByShopCategory = new Map<string, number[] | null>();

  for (const state of due) {
    const contract = state.contract;
    // Hoisted so the catch block can advance past a dead step.
    const history = parseJson<DunningHistoryEntry[]>(state.historyJson, []);
    const category = episodeCategory(
      history,
      (state.declineCategory ?? "GENERIC_DECLINE") as DeclineCategory,
    );
    let strategy: DunningStep[] = [];
    let idx = -1;
    try {
      let graceDays = graceDaysByShop.get(contract.shop);
      if (graceDays === undefined) {
        graceDays = await highValueGraceDaysForShop(contract.shop);
        graceDaysByShop.set(contract.shop, graceDays);
      }
      const offsetsKey = `${contract.shop}:${category}`;
      let retryOffsets = offsetsByShopCategory.get(offsetsKey);
      if (retryOffsets === undefined) {
        retryOffsets = await resolveRetryOffsets(contract.shop, category);
        offsetsByShopCategory.set(offsetsKey, retryOffsets);
      }
      // The schedule pinned at EPISODE_START wins over a freshly rebuilt one:
      // merchant edits or a new learned DUNNING_RECOVERY version must not
      // re-index this episode's executed-step count into a different-length
      // array (instant EXHAUSTED / premature PAUSE / repeated RETRY). This
      // single substitution also covers the exhaustion check, the
      // pending-retry gate, the catch-block bookkeeping and the
      // CONCURRENT_UPDATE reconciliation — they all read `strategy`.
      strategy = episodeStrategy(
        history,
        strategyFor(
          category,
          isHighValueContract(contract),
          graceDays,
          retryOffsets,
        ),
      );
      idx = stepsExecutedInEpisode(history);
      const episode = episodeCount(history);

      if (idx >= strategy.length) {
        history.push({ at: now.toISOString(), type: "EXHAUSTED" });
        const written = await prisma.dunningState.updateMany({
          where: {
            id: state.id,
            phase: { in: [...ACTIVE_PHASES] },
            updatedAt: state.updatedAt,
          },
          data: {
            phase: "EXHAUSTED",
            nextRetryAt: null,
            historyJson: JSON.stringify(history),
          },
        });
        if (written.count > 0) {
          await appendAudit({
            shop: contract.shop,
            actorType: "SYSTEM",
            action: "DUNNING_EXHAUSTED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: { declineCategory: category, stepsExecuted: idx },
          });
          exhausted++;
        } else {
          skipped++;
        }
        continue;
      }

      const step = strategy[idx];

      // Pending-retry gate — OUTSIDE the idempotent closure (no idempotency
      // row is minted, so the step executes normally once the outcome lands):
      // an afterDays:0 follow-up email must not tell the customer their
      // payment failed while the retry we just created is still pending.
      if (idx > 0 && strategy[idx - 1].action === "RETRY") {
        const latestAttempt = await prisma.billingAttempt.findFirst({
          where: { contractId: contract.id },
          orderBy: { occurredAt: "desc" },
          select: { status: true },
        });
        if (latestAttempt?.status === "PENDING") {
          await prisma.dunningState.updateMany({
            where: {
              id: state.id,
              phase: { in: [...ACTIVE_PHASES] },
              updatedAt: state.updatedAt,
            },
            data: { nextRetryAt: new Date(now.getTime() + 60 * 60 * 1000) },
          });
          skipped++;
          continue;
        }
      }

      const { result } = await withIdempotency(
        `dunning-step:${contract.id}:${episode}:${idx}`,
        "retention.dunningStep",
        async () => {
          // Stale-state guard, before ANY side effect: a webhook (success or
          // new failure) that landed after the due-list snapshot wins. Thrown
          // so the idempotency row is released and the step can still run
          // against the fresh state on the next pass.
          const fresh = await prisma.dunningState.findUnique({
            where: { id: state.id },
          });
          if (
            !fresh ||
            !(ACTIVE_PHASES as readonly string[]).includes(fresh.phase) ||
            fresh.updatedAt.getTime() !== state.updatedAt.getTime()
          ) {
            throw new StaleDunningStateSkip();
          }

          let phase: string = state.phase;
          let graceUntil: Date | null = state.graceUntil;
          let retryCount = state.retryCount;

          switch (step.action) {
            case "RETRY": {
              const { graphql } = await getOfflineAdmin(contract.shop);
              retryCount += 1;
              // The cycle index does not advance while the cycle stays unpaid,
              // so each retry needs its own attempt suffix or every retry
              // after the first replays the first attempt's idempotency key
              // without ever reaching Shopify. episode+idx is stable within
              // this step (replay-safe) and unique across steps/episodes.
              await createBillingAttempt(graphql, contract.shop, contract.id, {
                billingCycleIndex: contract.successfulOrders + 1,
                attempt: `${episode}-${idx}`,
              });
              phase = "RETRYING";
              break;
            }
            case "EMAIL":
            case "SMS": {
              await emitLifecycleEvent({
                shop: contract.shop,
                name: "CHARGE_FAILED",
                contractId: contract.id,
                shopifyCustomerId: contract.shopifyCustomerId,
                email: contract.customerEmail,
                payload: {
                  step: idx,
                  channel: step.action,
                  template: step.template ?? null,
                  declineCategory: category,
                  followUp: true,
                },
                dedupeKey: `dunning:${contract.id}:${episode}:${idx}`,
              });
              break;
            }
            case "PORTAL_BANNER":
              // The portal reads DunningState directly; the history entry is
              // the banner trigger.
              break;
            case "PAUSE": {
              const { graphql } = await getOfflineAdmin(contract.shop);
              const resumeDate = addDays(now, 30);
              // emitEvent: false — a dunning grace pause is failing-card
              // recovery, not customer pause behaviour; a plain PAUSE_STARTED
              // here would pollute pauseRate and per-contract pause
              // propensities. The distinctly named event below preserves
              // observability while every PAUSE_STARTED consumer excludes it
              // by name. The pause-resume job [core] resumes the contract at
              // resumeDate and hands the episode to FINAL_NOTICE.
              await pauseUntil(graphql, contract.shop, contract.id, resumeDate, {
                emitEvent: false,
              });
              await emitLifecycleEvent({
                shop: contract.shop,
                name: "DUNNING_PAUSE_STARTED",
                contractId: contract.id,
                shopifyCustomerId: contract.shopifyCustomerId,
                email: contract.customerEmail,
                payload: {
                  resumeDate: resumeDate.toISOString(),
                  declineCategory: category,
                  step: idx,
                },
                dedupeKey: `dunning-pause:${contract.id}:${episode}`,
              });
              phase = "GRACE";
              graceUntil = resumeDate;
              break;
            }
            case "CANCEL": {
              // Defense-in-depth: a contract reactivated after the PAUSE step
              // (customer fixed payment and resumed) must not be cancelled by
              // this stale scheduled step. Likewise a pause DUNNING DID NOT
              // CREATE (a customer/portal pause — e.g. the PAUSE step was
              // skipped past on AlreadyPausedError because the customer had
              // already paused, so graceUntil was never set): cancelling it
              // would break the promised resume date, treating a customer
              // who proactively paused strictly worse than one who did
              // nothing. Resolving is correct: with graceUntil null the
              // pause is not a dunning grace pause, so the pause-resume
              // handoff owns it — the first post-resume billing failure
              // opens a fresh episode. A dunning grace pause (graceUntil
              // equal to pausedUntil) still falls through to cancel,
              // preserving the terminal behaviour for LOST_OR_STOLEN /
              // PERMANENT_FAILURE.
              const freshContract = await prisma.subscriptionContract.findUnique({
                where: { id: contract.id },
              });
              const reactivated =
                freshContract?.status === "ACTIVE" &&
                freshContract.pausedUntil == null;
              const foreignPause =
                freshContract != null &&
                freshContract.pausedUntil != null &&
                (state.graceUntil == null ||
                  freshContract.pausedUntil.getTime() !==
                    state.graceUntil.getTime());
              if (reactivated || foreignPause) {
                const note = reactivated
                  ? "CANCEL_SKIPPED_CONTRACT_REACTIVATED"
                  : "CANCEL_SKIPPED_NON_DUNNING_PAUSE";
                history.push({
                  at: now.toISOString(),
                  type: "RESOLVED",
                  note,
                });
                const written = await prisma.dunningState.updateMany({
                  where: {
                    id: state.id,
                    phase: { in: [...ACTIVE_PHASES] },
                    updatedAt: state.updatedAt,
                  },
                  data: {
                    phase: "RESOLVED",
                    nextRetryAt: null,
                    graceUntil: null,
                    historyJson: JSON.stringify(history),
                  },
                });
                if (written.count > 0) {
                  await appendAudit({
                    shop: contract.shop,
                    actorType: "SYSTEM",
                    action: "DUNNING_STEP_EXECUTED",
                    subjectType: "SubscriptionContract",
                    subjectId: contract.id,
                    payload: {
                      stepIndex: idx,
                      action: step.action,
                      skipped: reactivated
                        ? "CONTRACT_REACTIVATED"
                        : "NON_DUNNING_PAUSE",
                      declineCategory: category,
                      nextRetryAt: null,
                      phase: "RESOLVED",
                    },
                  });
                }
                return { stepIndex: idx, action: step.action, phase: "RESOLVED" };
              }
              const { graphql } = await getOfflineAdmin(contract.shop);
              // Involuntary cancel: no CANCELLATION_COMPLETED emission here —
              // metrics counts payment-failure churn from dunning/cancelReason
              // and the event would inflate voluntary churn.
              await cancelContract(
                graphql,
                contract.shop,
                contract.id,
                "PAYMENT_FAILURE",
                "SYSTEM",
                { emitEvent: false },
              );
              phase = "EXHAUSTED";
              break;
            }
          }

          history.push({
            at: now.toISOString(),
            type: "STEP",
            stepIndex: idx,
            action: step.action,
            template: step.template,
          });

          // Schedule the next step, or exhaust — never exceed the strategy.
          const next = strategy[idx + 1];
          let nextRetryAt: Date | null = null;
          if (next && phase !== "EXHAUSTED") {
            nextRetryAt = addDays(now, next.afterDays);
            if (next.action === "RETRY" && category === "INSUFFICIENT_FUNDS") {
              nextRetryAt = snapRetryToLikelySalary(nextRetryAt, now);
            }
          } else if (phase !== "EXHAUSTED") {
            phase = "EXHAUSTED";
            history.push({ at: now.toISOString(), type: "EXHAUSTED" });
          }

          // Optimistic write: if a webhook resolved (or re-failed) the state
          // while this step ran, the concurrent writer wins — never audit a
          // schedule that was not written.
          const written = await prisma.dunningState.updateMany({
            where: {
              id: state.id,
              phase: { in: [...ACTIVE_PHASES] },
              updatedAt: state.updatedAt,
            },
            data: {
              phase,
              retryCount,
              nextRetryAt,
              graceUntil,
              historyJson: JSON.stringify(history),
            },
          });
          if (written.count === 0) {
            logger.info("dunning step write lost to a concurrent update", {
              contractId: contract.id,
              stepIndex: idx,
              action: step.action,
            });
            return {
              stepIndex: idx,
              action: step.action,
              phase,
              skippedReason: "CONCURRENT_UPDATE",
            };
          }

          await appendAudit({
            shop: contract.shop,
            actorType: "SYSTEM",
            action: "DUNNING_STEP_EXECUTED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: {
              stepIndex: idx,
              action: step.action,
              declineCategory: category,
              nextRetryAt: nextRetryAt?.toISOString() ?? null,
              phase,
            },
          });

          return { stepIndex: idx, action: step.action, phase };
        },
      );

      if ((result as { skippedReason?: string }).skippedReason === "CONCURRENT_UPDATE") {
        // Side effects ran but the state advance lost to a concurrent write
        // (typically a RETRY_FAILED history append). Reconcile against the
        // CURRENT row so the executed step is recorded and the schedule
        // moves on — otherwise the same idempotency row replays forever.
        skipped++;
        const current = await prisma.dunningState.findUnique({
          where: { id: state.id },
        });
        if (
          current &&
          (ACTIVE_PHASES as readonly string[]).includes(current.phase)
        ) {
          const currentHistory = parseJson<DunningHistoryEntry[]>(
            current.historyJson,
            [],
          );
          if (
            episodeCount(currentHistory) === episodeCount(history) &&
            stepsExecutedInEpisode(currentHistory) === idx
          ) {
            const step = strategy[idx];
            currentHistory.push({
              at: now.toISOString(),
              type: "STEP",
              stepIndex: idx,
              action: step.action,
              template: step.template,
              note: "RECONCILED_AFTER_CONCURRENT_UPDATE",
            });
            const next = strategy[idx + 1];
            await prisma.dunningState.updateMany({
              where: { id: state.id, updatedAt: current.updatedAt },
              data: next
                ? {
                    nextRetryAt: addDays(now, next.afterDays),
                    historyJson: JSON.stringify(currentHistory),
                  }
                : {
                    phase: "EXHAUSTED",
                    nextRetryAt: null,
                    historyJson: JSON.stringify(currentHistory),
                  },
            });
          }
        }
      } else if ((result as { skippedReason?: string }).skippedReason) {
        skipped++;
      } else {
        executed++;
      }
    } catch (e) {
      if (e instanceof StaleDunningStateSkip) {
        skipped++;
        continue;
      }
      const deterministic =
        (e instanceof ShopifyGraphqlError && (e.userErrors?.length ?? 0) > 0) ||
        e instanceof AlreadyPausedError;
      logger.error("dunning step failed", {
        contractId: contract.id,
        stepIndex: idx,
        deterministic,
        error: e instanceof Error ? e.message : String(e),
      });
      // Never leave nextRetryAt in the past with no plan: that wedges the
      // episode into an infinite retry loop hammering the same failure.
      try {
        const note = e instanceof Error ? e.message.slice(0, 300) : String(e);
        if (deterministic && idx >= 0) {
          // Deterministic (Shopify userErrors): the step can never succeed —
          // record it as executed-with-failure so the counter advances past
          // it, and schedule the next step (or exhaust).
          history.push({
            at: now.toISOString(),
            type: "STEP",
            stepIndex: idx,
            action: strategy[idx]?.action,
            note: `STEP_FAILED_SKIPPED: ${note}`,
          });
          const next = strategy[idx + 1];
          let phase: string = state.phase;
          let nextRetryAt: Date | null = null;
          if (next) {
            nextRetryAt = addDays(now, next.afterDays);
          } else {
            phase = "EXHAUSTED";
            history.push({ at: now.toISOString(), type: "EXHAUSTED" });
          }
          await prisma.dunningState.updateMany({
            where: {
              id: state.id,
              phase: { in: [...ACTIVE_PHASES] },
              updatedAt: state.updatedAt,
            },
            data: {
              phase,
              nextRetryAt,
              historyJson: JSON.stringify(history),
            },
          });
          await appendAudit({
            shop: contract.shop,
            actorType: "SYSTEM",
            action: "DUNNING_STEP_FAILED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: {
              stepIndex: idx,
              deterministic: true,
              declineCategory: category,
              nextRetryAt: nextRetryAt?.toISOString() ?? null,
              phase,
            },
          });
        } else {
          // Transient: exponential backoff, capped attempts.
          const failures = trailingStepErrors(history) + 1;
          history.push({
            at: now.toISOString(),
            type: "STEP_ERROR",
            stepIndex: idx >= 0 ? idx : undefined,
            note,
          });
          const closeEpisode = failures >= MAX_TRANSIENT_STEP_FAILURES;
          if (closeEpisode) {
            history.push({ at: now.toISOString(), type: "EXHAUSTED" });
          }
          await prisma.dunningState.updateMany({
            where: {
              id: state.id,
              phase: { in: [...ACTIVE_PHASES] },
              updatedAt: state.updatedAt,
            },
            data: closeEpisode
              ? {
                  phase: "EXHAUSTED",
                  nextRetryAt: null,
                  historyJson: JSON.stringify(history),
                }
              : {
                  nextRetryAt: new Date(
                    now.getTime() + transientBackoffMs(failures),
                  ),
                  historyJson: JSON.stringify(history),
                },
          });
          await appendAudit({
            shop: contract.shop,
            actorType: "SYSTEM",
            action: "DUNNING_STEP_FAILED",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: {
              stepIndex: idx,
              deterministic: false,
              consecutiveFailures: failures,
              exhausted: closeEpisode,
              declineCategory: category,
            },
          });
          if (closeEpisode) exhausted++;
        }
      } catch (persistError) {
        logger.error("dunning failure bookkeeping failed", {
          contractId: contract.id,
          error: String(persistError),
        });
      }
    }
  }

  return { processed: due.length, executed, exhausted, skipped };
}

// ─────────────────────────── Pre-dunning job ──────────────────────────────

/** Default warning window before the next charge, in days. */
const DEFAULT_PRE_DUNNING_LEAD_DAYS = 10;

/**
 * The per-contract-and-expiry-month guard must outlive the whole eligibility
 * window (lead days + however long the customer takes to update the card),
 * which routinely exceeds the default 7-day idempotency TTL — after a prune
 * the daily job would re-notify for the same expiring card every ~7 days.
 */
const PRE_DUNNING_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Pure: does a card (valid through the end of expiryMonth/expiryYear) expire
 * before the given cutoff? Month is 1-12.
 */
export function cardExpiresBefore(
  expiryMonth: number,
  expiryYear: number,
  cutoff: Date,
): boolean {
  // First instant AFTER the last valid month (month is 1-12, so this rolls
  // into the following month correctly, including December → January).
  const expiryEnd = new Date(Date.UTC(expiryYear, expiryMonth, 1));
  return expiryEnd.getTime() < cutoff.getTime();
}

/**
 * Warn subscribers whose card expires before their next charge (+ lead days
 * from ShopSettings.settingsJson.preDunningLeadDays), emit CARD_EXPIRING and
 * trigger Shopify's secure payment-update email. Idempotent per contract and
 * card expiry month.
 */
export async function runPreDunningJob(
  shop?: string,
): Promise<{ checked: number; notified: number }> {
  const shopRows = shop
    ? [{ shop }]
    : await prisma.subscriptionContract.findMany({
        where: { status: "ACTIVE" },
        distinct: ["shop"],
        select: { shop: true },
      });

  let checked = 0;
  let notified = 0;

  for (const { shop: shopDomain } of shopRows) {
    const settings = await prisma.shopSettings.findUnique({
      where: { shop: shopDomain },
    });
    const settingsObj = parseJson<Record<string, unknown>>(
      settings?.settingsJson,
      {},
    );
    const rawLead = Number(settingsObj.preDunningLeadDays);
    const leadDays =
      Number.isFinite(rawLead) && rawLead > 0
        ? rawLead
        : DEFAULT_PRE_DUNNING_LEAD_DAYS;

    const contracts = await prisma.subscriptionContract.findMany({
      where: {
        shop: shopDomain,
        status: "ACTIVE",
        nextBillingDate: { not: null },
        cardExpiryMonth: { not: null },
        cardExpiryYear: { not: null },
      },
    });

    for (const contract of contracts) {
      checked++;
      const nextBillingDate = contract.nextBillingDate as Date;
      const expiryMonth = contract.cardExpiryMonth as number;
      const expiryYear = contract.cardExpiryYear as number;
      const cutoff = addDays(nextBillingDate, leadDays);
      if (!cardExpiresBefore(expiryMonth, expiryYear, cutoff)) continue;

      const key = `pre-dunning:${contract.id}:${expiryYear}-${expiryMonth}`;
      try {
        await withIdempotency(key, "retention.preDunning", async () => {
          const last4 = contract.cardLastDigits ?? "••••";
          await emitLifecycleEvent({
            shop: shopDomain,
            name: "CARD_EXPIRING",
            contractId: contract.id,
            shopifyCustomerId: contract.shopifyCustomerId,
            email: contract.customerEmail,
            payload: {
              message: `Your next treatment delivery is scheduled for ${humanDate(nextBillingDate)}. The card ending in ${last4} expires this month.`,
              nextBillingDate: isoDate(nextBillingDate),
              cardLastDigits: contract.cardLastDigits,
              cardExpiryMonth: expiryMonth,
              cardExpiryYear: expiryYear,
            },
            dedupeKey: key,
          });

          const { graphql } = await getOfflineAdmin(shopDomain);
          await sendPaymentUpdateEmail(graphql, shopDomain, contract.id);

          // Portal banner: mark PRE_DUNNING unless an episode is already live.
          const state = await prisma.dunningState.findUnique({
            where: { contractId: contract.id },
          });
          const activeEpisode =
            state != null &&
            (ACTIVE_PHASES as readonly string[]).includes(state.phase);
          if (!activeEpisode) {
            const history = parseJson<DunningHistoryEntry[]>(
              state?.historyJson,
              [],
            );
            history.push({
              at: new Date().toISOString(),
              type: "STEP",
              action: "PORTAL_BANNER",
              note: "PRE_DUNNING_CARD_EXPIRING",
            });
            await prisma.dunningState.upsert({
              where: { contractId: contract.id },
              create: {
                contractId: contract.id,
                phase: "PRE_DUNNING",
                historyJson: JSON.stringify(history),
              },
              update: {
                phase: "PRE_DUNNING",
                historyJson: JSON.stringify(history),
              },
            });
          }

          await appendAudit({
            shop: shopDomain,
            actorType: "SYSTEM",
            action: "PRE_DUNNING_NOTICE",
            subjectType: "SubscriptionContract",
            subjectId: contract.id,
            payload: {
              cardExpiryMonth: expiryMonth,
              cardExpiryYear: expiryYear,
              nextBillingDate: isoDate(nextBillingDate),
              leadDays,
            },
          });

          return { notified: true };
        }, PRE_DUNNING_TTL_MS);
        notified++;
      } catch (e) {
        logger.error("pre-dunning notice failed", {
          contractId: contract.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { checked, notified };
}
