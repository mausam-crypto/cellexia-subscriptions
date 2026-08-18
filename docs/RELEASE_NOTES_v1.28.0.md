# Release notes v1.28.0: the portal churn pack

For the developer applying the update and for the merchant reviewing the
new settings. Apply on top of v1.27.0. Read together with
[UPDATE.md](./UPDATE.md) and the [CHANGELOG](../CHANGELOG.md) (the 1.28.0
entry lists every setting, event, template, verb and job by name).

## What changes at a glance (v1.27.0 → v1.28.0)

| Area | Change | Deploy step |
|---|---|---|
| Database | Migrations `0027_portal_payments` (6 nullable columns) and `0028_flexibility_deliveries` (12 nullable columns). Additive only, no new tables, no indexes. | `npm run setup` |
| Server | Payments core (card-update resolver, payment-issue banner, retry / 3DS / skip-and-resume, other payment methods, new-card detection, post-exhaustion touches), charge timing + the one next-order estimate, delay re-anchor + Undo, per-line cycle edits, vacation hold, send-tomorrow, delivery instructions, deliveries + tracking, results timeline + check-in email, rewards roadmap, onboarding card + welcome email, DOWNSIZE / DELAY / concierge saves, scheduled cancel, cancel-intent follow-up, win-back parity + restart landing, support settings + Get-help card, accessibility pass, education links; 3 new jobs, 8 new templates, 8 new magic verbs, 2 SMS keywords, 3 self-checks, 2 alerts. | Deploy and restart the host |
| App config | `shopify.app.toml` gains three webhook topics: `fulfillments/create`, `fulfillments/update`, `fulfillment_events/create` (delivery tracking). | `npm run deploy` |
| Checkout UI extension | `extensions/cellexia-survey` renders a "Manage your subscription" card above the survey on the Thank-you and Order-status pages (subscription orders only; no setting needed). Extension locales gain the card's strings. | `npm run deploy` (same command) |
| Buy-box theme extension | **Unchanged.** No `.liquid`, JS or CSS change; size budgets as in v1.27.0. | Nothing |
| Scopes, env vars, app proxy | Unchanged. | Nothing |

## Exact order of operations

1. Back up the database (UPDATE.md section 4, step 2).
2. Unzip `cellexia-subscriptions-v1.28.0.zip` over the previous directory,
   keeping `.env` and `fly.toml`. Commit to your own git repo and review the
   diff.
3. `npm ci`
4. `npm run setup` (applies 0027 and 0028; safe before the new code runs —
   v1.27 code ignores every new column).
5. **Decide the post-exhaustion rollout before step 6.** On the first
   `dunning_run` after deploy, every subscription that is FAILED
   (dunning-exhausted) and older than the last offset in
   `dunning.postExhaustionTouchDays` (default `[7, 21]`) receives ONE
   "your subscription is on hold — three ways to continue" email
   (`payment_failed_parked`). On a pre-launch store with no FAILED contracts
   this is a no-op. If you would rather not contact the parked cohort at
   all, set the array to `[]` in Settings → dunning right after the server
   is up (the sweep runs every 10 minutes) — or disable the template on the
   Emails page.
6. Deploy and restart the server.
7. `npm run deploy` (webhook topics + checkout extension). AFTER step 6: the
   new server registers handlers for the three fulfillment topics; a v1.27
   server would ignore them (Shopify retries and gives up; no effect).
8. Settings review (below), then verify.

## New settings to review

Everything ships with a default equal to the previous behaviour where one
existed; the items below are the ones that need a merchant decision.

- **Settings → Support** (`support.*`) — fill in at least the **support
  email**. Until you do, the portal's Get-help card, the cancel flow's
  "talk to us" cards, the welcome email and every "reach a human" line fall
  back to the store's contact email (Shopify → Settings → Store details); if
  that is empty too, the email CTA is hidden rather than pointing at a dead
  address. Optional: **Reply-To override**, **WhatsApp** number (E.164),
  **chat URL** (https), **hours note**, **SLA in business days** (default 1
  — this number is promised to the customer by the concierge save; only
  promise what a human can meet), **requests per hour** (default 3, per
  customer).
- **Settings → Billing timing** (`billing.chargeHourLocal`, default 0) — the
  local hour at which renewals charge. 0 keeps today's behaviour (the first
  5-minute sweep after shop midnight). Every "you can make changes until
  {date} 23:59" line, the reminder, the portal and the SMS keywords read the
  same instant. Move it (e.g. 06:00) only if fulfilment cut-off allows; the
  copy follows automatically. `billing.preparingWindowHours` (default 6)
  bounds the "Preparing your order" state.
- **Settings → portal → Delay re-anchors** (`portal.delayReanchors`, default
  ON) — "Delay by N weeks" moves the whole schedule and the portal offers an
  explicit "just this once"; OFF restores the old one-cycle delay everywhere
  (portal, magic links, SMS).
