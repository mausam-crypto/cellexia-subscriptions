# Theme integration — Cellexia Treatment Widgets

How to install and QA the theme app extension (`extensions/treatment-widgets`)
in the existing Sleepless Media theme (jQuery + CartJS stack), next to or
replacing the theme's `snippets/sm-rc-widget.liquid` plumbing.

## What ships

| Block | Widgets | Target template |
| --- | --- | --- |
| **Treatment choice** (`blocks/treatment-choice.liquid`) | A (choice cards) + B (quantity → cadence) + E (basic-purchase comparison) | Product |
| **Cart: make it continuous** (`blocks/cart-conversion.liquid`) | F (one-click line conversion) | Cart |

Both blocks are app blocks (`"target": "section"`): the merchant adds them in
the theme editor via **Add block → Apps**. Assets (`cellexia-widgets.css/js`)
are injected once per page by Shopify regardless of how many blocks are used.

## Installing on the product page

1. `shopify app deploy` from the app root, then open the theme editor on the
   product template (Online Store → Customize → Products → Default product).
2. In the section that renders the PDP info column (`sections/pdp.liquid`),
   choose **Add block → Apps → Treatment choice**. Drag it to sit where the
   commented-out `pdp__recharge` markup used to live — directly above the
   `pdp__actions` row.
3. Because the block ships its own quantity pills (Widget B) and add-to-cart
   button, hide the theme's duplicates for a clean layout:
   - the `action--qty` quantity stepper (`#quantity-select-pdp` and its
     +/- buttons), and
   - the theme's `[sm-rc-add-to-cart]` button.
   Do this per-template via the theme editor (custom CSS or removing the
   elements from `pdp.liquid`), not by deleting the sm-rc hooks globally —
   other templates may still rely on them.
4. Configure the block settings: widget toggles (A/B/E), heading/savings copy,
   cadence defaults per quantity (1→4, 2→8, 3→12 weeks), brand color
   overrides. Runtime copy/cadence overrides from the admin (Widgets screen)
   arrive through `/apps/cellexia/api/widget-config` and win over block
   settings without a theme redeploy.

### How the sm-rc attribute hooks coexist

The widget deliberately does **not** claim any `sm-rc-*` hook, so the theme
snippet keeps working wherever it is still rendered:

- **Variant selection** — if `[sm-rc-variant-selector]` exists on the page,
  the widget hides its own variant `<select>` and listens to the theme
  selector's `change` events instead (the theme's option selectors →
  `sm-rc-variant-selector` sync keeps working untouched). Without the theme
  selector, the widget renders its own select (only when the product has more
  than one variant).
- **Plan selection** — the widget never touches `[sm-rc-plan-selector]`.
  If you keep both UIs visible you will have two independent plan pickers;
  hide one (recommended: keep the widget, hide the sm-rc test selectors,
  which the snippet renders unstyled anyway).
- **Add to cart** — the widget's button posts `/cart/add.js` directly with
  `{items: [{id, quantity, selling_plan?}]}` (equivalent to the theme's
  `CartJS.addItem`). It does not bind `[sm-rc-add-to-cart]`.
- **Price display** — the widget maintains its own `data-cxw-*` price spans
  and never writes to `sm-rc-current-price` etc.

## Installing on the cart page

1. Theme editor → Cart template → **Add block → Apps → Cart: make it
   continuous**, placed between the line-item list and the cart footer.
2. Each eligible line (product has selling plans, line has none) renders one
   subtle `#F4F4F4` band row, capped by the block's **Maximum rows** setting.
3. Conversion posts `/cart/change.js` with `{line, quantity, selling_plan}` —
   quantity and variant are preserved — then refreshes (see below). On the
   `/cart` page the widget reloads the page after converting so Liquid
   re-renders line prices and totals.

