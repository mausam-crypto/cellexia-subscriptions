# Cellexia Subscriptions

Private (single-store) Shopify subscription engine for Cellexia, a D2C
anti-aging skincare brand. Shopify remains the source of truth for contracts,
payments and orders; this app owns everything Shopify doesn't: scheduling,
dunning, gifts, magic links, the customer portal, cancel-save flows, win-back
and analytics.

Goal: **maximise lifetime gross profit and subscriber take-rate without hurting
conversion; minimise voluntary and involuntary churn.**

## Features

- **Safe install (dark launch)** — installing changes *nothing* on the live
  store: the app starts in Setup mode with the buy box hidden, the portal
  closed, billing/notifications/Klaviyo suppressed. Plans, theme block and
  subscriber import can all be set up on production risk-free; an explicit
  **Go live** flips the store on (with optional staggering of overdue renewals
  so launch never triggers a burst of charges).
- **Admin preview** — see the buy-box widget on the live theme (PDP, cart,
  checkout) via a signed preview link visible only in your own browser, and
  the real customer portal exactly as a subscriber sees it (read-only preview
  session on a real subscriber or a local-only demo subscription) — with zero
  impact on real visitors.
- **Selling plans & buy box** — plan groups synced from app config (first-order
  vs ongoing discounts via pricing policies, never codes); theme app extension
  PDP buy box with preselect, badge and savings display. **One-click app-embed
  install**: a single theme-editor toggle (App embeds → "Cellexia Buy Box")
  mounts the widget automatically above the add-to-cart area and carries the
  selling plan into JS-driven cart requests — so it works even on themes whose
  product section takes no app blocks (a section app block remains available
  for themes that do).
- **Buy box designer** — seven PDP design presets (classic cards, toggle
  tabs, comparison tiles, inline upgrade, value stack, routine planner, and
  subscription max — the subscription card *is* the buy box, with one-time
  demoted to a quiet priced link that stays one tap away) with deep
  layout/style/per-locale text customization, **per-Shopify-Market preset
  selection** (each market can run its own preset, everything else inherited
  from the main design), preview, revision history with one-click restore,
  and take-rate reporting per design — all configured in-app and published
  to a metafield; the theme block is added once and never needs touching
  again.
- **Safe alongside another subscription app** — the store can run a second
  subscription app (cellexialabs.com runs Joy) without risk: every contract is
  classified `OURS` / `FOREIGN` / `UNKNOWN` from its selling plans, and only
  `OURS` is ever billed, emailed, analysed or exposed in the portal — so the
  other app's subscribers can never be charged twice or contacted by us.
  Unprovable ownership fails safe (never billed). The buy box renders our own
  selling plan group or **nothing at all**, from an id allow-list published to
  a shop metafield — never a competitor's plan. Foreign subscriptions and
  foreign plan groups are surfaced in the admin, and migrating subscribers over
  is an explicit, audited claim/import step.
- **Billing scheduler** — timezone-safe renewal sweep with DB-leased job locks
  and crash-proof idempotency (`{contract}:{cycle}:{attempt}` keys; double
  charges are impossible). Internal 60s tick or external cron mode.
- **Dunning engine** — decline-code taxonomy (soft/hard/auth), payday-aligned
  retry ladder (time-anchored, per-billing-cycle cases), backup-card fallback
  with automatic revert, 3DS challenge links, pre-expiry card notices,
  crash-safe deduped customer notifications, recovery tracking.
- **Customer portal** (app proxy, store domain) — OTP login (enumeration-safe)
  and HttpOnly-cookie sessions; skip, delay, frequency, swap, quantity,
  add/remove lines, one-time add-ons, pause/resume, address & card updates,
  cancel — and one-tap restart after cancelling; RTL-aware.
- **Magic links** — signed single-use action links (skip, delay, add-to-next,
  update card, resume, 3DS confirm…) with zero login, straight from emails.
- **Cancel-save flow** — reason survey (with a visible skip) → reason-matched
  saves → strictly opt-in final offer, all offers cooldown-capped and gated
  server-side; FTC click-to-cancel compliant (≤3 steps to cancel, always;
  declining saves cancels immediately).
- **Gifts & lifecycle** — surprise cycle-2 gift, announced milestones,
  anniversary, rewards unlock; gift COGS wired into profit analytics.
- **Win-back** — staged touches timed to the *predicted empty date*, not the
  cancel date.
- **Klaviyo** — every lifecycle event feeds Klaviyo flows through a guaranteed-
  delivery outbox; SMTP fallback for transactional email.