- **Settings → lifecycle → Results timeline** (`lifecycle.resultsTimeline`) —
  four generic phases (weeks 0–4 / 4–8 / 8–12 / 12+) with non-medical default
  copy in every locale, a check-in email at week 4 (`checkinWeek`), and the
  survey-based expectation line. Edit the phase titles/bodies to your product's
  truthful language or leave the defaults; the same content drives the portal
  card, the cancel flow's education save and the check-in email. Also behind
  `portalGrowth.resultsTimeline` and the `results_timeline` experiment.
- **Settings → dunning → Post-exhaustion touches**
  (`dunning.postExhaustionTouchDays`, default `[7, 21]`) — see step 5.
  Related: `dunning.customerRetryCooldownMinutes` (60),
  `dunning.newMethodDetection` / `newMethodAutoSwitch` (both ON: a customer
  in payment trouble who saves a new card is switched to it when the old one
  is dead, otherwise offered a one-tap switch).
- **Settings → portal → Education URLs** (`portal.routineGuideUrl`,
  `howToUseUrl`, `faqUrl`, all empty by default) — the "Get the most from
  your routine" card appears once at least one is set; the cancel flow's
  education save uses the same links. Store-relative (`/pages/...`) or https.
- **Cancel-flow page** — every new save and follow-up has a toggle: cheaper
  configuration (DOWNSIZE), "push to when you'll run out" (DELAY, max days),
  concierge hold (days, minimum lead hours), scheduled cancel for locked
  subscribers (notice days, keep-link TTL), cancel-intent follow-up (send
  after N hours, charge buffer, per-customer cooldown, portal banner days).
  All ON by default; the scheduled cancel only matters when a plan has
  `lockDays > 0`.
- **Settings → portalGrowth** — five new toggles, all ON: supply meter,
  results timeline, rewards roadmap, onboarding card, deliveries list.
- **Emails page** — eight new templates to read once (subjects/bodies are
  editable as before): welcome (`subscription_started`), payment parked,
  new card detected, 3DS SMS, cancellation scheduled / upcoming, cancel-intent
  follow-up, routine check-in. On the Klaviyo delivery setup page, **Create
  my flows** adds the missing flows; flows created before v1.28.0 keep their
  sender/Reply-To (edit or recreate them in Klaviyo if you changed the
  support email — see KLAVIYO_SETUP.md).

## Launch blocker: test the card-update path on the dev store

`customerPaymentMethodGetUpdateUrl` — the page the portal's "Update card"
button, the `UPDATE_CARD` links and the admin "Open secure page" used to open
for everyone — is documented by Shopify as Shop Pay only; card instruments
return `INVALID_INSTRUMENT`. v1.28.0 decides the path server-side
(`app/lib/payments/cardUpdate.server.ts`): Shop Pay → hosted page; card /
PayPal → Shopify's own "Confirm payment for your subscription" email (link
valid 48 hours, replaces the instrument under the same id) plus a "Manage
payment methods in your account" link to `/account`. Two things are
**unverified on a real store** and must be checked before subscriber #1:

1. On the dev store, subscribe with a **test card** (not Shop Pay), open the
   portal → subscription → payment section → **Update card**. Expected: the
   toast "we've emailed you a secure link", the Shopify email arrives, its
   link opens the hosted replace flow, and after replacing the card the
   webhook fires: the portal shows the new card, `payment_method_updated` is
   sent and any open dunning case retries at once
   (`contract.payment_method_updated`, `dunning.retry_scheduled` on the
   timeline). Repeat once with a **Shop Pay** checkout: the button should
   302 to the hosted page directly.
