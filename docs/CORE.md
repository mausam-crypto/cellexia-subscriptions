# Core subscription service

Owner of: all Shopify Admin GraphQL documents (`app/graphql/*`), contract
operations, billing attempts, selling plan sync, webhooks, reconciliation and
staff RBAC.

## The contract-editing draft recipe

Shopify contracts detach from their selling plan at purchase, so every change
to a live subscriber goes through the draft workflow — implemented once in
`app/services/core/contracts.server.ts` and reused by every module:

1. `subscriptionContractUpdate(contractId)` → returns `draft.id`
2. Draft mutations as needed: `subscriptionDraftLineAdd` / `LineUpdate` /
   `LineRemove`, `subscriptionDraftUpdate` (cadence, delivery address),
   `subscriptionDraftDiscountAdd` (account credit = one-cycle fixed-amount
   manual discount, `recurringCycleLimit: 1`)
3. `subscriptionDraftCommit(draftId)`

No-draft paths: `subscriptionContractSetNextBillingDate` (delay, bring
forward, set date), `subscriptionBillingCycleSkip`/`Unskip`/`ScheduleEdit`
(skip next shipment), `subscriptionContractPause`/`Activate`/`Cancel`
(pause/resume/cancel), `subscriptionContractAtomicCreate` (split),
`customerPaymentMethodSendUpdateEmail` (secure card update — we never touch
card data).

After **every** commit the local mirror is refreshed via
`syncContractFromShopify`, which upserts `SubscriptionContract` +
`ContractLine` rows (status, nextBillingDate, delivery interval → weeks,
line pricing in cents, card summary). The mirror is the app's read model;
Shopify remains the source of truth.

**Interval mapping:** Shopify policies `{interval, intervalCount}` are stored
as `intervalWeeks`: WEEK = count, MONTH ≈ count × 4 (documented
approximation), YEAR = count × 52, DAY = ceil(count / 7). Writes back to
Shopify always use exact `WEEK` intervals.

## Idempotency keys

Every mutation runs inside `withIdempotency(key, scope, fn)`:

- **Billing:** `bill:<localContractId>:<billingCycleIndex>` — the same key is
  passed as `idempotencyKey` to `subscriptionBillingAttemptCreate`, so Shopify
  double-charges are impossible even across process crashes. Default 7-day TTL.
- **Contract edits:** `contract:<contractId>:<ACTION>:<args fingerprint>` with
  a 10-minute TTL — double-submits replay the stored result; a genuinely
  repeated edit later (e.g. qty 1 → 2 → 1 → 2) runs fresh after the window.
- Day-scoped keys for repeatable side effects (credit, payment-update email).

## Webhook replay protection

`POST /webhooks` → `authenticate.webhook` → insert `ProcessedWebhook`
(unique `webhookId` from the `X-Shopify-Webhook-Id` header); a duplicate
delivery is acknowledged with 200 and skipped. Handler errors:

- **Retryable** (transient infra, missing sync race): the guard row is
  deleted and 500 returned so Shopify redelivers.
- **Non-retryable** (Shopify `userErrors` — deterministic): logged and acked
  with 200 to avoid poison-message loops.

Handlers also dedupe their own effects (lifecycle events carry explicit
`dedupeKey`s, outcome recording tolerates repeats) since delivery is
at-least-once.

## Reconciliation

`runReconcileJob(shop?)` (`POST /jobs/reconcile`) compares the last 30 days of
local `SUCCESS` billing attempts against Shopify subscription orders
(`sourceName: subscription_contract` or `Subscription` tag):

- orders with no local attempt (missed webhook / drift)
- successful attempts whose order is missing on Shopify
- amount mismatches (cents-exact)

Discrepancies append an `AuditLog` row with action `RECONCILE_DISCREPANCY`
(payload lists the offending ids) and the job returns a per-shop summary.

## RBAC

`requireRole(sessionEmail, shop, ...roles)` throws a 403 `Response` unless the
email holds one of the roles; OWNER/ADMIN pass everything; empty role list =
any staff role. First-run seed: while a shop has zero `StaffRole` rows, any
authenticated session acts as OWNER so the installer can reach Settings.

## Selling plan versioning

`pushSellingPlanConfig` creates/updates the `SellingPlanGroup` (recurring
WEEK policies + PERCENTAGE pricing), writes `shopifyGroupId` and per-plan
`shopifyPlanId`s back into `plansJson`, bumps `version`, and snapshots the
full config into `SellingPlanConfigVersion` — existing subscribers are never
affected by plan edits, and each cohort's signup rules stay auditable.
