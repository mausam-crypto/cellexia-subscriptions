# Changelog

All notable changes to Cellexia Subscriptions. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org) as contracted in [docs/UPDATE.md](docs/UPDATE.md).

## [1.13.0] — 2026-08-10

**New per-plan option: "Block skip, pause, change or cancel for the first X
days"** — a commitment window that stops discount-grab-and-cancel. One
additive migration (`0017_plan_lock_window`, `prisma migrate deploy`); no new
env vars, no scope, webhook or theme changes (`npm run deploy` not needed).

### Added

- **Commitment window per plan** (Plans → edit plan → "Commitment window",
  `SellingPlanConfig.lockDays`, 0–365, default 0 = off). While a contract is
  inside the window — counted from checkout (`firstChargeAt`, falling back to
  the mirror's `createdAt`, whichever is EARLIER) — every customer-initiated
  schedule reduction is refused: skip, delay, frequency change, next-date
  change, pause, variant swap, recurring-line removal, quantity decrease, and
  cancellation. Additions and recoveries stay available (add product, one-time
  add-on, quantity increase, addon removal, unskip, resume, reactivate,
  address, payment update), and admin, dunning, stockout and system flows are
  never blocked. Set it to roughly delivery time plus first use.
- **Terms as subscribed under, never retroactive**: the covering plan's
  lockDays is stamped onto the contract once, at mirror creation
  (`SubscriptionContract.lockDays`); the effective window is the SMALLER of
  that stamp and the plan's current setting. Enabling or raising the value
  never locks anyone who checked out before it existed (they subscribed under
  "cancel anytime"); lowering or clearing it — or deleting the plan —
  releases everyone immediately. Every pre-upgrade, imported and
  install-backfilled contract carries no stamp and is permanently exempt.
- **The promised date is exactly true**: the window ends at shop-timezone
  MIDNIGHT of the displayed unlock date (`dates.server.ts` calendar math, DST
  safe) — a customer told "available on 12 March" is never refused on
  12 March.
- **Enforced at every customer surface, not just hidden in the UI**: the
  portal action dispatcher, the whole cancel flow through one choke point
  (`requireCancelContext` — a crafted POST to `/cancel/:id/confirm` cannot
  mint its own session past it) plus a `completeCancel` engine backstop for
  non-admin channels, magic-link verbs SKIP_NEXT/DELAY_NEXT/PAUSE/SWAP at
  execution time (links sit in inboxes up to 14 days — a pre-lock link is
  refused mid-window and works again after), and SMS SKIP/DELAY with a
  localized reply naming the unlock date.
- **Honest locked-state UX**: the subscription page shows the exact unlock
  date (`portal.locked.notice`), the controls the window disables disappear
  (schedule + pause cards, cancel link, minus/remove/swap on recurring
  lines), portal-home one-tap skip/delay hide, refused attempts land a
  localized toast, and a locked magic link renders the refusal on the GET
  page itself — before the auto-submit — without consuming the token, so the
  same emailed link works normally once the window has passed. 5 new keys in
  all 22 locale catalogs. The admin subscriber page shows a "Locked until …"
  badge so support sees why a customer "can't cancel"; the plan form warns
  the merchant to disclose the commitment in their terms AND to edit the buy
  box's default "Skip, pause or cancel anytime" reassurance/benefit copy,
  which would otherwise promise exactly what the window blocks.
- **Deliberately exempt**: imported and demo contracts (their lines carry no
  selling-plan id — a migrated long-tenured subscriber must not re-lock at
  import day). Plan resolution matches line selling-plan ids against each
  config's append-only plan-id union (both GID and numeric forms; strictest
  matching plan wins), so it survives frequency changes and plan-frequency
  deletions. Note: the merchant demo preview renders unlocked (the demo
  fixture is 70 days old by design).

### Migration notes

- `0017_plan_lock_window` — two additive columns: `SellingPlanConfig.lockDays
  INTEGER NOT NULL DEFAULT 0` (the merchant setting; 0 = exactly the
  pre-upgrade behavior) and `SubscriptionContract.lockDays INTEGER` nullable
  (the subscribed-under stamp; null = every existing row = permanently
  exempt). No backfill, no destructive statement.

## [1.12.1] — 2026-08-10

**The customer-portal preview no longer opens on a full-screen black page.**
No migration, no new env vars, no scope or theme changes (`npm run deploy`
not needed) — app-server restart only.

### Fixed

- **Portal preview = black screen on the live store.** The portal's preview
  banner carried the class `cx-preview-bar` — a name the other "cellexia"
  vendor's storefront apps (cellexia-reviews, cellexia-aov-ltv-booster) also
  use for THEIR preview-bar component. Their theme-extension CSS loads on
  every theme page, the theme-wrapped portal included; their
  `.cx-preview-bar` rules (`inset-block-end:0`, opaque `#0F1111`,
  `z-index:2147479999`, flex-centered) merged with ours (`top:0`) and
  stretched the 42px banner into a full-viewport opaque black overlay. The
  preview page rendered perfectly underneath and showed nothing but the
  banner text. Verified live on cellexialabs.com by reproducing the exact
  DOM: the same injection now renders a slim top bar with the fix applied.
  Same vendor, same namespace, same failure mode as the v1.2.2 buy-box
  wrapper adoption and the v1.2.3 portal-script sweep — this was round
  three, in CSS.
