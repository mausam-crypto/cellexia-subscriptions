# Cellexia Buy Box — theme app extension

The PDP subscription widget. Renders the product's selling plans as one of
**eight design presets** (classic stacked cards by default) and carries the
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
snippets/cx-buybox-core.liquid   THE widget's brain: group ownership (which selling plan group is
                                 OURS — see "Running alongside another subscription app"), config
                                 resolution, text resolution, templating, frequency/save labels,
                                 price blocks, preset dispatch, JSON island. ALL string/value
                                 computation happens here — the presets only print.
snippets/cx-preset-*.liquid      the eight design presets (classic, toggle, tiles, inline,
                                 value_stack, planner, subscription_max,
                                 subscription_ultra_max), one partial each,
                                 rendered DIRECTLY (markup position) from the core's case
                                 statement. Pure markup: they compute nothing, resolve no text
                                 and render no further snippet — see the Liquid rules below.
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
(`<!-- BEGIN app snippet: cx-design-text -->CHOOSE YOUR RITUAL…`). That is
exactly what corrupted the v1.2.x storefront render.

The refined invariants (v1.7.0, when the preset partials — seven then,
eight today — were extracted from the core for the platform's Liquid size budget — since
verified to be a TOTAL across the extension, not per-file; see "The shipped
Liquid is minified on purpose" below):

- **Capture-around-render is forbidden forever**, in every Liquid form (tag
  form, `{% liquid %}` line form, `assign`/`echo`, and the legacy
  `include` spelling).
- **Renders happen only in direct-output markup position**, where the
  comment markers land between elements as ordinary invisible HTML
  comments: the single `{% render 'cx-buybox-core' %}` in each of the two
  block files, and the eight preset renders in the core's `{% case %}`
  dispatch. Nowhere else — never inside a `{% capture %}`, never as a line
  inside a `{% liquid %}` block.
- **Snippets never return values — a snippet is never a function.** All
  string and value computation stays in the consumer: the core precomputes
  every label, price string and flag and passes them as explicit render
  arguments; a preset partial only prints. Capturing PURE MARKUP that
  contains no render is fine — that is how the preset ordering knobs work.
- The `snippets/` directory holds exactly `cx-buybox-core.liquid` plus the
  eight `cx-preset-*.liquid` partials — the list is pinned by
  `tests/liquid/lint.test.ts`, so a stray snippet fails CI. A preset
  partial never renders another snippet.

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
- `grep 'render'` — every hit must be one of: the two block files' render
  of `cx-buybox-core`, or the core's eight direct preset renders in its
  `{% case %}` dispatch. None may sit inside a `{% capture %}` and none may
  appear in a preset partial.

## Core snippet internals

The full rationale that used to live as comments inside
`cx-buybox-core.liquid`, moved here so the shipped Liquid fits the
platform's TOTAL Liquid size budget. The compact comments in the file point here;
**the rules below are still load-bearing** — the byte-stable snapshot and
the goldens in `tests/liquid/` enforce them.

### The shipped Liquid is minified on purpose — this README is where readability lives

A real `shopify app deploy` proved the 100KB Liquid limit is enforced on
the **TOTAL of all `.liquid` files in the extension**, not per file. Every
shipped `.liquid` file is therefore kept minified:

- **no leading indentation** — every line starts at column 0. This is
  semantics-preserving: inside `{% liquid %}` blocks indentation is
  cosmetic, and in HTML the indentation before a kept newline collapses to
  the same single inter-element whitespace as the newline alone. **Every
  newline is kept** — several are load-bearing (the widget root's
  conditional attributes below, and each line of a `{% liquid %}` block is
  its own statement);
- **no blank lines**;
- **comments trimmed to one line each**, pointing here (still delimiter-
  and pipe-free — see the comment discipline above);
- **`{% schema %}` JSON compacted** (`JSON.stringify` style — Shopify only
  parses it, and `tests/liquid/schema.test.ts` still validates it);
- the eight preset partials **end without a trailing newline**, so a
  partial's rendered output ends flush at its last tag and no stray
  whitespace lands before Shopify's `END app snippet` marker.

When editing: edit in place at column 0, don't re-indent (the size guards
in `tests/liquid/size-limits.test.ts` and this budget are why), and don't
reformat a whole file — the render goldens and the byte-stable snapshot in
`tests/liquid/__snapshots__/` pin the output. Prose explaining WHY the
code is shaped the way it is belongs in this README, not in the Liquid.
Byte budget at the time of minification: 72,760 bytes total across the 10
files, against Shopify's 102,400-byte total and our own 90,112-byte (88KB)
working ceiling.

### Editing the file: comment discipline

