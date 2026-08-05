# DEPLOYMENT CHECKLIST — Cellexia Continuous Treatment

Follow top to bottom for a first production deployment. Every step has a
checkbox; most have a `verify:` line — do not advance past a failed verify.
Companions: [`RUNBOOK.md`](RUNBOOK.md) (ops detail), [`THEME-INTEGRATION.md`](THEME-INTEGRATION.md)
(theme QA), [`COMMUNICATIONS.md`](COMMUNICATIONS.md) (Klaviyo), [`CONFIGURABILITY.md`](CONFIGURABILITY.md) (where every knob lives).

---

## 1. Partner Dashboard

- ☐ Create the app in the Shopify Partner Dashboard (embedded; custom or public).
- ☐ Request **Subscriptions API access** (Partner Dashboard → your app → API access).
  The `read/write_own_subscription_contracts` and `read/write_purchase_options`
  scopes are gated behind this approval — without it the app installs but every
  selling-plan push and contract mutation fails.
  verify: API access shows Subscriptions **approved** before the first install.
- ☐ Request **Protected customer data access** (same API access page). Level + fields:
  - *Protected customer data* (app level) — reason: subscription contract mirror & lifecycle emails.
  - *Name* — contract mirror, portal greeting, CS console identification.
  - *Email* — portal magic-link login and Klaviyo lifecycle events (the app is inert without it).
  - *Address* — delivery address display and coarse acquisition geo (country/city/province/first-3-of-zip only; full zip is never stored).
  - *Phone* — the app reads the contract delivery address's phone (`deliveryMethod.address.phone` in `CONTRACT_FIELDS_FRAGMENT`) and re-sends it on contract split. Request it, or strip `phone` from the fragment.
  verify: fields show **approved**; on an unapproved app, webhooks/API return redacted customer fields on non-dev stores and magic-link email lookup silently gets `null` emails.
- ☐ Note the **Shopify Payments requirement**: subscription contracts only bill
  through Shopify Payments (PayPal Express/Authorize.net only in eligible regions).
  Confirm the production store runs Shopify Payments; on the dev store enable
  Shopify Payments **test mode** for §7.

## 2. Hosting & environment

- ☐ Provision: Node **>= 20.10** (`engines` pin in package.json), a **Postgres**
  database, an HTTPS domain (embedded admin + app-proxy HMAC require TLS), a
  process manager (systemd/pm2) and a scheduler able to run curl (cron/GitHub Actions/Fly machines).
  verify: `node --version` ≥ 20.10 on the host.
- ☐ Set the environment (matrix below; `.env.example` mirrors it):

| Var | Required | Production value / guidance |
| --- | --- | --- |
| `SHOPIFY_API_KEY` | yes | Client ID from the Partner Dashboard app. |
| `SHOPIFY_API_SECRET` | yes | Client secret from the Partner Dashboard app. |
| `SHOPIFY_APP_URL` | yes | `https://<app-host>` — must equal `application_url` in `shopify.app.toml`. |
| `SCOPES` | yes | Exact copy of `[access_scopes].scopes` from `shopify.app.toml`. |
| `DATABASE_URL` | yes | `postgresql://…` (§3). |
| `MAGIC_LINK_SECRET` | yes | `openssl rand -hex 32`. Falls back to `SHOPIFY_API_SECRET` if unset — always set it explicitly in prod. Rotating it invalidates outstanding magic links AND makes stored Klaviyo keys undecryptable (re-enter in admin). |
| `JOB_SECRET` | yes | `openssl rand -hex 32`; Bearer token for `POST /jobs/:job` (§6). |
| `NODE_ENV` | yes | `production`. |
| `SHOPIFY_APP_DISTRIBUTION` | no | App distribution mode read by `app/shopify.server.ts`: set `app_store` for a public App Store listing; unset/anything else = single-merchant (custom) distribution. Must match the Partner Dashboard distribution choice. |
| `PORT` | no | remix-serve listen port (default 3000); front with your TLS proxy. |
| `PORTAL_BASE_URL` | no | Customer-facing base URL for the portal; defaults to `SHOPIFY_APP_URL`. Rides into every Klaviyo email as `portalUrl`. |
| `PORTAL_SUPPORT_EMAIL` | no | Support address in portal footers/gates (default `care@cellexia.com`). |
| `PORTAL_FONT_BASE_URL` | no | CDN base for Gobold/Argumentum woff2; portal falls back to system fonts. |
| `PORTAL_SHOP` | no | Multi-shop installs only: which shop the portal login page serves. |
| `SHOP_CUSTOM_DOMAIN` | no | Only if OAuth runs on a non-`*.myshopify.com` domain. |

