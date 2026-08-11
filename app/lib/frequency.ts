import { z } from "zod";

/**
 * Multi-unit order frequency (v1.8.0).
 *
 * A plan frequency is a `{ unit, count }` pair — "every 10 days", "every 2
 * weeks", "every 1 month" — and one selling plan group may mix units freely.
 * Before v1.8.0 the app stored plan frequencies as whole-week integers
 * (SellingPlanConfig.frequenciesWeeks / defaultFrequencyWeeks); those columns
 * remain the fallback for rows saved before the multi-unit columns existed
 * and keep being written as approximations so a rollback to a pre-v1.8.0
 * build still sees a coherent (week-only) view of every config.
 *
 * ISOMORPHIC MODULE — imported by client route components (admin plans UI)
 * as well as server code. No Prisma, no server-only imports here (the
 * `ownership.server` build failure of v1.6.1 is the cautionary tale).
 */

/** Units a merchant can offer on a plan. */
export const FREQUENCY_UNITS = ["DAY", "WEEK", "MONTH"] as const;
export type FrequencyUnit = (typeof FREQUENCY_UNITS)[number];

/**
 * Units a mirrored Shopify billing policy can carry. Plans this app creates
 * never use YEAR, but foreign/imported contracts can — conversion helpers
 * accept it so contract-side math never meets an unknown unit.
 */
export type IntervalUnit = FrequencyUnit | "YEAR";

export interface Frequency {
  unit: FrequencyUnit;
  count: number;
}

/**
 * Per-unit count ranges for merchant-offered frequencies. WEEK keeps the
 * historical 1–26 admin range; DAY and MONTH are bounded to cadences that
 * make sense for a replenishment product (and stay far inside anything
 * Shopify accepts for a SellingPlanInterval count).
 */
export const FREQUENCY_COUNT_LIMITS: Record<
  FrequencyUnit,
  { min: number; max: number }
> = {
  DAY: { min: 1, max: 90 },
  WEEK: { min: 1, max: 26 },
  MONTH: { min: 1, max: 12 },
};

export const frequencySchema = z.object({
  unit: z.enum(FREQUENCY_UNITS),
  count: z.number().int().positive(),
});

export const frequenciesSchema = z.array(frequencySchema);

/** Range error for one frequency, or null when it is within limits. */
export function frequencyRangeError(freq: Frequency): string | null {
  const limits = FREQUENCY_COUNT_LIMITS[freq.unit];
  if (freq.count < limits.min || freq.count > limits.max) {
    const noun = UNIT_NOUNS[freq.unit].plural;
    return `Frequencies in ${noun} must be between ${limits.min} and ${limits.max}`;
  }
  return null;
}

export function sameFrequency(a: Frequency, b: Frequency): boolean {
  return a.unit === b.unit && a.count === b.count;
}

/**
 * Stable machine token for form values and set membership: "10:DAY",
 * "2:WEEK". Never shown to customers.
 */
export function frequencyToken(freq: Frequency): string {
  return `${freq.count}:${freq.unit}`;
}

export function parseFrequencyToken(token: string): Frequency | null {
  const match = /^(\d+):(DAY|WEEK|MONTH)$/.exec(token.trim());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  return { unit: match[2] as FrequencyUnit, count };
}

// ── Ordering + dedupe ─────────────────────────────────────────────────────────

/** Sort key only — display order, never money or scheduling math. */
export function approxDays(unit: IntervalUnit, count: number): number {
  switch (unit) {
    case "DAY":
      return count;
    case "WEEK":
      return count * 7;
    case "MONTH":
      return count * 30;
    case "YEAR":
      return count * 365;
  }
}

const UNIT_ORDER: Record<FrequencyUnit, number> = { DAY: 0, WEEK: 1, MONTH: 2 };

/**
 * Dedupe exact `{unit, count}` pairs and sort shortest-cadence first (ties —
 * "7 days" vs "1 week" — order by unit granularity). Equivalent-duration
 * pairs in different units are deliberately kept: they are distinct selling
 * plans with distinct customer-facing names.
 */
export function normalizeFrequencies(list: Frequency[]): Frequency[] {
  const seen = new Set<string>();
  const out: Frequency[] = [];
  for (const freq of list) {
    const token = frequencyToken(freq);
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(freq);
  }
  return out.sort(
    (a, b) =>
      approxDays(a.unit, a.count) - approxDays(b.unit, b.count) ||
      UNIT_ORDER[a.unit] - UNIT_ORDER[b.unit],
  );
}

// ── Week approximation (the pre-v1.4.0 lingua franca) ────────────────────────

/**
 * `{unit, count}` → whole weeks. MONTH×4, DAY ceil/7 and YEAR×52 are
 * approximations — acceptable for the surfaces that key off intervalWeeks
 * (scheduling display, consolidation grouping, risk features); money math
 * must use the exact unit/count instead (see computeMrrCents).
 * Same math as the contract mirror has used since v1.4.0.
 */