- **Every portal DOM class moved off the vendor's `cx-` namespace**, `.cx-*`
  → `.cxs-*` (cancel-flow's scoped `.cxc-*` block already complied): the
  vendor's sheets also ship their own `.cx-btn`, `.cx-card`, `.cx-chip`,
  `.cx-error`, `.cx-hp` and `.cx-muted`, so any of those could be restyled
  out from under the portal by their next app update. A class the vendor
  styles aggressively enough (`display:none !important` appears in one
  deployed variant of their CSS) cannot be defended with specificity — the
  element must simply never carry the name. Query parameters (`cx_pp`,
  `cx_preview`) and the `cx_portal` cookie are not CSS-reachable and keep
  their names, so outstanding preview links and sessions survive the update.
- **The preview banner was invisible even without the collision**: the live
  theme fixes its header wrapper at `z-index:99999`, and the banner's old
  `z-index:100` rendered behind it. It now pins a near-max `z-index`
  (2147483200) — above the theme header and the vendor's overlays; a 42px
  strip cannot meaningfully occlude a page the way the accidental
  full-screen layer did.

### Added

- **Lint rule (tests/liquid/lint.test.ts §5e): the bare `cx-` class prefix
  is banned in portal markup** — layout, every `proxy.*` route and the
  cancel-flow pages, comments blanked first. The rule that would have caught
  this before it shipped; portal classes live in `cxs-`/`cxc-` from now on.
- **The pre-launch demo preview is pinned end-to-end**
  (tests/portal-preview-gate.test.ts §4): with the app still in SETUP mode, a
  valid demo `?cx_pp=` link renders the portal home with the demo
  subscription's own line items behind the preview bar — never the
  "finishing touches" setup gate and never the empty "no subscriptions"
  portal — and the portal's contract lookup is asserted to stay
  `ownership: OURS` **without** an `isDemo` exclusion (every other consumer
  filters demo rows out, which is exactly how such a clause could sneak into
  the one query that must keep them). A valid token landing on `/login` is
  pinned to bounce straight back to the portal home, token intact. The gate
  page itself remains public-only copy: an admin whose link went stale gets
  the named "preview link has expired — reopen it from the admin" page
  instead, on every portal route (v1.9.0 behaviour, still covered).

## [1.12.0] — 2026-08-10

**SMTP and Klaviyo are now configurable from the admin — Settings → Email
delivery / Klaviyo connection — with the env vars as fallback.** No
migration, no new env vars, no scope or theme changes (`npm run deploy` not
needed). Env-only installs behave exactly as before; every existing
`MAIL_*`/`SMTP_*`/`KLAVIYO_*` variable keeps working as the fallback layer.

### Added

- **Settings → Email delivery (SMTP)** (`mailTransport` setting): transport
  choice (env-vars / SMTP / console), From address, host, port, username,
  password and TLS mode, editable in the admin. A saved transport wins over
  `MAIL_PROVIDER`; blank fields fall back to their matching env var. Saves
  apply on the next email sent, on every instance — the transport cache is
  keyed by the resolved config (`global.__cellexiaMailTransport`), no
  restart. A **Test saved transport** button runs a real SMTP `verify()`
  round-trip.
- **Settings → Klaviyo connection** (`klaviyo` setting): the private API key,
  editable in the admin. A saved key wins over `KLAVIYO_PRIVATE_API_KEY`;
  the outbox flush resolves it fresh on every tick, so queued events start
  delivering on the next flush after a save (a minute with the internal
  scheduler, up to the cron interval with `SCHEDULER_MODE=external`) —
  keeping the KLAVIYO_SETUP promise (and its 24h age-out). A **Test key**
  button probes the key BEFORE saving
  (only a 401 condemns it; 403 = healthy Events-only scoped key — a wrong
  saved key would dead-letter queued events within a minute).
  `KLAVIYO_API_REVISION` stays env-only by design.
- **Secrets handling** (`app/lib/crypto/secrets.server.ts`): the SMTP
  password and Klaviyo key are stored AES-256-GCM-encrypted under a key
  derived from `APP_SIGNING_SECRET`. They are write-only in the UI (never
  echoed to the browser; blank keeps the saved value, an explicit checkbox
  clears it) and redacted to markers — "(set)"/"(updated)"/"(cleared)" — in
  `settings_updated` audit events, so neither the Audit page nor its CSV
  export can ever leak them. Rotating `APP_SIGNING_SECRET` invalidates the
  stored credentials: delivery falls back to the env vars (never crashes)
  and they must be re-entered — documented in OPERATIONS §10.
- New suites: `tests/settings-secrets.test.ts`,
  `tests/mailer-settings-override.test.ts`,
  `tests/klaviyo-settings-key.test.ts`,
  `tests/settings-secret-redaction.test.ts`.

### Changed

- `sendEmail`/`verifyMailer` (mailer) and `isKlaviyoConfigured`/
  `createKlaviyoEvent` (Klaviyo client) resolve configuration
  settings-first with env fallback; `isKlaviyoConfigured` is now **async**
  and shop-aware, and `verifyMailer` takes an optional shopId (env-only
  without one — `/api/health` passes the primary shop's, guarded, so a
  down DB degrades to the env-only check instead of failing the probe).
  Any settings-read or decrypt failure degrades to env resolution:
  settings can improve delivery, never break it. The production fail-loud
  contract is unchanged — no provider chosen anywhere still throws on send
  and turns `/api/health` red.
- Debug self-check (`mailer`, `app_secrets`, `klaviyo_outbox`), the
  `KLAVIYO_OUTBOX_BACKLOG` alert and the launch checklist now report the
  effective (settings-or-env) configuration and point their remediation at
  the Settings page; the mailer check names the config source in its
  detail. `MailerStatus` gains a `source: "settings" | "env"` field.

## [1.11.0] — 2026-08-10

**Buy box: the one-click-behind variant defect fixed at the root, the
theme's main price kept honest, and a new `subscription_ultra_max` preset.**
Theme-extension release: run `npm run deploy` after updating — nothing
reaches the storefront until the extension is redeployed. No migrations, no
env changes.

### Fixed

- **Widget permanently one variant behind the pills (live, preview and
  future-live).** The store's PDP no longer carries any `input[name="id"]`:
  the size pills expose the variant id only as a `data-val-id` attribute
  (one pill's value padded with trailing whitespace), the theme paints the
  selection by moving an `active` class, and a bystander widget's
  recommendation rows (`data-variant-id`) track the current variant on
  their own schedule. The embed's picker didn't know `data-val-id`, and its
  one-shot 60ms DOM re-read raced the bystander's update — pushing the
  PREVIOUS variant after every click ("select 1 jar, see the 2-jar
  subscription price"), with no `[name="id"]` field left for the 600ms poll
  to correct from. Both storefront assets now read the marker vocabulary
  (`data-variant-id` / `data-val-id` / `data-variant`, trimmed) and rank
  evidence — bound form, changed-since-last-read, `[name=id]` fields
  (own-section tiebreak), the theme's own active-selection paint, passive
  bystander markers last; an unpicked swatch is never evidence, only a real
  field can park the widget on an un-synced variant, and the embed's
  re-read is staggered (60/350/900ms) with the poll underneath. Pinned by
  the new marker-theme suites in `tests/buybox-variant-tracking.test.ts`
  and the refreshed live-PDP fixture in
  `tests/embed-hostile-neighbour.test.ts`, each with mutation checks that
  put the defect back. This also un-froze the theme add-to-cart price swap,
  which had stopped matching the button's string because the widget was
  quoting the wrong variant.

### Added

- **Theme MAIN price sync** (`themeSync.syncMainPrice`, default ON;
  `themeSync.mainPriceSelector` escape hatch, sanitized like
  `priceSelector`). The price under the product title now follows the
  selected purchase option with the same exact-money-string swap as the
  add-to-cart button (built-in list led by the store's `.pdp__price`);
  struck-through compare-at and per-unit lines are deliberately untouched.
  New root attributes `data-cellexia-price-sync-main` /
  `data-cellexia-main-selector`; a pre-v1.11.0 metafield (missing keys)
  means ON, per the schema-evolution rule.
- **`subscription_ultra_max` preset** (eighth preset). `subscription_max`
  taken to its logical end: the card sheds all offer chrome — no border, no
  tint, no badge, no savings pill, no reassurance line by default (each
  re-enableable) — so the subscription price reads as the product's plain,
  normal price; subscription is preselected; the recurring then-line always
  stays (recurrence disclosure is not optional). The quiet priced one-time
  line doubles as a relocatable **satellite** that `buy-box.js` mounts
  BELOW the theme's whole buy area (quantity, add to cart, guarantees)
  while the widget is visible — rendered inside the widget root so no-JS
  and launch-gated pages stay exactly as safe as `subscription_max`, with
  its own gate mirror, ownership assertion and ghost cleanup. Designer
  card, preview, per-market support and docs included.

### Changed

- `tests/liquid/size-limits.test.ts`: per-script performance ceiling raised
  92→112KB for the new tracking/satellite modules (a deliberate,
  commented decision, not drift). Total shipped Liquid stays within the
  88KB deploy budget.

## [1.10.0] — 2026-08-09

**Data-collection deep audit: 110 verified findings fixed, one additive
migration (0016), every ingest path made loss-proof or honest about its
limits.** A 19-agent adversarially-verified audit swept every data-collection,
aggregation and forecast-input path; this release implements the fixes. All
schema changes are additive (`0016_data_collection_audit`: 25 columns across 9
tables + `PriceChangeContractOutcome` + `AvailabilitySnapshot`).

**Capture-time corruption stopped (unrepairable-later class):**

- The acquisition PII scrubber no longer destroys legitimate data: slug-shaped
  campaign names (`black-friday-2025-conversion`), date-stamped campaigns and
  numeric ad-platform ids survive; real emails/tokens are still redacted; a
  capped unscrubbed `acqRaw.rawUtm` reserve allows future recomputation.
- CSV imports run acq columns through the same sanitizer (doc parity), compute
  first-order shape, and accept `subscribed_since` so a migrated book cohorts
  on its real signup dates instead of import day (docs/MIGRATION.md updated).
- Price-change batches carry `currencyCode`, reprice only matching-currency
  contracts, and record per-contract outcomes (`PriceChangeContractOutcome`)
  instead of stamping APPLIED over erased failures; notice events log only
  when the notice actually sent.

**Revenue books made true:**

- A successful charge can no longer be booked at 0 cents forever: redelivered
  success webhooks and the unsettled-attempt sweep true-up null `amountCents`
  (logging `billing.attempt_amount_backfilled`), and the new
  `ATTEMPT_AMOUNT_MISSING` alert surfaces any residue.
- Refund recording is atomic with its replay guard (one transaction), applies
  the same currency guard as revenue, logs unmatched refunds instead of
  dropping them, and the new `refund_reconcile` job re-attempts the match.
- Gift COGS survives the grant lifecycle: `GiftGrant.shippedAt` is stamped at
  settlement and both gross-profit surfaces count by it — cohort LTGP no
  longer silently loses every shipped gift's cost.
- One truthful "recovered" definition shared by rollup and dashboard;
  dunning cases persist the at-risk amount (`amountAtRiskCents`) at open, so
  the failed-payments queue finally shows money.
- CHALLENGED attempts get a lost-webhook recovery lane (Shopify re-query
  before dunning exhaustion) — a paid 3DS charge can no longer be unrecorded
  while the customer is wrongly churned.
- Settlement now persists the renewal order's discount/tax/shipping/subtotal
  and real processed instant, increments `lifetimeDiscountCents`, and captures
  a per-charge cost snapshot (`BillingAttempt.costSnapshot`) so gross-profit
  history stops being rewritten by later cost-setting edits.
- Foreign-currency exclusions are counted (`excludedForeignCurrencyCents`)
  instead of silently invisible.

**Forecast & risk honesty:**

- Per-cycle survival counts FAILED/EXPIRED contracts as churned (involuntary
  churn was censored); the "net of refunds" series actually nets refunds;
  gap-backfilled rollup days are flagged (`snapshotFabricated`) and treated as
  filled, not observed; model-error decay keys on calendar weeks; history
  window extended to 78 weeks; forecast grade wired into insights; learning
  labels recover involuntary-churn episodes cleared by later recovery;
  predicted-empty dates blend observed per-contract consumption with the
  merchant estimate.

**Silent-loss channels closed:**

- `logEvent` supports transactional writes (`{tx}`) + `logEventOrThrow`;
  swallowed event-write failures are counted and alerted
  (`EVENT_WRITE_FAILURES`) — take-rate, refund and saves counters were
  event-sole-source.
- ORDERS_CREATE replay guards are per-block, so a partial run re-completes on
  redelivery instead of permanently losing the take-rate denominator or the
  acquisition stash; test orders are excluded; design attribution uses the
  same subscribability test as the denominator and the embed stamps
  `_cellexia_design` even when the theme itself carried the selling plan.
- `backfillAllContracts` is finally wired (install + daily
  `full_sync_reconcile`), so pre-install contracts get mirrored and late
  mirrors stop stamping churn timestamps as "now".
- GDPR redaction scrubs the Klaviyo outbox (pending rows deleted, sent/dead
  rows anonymized) — redacted identities can no longer be transmitted
  outward post-erasure.
- NotificationLog is truthful: outbox rows that die flip their log row to
  FAILED via `outboxId` and emit `notification.failed`, so dunning dedupe
  stops sticking on messages never delivered.

**New collection (additive, consumed later per the data-foundation rule):**
fulfillment outcomes (`orders/fulfilled` → `fulfilledAt` /
`originOrderFulfilledAt` + `billing.order_fulfilled`), order cancellations
(capture-only `billing.order_cancelled`), `shop/update` + `customers/update`
sync (currency/timezone/identity drift), skip initiator separation
(`merchantSkipCount` — stockout/admin skips no longer poison churn-risk
features), pause reasons, portal visit + OTP failure/throttle telemetry,
add-on offer impressions (`cycle.addon_offer_shown`), daily variant
`AvailabilitySnapshot` from the alert scan, winback opt-out via SMS STOP
(`winback.opted_out`), expanded acquisition bundle (discount codes, checkout
locale, presentment currency, sales channel, marketing consent, order tags),
`expiredAt` churn stamping, consolidation clustering on exact cadence
(`unit:count`, never the week approximation).

**Deliberately deferred, documented:** buy-box impression beacons, Klaviyo
engagement ingest, ad-spend/CAC entry, the `orders/edited` money leg
(accepted-error entry in docs/DATA_FOUNDATION.md), extra forecast model
signals gated on backtest wins.

Verified: `npm run verify` green (tsc 0 errors, 2,673+ tests across 138
files, build clean); migration SQL proven equivalent to
`prisma migrate diff` output. Deploy notes: run `npm run deploy` so the four
new webhook topics register; migration 0016 applies on normal deploy;
`npx prisma generate` after pulling.

## [1.9.0] — 2026-08-09

**Debug tab: continuous live-store self-checks.** A new admin **Debug** page
(nav, between Audit and Settings) runs 28 read-only checks against the
DEPLOYED store — the failure modes local debugging cannot see — grouped by
category: platform (DB, migrations, required env/secrets, SMTP verify, clock
skew), Shopify connection (Admin API token, granted-vs-requested scope diff,
webhook delivery evidence, app-proxy identity probe), launch & storefront
(launch-flag divergence, selling-plan sync, ownership allow-list published +
appId match, storefront reachability incl. password-page detection), customer
portal (signing round-trip, a REAL portal fetch through the store domain and
Shopify's app proxy, demo-fixture health), billing (scheduler heartbeat, stuck
attempts past the sweeps' windows, forgotten overdue renewals, a
multiple-successful-charges-per-cycle guard), dunning (sweep heartbeat, zombie
RETRYING cases, overdue awaiting cases), jobs (per-job freshness against each
registered cadence), notifications (Klaviyo outbox draining/age-out, failed
sends, stale setup-mode suppressions after go-live) and data integrity (stored
settings that silently fell back to defaults, ownership attribution, open
alerts).

The same suite runs automatically every 30 minutes via the new ungated
`selfcheck_run` job (it only reads — catching a dead proxy BEFORE go-live is
its job), persists its report to the machine-written `selfCheck` setting, and
keeps ONE deduped CRITICAL `SELF_CHECK_FAILED` alert in sync with the verdict:
raised while broken (emails Settings → alerts → emailTo), auto-resolved when a
later run comes back clean. Each check carries a plain-language detail and a
named fix, doctor-style.

**Fixed — portal preview dead-ending at the setup gate.** "Preview with a demo
subscription" could land on the public "finishing touches" gate page instead
of the portal, through three separate paths, all closed:

- A **valid `?cx_pp=` preview token now outranks a stale non-preview
  `cx_portal` cookie** in `getPortalSession` (dev-harness path: an old OTP
  login shadowed every preview click; on a live store the proxy strips
  cookies, so ordering there is unchanged). An invalid token still falls
  through to the other identity paths.
- **Every gate site now names an expired preview link.** A gated request
  carrying `?cx_pp=` gets the "preview link has expired" page (new shared
  `closedPortalPage` in the portal layout) instead of the generic gate —
  previously only `/login` did this; a storefront-logged-in admin on a stale
  link fell through to a non-preview session and hit the nameless gate on
  every other route (portal home, account, subscription, api, cancel flow).
- **The token now survives dropped query strings** (classically: the
  storefront password page redirect). A page rendering a live preview stores
  the token in `sessionStorage`; the setup-gate page — sessionless by
  construction and only ever rendered while the store is dark — retries once
  with the stored token when its own URL lost it. No loop is possible: the
  retry URL carries `cx_pp`, and a page whose URL carries `cx_pp` never
  retries.

> **Update notes:** no migration, no new env vars, no scope changes.
> `shopify.app.toml` is unchanged (no `npm run deploy` needed for this
> release; the new checks read webhook/proxy state, they do not register
> any). New machine-written settings key `selfCheck`; new alert type
> `SELF_CHECK_FAILED`; new job `selfcheck_run` (every 30 min, ungated —
> runs in setup mode by design).

## [1.8.0] — 2026-08-08

**Order frequencies in days, weeks or months — mixable in one plan.** Plans
were week-only (`frequenciesWeeks` ints); a merchant could not offer
"every 10 days" or "every month", let alone both next to "every 2 weeks".
Frequencies are now `{unit: DAY|WEEK|MONTH, count}` pairs, freely mixable
inside one selling plan group, end to end: admin plan editor (token grammar —
bare ints stay weeks, `10d` / `1m` add units), Shopify selling-plan sync
(exact unit+count billing/delivery policies), buy box (localized unit nouns in
chips/dropdown/microcopy and the JS island, all 22 extension catalogs), portal
frequency change (token-valued options, all 22 app catalogs via the new
`freq.{every|option}.{unit}.{one|other}` key family), cancel-flow save offer
(suggests in the contract's own unit), bulk plan migration, CSV import
(`interval_unit`+`interval_count` columns; `interval_weeks` stays as the WEEK
alias), admin subscriber pages and CSV export (additive unit/count columns),
Klaviyo events and reminder vars (additive `*_unit`/`*_count`/localized
`frequency` phrase — every existing weeks-named property is retained).

Under the hood: one shared module `app/lib/frequency.ts` owns parsing,
normalization, tokens, labels and the week approximation; `contractFrequency()`
resolves a contract's exact cadence (mirror columns, `intervalWeeks`
fallback); `addIntervalTz()` advances dates calendar-exactly (month-end
clamping) and now drives the billing scheduler's optimistic advance, skip
preview/execution, gifts and win-back windows — the 4-weeks-per-month
approximation no longer drifts monthly schedules. Migration 0015 (additive:
two nullable Json columns on `SellingPlanConfig`); legacy week columns keep
being written as approximations for rollback safety.

> **Compatibility notes:**
> - **Week plans are untouched on Shopify.** The plan option value
>   "Every N weeks" is byte-frozen as the reconcile key (pinned by test), so
>   re-syncing an existing week-only group updates plans in place — same
>   GIDs, no storefront allow-list churn. New-unit plans are new plans.
> - **External names are additive-only.** `interval_weeks`,
>   `frequency_weeks`, `oldWeeks`/`newWeeks`, the subscriber-export
>   `intervalWeeks` column and magic-token `{weeks}` params all still exist
>   and still carry the whole-week approximation; unit-aware fields ride
>   alongside. Existing Klaviyo flows keep working unchanged.
> - i18n: `portal.schedule.every_weeks_option` was removed; four sentence
>   keys now take a pre-localized `{frequency}` phrase. All 21 translations
>   updated in this release (parity-tested).
> - Deliberately unchanged: delay quick-actions (1w/3w links, SMS DELAY's
>   2 weeks) stay week-denominated — they are duration offsets, valid for
>   any cadence — and the buy-box designer preview keeps its illustrative
>   week-only sample data.

Post-implementation adversarial review (7 finders, 3-vote verification per
finding) confirmed and fixed 8 further defects before packaging: a sticky
live-widget outage window (product-reconcile failure after a plan-GID-swapping
sync stranded the published allow-list — reconcile failures now report through
the ATTACH_FAILED path and the allow-list always tracks the live plans); the
billing sweep's stale-mirror heal now prefers Shopify's own next date (local
month steps clamp month-ends and would drift a day-31 monthly schedule); the
cancel-flow frequency save now accepts ONLY the exact offered cadence (the
pre-existing any-weeks bypass would have widened to daily billing); anniversary
gifts are granted once per rule (month-end window overlap could grant twice);
the cancel SKIP card previews Shopify's real post-skip date; bulk migration
matches YEAR-mirrored contracts its picker counts; rollback-window plan edits
now win over the stale multi-unit Json (coherence check between the column
families); prepaid plans keep their full label instead of colliding with the
plain plan of the same cadence; and buy-box frequency sentences are composed
from per-unit `every_*` phrases so gendered/case-marked languages stay
grammatical (French "toutes les 2 semaines" vs "tous les 10 jours") — all 21
extension catalogs updated, English output byte-identical. A plan offers at
most 20 frequencies (Shopify per-group plan cap headroom).

2250 tests (was 2160), `npm run verify` green twice, Liquid total 80,947
bytes of the 90,112 working ceiling.

## [1.7.0] — 2026-08-08

**The portal works on a real store: cookie-less identity.** Root cause of the
"Preview with a demo subscription" dead end — and of every portal login
failing on a live store while all local tests passed: **Shopify's app proxy
strips the `Cookie` request header and the `Set-Cookie` response header in
both directions** (shopify.dev, "About app proxies" → Disallowed headers).
The portal's entire identity model rode that cookie: OTP login set
`cx_portal`, the magic-link LOGIN hand-off exchanged `?handoff=` for the same
cookie — and on a live store the browser never received or returned either,
so every visit arrived sessionless and fell through to the setup gate
("We're putting the finishing touches…") with zero explanation. The local
harness reaches the app host directly, so cookies worked there and 2160 tests
proved a flow production could never run. Identity now rides the signed query
string, which the proxy HMAC covers end-to-end: **admin previews** use a
stateless, signed, 1-hour, view-only `?cx_pp=` token (the same trade-off as
the `?cx_preview=` storefront token — every mutation is already intercepted
for preview sessions), and **real customers** use Shopify's own
`logged_in_customer_id`, appended by Shopify to every proxied request when
the visitor is signed into their store account.

> **Migration notes:**
> - **Customers now sign in with their store account.** The portal login
>   page's primary CTA is `/account/login?return_url=…`; after Shopify's
>   login the portal opens with zero app cookies. The email → OTP-code flow
>   cannot work through the proxy and is hidden unless
>   **`PORTAL_COOKIE_DEV=1`** (new in `.env.example`) — set it only for a
>   local harness that reaches the app host directly.
> - Admin preview links minted before this release keep working: the magic
>   LOGIN executor now appends a fresh `?cx_pp=` token alongside the (dead on
>   live) hand-off.
> - No schema changes, no migrations, no new scopes.

### Added

- **`app/lib/portal/previewToken.server.ts`** — the stateless `?cx_pp=`
  admin preview token: `base64url(payload).HMAC` over the same signing
  primitives the session cookie already used (no new crypto), verified
  signature-first (timing-safe), then expiry, then **shop binding**. 1-hour
  TTL, multi-use, nothing stored server-side. The doc comment spells out why
  a URL token is acceptable *here* (admin-initiated, view-only, short-lived)
  while customer session tokens in URLs remain banned.
- **Two cookie-less identity paths in `getPortalSession`** (tried after the
  cookie, both safe only behind `authenticate.public.appProxy`, which every
  proxy route already runs first): a verified `cx_pp` token opens an
  `isPreview` session carrying the raw token; a numeric
  `logged_in_customer_id` opens a real session, matched against contracts
  storing either the customer gid or the bare id, email taken from the
  newest matching contract. `PortalSessionContext` gains
  `previewToken: string | null`.
- **Token propagation**: `withLocale(path, locale, preview?)` appends
  `cx_pp=` to portal-base URLs; every in-portal link, form action and
  redirect built under a session now passes `session.previewToken` (portal
  home, subscription page, account, api dispatcher, logout, the whole
  cancel flow), and the layout nav carries it via the new
  `PortalPageInput.previewToken`. The layout's client script re-stamps any
  portal-base link or form that slipped through (belt-and-suspenders — the
  token in the URL *is* the session).
- **Honest login screens** (`proxy.login`): an expired/tampered `cx_pp`
  renders "This preview link has expired — reopen it from the Cellexia
  admin" *before* the setup gate; a dead LOGIN hand-off redirects with
  `?signin=expired` and renders "That sign-in link has expired"; the primary
  CTA is the storefront sign-in. New keys under `portal.preview.expired_*` /
  `portal.login.*` in all 22 catalogs.

### Changed

- **Admin portal previews are direct links** (`app.preview`,
  `preview-portal-demo` / `preview-portal-subscriber`): the intents return
  `https://<store>/apps/cellexia-subs/?cx_pp=…` — opens instantly on the
  live store, valid 1 hour, multi-use, safe to share with staff — instead of
  minting a magic LOGIN URL whose cookie hand-off the proxy discarded.
  Checklist ticking and the `portal_preview_created` audit event are
  unchanged (payload gains `via: "cx_pp"`).
- **The magic LOGIN hand-off is kept** (harmless, still works in the local
  harness), and when the payload carries `preview: true` the redirect also
  appends a fresh `cx_pp` token so stale pre-1.7.0 preview links keep
  working on live.
- The setup-mode gates (`proxy._index`, `proxy.account`,
  `proxy.subscription.$id`, `proxy.api.$action`, cancel flow) needed no
  change: they key off `portalSession.isPreview`, which `cx_pp` sessions
  set — and preview mutation interception blocks every write for them
  exactly as before.
- **Sessionless bounces keep the request's `cx_pp`** (`loginRedirectUrl`,
  now exported from `session.server` and shared by `requireCustomer`,
  `proxy._index` and the api dispatcher): the portal home is the *exact*
  URL the admin preview mints, so an expired token lands there first — a
  redirect to `/login` that dropped the token would recreate the original
  dead-end (generic setup gate) instead of reaching the expired-preview
  card.
- **Sign-out follows the credential** (`proxy.account`, `proxy.logout`): a
  `logged_in_customer_id` session holds no app credential to destroy —
  Shopify re-appends the identity to every proxied request, so the app's
  own POST `/logout` deleted nothing and the `/login` bounce signed the
  customer straight back in. The account page now links those sessions to
  Shopify's `/account/logout` (the store account *is* the session), and a
  stale cached form that still POSTs the app's `/logout` is redirected
  there too. Cookie (dev-harness) and preview sessions keep the app form.
  `PortalSessionContext` gains `viaStorefrontLogin`.
- `verifyPreviewToken` guards a signed non-object payload before the first
  property access — `JSON.parse("null")` returns without throwing, so the
  parse's try/catch never saw it and the dereference escaped as a 500.
  Defense-in-depth only: unreachable without a valid HMAC, and the app
  never mints such a body.

### Tests

- 2200 tests (40 new): `cx_pp` mint/verify round-trip, expiry boundary,
  tampered signature/payload, wrong-shop binding; `getPortalSession` cx_pp +
  logged_in_customer_id paths (gid/numeric normalization pinned on the
  query), bare and empty-licid requests still null; `withLocale` third
  parameter (portal paths only — the token never leaks onto
  `/account/login`); login-page branches (expired preview beats the setup
  gate, `signin=expired`, OTP hidden by default and back under
  `PORTAL_COOKIE_DEV=1`); setup-gate bypass for `cx_pp` sessions on the
  portal home and subscription pages with the token threaded through every
  rendered action URL; mutation interception bouncing `cx_pp` sessions with
  the token intact; and the preview intents returning direct, verifiable
  `cx_pp` URLs with the audit/checklist side effects preserved. Hardening
  pass: an *expired* `cx_pp` at the portal entry URL (and on a mid-preview
  POST) redirects to login with the token intact and the followed page
  names the expiry; the storefront-login account page renders the
  `/account/logout` link (never the dead POST form, which cookie sessions
  keep); POST `/logout` with `logged_in_customer_id` hands off to Shopify's
  logout; a signed non-object token body fails closed instead of throwing.

## [1.6.9] — 2026-08-08

**Ownership hardening: two factors, exact sets.** After the v1.6.6 id-space
fix, a single field — one `planIds` entry in the `cellexia.plan_groups` shop
metafield — decided storefront ownership by itself: anything that could
write a plan id into that metafield (a bug, a bad migration, a forged
request, any app holding `write_metafields`) was sufficient **alone** to
render a foreign selling plan group through our buy box. Ownership now
requires BOTH, together: the group's `selling_plan_group.app_id` equal to
the `appId` this app publishes about itself, AND the group's live plan set
**exactly equal** to a published `planSets` entry — same members, same
count. Exact set equality (not "any one plan on a list") is deliberate: an
app id is public and any app can stamp any string onto its own groups, so
against a competitor that pre-stamped our id onto its single-plan group, an
any-member rule would collapse straight back to one corruptible field. Under
exact sets, corrupting one entry darkens the widget (fails closed, ours
included); rendering a foreign group requires authoring its complete
coherent set — wholesale forgery of the trust anchor, the documented
residual. **No schema changes, no migrations, no new scopes** (the app-id
read uses `currentAppInstallation`, already covered).

> **⚠️ Upgrade order for a live store (avoid a dark-widget window):**
> `selling_plan_group.app_id` is **nil** until this app stamps it — Shopify
> never fills it in — and the new storefront gate requires it plus the new
> `planSets` field. Deploy in this order: **(1)** deploy the app server
> (this ZIP), **(2)** press **Sync to Shopify** on the Plans page (stamps
> the group + republishes the allow-list with `appId`/`planSets` — the old
> extension ignores the new fields and keeps rendering off
> `groupIds`/`planIds`, which are still published), **(3)** `npm run deploy`
> the extension. Doing (3) before (2) blanks the buy box until the sync
> runs; the Preview Doctor names the exact missing half, and the daily
> alert sweep now republishes automatically within 24h as a backstop.

### Added

- **`appId` + `planSets` in the `cellexia.plan_groups` metafield (v2)**:
  published on every plan sync, go-live and config delete. `appId` is this
  app's own numeric App id (`getCurrentAppId()` via
  `currentAppInstallation`) — unlike selling plan group ids (opaque,
  per-shop identifiers in storefront Liquid: the v1.6.6 outage), an app id
  reads identically from the Admin API and from Liquid. `planSets` is each
  owned group's **live** plan-id set, read off Shopify at publish time via
  `getSellingPlanGroupOwnershipStates()` — deliberately NOT the append-only
  DB evidence, which keeps dead plan ids for billing safety and can never
  serve an exact-count comparison. If the live state cannot be read, the
  publish fails and the previous metafield stays: stale-but-valid beats
  fresh-but-dark.
- **The app-id stamp**: every group create AND update writes
  `SellingPlanGroupInput.appId`, and `publishOwnGroupsMetafield()` heals
  unstamped (pre-1.6.9) groups via `stampSellingPlanGroupAppIds()` before
  writing the metafield — so flows that republish without a full group sync
  (go-live, config delete) can never publish an `appId` the groups don't
  carry. The heal's outcome is **surfaced, never swallowed**:
  `PublishResult.heal` lists stamped/already-stamped/failed groups, and the
  go-live audit records `published but INCOMPLETE (appId stamp failed …)`
  instead of a bare "published" over a dark storefront. A sync that cannot
  read the app id fails loudly on the plan row rather than producing a
  group that can never render.
- **Preview Doctor honesty** (`allow_list` step): verifies the published
  `appId` against the installed app **verbatim** (the storefront never
  trims — a whitespace-padded appId is reported as exactly that, not
  trimmed into a false PASS), the group-side stamp, AND exact set coverage
  of each group's live plans, all off one
  `getSellingPlanGroupOwnershipStates()` read. New diagnostic attributes on
  the no-owned-group marker — `data-cellexia-diag-allow-app-id` ("none" for
  a pre-1.6.9 metafield) and `data-cellexia-diag-set-count` (plan-count 3
  with set-count 0 reads as a pre-1.6.9 metafield) — make the same states
  readable in a browser inspector next to the per-group app ids.
- **`OWNERSHIP_FACTORS` daily alert with self-heal** (riding the existing
  PLAN_GROUP_DRIFT 24h Admin-API budget): the sweep verifies both
  storefront factors against the live state — the dark-widget class that
  attachment verification cannot see (e.g. the extension deployed before
  Sync during this upgrade) — **republishes automatically**
  (`publishOwnGroupsMetafield` stamps + rewrites), and raises the WARNING
  only when the republish did not fix it.

### Changed

- **The storefront gate** (`cx-buybox-core.liquid`) requires both factors,
  each mandatory and fail-closed: the correct plan set with the wrong or
  missing appId renders nothing; the right appId with a partial, superset,
  or one-member-mutated set renders nothing; a metafield published before
  this release renders nothing until the next sync republishes it —
  briefly absent beats briefly wrong, and every degraded state self-heals
  on the next sync, publish, or daily sweep.

### Removed

- **The legacy group-id OR** in the storefront gate — the v1.6.6 demotion
  left it in the code although it could never fire in production
  (admin-numeric ids cannot equal Liquid's opaque group ids), making it
  pure attack surface reachable only by a hand-written metafield carrying
  the opaque id form. The branch is gone; `groupIds` and the any-member
  `planIds` union still travel in the metafield for the Preview Doctor,
  debuggability and the pre-1.6.9 extension, but the new storefront gate
  reads neither.

### Tests

- 2160 tests (39 new). Mutation-proven three ways on the Liquid gate:
  disabling the app-id comparison fails 3 tests, deleting the blank-appId
  guard fails the dedicated mutation-killer (nil-vs-nil must never match,
  pinned against stamped/unstamped groups and missing/empty/whitespace
  appIds), and weakening set equality to any-member fails 2 (partial and
  superset sets). Also pinned: the single-entry-corruption scenarios with a
  competitor that copied our appId (legacy planIds corruption is inert; set
  corruption darkens everything; only the full authored forgery renders —
  the honest residual), live-set-vs-dead-DB-evidence separation on the
  publish path, publish failing closed when the live read fails, heal
  outcome surfaced through publish → go-live audit, the Doctor's seven FAIL
  shapes (missing/mismatched/whitespace appId, missing planSets, unstamped
  group, unreadable group, uncovered live set), and the daily sweep's
  verify → republish → alert ladder.

## [1.6.8] — 2026-08-08

**Variant-switch price fix — merchant-reported, live on their store
(subscription_max preset).** Their theme sells jar packs as SEPARATE
VARIANTS switched by its own pill buttons ("1 Jar | 2 Jars - 15% Off |
3 Jars - 20% Off"): clicking a pill updates the theme's price display and
the cart, while every price the widget shows — first-order price, the
"then … every …" line, savings, the quiet "or buy once for …" link, and
the money pair feeding the theme add-to-cart price sync — stayed frozen
on the landing variant. Two root causes, both fixed: the theme sets its
variant state **programmatically** (jQuery `.val()` — no `change` event,
no `?variant=` write), so every listener the widget had stayed silent;
and the data a full repaint anchors on was not entirely per-variant —
the root `data-cellexia-money-*` pair stayed server-rendered for the
landing variant, and the island's matrix lacked per-variant compare-at,
cents and the ongoing price. **No schema changes, no migrations, no env
changes, no new scopes**; total extension Liquid 74,762 bytes, still
under the size suite's ceiling.

### Fixed

- **`buy-box.js`: event-independent variant tracking**, layered under the
  existing (kept) listeners: an authoritative re-read — the theme's
  `[name="id"]` input-or-select (bound form first, then a read-only
  document-wide scan that skips our own markup and accepts only ids the
  island knows), then `?variant=`, else keep the current variant; click
  delegation over the product area scheduling that re-read on the next
  macrotask and again at +350 ms (themes update state asynchronously);
  and a 600 ms poll of the same field — string compare, only while
  `document.visibilityState === 'visible'`, one interval per widget,
  cleared on pagehide and on detach, re-armed by `resync()` — which
  catches ANY switching mechanism, including pure-JS themes.
- **Several `[name="id"]` fields for one product no longer race on
  document order.** A page can carry duplicates of the theme's variant
  field (quick-buy modal, sticky add-to-cart bar, featured-product
  section); the scan formerly trusted the FIRST island-known value, so a
  stale duplicate could freeze the widget — or flip it to the wrong
  variant. Disagreements between island-known values are now settled on
  evidence: the field whose value actually **changed** since the last
  read (the one the shopper is driving) wins, then a field inside the
  widget's own section, else the current variant is kept. The poll also
  stopped paying a document-wide `querySelectorAll` per tick: it reuses
  the last scan's field list (validated for liveness, fully re-queried
  every 10th tick), while click-driven re-reads always re-query.
- **A variant added AFTER plan sync parks the widget instead of freezing
  it on stale prices.** A numeric id the island has no row for — read
  from the bound (ownership-checked) form, or from a field previously
  seen holding this product's ids — is conclusive: nothing the widget
  shows could price it, and a `selling_plan` left in the form could 422
  the theme's add-to-cart. The widget hides itself (root `[hidden]` +
  `data-cellexia-unsynced`), releases the form (plan field removed or
  emptied, design property disabled), restores the theme's button text
  and serves no `getState()` (so the embed's cart patcher carries no plan
  either); it un-parks with a full repaint the moment a known variant
  returns. Foreign numeric ids with no such history (another product's
  quick-add) never park anything. Re-syncing the plan ships a fresh
  island, so a reloaded page prices the new variant normally.
- **On a variant change, every price surface of every one of the seven
  presets repaints** from the island matrix (option cards, first-order
  line, then-line with `{frequency}` preserved, savings from matrix
  strings, per-delivery, tiles compare rows, the subscription_max quiet
  link amount), the root `data-cellexia-money-onetime`/`-sub` pair
  re-anchors, and the theme add-to-cart price sync re-syncs so the
  theme's button quotes the NEW variant's subscription price. A sold-out
  variant still renders its prices; add-to-cart behaviour stays the
  theme's. `textContent` writes only, as everywhere.

### Added

- **Per-variant price matrix completion in the JSON island**
  (`cx-buybox-core.liquid`): every available variant row now also carries
  `oneTimeCents` and `compareAt` (formatted, only when it beats the
  price), and every variant × plan entry carries `firstCents` and the
  formatted `ongoing` price — money strings pre-formatted in the shop
  money format and RAW-decoded at the island boundary, as before. The
  cents feed exact client-side comparisons (the strike-through decision),
  so the JS still never formats money or does price math for copy.
- **Tests**: `tests/buybox-variant-tracking.test.ts` drives the REAL
  Liquid render (new three-variant jar fixture: distinct prices, one
  compare-at, one sold out) and the REAL `buy-box.js` through a
  programmatic variant switch — `[name="id"].value` set with NO events —
  and asserts every price surface, both money attributes and the theme
  button re-anchor for classic and subscription_max, plus the
  click-delegation path and the visibility gate; **mutation checks**
  disable the poll and the disagreement rules in the loaded source and
  prove the respective tests fail without them. Multi-field pages
  (stale quick-buy duplicate first in document order, boot-time
  disagreement, a field injected after boot crossing the scan-cache
  window) and the un-synced-variant park/un-park cycle (formless and
  bound-form, including the form release and reinstatement) are each
  pinned. Dropdown themes are covered on their own: a `<select
  name="id">` page (formless and bound-form — ownership proven through
  the select) is caught by the poll after a programmatic option flip,
  with a mutation check cutting the scan's `select[name="id"]` half to
  prove that branch load-bearing. The poll's lifecycle is pinned too:
  `pagehide` clears the widget's single interval (the window stub
  records real listeners now), a switch made while the poll is dead is
  provably missed, and `CellexiaSubs.resync()` re-arms a genuinely live
  poll that catches the next switch. The 600 ms period itself is pinned
  as a value at both arm sites (mount and resync re-arm): the interval
  stub records the registered delay and the suite asserts it, so a poll
  quietly regressed to a long period fails the suite instead of passing
  on tick-driven tests alone.
  `tests/buybox-foreign-section-form.test.ts` gained a two-nets
  vacuity guard proving the park alone already defuses the old
  `|| scoped[0]` fallback defect. `tests/liquid/variant-matrix.test.ts`
  is the golden render of the island matrix (every variant × every plan,
  prices, cents, compare-at, availability, selected-variant id), now
  including **byte-golden snapshots** of the three-jar island for
  classic and subscription_max.

## [1.6.7] — 2026-08-07

**Diagnosability release — the blank storefront preview now explains
itself.** Reported live by the merchant: they created a plan, opened a
storefront preview, and NOTHING showed — no error anywhere, just an ordinary
product page. Triage against the live store found the extension and app proxy
had simply never been deployed (deploys were rejected for size until v1.6.4)
and the plan possibly not synced to the product — but establishing that took
a developer bisecting the store by hand. The widget render chain has ~7
independent gates (extension deployed + app embed enabled on the published
theme, plan synced, selling plan group attached to the product,
`cellexia.plan_groups` allow-list published, launch gate, valid preview token
+ reachable proxy, JS mount), and every closed gate produced the identical
symptom: a silently blank page. v1.6.7 makes the chain self-explaining at
both ends — a **Preview Doctor** in the admin that walks the chain against
the live store and names the first closed gate, and admin-only diagnostic
cards on the storefront when preview validation itself fails. Fail-closed
rendering for customers is unchanged everywhere. **No schema changes, no
migrations, no env changes, no new scopes**, and the extension `.liquid`
size budget is unchanged (the size suite still enforces the total).

### Added

- **Preview Doctor** (`app/lib/launch/doctor.server.ts`, surfaced on
  **Preview & launch → Storefront preview**, intent `run-doctor`): walks the
  render chain in order, against the LIVE store, caching nothing — (a) plan
  synced (active, `SYNCED`, Shopify group **and** selling plan ids
  recorded); (b) the diagnosed product is in the plan's product list;
  (c) Shopify attachment read-back (Admin GIDs against Admin GIDs — one id
  space); (d) the `cellexia.plan_groups` allow-list is published and carries
  our group id **and our plan ids** — the v1.6.6 id-space model: the
  storefront matches ownership on PLAN ids, so a list with group ids but an
  empty/foreign `planIds` renders nothing and is a FAIL here; (e) the
  app-proxy identity probe — HTTP 404 reads as "Shopify has no proxy
  registered for this app" (the undeployed-app incident), a foreign body as
  "something else owns the path", and unlike the launch-checklist row an
  unreachable proxy is a FAIL, because this exact probe is what the
  visitor-side reveal runs; (f) a real fetch of the live product-page HTML
  looking for our markup markers — the end-to-end proof that the deployed
  extension + enabled embed actually reach the storefront; (g) launch mode,
  informational. Each step reports **PASS/FAIL/WARN/SKIP** with a detail
  line and a remediation; the report carries verdict **READY/BLOCKED** plus
  `firstBlockedStep`; WARN means inconclusive (storefront password page, bot
  protection, a network hiccup between app host and store) and never
  blocks. Every step is independently contained — a throwing step becomes a
  FAIL row with the error, never a crashed report — and each run logs one
  `preview_doctor_run` audit event with the verdict.
- **The storefront preview gates on the doctor**: "Preview on product page"
  runs the diagnosis before opening the tab. On BLOCKED, the report renders
  inline in the admin (the toast names the first failing step) instead of
  opening the blank page — with an **Open anyway** escape hatch, so nothing
  is ever hard-blocked; a doctor that itself cannot run fails open and never
  blocks the preview on its own error — but not silently: the preview opens
  with a toast saying the pre-flight diagnosis was skipped (pointing at
  **Run diagnosis**), and the `storefront_preview_created` audit event
  carries `doctorSkipped: true`, so an un-vetted preview never reads as a
  vetted one. The "Storefront previewed" checklist item now ticks **only off
  a doctor-vetted open**: a blocked preview ticks nothing, and neither does
  an un-vetted open — **Open anyway** (the doctor just said BLOCKED) or the
  fail-open path (the doctor crashed, chain state unknown) opens the tab but
  leaves the checklist alone, says so in the toast, and stamps the audit
  event with `checklistPreviewedStorefront: false` (plus `openAnyway`/
  `doctorSkipped`) — the checklist can never be ticked off a preview that
  opened a blank page.
- **Storefront-side failure cards, admin-only**
  (`extensions/cellexia-buy-box/assets/buy-box.js`): when the URL of THIS
  page load carries `?cx_preview=` and the validation round-trip completes
  with a failure, the existing admin-diagnostic card style names the reason
  — `{ ok: false }` → "this preview link is expired or invalid … generate a
  fresh preview link from Preview & launch"; an HTTP error status or network
  failure → "the preview could not be validated (HTTP 404) … run the
  Preview Doctor" (the exact blank page an undeployed app produces; the
  admin-gated doctor then names the undeployed proxy and the deploy
  command). Gated on the URL parameter, never `sessionStorage`, so a token
  following the tab to other pages raises nothing there and a customer can
  never be shown vendor English; the widget itself stays fail-closed and is
  revealed only by a validated session, exactly as before. A transport
  failure keeps the stored token, so a reload after deploying just works.
  Because this card's gate is the URL parameter alone (validation failed —
  no admin is proven), its copy is treated as an **unauthenticated
  surface**: it names no proxy paths and no operator commands; that detail
  lives behind admin auth in the Preview Doctor it points to.
