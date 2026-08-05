# Cellexia Continuous Treatment — architecture

A Shopify subscription app built as a **continuous-treatment optimisation
system**: it maximises `recurring AOV × successful paid orders × gross margin`
across the whole subscriber lifecycle, not just recurring billing.

Stack: Remix (`@shopify/shopify-app-remix` v3) + Prisma (SQLite dev / Postgres
prod) + Polaris admin + theme app extension (storefront widgets) + customer
account UI extension + magic-link portal. All Shopify access is Admin GraphQL
(API version 2025-01); webhooks are declared in `shopify.app.toml`.

**Critical Shopify semantics:** a subscription contract becomes independent of
its selling plan at purchase. Editing a selling plan NEVER changes existing
subscribers — all subscriber changes go through the contract-editing draft
workflow (`subscriptionContractUpdate → draft mutations → subscriptionDraftCommit`)
or billing-cycle mutations. `SellingPlanConfig` is versioned so we always know
which rules each cohort signed up under.

## Directory map & module ownership

```
app/
  shopify.server.ts, db.server.ts, root.tsx, entry.server.tsx   [foundation]
  types/domain.ts          shared const unions & types           [foundation]
  lib/                     money, dates, logger, crypto          [foundation]
  services/
    events.server.ts       emitLifecycleEvent (everyone calls)   [foundation]
    audit.server.ts        appendAudit / verifyAuditChain        [foundation]
    idempotency.server.ts  withIdempotency                       [foundation]
    core/                  contracts, selling plans, billing,
                           webhooks, reconciliation              [core]
    offers/                widget config, eligibility, defaults,
                           experiments, pre-shipment offers      [offers]
    retention/             cancel flows, save offers, dunning,
                           churn scoring, pause/skip             [retention]
    treatment/             depletion, adherence, compatibility,
                           routines, milestones, quality score,
                           autopilot                             [treatment]
    analytics/             metrics, cohorts, survival, LTV,
                           forecasting                           [analytics]
    communications/        klaviyo client + outbox delivery      [communications]
    portal/                magic-link auth, portal session       [portal]
  routes/
    app.tsx (+nav)                                               [foundation]
    app._index.tsx         executive dashboard                   [analytics]
    app.analytics.tsx      cohorts / survival / forecast         [analytics]
    app.subscribers.tsx, app.subscribers.$id.tsx  CS console     [subscribers]
    app.plans.tsx          selling-plan configs + qty defaults   [offers]
    app.widgets.tsx        widget configs + experiments          [offers]
    app.retention.tsx      cancel-flow config + churn risk       [retention]
    app.dunning.tsx        retry strategies + recovery report    [retention]
    app.treatment.tsx      compatibility graph, routines,
                           adherence, depletion overrides        [treatment]
    app.settings.tsx       Klaviyo, RBAC, audit viewer,
                           reconciliation                        [communications]
    webhooks.tsx           all webhook topics, dispatch          [core]
    jobs.$job.tsx          scheduled-job runner                  [analytics]
    portal.*               customer portal (magic-link)          [portal]
    proxy.api.*            storefront widget APIs (app proxy)    [offers]
    proxy.portal-link.tsx  magic-link request from storefront    [portal]
extensions/
  treatment-widgets/       theme app extension (widgets A/B/E/F) [theme-ext]
  customer-portal-link/    customer account UI extension         [account-ext]
tests/                     vitest unit tests, per owner
docs/                      BRAND.md [foundation], others per owner
```

Owners must stay inside their files. Cross-service calls go through the
contracts below — import the module, never duplicate its logic.

## Hard conventions

1. Money = integer minor units (`amountCents`) + `currencyCode`. Use `lib/money`.
2. Enum-like DB strings MUST come from `~/types/domain` unions.
3. `*Json` columns hold `JSON.stringify` payloads; parse with `parseJson`.
4. Every state-changing operation appends `appendAudit(...)`.
5. Every operation that creates money movement or edits a contract runs inside
   `withIdempotency(key, scope, fn)`; billing attempt keys are
   `bill:<contractId>:<billingCycleIndex>[:<attempt>]` — the optional
   `attempt` suffix distinguishes deliberate re-attempts (dunning retries)
   for the same unpaid cycle.
