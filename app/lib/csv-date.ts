/**
 * Strict `next_charge_date` parsing, shared by BOTH subscriber importers —
 * the admin route (app/routes/app.import.tsx) and the CLI
 * (scripts/import-subscribers.ts) — so the two can never drift. Pure module
 * (no server deps): the route bundles it and the script imports it directly.
 *
 * Accepted, exactly as the row-schema error message promises:
 *  - `YYYY-MM-DD` — parsed at 12:00 UTC so the calendar day survives any
 *    shop timezone;
 *  - a strict ISO-8601 timestamp — `YYYY-MM-DDTHH:mm[:ss[.sss]]` with an
 *    explicit `Z` or `±HH[:]MM` offset.
 *
 * Everything else returns null and surfaces as a row error in the dry run.
 * This used to fall back to bare `new Date(value)`, which silently accepted
 * exactly the values a migration CSV is most likely to contain:
 *  - "05/06/2026" (European DMY for 5 June) parsed as US MDY May 6 in the
 *    SERVER's local timezone — every migrated subscriber billed roughly a
 *    month off their real schedule;
 *  - "June 5, 2026" and other prose dates parsed;
 *  - a spreadsheet-degraded bare "2026" parsed as Jan 1 2026 — in the past,
 *    so resolveNextBillingDate silently moved the charge to TOMORROW: an
 *    unauthorized early charge on a stored payment method the day after
 *    cutover;
 *  - "2026-02-30" rolled over to Mar 2 on V8 instead of failing.
 * Calendar components are validated here (not via Date round-trip) precisely
 * because the engine's rollover behavior is what made the last case invisible.
 */

const BARE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DDTHH:mm[:ss[.fraction]](Z|±HH:MM|±HHMM)`. The offset is
 * mandatory: a wall-clock timestamp without one would be read in the
 * server's timezone — the exact ambiguity this module exists to reject.
 */
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Days in `month` (1-based) of `year`, Gregorian. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validCalendarDay(year: number, month: number, day: number): boolean {
  return (
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
  );
}

export function parseCsvDate(value: string): Date | null {
  const v = value.trim();

  const bare = BARE_DATE_RE.exec(v);
  if (bare) {
    const [year, month, day] = [bare[1], bare[2], bare[3]].map(Number);
    if (!validCalendarDay(year, month, day)) return null;
    const date = new Date(`${v}T12:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const ts = ISO_TIMESTAMP_RE.exec(v);
  if (!ts) return null;
  const [year, month, day, hour, minute] = [
    ts[1],
    ts[2],
    ts[3],
    ts[4],
    ts[5],
  ].map(Number);
  const second = ts[6] != null ? Number(ts[6]) : 0;
  if (!validCalendarDay(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offset = ts[7];
  if (offset !== "Z") {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(-2));
    if (offsetHours > 14 || offsetMinutes > 59) return null;
  }

  const date = new Date(v);
  return Number.isNaN(date.getTime()) ? null : date;
}
