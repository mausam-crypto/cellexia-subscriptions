# Analytics module — metrics, cohorts, survival, forecasting, jobs

Owner: `app/services/analytics/*`, `app/routes/app._index.tsx`,
`app/routes/app.analytics.tsx`, `app/routes/jobs.$job.tsx`,
`app/components/charts/*`.

All money figures are integer minor units (cents). All rates are fractions
0..1 unless a `%` is stated. Enum-like strings come from `~/types/domain`.

## Cost model (`app/services/analytics/costModel.server.ts`)

Every profit figure flows through the cost model (ANALYTICS-V2 §1) — no
consumer computes margin on its own. `getCostModel(shop)` parses
`ShopSettings.settingsJson.costModel` (`defaultGrossMarginPercent`,
`shippingPerDeliveryCents`, `fulfillmentPerDeliveryCents`,
`paymentFeePercent`, `paymentFeeFixedCents`) and normalises percents 0–100 to
fractions 0..1. `ProductMeta.grossMarginPercent` is a FRACTION 0..1.
Per-line COGS precedence: `unitCostCents × quantity` →
`grossMarginPercent` fraction → the shop default margin fraction (0.70
unconfigured). Per order (`orderContribution`):

```
contribution = revenue − COGS − shipping − fulfillment − (revenue × feeFraction + feeFixed)
```

`CostModel.configured` is false until the merchant saves the cost form once;
`ExecutiveMetrics.costConfigured` surfaces it so UIs can banner.

## Executive metrics (`getExecutiveMetrics(shop, {from, to})`)

Sources: `SubscriptionContract` (+ lines + dunning state), `BillingAttempt`,
`AnalyticsEvent`, `ProductMeta`, `ShopSettings`. "Range" means
`occurredAt/createdAt/cancelledAt ∈ [from, to]`.

| Metric | Formula |
| --- | --- |
| `activeSubscribers` | count of contracts with `status = ACTIVE` (point-in-time now) |
| `newSubscriptions` | contracts with `createdAt` in range |
| `netGrowth` | `newSubscriptions - contracts cancelled in range` (merge sources — `cancelReason = MERGED` — are excluded: a merge is consolidation, not churn) |
| `activeSubscriptionRevenueCents` | Σ over ACTIVE contract lines of `currentPriceCents × quantity` (per billing cycle) |
| `grossProfitCents` | Σ over ACTIVE contracts of `revenue − COGS` per cycle, via `costModel.orderContribution` (COGS precedence: `unitCostCents` → `grossMarginPercent` fraction → shop default) |
| `recurringGrossProfitCents` | back-compat alias of `grossProfitCents` (same value) |
| `contributionCents` | Σ over ACTIVE contracts of the full LTGP `orderContribution.contributionCents` per cycle: `revenue − COGS − shipping − fulfillment − payment fees` |
| `costConfigured` | `CostModel.configured` — false until the merchant saves the cost form once (UIs banner while false) |
| `subscriberAovCents` | mean `amountCents` of SUCCESS billing attempts in range; falls back to `activeSubscriptionRevenueCents / activeSubscribers` ONLY when no SUCCESS attempt exists lifetime (a shop with history but an off-billing range shows 0 = "no charges in range") |
| `grossMarginLtvCents` | mean over contracts with ≥1 successful order of `totalRevenueCents × blended margin fraction`; the per-line margin fraction is `1 − COGS/price` from the cost model (value-weighted across current lines) |
| `paidOrdersPerSubscriber` | SUCCESS billing attempts with `occurredAt ≤ to` / count of contracts created ≤ `to` (as-of-`to`, no look-ahead into orders after the window) |
| `voluntaryChurnRate` | `CANCELLATION_COMPLETED` events in range / churn denominator |
| `involuntaryChurnRate` | contracts cancelled in range with `DunningState.phase = EXHAUSTED` (or cancel reason containing "PAYMENT") / churn denominator |
| `pauseRate` | `PAUSE_STARTED` events in range / churn denominator — customer pauses only: the dunning grace pause emits `DUNNING_PAUSE_STARTED` instead and is never counted here |
| `reactivationRate` | `PAUSE_ENDED` events / `PAUSE_STARTED` events in range (`PAUSE_ENDED` = an actual resume, emitted by `resumeContract`; `PAUSE_ENDING` remains the Klaviyo "pause ends soon" reminder trigger) |
| `skipRate` | `ORDER_SKIPPED` / (`ORDER_SKIPPED` + completed charges) in range |
| `productAdditionRate` | `PRODUCT_ADDED` events in range / max(activeSubscribers, 1) |
| `oneTimeToSubscriptionRate` | `WIDGET_*` conversions with payload `widgetType = POST_ONE_TIME` / impressions of that widget |
| `subscriptionToRoutineRate` | ACTIVE contracts with ≥2 distinct products / activeSubscribers |
| `paymentRecoveryRate` | min(1, SUCCESS attempts with `isRetry = true` / FAILURE attempts) in range. `isRetry` marks only deliberate re-attempts of a still-unpaid cycle: dunning-created attempts, or webhook-recorded attempts whose immediately prior attempt was FAILURE/CHALLENGED — never routine renewals |
| `attachRate` | widget conversions carrying a subscription selection (selling plan in payload) / all widget conversions |
| `widgetConversionRate` | widget conversions / widget impressions |