Comments in the core and the preset partials contain **no Liquid tag or
output delimiters** — Liquid parses the body of a comment block even though
it never renders it, so a half-written tag inside a comment can break the
whole storefront page. Write tag names in prose (render / capture /
assign), never as real tags. They also contain **no pipe characters**: the
harness-fidelity lint (`tests/liquid/lint.test.ts` §6) reads every "pipe
word" in the file as a filter name that the harness must implement.

### The string-space contract (two spaces, never mixed)

**RAW** — unescaped source text, exactly as authored: merchant text from
the `cellexia.buybox_design` JSON metafield, theme-editor block settings,
Shopify object names (`selling_plan.name`). Variables carry the `_raw`
suffix. RAW is what travels in `data-cellexia-*` attributes (single escape
filter, which the browser decodes back to raw on `getAttribute`) and in
the JSON island (single `json` filter, whose values `buy-box.js` writes
with `textContent`).

**SAFE** — HTML-escaped text, ready to be printed. Variables carry no
suffix. Printed with a plain output tag and **never filtered again**.

Conversions — each happens exactly once, at a marked boundary:

- RAW → SAFE: the escape filter (the only escape in the pipeline), at the
  point of output.
- SAFE → RAW: the documented un-escape chain in the core's "locale
  defaults" block. It is applied **only** to t-filter output, which is the
  one source that arrives pre-escaped, so that locale defaults and
  merchant overrides can be resolved in one space. `&amp;` is replaced
  **last** (otherwise `&amp;lt;` would decode twice). `escape(unescape(t))
  == t`, so the chain is loss-free — and it stays correct in the
  hypothetical where a future Shopify version stops escaping t output.

**Money** — `money` + `strip_html` output is treated as SAFE. A shop's
`money_format` may legitimately contain HTML entities: Shopify's own stock
formats include `&pound;{{amount}}`, `&euro;{{amount_with_comma_separator}}`
and the widely used `{{amount}}&nbsp;CHF`; `strip_html` removes tags,
never entities. Money is therefore only ever injected into SAFE strings
and **never escaped again, by any filter**. Strings that mix money with
locale copy (the "then …", "Save …" and "… per delivery" lines) are
consequently SAFE, and are un-escaped once on the way into the JSON island
(where the JS needs RAW).

**Island exception** — money that enters the JSON island is decoded
SAFE → RAW there, exactly once, by the dedicated money chain at the
island's variants map: the money-format entities Shopify's stock formats
actually use (`&nbsp;` `&pound;` `&euro;` `&yen;` `&cent;`) plus the
standard un-escape set, `&amp;` last. `<script>` is a raw-text element —
the browser decodes entities in attributes and text nodes but **never**
inside the island — so leaving island money SAFE paints literal
`&nbsp;`/`&euro;` through `textContent` into every price line and breaks
the theme price sync's byte-for-byte text match. The composed island
strings (then / save / perDelivery) take their locale sentence through the
same SAFE → RAW chain as the locale-defaults block, and only **then**
receive the RAW plan label and the RAW money string (money decoded first;
composing before un-escaping would run the chain over the money too). No
value is ever escaped or un-escaped more than once.

**Named t-filter arguments are only ever inert placeholder literals**
(`{price}`, `{amount}`, `{frequency}`) — never a real value. The t filter
escapes whatever it interpolates, so passing it a SAFE money string would
turn `&euro;` into `&amp;euro;`, which prints as the literal characters
`&euro;` on the page — the same visible-entity defect that corrupted the
v1.2.0 render, one currency format away. (And in the mirror case where a
future Shopify version stops escaping, a merchant-authored selling-plan
name would reach the page unescaped instead: one placeholder rule is
correct under both behaviours.) `{` and `}` are untouched by every escape,
so the placeholders survive the filter intact and the real values are
substituted with `replace` immediately afterwards — SAFE values into the
SAFE result that is printed, RAW values into the un-escaped copy that
feeds the JSON island. Exactly one escape per value, on either path.

**`data-cellexia-tpl`** carries the RAW template so `buy-box.js` can
re-resolve the percent/amount/frequency placeholders on variant/plan
change and write the result with `textContent`. It is emitted only when
the RAW template actually contains a `{` placeholder, with one exception:
a merchant-authored `savingsTemplate` is always emitted, so the JS never
overwrites it with the built-in "Save X" label.

### The preset partials compute nothing

`{% render %}` isolates scope, and the partials leverage that as a design
principle: every value a preset prints — every label, price string, flag
and precomputed markup fragment — is resolved in the core and passed as an
explicit render argument. A variable missing from an argument list fails
visibly in the harness goldens instead of silently rendering blank. The
only filters inside a partial are `money` on price cents and the
documented single `escape` of RAW template values into `data-cellexia-tpl`
attributes. A partial resolves no text, reads no metafield and renders no
further snippet.

### The widget root's conditional attributes (whitespace control)