The mini-cart drawer is built client-side by `refreshMiniCart()` in
`assets/_sleepify.authored.bundle.js`, so app blocks cannot render inside it.
Widget F therefore covers the cart page; if you want conversion rows inside
the drawer, port the `.cxw-convrow` markup into the drawer template as a
theme customization and the extension JS will pick it up (it binds any
`[data-cxw-cart]` root at DOM-ready).

## Cart refresh integration

After every successful cart mutation the widget:

1. Dispatches `document → CustomEvent('cart:refresh', {bubbles: true})` for
   any listener (future theme versions, other apps).
2. If the theme drawer exists (`.mini-cart` in the DOM) **and**
   `window.refreshMiniCart` is defined, fetches `/cart.js` and calls
   `refreshMiniCart(cart)` — the exact flow the theme's own
   `successState()` uses, so the drawer opens with the new line.
3. If no drawer exists on the page, falls back to redirecting to `/cart`.

## B2B behaviour (mirrors sm-rc-widget)

The theme layout sets `window.isB2BCustomer = {{ customer.b2b? | json }}` and
`sm-rc-widget.liquid` skips the selling plan on add-to-cart for B2B. The
widgets mirror this exactly:

- Widget A–E: the add-to-cart payload **omits `selling_plan`** whenever
  `window.isB2BCustomer === true`, even with Continuous Treatment selected.
- Widget F: hidden for B2B customers (Liquid `{% unless customer.b2b? %}`
  plus a JS guard for cached pages).

## Data flow

- First paint is 100% Liquid: selling plans, prices, and savings percentages
  come from `product.selling_plan_groups` (first group, matching the theme's
  own assumption) — no API call needed.
- Enhancement config: `GET /apps/cellexia/api/widget-config?product_id=…&visitor=…`
  (app proxy). Response `{widgetType, settings, experimentKey, cadenceDefaults}`
  overrides cadence defaults and copy. Any failure (offline, app down) leaves
  the Liquid defaults in charge — the widget never blocks on the network.
- Telemetry: `POST /apps/cellexia/api/events` (sendBeacon when available)
  with events `impression`, `select_treatment`, `select_basic`, `nudge_shown`,
  `nudge_converted`, `add_to_cart`, `cart_convert`.

## QA checklist

Product page (Widgets A/B/E):

- [ ] Continuous Treatment card is pre-selected, 2px ink border, blue
      "RECOMMENDED" ribbon; Basic Purchase is smaller and muted (`#BABABA`).
- [ ] Savings bullet shows the highest percentage from the product's selling
      plan group; fallback copy appears for non-percentage plans.
- [ ] Quantity pills 1/2/3 update the cadence line automatically
      (1→4, 2→8, 3→12 weeks by default) — no frequency dropdown visible
      until the "Prefer a different rhythm?" toggle is opened.
- [ ] Admin cadence overrides (widget-config `cadenceDefaults`) win over
      block settings after the async fetch; with the app proxy unreachable
      the block-setting defaults still work.
- [ ] Variant change via the theme's option/variant selectors updates all
      widget prices (listen path: `[sm-rc-variant-selector]` change).
      On a theme without sm-rc hooks the widget's own variant select shows.
- [ ] Unavailable variant disables the button and shows "Sold out".
- [ ] `product.requires_selling_plan == true`: Basic Purchase card absent,
      nudge never renders, add-to-cart always carries a selling plan
      (except B2B — see below).
- [ ] Selecting Basic Purchase reveals the inline comparison **once per
      session** (sessionStorage `cxw_nudge_<productId>`), inline and
      dismissible — never a popup, add-to-cart stays clickable above it.
- [ ] "Switch to Continuous Treatment" flips the selection, hides the nudge
      and focuses the treatment card.
- [ ] Add to cart (treatment): line lands in cart with the selling plan,
      quantity matches the pill; drawer opens via `refreshMiniCart`.
- [ ] Add to cart (basic): no selling plan on the line.
- [ ] B2B (`window.isB2BCustomer === true`): line is added **without** a
      selling plan even in treatment mode.
