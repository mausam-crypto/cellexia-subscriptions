import type { DunningCase } from "@prisma/client";
import prisma from "~/db.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import { addIntervalTz, cardExpiryMoment, shopDayStartUtc } from "~/lib/dates.server";
import { contractFrequency, type Frequency } from "~/lib/frequency";
import { releaseHeldCycleAttempts } from "~/lib/billing/release.server";
import { clearStaleCycleOverrides } from "~/lib/billing/estimate.server";
import {
  contractActivate,
  getBillingCycleByDate,
  getBillingCycleByIndex,
  getContract,
  setNextBillingDate as shopifySetNextBillingDate,
  skipBillingCycle,
} from "~/lib/graphql/index.server";
import {
  eventIdentity,
  fetchNextBillingDate,
  loadContractContext,
  resolveActor,
  resolveSource,
  withMirrorGuard,
  type ServiceOptions,
} from "~/lib/contracts/shared.server";
import { isBillableOwnership } from "~/lib/ownership/ownership.server";
import { OPEN_CASE_STATES } from "./states";
import { onCycleSkipped } from "./engine.server";

/**
 * "Skip that order and continue from {date}" (v1.28.0, P1.9) — the third way
 * out of a FAILED (dunning-exhausted) contract, next to "Retry with this
 * card" and "Update / use another card".
 *
 * Today an exhausted contract is parked: the ladder gave up, the held cycle
 * is still unbilled, and the only exits are a successful retry or a card
 * change. A customer whose card is FINE (soft decline that never cleared,
 * a bank limit that month) but who does not want the held order any more
 * has no verb — so they cancel. This one is case-aware end to end:
 *
 *  1. guards: contract FAILED (ACTIVE ⇒ already_active, anything else ⇒
 *     contract_status), ours, card not hard-dead (revoked / expired /
 *     absent ⇒ refused — the next charge would only fail again; the toast
 *     points at update-card), no attempt of the held cycle in flight
 *     (PENDING / CHALLENGED with a Shopify id ⇒ its outcome must settle);
 *  2. the held cycle = the newest EXHAUSTED case's trigger-attempt cycle
 *     (legacy case without one: the cycle at the mirror's nextBillingDate);
 *     Shopify `subscriptionBillingCycleSkip` on it (idempotent — already
 *     skipped is fine; already BILLED ⇒ refused, nothing to skip);
 *  3. `subscriptionContractActivate`; the next date = the first cycle date
 *     after the held one that is still ahead (Stage B timing — a weekly
 *     plan exhausted 30 days ago must not "continue" from three dates in
 *     the past). Shopify's own next date is used when it is ahead; else it
 *     is set explicitly (subscriptionContractSetNextBillingDate);
 *  4. mirror: ACTIVE, failedAt null, consecutiveFailures 0 (the recovery
 *     path's clears), nextBillingDate, skipCount/lastSkippedAt (an honest
 *     customer skip); the closed episode's terminal attempts are released
 *     (releaseHeldCycleAttempts — every reactivation entry point must);
 *  5. the EXHAUSTED case gets resolution CUSTOMER_SKIPPED (state stays
 *     EXHAUSTED: it IS the exhausted episode, now closed by the customer);
 *     an open case re-armed meanwhile (a "Retry now" that did not fire) is
 *     closed through the engine's own onCycleSkipped reconciliation;
 *  6. events: cycle.skipped {initiator CUSTOMER, reason skip_failed_cycle}
 *     (the confirmation bridge mails skip_confirmed with the new date),
 *     contract.activated {reason skip_failed_cycle}, dunning.case_closed
 *     {resolution CUSTOMER_SKIPPED}, and portal.payment_skip_resume
 *     {outcome} for EVERY call, refusals included (the funnel).
 *
 * Shared by the portal verb, the SKIP_FAILED_CYCLE magic link and (never
 * directly) the post-exhaustion touch emails that carry that link. Throws
 * only on infrastructure failure after the guards (the caller maps it to
 * the generic error toast); every foreseeable refusal is a typed outcome.
 */

export type SkipResumeRefusal =
  | "not_found"
  | "not_ours"
  | "contract_status"
  | "no_case"
  | "no_card"
  | "card_revoked"
  | "card_expired"
  | "attempt_in_flight"
  | "no_cycle"
  | "cycle_billed";