The root `<div>` carries two conditional attributes — `data-section-id`
('section' context only) and the `hidden data-cellexia-gated` pair (gated
shops only) — each on its own source line, which puts every edit one
whitespace-control mistake away from either of two bugs:

- trim nothing, and a false condition leaves a whitespace-only line inside
  the opening tag — harmless to browsers, but emitted on every render and
  recorded forever in the byte-stable snapshot;
- trim both sides, and the newline separating two attributes disappears
  with the tag, gluing them into one token (`id="…"class="…"`) and
  silently dropping an attribute the JS depends on.

So each conditional attribute opens with a **left-trimming** tag delimiter
(which eats the newline plus indentation that precedes it) and re-supplies
that newline and indentation **inside its own body**, ahead of the
attribute. The attribute is still written on its own line when the
condition holds, and nothing at all is emitted when it does not; the
separating newline always travels with the attribute it introduces. Never
trim the trailing side of these tags, and never hoist that leading newline
out of the body — either change re-creates one of the two bugs.
`tests/liquid/render.test.ts` ("widget root attribute list") pins all four
shapes.

The root's `data-cellexia-money-*` / `data-cellexia-price-*` attributes
drive the theme add-to-cart price sync (see the themeSync section below).
Both money attributes are SAFE money and never escaped; only the double
quote is converted to its entity, which the browser decodes back on
`getAttribute`, so what the JS compares is byte-identical to what the
theme printed. `data-cellexia-money-sub` is empty when the current variant
has no allocation in our group — there is no subscription price to
promise, and the JS then leaves the theme alone. `cx-buybox--no-sub` on
the root's class list makes the **first paint** honest for such a variant,
instead of showing a subscription card at the one-time price until the JS
runs.

### The nameless selling-plan mirror

The hidden input tagged `data-cellexia-selling-plan` records the resolved
plan id (recommended frequency, else the group's first plan — the same id
the JSON island carries as `initialPlan`) in the DOM before any script
runs, mirroring the visible preselection exactly: empty while one-time is
preselected. **It must never carry `name="selling_plan"`.** The markup
travels with the widget, and `buy-box-embed.js` can move the widget inside
the theme's `/cart/add` form (placement heuristics 3 and 4); `buy-box.js`
has by then already injected its own `selling_plan` input into that form,
so a named mirror would make two `selling_plan` fields in one form — and
Shopify's cart parser keeps the **last** duplicate, which is not the one
the JS keeps updating. A shopper switching to "One-time" would still get a
subscription line. The name therefore belongs to exactly one field, the
one `buy-box.js` owns and tags `data-cellexia-plan-input`. No-JS safety
follows from the same rule: with scripting off nothing here can reach the
cart at all (and the `<noscript>` rule hides the widget, so no
unfulfillable promise is shown).

### The JSON island

Fully localized price strings per variant × selling plan; `buy-box.js`
only swaps strings — it never formats money or builds copy. `freq` and
`savePct` feed the client-side `{frequency}`/`{percent}` template
re-resolution; `pd` feeds the per-delivery hooks; `oneTime` (per variant)
and `first` (per variant × plan) are also the pair the theme add-to-cart
price sync swaps, so a variant or frequency change re-syncs the theme's
button without the JS ever formatting money. Since v1.6.8 the matrix is
complete per variant: `oneTimeCents` and `compareAt` (formatted, emitted
only when it beats the price) per variant, `firstCents` and the formatted
`ongoing` price per variant × plan, plus `available` — the cents exist so
the ONE client-side price comparison (the strike-through decision) is
exact instead of a string inequality; every displayed string still comes
pre-formatted from Liquid. Every string in the island is RAW — see the
island exception above for why.

### Merchant custom CSS (brace containment)

`style.customCss` is sanitized server-side (`sanitizeCustomCss`) before
publish; the replaces and the brace walk in the core are an idempotent
belt-and-suspenders against hand-edited metafields (the `slice` mirrors
the server's 5000-char cap so the walk is bounded whatever the metafield
holds). The css is emitted inside a wrapper rule scoped to the widget
instance id, so a right brace that is not closing a brace opened inside
the css would close the wrapper itself and turn every rule after it into
unscoped, storefront-global CSS. The core walks the segments between right
braces keeping a depth counter and drops the css entirely the moment depth
would go negative; the `x` sentinel keeps `split` from collapsing trailing
separators, so segment count is always close-count + 1 and only the last
segment (never followed by a right brace) is skipped.

### Group ownership, the no-owned-group marker, presets, price sync

