# Manual deploy guide — Cellexia Subscriptions

For when a new update ZIP arrives and no one is available to run it through
Claude. **Read this whole file before touching anything** — this app handles
real recurring billing and vaulted payment methods; mistakes here are higher
stakes than in the other three apps in this family.

## 0. Where everything lives

| Thing | Value |
|---|---|
| Canonical working copy | `cellexia-apps/cellexia-subscriptions/cellexia-subscriptions` |
| GitHub | `github.com/mausam-crypto/cellexia-subscriptions` (branch `master`) |
| Render service | `cellexia-subscriptions` → `cellexia-subscriptions.onrender.com` — **paid/always-on plan (`starter`), not free.** The billing scheduler (`SCHEDULER_MODE=internal`) runs a 60-second loop inside this process; a sleeping free-tier instance would silently stop renewals with no error. |
| Render database | `cellexia-subscriptions-db` (Postgres, free plan is fine for the DB itself) |
| Shopify Partner org | Cellexia Ltd |
| Client ID | `59c7f4893e8491dc5f6a047fcc6ccd08` |
| App proxy subpath | `apps/cellexia-subscriptions/*` — the export's own default template ships plain `cellexia`, which collides with the AOV app. See §3. |
| Live store | Installed on `cellexia-labs.myshopify.com`. |

## 1. THE rule — read this before anything else

**This app is single-merchant by design: one deployment (this Render
service + its database) serves exactly one store.** Never install this same
deployment on a second store (e.g. a dev store for testing) — the second
install silently becomes primary, and **renewal billing for the first store
stops with no error at all.** There is no guardrail against this; the only
protection is not doing it. If you ever need a disposable test deployment,
stand up a completely separate one: its own Partner app, its own Render
service, its own database, its own secrets.

## 2. Before touching anything

```bash
cd cellexia-subscriptions/cellexia-subscriptions
git status --short      # must be empty
ls shopify.app*.toml     # must show exactly ONE file
```

## 3. Diff against the last real update, not this repo

Same reasoning as every app in this family — this folder already has fixes
applied, so a raw diff against it is noisy. Diff the new ZIP against the
previous update ZIP if you still have it:

```bash
diff -rq /path/to/previous-update/... /path/to/new-update/... \
  --exclude=node_modules --exclude=.git --exclude=build --exclude=dist \
  --exclude=.env --exclude=".shopify" --exclude="shopify.app.toml" --exclude="render.yaml"
```

Read `CHANGELOG.md` (and `docs/UPDATE.md` if it has version-specific notes)
in full before merging anything.

## 4. The proxy-path collision — check this on EVERY update

The export's own template defaults to `/apps/cellexia/*`, which collides
with the AOV & LTV Booster app already on this store. Every update needs a
full search:

```bash
grep -rn "apps/cellexia\b" app/ extensions/ | grep -v "cellexia-subscriptions"
```

Known repeat offenders — fix every one, not just the obvious file:

