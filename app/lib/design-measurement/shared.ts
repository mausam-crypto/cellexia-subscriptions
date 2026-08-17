/**
 * Design measurement — the ISOMORPHIC half (v1.26.0).
 *
 * Everything the storefront contract, the server modules
 * (ledger/facts/backfill/scoreboard) and the admin Results tab all need to
 * agree on, with NO server imports: the hidden line-property name, the value
 * grammar of that property, the preselect vocabulary, and the display
 * formatters. Client components import this file directly, so it must stay
 * free of prisma, node builtins, Shopify clients and other .server modules
 * (the same rule as app/lib/ownership/shared.ts and app/lib/widget/
 * widget-markets.ts).
 *
 * WHY a second property next to `_cellexia_design`: `_cellexia_design` is
 * stamped on SUBSCRIPTION adds only, so it can prove which design SOLD a
 * subscription but never which design a one-time buyer SAW — the take-rate
 * denominator was attributed by calendar guesswork. `_cellexia_seen` is
 * stamped on EVERY add-to-cart of our product while the widget is visible
 * (one-time and subscription), and it carries the one variable the merchant
 * insisted on tracking separately: whether the subscription option was
 * PRESELECTED on the rendered widget. Value grammar: `<preset>|<p>` where
 * `p` is `s` (subscription preselected), `o` (one-time preselected) or `u`
 * (unknown, an older buy-box.js). Both properties keep their exact meaning
 * forever; readers must never treat one as the other.
 */

/** Hidden line property carrying `<preset>|<s|o|u>` on every widget add. */
export const SEEN_PROPERTY = "_cellexia_seen";

/** Stored vocabulary of SubscribableOrder.designPreselect / originDesignPreselect. */
export const DESIGN_PRESELECT_VALUES = ["sub", "one"] as const;
export type DesignPreselect = (typeof DESIGN_PRESELECT_VALUES)[number];

/** How a row's design was resolved (the ladder, best evidence first). */
export const DESIGN_SOURCE_VALUES = [
  "seen",
  "design_prop",
  "calendar",
  "none",
] as const;
export type DesignSource = (typeof DESIGN_SOURCE_VALUES)[number];

/**
 * One contiguous stretch of the design calendar: which design (and which
 * preselect) was live for a market (or the default) between `from` and `to`
 * (null = still live). Built by ledger.server.ts, rendered by the Results tab
 * so the merchant can read Shopify Analytics against the same dates.
 */
export interface DesignPeriod {
  revisionId: string;
  label: string | null;
  preset: string;
  preselect: DesignPreselect | null;
  /** null = the default design (every market without an override). */
  marketHandle: string | null;
  from: Date;
  to: Date | null;
}

export interface ParsedSeen {
  designKey: string;
  preselect: DesignPreselect | null;
}

/**
 * Preset keys are lowercase snake_case identifiers (PRESET_KEYS in
 * app/lib/widget/presets.ts). The parser sanitizes to this shape rather than
 * to the live preset list on purpose: a preset retired in a later release
 * must keep resolving on historical rows, and a line property is buyer-
 * writable input (anyone can POST to /cart/add), so the value is treated as
 * an untrusted string and never stored raw.
 */
const DESIGN_KEY_RE = /^[a-z0-9_]{1,40}$/;

/** Lowercased + trimmed design key, or null when empty/invalid. */
export function sanitizeDesignKey(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase();
  return DESIGN_KEY_RE.test(key) ? key : null;
}

/**
 * "subscription_max|s" → { designKey: "subscription_max", preselect: "sub" };
 * "x|o" → "one"; "x|u" or a bare "x" → preselect null. Returns null when the
 * key part is empty or invalid. The full words ("sub"/"one") are accepted as
 * well as the single letters so a hand-typed value in a test cart still
 * parses; anything else means "unknown".
 */
export function parseSeenValue(
  raw: string | null | undefined,
): ParsedSeen | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const bar = trimmed.indexOf("|");
  const keyPart = bar === -1 ? trimmed : trimmed.slice(0, bar);
  const flagPart = bar === -1 ? "" : trimmed.slice(bar + 1).trim().toLowerCase();
  const designKey = sanitizeDesignKey(keyPart);
  if (!designKey) return null;
  let preselect: DesignPreselect | null = null;
  if (flagPart === "s" || flagPart === "sub") preselect = "sub";
  else if (flagPart === "o" || flagPart === "one") preselect = "one";
  return { designKey, preselect };
}

/** Narrow a stored string to the preselect vocabulary (null otherwise). */
export function normalizeDesignPreselect(
  value: string | null | undefined,
): DesignPreselect | null {
  return value === "sub" || value === "one" ? value : null;
}

/**
 * "subscription_max" → "Subscription max"; null/empty → "Unknown". A plain
 * formatter rather than PRESET_META names on purpose: the segments layer
 * (segments-shared.ts) formats the same keys without importing anything, and
 * two surfaces showing two names for one design would read as two designs.
 */
export function presetDisplayName(key: string | null | undefined): string {
  if (typeof key !== "string" || key.trim() === "") return "Unknown";
  const words = key.trim().toLowerCase().split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return "Unknown";
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** "sub" → "sub preselected", "one" → "one-time preselected", null → "". */
export function preselectDisplayName(
  preselect: string | null | undefined,
): string {
  if (preselect === "sub") return "sub preselected";
  if (preselect === "one") return "one-time preselected";
  return "";
}

/**
 * Display label of one design VARIANT (design × preselect):
 * ("subscription_max", "sub") → "Subscription max · sub preselected";
 * ("subscription_max", null)  → "Subscription max";
 * (null, anything)            → "Unknown design".
 */
export function designVariantLabel(
  designKey: string | null | undefined,
  preselect: string | null | undefined,
): string {
  if (typeof designKey !== "string" || designKey.trim() === "") {
    return "Unknown design";
  }
  const suffix = preselectDisplayName(preselect);
  return suffix
    ? `${presetDisplayName(designKey)} · ${suffix}`
    : presetDisplayName(designKey);
}