export type SkipResumeOutcome =
  | {
      kind: "resumed";
      caseId: string | null;
      cycleIndex: number;
      nextBillingDate: Date;
    }
  | { kind: "already_active" }
  | { kind: "refused"; reason: SkipResumeRefusal };

export interface SkipResumeOptions extends ServiceOptions {
  now?: Date;
}

/** Bounded search — beyond this the plain "now + one interval" applies. */
const MAX_RESUME_STEPS = 120;

/**
 * Pure: the first cycle date strictly after `now`, stepping one interval at
 * a time from the held cycle's date (shop-tz calendar steps). The held date
 * itself is never returned (it is the skipped order). Exposed for the banner
 * label ("continue from {date}") so the promise and the execution agree.
 */
export function computeSkipResumeDate(input: {
  heldDate: Date;
  frequency: Frequency;
  tz: string;
  now: Date;
}): Date {
  const { heldDate, frequency, tz, now } = input;
  // Always k intervals FROM THE ANCHOR (not iteratively from the previous
  // step): month-end anchors would otherwise drift (May 31 → Jun 30 → Jul 30).
  let steps = 1;
  let candidate = addIntervalTz(heldDate, frequency.unit, frequency.count, tz, steps);
  while (candidate.getTime() <= now.getTime() && steps < MAX_RESUME_STEPS) {
    steps += 1;
    candidate = addIntervalTz(heldDate, frequency.unit, frequency.count, tz, steps);
  }
  if (candidate.getTime() <= now.getTime()) {
    candidate = addIntervalTz(now, frequency.unit, frequency.count, tz);
  }
  return candidate;
}

/**
 * Null the per-line cycle flags the skip-and-resume made stale: the cycle at
 * the effective next date decides (Shopify's indexing after a re-anchor is
 * not knowable locally); when that lookup fails, at least the held cycle is
 * gone, so everything below held+1 is cleared. Never throws.
 */
async function reconcileCycleOverridesAfterSkipResume(
  admin: Parameters<typeof getBillingCycleByDate>[0],
  contract: { id: string; shopifyContractId: string },
  heldCycleIndex: number,
  effectiveNext: Date,
): Promise<void> {
  let upcomingIndex = heldCycleIndex + 1;
  try {
    const cycle = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      effectiveNext,
    );
    if (cycle && cycle.cycleIndex > heldCycleIndex) upcomingIndex = cycle.cycleIndex;
  } catch (err) {
    console.error(
      "[dunning] skip-resume: cycle lookup for per-line edits failed — clearing below held+1",
      contract.id,
      err,
    );
  }
  await clearStaleCycleOverrides(contract.id, upcomingIndex);
}

/** Hard-dead card: nothing a retry could ever recover. */
export function cardHardDeadReason(
  contract: {
    paymentMethodId: string | null;
    paymentMethodRevokedAt?: Date | null;
    cardExpiryMonth: number | null;
    cardExpiryYear: number | null;
  },
  now: Date,
  tz?: string | null,
): "no_card" | "card_revoked" | "card_expired" | null {
  if (!contract.paymentMethodId) return "no_card";
  if (contract.paymentMethodRevokedAt != null) return "card_revoked";
  const expiresAt = cardExpiryMoment(
    contract.cardExpiryMonth,
    contract.cardExpiryYear,
    tz,
  );
  if (expiresAt && now.getTime() >= expiresAt.getTime()) return "card_expired";
  return null;
}

/**
 * The date the verb WOULD set for a FAILED contract (banner label, magic
 * confirm page, parked emails): held date from the newest EXHAUSTED case's
 * trigger attempt (legacy: the mirror's next date), then the same pure
 * computation the execution uses. Null when nothing can be derived (the
 * copy falls back to "on your usual schedule"). Contained: never throws.
 */
export async function previewSkipResumeDate(
  contract: {
    id: string;
    nextBillingDate: Date | null;
    intervalWeeks: number;
    billingIntervalUnit?: string | null;
    billingIntervalCount?: number | null;
  },
  tz: string,
  now: Date = new Date(),
): Promise<Date | null> {
  try {
    const exhausted = await prisma.dunningCase.findFirst({
      where: { contractId: contract.id, state: "EXHAUSTED" },
      orderBy: { openedAt: "desc" },
    });
    const held = await heldCycleOfCase(exhausted);
    const heldDate = held?.scheduledFor ?? contract.nextBillingDate;
    if (!heldDate) return null;
    return computeSkipResumeDate({
      heldDate,
      frequency: contractFrequency(contract),
      tz,
      now,
    });
  } catch (err) {
    console.error("[dunning] skip-resume preview date failed", contract.id, err);
    return null;
  }
}