export function approxWeeks(unit: IntervalUnit | string, count: number): number {
  const n = Math.max(1, count);
  switch (unit) {
    case "WEEK":
      return n;
    case "MONTH":
      return n * 4;
    case "DAY":
      return Math.max(1, Math.ceil(n / 7));
    case "YEAR":
      return n * 52;
    default:
      return n;
  }
}

// ── Config parsing (Prisma Json columns, defensively) ────────────────────────

const legacyWeeksSchema = z.array(z.number().int().positive());

interface FrequencyConfigColumns {
  frequencies: unknown;
  defaultFrequency: unknown;
  frequenciesWeeks: unknown;
  defaultFrequencyWeeks: number;
}

/**
 * The offered frequencies of a SellingPlanConfig row: the multi-unit
 * `frequencies` column when present, valid AND coherent with the legacy week
 * columns, else the legacy week-integer column, else the default frequency
 * alone. Always normalized, never empty.
 *
 * Coherence check: every v1.8.0 writer stores frequenciesWeeks as exactly the
 * approxWeeks projection of `frequencies` (as a set), so a mismatch can only
 * mean the WEEK COLUMNS WERE EDITED BY A PRE-v1.8.0 BUILD after the Json was
 * written (a rollback-window plan edit). The legacy columns are then the
 * newer truth and win — otherwise rolling forward would silently revert the
 * merchant's rollback-era edit to the stale multi-unit list.
 */
export function parseConfigFrequencies(
  config: FrequencyConfigColumns,
): Frequency[] {
  const parsed = frequenciesSchema.safeParse(config.frequencies);
  const legacy = legacyWeeksSchema.safeParse(config.frequenciesWeeks);
  if (parsed.success && parsed.data.length > 0) {
    const projected = new Set(
      parsed.data.map((f) => approxWeeks(f.unit, f.count)),
    );
    const stored = new Set(legacy.success ? legacy.data : []);
    const coherent =
      !legacy.success ||
      legacy.data.length === 0 ||
      (projected.size === stored.size &&
        [...projected].every((w) => stored.has(w)));
    if (coherent) return normalizeFrequencies(parsed.data);
  }
  if (legacy.success && legacy.data.length > 0) {
    return normalizeFrequencies(
      legacy.data.map((count) => ({ unit: "WEEK" as const, count })),
    );
  }
  return [parseConfigDefaultFrequency(config)];
}

/** The default frequency, with the same fallback AND coherence chain. */
export function parseConfigDefaultFrequency(
  config: Pick<FrequencyConfigColumns, "defaultFrequency" | "defaultFrequencyWeeks">,
): Frequency {
  const parsed = frequencySchema.safeParse(config.defaultFrequency);
  if (
    parsed.success &&
    approxWeeks(parsed.data.unit, parsed.data.count) ===
      config.defaultFrequencyWeeks
  ) {
    return parsed.data;
  }
  return { unit: "WEEK", count: Math.max(1, config.defaultFrequencyWeeks) };
}

// ── Per-variant default frequency (v1.8.0 columns; map added v1.14.0) ────────

const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/\d+$/;

/** Is `key` a well-formed ProductVariant GID? (Map keys, form field names.) */
export function isVariantGid(key: string): boolean {
  return VARIANT_GID_RE.test(key);
}

/**
 * The per-variant default-frequency map of a SellingPlanConfig row
 * (`variantDefaultFrequencies`): variant GID → `{unit, count}`, explicit
 * overrides only — a variant absent here uses the group default. Defensive
 * like every config parser in this module: a malformed column, key or entry
 * is DROPPED, never thrown (admin and publish must both survive a bad row).
 * When `offered` is given, entries outside it are dropped too — an override
 * may only preselect a cadence the plan actually sells; a later frequency
 * edit that removed the cadence silently retires the override rather than
 * pointing the storefront at a plan that no longer exists.
 */
export function parseConfigVariantDefaults(
  value: unknown,
  offered?: Frequency[],
): Map<string, Frequency> {
  const out = new Map<string, Frequency>();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  const offeredTokens = offered
    ? new Set(offered.map(frequencyToken))
    : null;
  for (const [key, entry] of Object.entries(value)) {
    if (!VARIANT_GID_RE.test(key)) continue;
    const parsed = frequencySchema.safeParse(entry);
    if (!parsed.success) continue;
    if (frequencyRangeError(parsed.data)) continue;
    if (offeredTokens && !offeredTokens.has(frequencyToken(parsed.data))) {
      continue;
    }
    out.set(key, parsed.data);
  }
  return out;
}

// ── Customer-facing plan strings (English — Shopify plan names/options) ──────

const UNIT_NOUNS: Record<FrequencyUnit, { singular: string; plural: string }> = {
  DAY: { singular: "day", plural: "days" },
  WEEK: { singular: "week", plural: "weeks" },
  MONTH: { singular: "month", plural: "months" },
};

