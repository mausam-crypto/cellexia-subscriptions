import prisma from "~/db.server";
import { logEvent, type EventSource } from "~/lib/events/log.server";
import {
  createSignedPayload,
  verifySignedPayload,
} from "~/lib/crypto/tokens.server";
import {
  changeFrequency,
  revertDelayedCycle,
  setLineQuantityThisCycle,
  setNextBillingDate,
  unskipLineThisCycle,
  unskipNextCycle,
} from "~/lib/contracts/service.server";
import {
  contractFrequency,
  sameFrequency,
  type Frequency,
  type FrequencyUnit,
} from "~/lib/frequency";
import {
  chargeMomentUtcSync,
  resolveChargeTiming,
  type ChargeTiming,
} from "~/lib/billing/timing.server";

/**
 * Portal Undo (v1.28.0, P2.2) for the three schedule verbs that had none:
 * delay (once / re-anchor), next_date and frequency. The portal's skip toast
 * undoes through `unskip` directly; the SMS "UNDO" keyword reaches a skip
 * through the `skip` spec below (kind "skip" → unskipNextCycle), so texting
 * SKIP then UNDO unskips instead of answering "nothing to undo".
 *
 * Mechanism — the same signed-token idea as the SKIP undo magic link
 * (tokens.server), minus the database row: the toast that confirms the
 * action carries a signed, expiring UndoSpec (what to restore, and what the
 * contract must currently look like for the restore to still make sense),
 * bound to shop + contract + customer. `undo` is then a NORMAL guarded
 * portal action (session, CSRF, ownership, rate limit) that verifies the
 * token and re-checks the contract against the spec:
 *
 *   - current state ≠ the action's after-state → "stale" (something else
 *     moved the schedule since — a second action, a charge — and undoing
 *     blindly would restore a date the customer no longer expects);
 *   - the previous date's CHARGE MOMENT (timing.server — shop-day start +
 *     billing.chargeHourLocal, the same instant the sweep and the "changes
 *     until" line use) is already behind us → "past" (nothing truthful to
 *     restore to; a same-day-morning delay before the charge hour stays
 *     undoable, a restore into a passed charge moment never happens);
 *   - otherwise the previous value is restored through the contract
 *     services (mode-faithful: a one-cycle delay is reverted with a cycle
 *     schedule edit, a re-anchor / next-date change with set-next-date, a
 *     frequency change with the previous cadence + the previous date — the
 *     frequency undo applies BOTH stale checks (cadence AND next date, so a
 *     later delay is never silently discarded) and the same "past" guard
 *     before touching the cadence, since Shopify recomputes the date from
 *     the restored interval and could land it in the past → an immediate
 *     charge, never an "undo").
 *
 * The preparing-your-order window (isPreparingOrder) is enforced by the
 * callers (portal dispatcher, SMS UNDO), like every other schedule verb.
 *
 * The same spec is derived from the action's OWN event payload
 * (undoSpecFromEvent) for the SMS "UNDO" keyword — the events store the
 * previous values precisely so that any channel can reverse them.
 *
 * Window: portal.magicLinkTtlDays — the existing customer one-tap link
 * lifetime the SKIP undo already uses (undoWindowSeconds).
 */

export type UndoSpec =
  | {
      kind: "skip";
      previousNextBillingDate: string;
      nextBillingDate: string;
    }
  | {
      kind: "delay";
      mode: "once" | "reanchor";
      previousNextBillingDate: string;
      nextBillingDate: string;
    }
  | {
      kind: "next_date";
      previousNextBillingDate: string;
      nextBillingDate: string;
    }
  | {
      kind: "frequency";
      oldUnit: FrequencyUnit;
      oldCount: number;
      newUnit: FrequencyUnit;
      newCount: number;
      previousNextBillingDate: string | null;
      nextBillingDate: string | null;
    }
  // Per-line cycle edits (v1.28.0, P2.5). Stale check: the line must still
  // carry the flag for that exact cycle (something else moved it otherwise).
  | {
      kind: "line_skip";
      lineId: string;
      cycleIndex: number;
    }
  | {
      kind: "line_qty_once";
      lineId: string;
      cycleIndex: number;
      /** The override to restore (null = back to the plan quantity). */
      previousOverride: number | null;
      /** The override the action wrote (null = it cleared the override). */
      override: number | null;
    };