- **Preview picker honesty**: products whose page can never show the widget
  — draft or archived in Shopify, or no selling plan group attached — stay
  listed in the storefront-preview picker but disabled, with the reason on
  the option. The preview no longer offers a link that opens a 404 or a page
  this app deliberately renders nothing on (while ticking "Storefront
  previewed" for a preview that never happened). The Preview Doctor's own
  product picker deliberately keeps every product selectable — the broken
  ones are exactly the ones worth diagnosing.

### Changed

- **Every admin diagnostic card now requires `?cx_preview=` in the URL of
  the page it appears on.** The two pre-existing cards — the no-owned-group
  hint (`buy-box.js`) and the placement-anchor hint (`buy-box-embed.js`) —
  kept their server-validated-session gate but could ride the
  `sessionStorage` token onto same-tab pages the admin never previewed
  (PDP → cart keeps the validated session alive by design, for the widget
  reveal). They now additionally require the `cx_preview` parameter in the
  current page's own URL, the same gate the new failure card uses — so a
  diagnostic card can only ever appear on a page actually opened through a
  preview link, and only with the proxy's `{ ok: true }` on top. The widget
  reveal itself (PDP → cart persistence) is unchanged.

### Tests

- `tests/preview-doctor.test.ts` (30 tests, DB-free): each step PASSes on
  the all-green world and FAILs on its own broken fixture (unsynced plan,
  product not in the config, missing/junk/empty-`planIds`/foreign-`planIds`
  allow-list, proxy 404 vs foreign body vs unreachable, marker-less live
  HTML, DRAFT product); a THROWING storefront fetch is WARN, not FAIL, and
  WARN never blocks; verdict/`firstBlockedStep` follow chain order over a
  full walk (no short-circuit); a throwing step — up to and including an
  unreadable shop — never crashes the report; the `preview-storefront`
  action returns the report instead of a URL on BLOCKED, honours
  `openAnyway`, and opens normally on READY; the fail-open path is pinned
  as NOT silent (a doctor that itself throws still opens the preview, but
  the response carries the skipped-diagnosis toast and the audit event
  `doctorSkipped: true`); plus a mutation check on the proxy-identity
  assertion (flip the probe to a foreign body → FAIL, restore → PASS).
- `tests/preview-failure.test.ts`: the storefront failure cards, driven over
  the real server-rendered Liquid and the real `buy-box.js` in both install
  shapes (section block and app embed) — including the customer gate
  (storage-only token: silence), the one-card guarantee on the embed
  shape, and a no-internal-detail assertion (the failure card, being an
  unauthenticated surface, must never name proxy paths or operator
  commands). Plus the placement-anchor card's double gate: it appears for a
  validated admin on the preview-linked page and stays silent on a VALIDATED
  storage-only hop.
- `tests/server-bundle-size.test.ts`: tracked-growth guard on the app
  server build — biggest chunk ≤ 3MB, whole `build/server` tree ≤ 4MB
  (today ~2.3MB); skips when no build output exists. The extension has had
  size gates since v1.6.3; the app server had none, and its bundle had
  grown to ~2.3MB unnoticed.
- `tests/buybox-no-owned-group.test.ts` extended for the double gate: a fully
  validated storage-only session (the PDP → cart hop) raises no hint card in
  either install shape — while the widget reveal itself still follows the
  hop. Both new pins were mutation-checked (gate reverted to validated-only →
  each suite fails on exactly its new test; gate restored → green).

### Documentation

- **OPERATIONS.md §20** — new runbook **"Widget not showing?"** that starts
  with "Run the Preview Doctor", maps the 7 gates to their fixes, and
  explains WARN vs FAIL; pointers added from §14 (launch mode) and §16
  (buy box embed).
- **INSTALL.md §9/§10** — the Preview Doctor is named as the first debugging
  step whenever a preview shows no widget, and §10b notes the preview button
  runs it automatically.
- **TESTING.md §10** — the preview QA pass starts with the doctor when the
  widget is missing.

## [1.6.6] — 2026-08-07

**Live-blocker release — the buy box treated our own synced plan as another
app's.** The merchant saw the "plans from another subscription app" admin
card (and no widget) on a product whose Cellexia plan sync had SUCCEEDED,
because storefront Liquid exposes selling plan **group** ids in a different
id space than the Admin API ids the `cellexia.plan_groups` allow-list
publishes — group-id equality can never match in Liquid, so storefront
ownership matches on selling **plan** ids (numeric and identical in both
APIs; the same ids the cart's `selling_plan` param already uses). This
release also closes the follow-on trust gap on the admin side: **SYNCED is
now a verified claim** — the app re-reads product attachment from the Admin
API after every sync and re-checks it daily, so the Plans page can never say
SYNCED while the storefront disagrees. **No schema changes, no migrations,
no env changes, no new scopes.**

### Added

- **Post-sync attachment verification (Plans → Sync to Shopify)**: after the
  selling plan group mutations succeed, the app re-queries every product in
  the config for its `sellingPlanGroups` (Admin API GIDs against Admin API
  GIDs — one id space, reliable exact equality, unlike storefront Liquid
  group ids) and records `SYNCED` only on a full attach. Any product missing
  the group — the signature another subscription app's product sync leaves
  when it reconciles products it also manages, or a deleted product — sets
  `syncStatus` **`ATTACH_FAILED`** with `syncError` naming the products, and
  the Plans row shows a critical **Attach failed** badge with that message
  instead of Synced. An unverifiable attach (the verification read itself
  failing) is also `ATTACH_FAILED`, never silently `SYNCED`. New
  `findProductsMissingFromGroup` in `app/lib/graphql/sellingPlans.server.ts`
  (batched `nodes(ids:)`, 25 products per query); ownership evidence and the
  allow-list metafield are still recorded either way, since the group and its
  plans do exist on Shopify.
- **Daily drift alert (`PLAN_GROUP_DRIFT`)**: the alert scan now re-verifies
  every `SYNCED` config's product attachment (same batched Admin API check),
  self-gated to one sweep per 24h on the `system.plan_group_drift_check`
  event trail so the 15-minute scan cadence never hammers Shopify. On drift
  it raises a deduped WARNING — "Your Cellexia plan was detached from
  {products} — another subscription app's sync may be reconciling products it
  manages. Re-sync on the Plans page, and exclude these products from the
  other app's management." Resilient by construction: per-config try/catch,
  title-lookup failures fall back to product GIDs, and a partially failed
  sweep still timestamps itself.

### Changed

- [docs/OPERATIONS.md](docs/OPERATIONS.md) §18 (running alongside another
  subscription app): documents the id-space lesson (storefront group ids ≠
  admin group ids; ownership matches on plan ids) and the drift scenario with
  its remediation (re-sync, then exclude the products from the other app's
  management — the exclusion is the durable fix).

### Migration notes

None. No schema change; the new `ATTACH_FAILED` value lives in the existing
`syncStatus` string column. Re-deploy the app; re-deploy the extension with
`npm run deploy` if this release ships with the buy-box ownership fix.

## [1.6.4] — 2026-08-07

**Deploy-blocker release — the Liquid limit model was wrong.** The 100KB
Liquid limit is **TOTAL extension-wide** (verified empirically by the
merchant's developer via a real `shopify app deploy`) — v1.6.3's per-file
model was wrong; all Liquid minified from 110,294 → 72,760 bytes; guard
rewritten around the total budget. A plain PATCH: **no migrations, no schema
changes, no env changes, no scope changes**. Applying this release requires
`npm run deploy` (the whole point is getting the extension under the real
budget).

### Fixed

- **Extension — combined Liquid over Shopify's 100KB TOTAL budget (deploy
  rejected)**: v1.6.3 modeled the platform's 100KB Liquid limit as
  per-file, so its guard passed a tree whose ten `.liquid` files summed to
  110,294 bytes — and the real `shopify app deploy` rejected it, proving
  the 102,400-byte budget is enforced on the **total of all `.liquid` files
  in the extension**. All shipped Liquid is now minified
  (110,294 → 72,760 bytes): leading indentation stripped (cosmetic inside
  `{% liquid %}` blocks; in HTML it collapses to the same inter-element
  whitespace as the kept newline — **every newline is kept**), blank lines
  removed, remaining comments trimmed to one line each pointing at the
  extension README's "Core snippet internals". No logic changes, no
  renames, no reordering — the render goldens prove the output is
  unchanged, and the byte-stability snapshots were regenerated with a
  whitespace-only diff. The seven preset partials are kept (they no longer
  buy budget under a total model, but they still buy maintainability).
- **Guard — `tests/liquid/size-limits.test.ts` rewritten around the total
  budget**: the PRIMARY assertion now holds the **TOTAL** of every shipped
  `.liquid` file ≤ 90,112 bytes (88KB — 12% margin under the platform's
  102,400-byte total, matching the working ceiling in the extension
  README), with the empirical verification and the remediation
  order (strip whitespace/comments first; merge partials second; move
  logic to JS/assets last) in the failure message. The old per-file check
  survives as a belt at the same ceiling. All other guards (block count,
  bundle size, locale caps, JS/CSS performance ceilings, schema validity)
  are unchanged.

### Changed

- Docs corrected to the total-budget model:
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/UPDATE.md](docs/UPDATE.md), [docs/TESTING.md](docs/TESTING.md) and
  the extension README no longer describe the limit as per-file; the README's
  "Core snippet internals" section now carries the minification discipline
  (edit at column 0, keep every newline, prose lives in the README).

### Migration notes

None. Re-deploy the extension with `npm run deploy`.

## [1.6.3] — 2026-08-07

**Deployment-blocker release.** The first real `npm run deploy` of 1.6.2
surfaced four blockers that nothing in CI exercised — every one of them was
only discoverable on the deploy console (or, for the last item, on the hosting
provider's health dashboard). Each is fixed AND now carries a permanent guard
in the suite, so the whole class fails in `npm run verify` instead of at
deploy time. A plain PATCH otherwise: **no migrations, no schema changes, no
env changes, no new scopes** (one *invalid* scope entry is removed — nothing
to re-approve, since it was never grantable). Because `shopify.app.toml`
changed (scope list corrected, app-proxy subpath), applying this release
requires `npm run deploy`.

### Fixed

- **Extension — core Liquid file over Shopify's 100KB hard limit (deploy
  rejected)**: `snippets/cx-buybox-core.liquid` had grown to 111,374 bytes,
  and `shopify app deploy` rejects any theme-extension Liquid file over
  102,400 bytes. The seven design presets now live in seven partials
  (`snippets/cx-preset-*.liquid`, 3–6KB each) rendered DIRECTLY from the
  core's `{% case %}` — direct-to-markup renders leave Shopify's BEGIN/END
  app-snippet comment markers as invisible HTML comments (they are never
  captured: capture-around-render is the exact v1.2.0 corruption shape and
  stays forbidden forever), and the remaining maintainer essays moved to the
  extension README, bringing the core to ~64KB.
  `tests/liquid/lint.test.ts` pins the refined invariants (renders only in
  direct-output markup position, the snippet set itself, preset partials
  render/compute nothing further), `tests/liquid/render.test.ts` proves the
  refactor changed nothing but the inert comment markers, and NEW
  `tests/liquid/size-limits.test.ts` makes the budgets permanent: every
  `.liquid` ≤ 90KB (platform rejects at 100KB), combined Liquid ≤ 450KB,
  ≤ 25 blocks, whole bundle ≤ 9MB, every locale file valid JSON and ≤ 16KB,
  plus our own performance ceilings on the assets (JS ≤ 92KB, CSS ≤ 64KB).
- **Config — invalid scope `write_customer_payment_methods` removed (deploy
  rejected)**: the scope does not exist in Shopify's scope catalogue, so
  config validation refused the whole push. Payment-method mutations are
  authorized by `write_customers`, which the app already requests; the
  phantom entry is gone from `shopify.app.toml` and
  [docs/INSTALL.md](docs/INSTALL.md), and
  `tests/deploy-config.test.ts` keeps the toml and `.env.example` scope lists
  identical and covering every mutation the app calls.
- **Config — app-proxy subpath collided with the merchant's other live app
  (portal dead on arrival)**: the proxy was configured at `/apps/cellexia`,
  but the merchant's "AOV & LTV Booster" app already serves that subpath on
  the same store, so every portal URL would have been answered by the wrong
  app. The subpath is now **`cellexia-subs`**, with a single source of truth
  (`PORTAL_PROXY_SUBPATH` in `app/lib/portal/proxy-path.ts`);
  `tests/proxy-subpath.test.ts` pins all four places the path appears into
  agreement and bans the legacy value forever, and the go-live checklist
  gained a **proxy-identity probe** that fetches the live proxy URL and
  verifies OUR app answered (OK / MISMATCH / UNREACHABLE) before launch, so a
  future collision is caught by the checklist rather than by a customer.
- **Extension — embed block schema rejected by the CLI (`"default": ""`)**:
  the anchor-selector text setting declared an explicit empty-string default,
  which `shopify app deploy` schema validation rejects — an absent default IS
  empty, so the key was removed (behaviour unchanged).
  `tests/liquid/schema.test.ts` now mirrors the CLI's schema checks (labels
  present, select defaults among their options, checkbox defaults boolean,
  no empty-string defaults, …) so the next schema mistake fails in vitest,
  not on the deploy console.
- **Hosting — bare-root `HEAD /` health probe answered 500**: the root route
  called `login()` from `shopify.server`, which reads the request body and
  throws on the bodyless HEAD probes hosting health checks and load balancers
  send — every probe became a 500 and the host flagged the deploy unhealthy.
  The root loader now touches only the URL (`?shop=` still redirects into the
  embedded app; everything else gets a plain 200); real monitoring belongs on
  `/api/health`.

## [1.6.2] — 2026-08-06

**Second pre-launch stabilisation sweep.** A further review pass over the
billing, dunning, gift, reactivation, import, notification and launch
surfaces, on top of the 1.6.1 sweep. Every fix is enumerated under Fixed
below; each is pinned by the named test(s).

**One migration ships with this release: `0014_challenged_attempt_marker_repair`
— a pure data repair, no schema change** (one scoped `UPDATE` clearing
`declineCategory` on rows still sitting `CHALLENGED` + `AUTH_REQUIRED`; no
`ADD COLUMN`, no DROP, no RENAME, no type change — the header carries the full
story). Run `prisma migrate deploy` as usual. **One new scheduled job**:
`settlement_redrive` (every 15 minutes, no configuration). **No new scopes, no
new env vars.**

**One deliberate operational behavior change**: in production the mailer now
REFUSES the implicit console fallback. A deploy with `MAIL_PROVIDER` unset (or
typo'd) used to console-log every OTP / 3DS / admin email and record it SENT;
it now fails the send loudly (FAILED in NotificationLog) and `/api/health`
reports 503 until `MAIL_PROVIDER` is set explicitly to `smtp` or `console`.
Check your deployment env before updating.

Versioning honesty, as in 1.6.1: numbered as a stabilisation PATCH of 1.6.x
(bug fixes only, no features), but because a migration ships, follow the
[docs/UPDATE.md](docs/UPDATE.md) §4 procedure (backup, `prisma migrate
deploy`) rather than the bare PATCH shortcut. No `npm run deploy` /
re-approval is needed — scopes are unchanged.

### Fixed

- **Billing — the 3DS challenge stamp masked the failure engine's processed
  marker**: both challenge claims (`onBillingAttemptChallenged` and the stale
  sweep's CHALLENGED branch) stamped the ATTEMPT's `declineCategory =
  'AUTH_REQUIRED'` at challenge time — but that column is
  `onBillingAttemptFailed`'s written-LAST "processing complete" marker, so
  when the challenged attempt's real FAILURE webhook later arrived (customer
  abandoned the challenge, bank declined post-authentication) the engine saw
  FAILED + non-null category and returned: no retry ladder for recoverable
  post-3DS declines, no `consecutiveFailures` increment, and the cycle sat
  held until `cancelAfterFailedDays` exhausted the case. The attempt column
  now stays null until the failure engine truly finishes (the CASE's
  `declineCategory` and the `mitEvidence` fold keep the challenge state), and
  migration 0014 repairs the rows the old code already stamped. Pinned by
  tests/dunning-challenge-marker.test.ts.
- **Billing — half-settled attempts whose webhook retry train is dead now
  self-heal (`settlement_redrive` job)**: a handler that THROWS is answered
  200 FAILED (a 5xx would get the webhook disabled), and any 2xx permanently
  ends Shopify's redelivery for that id — so the 1.6.1 crash-redrive
  contracts (SUCCESS + `settledAt` NULL, FAILED + `declineCategory` NULL) had
  no carrier left after a handler ERROR: zombie dunning cases kept emailing
  "payment failed" to PAID customers, and failed cycles sat held with the
  subscriber silently unbilled. The new 15-minute sweep re-drives both shapes
  directly (`finishSuccessSettlement(redrive)` / `onBillingAttemptFailed`,
  each single-flight via its own marker or lease, age-gated so it can never
  race a live handler, scoped OURS + non-demo, 7-day lookback). Pinned by
  tests/settlement-redrive.test.ts.
- **Alerts — a single unrecoverable FAILED webhook receipt now alerts**: the
  WEBHOOK_FAILURES check only fired at ≥5 failures/hour (or on stuck claimed
  receipts), so 1-4 handler ERRORs — each already 200-acknowledged, retry
  train over — aged out of the window silently. A third arm now raises
  CRITICAL on ANY receipt FAILED + unfinished past the 15-minute stuck window
  (48h lookback), with copy explaining what recovers automatically and what
  needs manual re-sync. Pinned by tests/webhook-stuck-receipt-alert.test.ts.
- **Webhooks — reconstructed billing attempts settled the wrong cycle on
  index-diverged contracts**: an attempt row reconstructed from an external
  charge (vaulted-elsewhere flows, admin-manual attempts) was stamped
  `cycleIndex = ordersCount + 1`, but Shopify cycle indexes drift ahead of
  ordersCount after any skipped cycle — so cycle-scoped settlement
  (add-on mirrors via `addonCycleIndex`, gift ADDED→SHIPPED flips) missed:
  the customer paid for a staged add-on whose mirror survived forever and
  whose freed-never `addClaimKey` blocked all future stagings of that
  variant. The billed cycle is now resolved from Shopify by the mirrored
  `nextBillingDate` (ordersCount + 1 only as read-failure fallback). Pinned
  by tests/webhook-reconstructed-cycle-index.test.ts.
- **Reactivation — admin "Resume" of a payment-FAILED contract never billed
  again**: `resumeContract` activated the contract and promised billing in ~3
  days, but the failed cycle's terminal attempt still held the cycle at the
  sweep's history guard, the closed dunning case could not be reopened
  (that path requires status FAILED), and no code path ever created another
  attempt. FAILED resumes now release the closed episode via the new shared
  `releaseHeldCycleAttempts` helper (`supersededAt`, migration 0013's
  mechanism) and clear the live-state `failedAt`; the release count is
  audited on `contract.resumed`. Pinned by
  tests/resume-failed-cycle-release.test.ts.
- **Reactivation — a merchant reactivating a cancelled/failed contract in the
  SHOPIFY admin left the mirror churned and the cycle held**:
  `syncContractFromShopify` had no CANCELLED/FAILED → ACTIVE transition
  handling, so the stale `cancelledAt`/`failedAt` stamps survived (the
  subscriber kept counting as churned, and a LATER churn kept the old
  timestamp) and the failed cycle stayed held exactly as above. Sync now
  clears the live-state churn columns on that transition and — for billable
  (OURS) contracts, in ONE transaction with the ACTIVE mirror write —
  releases the held cycle, audited on the sync event. Pinned by
  tests/sync-reactivation-release.test.ts.
- **Win-back — the failed-cycle release is now part of the replay contract
  and atomic with the mirror write**: `reactivateFromWinback`'s ACTIVE
  early-return (link replay, double click — or a concurrent webhook flipping
  the mirror ACTIVE mid-first-pass) settled the win-back bookkeeping WITHOUT
  releasing the failed cycle, recreating the reactivated-but-never-billed
  trap when the first pass died between the mirror write and the release;
  and the release itself ran outside the mirror-write transaction. The
  release now commits atomically with the ACTIVE write, the replay path
  re-runs it (a pure replay finds nothing and stays silent), and a healing
  replay logs its own audited `winback.reactivated` with the release count.
  Pinned by tests/winback-cycle-release.test.ts.
- **Gifts — "gift on your Nth order" matched the Shopify cycle index instead
  of the order number**: ORDER_INDEX rules compared `rule.orderIndex` to the
  billing-cycle index, which drifts ahead of ordersCount by one for every
  skipped cycle — after any skip, the milestone email announced a gift whose
  rule could never match again. Rule matching (and the cycle-date estimate)
  now runs in order-number space (`ordersCount + 1` = the order the ensured
  cycle will become), while grants and cycle edits stay in Shopify
  cycle-index space; every caller passes both explicitly. Pinned by
  tests/gift-order-index-space.test.ts.
- **Gifts — the daily `gifts_run` job was a permanent no-op for any
  subscriber who ever skipped**: it ensured cycle `ordersCount + 1`, which on
  an index-diverged contract is an old skipped/billed cycle — the ensure call
  short-circuited every night. The upcoming cycle is now resolved from
  Shopify by `nextBillingDate` (order-number space as the read-failure
  fallback). Pinned by tests/gift-order-index-space.test.ts.
- **Gifts — an ADDED grant whose cycle was later skipped stranded forever**:
  the committed zero-priced line died with the skip (cycle-scoped edits
  evaporate), but the grant stayed ADDED — the portal promised a free gift on
  every future order that never shipped. `ensureGiftsForUpcomingCycle` now
  re-anchors: a provably-skipped cycle's ADDED grant reverts to SCHEDULED on
  the ensured cycle and re-attaches (the gift-added idempotency marker is now
  per (grant, cycle), so the dead commit no longer blocks the new one); a
  BILLED cycle's stale ADDED grant flips SHIPPED (the flip was lost, not the
  line); gone/unreadable cycles prove nothing and are left alone; a
  same-variant duplicate on the target cycle retires the stray as REMOVED.
  All audited as `lifecycle.gift_rescheduled`. Pinned by
  tests/gift-reanchor.test.ts.