The full expositions live in their own sections of this README: "Running
alongside another subscription app" (the ownership allow-list, its two
mandatory factors and the forged-field history), "The admin-only
diagnostic" (why the marker is a `<template>` with three independent
layers against theme CSS), "Design presets", "Text resolution and
templates" and "Theme add-to-cart price sync".

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
- **Variant tracking (layered, event-independent since v1.6.8).** Events
  are the fast path: product-form `change` and `?variant=` (history patch +
  popstate) in `buy-box.js`, plus this embed's Sleepify size-picker watcher
  (`.pdp__options`, **clicks as well as `change` events** — swatch buttons
  and labels fire no `change`; since v1.11.0 the fast path also knows the
  pills' `data-val-id` attribute — the client's current vocabulary, one
  pill's value shipped with trailing whitespace, so every read is
  trimmed — and re-reads at **+60/350/900 ms** instead of one +60 ms shot,
  because themes and bystander widgets settle their state on unpredictable
  schedules; its DOM re-read uses the same field → active-selection →
  passive-marker trust order as `buy-box.js` below). Underneath them,
  `buy-box.js` also tracks
  variants **with no event at all** — the fix for the live merchant report:
  their theme sells jar packs as separate variants switched by its own pill
  buttons, setting state programmatically (jQuery `.val()`, no `change`
  event, no `?variant=` write), and every widget price stayed frozen on the
  landing variant. Three layers, all funnelling into one authoritative
  re-read (`readThemeVariant()`: the bound form's `[name="id"]` first, then
  a READ-ONLY document-wide scan — `scanThemeFields()`, which skips our own
  markup and, since v1.11.0, collects next to `[name="id"]`
  inputs-and-selects any element carrying a variant id only as an
  ATTRIBUTE (`data-variant-id` / `data-val-id` / `data-variant`, values
  trimmed) — then `?variant=`, else keep current): click delegation over
  the product area
  (re-read next macrotask + again at +350 ms, themes update state
  asynchronously), and a 600 ms poll of the same field — a string compare,
  only while the document is visible, ONE interval per widget, cleared on
  pagehide and detach, re-armed by `resync()` — which catches ANY
  mechanism, including pure-JS themes. The poll reuses the last scan's
  field list (validated for liveness, re-queried every 10th tick);
  click-driven re-reads always re-query. A page carrying SEVERAL such
  signals for this product (quick-buy modal, sticky add-to-cart bar,
  bystander widgets) is settled on evidence, not document order. The
  v1.11.0 tiers came from the SECOND live Sleepify defect: the pills moved
  their id to `data-val-id` (no `input[name="id"]` exists on the page any
  more, and the theme marks selection only by moving an `active` class
  between pills), and the only other page-level signal was a bystander
  vendor widget's rows (`.cx-az-fbt__row[data-variant-id]`) tracking the
  current variant on their own schedule — the old one-shot +60 ms re-read
  didn't know `data-val-id`, trusted the first `[data-variant-id]` found,
  raced the bystander's update and pushed the PREVIOUS variant after every
  pill click, so the widget ran permanently one click behind (wrong
  subscription price, and the theme add-to-cart button swap stopped
  matching, so it froze too). Every signal is now classified **per read**
  into evidence tiers, strongest first:
    1. the bound (ownership-checked) form's `[name="id"]` — conclusive;
    2. any signal whose value **CHANGED** since the last read — the one
       the shopper is driving — fields and markers alike;
    3. `[name="id"]` fields, unanimous, then the own-section tiebreak —
       the canonical form state stays above any mere marker, and a laggy
       field self-corrects through tier 2 the moment it catches up;
    4. the theme's own active-selection paint (checked input,
       `aria-selected` / `aria-pressed` / `aria-checked`, or an
       `active`/`selected`/`current` class token), unanimous;
    5. passive bystander markers (another widget's row naming one of OUR
       variants), unanimous, and only when no field and no active carrier
       said anything — the weakest evidence never overrides the theme's
       own state.
  An **unpicked swatch is never evidence**: a control-shaped carrier
  (button/label/link/option, radio/checkbox input) without the active
  signal, or one inside `.pdp__options` / `[data-option]`, permanently
  names its OWN variant, not the current selection — reading it as
  "current" is how a widget freezes on the first pill in a row. A stale
  duplicate can never freeze or flip the widget. On
  a change, every price surface of every preset repaints from the island's
  per-variant matrix, the root `data-cellexia-money-*` pair re-anchors, and
  the theme add-to-cart price sync swaps the new variant's strings.