6. Webhook handlers first record `ProcessedWebhook` (unique `webhookId`) and
   skip already-processed deliveries (replay protection).
7. Lifecycle events only via `emitLifecycleEvent` — never call Klaviyo direct.
8. Server-only modules end in `.server.ts`. Path alias `~/*` = `app/*`.
9. Shopify calls: `runGraphql(graphql, QUERY, variables)` +
   `assertNoUserErrors(...)` from `services/core/shopifyClient.server.ts`.
   GraphQL documents live in `app/graphql/*.ts` [core] as exported constants;
   other modules import from there.
10. Decision logic (scores, offer selection, retry strategy, forecast math,
    depletion math) is written as pure functions over plain inputs, separate
    from Prisma/Shopify I/O, and unit-tested in `tests/`.

## Cross-service contracts (exact exports)

`services/core/contracts.server.ts` [core]
- `syncContractFromShopify(graphql, shop, shopifyContractId): Promise<SubscriptionContract>`
- `updateLineQuantity(graphql, shop, contractId, lineId, quantity)`
- `swapLineVariant(graphql, shop, contractId, lineId, newVariantGid)`
- `addLineToContract(graphql, shop, contractId, {variantGid, quantity, priceCents?})`
- `removeLineFromContract(graphql, shop, contractId, lineId)`
- `setNextBillingDate(graphql, shop, contractId, date)`
- `skipNextShipment(graphql, shop, contractId)`
- `delayByWeeks(graphql, shop, contractId, weeks)`
- `bringForward(graphql, shop, contractId, date)`
- `pauseUntil(graphql, shop, contractId, resumeDate)`
- `resumeContract(graphql, shop, contractId)`
- `switchCadence(graphql, shop, contractId, intervalWeeks)`
- `updateDeliveryAddress(graphql, shop, contractId, address)`
- `sendPaymentUpdateEmail(graphql, shop, contractId)`
- `applyAccountCredit(graphql, shop, contractId, amountCents)` (one-cycle manual discount)
- `mergeContracts(graphql, shop, targetContractId, sourceContractIds)`
- `splitContract(graphql, shop, contractId, lineIdsToSplit)`
- `cancelContract(graphql, shop, contractId, reason, actor)`
  All: local cuid `contractId`, audit + event emission inside, return the
  refreshed local `SubscriptionContract`.

`services/core/billing.server.ts` [core]
- `createBillingAttempt(graphql, shop, contractId, {originTime?, billingCycleIndex})`
- `recordAttemptOutcome(shop, shopifyBillingAttemptId, outcome)` (from webhooks)

`services/core/sellingPlans.server.ts` [core]
- `pushSellingPlanConfig(graphql, shop, configId)` — create/update the Shopify
  SellingPlanGroup from a `SellingPlanConfig`, bump version + snapshot.
- `assignProductsToConfig(graphql, shop, configId, productGids)`

`services/retention/cancellation.server.ts` [retention]
- `startCancellationSession(shop, contractId): Promise<CancellationSession>`
- `submitReason(sessionId, reason: CancelReason, detail?)`
- `getOffersForSession(sessionId): Promise<SaveOffer[]>` — reason-specific,
  cheapest-first, capped by `maxRationalSaveCostCents`
- `acceptOffer(graphql, sessionId, offerType)` — executes via core contracts
- `finalizeCancellation(graphql, sessionId)` — actually cancels

`services/retention/dunning.server.ts` [retention]
- `categorizeDeclineCode(code: string | null): DeclineCategory`
- `strategyFor(category: DeclineCategory, isHighValue: boolean, graceDays?: number): DunningStep[]`
- `onBillingFailure(shop, contractId, errorCode)` / `onBillingSuccess(shop, contractId)`
- `runDunningQueueJob(shop?)`, `runPreDunningJob(shop?)` (card-expiry warnings)

