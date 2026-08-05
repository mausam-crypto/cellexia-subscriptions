# Offers module — widgets, experiments, pre-shipment engine

Owner: `[offers]`. Services live in `app/services/offers/*`, storefront APIs in
`app/routes/proxy.api.*`, admin UIs in `app/routes/app.plans.tsx` and
`app/routes/app.widgets.tsx`.

## Widget matrix

| Widget | `WidgetType` | Surface | Purpose |
| --- | --- | --- | --- |
| A | `TREATMENT_CHOICE` | PDP (theme extension) | Continuous Treatment vs Basic Purchase choice. Continuous is recommended and visually dominant; Basic stays visible but secondary. Three presentation styles: `choice` (default), `max` and `ultra` — see the Subscription Max and Subscription Max Ultra sections below. |
| B | `QUANTITY_CADENCE` | PDP (theme extension) | Quantity + delivery cadence selection with smart defaults ("we recommend a delivery every N weeks"). |
| D | `ROUTINE_BUILDER` | **Customer portal** (not the theme extension) | Add complementary steps to an existing treatment plan — one delivery, one box. Config/defaults live here; rendering is owned by `[portal]`. |
| E | `POST_ONE_TIME` | Post-purchase / follow-up surfaces | Nudge after a Basic Purchase to continue as a Continuous Treatment Plan. |
| F | `CART_CONVERSION` | Cart (theme extension) | Convert one-time lines to a treatment plan (`POST /cart/change.js` with `selling_plan`, client-side only). |

All customer-facing copy uses the Continuous Treatment voice (see
`docs/BRAND.md`): "treatment plan", "delivery", "routine" — never raw
subscription jargon — and always the reassurance **"Adjust, delay or cancel
online."** The full brand-default copy per widget is
`DEFAULT_WIDGET_SETTINGS` in `app/services/offers/widgets.server.ts`;
`{percent}` / `{weeks}` placeholders are substituted client-side from the
product's selling plan data.

## Widget resolution (`resolveWidget`)

1. Load active `WidgetConfig` rows for the shop, ordered by `priority`
   (highest first).
2. Match each row's `targetingJson` against the request context; keep the
   **first match per widget type**; the overall highest-priority winner is
   returned (an optional `widgetType` filter narrows to one type, e.g. per
   theme block).
3. Merge the winner's `settingsJson` over `DEFAULT_WIDGET_SETTINGS` (deep
   merge; arrays and scalars are replaced).
4. If the winner references a `RUNNING` experiment and the request carries a
   subject key, assign a variant (see below) and merge the variant's settings
   on top.
5. Attach `cadenceDefaults` from the product's `SellingPlanConfig`
   `quantityDefaultsJson`.

With no matching config the brand-default `TREATMENT_CHOICE` widget is
returned, so the storefront always renders coherent copy.

### Targeting fields (`WidgetConfig.targetingJson`)

```json
{
  "productIds": ["gid://shopify/Product/123"],
  "markets": ["DE", "FR"],
  "trafficSources": ["email", "paid-social"],
  "returningOnly": true,
  "intentBands": ["high"]
}
```

- Empty / missing fields mean **no restriction**.
- A restriction on a dimension the request did not provide does **not** match
  (safe default).
- Product ids match across GID and bare-numeric formats.
- `returning` derives only from the HMAC-verified `logged_in_customer_id`.

### Cadence defaults (`SellingPlanConfig.quantityDefaultsJson`)

```json
{
  "default": { "1": 4, "2": 8, "3": 12 },
  "byProduct": { "gid://shopify/Product/123": { "1": 6 } }
}
```

`cadenceDefaultForQuantity(config, productId, qty)` resolves: per-product
override → default map → nearest lower quantity → smallest configured
quantity → first plan's `intervalWeeks` → 4 weeks. The legacy flat shape
(`{"1": 4}`) is still accepted.