- **Un-synced variants park the widget.** A NUMERIC id the island has no
  row for, read from the bound (ownership-checked) form or from a field
  that was previously seen holding this product's ids, is conclusive: the
  product gained a variant after the last plan sync, and nothing the
  widget could show would price it. Only a real `[name="id"]` **field** may
  raise this verdict (v1.11.0) — a marker ATTRIBUTE, e.g. another widget's
  rows reshuffling to a variant we never sold, is not evidence this
  product changed, so a marker never parks the widget. The widget
  **parks** — root `[hidden]`
  plus its own `data-cellexia-unsynced` marker, the theme's form released
  (no `selling_plan` left to 422 the new variant, design property
  disabled), the theme's button text restored, `getState()` null so the
  embed's cart patcher carries no plan either — and un-parks with a full
  repaint the moment a known variant returns. Foreign numeric ids with no
  such history (another product's quick-add) never park anything. A plan
  re-sync ships a fresh island, so a reloaded page prices the new variant
  normally. Covered by `tests/buybox-variant-tracking.test.ts` (real
  Liquid render + real JS, programmatic switch with NO events), including
  mutation checks that disable the poll and the disagreement rules and
  prove the respective tests fail without them, and by the two-nets
  vacuity guard in `tests/buybox-foreign-section-form.test.ts`.

### Anchor-selector troubleshooting

- If the widget does not appear during preview, look for a small dark card
  bottom-left: **"Cellexia buy box: no placement anchor found — set a
  custom CSS selector in the Buy box designer → Placement."** That card is
  admin-only and double-gated: it appears only on a page whose own URL
  carries `?cx_preview=` **and** only once the app proxy has **validated**
  the token (`CellexiaSubs.previewValidated`). Never on the mere presence
  of the parameter — a leaked or expired link, or anyone appending it, must
  not be shown internal English vendor copy on a customer-facing page — and
  never off the stored session alone: the validated token persists in
  `sessionStorage` across same-tab navigation (that is how the widget
  reveal follows PDP → cart), so without the URL half the card could
  surface on pages the admin never previewed. Because validation is a
  network round-trip, `buy-box.js` fires `cx:preview:validated` when it
  lands and the mount (and this card) is retried then. Real visitors never
  see it — for them a failed mount just means no widget, never breakage. A
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
   cart line shows the selling plan ("Every 8 weeks", "Every 10 days",
   "Every 1 month" etc. — since v1.8.0 plan cadences can mix days, weeks
   and months).

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
  (`GET /apps/cellexia-subs/preview/validate` — HMAC-signed, preview-only action,
  7-day expiry, never consumed). Only a `{ ok: true }` answer removes
  `hidden` and shows the localized "Preview — only you can see this" ribbon.
  Everything fails closed: an invalid or expired token is dropped from
  `sessionStorage`, and a network error simply leaves the widget hidden.
- **A failed validation is named, not silent (v1.6.7).** Fail-closed
  rendering is unchanged — the widget stays hidden — but when the URL of the
  page you are on carries `?cx_preview=` **and** the validation round-trip
  completes with a failure, `buy-box.js` raises the usual admin diagnostic
  card (same style as the placement and no-owned-group hints) naming which
  failure it was: an `{ ok: false }` answer means the token is expired or
  invalid ("Generate a fresh preview link from Preview & launch"), while an
  HTTP error status or a network failure means the round-trip itself did
  not complete ("the preview could not be validated (HTTP 404) … run the
  Preview Doctor" — the exact blank page you get when the extension was
  never deployed; the admin-gated Preview Doctor names the undeployed proxy
  and the deploy command). The gate is the URL parameter of *this* page
  load, never `sessionStorage`: customers never carry the parameter, a
  stored token following the tab to other pages raises nothing there, and a
  transport failure keeps the token so a reload after deploying just works.
  Because this card's gate is the URL parameter ALONE (validation failed,
  so no admin is proven), its copy is treated as an unauthenticated
  surface: it names no proxy paths and no operator commands — that detail
  lives behind admin auth in the Preview Doctor. Pinned by
  `tests/preview-failure.test.ts` in both install shapes, including a
  no-internal-detail assertion.
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
{ "v": 2, "groupIds": ["6612300000009"], "planIds": ["6881100003"],
  "planSets": [["6881100001", "6881100002", "6881100003"]], "appId": "4830258" }
