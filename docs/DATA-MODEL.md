# DATA-MODEL — a narrated tour of `prisma/schema.prisma`

Read this next to the schema itself. Three conventions govern everything:

1. **No native enums, no native `Json`** — SQLite (dev) and Postgres (prod)
   share one schema. Enum-like fields are `String` and every value written to
   them MUST come from the const unions in `app/types/domain.ts`. `*Json`
   columns hold `JSON.stringify`'d payloads; parse them with
   `parseJson<T>(raw, fallback)` from the same file — never bare `JSON.parse`.
2. **Money is integer minor units** (`…Cents`) plus an explicit
   `currencyCode`. No float ever carries money.
3. **Shopify GIDs are stored verbatim**
   (`"gid://shopify/SubscriptionContract/1"`); local rows use cuid ids. Local
   ids are what cross-service function signatures pass around
   (`contractId` in `ARCHITECTURE.md` contracts = the local cuid).

The local database is a **mirror with indexes**, not an authority: Shopify is
the source of truth for contract state, and `syncContractFromShopify` /
`runReconcileJob` re-establish the mirror whenever there is doubt.

---

## Session & shop scaffolding

### `Session`
The stock `@shopify/shopify-app-session-storage-prisma` table (OAuth tokens,
online/offline sessions). Don't touch it directly; `app/shopify.server.ts`
owns it.

### `ShopSettings`
One row per shop: display `currencyCode` (default `EUR`), the Klaviyo toggle
plus the API key **encrypted at rest** (`klaviyoApiKeyEncrypted`, AES-256-GCM
via `lib/crypto.server.ts`), and a `settingsJson` grab-bag for shop-level
knobs (default autopilot guardrails, pre-dunning lead days, grace-period
rules). Anything that would otherwise become a one-off column starts life in
`settingsJson`.

### `StaffRole`
RBAC assignments: `(shop, email)` unique → `role` ∈ `StaffRoleName`
(`OWNER | ADMIN | CS_AGENT | ANALYST`). Enforced by
`requireRole` (`services/core/rbac.server.ts`).

## Selling plans & product knowledge

### `SellingPlanConfig`
The merchant-editable rule set from which the Shopify `SellingPlanGroup` is
generated (`shopifyGroupId` back-reference). `version` increments on every
rule change; `plansJson` holds the plan definitions and
`quantityDefaultsJson` the quantity→cadence defaults (shapes below). Because
contracts detach from selling plans at purchase, editing a config never
touches existing subscribers — which is exactly why versioning matters.

### `SellingPlanConfigVersion`
Append-only history: `(configId, version)` unique, full JSON `snapshot` of the
config at that version, `changedBy` (staff email or `"system"`). Answers
"which rules did this cohort sign up under?" forever.

### `ProductMeta`
Per-product knowledge that Shopify doesn't hold, keyed
`(shop, shopifyProductId)`:

- **Depletion inputs:** `unitContents` (g/ml per unit) + `defaultDailyUsage`
  (same unit/day) seed the depletion engine before behavioural signals exist.
- **Margin inputs:** `grossMarginPercent` (fraction, e.g. `0.78`) and
  `unitCostCents` feed contribution-margin math (forecast, save-offer caps,
  add-on ranking).
- **Routine inputs:** `timeOfDay` ∈ `TimeOfDay` (`AM|PM|BOTH`), `concern`
  slug, `heroRank` (1 = hero treatment — the starting point of graduated
  routine expansion).
- **Gates:** `subscribable`, `active` (kept current by the `products/update`
  webhook).

### `CompatibilityEdge`
A directed edge of the routine compatibility graph:
`(shop, fromProductId, toProductId, relation)` unique, `relation` ∈
`CompatibilityRelation` (`PAIRS_WITH | STAGGER | REDUNDANT |
ROUTINE_STEP_BEFORE | SENSITIVITY_CONFLICT`), weighted by `strength`.
Consumed by routine recommendation, add-on ranking, and swap eligibility
(never offer across a `SENSITIVITY_CONFLICT` edge).

### `RoutineTemplate`
A merchant-curated routine for a `concern`, with ordered `stepsJson` (shape
below). Templates are what `recommendRoutine` fits a customer's current
products against.

## The contract mirror

### `SubscriptionContract`
The central row — a local mirror of a Shopify subscription contract plus
everything the optimisation layer knows about it:

- **Identity/state:** `shopifyContractId` (unique), `shopifyCustomerId`,
  `customerEmail`, `status` ∈ `ContractStatus`
  (`ACTIVE | PAUSED | CANCELLED | EXPIRED | FAILED`), `currencyCode`,
  `intervalWeeks`, `nextBillingDate` / `nextDeliveryDate`,
  `deliveryAddressJson`.
