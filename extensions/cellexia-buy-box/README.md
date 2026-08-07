# Cellexia Buy Box — theme app extension

The PDP subscription widget. Renders the product's selling plans as one of
**seven design presets** (classic stacked cards by default) and carries the
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
snippets/cx-buybox-core.liquid   THE widget, self-contained: group ownership (which selling plan
                                 group is OURS — see "Running alongside another subscription app"),
                                 config resolution, text resolution, templating, frequency/save
                                 labels, price blocks, all seven presets, JSON island. The ONLY
                                 snippet in this extension — see the Liquid rules below for why it
                                 is deliberately one big file.
assets/buy-box.css               mobile-first styles (BEM namespaces cx-buybox / cx-buybox-embed)
assets/buy-box.js                widget behaviour: vanilla JS, deferred, no dependencies
assets/buy-box-embed.js          embed-only: self-mounting + fetch/XHR cart-request patching
locales/*.json                   storefront copy (en.default + 21 translations)
```

## Theme app extension Liquid rules

Two hard rules. Both were learned the expensive way — breaking either one
corrupts the rendered widget on every storefront, not just some themes.

**1. Never capture (or otherwise stringify) the output of a `render`.**
Shopify wraps the output of *every* `{% render 'x' %}` of an extension
snippet in `<!-- BEGIN app snippet: x -->` … `<!-- END app snippet -->`.
Those markers are invisible when they land in markup position, but the
moment a render is captured into a variable they become part of the
**string** — and a later `| escape` prints them as visible page text
(`<!-- BEGIN app snippet: cx-design-text -->CHOOSE YOUR RITUAL…`).

- A snippet may only emit final markup. **A snippet is never a function.**
- `snippets/cx-buybox-core.liquid` therefore contains **zero `render`
  tags**: every former helper snippet is inlined as `{% liquid %}` /
  `{% assign %}` blocks, or as a `{% capture %}` of pure markup (capturing
  markup that contains no render is fine — that is how the preset ordering
  knobs work).
- The only renders in the extension are the single
  `{% render 'cx-buybox-core' %}` in each of the two block files, both in
  markup position where the comment markers are ordinary HTML comments.
- The `snippets/` directory holds exactly one file. Adding a second snippet
  is almost always a mistake — inline it instead.

**2. `{{ 'key' | t }}` output is ALREADY HTML-escaped — never escape it again.**
The locale string `Subscribe & Save` comes back from the `t` filter as
`Subscribe &amp; Save`. Escaping it a second time yields `&amp;amp;`, which
the browser renders as the literal characters `&amp;`.

`cx-buybox-core.liquid` enforces this with a two-space string convention,
documented in full at the top of the file:

| Space | Meaning | Naming | Where it goes |
|---|---|---|---|
| **RAW** | unescaped source text (JSON metafield config, block settings, `selling_plan.name`) | `cx_<name>_raw` | `data-cellexia-*` attributes via exactly one escape filter; the JSON island via the json filter |
| **SAFE** | HTML-escaped, ready to print | `cx_<name>` | printed with a plain output tag, never filtered again |

- RAW → SAFE happens exactly once, with `| escape`, at the point of output.
- SAFE → RAW happens exactly once, in the "locale defaults" block, where
  `t` output is un-escaped (`&amp;` replaced **last**) so that locale
  defaults and merchant overrides can be resolved in a single space.
- `| money | strip_html` output counts as SAFE and is only injected into
  SAFE strings — it is never escaped, because a shop's `money_format` may
  legitimately contain entities.
- Anything `buy-box.js` writes with `textContent` (`data-cellexia-tpl` templates
  and every JSON-island string) must be RAW.

When editing, the whole convention is greppable:

- `grep '| escape'` — every hit must sit on a `_raw` variable (the only two
  exceptions are the `--cx-accent` / style-token values in the wrapper's
  `style` attribute, which are zod-validated hex/px and are escaped purely
  as attribute-injection hardening);
- `grep '| t'` — no hit may ever be followed by `| escape`;
- `grep 'render'` — there must be none in `snippets/`.

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
  widget renders `[hidden][data-cellexia-gated]` until the
  `cellexia.launch_status` metafield says `"live"`, and only a validated
  `?cx_preview=` token reveals it (same ribbon, same session behaviour —
  see "Safe launch & preview" below). Mounting only unhides the embed
  *wrapper*, never the gated widget inside it — **and it leaves that wrapper
  `[hidden]` too while the widget is gated**, because the wrapper is a
  full-width block with margins (and `grid-column: 1 / -1`): unhiding an
  empty one would push Add to cart down on the live product page before you
  go live. So enabling the embed during setup is genuinely a no-op on the
  storefront. Once a validated preview reveals the widget, `buy-box.js`
  unhides the mounted wrapper with it.
- **The app block wins.** If the page also renders the section-targeted app
  block, the embed stays hidden and dormant — never two widgets. Safe to
  leave the embed enabled as a fallback on themes that support blocks.
- **No `/cart/add` form? Still works.** On JS-driven themes (Sleepify posts
  to `/cart/add.js` via jQuery XHR with no form), `buy-box-embed.js` wraps
  `window.fetch` and `XMLHttpRequest` once and injects the selected
  `selling_plan` (+ the `properties[_cellexia_design]` attribution) into
  `/cart/add` and `/cart/add.js` POST bodies — FormData, urlencoded, JSON
  `items[]` or flat JSON alike, including the bracket form jQuery produces
  for an `items[]` payload (`items[0][id]=…`, injected per matching item).
  Requests are matched against **this product's variant ids**, so other
  vendors' cart calls (bundle widgets, upsells) pass through byte-identical;
  so does everything when one-time is selected, the widget is hidden, or
  anything at all errors. An add-to-cart can never break. Covered by
  `tests/embed-cart-injection.test.ts`, which drives the real file through
  `window.fetch` and asserts on the outgoing bodies.
- **Variant tracking.** Beyond the standard form/URL handling in
  `buy-box.js`, the embed watches the Sleepify size picker
  (`.pdp__options`) for **clicks as well as `change` events** — swatch
  buttons and labels fire no `change`, and a widget stuck on the first
  variant's prices would quote a price the checkout does not honour — then
  re-reads `?variant=` and, if the theme does not use it, the theme's own
  current-variant field (`[name="id"]`, or a `[data-variant-id]` outside the
  picker). Ids that are not this product's are ignored. No polling.

### Anchor-selector troubleshooting

- If the widget does not appear during preview, look for a small dark card
  bottom-left: **"Cellexia buy box: no placement anchor found — set a
  custom CSS selector in the Buy box designer → Placement."** That card is
  admin-only: it appears only once the app proxy has **validated** the
  preview token (`CellexiaSubs.previewValidated`), never on the mere
  presence of a `?cx_preview=` parameter — a leaked or expired link, or
  anyone appending that parameter, must not be shown internal English
  vendor copy on a customer-facing page. Because validation is a network
  round-trip, `buy-box.js` fires `cx:preview:validated` when it lands and
  the mount (and this card) is retried then. Real visitors never see it —
  for them a failed mount just means no widget, never breakage. A
  `console.warn` with the same diagnosis is logged for every merchant.
- Fix it by setting a selector: either on the embed (theme editor → App
  embeds → Cellexia Buy Box → Custom anchor selector, e.g. `.pdp__grey`)
  or centrally in the app (Buy box designer → Placement). The embed-level
  selector wins over the app one.
- A custom selector that matches nothing logs a warning and falls back to
  the automatic heuristics after a 1.5s grace period (late-rendered PDPs
  get two mount passes: DOM-ready and +1500ms).
- Test selectors in the browser console with
  `document.querySelector('...')` on the live PDP.

### Namespace note (unrelated "cx-*" app on the page) — READ BEFORE EDITING

cellexialabs.com already carries **another vendor's** app using element ids
`cx-i18n`, `cx-cart-config`, `cx-pdp-config`, `cx-embed-config`, plus the
`sm-rc-widget` bundle widget and Stamped reviews. In the buy column
(`.pdp__info`) that app renders:

```html
<div class="cx cx--self-contained" data-cx-embed>…</div>
```

**This cost us a production outage (fixed in v1.2.3).** Our app-embed wrapper
used to carry an attribute of the same name, and `buy-box-embed.js` found its
own wrapper with `document.querySelector('[data-cx-embed]')`. That returned
*their* element — it appears earlier in the DOM than our body-end wrapper — so
we wrote our mount marker onto DOM we do not own, and the mount check then
answered "already mounted" for ever. Our wrapper never left the end of
`<body>`: `[hidden]`, 0px tall, no buy box on the storefront.

Coexistence rules baked into this extension. **Do not "clean up" any of them:**

1. **Attributes are namespaced `data-cellexia-*`**, never `data-cx-*`. CSS
   class names stay `cx-buybox*` — they do not collide with that app's `.cx` /
   `.cx--self-contained`, and merchant CSS written against them keeps working.
2. **Every document-level lookup of our own markup carries our class as well
   as the attribute** — `.cx-buybox-embed[data-cellexia-embed]` and
   `.cx-buybox[data-cellexia-buybox]`, hoisted into the `OWN_WRAPPER` /
   `OWN_WIDGET` constants at the top of both asset files. Never a bare
   `[data-cellexia-…]` document lookup. Every other query is rooted at a node
   already proven to be ours.
3. **Ownership is asserted at the point of mutation**:
   `classList.contains('cx-buybox-embed')` before the wrapper is moved, marked
   or unhidden, `'cx-buybox'` before `init()` writes to a widget root. The code
   bails out silently on anything else.
4. Our global is the single guarded `window.CellexiaSubs` object; our CSS/JS
   never queries `[id^="cx-"]` or any id selector; the embed introduces **no
   element ids at all** (the widget's own ids are all uid-suffixed); the cart
   patcher only ever touches requests carrying our own product's variant ids;
   and the theme price sync excludes every Cellexia widget from its target
   search on top of its header / nav / footer / cart-drawer exclusions.

`tests/liquid/lint.test.ts` §5 enforces rules 1–2 statically, and
`tests/embed-mount.test.ts` reproduces the live collision (with a vacuity
guard that restores the bare lookup and asserts the widget is stranded again).

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
  prefers real add-to-cart forms over Shop Pay installment forms. Outside a
  section scope (the app embed boots at body end) a form is only used when
  its `[name="id"]` holds one of THIS product's variant ids — another
  product's quick-add form is never written to, since our `selling_plan`
  would make Shopify reject that product's add-to-cart. A theme with no
  product form of its own gets none here; the embed's request patcher carries
  the plan instead.
- **No JavaScript**: the widget hides itself (`<noscript>`) instead of
  showing a selection that would not reach the cart.

## Safe launch & preview

Installing the app and adding this block changes **nothing** on the live
storefront until the merchant explicitly goes live from the app admin.

- **The gate is a shop metafield.** The app maintains
  `shop.metafields.cellexia.launch_status` (`"setup"` until go-live, then
  `"live"`). While it is not `"live"`, the block still server-renders its
  full markup but with `hidden` + `data-cellexia-gated="true"` on the wrapper — and
  a CSS backstop (`[data-cellexia-gated][hidden] { display: none !important; }`)
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
- **The gate is a WRITE gate, not just a visual one.** A hidden widget also
  writes nothing into the theme's product form: `buy-box.js` skips its
  `selling_plan` / `properties[_cellexia_design]` injection entirely while the
  widget (or a wrapper around it) carries `hidden`, and removes anything it
  had written if it becomes hidden. Without that, a setup-mode shop on a
  Dawn-family theme would still have the preselected plan sitting in the
  form, and any customer's Add to cart would silently create a subscription
  line nobody could see. When the widget is legitimately revealed — a
  validated preview token, or the app embed finishing its mount — the write
  path is re-run through `CellexiaSubs.resync()`.
- **Reassurance.** Until go-live a real visitor cannot see the widget, add a
  selling plan to the cart, or reach subscription terms in checkout. Even
  someone who guesses the `?cx_preview` parameter name gets nothing: the
  reveal requires a validly signed, unexpired token, verified server-side,
  and nothing admin-only (not even the placement diagnostic card) keys off
  the raw parameter. In live mode the gate and the preview module are
  completely inert — the block renders and behaves exactly as before.

## Running alongside another subscription app (group ownership, v1.2.4)

**The widget renders OUR selling plan group, or it renders nothing. Never a
competitor's.** This is a safety rule, not a preference — read this section
before touching the group-selection block in `cx-buybox-core.liquid`.

### What went wrong

cellexialabs.com already runs **Joy Subscriptions**, whose selling plan group
sits **first** on the product and offers 5% off. The widget used to resolve
its group like this:

```liquid
assign cx_group = product.selling_plan_groups | first   # ← Joy's group
for g in product.selling_plan_groups
  if g.name downcased contains 'cellexia' → use it
```

No group was literally named "cellexia", so the widget rendered **Joy's
plan**: Joy's discount in the heading and the savings label, Joy's cadences in
the frequency selector, and — the part that matters — **Joy's selling plan id**
in the hidden mirror, in the JSON island and therefore in `/cart/add`. Any
subscription bought through our buy box would have become a **Joy contract**.
Editing the Cellexia plan in the admin changed nothing on the page, because
the Cellexia plan was never on the page. This is not a preview-only defect:
the same Liquid runs for every visitor.

### The allow-list

The app publishes the shop metafield `cellexia.plan_groups` (type `json`) on
every plan sync:

```json
{ "v": 1, "groupIds": ["6612300000009"], "planIds": ["6881100003"] }
```

`cx-buybox-core.liquid` renders the **first group on the product whose id is
in `groupIds` and which also contains one of the ids in `planIds`**. Ids are
compared **as strings, one entry at a time, by exact equality** — Liquid hands
out numeric ids and the metafield holds strings, so both sides are normalised
with an empty `append`. A substring test against a joined list would let group
`12` match an allow-listed `123`, which is exactly how a foreign group gets
rendered by accident. Do not "optimise" those loops.

`planIds` is the **second factor, and it is required, not a veto**. Matching
on `groupIds` alone put the entire ownership decision on one field of one
metafield: an allow-list naming the other app's group id resolved to *their*
group, and every line below that point is written on the assumption that the
group it was handed is ours — so their selling plan id reached the JSON island,
the nameless mirror and the cart. The plan ids are independent evidence (they
name plans this app created through the API), so requiring both means one
forged field is not enough.

An allow-list with **no** `planIds` therefore renders nothing at all. It used
to render on the group id alone, so that a shop upgrading from a build without
`SellingPlanConfig.shopifyPlanIds` would not lose its buy box — but empty
`planIds` is a state the app *emits itself* (`publishOwnGroupsMetafield()`
writes `{"groupIds":["77"],"planIds":[]}` when it cannot read a group back from
Shopify), so that exemption handed the whole guard back to a single field.
Failing closed costs an existing customer a blank buy box until the next
successful sync; failing open costs them a competitor's plan in their own cart.
The app repairs those plan ids before it publishes, so the window is the first
sync, not the life of the install.

Everything else is fail-closed:

| Situation | What renders |
|---|---|
| A group on this product is allow-listed, and holds an allow-listed plan | that group — the normal widget |
| A group is allow-listed by id, but holds none of the allow-listed plans | **nothing** — the group is skipped and the scan continues, so a genuinely-ours group later on the product still renders |
| Allow-list exists, no group on this product matches | **nothing** (plus the invisible marker below) |
| Metafield absent or `groupIds` empty (plans never synced, or the write failed) | **nothing** — including when the product carries exactly one group, and including when that group is ours. Re-sync the plan from the admin Plans page to publish the allow-list |
| Metafield malformed (a bare string, wrong shape, `groupIds` an object) | treated as absent → **nothing** |

There is **no name heuristic**. An earlier build matched a group whose *name*
contained `cellexia` when the allow-list was missing, and a name is
merchant-chosen text: on a store called Cellexia Labs, the other app's group
can perfectly well be called "Cellexia Subscribe & Save" — and then the name
match rendered *their* group. Guessing from a name has no safe version, so the
fallback was removed rather than narrowed. A group renders because its id is
allow-listed, or it does not render.

"Nothing" means nothing: no wrapper, no JSON island, no hidden input, no
`<style>`, no layout shift — byte-identical to the path a product with no
selling plans takes. There is **no** fallback to "the first group on the
product". That fallback *is* the bug.

### The admin-only diagnostic

A page that renders nothing is correct for a shopper and a mystery for the
merchant. So when no owned group matched, the snippet leaves exactly one
trace:

```html
<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden
          style="display:none!important"></template>
```

Three independent reasons it can never take part in layout: a `<template>`
renders nothing by definition (its contents are not even in the document
tree), it carries `hidden`, and the inline declaration outranks any theme
stylesheet — including the themes that re-display `[hidden]` elements. It is
also empty, carries none of the widget's hooks, and is never a `querySelector`
target for anything but the diagnostic below. `buy-box.js` turns it into the usual
`.cx-buybox-diagnostic` card reading *"Cellexia buy box: this product has
subscription plans from another app but none from Cellexia. Sync your Cellexia
plan to this product in the app's Plans page."* — **only** when
`CellexiaSubs.previewValidated === true`, i.e. after the app proxy has
validated a signed preview token. Never off the raw `?cx_preview=` parameter,
which anyone can put in a URL (same rule, same reasons, as the placement
diagnostic; see the namespace note). The app embed's own "no placement anchor"
card stays quiet on an empty wrapper, so the two never stack.

Pinned by `tests/liquid/render.test.ts` (§ selling plan group ownership,
including a vacuity guard that allow-lists Joy's group and watches the widget
render Joy's 5% plan — the reported symptom, reproduced) and by
`tests/buybox-no-owned-group.test.ts`, which runs the real asset files over
the real server-rendered markup and asserts the card is impossible to reach
without a validated session.

### What this does NOT fix

Both apps can still render a widget on the same PDP — ours is not able to
hide theirs. Disable the other app's PDP widget on those products before go
live. Contract-level isolation (billing, emails, analytics, portal) is a
separate mechanism in the app itself; see `docs/OPERATIONS.md`.

## Design presets

Seven CRO archetypes, all sharing the same selling-plan wiring, launch
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
| **subscription_max** (v1.6.0) | The subscription card **is** the buy box: one calm card (price, "then {price} every {frequency}", savings kept quiet, the reassurance line prominent). Heading, badge and frequency selector default OFF (each re-enableable); the plan default cadence is used. One-time purchase stays fully real but is demoted to a single muted underlined "or buy once for {amount}" line below the card; tapping it swaps in a minimal selected state (check + "One-time purchase — {amount}" + a quiet switch-back link). | When subscribing should read as the obvious way to buy — zero decision fatigue, purely visual (no extra perks or discounts). Highest take-rate posture; demoting one-time is a **medium** CVR risk on cold traffic. Test against your baseline; restoring the previous design is one click in the designer. |

### subscription_max: the compliance guardrails are load-bearing

Quiet is not hidden. The demoted one-time line is a real radio in the same
`role=radiogroup` (visually-hidden inputs, same sr-radio pattern as every
card preset), reachable in exactly **one** interaction, and its price is
printed in the link **before** selection. Selecting it clears the hidden
`selling_plan` input and reverts the theme's add-to-cart button through the
normal price sync; the switch-back link is a native `<label for>` wired to
the subscription radio (`aria-hidden` — it duplicates the radio group, which
screen readers and keyboards operate directly). `buy-box.js` contains no
subscription_max-specific code: the preset rides the existing
`data-cellexia-option` radio machinery end to end.

### Per-market design selection (`config.markets`, v1.6.0)

The designer can pick a preset **per Shopify Market**, with the main design
as the default for every market not listed. The published config gains

```json
"markets": { "<market handle>": { "preset": "subscription_max" } }
```

and the Liquid resolves the active preset in this order:

1. **`design_source` block setting** (theme-editor emergency override) —
   wins over everything, markets included.
2. **`config.markets[localization.market.handle].preset`** — exact match on
   the market handle; an entry naming an unknown preset falls back to the
   base preset (never a half-applied one).
3. **`config.preset`** — the main design.
4. **`classic`** — no published config at all.

Only the preset switches per market: text, layout, style and behavior are
inherited from the base config. The lookup is nil-safe — stores (or
harnesses) that do not expose `localization.market` simply render the base
preset — and `data-cellexia-preset` (and therefore the `_cellexia_design`
attribution property) always carries the **resolved** preset. The
storefront preview link shows the market of the domain you open it on.

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
`data-cellexia-preset="classic"`, the `cx-buybox--classic` class (which carries
no CSS rules — the base *is* classic), and extra JSON-island keys. All
knob defaults mirror `DEFAULT_DESIGN_CONFIG`, which is the v1.0.0
rendering written out as explicit values. Deleting the metafield is
therefore always a safe rollback.

### Text resolution and templates

Config text resolves per key: `config.text[current locale]` →
`config.text.en` → the extension locale files (the v1.0.0 copy). Blank or
whitespace-only overrides count as absent, so an empty admin field can never
blank out storefront copy. The `subscribeLabel`, `savingsTemplate`,
`firstOrderLine` and `oneTimeLinkLabel` fields support `{percent}` /
`{amount}` / `{frequency}` placeholders — resolved in Liquid for the first
paint and re-resolved by `buy-box.js` on variant/plan changes (values come
precomputed per variant × plan from the JSON island, so JS still never
formats money).

`data-cellexia-tpl` carries the **RAW** template (single escape filter in the
attribute; the browser hands it back un-escaped via `getAttribute`, and JS
writes the resolved result with `textContent`). It is emitted only when the
raw template actually contains a `{` placeholder — with one deliberate
exception: a merchant-authored `savingsTemplate` is always emitted, because
otherwise the JS would overwrite the custom label with the built-in
"Save X" copy on the next variant change. Every JSON-island string is RAW
for the same reason. See "Theme app extension Liquid rules" above.

### Theme add-to-cart price sync (`themeSync`, v1.2.2)

Many themes print the price inside their **own** Add to cart button ("ADD TO
CART - CHF 64.00"). That is the one-time price, so with the subscription
selected the shopper reads one price in the widget and another on the button
they are about to click. `buy-box.js` therefore performs a **money-string
swap**: the widget root carries `data-cellexia-money-onetime` and
`data-cellexia-money-sub` (the current variant's one-time price and the selected
plan's first-order price, formatted by Liquid with the shop's own
`money_format` — the JS still never formats money), and while subscription is
selected the JS walks the button's **text nodes** and replaces the one-time
string with the subscription one; variant and frequency changes re-sync from
the same `oneTime` / `first` values in the JSON island, and a
`MutationObserver` re-applies whenever the theme rewrites the label (Sleepify
does that on every variant change). It is safe by construction: text nodes
only — never `innerHTML`, so no theme markup, listener or analytics hook is
destroyed — it does **nothing at all** if the button does not literally
contain the one-time money string (no currency regex, no guessing), targets
are only looked for inside the widget's own product area (header, nav, footer
and cart drawers are excluded), everything it changed is recorded and restored
on one-time / hidden / launch-gated, a write budget kills the module and
returns the button if a theme fights back, and every entry point is wrapped in
try/catch — it never touches the form, the submit path or the cart payload, so
it can never block an add-to-cart. Configured from the app (Buy box designer →
**Theme integration**): `themeSync.syncAddToCartPrice` (default **on**, also
for shops with no published design) and `themeSync.priceSelector`, an optional
CSS selector for themes the built-in list (`.pdp__actions .btn--atc`,
`button[name="add"]`, `.product-form__submit`, `[data-add-to-cart]`,
`.btn--atc`) does not cover — `.pdp__actions .btn--atc` is the value for
cellexialabs.com's Sleepify theme. See
[docs/OPERATIONS.md §17](../../docs/OPERATIONS.md) for the troubleshooting
runbook.

### The `_cellexia_design` line property (design attribution)

When a subscription option is selected, `buy-box.js` maintains a hidden
`properties[_cellexia_design]` input in the product form whose value is the
active preset key (from the wrapper's `data-cellexia-preset`); the input is
disabled whenever one-time is selected, so it is only ever submitted with
a selling plan. Because the property name starts with an underscore,
standard themes and checkout **hide it from customers** — it never
appears on the cart line or the order confirmation. The ORDERS_CREATE
webhook reads it from `line_items[].properties` and logs the design key,
which is what powers take-rate-by-design reporting in the app: every
subscription add-to-cart is attributable to the exact design that
produced it.

The property was called `_cx_design` up to v1.2.2 and was renamed with the
rest of the storefront namespace (see the namespace note above). The widget
only ever writes the current name; the ORDERS_CREATE handler accepts **both**,
preferring the current one, so orders placed — and carts that were already
open — before the merchant updated the extension are still attributed.

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
| **Accent color** | `#1d1d1b` | The subscription card's distinct border/fill/badge. The default is the brand near-black, the same value as `--cx-accent` in `assets/buy-box.css`, as the app embed's accent and as `DEFAULT_DESIGN_CONFIG.style.accent` — this setting is **always** written into the widget's inline style, so it beats the stylesheet and a stray sample colour here repaints the whole widget (including on the "Force preset: …" emergency override, which ignores the published `style` block). Match the brand's primary CTA family but keep contrast ≥ 3:1 against the page background. Deeper overrides via CSS custom properties (`--cx-accent`, `--cx-accent-soft`, `--cx-border`, `--cx-radius`, ... — see the header of `assets/buy-box.css`). |
| **Compact mode** | off | Tighter paddings for dense PDPs or drawer/quick-buy contexts. |

### Removing the frequency selector (`layout.showFrequency`, v1.2.0)

The Buy box designer can remove the delivery-frequency selector from the
widget **entirely, across all seven presets** (published as
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

- On load it finds the section's `form[action*="/cart/add"]` — identity-checked
  against this product's variant ids whenever there is no section to scope to,
  so another product's form is never touched — and injects (or reuses) a hidden
  `input[name="selling_plan"]`, dispatching `change` events so theme scripts and
  analytics can react.
- **Exactly one field in that form is named `selling_plan`.** Shopify's cart
  parser honours the *last* duplicate, so a second field would silently beat
  the one the widget keeps in sync — and the app embed can move the widget,
  markup and all, into the very form the JS already injected into. The JS
  therefore owns a single field (tagged `data-cellexia-plan-input`: created by it,
  or the theme's own input adopted), the widget's server-rendered mirror
  (`data-cellexia-selling-plan`) is deliberately **nameless** and never submitted,
  and any other `selling_plan` field carrying our markup loses its name.
- **Nothing is written while the widget is hidden** (launch gate, or an
  app-embed wrapper that has not mounted): the injection is skipped and any
  earlier write is taken back, so a shopper can never carry a plan they
  cannot see. `CellexiaSubs.resync()` re-runs it on reveal/mount.
- Variant changes are picked up from form `change` events and from
  `?variant=` URL updates (history patch + `popstate`); prices are swapped
  from a precomputed, fully-localized JSON island — the JS never does money
  math, so rounding and currency formatting always match Liquid.
- Selecting a delivery frequency while "one-time" is active switches the
  selection to subscription (choosing a cadence signals intent).
- It re-asserts the input on form `submit` in case a theme script rebuilt the
  form, and re-initializes on `shopify:section:load` for the theme editor.
- Alongside `selling_plan` it maintains the hidden
  `properties[_cellexia_design]` design-attribution input (see above) — enabled
  with the preset key when subscription is selected, disabled otherwise.
- Every preset funnels into the same state machine: radios
  (classic/tiles/value_stack/planner), `role=tab` buttons with arrow-key
  support (toggle), the inline checkbox, and frequency chips all call the
  same `setMode()`/`render()`; price nodes carry stable `data-cellexia-*` hooks
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
