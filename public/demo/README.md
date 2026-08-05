# Storefront widget harness (`/demo/widget.html`)

A static, no-store preview of the Cellexia theme-extension widgets. Open
`public/demo/widget.html` directly in a browser (or hit `/demo/widget.html`
once the Remix app is built — `public/` is served at the site root). It
renders a Cellexia-styled product page containing widgets **A** (treatment
choice cards), **B** (quantity → cadence pills), **E** (Basic-Purchase
comparison nudge) and, below a mock cart line, widget **F** (one-click cart
conversion).

Demo product: "Cellexia Regenerating Serum", €79,00, one variant, selling
plans "Every 4 weeks" (15% off) and "Every 8 weeks" (10% off), one-time
purchase allowed.

## What is real

- **CSS and JS** — `cellexia-widgets.css` / `cellexia-widgets.js` here are
  unmodified copies of `extensions/treatment-widgets/assets/` (each carries a
  one-line `PREVIEW COPY` header). All behaviour you see — hydration, card /
  pill selection, plan matching, price and savings recomputation, the
  once-per-session nudge, add-to-cart states, cart-row conversion — is the
  real production code path.
- **Hydration** — the widget boots against the transcribed markup exactly as
  it would against Liquid output on a live shop.
- **Telemetry payloads** — the real impression / selection / conversion
  events are built by the widget and logged to the browser console (look for
  `[cellexia demo] telemetry beacon → /apps/cellexia/api/events`).
- **The config-fallback path** — `/apps/cellexia/api/widget-config` is
  mocked to return 404 on purpose, so the widget exercises its genuine
  fallback to Liquid-rendered defaults (what a live shop does when no
  enhancement config is published).
- **Gobold** — loaded from the same woff2/woff files the live theme ships.

## What is simulated

- **The Liquid output** — the HTML in `widget.html` is a hand transcription
  of what `blocks/treatment-choice.liquid` and `blocks/cart-conversion.liquid`
  render for the demo product. If a block's markup changes, this file must be
  re-transcribed (and the asset copies re-copied).
- **Cart + app-proxy endpoints** — an inline shim monkey-patches
  `window.fetch` / `navigator.sendBeacon`: `/cart/add.js` and
  `/cart/change.js` resolve `{ok:true}` after 300 ms, show a demo toast and
  log their payloads; `/cart.js` returns a canned cart; the app proxy never
  leaves the page.
- **Navigation** — the widget's reload / redirect-to-cart behaviour after a
  cart mutation is routed into a mini-cart refresh stub so the page stays put.
- **Argumentum** — the body font is licensed and loaded externally by the
  live theme; "Helvetica Neue" stands in here (same fallback the portal
  uses).
- The nudge's once-per-session flag is cleared on every page load so the
  Widget E flow can be demonstrated repeatedly.

## Seeing it for real

Run `shopify app dev` from the repo root, install the app on a dev store,
then in the theme editor add the **Treatment choice** app block to a product
template and **Cart: make it continuous** to the cart template. Selling-plan
data then comes from real `product.selling_plan_groups`, the app proxy
serves live widget config and telemetry, and cart calls hit Shopify's AJAX
API.

Source of truth: `extensions/treatment-widgets/`. Never edit the copies here
to change widget behaviour.
