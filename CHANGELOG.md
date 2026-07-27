# Changelog

All notable changes to Cellexia Subscriptions. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) as contracted in [docs/UPDATE.md](docs/UPDATE.md).

## [1.2.3] — 2026-07-25

Namespace-collision release. **No database migration and no env change**;
billing, dunning and Klaviyo paths are untouched. It fixes one defect,
reproduced on the client's live store, that made the widget invisible there — a
namespace collision with another app already installed on the same product page
— and then applies the same scoping rule to the *other* place this app puts
markup and a `<script>` on a storefront page: the customer portal, which is
served through the app proxy and therefore renders inside the merchant's theme.
The portal change is presentation-layer only (three DOM lookups; no route,
session, or data behaviour moved).

### Fixed

- **The buy box never mounted on cellexialabs.com: another app owns the "cx"
  attribute namespace.** The client's product page already hosts an unrelated
  vendor which renders, inside `.pdp__info` (the buy column),
  `<div class="cx cx--self-contained" data-cx-embed>` — the same page also
  carries that vendor's `cx-i18n`, `cx-cart-config`, `cx-pdp-config` and
  `cx-embed-config` script ids and a `.sm-rc-widget`. Our app-embed wrapper
  carried an attribute of the same name and `buy-box-embed.js` looked its own
  wrapper up by that attribute alone, so the lookup returned **that vendor's
  element** — it appears earlier in the DOM than our body-end wrapper. Two
  consequences, both observed live: we wrote our "mounted" marker onto, and
  adopted, DOM we do not own; and the mount check then reported "already
  mounted" for ever, so our wrapper stayed at the end of `<body>`, `[hidden]`,
  0px tall. The buy box was simply not on the page.
- **"Your store isn't showing what this page says" could not fire for a
  near-miss launch flag.** The Liquid gate is a plain string equality —
  `if cx_launch_status == 'live'` — with no trim and no case folding, so only
  the exact value `live` renders the widget. `launchFlagDiverged()`
  (`app/lib/launch/launch.server.ts`), which decides whether **Preview &
  launch** shows the critical divergence banner, normalised the metafield with
  `.trim().toLowerCase()` first. A hand-edited `cellexia.launch_status` of
  `" Live "` or `"LIVE"` while the app was LIVE was therefore reported as
  in-sync, while every product page rendered the widget
  `hidden data-cellexia-gated="true"` — a dark store behind a green admin page,
  which is the one state that banner exists to surface. The comparison is now
  exact, matching the gate byte for byte; the near-miss values are pinned on
  both sides (`tests/liquid/render.test.ts` asserts Liquid renders them gated,
  `tests/launch-sync.test.ts` asserts the detector calls each a divergence)
  so the two halves cannot drift apart again. Re-syncing rewrites the flag to
  the canonical value, so the stricter check can only ever offer a fix.

### Changed