```

`cx-buybox-core.liquid` renders the **first group on the product that passes
BOTH factors: its `app_id` equals `appId`, AND its live plan set EXACTLY
equals one `planSets` entry — same members, same count** (v1.6.9 — the old
`groupIds` equality is gone entirely, and the any-member `planIds` rule went
with it; both legacy fields still travel for the Preview Doctor and the
pre-v1.6.9 extension). Ids are compared **as strings, one entry at a time,
by exact equality** — the metafield holds strings, plan ids arrive numeric,
so both sides are normalised with an empty `append`. A substring test
against a joined list would let plan `12` match an allow-listed `123`, which
is exactly how a foreign group gets rendered by accident. And the set must
match by COUNT as well as by members: an any-member rule would let ONE
corrupted entry render a competitor's single-plan group whose owner stamped
our public app id onto it (see below). Do not "optimise" those loops.

**The two v1.6.9 factors, and why they have this exact shape.** After the
id-space fix below, a single field — one `planIds` entry — decided ownership
by itself; anything that could write a plan id into the metafield (a bug, a
bad migration, a forged request) was sufficient alone.

1. **`app_id` = `appId`.** `selling_plan_group.app_id` lives on the
   **group**, not in the metafield, and exists only because this app
   **stamps** it there (`SellingPlanGroupInput.appId` on every group
   create/update, plus a heal on every allow-list publish — Shopify leaves
   `app_id` nil otherwise). Unlike group ids, app ids read the same from
   the Admin API and from Liquid, which is what makes the comparison usable
   at all. HONEST LIMIT: the value is public and any app can stamp any
   string onto its OWN groups — a competitor can copy ours — so this factor
   forces coherence but never decides alone.
2. **Exact plan-set equality**, not any-member. Because of that honest
   limit, an any-member plan rule would collapse back to one field against
   a competitor who pre-stamped our app id: ONE forged `planIds` entry
   would render their single-plan group (Joy's group has exactly one plan).
   Under exact set equality, tampering with an existing set darkens the
   widget — ours included, fail closed — and rendering a foreign group
   requires authoring its complete, well-formed set: wholesale forgery of
   the trust anchor, the documented residual no storefront-side rule can
   close.

Missing either half — a pre-v1.6.9 metafield with no `appId`/`planSets`, a
pre-v1.6.9 group not yet stamped, or a stale set after a plan change —
renders **nothing** until the next plan sync or publish heals it (fail
closed; the Preview Doctor names the exact half, and the daily alert sweep
republishes automatically and alerts only if that did not fix it).

**Why plan ids and not group ids (the id-space trap, fixed live):** storefront
Liquid exposes `selling_plan_group.id` in a **different id space than the
Admin API** — an opaque storefront identifier, not the numeric admin id the
app knows and publishes in `groupIds`. A group-id comparison therefore matches
*nothing* on a real storefront, and an ownership rule that required it
rendered nothing on a product whose plan sync had **succeeded** (the merchant
saw the "plans from another app" admin card next to a correctly-synced plan).
Selling **plan** ids are numeric and identical in both APIs — they are what
the cart's `selling_plan` param carries — so the plan-id intersection is the
ownership test. `planIds` names plans this app created through the API, which
also makes it the trust anchor the group id never was. The legacy `groupIds`
equality survived v1.6.6 as a demoted secondary OR — inert by construction
(admin-numeric ids cannot equal opaque storefront ids), reachable only by a
hand-written metafield carrying the opaque form — which made it pure attack
surface for zero benefit, so **v1.6.9 removed the branch outright**: the
storefront never reads `groupIds` at all now. The field still travels in the
metafield for the Preview Doctor and for humans debugging a shop.

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
| A group on this product carries the allow-listed `appId` AND its live plan set exactly equals a `planSets` entry | that group — the normal widget (first such group, in product order) |
| A group fails either factor (wrong/nil `app_id`, or its plan set matches no published set — partial, superset, or one mutated member) | **nothing** — the group is skipped and the scan continues, so a genuinely-ours group later on the product still renders |
| Allow-list exists, no group on this product passes both factors | **nothing** (plus the invisible marker below) |
| Metafield absent, `planSets` empty/missing, or `appId` missing (plans never synced, the write failed, or the metafield predates v1.6.9) | **nothing** — including when the product carries exactly one group, and including when that group is ours. Re-sync the plan from the admin Plans page to republish |
| OUR group not yet stamped with `app_id` (synced before v1.6.9) | **nothing** until the next sync or allow-list publish stamps it |
| Metafield malformed (a bare string, wrong shape, lists as objects) | treated as absent → **nothing** |

There is **no name heuristic**. An earlier build matched a group whose *name*
contained `cellexia` when the allow-list was missing, and a name is
merchant-chosen text: on a store called Cellexia Labs, the other app's group
can perfectly well be called "Cellexia Subscribe & Save" — and then the name
match rendered *their* group. Guessing from a name has no safe version, so the
fallback was removed rather than narrowed. A group renders because it holds an
allow-listed plan, or it does not render.

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
          style="display:none!important"
          data-cellexia-diag-group-count="1"
          data-cellexia-diag-groups="joy-subscriptions:Joy Subscriptions"
          data-cellexia-diag-allowlist="present"
          data-cellexia-diag-plan-count="3"
          data-cellexia-diag-set-count="1"
          data-cellexia-diag-allow-app-id="4830258"></template>
```

The `data-cellexia-diag-*` attributes say **why** nothing matched, readable in
any browser inspector: every selling plan group on the product (`app_id:name`,
names truncated to 40 characters and escaped once), whether the allow-list
metafield was published at all, how many legacy plan ids and how many plan
SETS it carries (`plan-count` 3 with `set-count` 0 reads as a pre-v1.6.9
metafield), and which `appId` it expects (`none` when the field is missing;
read next to the per-group app ids, an unstamped or mismatched group is
visible in the same inspector view). They are diagnostic data for the admin
card and for humans; nothing reads them at storefront runtime.

