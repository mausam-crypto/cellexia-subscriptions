/**
 * App-proxy subpath — the single source of truth.
 *
 * The value is "cellexia-subs" and NEVER "cellexia": the merchant's other
 * live app ("AOV & LTV Booster") already serves /apps/cellexia on the same
 * store, so shipping this app on that subpath hands our portal traffic to
 * the other app (or ours to it, depending on which proxy config Shopify
 * kept). That collision shipped repeatedly — the legacy subpath is banned.
 *
 * Enforcement (tests/proxy-subpath.test.ts): shopify.app.toml's
 * `[app_proxy] subpath`, this constant, and the hardcoded paths in
 * extensions/cellexia-buy-box/assets/buy-box.js + buy-box-embed.js (theme
 * extension JS cannot import app modules) must all agree — and none may be
 * the banned legacy value. The Preview & launch checklist additionally
 * probes the LIVE path end-to-end ("Portal proxy answers as Cellexia",
 * probeProxyIdentity in app/lib/launch/launch.server.ts), so a deployed
 * collision is caught even when the sources agree.
 *
 * This module is isomorphic on purpose — no server-only imports — so admin
 * UI code may import it. Changing the subpath requires `npm run deploy`
 * (the proxy config only takes effect on deploy) and invalidates any
 * customer-bookmarked portal links; magic links are unaffected (they ride
 * the app host). See docs/OPERATIONS.md §18.
 */
export const PORTAL_PROXY_SUBPATH = "cellexia-subs";

/** Store-domain base path of the app proxy (prefix + subpath), no trailing slash. */
export const PORTAL_PROXY_BASE = `/apps/${PORTAL_PROXY_SUBPATH}`;
