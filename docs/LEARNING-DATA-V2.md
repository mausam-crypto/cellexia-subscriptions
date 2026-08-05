# Learning & Data V2 — build contract

Two goals: (1) the risk/forecast machinery **recalibrates itself from observed
outcomes** as subscribers accumulate — day-1 heuristics are only priors;
(2) the app **collects maximal first-party data from day 1** (traffic source,
geo, behavior, time-to-purchase, …) so future features inherit a deep dataset.
Exact contract — implementers follow to the letter.

## 1. Learning engine — `app/services/analytics/learning.server.ts` [owner: learning]

### Storage (new Prisma model + migration)
```prisma
model ModelState {
  id          String   @id @default(cuid())
  shop        String
  // domain: CHURN_CALIBRATION | DUNNING_RECOVERY | FORECAST_PROPENSITY | DEPLETION_USAGE
  model       String
  version     Int
  paramsJson  String   // learned parameters (shape per model, below)
  metricsJson String   @default("{}") // quality metrics (brier, lift, n)
  sampleSize  Int
  computedAt  DateTime @default(now())
  @@unique([shop, model, version])
  @@index([shop, model])
}
```
Append-only; latest version wins. `getModelState(shop, model)` returns the
newest row parsed, or null (callers must treat null = "use static defaults").

### Pure functions (exported, unit-tested)
- `shrinkRate(observed: number, n: number, prior: number, k = 20): number`
  — empirical-Bayes blend `(observed*n + prior*k)/(n+k)`. The k=20 prior
  weight means ~20 observations to move halfway off the prior; thin data
  never swings parameters violently.
- `fitCalibrationBuckets(pairs: Array<{score: number; churned: boolean}>, priorWeight = 20): CalibrationBucket[]`
  — 10 equal-width score buckets; per bucket observed churn shrunk toward the
  bucket midpoint (identity prior); enforce monotone non-decreasing via
  pool-adjacent-violators. `CalibrationBucket = {lo, hi, observed, n, calibrated}`.
- `applyCalibration(score: number, buckets: CalibrationBucket[] | null): number`
  — null/empty → score unchanged; else linear interpolation within bucket.
- `brierScore(pairs): number`, `decileLift(pairs): number` (top-decile
  observed churn ÷ overall).
- `bestRetryOffsets(episodes: Array<{category: string; offsetDays: number; recovered: boolean}>, minN = 30): Record<string, number[]>`
  — per category, pick up to 3 offset-days ranked by shrunk recovery rate;
  categories under minN are omitted (callers keep static strategy).
- `learnedPropensities(observed: {cycles: number; skips: number; pauses: number; churns: number}, priors: {skip: number; pause: number; churn: number}): {skip, pause, churn}` — each via shrinkRate. Skip/pause use opportunity denominators (cycles + events — a skipped/paused cycle produces no SUCCESS attempt), matching forecast.server's per-contract convention; churn stays per completed cycle (CHURN_HAZARD_SCALE domain).

### Job — `runLearningJob(shop?)` (jobs registry key "learning", weekly)
1. **CHURN_CALIBRATION**: pair ScoreSnapshots (kind CHURN_RISK) aged 60–180
   days with the outcome "contract exited within 90 days of the snapshot"
   (use `effectiveCancelledAt` from cohorts.server). Pairs train on the RAW
   score (factorsJson.raw; snapshot.value fallback for legacy snapshots) —
   value stores the CALIBRATED score, and training on it would fit each
   version on the previous version's outputs. Merged contracts (cancelReason
   MERGED) never count as churned; pairs whose 90-day window a merge
   interrupted are censored (dropped). Need ≥ 40 pairs to write
   a version; store buckets + {brier, decileLift, n}.
2. **DUNNING_RECOVERY**: from BillingAttempt history, reconstruct
   failure→retry episodes (isRetry rows after a FAILURE, offsetDays =
   occurredAt delta); store bestRetryOffsets output + per-category n.
3. **FORECAST_PROPENSITY**: observed per-cycle skip/pause/churn rates over the
   trailing 180 days (events ORDER_SKIPPED, PAUSE_STARTED (customer only —
   exclude payload.dunning); churn = VOLUNTARY exits ÷ completed cycles —
   payment-failure cancels are excluded because the forecast models
   involuntary loss separately via pFail × FAILURE_LOSS_SHARE, and MERGED
   cancels are consolidation, not churn) shrunk toward the
   static defaults currently hard-coded in forecast.server (export them as
   `STATIC_PROPENSITY_PRIORS` from forecast.server so both sides share one
   source).
