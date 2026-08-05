# Analytics V2 — build contract

Goals: (1) a real cost model so contribution/LTGP is true profit, not just
product margin; (2) forecast with selectable models + a reliability grade;
(3) dashboards a non-analyst reads at a glance. This document is the exact
contract between the modules — implementers follow it to the letter.

## 1. Cost model — `app/services/analytics/costModel.server.ts` [owner: servers]

**The unit rule (resolves today's ambiguity):** `ProductMeta.grossMarginPercent`
is a FRACTION 0..1 (as the schema documents). All `settingsJson` cost values
below are integers (cents) or percents 0–100 as named; `getCostModel`
normalises percents to fractions before anything else consumes them.

`ShopSettings.settingsJson.costModel`:
```json
{
  "defaultGrossMarginPercent": 70,     // percent 0-100, used when a product has no cost data
  "shippingPerDeliveryCents": 0,       // what CELLEXIA pays per shipment
  "fulfillmentPerDeliveryCents": 0,    // pick/pack/3PL per shipment
  "paymentFeePercent": 0,              // e.g. 1.9 (percent of order value)
  "paymentFeeFixedCents": 0            // e.g. 30 per charge
}
```

Exports (exact):
- `interface CostModel { defaultMarginFraction: number; shippingPerDeliveryCents: number; fulfillmentPerDeliveryCents: number; paymentFeeFraction: number; paymentFeeFixedCents: number; configured: boolean }`
  (`configured` = the merchant saved the form at least once — drives the
  "set your costs" banners.)
- `getCostModel(shop: string): Promise<CostModel>` (parse + normalise + defaults)
- `productCogsCents(line: {priceCents: number; quantity: number}, meta: {unitCostCents?: number | null; grossMarginPercent?: number | null} | null, model: CostModel): number` — PURE.
  Precedence: `unitCostCents` (× quantity) → `grossMarginPercent` fraction →
  `model.defaultMarginFraction`.
- `orderContribution(input: {lines: Array<{priceCents: number; quantity: number; meta: {unitCostCents?: number | null; grossMarginPercent?: number | null} | null}>}, model: CostModel): OrderContribution` — PURE.
  `interface OrderContribution { revenueCents; cogsCents; shippingCents; fulfillmentCents; paymentFeeCents; contributionCents; contributionFraction }`
  Formula (LTGP per order): `contribution = revenue − COGS − shipping − fulfillment − (revenue×feeFraction + feeFixed)`.
  Never returns negative fraction below −1; guards revenue 0.
- `metaByProductId(shop, productIds: string[]): Promise<Map<string, {unitCostCents, grossMarginPercent}>>` — one query, GID/bare tolerant.

**Every profit number flows through `orderContribution`**: metrics
(recurringGrossProfit → rename semantics: gross profit = revenue − COGS;
contribution = full formula), cohorts (`contributionFraction`, profit bands,
`bestConfigurations`), forecast margins, retention
`maxRationalSaveCostCents`, pre-shipment ranking margin factor. No consumer
computes margin on its own anymore.

## 2. Forecast V2 — `app/services/analytics/forecast.server.ts` [owner: forecast]

- `interface ForecastOptions { model: "CONTRACT" | "SURVIVAL_TREND"; scenario: "BASE" | "CONSERVATIVE" | "OPTIMISTIC"; horizonWeeks: 4 | 13 | 26 }` (default CONTRACT/BASE/13)
- `computeForecast(shop: string, options: ForecastOptions): Promise<ForecastResult>` — on-the-fly for the UI;
  `runForecastJob(shop?)` still snapshots the default options nightly (rowsJson
  gains `meta: {options, computedAt, reliability}`).
- Models:
  - **CONTRACT** (existing engine): per-contract cycle simulation from churn
    risk, dunning state, skip/pause propensities; costs via `orderContribution`.
  - **SURVIVAL_TREND**: takes the shop's OBSERVED survival curve
    (`getSurvivalCurves`) and applies realised per-cycle retention to the
    active base — data-driven, ignores per-contract scores. When history is
    too thin (<2 completed cycles observed) it must say so and fall back to
    CONTRACT with a note in `reliability.reasons`.
  - Scenario multipliers applied to either model: CONSERVATIVE = churn/skip
    ×1.35, add-ons ×0.5; OPTIMISTIC = churn/skip ×0.75, add-ons ×1.15.
    BASE = ×1. Multipliers are exported constants.
- **Reliability estimator** — PURE, exported, unit-tested:
  `forecastReliability(input: {activeContracts: number; monthsOfHistory: number; completedCycles: number; productsWithCosts: number; productsTotal: number; cancelledObserved: number}): Reliability`
  `interface Reliability { grade: "LOW" | "MODERATE" | "HIGH"; score: number; /* 0-100 */ expectedErrorBand: string; /* "±40%" */ reasons: string[] }`
  Scoring guide: active<15 or months<2 → LOW (±50%); active≥15 & months≥3 &
  completedCycles≥30 → MODERATE (±25%); active≥40 & months≥6 &
  cancelledObserved≥10 & cost coverage≥60% → HIGH (±12%). Reasons are plain
  language ("Only 4 weeks of billing history — treat weeks 5+ as directional",
  "3 of 9 products have real cost data; profit lines use the default margin").

## 3. UI [owners: dashboard / analytics-ui]

- `app/services/analytics/insights.server.ts` [dashboard owner]:
  `buildInsights(current: ExecutiveMetrics, previous: ExecutiveMetrics, extras: {reliability: Reliability; costModel: CostModel; bestConfig?: BestConfiguration}): Insight[]`
  `interface Insight { tone: "positive" | "warning" | "neutral"; headline: string; detail?: string; linkTo?: string }` — max 5, ordered by importance,
  PURE and unit-tested (biggest mover, churn composition shift, best cohort,
  costs-unset warning, low-reliability note).
- Dashboard (`app._index.tsx`): insight strip on top; tiles grouped under
  Growth / Revenue & profit / Retention / Payment recovery; every tile gets
  `helpText` (plain-language "how this is computed") shown via Polaris
  Tooltip; deltas colored by BUSINESS direction (churn ↓ = green).
- Cohort heatmap (`app.analytics.tsx`): calendar month column headers, cohort
  size column, color legend, null cells render as blank "—" (never 0), hover
  title with exact value + cohort, a one-line reading guide, and metric/
  dimension switchers that preserve other params.
- Forecast tab: model + scenario + horizon selectors (links, not JS state),
  Reliability card FIRST (grade badge + reasons), then chart + ops table.
- New **Costs tab** in `app.analytics.tsx`: cost-model form (euros in the UI,
  cents in storage), per-product COGS editor (writes ProductMeta
  unitCostCents/grossMarginPercent — fraction stored, percent displayed),
  live example card showing the LTGP formula applied to a sample order.
  Dashboard + Analytics show a dismissible banner linking here while
  `costModel.configured` is false.
- Number formatting: `app/components/charts/format.ts` [dashboard owner] —
  client-safe `fmtMoney(cents, currency)`, `fmtPct(fraction, dp)`,
  `fmtDelta(...)`; every view uses these (no ad-hoc toFixed).

## 4. File ownership for the build

- **servers**: costModel.server.ts (new), metrics.server.ts, cohorts.server.ts,
  survival.server.ts, + margin-source switches in retention/cancellation.server.ts,
  retention/saveOffers.server.ts (params only), offers/preShipment.server.ts;
  tests for cost engine + touched formulas; app.settings.tsx NOT touched.
- **forecast**: forecast.server.ts, tests/analytics/forecast.test.ts.
- **analytics-ui**: app.analytics.tsx, app.analytics.export.tsx.
- **dashboard**: app._index.tsx, components/charts/*, insights.server.ts (new),
  format.ts (new), tests for insights.
Confirmed bugs from the debug pass are fixed by the agent owning the file.