- **Sync — the monotonic ownership rule is now enforced at the database
  write**: the ownership verdict is resolved off the top-of-sync read, and
  the multi-second Shopify round trips before the write let a concurrent
  explicit verdict (import's OURS stamp, admin claim) land in between — the
  stale resolution then flipped a just-imported contract back to UNKNOWN,
  silently excluding it from every OURS_ONLY billing/dunning/reminder sweep.
  `ownership` is no longer part of the shared update spread: OURS/FOREIGN
  are written, UNKNOWN is never written on the update path (creates still
  carry the resolved value), and the audit event reports the verdict the row
  actually holds. Pinned by tests/contract-ownership-sync.test.ts and
  tests/ownership-enforcement.test.ts.
- **Portal — skipping a cycle stranded its staged one-time add-ons**: a
  skipped cycle never settles, and settlement is the only thing that cleared
  add-on mirrors — so the portal kept promising the add-on "with your next
  order" while no future order contained it, and its permanently-unique
  `addClaimKey` turned every later re-add of that variant into a silent
  no-op. `skipNextCycle` now removes add-ons staged on the cycle being
  skipped (Shopify line first, then mirror + claim key, audited as
  `cycle.addon_removed`) BEFORE the skip commits; an infrastructure error
  aborts the whole skip retryably, later-cycle add-ons ride on untouched.
  Pinned by tests/addon-skip-clear.test.ts.
- **Notifications — the demo preview contract could be emailed like a real
  customer**: the pre-expiry card sweep was missing the `isDemo: false`
  filter every other sweep carries, and nothing downstream would have caught
  it. The filter is added, and `sendNotification` now carries a last-line
  demo gate: customer-facing templates for an `isDemo` contract are
  SUPPRESSED (reason `demo_contract`; admin-facing templates still deliver
  to the merchant). Pinned by tests/demo-contract-notifications.test.ts.
- **Mail — a forgotten or typo'd `MAIL_PROVIDER` silently dropped every
  OTP / 3DS / admin email in production**: the provider check fell back to
  console for ANY unrecognized value, console-logged the mail and recorded
  it SENT. `MAIL_PROVIDER` is now case-insensitive, and an IMPLICIT console
  fallback in production makes `sendEmail` throw (the send lands FAILED) and
  `verifyMailer` report unhealthy; an explicit `MAIL_PROVIDER=console`
  remains allowed everywhere. Pinned by tests/mailer-provider.test.ts.
- **Health — `/api/health` now checks direct-mail deliverability**: OTP, 3DS
  and admin alerts bypass Klaviyo and ride the direct mailer alone, but the
  endpoint only watched the DB and billing job — a dead mailer was invisible
  to uptime monitoring. The mailer status (SMTP `verify()` round-trip,
  cached 60s) is now in the body and folded into overall health: unhealthy
  mailer → 503. Pinned by tests/health-mailer.test.ts.
- **Notifications — Klaviyo-unconfigured fallback emails shipped literal
  `{skip_url}` placeholders**: the direct-SMTP fallback (added in 1.6.1)
  rendered from the caller's vars alone, but locale bodies reference the
  contract snapshot, `portal_url` and the one-tap magic-link bundle
  unconditionally. The shared direct-delivery path now renders from the same
  full property set a Klaviyo flow would receive (caller vars win on
  collision; magic-link tokens and OTP codes still never persist to
  NotificationLog). Pinned by tests/klaviyo-unconfigured-fallback.test.ts.
- **Alerts — one demo placeholder variant id killed the STOCKOUT_RENEWALS
  check for good**: the demo fixture's fake `gid://cellexia/demo/variant/…`
  ids entered the renewal-availability feed, and Shopify's `nodes(ids:)`
  rejects a malformed id with a TOP-LEVEL error — blanking the whole batch,
  every night, forever. The feed query is now scoped `isDemo: false` +
  OURS_ONLY (extracted as `collectRenewalVariantAvailability`, exported for
  tests), and `getVariants` drops non-`gid://shopify/` ids as defence in
  depth. Pinned by tests/alerts-variant-feed.test.ts and
  tests/get-variants-gid-filter.test.ts.
- **Launch — "Shift these renewals forward" ran AFTER the shop went live**:
  the overdue stagger looped per-contract Shopify mutations for minutes
  while the billing sweep (its own 5-minute tick, gated only on the launch
  setting) was already free to run — on a migration store the next tick
  could charge every not-yet-shifted overdue contract in one burst, exactly
  what the option promises to prevent. The stagger now runs BEFORE the mode
  flips, while the shop is still SETUP; a subsequently failed go-live leaves
  only harmlessly postponed dates (1-3 days, no charges), stated in the
  error. Pinned by tests/launch-mode.test.ts.
- **Admin — the price-change notice window could collapse to same-day
  repricing**: the per-batch `noticeDays` override from the bulk form was
  accepted verbatim (the Polaris min/max only constrains spinner arrows), so
  a typed "3" — or a crafted 0/negative POST — bypassed the registry's 7-day
  compliance floor and repriced subscribers the day the "advance notice"
  email went out. The registry bounds are now exported constants enforced in
  `createPriceChangeBatch` itself (no caller can violate them) and validated
  with a real error in the bulk form. Pinned by
  tests/price-change-notice-days.test.ts.
- **Import — `next_charge_date` parsing silently accepted ambiguous dates**:
  both importers fell back to bare `new Date(value)`, which parsed
  "05/06/2026" (European DMY) as US May 6 in the SERVER's timezone (every
  migrated subscriber billed ~a month off), accepted prose dates, rolled
  "2026-02-30" over to Mar 2, and parsed a spreadsheet-degraded bare "2026"
  as Jan 1 — in the past, which `resolveNextBillingDate` turned into an
  unauthorized charge TOMORROW. Parsing now lives in one shared strict
  module (`app/lib/csv-date.ts`, used by both importers, drift pinned by
  test): `YYYY-MM-DD` at 12:00 UTC, or ISO-8601 with an explicit offset;
  everything else is a row error at dry-run. Pinned by tests/csv-date.test.ts.
- **Import — the duplicate guard was case-sensitive on email**: the CSV email
  is lowercased at parse, but the mirror stores the Shopify customer's email
  VERBATIM — so every subscriber whose stored address carries an uppercase
  letter was invisible to the guard, and the prescribed "fix rows, re-run
  the file" pass created a SECOND live Shopify contract that double-billed
  them. Both importers now match `mode: "insensitive"`. Pinned by
  tests/import-duplicate-guard.test.ts.
- **Import — the CLI importer's duplicate guard only matched ACTIVE
  contracts**: the same PAUSED re-run gap 1.6.1 closed in the admin importer
  existed in `scripts/import-subscribers.ts`; it now shares the
  `IMPORTABLE_STATUSES` constant pattern (guard covers the whole creatable
  set; churned statuses stay re-importable). Pinned by
  tests/import-duplicate-guard.test.ts.
- **Buy box — merchant custom CSS could escape its wrapper scope**: the CSS
  is emitted inside `#cx-buybox-<uid> { … }`, so a value like
  `color:red} body{display:none` closed the wrapper and shipped UNSCOPED
  storefront-global rules — up to hiding the demoted one-time link the
  subscription_max preset keeps as a compliance guardrail. `sanitizeCustomCss`
  now enforces brace containment (depth never negative, ends at zero;
  unbalanced css is rejected WHOLE, after the length cap so truncation can't
  ship half-open), and the Liquid belt mirrors the same depth walk against
  hand-edited metafields. Pinned by tests/widget-design.test.ts and
  tests/liquid/custom-css.test.ts.
- **Portal — a crafted `?locale=` could 500 every portal page**:
  `normalizeLocale` used bare truthiness lookups on the locale catalog, so
  Object.prototype keys ("__proto__", "constructor", "toLocaleString", …)
  resolved as "supported" locales and were returned verbatim — Intl then
  threw RangeError on every money/date format. Lookups are now
  own-property-only (`Object.hasOwn`), the catalog map is built on a null
  prototype and frozen, and `SUPPORTED_LOCALES` is frozen (an in-place sort
  would silently repoint base-language fallbacks). Pinned by
  tests/i18n-parity.test.ts.

## [1.6.1] — 2026-08-06

**Pre-launch stability sweep + production-build fix.** `npm run build` — the
third leg of the `npm run verify` release gate — failed with "Server-only
module referenced by client". Root cause: **server-only imports reachable from
client route exports** — admin route COMPONENTS (`app.subscribers.tsx`,
`app.subscribers.$id.tsx`) referenced the ownership vocabulary from
`~/lib/ownership/ownership.server`, whose module graph pulls in Prisma and the
Shopify client, so the client bundle could not be built (typecheck and tests
stayed green; only the build leg catches this class). The pure, isomorphic
half now lives in `app/lib/ownership/shared.ts` (constants, labels,
`isBillableOwnership`, `normalizeOwnership` — no prisma, no node builtins, no
`.server` imports), and `ownership.server.ts` re-exports it verbatim: every
server caller keeps its import path and each name has exactly one definition.

Beyond the build failure, this sweep confirmed and fixed **28 findings** —
every one documented under Fixed below (the build failure is the first), plus
one dead-settings removal (Removed) and one regression pin (Hardened).

**Seven additive migrations** ship with this release:
`0007_billing_attempt_settled_at`, `0008_dunning_concurrency`,
`0009_line_add_claim`, `0010_acq_pickup_exhausted`,
`0011_origin_capture_exhausted`, `0012_addon_cycle_index`,
`0013_reactivation_cycle_release` — nullable ADD
COLUMNs and one partial unique index; the only data writes are a backfill
touching solely the new `settledAt` column and a repair closing the exact
duplicate-open-case corruption 0008 makes impossible (no DROP, no RENAME, no
type change — each migration's header carries the full story).

**One new access scope: `write_order_edits`** (the first-order gift order
edit — see Fixed below). Per [docs/UPDATE.md](docs/UPDATE.md) a scope change
requires `npm run deploy` and re-approving the install; until approved, the
gift path defers to the first renewal and raises a CRITICAL alert instead of
failing silently. Versioning honesty: the §1 table reserves migrations and
scope changes for MINOR/MAJOR bumps — 1.6.1 is numbered as the stabilisation
patch of 1.6.0 (bug fixes only, no new features), but **follow the full §4
update procedure** (backup, `prisma migrate deploy`, `npm run deploy`,
re-approve scopes) rather than the usual PATCH shortcut.

### Fixed

- **Production build — server-only imports reachable from client route
  exports**: the defect and fix described in the lead above. Guard rails are
  written into both files: `shared.ts` documents that it must never gain a
  prisma/node/`.server` import, and `ownership.server.ts` documents why the
  re-export indirection exists, so the two cannot silently drift back into
  the broken shape.
- **Billing — success-side bookkeeping was lost forever if the process died
  after the SUCCESS claim**: `handleBillingAttemptSuccess` claimed the
  attempt (status → SUCCESS) and then ran the contract counter increments,
  gift flip, add-on clearing, dunning close, order confirmation and event
  logging as SEPARATE statements; a crash in between sent the redelivered
  webhook down the mirror-refresh-only replay path (status already SUCCESS)
  and the side effects were never driven — an open dunning case left behind
  a PAID cycle, `ordersCount`/`lifetimeRevenueCents` never incremented,
  rollup revenue undercounted. The failure path always had a re-drive anchor
  (`declineCategory` written last); the success path now has its equivalent:
  the accounting commits atomically with the claim and
  `finishSuccessSettlement` stamps `settledAt` (migration 0007) LAST, so a
  SUCCESS attempt with `settledAt` NULL is recognizably half-settled and a
  redelivery re-drives the remaining (individually idempotent) side effects
  instead of returning.
- **Dunning — a delayed FAILURE webhook re-ran the engine concurrently with
  the stale-attempt sweep**: the redelivery guard (status FAILED +
  `declineCategory` non-null) is read-then-act and `declineCategory` lands
  seconds later, so two racing invocations double-incremented
  `consecutiveFailures`, sent duplicate "payment failed" emails and could
  open TWO dunning cases whose ladders each minted charge attempts. Engine
  entry is now an atomic lease claim (`dunningClaimedAt`, migration 0008 —
  `updateMany` gated on `declineCategory IS NULL` and a null/expired lease;
  a crashed run's lease expires, so redelivery-driven crash recovery is
  preserved), and "one open case per contract" is now a DATABASE invariant:
  the partial unique index `DunningCase_one_open_case_per_contract` over the
  open states rejects the concurrent second create, the P2002 loser reuses
  the winner's case, and the migration repairs pre-existing duplicate-open
  cases (newest survives, the rest close as SUPERSEDED_DUPLICATE). Pinned by
  tests/dunning-concurrency.test.ts.
- **Portal — a double-tap on "Add one-time" charged the add-on twice**:
  `addOneTimeAddon` (and `addLine` for recurring adds, identical shape) used
  a read-then-act duplicate guard around a multi-second Shopify
  billing-cycle edit, and the portal is server-rendered HTML with no
  client-side button disabling — both overlapping requests passed the find
  and both appended the variant to the next cycle. The mirror row is now
  created FIRST carrying a unique `addClaimKey`
  (`addon:{contractId}:{variantId}` / `line:{contractId}:{variantId}`,
  migration 0009), and only then does the Shopify edit run (the row is
  deleted if the edit fails); the double-tap loser hits P2002 and no-ops as
  already-staged. Checkout sync, gift-engine and import lines never set the
  key. Pinned by tests/addon-claim.test.ts (loser: no second cycle edit, no
  second event, no charge).
- **First-order gift — the order edit was impossible without
  `write_order_edits` and failed silently**: the gift attaches to the
  checkout order via an order edit, but the granted scopes never included
  `write_order_edits`, so Shopify answered ACCESS_DENIED for EVERY
  contract and each promised gift silently deferred a full billing interval
  to the first renewal, with a console line as the only trace. The scope is
  now in `shopify.app.toml` (re-approve on update), and the ACCESS_DENIED
  error class — misconfiguration, unlike an individually uneditable order —
  raises a deduped CRITICAL `FIRST_ORDER_GIFT_ACCESS_DENIED` alert with
  remediation steps; the deferral fallback that keeps the customer promise
  is contained and untouched by alerting failures.
- **Buy box — shops whose `money_format` contains HTML entities painted
  literal `&nbsp;`/`&pound;`/`&euro;` into prices**: money reaching the
  widget's JSON island stayed HTML-escaped, but `<script>` is a raw-text
  element — the browser decodes entities in attributes and text nodes,
  never inside the island — and `buy-box.js` writes island values with
  `textContent`, so Shopify's own stock formats (`&pound;{{amount}}`,
  `{{amount}}&nbsp;CHF`) rendered as literal entity text and broke the
  theme price sync's byte-for-byte text match. Island-bound money is now
  decoded SAFE → RAW at the island boundary, exactly once, by a dedicated
  documented chain; the snippet's string-space contract (RAW vs SAFE, every
  conversion at one marked boundary, `&amp;` replaced last) is written into
  the file so the single-decode invariant cannot regress silently.
- **Admin lists — timestamp-only pagination cursors silently lost rows
  (audit log + subscribers)**: cursors carried `createdAt` alone with a
  strict comparison, but `createdAt` is timestamp(3) and a webhook burst or
  bulk operation writes several rows in the SAME millisecond — a page
  ending mid-tie dropped every remaining same-millisecond row from all
  later pages (an auditor paging the compliance log missed events with no
  indication), and equal-timestamp rows could swap order between the
  page-1 and page-2 queries even without a boundary tie. Both lists now
  share compound (createdAt, id) keyset pagination
  (`app/lib/pagination.server.ts`): total ORDER BY (createdAt, id), a
  `"<ISO>~<id>"` cursor, boundary condition
  `(createdAt < c.at) OR (createdAt = c.at AND id < c.id)` mirrored for
  "prev" — and a legacy bare-ISO cursor from an old tab still decodes.
  Pinned by tests/pagination.test.ts.

- **Origin MONEY backfill — permanently unfetchable orders starved the capped
  queue**: the nightly `origin_order_backfill` money pass scans the oldest 200
  OURS contracts with `originOrderTotalCents` null, but `getOrderSummary`
  throws for every order the Admin API answers `order: null` for — which,
  without the `read_all_orders` scope (not requested; needs Shopify approval),
  is EVERY order older than 60 days, plus deleted and GDPR-erased orders. An
  established-shop install mirrors hundreds of such contracts at once; they
  failed every night, never left the oldest-first window, and once ≥ 200
  existed the whole cap burned on the same dead fetches while fetchable rows
  (capture-at-sync hiccups, UNKNOWN contracts reclassified OURS in time)
  sorted after them forever — their first payment permanently missing from
  cohort month-0 / rollup revenue. Exactly the defect class migration 0010
  fixed for the acquisition pass; the money pass had no terminal marker.
  Now: `getOrderSummary` throws a typed `OrderNotFoundError` (a conclusive
  API answer, distinct from transport/throttle errors); the backfill stamps
  `originCaptureExhaustedAt` (migration 0011) when that error hits a contract
  mirrored longer ago than `ORIGIN_CAPTURE_GRACE_MS`, via an atomic
  still-uncaptured claim, and the pending query excludes stamped rows — the
  window drains at up to 200 rows/run. The capture-at-sync path ignores the
  marker, so a row stamped while its order was temporarily invisible (e.g.
  `read_all_orders` granted later) self-heals on any later successful sync.
  Contained per-contract failure counters (previously invisible — the job
  itself records SUCCESS) now surface as the new `ORIGIN_BACKFILL_FAILURES`
  WARNING alert.

- **Buy-box widget — the in-section fallback adopted a provably-foreign
  add-to-cart form**: when every `/cart/add` form in the block's section
  belonged to another product (a cross-sell/complementary-products quick-add
  while the main add-to-cart is JS-driven), `findProductForm` still bound
  `scoped[0]` — and the widget then injected our `selling_plan` +
  `properties[_cellexia_design]` into the OTHER product's form, so the
  shopper's quick-add was rejected by Shopify with a 422 (selling plan not
  available for that variant). `formOwnership` now separates the conclusive
  verdict (a digits-only `[name="id"]` value that is not in our variants
  island — another product's variant id) from the inconclusive one (a theme
  storing a non-variant token, verdict `token`): the in-section fallback
  still binds a `token` form (the block placement vouches for it — unchanged
  behaviour for the themes the fallback existed for) but binds NOTHING when
  every scoped form is provably foreign, matching the document-wide "prove
  ownership or bind to nothing" rule; formless/AJAX themes keep working via
  `buy-box-embed.js`'s request patcher.

- **Webhooks — an in-flight duplicate answered 200 forfeited Shopify's entire
  redelivery train**: a same-id retry arriving within the 60s in-flight grace
  window was answered `SKIPPED_DUPLICATE` **200**, and any 2xx permanently
  ends Shopify's redelivery for that webhook id — so when the original
  delivery's handler (slow under load, past Shopify's ~5s delivery timeout)
  later died mid-settlement, the settledAt-NULL redrive contract had no
  carrier left and the receipt sat stuck until a MANUAL replay: the automatic
  crash recovery the claim/re-run design exists for was silently forfeited.
  Symmetrically, a handler still alive past the grace window collided with a
  late retry, which re-ran the handler CONCURRENTLY with the original. Now:
  an in-flight duplicate is answered **503** (`IN_FLIGHT_RETRY_LATER`) so the
  retry train survives — the next retry either finds `processedAt` set (clean
  duplicate) or drives the crash re-run; the receipt's `receivedAt` is
  heartbeat-renewed every 30s while a handler runs (the JobLock lease-renewal
  pattern), so a live handler is in-flight however long it runs; and the
  crash-residue re-run is claimed atomically (a `receivedAt`-refresh
  `updateMany` conditioned on the claim still being stale), so two late
  retries can never re-run the handler twice concurrently.

- **Refund netting — presentment-currency refunds were subtracted raw from
  shop-currency totals (Shopify Markets)**: `handleRefundsCreate` incremented
  `originOrderRefundedCents` / `BillingAttempt.refundedCents` with the REST
  refund transactions' amounts, which are denominated in the order's PAYMENT
  (presentment) currency — while both stored totals are shopMoney figures
  (`getOrderSummary` selects only `…PriceSet.shopMoney`). On a CHF shop
  selling to Germany via Markets, a EUR 30 refund of a CHF 93.50 origin
  order netted 3 000 EUR-cents off a 9 350 CHF-cent total: every partial
  refund on a foreign-presentment order mis-netted cohorts and rollups by
  the FX delta, and larger presentment numerals (JPY on a EUR shop)
  over-netted to the clamp floor. Netting is now gated on currency
  agreement (`refundCurrencyAgrees` — null-tolerant, the same rule
  `originPaymentCountsOnce` applies): the origin branch enforces it inside
  the row-level `updateMany` (so a concurrent capture cannot slip between
  check and increment), the attempt branch checks the stamped
  `currencyCode`, and a mismatched refund is skipped with a distinct
  `refund_skipped_currency_mismatch` event that still arms the refund-id
  replay guard. Pinned by tests/origin-refund-interleaving.test.ts
  (currency-agreement describe: origin skip + redelivery block, attempt
  skip incl. untouched `lifetimeRevenueCents`, null-currency still nets).
