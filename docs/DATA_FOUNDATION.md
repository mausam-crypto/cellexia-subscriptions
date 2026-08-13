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
personal data).

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
  denominator carries no device.)*
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
