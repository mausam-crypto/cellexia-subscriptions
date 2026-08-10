import { fromZonedTime, toZonedTime, format } from "date-fns-tz";
import { addDays, addMonths, addWeeks, addYears, startOfDay } from "date-fns";
import type { IntervalUnit } from "~/lib/frequency";

/**
 * Timezone-safe scheduling helpers. All persisted timestamps are UTC.
 * "Billing day" semantics are computed in the shop's IANA timezone so a
 * contract billed "on the 12th" bills on the 12th in London, not in UTC.
 */

/** UTC instant for the start of the given day in the shop timezone. */
export function shopDayStartUtc(date: Date, tz: string): Date {
  const zoned = toZonedTime(date, tz);
  return fromZonedTime(startOfDay(zoned), tz);
}

/** Add N days, anchored to the shop-timezone calendar. */
export function addDaysTz(date: Date, days: number, tz: string): Date {
  const zoned = toZonedTime(date, tz);
  return fromZonedTime(addDays(zoned, days), tz);
}

/** Add N weeks, anchored to the shop-timezone calendar. */
export function addWeeksTz(date: Date, weeks: number, tz: string): Date {
  const zoned = toZonedTime(date, tz);
  return fromZonedTime(addWeeks(zoned, weeks), tz);
}

/** Add N months, anchored to the shop-timezone calendar (month-end clamps). */
export function addMonthsTz(date: Date, months: number, tz: string): Date {
  const zoned = toZonedTime(date, tz);
  return fromZonedTime(addMonths(zoned, months), tz);
}

/**
 * Advance a date by `intervals` billing intervals of `{unit, count}` in the
 * shop timezone — the one place cadence-unit date math lives. MONTH steps are
 * calendar months (Jan 31 + 1 month = Feb 28/29), matching how Shopify walks
 * a MONTH billing policy; negative `intervals` steps backwards.
 */
export function addIntervalTz(
  date: Date,
  unit: IntervalUnit,
  count: number,
  tz: string,
  intervals = 1,
): Date {
  const zoned = toZonedTime(date, tz);
  const steps = Math.max(1, count) * intervals;
  const advanced =
    unit === "DAY"
      ? addDays(zoned, steps)
      : unit === "WEEK"
        ? addWeeks(zoned, steps)
        : unit === "MONTH"
          ? addMonths(zoned, steps)
          : addYears(zoned, steps);
  return fromZonedTime(advanced, tz);
}

/** Same calendar day in the shop timezone? */
export function isSameShopDay(a: Date, b: Date, tz: string): boolean {
  return (
    format(toZonedTime(a, tz), "yyyy-MM-dd", { timeZone: tz }) ===
    format(toZonedTime(b, tz), "yyyy-MM-dd", { timeZone: tz })
  );
}

/** Is `date` on or before today's end, in the shop timezone? (i.e. due) */
export function isDueNow(date: Date, tz: string, now = new Date()): boolean {
  const dueDay = format(toZonedTime(date, tz), "yyyy-MM-dd", { timeZone: tz });
  const today = format(toZonedTime(now, tz), "yyyy-MM-dd", { timeZone: tz });
  return dueDay <= today;
}

/**
 * Payday alignment: given a candidate retry date, snap forward to the nearest
 * configured payday-of-month if one falls within `snapWindowDays` after it.
 */
export function alignToPayday(
  candidate: Date,
  tz: string,
  paydays: number[],
  snapWindowDays: number,
): Date {
  if (!paydays.length || snapWindowDays <= 0) return candidate;
  for (let offset = 0; offset <= snapWindowDays; offset++) {
    const probe = addDaysTz(candidate, offset, tz);
    const dom = Number(
      format(toZonedTime(probe, tz), "d", { timeZone: tz }),
    );
    if (paydays.includes(dom)) return probe;
  }
  return candidate;
}

export function formatShopDate(date: Date, tz: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale ?? "en", {
    dateStyle: "long",
    timeZone: tz,
  }).format(date);
}
