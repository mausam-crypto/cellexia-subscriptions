# RUNBOOK — operating Cellexia Continuous Treatment

Audience: whoever deploys, schedules, monitors, and firefights this app.
Companion docs: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (contracts &
conventions), [`SAFEGUARDS.md`](SAFEGUARDS.md) (what protects us and where).

> **Deploying for the first time?** Follow
> [`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) top to bottom — it
> sequences the sections below (plus Partner Dashboard approvals, store setup
> and theme steps) into a single verified pass. This runbook is the reference
> behind it.

---

## 1. Environment

Copy `.env.example` → `.env` and fill in:

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | App credentials from the Partner Dashboard (written by `shopify app config link` / dev). |
| `SHOPIFY_APP_URL` | Public base URL of the deployed app. |
| `SCOPES` | Must match `[access_scopes]` in `shopify.app.toml` (list below). |
| `DATABASE_URL` | `file:./dev.sqlite` in dev; a Postgres URL in production (§5). |
| `MAGIC_LINK_SECRET` | Signs/encrypts portal tokens and secrets at rest. Generate: `openssl rand -hex 32`. Falls back to `SHOPIFY_API_SECRET` if unset — set it explicitly in prod. **Rotating it invalidates outstanding magic links and makes previously encrypted Klaviyo keys undecryptable (re-enter them).** |
| `PORTAL_BASE_URL` | Base URL customers use for the portal; defaults to `SHOPIFY_APP_URL`. |
| `JOB_SECRET` | Bearer token protecting `POST /jobs/:job`. Generate like `MAGIC_LINK_SECRET`. |

The Klaviyo private API key is deliberately **not** an environment variable:
it is entered per shop in **Admin → Settings → Integrations** and stored
AES-256-GCM-encrypted in `ShopSettings.klaviyoApiKeyEncrypted`
(`app/lib/crypto.server.ts`).

Optional variables (`PORT`, `PORTAL_SUPPORT_EMAIL`, `PORTAL_FONT_BASE_URL`,
`PORTAL_SHOP`, `SHOP_CUSTOM_DOMAIN`) are listed with guidance in
[`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) §2. **Never set
`DEMO_MODE` in a production environment** — it is a localhost-only admin-auth
bypass; the app refuses it on non-localhost `SHOPIFY_APP_URL` and logs an
error, but its presence in a prod env file should be treated as an incident
(`docs/DEMO-MODE.md`).

Node ≥ 20.10. Install with `npm install` (workspaces pull in extension deps).

## 2. Partner Dashboard app + config link

1. Create the app in the Shopify Partner Dashboard (type: custom or public,
   embedded).
2. Locally: `npm run config:link` (`shopify app config link`) — selects the
   Partner app and writes its `client_id` into `shopify.app.toml` (replacing
   `REPLACE_WITH_CLIENT_ID`).
3. **Before the first production deploy**, rewrite every
   `https://example.com` placeholder in `shopify.app.toml` to the real app
   host: `application_url`, all three `[auth].redirect_urls`, and
   `[app_proxy].url` (keep the `/proxy` path and `prefix`/`subpath`).
   `automatically_update_urls_on_dev` rewrites these only during
   `shopify app dev`; `shopify app deploy` pushes the toml **as-is**, so
   deploying with placeholders points OAuth and the app proxy at example.com.
   Verify: `grep example.com shopify.app.toml` → no matches.
4. `npm run dev` for development (the CLI tunnels and, because
   `automatically_update_urls_on_dev = true`, keeps `application_url` and
   redirect URLs current).
5. `npm run deploy` (`shopify app deploy`) to release. Because
   `include_config_on_deploy = true`, this pushes the **whole config** —
   scopes, webhook subscriptions, app proxy — together with the extensions.
   The toml is the source of truth; do not hand-edit webhooks in the
   Dashboard.

### Partner Dashboard access approvals (before the first real-store install)

Sequenced with verify steps in [`DEPLOYMENT-CHECKLIST.md`](DEPLOYMENT-CHECKLIST.md) §1; reference detail:

- **Subscriptions API access** — Partner Dashboard → Apps → *(this app)* →
  **API access** → "Subscriptions" → Request access. Development stores work
  without it; on live stores every `sellingPlanGroup*`, `subscriptionContract*`,
  `subscriptionDraft*`, `subscriptionBillingCycle*` and
  `subscriptionBillingAttemptCreate` call is rejected until approved.