Product → config linkage note: the product/config assignment lives in Shopify
(SellingPlanGroup membership, managed by core's `assignProductsToConfig`).
Locally, `resolveWidget` prefers a config whose `byProduct` overrides mention
the product, else the most recently updated active config.

## Experiment mechanics

- `Experiment.variantsJson`: `[{"key": "control", "weight": 50, "settingsJson": "{…}"}, …]`.
- Assignment is **deterministic**: FNV-1a hash of the subject key mapped onto
  the cumulative weight range, then persisted as an `ExperimentAssignment`
  (unique per experiment + subject). Re-requests always return the stored
  variant; races resolve to the same variant because bucketing is pure.
- Subject key: the verified `logged_in_customer_id` when present, else the
  anonymous `visitor` token generated and stored by the storefront script.
  No subject key → no assignment (defaults are served, nothing persisted).
- Only `RUNNING` experiments affect visitors. Transitions: `DRAFT → RUNNING`
  (sets `startedAt`) → `COMPLETED` (sets `endedAt`). Variants are editable
  only while `DRAFT`, so assignments stay valid.
- The resolved widget carries `experimentKey = "<experimentId>:<variantKey>"`;
  the storefront echoes `variantKey` back in telemetry events.

## Storefront APIs (app proxy, HMAC-verified)

All under `/apps/cellexia/api/*` → `app/routes/proxy.api.*`. Identity only
ever comes from the verified `logged_in_customer_id` parameter.

- `GET /widget-config?product_id=&market=&src=&qty=&widget=&visitor=` →
  `{ widgetType, settings, cadenceDefaults, experimentKey?, suggestedIntervalWeeks? }`,
  `Cache-Control: public, max-age=60`.
- `POST /events` with `{ event, widgetType?, productId?, variantKey? }` →
  writes an `AnalyticsEvent` named `WIDGET_<EVENT>` (uppercased, sanitised).
  These telemetry names are deliberately distinct from `LIFECYCLE_EVENTS`
  and never go through the Klaviyo outbox.
- `POST /add-on` with
  `{ contract_id, variant_id, product_id, title, price_cents, mode, deliveries? }`
  → verifies the signed-in customer owns the contract, creates an `AddOnItem`
  (mode from `ADD_ON_MODES`; `deliveries` required for `N_DELIVERIES`),
  idempotent per contract/variant/mode/day, appends a `CUSTOMER` audit entry
  and emits `PRODUCT_ADDED`.

## Pre-shipment engine (`runPreShipmentJob`, jobs registry `pre-shipment`)

Finds `ACTIVE` contracts billing in **3–7 days** and, per contract:

1. Emits `PRE_SHIPMENT_WINDOW_OPEN` (deduped per billing cycle:
   `pre-shipment:<contractId>:<billingDate>`) with ranked add-on candidates,
   the expected next order value, and the gift-threshold data. **Klaviyo
   composes and sends the message** — this module never messages directly.
2. Detects **repeated one-time add-ons**: >= 3 `NEXT_ONLY` `AddOnItem` rows of
   the same product (and not already a contract line) → emits
   `REPEATED_ONE_TIME_ADD_ON` so Klaviyo can prompt the permanent upgrade.
3. **Gift threshold**: when `ShopSettings.settingsJson.giftThresholdCents` is
   set and the expected order value is within 30% below it, the payload
   includes `amountToGiftCents` (the exact gap) so the message can say "add
   X to receive your gift".

### Ranking factors (`rankAddOnCandidates`, pure)

Weighted mix (weights in `RANKING_WEIGHTS`, sum = 1):

| Factor | Weight | Source |
| --- | --- | --- |
| `routineFit` | 0.22 | `PAIRS_WITH` compatibility edges to the current routine (strength-weighted) |
| `marginPercent` | 0.14 | `ProductMeta.grossMarginPercent` |
| `repeatPurchaseProbability` | 0.14 | analytics input (0..1) |
| `estimatedRetentionLift` | 0.14 | analytics input (0..1) |
| `previousPurchases` | 0.12 | customer's past lines + add-ons |
| `concernMatch` | 0.10 | candidate concern ∈ routine's concerns |
| `inventoryAvailable` | 0.08 | 1 if known in stock, 0.5 if unknown |
| `seasonalRelevance` | 0.06 | seasonal input (0..1) |

Hard exclusions: already in the routine; `inventoryAvailable === false`;
any `REDUNDANT` or `SENSITIVITY_CONFLICT` edge to a current product (either
direction). Output is the top N (default 3) with a normalised factor
breakdown and customer-safe `reasons` strings in brand voice.

## Admin pages

- **`/app/plans`** — versioned `SellingPlanConfig` editor (plan rows,
  quantity→cadence defaults for qty 1/2/3, product GID assignment) with
  version history. Saving pushes via core's `pushSellingPlanConfig` (which
  bumps the version and snapshots); a banner reminds staff that **editing
  plans never changes existing subscribers** — contracts are independent of
  their selling plan after purchase.
- **`/app/widgets`** — `WidgetConfig` CRUD (settings prefilled from
  `DEFAULT_WIDGET_SETTINGS`), experiment CRUD with status transitions, and an
  assignment/telemetry summary aggregated from `ExperimentAssignment` and
  `WIDGET_*` `AnalyticsEvent` rows.

## Committed Treatment Plan

A third widget-A card: the customer's best price in exchange for a minimum
number of deliveries. OFF by default everywhere.

### Settings shape (widget A, `DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE.committed`)

```json
{
  "enabled": false,
  "position": 2,
  "percentOff": 20,
  "minDeliveries": 3,
  "termsShort": "Commit to at least {n} deliveries and get {p}% off",
  "termsFull": "The Committed Treatment Plan gives you our best price in exchange for a minimum of {n} deliveries. …"
}
```