- [ ] Keyboard: arrows/space/enter operate both radiogroups; focus rings
      visible; cadence changes announced (`aria-live="polite"`).
- [ ] `prefers-reduced-motion`: no transitions.

Cart page (Widget F):

- [ ] Rows appear only for lines with selling-plan-eligible products and no
      plan applied; capped at the max-rows setting.
- [ ] Convert preserves quantity and variant, applies the highest-percentage
      plan, fires `cart_convert`, reloads `/cart` with updated prices.
- [ ] No rows for B2B customers.
- [ ] Subscription lines (plan already applied) never show a row.

Regression:

- [ ] Theme pages without the blocks: no console errors, no CSS bleed
      (all selectors are `.cxw-*` namespaced).
- [ ] The sm-rc widget still works where rendered (no double-binding of its
      hooks by our JS).

## Committed Treatment card (third choice)

The Treatment choice block can render a third card — **COMMITTED TREATMENT**
— offering the best per-delivery price in exchange for a minimum number of
deliveries. It is OFF by default (`enable_committed`).

### Setup

1. **Create committed selling plans** in the app's `/app/plans` screen: add
   plan entries with `minDeliveries` and `committed: true` alongside the
   standard cadences, at a **higher** `percentOff` than the standard plans
   (e.g. standard 15% → committed 20%). Push the config so the plans exist
   in the product's selling plan group.
2. **Name the committed plans so the block can find them.** Liquid cannot
   read `minCycles`, so committed plans are identified by a case-insensitive
   name substring — the block setting **Committed plan name match** (default
   `commit`). Naming plans "Committed — every 4/8/12 weeks" works with the
   default.
3. In the theme editor, tick **Show the Committed Treatment card** on the
   Treatment choice block. If no selling plan name matches, the card simply
   does not render.
4. **Card position** semantics:
   - `1` — committed is the **first** card AND the pre-selected default
     (the Continuous Treatment card starts unselected).
   - `2` (default) — second card, between Continuous Treatment and Basic
     Purchase.
   - `3` — third card, after Basic Purchase.
   Continuous Treatment always stays before Basic Purchase.
5. **Committed discount %** in the block is a display fallback only — the
   rendered price always comes from the committed plan's allocation for the
   selected variant. **Minimum deliveries** and the two terms texts (short
   line inside the card + full text in the "?" tooltip) should match the
   selling plan's real commitment.
6. Admin runtime overrides (Widgets screen → `settings.committed`, shape
   from `DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE.committed`) win over block
   settings: `enabled: false` force-hides the card even when the block
   enables it; `planIds` replaces the name-matched plan pool; `termsShort`
   / `termsFull` replace the terms copy (`{n}` = minDeliveries, `{p}` =
   percentOff).

### How it behaves

- The committed plan pool is kept separate from the standard pool: quantity
  pills pick the closest cadence **within the active card's pool**, and the
  standard default plan never resolves to a committed plan.
- Selecting the committed card reveals the short terms line inside the card;
  add-to-cart attaches the committed selling plan.
- Telemetry adds `select_committed` next to `select_treatment` /
  `select_basic`.
- The Widget E comparison (shown when Basic Purchase is selected) compares
  against the **best available** plan price when the committed card is on.

### QA checklist additions

- [ ] Committed card renders only when `enable_committed` is on AND at least
      one selling plan name matches **Committed plan name match**.
- [ ] Position `1`: committed card first and pre-selected (`aria-checked`,
      2px ink border), first-paint add-to-cart price = committed price;
      positions `2`/`3` slot it after treatment / after basic.
- [ ] Committed price/compare-at hydrate per variant from plan allocations;
      qty pills switch between "Committed — every 4/8/12 weeks".
- [ ] **Per-unit committed price is never worse than the standard plan
      price** — merchants must configure the committed % HIGHER than the
      standard %. If a committed cadence prices above the matching standard
      cadence, fix the selling plan config.
