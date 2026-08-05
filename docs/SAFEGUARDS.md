# SAFEGUARDS — every non-negotiable, mapped to its implementation

This document is the compliance map: each operational safeguard from the
product spec, where it lives in code, and how to verify it. If you touch any
of these paths, this file must still be true afterwards.

| # | Safeguard | Implementation | Verify |
| --- | --- | --- | --- |
| 1 | Immutable hash-chained audit log | `app/services/audit.server.ts` + `AuditLog` | `verifyAuditChain(shop)` |
| 2 | Idempotent billing | `withIdempotency` + Shopify `idempotencyKey` | `IdempotencyKey` / `BillingAttempt` uniques |
| 3 | Duplicate-order prevention | Layered keys (see §3) | unique constraints hold |
| 4 | Webhook replay protection | `ProcessedWebhook` guard in `routes/webhooks.tsx` | replay a delivery → skipped |
| 5 | RBAC | `StaffRole` + `requireRole` | role matrix below |
| 6 | Manual CS override | Subscribers console → core contract functions | audit rows with `actorType=STAFF` |
| 7 | Contract change history | `AuditLog` by subject | query by `subjectType/subjectId` |
| 8 | Versioned selling-plan rules | `SellingPlanConfigVersion` snapshots | version rows per change |
| 9 | Market currency handling | `currencyCode` + integer cents everywhere | no float money anywhere |
| 10 | Inventory safeguards | forecast + eligibility + stock events | `ForecastSnapshot`, OOS events |
| 11 | Discontinued-variant handling | `products/update` webhook + swap flows | `ProductMeta.active`, swap offers |
| 12 | Bulk migration tooling | `syncContractFromShopify` as the import primitive | §12 |
| 13 | Data export & GDPR | analytics CSV + `services/core/gdpr.server.ts` | §13 |
| 14 | Monitoring | RUNBOOK §7 | alerts wired |
| 15 | Reconciliation | `runReconcileJob` [core], daily | RUNBOOK §8.2 |

---

## 1. Immutable, hash-chained audit log

`app/services/audit.server.ts` — `appendAudit(entry)` writes append-only
`AuditLog` rows. Each row's `hash` is a SHA-256 over the **previous row's
hash** plus all its own fields; `(shop, seq)` is unique, so the chain is
strictly ordered per shop and any mutation, deletion, or insertion breaks
every subsequent hash. `verifyAuditChain(shop)` recomputes the chain and
reports the first broken `seq`. Convention 4 in `ARCHITECTURE.md`: **every**
state-changing operation appends an entry — contract edits, billing actions,
save offers, CS overrides, settings changes. Actors are typed
(`SYSTEM | STAFF | CUSTOMER | WEBHOOK` from `~/types/domain`). Verification is
surfaced in Admin → Settings and should run weekly (RUNBOOK §7.3).

## 2. Idempotent billing

Two independent layers:

1. **App layer** — `app/services/idempotency.server.ts#withIdempotency(key,
   scope, fn)`. Billing keys are `bill:<contractId>:<billingCycleIndex>`. The
   first caller stores its result; replays return the stored result without
   re-running the side effect; a crashed-mid-flight run leaves a result-less
   row that *refuses* to double-fire (fail-closed). The unique-key race is
   handled (P2002 → replay or in-progress error).
2. **Shopify layer** — `subscriptionBillingAttemptCreate` is always called
   with an `idempotencyKey` (contract-editing recipe, `ARCHITECTURE.md`), so
   even a retried GraphQL call cannot create a second attempt on Shopify's
   side. `BillingAttempt.idempotencyKey` and
   `BillingAttempt.shopifyBillingAttemptId` are both unique in the mirror.

Keys expire after 7 days by default; the `prune` job clears expired rows —
long after any legitimate retry window for a billing cycle.

## 3. Duplicate-order prevention

Orders only come from billing attempts, so §2's layers are the primary
defence: one idempotency key per (contract, cycle) app-side, one
`idempotencyKey` per attempt Shopify-side, unique mirror constraints. On top:

- `SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS` is itself replay-guarded (§4), so a
  redelivered success webhook cannot double-increment `successfulOrders` /
  `totalRevenueCents`.
- `ORDERS_CREATE` stamps orders for reconciliation and add-on attribution, so
  an unexpected second order for a cycle is visible in daily reconcile rather
  than silently absorbed.

## 4. Webhook replay protection

`app/routes/webhooks.tsx` [core]: after `authenticate.webhook(request)`, the
handler inserts into `ProcessedWebhook` (unique `webhookId`) **before**
processing and returns early for already-seen ids. Shopify redeliveries (its
at-least-once delivery, or our slow 2xx) are therefore no-ops. Skips are
logged — a surge is a monitoring signal, not an error (RUNBOOK §7.4).