- **Import — re-executing a migration file double-created every PAUSED
  subscriber**: the per-group duplicate guard in `processGroup` matched only
  `status: "ACTIVE"` local contracts, but the importer explicitly creates
  `PAUSED` ones too (row schema `status` enum). The supported re-run
  workflow (execute, vault the missing cards, dry-run and execute again)
  therefore sent every PAUSED group through
  `subscriptionContractAtomicCreate` a second time — two live PAUSED
  contracts on Shopify per subscriber, both billing when the customer
  resumes. The creatable set is now a single constant
  (`IMPORTABLE_STATUSES`) feeding BOTH the row-schema enum and the guard's
  `status: { in: … }` filter, so they cannot drift; churned statuses
  (CANCELLED/EXPIRED/FAILED) stay re-importable. Pinned by
  tests/import-duplicate-guard.test.ts (constant/enum/guard coupling plus
  where-clause semantics over the shared interpreter).
- **Acquisition backfill — unfillable rows starved the capped pickup queue**:
  `runOriginOrderBackfill`'s acquisition pass selected the OLDEST 200 OURS
  contracts with an `originOrderId` and `acqRaw` null and re-ran the stash
  pickup, but wrote no "no stash exists, stop retrying" marker. Rows that can
  NEVER be filled — pre-0006 contracts whose `ORDERS_CREATE` predates the
  stash feature, and redacted contracts whose stash payloads were cleared —
  therefore re-entered the oldest-first window every night; once ≥ 200 of
  them existed they permanently occupied the entire cap, and the exact
  contract the retry path was added for (mirrored `UNKNOWN`, reclassified
  `OURS` later — the newest `createdAt`) could never be scanned: its stashed
  geo/UTM/device bundle stayed stranded in the event log forever. The queue
  is now drainable: a contract still stash-less past the 48-hour
  webhook-race/redelivery horizon (`ACQ_PICKUP_GRACE_MS`) is stamped
  `acqPickupExhaustedAt` (migration 0010) via the same `acqRaw`-still-null
  atomic claim and excluded from future scans; `CUSTOMERS_REDACT` stamps it
  directly when clearing the stash payloads. Transient pickup errors are
  never stamped (retried next run), and the `ORDERS_CREATE` direct-persist
  path ignores the stamp, so a genuinely late order webhook still lands its
  bundle. Pinned by tests/origin-revenue.test.ts (terminal-stamp, young-row
  grace, error-not-retired and retired-rows-excluded-from-the-window tests)
  and the redact stamp by tests/acquisition-capture.test.ts.
- **Discount grants — a crash window silently halved multi-cycle save
  offers**: `applyGrantToCycle` ran three separate writes with the
  idempotency marker LAST (Shopify cycle edit → `cyclesRemaining` decrement →
  `cycle_discount_applied` event), so a process death between the decrement
  and the marker left the grant one cycle poorer with no applied-marker; the
  next 5-minute sweep tick found no marker, re-applied the same cycle (safe —
  absolute price) and decremented AGAIN. A cancel-flow save of "20% for 2
  cycles" delivered ONE discounted cycle — the broken promise the cancel flow
  exists to prevent. The decrement and the marker now commit in ONE
  transaction, after the Shopify edit (a death before the transaction leaves
  the grant untouched and the next tick re-drives the idempotent edit; a
  death after leaves both durable), and the decrement is a compare-and-swap
  on the `cyclesRemaining` read at sweep start, so a replayed or concurrent
  application of the same cycle consumes nothing and writes no second marker.
  The marker row is written with the transaction client rather than
  `logEvent` (which never throws by contract — a swallowed marker write would
  re-open the window; `contract.updated` is not Klaviyo-mapped, so no outbox
  forward is lost). Pinned by tests/discount-grant-consume.test.ts (the
  single-transaction ordering, stale-snapshot CAS and
  exactly-2-cycles-delivered tests fail against the old three-write shape).

- **Forecast — partial-week keys computed in UTC instead of the shop-local
  rollup label space**: `getForecast` keyed "the current week" (and the
  history cutoff, and `recordForecastAccuracyWeek`'s entry key) off the UTC
  week of the instant `now`, while `DailyRollup` rows are labeled by the
  shop-timezone calendar day. During the weekly hours when the shop-local and
  UTC dates disagree the wrong bucket was excluded: a UTC+ shop just past its
  local Monday midnight DELETED the just-completed week and kept the ~2-hour
  in-progress bucket as the newest "complete" week (naive anchored the whole
  netRevenue horizon on hours of charges, trend read a collapse, and the
  final backtest fold recorded garbage `latestOneStepApe`); a UTC− shop still
  in its local Sunday evening kept the in-progress bucket entirely. Worse,
  whenever the drifting `risk_learning_run` cadence landed in that window,
  `recordForecastAccuracyWeek` stamped the corrupted measurement under the
  OLD week's key — an entry never rewritten once UTC caught up, poisoning the
  "auto" ranking, blend weights and beat-streak for up to 26 weeks.
  `getForecast` now loads the shop's `ianaTimezone` and computes
  `currentWeekKey`, the rollup query cutoff and the recorded `weekStartIso`
  via `shopDayLabelUtc` (the label-space rule ARCHITECTURE.md already
  mandates), also fixing the rollup query's forbidden instant-vs-label
  comparison. Pinned by tests/forecast.test.ts ("shop-local week boundary":
  UTC+/UTC− straddle cases plus a `recordForecastAccuracyWeek` key test —
  all three fail against the old keying).
- **Webhooks — crash recovery unreachable behind the receipt claim**: the
  route claimed the `WebhookReceipt` as terminally processed BEFORE running
  the handler and answered every P2002 with `SKIPPED_DUPLICATE`, so Shopify's
  automatic redelivery (same `X-Shopify-Webhook-Id`, sent because a crashed
  process never responded) could never re-drive a handler that died mid-way —
  yet every documented crash contract (`finishSuccessSettlement`'s
  settledAt-NULL redrive, the dunning engine's declineCategory-written-last
  and lease-expiry redrives) depends on exactly that redelivery. A deploy
  restart between the success claim transaction and the dunning close left
  the paid customer's case open forever, walking the email ladder
  (payment_failed_2/3 + SMS to a customer who had just PAID). The claim is
  now two-phase: `processedAt` is the completion marker, and a same-id
  redelivery that finds the claim unfinished (outside the in-flight grace
  window, same payload hash) re-runs the idempotent handler and completes the
  receipt. Crashed receipts are also visible now: `WEBHOOK_FAILURES` alerts
  on any receipt stuck claimed-but-unfinished for over 15 minutes, alongside
  the existing FAILED threshold. Pinned by
  tests/webhook-receipt-redelivery.test.ts (the crash-residue and
  FAILED-residue redrive tests fail against the old claim-first route).
- **Webhooks — the crash-residue redrive was not single-flight**: the redrive
  above re-ran the handler whenever a claimed receipt sat unfinished past the
  grace window, but never RE-claimed it — no conditional update guarded
  entry, and `receivedAt` was never bumped. Shopify aborts unanswered
  deliveries after ~5s and retries under the same `X-Shopify-Webhook-Id`, so
  a slow handler is guaranteed to receive same-id retries while still
  running, and `SUBSCRIPTION_CONTRACTS_CREATE` (contract + variants +
  plan-evidence + order summary + first-order-gift order edit + acquisition
  lookup) routinely outlives the old 60s window under Admin API throttling: a
  retry then ran `syncContractFromShopify` CONCURRENTLY with the original
  delivery, both read the contract's local lines before either wrote, and a
  Shopify line absent locally was created by BOTH (`ContractLine` has no
  unique on contractId+shopifyLineId) — doubled portal items, doubled
  per-cycle COGS/discount estimates, duplicate canonical `contract.updated`
  events double-firing Klaviyo; on a CREATE catch-up race the loser's P2002
  stamped the receipt FAILED despite successful processing. Two-part fix:
  the takeover is now an atomic re-claim (conditional `updateMany` — bump
  `receivedAt` where `processedAt` is still NULL and `receivedAt` is
  unchanged since read; only the `count === 1` winner runs, losers answer
  `SKIPPED_DUPLICATE`, and the winner's fresh `receivedAt` restarts the
  grace window for its own run), and `IN_FLIGHT_GRACE_MS` is raised 60s →
  10 min so the window covers the worst LEGITIMATE handler runtime instead
  of presuming a throttled-but-alive run dead (still under the 15-min stuck
  alert; Shopify retries for 48h, so later retries keep driving crash
  recovery). Pinned by tests/webhook-receipt-redrive.test.ts (re-claim
  precedes the handler, lost re-claim skips, 70s-old claim is in-flight not
  residue) and tests/webhook-receipt-redelivery.test.ts.
- **Dunning — admin intents could overwrite a webhook-resolved case (and the
  cockpit took any caseId)**: "Retry now" (Dunning queue + subscriber
  cockpit), "Mark resolved", "Cancel case" and the queue's contract-cancel
  performed unconditional `DunningCase` writes with no open-state guard — the
  engine's own reopen path guards ("RETRYING cases already have a schedule;
  recovery closes the rest") and clears `resolvedAt`/`resolution`, the admin
  routes did neither. An admin clicking "Retry now" on a stale page after the
  customer's card recovered the case flipped RECOVERED back to RETRYING with
  the stale resolution stamped: the next sweep re-billed the already-billed
  cycle, Shopify's refusal parked the case AWAITING_CUSTOMER, `daysOpen`
  (anchored to the ORIGINAL `openedAt`) blew past `cancelAfterFailedDays`,
  and `exhaustCase` cancelled an ACTIVE fully-paid contract with reason
  PAYMENT_FAILED while the ladder re-sent "your payment failed" every sweep;
  "Send card link" re-mailed the fix-payment email on recovered cases. Worse,
  the cockpit's three intents ran `update({ where: { id: caseId } })` with
  the form's caseId unscoped to the contract or shop — a bare POST could
  flip ANY case in the database while `dunningResolve` reset
  `consecutiveFailures` on the loaded contract. All five intents now go
  through the engine's new `transitionOpenCase`: ONE conditional
  `updateMany` scoped to `{ id, contractId, state: { in: OPEN_CASE_STATES } }`
  — guard and write are atomic, so a concurrent webhook recovery cannot race
  the click — refusing with "already resolved" when nothing matches, and
  `sendCardLink` refuses before any email goes out (re-opening resolved
  cases stays exclusively with `onPaymentMethodUpdated`, which clears the
  resolution fields). The queue's local open-state list is replaced by the
  engine's exported `OPEN_CASE_STATES` so the vocabulary cannot drift.
  Pinned by tests/dunning-admin-guards.test.ts (behavioural
  `transitionOpenCase` tests incl. the count-0 refusal, plus source pins
  keeping every intent in both routes on the guarded path).
- **Forecast — blend backtest hindsight leak**: the blend model's
  walk-forward backtest weighted every fold with `priorErrorOf` — errors from
  ALL prior calendar weeks — even though entries recorded during a fold's own
  evaluation weeks encode knowledge of the actuals being scored, so blend's
  `backtestMape` was optimistically biased and "auto" could prefer it over
  honestly-scored rivals. Weights are now fold-aware (`historyErrorAsOf`):
  each backtest fold may only use history entries recorded no later than its
  first evaluated week; the live horizon still uses the full prior history.
  Root cause companion fix: `recordForecastAccuracyWeek` now persists each
  week's TRUE out-of-sample error (`latestOneStepApe` — the final fold's
  one-step holdout APE, mean over MRR + actives) instead of the full backtest
  average, whose ~25-fold overlap between consecutive weeks made the
  exponentially weighted ranking and the "beaten naive for N straight weeks"
  streak near-tautological. Pinned by tests/forecast.test.ts (fold-aware
  weight tests, holdout-vs-average tests, and a leak regression test that
  fails against the old weighting).
- **Cancel flow — concurrent double-submission race**: `completeCancel` now
  claims the session with an atomic `outcome: null` guard BEFORE executing
  the Shopify cancel (same claim-first pattern as `acceptSave` /
  `acceptFinalOffer`), reverts the claim if the mutation fails, and a loser
  never re-executes. Previously a save-accept and a cancel-confirm submitted
  from two tabs could BOTH take effect with the last session write winning —
  contract cancelled on Shopify while the customer saw the "saved" page (or a
  live discount grant stranded on a cancelled contract). Pinned by
  tests/cancel-save-guards.test.ts ("cancel-session closure races").
- **Acquisition capture — marker-less REST payloads**: `handleOrdersCreate`
  now gates the acquisition stash on the same `containsSubscribable` test the
  take-rate denominator uses (selling-plan marker OR product in an active
  `SellingPlanConfig.productIds`) instead of the marker alone. REST order
  webhooks do not always carry the marker; for shops on that payload variant
  every subscription-origin order silently skipped the stash, the
  contract-create pickup found nothing, and the order-id idempotency guard
  made the loss permanent — the shop's entire acquisition foundation stayed
  null. Over-stashing a subscribable one-time order is inert: the pickup
  handshake requires `originOrderId` to match.
- **Risk learning — fabricated pre-install snapshots**: `buildRiskSnapshots`
  clamps each contract's snapshot grid to its mirror row's `createdAt` (the
  moment observation actually began). Sync backfills `firstChargeAt` to the
  ORIGIN order's historical date, so an imported book generated up to ~18
  months of pre-install grid rows whose features degenerated to "zero orders,
  never logged in, no dunning, old account" — dominating the training set,
  inflating the merchant-facing "trained on N outcomes" counts, sandbagging
  the heuristic's comparison AUC, and letting promotion be earned against a
  degenerate baseline. The clamp also structurally removes the false churn
  labels sync stamped on contracts mirrored as cancelled at import
  (`cancelledAt` = sync time). Account age still uses true arrival.
- **CSV exports — spreadsheet formula injection (OWASP)**: audit and
  subscribers exports now neutralize customer-controlled cells starting with
  `=`, `+`, `-`, `@` (and tab/CR variants) with a leading single quote before
  RFC-4180 quoting. A checkout name like `=HYPERLINK(...)` previously
  executed as a formula when the merchant opened the export in Excel/Sheets.
  Both routes now share ONE hardened `csvEscape` (`app/lib/csv.server.ts`) so
  the two surfaces can never drift again.
- **One-time add-ons — cycle-N settlement consumed a cycle-N+1 add-on and
  re-armed the exact double charge migration 0009 prevents**:
  `consumeCycleOnSuccess` cleared add-on mirror lines CONTRACT-scoped, but an
  add-on can be staged for the NEXT cycle while the current charge is still
  in flight (`runBillingSweep` advances `nextBillingDate` optimistically at
  attempt creation — a window of seconds normally, hours when a lost success
  webhook leaves the attempt to the stale sweep). Cycle N's settlement then
  deleted the N+1 mirror: the Shopify N+1 billing-cycle edit survived (the
  customer still gets charged), the portal had nothing left to remove, and
  the freed permanently-unique `addClaimKey` let the same variant be staged —
  and paid for — twice. `addOneTimeAddon` now stamps the resolved Shopify
  cycle index on the mirror (`addonCycleIndex`, migration 0012), settlement
  consumes only mirrors staged for the settling cycle (legacy NULL rows keep
  the old behavior), and `removeLine` targets the recorded cycle instead of
  re-resolving "next" by date. Pinned by tests/addon-cycle-scope.test.ts,
  tests/addon-claim.test.ts and tests/stale-sweep-settlement.test.ts.
- **Win-back — the promised reactivation gift silently never shipped on
  index-diverged contracts**: `grantReactivationGift` stamped the GiftGrant
  with `ordersCount + 1`, but Shopify billing-cycle indexes diverge from
  ordersCount permanently after any skipped or unbilled cycle (a skipped
  cycle keeps its index). The pre-charge attach matches SCHEDULED grants on
  the EXACT index and never found it; the daily job resolved the
  ordersCount-space index to an already skipped/billed cycle and returned
  early — the customer reactivated for a gift the magic-link page promised
  (`magic.winback.sub_gift`) and it sat SCHEDULED forever. The grant is now
  stamped with the REAL upcoming index (`getBillingCycleByDate` on the
  billing date reactivation just set; ordersCount space only as a read-failure
  fallback), and `ensureGiftsForUpcomingCycle` re-anchors any SCHEDULED grant
  stranded on an earlier index onto the cycle actually being charged — but
  only when the grant's own cycle is provably unbillable (skipped, billed or
  gone), so the create-webhook's ensure-cycle-2 call can never steal a
  still-chargeable cycle-1 grant, and a transient Shopify read failure never
  triggers a move (audited as `lifecycle.gift_rescheduled`). Pinned by
  tests/winback-gift-cycle-index.test.ts and tests/gift-reanchor.test.ts.
- **Notifications — every customer email was logged SENT and delivered to
  nobody while `KLAVIYO_PRIVATE_API_KEY` was unset**: `sendNotification`
  marked metric templates SENT the moment `enqueue()` inserted an outbox row,
  but without the key `flushKlaviyoOutbox` left those rows PENDING forever —
  dunning ladders advanced (`emailsSent`, `NotificationLog` dedupe), cycle
  dedupe stuck, the launch checklist promised an "SMTP fallback" that did not
  exist, no alert watched the outbox, and a key configured weeks later
  flushed the stale backlog into Klaviyo, firing flows on long-resolved
  moments. Four-part fix: (1) with the key absent the router no longer
  enqueues — lifecycle EMAIL templates now genuinely fall back to direct
  SMTP (the SENT row carries the ladder/cycle dedupe vars the KLAVIYO_EVENT
  row would have), and SMS templates are SUPPRESSED (reason
  `klaviyo_unconfigured`) since no transport exists; (2) `flushKlaviyoOutbox`
  ages out PENDING/FAILED rows older than 24h to DEAD — even while the key
  is missing — so stale moments are dropped, never fired late; (3) a new
  `KLAVIYO_OUTBOX_BACKLOG` WARNING alert raises on PENDING rows stalled
  \>60 min or rows dead within 48h, with copy that names the missing key;
  (4) the launch-checklist copy now states exactly what does and does not
  deliver. Pinned by tests/klaviyo-unconfigured-fallback.test.ts and
  tests/klaviyo-outbox-expiry.test.ts.