- [ ] Terms line (`Commit to at least…`) is hidden until the committed card
      is selected, and hides again on deselection.
- [ ] Tooltip a11y: "?" button has an aria-label + `aria-describedby`
      pointing at the `role="tooltip"` element and `aria-expanded` state;
      opens on hover AND keyboard focus; closes on blur, mouseleave, Escape
      and outside tap; click toggles on touch; focus is never trapped;
      tapping "?" does not select the card.
- [ ] Widget E nudge (Basic selected) uses the committed price when it is
      the cheapest available plan.
- [ ] Admin override `settings.committed.enabled = false` hides the card
      even with the block toggle on (after the widget-config fetch).
- [ ] `select_committed` telemetry fires on selection; `add_to_cart` carries
      the committed `selling_plan` id.
- [ ] B2B customers never see the committed card (same rule as the other
      plan surfaces).

## Subscription Max style (widget A)

An alternative presentation for the Treatment choice block: the Continuous
Treatment plan as THE purchase path — one confident, full-width,
pre-selected card, no Basic Purchase card, no comparison framing, and no
added perks or pressure copy. The one-time purchase stays genuinely
available as a single quiet text link below the add-to-cart button. Purely
visual — pricing and selling plans are identical to the default `choice`
style (see `docs/OFFERS.md` → Subscription Max for intent and rollout
guidance).

### Setup

1. **Default style** on the Treatment choice block: `choice` (default),
   `max` or `ultra` — the fallback for all markets (for `ultra` see the
   Subscription Max Ultra section below).
2. **Per-market styles**: the block's **market_styles** text setting, e.g.
   `fr:max, de:choice`. Keys are matched case-insensitively against
   `localization.market.handle`; unlisted markets use the default style.
   This is the zero-latency path — Liquid resolves the style at first
   paint, no API call.
3. **Admin runtime override** (Widgets screen): a widget A config with
   targeting `{"markets": ["FR"]}` and settings `{"style": "max"}` wins over
   the Liquid-resolved style after the widget-config fetch (the JS restyles
   the root). With the app proxy unreachable, the Liquid style stays in
   charge.
4. **A/B before flipping a market**: attach an experiment with
   `{"style": "choice"}` vs `{"style": "max"}` variant overrides to a
   market-targeted config and compare telemetry before changing
   `market_styles` for everyone.
5. If the Committed Treatment card is enabled for the product, keep it off
   in markets running Subscription Max — the style is a single-plan
   presentation.

### How it behaves

- One full-width Continuous Treatment card, pre-selected; no Basic Purchase
  card and no comparison box.
- One-time link below the add-to-cart button: "Prefer a single delivery?
  Buy once for {one-time price}" — small, muted, underlined text with the
  honest one-time price, never a card.
- Clicking it switches to basic mode: the add-to-cart price updates to the
  one-time price and the link becomes "Buying once at {price} — switch back
  to Continuous Treatment", which returns to the plan.
- The Widget E comparison nudge is disabled by default in this style.
- `product.requires_selling_plan == true`: the link never renders.

### QA checklist additions

- [ ] Max style renders ONE full-width Continuous Treatment card,
      pre-selected — no Basic Purchase card, no comparison box, no extra
      perk/discount copy beyond the standard plan bullets.
- [ ] One-time link is visible below the add-to-cart button, small muted
      underlined text showing the honest one-time price — never styled as a
      card or button.
- [ ] Link is keyboard-reachable: tab order reaches it after the
      add-to-cart button, focus ring visible, Enter activates it.
- [ ] Clicking the link switches to basic mode and the add-to-cart price
      updates to the one-time price; the link flips to "Buying once at
      {price} — switch back to Continuous Treatment"; activating it again
      restores the plan and the plan price.
- [ ] Add to cart in buy-once mode carries no selling plan; in plan mode it
      carries the selling plan (B2B rules unchanged).