## 5. RBAC

`StaffRole` (`@@unique([shop, email])`) assigns one of the
`STAFF_ROLE_NAMES` from `~/types/domain`; enforcement is
`requireRole(session, ...roles)` in `services/core/rbac.server.ts` [core],
called by every admin route:

| Role | Access |
| --- | --- |
| `OWNER`, `ADMIN` | Everything, including settings, RBAC, plan configs |
| `CS_AGENT` | Subscriber console only (`app.subscribers.*`) |
| `ANALYST` | Read-only analytics (`app._index`, `app.analytics`) |

Role changes are settings changes → audited (§1).

## 6. Manual CS override

The subscriber console (`app.subscribers.tsx`, `app.subscribers.$id.tsx`)
gives CS agents the full set of core contract operations — quantity, variant
swap, add/remove line, dates, skip/delay/pause/resume, cadence, address,
payment-update email, account credit (one-cycle discount via the draft
workflow), merge/split, cancel. There is no separate "override" code path:
CS actions go through the **same** `services/core/contracts.server.ts`
functions as the portal and autopilot, so they get idempotency, audit
(`actorType: "STAFF"`, `actorId: <email>`), event emission, and post-commit
re-sync for free. What CS can do is bounded by RBAC (§5), and everything CS
did is answerable from the audit trail (§7).

## 7. Contract change history

`AuditLog` doubles as the per-contract change history:
`@@index([shop, subjectType, subjectId])` makes
"every change to this contract, in order, with actor and payload" a single
indexed query (RUNBOOK §8.1 step 4 shows it). Because entries are
hash-chained, this history is evidence-grade — it cannot be quietly edited
after the fact. The subscriber detail page renders this trail.

## 8. Versioned selling-plan rules

Shopify semantics: contracts detach from their selling plan at purchase, so
"what rules did this cohort sign up under?" cannot be answered from Shopify.
`SellingPlanConfig.version` + `SellingPlanConfigVersion`
(`@@unique([configId, version])`, full JSON `snapshot`, `changedBy`) answer
it locally: `pushSellingPlanConfig` [core] bumps the version and appends a
snapshot on every rule change. Contracts additionally capture acquisition
context at creation (`acquisitionJson`, `initialDiscountPercent`,
`widgetVersion`), which is what cohort analytics segment on.

## 9. Market currency handling

Hard convention 1 (`ARCHITECTURE.md`): all money is integer minor units +
an explicit `currencyCode` — `ShopSettings.currencyCode`,
`SubscriptionContract.currencyCode`, and `*Cents` integer columns everywhere
(`totalRevenueCents`, `currentPriceCents`, `unitCostCents`, `saveCostCents`,
forecast `revenueCents`/`marginCents`/`ciLowCents`/`ciHighCents`, …).
Formatting/rounding lives only in `app/lib/money.ts` (`formatMoney`,
`toCents`, `percentOff`). No floats carry money; no amount travels without
its currency. Forecast rows carry `market` so multi-market aggregation never
sums across currencies blindly.

## 10. Inventory safeguards

- **Forward visibility:** the weekly 13-week `ForecastSnapshot` [analytics] is
  per week/SKU/market with probability-adjusted units (skips, pauses,
  cancellations, failures, add-ons factored in) — the purchasing signal that
  prevents stockouts of contracted demand.
- **Live transitions:** `products/update` webhook refreshes `ProductMeta`
  availability and emits `PRODUCT_OUT_OF_STOCK` / `PRODUCT_BACK_IN_STOCK`
  lifecycle events for merchant/customer flows.
- **Offer eligibility:** pre-shipment add-on ranking
  (`offers/preShipment.server.ts#rankAddOnCandidates`) includes inventory as
  an input — the app does not upsell what it cannot ship; `ProductMeta.active`
  / `subscribable` gate widget and routine eligibility.

## 11. Discontinued-variant handling

When a product/variant is discontinued or deactivated:

1. `products/update` refreshes `ProductMeta` (title, availability, `active`).
2. Affected contract lines are migrated with
   `swapLineVariant(graphql, shop, contractId, lineId, newVariantGid)` [core]
   — draft workflow, audited, idempotent.
3. Customer-facing paths offer the swap in brand voice: the `PRODUCT_SWAP`
   save offer in the cancellation flow and the portal's change-product flow.
4. The compatibility graph (`CompatibilityEdge`) constrains what counts as an
   acceptable substitute (`REDUNDANT` edges are natural swap candidates;
   `SENSITIVITY_CONFLICT` edges are never offered).