- **Protected customer data** — same API access page, "Protected customer
  data access". Declare the app-level use (subscription contract mirror +
  lifecycle communications) **and each field the app reads**: **Name**
  (contract mirror, CS console), **Email** (portal magic-link login, Klaviyo
  events — the portal is unusable without it), **Address** (delivery address
  display/edit, coarse acquisition geo), **Phone** (read via the contract's
  delivery address and re-sent on contract split — request it, or strip
  `phone` from `CONTRACT_FIELDS_FRAGMENT`). Without approval, live-store
  webhook payloads and Admin API responses arrive with these fields
  **silently redacted**: contracts mirror with `null` emails, magic-link
  lookup never matches, and acquisition geo is empty — no errors anywhere.
- **`read_all_orders`** — *not* requested and not needed: all order reads stay
  inside Shopify's default 60-day window (reconcile looks back 30 days). If
  the reconcile lookback is ever raised past 60 days, request it here first.
- **Merchant-store prerequisites**: Shopify Payments active on the production
  store (subscriptions bill through Shopify Payments; PayPal Express /
  Authorize.net only in eligible regions); **new customer accounts** enabled
  (the `customer-portal-link` extension targets
  `customer-account.profile.block.render` / `customer-account.order-index.block.render`
  and never renders on classic accounts — storefront links through the app
  proxy still work); an Online Store 2.0 theme so the theme-extension blocks
  can be added in the theme editor.

### Scopes and why each one

From `[access_scopes]` in `shopify.app.toml`:

| Scope | Why |
| --- | --- |
| `read_customers`, `write_customers` | Customer email/identity for the contract mirror, portal magic links, and compliance (data request / redact) handling. |
| `read_orders` | Reconciliation stamps and add-on attribution from `orders/create`; acquisition attribution (origin order, first-order AOV). |
| `read_products`, `write_products` | `ProductMeta` sync (titles, availability via `products/update`) and assigning products to selling plan groups. |
| `read_purchase_options`, `write_purchase_options` | Create/update SellingPlanGroups from `SellingPlanConfig` (`pushSellingPlanConfig`). |
| `read_own_subscription_contracts`, `write_own_subscription_contracts` | The heart of the app: contract mirror sync, the draft-edit workflow, billing-cycle mutations, `subscriptionBillingAttemptCreate`. |
| `read_customer_payment_methods` | Card brand/last4/expiry on contracts (drives **pre-dunning**) and `customerPaymentMethodSendUpdateEmail`. |

If you change scopes: update both the toml and `SCOPES` in `.env`, deploy, and
merchants re-consent on next load (`app/scopes_update` webhook fires; its
handler refreshes the stored `Session.scope` for the shop and appends an
`APP_SCOPES_UPDATED` audit row).

## 3. Webhooks

All webhook subscriptions are **toml-declared** (`[[webhooks.subscriptions]]`,
API version `2025-10`, URI `/webhooks`) and registered by `shopify app deploy`
— there is no imperative registration code.

> **API version lifecycle.** The app runs Admin GraphQL + webhooks on
> `2025-10` (declared in `shopify.app.toml` and `app/shopify.server.ts`;
> the `app/graphql/*.ts` document headers mirror it). Shopify supports each
> version for ~12 months, so 2025-10 is safe until roughly **2026-10**. To
> bump: update `api_version` in `shopify.app.toml`, `ApiVersion.*` in
> `app/shopify.server.ts`, and the version comments in `app/graphql/*.ts`;
> review the target version's release notes against the documents in
> `app/graphql/`; run the test suite; then `npm run deploy` (webhook
> subscriptions follow the toml).

Topics:

- `subscription_contracts/create`, `subscription_contracts/update`
- `subscription_billing_attempts/success`, `…/failure`, `…/challenged`
- `customer_payment_methods/create|update|revoke`
- `orders/create`
- `products/update`
- `app/uninstalled`, `app/scopes_update`
- Compliance: `customers/data_request`, `customers/redact`, `shop/redact` —
  handled for real in `app/services/core/gdpr.server.ts` (export assembly,
  customer PII redaction, full shop purge; behaviour spec in SAFEGUARDS §13,
  operator playbook in §8.4 below)