Churn denominator: the subscriber base at range start — contracts created
before `from` and not cancelled by `from` — or `newSubscriptions` when larger
(young shops). This is an approximation; historical PAUSED status is not
reconstructed.

Widget telemetry: any `AnalyticsEvent` whose name starts with `WIDGET_` is
classified by substring — IMPRESSION/VIEW → impression, CONVERSION/CONVERT/
ADD_TO_CART/PURCHASE → conversion, SELECT → selection. Impression/conversion
TOTALS come from the unbounded per-name `groupBy` over the full range (never
a row-capped sample); payload-dependent splits (attach rate, POST_ONE_TIME)
cursor-paginate the rows in 10k batches so no event is dropped. Payload keys
are read defensively (`widgetType`/`widget_type`,
`sellingPlanId`/`selling_plan`, …) so the offers module can evolve its
telemetry without breaking metrics.

Cancellation stamping: contracts cancelled OUTSIDE the app (Shopify admin,
native customer portal, another app, or Shopify marking them EXPIRED) are
stamped `cancelledAt = now, cancelReason = "EXTERNAL"` by
`syncContractFromShopify` when the terminal status arrives, so netGrowth and
every churn denominator see webhook-driven churn. Merge sources are stamped
`cancelReason = "MERGED"` and excluded from churn everywhere. Replayed
webhooks cannot double-count events: emissions with an explicit `dedupeKey`
are unique on the `AnalyticsEvent` warehouse row itself.

## Cohorts (`getCohortTable(shop, dimension, metric)`)