`services/retention/churn.server.ts` [retention]
- `computeChurnRisk(features: ChurnFeatures): {score: number; factors: Record<string, number>}` (pure)
- `runChurnScanJob(shop?)` — snapshots scores, emits HIGH_CHURN_RISK

`services/treatment/depletion.server.ts` [treatment]
- `predictRunOutDate(input: {deliveredAt: Date; unitsDelivered: number; dailyUsage: number}): Date` (pure)
- `registerDepletionSignal(shop, contractLineId, signal: DepletionSignal, meta?)`
- `runDepletionScanJob(shop?)` — emits LIKELY_EXCESS_INVENTORY / LIKELY_PRODUCT_SHORTAGE

`services/treatment/routines.server.ts` [treatment]
- `recommendRoutine(shop, {concern, currentProductIds}): Promise<RoutineRecommendation>`
- `consolidationPlan(shop, shopifyCustomerId): Promise<{merge: boolean; targetContractId?, sourceContractIds: string[]}>`

`services/treatment/quality.server.ts` [treatment]
- `computeQualityScore(features: QualityFeatures): {score: number; factors: Record<string, number>}` (pure)

`services/treatment/milestones.server.ts` [treatment]
- `runMilestoneJob(shop?)` — detects & records milestones, emits TREATMENT_MILESTONE

`services/offers/widgets.server.ts` [offers]
- `resolveWidget(shop, params: {productId?, market?, trafficSource?, returning?, visitorKey?}): Promise<ResolvedWidget>`
  (`ResolvedWidget` = {widgetType, settings, experimentKey?, cadenceDefaults}) —
  applies targeting priority + experiment assignment.
- `cadenceDefaultForQuantity(config: SellingPlanConfig, productId: string, qty: number): number` (pure-ish)

`services/offers/preShipment.server.ts` [offers]
- `rankAddOnCandidates(inputs: AddOnRankingInputs): RankedAddOn[]` (pure; uses
  routine, purchase history, compatibility, margin, inventory, season, concern)
- `runPreShipmentJob(shop?)` — opens the 3–7 day window, emits PRE_SHIPMENT_WINDOW_OPEN

`services/analytics/metrics.server.ts` [analytics]
- `getExecutiveMetrics(shop, range): Promise<ExecutiveMetrics>`
- `getSurvivalCurves(shop, cohortBy?): Promise<SurvivalCurve[]>` (cancellation
  separated from payment failure)
- `getCohortTable(shop, dimension, metric): Promise<CohortTable>`

`services/analytics/forecast.server.ts` [analytics]
- `forecastContract(c: ContractForecastInput): ContractForecast` (pure:
  `P(success) × expected order value × expected margin`)
- `runForecastJob(shop?)` — aggregates 13 weeks by week/SKU/market into
  `ForecastSnapshot` incl. skips/pauses/cancels/failures/add-ons + CI.

`services/communications/klaviyo.server.ts` [communications]
- `processOutboxJob(shop?)` — delivers `OutboundEvent` rows (batched, retry
  with backoff, DEAD after 8 attempts), maps event names to
  `"Cellexia " + Title Case` metrics.
- `klaviyoEnabled(shop): Promise<boolean>`

`services/portal/auth.server.ts` [portal]
- `requestMagicLink(shop, email)` — always responds success (no enumeration);
  creates token (30 min, single-use), emits MAGIC_LINK_REQUESTED (Klaviyo
  delivers the email).
- `verifyMagicLinkAndCreateSession(request, token): Promise<Response>` (sets cookie)
- `requirePortalCustomer(request): Promise<{shop, shopifyCustomerId, email}>`
  (redirects to /portal/login when absent)

## Jobs registry (`/jobs/:job`, POST, `Authorization: Bearer $JOB_SECRET`)