`app/routes/webhooks.tsx` [core] authenticates with `authenticate.webhook`,
records `ProcessedWebhook` (unique `webhookId`) **before** doing work, and
skips already-processed deliveries — Shopify redeliveries are therefore safe.
Handlers are also individually idempotent, so a missed delivery is recovered
by the reconcile job (§7), never by manual replays with side effects.

## 4. App proxy (storefront ↔ app)

`shopify.app.toml`:

```toml
[app_proxy]
url    = "https://<app-host>/proxy"
prefix = "apps"
subpath = "cellexia"
```

So `https://<shop-domain>/apps/cellexia/<x>` → `<app-host>/proxy/<x>`. Used by:

- `proxy.api.widget-config` — widget enhancement data (cadence defaults,
  experiment assignment, copy overrides)
- `proxy.api.events` — widget telemetry (impressions/selections/conversions)
- `proxy.api.add-on` — storefront add-on attach to the customer's own
  contract (ownership enforced via `logged_in_customer_id`; catalog-side
  pricing only)
- `proxy.portal-link` — verified customer hand-off into the portal

All proxy routes authenticate with `authenticate.public.appProxy` (HMAC).
Customer identity comes **only** from `logged_in_customer_id` in the verified
proxy context — never from bare query params. If the proxy stops working after
a domain change, re-run `npm run deploy` so the proxy URL follows the app URL.

## 5. Database: SQLite (dev) → Postgres (prod)

The schema is deliberately portable: no native enums, no `Json` columns, money
as integers. Migration path:

1. Point `DATABASE_URL` at Postgres. The production schema and its baseline
   migrations are checked in under `prisma/postgres/`
   (`prisma/postgres/schema.prisma`) — do not hand-edit the provider in the
   SQLite `prisma/schema.prisma`.
2. In production run `npm run setup:postgres` (Prisma generate +
   `prisma migrate deploy` against `prisma/postgres/`) — never `migrate dev`.
   The plain `npm run setup` remains the SQLite/dev path.
3. Back up before every deploy that includes a migration. The `AuditLog`
   table is append-only evidence; treat it accordingly in retention policies.

## 6. Scheduling the jobs registry

Every recurring behaviour is exposed as `POST /jobs/:job` guarded by
`Authorization: Bearer $JOB_SECRET`. The route (`app/routes/jobs.$job.tsx`)
just dispatches to the owning service's `run*Job(shop?)`. Invoke from any
scheduler — cron on a VM, Fly machines, GitHub Actions schedules, etc.
Jobs are idempotent and safe to re-run; a duplicate invocation is cheap.

Exact invocation:

```bash
APP_URL="https://<app-host>"

curl -fsS -X POST "$APP_URL/jobs/billing"        -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/outbox"         -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/dunning-queue"  -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/pre-dunning"    -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/pre-shipment"   -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/churn-scan"     -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/depletion-scan" -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/milestones"     -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/anniversaries"  -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/forecast"       -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/reconcile"      -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/prune"          -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/apply-add-ons"  -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/pause-resume"   -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/expire-cancel-sessions" -H "Authorization: Bearer $JOB_SECRET"
curl -fsS -X POST "$APP_URL/jobs/learning"       -H "Authorization: Bearer $JOB_SECRET"
```

Recommended frequencies (and a ready-made crontab):