- **Payment metadata:** `paymentMethodId`, card brand/last4/expiry — kept
  fresh by `customer_payment_methods/*` webhooks; expiry drives pre-dunning.
- **Running totals:** `successfulOrders`, `failedAttempts`,
  `totalRevenueCents` — maintained only by (replay-guarded) webhook handlers.
- **Treatment framing:** `treatmentStartedAt`, `pausedUntil`, `cancelledAt`,
  `cancelReason` ∈ `CancelReason`.
- **Denormalised scores:** `qualityScore`, `churnRiskScore`,
  `expectedLtvCents` — latest values for list filtering/sorting; full history
  lives in `ScoreSnapshot`.
- **Autopilot:** `autopilotEnabled` + `guardrailsJson` (shape below — the
  customer's hard limits on autonomous changes).
- **Acquisition attribution (immutable at create):** `acquisitionJson`,
  `originOrderId`, `firstOrderAovCents`, `initialDiscountPercent`,
  `widgetVersion` — the dimensions cohort analytics slice on.

Indexes match the hot paths: `(shop, status)`, `(shop, shopifyCustomerId)`,
`(shop, nextBillingDate)` (billing/pre-shipment/pre-dunning scans).

### `ContractLine`
One product line on a contract: Shopify line/product/variant ids, `title`,
`quantity`, `currentPriceCents`, and the selling plan it was purchased under
(`sellingPlanId`/`sellingPlanName` — historical record; remember the contract
is already independent of the plan). Has an optional 1:1 `DepletionEstimate`.

### `AddOnItem`
One-time or limited-run additions to upcoming deliveries: `mode` ∈
`AddOnMode` (`NEXT_ONLY | RECURRING | N_DELIVERIES`, with
`remainingDeliveries` counting down for the latter), `priceCents`, and
`source` (portal, pre-shipment email, cs-console) for attribution of the
recurring-AOV levers.

## Billing & dunning

### `BillingAttempt`
Mirror of every billing attempt: unique `shopifyBillingAttemptId` and unique
app-side `idempotencyKey` (`bill:<contractId>:<billingCycleIndex>`), `status`
∈ `BillingAttemptStatus` (`PENDING | SUCCESS | FAILURE | CHALLENGED`), the raw
processor `errorCode` plus its derived `declineCategory` ∈ `DeclineCategory`,
resulting `orderId`, `amountCents`, `attemptNumber`, `isRetry`. This table is
the evidence in any double-charge investigation (RUNBOOK §8.1).

### `DunningState`
One per contract (1:1): `phase` ∈ `DunningPhase`
(`NONE | PRE_DUNNING | RETRYING | GRACE | FINAL_NOTICE | RESOLVED |
EXHAUSTED`), the active `declineCategory`, `retryCount`, `nextRetryAt`
(indexed — the dunning-queue job scans it), `graceUntil`, and `historyJson`,
the full step timeline (shape below). Reset by `onBillingSuccess`, advanced by
`onBillingFailure` + `runDunningQueueJob`.

## Retention

### `CancellationSession`
One diagnostic cancellation funnel run: `reason` ∈ `CancelReason`,
free-text `reasonDetail`, `offersJson` (the offers actually presented — shape
below), `outcome` ∈ `CancelOutcome` (`IN_PROGRESS | SAVED | CANCELLED |
ABANDONED`), and the economics: `savedByOffer` ∈ `SaveOfferType`,
`saveCostCents`, and `maxSaveCostCents` — the profit-aware ceiling computed at
session start that caps what the save-offer engine may spend.

### `ScoreSnapshot`
Time series of engine outputs per contract: `kind` ∈ `ScoreKind`
(`QUALITY | CHURN_RISK | LTV`), `value`, and `factorsJson` — the feature
breakdown that makes every score explainable to a human. Latest values are
denormalised onto the contract.

## Treatment engine

### `DepletionEstimate`
1:1 with `ContractLine`: `estimatedDailyUsage`, `lastDeliveryAt`,
`unitsOnHand`, `predictedRunOutAt`, a `confidence` (0–1, starts 0.5), and
`signalsJson` — the log of behavioural signals that adjusted the estimate
(shape below). Written by `registerDepletionSignal`, scanned daily by
`runDepletionScanJob`.

### `AdherenceSurvey`
Sent surveys and their answers: `answersJson` keyed by `AdherenceQuestion`
(`STARTED_USING | USAGE_FREQUENCY | PRODUCT_REMAINING | DISCOMFORT |
DESIRED_CHANGE`), `sentAt` / `respondedAt`. Survey answers are one of the
depletion signals (`SURVEY_OVERRIDE`) and feed the quality score.

### `Milestone`
`(contractId, type)` unique — each milestone happens once: `type` ∈
`MilestoneType` (`TREATMENT_STARTED | FIRST_MONTH | NINETY_DAYS |
SIX_DELIVERIES | ONE_YEAR`), `rewardStatus` ∈ `MilestoneRewardStatus`
(`PENDING | GRANTED | NOTIFIED`), optional `rewardJson` describing the granted
benefit.

## Offers & experiments

### `WidgetConfig`
A configured widget instance: `widgetType` ∈ `WidgetType`
(`TREATMENT_CHOICE | QUANTITY_CADENCE | ROUTINE_BUILDER | POST_ONE_TIME |
CART_CONVERSION`), `targetingJson` (shape below), `settingsJson`
(widget-specific copy/settings overrides), `priority` (higher wins when
multiple configs target the same context), `active`, optional `experimentId`.
`resolveWidget` [offers] applies targeting priority + experiment assignment.

### `Experiment` / `ExperimentAssignment`
`Experiment.variantsJson` defines weighted variants (shape below); `status` ∈
`ExperimentStatus` (`DRAFT | RUNNING | COMPLETED`). `ExperimentAssignment`
pins a `subjectKey` (anonymous visitor token or Shopify customer id) to a
`variantKey`, `(experimentId, subjectKey)` unique — assignment is sticky and
race-safe by constraint.

## Analytics & outbound

### `AnalyticsEvent`
The local event warehouse: every `emitLifecycleEvent` call lands here
(`name` ∈ `LifecycleEvent`, optional `contractId`/`shopifyCustomerId`,
`payloadJson`). Indexed `(shop, name, occurredAt)` for funnel/metric queries
and `(contractId)` for per-contract timelines.

### `OutboundEvent`
The Klaviyo outbox (at-least-once with replay safety): unique `dedupeKey`
(hash of shop|name|contractId|payload, or caller-supplied), `profileEmail`,
`status` ∈ `OutboxStatus` (`PENDING | SENT | FAILED | DEAD`), `attempts`,
`lastError`, `nextAttemptAt` (indexed with status — the outbox job's scan
key). `DEAD` after 8 attempts; redrive procedure in RUNBOOK §8.3.

### `ForecastSnapshot`
Weekly output of the 13-week contract-level forecast: `horizonWeeks`
(default 13) and `rowsJson`, one row per week × SKU × market (shape below).
Snapshots are kept, not overwritten — forecast accuracy is itself measurable
by comparing old snapshots to what happened.

## Operational safeguards

### `AuditLog`
Append-only, hash-chained (see [`SAFEGUARDS.md`](SAFEGUARDS.md) §1):
`(shop, seq)` unique orders the chain; `prevHash`/`hash` link it;
`actorType` ∈ `ActorType` (`SYSTEM | STAFF | CUSTOMER | WEBHOOK`);
`(shop, subjectType, subjectId)` index makes it double as per-entity change
history.

### `IdempotencyKey`
Backing store for `withIdempotency`: unique `key`, `scope`, `resultJson`
(null = in-flight/crashed → fail-closed), `expiresAt` (pruned weekly).

### `ProcessedWebhook`
Webhook replay guard: unique Shopify `webhookId` + topic/shop, inserted
before processing.

### `MagicLinkToken`
Portal login tokens: only the SHA-256 `tokenHash` is stored (never the
token), 30-minute `expiresAt`, single-use via `usedAt`. Expired rows are
pruned weekly.

---

## JSON column shapes

`*Json` columns are `JSON.stringify`'d strings. Shapes below are written as
TypeScript. Access through the owning service's functions where one exists
(e.g. `cadenceDefaultForQuantity` for quantity defaults) rather than parsing
ad hoc in other modules.

### `SellingPlanConfig.plansJson`
Array of plan definitions the Shopify group is generated from:

```ts
Array<{
  name: string;            // e.g. "Every 4 weeks"
  intervalWeeks: number;   // delivery/billing interval
  percentOff: number;      // plan discount, e.g. 10
  shopifyPlanId?: string;  // gid://shopify/SellingPlan/... once pushed
}>
```

### `SellingPlanConfig.quantityDefaultsJson`
Quantity → default cadence in **weeks**. Top level is the shop-wide map;
per-product overrides are keyed by product GID under `byProduct`:

```ts
{
  [quantity: string]: number;          // e.g. {"1": 4, "2": 8, "3": 12}
  byProduct?: {
    [productGid: string]: { [quantity: string]: number };
  };
}
```

Only `offers/widgets.server.ts#cadenceDefaultForQuantity(config, productId,
qty)` should interpret this column — it resolves product override → shop map
→ nearest lower quantity.

### `SubscriptionContract.guardrailsJson`
Exactly the `AutopilotGuardrails` interface from `~/types/domain`:

```ts
{
  maxChargeCents: number | null;   // hard ceiling per charge; null = no cap
  askBeforeAdding: boolean;        // autopilot must propose, not act, for additions
  minIntervalWeeks: number | null; // never tighten cadence below this
  notifyDaysBefore: number;        // heads-up lead time before any autopilot change
}
```

### `WidgetConfig.targetingJson`
All fields optional; absent = no constraint:

```ts
{
  productIds?: string[];      // shopify product GIDs
  markets?: string[];         // market/country codes
  trafficSources?: string[];  // e.g. "paid", "organic", "email"
  returningOnly?: boolean;    // only returning visitors (widget E)
  intentBands?: string[];     // visitor-intent segments
}
```

### `Experiment.variantsJson`

```ts
Array<{
  key: string;          // variant key stored on ExperimentAssignment
  weight: number;       // relative traffic weight
  settingsJson: string; // stringified settings overrides merged over WidgetConfig.settingsJson
}>
```

(Note the nesting: `settingsJson` is itself a JSON string, mirroring the
widget's own settings column.)

### `ForecastSnapshot.rowsJson`
One row per week × SKU × market; all money integer cents:

```ts
Array<{
  weekStart: string;                 // ISO date, Monday of the week
  sku: string;
  market: string;
  contractedUnits: number;           // naive: every active contract ships
  probabilityAdjustedUnits: number;  // after P(success) etc.
  expectedSkips: number;
  expectedPauses: number;
  expectedCancellations: number;
  expectedFailedPayments: number;
  expectedAddOnUnits: number;
  revenueCents: number;
  marginCents: number;
  ciLowCents: number;                // confidence interval on revenueCents
  ciHighCents: number;
}>
```

### `DunningState.historyJson`
Full timeline of steps taken, append-only:

```ts
Array<{
  at: string;       // ISO timestamp
  action: string;   // DunningStep action: "RETRY" | "EMAIL" | "SMS" | "PORTAL_BANNER" | "PAUSE" | "CANCEL"
  channel?: string; // delivery channel where applicable
  outcome: string;  // e.g. "SUCCESS", "FAILURE", "SENT"
}>
```

### `DepletionEstimate.signalsJson`
Log of behavioural adjustments to the estimate:

```ts
Array<{
  at: string;          // ISO timestamp
  signal: DepletionSignal; // "EARLY_DELAY" | "BROUGHT_FORWARD" | "REPEATED_SKIPS"
                           // | "EXTRA_ONE_TIME_PURCHASE" | "SURVEY_OVERRIDE" | "DELIVERY_RECEIVED"
  adjustment: number;  // applied change (e.g. daily-usage delta or units credited)
}>
```

### `RoutineTemplate.stepsJson`
Ordered routine steps:

```ts
Array<{
  productId: string;   // shopify product GID
  role: string;        // step role slug, e.g. "cleanse", "treat", "protect"
  timeOfDay: TimeOfDay; // "AM" | "PM" | "BOTH"
  optional: boolean;
}>
```

### Other JSON columns (brief)

| Column | Shape |
| --- | --- |
| `ShopSettings.settingsJson` | Shop-level knobs: default guardrails, pre-dunning lead days, grace rules, `fontBaseUrl` (BRAND.md). Object, all keys optional. |
| `SellingPlanConfigVersion.snapshot` | Full JSON snapshot of the `SellingPlanConfig` row at that version. |
| `SubscriptionContract.deliveryAddressJson` | Shopify mailing-address object as returned by the Admin API. |
| `SubscriptionContract.acquisitionJson` | Attribution at creation: widget/experiment keys, traffic source, market, landing product. |
| `CancellationSession.offersJson` | `Array<{type: SaveOfferType; params: Record<string, unknown>; costCents: number}>` — offers presented. |
| `ScoreSnapshot.factorsJson` | `Record<string, number>` — per-feature contribution (matches `computeChurnRisk` / `computeQualityScore` return). |
| `AdherenceSurvey.answersJson` | `Partial<Record<AdherenceQuestion, string \| number \| boolean>>`. |
| `Milestone.rewardJson` | Reward descriptor, e.g. `{kind: "GIFT", productGid, note}` or `{kind: "CREDIT", amountCents}`. |
| `WidgetConfig.settingsJson` | Widget-specific copy/settings overrides (per-widget keys, owned by [offers]). |
| `AnalyticsEvent.payloadJson` / `OutboundEvent.payloadJson` | Event payload as passed to `emitLifecycleEvent` (also the Klaviyo event properties). |
| `AuditLog.payloadJson` | Free-form action detail; part of the hashed material — never rewrite. |
| `IdempotencyKey.resultJson` | Stringified return value of the guarded function (`null` while in flight). |
