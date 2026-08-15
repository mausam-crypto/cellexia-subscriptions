import { adminClientForShop } from "~/shopify.server";
import { requireShop } from "~/lib/shop/install.server";
import { logEvent } from "~/lib/events/log.server";
import { getSetting, setSetting } from "~/lib/settings/settings.server";
import { settingsSchemas } from "~/lib/settings/registry.server";
import {
  WIDGET_MARKETS_METAFIELD_KEY,
  WIDGET_MARKETS_METAFIELD_NAMESPACE,
  buildWidgetMarketsValue,
  uniqueHandles,
  type WidgetMarketsMetafieldValue,
  type WidgetMarketsSetting,
} from "./widget-markets";
import type { AdminClient } from "~/lib/graphql/client.server";
import {
  getShopMetafield,
  setShopMetafield,
} from "~/lib/graphql/metafields.server";
import { listMarkets, type ShopifyMarket } from "~/lib/graphql/markets.server";

/**
 * Where the buy box shows — market-scoped widget visibility (v1.25.0).
 *
 * "The app is live, but the subscription option should only appear in these
 * Shopify Markets." The launch mode stays the shop-wide on/off switch; this
 * is an orthogonal per-market filter, and its default — every market — is a
 * no-op that a shop which never touched it never has to sync.
 *
 * Source of truth: the `widgetMarkets` setting ({ mode: "all" | "selected",
 * handles: [...] }). Storefront projection: the shop metafield
 * `cellexia.widget_markets`, `{"v":1,"mode":"all"|"selected","handles":[…]}`,
 * read by cx-buybox-core.liquid as
 *
 *     assign cx_wm = shop.metafields.cellexia.widget_markets.value
 *     if cx_wm and cx_wm.mode == 'selected'
 *       … shown only when cx_wm.handles contains localization.market.handle
 *
 * — a plain Liquid `contains` on an array: EXACT element equality, no trim,
 * no case folding, and a blank/absent market handle under "selected" fails
 * closed. Anything that is not byte-exact `mode == 'selected'` (absent
 * metafield, mode "all", an unknown mode) shows the widget everywhere, so
 * ABSENT ⇔ `{mode:"all"}` and neither install nor go-live needs to write it.
 *
 * Save contract (mirrors goLive): setting first, then the metafield; when
 * the metafield write fails the setting is ROLLED BACK and the caller gets
 * a friendly error — the app must never claim "only these markets" while
 * every product page still reads the previous rule. `selected` with zero
 * handles is refused: hidden-in-every-market is never what a merchant meant
 * (that is what "Revert to setup" is for), and unknown handles are refused
 * against the live market list, because a typo here silently hides the
 * widget from a whole country and nothing else in the app would ever say so.
 *
 * The pure helpers (constants, marketAllowed, auditSelectedHandles,
 * widgetMarketsDiverged, parseHiddenMarketFromHtml, buildWidgetMarketsValue) live in the
 * isomorphic `widget-markets.ts` — route COMPONENTS import from there,
 * because a `.server` module reachable from client code fails
 * `remix vite:build` (v1.6.1 lesson). This module re-exports them.
 *
 * Presentation-adjacent but NOT ownership: this metafield decides in WHICH
 * markets our group renders, never WHETHER a group is ours (that stays with
 * `cellexia.plan_groups`, two-factor, fails closed).
 */

export {
  WIDGET_MARKETS_METAFIELD_NAMESPACE,
  WIDGET_MARKETS_METAFIELD_KEY,
  WIDGET_MARKETS_METAFIELD_VERSION,
  MARKET_HIDDEN_ATTR,
  MARKET_DIAG_ATTR,
  buildWidgetMarketsValue,
  marketAllowed,
  auditSelectedHandles,
  widgetMarketsDiverged,
  parseHiddenMarketFromHtml,
  type WidgetMarketsSetting,
  type WidgetMarketsMode,
  type WidgetMarketsMetafieldValue,
  type SelectedHandlesAudit,
} from "./widget-markets";

/** Outcome of a widget_markets metafield write — never an exception. */
export interface WidgetMarketsPublishResult {
  ok: boolean;
  error?: string;
  value?: WidgetMarketsMetafieldValue;
}

export type WidgetMarketsSaveResult =
  | { ok: true; setting: WidgetMarketsSetting; previous: WidgetMarketsSetting }
  | {
      ok: false;
      /**
       * `invalid` — the input failed validation (nothing was changed);
       * `unknown_handles` — a handle is not a market on this shop (nothing
       * changed); `markets_unreadable` — the live market list could not be
       * read, so the handles could not be verified (nothing changed);
       * `publish_failed` — the setting was written and ROLLED BACK because
       * the storefront metafield could not be updated.
       */
      code: "invalid" | "unknown_handles" | "markets_unreadable" | "publish_failed";
      error: string;
    };

