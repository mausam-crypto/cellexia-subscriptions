# Cellexia Buy Box — theme app extension

The PDP subscription widget. Renders the product's selling plans as one of
**six design presets** (classic stacked cards by default) and carries the
choice into the cart — through the theme's product form where one exists, or
by patching the theme's JS cart requests where none does (see the app
embed). The active design is configured from the app's **Buy box designer**
and published to a shop metafield — no theme edit or redeploy is needed to
change it.

It ships in **two install shapes sharing one implementation**
(`snippets/cx-buybox-core.liquid` renders the identical widget for both):

- **App embed** (`blocks/buy-box-embed.liquid`, target `body`) —
  **recommended: works on every theme**, one toggle, no template surgery.
- **App block** (`blocks/buy-box.liquid`, target `section`) — for themes
  whose product section accepts app blocks; renders exactly where the
  merchant drags it.

```
blocks/buy-box.liquid            app block (target: section) — thin wrapper over cx-buybox-core
blocks/buy-box-embed.liquid      app embed (target: body) — self-mounting wrapper over cx-buybox-core
snippets/cx-buybox-core.liquid   THE widget: config resolution + all six presets + JSON island
snippets/cx-price.liquid         money display helper
snippets/cx-freq-label.liquid    localized "Delivery every N weeks" labels
snippets/cx-save-label.liquid    localized "Save X" labels
snippets/cx-design-text.liquid   config text override resolution (locale → en → default)
snippets/cx-tpl.liquid           {percent}/{amount}/{frequency} template resolution
snippets/cx-freq-control.liquid  frequency dropdown or chips (shared by presets)
snippets/cx-benefit-list.liquid  check-mark benefit list
snippets/cx-reassurance.liquid   reassurance line with check icon
snippets/cx-sub-price-block.liquid  subscription price cluster (shared by presets)
assets/buy-box.css               mobile-first styles (BEM namespaces cx-buybox / cx-buybox-embed)
assets/buy-box.js                widget behaviour: vanilla JS, deferred, no dependencies
assets/buy-box-embed.js          embed-only: self-mounting + fetch/XHR cart-request patching
locales/*.json                   storefront copy (en.default + 21 translations)
```

## Install as app embed (recommended — works on every theme)

Some themes — including the client's custom "Sleepify Theme" on
cellexialabs.com — do not accept app blocks in their product section, so the
app block below simply cannot be added there. The app embed is the
everywhere-else answer, and it is **one toggle**:

1. Deploy the app (`npm run deploy`) so the extension is available to the store.
2. In the Shopify admin: **Online Store → Themes → Customize**.
3. Open **Theme settings** (bottom-left) → **App embeds**.
4. Switch **Cellexia Buy Box** on and press **Save**. Done.

From then on, every product page whose product has a Cellexia selling plan
gets the widget automatically: the embed server-renders it hidden at the end
of `<body>` and `buy-box-embed.js` moves it into the buy column and unhides
it. Placement is resolved in this order:

1. the embed's **Custom anchor selector** setting (theme editor), combined
   with its **Position** setting (before / after / inside-start / inside-end);
2. the published design config's **Placement** (Buy box designer →
   Placement, mode "CSS selector");
3. automatic heuristics: `.pdp__info .pdp__grey` → insert before (the
   cellexialabs.com buy column: after the size options, above quantity +
   Add to cart), then `.product-form__buttons` → before (Dawn-family OS 2.0
   themes), then the `/cart/add` form's submit button → before its closest
   block-level wrapper, then the `/cart/add` form → inside-start, then a
   `.pdp__price` / `.price` element → after.

Embed behaviours worth knowing:

- **The launch gate is identical to the app block's.** Enabling the embed
  while the app is in setup mode shows **nothing** to visitors — the inner
  widget renders `[hidden][data-cx-gated]` until the
  `cellexia.launch_status` metafield says `"live"`, and only a validated
  `?cx_preview=` token reveals it (same ribbon, same session behaviour —
  see "Safe launch & preview" below). Mounting only unhides the embed
  *wrapper*, never the gated widget inside it.
- **The app block wins.** If the page also renders the section-targeted app
  block, the embed stays hidden and dormant — never two widgets. Safe to
  leave the embed enabled as a fallback on themes that support blocks.