async function heldCycleOfCase(
  kase: DunningCase | null,
): Promise<{ cycleIndex: number; scheduledFor: Date } | null> {
  if (!kase?.triggerAttemptId) return null;
  const trigger = await prisma.billingAttempt.findUnique({
    where: { id: kase.triggerAttemptId },
    select: { cycleIndex: true, scheduledFor: true },
  });
  return trigger
    ? { cycleIndex: trigger.cycleIndex, scheduledFor: trigger.scheduledFor }
    : null;
}

/**
 * Per-contract serialization of the verb (in-process). A double tap / second
 * tab / a magic-link replay racing the portal POST both pass every guard
 * (there is no per-contract lock, only the hourly rate limit) — the second
 * run would skip / activate / log `cycle.skipped` twice. Chained here, the
 * second run starts only after the first settles, re-reads the contract and
 * lands on `already_active`. Multi-instance deployments still rely on the
 * Shopify-side idempotency below (an already-skipped cycle is not skipped
 * again; an already-ACTIVE contract is tolerated).
 */
const inFlightByContract = new Map<string, Promise<unknown>>();

export async function skipFailedCycleAndResume(
  shopDomain: string,
  contractLocalId: string,
  options: SkipResumeOptions = {},
): Promise<SkipResumeOutcome> {
  const key = `${shopDomain}:${contractLocalId}`;
  const prior = inFlightByContract.get(key) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(() => skipFailedCycleAndResumeUnlocked(shopDomain, contractLocalId, options));
  inFlightByContract.set(key, run);
  try {
    return await run;
  } finally {
    if (inFlightByContract.get(key) === run) inFlightByContract.delete(key);
  }
}