- **Analytics** — daily rollups and a cohort heatmap of retention & true-LTV
  LTGP (first checkout payment + every renewal, net of refunds), computed
  from a merchant-editable cost model (per-product COGS with Shopify-cost
  sync + overrides, per-parcel shipping/fulfillment, payment fees) that
  flags how much of the profit math is estimated; censoring-corrected
  survival curves split by churn cause; **self-improving churn risk** (a
  learned model trains nightly on the store's own history and replaces the
  heuristic only once provably better — status always visible); take rate
  (incl. per buy-box design); dunning recovery; five backtested forecast
  models with honest A–D accuracy grades, self-measured weekly so model
  selection keeps improving; plain-language insight cards.
- **Acquisition data foundation** — source/UTM, geo, device and first-order
  shape captured (sanitized — never an IP or full user-agent) on every new
  subscription and erased on GDPR redact, so channel-quality analysis has
  history from day one ([docs/DATA_FOUNDATION.md](docs/DATA_FOUNDATION.md)).
- **Ops** — health endpoint, alerting (billing failures, webhook spikes, stuck
  contracts, churn spikes), full audit event log, bulk operations (stockout
  actions, price changes with notice), subscriber import.

## Stack

Remix (Vite) + TypeScript (strict) · Prisma + PostgreSQL · Shopify Admin
GraphQL **2025-01** · Polaris + App Bridge (embedded admin) · Theme app
extension (buy box) · App proxy (portal) · Klaviyo · Vitest. Deliverable runs
as a single Node 20+ process + Postgres (Dockerfile included).

## Quickstart

Full runbook with every gotcha: **[docs/INSTALL.md](docs/INSTALL.md)**. Compressed:

```bash
# Partner Dashboard: create custom app; request Subscriptions API +
# protected customer data access (docs/INSTALL.md §2) — mandatory.
cp .env.example .env            # fill everything (openssl rand -hex 32 for secrets)
npm ci
npx prisma migrate deploy       # against your PostgreSQL
npm run config:link             # link shopify.app.toml to your app (fills client_id)
npm run deploy                  # push config + webhooks + theme extension
# Deploy the web process (Fly.io recipe in docs/INSTALL.md §3), install the app
# on the store, enable the "Cellexia Buy Box" app embed (Theme settings →
# App embeds; or add the theme block), create+sync a plan, then place a test
# subscription (docs/TESTING.md).
```

## Documentation

| Doc | What's in it |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Complete installation runbook: safe (dark) install, Partner app, API access approvals, Fly.io hosting, env, DB, deploy, theme, preview & go-live, troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, golden rules, module map, event vocabulary |
| [docs/UPDATE.md](docs/UPDATE.md) | Versioning contract, update & rollback procedure |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Day-2 runbooks: alerts, dunning review, refunds, credits, stockouts, price changes, secret rotation, GDPR, backups, monitoring, launch mode, running alongside another subscription app, the analytics cost model & metric definitions, the self-learning risk/forecast models |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Importing subscribers from Recharge/Skio/Appstle/Bold/Joy incl. payment-method reality and migrating off an app that stays installed |
| [docs/TESTING.md](docs/TESTING.md) | E2E test plan: test cards, every customer verb, dunning ladder simulation, load sanity, preview-based pre-launch QA |
| [docs/OFFER_PLAYBOOK.md](docs/OFFER_PLAYBOOK.md) | Operator levers: discounts vs gifts math, cadence, consolidation, save ladder, target metrics, the weekly analytics review |
| [docs/DATA_FOUNDATION.md](docs/DATA_FOUNDATION.md) | Origin-order revenue mirror + acquisition capture: field-by-field contract, sanitization rules, GDPR erasure, what it unlocks later |
| [docs/KLAVIYO_SETUP.md](docs/KLAVIYO_SETUP.md) | Klaviyo metrics, flows and profile properties |
| [docs/sample-import.csv](docs/sample-import.csv) | Import file example |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Support & versioning

Delivered as versioned ZIPs, semantic versioning; every release ships a
CHANGELOG entry and additive migrations — the exact promises are in
[docs/UPDATE.md](docs/UPDATE.md). Keep your own git repo from day one
(recommended there) so updates arrive as reviewable diffs. Report issues with:
app version, the relevant **Audit** page events, and `/api/health` output.

## Licence

Proprietary — © Cellexia. All rights reserved. No redistribution, resale or use
outside the Cellexia store without written permission.
