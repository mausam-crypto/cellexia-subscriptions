import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Collapsible,
  DataTable,
  Divider,
  InlineGrid,
  InlineStack,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import type {
  ConversionBlock,
  GuardrailStatus,
  GuardrailVerdict,
  Scoreboard,
  ScoreboardGrade,
  ScoreboardGroupBy,
  ScoreboardTotals,
  VariantRow,
} from "~/lib/design-measurement/types";
import { probabilityBetterThan } from "~/lib/design-measurement/types";
import type { DesignPeriod } from "~/lib/design-measurement/shared";
import { formatMoney } from "~/lib/money";

/**
 * Buy box designer, Results tab (v1.26.0, visits + conversion in v1.27.0) —
 * the merchant-facing readout of the design measurement engine.
 *
 * Client-safe on purpose: this file imports NOTHING server-side. Types come
 * from app/lib/design-measurement/types.ts (pure) and shared.ts (isomorphic);
 * the only value import is `probabilityBetterThan` (pure numerics) so the
 * "chance it beats the reference" column is computed in the browser and
 * re-computed instantly when the merchant changes the reference design.
 *
 * Data arrives lazily: the tab mounts only when selected, and on mount it
 * GETs the /app/buy-box/results resource route through a fetcher (the
 * designer page's own loader never pays for the scoreboard). Every control
 * change refetches; "Refresh now" adds fresh=1 to bypass the 10-minute
 * server cache. Settings and session counts POST to the same route with a
 * second fetcher, then the readout is refetched fresh so the guardrail
 * thresholds and conversion columns reflect what was just saved.
 *
 * v1.27.0: the storefront beacon records one visit per visitor per day per
 * (design, preselect) in WidgetVisitorDay, and the scoreboard joins it on the
 * same key as the order facts. That turns orders into CONVERSION (orders per
 * 100 visits, subscriptions per 100 visits) and, combined with the kept
 * rate, into the one number designs should be compared on: kept subscribers
 * per 100 visits after 30 days. Every visit-based cell degrades to plain
 * words when visits are missing (row.visits === null): a store that has not
 * deployed the v1.27.0 extension or has the app embed disabled reads
 * "no visits yet" and a banner, never NaN or an empty cell, and take rate /
 * kept rates keep working exactly as before. The typed-in Shopify sessions
 * stay as an optional cross-check of the beacon.
 *
 * ONE reference on the screen: the "Compare against" Select (default: the
 * real design with the most orders) drives BOTH the "chance it beats the
 * reference" column and the "Compare against the reference" card, and both
 * are computed here in the browser from the raw counts on each row with one
 * gating rule (compareAgainstReference). An earlier draft rendered the card
 * from a server-computed comparison that was always against the most-orders
 * row, so picking another design in the Select left two different
 * "references" on one screen with mirror-image chances for the same pair.
 * The guardrail keeps its own fixed baseline (the design with the most
 * orders) and is worded as "the guardrail baseline", never "the reference".
 *
 * Precision: per-100-visits rates are printed with two decimals and are
 * computed from the raw counts the scoreboard ships (orders counted over the
 * visit window ÷ visits) whenever those counts are present, so the digits on
 * the screen are real; the server's rounded rate is only a fallback for a
 * payload without the counts. Deltas are differences of those unrounded
 * rates, rounded once when printed.
 *
 * Copy rules: plain English, one line of explanation where each metric
 * appears, no em dashes.
 */

// ── Wire contract shared with app/routes/app.buy-box_.results.tsx ────────────

export const DESIGN_RESULTS_URL = "/app/buy-box/results";

export const RANGE_KEYS = ["30", "90", "365", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

/** designMeasurement settings as the route serialises them for the tab. */
export interface DesignMeasurementSettingsView {
  startedAt: string | null;
  excludeEmails: string[];
  guardrailMaxOrderDropPct: number;
  guardrailMinOrdersPerWeek: number;
  weeklySessions: Record<string, number>;
}

export interface DesignResultsMarket {
  handle: string;
  name: string | null;
}

/** GET /app/buy-box/results?range=&market=&group=&fresh= → this. */
export interface DesignResultsPayload {
  scoreboard: Scoreboard;
  settings: DesignMeasurementSettingsView;
  markets: DesignResultsMarket[];
  currencyCode: string;
  query: { range: RangeKey; market: string; group: ScoreboardGroupBy };
}

/** POST /app/buy-box/results (intent save-measurement-settings | save-sessions) → this. */
export interface DesignResultsActionData {
  ok: boolean;
  intent: string;
  toast: string;
}

// ── Formatting helpers (pure, local) ─────────────────────────────────────────

const RANGE_OPTIONS: { label: string; value: RangeKey }[] = [
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "Last 365 days", value: "365" },
  { label: "Since measurement start", value: "all" },
];

const GROUP_OPTIONS: { label: string; value: ScoreboardGroupBy }[] = [
  { label: "Design and preselected option", value: "variant" },
  { label: "Design only", value: "design" },
  { label: "Published revision", value: "revision" },
];