export type UndoAction = UndoSpec["kind"];

/** Event types whose payload can be turned back into an UndoSpec. */
export const UNDOABLE_EVENT_TYPES = [
  "cycle.skipped",
  "cycle.delayed",
  "contract.next_date_changed",
  "contract.frequency_changed",
  // Per-line cycle edits (v1.28.0, P2.5) — SMS UNDO reverses them too.
  "cycle.line_skipped",
  "cycle.line_quantity_set",
] as const;

interface UndoBinding {
  shopId: string;
  contractId: string;
  customerId: string;
}

interface UndoTokenData extends UndoBinding {
  spec: UndoSpec;
}

const TOKEN_KIND = "portal_undo";

/** Undo window in seconds from the portal settings (magicLinkTtlDays). */
export function undoWindowSeconds(portalSettings: {
  magicLinkTtlDays?: number;
}): number {
  const days = portalSettings.magicLinkTtlDays;
  const safe =
    typeof days === "number" && Number.isFinite(days) && days >= 1 ? days : 14;
  return Math.floor(safe) * 24 * 3600;
}

/**
 * Sign an undo token for the toast. Contained: a signing failure (secret
 * missing in a dev shell, malformed spec) yields null and the toast simply
 * offers no Undo — the action that succeeded is never affected.
 */
export function mintUndoToken(
  spec: UndoSpec,
  binding: UndoBinding,
  ttlSeconds: number,
): string | null {
  try {
    const data: UndoTokenData = { ...binding, spec };
    return createSignedPayload(TOKEN_KIND, data, ttlSeconds);
  } catch (err) {
    console.error("[portal] undo token mint failed", binding.contractId, err);
    return null;
  }
}

export type ReadUndoTokenResult =
  | { ok: true; spec: UndoSpec }
  | { ok: false; reason: "invalid" | "expired" | "mismatch" };

/** Verify a token and require it to be bound to THIS shop/contract/customer. */
export function readUndoToken(
  token: string,
  binding: UndoBinding,
): ReadUndoTokenResult {
  let verified;
  try {
    verified = verifySignedPayload<UndoTokenData>(token, TOKEN_KIND);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!verified.ok) {
    return {
      ok: false,
      reason: verified.reason === "EXPIRED" ? "expired" : "invalid",
    };
  }
  const data = verified.payload.data;
  if (
    !data ||
    data.shopId !== binding.shopId ||
    data.contractId !== binding.contractId ||
    data.customerId !== binding.customerId
  ) {
    return { ok: false, reason: "mismatch" };
  }
  const spec = normalizeSpec(data.spec);
  if (!spec) return { ok: false, reason: "invalid" };
  return { ok: true, spec };
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(new Date(v).getTime());
}