- `app/lib/cancel/config.server.ts` → `PROXY_PUBLIC_BASE`
- `app/lib/portal/session.server.ts` → `PORTAL_BASE_PATH` (this is the
  customer's portal-login session cookie path — get this wrong and
  customers can't stay logged into the portal)
- `app/lib/magiclinks/builder.server.ts` → the URL builder used for every
  skip/delay/pause/card-update link sent by email
- `app/lib/portal/layout.server.ts` — has two separate hardcoded spots (a
  cookie-setting string AND a `base` constant)
- `extensions/cellexia-buy-box/assets/buy-box.js` → `PREVIEW_VALIDATE_PATH`
  (and check any new JS files the update adds for the same fallback string)
- `shopify.app.toml`'s `[app_proxy] subpath` — **never overwrite this file
  at all** (see §6), but if the export's placeholder-riddled toml is ever
  used as a reference, this is why the subpath in it is wrong.

## 5. The literal-brace Liquid bug — check every buy-box liquid/snippet file

If you see a pattern like:

```liquid
{{ 'subscribe_save_percent' | t: percent: '{percent}' }}
```

this is a genuine Liquid **syntax** error, not a lint nit — `shopify app
deploy` will reject the whole bundle with "Variable ... was not properly
terminated." It has recurred across releases as the widget's markup got
refactored into new files (block → shared snippet). Fix by building the
placeholder via string concatenation instead of a literal brace inside the
`{{ }}` tag:

```liquid
{%- assign cx_pct_placeholder = '{' | append: 'percent' | append: '}' -%}
{{ 'subscribe_save_percent' | t: percent: cx_pct_placeholder }}
```

Search for it before every deploy attempt:

```bash
grep -rn "{{ '.*'.*{.*}.*}}" extensions/cellexia-buy-box/
```

(Ignore matches that are just multiple plain `{{ 'x' | t }}` calls
concatenated with `||` — those don't have the bug, only ones passing a
literal `'{something}'` string as a filter *argument* do.)

## 6. Files that will look "changed" but are NOT — never copy these over

- **`Dockerfile`** — the export ships `ENV NODE_ENV=production` *before*
  `RUN npm ci`, then uses either `npm ci --omit=dev` or plain `npm ci` with
  that env var already set. **Either way, npm treats `NODE_ENV=production`
  as an implicit `--omit=dev` regardless of the actual install flags** —
  this strips `@remix-run/dev` and `vite` (devDependencies), and the very
  next Dockerfile line, `RUN npm run build` (which runs `remix vite:build`),
  fails outright: `sh: remix: not found`, exit 127. This repo's Dockerfile
  moves `ENV NODE_ENV=production` to right before `CMD`, after the build
  step — keep that ordering, don't copy the export's Dockerfile over it.
- **`app/shopify.server.ts`** — same dotenv/`RENDER_EXTERNAL_URL` pattern as
  every app in this family. (This app's export has, unlike the others,
  already shipped `AppDistribution.SingleMerchant` correctly — but double
  check it hasn't regressed to `AppStore` in a later release anyway.)
- **`app/routes/_index.tsx`** — the root route's `loader` needs a guard for
  bare `HEAD` requests (infrastructure health probes) before calling
  `login(request)`, which unconditionally tries to read the request as form
  data and throws on a bodyless `HEAD`. Keep this repo's version, which
  returns `new Response(null, { status: 200 })` for `request.method ===
  "HEAD"` before reaching `login()`.
- **`package.json`** — keep the `dotenv` dependency; the export omits it.

## 7. Other known gotchas

- **GDPR webhook topics need a separate `compliance_topics` key.** If
  `customers/data_request`, `customers/redact`, or `shop/redact` ever end up
  mixed into a regular `topics = [...]` array in `shopify.app.toml`, deploy
  will reject them: "The following topic is invalid." They need their own
  `[[webhooks.subscriptions]]` block using `compliance_topics = [...]`
  instead of `topics = [...]`. This repo's toml already has this right —
  don't let an update's toml (which you shouldn't be copying anyway, see
  below) reintroduce the mixed form as a reference.
- **`write_customer_payment_methods` is not a real Shopify scope.** If a
  future `UPDATE.md`/`docs/MIGRATION.md` tells you to add it, don't — deploy
  validation rejects it outright. This app's actual payment-method
  functionality (`customerPaymentMethodGetUpdateUrl`,
  `...SendUpdateEmail` — generating a link/email for the customer to update
  their own card) only needs `read_customer_payment_methods`, already in
  the scope list.
- **Theme-extension schema settings can't have `"default": ""`.** An empty
  string as a text setting's default is rejected at deploy validation
  ("default can't be blank"). If a new embed/block ships with this, just
  remove the `"default"` key entirely — a text setting with no default
  already behaves as empty/optional.
- **Never overwrite `shopify.app.toml`.** Same rule as every app in this
  family: never touch `client_id`, `application_url`, `redirect_urls`, or
  `[app_proxy]`. This app's scopes are already correct (see §_current
  scopes_ below) — verify anything new against real Shopify docs before
  adding it, given the two invented-scope incidents already hit here.

**Current, correct scopes** (also in `render.yaml`):

```
read_customers,write_customers,read_orders,read_products,write_products,read_purchase_options,write_purchase_options,read_own_subscription_contracts,write_own_subscription_contracts,read_customer_payment_methods,read_locales,read_markets,read_inventory,read_fulfillments,read_discounts
```

## 8. Sanity suite

```bash
npm ci                # matches what the Dockerfile actually runs — use ci, not install, at least once
npx prisma generate
npx tsc --noEmit
npm run test           # vitest — this app has real unit test coverage (500+ tests), use it
npm run build
npx shopify app build
```

The `AssetSizeAppBlockJavaScript` warning on `buy-box.js` exceeding 10KB is a
known non-blocking theme-check finding — it's shown as `[error]` in
theme-check's own severity labeling but has never actually blocked a real
`shopify app deploy` in this app's history. Only stop for something that
makes the overall build/deploy command itself fail.

## 9. Deploy

```bash
git add -A
git commit -m "describe what actually changed"
git push origin master           # Render auto-deploys the app server

ls shopify.app*.toml              # re-check: exactly one file
npx shopify app deploy --allow-updates
```

Confirm Render actually redeployed with the new code, and that the backend
is genuinely healthy (not just "responding"):

```bash
curl -s "https://cellexia-subscriptions.onrender.com/api/health" --max-time 20
```

Check the response for `"ok":true`, `"db":true`, and that `lastJobRuns`
shows recent `"status":"SUCCESS"` entries for `billing_run` and the other
scheduled jobs — this is the real proof the scheduler is alive and the
Dockerfile/env vars are correct, not just that *some* process is listening
on the port.

## 10. Environment variables (Render → Environment tab)

If a variable is ever missing after a Render service gets rebuilt or
reconfigured, here's the full list:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Render → "Add from Database" → pick `cellexia-subscriptions-db` → Internal Database URL. Never type this by hand. |
| `SHOPIFY_API_KEY` | `59c7f4893e8491dc5f6a047fcc6ccd08` |
| `SHOPIFY_API_SECRET` | Partner Dashboard → app → Client credentials. A real secret — paste directly, never write it down elsewhere. |
| `SCOPES` | The scope string in §7 above |
| `SHOPIFY_APP_URL` | `https://cellexia-subscriptions.onrender.com` |
| `SCHEDULER_MODE` | `internal` |
| `APP_SIGNING_SECRET` | Generate with `openssl rand -hex 32`. Rotating this invalidates every outstanding magic link. |
| `CRON_SECRET` | Generate with `openssl rand -hex 32` — a **different** value from `APP_SIGNING_SECRET`. |
| `DEFAULT_TIMEZONE` | `Europe/London` |
| `KLAVIYO_PRIVATE_API_KEY` | Klaviyo → Settings → API Keys → Private API Keys (full access to Events/Profiles/Lists) |
| `KLAVIYO_API_REVISION` | `2025-01-15` — **note**: the app's own code fallback default is the older `2024-10-15`; don't rely on the fallback, always set this explicitly |
| `MAIL_PROVIDER` | `smtp` |
| `MAIL_FROM` | e.g. `Cellexia <care@cellexia.com>`, using a domain with SPF/DKIM configured |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | Your transactional email provider's credentials |
| `SMTP_PORT` | `587` |
| `SMS_PROVIDER` | `none` |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |

## 11. Safety

A fresh install (and every update) ships in **Setup mode**: the buy-box
widget renders hidden, no customer is ever charged or messaged, and the
customer portal shows a "not yet available" page — regardless of what an
update changes. Nothing here should ever need touching to keep that true;
if a diff ever appears to loosen one of those gates, stop and read it very
carefully before merging. **Going live is a manual, deliberate click in the
app's own Preview & launch page — never something a deploy does by itself,
and never something to do without being certain the merchant wants it.**