- **Contract sync — losing the routine first-sync race aborted the whole
  sync and cost the subscriber their first-order gift**: the monotonic-
  ownership rework restructured `syncContractFromShopify`'s single write into
  read-then-branch with no conflict handling on the create. Two FIRST-TIME
  syncs of the same contract race routinely (Shopify fires
  SUBSCRIPTION_CONTRACTS_CREATE and _UPDATE back-to-back at checkout, and
  app.import's post-create sync races the CREATE webhook): both read
  `existing == null`, both spend seconds in Shopify round trips, and the
  loser's create threw P2002 out of the entire sync. Through
  `handleSubscriptionContractsCreate` that aborted BEFORE the
  contract.created event, locale backfill, `ensureFirstOrderGift` (its only
  call site) and cycle-1/2 gift scheduling ever ran, the webhook answered
  200 FAILED — retry train over — and the plan-configured first-order gift
  silently never shipped (settlement_redrive only covers billing attempts;
  the WEBHOOK_FAILURES manual re-sync re-mirrors but never re-gifts). The
  loser now catches P2002, re-reads the row the winner committed, and falls
  through to the update path — re-applying the monotonic ownership rule
  against the winner's verdict, never clobbering the winner's
  `firstChargeAt` capture, and logging contract.updated (the winner already
  logged the one contract.created). Pinned by
  tests/sync-first-sync-race.test.ts.
- **Win-back — reactivated subscribers whose failed cycle was still unbilled
  were never billed again**: `reactivateFromWinback` (the magic-link
  APPLY_WINBACK route and the cancel-flow "Restart my subscription" action)
  promised billing in `reactivationBillDelayDays`, but that date typically
  lands back INSIDE the failed cycle's window, and the billing sweep's
  cycle-history guard held any cycle whose newest attempt is
  FAILED/CHALLENGED/EXPIRED "for the dunning engine" — an engine whose case
  was already resolved at cancel time (auto-closed CANCELLED, or EXHAUSTED),
  with `onPaymentMethodUpdated` only reopening EXHAUSTED cases while the
  contract is FAILED. Reactivated = ACTIVE, so NO code path ever created
  another attempt: winback.reactivated + contract.activated were logged, the
  discount granted, the gift scheduled — and the customer was never billed
  and never shipped, with only a generic STUCK_CONTRACTS warning and no open
  case to retry. Reactivation now stamps the closed episode's terminal
  attempts with `supersededAt` (migration 0013; only when no dunning case is
  open — PENDING rows are never touched, their charge fate is unknown), the
  guard ignores superseded rows, and attempt numbering still counts them so
  the fresh first attempt gets a new unique idempotency key; the release
  count is audited on the winback.reactivated event
  (`releasedFailedAttempts`). Pinned end-to-end (fail → cancel → reactivate
  → sweep bills) by tests/winback-cycle-release.test.ts and
  tests/billing-cycle-guard.test.ts.

### Removed

- **Orphaned "Buy box" settings card**: `buyBox.savingsFormat` /
  `subscriptionListedFirst` / `showReassuranceCopy` were editable in Settings
  but consumed by nothing — the widget reads the theme-editor block settings
  (`savings_format`, `preselect_subscription`, `show_reassurance`) and the
  published design presets. The dead group is removed from the registry and
  the Settings page (live-looking dead controls erode trust in every real
  one); stored `buyBox` Setting rows are inert. Re-adding requires actually
  wiring the fields into the payload the extension reads.

### Hardened

- **3DS CHALLENGED transitions pinned as forward-only**: new
  tests/billing-challenged-guards.test.ts locks the PENDING-guarded claims in
  `handleBillingAttemptChallenged` and the stale sweep, plus dunning's
  cycle-already-succeeded guard, so a late CHALLENGED retry can never stomp a
  settled SUCCESS (reopening dunning for a paid cycle and re-arming a
  double-increment) without failing the suite.

## [1.6.0] — 2026-08-06

**"Subscription max" buy-box preset + per-Shopify-Market design selection.**
A seventh designer preset, `subscription_max`, makes subscribing read as the
obvious way to buy: the subscription card *is* the buy box — one calm card
with the price, a "then {ongoing} every {frequency}" line, savings shown
quietly and the "Skip, pause or cancel anytime." reassurance kept prominent —
while the one-time purchase demotes to a single muted underlined link below
it. The demotion is **purely visual and deliberately not subscription-only**:
one-time stays real, priced *in the link before selection*, and selectable in
exactly one tap — the compliance guardrail (FTC negative-option posture) that
also protects conversion. And designs are now selectable **per Shopify
Market**: each market can run its own preset, inheriting everything else
from the main design.

**MINOR bump**: no migrations, no schema changes (the config lives in the
existing `cellexia.buybox_design` design metafield; the new `markets` field
and preset key are backward compatible — every stored revision keeps
parsing), no new scopes (`read_markets` was already granted), no env
changes. Restoring a pre-1.6.0 revision from history works unchanged.

### Added

- **`subscription_max` preset** (widget + designer + preview replica):
  - The card carries price, the ongoing-cadence line, quiet inline savings
    (regular weight — no shouting), and the reassurance line at full text
    color. **No "choose your option" framing**: the heading defaults to
    empty in this preset (a Text-tab override still applies), the savings
    **badge is off by default** and the **frequency selector is hidden by
    default** (plan default cadence applies) — both remain re-enableable
    layout knobs (`layout.showBadge` / `layout.showFrequency`).
  - **One-time as a quiet link**: "or buy once for {amount}" — 13px, muted,
    underlined, generous whitespace above so it sits apart from the card,
    with the one-time price rendered in the link *before* selection and
    following variant switches. Tapping it selects one-time: the link swaps
    (pure CSS) into a minimal selected state — small check + "One-time
    purchase — {amount}" — plus a quiet "Switch back to Subscribe & Save"
    link; the cart request then carries no selling plan and the theme
    add-to-cart price sync reverts the button to the theme's own price
    (and back again on switch-back).
  - **Accessibility**: same pattern as every card preset — a real
    `role=radiogroup` with visually-hidden radio inputs and `aria-checked`
    mirroring; the switch-back label drives the subscription radio through
    its `for` attribute (and is `aria-hidden` — keyboards and screen
    readers operate the radio group directly). `buy-box.js` needed **no
    preset-specific code**: the quiet link is a standard option radio in
    the existing state machine.
  - **Honest designer metadata** (`PRESET_META`): highest take-rate
    posture, one-time demoted to a quiet link, conversion risk **medium** —
    test against your baseline and restore from history in one click.
  - Two new locale keys (`or_buy_once_quiet`, `switch_back`) in all 22
    extension locale files (key parity enforced by tests).
- **Per-market design selection** (`config.markets`, keyed by market
  handle — `{ [handle]: { preset } }`, field default `{}`):
  - **Designer "Markets" card**: every Shopify Market on the shop (Admin
    GraphQL `markets` query via the new `app/lib/graphql/markets.server.ts`,
    read-only; primary market tagged) with a per-row preset select whose
    first option is "Default (use main design)". Only the preset varies per
    market — text, layout, style, behavior, placement and theme sync are
    always inherited from the main design. Saves and publishes through the
    existing draft/revision flow. Entries for since-deleted markets are
    flagged and removable; a failed markets fetch degrades gracefully and
    never deletes saved entries.
  - **Storefront resolution, nil-safe**: `localization.market.handle` →
    `config.markets[handle].preset` when present and a known preset, else
    the main `config.preset`; storefronts that report no market, unknown
    handles and unknown preset values all fall back to the main design. The
    theme-editor `design_source` emergency override still wins over the
    whole config, markets included. `data-cellexia-preset` — and therefore
    the `_cellexia_design` take-rate attribution — carries the **resolved**
    preset, so per-market rollouts are measurable per design.
  - **Preview per market**: a "Preview market" select above the designer's
    preview pane renders the preset each market resolves to (client-side
    replica, nothing published); the storefront preview link shows the
    market of the domain you open it on.

### Documentation

- [docs/OFFER_PLAYBOOK.md §9](docs/OFFER_PLAYBOOK.md): "Subscription Max"
  section — what it is, why it is deliberately not subscription-only, when
  to use it, and the per-market rollout measurement discipline (enable in
  one market, compare take rate *and* PDP conversion, one-click restore).
- [docs/OPERATIONS.md §15](docs/OPERATIONS.md): Markets card runbook +
  per-market preview note. [docs/TESTING.md §10](docs/TESTING.md):
  subscription_max QA checks (one-tap one-time, price in link, switch-back,
  ATC price sync both directions) + per-market preview QA.

## [1.5.0] — 2026-08-06

**Customer-journey audit: 35 findings fixed across portal, cancel/win-back
and dunning.** A line-by-line audit of the three surfaces a paying
subscriber actually touches — the customer portal + magic links, the
cancel/win-back flow, and the dunning engine with its admin queue — surfaced
**35 findings: 9 portal, 13 cancel/win-back, 13 dunning. All 35 are fixed in
this release** and enumerated below, each tagged `[portal]` / `[cancel]` /
`[dunning]`. The heaviest were security- and money-grade: the magic-link
login put the portal session token in the URL, a crafted POST could mint a
never-offered discount, a second failing cycle burned the whole retry ladder
in minutes, and "payment failed" emails could double-send across a crash.
None of the audited fixes needed schema changes — every behavior knob they
introduce is a JSON setting whose default equals the old hardcoded constant.

**True-LTV revenue + acquisition data foundation + self-learning models.**
The origin (checkout) payment never becomes a `BillingAttempt`, so every
cohort/LTGP/rollup revenue figure was structurally **renewals-only** and
understated true LTV by each subscriber's first — largest,
first-order-discounted — payment. This release captures the origin order's
money on the contract, backfills history, and books it into cohort month-0
and daily-rollup revenue with refund netting and a hard double-count guard;
the user-facing "renewals-only" qualifiers are gone. **Expect cohort
month-0 cells (and every LTGP figure built on them) to jump on upgrade —
that is the first payment finally being counted, not an error.** On top of
the new data: an acquisition & behavior data foundation (sanitized at
ingest, erased on GDPR redact —
[docs/DATA_FOUNDATION.md](docs/DATA_FOUNDATION.md)), a **learned churn-risk
model that shadows the heuristic until it is provably better on held-out
data**, and a forecast that measures its own models weekly and picks the
winner.

**MINOR bump**: ships one **additive** migration
(`0006_origin_order_revenue_acquisition`: eighteen nullable-or-defaulted
`ADD COLUMN`s on `SubscriptionContract`; no drop/rename/rewrite), two
machine-written Settings (`riskModel`, `forecastModelHistory`) and three
scheduled jobs with safe defaults (`risk_learning_run`,
`origin_order_backfill`, `cancel_session_gc`) — exactly the
[docs/UPDATE.md §1](docs/UPDATE.md) MINOR contract. No env changes, no scope
changes, nothing destructive.

### Added

- **Origin-order revenue in analytics**: cohorts book the origin payment
  (`originOrderTotalCents` net of `originOrderRefundedCents`) into the
  subscriber's month-0, and daily rollups book it on the day it processed;
  `REFUNDS_CREATE` matches refunds to contracts by `originOrderId` and
  accumulates `originOrderRefundedCents`, so origin refunds are netted just
  like renewal refunds. The shared `originPaymentCountsOnce` guard
  guarantees an order already claimed by a billing attempt is **never also
  booked as origin revenue** — no double counting on any surface.
  `lifetimeRevenueCents` deliberately keeps its renewals-only
  ("billed by this app") meaning, documented as such.
- **Origin money capture + backfill**: the contract mirror/sync stamps
  `originOrderTotalCents/DiscountCents/ShippingChargedCents/ProcessedAt/
  CurrencyCode` from the origin order summary at mirror time (never
  rewritten once set), and the daily `origin_order_backfill` job fills
  pre-1.5.0 rows so history joins the totals.
- **Acquisition & behavior data foundation**
  ([docs/DATA_FOUNDATION.md](docs/DATA_FOUNDATION.md)): twelve `acq*`
  columns (referring/landing site, source, UTM, geo, device, time-to-purchase,
  first-order units/value band, raw bundle) captured once per contract from
  the origin `ORDERS_CREATE` payload + Shopify customer record. **Sanitized
  before persistence**: URLs keep host + path + `utm_*` params only — never
  a raw IP, never a full user-agent. Capture is idempotent via an atomic
  `acqRaw`-still-null claim. The import script accepts optional `acq_*` CSV
  columns; Klaviyo profiles gain `cellexia_acq_source` /
  `cellexia_acq_country`; the subscriber detail page gains an acquisition
  card.
- **Learned churn-risk model** (`app/lib/analytics/learning.server.ts`,
  nightly `risk_learning_run` job): logistic regression trained on
  historical feature snapshots (28-day snapshot cadence, 60-day churn
  outcome window, time-ordered train/holdout split). **Shadow-until-better
  with sample-count honesty**: the learned model influences nothing until
  it has ≥50 positive and ≥50 negative outcomes **and** beats the heuristic
  baseline's holdout AUC by ≥0.02; it is demoted the same way if it stops
  qualifying. `getRiskModelStatus()` and the Overview risk-calibration chip
  report the active mode with its sample counts — the UI never claims
  "learned" without the data to prove it.
- **Self-measuring forecast**: the nightly `risk_learning_run` tick
  backtests the forecast models against what actually happened and records
  each completed week's per-model error in the rolling machine-written
  `forecastModelHistory` Setting; "auto" now selects by
  exponentially weighted recent error (a lucky week no longer flips the
  choice), and a new **blend** model averages the base models weighted by
  inverse recorded error. The Forecast tab shows which model is winning on
  recorded weeks and why.
- `[portal]` **One-tap restart everywhere a cancelled customer lands**:
  "Restart my subscription" on the portal home card and the subscription
  detail page, and "Restart my subscription now" on the cancel "done" page
  (all posting to the portal `reactivate` action → `reactivateFromWinback`,
  no discount attached) — the cancelled state was a portal dead-end for
  returning customers.
- `[cancel]` **Reason-offer cooldown**
  (`cancelFlow.reasonOfferCooldownDays`, default 90): the step-3 discount
  save can no longer be farmed by re-walking the flow every time the grant
  exhausts; checked both when building the card and again at accept time.
- `[cancel]` **Offer gating enforced server-side**: `acceptSave` refuses any
  save kind that was never shown in the session (PAUSE exempt — the flow's
  own always-available default), so a crafted POST can't mint an unoffered
  15% grant.
- Promoted hardcoded behavior to settings (defaults = old constants):
  `cancelFlow.maxSavesShown/frequencySuggestDeltaWeeks/pauseSuggestMonths/
  sessionFreshMinutes`, `winback.reactivationBillDelayDays/linkGraceDays`,
  and the portal limits `portal.mutationsPerHour/nextDateMaxDays/
  maxLineQuantity/otpRequestsPerHour/otpVerifyMaxAttempts/
  contextualPromptBufferDays/contextualPromptDelayWeeks` — each editable in
  the admin (Cancel flow / Settings pages). Winback touch offsets are now
  validated monotonic (soft < perk < discount < sunset) and
  `dunning.softRetryDays` strictly increasing.
- `[cancel]` **`cancel.aborted` is emitted** (the documented vocabulary was
  dead): when a new flow abandons prior sessions, and hourly via the new
  `cancel_session_gc` job for walked-away sessions.
- `[cancel]` Save-rate instrumentation: `cancel.save_shown` carries
  per-offer parameters, DISCOUNT/FINAL accepts carry `sessionId`,
  `cancel.completed` carries the declined offer kinds; new "Save rate by
  offer kind" table on the admin Cancel flow page.
- Regression tests: `tests/portal-audit.test.ts` (LOGIN hand-off, OTP
  timing, RTL, dispatcher gates, static source pins),
  `tests/cancel-save-guards.test.ts`, `tests/dunning-ladder.test.ts` (real
  ladder-rung selection), `tests/dunning-double-retry.test.ts` (cross-cycle
  case scoping, idempotency through the immediate-retry collision),
  `tests/dunning-send-dedupe.test.ts`, `tests/origin-revenue.test.ts`,
  `tests/acquisition.test.ts` + `tests/acquisition-capture.test.ts`
  (sanitizer + capture/redact), and `tests/risk-learning.test.ts`
  (determinism, promotion gate, no label leakage).

### Changed

- **CUSTOMERS_REDACT erases acquisition data with the identity**: every
  `acq*` column and the `acqRaw` bundle are nulled by the GDPR redact
  handler, and `acquisition.captured` events are scrubbed alongside the
  customer's other events. Any future `acq*` column must be added to the
  redact list (enforced by comment-contract and test).
- **"Renewals-only" labels removed**: with origin revenue included in
  cohorts, LTGP and rollups, the analytics UI qualifiers and doc claims
  that revenue was renewals-only are gone. The one field that keeps the
  old meaning — `lifetimeRevenueCents` ("billed by this app") — is
  documented as such in code and docs, and the subscriber page shows it
  beside its "orders billed" count.
- `[cancel]` **FTC/EU click-to-cancel alignment**: declining saves
  completes the cancellation immediately (no auto-inserted interstitial);
  the deeper final offer is strictly opt-in behind a "See my final offer"
  link on the saves/confirm pages; the reason survey has a visible "I'd
  rather not say" bypass. Compliance comments now describe the real flow.
- `[cancel]` **Final offer is show-once**: `eligibleForFinalOffer` also
  blocks on a prior `cancel.final_offer_shown` within the cooldown, and the
  copy no longer claims "we only offer this once" unconditionally.
- `[cancel]` Honest copy (en + 21 locales in parity): win-back seed says we
  may check in "a couple of times"; milestone copy no longer implies an
  already-shipped gift can be revoked.
- `[cancel]` Winback grant acceptance now logs `winback.discount_granted`
  (new vocabulary entry) instead of re-emitting `winback.discount_offered`
  — offer/acceptance analytics no longer double-count.
- `[dunning]` Admin dunning queue: scoped to owned, non-demo contracts
  (queries and actions), next-retry shown as shop-timezone date+time,
  recovery rate counts cancelled-from-dunning cases in its denominator.

### Fixed

- `[dunning]` **Cross-cycle dunning case reuse** — a second cycle failing
  while an older case was open anchored its ladder to the stale `openedAt`
  and burned every rung in minutes: cases are now per billing cycle (older
  open case closed as `SUPERSEDED`, fresh anchor + notification cursors).
- `[dunning]` **Ladder rungs are selected by time, not attempt count** —
  admin "Retry now", the 1-hour backup retry and payment-method-updated
  immediate retries no longer consume configured rungs or drag exhaustion
  earlier; a scheduled retry is always strictly in the future (also fixes
  the snap-past-next-rung edge).
- `[dunning]` **Exhausted-case resurrection was dead code** — the
  payment-method webhook now pokes dunning when the contract is FAILED even
  though the EXHAUSTED case has `resolvedAt` set, so a customer who fixes
  their card via the emailed link actually recovers.
- `[dunning]` **Success webhooks only resolve the matching cycle's case** —
  a newer cycle's ordinary renewal no longer closes an older cycle's case
  as "recovered" (cancelling its pending retry and booking the wrong
  amount).
- `[dunning]` **Failure processing is crash-resumable** — the webhook
  handler always re-invokes the dunning engine on redelivery; the engine's
  processing-complete marker (`declineCategory`) is written last.
- `[dunning]` **Ladder emails/SMS have persistent dedupe** (NotificationLog
  `dunning_dedupe` key) — a crash between send and cursor write, or a
  second sweep instance, can no longer double-send "payment failed".
- `[dunning]` **Webhook-driven dunning notifications share that dedupe**
  (`sendCaseNotificationOnce`): the HARD-failure notice carries the ladder's
  own rung-0 key (webhook path and day-0 sweep rung mutually dedupe), and
  the 3DS fallback + real-challenge links each dedupe against their own
  redelivery on per-case / per-attempt keys — closing the crash window
  between `sendNotification` and the `emailsSent`/`lastNotifiedAt` cursor
  write on all three webhook send sites (regression:
  `tests/dunning-send-dedupe.test.ts`).
- `[dunning]` **Backup-card fallback is two-way and visible** — if the
  backup also fails, the original card is restored for the remaining rungs
  (`dunning.backup_reverted`); switching refreshes the mirrored card
  metadata and notifies the customer (`payment_method_updated`).
- `[dunning]` **Late 3DS failures for an already-recovered cycle** no
  longer open a phantom case / email "confirm your payment" to a customer
  who just paid.
- `[dunning]` **fireRetry cannot loop hourly forever** — a permanent
  ShopifyUserError (or 24 consecutive create failures) parks the case
  AWAITING_CUSTOMER, expires the blocking PENDING row, and lets the
  cancel-window timeout resolve it.
- `[dunning]` Pre-expiry sweep only sends Shopify's hosted card-update
  email when our own notice was actually SENT — no more daily Shopify
  emails while the email channel is off.
- `[dunning]` UPDATE_CARD magic links now live `cancelAfterFailedDays + 7`
  days, so the last ladder email's link is still valid at the end of the
  case window.
- `[portal]` **The magic-link login exposed the portal session** — the
  LOGIN verb minted a session at link time and redirected with the token in
  the URL (browser history, referrer headers, proxy logs). It now redirects
  with a single-use hand-off code (TTL ≤ 2 minutes) that the portal
  exchanges server-side (`exchangeLoginHandoff`) for the HttpOnly + Secure
  `cx_portal` cookie; an emailed LOGIN link pasted as a hand-off code is
  refused, and only the exchange ever creates a session.
- `[portal]` **The portal page script wrote a JS-readable session cookie**
  — removed; session tokens are read from the signed HttpOnly cookie only,
  never from query parameters or `document.cookie` (both statically pinned
  by `tests/portal-audit.test.ts`).
- `[portal]` **OTP requests leaked subscriber membership through response
  timing** — `requestOtp` returned fast for unknown emails and slow (send
  awaited) for known ones; the send is now fire-and-forget and every return
  path waits out the same jittered constant-time floor.
- `[portal]` **Magic-link mutations bypassed the portal's hourly rate
  ceiling** (bounded only by per-token maxUses) — mutating verbs now share
  `portal.mutationsPerHour`, counted insert-then-count on the
  already-logged `magic.link_used` event; LOGIN / card-update / 3DS
  hand-offs stay unthrottled.
- `[portal]` **Portal rate limiting had a count-then-act race** — a
  dedicated `portal.mutation_attempt` event is inserted before counting, so
  concurrent requests each see at least their own attempt and the ceiling
  holds.
- `[portal]` **`address` was accepted for contracts in non-editable
  statuses** — the api dispatcher now gates it on an `EDITABLE_ONLY` status
  check like the cycle verbs.
- `[portal]` **Double-tapped one-tap mutations re-executed** (second tab,
  email client prefetch, retry) — skip/delay carry the cycle date they
  target (`expected_next`) and no-op with the same success toast once the
  contract has advanced; pause/resume short-circuit on status.
- `[portal]` **RTL locales rendered left-to-right** — the portal root now
  stamps `lang` + `dir` (Arabic gets `dir="rtl"` with RTL-aware styles)
  inside the merchant's LTR theme.
- `[cancel]` Winback perk links grant the promised free gift —
  `params.gift` is passed through, `percent: 0` is no longer clamped up to
  a bogus 1% × 1-cycle grant, and the confirmation shows gift copy.
- `[cancel]` Demo-fixture leakage: rewards-unlock, gift-scheduling (incl.
  shipped-gift mirror clear) and win-back scheduling/sweep all exclude
  `isDemo` contracts.
- `[cancel]` Browser back-navigation to the saves page no longer wipes the
  FINAL_DISCOUNT shown-marker (merge-preserving `savesShown` writes).
- `[cancel]` Admin cancel-flow funnel reads `savesShown` by its real `kind`
  key (the final-offer tiles could never populate), the reason→saves
  preview table matches the live config, and `humanReason` lists the real
  vocabulary.
- `[cancel]` "I still want to cancel" after a save carries the customer's
  stated reason into the new session (and `completeCancel` falls back to
  the most recent stated reason) instead of burying it as OTHER.

## [1.4.0] — 2026-08-06

**Analytics correctness audit.** A line-by-line debug of the entire analytics
module (rollup, cohorts/LTGP, survival, forecast, funnel queries, alerts,
risk) plus the webhook/billing paths that feed it surfaced **18 findings —
all 18 fixed in this release** and enumerated below (5 under *Added*: missing
capabilities, including the reported "nowhere to set COGS/shipping/fees for
LTGP" gap; 4 under *Changed*: corrected behaviour; 9 under *Fixed*: outright
defects). Every money metric now decomposes the same way on every surface —
**gross profit = revenue (net of refunds) − COGS − merchant-side
shipping/fulfillment − payment fees** — computed by one shared cost model,
with the estimated share of COGS tracked so partly-estimated LTGP is flagged
instead of silently trusted. Ownership (`OURS` only) and the demo fixture are
excluded from every analytics aggregate via a single spreadable filter.
Survival curves are right-censored; forecasts can never emit NaN.

**MINOR bump**: ships two **additive** database migrations
(`0004_analytics_costs`: nine columns; `0005_exact_billing_cadence`: two
nullable columns) and new admin settings with safe defaults — exactly the
[docs/UPDATE.md §1](docs/UPDATE.md) MINOR contract. No env changes, no scope
changes, nothing destructive.

### Added

- **Shared analytics cost model** (`app/lib/analytics/costs.server.ts` + the
  `costModel` setting, Settings → Costs & profit): payment fee (% + fixed per charge),
  merchant-side fulfillment + carrier cost per shipment, and a
  COGS-fallback-percent-of-price for products with no known cost. COGS per
  billed line resolves synced Shopify `inventoryItem.unitCost` → the
  merchant's per-product override (`ProductCadence.unitCostCentsOverride`,
  Plans → "Costs & margins") → the percentage estimate; the estimated share is
  stored (`estimatedCogsCents`) and surfaced as a coverage warning.
- **Refund tracking**: `REFUNDS_CREATE` records refunds against our renewal
  orders on `BillingAttempt.refundedCents` (idempotent per refund id). The
  originally charged `amountCents` is never rewritten; rollups and cohorts
  subtract refunds instead, and `SubscriptionContract.lifetimeRevenueCents`
  is decremented (clamped at zero) so lifetime figures read net of refunds.
- **Exact billing cadence mirror**
  (`SubscriptionContract.billingIntervalUnit`/`billingIntervalCount`, synced
  from the Shopify billing policy): MRR now converts each contract's real
  cadence to calendar months. A monthly 80.– plan is 80.–/mo MRR — the old
  `intervalWeeks` approximation read it as ≈86.90 (×4.345/4, ~8.6% high) and
  understated day-cadences by up to ~16%. Pre-existing rows fall back to the
  approximation until their next sync.
- **Prepaid detection at ingest**: contracts whose delivery policy is
  strictly more frequent than their billing policy are flagged
  `isPrepaid` with `prepaidDeliveriesPerCharge`, so the prepaid mix stats and
  the cost model's deliveries-per-charge multipliers (COGS/shipping per
  charge) actually engage.
- **Daily rollup self-heal**: the rollup job scans the last 90 days for
  missing `DailyRollup` rows (multi-day outages used to leave permanent
  interior gaps — "yesterday + today" on resume only closed the newest day)
  and fills them from raw data; days that already have a row are never
  rewritten. A FAILED daily job now retries within 30 minutes instead of
  waiting out its full 24h cadence.

### Changed

- **Cohort/LTGP surfaces are labelled "renewal" throughout** (Analytics →
  Cohorts & LTGP): cohort revenue is Σ successful billing attempts, and the
  first (checkout) payment never becomes a billing attempt, so cumulative
  LTGP intentionally excludes each subscriber's first payment. Every surface
  now discloses this — true lifetime value is HIGHER than shown.
- **Rollup and cohort gross profit use the same formula** (they used to
  differ: charged − COGS vs revenue − COGS − customer-paid delivery − a
  hardcoded 2.9%+30¢), so the two surfaces reconcile to the cent — pinned by
  the golden-number test suite.
- Survival/retention curves are **right-censored**: contracts that simply
  have not reached a cycle yet carry no information about surviving it, so a
  young book no longer reads as sky-high churn. Forecast history
  carry-forward-fills rollup gaps (annotated, never invented growth) and is
  guarded against NaN on empty/short/flat history.
- `getOrderSummary` no longer invents `"GBP"` when Shopify omits the money
  set — it returns `null` and every caller falls back to the contract's own
  currency, so a mislabelled amount can no longer slip past the
  "same-currency only" analytics guards.

### Fixed

- **Billing-attempt success webhook races** (double-count risk): the
  PENDING→SUCCESS transition is now claimed atomically (status-guarded
  write), so two concurrent deliveries of the same success under different
  webhook ids can no longer double-increment `ordersCount` /
  `lifetimeRevenueCents`. A replay of an already-settled attempt no longer
  rewrites `amountCents` from the order's current total — after a refund that
  total is reduced and refunds are subtracted separately, so the old
  behaviour double-counted the refund.
- **Stale-attempt sweep success path**: an attempt resolved by the sweep
  (missed webhook) now records the charged amount from the order and
  increments the contract counters — the charge used to enter rollup/cohort
  revenue as 0 with stale cycle counters.
- **`ORDERS_CREATE` idempotency**: manual webhook redeliveries (new webhook
  id) no longer double-count the take-rate denominator
  (`checkout.subscribable`) or design attribution — guarded per order id,
  same pattern as the refund guard.
- **Win-back reactivation preserves churn history**: the prior
  `cancelledAt`/`cancelReason`/`cancelSource`/`failedAt` are recorded on the
  `winback.reactivated` event before the live columns are cleared, and closed
  rollup days are never rewritten, so the churn episode stays reconstructable
  while cohort retention correctly counts the subscriber as retained again.