async function skipFailedCycleAndResumeUnlocked(
  shopDomain: string,
  contractLocalId: string,
  options: SkipResumeOptions = {},
): Promise<SkipResumeOutcome> {
  const now = options.now ?? new Date();
  const source: EventSource = resolveSource(options);
  const actor = resolveActor(options);

  let ctx: Awaited<ReturnType<typeof loadContractContext>>;
  try {
    ctx = await loadContractContext(shopDomain, contractLocalId);
  } catch (err) {
    console.error("[dunning] skip-resume: contract context failed", contractLocalId, err);
    return { kind: "refused", reason: "not_found" };
  }
  const { shop, contract, admin } = ctx;

  const trace = async (
    outcome: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "portal.payment_skip_resume",
      source,
      actor,
      payload: { outcome, ...extra },
    });
  };
  const refuse = async (
    reason: SkipResumeRefusal,
    extra: Record<string, unknown> = {},
  ): Promise<SkipResumeOutcome> => {
    await trace("refused", { reason, ...extra });
    return { kind: "refused", reason };
  };

  if (!isBillableOwnership(contract.ownership)) return refuse("not_ours");
  if (contract.status === "ACTIVE") {
    await trace("already_active");
    return { kind: "already_active" };
  }
  if (contract.status !== "FAILED") return refuse("contract_status");

  const dead = cardHardDeadReason(contract, now, shop.ianaTimezone);
  if (dead) return refuse(dead);

  // The exhausted episode (newest) — the case this verb closes.
  const exhausted = await prisma.dunningCase.findFirst({
    where: { contractId: contract.id, state: "EXHAUSTED" },
    orderBy: { openedAt: "desc" },
  });
  // A case re-armed since (customer "Retry now" reopens the exhausted case
  // in place): same episode, same held cycle. It is closed below through
  // the engine's own reconciliation once the cycle is gone on Shopify.
  const open = await prisma.dunningCase.findFirst({
    where: { contractId: contract.id, state: { in: OPEN_CASE_STATES } },
    orderBy: { openedAt: "desc" },
  });
  const kase = exhausted ?? open;
  if (!kase) return refuse("no_case");

  // Held cycle: the case's trigger-attempt cycle; legacy cases (no trigger
  // attempt) fall back to the cycle at the mirror's next date.
  let held = await heldCycleOfCase(kase);
  if (!held && contract.nextBillingDate) {
    const byDate = await getBillingCycleByDate(
      admin,
      contract.shopifyContractId,
      contract.nextBillingDate,
    );
    if (byDate) {
      held = {
        cycleIndex: byDate.cycleIndex,
        scheduledFor: byDate.billingAttemptExpectedDate ?? contract.nextBillingDate,
      };
    }
  }
  if (!held) return refuse("no_cycle", { dunningCaseId: kase.id });

  // An attempt of the held cycle whose outcome Shopify still owes us: its
  // webhook could be a SUCCESS (recovery) — skipping under it would strand a
  // paid order. The customer's other buttons cover this moment.
  const inFlight = await prisma.billingAttempt.findFirst({
    where: {
      contractId: contract.id,
      cycleIndex: held.cycleIndex,
      status: { in: ["PENDING", "CHALLENGED"] },
      shopifyAttemptId: { not: null },
    },
    select: { id: true },
  });
  if (inFlight) {
    return refuse("attempt_in_flight", {
      dunningCaseId: kase.id,
      attemptId: inFlight.id,
    });
  }

  // ── Shopify: skip the held cycle (idempotent), then activate ──────────────
  const cycle = await getBillingCycleByIndex(
    admin,
    contract.shopifyContractId,
    held.cycleIndex,
  );
  if (!cycle) return refuse("no_cycle", { dunningCaseId: kase.id });
  if (cycle.status === "BILLED") {
    return refuse("cycle_billed", { dunningCaseId: kase.id, cycleIndex: held.cycleIndex });
  }
  const heldDate = cycle.billingAttemptExpectedDate ?? held.scheduledFor;
  if (!cycle.skipped) {
    await skipBillingCycle(admin, contract.shopifyContractId, {
      index: held.cycleIndex,
    });
  }

  // Next date: the first cycle date after the held one that is still ahead —
  // the SAME computation the banner / parked email / magic confirm page
  // labelled the CTA with (`previewSkipResumeDate`), so the toast, the
  // skip_confirmed email and the hero afterwards name the day the customer
  // clicked on. Shopify's own date is kept only when it already lands on
  // that shop day (its time-of-day is the anchor's — no needless re-anchor);
  // a missing / past / different date is set explicitly, so the sweep never
  // bills an order the customer was told lies in the past and no surface
  // promises a day the verb does not keep. Order matters (Stage G review
  // fix): the explicit set is attempted BEFORE activation — between activate
  // and a later set, Shopify's own contract-update webhook mirrors ACTIVE +
  // the stale past date and a billing-sweep tick in that window would open
  // an attempt on an un-skipped intermediate cycle. Shopify may refuse the
  // set on a FAILED contract; then it is applied right after activation
  // (the historical order).
  const freq = contractFrequency(contract);
  const target = computeSkipResumeDate({
    heldDate,
    frequency: freq,
    tz: shop.ianaTimezone,
    now,
  });
  let effectiveNext = await fetchNextBillingDate(admin, contract.shopifyContractId, null);
  let needsExplicitSet =
    !effectiveNext ||
    effectiveNext.getTime() <= now.getTime() ||
    shopDayStartUtc(effectiveNext, shop.ianaTimezone).getTime() !==
      shopDayStartUtc(target, shop.ianaTimezone).getTime();
  if (needsExplicitSet) {
    try {
      const set = await shopifySetNextBillingDate(admin, contract.shopifyContractId, target);
      effectiveNext = set.nextBillingDate ?? target;
      needsExplicitSet = false;
    } catch (err) {
      console.warn(
        "[dunning] skip-resume: next-date set before activation refused — setting after",
        contract.id,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Activate — tolerant of a Shopify contract that is ALREADY active (a
  // half-applied earlier run whose mirror write failed, or a concurrent
  // second instance): Shopify refuses `subscriptionContractActivate` on an
  // ACTIVE contract with a userError; re-read and continue when it is
  // active, rethrow otherwise (a real refusal must surface as the toast).
  try {
    await contractActivate(admin, contract.shopifyContractId);
  } catch (err) {
    let activeAlready = false;
    try {
      const remote = await getContract(admin, contract.shopifyContractId);
      activeAlready = remote.status === "ACTIVE";
    } catch {
      // unreadable — fall through to the original error
    }
    if (!activeAlready) throw err;
    console.warn(
      "[dunning] skip-resume: Shopify contract already ACTIVE — continuing (half-applied earlier run)",
      contract.id,
    );
  }

  if (needsExplicitSet) {
    const set = await shopifySetNextBillingDate(admin, contract.shopifyContractId, target);
    effectiveNext = set.nextBillingDate ?? target;
  }
  if (!effectiveNext) effectiveNext = target;

  // ── Mirror ────────────────────────────────────────────────────────────────
  await withMirrorGuard("skipFailedCycleAndResume", ctx, options, () =>
    prisma.subscriptionContract.update({
      where: { id: contract.id },
      data: {
        status: "ACTIVE",
        failedAt: null,
        consecutiveFailures: 0,
        nextBillingDate: effectiveNext,
        skipCount: { increment: 1 },
        lastSkippedAt: now,
      },
    }),
  );

  // ── Per-line cycle edits ──────────────────────────────────────────────────
  // Every other schedule mover reconciles the staged "skip this line once" /
  // quantity-override flags after moving (skipNextCycle → held+1, resume /
  // set-next-date → the cycle at the effective date). The held cycle is gone
  // for good, so anything staged on it (or below) is stale — left in place
  // it would make the estimate claim "not this time" for a line the next
  // order ships. Contained (never blocks the verb).
  await reconcileCycleOverridesAfterSkipResume(
    admin,
    contract,
    held.cycleIndex,
    effectiveNext,
  );

  // ── Cases ─────────────────────────────────────────────────────────────────
  let closedCaseId: string | null = null;
  if (exhausted) {
    const marked = await prisma.dunningCase.updateMany({
      where: { id: exhausted.id, state: "EXHAUSTED" },
      data: { resolution: "CUSTOMER_SKIPPED", resolvedAt: now, nextRetryAt: null },
    });
    if (marked.count === 1) closedCaseId = exhausted.id;
  }
  if (open) {
    // Engine reconciliation: closes the re-armed case anchored on the held
    // cycle (CYCLE_SKIPPED) and expires its un-started PENDING rows.
    // Contained inside the engine.
    const closed = await onCycleSkipped(contract.id, held.cycleIndex, source);
    if (closed && !closedCaseId) closedCaseId = open.id;
  }
  // The closed episode's terminal attempts stop being the cycle's live
  // verdict (every reactivation entry point releases; the skipped cycle
  // short-circuits anyway, the FOLLOWING one must never be held by them).
  const released = await releaseHeldCycleAttempts(contract.id);

  // ── Events ────────────────────────────────────────────────────────────────
  await logEvent({
    ...eventIdentity(shop, contract),
    type: "cycle.skipped",
    source,
    actor,
    payload: {
      cycleIndex: held.cycleIndex,
      initiator: "CUSTOMER",
      reason: "skip_failed_cycle",
      previousNextBillingDate: heldDate.toISOString(),
      nextBillingDate: effectiveNext.toISOString(),
      dunningCaseId: kase.id,
    },
  });
  await logEvent({
    ...eventIdentity(shop, contract),
    type: "contract.activated",
    source,
    actor,
    payload: {
      reason: "skip_failed_cycle",
      dunningCaseId: kase.id,
      cycleIndex: held.cycleIndex,
      nextBillingDate: effectiveNext.toISOString(),
      releasedFailedAttempts: released,
    },
  });
  if (closedCaseId === exhausted?.id && exhausted) {
    await logEvent({
      ...eventIdentity(shop, contract),
      type: "dunning.case_closed",
      source,
      actor,
      payload: {
        dunningCaseId: exhausted.id,
        cycleIndex: held.cycleIndex,
        resolution: "CUSTOMER_SKIPPED",
        reason: "skip_failed_cycle",
      },
    });
  }
  await trace("resumed", {
    dunningCaseId: kase.id,
    cycleIndex: held.cycleIndex,
    nextBillingDate: effectiveNext.toISOString(),
  });

  return {
    kind: "resumed",
    caseId: kase.id,
    cycleIndex: held.cycleIndex,
    nextBillingDate: effectiveNext,
  };
}
