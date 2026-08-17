# Data foundation — origin-order revenue & acquisition capture

v1.5.0 (migration `0006_origin_order_revenue_acquisition`). Two goals:

1. **Close the renewals-only revenue gap.** The first (checkout) payment never
   becomes a `BillingAttempt`, so before 0006 every cohort/LTGP/rollup revenue
   figure structurally excluded it. The origin payment is now mirrored onto
   the contract and included in analytics.
2. **Collect as much acquisition/behavior data as possible, safely.** Source,
   UTMs, geo, device class and first-order shape are captured at the moment
   they exist (the origin order's webhook) into additive columns, so future
   features (source-level LTGP, geo cohorts, device take-rate) have history
   from day one instead of starting cold.

**The additive rule (non-negotiable):** new ingest always lands in NEW
additive columns or inside `acqRaw` — an existing field is never repurposed,
renamed or re-typed. That is what makes this a foundation: every consumer
written later can trust that a column has always meant the same thing.

---

## Part 1 — Origin-order money mirror (`SubscriptionContract`)

| Field | Type | Source | Meaning |
|---|---|---|---|
| `originOrderTotalCents` | `Int?` | `getOrderSummary(originOrderId).totalCents` | The origin payment as charged (order current total at capture — for the normal same-day capture, exactly what was paid). Never rewritten after capture. `null` = not captured yet. |
| `originOrderDiscountCents` | `Int?` | `…discountsCents` | Order-level discount total — money-true (no per-line estimation), reported alongside revenue like renewal `discountCents`. |
| `originOrderShippingChargedCents` | `Int?` | `…shippingCents` | What the CUSTOMER paid for delivery on the first order. Revenue context (it is inside the total), never a cost. |
| `originOrderRefundedCents` | `Int` (default 0) | `REFUNDS_CREATE` webhook | Σ refunds recorded against the origin order (matched by `contract.originOrderId` when no `BillingAttempt` claims the order). Netted in analytics; the total above is never rewritten. |
| `originOrderProcessedAt` | `DateTime?` | order `processedAt` (fallback `createdAt`) | The payment instant — the day/month analytics book the origin payment on. |
| `originOrderCurrencyCode` | `String?` | order currency (fallback contract currency) | Currency guard input: a non-shop-currency origin total is excluded from shop-currency aggregates, never summed at 1:1. |

### Capture paths (all idempotent — only fill while `originOrderTotalCents` is null)

1. **At mirror time**: `syncContractFromShopify` (create webhook / any sync)
   fetches the order summary once for owned (`OURS`) contracts and persists
   the fields. A failed fetch leaves them null.
2. **Daily backfill**: job `origin_order_backfill` — OURS, non-demo contracts
   with an `originOrderId` and a null total, oldest first, capped at 200 per
   run (`ORIGIN_BACKFILL_CAP`), per-contract failures contained and retried
   next run. Covers pre-0006 rows, failed fetches and contracts classified
   OURS after creation. Ungated in SETUP (read-only analytics capture).

### Analytics semantics

- **Cohorts** (`runCohortComputation`): origin payment (total − refunded,
  clamped) booked in the month it processed — normally month 0. Fees via the
  shared cost model on the origin total; one shipment cost
  (× deliveries-per-charge when prepaid); **COGS approximated from the
  contract's CURRENT lines via `resolveLineCogs`** (origin lines ≈ current
  lines — the same lines-as-they-exist-now approximation billed cycles already
  accept; swaps between checkout and capture blur it slightly).
- **Rollups** (`runDailyRollup`): origin payments enter `chargedCents` (and
  discount/COGS/shipping/fees) on their processed day. The normal path
  captures on the create webhook — same day, inside the trailing recompute
  window. A LATE capture (backfill) whose processed day already left the
  recompute/backfill window stays out of that closed rollup row — closed days
  keep their snapshots — while the cohort triangle (full recompute from
  source) always includes it. LTGP truth lives in cohorts; rollups are the
  day-by-day operational ledger.