// ── Shopify I/O ──────────────────────────────────────────────────────────────

/**
 * Write the metafield for a setting. Never throws — reports. The caller
 * decides what a failure means (saveWidgetMarkets rolls the setting back;
 * the Preview page's re-sync just toasts).
 */
export async function publishWidgetMarketsMetafield(
  admin: AdminClient,
  setting: WidgetMarketsSetting,
): Promise<WidgetMarketsPublishResult> {
  const value = buildWidgetMarketsValue(setting);
  try {
    await setShopMetafield(admin, {
      namespace: WIDGET_MARKETS_METAFIELD_NAMESPACE,
      key: WIDGET_MARKETS_METAFIELD_KEY,
      type: "json",
      value: JSON.stringify(value),
    });
    return { ok: true, value };
  } catch (err) {
    console.error("[widget-markets] metafield publish failed", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      value,
    };
  }
}

/**
 * The raw metafield value as the storefront reads it (JSON string), or null
 * when never written. Throws on a read failure — callers decide (the
 * Preview page contains it and claims nothing).
 */
export async function readWidgetMarketsMetafield(
  admin: AdminClient,
): Promise<string | null> {
  const metafield = await getShopMetafield(
    admin,
    WIDGET_MARKETS_METAFIELD_NAMESPACE,
    WIDGET_MARKETS_METAFIELD_KEY,
  );
  return metafield ? metafield.value : null;
}

// ── Save ─────────────────────────────────────────────────────────────────────

/**
 * Validate → store the setting → publish the metafield → audit. See the
 * module comment for the rollback contract. `markets` may be handed in by a
 * caller that already listed them; otherwise the live list is read here.
 */
export async function saveWidgetMarkets(
  shopDomain: string,
  next: unknown,
  actor: string,
  options: { markets?: ShopifyMarket[] } = {},
): Promise<WidgetMarketsSaveResult> {
  const parsed = settingsSchemas.widgetMarkets.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      code: "invalid",
      error: issue
        ? `${issue.path.join(".") || "setting"}: ${issue.message}`
        : "Invalid market setting",
    };
  }
  const setting: WidgetMarketsSetting = {
    mode: parsed.data.mode,
    handles: uniqueHandles(parsed.data.handles),
  };

  if (setting.mode === "selected" && setting.handles.length === 0) {
    return {
      ok: false,
      code: "invalid",
      error:
        "Pick at least one market — “Only these markets” with none selected would hide the buy box everywhere. To take the widget down everywhere, use Revert to setup instead.",
    };
  }

  const shop = await requireShop(shopDomain);
  const admin = await adminClientForShop(shopDomain);

  if (setting.mode === "selected") {
    let markets = options.markets;
    if (!markets) {
      try {
        markets = await listMarkets(admin);
      } catch (err) {
        console.error("[widget-markets] market list read failed", err);
        return {
          ok: false,
          code: "markets_unreadable",
          error: `Could not read your markets from Shopify (${err instanceof Error ? err.message : String(err)}) — the selection was not saved; retry in a moment.`,
        };
      }
    }
    const known = new Set(markets.map((m) => m.handle));
    const unknown = setting.handles.filter((h) => !known.has(h));
    if (unknown.length > 0) {
      return {
        ok: false,
        code: "unknown_handles",
        error: `Not a market on this shop: ${unknown.map((h) => `“${h}”`).join(", ")} — reload the page and pick again.`,
      };
    }
  }

  const previous = await getSetting(shop.id, "widgetMarkets");
  await setSetting(shop.id, "widgetMarkets", setting, actor);
  const publish = await publishWidgetMarketsMetafield(admin, setting);
  if (!publish.ok) {
    // Roll back so the app never claims a market rule the storefront does
    // not apply; the admin gets a real error and can retry.
    await setSetting(shop.id, "widgetMarkets", previous, actor);
    return {
      ok: false,
      code: "publish_failed",
      error: `Storefront rule not updated (cellexia.widget_markets): ${publish.error ?? "unknown error"}. Nothing was changed — retry.`,
    };
  }

  await logEvent({
    shopId: shop.id,
    type: "admin.action",
    source: "ADMIN",
    actor,
    payload: {
      action: "widget_markets_saved",
      value: setting,
      previous,
    },
  });

  return { ok: true, setting, previous };
}
