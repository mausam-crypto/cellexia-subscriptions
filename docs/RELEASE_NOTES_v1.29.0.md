# Release notes v1.29.0: portal home polish, single-subscription view, reply promise

For the developer applying the update and for the merchant reviewing the
new settings. Apply on top of v1.28.1 (or v1.28.0 with the schema fix
applied by hand). Read together with [UPDATE.md](./UPDATE.md) and the
[CHANGELOG](../CHANGELOG.md) (the 1.29.0 entry lists every setting, key,
module and test by name).

## What changes at a glance (v1.28.1 → v1.29.0)

| Area | Change | Deploy step |
|---|---|---|
| Database | **No migration.** `settings.support` gains three JSON keys with defaults; a stored `slaBusinessDays` is read quietly (see below). | `npm run setup` still runs (regenerates the Prisma client; migrations are a no-op) |
| Server | Portal home rendering fixes (roadmap styles + chronological order, one-line next-order block + one shared cut-off formatter, uniform value tiles), single-subscription direct view (`portal.singleSubscriptionOpensDetail`, default ON) with the home-only surfaces on the detail page, reply promise model (`support.replyWithinValue` / `replyWithinUnit` / `alwaysOn`) rendered by one helper everywhere, concierge SLA job on minutes/hours + 10-minute cadence. | Deploy and restart the host |
| App config | `shopify.app.toml` unchanged since 1.28.1. | Nothing |
| Extensions (checkout survey, buy-box theme extension) | **Unchanged.** | Nothing — `npm run deploy` is not required |
| Scopes, env vars, app proxy, webhooks | Unchanged. | Nothing |

## Exact order of operations

1. Back up the database (UPDATE.md section 4, step 2) — routine; nothing
   in 1.29.0 writes a schema change.
2. Unzip `cellexia-subscriptions-v1.29.0.zip` over the previous directory,
   keeping `.env`, `fly.toml`, **your `shopify.app.toml` and your
   `extensions/*/shopify.extension.toml`** (the ZIP ships templates; restore
   yours from git if overwritten). No toml delta this release. Commit to
   your own git repo and review the diff.
3. `npm ci`
4. `npm run setup` (no migration to apply; regenerates the client).
5. Deploy and restart the server.
6. Settings review (below), then verify.

## New settings to review

- **Settings → Support → Reply promise** (`support.replyWithinValue` default
  **30**, `support.replyWithinUnit` default **minutes**, `support.alwaysOn`
  default **on** → "A human replies within 30 minutes, 24/7."). **Required
  check.** This sentence is what the Get-help card, the support toast, the
  concierge save card and the saved page promise the customer, and what the
  `concierge_sla_run` job (now every 10 minutes) measures a concierge
  request against — a request unanswered past it raises a CRITICAL
  `SUPPORT_SLA_BREACH` alert.
  - A store that **saved** the Support section on 1.28.x keeps its old
    number: the stored `slaBusinessDays` is read as `{value: N, unit:
    business days, 24/7 off}` until you save the section again (the form
    then writes the three new fields and the legacy key disappears).
  - A store that **never saved** the Support section moves silently from
    the old default (1 business day) to **30 minutes, 24/7** and arms
    30-minute breach alerts. Setup cannot tell a fresh install from an
    upgrade, and 30 minutes 24/7 is the recorded product decision — so open
    Settings → Support once and set the value / unit / 24-7 you can honour.
    A not-24/7 minutes or hours promise reads "… on business days" to the
    customer; `business days` as the unit is never 24/7.
- **Settings → Customer portal → Open the subscription directly when there
  is only one** (`portal.singleSubscriptionOpensDetail`, default ON). A
  customer with exactly one subscription (any status) lands on its page
  instead of a list of one; the list stays one tap away (Subscriptions tab →
  `/?list=1`). The admin portal preview behaves the same (the demo persona
  has one contract). Turn OFF to restore the list-first home.

Nothing else needs a decision: the home rendering fixes, the cut-off
wording and the shared cards are not behind new settings (they correct
what v1.28.0 already showed).

## How to verify after deploying

Admin:

- Settings → Support shows "Reply promise — within", "Reply promise —
  unit", "24/7"; the section description names the default sentence.
  Settings → Customer portal shows the single-subscription toggle.
- Debug → `settings_integrity` PASSes (a legacy `slaBusinessDays` row parses
  through the new schema).
- Cancel-flow page: the concierge hold help text points at Settings →
  Support → Reply promise.
- Alerts: submit a concierge save on the dev store and leave it — with the
  default promise, `SUPPORT_SLA_BREACH` appears within ~40 minutes (30 min
  promise + the 10-minute tick), its message reads "unanswered for {elapsed}
  (promise: A human replies within 30 minutes, 24/7.)". Resolve the
  `SUPPORT_REQUEST` alert first and no breach is raised.

Portal (dev store, test customer with one subscription):

- Open the portal root: you land on the subscription page (302). The
  "← All subscriptions" link and the "Subscriptions" tab open the list at
  `/?list=1` and stay there. The rewards card, and — when applicable — the
  cancel-intent and newer-card banners, appear on the subscription page.
  Toasts (skip → Undo, delay, support sent) render on the subscription page.
- Give the customer a second subscription (or turn the setting off): the
  root shows the list as before.
- Home / list card at 375 px and 1024 px: rewards roadmap rows in date order
  with the meta on its own line at 375; NEXT ORDER = heading date, one
  "€ total · card" line, "Changes until {previous day}, 11:59 PM" (or the
  real local hour when `billing.chargeHourLocal` ≠ 0) — the reminder
  email's `{edit_cutoff}` says the same; value tiles read "1 delivery to
  your milestone gift" / "3 deliveries …".
- Get-help card SLA line, the toast after submitting, the cancel flow's
  concierge card and the saved page all print the same promise sentence.

## Rollback

- Server: redeploy v1.28.1; leave the database as it is. Settings JSON:
  a Support section saved under 1.29.0 carries `replyWithinValue` /
  `replyWithinUnit` / `alwaysOn` and no `slaBusinessDays` — the 1.28.x
  schema fills `slaBusinessDays` from its default (1) and ignores the new
  keys, so the old promise text returns; re-save on 1.28.x if you need a
  different number. `portal.singleSubscriptionOpensDetail` is ignored by
  1.28.x. Alerts raised under 1.29.0 keep their `replyWithin` context
  (harmless).

## Where things live (new in v1.29.0)

- `app/lib/portal/single-subscription.server.ts` — redirect / list-marker
  helpers; `app/lib/portal/rewards-card.server.ts`,
  `app/lib/portal/new-card-banner.server.ts` — the shared home / detail
  cards; `PortalPageInput.subscriptionsHref` in `layout.server.ts`.
- `app/lib/support/reply-promise.server.ts` — the one sentence helper and
  the toast URL codec; `resolveReplyPromise` + `ReplyPromise` types in
  `app/lib/support/channels.server.ts`; `replyPromiseElapsed` /
  `weekdayMsBetween` / `formatElapsed` in `app/lib/cancel/scheduled.server.ts`.
- `formatEditCutoff` in `app/lib/billing/timing.server.ts`;
  `sortRoadmapRows` in `app/lib/portal/growth.server.ts`.
- Tests: `tests/portal-single-subscription.test.ts`,
  `tests/support-reply-promise.test.ts`,
  `tests/cancel-concierge-sla-minutes.test.ts`,
  `tests/portal-home-render-fixes.test.ts`.