function fmtPct(pct: number | null | undefined, digits = 1): string {
  if (pct == null || !Number.isFinite(pct)) return "n/a";
  return `${pct.toFixed(digits)}%`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("en").format(n);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtCents(cents: number | null | undefined, currency: string): string {
  if (cents == null || !Number.isFinite(cents)) return "not yet";
  try {
    return formatMoney(Math.round(cents), currency);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "subscription_max" → "Subscription max" (kept local so this file stays value-import free). */
function presetTitle(key: string | null | undefined): string {
  if (!key) return "Unknown design";
  const words = key.replace(/[_-]+/g, " ").trim();
  if (!words) return "Unknown design";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function preselectWords(preselect: string | null | undefined): string {
  if (preselect === "sub") return "subscription preselected";
  if (preselect === "one") return "one-time preselected";
  return "";
}

function gradeBadge(grade: ScoreboardGrade) {
  if (grade === "usable") return <Badge tone="success">Usable</Badge>;
  if (grade === "direction_only") return <Badge tone="info">Direction only</Badge>;
  return <Badge tone="attention">Too early</Badge>;
}

function guardrailBadge(status: GuardrailStatus) {
  if (status === "ok") return <Badge tone="success">OK</Badge>;
  if (status === "watch") return <Badge tone="warning">Watch</Badge>;
  if (status === "breach") return <Badge tone="critical">Breach</Badge>;
  return <Badge>Not enough data</Badge>;
}

/**
 * Kept-rate cell. The percentage is heldSubscribed ÷ matureSubscribed, so the
 * fraction printed next to it must be exactly that pair (an earlier draft
 * printed "4 still active, 25 orders old enough" beside 40%, which a merchant
 * reads as 4/25 = 16%). Two distinct empty states: "not yet" when no order is
 * old enough for the horizon, "no subscribers yet" when orders have matured
 * but none of them subscribed (matured, nothing to keep; not immature).
 */
export function heldCell(rate: VariantRow["held"]["d30"]): string {
  if (rate.matureOrders === 0) return "not yet";
  if (rate.matureSubscribed === 0 || rate.pct == null) {
    return `no subscribers yet (${fmtInt(rate.matureOrders)} orders old enough)`;
  }
  return `${fmtPct(rate.pct)} (${fmtInt(rate.heldSubscribed)} of ${fmtInt(rate.matureSubscribed)} subscribers still active; ${fmtInt(rate.matureOrders)} orders old enough)`;
}

// ── Visits + conversion cells (v1.27.0) ──────────────────────────────────────

function finiteOrNull(n: number | null | undefined): number | null {
  return n == null || !Number.isFinite(n) ? null : n;
}

/**
 * numerator ÷ denominator × 100, UNROUNDED, from the raw counts on the row
 * (a zero denominator gives null, same as the server); the server's own
 * rounded rate is only the fallback for a payload that lacks a count. Never
 * row.orders as a stand-in numerator: the scoreboard counts only the orders
 * that fell on days with visit coverage (ConversionBlock.ordersCounted), and
 * a guessed numerator would put a wrong rate next to the right visits.
 */
function per100(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
  serverRate: number | null | undefined,
): number | null {
  const num = finiteOrNull(numerator);
  const den = finiteOrNull(denominator);
  if (num != null && den != null) return den > 0 ? (num / den) * 100 : null;
  return finiteOrNull(serverRate);
}

/**
 * Everything the tab needs from a row's visits and conversion, resolved
 * once: the raw counts that go into probabilityBetterThan and the three
 * per-100 rates at full precision (the scoreboard ships them rounded to 2
 * decimals; the tab prints 2 decimals of the unrounded ratio, so the digits
 * on the screen are real and never a rounding of a rounding). Exported for
 * the render test.
 */
export interface RowRates {
  /** Visitor-days on the row; null when the row carries no visits. */
  visits: number | null;
  /** Numerators as the scoreboard counted them (days with visit coverage only). */
  ordersCounted: number;
  subscribedCounted: number;
  keptCounted: number;
  maturedVisits: number | null;
  ordersPer100: number | null;
  subscriptionsPer100: number | null;
  keptPer100: number | null;
  /** addedToCart ÷ visits × 100 from the raw visit counts. */
  addToCartPct: number | null;
  firstVisitDay: string | null;
}

export function rowRates(row: VariantRow): RowRates {
  const conv: Partial<ConversionBlock> = row.conversion ?? {};
  const visits = row.visits ? finiteOrNull(row.visits.visits) : null;
  // A missing count (older payload) falls back to the row's plain count for
  // the chance maths, but never invents a rate: per100 then uses the server's.
  const ordersCounted = finiteOrNull(conv.ordersCounted) ?? row.orders;
  const subscribedCounted = finiteOrNull(conv.subscribedCounted) ?? row.subscribed;
  const keptCounted = finiteOrNull(conv.keptCounted) ?? row.held.d30.heldSubscribed;
  const maturedVisits = finiteOrNull(conv.maturedVisits);
  return {
    visits,
    ordersCounted,
    subscribedCounted,
    keptCounted,
    maturedVisits,
    ordersPer100: per100(conv.ordersCounted, visits, conv.ordersPer100Visits),
    subscriptionsPer100: per100(conv.subscribedCounted, visits, conv.subscriptionsPer100Visits),
    keptPer100: per100(conv.keptCounted, conv.maturedVisits, conv.keptSubscribersPer100VisitsD30),
    addToCartPct: row.visits ? per100(row.visits.addedToCart, visits, conv.addToCartPct) : null,
    firstVisitDay: typeof conv.firstVisitDay === "string" && conv.firstVisitDay ? conv.firstVisitDay : null,
  };
}

/** "1.52 per 100" for the per-100-visits rates; null → the caller's empty word. */
function fmtPer100(n: number | null | undefined, empty = "not yet"): string {
  if (n == null || !Number.isFinite(n)) return empty;
  return `${n.toFixed(2)} per 100`;
}

/**
 * Signed difference in points, e.g. "+0.42 pts" / "-3.1 pts". Conversion
 * deltas live in the 0.x range so they get two decimals; take rate / kept
 * deltas are whole-ish percentages and get one. null → "not yet" (one side
 * has not matured or has no visits).
 */
export function fmtDeltaPts(n: number | null | undefined, digits: 1 | 2 = 1): string {
  if (n == null || !Number.isFinite(n)) return "not yet";
  // `|| 0` folds -0 into 0 so a delta that rounds to nothing never prints "-0.0".
  const rounded = Number(n.toFixed(digits)) || 0;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(digits)} pts`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "YYYY-MM-DD" (a shop-tz day key) → "05 Sep 2026" without going through
 * Date or Intl on purpose: the key is a calendar day, not an instant (a
 * browser west of Greenwich would print the day before), and ICU's en-GB
 * short month varies by version ("Sep" / "Sept"), which would make the same
 * payload read differently per browser. Anything that is not a day key is
 * printed as is.
 */
function fmtDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const month = MONTHS_SHORT[Number(m[2]) - 1];
  return month ? `${m[3]} ${month} ${m[1]}` : day;
}

const DAY_MS = 86_400_000;

/**
 * The first day of the range as a "YYYY-MM-DD" key: computedAt minus the
 * trailing window, or the measurement start date for "since measurement
 * start" (null = all time). Derived in UTC, so it can sit a day off the
 * shop-tz day at the edges; the note it gates is informational ("orders
 * counted since ...") and a day of slack there is harmless, whereas printing
 * the note for every row would drown it.
 */
export function rangeStartDay(board: Pick<Scoreboard, "rangeDays" | "computedAt" | "startedAt">): string | null {
  if (board.rangeDays != null && Number.isFinite(board.rangeDays)) {
    const end = new Date(board.computedAt).getTime();
    if (Number.isNaN(end)) return null;
    return new Date(end - board.rangeDays * DAY_MS).toISOString().slice(0, 10);
  }
  return board.startedAt ? String(board.startedAt).slice(0, 10) : null;
}

/**
 * "120 orders counted since 05 Sep 2026" when the row's conversion numerator
 * starts later than the range does (the beacon went live after the range
 * start, so the scoreboard counts only the orders that fell on days with
 * visits, and the merchant must see that the row's Orders column and its
 * conversion are not over the same days). null when the visit window covers
 * the whole range or the payload has no first visit day.
 */
export function ordersSinceNote(
  firstVisitDay: string | null,
  rangeStart: string | null,
  ordersCounted?: number | null,
): string | null {
  if (!firstVisitDay) return null;
  if (rangeStart && firstVisitDay <= rangeStart) return null;
  const count = ordersCounted != null && Number.isFinite(ordersCounted) ? `${fmtInt(ordersCounted)} orders` : "orders";
  return `${count} counted since ${fmtDay(firstVisitDay)}`;
}

// ── One reference, one gating rule (v1.27.0) ────────────────────────────────

/**
 * A row against the reference the merchant picked in "Compare against":
 * deltas in points (row minus reference, unrounded, null when either side
 * has no value) and the chance the row is truly better, from
 * probabilityBetterThan over the raw counts. ONE gating rule for every
 * chance on the screen: while either design is "too early" (under 30
 * orders) no chance is printed at all, in the column or in the card; the
 * guide already says only usable rows should change a decision, and a
 * percentage next to a 12-order row reads as more than it is. Below the
 * gate a chance is null only when a side has no denominator (no visits, no
 * orders, no matured subscriber). Exported for the render test.
 */
export interface RowComparison {
  gate: "ok" | "too_early";
  deltas: {
    conversionPts: number | null;
    subscriptionConversionPts: number | null;
    takeRatePts: number | null;
    kept30Pts: number | null;
    keptPer100VisitsD30: number | null;
  };
  chance: { conversion: number | null; takeRate: number | null; kept30: number | null };
}

function delta(a: number | null, b: number | null): number | null {
  return a == null || b == null ? null : a - b;
}

export function compareAgainstReference(row: VariantRow, ref: VariantRow): RowComparison {
  const r = rowRates(row);
  const f = rowRates(ref);
  const gate: RowComparison["gate"] =
    row.grade === "too_early" || ref.grade === "too_early" ? "too_early" : "ok";
  const open = gate === "ok";
  return {
    gate,
    deltas: {
      conversionPts: delta(r.ordersPer100, f.ordersPer100),
      subscriptionConversionPts: delta(r.subscriptionsPer100, f.subscriptionsPer100),
      takeRatePts: delta(finiteOrNull(row.takeRatePct), finiteOrNull(ref.takeRatePct)),
      kept30Pts: delta(finiteOrNull(row.held.d30.pct), finiteOrNull(ref.held.d30.pct)),
      keptPer100VisitsD30: delta(r.keptPer100, f.keptPer100),
    },
    chance: {
      conversion:
        open && r.visits != null && f.visits != null && r.visits > 0 && f.visits > 0
          ? probabilityBetterThan(f.ordersCounted, f.visits, r.ordersCounted, r.visits)
          : null,
      takeRate:
        open && row.orders > 0 && ref.orders > 0
          ? probabilityBetterThan(ref.subscribed, ref.orders, row.subscribed, row.orders)
          : null,
      kept30:
        open && row.held.d30.matureSubscribed > 0 && ref.held.d30.matureSubscribed > 0
          ? probabilityBetterThan(
              ref.held.d30.heldSubscribed,
              ref.held.d30.matureSubscribed,
              row.held.d30.heldSubscribed,
              row.held.d30.matureSubscribed,
            )
          : null,
    },
  };
}

/**
 * The chance suffix on a comparison-card cell: ", 72% chance better", or
 * ", too early to say" while the gate is closed, or nothing when the chance
 * has no denominator on one side.
 */
export function chanceSuffix(gate: RowComparison["gate"], p: number | null): string {
  if (gate === "too_early") return ", too early to say";
  if (p == null || !Number.isFinite(p)) return "";
  return `, ${Math.round(p * 100)}% chance better`;
}

/**
 * The empty word for a visit-based cell when a row carries no visits. Three
 * cases a merchant must be able to tell apart: a synthetic row (no design to
 * attach visits to: "n/a"), a store where the beacon has recorded nothing in
 * the range ("no visits yet": the extension is not deployed or the app embed
 * is disabled, and the banner says so), and a grouping where visits cannot
 * be attached even though the shop has them (revision view: "not available
 * for this view"). Exported so the render test can pin the three words.
 */
export function visitsEmptyWord(rowKey: string, visitsTracked: boolean): string {
  if (SYNTHETIC_KEYS.has(rowKey)) return "n/a";
  return visitsTracked ? "not available for this view" : "no visits yet";
}

/**
 * Visits cell: the visitor count plus, when the beacon saw add-to-carts, the
 * share of visitors who added to cart, so the merchant sees engagement next
 * to reach without another column.
 */
export function visitsCell(row: VariantRow, visitsTracked: boolean): string {
  const v = row.visits;
  if (v == null) return visitsEmptyWord(row.key, visitsTracked);
  const atc = rowRates(row).addToCartPct;
  return atc == null ? fmtInt(v.visits) : `${fmtInt(v.visits)} (${fmtPct(atc, 0)} added to cart)`;
}

/**
 * Conversion-style cell over a row's visits: the empty word when the row has
 * no visits at all (null: beacon missing / view cannot attach them; zero: the
 * shop records visits but none carried this stamp), otherwise the rate or
 * `notYet` when the rate is null (immature).
 */
function per100Cell(
  row: VariantRow,
  value: number | null | undefined,
  visitsTracked: boolean,
  notYet: string,
): string {
  if (row.visits == null) return visitsEmptyWord(row.key, visitsTracked);
  if (row.visits.visits === 0) return "no visits";
  return fmtPer100(value, notYet);
}

/** Conversion cell (orders per 100 visits), from the raw counts when present. */
export function conversionCell(row: VariantRow, visitsTracked: boolean): string {
  return per100Cell(row, rowRates(row).ordersPer100, visitsTracked, "n/a");
}

/** Subscription conversion cell (subscriptions per 100 visits). */
export function subscriptionConversionCell(row: VariantRow, visitsTracked: boolean): string {
  return per100Cell(row, rowRates(row).subscriptionsPer100, visitsTracked, "n/a");
}

/**
 * Kept subscribers per 100 visits (30d): kept subscribers ÷ MATURED visits
 * × 100 (visits on days old enough for a 30-day horizon), null until a visit
 * day has matured. Distinguishes "no visits yet" (cannot be computed at all)
 * from "not yet" (visits present, none old enough), so a merchant never
 * mistakes a missing beacon for an immature cohort. The kept-subscriber
 * count that went into the rate rides along, but NOT "of N visits": the
 * denominator is the matured subset, and printing the full visit count next
 * to the rate would invite the same wrong division heldCell guards against.
 */
export function keptPer100Cell(row: VariantRow, visitsTracked: boolean): string {
  const rates = rowRates(row);
  const n = rates.keptPer100;
  const base = per100Cell(row, n, visitsTracked, "not yet");
  if (n == null || row.visits == null || row.visits.visits === 0) return base;
  return `${base} (${fmtInt(rates.keptCounted)} kept subscribers)`;
}

/**
 * Guardrail verdicts per design, one row each: the conversion-based verdict
 * (basis "conversion", available once both sides have visits in two or more
 * qualifying weeks) wins over the raw-orders one (basis "orders", also what
 * a v1.26.0 verdict without a basis field means). The scoreboard may ship
 * one verdict per key or both bases per key; either way the merchant reads
 * one line per design and the Basis column says which rule judged it.
 * Exported for the render test.
 */
export function pickGuardrailVerdicts(verdicts: ReadonlyArray<GuardrailVerdict>): GuardrailVerdict[] {
  const byKey = new Map<string, GuardrailVerdict>();
  for (const v of verdicts) {
    const current = byKey.get(v.key);
    if (!current) {
      byKey.set(v.key, v);
      continue;
    }
    if (verdictBasis(current) !== "conversion" && verdictBasis(v) === "conversion") {
      byKey.set(v.key, v);
    }
  }
  return [...byKey.values()];
}

/** Basis of a verdict; a verdict without one (older scoreboard) is orders-based. */
export function verdictBasis(v: GuardrailVerdict): "conversion" | "orders" {
  return v.basis === "conversion" ? "conversion" : "orders";
}

function basisWords(basis: "conversion" | "orders"): string {
  return basis === "conversion" ? "Conversion (orders per 100 visits)" : "Weekly orders";
}

/**
 * Days-with-visits coverage. The scoreboard reports the share of days in the
 * range that have at least one visit row (fraction 0..1) and, when it can,
 * the two counts behind it. Printed as "60% of days (18 of 30)"; a value
 * above 1 is read as a plain day count (defensive: never NaN, never a silent
 * 3,000%).
 */
export function fmtVisitCoverage(
  v: number | null | undefined,
  covered?: number | null,
  inRange?: number | null,
): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  const counts =
    covered != null && inRange != null && Number.isFinite(covered) && Number.isFinite(inRange)
      ? ` (${fmtInt(covered)} of ${fmtInt(inRange)})`
      : "";
  if (v <= 1) return `${Math.round(v * 100)}% of days${counts}`;
  return `${fmtInt(Math.round(v))} days`;
}

/** Local mirror of the settings validation so the merchant gets instant feedback before the round-trip. */
function parseIntField(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (n < min || n > max) return null;
  return n;
}

const SYNTHETIC_KEYS = new Set(["no_exposure", "unknown"]);

interface SettingsForm {
  startedAt: string;
  excludeEmails: string;
  guardrailMaxOrderDropPct: string;
  guardrailMinOrdersPerWeek: string;
}

function settingsToForm(s: DesignMeasurementSettingsView): SettingsForm {
  return {
    startedAt: s.startedAt ?? "",
    excludeEmails: s.excludeEmails.join("\n"),
    guardrailMaxOrderDropPct: String(s.guardrailMaxOrderDropPct),
    guardrailMinOrdersPerWeek: String(s.guardrailMinOrdersPerWeek),
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export interface DesignResultsProps {
  /** Markets known to the designer page (Shopify list); merged with the ones the readout has seen orders for. */
  markets: ReadonlyArray<{ handle: string; name: string }>;
  launchMode: string;
}

export function DesignResults({ markets, launchMode }: DesignResultsProps) {
  const shopify = useAppBridge();
  const [range, setRange] = useState<RangeKey>("all");
  const [market, setMarket] = useState("");
  const [group, setGroup] = useState<ScoreboardGroupBy>("variant");
  const [referencePick, setReferencePick] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);

  const fetcher = useFetcher<DesignResultsPayload>();
  const saveFetcher = useFetcher<DesignResultsActionData>();
  const { load } = fetcher;

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams({ range, market, group });
    return `${DESIGN_RESULTS_URL}?${params.toString()}`;
  }, [range, market, group]);

  // First mount + every control change: refetch (served from the 10-minute
  // cache when the same query was computed recently). `load` is stable in
  // Remix, so this never loops.
  useEffect(() => {
    load(queryUrl);
  }, [load, queryUrl]);

  const refresh = () => load(`${queryUrl}&fresh=1`);

  const data = fetcher.data;
  const board = data?.scoreboard;
  const loading = fetcher.state !== "idle";
  const currency = data?.currencyCode ?? "EUR";
  // totals.orders is counted AFTER the staff / foreign-only exclusions, so
  // "no orders" also covers "only test orders so far".
  const hasOrders = (board?.totals.orders ?? 0) > 0;

  // Settings form: mirrors the payload's settings until the merchant types,
  // then the typed draft sticks across background refetches (a refetch never
  // clobbers unsaved typing). Derived synchronously rather than seeded in an
  // effect so the form exists in the very same render the data arrives in
  // (and in a server render): the settings must be reachable BEFORE the
  // first order, not only after an effect tick.
  const [formDraft, setFormDraft] = useState<SettingsForm | null>(null);
  const [sessionsEdits, setSessionsEdits] = useState<Record<string, string> | null>(null);
  const form: SettingsForm | null = useMemo(
    () => formDraft ?? (data ? settingsToForm(data.settings) : null),
    [formDraft, data],
  );
  const sessionsDraft: Record<string, string> | null = useMemo(() => {
    if (sessionsEdits) return sessionsEdits;
    if (!data) return null;
    const seeded: Record<string, string> = {};
    for (const [week, n] of Object.entries(data.settings.weeklySessions)) {
      seeded[week] = String(n);
    }
    return seeded;
  }, [sessionsEdits, data]);
  const setForm = (next: SettingsForm) => setFormDraft(next);
  const setSessionsDraft = (next: Record<string, string>) => setSessionsEdits(next);

  // Save results: toast once per response, then a fresh refetch so verdicts
  // and conversion columns reflect the saved values.
  const lastSaveRef = useRef<DesignResultsActionData | null>(null);
  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data) return;
    if (lastSaveRef.current === saveFetcher.data) return;
    lastSaveRef.current = saveFetcher.data;
    shopify.toast.show(saveFetcher.data.toast, { isError: !saveFetcher.data.ok });
    if (saveFetcher.data.ok) load(`${queryUrl}&fresh=1`);
  }, [saveFetcher.state, saveFetcher.data, shopify, load, queryUrl]);

  const saving = saveFetcher.state !== "idle";

  // THE reference design, shared by the "chance it beats the reference"
  // column and the "Compare against the reference" card: the merchant's pick
  // in the Select while it names a comparable row, else the real design with
  // the most orders (rows are sorted by orders desc; synthetic rows such as
  // "No widget exposure" are not comparable and never default). Derived
  // synchronously rather than seeded in an effect so the very first render
  // (and a server render) already has a reference, and a refetch that drops
  // the picked row falls back on its own.
  const rows = useMemo(() => board?.rows ?? [], [board]);
  const comparableRows = useMemo(
    () => rows.filter((r) => !SYNTHETIC_KEYS.has(r.key)),
    [rows],
  );
  const reference = comparableRows.some((r) => r.key === referencePick)
    ? referencePick
    : (comparableRows[0]?.key ?? "");
  const referenceRow = comparableRows.find((r) => r.key === reference) ?? null;

  // Visits (v1.27.0). Two different absences a merchant must be able to tell
  // apart: "visits not recorded yet" (the SHOP has no visit rows in range:
  // extension not deployed, app embed disabled) and "no visits in this
  // selection" (the shop records visits, but none matched the market and
  // range chosen above, e.g. a market added after the last visit-to-market
  // refresh). The scoreboard says which with totals.visitsRecorded; a payload
  // without that field falls back to the older heuristic (any visits at all,
  // or any row carrying a visit block). When not recorded, every visit-based
  // cell reads "no visits yet" and the banner explains why; the beacon
  // WARNING fires only when the store is live and orders that saw the buy
  // box arrived without a single visit ON THE SHOP, which is the signature of
  // a missing extension deploy or a disabled app embed. A market with orders
  // but no visits never raises it.
  const totals: Partial<ScoreboardTotals> = board?.totals ?? {};
  const totalVisits = totals.visits ?? 0;
  const visitsRecorded =
    typeof totals.visitsRecorded === "boolean"
      ? totals.visitsRecorded
      : totalVisits > 0 || rows.some((r) => r.visits != null);
  const visitsTracked = visitsRecorded;
  const noVisitsInSelection = visitsRecorded && totalVisits === 0;
  const exposureOrders = board
    ? Math.max(0, board.totals.orders - (board.totals.noExposure ?? 0))
    : 0;
  const beaconWarning = launchMode === "LIVE" && exposureOrders > 0 && !visitsRecorded;
  // Some rows may lack visits although the shop has them (revision grouping
  // attaches visits per design, not per revision): say so once under the table.
  const visitsMissingForView =
    visitsTracked && comparableRows.length > 0 && comparableRows.some((r) => r.visits == null);
  // Overall conversion across the rows that carry visits (synthetic rows
  // never do), from the same numerators the rows use.
  const visitTotals = rows.reduce(
    (acc, r) => {
      if (!r.visits) return acc;
      const rates = rowRates(r);
      return { orders: acc.orders + rates.ordersCounted, visits: acc.visits + (rates.visits ?? 0) };
    },
    { orders: 0, visits: 0 },
  );
  const overallConversion =
    visitTotals.visits > 0 ? (visitTotals.orders / visitTotals.visits) * 100 : null;
  // "orders counted since <day>" notes (per row) when the visit window starts
  // after the range does; the same note is repeated once in the card helper.
  const rangeStart = board ? rangeStartDay(board) : null;

  // Market select: the designer's Shopify list plus every market the readout
  // has seen orders for (a deleted market keeps its rows readable).
  const marketOptions = useMemo(() => {
    const byHandle = new Map<string, string>();
    for (const m of markets) byHandle.set(m.handle, m.name);
    for (const m of data?.markets ?? []) {
      if (!byHandle.has(m.handle)) byHandle.set(m.handle, m.name ?? m.handle);
    }
    for (const m of board?.markets ?? []) {
      if (!byHandle.has(m.handle)) byHandle.set(m.handle, m.name ?? m.handle);
    }
    const list = [...byHandle.entries()]
      .map(([handle, name]) => ({ value: handle, label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: "", label: "All markets" }, ...list];
  }, [markets, data, board]);

  // ── Submits ────────────────────────────────────────────────────────────────

  const submitSettings = () => {
    if (!form) return;
    const maxDrop = parseIntField(form.guardrailMaxOrderDropPct, 0, 90);
    const minOrders = parseIntField(form.guardrailMinOrdersPerWeek, 0, 100000);
    if (maxDrop == null) {
      shopify.toast.show("Tolerated drop must be a whole number from 0 to 90", { isError: true });
      return;
    }
    if (minOrders == null) {
      shopify.toast.show("Minimum orders per week must be a whole number from 0 to 100000", { isError: true });
      return;
    }
    saveFetcher.submit(
      {
        intent: "save-measurement-settings",
        startedAt: form.startedAt.trim(),
        excludeEmails: form.excludeEmails,
        guardrailMaxOrderDropPct: String(maxDrop),
        guardrailMinOrdersPerWeek: String(minOrders),
      },
      { method: "post", action: DESIGN_RESULTS_URL },
    );
  };

  const submitSessions = () => {
    if (!sessionsDraft) return;
    const map: Record<string, number> = {};
    for (const [week, raw] of Object.entries(sessionsDraft)) {
      const trimmed = raw.trim();
      if (trimmed === "") continue;
      const n = parseIntField(trimmed, 0, 100000000);
      if (n == null) {
        shopify.toast.show(`Sessions for ${week} must be a whole number`, { isError: true });
        return;
      }
      map[week] = n;
    }
    saveFetcher.submit(
      { intent: "save-sessions", weeklySessions: JSON.stringify(map) },
      { method: "post", action: DESIGN_RESULTS_URL },
    );
  };

  // ── Derived table data ─────────────────────────────────────────────────────

  const scoreboardRows = rows.map((row) => {
    const isReference = referenceRow != null && row.key === referenceRow.key;
    // The take-rate chance against THE reference, through the same gate the
    // comparison card uses (compareAgainstReference), so the two never
    // disagree about the same pair.
    let chance: string;
    if (SYNTHETIC_KEYS.has(row.key)) chance = "n/a";
    else if (isReference) chance = "reference";
    else if (!referenceRow) chance = "n/a";
    else {
      const cmp = compareAgainstReference(row, referenceRow);
      chance =
        cmp.gate === "too_early"
          ? "too early"
          : cmp.chance.takeRate == null
            ? "n/a"
            : `${Math.round(cmp.chance.takeRate * 100)}%`;
    }
    const oneTimeShare = row.orders > 0 ? (row.oneTime / row.orders) * 100 : null;
    const ltgp = row.ltgp
      ? `${fmtCents(row.ltgp.m3, currency)} / ${fmtCents(row.ltgp.m6, currency)}`
      : "not yet";
    // Visit-based cells: the empty word depends on WHY visits are missing
    // (see per100Cell / visitsEmptyWord). When the row's conversion counts
    // orders only from its first visit day, the Conversion cell says so on a
    // second line, so Orders and Conversion are never read over the same days
    // by mistake.
    const rates = rowRates(row);
    const sinceNote =
      row.visits && row.visits.visits > 0
        ? ordersSinceNote(rates.firstVisitDay, rangeStart, rates.ordersCounted)
        : null;
    const conversionText = conversionCell(row, visitsTracked);
    const conversionNode = sinceNote ? (
      <BlockStack gap="050">
        <span>{conversionText}</span>
        <Text as="span" variant="bodySm" tone="subdued">
          {sinceNote}
        </Text>
      </BlockStack>
    ) : (
      conversionText
    );
    return [
      row.label,
      fmtInt(row.orders),
      fmtInt(row.subscribed),
      fmtPct(row.takeRatePct),
      visitsCell(row, visitsTracked),
      conversionNode,
      subscriptionConversionCell(row, visitsTracked),
      heldCell(row.held.d30),
      heldCell(row.held.d60),
      heldCell(row.held.d90),
      keptPer100Cell(row, visitsTracked),
      row.quickCancel14.pct == null
        ? "not yet"
        : `${fmtPct(row.quickCancel14.pct)} (${fmtInt(row.quickCancel14.cancelled)} of ${fmtInt(row.quickCancel14.matureSubscribed)})`,
      fmtPct(oneTimeShare),
      ltgp,
      chance,
      gradeBadge(row.grade),
    ];
  });

  // Guardrails: one line per design; conversion basis wins when present.
  const pickedVerdicts = pickGuardrailVerdicts(board?.guardrail.verdicts ?? []);
  const guardrailRows = pickedVerdicts.map((v) => {
    const row = rows.find((r) => r.key === v.key);
    return [row?.label ?? v.key, guardrailBadge(v.status), basisWords(verdictBasis(v)), v.detail];
  });
  const anyConversionBasis = pickedVerdicts.some((v) => verdictBasis(v) === "conversion");

  // Compare against the reference: computed HERE against referenceRow (the
  // Select's pick), one line per other comparable design, deltas in points
  // plus the chance that the design is truly better on conversion, take rate
  // and kept 30d. The scoreboard's own server-side comparison (always against
  // the most-orders row) is deliberately left unread: two references on one
  // screen is exactly the confusion this avoids.
  const comparisonReferenceLabel = referenceRow?.label ?? null;
  // A per-100 delta cell needs visits on BOTH sides; the words say which side is missing.
  const per100DeltaCell = (row: VariantRow, ref: VariantRow, d: number | null): string => {
    if (row.visits == null) return visitsEmptyWord(row.key, visitsTracked);
    if (row.visits.visits === 0) return "no visits";
    if (ref.visits == null || ref.visits.visits === 0) return "reference has no visits";
    return fmtDeltaPts(d, 2);
  };
  // A chance only ever follows a printed delta: "not yet" stays bare.
  const withChance = (text: string, d: number | null, gate: RowComparison["gate"], p: number | null) =>
    d == null ? text : `${text}${chanceSuffix(gate, p)}`;
  const comparisonRows = referenceRow
    ? comparableRows
        .filter((row) => row.key !== referenceRow.key)
        .map((row) => {
          const cmp = compareAgainstReference(row, referenceRow);
          const bothVisits =
            row.visits != null && row.visits.visits > 0 && referenceRow.visits != null && referenceRow.visits.visits > 0;
          const conversionText = per100DeltaCell(row, referenceRow, cmp.deltas.conversionPts);
          return [
            row.label,
            bothVisits
              ? withChance(conversionText, cmp.deltas.conversionPts, cmp.gate, cmp.chance.conversion)
              : conversionText,
            per100DeltaCell(row, referenceRow, cmp.deltas.subscriptionConversionPts),
            withChance(fmtDeltaPts(cmp.deltas.takeRatePts, 1), cmp.deltas.takeRatePts, cmp.gate, cmp.chance.takeRate),
            withChance(fmtDeltaPts(cmp.deltas.kept30Pts, 1), cmp.deltas.kept30Pts, cmp.gate, cmp.chance.kept30),
            per100DeltaCell(row, referenceRow, cmp.deltas.keptPer100VisitsD30),
          ];
        })
    : [];
  // The card and the scoreboard footnote repeat the "orders counted since"
  // explanation once when any design with visits has the note, so the
  // conversion figures are read over the right days.
  const anySinceNote = rows.some(
    (r) => r.visits != null && r.visits.visits > 0 && ordersSinceNote(rowRates(r).firstVisitDay, rangeStart) != null,
  );

  const weeklyDesigns = comparableRows.slice(0, 6);
  const hasSessions = (board?.conversion ?? []).some((c) => c.sessions != null);
  // Weekly visits + conversion per design ride along only when the beacon has
  // recorded visits (otherwise the extra columns would all read zero).
  const weeklyVisitDesigns = visitsTracked ? weeklyDesigns.filter((r) => r.visits != null) : [];
  const weeklyHeadings = [
    "Week",
    ...weeklyDesigns.map((r) => `${r.label}: orders / subscribed (take rate)`),
    ...weeklyVisitDesigns.map((r) => `${r.label}: visits (orders per 100 visits)`),
    ...(hasSessions ? ["Sessions (typed in)", "Orders per 100 sessions", "Subscriptions per 100 sessions"] : []),
  ];
  const weeklyRows = (board?.weeks ?? []).map((week, i) => {
    const cells: (string | number)[] = [week];
    for (const design of weeklyDesigns) {
      const bucket = design.weekly[i] ?? design.weekly.find((w) => w.week === week);
      if (!bucket) {
        cells.push("0 / 0");
        continue;
      }
      const rate = bucket.orders > 0 ? (bucket.subscribed / bucket.orders) * 100 : null;
      cells.push(`${fmtInt(bucket.orders)} / ${fmtInt(bucket.subscribed)} (${fmtPct(rate, 0)})`);
    }
    for (const design of weeklyVisitDesigns) {
      const bucket = design.weekly[i] ?? design.weekly.find((w) => w.week === week);
      const visits = bucket?.visits ?? 0;
      if (!bucket || visits === 0) {
        cells.push("0 visits");
        continue;
      }
      cells.push(`${fmtInt(visits)} (${fmtPer100((bucket.orders / visits) * 100)})`);
    }
    if (hasSessions) {
      const conv = board?.conversion.find((c) => c.week === week);
      cells.push(conv?.sessions == null ? "not entered" : fmtInt(conv.sessions));
      cells.push(fmtPct(conv?.conversionPct ?? null, 2));
      cells.push(fmtPct(conv?.subscriptionConversionPct ?? null, 2));
    }
    return cells;
  });

  const sessionWeeks = useMemo(() => {
    const set = new Set<string>(board?.weeks ?? []);
    for (const week of Object.keys(sessionsDraft ?? {})) set.add(week);
    return [...set].sort();
  }, [board, sessionsDraft]);

  const calendarRows = (board?.calendar ?? []).map((p: DesignPeriod) => [
    fmtDate(p.from instanceof Date ? p.from.toISOString() : String(p.from)),
    p.to ? fmtDate(p.to instanceof Date ? p.to.toISOString() : String(p.to)) : "now",
    p.marketHandle ?? "Default (all markets)",
    [p.label, presetTitle(p.preset), preselectWords(p.preselect)]
      .filter((s) => s && s.trim() !== "")
      .join(", "),
  ]);

  const hygieneTotals = rows.reduce(
    (acc, r) => ({
      promo: acc.promo + r.hygiene.promo,
      mixed: acc.mixed + r.hygiene.mixed,
      transition: acc.transition + r.hygiene.transition,
    }),
    { promo: 0, mixed: 0, transition: 0 },
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <BlockStack gap="400">
      {/* 1. Controls */}
      <BlockStack gap="200">
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300" alignItems="end">
          <Select
            label="Range"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(v) => setRange(v as RangeKey)}
          />
          <Select
            label="Market"
            options={marketOptions}
            value={market}
            onChange={setMarket}
          />
          <Select
            label="Group by"
            options={GROUP_OPTIONS}
            value={group}
            onChange={(v) => setGroup(v as ScoreboardGroupBy)}
          />
          <Button onClick={refresh} loading={loading && !!data} disabled={loading}>
            Refresh now
          </Button>
        </InlineGrid>
        <Text as="p" variant="bodySm" tone="subdued">
          {board
            ? `Data as of ${fmtDateTime(board.computedAt)} (${board.cached ? "cached, kept up to 10 minutes" : "freshly computed"}).${
                board.startedAt && range === "all"
                  ? ` Counting orders since ${fmtDate(board.startedAt)}.`
                  : ""
              }`
            : "Loading the latest results."}
        </Text>
      </BlockStack>

      {!data ? (
        <Box paddingBlock="600">
          <InlineStack align="center" gap="300" blockAlign="center">
            <Spinner accessibilityLabel="Loading results" size="small" />
            <Text as="span" tone="subdued">
              Computing take rate, kept rates and guardrails.
            </Text>
          </InlineStack>
        </Box>
      ) : null}

      {board && !hasOrders ? (
        /* 2. Empty state */
        <Banner tone="info" title="No orders to read yet">
          <BlockStack gap="200">
            <Text as="p">
              {board.totals.excludedStaff > 0
                ? `Every order in this range (${fmtInt(board.totals.excludedStaff)}) came from the staff and test emails you listed, so there is nothing to read yet. Real orders fill this tab in on their own.`
                : launchMode === "SETUP"
                  ? "Your store is in Setup mode, so the buy box is not shown to visitors yet. Once you go live and orders arrive for the products with a subscription option, this tab fills in on its own."
                  : "As soon as orders arrive for the products with a subscription option, this tab fills in on its own. Nothing else to install."}
            </Text>
            <Text as="p">What gets measured for every order:</Text>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              <li>Which buy box design the shopper saw, and whether subscription was the preselected option.</li>
              <li>How many visitors saw each design (one visit per visitor per day), so orders can be read as a conversion rate.</li>
              <li>Whether the order was a subscription or a one-time purchase (take rate).</li>
              <li>Whether the subscription is still active 30, 60 and 90 days later (kept rate) and quick cancels within 14 days.</li>
              <li>Weekly order counts per design (guardrail against a design that quietly costs you orders).</li>
              <li>Gross profit per subscriber over time (LTGP), once the subscribers are old enough.</li>
            </ul>
            {totalVisits > 0 ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {`Visits are already being recorded: ${fmtInt(totalVisits)} so far in this range. Conversion appears with the first orders.`}
              </Text>
            ) : null}
            <Text as="p" variant="bodySm" tone="subdued">
              You can already set the measurement start date and list staff or test buyer emails under Guardrails and settings below; orders from those emails are left out of every number on this tab.
            </Text>
          </BlockStack>
        </Banner>
      ) : null}

      {board && hasOrders ? (
        <>
          {/* 3. Scoreboard */}
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center" wrap>
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">
                    Scoreboard
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`${fmtInt(board.totals.orders)} orders, ${fmtInt(board.totals.subscribed)} subscribed (${fmtPct(
                      board.totals.orders > 0
                        ? (board.totals.subscribed / board.totals.orders) * 100
                        : null,
                    )} overall take rate).${
                      visitsTracked
                        ? ` ${fmtInt(totalVisits)} visits${
                            overallConversion != null
                              ? `, ${overallConversion.toFixed(2)} orders per 100 visits overall`
                              : ""
                          }.`
                        : ""
                    }`}
                  </Text>
                </BlockStack>
                {comparableRows.length > 1 ? (
                  <Box minWidth="260px">
                    <Select
                      label="Compare against"
                      options={comparableRows.map((r) => ({ label: r.label, value: r.key }))}
                      value={reference}
                      onChange={setReferencePick}
                    />
                  </Box>
                ) : null}
              </InlineStack>
              {!visitsRecorded ? (
                <Banner
                  tone={beaconWarning ? "warning" : "info"}
                  title={beaconWarning ? "No visits recorded although orders arrived" : "Visits are not recorded yet"}
                >
                  <Text as="p">
                    {beaconWarning
                      ? "Orders that saw the buy box arrived in this range, but not a single visit was recorded. Visit tracking needs the v1.27.0 extension deployed and the app embed enabled in your theme (Online Store, Themes, Customize, App embeds). Until then the visit and conversion columns read \"no visits yet\"; take rate and kept rates are not affected."
                      : "Visit tracking starts once the v1.27.0 extension is deployed with the app embed enabled in your theme. From that day on, every design shows visits, conversion (orders per 100 visits) and kept subscribers per 100 visits; earlier orders keep their take rate and kept rates."}
                  </Text>
                </Banner>
              ) : null}
              {noVisitsInSelection ? (
                <Banner tone="info" title="No visits in this selection">
                  <Text as="p">
                    Your store records visits, but none were recorded for the market and range selected above, so the visit and conversion cells read &quot;no visits&quot;. Take rate and kept rates are not affected. Visits from a market added recently are matched to it at the next data refresh.
                  </Text>
                </Banner>
              ) : null}
              <div style={{ overflowX: "auto" }}>
                <DataTable
                  columnContentTypes={[
                    "text",
                    "numeric",
                    "numeric",
                    "numeric",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "text",
                    "numeric",
                    "text",
                    "text",
                    "text",
                  ]}
                  headings={[
                    "Design",
                    "Orders",
                    "Subscribed",
                    "Take rate",
                    "Visits",
                    "Conversion (orders per 100 visits)",
                    "Subscription conversion (per 100 visits)",
                    "Kept 30d",
                    "Kept 60d",
                    "Kept 90d",
                    "Kept subscribers per 100 visits (30d)",
                    "Quick cancels (14d)",
                    "One-time share",
                    "LTGP per subscriber (M3 / M6)",
                    "Chance it beats the reference",
                    "Grade",
                  ]}
                  rows={scoreboardRows}
                />
              </div>
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">
                  Take rate: subscribed orders divided by all orders that saw the buy box. Visits: visitors who saw this design, counted once per day each. Conversion: orders per 100 visits; subscription conversion: subscription orders per 100 visits. Both compare only what the same design saw and sold, so a design that sells fewer subscriptions to more visitors cannot look better than it is.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Kept rates only count orders old enough (30, 60 or 90 days) and say how many of the subscribers among them were still active at that age; &quot;not yet&quot; means no order in that group is old enough, &quot;no subscribers yet&quot; means orders are old enough but none of them subscribed. Kept subscribers per 100 visits (30d): the subscribers still active after 30 days, per 100 visits from days old enough for that horizon; it combines conversion and net take rate in one number and is the number to compare designs on once it has matured.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Quick cancels: subscribers who cancelled within 14 days of ordering. LTGP per subscriber: gross profit earned per subscriber after 3 and 6 months, for subscribers old enough. Chance it beats the reference: how likely this design&apos;s true take rate is higher than the reference design&apos;s (the design chosen under &quot;Compare against&quot;), given the orders so far (50% means a coin flip); &quot;too early&quot; while either design has under 30 orders.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Grade: too early under 30 orders, direction only under 200, usable at 200 or more. Only usable rows should change a decision.
                </Text>
                {anySinceNote ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    &quot;Orders counted since&quot; under Conversion: visits for that design start on that day, later than the range does, so its conversion and subscription conversion count only the orders from that day on (the Orders column still counts the whole range).
                  </Text>
                ) : null}
                {visitsMissingForView ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Visits are attached per design and preselected option, so some rows in this view read &quot;not available for this view&quot;; switch Group by to &quot;Design and preselected option&quot; to see them.
                  </Text>
                ) : null}
              </BlockStack>
            </BlockStack>
          </Card>

          {/* 3b. Compare against the reference (v1.27.0): deltas + chance
              better against THE reference (the Select's pick), computed in
              the browser from the raw counts on each row. */}
          {comparisonRows.length > 0 ? (
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingMd">
                    Compare against the reference
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {`Each design against ${
                      comparisonReferenceLabel ? `"${comparisonReferenceLabel}"` : "the reference"
                    }, the design chosen under "Compare against" above (by default the design with the most orders in this range). Differences are in percentage points; "chance better" is how likely the design is truly better than the reference on that number, given the data so far (50% means a coin flip, above 90% is convincing); "too early to say" while either design has under 30 orders.`}
                  </Text>
                  {anySinceNote ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Conversion differences use each design&apos;s orders from its first day with visits (&quot;orders counted since&quot; under Conversion in the scoreboard), so they line up with the visits.
                    </Text>
                  ) : null}
                </BlockStack>
                <div style={{ overflowX: "auto" }}>
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text", "text"]}
                    headings={[
                      "Design",
                      "Conversion (orders per 100 visits)",
                      "Subscription conversion",
                      "Take rate",
                      "Kept 30d",
                      "Kept subscribers per 100 visits (30d)",
                    ]}
                    rows={comparisonRows}
                  />
                </div>
                <Text as="p" variant="bodySm" tone="subdued">
                  Read it left to right: conversion must hold first, then take rate, then kept 30d. The last column is the one to decide on once it reads a number for both designs; &quot;not yet&quot; means one side has no order old enough or no visits.
                </Text>
              </BlockStack>
            </Card>
          ) : null}
        </>
      ) : null}

      {/* Cards 4, 5 and 7 render whenever data is present, INDEPENDENT of
          totals.orders: the settings (start date, staff emails, guardrail
          thresholds), the sessions editor and the design calendar are exactly
          what a merchant needs BEFORE the first order (pre-launch store) or
          when every order so far was a staff test. Only the tables that need
          orders (scoreboard, verdicts, weekly, data quality) wait for them. */}
      {board ? (
        <>
          {/* 4. Guardrails + settings */}
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  Guardrails and settings
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  A design that lifts take rate but loses orders is a loss. Each design is compared with the design with the most orders (the guardrail baseline, fixed; not the &quot;Compare against&quot; pick above) week by week; a drop larger than your tolerance over two or more weeks is a breach.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {anyConversionBasis
                    ? "Basis: where both designs have visits in two or more full weeks, the verdict compares weekly conversion (orders per 100 visits), which is fair even when the designs did not get the same traffic. Designs without enough visits fall back to raw weekly orders. The Basis column says which rule judged each line."
                    : "Basis: raw weekly orders. Once visits are recorded for two or more full weeks, verdicts switch to weekly conversion (orders per 100 visits), which is fair even when the designs did not get the same traffic."}
                </Text>
              </BlockStack>
              {hasOrders && guardrailRows.length > 0 ? (
                <DataTable
                  columnContentTypes={["text", "text", "text", "text"]}
                  headings={["Design", "Status", "Basis", "What we see"]}
                  rows={guardrailRows}
                />
              ) : (
                <Text as="p" tone="subdued">
                  Guardrail verdicts appear once at least two designs have a full week of orders.
                </Text>
              )}
              <Divider />
              {form ? (
                <BlockStack gap="300">
                  <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
                    <TextField
                      label="Tolerated weekly order drop (%)"
                      type="number"
                      min={0}
                      max={90}
                      value={form.guardrailMaxOrderDropPct}
                      onChange={(v) => setForm({ ...form, guardrailMaxOrderDropPct: v })}
                      autoComplete="off"
                      helpText="How far below the guardrail baseline (the design with the most orders) a design's weekly orders may fall before it counts as a breach."
                    />
                    <TextField
                      label="Minimum orders per week"
                      type="number"
                      min={0}
                      max={100000}
                      value={form.guardrailMinOrdersPerWeek}
                      onChange={(v) => setForm({ ...form, guardrailMinOrdersPerWeek: v })}
                      autoComplete="off"
                      helpText="Guardrails only judge once the guardrail baseline (the design with the most orders) averages at least this many orders per week, so a store that is still quiet cannot raise a false alarm. Set it to roughly a third of your normal weekly orders."
                    />
                    <TextField
                      label="Measurement start date"
                      value={form.startedAt}
                      onChange={(v) => setForm({ ...form, startedAt: v })}
                      autoComplete="off"
                      placeholder="2026-09-01"
                      helpText={'Orders before this date are left out of the "since measurement start" range. Leave empty for all time.'}
                    />
                  </InlineGrid>
                  <TextField
                    label="Staff and test buyer emails"
                    value={form.excludeEmails}
                    onChange={(v) => setForm({ ...form, excludeEmails: v })}
                    autoComplete="off"
                    multiline={3}
                    placeholder={"you@yourbrand.com\ntester@yourbrand.com"}
                    helpText="One per line or separated by commas. Orders from these emails are left out of every number on this tab; saving applies right away to the orders already recorded as well as to new ones."
                  />
                  <InlineStack align="end">
                    <Button variant="primary" onClick={submitSettings} loading={saving}>
                      Save settings
                    </Button>
                  </InlineStack>
                </BlockStack>
              ) : null}
            </BlockStack>
          </Card>

          {/* 5. Weekly view + sessions */}
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  Week by week
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Orders and subscribed orders per design for each week in the range (Monday to Sunday, your store&apos;s time zone)
                  {visitsTracked
                    ? ", plus the visits each design got that week and its conversion (orders per 100 visits)"
                    : ""}
                  . Read whole weeks only: a partial week always looks worse.
                </Text>
              </BlockStack>
              {hasOrders && weeklyRows.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <DataTable
                    columnContentTypes={weeklyHeadings.map(() => "text")}
                    headings={weeklyHeadings}
                    rows={weeklyRows}
                  />
                </div>
              ) : (
                <Text as="p" tone="subdued">
                  {hasOrders
                    ? "No full week in this range yet."
                    : "The week by week table fills in once orders arrive."}
                </Text>
              )}
              <Divider />
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">
                  Optional cross-check: Shopify sessions
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  {visitsTracked
                    ? "Visits are recorded by the buy box itself, so this is optional: type in the weekly product page sessions from Shopify Analytics to check the beacon against Shopify's own count (sessions run a little higher than visits, since a visit is one visitor per day per design). "
                    : "Until visits are recorded, you can type in the weekly product page sessions from Shopify Analytics to get a rough conversion rate per week. "}
                  In Shopify Analytics open Reports, then &quot;Sessions by landing page&quot; (or &quot;Online store conversion over time&quot;), set the date range to one week Monday to Sunday and filter to your product pages.
                </Text>
                {sessionWeeks.length > 0 && sessionsDraft ? (
                  <BlockStack gap="200">
                    <InlineGrid columns={{ xs: 2, sm: 3, md: 4, lg: 6 }} gap="200">
                      {sessionWeeks.map((week) => (
                        <TextField
                          key={week}
                          label={week}
                          type="number"
                          min={0}
                          value={sessionsDraft[week] ?? ""}
                          onChange={(v) => setSessionsDraft({ ...sessionsDraft, [week]: v })}
                          autoComplete="off"
                          placeholder="sessions"
                        />
                      ))}
                    </InlineGrid>
                    <InlineStack align="end">
                      <Button onClick={submitSessions} loading={saving}>
                        Save sessions
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">
                    Weeks appear here once the range holds orders or a measurement start date is set.
                  </Text>
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </>
      ) : null}

      {/* 6. Data quality: shown as soon as ANY order was recorded, staff-excluded
          ones included, so a merchant who has only placed test orders sees them
          counted under "Staff and test orders (left out)". */}
      {board &&
      (hasOrders ||
        board.totals.excludedStaff > 0 ||
        board.totals.excludedForeignOnly > 0 ||
        totalVisits > 0) ? (
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Data quality
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                How trustworthy the numbers above are. Coverage well below 100% usually means a theme or app installs the buy box in a way that skips the storefront marker; the design calendar then fills the gap.
              </Text>
            </BlockStack>
            {beaconWarning ? (
              <Banner tone="warning" title="Visit beacon: nothing received">
                <Text as="p">
                  {`Your store is live and ${fmtInt(exposureOrders)} orders that saw the buy box arrived in this range, but zero visits were recorded. Most likely the v1.27.0 extension is not deployed yet or the app embed is disabled in the theme (a theme block alone shows the buy box but sends no visits). The Debug page's self-check "widget_visits" reports the same.`}
                </Text>
              </Banner>
            ) : null}
            <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="300">
              <QualityStat
                label="Visits recorded"
                value={fmtInt(totalVisits)}
                hint={
                  noVisitsInSelection
                    ? "Visitors who saw the buy box in this range, counted once per day per design. Your store records visits; none matched the selected market and range."
                    : "Visitors who saw the buy box in this range, counted once per day per design. Zero while the v1.27.0 extension is not deployed or the app embed is disabled."
                }
              />
              <QualityStat
                label="Days with visits"
                value={fmtVisitCoverage(
                  board.totals.visitCoverageDays,
                  board.totals.visitDaysCovered,
                  board.totals.visitDaysInRange,
                )}
                hint="Share of the days in this range with at least one recorded visit. Gaps mean the beacon was off or blocked on those days."
              />
              <QualityStat
                label="Last visit"
                value={board.totals.lastVisitAt ? fmtDateTime(board.totals.lastVisitAt) : "none yet"}
                hint="When the beacon last recorded a visit. An old time while the store is busy means the beacon stopped."
              />
              <QualityStat
                label="Seen coverage"
                value={fmtPct(board.totals.seenCoveragePct, 0)}
                hint="Orders where the storefront itself recorded which design the shopper saw."
              />
              <QualityStat
                label="Calendar agreement"
                value={fmtPct(board.totals.calendarAgreementPct, 0)}
                hint="Orders whose recorded design matches what the design calendar says was live."
              />
              <QualityStat
                label="No widget exposure"
                value={fmtInt(board.totals.noExposure)}
                hint="Orders for a subscribable product placed without the buy box (quick buy, cart drawer, checkout link)."
              />
              <QualityStat
                label="Other app plans only (left out)"
                value={fmtInt(board.totals.excludedForeignOnly)}
                hint="Orders that only carried another app's subscription plan; not ours to measure."
              />
              <QualityStat
                label="Staff and test orders (left out)"
                value={fmtInt(board.totals.excludedStaff)}
                hint="Orders from the emails listed under settings."
              />
              <QualityStat
                label="Subscribed without a design"
                value={fmtInt(board.totals.unattributedSubscribed)}
                hint="Subscriptions we could not tie to any design; they count in totals, not in any row."
              />
              <QualityStat
                label="With a discount code"
                value={fmtInt(hygieneTotals.promo)}
                hint="Promotions lift take rate on their own; compare designs over periods with similar promo mix."
              />
              <QualityStat
                label="Mixed with another app"
                value={fmtInt(hygieneTotals.mixed)}
                hint="Orders carrying both our line and another app's subscription plan."
              />
              <QualityStat
                label="Placed within a day of a publish"
                value={fmtInt(hygieneTotals.transition)}
                hint="Orders around a design change, where the shopper may have seen either design."
              />
            </InlineGrid>
          </BlockStack>
        </Card>
      ) : null}

      {/* 7. Design calendar (always with data: the calendar starts with the
          first publish, long before the first order) */}
      {board ? (
        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Design calendar
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Which design was live when, per market. Use these dates when you read Shopify Analytics side by side with this tab.
              </Text>
            </BlockStack>
            {calendarRows.length > 0 ? (
              <DataTable
                columnContentTypes={["text", "text", "text", "text"]}
                headings={["From", "To", "Market", "Design"]}
                rows={calendarRows}
              />
            ) : (
              <Text as="p" tone="subdued">
                No published design yet. The calendar starts with your first publish.
              </Text>
            )}
          </BlockStack>
        </Card>
      ) : null}

      {/* 8. How to read this */}
      {board ? (
        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">
                How to read this
              </Text>
              <Button
                variant="plain"
                onClick={() => setHelpOpen((o) => !o)}
                ariaExpanded={helpOpen}
                ariaControls="design-results-help"
              >
                {helpOpen ? "Hide" : "Show"}
              </Button>
            </InlineStack>
            <Collapsible id="design-results-help" open={helpOpen}>
              <BlockStack gap="200">
                <Text as="p" variant="bodySm">
                  <strong>Visits:</strong> a visitor who saw the buy box, counted once per day per design and preselected option (recorded by the buy box itself; needs the v1.27.0 extension with the app embed enabled).{" "}
                  <strong>Conversion:</strong> orders per 100 visits of the same design.{" "}
                  <strong>Subscription conversion:</strong> subscription orders per 100 visits.{" "}
                  <strong>Take rate:</strong> subscribed orders divided by all orders that saw the buy box.{" "}
                  <strong>Kept 30/60/90:</strong> of the subscribers whose order is at least that old, the share still active at that age.{" "}
                  <strong>Kept subscribers per 100 visits (30d):</strong> subscribers still active after 30 days, per 100 visits of that design from days old enough for the 30-day horizon.{" "}
                  <strong>Quick cancels:</strong> subscribers who cancelled within 14 days.{" "}
                  <strong>One-time share:</strong> orders that chose one-time purchase.{" "}
                  <strong>LTGP per subscriber:</strong> gross profit per subscriber after 3 and 6 months, for subscribers old enough.{" "}
                  <strong>Guardrail:</strong> weekly conversion (or weekly orders where visits are missing) per design against the design with the most orders (the guardrail baseline; the &quot;Compare against&quot; pick does not move it); a breach means the design is costing orders.{" "}
                  <strong>Chance better:</strong> in the scoreboard column and the compare card, both against the design chosen under &quot;Compare against&quot;, and both silent (&quot;too early&quot;) while either design has under 30 orders.
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>Why kept subscribers per 100 visits is the number to compare designs on:</strong> a design can win take rate by pushing subscription on fewer, more determined buyers, and lose on total orders; it can win conversion by selling one-time to everyone, and lose the subscribers you wanted. Kept subscribers per 100 visits multiplies conversion, take rate and the 30-day kept rate into one number: how many lasting subscribers each 100 visitors turned into. Whichever design is higher there, once matured and with enough visits, is the better design.
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>Sample size:</strong> to see a 10 point difference in take rate (say 30% against 40%) you need about 300 orders per design; a 5 point difference needs about 1,100 per design. Conversion moves in fractions of a point, so it needs visits in the thousands per design. Below that, treat the numbers as direction only.
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>The order to read metrics in:</strong> first conversion and orders per week must hold (guardrail), then take rate, then kept 30/60/90, then kept subscribers per 100 visits, then LTGP once subscribers are mature. A higher take rate that does not keep its subscribers is not a win.
                </Text>
                <Text as="p" variant="bodySm">
                  <strong>How to run a test:</strong> change one design at a time, run whole weeks (Monday to Sunday), keep the same design in every market during the test, name each design when you publish, and avoid promotions that only overlap one design.
                </Text>
              </BlockStack>
            </Collapsible>
          </BlockStack>
        </Card>
      ) : null}
    </BlockStack>
  );
}

function QualityStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Box padding="300" borderColor="border" borderWidth="025" borderRadius="200">
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {hint}
        </Text>
      </BlockStack>
    </Box>
  );
}