## 12. Bulk migration tooling

For migrating an existing subscriber base (previous subscription app):
`syncContractFromShopify(graphql, shop, shopifyContractId)` [core] is the
import primitive — it builds/refreshes the full local mirror row from Shopify
truth, with audit and event emission built in. A migration is a loop over
contract GIDs (from a Shopify bulk query or CSV) calling it; re-running is
safe because sync is upsert-by-`shopifyContractId` and webhook-independent.
Origin metadata (`acquisitionJson`) can mark migrated cohorts so analytics can
separate them from organically acquired ones. Run `reconcile` after any bulk
import as a checksum.

## 13. Data export & GDPR

- **Analytics:** the analytics routes export CSV (cohort tables, forecast
  rows, executive metrics) for finance/ops consumption outside the app.
- **Compliance (GDPR):** the three mandatory topics are subscribed in
  `shopify.app.toml` and implemented in
  `app/services/core/gdpr.server.ts` [core] (dispatched from the webhook
  handlers, behind the §4 replay guard). What each one actually does:
  - **`customers/data_request` → `handleCustomersDataRequest`.** Assembles
    the customer's data from the local mirror — contracts (matched on the
    payload customer id in both gid and bare form) with their lines,
    delivery address, full **unredacted** acquisition record (the export is
    for the customer; PII is its purpose), plus billing-attempt and
    analytics-event counts — and logs the export JSON via `logger.info`
    (`"gdpr customer data request export"`). Appends exactly one audit row
    `GDPR_DATA_REQUEST` with `{ordersRequested, contractsFound}`. **Nothing
    is emailed and nothing is deleted** — the operator retrieves the logged
    export and fulfils the request within 30 days (RUNBOOK §8.4).
  - **`customers/redact` → `handleCustomersRedact`.** Anonymises PII while
    retaining financial records: every matched `SubscriptionContract` keeps
    its row, lines, billing attempts and revenue totals, but
    `customerEmail` and `deliveryAddressJson` are set to null and
    `acquisitionJson` is stripped of `referrer`, `utm`, `visitor`, the raw
    attribute snapshots (`raw`, legacy `custom`) and `geo.city/province/zip3`
    — `channel`, `device`, `geo.countryCode/country` and `schemaVersion`
    stay for aggregates, and a `redactedAt` timestamp is stamped
    (field-level map: DATA-DICTIONARY §1). `MagicLinkToken` rows for the
    customer are deleted; email-bearing keys are scrubbed from the
    customer's `AnalyticsEvent` payloads (rows and non-identifying fields
    stay). Idempotent — a redelivery redacts nothing new and its audit row
    says `alreadyRedacted`. Audit `GDPR_CUSTOMER_REDACTED` records **counts
    only**, never the redacted values. Not touched by design: `OutboundEvent`
    rows (transient delivery queue) and card metadata (last4/expiry, kept as
    financial-record context).
  - **`shop/redact` → `handleShopRedact`.** First appends a final
    `GDPR_SHOP_REDACTED` audit entry with per-table row counts, then deletes
    **every** row belonging to the shop across **every** model except the
    append-only `AuditLog`, child-before-parent, in a single transaction.
    `IdempotencyKey` rows (which carry no shop column) are swept by the
    contract / add-on / cancellation-session cuids embedded in their keys;
    any stragglers expire via the 7-day TTL + weekly `prune`.
- Uninstall cleanup stays separate: `app/uninstalled` deletes Session rows
  and disables Klaviyo, nothing more — full deletion waits for `shop/redact`
  (Shopify sends it 48 h after uninstall).
- The `AnalyticsEvent` warehouse plus `AuditLog` make any per-customer export
  reconstructible by `shopifyCustomerId` / subject queries.

## 14. Monitoring

Covered operationally in [`RUNBOOK.md`](RUNBOOK.md) §7: outbox `DEAD` count,
dunning `EXHAUSTED` rate, audit-chain verification, webhook replay skips,
billing failure rates by decline category, job liveness. The safeguard here
is that each critical failure mode has a **queryable residue** (status
columns, snapshots, log rows) rather than only ephemeral logs.

## 15. Reconciliation

`runReconcileJob(shop?)` [core], scheduled daily, is the standing safety net
for anything the webhook pipeline missed: it re-syncs drifted contracts from
Shopify (which is always the source of truth — the local mirror is a cache
with indexes, never an authority) and uses `ORDERS_CREATE` stamps to catch
order-level anomalies. Incident use: RUNBOOK §8.2. Design rule: drift is fixed
by re-sync, never by hand-editing mirror rows.