Columns are month offsets `M0..M11` from each contract's start, using the
mean Gregorian month (30.4375 days). The cohort clock is the contract's
REAL Shopify creation date (`treatmentStartedAt`, mirrored from the remote
contract; falls back to the local row's `createdAt`) — the mirror row's
`createdAt` is only the first-seen time and would cohort back-book imports
and reinstalls into the install month. A cell is `null` when the cohort is
too young to be observed at that offset.

Churn detection: a member has exited at its **effective** churn date —
`cancelledAt` when the app's own cancel flow stamped it, otherwise the row's
`updatedAt` when the status is terminal (`CANCELLED`/`EXPIRED`/`FAILED`).
Shopify-side cancels (admin, native portal, other apps) arrive via webhook
sync with a status change only, never a `cancelledAt`. Contracts with
`cancelReason = MERGED` are **censored** from `retention`/`subscribers`
cells from their merge month on (a merge is consolidation, not churn).

Dimensions: `startMonth`, `firstProduct`, `country`, `acquisitionChannel`,
`landingPage`, `advertorial`, `campaign`, `initialDiscount`,
`initialQuantity`, `sellingPlanConfig`, `device`, `newVsReturning`,
`firstOrderAovBand`, `firstShipmentProfitBand`, `widgetVersion`.
Acquisition-derived dimensions parse `acquisitionJson` defensively
(`channel`/`utm_source`, `landing_page`, `utm_campaign`, `device`,
`returning`, …); attribute-sourced values are strings, so numeric and
boolean-ish strings are coerced. `initialQuantity` prefers the acquisition
attribute (`initial_quantity`, string or number); when absent it falls back
to the sum of quantities of the contract's INITIAL lines only — lines
created within 24h of the earliest line — so products added later never move
a contract into a higher-quantity cohort (quantity edits to an original line
still reflect the current value). `newVsReturning` accepts boolean `true`/
`false` and the strings `true/1/yes/returning` vs `false/0/no/new`. Bands:
AOV `<50 / 50-99 / 100-149 / 150+` (currency major units), discount
`no intro discount / 1-10% / 11-20% / 21%+`, first-shipment profit
`<25 / 25-49 / 50-99 / 100+`.

Metrics:

- `retention` — share of the cohort's observable members still active at
  month m (not exited within m months; MERGED members censored). Fraction
  0..1.
- `subscribers` — the same, as an absolute count.
- `ltvCents` — average cumulative REALISED revenue through month m,
  **including cycle 0**: the origin checkout order (`firstOrderAovCents`)
  counts as the first payment. `BillingAttempt` rows exist only for rebills,
  so a synthetic origin payment is prepended at the contract's start unless
  a recorded payment already sits within 2 days of it (seeded cycle-0
  attempts are not double-counted; rebills cannot occur before one interval,
  minimum one week).
- `contributionCents` — `ltvCents` × each contract's contribution fraction
  from the cost engine (`orderContribution` in
  `services/analytics/costModel.server` — the full LTGP formula: revenue −
  COGS − shipping − fulfillment − payment fees), not raw product margin.

### Best configurations (`bestConfigurations(shop)`)

The flagship question: *which acquisition source × introductory offer × first
product × cadence produces the highest 12-month contribution margin?*
Contracts are grouped by that combo; each contributes its cumulative realised
revenue in months M0..M11 — **including the cycle-0 origin order**, so
intro-discount economics are actually measured — × its cost-engine
contribution fraction. Ranked by average 12-month contribution per contract.
`matureContracts` counts members observed for a full 12 months — treat
combos with few mature members as directional.

## Survival (`getSurvivalCurves(shop, cohortBy?)`)

Checkpoints: rebill 1/2/3 and 90/180/365 days. Member dating follows the
cohort conventions above: real start (`treatmentStartedAt`) and effective
churn date (terminal statuses without `cancelledAt` exit at their
`updatedAt`).

**Eligibility (the at-risk set) is symmetric**: a checkpoint's denominator
contains only contracts whose observation window covers it — old enough to
have reached the checkpoint at their cadence (rebill n: age ≥ n ×
intervalWeeks × 7 days; day checkpoints: age ≥ the day count), exits and
survivors alike. Exits get no special admission (admitting exits of any age
while censoring young survivors biases every curve downward). A contract
with `successfulOrders ≥ n + 1` is also eligible at rebill n regardless of
age — proof of survival, which keeps committed subscribers in the
denominator after a cadence switch retroactively re-dates their history.

**Rebill survival follows the paid-order rule**: a contract "survived rebill
n" when `successfulOrders ≥ n + 1` (first order + n rebills).
`remainingPercent` at rebill n is the share of eligible members meeting that
rule; eligible members still alive but short of it (paused, skipping,
mid-dunning) are reported separately as `pendingPercent`, so
remaining + voluntary + paymentFailure + pending = 100 for rebill points
(day points always report `pendingPercent` 0 and remaining as the complement
of exits). The three exit/remaining numbers alone no longer sum to 100 at
rebill checkpoints — that is by design.

Exits split by `classifyExit`: `PAYMENT_FAILURE` when dunning is `EXHAUSTED`
(or the cancel reason mentions payment), `VOLUNTARY` otherwise. A contract
with no `cancelledAt` still counts as a `PAYMENT_FAILURE` exit when its
dunning phase is `EXHAUSTED` and its status is not `ACTIVE` — five of the
seven dunning strategies end in a terminal PAUSE that no job ever cancels or
resumes, so those dead contracts must not read as survivors; their day-
checkpoint exit is dated from `DunningState.graceUntil`, falling back to the
last dunning-state write. `cancelReason = MERGED` is consolidation, not
churn: merged members are censored out of checkpoints at/after the merge.

**Null vs zero**: every percentage is `null` when `eligible = 0` — the
checkpoint is not observable yet (nobody old enough) — and `0` means
observed and gone. Consumers must render `null` as no-data ("—"), never as
0%. Each curve also carries `atRisk`, a number array parallel to `points`
(`atRisk[i] = points[i].eligible`), so the UI can grey out thin data.

Optional `cohortBy`: `startMonth`, `widgetVersion`, `intervalWeeks`; the
overall `"all"` curve always comes first. Cohort curves are capped at 24;
the cap keeps the NEWEST `startMonth` keys (newest-first ordering) and
sorts `intervalWeeks` numerically, so recent cohorts are never silently
dropped in favour of ancient ones.

## Forecast methodology (`forecastContract`, `computeForecast`, `runForecastJob`)

V2 (see docs/ANALYTICS-V2.md §2). `computeForecast(shop, options)` computes a
forecast on the fly for the UI; `ForecastOptions` selects:

- **model** — `CONTRACT` (default) or `SURVIVAL_TREND`
- **scenario** — `BASE` (default), `CONSERVATIVE`, `OPTIMISTIC`
- **horizonWeeks** — `4 | 13 | 26` (default 13)

### CONTRACT model (`forecastContract`, pure, unit-tested)

- Billing cycles are projected from `nextBillingDate` every `intervalWeeks`,
  bucketed into Monday-start weeks (`startOfWeek`) over the horizon.
  **Overdue contracts bill at most once this week**: a nextBillingDate that
  is several intervals in the past (the normal state mid-dunning) collapses
  into ONE next-charge event in the current week — the missed cycles are
  skipped, and the single remaining charge carries the dunning-phase
  recovery probability. The cycle loop is capped by the horizon DATE, never
  by a cycle count, so overdue contracts cannot truncate the forecast tail.
- Event ordering within a cycle: cancel → payment failure → pause → skip.
  Each expected-event probability is conditioned on earlier events not
  happening. The paid-order probability is
  `pOrder = alive × (1−pCancel) × (1−pFail) × (1−pPause) × (1−pSkip)`.
- Hazards: `pCancel = churnRiskScore × 0.35` per cycle. `pFail` on the first
  upcoming cycle comes from the dunning phase (NONE 0.04, PRE_DUNNING 0.10,
  RETRYING 0.35, GRACE 0.50, FINAL_NOTICE 0.65, RESOLVED 0.05, EXHAUSTED 1 —
  an exhausted contract forecasts zero); later cycles revert to the 0.04
  base. Skip/pause propensities are the contract's historical shares of
  cycles (`ORDER_SKIPPED` / `PAUSE_STARTED` events vs successful orders),
  capped at 0.9.
- Survival decay: `alive ← alive × (1−pCancel) × (1−pFail×0.5)` — cancels
  remove the contract; half of payment failures are never recovered; pauses
  and skips cost the cycle but not the subscriber.
- Unscored contracts use a churn-risk prior of 0.15.

### SURVIVAL_TREND model (`survivalTrendForecast`, pure, unit-tested)

Takes the shop's OBSERVED survival curve (`getSurvivalCurves`, using the
rebill checkpoints' `atRisk` denominators) and applies realised per-cycle
retention to the active base uniformly — data-driven, ignoring per-contract
churn/dunning scores. `observedRetentionFromCurve` derives `r₁ = S(1)`,
`rₙ = S(n)/S(n−1)` from the consecutive prefix of observable checkpoints;
cycles beyond the observed history reuse the last realised retention, and
exits split voluntary vs payment-failure by the deepest checkpoint's observed
share. When fewer than 2 completed cycles are observable the model **falls
back to CONTRACT** and says so in `reliability.reasons`.

### Scenarios (`SCENARIO_MULTIPLIERS`, exported constants)

Applied to either model: `CONSERVATIVE` = churn/skip hazard ×1.35, add-on
take-up ×0.5; `OPTIMISTIC` = churn/skip ×0.75, add-ons ×1.15; `BASE` = ×1.
Scenario multipliers never change `contractedUnits` (scheduled volume).

### Money — every profit number flows through the cost engine

Expected revenue = `pOrder × order value`. `marginCents` is CONTRIBUTION via
`orderContribution` (costModel.server): revenue − COGS − shipping −
fulfilment − payment fees, using the order-level contribution fraction for
lines and each add-on's incremental contribution (marginal COGS + payment
fee) for add-ons. No local margin math for aggregated money.

