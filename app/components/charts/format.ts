/**
 * Client-safe number and date-label formatting for every analytics view
 * (ANALYTICS-V2 §3, dashboard owner). Two hard rules live here:
 *
 * 1. Money is integer cents in, formatted string out — no view does its own
 *    `toFixed` on money.
 * 2. Date labels are derived from the ISO "YYYY-MM-DD" string itself, never
 *    by parsing it into a `Date`. `new Date("2026-08-03")` is UTC midnight,
 *    which Intl renders as the previous day on any server west of UTC —
 *    that drift produced Monday weeks labelled with Sunday dates.
 *
 * Everything is deterministic on server and client (fixed "en" locale) so
 * SSR and hydration always agree.
 */

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Format integer minor units, e.g. (3840, "EUR") -> "€38.40". Whole amounts
 * drop the decimals ("€40") so axis ticks and tiles stay readable.
 */
export function fmtMoney(cents: number, currency: string): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0;
  const whole = safe % 100 === 0;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(safe / 100);
  } catch {
    // Unknown/blank currency code: fall back to a plain decimal + code.
    return `${(safe / 100).toFixed(whole ? 0 : 2)} ${currency}`.trim();
  }
}

/** Format a fraction 0..1 as a percentage, e.g. (0.05) -> "5.0%". */
export function fmtPct(fraction: number, dp = 1): string {
  const safe = Number.isFinite(fraction) ? fraction : 0;
  return `${(safe * 100).toFixed(dp)}%`;
}

/**
 * Fraction-aware plain-number formatter for axis ticks and bar labels.
 * `String(Math.round(v))` — the old chart default — rendered the ticks
 * [0, 0.45, 0.9] as "0", "0", "1": duplicate gridline labels and bars of
 * 0.4 units labelled "0". Small magnitudes keep enough decimals to stay
 * distinct; large magnitudes stay integers.
 */
export function fmtNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (Number.isInteger(value) || abs >= 10) return String(Math.round(value));
  if (abs >= 0.1) return value.toFixed(1);
  return value.toFixed(2);
}

export type DeltaFormat = "count" | "cents" | "rate" | "decimal";

/**
 * Signed period-over-period delta text: rates in percentage points
 * ("+2.1 pp"), money via fmtMoney ("+€12.40"), counts and decimals signed.
 */
export function fmtDelta(
  delta: number,
  format: DeltaFormat,
  currency = "EUR",
): string {
  const safe = Number.isFinite(delta) ? delta : 0;
  const sign = safe > 0 ? "+" : "";
  switch (format) {
    case "rate":
      return `${sign}${(safe * 100).toFixed(1)} pp`;
    case "cents":
      return `${sign}${fmtMoney(safe, currency)}`;
    case "decimal":
      return `${sign}${safe.toFixed(2)}`;
    case "count":
      return `${sign}${Math.round(safe)}`;
  }
}

/**
 * Short human label for an ISO "YYYY-MM-DD" string, e.g. "2026-08-03" ->
 * "3 Aug". Pure string slicing — no Date construction, so the label can
 * never drift a day with the server or browser timezone. Unrecognised
 * input is returned untouched.
 */
export function fmtDateLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return isoDate;
  return `${day} ${MONTHS_SHORT[monthIndex]}`;
}
