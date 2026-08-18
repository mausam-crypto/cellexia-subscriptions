import { addIntervalTz } from "~/lib/dates.server";
import {
  contractFrequency,
  frequencyToken,
  type Frequency,
} from "~/lib/frequency";

/**
 * Portal schedule semantics helpers (v1.28.0, P2.2) shared by the api
 * dispatcher (writer of the toast params), the subscription page (delay
 * options + frequency consequence preview) and the magic-link / SMS DELAY
 * verbs — one place decides what "delay" means for this shop.
 */

export type DelayMode = "reanchor" | "once";

/**
 * Which delay the customer gets. portal.delayReanchors ON (default): the
 * portal offers both — "Delay by N weeks" moves the whole schedule
 * (re-anchor) and "Just this once" pushes only this order — so the form's
 * explicit `mode=once` wins, everything else re-anchors. OFF: today's
 * behaviour, always one cycle, whatever the form says.
 */
export function delayModeFor(
  portalSettings: { delayReanchors?: boolean } | null | undefined,
  requested: string | null | undefined,
): DelayMode {
  if (portalSettings?.delayReanchors !== true) return "once";
  return requested === "once" ? "once" : "reanchor";
}

/** Shop-tz calendar day (YYYY-MM-DD) of an instant — the toast `d1`/`d2` form. */
export function calendarDayIn(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * The next-date pair a frequency change is expected to produce, computed the
 * way changeFrequency's Shopify re-read has been observed to land (and the
 * cancel flow's FREQUENCY save card estimates it): Shopify recomputes the
 * next order from the last one + the NEW interval, so the next order moves
 * by the added (or removed) slack; the full new cadence runs after it. Same
 * unit: exact unit arithmetic. Different units: the day-denominated delta
 * for DAY↔WEEK; for MONTH crossings the next date is left where it is (the
 * only honest estimate without a Shopify read) — copy says "around".
 * A negative delta that would land in the past clamps to tomorrow (Shopify
 * bills such a contract at the next sweep). Null when the contract has no
 * next date.
 */
export function estimateFrequencyChange(
  contract: {
    nextBillingDate: Date | null;
    intervalWeeks: number;
    billingIntervalUnit?: string | null;
    billingIntervalCount?: number | null;
  },
  target: Frequency,
  tz: string,
  now: Date = new Date(),
): { nextDate: Date; followingDate: Date } | null {
  const next = contract.nextBillingDate;
  if (!next) return null;
  const current = contractFrequency(contract);
  let estimated = next;
  const shiftDays = (days: number) =>
    days === 0
      ? next
      : addIntervalTz(next, "DAY", Math.abs(days), tz, days > 0 ? 1 : -1);
  if (current.unit === target.unit) {
    const delta = target.count - current.count;
    estimated =
      delta === 0
        ? next
        : addIntervalTz(next, target.unit, Math.abs(delta), tz, delta > 0 ? 1 : -1);
  } else if (current.unit !== "MONTH" && target.unit !== "MONTH") {
    const days = (f: Frequency) => (f.unit === "WEEK" ? f.count * 7 : f.count);
    estimated = shiftDays(days(target) - days(current));
  }
  const tomorrow = addIntervalTz(now, "DAY", 1, tz);
  if (estimated.getTime() < tomorrow.getTime()) estimated = tomorrow;
  return {
    nextDate: estimated,
    followingDate: addIntervalTz(estimated, target.unit, target.count, tz),
  };
}

/** `data-cxs-next` / `data-cxs-following` values for a frequency <option>. */
export function frequencyOptionPreview(
  contract: Parameters<typeof estimateFrequencyChange>[0],
  option: Frequency,
  tz: string,
  now: Date = new Date(),
): { token: string; next: string; following: string } | null {
  const est = estimateFrequencyChange(contract, option, tz, now);
  if (!est) return null;
  return {
    token: frequencyToken(option),
    next: calendarDayIn(est.nextDate, tz),
    following: calendarDayIn(est.followingDate, tz),
  };
}