- **Double-count guard**: an origin order that ALSO has a successful
  `BillingAttempt` (should not exist, but nothing structurally prevents it)
  counts ONCE — the attempt wins. `originPaymentCountsOnce`
  (`app/lib/analytics/queries.server.ts`) is the single pure predicate both
  surfaces share; refunds apply the same precedence (attempt match first,
  origin match only otherwise).
- **`lifetimeRevenueCents` keeps its renewals-only meaning** ("revenue billed
  by this app", net of renewal refunds). The origin payment is deliberately
  not added to it; cohort/LTGP/rollup aggregates read the origin columns
  directly. Anything presenting `lifetimeRevenueCents` (subscriber cockpit)
  shows billed-by-us revenue.
- **Pre-capture refunds**: a refund issued before the money was captured is
  partially reflected in the captured current total (item refunds reduce it),
  which is the honest money-kept figure; money-only refunds predating capture
  are the one case revenue can read slightly high — accepted and documented.
- **Post-capture order edits (accepted error)**: a captured amount — origin
  or renewal (`BillingAttempt.amountCents`) — is never rewritten, and the app
  does not subscribe `orders/edited`. DOWNWARD money movement after capture
  flows through `REFUNDS_CREATE` (tracked in the refunded counters), and an
  order cancellation is recorded capture-only by `orders/cancelled`
  (`billing.order_cancelled` — no money mutation, refunds settle the money);
  an UPWARD edit (merchant adds an item / raises the total after our
  capture) is invisible — revenue reads low by the added amount for exactly
  that order. Accepted: upward-edited subscription orders are vanishingly
  rare, the immutability rule is what protects every refund-netting
  invariant above, and an `orders/edited` leg would need its own event
  vocabulary and replay guards for a case with no observed volume. Revisit
  only with evidence (an `orders/edited` subscription capturing the delta
  additively would be the shape).

---

## Part 2 — Acquisition capture (`SubscriptionContract.acq*`)

Captured for subscribable orders from the `ORDERS_CREATE` payload — a line
carries a selling-plan marker OR a line's product is listed in an active
`SellingPlanConfig.productIds` (the same `containsSubscribable` test the
take-rate denominator uses, because REST order payloads do not always include
the marker) — enriched with the Shopify customer record at contract creation.
The webhooks race in either order, so the sanitized bundle is stashed as an
`acquisition.captured` event (keyed by `payload.orderId`) and whichever side
finds both halves persists it — idempotently, while `acqRaw` is still null.
A stash for a subscribable one-time order is inert: the pickup only applies a
bundle whose `orderId` matches the contract's `originOrderId`.

Both online triggers can fire while the contract is not yet billable (e.g.
mirrored `UNKNOWN`, reclassified `OURS` later), so the daily
`origin_order_backfill` job re-runs the pickup for OURS, non-demo contracts
with an `originOrderId` and `acqRaw` still null. That retry queue is
drainable by construction: a contract still stash-less past the 48-hour
webhook-race/redelivery horizon (`ACQ_PICKUP_GRACE_MS`) can never be filled
by the pickup — its `ORDERS_CREATE` predates the stash feature (pre-0006) or
its stash payload was redacted — and is stamped `acqPickupExhaustedAt`
(migration 0010, additive) and excluded from future scans, so unfillable rows
cannot monopolize the capped oldest-first window. Transient pickup errors are
never stamped (retried next run), and the `ORDERS_CREATE` direct-persist path
ignores the stamp, so a genuinely late order webhook still lands its bundle.

| Field | Type | Source | Sanitization / meaning |
|---|---|---|---|
| `acqReferringSite` | `String?` | order `referring_site` | URL sanitizer (below). Where the buyer came from. |
| `acqLandingSite` | `String?` | order `landing_site` | URL sanitizer. First page hit on the store. |
| `acqSourceName` | `String?` | order `source_name` | Truncated 64. Shopify channel ("web", "shopify_draft_order", app ids…). |
| `acqUtm` | `Json?` | utm params of landing (fallback referring) URL | `{source, medium, campaign, term, content}`, each PII-scrubbed + truncated; null when no UTM at all. Extracted BEFORE the URL sanitizer strips params, so no signal is lost. The scrub preserves campaign VALUES (kebab/snake slugs, date-stamped names, pure-digit ad-platform ids) — see the token rules below; the capped-only originals ride in `acqRaw.rawUtm` so the edge can always be recomputed. |
| `acqCountryCode` | `String?` | shipping (fallback billing) address | Uppercased, ≤8 chars. |
| `acqCity` | `String?` | shipping (fallback billing) address | Truncated 64. |
| `acqProvinceCode` | `String?` | shipping (fallback billing) address | Uppercased, ≤16 chars. |
| `acqDeviceType` | `String?` | `client_details.user_agent` | Reduced to `"mobile" \| "desktop" \| "tablet"` (else null). **The full UA string is never stored.** |
| `acqTimeToPurchaseSeconds` | `Int?` | customer `createdAt` → origin order `processedAt` | Browse-to-buy latency, clamped ≥ 0. Needs the Shopify customer read; null when unavailable. |
| `acqUnitsFirstOrder` | `Int?` | Σ line-item quantities | First-order basket size. |
| `acqOrderValueBand` | `String?` | order total | Decile-friendly label (`"0_25"` … `"200_plus"`, major units, edges in `ORDER_VALUE_BAND_EDGES`). A presentation convenience — the raw total is kept in `acqRaw.orderTotalCents`, so bands can be recomputed with different edges without losing data. |
| `acqRaw` | `Json?` | whole sanitized bundle | Everything above plus `orderId`, `orderTotalCents`, `orderCurrencyCode`, `orderProcessedAt`, `customerCreatedAt`, `customerNumberOfOrders` (and `importedFrom`/`importPassthrough`/`importSubscribedSince` for CSV imports). **Future-mining surface**: new ingest may add keys here without a migration. Additive keys so far: `rawUtm` — the five utm values length-capped ONLY, no scrub (the recompute reserve: scrub-heuristic changes can rebuild `acqUtm` instead of losing the dimension; it may hold what a scrub would catch, and lives inside `acqRaw` precisely so CUSTOMERS_REDACT clears it) — `paidChannel` (v1.16.0: the ad channel indicated by a click-id param — gclid/fbclid/ttclid/msclkid/… — on the RAW landing/referring URL, detected BEFORE the sanitizer strips those params; presence-only, the id values are never stored; feeds the traffic-source segment ladder) — `referrerInternal` (v1.16.0: whether the referrer is the shop ITSELF, judged at capture against the myshopify domain, the order-status-URL host and the landing host; true = internal navigation, false = proven external, null = no referrer; the ladder's self-referral guard) — and the order-payload extras `discountCodes` (capped code list), `checkoutLocale` (since v1.16.0 the language segment prefers it over the normalized contract locale), `presentmentCurrencyCode`, `presentmentTotalCents`, `appId`, `sourceIdentifier` (scrubbed), `buyerAcceptsMarketing`, `orderTags` (capped list); each is null when its ingest cannot supply it. |

### Sanitization rules (pure module: `app/lib/acquisition/sanitize.ts`)

Enforced in one exported, unit-testable place so no caller can forget them:

- **Never the raw IP** (`client_details.browser_ip` is not even read),
  **never the full user-agent string** (reduced to the device class, then
  discarded).
- **URLs**: keep host (absolute URLs) + path + `utm_*` query params ONLY —
  every other query param is dropped (checkout tokens, session ids, gclid,
  email-in-query…). Free-text parts are scrubbed of emails, phone-length
  digit runs and token-shaped strings, then hard-capped (512 chars).
- **Token vs slug** (the scrub must not destroy the campaign dimension):
  a 20+ char alnum run is redacted only when it is machine-shaped —
  mixed-case WITH digits (base64 entropy), a separator-less letter+digit
  fusion (hex-ish checkout/cart tokens), or longer than 64 chars. Human
  slugs survive: `black-friday-2025-conversion`, `20260801_summer_sale`,
  product handles in paths. Inside `utm_*` values and slug-shaped path
  segments, pure-digit runs are ad-platform campaign/ad ids and are KEPT
  (`sanitizeUtmValue`); genuinely free text (unparseable input, non-slug
  path segments) still phone-scrubs digit runs.
- **Every field is length-capped** so a hostile payload cannot balloon a row.
- Ownership: capture persists onto **OURS** contracts only (another app's
  subscriber is not ours to profile; UNKNOWN fails safe).

### GDPR (mandatory)

`CUSTOMERS_REDACT` nulls **every** `acq*` data column and `acqRaw` on the
customer's contracts and clears the payloads of their `acquisition.captured`
stash events. It also **stamps** `acqPickupExhaustedAt` (the one non-data
`acq*` column — a queue-control marker holding no acquisition information):
the stash payloads are cleared, so the redacted `acqRaw`-null row must leave
the backfill's pickup window rather than be re-scanned nightly forever.
**Any new acq column must be added to the anonymizer in
`app/lib/webhooks/handlers.server.ts` in the same change that adds it.**
Origin-order *money* columns are retained (legitimate financial records, no
personal data). The `originDesign*` columns (Part 4, v1.26.0) are the one
other explicit exception: they are NOT `acq*` columns and are deliberately
retained through the redact, see Part 4 for the reasoning. The visit ledger
`WidgetVisitorDay` (Part 4, v1.27.0) is outside the redact for a simpler
reason: it holds no personal data at all (a random browser-local id, day,
design, market, device class and counts), so no row can be traced to a
customer and there is nothing to clear.

### Where it surfaces today

- **Subscriber cockpit** (`/app/subscribers/:id`): the "Acquisition" card —
  first order, source, UTMs, location, device, account-to-first-order time,
  first-order units.
- **Analytics segments** (v1.15.0, `app/lib/analytics/segments.server.ts`) —
  the first analytical consumers, read-only as contracted: the analytics
  page filters every view by country (`acqCountryCode` as the delivery-
  address fallback), traffic source (`acqUtm.source` → `acqSourceName`),
  device (`acqDeviceType`), first-order value (`acqOrderValueBand`) and
  first-order discount depth (the origin money mirror). Contracts without
  captured data appear under an explicit "Unknown" bucket — never silently
  excluded. The VAT cost model (v1.15.0) reads `acqCountryCode` through the
  same `contractTaxCountry` helper for its country-rate fallback.
- **Klaviyo**: profile attributes `cellexia_acq_source` /
  `cellexia_acq_country`, synced on every contract-scoped event when present.
- **Importers** (`scripts/import-subscribers.ts` CLI + `/app/import` admin):
  every imported contract gets its first-order shape — `acqUnitsFirstOrder`,
  `acqOrderValueBand`, `acqRaw.orderTotalCents` — computed from the CSV
  quantities + prices (the migrated-cadence approximation of the true first
  order, flagged `acqRaw.importPassthrough`), plus geo from the
  delivery-address columns. The CLI's optional `acq_*` columns pass through
  the same sanitizer entry points and caps as the webhook path
  (`sanitizeUtmValue` per utm value; the capped-only originals land in
  `acqRaw.rawUtm`), read from the first row in the group carrying any. The
  optional `subscribed_since` column (strict `parseCsvDate`, past-only, both
  importers) becomes `firstChargeAt`, so a migrated book cohorts on its real
  signup dates instead of arriving as one giant import-day cohort; the raw
  value is kept in `acqRaw.importSubscribedSince`.

### What it unlocks later (why we collect now)

- **Source-level LTGP** — join `acqSourceName`/`acqUtm.source` against cohort
  LTGP: which channel produces subscribers worth keeping, not just cheap
  ones. *(Shipped v1.15.0 as the traffic-source segment.)*
- **Geo cohorts** — retention/LTGP by `acqCountryCode`/`acqCity` (shipping
  performance and product-market fit differ by region). *(Country shipped
  v1.15.0 as the country segment; city remains future work.)*
- **Device take-rate** — buy-box conversion and survival by `acqDeviceType`,
  feeding preset choice in the designer. *(Device-segmented survival/LTGP
  shipped v1.15.0; per-device take rate remains future work — the checkout
  denominator carries no device.)* Partially addressed in v1.26.0: the
  `SubscribableOrder` fact row (Part 4) carries `deviceType` (the same
  reduced device class, taken from the acquisition capture of the order), so
  a per-device take rate is computable from the fact table; no admin surface
  shows it yet.
- **Value-band survival** — do bigger first orders churn less?
  `acqOrderValueBand` (and the raw total in `acqRaw`) make that a query, not
  a project. *(Shipped v1.15.0 as the first-order value segment.)*
- **Churn-risk features** — `acqTimeToPurchaseSeconds`, units and band are
  natural inputs for the risk model once enough labeled history exists.

The rule stands: consumers read these columns read-only, and any new signal
lands additively.

## Part 3 — Post-purchase survey (v1.21.0, migration 0020)

The second behavioral foundation surface: `SurveyResponse` rows (one per
checkout ORDER shown the thank-you/order-status survey) plus four nullable
`SubscriptionContract` columns — `predictedLtgp`, `predictedLtgpAt`,
`predictedLtgpInitial` (frozen day-one prediction, never rewritten) and
`surveyHoldout` (deterministic intervention holdout, assigned once, never
reshuffled). The same additive rule applies verbatim: answer OPTION KEYS are
a frozen measurement instrument versioned by `questionSetVersion`
(`app/lib/survey/shared.ts` is the authority; the extension bundles a
pinned mirror) — a wording change that alters an option's meaning is a new
version with new keys, never an in-place edit, because churn/LTGP
coefficients are estimated per option key over months of matured labels.
Consumers today: churn-risk features (`learning.server.ts`), predicted
LTGP (`predicted-ltgp.server.ts`), the subscriber-page survey card and the
`survey.answered` Klaviyo metric. GDPR: survey rows carry no free text and
no PII beyond the customer GID; contract deletion is impossible outside
demo resets, whose contracts never link surveys.

## Part 4 — Design measurement facts (v1.26.0, migration 0025; visits v1.27.0, migration 0026)

<a name="part-4"></a>

The third foundation surface answers "which buy-box design did each
subscribable order see, and did it subscribe?" It lands, per the additive
rule, in one new fact table, one new cache table, five nullable columns on
`SubscriptionContract` and one on `WidgetDesignRevision`. Nothing existing
was renamed or re-typed; v1.25 code runs unchanged against the schema.
v1.27.0 adds the matching denominator, "how many visitors saw each design",
in one more additive table, `WidgetVisitorDay` (migration 0026, no ALTER):
v1.26 code runs unchanged against it and a rollback leaves the rows in
place, unread.
Engine and readouts: [ARCHITECTURE.md, Design measurement](ARCHITECTURE.md#design-measurement).

### The `_cellexia_seen` carrier (storefront)

`properties[_cellexia_seen]` = `<preset>|<p>`, `p` in `s` (subscription was
preselected on the rendered widget), `o` (one-time preselected) or `u`
(unknown), for example `subscription_max|s`. Both storefront writers stamp
it on EVERY add-to-cart of our product's variants while the widget is
visible, one-time and subscription alike; `_cellexia_design` keeps its old
meaning (subscription adds only). Foreign variants and foreign-plan lines are
never touched, an existing non-empty value is never overwritten, and a hidden
or gated widget stamps nothing. It is buyer-writable input like any line
property: the parser (`parseSeenValue`, `app/lib/design-measurement/shared.ts`)
sanitizes the key to lowercase `/^[a-z0-9_]{1,40}$/` and treats anything but
`s`/`o` (or `sub`/`one`) as unknown; the raw value is never stored.

### `checkout.subscribable` payload

Additive key `seen: [...]`: the distinct `_cellexia_seen` values found on the
order's lines, sorted. Everything else in the payload (`orderId`,
`orderName`, `hasSellingPlanLine`, `presentmentCurrencyCode`, `designKeys`)
is unchanged. The nightly `design_facts_backfill` rebuilds a fact row from
this event alone when the direct write was lost.

### `SubscribableOrder` (one row per subscribable storefront order)

PII-free by construction: no email, no customer id, no address beyond the
country code. Written by `recordSubscribableOrder`
(`app/lib/design-measurement/facts.server.ts`) from ORDERS_CREATE for every
`containsSubscribable` order and by the nightly backfill; upsert on the
unique `(shopId, orderId)`; on update the join fields (`subscribed`,
`contractId`, `subscribedAt`) are never touched. Free-text fields are
length-capped (`orderName` 40, `sourceName` 40, `deviceType` 16,
`currencyCode` 8, `countryCode` ISO-2 or null).

| Field | Type | Source | Meaning |
|---|---|---|---|
| `orderId` | `String` | order GID | Unique per shop with `shopId`. |
| `orderName` | `String?` | order `name` | Display only. |
| `processedAt` | `DateTime` | order `processed_at` (fallback `created_at`, then now) | The instant the design calendar and the maturity gates use. |
| `countryCode` | `String?` | shipping (fallback billing) `country_code` | ISO-2, uppercased; anything else null. |
| `currencyCode` | `String?` | order `presentment_currency` | Context only. |
| `marketHandle` | `String?` | `MarketCountryMap` lookup on `countryCode` | The Shopify market the design was chosen for; null = unknown, resolves to the default design. |
| `deviceType` | `String?` | the acquisition capture's `acqDeviceType` for the same order | `"mobile" \| "desktop" \| "tablet"` or null; the full user agent is never stored. |
| `sourceName` | `String?` | order `source_name` | Shopify channel, capped 40. |
| `orderTotalCents` | `Int?` | order `total_price` | For AOV per design. |
| `units` | `Int?` | Σ line quantities | Basket size. |
| `designKey` | `String?` | resolution ladder | The preset key the shopper saw; null = unknown. |
| `designPreselect` | `String?` | resolution ladder | `"sub" \| "one" \| null` (unknown). |
| `designRevisionId` | `String?` | design calendar | The `WidgetDesignRevision` live for the order's market at `processedAt`. |
| `designSource` | `String` | resolution ladder | `"seen" \| "design_prop" \| "calendar" \| "none"`, best evidence first: `_cellexia_seen` on any of our lines, else `_cellexia_design`, else the calendar (withheld when the store was in SETUP or the market was hidden by `widgetMarkets`), else none. |
| `calendarDesignKey` | `String?` | design calendar | What the ledger said regardless of the ladder, for the stamped-vs-calendar agreement audit. |
| `hasSellingPlanLine` | `Boolean` | payload | Any line carried a selling-plan marker. |
| `ownership` | `String` | plan ids on the lines vs our own plan-id set | `"ours" \| "foreign" \| "mixed" \| "none"`; foreign-only orders are excluded from the readouts and counted as excluded. When our own plan-id set is known to be incomplete, an unmatched plan is not declared foreign. |
| `exposure` | `Boolean` | lines | Any widget-stamped property on any line. |
| `subscribed` | `Boolean` | `linkContractDesign` | A COUNTABLE (non-demo, OURS) contract has this order as `originOrderId`. |
| `contractId` | `String?` | `linkContractDesign` | That contract; no FK, survives contract deletion. |
| `subscribedAt` | `DateTime?` | `linkContractDesign` | Contract `firstChargeAt` (fallback `createdAt`). |
| `promo` | `Boolean` | `discount_codes` or `discount_applications` non-empty | Hygiene flag: a promo week must not read as a design effect. |
| `mixed` | `Boolean` | lines | Several designs stamped on one order, or our product bought both as subscription and one-time. |
| `transition` | `Boolean` | design calendar | A publish happened within 24 hours before the order (carry-over risk); recomputed nightly over the rows since `designMeasurement.startedAt` (all rows when unset, capped 5,000). |
| `staff` | `Boolean` | checkout email in `designMeasurement.excludeEmails` | Computed at write time from the email, which is never stored; re-stamped from the `checkout.subscribable` event's email when the Results tab saves the email list, and nightly over the same range as `transition`. |

Indexes: unique `(shopId, orderId)`; `(shopId, processedAt)`;
`(shopId, designKey, processedAt)`; `(shopId, contractId)`.

### `SubscriptionContract.originDesign*` (write-once) and the redact exception

| Field | Type | Meaning |
|---|---|---|
| `originDesignKey` | `String?` | Preset key of the design that acquired this subscriber; null = unknown. |
| `originDesignPreselect` | `String?` | `"sub" \| "one" \| null`: was subscription preselected on the widget that sold this. |
| `originDesignRevisionId` | `String?` | The revision live at checkout (calendar). |
| `originDesignSource` | `String?` | `"seen" \| "design_prop" \| "calendar" \| "none"`. |
| `originDesignStampedAt` | `DateTime?` | Set once by `linkContractDesign`; the guard of the write-once rule (`updateMany ... where originDesignStampedAt: null`). |

Stamped from the order's fact row when it exists; when it does not (order
predates the feature, lost webhook) from `widget.design_attributed` events,
then the calendar, then `"none"`, and only once the contract is older than
48 hours (`LINK_NO_FACT_GRACE_MS`) so the webhook race cannot burn the slot
on a guess. Consumers: the analytics segment dimensions `design` and
`preselect`, read-only.

**CUSTOMERS_REDACT does NOT clear these columns.** This is an explicit,
documented exception to the "every acq column joins the anonymizer" rule
above, decided by the merchant in v1.26.0: the design label is a property of
the checkout (which buy-box design was live and how it was rendered), not of
the person, it identifies nobody, and clearing it would punch holes in the
kept-rate and LTGP-by-design readouts for every redacted subscriber. The
anonymizer in `app/lib/webhooks/handlers.server.ts` carries a comment saying
so; do not add `originDesign*` to it. `SubscribableOrder` itself holds no
personal data and needs no redact step.

### `WidgetVisitorDay` (v1.27.0, one row per visitor per shop-day per design and preselect)

The visit ledger: the conversion denominator that pairs with
`SubscribableOrder`. Written only by the storefront beacon
(`buy-box-embed.js` section 4, `GET /apps/cellexia-subs/w`,
`app/routes/proxy.w.tsx`, `recordVisit` in
`app/lib/design-measurement/visits.server.ts`); the theme block alone sends
nothing, so a theme-block-only install has no rows here. Upsert on the
unique `(shopId, day, vid, designKey, designPreselect)`: a `view` beacon
adds one to `views` (created with 1), `engage` sets `engaged`, `atc` sets
`addedToCart` and, when the subscription option was added, `addedSubscription`;
`engage` and `atc` create the row with `views 0` when no view landed first,
so an add to cart without a prior view still counts a visit. Every event
refreshes `lastSeenAt`; the identity columns are written on create only,
so a later beacon carrying nothing never blanks them.

**PII stance.** Nothing here identifies a person: `vid` is a random
browser-local id (16 URL-safe characters, `localStorage["cellexia_vid"]`,
falling back to `sessionStorage`, then to a per-page value), not a customer
id, not a cookie, not tied to an email or an order; no IP, no user agent
and no page URL are stored (the User-Agent is only read in memory by the
route's bot filter). Merchant decision (v1.27.0): no consent gate. There is
nothing to redact: `CUSTOMERS_REDACT` does not touch this table because no
row can be traced to a customer.

**Retention.** Rows whose `day` is older than 400 days
(`VISIT_RETENTION_DAYS`, cutoff computed in the shop timezone) are deleted
by the nightly `design_facts_backfill` (`prune_visits`, its last step).
Rows carrying a `countryCode` but a null `marketHandle` (written before the
market map was filled) are mapped by the same job's flags step
(`recomputeVisitMarkets`, oldest first, capped 5,000 per run).

| Field | Type | Source | Meaning |
|---|---|---|---|
| `day` | `String` | `visitDayKey(now, shop.ianaTimezone)` at the server | `YYYY-MM-DD` in the shop timezone; the day the visitor is counted on. |
| `vid` | `String` | beacon `vid` | Anonymous browser-local visitor id, validated `/^[A-Za-z0-9_-]{8,32}$/`; anything else drops the beacon. |
| `designKey` | `String` | beacon `d` through `sanitizeDesignKey` | The preset key the widget rendered (`state.design`). |
| `designPreselect` | `String` | beacon `p` (`s` / `o` / `u`) | `"sub" \| "one" \| "u"`, NOT NULL, default `"u"` (unknown: an older `buy-box.js`). Same vocabulary as the order stamp, so numerator and denominator join on the identical key. |
| `countryCode` | `String?` | beacon `c` (`window.Shopify.country`) | ISO-2 uppercase or null; anything else null (never a dropped beacon). |
| `marketHandle` | `String?` | `MarketCountryMap` lookup on `countryCode` | The Shopify market; null = unknown (mapped later by `recomputeVisitMarkets`). |
| `deviceType` | `String?` | beacon `dv` (`m` / `t` / `d`) | `"mobile" \| "tablet" \| "desktop"` or null; from viewport width and pointer type, no user agent. |
| `views` | `Int` | `view` beacons | Page views on which the widget was at least half on screen for a full second. |
| `engaged` | `Boolean` | `engage` beacon | The visitor interacted with the widget (or the ultra-max satellite line). |
| `addedToCart` | `Boolean` | `atc` beacon | Our product was added to the cart from a page where the widget was visible. |
| `addedSubscription` | `Boolean` | `atc` beacon with `m=s` | The add carried the subscription option. |
| `firstSeenAt` / `lastSeenAt` | `DateTime` | server clock | First and most recent beacon for the row; `lastSeenAt` is what the `widget_visits` self-check and the "Last visit" tile read. |

Indexes (four): unique `(shopId, day, vid, designKey, designPreselect)`;
`(shopId, day)` (the summary and the presence probes `hasVisits` /
`firstVisitDay`); `(shopId, designKey, day)`; `(shopId, lastSeenAt)` (the
"last visit" top-1 and the `widget_visits` self-check's since-count, so
neither sorts the shop's whole ledger).

**Beacon parameters** (`GET /apps/cellexia-subs/w?…`, all in the query
string, HMAC-signed by the app proxy like every proxy request): `e`
(`view` / `engage` / `atc`), `d` (design key), `p` (`s` / `o` / `u`), `v`
(variant id), `c` (country), `cur` (active currency), `dv` (device class),
`vid` (visitor id), `pv` (8-character page-view id, unique per page load),
`t` (`Date.now()`), and on `atc` only `m` (`s` subscription / `o` one-time).
`v`, `cur`, `pv` and `t` are transport-only: the server ignores them and
stores nothing from them. Each event goes out at most once per page load
per design and preselect (`atc` also per mode; `atc` fires whenever an
intercepted cart request targets one of our variants, stamps injected or
already present, and never for a foreign variant). No beacon leaves the page
in admin preview (`cx_preview=` in the URL), in the theme editor
(`Shopify.designMode === true`) or while `getState()` is null (widget
hidden, launch-gated or absent). Server side, a beacon whose User-Agent
matches a crawler token as a whole word, a headless/audit tool prefix or a
named crawler is dropped (`VISIT_BOT_UA_RE`; a device name that merely
contains "bot", such as CUBOT phones, is not a bot).

### `MarketCountryMap` (cache)

`(shopId, countryCode)` unique → `marketHandle`, `marketName`. Rebuilt from
the Admin API Market regions (enabled markets only, primary market first, a
country served by two markets keeps the first) by the nightly
`design_facts_backfill` (its first step, so the rows it then writes resolve
against a filled map) and after every design publish, both contained; an
empty API answer never wipes a working map, and a missing entry resolves to
the default design (`marketHandle = null`), never to an error. Cache only:
safe to truncate, it refills on the next refresh.

### The write-once rule, restated for this part

`SubscribableOrder` rows are re-derivable facts (a redelivered order webhook
or the backfill may rewrite the design and hygiene columns; the join columns
are only ever set by `linkContractDesign`). `originDesign*` are stamped once
and never rewritten: a subscriber is attributed to exactly the design that
acquired them, forever, even after later republishes change the calendar.