- The **Klaviyo private API key is NOT an env var** — it is entered per shop in
  Admin → Settings → Integrations and stored AES-256-GCM-encrypted (§5.2).
- ☐ **DANGER — never set `DEMO_MODE` (or `DEMO_SHOP`, `DEMO_MODE_DANGEROUS_OK`) in
  production.** `DEMO_MODE=1` bypasses Shopify admin auth entirely. The app
  refuses it when `SHOPIFY_APP_URL` is not localhost (`app/shopify.server.ts`)
  and runs with real auth — but treat its presence in a prod env file as an incident.
  verify: `grep DEMO_MODE` your production env → no matches.

## 3. Database

- ☐ `npm ci` (workspaces pull in extension deps).
- ☐ With the Postgres `DATABASE_URL` exported: `npm run setup:postgres`
  (Prisma generate + `migrate deploy` against `prisma/postgres/schema.prisma`).
  Never `migrate dev` in production.
  verify: `psql "$DATABASE_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"` → **30** (29 app tables + `_prisma_migrations`).

## 4. App config & deploy

- ☐ `npm run config:link` — selects the Partner app and writes its `client_id`
  into `shopify.app.toml` (replacing `REPLACE_WITH_CLIENT_ID`).
- ☐ Rewrite the placeholder URLs in `shopify.app.toml` to the production host:
  `application_url`, all three `[auth].redirect_urls`, and `[app_proxy].url`
  (`https://<app-host>/proxy`). Keep `prefix = "apps"`, `subpath = "cellexia"`.
  verify: `grep example.com shopify.app.toml` → no matches; `SHOPIFY_APP_URL` env matches `application_url`.
- ☐ Build and start the server: `npm run build`, then `npm run start`
  (remix-serve) under your process manager, behind TLS.
  verify: `curl -s https://<app-host>/jobs/ping` → HTTP 405 JSON (`"Use POST with Authorization…"`) — proves the app is up without leaking anything.
- ☐ `npm run deploy` (`shopify app deploy`). Because `include_config_on_deploy = true`
  this releases **config + extensions together**: scopes, all webhook
  subscriptions (API 2025-10, URI `/webhooks`), the app proxy, the
  `treatment-widgets` theme extension and the `customer-portal-link`
  customer-account extension. The toml is the source of truth — never hand-edit
  webhooks in the Dashboard.
  verify: Partner Dashboard → app → Versions shows the new version **Active**
  (the CLI prints the version page URL); re-run after ANY app-domain change so
  webhooks + proxy follow.

## 5. Store setup (in order — verify each before the next)

1. ☐ **Install the app** on the store via the Partner Dashboard install link;
   approve the scope grant.
   verify: the embedded admin opens (Dashboard/Subscribers render); no OAuth loop.
2. ☐ **Settings.** Admin → Settings → General: `currencyCode`, gift threshold;
   Admin → Analytics → Costs: cost model (margin %, shipping/fulfillment per
   delivery, payment fees) — every profit figure derives from this. Admin →
   Settings → Integrations: paste the Klaviyo Private API key (**Events: Full**
   access), tick *Enable Klaviyo delivery*, save. Then build the **15 suggested
   flows** listed on that screen (per `docs/COMMUNICATIONS.md`): welcome,
   first-charge-approaching, charge-completed, charge-failed-recovery,
   card-expiring, pre-shipment-window, pause-ending, milestone,
   cancellation-saved, cancellation-completed, **magic-link (build this one
   first — portal login emails depend on it)**, churn-risk-outreach,
   excess-inventory, back-in-stock, anniversary.
   verify: trigger a test event (request a portal sign-in link after §6's outbox
   cron is live) → metric "Cellexia Magic Link Requested" appears in Klaviyo.
3. ☐ **Treatment plans.** Admin → Treatment plans (`/app/plans`): create the
   plan configs (cadence rows, quantity→cadence defaults 1→4/2→8/3→12 wk);
   for Committed Treatment add entries with `committed: true`, **minDeliveries ≥ 2**
   (pushed as `billingPolicy.minCycles`) and a **higher** percentOff than the
   standard rows, named so the theme block finds them (default match: "commit").
   **Save & push to Shopify**, then **Assign products** to each config. If any
   product ever carried another subscription app's plans, **re-save the config**
   so the group gets the `appId: "cellexia"` stamp the widgets filter on.
   verify: on a product page, `{{ product.selling_plan_groups | map: 'app_id' | join: ', ' }}` includes `cellexia`; the widget shows YOUR percentages.