`dunning-queue`, `pre-dunning`, `churn-scan` [retention] · `outbox`
[communications] · `milestones`, `depletion-scan`, `anniversaries` [treatment]
· `pre-shipment` [offers] · `forecast` [analytics] · `reconcile` [core] ·
`prune` (idempotency + expired tokens) [analytics route calls foundation fn].
Each service exports its `run*Job(shop?)`; the route just dispatches. Invoke
from any scheduler (cron, Fly machines, GitHub Actions…).

## Webhook flow [core]

`POST /webhooks` → `authenticate.webhook(request)` → replay guard
(`ProcessedWebhook` by `webhookId`) → dispatch by topic:
- `SUBSCRIPTION_CONTRACTS_CREATE/UPDATE` → `syncContractFromShopify`, capture
  acquisition attribution on create, emit SUBSCRIPTION_STARTED, initial
  quality score [calls treatment].
- `SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS` → `recordAttemptOutcome`, reset
  dunning [retention.onBillingSuccess], bump totals, CHARGE_COMPLETED,
  depletion DELIVERY_RECEIVED signal.
- `SUBSCRIPTION_BILLING_ATTEMPTS_FAILURE/CHALLENGED` → `recordAttemptOutcome`,
  `retention.onBillingFailure`, CHARGE_FAILED.
- `CUSTOMER_PAYMENT_METHODS_*` → update card metadata on contracts.
- `ORDERS_CREATE` → reconciliation stamp + add-on attribution.
- `PRODUCTS_UPDATE` → refresh `ProductMeta` titles/availability; emit
  PRODUCT_OUT_OF_STOCK / PRODUCT_BACK_IN_STOCK on inventory transitions.
- `APP_UNINSTALLED`, compliance topics → cleanup / data export / redact.

## Contract-editing recipe (core implements once, everyone reuses)

1. `subscriptionContractUpdate(contractId)` → returns `draft.id`
2. Draft mutations as needed: `subscriptionDraftLineAdd`, `subscriptionDraftLineUpdate`,
   `subscriptionDraftLineRemove`, `subscriptionDraftUpdate` (nextBillingDate,
   deliveryPolicy, billingPolicy, deliveryMethod/address),
   `subscriptionDraftDiscountAdd` (account credit as 1-cycle fixed discount)
3. `subscriptionDraftCommit(draftId)`
Billing-cycle actions (no draft): `subscriptionBillingCycleSkip`,
`subscriptionBillingCycleUnskip`, `subscriptionBillingCycleScheduleEdit`.
Status: `subscriptionContractPause`, `subscriptionContractActivate`,
`subscriptionContractCancel`. Billing: `subscriptionBillingAttemptCreate`
(always with `idempotencyKey`). Payment: `customerPaymentMethodSendUpdateEmail`.
After every commit, re-`syncContractFromShopify` so the local mirror is truth.

## Storefront ↔ app data flow

Theme extension widgets render from Liquid (selling plans come from the
`product` object — zero-latency, no API needed for first paint). Enhancement
data (variable cadence defaults, experiment assignment, copy overrides) is
fetched client-side from `/apps/cellexia/api/widget-config?product_id=…`
(app proxy → `proxy.api.widget-config.tsx`, verified via
`authenticate.public.appProxy`). Widget telemetry (impressions, selections,
conversions) posts to `/apps/cellexia/api/events`. Cart conversion (widget F)
uses `POST /cart/change.js` with `selling_plan` client-side only.

## Security

Admin routes: `authenticate.admin`. Webhooks: `authenticate.webhook`. Proxy
routes: `authenticate.public.appProxy` (HMAC-verified; never trust bare query
params for identity — use `logged_in_customer_id` from the verified proxy
context for customer identity on storefront calls). Portal: signed cookie
session established only via magic link or a verified proxy hand-off. Jobs:
bearer `JOB_SECRET`. RBAC via `StaffRole` (OWNER/ADMIN full, CS_AGENT
subscriber console only, ANALYST read-only analytics); helper
`requireRole(session, ...roles)` lives in `services/core/rbac.server.ts` [core].
