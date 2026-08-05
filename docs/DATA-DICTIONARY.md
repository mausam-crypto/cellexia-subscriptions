# DATA DICTIONARY — every field Cellexia collects

Audience: anyone deciding whether a datum already exists before adding a new
collector, and anyone building a feature on top of the day-1 dataset.
Companion docs: [`LEARNING-DATA-V2.md`](LEARNING-DATA-V2.md) (the build
contract this dictionary documents), [`DATA-MODEL.md`](DATA-MODEL.md) (table
level), [`ANALYTICS.md`](ANALYTICS.md).

Conventions used below:

- **Source** — where the value is born (storefront JS, webhook, portal, job).
- **Storage** — the column/JSON path that holds it.
- **Consumers today** — code that reads it right now. A field with no
  consumer is marked **RESERVED** — collected deliberately so future
  features inherit history instead of starting from zero. Never delete a
  RESERVED field for being "unused"; that is its job.
- All money integer cents; all enum-like strings from `app/types/domain.ts`.

---

## 1. Acquisition record — `SubscriptionContract.acquisitionJson`

Built by the pure `buildAcquisition(input)` in
`app/services/core/acquisition.server.ts` on `ORDERS_CREATE` /
`SUBSCRIPTION_CONTRACTS_CREATE`, **merged over** any existing
`acquisitionJson` (earlier keys are never lost). `schemaVersion: 2` marks the
enriched record; parsers must tolerate both shapes. On a GDPR
`customers/redact`, part of this record is stripped — the per-field fate is
listed in the **GDPR redaction** subsection below; parsers must also tolerate
a redacted record (missing `utm`/`referrer`/`raw`, `redactedAt` present).

### v2 fields (schemaVersion 2)

| Field | Type | Source | Consumers today | Status |
| --- | --- | --- | --- | --- |
| `channel` | string enum-ish: `meta-ads`, `google`, `klaviyo`, `tiktok`, `organic`, `referral`, `direct` | Derived: `utm_source` → referrer-host map → `direct` | `cohortKeyFor("acquisitionChannel")` (cohort tables, `bestConfigurations`) | live |
| `utm` | object — raw `utm_*` + `gclid` + `fbclid` snapshot (plus the full raw note_attributes snapshot) | Storefront localStorage snapshot → cart attribute `_cellexia_utm` → order `note_attributes` | Channel derivation; cohort flat-merge (`utm_source`) | live (raw payload RESERVED) |
| `referrer` | string URL | First `document.referrer` captured on first widget impression | Channel derivation fallback | live |
| `landingPage` | string path | First landing path (localStorage, 30 d) | `cohortKeyFor("landingPage")` | live |
| `device` | `"mobile"` \| `"desktop"` | Storefront `matchMedia` → `_cellexia_device` | `cohortKeyFor("device")` | live |
| `widgetVersion` | string `"<WIDGET_TYPE>:<variant>"` | `_cellexia_widget` cart attribute | Also denormalised to `SubscriptionContract.widgetVersion`; experiments/cohorts | live |
| `visitor` | string visitor key (`v…`) | Storefront localStorage visitor key (`_cellexia_visitor`) | Widget telemetry join (impression → conversion stitching) | RESERVED (cross-session identity graph) |
| `timeToPurchaseSeconds` | number | `firstSeenAt` → order `created_at` delta | — | RESERVED (intent-band modelling) |
| `unitsInitial` | number | Order line quantities at purchase | — | RESERVED (initial-basket cohorting) |
| `linesInitial` | number | Order line count at purchase | — | RESERVED |
| `geo.countryCode` / `geo.country` / `geo.city` / `geo.province` | strings | Order `shipping_address` | `cohortKeyFor` market dimensions where mapped | live/RESERVED per dimension |
| `geo.zip3` | string (first 3 zip chars) | Order `shipping_address.zip` | — | RESERVED (regional cohorts without storing full zip) |
| `customerLocale` | string BCP-47-ish | Order `customer_locale` | — | RESERVED (localised comms) |
| `orderName` | string `"#1234"` | Order webhook | Support/debug joins | live |
| `sourceName` | string (`web`, `pos`, …) | Order webhook | — | RESERVED (channel hygiene) |
| `capturedAt` | ISO datetime | Set by `buildAcquisition` | Freshness checks | live |
| `schemaVersion` | number (2) | Set by `buildAcquisition` | Parser future-proofing | live |

### v1 legacy keys (pre-enrichment; still merged, still parsed)