- **Take-rate denominator no longer counts renewal orders**:
  `ORDERS_CREATE` skips orders with `source_name "subscription_contract"`
  (the value Shopify stamps on billing-attempt orders). Renewals used to
  inflate the checkout counter once per cycle — systematically deflating the
  take-rate level as the book matured — and their line items re-carry the
  buy-box design property, re-attributing the same design every cycle.
  Events logged before this release still include renewals; the analytics
  card's help text says so.
- **Rollup funnel counters scoped to countable contracts**: the daily
  rollup's `skips` / `savesOffered` / `savesAccepted` / `addonsAttached`
  columns (and the refund events feeding `refundedCents`) now count
  `SubscriberEvent` rows through the contract relation with the shared
  ownership + non-demo filter — a merchant clicking through the demo-portal
  cancel flow or skipping the demo contract's cycle no longer inflates that
  day's funnel numbers, and a refund recorded against a non-countable
  contract can no longer reduce revenue chargedCents never contained.
  `checkout.subscribable` (take-rate denominator) stays contract-less by
  nature and is counted separately. Pinned by demo/foreign event pollution
  in the golden-number suite.
- **Charge timestamps no longer drift on delayed settlement**: a success
  settled by webhook or the stale sweep stamps `completedAt` (and a first
  charge's `firstChargeAt`) from the order's `createdAt` — the real charge
  instant — instead of processing time, so a charge near midnight (or one
  resolved by the hours-later sweep) lands in its true rollup day and cohort
  month. Backdating is capped at 24h, and `rollup_run` now re-upserts the
  last 2 closed days on every tick, so a backdated charge can never strand
  in a rollup row that is no longer recomputed.
- **Duplicate operational alerts under concurrent scans**: `raiseAlert`'s
  open-alert dedupe and create now run inside one transaction serialized by
  a Postgres advisory lock per (shop, alert type) — the 15-minute runner
  racing a manual scan (or a second app pod) can no longer create duplicate
  alert rows or send duplicate CRITICAL emails. No schema change.
- **Last hardcoded currency fallback removed**: `normalizeContract` no
  longer invents `"GBP"` when Shopify omits a contract's `currencyCode`
  (`ShopifyContract.currencyCode` is now nullable, same contract as
  `OrderSummary`); the sync mirror falls back to the existing row's
  currency, then the shop's — amounts can no longer slip past the
  "same currency only" analytics guards in the wrong book.

### Migration notes

Run `npx prisma migrate deploy` (or `npm run setup`) as usual — both
migrations are additive and safe under old code. No admin action is required.
Optional but recommended: fill in Settings → Costs (payment fee, shipping/
fulfillment, COGS fallback) and per-product COGS overrides on the Plans page;
until then gross profit uses the model's defaults and flags the estimated
share. MRR precision improves per contract as each contract next syncs
(webhook or backfill); a full re-sync accelerates it.

## [1.3.0] — 2026-08-05

> **⚠️ SAFETY RELEASE — PREVENTS DUPLICATE CHARGES TO REAL CUSTOMERS**
>
> Before this version, going live on a store that runs a **second subscription
> app** would have made this app bill **that app's subscribers too**. Their
> contracts arrive here on the same Shopify webhooks, were mirrored like any
> other, and the billing sweep charged every active contract it found — while
> the other app kept charging them on its own schedule. **Two apps, two
> charges, one real customer.** Nothing had gone out yet only because the app
> was still in Setup mode.
>
> From 1.3.0 every contract carries an explicit owner, and **only contracts
> this app owns are ever billed, dunned, emailed, sent to Klaviyo, counted or
> exposed in the portal**. Ownership that cannot be proven is treated exactly
> like another app's — nothing is charged on a guess. The same release stops
> the buy box from selling a competitor's plan through our widget.
>
> Update before going live. On a store that already has subscriptions, read
> **Migration notes** at the end of this entry — there is one required admin
> step, and until you run it your **own** renewals are paused rather than
> risked.

**Two subscription apps on one store.** cellexialabs.com runs Joy
Subscriptions as well as this app, and Shopify gives every subscription app on
a store the same webhooks and the same product pages. Until this release the
app behaved as if it were alone: it rendered whichever selling plan group came
first on the product, and it mirrored — and would have billed — every contract
on the store, Joy's included. This release makes "whose is this?" an explicit,
fail-safe property of every contract and of every group the buy box could
render.

**MINOR bump, not a patch**: it ships a database migration and new admin
behaviour, which [docs/UPDATE.md §1](docs/UPDATE.md) reserves for MINOR
releases. (Source comments written while this work was in progress date it
`v1.2.4`; that version was never released.)

**Ships a database migration** (`0003_contract_ownership`, additive: three
columns and one index). See **Migration notes** at the end of this entry — one
admin step is required on a store that already has subscriptions.

### Added

- **`SubscriptionContract.ownership`** — `OURS` / `FOREIGN` / `UNKNOWN`,
  decided from the selling plan ids on the contract's lines against the plan
  ids we synced (`SellingPlanConfig.shopifyPlanIds`, also new, and
  `ContractLine.sellingPlanId` / `sellingPlanName`, likewise). Only `OURS` is
  ever billed, dunned, reminded, emailed/SMSed, sent to Klaviyo, counted in
  analytics or exposed in the customer portal. `UNKNOWN` — ownership not
  provable — is treated exactly like another app's: the indeterminate case
  fails safe, so nothing is charged on a guess. The column **defaults to
  `UNKNOWN`**, in the schema and in the migration alike. Every insert path
  writes it explicitly, so the default is only ever reached by a `create()`
  that forgot the column — which makes its value "what a future bug gets", not
  "what most contracts are". `OURS` would hand that bug straight to the billing
  sweep; `UNKNOWN` hands it to the re-check pass instead.
- **The storefront allow-list `cellexia.plan_groups`** (shop metafield, json),
  republished on every plan sync and again on go-live. The buy box renders the
  group whose **id** is on that list and no other; ids are compared as strings
  by exact equality, one entry at a time. A listed group must *also* contain
  one of the listed **plan** ids before it renders — two independent fields,
  **both mandatory**, so a single forged or corrupted `groupIds` entry cannot
  hand the renderer another app's group. An allow-list carrying no plan ids
  therefore unlocks nothing at all: the buy box renders on both factors or it
  renders nothing.

  `planIds` was briefly specified as a veto rather than a requirement — empty
  meant "match on the group id alone", so a shop that had not yet recorded
  `SellingPlanConfig.shopifyPlanIds` kept its widget instead of going dark.
  That was a hole, and a reachable one: empty `planIds` is a state the app
  *emits itself*, whenever the plan-id repair cannot read a group back from
  Shopify (`{"groupIds":["77"],"planIds":[]}`). In it, the two factors
  collapsed to one and a single bad `groupIds` entry rendered a competitor's
  group in full — their discount in the price, their selling plan id in the
  cart mirror and the JSON island, their contract at the end of it. Both
  factors are now required in every state. The cost is paid in the safe
  direction: a shop whose plan ids are unrecorded shows no buy box until the
  next successful sync, rather than showing the wrong one. Publishing repairs
  the missing plan ids first, so that window closes on the first sync or
  go-live, and the go-live audit entry now says `published but INCOMPLETE`
  instead of `published` when it does not.
- **Preview & launch → "Other subscription apps"** — contracts by owner, the
  other app's selling plan groups and the products they sit on, and a
  **Re-check subscription ownership** action that reads contracts back from
  Shopify and re-files them.
- **Subscribers**: an owner per row, a filter for the unattributed ones, and
  **Claim as Cellexia's** (bulk) for contracts that are ours but carry no
  selling plan to prove it — imports, typically. Claiming only ever promotes
  `UNKNOWN` → `OURS`; a contract positively identified as another app's is
  never flipped.
- **A `FOREIGN_CONTRACTS` alert** (WARNING, deduped like every other alert)
  while any subscription on the store belongs to another app or is still
  unattributed — so the situation is impossible to miss before go-live. Its
  message states the isolation in plain words: Cellexia will never bill, email
  or modify them.
- **Documentation** for running two subscription apps on one store:
  - `docs/OPERATIONS.md` §18 — the runbook: what each ownership value means, a
    what-is-isolated / what-is-your-job table (billing, emails, Klaviyo,
    analytics and the portal are isolated; the product page is not), what
    going live does to the other app's subscribers (nothing), what to do after
    this update, the checklist to work through **before uninstalling the other
    app**, and the support answer for "my login code never arrives".
  - `docs/INSTALL.md` §7d — the explicit install step when another
    subscription app is present (sync your plan to the products, confirm the
    preview shows *your* discount, disable the other app's PDP widget before
    go-live), §10 checklist row 11, §10d (confirm every subscription is
    attributed right after go-live) and two new Troubleshooting entries for
    "no widget renders" / "that subscribe box is not ours".
  - `docs/MIGRATION.md` §5 — the Joy-specific path: export, cancel in the other
    app **first**, import (rows are stamped `OURS`), claim the leftovers, and
    why a `FOREIGN` contract can never be claimed instead of re-imported.
  - `docs/ARCHITECTURE.md` — the ownership model, the allow-list metafield and
    the admin surfacing, as golden rule 11.

### Fixed

- **The buy box rendered a competitor's selling plan group.** It took
  `product.selling_plan_groups | first` and then looked for a group whose
  *name* contained "cellexia"; on the client's product, where Joy's group is
  first and no group is named that way, it resolved to **Joy's**. The page
  advertised Joy's 5%, the frequency selector offered Joy's cadences, and the
  hidden `selling_plan` mirror — the value that reaches `/cart/add` — carried a
  **Joy selling plan id**, so a subscription bought through our widget became a
  Joy contract. Editing our own plan changed nothing on the page, because our
  plan was never on the page. The group is now chosen from the id allow-list,
  and when no owned group matches, the snippet renders **nothing at all**: no
  wrapper, no JSON island, no hidden input, no `<style>` — byte-identical to a
  product with no subscription plans, bar an empty hidden `<template>` that
  only the admin preview reads.
- **The pre-sync name fallback could still render another app's group.** With
  no allow-list published yet, the widget matched on the group *name* — and a
  name is merchant-chosen text: on a store called Cellexia Labs, a Joy group
  called "Cellexia Subscribe & Save" renders as ours, and a lone group on the
  product is not evidence either. The heuristic is **removed**, not narrowed:
  guessing from a name has no safe version. A group renders because its id is
  on the allow-list, or it does not render — so a product page shows no widget
  until the plan has been synced (which is what publishes the allow-list). The
  `group_name_token` snippet parameter is gone with it.
- **Go-live rescheduled the other app's subscriptions.** The overdue-renewal
  list the go-live modal offers to stagger was not filtered by ownership, and
  staggering calls `setNextBillingDate`, which edits the contract **on
  Shopify** — so going live moved billing dates on contracts Joy owns, for
  charges we were never going to make. The list is `OURS` only now.
- **The admin support cockpit acted on contracts we do not own.** It opened for
  a `FOREIGN`/`UNKNOWN` contract with a warning banner but left every button
  live, and warning copy is not a control: **Charge now** there calls Shopify's
  `billingAttemptCreate` — the duplicate charge this release exists to prevent,
  one click away, and reachable by POST without the UI at all. Every intent is
  now refused server-side unless the contract is `OURS`, next to where the
  contract is loaded, so a newly added action is refused by default; the page
  still opens, and read-only product search still works.
- **Inbound SMS keywords (`SKIP` / `DELAY`) acted on any subscriber on the
  store.** `/api/sms/inbound` resolved a phone number against every ACTIVE
  contract, demo fixtures and the other app's subscribers included, then moved
  the next billing date on Shopify and replied. A number we do not manage now
  gets the ordinary "unknown phone" answer, which is what leaves the other
  app's own keyword flow to handle it.
- **`reclassifyContracts()` had no caller.** The one function that turns
  mirrored contracts into real verdicts — the documented pre-go-live step —
  existed in the codebase and was invoked by nothing: no route, no job, no
  script. Go-live now runs it before the mode flips, and the Preview & launch
  page exposes it as a button. A static test asserts both wirings, because dead
  code passes every behavioural test it does not have.

- **Going live left the biggest stores half-attributed.** Go-live ran ONE
  reclassification pass, and a pass stops after 2 000 contracts. A store with
  more subscriptions than that went live with the overflow still `UNKNOWN` —
  **our own subscribers among them, and `UNKNOWN` is never billed** — so those
  renewals silently stopped. Nothing in the app re-ran the pass; the only
  recovery was an admin noticing and pressing *Re-check subscription
  ownership* over and over. Go-live now sweeps **every** contract, paginated by
  `id` (the pass orders by `ownership`, the very column it rewrites, which is
  safe for one capped pass but would skip or revisit rows when paging through
  a whole store). Bounded in both directions: a row ceiling and a budget on
  Shopify re-fetches, with anything left over reported as `remaining`.
- **"How much is left?" always said "not finished".** `remaining` was
  *contracts this pass did not look at*, counted over the whole store — a
  constant on any store larger than one pass, so it never reached zero however
  many times the pass ran. It is now the number of contracts still waiting for
  a verdict: it decreases as work is done and reaches **0** exactly when the
  store is fully attributed. That is the number the go-live audit event records
  and the one the Preview & launch toast turns into "run it again".
- **Another app's charges landed on our books.** Shopify sends
  `SUBSCRIPTION_BILLING_ATTEMPTS_*` for every contract on the store, so Joy's
  renewals arrived as webhooks for charges we never made. With no matching
  local attempt row (there could not be one), the handler fell through to
  reconstructing a `BillingAttempt` from the payload — for **any** contract. On
  Joy's contracts that incremented `ordersCount` and `lifetimeRevenueCents` on
  our mirror, put a row in the `PENDING` gauge the health endpoint reads, and
  spent a Shopify order-summary call per foreign renewal. Reconstruction is now
  refused unless the contract is `OURS`. Attempts we *did* originate are
  unaffected — they match by attempt id or idempotency key first — and so is
  the case the path exists for: a merchant charging one of **our** contracts by
  hand from the Shopify admin.

### Changed

- **Every gating query filters on ownership** — the billing due-query and its
  batch re-fetch, the stale-attempt sweep, dunning (case creation and the retry
  sweep), reminders and pause auto-resume, gifts, lifecycle, win-back,
  consolidation, price-change batches, all analytics (rollups, cohorts,
  survival, risk, forecast, alerts, dashboard), the portal (list, detail,
  account, OTP login and the single mutation dispatcher), magic links, bulk
  plan migration and mass skip. `tests/ownership-enforcement.test.ts` pins both
  halves: the guards firing, and the filters still being present in the source
  of every one of those queries.
- The **Subscribers list is deliberately NOT filtered** — it is the one place
  another app's contracts must stay visible, so the merchant can see and claim
  them. Pinned by test, so a well-meaning "add the filter everywhere" cannot
  blind the admin.

### Migration notes

`npx prisma migrate deploy` (or `npm run setup`) applies
`0003_contract_ownership`. It is additive — three `ADD COLUMN`, one
`CREATE INDEX`, no drop, no rename, no data rewrite — and the previous app
version runs unchanged against the new schema.

**Pre-existing contracts are backfilled to `UNKNOWN`, not `OURS`.** At
migration time there is nothing to decide with: the two columns ownership is
derived from are added by that same migration and are null on every existing
row. `OURS` would have been fail-open — the first billing sweep after the
update would have charged the other app's subscribers on top of the other app,
silently. `UNKNOWN` is not billable, so nothing pre-existing is charged until
it has been positively identified.

**That includes your own subscribers**, so on a store with existing
subscriptions there is one required step before renewals resume:

> Preview & launch → **Re-check subscription ownership**

It reads each contract back from Shopify, records the selling plan on its
lines and files it as `OURS` or `FOREIGN`. **Going live does this
automatically**, before the mode flips, and sweeps the whole store rather than
one capped batch — so a store going live for the first time needs no extra
step, whatever its size.

One honest limit: each run makes at most 1 000 Shopify re-fetches, and
immediately after the migration every pre-existing contract needs one (the
column its verdict comes from is added by this migration, so it is null on
every existing row). A store with more than 1 000 subscriptions therefore
finishes in more than one run. The toast and the go-live audit event both
report how many are **still unattributed**, and that number reaches 0 when the
job is done — if it is not 0, run *Re-check subscription ownership* again.
Renewals for contracts still waiting are delayed, never double-charged.

**Subscribers imported before this release need claiming.** Contracts created
by the CSV importer or the Import page carry no selling plan at all
(`subscriptionContractAtomicCreate` does not take one), so there is nothing for
the classifier to match: from 1.3.0 those paths stamp `ownership = OURS` at
creation, but rows imported by an earlier version were backfilled to `UNKNOWN`
and the re-check pass cannot promote them — no evidence exists to promote them
*with*. Claim them: Subscribers → *Managed by: Unattributed* → select →
**Claim as Cellexia's** (`UNKNOWN` → `OURS` only, one `admin.action` per row;
`FOREIGN` rows are refused). Then verify the counts on Preview & launch →
"Other subscription apps" before relying on billing.

## [1.2.3] — 2026-07-25

Namespace-collision release. **No database migration and no env change**;
billing, dunning and Klaviyo paths are untouched. It fixes one defect,
reproduced on the client's live store, that made the widget invisible there — a
namespace collision with another app already installed on the same product page
— and then applies the same scoping rule to the *other* place this app puts
markup and a `<script>` on a storefront page: the customer portal, which is
served through the app proxy and therefore renders inside the merchant's theme.
The portal change is presentation-layer only (three DOM lookups; no route,
session, or data behaviour moved).

### Fixed

- **The buy box never mounted on cellexialabs.com: another app owns the "cx"
  attribute namespace.** The client's product page already hosts an unrelated
  vendor which renders, inside `.pdp__info` (the buy column),
  `<div class="cx cx--self-contained" data-cx-embed>` — the same page also
  carries that vendor's `cx-i18n`, `cx-cart-config`, `cx-pdp-config` and
  `cx-embed-config` script ids and a `.sm-rc-widget`. Our app-embed wrapper
  carried an attribute of the same name and `buy-box-embed.js` looked its own
  wrapper up by that attribute alone, so the lookup returned **that vendor's
  element** — it appears earlier in the DOM than our body-end wrapper. Two
  consequences, both observed live: we wrote our "mounted" marker onto, and
  adopted, DOM we do not own; and the mount check then reported "already
  mounted" for ever, so our wrapper stayed at the end of `<body>`, `[hidden]`,
  0px tall. The buy box was simply not on the page.
- **"Your store isn't showing what this page says" could not fire for a
  near-miss launch flag.** The Liquid gate is a plain string equality —
  `if cx_launch_status == 'live'` — with no trim and no case folding, so only
  the exact value `live` renders the widget. `launchFlagDiverged()`
  (`app/lib/launch/launch.server.ts`), which decides whether **Preview &
  launch** shows the critical divergence banner, normalised the metafield with
  `.trim().toLowerCase()` first. A hand-edited `cellexia.launch_status` of
  `" Live "` or `"LIVE"` while the app was LIVE was therefore reported as
  in-sync, while every product page rendered the widget
  `hidden data-cellexia-gated="true"` — a dark store behind a green admin page,
  which is the one state that banner exists to surface. The comparison is now
  exact, matching the gate byte for byte; the near-miss values are pinned on
  both sides (`tests/liquid/render.test.ts` asserts Liquid renders them gated,
  `tests/launch-sync.test.ts` asserts the detector calls each a divergence)
  so the two halves cannot drift apart again. Re-syncing rewrites the flag to
  the canonical value, so the stricter check can only ever offer a fix.

### Changed