- [ ] Widget E comparison nudge never renders in max style (default),
      including after switching to buy-once.
- [ ] `product.requires_selling_plan == true`: the one-time link never
      renders and add-to-cart always carries a selling plan.
- [ ] Telemetry events carry the active style so `choice` vs `max` can be
      compared per market / experiment.
- [ ] `market_styles` (e.g. `fr:max`): the FR market renders max at first
      paint — no restyle flash; market handle matching is
      case-insensitive.
- [ ] Admin override `settings.style` (Widgets screen) restyles the widget
      after the widget-config fetch and wins over the Liquid style; with
      the proxy unreachable the Liquid style is kept.
- [ ] Prices identical between the two styles for the same product and
      plan — the style is purely presentational.

## Subscription Max Ultra style (widget A)

The third presentation: in `ultra` the subscription is not presented as a
concept at all. No card, no heading, no plan name, no bullets, no ribbon —
and **no savings framing** (no strikethrough compare price, no "Save X%").
The page reads like a completely normal purchase: the plan price simply IS
the price. What renders: an optional plain price line, the quantity pills,
the cadence and per-month lines, the advanced rhythm details, add-to-cart,
and the quiet one-time link with neutral copy. The Widget E nudge and the
Committed Treatment card NEVER render in ultra. Pricing and selling plans
are identical to the other styles (see `docs/OFFERS.md` → Subscription Max
Ultra for the full intent).

### Setup

1. **Style**: set the block's **Default style** to `ultra`, or per market
   via **market_styles** (pairs accept ultra, e.g. `fr:ultra, de:choice`) —
   zero-latency Liquid path. The admin runtime override (Widgets screen,
   settings `{"style": "ultra"}`) works exactly like max: it applies only
   when explicitly set and wins after the widget-config fetch.
2. **Quantity label**: set the block's **quantity_label** free-text setting
   to `Units` (default "Units per delivery") so the pills carry no delivery
   framing.
3. **Line toggles**: **show_price_line** (the plain plan unit price line,
   default on), **show_cadence_line** and **show_permonth_line** (default
   on). The cadence/per-month toggles are honored in ALL styles.
4. **Link copy**: the one-time link uses neutral default copy — "Prefer a
   single delivery? Buy once for {price}" / back-state "Buying once at
   {price} — switch back" — overridable via the block settings
   **ultra_link_copy** / **ultra_link_back_copy**. Any override must stay
   neutral: never name the plan ("Continuous Treatment", "subscription",
   "treatment"), never obscure the honest one-time price.
5. **Theme price element**: check the theme's own PDP price display against
   the ultra price story. The theme typically renders the one-time price;
   on an ultra product the page says the plan price IS the price, so a
   theme price element showing the higher one-time figure contradicts the
   widget (and a lower one next to the ATC price looks like an error).
   Merchants should either make the theme price reflect the plan price or
   hide the theme price element on ultra products — per-template, the same
   way the theme quantity stepper and `[sm-rc-add-to-cart]` button are
   hidden (see "Installing on the product page").
6. **Committed card**: `enable_committed` has no effect in ultra — the card
   never renders (cards are choice-framing). Leave the toggle configured
   for markets on other styles if you mix styles per market.
7. **A/B before flipping a market**: attach an experiment with
   `{"style": "max"}` vs `{"style": "ultra"}` (or `choice` vs `ultra`)
   variant overrides to a market-targeted config and compare telemetry
   before changing `market_styles` for everyone.

### QA checklist additions

- [ ] NO card, box, heading, ribbon or bullets render; the words
      "Continuous Treatment", "subscription" and "treatment" appear nowhere
      in the widget output.
- [ ] NO savings framing anywhere: no strikethrough compare-at price, no
      "Save X%", no comparison or "designed for…" copy — in the price line,
      the ATC button, or the one-time link.