2. Click **Manage payment methods in your account** (`https://<store>/account`)
   while signed in with new customer accounts. Confirm where it lands (the
   profile page that lists the subscription's payment method); if the store
   redirects elsewhere, tell the developer — the link is built in one place
   (`accountUrl` in `app/routes/proxy.subscription.$id.tsx`,
   `https://<primary domain>/account`).

Debug → `payment_update_path` PASSes when every OURS contract has a mirrored
instrument type; it also counts pre-0027 rows still waiting for their first
webhook/sync (the nightly sync backfills them).

Also unverified (documented in code, contained): a Shopify billing-cycle
skip on a FAILED contract before `subscriptionContractActivate`, and
`subscriptionContractSetNextBillingDate` on a FAILED contract — both are the
"Skip that order and continue" verb; exercise it once with a test card that
declines (`insufficient_funds`), let the ladder exhaust (TESTING.md §4
compression), then tap the button in the portal.

## How to verify after deploying

Admin:

- Debug: `payment_update_path`, `delivery_tracking`, `portal_a11y` present
  and PASS (44 checks in total); Healthy verdict.
- Subscriber page: payment card shows brand + last4 + expiry and, per vaulted
  method, **Make primary**; "Backup set by …" once a backup exists; a
  "Support requests" card; on a scheduled cancel, the "Cancels {date}" badge
  and a **Keep** button.
- Settings: Support and Billing timing sections; Cancel-flow page shows the
  new knobs; Emails page lists the eight new templates.
- Alerts: `SUPPORT_REQUEST` after a portal Get-help submit (deduped per
  contract per day), `SUPPORT_SLA_BREACH` only after a concierge request
  passes the SLA unresolved.

Portal (dev store, test contract):

- Detail page: "Your next delivery" hero with the date, the "you can make
  changes until …" line, the lines as they bill, the discounted total, the
  card, "After that: {date}". Delay by 1 week → both dates in the toast and
  an **Undo** that restores the previous date; "just this once" leaves the
  following order on the old anchor.
- Multi-line contract: **Not this time** on one line → the hero and the
  reminder drop that line for the next order only; **Undo** restores it.
- Pause with a date → banner with Resume now / extend choices; the reminder
  email carries one-tap Resume and Extend.
- Address form: company, country and region selects, delivery instructions
  → the instructions appear in the hero's ships-to line and on the next
  renewal order as the `_cellexia_delivery_instructions` attribute.
- Get-help card on Account and on the subscription page: submit a Delivery
  problem with push-back → toast with the SLA, `support.requested` on the
  timeline, alert + support email.
- Failed payment (test card `insufficient_funds`, TESTING.md §4): the home
  card says "Payment issue · Order held since {date}", the detail banner
  offers **Retry now** (throttled after one tap), **Pause instead**, and —
  once exhausted — **Skip that order and continue from {date}**.
- Thank-you page of a new subscription checkout: the "Manage your
  subscription" card links to `/apps/cellexia-subs/`.
- Cancel flow: TOO_EXPENSIVE shows the DOWNSIZE card with concrete totals;
  the SUPPORT card carries the request form and is not counted as saved
  until submitted; a locked contract (plan `lockDays > 0`) offers "cancel at
  the end of the commitment" and the portal then shows "Cancels on {date} ·
  Keep".

## Rollback

- Server: redeploy v1.27.0; leave the database as it is (both migrations
  are additive; nothing in v1.27 reads the new columns). The three
  fulfillment webhook topics stay registered and are simply unhandled by the
  old server (Shopify retries then drops them); the checkout extension's
  "Manage your subscription" card keeps linking to the portal, which exists
  in v1.27.0 too. To remove both, `npm run deploy` from the v1.27.0 tree.
- Data written meanwhile (tracking columns, instrument types, cycle
  overrides) stays and becomes useful again on re-apply.

## Where things live (new in v1.28.0)

- `app/lib/payments/cardUpdate.server.ts` — the card-update path resolver.
- `app/lib/portal/dunning.server.ts`, `dunning-banner.server.ts`,
  `payment.server.ts`, `payment-methods.server.ts`, `threeds.server.ts` —
  the portal's payment surfaces; `app/lib/dunning/new-method.server.ts`,
  `skip-resume.server.ts`, `post-exhaustion.server.ts`, `other-cards.server.ts`,
  `held-amount.server.ts`, `states.ts` — the engine additions.
- `app/lib/billing/timing.server.ts`, `estimate.server.ts`,
  `following-date.server.ts` — charge moment, the one next-order estimate,
  the schedule-aware following date.
- `app/lib/portal/next-delivery.server.ts`, `schedule.server.ts`,
  `undo.server.ts`, `price-lock.server.ts`, `flex.server.ts`,
  `deliveries.server.ts`, `timeline.server.ts`, `education.server.ts`,
  `a11y.server.ts`, `countries.ts` — the portal cards and helpers.
- `app/lib/contracts/draft-lines.ts` + new service functions
  (`skipLineThisCycle`, `unskipLineThisCycle`, `setLineQuantityThisCycle`,
  `pauseUntil`, `extendPause`, `sendNextOrderTomorrow`,
  `setDeliveryInstructions`, `changePaymentMethod`, `setBackupPaymentMethod`).
- `app/lib/cancel/scheduled.server.ts`, `intent-followup.server.ts`,
  `intent-banner.server.ts`; `app/lib/winback/restart.server.ts`,
  `links.server.ts`, `welcome-back.server.ts`;
  `app/routes/proxy.subscription.$id.restart.tsx`.
- `app/lib/support/` (channels + request); `app/lib/lifecycle/checkin.server.ts`;
  `app/lib/notifications/subscription-started.server.ts`,
  `payment-method.server.ts`, `promise.server.ts`;
  `app/lib/webhooks/fulfillment-tracking.server.ts`.
- `extensions/cellexia-survey/src/manage-link.jsx`.
- `prisma/migrations/0027_portal_payments/`, `0028_flexibility_deliveries/`.
