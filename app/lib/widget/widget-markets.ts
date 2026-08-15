import type { SettingsValue } from "~/lib/settings/registry.server";

/**
 * Where the buy box shows — market-scoped widget visibility (v1.25.0), the
 * ISOMORPHIC half. Pure helpers only: no Prisma, no Shopify client, no
 * settings I/O — the admin route COMPONENTS (Preview & launch, Buy box
 * designer) import from here to decide labels like "— hidden", and Remix
 * bundles route components for the browser, so a `.server` import would
 * fail the production build (the v1.6.1 lesson: `remix vite:build` rejects
 * server-only modules reachable from client code). Everything that talks to
 * Shopify or the database lives in `widget-markets.server.ts`, which
 * re-exports this file so server callers keep one import.
 *
 * Model (see the server module for the full contract): the `widgetMarkets`
 * setting `{ mode: "all" | "selected", handles: [...] }` is the source of
 * truth; the shop metafield `cellexia.widget_markets`
 * `{"v":1,"mode":…,"handles":[…]}` is its storefront projection, read by
 * cx-buybox-core.liquid with a plain array `contains` — EXACT string
 * membership, no trim, no case folding, blank market handle fails closed
 * under "selected"; absent metafield ⇔ every market.
 */

export const WIDGET_MARKETS_METAFIELD_NAMESPACE = "cellexia";
export const WIDGET_MARKETS_METAFIELD_KEY = "widget_markets";
export const WIDGET_MARKETS_METAFIELD_VERSION = 1;

/**
 * The storefront marker cx-buybox-core.liquid renders INSTEAD of the widget
 * when the market is excluded — an inert, hidden template carrying none of
 * the widget hooks (no data-cellexia-buybox, no data-cellexia-gated, no
 * JSON island, and deliberately NOT data-cellexia-no-owned-group, so the
 * "plans from another app" diagnostic can never fire on a market you chose
 * to hide). The Preview Doctor and the Debug self-check look for it BEFORE
 * judging the launch gate. tests/liquid/market-visibility.test.ts pins the
 * Liquid half.
 */
export const MARKET_HIDDEN_ATTR = "data-cellexia-market-hidden";
/** Attribute on the same marker naming the market handle the page resolved. */
export const MARKET_DIAG_ATTR = "data-cellexia-diag-market";

export type WidgetMarketsSetting = SettingsValue<"widgetMarkets">;
export type WidgetMarketsMode = WidgetMarketsSetting["mode"];

export interface WidgetMarketsMetafieldValue {
  v: typeof WIDGET_MARKETS_METAFIELD_VERSION;
  mode: WidgetMarketsMode;
  handles: string[];
}

/** Deduplicate while keeping first-seen order (the merchant's list order). */
export function uniqueHandles(handles: readonly string[]): string[] {
  return [...new Set(handles)];
}

/**
 * The metafield value for a setting. `handles` travel only under
 * "selected": under "all" the Liquid never reads them, and publishing an
 * empty list keeps the written value equal to what ABSENT means.
 */
export function buildWidgetMarketsValue(
  setting: WidgetMarketsSetting,
): WidgetMarketsMetafieldValue {
  return {
    v: WIDGET_MARKETS_METAFIELD_VERSION,
    mode: setting.mode,
    handles: setting.mode === "selected" ? uniqueHandles(setting.handles) : [],
  };
}

/**
 * Is the widget shown in this market under this setting? Mirrors the Liquid
 * rule exactly (exact string membership; blank handle fails closed under
 * "selected"). Used by the admin pages and the self-check — never a
 * substitute for the storefront's own evaluation.
 */
export function marketAllowed(
  setting: Pick<WidgetMarketsSetting, "mode" | "handles">,
  marketHandle: string | null | undefined,
): boolean {
  if (setting.mode !== "selected") return true;
  if (!marketHandle) return false;
  return setting.handles.includes(marketHandle);
}

/**
 * A saved "selected" list judged against the LIVE market list — the shape
 * both the `widget_markets` self-check and the Preview card need. Structural
 * `{ handle, enabled }` on purpose: this file is isomorphic and must not
 * import the `.server` markets module.
 *
 *  - `missing`: saved handles that are no market on the shop any more
 *    (deleted, or the handle was changed in Shopify);
 *  - `disabled`: saved handles whose market exists but is a draft/disabled
 *    market — the API lists it, no visitor ever resolves it;
 *  - `live`: saved handles that are enabled markets — the ONLY ones in which
 *    the buy box can actually appear.
 *
 * `live.length === 0` under "selected" means the widget is hidden in every
 * market, with every other check green — the state this helper exists to
 * name. Under "all" everything is trivially live (empty lists).
 */