### Reliability estimator (`forecastReliability`, pure; `computeReliabilityInputs(shop)`)

`forecastReliability({activeContracts, monthsOfHistory, completedCycles,
productsWithCosts, productsTotal, cancelledObserved})` returns
`{grade, score 0-100, expectedErrorBand, reasons[]}`:

- active < 15 **or** months < 2 → `LOW` (±50%)
- active ≥ 15 & months ≥ 3 & completedCycles ≥ 30 → `MODERATE` (±25%)
- active ≥ 40 & months ≥ 6 & cancelledObserved ≥ 10 & cost coverage ≥ 60% →
  `HIGH` (±12%)

Reasons are plain language ("Only 4 weeks of billing history — treat weeks
5+ as directional.", "3 of 9 products have real cost data; profit lines use
the default margin."). UIs call `computeReliabilityInputs(shop)` for the
estimator input and render the Reliability card before any chart.

### Aggregation & snapshot

Both `computeForecast` and `runForecastJob(shop?)` aggregate every ACTIVE
(and dated-pause PAUSED) contract by **week × SKU × market** (market =
delivery-address country, `UNKNOWN` otherwise; SKU = variant id tail). Row
fields: `contractedUnits` (scheduled, ignoring probabilities — INCLUDING
scheduled add-on units, so Expected vs Contracted stays comparable per SKU),
`probabilityAdjustedUnits`, `expectedSkips/Pauses/Cancellations/
FailedPayments`, `expectedAddOnUnits` (AddOnItem NEXT_ONLY → first cycle,
N_DELIVERIES → remaining cycles, RECURRING → every cycle), `revenueCents`,
`marginCents`, `ciLowCents`, `ciHighCents`.
Indefinitely paused contracts are excluded.

Confidence interval ("binomial-ish"): each cell is a sum of independent
Bernoulli order events with values `v_i` and probabilities `p_i` — a
value-weighted Poisson-binomial. Normal approximation:
`Var = Σ p_i(1−p_i)v_i²`, bounds `expected ± 1.96√Var`, floored at 0.

`runForecastJob` snapshots the DEFAULT options nightly into a
`ForecastSnapshot` row whose `rowsJson` is the envelope
`{rows, meta: {options, computedAt, reliability}}` (an audit entry is
appended). Legacy snapshots whose `rowsJson` is a bare array remain readable:
`parseForecastSnapshotRows(rowsJson)` returns the rows with default options
and null `computedAt`/`reliability` (fall back to the snapshot row's own
`computedAt` column). The dashboard + analytics Forecast tab read the latest
snapshot; the Forecast tab recomputes on the fly via `computeForecast` when
non-default options are selected.

## Jobs registry (`POST /jobs/:job`)

Auth: `Authorization: Bearer $JOB_SECRET` (401 otherwise; GET → 405).
Optional `?shop=<domain>` (or JSON body `{"shop": …}`) narrows to one shop.
Response: `{ok, job, shop, ms, result}`.

| Job | Owner | Function |
| --- | --- | --- |
| `dunning-queue` | retention | `runDunningQueueJob` |
| `pre-dunning` | retention | `runPreDunningJob` |
| `churn-scan` | retention | `runChurnScanJob` |
| `outbox` | communications | `processOutboxJob` |
| `milestones` | treatment | `runMilestoneJob` |
| `depletion-scan` | treatment | `runDepletionScanJob` |
| `anniversaries` | treatment | `runAnniversaryJob` |
| `pre-shipment` | offers | `runPreShipmentJob` |
| `forecast` | analytics | `runForecastJob` |
| `reconcile` | core | `runReconcileJob` |
| `prune` | analytics (foundation fns) | `runPruneJob` — expired idempotency keys + expired magic-link tokens |

### Example cron setup

```cron
# crontab — every 15 min for time-sensitive queues, daily for heavy jobs
*/15 * * * *  curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/dunning-queue
*/15 * * * *  curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/outbox
0 5 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/pre-dunning
0 6 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/churn-scan
0 6 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/depletion-scan
0 7 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/milestones
0 7 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/anniversaries
0 8 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/pre-shipment
0 3 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/forecast
0 4 * * *     curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/reconcile
30 3 * * *    curl -sf -X POST -H "Authorization: Bearer $JOB_SECRET" https://app.example.com/jobs/prune
```

Or GitHub Actions:

```yaml
on:
  schedule:
    - cron: "0 3 * * *"
jobs:
  forecast:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sf -X POST \
            -H "Authorization: Bearer ${{ secrets.JOB_SECRET }}" \
            https://app.example.com/jobs/forecast
```

## Admin surfaces

- `/app` — executive dashboard: full metric tile grid with period-over-period
  deltas (30/90/365-day range select), 13-week forecast charts, survival
  curve, voluntary vs payment-related churn split, quick links to the
  at-risk list (`/app/retention`) and payment-recovery queue (`/app/dunning`).
- `/app/analytics` — tabs: Cohorts (dimension × metric heat table), Survival
  (curves + per-cohort table), Forecast (operations view for inventory +
  week/SKU/market detail with CI), Best configurations, Export (CSV:
  contracts, latest 10k events, current cohort table via `?export=`).

Charts are dependency-free inline SVG (`app/components/charts/*`) —
accessible (`role="img"` + title/desc), Cellexia-tinted (`#B1CDED` accent,
`#1D1D1B` ink).

## Analytics workspace UI (V2) — `/app/analytics`

Tabs: Cohorts · Survival · Forecast · **Costs** (new) · Best configurations ·
Export. While `costModel.configured` is false, a dismissible banner links to
the Costs tab (profit numbers fall back to the default margin until then).

### Cohort heatmap

- Column headers carry calendar-month semantics: **M0 is each cohort's own
  calendar month** (header reads "M0 · cohort month"), M1 the next month, and
  so on; a one-line reading guide sits above the table.
- A cohort-size ("Plans") column and a color-scale legend (low → high, with
  the max value labelled) accompany the heat table.
- Null cells render as **"—", never 0** — the cohort is too young to be
  observed at that offset.
- Every cell has a hover title with the cohort key, the offset (plus the
  actual calendar month for start-month cohorts) and the exact value.
- Thin cohorts (size < 5) are muted and marked "†" with a footnote — too
  small to draw conclusions from.
- Dimension/metric switchers preserve all other query params.

### Survival tab

- Uses the additive `atRisk` field on survival points: checkpoints resting on
  fewer than 5 plans at risk are greyed and marked "*"; checkpoints with 0
  plans at risk render "—" (no data, never "0 % remaining"). Hover any value
  for the at-risk count and the voluntary vs payment-failure exit split.
- The split is labelled in plain language: voluntary cancellations (customer
  chose to stop) vs payment failures (cards that never recovered).
- The per-cohort table caps at 8 cohort curves and keeps the **newest**
  start-month cohorts (order-independent selection via
  `pickSurvivalCurvesForDisplay`), showing "Showing the latest 8 of N
  cohorts" when truncated. Before this fix the blind
  `slice(0, 9)` dropped every cohort after the 8th oldest — exactly the
  recent months a merchant compares against.

### Forecast tab (V2)

- Model, scenario and horizon selectors are **links carrying query params**
  (`?model=CONTRACT|SURVIVAL_TREND&scenario=BASE|CONSERVATIVE|OPTIMISTIC&horizon=4|13|26`),
  not JS state — every view is a shareable URL. Labels: CONTRACT =
  "Plan-by-plan", SURVIVAL_TREND = "Based on your observed retention".
- The loader calls `computeForecast(shop, options)` live (no snapshot
  staleness); the nightly `runForecastJob` snapshot still feeds the dashboard
  and the CSV export.
- The **reliability card renders first**: grade badge (LOW = critical,
  MODERATE = attention, HIGH = success), expected error band, and
  plain-language reasons as bullets. Then the weekly revenue chart (every
  horizon week seeded, so zero-billing weeks stay visible), the ops table
  (expected vs contracted units on the same basis, add-ons included in both)
  and the week × SKU × market detail.

### Costs tab (new)

- **Cost-model form** — euros/percent in the UI, stored in
  `ShopSettings.settingsJson.costModel` as integer cents and percents 0–100
  per the V2 unit rule; the save merges over existing `settingsJson` keys,
  appends an audit entry (`settings.cost_model_updated`) and requires
  OWNER/ADMIN.
- **Per-product COGS editor** — inline rows writing
  `ProductMeta.unitCostCents` (euros in, cents stored) and
  `ProductMeta.grossMarginPercent` (percent in, **fraction 0..1 stored**),
  one save per row, audited (`product.cost_updated`). Percent-style entries
  are validated (0–100) — a "72" is stored as 0.72, never clamped to 100 %.
- **Live example card** — the LTGP formula applied line by line to a real
  recent plan (or a sample order on new shops):
  `revenue − COGS − shipping − fulfillment − payment fees = contribution`,
  computed through `orderContribution` so the example always matches the
  engine.

### CSV export hardening

`csvEscape` neutralises spreadsheet formula injection: string cells starting
with `=`, `+`, `-`, `@`, tab or CR are prefixed with an apostrophe (Excel/
Sheets "treat as text"); numeric cells (e.g. negative numbers) are untouched
and RFC-4180 quoting is unchanged.