- **No `/cart/add` form? Still works.** On JS-driven themes (Sleepify posts
  to `/cart/add.js` via jQuery XHR with no form), `buy-box-embed.js` wraps
  `window.fetch` and `XMLHttpRequest` once and injects the selected
  `selling_plan` (+ the `properties[_cx_design]` attribution) into
  `/cart/add` and `/cart/add.js` POST bodies — FormData, urlencoded, JSON
  `items[]` or flat JSON alike. Requests are matched against **this
  product's variant ids**, so other vendors' cart calls (bundle widgets,
  upsells) pass through byte-identical; so does everything when one-time is
  selected, the widget is hidden, or anything at all errors. An add-to-cart
  can never break.
- **Variant tracking.** Beyond the standard form/URL handling in
  `buy-box.js`, the embed listens to the Sleepify size picker
  (`.pdp__options select/input`) and re-reads `?variant=` after changes —
  no polling.

### Anchor-selector troubleshooting

- If the widget does not appear during preview, look for a small dark card
  bottom-left: **"Cellexia buy box: no placement anchor found — set a
  custom CSS selector in the Buy box designer → Placement."** That card is
  admin-only (it requires the preview session's token); real visitors never
  see it — for them a failed mount just means no widget, never breakage. A
  `console.warn` with the same diagnosis is logged too.
- Fix it by setting a selector: either on the embed (theme editor → App
  embeds → Cellexia Buy Box → Custom anchor selector, e.g. `.pdp__grey`)
  or centrally in the app (Buy box designer → Placement). The embed-level
  selector wins over the app one.
- A custom selector that matches nothing logs a warning and falls back to
  the automatic heuristics after a 1.5s grace period (late-rendered PDPs
  get two mount passes: DOM-ready and +1500ms).
- Test selectors in the browser console with
  `document.querySelector('...')` on the live PDP.

### Namespace note (unrelated "cx-*" scripts on the page)

cellexialabs.com already carries **another vendor's** scripts using element
ids `cx-i18n`, `cx-cart-config`, `cx-pdp-config`, `cx-embed-config`, plus
the `sm-rc-widget` bundle widget and Stamped reviews. Coexistence rules
baked into this extension: our global is the single guarded
`window.CellexiaSubs` object; our CSS/JS never queries `[id^="cx-"]` or any
id selector; the embed introduces **no element ids at all**; and the cart
patcher only ever touches requests carrying our own product's variant ids.
Do not "clean up" any of that when editing.

## Adding the block in the theme editor (themes that accept app blocks)

1. Deploy the app (`npm run deploy`) so the extension is available to the store.
2. In the Shopify admin: **Online Store → Themes → Customize**.
3. Open a **product template** (Default product, or the template used by
   subscribable products).
4. In the main product information section, click **Add block → Apps →
   Cellexia Buy Box**.
5. Drag the block **directly above the Buy buttons block** (above quantity /
   Add to cart). This is the position that converts: the customer picks
   subscription vs one-time, then immediately hits Add to cart.
6. **Hide the theme's default selling-plan picker** if the theme renders one
   (Dawn and most OS 2.0 themes show their own "Purchase options" UI when a
   product has selling plans). Two options:
   - Theme setting, if the theme exposes one for the purchase-options block; or
   - remove/hide that block in the same template. Running both UIs at once
     shows two competing selectors — the Cellexia buy box takes over the
     `selling_plan` input either way (it reuses the theme's input when one
     exists), but visually you want exactly one widget.
7. Save, then test: add to cart with subscription selected and confirm the
   cart line shows the selling plan ("Every 8 weeks" etc.).

The block is safe to add to *all* product templates: **when a product has no
selling plan the block renders nothing at all** — no wrapper, no CSS, no JS
side effects. One-time-only products keep their normal PDP.

Other behaviours worth knowing:

- **Subscription-only products** (`requires_selling_plan`): the one-time card
  is not rendered and subscription is forced on.
- **Variant deep links** (`?variant=`): initial server render prices the
  deep-linked variant; JS also re-reads the URL on history navigation.
- **Multiple selling plan groups** on one product: the block uses the first
  group whose name contains "Cellexia" (case-insensitive), else the first.
- **Multiple product forms on the page** (quick-buy, featured product
  sections): the JS scopes its form lookup to the block's own section, and
  prefers real add-to-cart forms over Shop Pay installment forms.
- **No JavaScript**: the widget hides itself (`<noscript>`) instead of
  showing a selection that would not reach the cart.

## Safe launch & preview

Installing the app and adding this block changes **nothing** on the live
storefront until the merchant explicitly goes live from the app admin.

- **The gate is a shop metafield.** The app maintains
  `shop.metafields.cellexia.launch_status` (`"setup"` until go-live, then
  `"live"`). While it is not `"live"`, the block still server-renders its
  full markup but with `hidden` + `data-cx-gated="true"` on the wrapper — and
  a CSS backstop (`[data-cx-gated][hidden] { display: none !important; }`)
  in case a theme reset re-displays `[hidden]` elements. Real visitors see
  nothing: no widget, no layout shift, no network calls. Going live flips the
  metafield from the app; the block then renders exactly as documented above
  on the next page load — no theme edit or redeploy involved.
- **Add the block early, safely.** Because of the gate, the recommended
  order is: add and position the block in the theme editor during setup,
  preview it (below), then go live. Nothing is visible to customers in
  between, so the theme work can happen days before launch.
- **How the preview link works.** The app's launch checklist generates a
  product-page link carrying `?cx_preview=<signed token>`. On load,
  `buy-box.js` stores the token in `sessionStorage` (key
  `cx_preview_token`) and validates it server-side via the app proxy
  (`GET /apps/cellexia-subscriptions/preview/validate` — HMAC-signed, preview-only action,
  7-day expiry, never consumed). Only a `{ ok: true }` answer removes
  `hidden` and shows the localized "Preview — only you can see this" ribbon.
  Everything fails closed: an invalid or expired token is dropped from
  `sessionStorage`, and a network error simply leaves the widget hidden.
- **Session-scoped, PDP → cart carries over.** Because the token lives in
  `sessionStorage`, the preview follows that browser tab across pages — the
  admin can browse other product pages and the cart without re-appending the
  query parameter — and ends when the tab closes. Nothing is stored
  server-side that could affect other visitors.
- **Checkout needs no reveal.** Checkout shows recurring terms natively
  whenever a line item carries a selling plan. In setup mode only the
  previewing admin can add to cart with a selling plan (the widget is hidden
  for everyone else), so only their checkout ever shows subscription terms.
- **Reassurance.** Until go-live a real visitor cannot see the widget, add a
  selling plan to the cart, or reach subscription terms in checkout. Even
  someone who guesses the `?cx_preview` parameter name gets nothing: the
  reveal requires a validly signed, unexpired token, verified server-side.
  In live mode the gate and the preview module are completely inert — the
  block renders and behaves exactly as before.

## Design presets

Six CRO archetypes, all sharing the same selling-plan wiring, launch
gating, preview reveal, variant-change price updates and accessibility
contract. Every preset supports every layout/style/text knob from the
designer; the difference is the persuasion architecture.

| Preset | What it renders | When to use it |
|---|---|---|
| **classic** | The v1.0.0 stacked full-width option cards — subscription first, accented and badged. | Your control group. This is the layout your current conversion rate was measured on; keep it live while A/B-testing the others. |
| **toggle** | A segmented two-tab pill ("One-time" \| "Subscribe & save {percent}") swapping a detail panel below. Arrow-key accessible `role=tablist`. | Mobile-heavy traffic and long PDPs — it adds almost no page height and reads like a native mobile pattern. Hides the side-by-side value story. |
| **tiles** | Two side-by-side comparison tiles; the subscription tile is elevated (shadow + badge) with explicit compare rows: per-delivery price, savings, flexibility. | Desktop-heavy traffic and deliberate, considered purchases — the strongest pattern for arguing (not asserting) the subscription's advantage. |
| **inline** | One checkbox row under the price: "Subscribe & save {percent}", expanding a slim detail line (price, cadence, reassurance). | The zero-conversion-risk option. The theme's buy box stays untouched; subscribing is a single opt-in line. Least persuasion, smallest lift. |
| **value_stack** | A benefit-rich subscription panel — headline price plus a check-mark benefit list (first-order saving, ongoing saving, milestone gift, skip/pause/cancel — locale defaults, overridable) — with one-time demoted to a small "or buy once for {amount}" text link. | Warm, high-consideration traffic and replenishable heroes. Highest expected take-rate, but demoting one-time is a real CVR risk on cold traffic. Watch CVR, not just take-rate. |
| **planner** | Frequency-forward "routine planner": cadence chips first (with a "Recommended" tag on the plan default), price shown per delivery, subscription as the primary card, one-time as a secondary row. | Consumables with a well-understood usage rhythm — sells the cadence, not the discount. Chips ask for a decision, which can stall unsure shoppers. |

### App config vs the `design_source` block setting

- The app's **Buy box designer** publishes the design (preset + layout +
  style + per-locale text) to the shop metafield
  `cellexia.buybox_design` (json, schema `app/lib/widget/presets.ts`).
  The block reads it null-safely on every page load, so publishing a new
  design or reverting a revision changes the storefront instantly.