4. ☐ **Theme editor** (per `docs/THEME-INTEGRATION.md`): add the **Treatment
   choice** block on the product template (above `pdp__actions`) and **Cart:
   make it continuous** on the cart template; hide the theme's quantity stepper
   and `[sm-rc-add-to-cart]` button per-template; set per-market styles via the
   block's **market_styles** setting (e.g. `fr:max, us:ultra`); on **ultra**
   products hide the theme's own PDP price element (it would contradict the
   plan-price-is-the-price story); **remove/disable the Joy widget & app embed
   and detach products from Joy's selling plan groups** in Joy's admin —
   otherwise its plans stay purchasable through its own surfaces.
   verify: run the QA checklists in THEME-INTEGRATION.md (per style in use); no console errors on pages without blocks.
5. ☐ **Policy toggles.** Admin → Settings → General: enable the minimum
   pause/cancel window if desired (`{enabled, days}`, days 1–90; never gates CS/system paths).
   verify: a fresh test contract's portal hides pause/cancel inside the window.
6. ☐ **Widgets admin** (Admin → Widgets) — only if overriding theme block
   settings: per-market `{"style": …}` configs (market HANDLES, not country
   codes), `committed.*` overrides, copy overrides, experiments. Leave empty to
   let the theme settings rule.
   verify: `/apps/cellexia/api/widget-config?product_id=…` returns your override.

## 6. Cron — all 16 jobs

Every job: `POST https://<app-host>/jobs/<name>` with `Authorization: Bearer $JOB_SECRET`.
verify each: response is `{"ok":true,"job":"<name>",…}` (non-2xx or `"ok":false` → alert; `-f` makes curl exit non-zero for cron-level alerting).

| Job | Cadence | Copy-paste |
| --- | --- | --- |
| **`billing`** | **every 15 min — THE JOB THAT CHARGES SUBSCRIPTIONS.** Shopify never auto-bills app-owned contracts; without this line no recurring order is ever created. | `curl -fsS -X POST "$APP_URL/jobs/billing" -H "Authorization: Bearer $JOB_SECRET"` |
| `outbox` | every 5 min (magic links ride this; tokens live 30 min — tighter is better) | `curl -fsS -X POST "$APP_URL/jobs/outbox" -H "Authorization: Bearer $JOB_SECRET"` |
| `dunning-queue` | hourly | `curl -fsS -X POST "$APP_URL/jobs/dunning-queue" -H "Authorization: Bearer $JOB_SECRET"` |
| `pause-resume` | hourly | `curl -fsS -X POST "$APP_URL/jobs/pause-resume" -H "Authorization: Bearer $JOB_SECRET"` |
| `pre-dunning` | daily | `curl -fsS -X POST "$APP_URL/jobs/pre-dunning" -H "Authorization: Bearer $JOB_SECRET"` |
| `pre-shipment` | daily | `curl -fsS -X POST "$APP_URL/jobs/pre-shipment" -H "Authorization: Bearer $JOB_SECRET"` |
| `apply-add-ons` | daily, BEFORE the day's billing window | `curl -fsS -X POST "$APP_URL/jobs/apply-add-ons" -H "Authorization: Bearer $JOB_SECRET"` |
| `churn-scan` | daily | `curl -fsS -X POST "$APP_URL/jobs/churn-scan" -H "Authorization: Bearer $JOB_SECRET"` |
| `depletion-scan` | daily | `curl -fsS -X POST "$APP_URL/jobs/depletion-scan" -H "Authorization: Bearer $JOB_SECRET"` |
| `milestones` | daily | `curl -fsS -X POST "$APP_URL/jobs/milestones" -H "Authorization: Bearer $JOB_SECRET"` |
| `anniversaries` | daily | `curl -fsS -X POST "$APP_URL/jobs/anniversaries" -H "Authorization: Bearer $JOB_SECRET"` |
| `reconcile` | daily | `curl -fsS -X POST "$APP_URL/jobs/reconcile" -H "Authorization: Bearer $JOB_SECRET"` |
| `expire-cancel-sessions` | daily | `curl -fsS -X POST "$APP_URL/jobs/expire-cancel-sessions" -H "Authorization: Bearer $JOB_SECRET"` |
| `forecast` | weekly | `curl -fsS -X POST "$APP_URL/jobs/forecast" -H "Authorization: Bearer $JOB_SECRET"` |
| `prune` | weekly | `curl -fsS -X POST "$APP_URL/jobs/prune" -H "Authorization: Bearer $JOB_SECRET"` |
| `learning` | weekly | `curl -fsS -X POST "$APP_URL/jobs/learning" -H "Authorization: Bearer $JOB_SECRET"` |