- **The widget's entire storefront attribute namespace is now
  `data-cellexia-*`** (was `data-cx-*`): `data-cellexia-embed`,
  `-buybox`, `-preset`, `-gated`, `-mounted`, `-anchor(-pos)`, `-tpl`,
  `-selling-plan`, `-plan-input`, `-design-prop`, `-money-onetime`/`-sub`,
  `-price-sync`/`-selector`, `-save`, `-init`, `-preview`, `-data` and every
  other hook, in both install shapes and in the Liquid, JS and CSS that read
  them. **CSS class names are unchanged** (`.cx-buybox*` does not collide with
  that vendor's `.cx` / `.cx--self-contained`), so no custom CSS a merchant
  wrote against the widget breaks.
- **Every document-level lookup of our own markup is qualified by our class as
  well as our attribute** (`.cx-buybox-embed[data-cellexia-embed]`,
  `.cx-buybox[data-cellexia-buybox]`) — defence in depth, so a future app that
  collides on an attribute name cannot repeat this. Lookups that are not
  document-level are rooted at our own wrapper or widget node. The one
  document-wide lookup that deliberately reads foreign markup (the theme's own
  current-variant field) is read-only and must name one of our variant ids to
  be used at all.
- **Ownership is asserted before anything is moved, marked or unhidden**
  (`classList.contains('cx-buybox-embed')` / `'cx-buybox'`); the code bails out
  silently otherwise. The theme add-to-cart price sync additionally excludes
  every Cellexia widget from its own target search, on top of the existing
  header / nav / footer / cart-drawer exclusions and the rule that a target
  must literally contain the theme's one-time money string before a character
  is touched.
- **The design-attribution cart line property is now `_cellexia_design`** (was
  `_cx_design`). The ORDERS_CREATE webhook reads **both** names, preferring the
  new one, so take-rate-by-design attribution keeps working for orders placed —
  and carts already open — before the merchant updated the theme extension.

- **The customer portal made the same unqualified lookups, on the merchant's
  own theme.** The portal is served through the app proxy, so its HTML and its
  inline `<script>` are injected into the theme — the same document as the
  theme's markup and every storefront app, that `cx` vendor included. The
  script queried `document.querySelector('.cx-toast')` and
  `document.querySelectorAll('.cx-portal form')`: class-only, qualified by no
  attribute, and the second one *writes* — it disables submit buttons on
  submit, so a foreign `.cx-portal` on the page would have had its forms
  disabled by us. It now makes exactly **one** document-level query,
  `.cx-portal[data-cellexia-portal]` (class and attribute), and roots every
  other lookup at that node; the toast carries `data-cellexia-toast` and the
  root `data-cellexia-portal`. Same failure mode as the buy box, a different
  directory — which is precisely why the extension-scoped guards missed it.

### Added

- `tests/liquid/lint.test.ts` §5e — the portal script under the same rule the
  extension lives under: every document-level query qualified by our class
  **and** our attribute, at most one of them, no `getElementById`/
  `getElementsBy*` reach into our markup, and the selector↔markup pairing
  asserted across files (the confirm forms are rendered by
  `app/routes/proxy.*.tsx`, so renaming one side would silently unbind the
  handler instead of raising). `commentSyntaxFor` learned `.ts`/`.tsx` so the
  scanners can read the portal module at all.
- `tests/embed-mount.test.ts` — the collision itself, reproduced: a foreign
  vendor element carrying our attribute name, earlier in the DOM, must be left
  untouched while our own wrapper mounts. Plus a vacuity guard that puts the
  bare attribute lookup back and asserts the widget is stranded at body end,
  exactly as it was on the live store.
- `tests/liquid/lint.test.ts` §5 — static guards: no `data-cx-*` and no
  `_cx_design` in any file the extension serves to a storefront (`assets/`,
  `blocks/`, `snippets/`, `locales/`, the extension TOML); source comments,
  which document the collision in prose, are blanked first, and the maintainer
  `README.md` — which Shopify never serves — is the single exemption, pinned by
  §5b so it cannot grow to cover a file that IS served. Plus: no bare
  `[data-cellexia-*]` document-level lookup, none through `closest()` or
  `matches()` either (an upward walk leaves our subtree just as a document
  query does), and every hoisted own-markup selector must be
  `.cx-*[data-cellexia-*]`.
- `tests/liquid/lint.test.ts` §5d — the guards' own blind spots, tested.
  Comments are blanked by a scanner rather than a regex: the regex version
  erased from the first `//` to end of line, so an ordinary CDN URL in a string
  hid every `data-cx-*` after it on that line, and it applied JS comment rules
  to `.json` and `.toml`, where `//` opens nothing. Call arguments are read
  with balanced parentheses, so a selector containing `:not(…)` can no longer
  slip past the rule that has to inspect it.
- **§5c now recognises every spelling of a document-wide query.** It matched a
  bare `document.` receiver only, so `document.body.querySelector(…)` — the
  outage's own shape, one property access away — together with
  `document.documentElement` and `document.head` walked straight past the rule
  that exists to forbid it. All four roots are matched now, in both the direct
  and the `(scope || document…)` form, and §5d pins that with an executable
  example per receiver so the rule cannot quietly go vacuous again.
- **§5c also covers `getElementById` / `getElementsBy*`.** These search the
  whole page from one bare string and cannot be class-qualified the way a
  selector can, so the rule for them is different in kind: they may not name
  our `cx-*` namespace at all — that namespace is shared with the other
  vendor's `cx-i18n` / `cx-cart-config` / `cx-pdp-config` / `cx-embed-config`
  ids — and our own markup must be reached through the `OWN_*` selectors. The
  one legitimate call (`'shopify-section-' + sectionId`, the platform's id,
  used to narrow a search) is pinned, so a new one fails until a human has
  looked at it.
- **§5c now checks every browser script the extension ships, not a hard-coded
  two.** The rules that forbid a bare `[data-cellexia-*]` lookup, an
  unqualified `OWN_*` selector, an `getElementById`/`getElementsBy*` reach into
  our namespace, and a literal own-markup selector handed to `safeQuery` all
  iterated a literal `["buy-box.js", "buy-box-embed.js"]`, while the
  namespace scanners beside them walk `assets/` from disk. A third storefront
  script would have been scanned for `data-cx-*` and skipped by every rule
  that actually prevents the element adoption. The list is read from `assets/`
  now, with a non-vacuity assertion that it still finds the two known scripts.
  The "must hoist an `OWN_*` selector" rule is keyed on whether the script
  makes a document-level query at all, so a query-free helper is not failed
  for having no selectors to hoist.
- **Liquid §1–§2 now treat the legacy `{% include %}` as a render.** Both rules
  were stated absolutely — "never capture a render", "no render in
  `snippets/`" — but keyed on the word `render`, leaving the identical defect
  reachable by the older spelling, which is the worse of the two: `include`
  does not isolate scope, so the snippet could read and clobber the caller's
  variables. Both spellings are covered, in both tag forms, and the blocks'
  single render is additionally pinned to `render`.
- Liquid rules §1–§2 now read tags through a scanner that understands **both**
  forms Shopify accepts — `{% render 'x' %}` and the bare line form inside a
  `{% liquid %}` block. A captured render written in the line form was
  invisible to every `{%\s*render` pattern, i.e. the one rule that exists to
  forbid the v1.2.0 storefront bug could be walked around by writing it
  differently. The block's single render must also be in markup position, not
  inside a `{% liquid %}` block.
- `tests/liquid/render.test.ts` — `data-cellexia-money-sub` must be **empty**
  for a variant with no allocation in the group, in every preset, with a
  vacuity guard for the subscribing case. `buy-box.js` swaps the theme's
  add-to-cart price to that attribute verbatim, so a non-empty value there
  would put a price on the theme's button that the shopper can never be
  charged. The contract was documented in the snippet; it is now executable.
- `tests/widget-design.test.ts` — ORDERS_CREATE still attributes the legacy
  `_cx_design` property, in both REST property shapes, and prefers the current
  name when a line carries both.
- `tests/liquid/harness.ts` — the Liquid ⇄ JS DOM-contract extractor now also
  reads the JS's hoisted selector constants, so those cannot drift away from
  the markup unnoticed.

### Migration notes

- **`npm run deploy` is required** — `extensions/cellexia-buy-box` changed. No
  database migration, no env change, no re-approved scopes.
- **Nothing to reconfigure.** The rename is internal to the extension: block
  settings, the published `cellexia.buybox_design` metafield, the launch gate
  and the preview-token flow are all unchanged, and a shop with no published
  design still renders pixel-identically.
- Any custom CSS written against the widget keeps working: only attributes were
  renamed, never class names. Custom CSS that targets `[data-cx-…]` attributes
  (nothing we ever documented) must be updated to `[data-cellexia-…]`.
- Design attribution is continuous across the upgrade — the webhook accepts the
  old property name as well.

## [1.2.2] — 2026-07-25

> Historical note: the widget's storefront attributes are written here under
> their **current** `data-cellexia-*` names. They shipped in this release as
> `data-cx-*` and were renamed in 1.2.3, when that prefix turned out to
> collide with another app on the client's store. Nothing else about this
> entry changed.

Theme-extension release. **Buy box only**: no database migration, no env
change, nothing in the portal, billing, dunning or Klaviyo paths moved. The
v1.2.0 Liquid rendering defects (app-snippet corruption, double-escaping) are
fixed and locked down by a real Liquid render harness, together with the
remaining rendering defects the golden renders did not cover — plus one new
storefront feature: the theme's own Add to cart button now quotes the price
the shopper actually selected.

### Fixed

- **`--cx-accent-soft` was declared twice in the widget root's inline style.**
  The accent at 7% alpha went into a fixed slot and `style.bgTint` was appended
  after it, so every shop with a published design shipped both declarations in
  one `style` attribute (`DEFAULT_DESIGN_CONFIG.style.bgTint` is `#F4F4F4`, so
  publishing *anything* triggered it). Last-declaration-wins made it render
  correctly, but the subscription card's fill depended on a theme, CDN or
  minifier preserving the order and both copies of an inline declaration. The
  soft fill now resolves to one value before it is printed — `style.bgTint`
  when the merchant set one, otherwise the accent at 7% alpha, the same rule
  the admin designer's live preview uses.
- **The soft fill was not escaped.** `color_modify` returns its input unchanged
  when the value is not a colour, so a hand-edited `cellexia.buybox_design`
  metafield could break out of the `style` attribute through
  `--cx-accent-soft`, even though `--cx-accent` right next to it was escaped.
  Both slots are escaped now. (The zod schema still rejects such a value on
  publish; this is the belt the file's own comment promised for a metafield
  edited by hand.)
- **An allocation stating no `per_delivery_price` produced a made-up price.**
  Where the price is printed unconditionally (the tiles compare row, the
  planner row) the widget rendered the money filter's rendering of nil next to
  real prices; the "X per delivery" line claimed a per-delivery price the
  platform never gave. The rows now fall back to the charge price — the same
  fallback `buy-box.js` applies on every later variant/plan change — and the
  line renders only for a stated per-delivery price that differs from the
  charge, i.e. genuinely prepaid plans. A free product (`per_delivery_price`
  0) is unaffected: 0 is a real value, not a missing one.
- **A variant with no allocation in the selling-plan group showed a
  subscription until the JS ran.** For a product only partly added to the
  group, the first paint offered a subscription card priced at the one-time
  price for a variant that cannot subscribe; `buy-box.js` corrected it on
  init. The root now carries `cx-buybox--no-sub` from the server — the class
  the stylesheet already hides every subscription-only fragment with, and the
  one the JS toggles — so the first paint is honest.

### Added

- **Theme add-to-cart price sync.** Observed live on cellexialabs.com: with
  the subscription option preselected (CHF 51.20 first order) the theme's own
  button still read "ADD TO CART - CHF 64.00" — the shopper saw one price in
  the widget and another on the button they were about to click, on the last
  click before the cart. The widget root now carries `data-cellexia-money-onetime`
  and `data-cellexia-money-sub` (the current variant's one-time price and the
  selected plan's first-order price, formatted by Liquid with the shop's own
  `money_format`), and `buy-box.js` swaps the one-time money **string** for
  the subscription one inside the theme button's **text nodes** while
  subscription is selected. It is a string swap, not a price re-render, and
  that is what makes it safe: never `innerHTML`; **nothing happens at all** if
  the button does not literally contain the one-time string (no currency
  regex, no guessing); targets are only looked for inside the widget's own
  product area, with header / nav / footer / cart-drawer regions excluded;
  every change is recorded and restored the moment one-time is selected or the
  widget is hidden, launch-gated or unmounted; a `MutationObserver` re-applies
  when the theme rewrites the label (Sleepify does, on every variant change)
  while our own writes happen with the observers disconnected; a write budget
  switches the module off and gives the button back if a theme fights it; and
  every entry point is wrapped in try/catch — it never touches the form, the
  submit path or the cart payload, so it can never block an add-to-cart. Later
  variant/frequency changes re-sync from the JSON island's existing `oneTime`
  / `first` values, so the JS still never formats money. Works identically in
  a validated storefront preview.
- **Buy box designer → Theme integration** — the new `themeSync` config
  object: "Match the theme's Add to cart price to the selected option"
  (`syncAddToCartPrice`, default **on**, including for shops with no published
  design) plus an optional CSS selector (`priceSelector`, e.g.
  `.pdp__actions .btn--atc`) for themes the built-in list does not cover.
  Field-level defaults, so every stored revision and the live
  `cellexia.buybox_design` metafield keep validating unchanged; the selector is
  sanitized with the same rule as `placement.selector`. Documented in
  [docs/OPERATIONS.md](docs/OPERATIONS.md) §17 and the extension README.
- `tests/theme-price-sync.test.ts` — the price-sync behaviour, driving the real
  `assets/buy-box.js` through a small DOM shim: the swap, the revert on
  one-time/hidden, "no price in the button → byte-identical", the header and
  cart-drawer exclusions, following a theme that rewrites the label (and
  reverting to its *newest* text), and the runaway guard.
- `tests/liquid/theme-sync.test.ts` — the Liquid half: both money strings on
  the root across all six presets and both install shapes, differing exactly
  when there is a discount, empty for a variant with no allocation, agreeing
  with the JSON island, surviving entity-bearing and quote-bearing
  `money_format`s, and a v1.1.0-shaped config (no `themeSync` key) still
  rendering the sync on.
- `tests/liquid/render.test.ts` — the widget root's inline style attribute
  (every custom property declared exactly once, across all six presets and
  four config shapes; the soft-fill resolution rule; both slots escaped
  against a hand-edited metafield; the designer preview kept in step),
  allocations that state no per-delivery price, and variants with no
  allocation in the group.
- `tests/liquid/harness.ts` — fixture options `omitPerDeliveryPrice` and
  `selectedVariantHasNoAllocations` for those catalog shapes.

### Migration notes

- **`npm run deploy` is required** — `extensions/cellexia-buy-box` changed.
  No database migration, no env change, no re-approved scopes.
- Shops with a published design get the `bgTint` they configured, which is the
  colour they already saw.
- The widget's own rendering is unchanged for zero-config shops; the only
  addition to their markup is the four inert `data-cellexia-money-*` /
  `data-cellexia-price-*` attributes on the root (the golden snapshot was updated
  for exactly those four).
- **The add-to-cart price sync is ON by default, including for shops that
  never published a design.** It changes the theme's button *text* only, only
  while the subscription option is selected, and only when that button already
  shows the one-time price — nothing else about the page, the form or the cart
  moves. To ship without it: Buy box designer → Theme integration → untick
  "Match the theme's Add to cart price to the selected option" → Publish.

## [1.2.1] — 2026-07-25

Build/deploy hotfix. **No runtime behavior change**: no schema migration, no
env change, no theme-extension change, nothing about the widget, the portal or
the billing paths moved. v1.2.0 could not be built or containerized; this
release fixes exactly that.

### Fixed

- **`npm run build` failed on Node 23.x** with
  `[vite:css-post] css content for "" was not found`. `app/routes/app.tsx`
  loaded the Polaris stylesheet as `…/styles.css?url`; Vite encodes a `?url`
  CSS id into a `__VITE_CSS_URL__<hex>__` marker and hex-decodes it back
  during `renderChunk`, and on Node 23.2.x `Buffer.from(s, "hex")` returns an
  **empty** buffer when `s` is a two-byte (non-Latin1) string — which the
  admin chunk is, because it contains non-ASCII characters. The stylesheet is
  now a plain side-effect import of the same file, which Remix's Vite plugin
  lists in the route manifest and
  `<Links />` renders: the same single `<link>` on `/app/*`, no `?url` code
  path. Node 20/22 LTS were never affected; the fix removes the dependency on
  the Node version either way.
- **The Docker image could not build.** `Dockerfile` ran `npm ci --omit=dev`
  and then `npm run build`, but the build chain (`@remix-run/dev`, which
  provides the `remix` binary, plus `vite` and `vite-tsconfig-paths`) lives in
  `devDependencies` — the build step died with `sh: remix: not found`. The
  install is now `npm ci --include=dev` (mandatory: `ENV NODE_ENV=production`
  makes npm omit dev packages by default) and the build-only packages are
  pruned again with `npm prune --omit=dev` after the build, so the shipped
  image keeps the same runtime footprint. The inherited
  `RUN npm remove @shopify/cli` line is gone: this project never depended on
  `@shopify/cli`, and under `NODE_ENV=production` that no-op re-reified the
  tree with `--omit=dev` and silently deleted the build chain again.
- **Added the missing `.dockerignore`.** The Dockerfile's `COPY . .` runs after
  `npm ci`, so on any machine where the app had been installed locally the
  host's `node_modules` was copied over the image's — and native binaries are
  platform-specific, so `npx prisma generate` and `npm run build` then failed
  inside the linux image with `invalid ELF header` / a missing
  `@esbuild/linux-*` package. The build context is now source-only, which also
  keeps `.env` and the local `build/` out of the image layers.
- **Removed the vestigial `workspaces: ["extensions/*"]`** from
  `package.json`. `extensions/cellexia-buy-box` is a theme app extension with
  no npm manifest, so the glob matched a directory npm cannot treat as a
  workspace. npm 10 tolerates it (and did here), but nothing depended on it.

### Added

- `tests/deploy-config.test.ts` — static guards for the deploy path the test
  suite could not see: no `?url`/`?inline`/`?raw` CSS imports under `app/`,
  the Dockerfile installs the devDependency build chain before
  `npm run build`, nothing re-reifies the dependency tree between install and
  build, `prisma generate` precedes the build, `.dockerignore` keeps
  `node_modules`/`build`/`.env` out of the build context, and the runtime
  packages stay in `dependencies` so the post-build prune cannot break
  `npm run start`.

### Migration notes

- **No database migration, no env change, no `npm run deploy` needed** — the
  theme extension is byte-identical to v1.2.0.
- Re-deploy the app (Fly/Railway/Render rebuild the image from the new
  `Dockerfile`). If you build outside Docker, run `npm ci` once so the
  refreshed `package-lock.json` is in effect.

## [1.2.0] — 2026-07-24

### Added

- **App-embed install path for the buy box**: the widget now also ships as a
  theme **app embed** (`blocks/buy-box-embed.liquid`, target `body`) enabled
  with a single toggle — Theme editor → **Theme settings** → **App embeds** →
  **"Cellexia Buy Box"** → Save. Built for themes whose product section does
  not accept app blocks (the reason: cellexialabs.com's custom "Sleepify"
  theme), it renders the identical widget (`snippets/cx-buybox-core.liquid`
  is shared with the app block) and mounts itself into the product page
  automatically. If the section app block is also present on a page, the
  block wins and the embed stays dormant — never two widgets. The launch
  gate is unchanged: even with the embed enabled, visitors see nothing until
  go-live, and the `?cx_preview` token flow reveals it exactly as before.
- **Automatic placement with custom-selector override**
  (`assets/buy-box-embed.js`): the embed inserts the widget above the theme's
  quantity/add-to-cart area via prioritized anchor heuristics (tuned first
  for cellexialabs.com — before `.pdp__grey` — with generic OS 2.0 and
  `/cart/add`-form fallbacks). Override precedence: the embed's theme-editor
  **Custom anchor selector** setting > the designer's new **Placement**
  section (`placement` in the design config: CSS selector +
  before/after/prepend/append) > automatic. In a preview session, an
  unmatched anchor shows an admin-only hint card instead of failing silently.
- **Cart-request selling-plan injection for formless AJAX themes**: on pages
  where the embed runs, `fetch`/`XMLHttpRequest` POSTs to `/cart/add(.js)`
  get the selected `selling_plan` (and the `_cellexia_design` attribution property)
  injected into any body shape — FormData, URLSearchParams, urlencoded
  string, JSON `items[]`, flat JSON. Only lines matching the widget's own
  product variants are touched; one-time selections, other vendors' cart
  calls and unknown body shapes pass through byte-identical.
- **Brand-matched defaults**: the designer's starting style tokens
  (`DEFAULT_DESIGN_CONFIG`) are now matched to cellexialabs.com — near-black
  `#1D1D1B` accents, `#F4F4F4` panel tint, white on accent, sharp 0px
  corners — so publishing an untouched design already looks native there.
  (The zero-config fallback is unchanged: with no published metafield the
  widget still renders the v1.0.0 look.)
- **Frequency-selector toggle** (`layout.showFrequency`, designer → Layout):
  turning it off removes the delivery-frequency selector from **all six
  presets** (the planner degrades to a single recommended-cadence line);
  add-to-carts then use each plan's default frequency, and subscribers can
  still change frequency any time in the portal.

### Migration notes

- **No database schema migration** — v1.2.0 ships no new Prisma migration.
- **No breaking changes**: existing design revisions and the published
  metafield JSON parse unchanged (the new `placement` and
  `layout.showFrequency` fields carry field-level defaults). The section app
  block keeps working exactly as installed.
- The theme extension changed (new embed block + `buy-box-embed.js`) — run
  `npm run deploy`. To use the embed path, enable it once in the theme
  editor (Theme settings → App embeds → "Cellexia Buy Box" → Save); this is
  safe on the live theme at any time (Setup mode keeps the widget hidden).

## [1.1.0] — 2026-07-23

### Added

- **Buy box design studio**: new admin **Buy box designer** page for the PDP
  widget. Six design presets — `classic` (the v1.0.0 layout), `toggle`
  (segmented tabs), `tiles` (side-by-side comparison), `inline` (one-line
  checkbox upgrade), `value_stack` (benefit-list panel), `planner`
  (frequency-first chips) — each a distinct CRO archetype, with deep
  customization of the selected preset: layout (option ordering, density,
  radius/border, frequency dropdown vs chips, show/hide toggles), style
  (colors, font scale, sanitized widget-scoped custom CSS) and **per-locale
  text overrides** with `{percent}`/`{amount}`/`{frequency}` templates
  (resolution: current locale → `en` → the extension locale files). Changes
  are previewable before publishing; publishing mirrors the config to the
  shop metafield `cellexia.buybox_design`, which the theme block reads
  null-safely — changing or reverting a design never touches the theme.
- **Revision history with restore**: every save is an append-only
  `WidgetDesignRevision`; restore copies an old revision into a new one and
  publishes it, so every design change is reversible in one click. Publishes
  and restores are logged as `admin.action` audit events.
- **Design attribution analytics**: subscription add-to-carts are stamped
  with a hidden `_cellexia_design` line property (underscore-prefixed — hidden from
  customers in themes and checkout); the ORDERS_CREATE webhook logs
  `widget.design_attributed` events (payload `{designKey, orderId}`) and the
  designer's performance card reports subscription orders and take-rate
  share per design. New canonical event type: `widget.design_attributed`.
- Theme-editor emergency override: new `design_source` block setting
  (default **App design**) can force a preset from the theme editor if the
  app is unreachable.

### Migration notes

- **No breaking changes; with no design published the widget renders
  identically to v1.0.0.** The zero-config fallback, all existing block
  settings and the selling-plan wiring are unchanged.
- Additive migration `0002` (new `WidgetDesignRevision` table):
  `npx prisma migrate deploy`.
- The theme extension changed (new snippets/assets and the `design_source`
  block setting) — run `npm run deploy`. Existing block placement keeps
  working as-is; no theme-editor action is required.

## [1.0.0] — 2026-07-23

Initial release.

### Added

- **Launch safety & preview**: the app installs **dark** — Setup mode until the
  admin explicitly goes live. While in Setup: customer-facing jobs skip
  themselves (logged `skipped: setup_mode`), customer notifications are
  suppressed at source (only OTP codes, operator alerts and import summaries
  send), no Klaviyo events are enqueued, the public portal is closed behind a
  friendly page, and the buy box renders hidden via the
  `cellexia.launch_status` shop metafield. Admin **Preview & launch** page:
  signed storefront preview links (`?cx_preview`, 7-day TTL) reveal the buy
  box on the live theme only in the admin's own browser — PDP, cart and
  checkout previewable with zero visitor impact; portal preview sessions
  render the full customer portal (real subscriber or local-only demo
  subscription) with every mutating action intercepted. **Go live** flips the
  setting + metafield, logs the flip, and offers to stagger overdue renewals
  over 3 days so launch never triggers a burst of charges; revert-to-setup is
  the emergency kill switch.
- **Selling plans**: plan-group config + sync (first-order/ongoing discounts via
  pricing policies, optional first-order gift, prepaid modelling), per-product
  cadence intelligence (real empty dates), theme app extension buy box
  (preselect, badge, savings formats).
- **Billing**: timezone-safe renewal scheduler with `JobLock` leases, crash-proof
  idempotent billing attempts, prepaid handling, stale-attempt sweep; internal
  60s tick or external-cron mode (`POST /api/jobs/run`).
- **Dunning**: decline taxonomy (SOFT/HARD/AUTH_REQUIRED), payday-aligned retry
  ladder, backup payment fallback, 3DS challenge magic links, card pre-expiry
  notices, recovery/exhaustion handling (default exhausted action: pause).
- **Customer portal** on the store domain (app proxy): OTP login, skip/unskip,
  delay, frequency change, swap, quantity, add/remove lines, one-time add-ons,
  pause/resume with auto-resume, address & card updates, contextual prompts.
- **Magic links**: signed, hashed-at-rest, single-use action tokens (skip,
  delay, add-to-next, update card, resume, pause, swap, 3DS confirm, login).
- **Cancel-save flow**: reason survey, reason-matched saves, capped final offer
  with cooldown, full `CancelSession` recording, 90-day retention tracking;
  FTC click-to-cancel compliant (≤3 steps).
- **Gifts & lifecycle**: gift rules by order index / days subscribed / save flow
  / win-back; surprise cycle-2 gift, announced milestone (cycle 6), rewards
  unlock (day 90), anniversary (day 365); gift COGS in profit math.
- **Win-back**: staged touches (soft → perk → capped discount → sunset) timed to
  predicted empty date.
- **Klaviyo**: outbox-backed event delivery with retries, profile sync, event
  mapping; SMTP fallback + notification log.
- **Analytics**: daily rollups, cohort survival + cumulative LTGP, churn risk
  scores, predicted empty dates, take rate, dunning recovery.
- **Admin (Polaris)**: dashboard, analytics, subscribers + timelines, dunning,
  alerts, audit, bulk ops (stockout actions, price change batches with notice),
  plans, gifts, cancel-flow config, settings registry, import.
- **Webhooks**: full topic coverage with `X-Shopify-Webhook-Id` dedupe and
  failure visibility; GDPR topics handled.
- **Import**: CSV importer (`subscriptionContractAtomicCreate`) with dry-run,
  batch tracking and re-run safety; sample file + platform mappings
  ([docs/MIGRATION.md](docs/MIGRATION.md)).
- **Ops**: `/api/health`, alerting with operator emails, i18n framework
  (English master catalog), Dockerfile, complete documentation set.

### Migration notes

- Fresh install only — see [docs/INSTALL.md](docs/INSTALL.md). Subscriber
  migration from Recharge/Skio/Appstle/Bold: [docs/MIGRATION.md](docs/MIGRATION.md).
