# INSTALL — Cellexia Subscriptions

Complete installation runbook. Follow the steps **in order**; each step assumes the
previous one succeeded. Audience: a Shopify developer who has never seen this
codebase, starting from the ZIP.

Related docs: [ARCHITECTURE.md](./ARCHITECTURE.md) (how it works),
[UPDATE.md](./UPDATE.md) (future releases), [OPERATIONS.md](./OPERATIONS.md)
(day-2 runbooks), [MIGRATION.md](./MIGRATION.md) (importing existing subscribers),
[TESTING.md](./TESTING.md) (E2E test plan), [KLAVIYO_SETUP.md](./KLAVIYO_SETUP.md)
(flows), [OFFER_PLAYBOOK.md](./OFFER_PLAYBOOK.md) (operator levers).

---

## Safe install: nothing goes live until you say so

**Installing this app makes zero visible changes to your live store.** A fresh
install starts in **Setup mode** and stays there until you press **Go live** on
the admin **Preview & launch** page. Concretely, while in Setup mode:

- The **buy-box widget renders hidden** for every visitor — you can add the
  theme block to your live theme immediately, nobody will see it.
- **No customer is ever charged or messaged**: the billing, dunning, reminder,
  gift, win-back and lifecycle jobs all skip themselves (each run is still
  logged, marked `skipped: setup_mode`), customer notifications are suppressed
  (only portal sign-in codes, operator alerts and import summaries go out), and
  no events are sent to Klaviyo — so no Klaviyo flow can fire.
