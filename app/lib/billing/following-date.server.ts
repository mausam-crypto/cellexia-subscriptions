import prisma from "~/db.server";
import { addIntervalTz } from "~/lib/dates.server";
import { contractFrequency } from "~/lib/frequency";

/**
 * The order AFTER the next one — schedule-aware (v1.28.0 review fix).
 *
 * `nextBillingDate + one interval` is only right while the next order sits on
 * the contract's anchor. A "just this once" delay (delayNextCycle — a cycle
 * schedule edit; the stockout auto-delay uses the same path) moves ONLY the
 * current cycle: the following order stays at the ORIGINAL anchor + interval,
 * which is exactly what the delayed_once toast tells the customer ("back to
 * {orig} after that"). Every surface that names the following order (hero
 * "After that", the preparing note, the reminder's following_date, the api
 * dispatcher's toast, delayNextCycle's own payload) must agree with it.
 *
 * Resolution: the newest cycle.delayed event is consulted; if it is a
 * one-cycle delay (mode "once", or a pre-v1.28 row without mode) whose
 * `nextBillingDate` is the contract's CURRENT next date, its
 * `followingBillingDate` (the anchor + interval it recorded) is the truth.
 * Anything else — a re-anchor delay, a skip, a next-date change, a charge —
 * moved the schedule since, and the plain interval step applies again.
 *
 * Contained: any read failure yields the plain step (never blocks a page or a
 * reminder run). Pure core (`followingFromDelayEvent`) for the tests.
 */

export interface FollowingDateContractLike {
  id: string;
  nextBillingDate: Date | null;
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
}

export interface DelayEventLike {
  type?: string;
  payload: unknown;
}

function isoOf(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Pure: given the newest cycle.delayed event (or null) and the contract's
 * current next date, the recorded following date when the event is a
 * one-cycle delay that produced this very next date; null otherwise.
 */
export function followingFromDelayEvent(
  event: DelayEventLike | null | undefined,
  nextBillingDate: Date,
): Date | null {
  if (!event) return null;
  if (event.type && event.type !== "cycle.delayed") return null;
  const p =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : null;
  if (!p) return null;
  if (p.mode === "reanchor") return null;
  const eventNext = isoOf(p.nextBillingDate);
  if (!eventNext || eventNext.getTime() !== nextBillingDate.getTime()) return null;
  return isoOf(p.followingBillingDate);
}

/** Newest cycle.delayed row for the contract (contained → null). */
export async function loadNewestDelayEvent(
  contractId: string,
): Promise<DelayEventLike | null> {
  try {
    const rows = await prisma.subscriberEvent.findMany({
      where: { contractId, type: "cycle.delayed" },
      orderBy: { createdAt: "desc" },
      take: 1,
      select: { type: true, payload: true },
    });
    const row = rows[0];
    return row ? { type: row.type, payload: row.payload } : null;
  } catch (err) {
    console.error("[billing] following date: delay event read failed", contractId, err);
    return null;
  }
}

/**
 * The following order's date for the contract's CURRENT next date: the
 * one-cycle-delay anchor when one applies, else next + one interval (shop tz).
 * Null without a next date.
 */
export async function resolveFollowingBillingDate(
  contract: FollowingDateContractLike,
  tz: string,
): Promise<Date | null> {
  const next = contract.nextBillingDate;
  if (!next) return null;
  const event = await loadNewestDelayEvent(contract.id);
  const anchored = followingFromDelayEvent(event, next);
  if (anchored) return anchored;
  const freq = contractFrequency(contract);
  return addIntervalTz(next, freq.unit, freq.count, tz);
}