- The block setting **Design** (`design_source`, default **App design**)
  is an emergency override in the theme editor: forcing a preset there
  ignores the published config entirely and renders that preset with
  default knobs. Use it only if the app is unreachable or a published
  design must be killed without touching the app. Set it back to
  "App design" afterwards.

### The zero-config fallback guarantee

With no published config (and `design_source` = "App design") the block
renders the **classic preset with v1.0.0 defaults** — visually and
behaviorally identical to v1.0.0. The only additions are inert:
`data-cx-preset="classic"`, the `cx-buybox--classic` class (which carries
no CSS rules — the base *is* classic), and extra JSON-island keys. All
knob defaults mirror `DEFAULT_DESIGN_CONFIG`, which is the v1.0.0
rendering written out as explicit values. Deleting the metafield is
therefore always a safe rollback.

### Text resolution and templates

Config text resolves per key: `config.text[current locale]` →
`config.text.en` → the extension locale files (the v1.0.0 copy). The
`subscribeLabel`, `savingsTemplate`, `firstOrderLine` and
`oneTimeLinkLabel` fields support `{percent}` / `{amount}` /
`{frequency}` placeholders — resolved in Liquid for the first paint and
re-resolved by `buy-box.js` on variant/plan changes (raw templates travel
in `data-cx-tpl` attributes; values come precomputed per variant × plan
from the JSON island, so JS still never formats money).