| Job | Owner | Cadence | Why |
| --- | --- | --- | --- |
| **`billing`** | core | **every 15 min** | **The job that charges subscriptions.** Shopify never auto-bills app-owned contracts — `runBillingJob` creates the first billing attempt of every due cycle. Without it, first orders succeed and no contract is ever charged again. |
| `outbox` | communications | **every 5 min** | Klaviyo delivery latency = customer-email latency (magic links ride this path). |
| `dunning-queue` | retention | **hourly** | Executes due retry steps; hourly keeps `nextRetryAt` precision without hammering. |
| `pre-dunning` | retention | **daily** | Card-expiry warnings; day granularity is enough. |
| `pre-shipment` | offers | **daily** | Opens the 3–7-day add-on window ahead of billing dates. |
| `churn-scan` | retention | **daily** | Snapshots churn scores, emits `HIGH_CHURN_RISK`. |
| `depletion-scan` | treatment | **daily** | Emits `LIKELY_EXCESS_INVENTORY` / `LIKELY_PRODUCT_SHORTAGE`. |
| `milestones` | treatment | **daily** | Detects & records treatment milestones. |
| `anniversaries` | treatment | **daily** | `SUBSCRIBER_ANNIVERSARY` events. |
| `forecast` | analytics | **weekly** | Recomputes the 13-week `ForecastSnapshot`. |
| `reconcile` | core | **daily** | Safety net for missed webhooks; re-syncs drifted contracts. |
| `prune` | analytics route → foundation | **weekly** | Deletes expired `IdempotencyKey` rows + expired magic-link tokens. |
| `apply-add-ons` | fulfillment | **daily** | Injects unapplied `AddOnItem` rows into contracts billing within the apply window (`settingsJson.addOnApplyDays`, default 3 d) — an add-on the customer was promised MUST become a real contract line before the charge. Run it BEFORE the day's billing window; pairs with `pre-shipment`. |
| `pause-resume` | retention-core | **hourly** | Emits the `PAUSE_ENDING` reminder ahead of `pausedUntil` and auto-resumes contracts whose pause has expired (dunning grace pauses excluded). Hourly keeps the "never indefinite" pause promise honest. |
| `expire-cancel-sessions` | retention-core | **daily** | Sweeps stale `IN_PROGRESS` cancellation sessions to `ABANDONED` — keeps the retention funnel report truthful and closes the stale-offer replay window. |
| `learning` | learning | **weekly** | Recalibrates churn calibration, dunning retry offsets, forecast propensities and depletion-usage suggestions from observed outcomes (`ModelState` versions; audit `learning.recalibrated`). |

```cron
*/15 * * * * curl -fsS -X POST "$APP_URL/jobs/billing"        -H "Authorization: Bearer $JOB_SECRET"
*/5 * * * *  curl -fsS -X POST "$APP_URL/jobs/outbox"         -H "Authorization: Bearer $JOB_SECRET"
0   * * * *  curl -fsS -X POST "$APP_URL/jobs/dunning-queue"  -H "Authorization: Bearer $JOB_SECRET"
15  6 * * *  curl -fsS -X POST "$APP_URL/jobs/pre-dunning"    -H "Authorization: Bearer $JOB_SECRET"
30  6 * * *  curl -fsS -X POST "$APP_URL/jobs/pre-shipment"   -H "Authorization: Bearer $JOB_SECRET"
45  6 * * *  curl -fsS -X POST "$APP_URL/jobs/churn-scan"     -H "Authorization: Bearer $JOB_SECRET"
0   7 * * *  curl -fsS -X POST "$APP_URL/jobs/depletion-scan" -H "Authorization: Bearer $JOB_SECRET"
15  7 * * *  curl -fsS -X POST "$APP_URL/jobs/milestones"     -H "Authorization: Bearer $JOB_SECRET"
30  7 * * *  curl -fsS -X POST "$APP_URL/jobs/anniversaries"  -H "Authorization: Bearer $JOB_SECRET"
0   8 * * *  curl -fsS -X POST "$APP_URL/jobs/reconcile"      -H "Authorization: Bearer $JOB_SECRET"
0   5 * * 1  curl -fsS -X POST "$APP_URL/jobs/forecast"       -H "Authorization: Bearer $JOB_SECRET"
0   4 * * 0  curl -fsS -X POST "$APP_URL/jobs/prune"          -H "Authorization: Bearer $JOB_SECRET"
0   6 * * *  curl -fsS -X POST "$APP_URL/jobs/apply-add-ons"  -H "Authorization: Bearer $JOB_SECRET"
30  * * * *  curl -fsS -X POST "$APP_URL/jobs/pause-resume"   -H "Authorization: Bearer $JOB_SECRET"
45  7 * * *  curl -fsS -X POST "$APP_URL/jobs/expire-cancel-sessions" -H "Authorization: Bearer $JOB_SECRET"
30  5 * * 1  curl -fsS -X POST "$APP_URL/jobs/learning"       -H "Authorization: Bearer $JOB_SECRET"
```

Alert on non-2xx responses from any of these (a `-f` curl exit code in cron is
the cheapest possible monitor).