- `{n}` / `{p}` placeholders are substituted client-side from
  `minDeliveries` / `percentOff`.
- **Position semantics:** `1` renders the committed card as the **first card
  and pre-selected default**; `2` = second card; `3` = third card.
- When `enabled`, `resolveWidget` attaches
  `settings.committed.planIds: string[]` — the `shopifyPlanId` values of the
  committed entries in the product's `SellingPlanConfig` (same
  config-resolution logic as `cadenceDefaults`). This is how the storefront
  JS identifies committed selling plans, because **Liquid exposes neither
  `minCycles` nor our `committed` flag**.

### Plan entries (`SellingPlanConfig.plansJson`)

Committed plans carry two optional fields alongside
`name`/`intervalWeeks`/`percentOff`/`shopifyPlanId`:

```json
{ "name": "Committed every 4 weeks", "intervalWeeks": 4, "percentOff": 20,
  "minDeliveries": 3, "committed": true }
```

An entry counts as committed when `committed === true` **or**
`minDeliveries >= 2`. `/app/plans` edits both fields per plan row and shows a
"Committed · min {n}" badge in the configuration list.

### minCycles push (Shopify enforcement)

`pushSellingPlanConfig` includes `minCycles: minDeliveries` in the recurring
`billingPolicy` (create **and** update paths) whenever `minDeliveries >= 2`,
so Shopify enforces the commitment at the contract level. Editing plans still
never changes existing subscribers — each cohort keeps the `minCycles` it
signed up under (snapshotted per version).

### Discount monotonicity, two tracks

`discountMonotonicityWarning` (pure, `app/services/offers/planWarnings.ts`,
re-exported by `app/routes/app.plans.tsx`) now checks the **committed track
and the standard track separately**: committed plans legitimately discount
more than standard plans at the same interval, so only a decreasing discount
*within* a track is a misconfiguration.

### Retention gates & CS visibility

Cancel (and pause, once underway) gates for committed contracts apply **only
to customer-facing surfaces** (portal) via
`app/services/retention/policy.server.ts`; the CS console and dunning/system
cancels are never gated. The subscriber console shows a
"Committed · {delivered}/{min} deliveries" badge, resolved by matching the
contract lines' selling-plan ids against committed `plansJson` entries.

### Legal disclosure

A minimum-delivery commitment is a term of sale: **confirm the commitment
terms ({n} deliveries, unlock rules) are disclosed at checkout in every
market where the committed plan is enabled** — the widget's
`termsShort`/`termsFull` copy on the PDP alone may not satisfy local
consumer law. The same applies to the minimum pause/cancel window setting
(`ShopSettings.settingsJson.minPauseCancelWindow`, OFF by default; first
treatment plan only; CS can always override).

## Subscription Max widget style (widget A)

`DEFAULT_WIDGET_SETTINGS.TREATMENT_CHOICE.style` selects how widget A
presents the offer. The value is the string `"choice" | "max" | "ultra"`;
the default is `"choice"` (for `"ultra"` see the Subscription Max Ultra
section below). The key is intentionally **absent from the defaults** and
applies only when a config explicitly sets it — otherwise the theme-resolved
style stays in charge.

### Intent

In the `max` style the Continuous Treatment plan is presented as **the**
purchase path: one confident, full-width card, pre-selected. Less is more —
the style works by removing decision fatigue, not by adding persuasion.

### What it changes visually

- **No Basic Purchase card** and **no comparison framing** — the choice
  architecture disappears, leaving a single plan card.
- The one-time purchase stays **genuinely available**, demoted to a single
  quiet text link below the add-to-cart button: *"Prefer a single delivery?
  Buy once for {one-time price}"* — small, muted, underlined text, never a
  card, always showing the honest one-time price. Clicking it switches the
  widget to basic mode (the add-to-cart price updates) and the link becomes
  *"Buying once at {price} — switch back to Continuous Treatment"*, which
  returns to the plan.
- The **Widget E comparison nudge is disabled by default in this style** — a
  comparison box would reintroduce exactly the doubt the style removes.

### What it deliberately does NOT do

- No extra perks, gifts or discounts attached to the style.
- No added copy pressure (no urgency lines, no loss framing, no countdowns —
  see `docs/BRAND.md`).
- No pricing or plan changes whatsoever: the same selling plans at the same
  prices as `choice`. The style is purely presentational.
- No hiding of the one-time option: **it stays reachable at its honest
  price**. This is required marketplace / consumer-law hygiene — the link
  must never be removed, priced misleadingly, or styled into invisibility.
  (When `product.requires_selling_plan` is true the link does not render —
  there is no one-time option to offer.)

### Enabling per market (two ways)