- [ ] Price line (when `show_price_line` is on): plain plan unit price,
      no compare price — and it **matches the add-to-cart unit price**
      (ATC shows unit price × quantity; qty 1 must show the identical
      figure). It updates on variant and plan changes.
- [ ] Quantity pills render with the `quantity_label` text ("Units");
      cadence and per-month lines show/hide per `show_cadence_line` /
      `show_permonth_line` — verify the toggles also work in `choice` and
      `max` (they are honored in all styles).
- [ ] The advanced "Prefer a different rhythm?" details work as in the
      other styles.
- [ ] One-time link: neutral copy that never names the plan (default
      "Prefer a single delivery? Buy once for {price}"), honest (higher)
      one-time price shown; clicking switches to buy-once (ATC price
      updates, no selling plan on add), link flips to "Buying once at
      {price} — switch back", activating again restores the plan and its
      price.
- [ ] Keyboard path to the one-time link: Tab reaches it directly after
      the add-to-cart button, focus ring visible, Enter and Space both
      toggle it — with no card radiogroup in ultra this link is the only
      switch, so the keyboard path is mandatory.
- [ ] Widget E nudge NEVER renders in ultra — even with the Widget E
      toggle on, even with `enable_nudge_in_max` on, and even after
      switching to buy-once.
- [ ] Committed card NEVER renders in ultra, even with `enable_committed`
      on and matching plans present.
- [ ] Theme's own PDP price element: hidden on ultra products or showing
      the plan price — never a contradicting one-time figure next to the
      widget.
- [ ] `product.requires_selling_plan == true`: the one-time link never
      renders; add-to-cart always carries a selling plan.
- [ ] Telemetry events carry style `ultra`; prices identical to `choice` /
      `max` for the same product and plan — purely presentational.

## Coexisting with another subscription app (Joy, Recharge, Seal, …)

A product's `selling_plan_groups` in Liquid contains **every** app's groups,
in no guaranteed order. The Cellexia blocks therefore never take the first
group blindly: they pick the group whose `app_id` contains the block setting
**"Selling plan group app ID"** (default `cellexia`, matched
case-insensitively). `pushSellingPlanConfig` stamps `appId: "cellexia"` on
every group it creates or updates, so the widget always renders Cellexia's
plans even when another app's group sits on the same product.

**Symptom this prevents**: the widget shows another app's discount (e.g.
Joy's 5%) and ignores every change made to the Cellexia plan — because it was
rendering the other app's group entirely.

**Migration checklist when another subscription app is installed:**

1. Update the app and **re-save each plan configuration** in Cellexia admin →
   Treatment plans (this pushes the `appId` marker onto existing groups).
2. Preview a product page: the widget must show the Cellexia percentages;
   changing the Cellexia plan config must now change the widget.
3. If the widget shows "no plans" instead: the product isn't assigned to a
   Cellexia plan group yet (assign it in Treatment plans), or the group
   predates the marker and the fallback picked it — re-save the config again
   and confirm `selling_plan_group.app_id` via
   `{{ product.selling_plan_groups | map: 'app_id' | join: ', ' }}` in a
   test snippet.
4. Before going live, **detach your products from the other app's selling
   plan groups** (in that app's admin) and remove/disable its widget or app
   embed in the theme. Even with Cellexia's widget filtering correctly, the
   other app's plans remain purchasable through its own surfaces (its widget,
   quick-buy, Buy Buttons) as long as its groups stay on the product — two
   parallel subscription systems on one product confuses customers and splits
   contracts across two apps.
5. Existing contracts created by the other app stay with that app — plan a
   migration (its export + `subscriptionContractAtomicCreate`, or let them
   run off) before uninstalling it.

The fallback: when NO group matches the app-id filter, the block falls back
to the first group (so stores without the marker keep working). If you ever
rename the marker, change it in both `CELLEXIA_PLAN_GROUP_APP_ID`
(`app/services/core/sellingPlans.server.ts`) and the two blocks' settings.