### 6.1 Recurring billing (the `billing` job)

`runBillingJob` (`app/services/core/billingScheduler.server.ts` [core]) is
the revenue heartbeat — treat its cron line as tier-0 infrastructure.
Division of labour:

- **The scheduler owns FIRST attempts.** For every ACTIVE contract whose
  `nextBillingDate` has arrived it creates the first billing attempt of the
  cycle (cycle index = `successfulOrders + 1`, idempotency key
  `bill:<contractId>:<cycleIndex>`, plus Shopify's own `idempotencyKey`).
  It never re-attempts a cycle that already has any attempt row.
- **Dunning owns RETRIES.** Contracts inside a live dunning episode
  (`RETRYING` / `GRACE` / `FINAL_NOTICE`) are skipped — the retry ladder in
  `services/retention/dunning.server.ts` is the only thing that re-charges
  an unpaid cycle (keys carry an `:attempt` suffix).
- **Stale-schedule guard.** A contract more than 45 days overdue is NOT
  charged — a surprise catch-up charge months later is a chargeback machine.
  The run appends a `BILLING_STALE_SKIPPED` audit row instead. **Review
  these**: query `AuditLog` for `action = 'BILLING_STALE_SKIPPED'` (or watch
  the `skippedStale` count in the `BILLING_RUN` audit payload / job
  response); for each hit, decide with the customer in the CS console —
  reschedule `nextBillingDate` forward to resume billing, or cancel. Expect
  hits after any long scheduler outage and on back-book imports.

Every run with due contracts appends a `BILLING_RUN` audit row with the full
summary (`due`, `attempted`, `skippedExistingAttempt`, `skippedDunning`,
`skippedStale`, `failed`) — `failed > 0` sustained across runs means Shopify
mutations are erroring for specific contracts; read the job logs
(`"billing job failed for contract"`).

## 7. Monitoring & alerts

What to watch, in order of importance:

1. **Outbox `DEAD` count** — `OutboundEvent.status = 'DEAD'` (8 failed
   attempts). Anything > 0 means customer communications were dropped:
   ```sql
   SELECT COUNT(*) FROM "OutboundEvent" WHERE status = 'DEAD';
   ```
   Also watch `PENDING` age: if `MIN(nextAttemptAt)` is far in the past, the
   `outbox` job isn't running.
   Read `lastError`: rows with `lastError = 'klaviyo disabled'` were killed
   **immediately** (first outbox pass, not after 8 attempts) because the shop
   has no usable Klaviyo key — either it was never entered in
   **Admin → Settings → Integrations**, or the stored key no longer decrypts
   (`MAGIC_LINK_SECRET` changed since it was saved). This is expected on a
   fresh install until the key is entered; every event emitted in that window
   is dropped and must be redriven per §8.3 after configuring the key.
2. **Dunning `EXHAUSTED` rate** — `DunningState.phase = 'EXHAUSTED'` per week.
   A spike means the recovery ladder is failing (bad strategy config, Klaviyo
   flow broken, or a processor-side problem):
   ```sql
   SELECT COUNT(*) FROM "DunningState" WHERE phase = 'EXHAUSTED';
   ```
3. **Audit chain verification** — run `verifyAuditChain(shop)` (surfaced in
   **Admin → Settings → Audit**). Result must be `{ok: true}`; a `brokenAtSeq`
   is a sev-1 (tampering or a write-path bug). Verify weekly and after any
   database restore.
4. **Webhook replay skips & handler latency** — the replay guard logs skipped
   deliveries when a `webhookId` already exists in `ProcessedWebhook`.
   Occasional skips are normal (Shopify redelivers); a sustained surge means
   we're returning non-2xx from `/webhooks` and Shopify is retrying — check
   application logs.
   Shopify counts any delivery not acked within ~5 s as failed and retries.
   Our handlers do synchronous Shopify GraphQL work (contract sync), so a
   slow delivery **will** trigger a retry — the guard row written before
   processing makes that retry a fast 200 no-op while the original finishes,
   so retries are harmless. Two narrow loss windows remain: (a) the process
   dies mid-handler (the guard row survives, so the redelivery no-ops), and
   (b) the original run fails with a retryable error *after* a raced retry
   already returned 200 (Shopify considers it delivered and stops). Both are
   healed by the daily `reconcile` job — treat "mirror drift fixed by
   reconcile" log lines as this signature, not as a new bug.
   Also monitor table growth: `ProcessedWebhook` is **never pruned** by any
   job. Rows are small, but on a busy store clear old ones periodically —
   deliveries older than Shopify's ~4 h retry horizon can never replay:
   ```sql
   DELETE FROM "ProcessedWebhook" WHERE "processedAt" < <now - 30 days>;
   ```
5. **Billing failure rate** — `BillingAttempt.status = 'FAILURE'` ratio per
   day, segmented by `declineCategory`. `PROCESSOR_ERROR` spikes are Shopify /
   processor incidents, not customer problems — don't burn retries during one.
6. **Job liveness** — every job in §6 should be observed to run at its
   cadence (cron exit codes, or compare `ForecastSnapshot.computedAt`,
   `ScoreSnapshot.computedAt` freshness against expectations).
   A **401** from `POST /jobs/:job` means `JOB_SECRET` is unset on the server
   or doesn't match the scheduler's bearer token. Nothing else surfaces this:
   the server boots fine, and every scheduled behaviour (dunning retries,
   outbox delivery, auto-resume) silently stops. This is exactly why the
   cron lines use `curl -f` — make sure those exit codes actually page
   someone.
7. **Stuck in-progress idempotency rows** — a hard kill (OOM, `SIGKILL` at
   the end of a deploy grace period) mid-operation can leave an
   `IdempotencyKey` row with `resultJson IS NULL`. Until its `expiresAt`
   passes (default TTL 7 days) every retry of that operation throws
   "already in progress" — for a dunning step this reads as repeated
   transient failures and can close the episode early. After any unclean
   shutdown, check and clear:
   ```sql
   SELECT key, scope, "createdAt" FROM "IdempotencyKey"
   WHERE "resultJson" IS NULL AND "createdAt" < <now - 1 hour>;
   -- verify the operation really is not running, then:
   DELETE FROM "IdempotencyKey" WHERE key = '<stuck-key>';
   ```
   Only delete rows you have confirmed dead — deleting a live one removes
   the double-fire guard for that operation.

## 8. Incident playbooks

### 8.1 Suspected double charge

Design guarantee first: a billing attempt runs inside
`withIdempotency("bill:<contractId>:<billingCycleIndex>", …)` **and** carries a
Shopify-side `idempotencyKey` on `subscriptionBillingAttemptCreate`;
`BillingAttempt.idempotencyKey` is unique. A true double charge requires all
three to fail. To investigate:

1. Get the local contract id (Admin → Subscribers, or by
   `shopifyContractId`).
2. Pull the attempts:
   ```sql
   SELECT id, "shopifyBillingAttemptId", "idempotencyKey", status, "orderId",
          "amountCents", "attemptNumber", "isRetry", "occurredAt"
   FROM "BillingAttempt" WHERE "contractId" = '<id>' ORDER BY "occurredAt";
   ```
   Two `SUCCESS` rows with **different** `billingCycleIndex`-derived keys and
   different orders = two legitimate cycles (check `intervalWeeks` vs dates).
   Two rows with the same key cannot exist (unique constraint) — if the
   customer shows two orders for one cycle, compare `orderId`s in Shopify
   admin; one of them did not come from this app.
3. Check the idempotency record:
   `SELECT * FROM "IdempotencyKey" WHERE key = 'bill:<contractId>:<cycleIndex>';`
   — a stored `resultJson` proves the second invocation was replayed, not
   re-executed.
4. Read the contract's audit trail (the full change history):
   ```sql
   SELECT seq, "actorType", "actorId", action, "payloadJson", "createdAt"
   FROM "AuditLog"
   WHERE shop = '<shop>' AND "subjectType" = 'SubscriptionContract'
     AND "subjectId" = '<id>' ORDER BY seq;
   ```
5. If a genuine duplicate is confirmed (expected cause: manual charge made
   outside the app), refund in Shopify admin, note it via the CS console so it
   lands in the audit log, and file the root cause.

### 8.2 Missed webhooks (mirror drift)

Symptoms: a contract's status/next billing date in the admin doesn't match
Shopify; `successfulOrders` lags; dunning didn't trigger after a failure.

1. Run the safety net: `POST /jobs/reconcile` — `runReconcileJob` [core]
   re-syncs drifted contracts from Shopify (the mirror is never the source of
   truth; Shopify is).
2. For a single contract, any CS-console action triggers
   `syncContractFromShopify` on commit; the reconcile job covers the rest.
3. Check `ProcessedWebhook` for the delivery window — if webhooks stopped
   entirely (e.g. app URL changed without a deploy), re-run
   `npm run deploy` to re-register the toml subscriptions, then reconcile.
4. Do not hand-edit mirror rows. Fix by re-sync, never by UPDATE.

### 8.3 Klaviyo outage / bad API key

The app never blocks on Klaviyo: `emitLifecycleEvent` writes analytics + an
outbox row and returns. During an outage, `OutboundEvent` rows accumulate as
`FAILED` with backoff (`attempts`, `nextAttemptAt`, `lastError`) and the outbox
**drains automatically** when Klaviyo recovers — events under 8 attempts need
no action.

1. Confirm cause via `lastError` on recent rows.
2. If the key was rotated: update it in **Admin → Settings** (stored
   encrypted) and let the next outbox run pick it up.
3. After an extended outage, redrive anything that hit the `DEAD` wall:
   ```sql
   UPDATE "OutboundEvent"
   SET status = 'PENDING', attempts = 0, "nextAttemptAt" = CURRENT_TIMESTAMP
   WHERE status = 'DEAD' AND "createdAt" > '<outage-start>';
   ```
   The unique `dedupeKey` guarantees Klaviyo-side dedupe safety on redrive.
4. Mind time-sensitive events: a `MAGIC_LINK_REQUESTED` older than 30 minutes
   points at an expired token — the customer just requests a new link; no
   redrive value.

### 8.4 GDPR requests (operator playbook)

The webhooks do the mechanical part automatically
(`app/services/core/gdpr.server.ts`, behaviour spec in SAFEGUARDS §13); the
operator owes one manual step:

- **Data request (`customers/data_request`).** The handler logs the full
  export JSON — search the application logs for
  `"gdpr customer data request export"` (the audit log shows a
  `GDPR_DATA_REQUEST` row with the customer id and
  `{ordersRequested, contractsFound}` as your pointer to when it fired).
  **The operator must fulfil the request within 30 days**: retrieve the
  logged export, cross-check it against the customer's record in the CS
  console (Admin → Subscribers), and deliver it to the merchant/customer
  through the merchant's own support channel. The app deliberately emails
  nothing — it cannot verify the requester's address.
- **Customer redact (`customers/redact`).** Fully automatic and idempotent:
  PII is anonymised, financial records stay. Verify via the
  `GDPR_CUSTOMER_REDACTED` audit row (counts only). No operator action
  unless the counts look wrong for a customer known to have data.
- **Shop redact (`shop/redact`).** Fully automatic: arrives ~48 h after
  uninstall and purges every table for the shop except `AuditLog`. The final
  `GDPR_SHOP_REDACTED` audit row holds the per-table counts — that entry is
  the retention-policy evidence the purge ran.

## 9. Hosting & runtime (self-hosted server)

The production server is plain `remix-serve` (`npm run start` →
`remix-serve ./build/server/index.js`). What that implies, verified against
`@remix-run/serve` 2.16:

### 9.1 Process posture

- **Set `NODE_ENV=production` explicitly.** `npm run start` does not set it.
  Without it the server still works, but dev-only fallbacks (e.g. the portal
  dev cookie secret path) stop being guarded by the production checks.
- **Set `PORT` explicitly.** If `PORT` is unset, remix-serve asks `get-port`
  for 3000 — and if 3000 is busy it silently binds a **random free port**,
  which reads as "app deployed but LB health checks fail". Never rely on the
  default.
- `HOST` is optional; unset means bind all interfaces. Behind a reverse proxy
  on the same box, set `HOST=127.0.0.1` so the app is not reachable directly.
- Boot order: run `npm run setup:postgres` (§5) before `npm run start` on
  every deploy so migrations are applied by the release, not by the first
  request.
- Logs are single-line JSON on stdout/stderr (`app/lib/logger.server.ts`) —
  point your collector at the process output; there are no log files.

### 9.2 Reverse proxy / TLS

TLS terminates at your proxy; remix-serve speaks plain HTTP. Two facts that
bite:

- The Remix express adapter honours **`X-Forwarded-Host`** (or `Host`) for
  the hostname but does **not** honour `X-Forwarded-Proto` — express "trust
  proxy" is never enabled, so `request.url` inside loaders/actions is always
  `http://…`. Do not write proxy configs assuming the app sees `https`.
- Consequently every absolute URL the app hands out comes from env, not from
  the request: `SHOPIFY_APP_URL` and `PORTAL_BASE_URL` **must** be the exact
  public `https://` origins. The portal magic-link claim's CSRF origin check
  compares the browser's `Origin` header against `PORTAL_BASE_URL` — if that
  var is missing or wrong, every magic-link sign-in 403s behind a proxy.
- Proxy requirements: forward `Host` unchanged (or set `X-Forwarded-Host`),
  keep request buffering on (Shopify webhooks are small), and allow request
  bodies on `POST /webhooks` and `POST /jobs/*` without auth interference.
- Portal cookies are `Secure; HttpOnly; SameSite=Lax` unconditionally — fine
  behind TLS, and the reason a plain-HTTP deployment (no TLS proxy) can never
  work in production.

### 9.3 Health checks

- `GET /` returns 200 without touching the database or Shopify — safe and
  cheap as a load-balancer liveness check.
- `GET /jobs/<anything>` returns **405**, so it is *not* usable as an LB
  target (most balancers require 2xx/3xx); it does confirm the Remix handler
  is up if you're probing by hand.
- There is currently **no deep health endpoint** (nothing does `SELECT 1`).
  A wedged database shows up as failing requests, not as a failing health
  check. If your platform supports command probes, probe the DB directly;
  otherwise treat §7 item 6 (job liveness) as the de-facto deep check.

### 9.4 Graceful shutdown & deploys

- remix-serve installs `SIGTERM`/`SIGINT` handlers that call
  `server.close()`: no new connections, in-flight requests finish. There is
  no forced timeout — a long-running `POST /jobs/…` (learning, forecast,
  reconcile on a big store) holds the old process open until your platform's
  grace period expires and SIGKILLs it.
- Schedule deploys away from the §6 cron slots, or give the platform a
  generous grace period (≥ 60 s). A SIGKILL mid-job is safe for money
  movement (idempotency keys + Shopify-side keys) but can leave stuck
  in-progress idempotency rows — see §7 item 7 for the cleanup.

### 9.5 One instance or many?

- **On SQLite: exactly one process, ever.** The database is a local file;
  a second replica (or a separate "job runner" process on another host)
  cannot share it. Multi-instance requires the Postgres path (§5).
- **On Postgres the web tier may scale**, with these caveats, verified per
  job (all 16 registry jobs audited for concurrent duplicate runs):
  - Money-moving and contract-mutating steps (the `billing` scheduler's
    first attempts, dunning retries, add-on apply, pause auto-resume,
    cancels) are each guarded by `withIdempotency` plus compare-and-set
    writes — a duplicate concurrent run cannot double-charge or
    double-mutate; the loser records a skip. The billing scheduler
    additionally skips any cycle that already has an attempt row and
    carries a Shopify-side `idempotencyKey` on every attempt.
  - The outbox uses an optimistic lease claim; duplicate runs cannot
    double-send (and Klaviyo's `unique_id` dedupes the at-least-once edge).
  - Event-emitting scan jobs (churn, milestones, anniversaries, depletion,
    pre-shipment, pre-dunning) dedupe customer-facing sends via unique
    `dedupeKey`s; duplicates only add benign warehouse/audit noise (churn
    runs can write duplicate `ScoreSnapshot` rows; learning/forecast write
    an extra append-only version — latest wins).
  - **Still: point cron at ONE base URL.** Every job run is cluster-wide
    (it scans the whole DB), not per-instance — fanning the schedule out to
    each replica only multiplies Shopify API usage and audit noise.
  - The audit log serialises on `unique(shop, seq)` with 10 jittered
    retries. Cross-replica write bursts for one shop raise collision rates;
    keep the replica count modest (2–3) and watch for
    "could not acquire audit sequence" errors — sustained appearances mean
    you've outgrown this design, not that you should raise the retry cap.