| Field | Source | Consumers today |
| --- | --- | --- |
| `widgetVersion`, `experimentKey`, `variantKey` | Checkout custom attributes `_cellexia_widget` / `_cellexia_experiment` / `_cellexia_variant` (`parseAcquisitionAttributes`, `app/services/core/pure.ts`) | Experiments attribution, cohorts |
| `initialDiscountPercent` | `_cellexia_discount_percent` attribute | Denormalised to `SubscriptionContract.initialDiscountPercent`; subscriber pricing (`planAdjustedPriceCents` resolution), savings tiles |
| `utm` (flat `utm_*` map) | Checkout attributes | Channel derivation |
| `custom` (any other `_cellexia_*`) | Checkout attributes | RESERVED |

### GDPR redaction — field fate on `customers/redact`

`handleCustomersRedact` (`app/services/core/gdpr.server.ts`) rewrites the
acquisition record in place. **Removed** (identifies or fingerprints the
person) vs **retained** (coarse aggregates cohort analytics runs on):

| Fate | Fields |
| --- | --- |
| **Removed** | `referrer`, `utm` (v2 snapshot AND v1 flat map — same key), `visitor`, `raw` (verbatim attribute snapshot: re-contains referrer/utm/visitor), v1 `custom`, `geo.city`, `geo.province`, `geo.zip3` |
| **Retained** | `channel`, `device`, `geo.countryCode`, `geo.country`, `widgetVersion`, `experimentKey`, `variantKey`, `initialDiscountPercent`, `landingPage`, `timeToPurchaseSeconds`, `unitsInitial`, `linesInitial`, `customerLocale`, `orderName`, `sourceName`, `capturedAt`, `schemaVersion` |
| **Added** | `redactedAt` (ISO timestamp, stamped once on first redaction) |

Consequences for consumers: channel/device/country cohort dimensions keep the
redacted contract; `landingPage` cohorts keep it; anything reading `utm`,
`referrer`, `visitor` or `raw` must treat absence as normal (a redacted — or
simply attribute-less — record). The same webhook also nulls
`SubscriptionContract.customerEmail` and `deliveryAddressJson`, deletes the
customer's `MagicLinkToken` rows and scrubs email-bearing keys from their
`AnalyticsEvent` payloads; financial fields (`firstOrderAovCents`,
`totalRevenueCents`, attempts, lines) are retained. Full behaviour:
[`SAFEGUARDS.md`](SAFEGUARDS.md) §13.

## 2. Storefront capture — cart attributes

Persisted by the theme-extension JS (fire-and-forget; never blocks
add-to-cart). LocalStorage snapshot lives 30 days; on add-to-cart the widget
POSTs `/cart/update.js` with cart **attributes** (leading underscore keeps
them hidden at checkout):

| Attribute | Value | Feeds |
| --- | --- | --- |
| `_cellexia_visitor` | visitor key | `acquisitionJson.visitor` |
| `_cellexia_first_seen` | first-impression ISO timestamp | `timeToPurchaseSeconds` |
| `_cellexia_referrer` | first `document.referrer` | `acquisitionJson.referrer` |
| `_cellexia_landing` | first landing path | `acquisitionJson.landingPage` |
| `_cellexia_utm` | JSON string: full `utm_*`+`gclid`+`fbclid` snapshot | `acquisitionJson.utm` |
| `_cellexia_widget` | `version:variant` | `widgetVersion` |
| `_cellexia_device` | `"mobile"` \| `"desktop"` | `acquisitionJson.device` |
| `_cellexia_qty` | selected quantity | `unitsInitial` cross-check |
| `_cellexia_experiment` / `_cellexia_variant` | experiment assignment | experiments attribution |
| `_cellexia_discount_percent` | selected plan's percent off | `initialDiscountPercent` |

## 3. Widget telemetry — `AnalyticsEvent` rows `WIDGET_*`

Written by `proxy.api.events.tsx` (app proxy, HMAC-verified): event name =
`"WIDGET_" + event.toUpperCase()` (e.g. `WIDGET_IMPRESSION`,
`WIDGET_SELECTION`, `WIDGET_CONVERSION`). Payload fields are normalised by
`extractWidgetTelemetry` (`app/services/offers/widgets.server.ts`), each
truncated to 100 chars:

| Payload field | Meaning | Consumers today |
| --- | --- | --- |
| `widgetType` | `WidgetType` (letter codes A/B/D/E/F mapped) | Admin → Widgets telemetry summary; `metrics.server` funnel classification |
| `productId` | product the widget rendered on | Widgets summary |
| `variantKey` | experiment variant (from `experimentKey` `"id:variant"`) | Experiment result aggregation |
| `sellingPlanId` | plan chosen (named so `isSubscriptionSelection()` recognises plan-bearing events) | Conversion metrics |
| `qty` | selected quantity | Cadence-default tuning |
| `experimentKey` | full experiment assignment key | Experiments |