- ☐ Install the ready-made crontab from RUNBOOK §6 (same 16 jobs, staggered times).
  verify: one manual run of each line above returns `{"ok":true…}`; a wrong token returns 401 (proves `JOB_SECRET` is actually set).
  verify (billing specifically): the `billing` response is `{"ok":true,…,"result":[…]}` — one per-shop summary (`due`, `attempted`, `skippedDunning`, `skippedStale`, `failed`) per shop with due contracts, an empty array when nothing is due yet. This is the revenue heartbeat; if the line is missing from the crontab the store takes first orders and never charges again.

## 7. First-week verification

- ☐ Place a **real test subscription** on the dev store (Shopify Payments test
  mode, test card `4242 4242 4242 4242`) through the Treatment choice widget.
  verify: order lands with a selling plan on the line.
- ☐ **Webhook arrival:** the contract appears in Admin → Subscribers within ~1 min
  (`subscription_contracts/create` → mirror row).
- ☐ **Acquisition captured:** the subscriber detail shows channel + geo
  (from `orders/create`: UTM→channel, country/city/province/zip3).
- ☐ **Magic link:** request a portal sign-in link → Klaviyo email arrives within
  the outbox cadence; the link opens the portal (30-min token window).
- ☐ **Recurring billing fires:** after the test subscription's
  `nextBillingDate` passes, confirm a `BillingAttempt` row appears for the
  contract (Admin → Subscribers → detail) and a new order lands in Shopify —
  proof the `billing` job (§6) is actually running and charging. No attempt
  row within an hour of the due date = the billing cron line is missing or 401ing.
- ☐ **Manual reconcile:** run the `reconcile` curl once; verify `{"ok":true…}`
  and no unexpected drift corrections in the result.
- ☐ **Dunning simulation (dev store/test mode only):** switch the test
  subscription's payment method to Shopify's test **decline** card
  `4000 0000 0000 0002`, let the next billing attempt fail (or trigger it from
  the CS console).
  verify: `DunningState` row appears (Admin → Dunning), "Cellexia Charge Failed" metric fires, retry ladder schedules `nextRetryAt`.
- ☐ **Audit chain:** Admin → Settings → Audit → run verification.
  verify: `{ok: true}` — any `brokenAtSeq` is sev-1 (RUNBOOK §7.3).
- ☐ **Outbox health:** Admin → Settings → Integrations → Outbox health.
  verify: `DEAD = 0`; oldest `PENDING` is younger than the outbox cadence.

## 8. Rollback & support

- **Kill a widget style per market instantly (no theme deploy):** Admin →
  Widgets → config targeting `{"markets": ["<handle>"]}` with
  `{"style": "choice"}` (or `committed.enabled: false`) — wins over the theme
  after the widget-config fetch. Theme-side fallback: edit `market_styles` in
  the theme editor. If the app itself is down, widgets fall back to Liquid
  defaults and keep selling — that is by design.
- **Pause jobs:** comment out crontab lines. Safe: jobs are idempotent, the
  outbox accumulates and drains on resume; only magic-link latency suffers
  (keep `outbox` running if at all possible).
- **Logs & audit:** app logs go to stdout (capture via your process manager /
  host drain); the append-only `AuditLog` (hash-chained) is browsable under
  Admin → Settings → Audit; re-run chain verification after ANY database restore.
- **CS override paths:** Admin → Subscribers → subscriber detail (CS console):
  pause/resume, skip, cadence change, add/remove product (with price override),
  cancel — all idempotent, all audited, never blocked by the customer policy
  window. Suspected double charge / mirror drift / Klaviyo outage: playbooks in
  RUNBOOK §8.
- **Contract data:** never hand-edit mirror rows — Shopify is the source of
  truth; fix drift with `reconcile`.