/**
 * The selling plan's option value AND reconcile key, e.g. "Every 10 days".
 *
 * WEEK is ALWAYS plural — "Every 1 weeks" included — because this exact
 * string has been the plan reconcile key since v1.0.0: the sync matches
 * existing Shopify plans by option value, and changing the format for any
 * week cadence would recreate every week plan (new GIDs → allow-list churn
 * on a live storefront). DAY and MONTH plans post-date v1.8.0, so they get
 * grammatical singular/plural from the start. The storefront widget parses
 * these strings by unit noun — it understands both forms.
 */
export function planOptionValue(freq: Frequency): string {
  if (freq.unit === "WEEK") return `Every ${freq.count} weeks`;
  const noun =
    freq.count === 1
      ? UNIT_NOUNS[freq.unit].singular
      : UNIT_NOUNS[freq.unit].plural;
  return `Every ${freq.count} ${noun}`;
}

/** Admin-facing English label — identical to the customer-facing plan name. */
export function frequencyLabelEn(freq: Frequency): string {
  return planOptionValue(freq);
}

// ── Admin text-input parsing ("4, 6, 8" / "10d, 2w, 1 month") ────────────────

const TOKEN_UNITS: Record<string, FrequencyUnit> = {
  d: "DAY",
  day: "DAY",
  days: "DAY",
  w: "WEEK",
  wk: "WEEK",
  wks: "WEEK",
  week: "WEEK",
  weeks: "WEEK",
  m: "MONTH",
  mo: "MONTH",
  mos: "MONTH",
  month: "MONTH",
  months: "MONTH",
};

/**
 * One comma-separated admin token → a frequency. A bare integer means weeks
 * (the pre-v1.8.0 input format keeps working unchanged); an integer with a
 * unit suffix — "10d", "2 w", "1 month" — selects the unit. Returns null on
 * anything else; range checking is the caller's job (frequencyRangeError).
 */
export function parseFrequencyInput(raw: string): Frequency | null {
  const match = /^(\d+)\s*([a-z]*)$/.exec(raw.trim().toLowerCase());
  if (!match) return null;
  const count = Number(match[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  if (match[2] === "") return { unit: "WEEK", count };
  const unit = TOKEN_UNITS[match[2]];
  return unit ? { unit, count } : null;
}

/**
 * The admin text-field representation of a frequency list: bare integers for
 * weeks (unchanged from pre-v1.8.0), suffixed values for other units.
 */
export function frequencyInputText(list: Frequency[]): string {
  return list
    .map((f) =>
      f.unit === "WEEK"
        ? String(f.count)
        : `${f.count}${f.unit === "DAY" ? "d" : "mo"}`,
    )
    .join(", ");
}

// ── Localized phrases (portal / notifications) ───────────────────────────────

/**
 * i18n key + vars for a frequency phrase. `style` picks the key family:
 * "every" is the lowercase mid-sentence phrase ("every 10 days"), "option"
 * the capitalized standalone label ("Every 10 days"). The catalogs carry
 * one/other forms per unit; languages with richer plural systems use their
 * "other" form for every count > 1 (consistent with the catalogs' existing
 * "{weeks} week(s)" pragmatism).
 */
export function frequencyPhraseKey(
  style: "every" | "option",
  freq: Frequency,
): { key: string; vars: { count: number } } {
  const unit = freq.unit.toLowerCase();
  const form = freq.count === 1 ? "one" : "other";
  return {
    key: `freq.${style}.${unit}.${form}`,
    vars: { count: freq.count },
  };
}

/**
 * Localized frequency phrase through the app's `t()`. Contract-side callers
 * may hold a nullable unit/count mirror — they fall back to the intervalWeeks
 * approximation before calling this.
 */
export function formatFrequency(
  translate: (key: string, vars?: Record<string, string | number>) => string,
  style: "every" | "option",
  freq: Frequency,
): string {
  const { key, vars } = frequencyPhraseKey(style, freq);
  return translate(key, vars);
}

/**
 * The `{unit, count}` a contract actually bills on: the exact mirror when
 * present (and offerable — YEAR degrades to weeks), else the intervalWeeks
 * approximation as a WEEK frequency. Never null: every surface that shows a
 * cadence goes through this one function.
 */
export function contractFrequency(contract: {
  intervalWeeks: number;
  billingIntervalUnit?: string | null;
  billingIntervalCount?: number | null;
}): Frequency {
  const unit = contract.billingIntervalUnit;
  const count = contract.billingIntervalCount;
  if (
    (unit === "DAY" || unit === "WEEK" || unit === "MONTH") &&
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 1
  ) {
    return { unit, count };
  }
  return { unit: "WEEK", count: Math.max(1, contract.intervalWeeks) };
}