- The **customer portal is closed** to the public (a friendly "not yet
  available" page) — only your own preview sessions get in.

That means the whole setup is safe to do on the production store, in any order,
over days if you like: sync selling plans (§9), add the theme block (§7),
configure Klaviyo (§8), import your existing subscribers
([MIGRATION.md](./MIGRATION.md)) — none of it touches a real customer until
go-live. When you are ready, the **Preview & launch** page lets you see the
widget and the portal exactly as customers will (visible only to you), then
flip the store live (§10).

---

## 0. Read this before anything else

### One deployment = one store (do not skip this)

This app is single-merchant by design: **each deployment (app process + its
database) serves exactly one store**. Background jobs — billing, dunning,
reminders — resolve "the shop" as the most recent active install in the
deployment's database.

> **Never install the same deployment on two stores** (e.g. the production
> store *and* a development store). The second install silently becomes the
> primary: jobs target it, and **renewal billing for the first store stops
> without any error**. This is the one mistake in this runbook with no
> guardrail — the safety is following this rule.

For the end-to-end test on a development store (§10a, item 10), stand up a
**separate, disposable deployment**: its own Partner app (§2), its own host app
(a second Fly app works, smallest size), its own database, its own secrets.
Tear it down after QA, or keep it as a permanent staging environment — either
is fine, as long as production has its own deployment that is installed on the
production store only, exactly once.

### The install at a glance

The full order of operations — each step is a section below:

1. Prerequisites in place (§1)
2. Create the Partner app, **request Subscriptions API + protected customer
   data access** and wait for approval (§2 — the most common install blocker)
3. Host the app + database; decide scheduler mode (§3)
4. Fill every environment variable (§4)
5. Apply database migrations (§5)
6. Link config, `npm run deploy`, install on the store (§6)
7. Add the theme block; verify the app proxy (§7) — safe on the live theme
8. Wire Klaviyo flows (§8)
9. Create + sync a selling plan; place a test subscription via preview (§9)
10. Full E2E on a **separate dev-store deployment** ([TESTING.md](./TESTING.md)),
    then the preview pass on production, then **Go live** (§10)

Nothing customers can see or feel happens until step 10's final click — see
"Safe install" above.

---

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| Node.js | **20.10+** (Node 22 LTS recommended; the production Dockerfile uses `node:22-alpine`) |
| Shopify Partner account | Needed to create the app — **free, open to merchants, no agency status required** (see §2-pre; create it under the brand's own email, not the developer's) |
| The store | Must be on a plan that supports subscriptions, with **Shopify Payments** (or another [supported gateway](https://shopify.dev/docs/apps/build/purchase-options/subscriptions)) active. The Subscriptions APIs refuse contract/billing mutations on unsupported gateways — PayPal-only stores cannot run this app. |
| Shopify CLI | `npm i -g @shopify/cli` (v3.x). Verify with `shopify version`. |
| PostgreSQL | v14+ in production. Locally: `docker compose -f docker-compose.dev.yml up -d` gives you one at `postgresql://cellexia:cellexia@localhost:5432/cellexia`. |
| Klaviyo account | With a **private API key** (full access to Events, Profiles, Lists). |

---

## 2. Create the app in the Partner Dashboard

### 2-pre. No Partner account? Create one — free, ~10 minutes, no agency required

A Shopify Partner account is **not** reserved for agencies: it is free, open to
anyone, and it is Shopify's intended home for a merchant's own private apps.
Being a single D2C brand is the normal case, not the exception.

1. Go to [partners.shopify.com](https://partners.shopify.com) → **Join** →
   sign up with a **company email owned by the brand** (e.g.
   `tech@cellexia.com`), organization name = the brand. Verify email, done —
   there is no vetting or fee.
2. **Ownership matters**: the Partner organization holds the app's Client ID /
   Client secret — the keys to subscription billing. It must belong to the
   brand, with the **developer invited as a team member**
   (Partner Dashboard → Team → Invite; scope their permissions to Apps).
   Do **not** let a freelancer or agency create the app inside *their* Partner
   org — if you ever part ways, your billing infrastructure lives in someone
   else's account.
3. Your store is unaffected: it does not "join" the Partner org and no
   collaborator access to the store is needed for this. The org is only where
   the app's credentials and configuration live; the install link from §6 is
   simply opened by anyone with store admin access.
4. Bonus: Partner accounts include free **development stores** — which is
   exactly what you need for the separate QA deployment required by §0 and
   §10a item 10.

### 2b. Create the app

1. Partner Dashboard → **Apps** → **Create app** → **Create app manually**.
   Name it `Cellexia Subscriptions`.
2. Distribution: **Custom distribution** — single store. Enter the store's
   `*.myshopify.com` domain. This app is built for exactly one merchant
   (`AppDistribution.SingleMerchant` in `app/shopify.server.ts`); do not choose
   public distribution.
3. Note the **Client ID** and **Client secret** (App settings page). These become
   `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`.

### 2a. CRITICAL — request protected API access **before** installing

Subscription contract mutations are gated. Without these approvals every
`subscriptionContract*` / `subscriptionBillingAttemptCreate` call fails with an
access error, and the app is dead on arrival:

1. **Subscriptions APIs**: App page → **App setup** (or **API access**) → section
   **Subscriptions** → **Request access**. Describe the use case:
   *"Private subscription app for our own store: sells auto-renewing skincare
   subscriptions via selling plans, manages contracts, and bills renewals with
   subscriptionBillingAttemptCreate."*
2. **Protected customer data access**: same page → **Protected customer data
   access** → request the **Protected customer data** level, plus the field-level
   permissions for **Name**, **Email**, **Phone**, **Address**. Give a concrete
   reason for each, e.g.:
   - Name/Email — "Customer portal login (OTP to the subscriber's email) and
     transactional subscription notifications."
   - Phone — "Optional SMS dunning/skip notifications."
   - Address — "Displaying and editing the subscription delivery address in the
     customer portal."
3. **`read_all_orders`** (optional): only needed if you will backfill analytics
   from orders older than 60 days. Request it under the same API access page; if
   granted, add `read_all_orders` to `SCOPES` in `.env` **and** to
   `[access_scopes]` in `shopify.app.toml` before deploying. If you skip it, the
   app still works — historical rollups just start from install date.

Approval is usually fast for custom apps on your own store, but do not proceed to
"place a test subscription" until the dashboard shows access granted.

---

## 3. Hosting

The app is one long-running Node web process + PostgreSQL. Anything that can run
a Docker container works. **Primary recipe: Fly.io.**

### Scheduler mode — read this first

- `SCHEDULER_MODE=internal` (default): a 60-second loop inside the web process
  runs billing, dunning, gifts, win-back, rollups (`app/lib/jobs/bootstrap.server.ts`).
  This **requires a single always-on machine**: on Fly that means
  `min_machines_running = 1` and `auto_stop_machines = false`. If the host scales
  to zero, renewals silently stop.
- `SCHEDULER_MODE=external`: the internal loop is disabled. You **must** point an
  external cron at `POST /api/jobs/run` with header `x-cron-secret: $CRON_SECRET`
  **every 5 minutes**. Use this on serverless/scale-to-zero hosts (Vercel-style
  platforms, Render free tier, autoscaling setups) — see §3c.

Job leases (`JobLock` table) make ticks safe even if two instances overlap, but
they do not create ticks — something must call the runner on time.

### 3a. Fly.io (primary)

Create `fly.toml` in the project root (the ZIP does not ship one because the app
name/region are yours):

```toml
app = "cellexia-subscriptions"
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "3000"
  NODE_ENV = "production"
  SCHEDULER_MODE = "internal"

[http_service]
  internal_port = 3000
  force_https = true
  # Internal scheduler needs an always-on machine:
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "60s"
    method = "GET"
    path = "/api/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

Then:

```bash
# 1. Create the Fly app without deploying yet
flyctl launch --no-deploy --copy-config --name cellexia-subscriptions

# 2. Database — either managed Fly Postgres:
flyctl postgres create --name cellexia-db --region lhr
flyctl postgres attach cellexia-db -a cellexia-subscriptions
#    ("attach" sets the DATABASE_URL secret automatically)
#    …or use Neon (https://neon.tech): create a project, then
# flyctl secrets set DATABASE_URL="postgresql://...neon.tech/cellexia?sslmode=require"

# 3. Secrets — every variable from .env.example that isn't in [env] above:
flyctl secrets set \
  SHOPIFY_API_KEY="<client id>" \
  SHOPIFY_API_SECRET="<client secret>" \
  SHOPIFY_APP_URL="https://cellexia-subscriptions.fly.dev" \
  SCOPES="read_customers,write_customers,read_orders,read_products,write_products,read_purchase_options,write_purchase_options,read_own_subscription_contracts,write_own_subscription_contracts,read_customer_payment_methods,write_customer_payment_methods,read_locales,read_markets,read_inventory,read_fulfillments,read_discounts" \
  APP_SIGNING_SECRET="$(openssl rand -hex 32)" \
  CRON_SECRET="$(openssl rand -hex 32)" \
  DEFAULT_TIMEZONE="Europe/London" \
  KLAVIYO_PRIVATE_API_KEY="pk_..." \
  KLAVIYO_API_REVISION="2025-01-15" \
  MAIL_PROVIDER="smtp" \
  MAIL_FROM="Cellexia <care@cellexia.com>" \
  SMTP_HOST="smtp.eu.example.com" SMTP_PORT="587" \
  SMTP_USER="..." SMTP_PASS="..."

# 4. Deploy (Docker build runs prisma generate + remix build; boot runs migrate deploy)
flyctl deploy
```

Your app host is `https://cellexia-subscriptions.fly.dev` — use it everywhere
`REPLACE_WITH_YOUR_APP_HOST` appears (§5).

### 3b. Railway / Render (alternatives)

- **Railway**: new project → Deploy from repo/ZIP → add a PostgreSQL plugin
  (injects `DATABASE_URL`) → set all remaining env vars → it builds the
  Dockerfile. Railway keeps one instance warm by default, so
  `SCHEDULER_MODE=internal` is fine on a paid plan. Set a health check on
  `/api/health`.
- **Render**: Web Service (Docker) + Render PostgreSQL. On the **free tier
  instances sleep — you must use `SCHEDULER_MODE=external`** + external cron
  (§3c). Paid "always on" instances can use internal mode.

### 3c. External cron (required for serverless / scale-to-zero hosts)

Set `SCHEDULER_MODE=external`, then create a job that POSTs every 5 minutes:

**cron-job.org**: create job → URL
`https://<your-app-host>/api/jobs/run` → schedule every 5 minutes → request
method POST → add header `x-cron-secret: <your CRON_SECRET>` → save. Enable
failure notifications.

**GitHub Actions** (`.github/workflows/cron.yml` in your own repo; store
`CRON_SECRET` as a repo secret):

```yaml
name: cellexia-scheduler-tick
on:
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch: {}
jobs:
  tick:
    runs-on: ubuntu-latest
    steps:
      - name: Tick
        run: |
          curl -fsS -X POST "https://<your-app-host>/api/jobs/run" \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
```

Note: GitHub schedule granularity can drift by a few minutes under load; for
billing-critical production, cron-job.org or the host's own cron is more punctual.

---

## 4. Configure environment

```bash
cp .env.example .env
```

Fill every variable:

| Variable | What it is |
|---|---|
| `SHOPIFY_API_KEY` | Client ID from the Partner Dashboard app page. |
| `SHOPIFY_API_SECRET` | Client secret from the same page. Also verifies webhook + app-proxy HMACs. |
| `SHOPIFY_APP_URL` | Public HTTPS base URL of your deployment (e.g. `https://cellexia-subscriptions.fly.dev`). No trailing slash. Must match `application_url` in `shopify.app.toml`. |
| `SCOPES` | OAuth scopes; keep in sync with `[access_scopes]` in `shopify.app.toml`. Only add `read_all_orders` if approved (§2a). |
| `DATABASE_URL` | PostgreSQL connection string. Append `?sslmode=require` for managed providers like Neon. |
| `APP_SIGNING_SECRET` | Signs magic links, portal sessions and OTP codes. Generate: `openssl rand -hex 32`. **Rotating it invalidates every outstanding magic link** — see [OPERATIONS.md](./OPERATIONS.md#secret-rotation). |
| `CRON_SECRET` | Shared secret for `POST /api/jobs/run`. Generate: `openssl rand -hex 32`. |
| `SCHEDULER_MODE` | `internal` (always-on host) or `external` (cron hits `/api/jobs/run`). See §3. |
| `DEFAULT_TIMEZONE` | IANA fallback timezone until the shop's own timezone is synced (e.g. `Europe/London`). |
| `KLAVIYO_PRIVATE_API_KEY` | Klaviyo private key (`pk_...`) with Events/Profiles/Lists full access. |
| `KLAVIYO_API_REVISION` | Klaviyo API revision date; ships as `2025-01-15`. Only change with a release that says so. |
| `MAIL_PROVIDER` | `smtp` in production. `console` prints emails to logs (local dev only — OTP codes appear in the server log). |
| `MAIL_FROM` | From header for OTP + fallback transactional email, e.g. `"Cellexia <care@cellexia.com>"`. Use a domain with SPF/DKIM configured. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Your transactional SMTP relay (Postmark, SES, Mailgun…). Port 587 STARTTLS. |
| `SMS_PROVIDER` | `none` — SMS goes out through Klaviyo flows. Only set if you wire a direct provider. |
| `NODE_ENV` / `PORT` | `production` / `3000` (must match the host's internal port). |

Secrets go into the host's secret store (e.g. `flyctl secrets set`), not into a
committed file. The `.env` file is for local development.

---

## 5. Database

Migrations ship in the ZIP under `prisma/migrations/`. Apply them:

```bash
npx prisma migrate deploy
```

(The Docker image runs this automatically on boot via `npm run docker-start` →
`npm run setup`, so on Fly/Railway/Render this happens for you. Run it manually
when pointing at a fresh DB from your laptop.)

For a **local scratch database** during development:

```bash
docker compose -f docker-compose.dev.yml up -d
# DATABASE_URL=postgresql://cellexia:cellexia@localhost:5432/cellexia
npx prisma migrate dev
```

`migrate dev` is for scratch DBs only — never run it against production.

---

## 6. Link the app config and deploy to Shopify

1. Open `shopify.app.toml` and replace **every** `REPLACE_WITH_YOUR_APP_HOST`
   with your real host (in `application_url`, the three `redirect_urls`, and
   `[app_proxy] url`). Leave `client_id` — the next step fills it.
2. Install dependencies and link:

   ```bash
   npm ci
   npm run config:link     # select your Partner org + the app you created in §2
   ```

   This writes your real `client_id` into `shopify.app.toml`.
3. Push the config + theme extension to Shopify:

   ```bash
   npm run deploy          # = shopify app deploy
   ```

   Because `include_config_on_deploy = true`, this registers the app URL,
   redirect URLs, **all webhook subscriptions**, and the app proxy — and uploads
   the `cellexia-buy-box` theme extension. Re-run it after any `shopify.app.toml`
   change.
4. Install on the store: Partner Dashboard → your app → **Distribution** (or
   **Test on development store**) → generate/open the install link for the store
   → approve the scopes.
5. Verify: Shopify admin → **Apps** → Cellexia Subscriptions. OAuth should
   complete without loops and the embedded Polaris admin (dashboard page) should
   load. The `shop.installed` event appears on the **Audit** page.

---

## 7. Theme setup (buy box + portal proxy)

1. Shopify admin → **Online Store → Themes → Customize** → open a **product
   template** → in the product information section click **Add block** → under
   *Apps*, add **"Cellexia Buy Box"**. Position it **above the buy buttons**.
   This is safe to do on the **live theme**: while the app is in Setup mode the
   block renders hidden for everyone — visitors see no change. You view it
   through a preview link from the **Preview & launch** page (§10).
2. Leave the theme's native buy buttons in place for now. Hide or replace them
   **only after** you have QA'd the buy box end-to-end (one-time purchase path,
   subscription path, frequency selector, price/savings display) via the
   preview pass — see [TESTING.md](./TESTING.md#10-preview-based-qa-pre-launch-on-the-live-store).
3. **App proxy check**: visit `https://<store-domain>/apps/cellexia` in a private
   window. While in Setup mode you should see the branded **"not yet
   available"** page, served on the store's own domain — that page *is* the
   proof the proxy works (after go-live the same URL renders the portal login,
   email → OTP). If you get a 404 or signature error, see Troubleshooting (§11).
4. **Buy-box design is configured in the app, not the theme**: the admin
   **Buy box designer** page picks one of six design presets and customizes
   layout, style and per-locale text, publishing to a shop metafield the block
   reads — so this one-time block add is the only theme change ever needed.
   Until you publish a design, the widget renders its classic v1.0.0 layout.

---

## 8. Klaviyo

1. Ensure `KLAVIYO_PRIVATE_API_KEY` and `KLAVIYO_API_REVISION` are set (§4).
2. Follow [KLAVIYO_SETUP.md](./KLAVIYO_SETUP.md) to create the metrics, flows
   (upcoming order, payment failed ladder, card expiring, cancel/save, win-back,
   gifts/milestones) and profile properties.
3. Events flow app → Klaviyo through a DB outbox with retries (`KlaviyoOutbox`),
   so a Klaviyo outage never breaks billing. Watch the outbox drain on the
   **Audit** page after your first test events.

---

## 9. First data — plans and a test subscription

1. In the embedded admin open the **Plans** page → **Create plan config**:
   name (e.g. "Cellexia Subscribe & Save"), pick products, frequencies in weeks
   (e.g. 4/6/8/10/12, default 8), first-order discount (default 20%), ongoing
   discount (default 10%) → save → **Sync to Shopify**. Sync status must go
   `PENDING → SYNCED`; on `ERROR`, the message is stored on the plan row (a
   common cause is missing Subscriptions API approval, §2a).
2. Open the **Preview & launch** page → **Storefront preview** → pick the
   product → open the preview link. The buy box should show the subscription
   option preselected with the savings badge. (In Setup mode the widget is
   hidden on the plain storefront — only the preview link reveals it, and only
   in your own browser.)
3. Place a test subscription with a [test card](./TESTING.md#test-cards)
   (dev store / Shopify Payments test mode: `4242 4242 4242 4242`) — add to
   cart from your preview session; checkout shows the recurring terms natively.
4. Watch the **Audit** page: `contract.created` (webhook `subscription_contracts/create`)
   should appear within seconds, and the contract shows on **Subscribers** with
   the correct next billing date.

---

## 10. Preview, then go live

Everything routes through the embedded admin's **Preview & launch** page — it
shows the current mode (Setup/Live), the go-live checklist, the preview tools
and the **Go live** button.

### 10a. Technical prerequisites

| # | Check | How to verify |
|---|---|---|
| 1 | All secrets set on the host | `flyctl secrets list` (or host equivalent) shows every var from §4 |
| 2 | Scheduler ticking | `GET https://<app-host>/api/health` returns 200 and reports a recent job tick; the **Audit**/JobRun log shows `billing_run` entries (in Setup mode these are recorded as skipped — that still proves the scheduler is alive) |
| 3 | Webhooks registered | Partner Dashboard → app → API health/webhooks shows the topics from `shopify.app.toml`; a test contract creation appears in Audit |
| 4 | Plans synced | Plans page: every active plan `SYNCED` |
| 5 | Theme block added | Buy box block on the product template (§7) — the Preview & launch checklist has a confirmation for this |
| 6 | Klaviyo flows live | Flows from [KLAVIYO_SETUP.md](./KLAVIYO_SETUP.md) set to Live (no events arrive until go-live — that is by design) |
| 7 | Dunning settings reviewed | Settings page → dunning ladder (`softRetryDays`, payday alignment, exhausted action) matches your policy |
| 8 | Alert emails set | Settings → alerts → `emailTo` contains real operator addresses |
| 9 | Import completed | [MIGRATION.md](./MIGRATION.md) run: dry-run clean, import done, 10 contracts spot-checked — imported subscribers are **not** billed or emailed while in Setup mode |
| 10 | Test renewal executed | On the **dev store, using its own separate deployment** (§0 — never install the production deployment on a second store): one contract billed by the scheduler end-to-end (attempt → order → `billing.order_created` event) |

### 10b. Preview pass (on the production store, invisible to visitors)

On **Preview & launch**:

1. **Storefront preview** — pick a product, open the generated preview link
   (`?cx_preview=<signed token>`, valid 7 days, reveals the widget only in your
   own browser session). Check the PDP widget (desktop + mobile), add to cart
   with a plan selected (the cart line shows the plan), continue to checkout
   (recurring terms shown natively). Real visitors see none of this.
2. **Portal preview** — one click creates a local-only **demo subscription**
   (never billed, never synced, invisible to analytics), or pick a real
   imported subscriber. The full portal opens with a "Preview mode" banner;
   every button works visually but **no action executes** — walk every screen
   including the cancel flow.
3. The full QA script for this pass is
   [TESTING.md §10](./TESTING.md#10-preview-based-qa-pre-launch-on-the-live-store).

Both previews tick their checklist items on the page automatically.

### 10c. Go live

Press **Go live**. The confirmation modal shows what will start (billing,
dunning, notifications, Klaviyo events, public portal, buy box visible).

**Overdue renewals**: if any imported/active contract has a next billing date
already in the past (typical after a migration — the app was dark while dates
came due), the modal lists them and offers **"shift overdue renewals"**:
instead of charging them all the moment you go live, their next billing dates
are spread over the next 3 days (shop timezone). Take the offer unless you
have a specific reason to charge immediately — going live should never cause a
burst of same-minute charges (or a burst of "your order is coming" emails).

Going live flips the `launch` setting and the `cellexia.launch_status` shop
metafield to `live`; the buy box appears on the storefront within minutes
(online-store rendering caches the metafield briefly) and the portal opens to
customers. The flip is logged on the Audit page (`admin.action` / `go_live`),
and can be reverted in an emergency — see
[OPERATIONS.md §14](./OPERATIONS.md#14-runbook--launch-mode).

---

## 11. Troubleshooting

**OAuth loop (install keeps redirecting).**
`SHOPIFY_APP_URL` must exactly equal `application_url` in `shopify.app.toml`
and the deployed host (https, no trailing slash, no path). After changing either,
re-run `npm run deploy` and reinstall. Also check the host clock (HMAC timestamps)
and that you're not fronting the app with anything that strips the
`Authorization` header.

**401 / signature error on `/apps/cellexia` (app proxy).**
The proxy request signature is computed with your **client secret** — if
`SHOPIFY_API_SECRET` doesn't match the Partner Dashboard value (e.g. after
rotating credentials), every proxy request 401s. Also confirm the `[app_proxy]`
URL in `shopify.app.toml` points at the **deployed** host and was pushed with
`npm run deploy`. Note the proxy is configured at deploy time; the Shopify admin
UI shows it under App setup → App proxy.

**Webhooks not arriving.**
Webhook subscriptions come from `shopify.app.toml` and are only (re)registered by
`npm run deploy` — deploying app code to Fly does **not** register webhooks. Check
Partner Dashboard → app → webhook delivery metrics for failures; a non-2xx from
`/webhooks` (bad HMAC → wrong `SHOPIFY_API_SECRET`, or 500s) causes Shopify to
retry then drop. The `WebhookReceipt` table / Audit page shows everything that
did arrive, including failures.

**`subscriptionBillingAttemptCreate` returns userErrors.**
Two usual suspects: (1) *payment method missing* — the contract has no vaulted
`CustomerPaymentMethod` (typical for imported contracts before payment migration;
see [MIGRATION.md](./MIGRATION.md#payment-methods)); the dunning engine will mark
it awaiting-customer and send a card-update link. (2) *access denied* — the
Subscriptions API approval (§2a) is missing or was requested after install;
re-check the Partner Dashboard and reinstall if scopes changed.

**Renewals fire at a strange hour / off by one day.**
All schedule math runs in the **shop's IANA timezone** (`Shop.ianaTimezone`,
synced from Shopify; fallback `DEFAULT_TIMEZONE`). `nextBillingDate` is stored in
UTC — a "4 Aug" renewal for a London shop is `2026-08-04T00:00:00+01:00` =
`2026-08-03T23:00:00Z` in the DB; that is correct, don't "fix" it. If dates look
wrong, check the shop timezone on the Settings page, not the DB values. DST
transitions are handled by `app/lib/dates.server.ts`; never do raw
`+ 7*24h` math around it.