Three independent reasons it can never take part in layout: a `<template>`
renders nothing by definition (its contents are not even in the document
tree), it carries `hidden`, and the inline declaration outranks any theme
stylesheet — including the themes that re-display `[hidden]` elements. It is
also empty, carries none of the widget's hooks, and is never a `querySelector`
target for anything but the diagnostic below. `buy-box.js` turns it into the usual
`.cx-buybox-diagnostic` card reading *"Cellexia buy box: this product has
subscription plans from another app but none from Cellexia. Sync your Cellexia
plan to this product in the app's Plans page."* — **only** when the current
page's own URL carries `?cx_preview=` **and**
`CellexiaSubs.previewValidated === true`, i.e. after the app proxy has
validated the signed token. Never off the raw parameter alone, which anyone
can put in a URL, and never off the stored session alone, which follows the
tab to pages the admin never previewed (same double gate, same reasons, as
the placement diagnostic; see the namespace note). The app embed's own "no
placement anchor" card stays quiet on an empty wrapper, so the two never
stack.

Pinned by `tests/liquid/render.test.ts` (§ selling plan group ownership,
including a vacuity guard that allow-lists Joy's group and watches the widget
render Joy's 5% plan — the reported symptom, reproduced) and by
`tests/buybox-no-owned-group.test.ts`, which runs the real asset files over
the real server-rendered markup and asserts the card is impossible to reach
without a validated session on a page opened through a preview link — a
fully validated storage-only session (the PDP → cart hop) raises nothing.

### What this does NOT fix

Both apps can still render a widget on the same PDP — ours is not able to
hide theirs. Disable the other app's PDP widget on those products before go
live. Contract-level isolation (billing, emails, analytics, portal) is a
separate mechanism in the app itself; see `docs/OPERATIONS.md`.

## Design presets

Eight CRO archetypes, all sharing the same selling-plan wiring, launch
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
| **subscription_ultra_max** (v1.11.0) | subscription_max taken to its logical end: the card sheds **all** offer chrome (no border/tint via `cx-buybox__ultramax-card`; badge, savings, reassurance and frequency selector all default OFF, each re-enableable by an explicit config `true`; heading defaults empty) so the subscription price reads as the product's plain price, not a plan being sold. Subscription is preselected unless `behavior.preselect === 'one_time'`; the recurring "then {price} every {frequency}" line **always stays** — recurrence disclosure is not optional. The quiet priced one-time line doubles as a **satellite** that `buy-box.js` relocates below the theme's whole buy area while the widget is visible (see the subsection below). | Maximum posture, maximum accountability: watch PDP conversion **and** refund/cancel quality, not just take-rate — shoppers who did not understand they subscribed are expensive. Warm traffic on a hero product where subscription is the intended default. |

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

### subscription_ultra_max: the plain-buy-box posture and the satellite

subscription_max taken to its logical end (v1.11.0, partial
`snippets/cx-preset-subscription_ultra_max.liquid`). The card sheds **all**
offer chrome: no border or tint (the `cx-buybox__ultramax-card` CSS), and
badge, savings, reassurance and frequency selector all default **off** —
each re-enableable only by an explicit config `true`. The heading defaults
empty; subscription is preselected unless `behavior.preselect ===
'one_time'`. The one guardrail that never sheds is the recurring "then
{price} every {frequency}" line — **recurrence disclosure is not
optional**, in this preset or any other.

The quiet priced one-time line (same radio, same one-tap reach and
pre-selection price as subscription_max) doubles as a **satellite**:

```html
<div class="cx-buybox__submax-onetime cx-buybox-satellite"
     data-cellexia-satellite data-cellexia-for="{{ uid }}">…</div>
```

It is rendered **inside** the widget root — so no-JS and launch-gated pages
are exactly as safe as subscription_max (the launch gate is an ancestor
`[hidden]`, and the line is inside that ancestry at render time) — and
`buy-box.js` relocates it below the theme's whole buy area while the widget
is visible. **Anchor order**: the first `.pdp__grey` found walking **up**
from the root (the client's PDP: quantity + Add to cart + badges +
guarantee + reviews), else the bound `/cart/add` form, else it stays where
the Liquid put it — which is the subscription_max layout.

The gate-safety invariants are load-bearing — do not "simplify" any of them:

- **Outside the root the ancestor-`[hidden]` gate is gone**, so the
  satellite mirrors `widgetHidden()` onto its **own** `hidden` attribute on
  every sync — a gated, parked or ghost widget never leaves a visible
  one-time line behind. It also carries its own copy of the
  `cx-buybox--no-sub` state class, since the root's class list no longer
  cascades to it.
- **Ownership is asserted (`isOwnSatellite`) before every move or
  removal** — the same rule as every other own-markup mutation (see the
  namespace note). Both asset files hoist the lookup into the new
  `OWN_SATELLITE` constant (`.cx-buybox-satellite[data-cellexia-satellite]`),
  registered in the lint allow-list, and the variant-tracking scans skip it
  like the other own-markup selectors.
- **A ghost root's satellite is removed**: when the widget's markup was
  replaced (theme-editor section re-render), its relocated line must not
  survive it — the successor renders and mounts its own; a predecessor's
  stray satellite for the same block is also cleaned up at init.
- **A relocated radio must never join a theme `<form>`**: whenever a FORM
  ancestor appears above the satellite, its inputs get a form-detaching
  attribute (`form` pointing at a non-existent id) so a stray `cx-purchase`
  field can never be submitted with the theme's add-to-cart.
- Every radio/wrap/price node reference was collected **at init**, while
  the satellite was still inside the root, so the existing state machine
  drives it **by reference** after the move — `buy-box.js` still contains
  no preset-specific selection logic; the satellite rides the same
  `data-cellexia-option` radio machinery, relocated. A theme re-render that
  destroys the satellite's host brings it home to the widget first, then
  re-mounts.

Size guard: the satellite module is part of why
`tests/liquid/size-limits.test.ts` raised `JS_FILE_LIMIT` 92→112KB in
v1.11.0.

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

**Theme MAIN price display (v1.11.0).** The same exact-money-string swap now
also covers the theme's main price display — the price under the product
title, which otherwise keeps quoting the one-time price while the
subscription is selected. Two new config fields, sanitized and published
exactly like their button counterparts: `themeSync.syncMainPrice` (boolean,
default **on**) and `themeSync.mainPriceSelector` (string, default `""`,
same sanitization as `priceSelector`, max 300 chars — when set it replaces
the built-in list entirely). The built-in main-price selector list is
`.pdp__price, .product__price, .price__regular, .product-price,
[data-product-price]` — the first entry is cellexialabs.com's Sleepify
theme. Struck-through compare-at and per-unit strings are **deliberately
untouched**: they are not the one-time money string, and this module never
computes money. The Liquid emits two new root attributes,
`data-cellexia-price-sync-main` and `data-cellexia-main-selector`; a
missing `syncMainPrice` key in an old metafield means **on**, while
pre-v1.11.0 cached markup without the attribute keeps exactly the old
button-only behavior. Both surfaces share the one swap engine, so every
safety property above (text nodes only, literal-string match, exclusion
list, write budget, restore-on-hidden, try/catch) applies to the main price
unchanged.

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
| **Recommended frequency** | "8 weeks" | Matched against selling plan names — any unit works ("8 weeks", "10 days", "1 month"); the matching plan is preselected. Set per product from real days-to-empty (the app's `ProductCadence` data), not an arbitrary monthly default — a cadence that matches actual usage prevents pantry-loading skips and cancels. |
| **Savings display** | Percent | Percent reads stronger below ~£50 price points ("Save 20%"); absolute reads stronger on premium AOV ("Save £18"). "Both" is honest but busy — test it on your highest-traffic PDP before rolling out. The savings are computed live from the selling-plan allocation vs the variant price, so they can never drift from checkout reality. |
| **Show reassurance** | on | "Skip, pause or cancel anytime." directly attacks commitment anxiety, the main psychological blocker to subscribing. Only show it if the portal genuinely offers all three — TRUE by default, but **false while a plan's Commitment window (`lockDays`, v1.13.0) is set**: skip, pause and cancel are then blocked for the first N days. Edit or disable this line (and the "Skip, pause or cancel anytime" benefit) for plans that use the lock. |
| **Accent color** | `#1d1d1b` | The subscription card's distinct border/fill/badge. The default is the brand near-black, the same value as `--cx-accent` in `assets/buy-box.css`, as the app embed's accent and as `DEFAULT_DESIGN_CONFIG.style.accent` — this setting is **always** written into the widget's inline style, so it beats the stylesheet and a stray sample colour here repaints the whole widget (including on the "Force preset: …" emergency override, which ignores the published `style` block). Match the brand's primary CTA family but keep contrast ≥ 3:1 against the page background. Deeper overrides via CSS custom properties (`--cx-accent`, `--cx-accent-soft`, `--cx-border`, `--cx-radius`, ... — see the header of `assets/buy-box.css`). |
| **Compact mode** | off | Tighter paddings for dense PDPs or drawer/quick-buy contexts. |

### Removing the frequency selector (`layout.showFrequency`, v1.2.0)

The Buy box designer can remove the delivery-frequency selector from the
widget **entirely, across all eight presets** (published as
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