## 4. Portal behaviour telemetry — `PORTAL_VIEW` / `PORTAL_ACTION`

One helper writes both: `trackPortal(shop, shopifyCustomerId, contractId,
kind, detail)` in `app/services/portal/auth.server.ts` — a direct
`AnalyticsEvent` insert (never throws, mirrors the `WIDGET_*` pattern; NOT a
lifecycle event, so nothing reaches Klaviyo).

| Name | When | Payload |
| --- | --- | --- |
| `PORTAL_VIEW` | every portal loader | `{detail: <page>, contractId}` |
| `PORTAL_ACTION` | every successful portal action | `{detail: <action>, contractId}` |

Consumers today: the churn feature `portalVisits30d` is REAL from this build
on — `runChurnScanJob` counts `PORTAL_VIEW` rows instead of the old
magic-link proxy. `PORTAL_ACTION` is RESERVED beyond audit/debug (future
engagement scoring).

## 5. Learning engine — `ModelState` (append-only, latest version wins)

`getModelState(shop, model)` returns the newest row parsed, or `null`
(callers fall back to static defaults). Written weekly by `runLearningJob`
(jobs key `"learning"`); every run appends audit `learning.recalibrated`.

| `model` domain | `paramsJson` shape | `metricsJson` | Consumers today |
| --- | --- | --- | --- |
| `CHURN_CALIBRATION` | `CalibrationBucket[]` — `{lo, hi, observed, n, calibrated}` ×10, monotone (PAV) | `{brier, decileLift, n}` | `runChurnScanJob` via `applyCalibration(raw, buckets)`; admin "Model health" card |
| `DUNNING_RECOVERY` | `bestRetryOffsets` output: `{<DeclineCategory>: number[] (≤3 offset-days)}` | per-category `n` | `getLearnedDunningOffsets(shop, category)` → `strategyFor(..., learnedOffsets)`; precedence merchant `dunningOverrides` > learned > static |
| `FORECAST_PROPENSITY` | `{skip, pause, churn}` per-cycle rates (shrunk toward `STATIC_PROPENSITY_PRIORS` from `forecast.server`) | sample sizes | Forecast propensity resolution: learned → static priors; reliability reasons |
| `DEPLETION_USAGE` | per-product suggested `dailyUsage` multiplier | observation counts | Stored only — surfaced as a suggestion in Admin → Treatment; depletion engine stays informational |

Shared columns: `version` (monotonic per shop+model), `sampleSize`,
`computedAt`. Minimum sample gates: 40 pairs (churn calibration), 30 per
category (dunning), else no version is written.

## 6. Score snapshots — `ScoreSnapshot.factorsJson` (kind `CHURN_RISK`)

From this build, churn snapshots gain `{raw, calibrated, modelVersion}`
alongside the per-feature factor map — `raw` is the uncalibrated model
score, `calibrated` what was persisted/thresholded, `modelVersion` the
`ModelState` version used (`null` = launch defaults). Consumers: the
learning job's outcome pairing (uses snapshots aged 60–180 d), the admin
Model-health card, `app.subscribers.$id` factor display.

## 7. Add-on fulfillment — `AddOnItem` tracking fields

Written by `app/services/offers/addOnFulfillment.server.ts` (see
[`RETENTION.md`](RETENTION.md) §add-on fulfilment lifecycle):

| Field | Meaning | Consumers today |
| --- | --- | --- |
| `appliedAt` | timestamp when the add-on became a real `ContractLine` (charged & shipped from the next cycle) | apply job dueness (`appliedAt: null` = unapplied); consumption gate |
| `appliedLineId` | local `ContractLine.id` created at application | `consumeAddOnsAfterCharge` line removal (variant-match fallback when stale) |
| `remainingDeliveries` | deliveries still owed (N_DELIVERIES; normalised to 1 for applied NEXT_ONLY) | consumption decrement/removal; `expectedNextOrderValueCents` |

Audit actions: `ADD_ON_APPLIED`, `ADD_ON_CONSUMED`, `ADD_ON_COMPLETED`,
`ADD_ON_APPLY_JOB` (per-shop run summary). Lifecycle: applied add-ons emit
`PRODUCT_ADDED` with `payload.addOn: true` so analytics can separate applied
add-ons from customer-initiated product adds.

## 8. Where to look next

- Lifecycle event catalogue: `LIFECYCLE_EVENTS` in `app/types/domain.ts`
  (mirrored 1:1 to Klaviyo as `"Cellexia " + Title Case`).
- Tunables and their admin surfaces: [`CONFIGURABILITY.md`](CONFIGURABILITY.md).
- Table-level reference: [`DATA-MODEL.md`](DATA-MODEL.md).