export interface SelectedHandlesAudit {
  missing: string[];
  disabled: string[];
  live: string[];
}

export function auditSelectedHandles(
  setting: Pick<WidgetMarketsSetting, "mode" | "handles">,
  markets: ReadonlyArray<{ handle: string; enabled: boolean }>,
): SelectedHandlesAudit {
  const audit: SelectedHandlesAudit = { missing: [], disabled: [], live: [] };
  if (setting.mode !== "selected") return audit;
  const byHandle = new Map(markets.map((m) => [m.handle, m]));
  for (const handle of uniqueHandles(setting.handles)) {
    const market = byHandle.get(handle);
    if (!market) audit.missing.push(handle);
    else if (!market.enabled) audit.disabled.push(handle);
    else audit.live.push(handle);
  }
  return audit;
}

/**
 * What a storefront reading `value` actually does — the Liquid rule, in TS.
 *
 *  - `null` (absent metafield), a value with `mode` other than the exact
 *    string "selected" (mode "all", unknown, missing) → shown everywhere.
 *  - mode "selected" with an ARRAY of handles → shown exactly for the string
 *    members of that array (non-strings can never equal a market handle).
 *  - Anything else — unparsable JSON, "selected" with a non-array `handles`
 *    (Liquid's `contains` on a STRING is a substring test, so its behaviour
 *    would not be the exact-match rule the setting promises) — is
 *    `unknown`, and unknown always counts as diverged: a re-sync rewrites
 *    the canonical value and costs nothing.
 */
type EffectiveVisibility =
  | { kind: "all" }
  | { kind: "selected"; handles: Set<string> }
  | { kind: "unknown" };

function effectiveFromMetafield(value: string | null): EffectiveVisibility {
  if (value === null) return { kind: "all" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "unknown" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    // A JSON scalar/array is truthy-but-mode-less to Liquid → shown
    // everywhere; but it is not a shape this app ever writes, so treat it
    // as unknown and let the re-sync normalise it.
    return { kind: "unknown" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.mode !== "selected") return { kind: "all" };
  if (!Array.isArray(record.handles)) return { kind: "unknown" };
  return {
    kind: "selected",
    handles: new Set(
      record.handles.filter((h): h is string => typeof h === "string"),
    ),
  };
}

function effectiveFromSetting(setting: WidgetMarketsSetting): EffectiveVisibility {
  return setting.mode === "selected"
    ? { kind: "selected", handles: new Set(setting.handles) }
    : { kind: "all" };
}

/**
 * Does the storefront metafield disagree with the setting? Compared the way
 * the buy box evaluates it (see effectiveFromMetafield): absent ⇔ all
 * markets, and "selected" lists compare as exact-string SETS (order and
 * duplicates are irrelevant to `contains`). Never normalises handles —
 * " ch" and "CH" are different markets to Liquid, so they are different
 * here (the launchFlagDiverged lesson).
 */
export function widgetMarketsDiverged(
  setting: WidgetMarketsSetting,
  metafieldValue: string | null,
): boolean {
  const want = effectiveFromSetting(setting);
  const have = effectiveFromMetafield(metafieldValue);
  if (have.kind === "unknown") return true;
  if (want.kind !== have.kind) return true;
  if (want.kind === "selected" && have.kind === "selected") {
    if (want.handles.size !== have.handles.size) return true;
    for (const h of want.handles) if (!have.handles.has(h)) return true;
  }
  return false;
}

/**
 * Pull the resolved market handle out of a storefront page that rendered
 * the market-hidden marker (`data-cellexia-diag-market="…"`). Returns null
 * when the marker is absent; "" when it is present with a blank handle (no
 * `localization.market` on that storefront). Only the FIRST marker counts —
 * one page renders one market.
 */
export function parseHiddenMarketFromHtml(html: string): string | null {
  if (!html.includes(MARKET_HIDDEN_ATTR)) return null;
  const match = new RegExp(`${MARKET_DIAG_ATTR}="([^"]*)"`).exec(html);
  return match ? decodeLiquidEscape(match[1]) : "";
}

/** Undo Liquid's `| escape` on an attribute value (the five HTML entities). */
function decodeLiquidEscape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