### The `_cx_design` line property (design attribution)

When a subscription option is selected, `buy-box.js` maintains a hidden
`properties[_cx_design]` input in the product form whose value is the
active preset key (from the wrapper's `data-cx-preset`); the input is
disabled whenever one-time is selected, so it is only ever submitted with
a selling plan. Because the property name starts with an underscore,
standard themes and checkout **hide it from customers** — it never
appears on the cart line or the order confirmation. The ORDERS_CREATE
webhook reads it from `line_items[].properties` and logs the design key,
which is what powers take-rate-by-design reporting in the app: every
subscription add-to-cart is attributable to the exact design that
produced it.

## Settings and the CRO rationale

| Setting | Default | Why |
|---|---|---|
| **Heading** | "Choose your ritual" | Frames the choice as a routine, not a billing decision. Clear to hide. |
| **Show badge / Badge text** | on / "Most popular" | Social proof on the subscription card. Leave the text empty to use the translated "Most popular" from the locale files. Only claim "Most popular" once it is true — unearned badges erode trust and reviews. |
| **Preselect subscription** | on | Subscription-first ordering + preselection is the single biggest take-rate lever (defaults are sticky). **Ethics**: preselection is fine only because the card states the full ongoing price ("then X every Y weeks") and the reassurance line before add-to-cart — never hide the recurring commitment. **A/B guidance**: test preselect on vs off per traffic source; preselect can slightly depress overall conversion on cold traffic while lifting take-rate — judge on projected LTGP per session (take-rate x LTV vs conversion delta), not on either metric alone. The daily `takeRateNum/takeRateDen` rollups in the app give you the take-rate side. |
| **Show frequency selector** | on | Letting customers pick a realistic cadence reduces "too much product" churn — the #1 voluntary cancel reason in replenishment categories. Hide it only for single-cadence offers; the recommended frequency then applies. The app-level switch (Buy box designer → layout → "Show frequency selector", published as `layout.showFrequency`) **overrides this block setting in both directions** and also governs the embed — see "Removing the frequency selector" below. |
| **Recommended frequency** | "8 weeks" | Matched against selling plan names; the matching plan is preselected. Set per product from real days-to-empty (the app's `ProductCadence` data), not an arbitrary monthly default — a cadence that matches actual usage prevents pantry-loading skips and cancels. |
| **Savings display** | Percent | Percent reads stronger below ~£50 price points ("Save 20%"); absolute reads stronger on premium AOV ("Save £18"). "Both" is honest but busy — test it on your highest-traffic PDP before rolling out. The savings are computed live from the selling-plan allocation vs the variant price, so they can never drift from checkout reality. |
| **Show reassurance** | on | "Skip, pause or cancel anytime." directly attacks commitment anxiety, the main psychological blocker to subscribing. Only show it if the portal genuinely offers all three (it does — skip/pause/cancel are one click in the Cellexia portal). |
| **Accent color** | `#4a5d4a` | The subscription card's distinct border/fill/badge. Match the brand's primary CTA family but keep contrast ≥ 3:1 against the page background. Deeper overrides via CSS custom properties (`--cx-accent`, `--cx-accent-soft`, `--cx-border`, `--cx-radius`, ... — see the header of `assets/buy-box.css`). |
| **Compact mode** | off | Tighter paddings for dense PDPs or drawer/quick-buy contexts. |

### Removing the frequency selector (`layout.showFrequency`, v1.2.0)

The Buy box designer can remove the delivery-frequency selector from the
widget **entirely, across all six presets** (published as
`layout.showFrequency: false` in the design config; a missing key means
`true`, so pre-v1.2.0 configs are unaffected):

- **classic / toggle / tiles / inline / value_stack** simply omit the
  dropdown/chips row — nothing else moves.
- **planner** would be pointless without its chips, so it degrades to a
  single recommended-cadence line ("Delivery every 8 weeks", built from the
  existing locale keys — no new strings) above the option cards.
- The hidden `selling_plan` input (or the patched cart request, in embed
  mode) still carries the **default plan**: the recommended frequency when
  one matches, else the group's first selling plan. The "then {price} every
  {frequency}" microcopy still states the cadence before add-to-cart, so
  the recurring commitment is never hidden.
- Subscribers can still change frequency later in the portal (portal
  frequency controls are governed separately by the plan's
  "allow frequency choice" setting on the Plans page).
- Groups with a single selling plan never rendered a selector in any
  version; this toggle just makes multi-plan groups behave the same way.

### Pricing display logic

- The **first-order price is shown big**; when the plan has a deeper
  first-order discount (fixed policy `afterCycle: 0` + recurring policy
  `afterCycle: 1`), the microcopy underneath states
  "then {ongoing price} every {frequency}" and the big price is labelled
  "First order". No surprise on renewal = fewer involuntary-feeling cancels
  and chargebacks.
- Savings are always computed against the variant's one-time price
  (`allocation vs variant.price`), so percent/absolute claims match exactly
  what checkout will charge.
- Prepaid plans additionally show "{price} per delivery" when the charge
  covers several deliveries.

All copy goes through the extension's locale files (`{{ 'key' | t }}`), so
the widget follows the storefront language automatically for all 22 shipped
locales.

## How the JS integrates with themes

- On load it finds the section's `form[action*="/cart/add"]` and injects (or
  reuses) a hidden `input[name="selling_plan"]`, dispatching `change` events
  so theme scripts and analytics can react.
- Variant changes are picked up from form `change` events and from
  `?variant=` URL updates (history patch + `popstate`); prices are swapped
  from a precomputed, fully-localized JSON island — the JS never does money
  math, so rounding and currency formatting always match Liquid.
- Selecting a delivery frequency while "one-time" is active switches the
  selection to subscription (choosing a cadence signals intent).
- It re-asserts the input on form `submit` in case a theme script rebuilt the
  form, and re-initializes on `shopify:section:load` for the theme editor.
- Alongside `selling_plan` it maintains the hidden
  `properties[_cx_design]` design-attribution input (see above) — enabled
  with the preset key when subscription is selected, disabled otherwise.
- Every preset funnels into the same state machine: radios
  (classic/tiles/value_stack/planner), `role=tab` buttons with arrow-key
  support (toggle), the inline checkbox, and frequency chips all call the
  same `setMode()`/`render()`; price nodes carry stable `data-cx-*` hooks
  in every preset, never preset-specific classes.
- A `cx:buybox:change` CustomEvent (detail: `variantId`, `sellingPlanId`,
  `mode`, `design`) bubbles from the block for pixels/analytics to hook into.
- Each widget registers on the guarded `window.CellexiaSubs` global
  (`getState()` / `setVariant()`); `getState()` returns `null` while the
  widget is hidden (launch-gated or unmounted embed), which is what lets
  `buy-box-embed.js` patch cart requests only for a selection the visitor
  can actually see.

## Accessibility

Native radios (visually hidden, fully keyboard-navigable) wrapped by the
whole card as a `<label>`; option groups are `role="radiogroup"` with a
translated label; `aria-checked` mirrors state; tap targets are ≥ 44px; the
frequency `<select>` has a visually-hidden label; RTL locales (Arabic) work
via CSS logical properties. Per-preset patterns: the toggle preset is a
real `role=tablist` (roving tabindex, ArrowLeft/ArrowRight/Home/End move
and activate, `aria-selected`/`aria-controls` wired to the panels); the
inline preset is a native checkbox; frequency chips are native radios
styled as pills. The toggle panel animation runs only when the design
enables it and the visitor has no `prefers-reduced-motion` preference.