4. **DEPLETION_USAGE**: per product, median realised inter-delivery stretch
   vs configured cadence → store a *suggested* dailyUsage multiplier. Stored
   only — the depletion engine stays informational per the product spec; the
   Treatment admin shows the suggestion next to the product ("observed usage
   suggests 0.8 ml/day — update?").
Every run appends audit `learning.recalibrated` with per-model n + metrics.

### Consumers (exact seams)
- `churn.server` [owner: learning edits this file]: `runChurnScanJob` applies
  `applyCalibration(rawScore, buckets)` before persisting; ScoreSnapshot
  factorsJson gains `{raw, calibrated, modelVersion}`.
- `dunning.server` [owner: retention-fixes]: `strategyFor(category, isHighValue, learnedOffsets?: number[] | null)` — additive optional param;
  `onBillingFailure`/queue job fetch offsets via
  `getLearnedDunningOffsets(shop, category)` (exported by learning.server;
  merchant overrides from settingsJson.dunningOverrides — see §3 — take
  precedence over learned, learned over static).
- `forecast.server` [owner: learning edits the propensity seam only]:
  propensity resolution order = learned (ModelState) → static priors;
  reliability reasons mention it ("skip/pause rates learned from N observed
  cycles" vs "using industry priors — too little history").
- Admin visibility [owner: retention-fixes]: app.retention gains a "Model
  health" card: churn calibration table (bucket, predicted vs observed, n),
  Brier trend across versions, dunning learned-offsets per category, and
  plain-language status ("Learning active — 214 outcomes observed" / "Not
  enough history yet — using launch defaults; learning starts automatically").

## 2. Data capture — maximise day-1 collection [owner: data-capture]

### Storefront (theme extension JS — fire-and-forget, never blocks add-to-cart)
On first widget impression persist (localStorage, 30d): visitor key (exists),
`firstSeenAt` ISO, first `document.referrer`, first landing path, full
`utm_*`+`gclid`+`fbclid` param snapshot. On add-to-cart, POST
`/cart/update.js` with cart **attributes**:
`_cellexia_visitor, _cellexia_first_seen, _cellexia_referrer,
_cellexia_landing, _cellexia_utm` (JSON string), `_cellexia_widget`
(version:variant), `_cellexia_device` ("mobile"|"desktop" via matchMedia),
`_cellexia_qty`. Keys under 100 leading-underscore attributes stay hidden from
the customer at checkout.

### Ingestion (webhooks [owner: data-capture edits handlers.server.ts])
- `ORDERS_CREATE` + contract create: read `note_attributes` (order webhook) /
  origin-order custom attributes; build the enriched acquisition record via a
  NEW pure `buildAcquisition(input)` in
  `app/services/core/acquisition.server.ts`:
```json
{
  "channel": "meta-ads|google|klaviyo|tiktok|organic|referral|direct",  // derived: utm_source → referrer host map → direct
  "utm": { "...": "raw utm params" },
  "referrer": "https://…", "landingPage": "/pages/…",
  "device": "mobile", "widgetVersion": "TREATMENT_CHOICE:v1",
  "visitor": "v…", "timeToPurchaseSeconds": 5460,
  "unitsInitial": 2, "linesInitial": 1,
  "geo": { "countryCode": "FR", "country": "France", "city": "Lyon", "province": "…", "zip3": "690" },
  "customerLocale": "fr", "orderName": "#1234", "sourceName": "web",
  "capturedAt": "ISO", "schemaVersion": 2
}
```
  Merged over any existing acquisitionJson (never lose earlier keys);
  `schemaVersion` future-proofs parsers. Geo from the order's
  shipping_address. cohortKeyFor's flat-merge already resolves `channel`,
  `landingPage`, `device` — verify and extend its key lists for the v2 names.
- **Any-order delivery**: the REST orders/create payload has no selling-plan
  field on line_items, so ORDERS_CREATE matches contracts by customer +
  originOrderId (with a ±48 h `treatmentStartedAt` window for the null-origin
  fallback) and always merges enrichment even when the AOV is already
  stamped. When the order webhook wins the race (contract row not created
  yet), the built record is stashed as an `ACQUISITION_ORDER_CAPTURE`
  AnalyticsEvent keyed by the order gid; the contract-create handler merges
  the stash underneath its own record, so order-only keys (locale, orderName,
  sourceName, geo, raw) survive both orderings.
- **Everything raw is kept**: the full note_attributes snapshot goes into
  acquisitionJson.utm/raw even if unused today.

### Portal behavior telemetry [owner: portal-fixes]
Every portal loader logs `PORTAL_VIEW` and every successful action logs
`PORTAL_ACTION` AnalyticsEvent rows (direct prisma write like WIDGET_*, name
prefix "PORTAL_", payload {page|action, contractId}) via one helper
`trackPortal(shop, customerId, contractId, kind, detail)` in
portal/auth.server.ts. This makes the churn feature `portalVisits30d` REAL
(churn scan switches from the magic-link proxy to counting PORTAL_VIEW).

## 3. Editability [owners: retention-fixes + docs]
- `settingsJson.dunningOverrides = {"INSUFFICIENT_FUNDS": [3,5,7], ...}` —
  editable per category in app.dunning (text inputs, validated 1..30 days,
  max 4 retries); precedence merchant > learned > static shown in the UI.
- docs/CONFIGURABILITY.md: table of EVERY tunable feature → where to edit it
  (admin surface + settings key + default) — widgets copy, cadence defaults,
  committed plan, policy window, pause presets, milestones rewards, cost
  model, dunning, churn threshold, Klaviyo, gift threshold, autopilot bounds.
- docs/DATA-DICTIONARY.md: every collected field: source, storage, consumers
  today, "reserved for future" flag.