1. **Theme editor — zero-latency path (recommended):** the Treatment choice
   block's **Default style** setting (`choice`/`max`, applies to all
   markets) plus the **market_styles** text setting, e.g. `fr:max,
   de:choice`. Keys are matched case-insensitively against
   `localization.market.handle`; unlisted markets use the default style.
   Liquid resolves this at first paint — no API round-trip.
2. **Admin runtime override (Widgets screen):** a widget A `WidgetConfig`
   with targeting `{"markets": ["FR"]}` and settings `{"style": "max"}`.
   `resolveWidget` merges `settings.style` like any other setting (the
   generic deep merge — no whitelist), and the storefront JS applies it by
   restyling the root after the widget-config fetch. This wins over the
   Liquid-resolved style; if the app proxy is unreachable the Liquid style
   stays in charge.

### Recommended rollout: A/B first

Before switching a whole market, run the style through the experiment
system: attach an experiment to a market-targeted widget A config with
variants overriding `{"style": "choice"}` vs `{"style": "max"}`, let it run,
and compare `select_basic` / `add_to_cart` telemetry (events carry the
active style) before flipping `market_styles` in the theme editor for
everyone.

## Subscription Max Ultra widget style (widget A)

`style: "ultra"` — the third widget A presentation, one step beyond `max`.

### Intent

In `ultra` the subscription is **not presented as a concept at all**. Where
`max` still shows one confident plan card, `ultra` removes the card too: the
page reads like a completely normal purchase, and the plan price simply
**is** the price. There is exactly **one logical option, zero
choice-framing, and zero savings claims** — with nothing to compare against,
there is nothing to claim. Use it where the pricing story is flat (the plan
price is the only price the market ever sees) and any "you are subscribing
and saving" framing would only add friction.

### What renders (the complete list)

- An **optional minimal price line**: the plan unit price, plain — no
  compare-at, no strikethrough, no badge (block setting `show_price_line`,
  default true).
- The **quantity pills**, labelled from the new free-text block setting
  `quantity_label` (default "Units per delivery" — set it to **"Units"** for
  ultra so the label carries no delivery framing).
- The **cadence line** and the **per-month line**, each individually
  toggleable via the new block settings `show_cadence_line` /
  `show_permonth_line` (default true; the toggles are honored in **all**
  styles, not just ultra).
- The advanced **"Prefer a different rhythm?"** details, unchanged.
- The **add-to-cart button** with its price, unchanged.
- The same **quiet one-time link** below add-to-cart as in `max`, with
  neutral copy (see below).

### What NEVER renders in ultra

- **No card or box, no heading, no ribbon, no bullets** — the choice
  architecture is gone entirely.
- **No plan name**: "Continuous Treatment", "subscription" and "treatment"
  appear nowhere in the widget.
- **No savings framing of any kind**: no strikethrough compare price, no
  "Save X%", no "designed for continued improvement" copy. The flat price
  story leaves nothing to claim.
- **The Widget E comparison nudge never renders** — unlike `max`, there is
  no opt-in (`enable_nudge_in_max` does not apply to ultra).
- **The committed card never renders** — cards are choice-framing, and ultra
  has none. Keep `enable_committed` semantics for the other styles; ultra
  ignores it.

### The honest one-time link (required)

The one-time purchase stays **genuinely selectable at its honest (higher)
price** — the same consumer-law hygiene rule as `max`: never remove the
link, never price it misleadingly, never style it into invisibility. What
changes in ultra is the copy, which must stay **neutral and never name the
plan** (naming it would reintroduce the subscription concept):

- Default: *"Prefer a single delivery? Buy once for {price}"*
- Back-state: *"Buying once at {price} — switch back"*

Both come from new locale keys and are overridable via the block settings
`ultra_link_copy` / `ultra_link_back_copy`. There is no dark-pattern hiding
here — the one-time option keeps a real, reachable control; it just gets no
competing presentation. (When `product.requires_selling_plan` is true the
link does not render — there is no one-time option to offer.)

### Enabling per market (both paths, same as max)

1. **Theme editor — zero-latency path (recommended):** the block's
   `default_style` select now offers `choice`/`max`/`ultra`, and
   `market_styles` pairs accept `ultra` (e.g. `fr:ultra, de:choice`). Liquid
   resolves it at first paint.
2. **Admin runtime override (Widgets screen):** a widget A config with
   settings `{"style": "ultra"}` (typically market-targeted). Per the
   explicit-only rule, `settings.style` overrides the Liquid style **only
   when a config explicitly sets it** — defaults never carry a style.

### Recommended rollout: A/B first

Ultra is the strongest of the three presentations — A/B it before flipping a
market: attach an experiment with `{"style": "max"}` vs `{"style": "ultra"}`
(or `choice` vs `ultra`) variant overrides to a market-targeted config,
compare `select_basic` / `add_to_cart` telemetry (events carry the active
style), then flip `market_styles` in the theme editor for everyone.