function isUnit(v: unknown): v is FrequencyUnit {
  return v === "DAY" || v === "WEEK" || v === "MONTH";
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isIndex(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isLineId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

/** Shape-check an untrusted spec (token or event payload). */
export function normalizeSpec(raw: unknown): UndoSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  switch (s.kind) {
    case "skip":
      if (isIso(s.previousNextBillingDate) && isIso(s.nextBillingDate)) {
        return {
          kind: "skip",
          previousNextBillingDate: s.previousNextBillingDate,
          nextBillingDate: s.nextBillingDate,
        };
      }
      return null;
    case "delay":
      if (
        (s.mode === "once" || s.mode === "reanchor") &&
        isIso(s.previousNextBillingDate) &&
        isIso(s.nextBillingDate)
      ) {
        return {
          kind: "delay",
          mode: s.mode,
          previousNextBillingDate: s.previousNextBillingDate,
          nextBillingDate: s.nextBillingDate,
        };
      }
      return null;
    case "next_date":
      if (isIso(s.previousNextBillingDate) && isIso(s.nextBillingDate)) {
        return {
          kind: "next_date",
          previousNextBillingDate: s.previousNextBillingDate,
          nextBillingDate: s.nextBillingDate,
        };
      }
      return null;
    case "frequency":
      if (
        isUnit(s.oldUnit) &&
        isCount(s.oldCount) &&
        isUnit(s.newUnit) &&
        isCount(s.newCount)
      ) {
        return {
          kind: "frequency",
          oldUnit: s.oldUnit,
          oldCount: s.oldCount,
          newUnit: s.newUnit,
          newCount: s.newCount,
          previousNextBillingDate: isIso(s.previousNextBillingDate)
            ? s.previousNextBillingDate
            : null,
          nextBillingDate: isIso(s.nextBillingDate) ? s.nextBillingDate : null,
        };
      }
      return null;
    case "line_skip":
      if (isLineId(s.lineId) && isIndex(s.cycleIndex)) {
        return { kind: "line_skip", lineId: s.lineId, cycleIndex: s.cycleIndex };
      }
      return null;
    case "line_qty_once":
      if (
        isLineId(s.lineId) &&
        isIndex(s.cycleIndex) &&
        (s.previousOverride === null || isCount(s.previousOverride)) &&
        (s.override === null || isCount(s.override))
      ) {
        return {
          kind: "line_qty_once",
          lineId: s.lineId,
          cycleIndex: s.cycleIndex,
          previousOverride: s.previousOverride as number | null,
          override: s.override as number | null,
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * The action's own event → the spec that reverses it. cycle.delayed rows
 * written before v1.28.0 carry no `mode`; they were all one-cycle delays.
 */
export function undoSpecFromEvent(event: {
  type: string;
  payload: unknown;
}): UndoSpec | null {
  const p =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  switch (event.type) {
    case "cycle.skipped":
      return normalizeSpec({
        kind: "skip",
        previousNextBillingDate: p.previousNextBillingDate,
        nextBillingDate: p.nextBillingDate,
      });
    case "cycle.delayed":
      return normalizeSpec({
        kind: "delay",
        mode: p.mode === "reanchor" ? "reanchor" : "once",
        previousNextBillingDate: p.previousNextBillingDate,
        nextBillingDate: p.nextBillingDate,
      });
    case "contract.next_date_changed":
      return normalizeSpec({
        kind: "next_date",
        previousNextBillingDate: p.previousNextBillingDate,
        nextBillingDate: p.nextBillingDate,
      });
    case "contract.frequency_changed":
      return normalizeSpec({
        kind: "frequency",
        oldUnit: p.oldUnit,
        oldCount: p.oldCount,
        newUnit: p.newUnit,
        newCount: p.newCount,
        previousNextBillingDate: p.previousNextBillingDate,
        nextBillingDate: p.nextBillingDate,
      });
    case "cycle.line_skipped":
      return normalizeSpec({
        kind: "line_skip",
        lineId: p.lineId,
        cycleIndex: p.cycleIndex,
      });
    case "cycle.line_quantity_set": {
      // Payload: { qty (billed), from (previous billed), planQuantity,
      // cleared }. The override BEFORE the action is `from` unless it was
      // the plan quantity (no override); the override AFTER is `qty` unless
      // the action cleared it.
      const plan = p.planQuantity;
      const from = p.from;
      const qty = p.qty;
      return normalizeSpec({
        kind: "line_qty_once",
        lineId: p.lineId,
        cycleIndex: p.cycleIndex,
        previousOverride: from === plan ? null : from,
        override: p.cleared === true || qty === plan ? null : qty,
      });
    }
    default:
      return null;
  }
}

export interface UndoContract {
  id: string;
  shopId: string;
  customerId: string;
  email: string;
  status: string;
  nextBillingDate: Date | null;
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
}

export type UndoOutcome =
  | { kind: "restored"; nextBillingDate: Date | null; frequency: Frequency | null }
  | { kind: "stale" }
  | { kind: "past" }
  | { kind: "inactive" };

function sameInstant(a: Date | null, iso: string | null): boolean {
  if (!a || !iso) return a == null && iso == null;
  return a.getTime() === new Date(iso).getTime();
}

/**
 * Reverse `spec` on `contract` if it still applies. Every branch logs
 * portal.undo { action, outcome, … } (contained). Throws only when a
 * service call fails — the caller maps that to its generic error path.
 */
export async function performUndo(
  shopDomain: string,
  contract: UndoContract,
  spec: UndoSpec,
  opts: {
    source: EventSource;
    actor: string;
    via: "portal" | "sms";
    /** Pre-resolved charge timing (else loaded from the shop's settings). */
    timing?: ChargeTiming;
  },
  now: Date = new Date(),
): Promise<UndoOutcome> {
  const audit = async (
    outcome: UndoOutcome["kind"],
    extra: Record<string, unknown> = {},
  ) => {
    try {
      await logEvent({
        shopId: contract.shopId,
        contractId: contract.id,
        customerId: contract.customerId,
        email: contract.email,
        type: "portal.undo",
        source: opts.source,
        actor: opts.actor,
        payload: { action: spec.kind, via: opts.via, outcome, ...extra },
      });
    } catch (err) {
      console.error("[portal] undo audit failed", contract.id, err);
    }
  };

  if (contract.status !== "ACTIVE") {
    await audit("inactive");
    return { kind: "inactive" };
  }

  const serviceOpts = { source: opts.source, actor: opts.actor };
  const timing = opts.timing ?? (await resolveChargeTiming(contract.shopId));
  // "past" = the charge moment of the date we would restore to has passed.
  const chargePassed = (d: Date): boolean =>
    chargeMomentUtcSync(d, timing).getTime() <= now.getTime();

  // Per-line cycle edits (P2.5): the line must still carry the flag for the
  // exact cycle the action wrote — otherwise the cycle settled / was skipped
  // whole / the customer edited again, and the undo has nothing to reverse.
  // The "past" guard is the contract's own next charge moment (the cycle the
  // flag rides): once it passed there is no cycle to put the line back on.
  if (spec.kind === "line_skip" || spec.kind === "line_qty_once") {
    const line = await prisma.contractLine.findFirst({
      where: { id: spec.lineId, contractId: contract.id },
      select: {
        id: true,
        skippedCycleIndex: true,
        cycleQuantityOverride: true,
        cycleQuantityOverrideIndex: true,
      },
    });
    const stillApplies =
      line != null &&
      (spec.kind === "line_skip"
        ? line.skippedCycleIndex === spec.cycleIndex
        : spec.override == null
          ? line.cycleQuantityOverrideIndex !== spec.cycleIndex
          : line.cycleQuantityOverrideIndex === spec.cycleIndex &&
            line.cycleQuantityOverride === spec.override);
    if (!stillApplies) {
      await audit("stale", { lineId: spec.lineId, cycleIndex: spec.cycleIndex });
      return { kind: "stale" };
    }
    if (contract.nextBillingDate && chargePassed(contract.nextBillingDate)) {
      await audit("past", { lineId: spec.lineId, cycleIndex: spec.cycleIndex });
      return { kind: "past" };
    }
    const updated =
      spec.kind === "line_skip"
        ? await unskipLineThisCycle(shopDomain, contract.id, spec.lineId, serviceOpts)
        : await setLineQuantityThisCycle(
            shopDomain,
            contract.id,
            spec.lineId,
            spec.previousOverride,
            serviceOpts,
          );
    await audit("restored", {
      lineId: spec.lineId,
      cycleIndex: spec.cycleIndex,
      ...(spec.kind === "line_qty_once"
        ? { restoredOverride: spec.previousOverride }
        : {}),
    });
    return {
      kind: "restored",
      nextBillingDate: updated.nextBillingDate,
      frequency: null,
    };
  }

  if (spec.kind === "skip") {
    if (!sameInstant(contract.nextBillingDate, spec.nextBillingDate)) {
      await audit("stale", {
        expectedNextBillingDate: spec.nextBillingDate,
        currentNextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
      });
      return { kind: "stale" };
    }
    if (chargePassed(new Date(spec.previousNextBillingDate))) {
      await audit("past", { previousNextBillingDate: spec.previousNextBillingDate });
      return { kind: "past" };
    }
    // Idempotent in the service (nothing skipped ⇒ no-op).
    const updated = await unskipNextCycle(shopDomain, contract.id, serviceOpts);
    await audit("restored", {
      restoredNextBillingDate: updated.nextBillingDate?.toISOString() ?? null,
    });
    return {
      kind: "restored",
      nextBillingDate: updated.nextBillingDate,
      frequency: null,
    };
  }

  if (spec.kind === "delay" || spec.kind === "next_date") {
    if (!sameInstant(contract.nextBillingDate, spec.nextBillingDate)) {
      await audit("stale", {
        expectedNextBillingDate: spec.nextBillingDate,
        currentNextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
      });
      return { kind: "stale" };
    }
    const previous = new Date(spec.previousNextBillingDate);
    if (chargePassed(previous)) {
      await audit("past", { previousNextBillingDate: spec.previousNextBillingDate });
      return { kind: "past" };
    }
    const updated =
      spec.kind === "delay" && spec.mode === "once"
        ? await revertDelayedCycle(shopDomain, contract.id, previous, serviceOpts)
        : await setNextBillingDate(shopDomain, contract.id, previous, serviceOpts);
    await audit("restored", {
      restoredNextBillingDate: updated.nextBillingDate?.toISOString() ?? null,
      ...(spec.kind === "delay" ? { mode: spec.mode } : {}),
    });
    return {
      kind: "restored",
      nextBillingDate: updated.nextBillingDate,
      frequency: null,
    };
  }

  // frequency
  const current = contractFrequency(contract);
  const after: Frequency = { unit: spec.newUnit, count: spec.newCount };
  const before: Frequency = { unit: spec.oldUnit, count: spec.oldCount };
  if (
    !sameFrequency(current, after) ||
    (spec.nextBillingDate != null &&
      !sameInstant(contract.nextBillingDate, spec.nextBillingDate))
  ) {
    await audit("stale", {
      expectedFrequency: after,
      currentFrequency: current,
      expectedNextBillingDate: spec.nextBillingDate,
      currentNextBillingDate: contract.nextBillingDate?.toISOString() ?? null,
    });
    return { kind: "stale" };
  }
  // The restore must land the schedule on the previous date: when that
  // date's charge moment has passed (or is unknown) there is nothing truthful
  // to restore to — and restoring the shorter cadence would let Shopify
  // recompute a next date in the past, i.e. an immediate charge.
  if (
    spec.previousNextBillingDate == null ||
    chargePassed(new Date(spec.previousNextBillingDate))
  ) {
    await audit("past", { previousNextBillingDate: spec.previousNextBillingDate });
    return { kind: "past" };
  }
  let updated = await changeFrequency(shopDomain, contract.id, before, serviceOpts);
  // Shopify recomputes the next date from the new cadence; when the change
  // moved the date, put the original one back exactly (a second re-anchor
  // only if the cadence restore did not already land there).
  if (spec.previousNextBillingDate) {
    const previous = new Date(spec.previousNextBillingDate);
    if (!sameInstant(updated.nextBillingDate, spec.previousNextBillingDate)) {
      updated = await setNextBillingDate(
        shopDomain,
        contract.id,
        previous,
        serviceOpts,
      );
    }
  }
  await audit("restored", {
    restoredFrequency: before,
    restoredNextBillingDate: updated.nextBillingDate?.toISOString() ?? null,
  });
  return {
    kind: "restored",
    nextBillingDate: updated.nextBillingDate,
    frequency: before,
  };
}