- **The widget's entire storefront attribute namespace is now
  `data-cellexia-*`** (was `data-cx-*`): `data-cellexia-embed`,
  `-buybox`, `-preset`, `-gated`, `-mounted`, `-anchor(-pos)`, `-tpl`,
  `-selling-plan`, `-plan-input`, `-design-prop`, `-money-onetime`/`-sub`,
  `-price-sync`/`-selector`, `-save`, `-init`, `-preview`, `-data` and every
  other hook, in both install shapes and in the Liquid, JS and CSS that read
  them. **CSS class names are unchanged** (`.cx-buybox*` does not collide with
  that vendor's `.cx` / `.cx--self-contained`), so no custom CSS a merchant
  wrote against the widget breaks.
- **Every document-level lookup of our own markup is qualified by our class as
  well as our attribute** (`.cx-buybox-embed[data-cellexia-embed]`,
  `.cx-buybox[data-cellexia-buybox]`) — defence in depth, so a future app that
  collides on an attribute name cannot repeat this. Lookups that are not
  document-level are rooted at our own wrapper or widget node. The one
  document-wide lookup that deliberately reads foreign markup (the theme's own
  current-variant field) is read-only and must name one of our variant ids to
  be used at all.
- **Ownership is asserted before anything is moved, marked or unhidden**
  (`classList.contains('cx-buybox-embed')` / `'cx-buybox'`); the code bails out
  silently otherwise. The theme add-to-cart price sync additionally excludes
  every Cellexia widget from its own target search, on top of the existing
  header / nav / footer / cart-drawer exclusions and the rule that a target
  must literally contain the theme's one-time money string before a character
  is touched.
- **The design-attribution cart line property is now `_cellexia_design`** (was
  `_cx_design`). The ORDERS_CREATE webhook reads **both** names, preferring the
  new one, so take-rate-by-design attribution keeps working for orders placed —
  and carts already open — before the merchant updated the theme extension.

- **The customer portal made the same unqualified lookups, on the merchant's
  own theme.** The portal is served through the app proxy, so its HTML and its
  inline `<script>` are injected into the theme — the same document as the
  theme's markup and every storefront app, that `cx` vendor included. The
  script queried `document.querySelector('.cx-toast')` and
  `document.querySelectorAll('.cx-portal form')`: class-only, qualified by no
  attribute, and the second one *writes* — it disables submit buttons on
  submit, so a foreign `.cx-portal` on the page would have had its forms
  disabled by us. It now makes exactly **one** document-level query,
  `.cx-portal[data-cellexia-portal]` (class and attribute), and roots every
  other lookup at that node; the toast carries `data-cellexia-toast` and the
  root `data-cellexia-portal`. Same failure mode as the buy box, a different
  directory — which is precisely why the extension-scoped guards missed it.

### Added

- `tests/liquid/lint.test.ts` §5e — the portal script under the same rule the
  extension lives under: every document-level query qualified by our class
  **and** our attribute, at most one of them, no `getElementById`/
  `getElementsBy*` reach into our markup, and the selector↔markup pairing
  asserted across files (the confirm forms are rendered by
  `app/routes/proxy.*.tsx`, so renaming one side would silently unbind the
  handler instead of raising). `commentSyntaxFor` learned `.ts`/`.tsx` so the
  scanners can read the portal module at all.
- `tests/embed-mount.test.ts` — the collision itself, reproduced: a foreign
  vendor element carrying our attribute name, earlier in the DOM, must be left
  untouched while our own wrapper mounts. Plus a vacuity guard that puts the
  bare attribute lookup back and asserts the widget is stranded at body end,
  exactly as it was on the live store.
- `tests/liquid/lint.test.ts` §5 — static guards: no `data-cx-*` and no
  `_cx_design` in any file the extension serves to a storefront (`assets/`,
  `blocks/`, `snippets/`, `locales/`, the extension TOML); source comments,
  which document the collision in prose, are blanked first, and the maintainer
  `README.md` — which Shopify never serves — is the single exemption, pinned by
  §5b so it cannot grow to cover a file that IS served. Plus: no bare
  `[data-cellexia-*]` document-level lookup, none through `closest()` or
  `matches()` either (an upward walk leaves our subtree just as a document
  query does), and every hoisted own-markup selector must be
  `.cx-*[data-cellexia-*]`.
- `tests/liquid/lint.test.ts` §5d — the guards' own blind spots, tested.
  Comments are blanked by a scanner rather than a regex: the regex version
  erased from the first `//` to end of line, so an ordinary CDN URL in a string
  hid every `data-cx-*` after it on that line, and it applied JS comment rules
  to `.json` and `.toml`, where `//` opens nothing. Call arguments are read
  with balanced parentheses, so a selector containing `:not(…)` can no longer
  slip past the rule that has to inspect it.
- **§5c now recognises every spelling of a document-wide query.** It matched a
  bare `document.` receiver only, so `document.body.querySelector(…)` — the
  outage's own shape, one property access away — together with
  `document.documentElement` and `document.head` walked straight past the rule
  that exists to forbid it. All four roots are matched now, in both the direct
  and the `(scope || document…)` form, and §5d pins that with an executable
  example per receiver so the rule cannot quietly go vacuous again.
- **§5c also covers `getElementById` / `getElementsBy*`.** These search the
  whole page from one bare string and cannot be class-qualified the way a
  selector can, so the rule for them is different in kind: they may not name
  our `cx-*` namespace at all — that namespace is shared with the other
  vendor's `cx-i18n` / `cx-cart-config` / `cx-pdp-config` / `cx-embed-config`
  ids — and our own markup must be reached through the `OWN_*` selectors. The
  one legitimate call (`'shopify-section-' + sectionId`, the platform's id,
  used to narrow a search) is pinned, so a new one fails until a human has
  looked at it.
- **§5c now checks every browser script the extension ships, not a hard-coded
  two.** The rules that forbid a bare `[data-cellexia-*]` lookup, an
  unqualified `OWN_*` selector, an `getElementById`/`getElementsBy*` reach into
  our namespace, and a literal own-markup selector handed to `safeQuery` all
  iterated a literal `["buy-box.js", "buy-box-embed.js"]`, while the
  namespace scanners beside them walk `assets/` from disk. A third storefront
  script would have been scanned for `data-cx-*` and skipped by every rule
  that actually prevents the element adoption. The list is read from `assets/`
  now, with a non-vacuity assertion that it still finds the two known scripts.
  The "must hoist an `OWN_*` selector" rule is keyed on whether the script
  makes a document-level query at all, so a query-free helper is not failed
  for having no selectors to hoist.
- **Liquid §1–§2 now treat the legacy `{% include %}` as a render.** Both rules
  were stated absolutely — "never capture a render", "no render in
  `snippets/`" — but keyed on the word `render`, leaving the identical defect
  reachable by the older spelling, which is the worse of the two: `include`
  does not isolate scope, so the snippet could read and clobber the caller's
  variables. Both spellings are covered, in both tag forms, and the blocks'
  single render is additionally pinned to `render`.
- Liquid rules §1–§2 now read tags through a scanner that understands **both**
  forms Shopify accepts — `{% render 'x' %}` and the bare line form inside a
  `{% liquid %}` block. A captured render written in the line form was
  invisible to every `{%\s*render` pattern, i.e. the one rule that exists to
  forbid the v1.2.0 storefront bug could be walked around by writing it
  differently. The block's single render must also be in markup position, not
  inside a `{% liquid %}` block.
- `tests/liquid/render.test.ts` — `data-cellexia-money-sub` must be **empty**
  for a variant with no allocation in the group, in every preset, with a
  vacuity guard for the subscribing case. `buy-box.js` swaps the theme's
  add-to-cart price to that attribute verbatim, so a non-empty value there
  would put a price on the theme's button that the shopper can never be
  charged. The contract was documented in the snippet; it is now executable.
- `tests/widget-design.test.ts` — ORDERS_CREATE still attributes the legacy
  `_cx_design` property, in both REST property shapes, and prefers the current
  name when a line carries both.
- `tests/liquid/harness.ts` — the Liquid ⇄ JS DOM-contract extractor now also
  reads the JS's hoisted selector constants, so those cannot drift away from
  the markup unnoticed.

### Migration notes

- **`npm run deploy` is required** — `extensions/cellexia-buy-box` changed. No
  database migration, no env change, no re-approved scopes.
- **Nothing to reconfigure.** The rename is internal to the extension: block
  settings, the published `cellexia.buybox_design` metafield, the launch gate
  and the preview-token flow are all unchanged, and a shop with no published
  design still renders pixel-identically.
- Any custom CSS written against the widget keeps working: only attributes were
  renamed, never class names. Custom CSS that targets `[data-cx-…]` attributes
  (nothing we ever documented) must be updated to `[data-cellexia-…]`.
- Design attribution is continuous across the upgrade — the webhook accepts the
  old property name as well.

## [1.2.2] — 2026-07-25

> Historical note: the widget's storefront attributes are written here under
> their **current** `data-cellexia-*` names. They shipped in this release as
> `data-cx-*` and were renamed in 1.2.3, when that prefix turned out to
> collide with another app on the client's store. Nothing else about this
> entry changed.

Theme-extension release. **Buy box only**: no database migration, no env
change, nothing in the portal, billing, dunning or Klaviyo paths moved. The
v1.2.0 Liquid rendering defects (app-snippet corruption, double-escaping) are
fixed and locked down by a real Liquid render harness, together with the
remaining rendering defects the golden renders did not cover — plus one new
storefront feature: the theme's own Add to cart button now quotes the price
the shopper actually selected.

### Fixed

- **`--cx-accent-soft` was declared twice in the widget root's inline style.**
  The accent at 7% alpha went into a fixed slot and `style.bgTint` was appended
  after it, so every shop with a published design shipped both declarations in
  one `style` attribute (`DEFAULT_DESIGN_CONFIG.style.bgTint` is `#F4F4F4`, so
  publishing *anything* triggered it). Last-declaration-wins made it render
  correctly, but the subscription card's fill depended on a theme, CDN or
  minifier preserving the order and both copies of an inline declaration. The
  soft fill now resolves to one value before it is printed — `style.bgTint`
  when the merchant set one, otherwise the accent at 7% alpha, the same rule
  the admin designer's live preview uses.
- **The soft fill was not escaped.** `color_modify` returns its input unchanged
  when the value is not a colour, so a hand-edited `cellexia.buybox_design`
  metafield could break out of the `style` attribute through
  `--cx-accent-soft`, even though `--cx-accent` right next to it was escaped.
  Both slots are escaped now. (The zod schema still rejects such a value on
  publish; this is the belt the file's own comment promised for a metafield
  edited by hand.)
- **An allocation stating no `per_delivery_price` produced a made-up price.**
  Where the price is printed unconditionally (the tiles compare row, the
  planner row) the widget rendered the money filter's rendering of nil next to
  real prices; the "X per delivery" line claimed a per-delivery price the
  platform never gave. The rows now fall back to the charge price — the same
  fallback `buy-box.js` applies on every later variant/plan change — and the
  line renders only for a stated per-delivery price that differs from the
  charge, i.e. genuinely prepaid plans. A free product (`per_delivery_price`
  0) is unaffected: 0 is a real value, not a missing one.
- **A variant with no allocation in the selling-plan group showed a
  subscription until the JS ran.** For a product only partly added to the
  group, the first paint offered a subscription card priced at the one-time
  price for a variant that cannot subscribe; `buy-box.js` corrected it on
  init. The root now carries `cx-buybox--no-sub` from the server — the class
  the stylesheet already hides every subscription-only fragment with, and the
  one the JS toggles — so the first paint is honest.

### Added

- **Theme add-to-cart price sync.** Observed live on cellexialabs.com: with
  the subscription option preselected (CHF 51.20 first order) the theme's own
  button still read "ADD TO CART - CHF 64.00" — the shopper saw one price in
  the widget and another on the button they were about to click, on the last
  click before the cart. The widget root now carries `data-cellexia-money-onetime`
  and `data-cellexia-money-sub` (the current variant's one-time price and the
  selected plan's first-order price, formatted by Liquid with the shop's own
  `money_format`), and `buy-box.js` swaps the one-time money **string** for
  the subscription one inside the theme button's **text nodes** while
  subscription is selected. It is a string swap, not a price re-render, and
  that is what makes it safe: never `innerHTML`; **nothing happens at all** if
  the button does not literally contain the one-time string (no currency
  regex, no guessing); targets are only looked for inside the widget's own
  product area, with header / nav / footer / cart-drawer regions excluded;
  every change is recorded and restored the moment one-time is selected or the
  widget is hidden, launch-gated or unmounted; a `MutationObserver` re-applies
  when the theme rewrites the label (Sleepify does, on every variant change)
  while our own writes happen with the observers disconnected; a write budget
  switches the module off and gives the button back if a theme fights it; and
  every entry point is wrapped in try/catch — it never touches the form, the
  submit path or the cart payload, so it can never block an add-to-cart. Later
  variant/frequency changes re-sync from the JSON island's existing `oneTime`
  / `first` values, so the JS still never formats money. Works identically in
  a validated storefront preview.
- **Buy box designer → Theme integration** — the new `themeSync` config
  object: "Match the theme's Add to cart price to the selected option"
  (`syncAddToCartPrice`, default **on**, including for shops with no published
  design) plus an optional CSS selector (`priceSelector`, e.g.
  `.pdp__actions .btn--atc`) for themes the built-in list does not cover.
  Field-level defaults, so every stored revision and the live
  `cellexia.buybox_design` metafield keep validating unchanged; the selector is
  sanitized with the same rule as `placement.selector`. Documented in
  [docs/OPERATIONS.md](docs/OPERATIONS.md) §17 and the extension README.
- `tests/theme-price-sync.test.ts` — the price-sync behaviour, driving the real
  `assets/buy-box.js` through a small DOM shim: the swap, the revert on
  one-time/hidden, "no price in the button → byte-identical", the header and
  cart-drawer exclusions, following a theme that rewrites the label (and
  reverting to its *newest* text), and the runaway guard.
- `tests/liquid/theme-sync.test.ts` — the Liquid half: both money strings on
  the root across all six presets and both install shapes, differing exactly
  when there is a discount, empty for a variant with no allocation, agreeing
  with the JSON island, surviving entity-bearing and quote-bearing
  `money_format`s, and a v1.1.0-shaped config (no `themeSync` key) still
  rendering the sync on.
- `tests/liquid/render.test.ts` — the widget root's inline style attribute
  (every custom property declared exactly once, across all six presets and
  four config shapes; the soft-fill resolution rule; both slots escaped
  against a hand-edited metafield; the designer preview kept in step),
  allocations that state no per-delivery price, and variants with no
  allocation in the group.
- `tests/liquid/harness.ts` — fixture options `omitPerDeliveryPrice` and
  `selectedVariantHasNoAllocations` for those catalog shapes.

### Migration notes

- **`npm run deploy` is required** — `extensions/cellexia-buy-box` changed.
  No database migration, no env change, no re-approved scopes.
- Shops with a published design get the `bgTint` they configured, which is the
  colour they already saw.
- The widget's own rendering is unchanged for zero-config shops; the only
  addition to their markup is the four inert `data-cellexia-money-*` /
  `data-cellexia-price-*` attributes on the root (the golden snapshot was updated
  for exactly those four).
- **The add-to-cart price sync is ON by default, including for shops that
  never published a design.** It changes the theme's button *text* only, only
  while the subscription option is selected, and only when that button already
  shows the one-time price — nothing else about the page, the form or the cart
  moves. To ship without it: Buy box designer → Theme integration → untick
  "Match the theme's Add to cart price to the selected option" → Publish.

## [1.2.1] — 2026-07-25

Build/deploy hotfix. **No runtime behavior change**: no schema migration, no
env change, no theme-extension change, nothing about the widget, the portal or
the billing paths moved. v1.2.0 could not be built or containerized; this
release fixes exactly that.

### Fixed

- **`npm run build` failed on Node 23.x** with
  `[vite:css-post] css content for "" was not found`. `app/routes/app.tsx`
  loaded the Polaris stylesheet as `…/styles.css?url`; Vite encodes a `?url`
  CSS id into a `__VITE_CSS_URL__<hex>__` marker and hex-decodes it back
  during `renderChunk`, and on Node 23.2.x `Buffer.from(s, "hex")` returns an
  **empty** buffer when `s` is a two-byte (non-Latin1) string — which the
  admin chunk is, because it contains non-ASCII characters. The stylesheet is
  now a plain side-effect import of the same file, which Remix's Vite plugin
  lists in the route manifest and
  `<Links />` renders: the same single `<link>` on `/app/*`, no `?url` code
  path. Node 20/22 LTS were never affected; the fix removes the dependency on
  the Node version either way.
- **The Docker image could not build.** `Dockerfile` ran `npm ci --omit=dev`
  and then `npm run build`, but the build chain (`@remix-run/dev`, which
  provides the `remix` binary, plus `vite` and `vite-tsconfig-paths`) lives in
  `devDependencies` — the build step died with `sh: remix: not found`. The
  install is now `npm ci --include=dev` (mandatory: `ENV NODE_ENV=production`
  makes npm omit dev packages by default) and the build-only packages are
  pruned again with `npm prune --omit=dev` after the build, so the shipped
  image keeps the same runtime footprint. The inherited
  `RUN npm remove @shopify/cli` line is gone: this project never depended on
  `@shopify/cli`, and under `NODE_ENV=production` that no-op re-reified the
  tree with `--omit=dev` and silently deleted the build chain again.
- **Added the missing `.dockerignore`.** The Dockerfile's `COPY . .` runs after
  `npm ci`, so on any machine where the app had been installed locally the
  host's `node_modules` was copied over the image's — and native binaries are
  platform-specific, so `npx prisma generate` and `npm run build` then failed
  inside the linux image with `invalid ELF header` / a missing
  `@esbuild/linux-*` package. The build context is now source-only, which also
  keeps `.env` and the local `build/` out of the image layers.
- **Removed the vestigial `workspaces: ["extensions/*"]`** from
  `package.json`. `extensions/cellexia-buy-box` is a theme app extension with
  no npm manifest, so the glob matched a directory npm cannot treat as a
  workspace. npm 10 tolerates it (and did here), but nothing depended on it.

### Added

- `tests/deploy-config.test.ts` — static guards for the deploy path the test
  suite could not see: no `?url`/`?inline`/`?raw` CSS imports under `app/`,
  the Dockerfile installs the devDependency build chain before
  `npm run build`, nothing re-reifies the dependency tree between install and
  build, `prisma generate` precedes the build, `.dockerignore` keeps
  `node_modules`/`build`/`.env` out of the build context, and the runtime
  packages stay in `dependencies` so the post-build prune cannot break
  `npm run start`.

### Migration notes

- **No database migration, no env change, no `npm run deploy` needed** — the
  theme extension is byte-identical to v1.2.0.
- Re-deploy the app (Fly/Railway/Render rebuild the image from the new
  `Dockerfile`). If you build outside Docker, run `npm ci` once so the
  refreshed `package-lock.json` is in effect.

## [1.2.0] — 2026-07-24

### Added

- **App-embed install path for the buy box**: the widget now also ships as a
  theme **app embed** (`blocks/buy-box-embed.liquid`, target `body`) enabled
  with a single toggle — Theme editor → **Theme settings** → **App embeds** →
  **"Cellexia Buy Box"** → Save. Built for themes whose product section does
  not accept app blocks (the reason: cellexialabs.com's custom "Sleepify"
  theme), it renders the identical widget (`snippets/cx-buybox-core.liquid`
  is shared with the app block) and mounts itself into the product page
  automatically. If the section app block is also present on a page, the
  block wins and the embed stays dormant — never two widgets. The launch
  gate is unchanged: even with the embed enabled, visitors see nothing until
  go-live, and the `?cx_preview` token flow reveals it exactly as before.
- **Automatic placement with custom-selector override**
  (`assets/buy-box-embed.js`): the embed inserts the widget above the theme's
  quantity/add-to-cart area via prioritized anchor heuristics (tuned first
  for cellexialabs.com — before `.pdp__grey` — with generic OS 2.0 and
  `/cart/add`-form fallbacks). Override precedence: the embed's theme-editor
  **Custom anchor selector** setting > the designer's new **Placement**
  section (`placement` in the design config: CSS selector +
  before/after/prepend/append) > automatic. In a preview session, an
  unmatched anchor shows an admin-only hint card instead of failing silently.
- **Cart-request selling-plan injection for formless AJAX themes**: on pages
  where the embed runs, `fetch`/`XMLHttpRequest` POSTs to `/cart/add(.js)`
  get the selected `selling_plan` (and the `_cellexia_design` attribution property)
  injected into any body shape — FormData, URLSearchParams, urlencoded
  string, JSON `items[]`, flat JSON. Only lines matching the widget's own
  product variants are touched; one-time selections, other vendors' cart
  calls and unknown body shapes pass through byte-identical.
- **Brand-matched defaults**: the designer's starting style tokens
  (`DEFAULT_DESIGN_CONFIG`) are now matched to cellexialabs.com — near-black
  `#1D1D1B` accents, `#F4F4F4` panel tint, white on accent, sharp 0px
  corners — so publishing an untouched design already looks native there.
  (The zero-config fallback is unchanged: with no published metafield the
  widget still renders the v1.0.0 look.)
- **Frequency-selector toggle** (`layout.showFrequency`, designer → Layout):
  turning it off removes the delivery-frequency selector from **all six
  presets** (the planner degrades to a single recommended-cadence line);
  add-to-carts then use each plan's default frequency, and subscribers can
  still change frequency any time in the portal.

### Migration notes

- **No database schema migration** — v1.2.0 ships no new Prisma migration.
- **No breaking changes**: existing design revisions and the published
  metafield JSON parse unchanged (the new `placement` and
  `layout.showFrequency` fields carry field-level defaults). The section app
  block keeps working exactly as installed.
- The theme extension changed (new embed block + `buy-box-embed.js`) — run
  `npm run deploy`. To use the embed path, enable it once in the theme
  editor (Theme settings → App embeds → "Cellexia Buy Box" → Save); this is
  safe on the live theme at any time (Setup mode keeps the widget hidden).

## [1.1.0] — 2026-07-23

### Added

- **Buy box design studio**: new admin **Buy box designer** page for the PDP
  widget. Six design presets — `classic` (the v1.0.0 layout), `toggle`
  (segmented tabs), `tiles` (side-by-side comparison), `inline` (one-line
  checkbox upgrade), `value_stack` (benefit-list panel), `planner`
  (frequency-first chips) — each a distinct CRO archetype, with deep
  customization of the selected preset: layout (option ordering, density,
  radius/border, frequency dropdown vs chips, show/hide toggles), style
  (colors, font scale, sanitized widget-scoped custom CSS) and **per-locale
  text overrides** with `{percent}`/`{amount}`/`{frequency}` templates
  (resolution: current locale → `en` → the extension locale files). Changes
  are previewable before publishing; publishing mirrors the config to the
  shop metafield `cellexia.buybox_design`, which the theme block reads
  null-safely — changing or reverting a design never touches the theme.
- **Revision history with restore**: every save is an append-only
  `WidgetDesignRevision`; restore copies an old revision into a new one and
  publishes it, so every design change is reversible in one click. Publishes
  and restores are logged as `admin.action` audit events.
- **Design attribution analytics**: subscription add-to-carts are stamped
  with a hidden `_cellexia_design` line property (underscore-prefixed — hidden from
  customers in themes and checkout); the ORDERS_CREATE webhook logs
  `widget.design_attributed` events (payload `{designKey, orderId}`) and the
  designer's performance card reports subscription orders and take-rate
  share per design. New canonical event type: `widget.design_attributed`.
- Theme-editor emergency override: new `design_source` block setting
  (default **App design**) can force a preset from the theme editor if the
  app is unreachable.

### Migration notes

- **No breaking changes; with no design published the widget renders
  identically to v1.0.0.** The zero-config fallback, all existing block
  settings and the selling-plan wiring are unchanged.
- Additive migration `0002` (new `WidgetDesignRevision` table):
  `npx prisma migrate deploy`.
- The theme extension changed (new snippets/assets and the `design_source`
  block setting) — run `npm run deploy`. Existing block placement keeps
  working as-is; no theme-editor action is required.

## [1.0.0] — 2026-07-23

Initial release.

### Added

- **Launch safety & preview**: the app installs **dark** — Setup mode until the
  admin explicitly goes live. While in Setup: customer-facing jobs skip
  themselves (logged `skipped: setup_mode`), customer notifications are
  suppressed at source (only OTP codes, operator alerts and import summaries
  send), no Klaviyo events are enqueued, the public portal is closed behind a
  friendly page, and the buy box renders hidden via the
  `cellexia.launch_status` shop metafield. Admin **Preview & launch** page:
  signed storefront preview links (`?cx_preview`, 7-day TTL) reveal the buy
  box on the live theme only in the admin's own browser — PDP, cart and
  checkout previewable with zero visitor impact; portal preview sessions
  render the full customer portal (real subscriber or local-only demo
  subscription) with every mutating action intercepted. **Go live** flips the
  setting + metafield, logs the flip, and offers to stagger overdue renewals
  over 3 days so launch never triggers a burst of charges; revert-to-setup is
  the emergency kill switch.
- **Selling plans**: plan-group config + sync (first-order/ongoing discounts via
  pricing policies, optional first-order gift, prepaid modelling), per-product
  cadence intelligence (real empty dates), theme app extension buy box
  (preselect, badge, savings formats).
- **Billing**: timezone-safe renewal scheduler with `JobLock` leases, crash-proof
  idempotent billing attempts, prepaid handling, stale-attempt sweep; internal
  60s tick or external-cron mode (`POST /api/jobs/run`).
- **Dunning**: decline taxonomy (SOFT/HARD/AUTH_REQUIRED), payday-aligned retry
  ladder, backup payment fallback, 3DS challenge magic links, card pre-expiry
  notices, recovery/exhaustion handling (default exhausted action: pause).
- **Customer portal** on the store domain (app proxy): OTP login, skip/unskip,
  delay, frequency change, swap, quantity, add/remove lines, one-time add-ons,
  pause/resume with auto-resume, address & card updates, contextual prompts.
- **Magic links**: signed, hashed-at-rest, single-use action tokens (skip,
  delay, add-to-next, update card, resume, pause, swap, 3DS confirm, login).
- **Cancel-save flow**: reason survey, reason-matched saves, capped final offer
  with cooldown, full `CancelSession` recording, 90-day retention tracking;
  FTC click-to-cancel compliant (≤3 steps).
- **Gifts & lifecycle**: gift rules by order index / days subscribed / save flow
  / win-back; surprise cycle-2 gift, announced milestone (cycle 6), rewards
  unlock (day 90), anniversary (day 365); gift COGS in profit math.
- **Win-back**: staged touches (soft → perk → capped discount → sunset) timed to
  predicted empty date.
- **Klaviyo**: outbox-backed event delivery with retries, profile sync, event
  mapping; SMTP fallback + notification log.
- **Analytics**: daily rollups, cohort survival + cumulative LTGP, churn risk
  scores, predicted empty dates, take rate, dunning recovery.
- **Admin (Polaris)**: dashboard, analytics, subscribers + timelines, dunning,
  alerts, audit, bulk ops (stockout actions, price change batches with notice),
  plans, gifts, cancel-flow config, settings registry, import.
- **Webhooks**: full topic coverage with `X-Shopify-Webhook-Id` dedupe and
  failure visibility; GDPR topics handled.
- **Import**: CSV importer (`subscriptionContractAtomicCreate`) with dry-run,
  batch tracking and re-run safety; sample file + platform mappings
  ([docs/MIGRATION.md](docs/MIGRATION.md)).
- **Ops**: `/api/health`, alerting with operator emails, i18n framework
  (English master catalog), Dockerfile, complete documentation set.

### Migration notes

- Fresh install only — see [docs/INSTALL.md](docs/INSTALL.md). Subscriber
  migration from Recharge/Skio/Appstle/Bold: [docs/MIGRATION.md](docs/MIGRATION.md).
