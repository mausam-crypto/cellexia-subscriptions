# Cellexia Subscriptions — Architecture

A private (single-merchant) Shopify subscription engine. Shopify remains the
source of truth for contracts, payments and orders; this app owns everything
Shopify doesn't: scheduling, dunning, gifts, magic links, portal UX, cancel-save
flows, win-back, analytics.

## Stack

- **Remix (Vite) + TypeScript** — Shopify's official app template shape
- **Prisma + PostgreSQL** — mirror + extension data model (`prisma/schema.prisma`)
- **Polaris + App Bridge** — embedded admin UI at `/app/*`
- **Theme app extension** — PDP buy box (`extensions/cellexia-buy-box`)
- **App proxy** — customer portal served on the store domain at `/apps/cellexia-subs/*` → app routes `/proxy/*`
- **Klaviyo** — all lifecycle/transactional flows are driven by server-side events (outbox pattern)
- **Jobs** — DB-leased locks (`JobLock`), 60s internal tick or external cron hitting `POST /api/jobs/run`

## Golden rules (apply everywhere)

1. **Money** is integer cents + ISO `currencyCode`. Convert at API boundaries only (`app/lib/money.ts`).
2. **Shopify IDs** are stored as full GIDs.
3. **Never discount codes on renewals.** All recurring pricing comes from selling-plan pricing policies and `DiscountGrant` rows applied via billing-cycle contract edits.
4. **Idempotency**: every billing attempt carries `idempotencyKey = "{contractId}:{cycleIndex}:{attemptNumber}"`, unique in DB *and* passed to `subscriptionBillingAttemptCreate`. Double charges are impossible even if the process crashes mid-run.
5. **Timezone-safe**: all schedule math goes through `app/lib/dates.server.ts` with the shop's IANA timezone.
6. **Every mutation logs an event** via `logEvent()` (`app/lib/events/log.server.ts`) with a type from the canonical vocabulary below. The event log is the timeline, the audit trail, and the Klaviyo feed.
7. **Settings, not accidents**: any behavior choice reads `getSetting(shopId, key)` (`app/lib/settings/settings.server.ts`). Never hardcode a policy. The v1.5.0 audit finished the sweep — cancel-flow, win-back and portal behavior constants (`cancelFlow.maxSavesShown`…, `winback.reactivationBillDelayDays`…, `portal.mutationsPerHour`…) are settings with defaults equal to the old constants. A policy constant found in code is a bug, not a style choice. (Three keys — `riskModel`, `forecastModelHistory`, `selfCheck` — are machine-written state, deliberately absent from the Settings UI.) Two keys — `mailTransport`, `klaviyo` — hold credentials: their secret fields are stored encrypted (`app/lib/crypto/secrets.server.ts`), are write-only on the Settings page (never echoed to the browser), and are redacted to markers in `settings_updated` audit events; empty values mean "fall back to the matching env var".
8. **Webhook truth**: state changes observed via webhooks always win over local assumptions; handlers are idempotent (`WebhookReceipt` dedupe on `X-Shopify-Webhook-Id`).
9. **Failures are contained**: analytics/Klaviyo/notification failures must never break billing or portal actions. Wrap and log.
10. **i18n**: user-facing strings go through `t(locale, key, vars)` (`app/lib/i18n/i18n.server.ts`), keys namespaced `portal.*`, `magic.*`, `email.*`, `sms.*`, `cancel.*`, `common.*`, `freq.*`. `en.json` is master.
11. **Frequencies are `{unit, count}` pairs** (v1.8.0): a plan cadence is a `Frequency` — `unit ∈ DAY|WEEK|MONTH`, mixable inside one selling plan group — and ALL frequency logic lives in `app/lib/frequency.ts` (isomorphic). Read config cadences via `parseConfigFrequencies`/`parseConfigDefaultFrequency` (multi-unit columns first, legacy week columns as fallback), read a contract's cadence via `contractFrequency()` (exact `billingIntervalUnit/Count` mirror, `intervalWeeks` fallback), advance dates via `addIntervalTz()`, display via `frequencyLabelEn` (admin) or `formatFrequency` + the `freq.*` key family (customers). `intervalWeeks` and `frequenciesWeeks`/`defaultFrequencyWeeks` remain written as `approxWeeks()` approximations wherever the exact values are written (rollback safety + week-keyed consumers); money math never uses the approximation. **The WEEK plan option value "Every N weeks" is byte-frozen** (always plural, even count 1): it is the selling-plan reconcile key, and changing it recreates every live week plan under new GIDs — `planOptionValue()` owns this and `tests/frequency.test.ts` pins it. **Per-variant defaults (v1.14.0)**: `SellingPlanConfig.variantDefaultFrequencies` maps variant GIDs to explicit `{unit, count}` overrides of the plan's `defaultFrequency` (parse via `parseConfigVariantDefaults`, always with the offered list so retired cadences drop). The storefront projection is the shop metafield `cellexia.variant_defaults` (`{v:1, default:{unit,count}, byVariant:{"<numeric variant id>":{unit,count}}}`, SYNCED configs only — allow-list parity), built in `app/lib/widget/variant-defaults.server.ts` and published as a CONTAINED rides-along of every `publishOwnGroupsMetafield()` call — presentation only, never an ownership factor; its outcome is surfaced as `PublishResult.variantDefaults` (sync/delete audit events, sync toast, go-live audit). The buy box preselects the matching plan per variant (`default` folded in for un-overridden variants — the revert target, which also makes the plan's defaultFrequency effective on the storefront; prepaid plans excluded) and `buy-box.js` adopts it on variant switches unless the shopper explicitly chose a cadence.
12. **Ownership**: the store runs a second subscription app, and its contracts arrive on our webhooks. Anything that bills, messages, edits, counts or exposes a contract filters on `OURS_ONLY` / `isBillableOwnership()` (`app/lib/ownership/ownership.server.ts`); the buy box renders our selling plan group or nothing. `UNKNOWN` means "not proven ours" and is treated exactly like another app's. See [Ownership](#ownership--two-subscription-apps-on-one-store).

## Module map

| Module | Path | Responsibility |
|---|---|---|
| GraphQL layer | `app/lib/graphql/` | All Admin API calls: selling plans, contracts, drafts, billing cycles/attempts, payment methods, products, orders, customers, markets (`markets.server.ts`, read-only — powers the designer's per-market card). Throws `ShopifyUserError` on userErrors. |
| Contract services | `app/lib/contracts/` | Skip/unskip, delay, frequency, swap, quantity, add/remove line, one-time add-on, pause/resume, cancel, address, next-date, price propagation vs grandfather, consolidation (merge), stockout evaluation, sync-from-webhook. |
| Plan lock window | `app/lib/contracts/lock.server.ts` | Per-plan `SellingPlanConfig.lockDays` (v1.13.0): blocks every CUSTOMER-initiated schedule reduction — skip, delay, frequency, next-date, pause, swap, recurring-line removal, quantity decrease, cancel — for the first N days after subscribing. Terms as subscribed under: the sync CREATE path stamps the covering plan's lockDays onto `SubscriptionContract.lockDays` once at mirror birth; the effective window is min(stamp, current setting) — raising never retro-locks, lowering/disabling releases immediately, null stamp (pre-feature/import/backfill) is permanently exempt. Resolution = line `sellingPlanId` membership in a config's append-only `shopifyPlanIds` (both id forms; NO product fallback); anchor = earliest of `firstChargeAt`/`createdAt`, window ends at shop-tz MIDNIGHT of the displayed unlock date (`addDaysTz`/`shopDayStartUtc` — golden rule 5). Enforced in the portal dispatcher, the cancel-flow choke point (`requireCancelContext`) + `completeCancel` backstop, magic-link GET describe + POST execution, and SMS keywords; additions/recoveries (add, addon, quantity increase, unskip, resume, reactivate, address, payment) and ADMIN/SYSTEM/DUNNING paths are never blocked. The guard lives in customer-facing surfaces — never in the contracts service. |
| Billing | `app/lib/billing/` | Scheduler (due contracts → pre-charge pipeline → attempt), prepaid handling, stale-attempt sweep. |
| Jobs | `app/lib/jobs/` | Registry + runner with `JobLock` leases and `JobRun` logs; `POST /api/jobs/run` for external cron. |
| Dunning | `app/lib/dunning/` | Decline-code taxonomy, retry ladder (payday-aligned), backup payment fallback, 3DS challenge links, pre-expiry notices, recovery, exhaustion. |
| Webhooks | `app/routes/webhooks.tsx` + `app/lib/webhooks/` | Consume all topics; dedupe; dispatch to services. |
| Portal | `app/routes/proxy.*` + `app/lib/portal/` | OTP login (anti-enumeration constant-time responses), sessions (signed HttpOnly cookie only; magic-link login lands via a single-use hand-off code — the token never rides a URL), subscription management UI (served through app proxy), contextual prompts, RTL-aware layout. |
| Magic links | `app/routes/magic.$token.tsx` + `app/lib/magiclinks/` | Token verbs with zero login; URL builders (`builder.server.ts`, already implemented). |
| Cancel flow | `app/lib/cancel/` + portal routes | Reason survey → reason-matched saves → opt-in final offer (server-side gating + cooldowns); `CancelSession` recording; hourly `cancel_session_gc` closes walked-away sessions (`cancel.aborted`). |
| Gifts & lifecycle | `app/lib/gifts/`, `app/lib/lifecycle/` | Gift rules/grants auto add/remove; milestones; rewards unlock; early-cycle incentives. |
| Win-back | `app/lib/winback/` | Staged win-back timed to predicted empty date. |
| Klaviyo | `app/lib/klaviyo/` | Outbox flush (with a 24h age-out — stale moments go DEAD, never fire late), event mapping (`events-map.server.ts` — replace the placeholder), profile sync. |
| Notifications | `app/lib/notifications/` | Channel router (Klaviyo event; without a Klaviyo key — `klaviyo` setting or `KLAVIYO_PRIVATE_API_KEY` env fallback — lifecycle email falls back to direct SMTP and SMS is SUPPRESSED — never logged SENT undelivered), templates, `NotificationLog`. Since v1.16.0 the admin **Emails** tab (`app/routes/app.emails.tsx` + `catalog.server.ts`) owns per-template customization: the `emails` setting holds enable/disable (SUPPRESSED reason `template_disabled`; critical templates bypass) and merchant subject/body overrides, which `renderEmail` applies in BOTH delivery shapes — the ready-rendered `content_subject`/`content_html`/`content_text` Klaviyo event properties (flows render `{{ event.content_html }}`) and the direct-SMTP fallback. Rendered content and link URLs are never persisted in `NotificationLog`. **v1.17.0 — the email studio**: body copy renders through a markdown-lite formatter (`format.ts`, isomorphic — escape-before-structure, http/https/mailto href allow-list, `{cta}` semantics preserved) inside a brand-kit shell (`emailDesign` setting, Emails → Design tab; defaults = the historical shell). Each template row also carries `sender` — `auto` (pre-1.17.0 behavior exactly), `app` (direct SMTP, delivery metric deliberately NOT enqueued so a flow cannot double-send), `klaviyo` (event only; keyless = SUPPRESSED `klaviyo_unconfigured`, never silently rerouted); SMS ignores `app`, critical templates keep their unconditional SMTP copy. The state-change confirmations (skip/delay/pause/cancel/…) default to their Klaviyo flows but become app-sent via the **confirmation bridge** (`confirmations.server.ts`, invoked by `logEvent()` beside the Klaviyo enqueue, contained, 10-min per-contract+template dedupe) when their sender is `app`. Per-template editor pages (`app.emails.$template.tsx`) provide live preview (the REAL `renderEmail` on `preview.server.ts` sample data — every template must render placeholder-free, pinned by tests; all sample links point at example.com) and a test send that never writes `NotificationLog`. The SMTP transport itself resolves settings-first (`mailTransport` setting, admin Settings → Email delivery; env vars as fallback; password encrypted via `app/lib/crypto/secrets.server.ts`), with the transport cache keyed by the resolved config so admin saves apply without a restart. |
| Analytics | `app/lib/analytics/` | Daily rollups, cohort LTGP (origin payment + renewals), the shared cost model (COGS/shipping/fees/VAT — `costs.server.ts`), censoring-corrected survival curves, churn risk with a self-training learned model (`learning.server.ts` — shadow-until-provably-better), predicted empty dates, five-model self-measuring forecasting with accuracy grades, take rate, alert scans, plain-language insights (`insights.server.ts`, imported directly — not via the barrel), and the segment layer (`segments.server.ts` + `segment-views.server.ts` — live filtered views by country/language/source/product/discount/device/value; the isomorphic vocabulary lives in `segments-shared.ts` for route components). See [Analytics](#analytics). |
| Acquisition capture | `app/lib/acquisition/` + webhook/sync handlers | Sanitized origin-order acquisition signals (`acq*` columns: source, UTM, geo, device, first-order shape) captured once per OURS contract; pure sanitizer (`sanitize.ts`) — never a raw IP or full user-agent; erased on GDPR redact. Contract: [docs/DATA_FOUNDATION.md](DATA_FOUNDATION.md). |
| Admin UI | `app/routes/app.*` | Polaris pages: dashboard, analytics, subscribers, dunning, emails (catalog + sender model + brand kit + per-template editor with live preview/test send + sent log, v1.17.0), alerts, audit, debug (live self-checks), bulk ops, plans, gifts, cancel-flow config, settings, import. |
| Buy box | `extensions/cellexia-buy-box/` | Theme app extension for the PDP, in two install shapes over one shared core snippet: a `section`-target app block, and (v1.2.0) a `body`-target **app embed** that self-mounts and patches JS cart requests for themes whose product section takes no app blocks. |
| Widget design | `app/lib/widget/` | Buy-box design system: preset catalog + zod config schema + customCss sanitizer + text resolution (`presets.ts`, isomorphic — the admin designer imports it client-side), revision store / publish-to-metafield / restore (`design.server.ts`). Edited from the admin **Buy box designer** page. |
| Launch & preview | `app/lib/launch/` | Install-dark launch mode (SETUP/LIVE), storefront PREVIEW tokens, go-live with ownership re-classification + overdue stagger; the gates live in jobs/notifications/Klaviyo/portal/buy box (see below). |
| Debug / self-check | `app/lib/debug/` | Live self-check engine behind the admin **Debug** page: 28 read-only checks against the deployed store (billing pipeline, dunning, portal-through-proxy, webhooks, jobs, notifications, config, data integrity), each contained doctor-style with detail + named fix. Runs every 30 min (`selfcheck_run`, ungated), persists to the machine-written `selfCheck` setting, keeps the deduped CRITICAL `SELF_CHECK_FAILED` alert in sync (raised while broken, auto-resolved on recovery). |
| Ownership | `app/lib/ownership/` | Which contracts and selling plan groups are **ours** on a store that runs a second subscription app: contract classification (`OURS`/`FOREIGN`/`UNKNOWN`), the `OURS_ONLY` filter every gating query spreads, the storefront allow-list metafield `cellexia.plan_groups`, claiming and re-classification. |
| i18n | `app/lib/i18n/` | Framework (done) + locale catalogs. |
| Scripts | `scripts/` | Import (atomicCreate), seed, healthcheck. |

## Shared seams (stable signatures — do not rename)

- `logEvent(input: LogEventInput): Promise<void>` — `~/lib/events/log.server`
- `getSetting(shopId, key)` / `setSetting(shopId, key, value, updatedBy?)` — `~/lib/settings/settings.server`
- `createMagicToken`, `verifyAndConsumeMagicToken`, `verifyMagicTokenSignature` — `~/lib/crypto/tokens.server`
- `buildMagicUrl`, `buildPortalUrl`, `buildActionLinkBundle` — `~/lib/magiclinks/builder.server`
- `adminClientForShop(shopDomain)` — `~/shopify.server`
- `getPrimaryShop()`, `requireShop(domain)` — `~/lib/shop/install.server`
- `t(locale, key, vars?)`, `normalizeLocale` — `~/lib/i18n/i18n.server`
- `runAllDueJobs(now: Date): Promise<void>` — `~/lib/jobs/runner.server` (billing module implements)
- `enqueueKlaviyoForEvent(event: LogEventInput): Promise<void>` — `~/lib/klaviyo/events-map.server`
- Contract services (contracts module implements, everyone calls):
  `skipNextCycle`, `unskipNextCycle`, `delayNextCycle`, `changeFrequency`
  (takes a `Frequency {unit, count}` — or a bare week count, kept for
  week-denominated callers — since v1.8.0),
  `swapLineVariant`, `changeLineQuantity`, `addLine`, `removeLine`,
  `addOneTimeAddon`, `pauseContract`, `resumeContract`, `cancelContract`,
  `updateDeliveryAddress`, `setNextBillingDate`, `applyDiscountGrant`,
  `mergeContracts`, `syncContractFromShopify` — all in `~/lib/contracts/service.server.ts`,
  all take `(shopDomain: string, contractId: string /* local cuid */, ...args)` and
  log events + return the updated local contract.
- Dunning: `onBillingAttemptFailed(attemptId)`, `onBillingAttemptSucceeded(attemptId)`,
  `onBillingAttemptChallenged(attemptId, redirectUrl?)` — `~/lib/dunning/engine.server.ts`
- Gifts: `ensureGiftsForUpcomingCycle(contractId, cycleIndex)` — `~/lib/gifts/engine.server.ts`

## Launch & preview

Installing the app changes **nothing** on the live store. The settings key
`launch` (`{ mode: "SETUP" | "LIVE", wentLiveAt, confirmedThemeBlock,
confirmedKlaviyo, previewedStorefront, previewedPortal }`) defaults to SETUP,
and the shop metafield `cellexia.launch_status` (`single_line_text_field`,
`"setup"` | `"live"`) mirrors the mode for Liquid. `app/lib/launch/launch.server.ts`
owns the state, the metafield sync, the go-live/revert actions and the preview
tokens; the admin **Preview & launch** page (`app/routes/app.preview.tsx`) is
the control room.

Gate points while in SETUP (each module enforces its own gate — when mode
resolution fails, everything assumes SETUP and stays dark):

- **Jobs runner** (`app/lib/jobs/runner.server.ts`): registry entries flagged
  `gatedInSetup` (`billing_run`, `dunning_run`, `reminders_run`,
  `pause_autoresume`, `gifts_run`, `winback_run`, `consolidation_run`,
  `pre_expiry_notices`, `lifecycle_run`) log a SUCCESS `JobRun` with stats
  `{skipped:"setup_mode"}` without touching a contract. Ungated jobs
  (analytics rollups/cohorts/churn risk, `risk_learning_run`,
  `origin_order_backfill`, `cancel_session_gc`, `stale_attempt_sweep`,
  `klaviyo_flush`, `alerts_run`, `selfcheck_run`) keep running — they derive
  state or clean up internal records, and touch no customer.
- **Notifications** (`app/lib/notifications/send.server.ts`): only `otp_code`,
  `admin_alert` and `import_summary` go out; every other template is logged
  `SUPPRESSED` (reason `setup_mode`) instead of sent.
- **Klaviyo** (`app/lib/klaviyo/events-map.server.ts`):
  `enqueueKlaviyoForEvent` suppresses at source — no outbox rows, so flows can
  never fire from setup-mode noise. Demo contracts are always excluded.
- **Portal** (`app/routes/proxy.*` + `setupGatePage` in
  `app/lib/portal/layout.server.ts`): the public portal serves a friendly
  "not yet available" page (200 + noindex) unless the portal session has
  `PortalSession.isPreview`.
- **Buy box** (`extensions/cellexia-buy-box/blocks/buy-box.liquid` and
  `blocks/buy-box-embed.liquid`): unless the `cellexia.launch_status`
  metafield equals `"live"`, the widget renders with
  `hidden data-cellexia-gated="true"` — invisible to every visitor, in both
  install shapes. The comparison is a plain Liquid `==`: **exact**, no trim and
  no case folding, so `" Live "` is a dark store. Anything in the app that
  models this gate must compare the same way — `launchFlagDiverged()` normalised
  the value until v1.2.3 and consequently reported a near-miss flag as in-sync
  while every product page rendered the widget hidden. Both halves are pinned
  (`tests/liquid/render.test.ts`, `tests/launch-sync.test.ts`).

**App embed** (v1.2.0). Besides the `section`-target app block, the widget
ships as a `body`-target app embed (`blocks/buy-box-embed.liquid`, one
theme-editor toggle) for themes whose product section takes no app blocks.
It renders the identical widget (shared `snippets/cx-buybox-core.liquid`)
hidden at body-end; `assets/buy-box-embed.js` then mounts it into the buy
column — anchor precedence: the embed's theme-editor selector setting → the
published config's `placement` (designer → Placement) → automatic heuristics
(tuned for cellexialabs.com: before `.pdp__grey`; then OS 2.0 / `/cart/add`
form fallbacks) — unhiding only the wrapper, never the launch-gated widget
inside, and leaving even the wrapper `[hidden]` while that widget is gated
(an empty full-width wrapper would change the live PDP's layout before
go-live; a validated preview reveal unhides the mounted wrapper with the
widget). The same file wraps `fetch`/XHR once so `/cart/add(.js)` POSTs on
formless AJAX themes get the selected `selling_plan` + `_cellexia_design` injected
(own-variant matches only; anything else passes through byte-identical). If
the section block is present the embed stays dormant, and state is shared
solely via the guarded `window.CellexiaSubs` global.

**Storefront namespace (v1.2.3) — `data-cellexia-*`, class-qualified.** The
widget's DOM hooks are attributes prefixed `data-cellexia-`
(`-embed`, `-buybox`, `-preset`, `-gated`, `-mounted`, `-anchor(-pos)`,
`-tpl`, `-selling-plan`, `-plan-input`, `-design-prop`, `-money-onetime`/
`-sub`, `-price-sync`/`-selector`, `-save`, `-init`, `-preview`, `-data`, …);
CSS class names stay `cx-buybox*`. They were `data-cx-*` until the client's
live PDP turned out to already host an unrelated vendor owning "cx" — a
`<div class="cx cx--self-contained" data-cx-embed>` inside the buy column,
plus `cx-i18n` / `cx-cart-config` / `cx-pdp-config` / `cx-embed-config` script
ids. `buy-box-embed.js` looked its own wrapper up by attribute alone, adopted
THAT element (mutating DOM we do not own), and then believed itself mounted
for ever, so our wrapper never left body-end: an invisible buy box on the one
store that matters. Three layers now, all load-bearing: (1) the
`data-cellexia-*` prefix; (2) every document-level lookup of our own markup is
qualified by our own class too — `.cx-buybox-embed[data-cellexia-embed]`,
`.cx-buybox[data-cellexia-buybox]`, hoisted into `OWN_WRAPPER` / `OWN_WIDGET`
constants in both asset files — while every other lookup is rooted at a node
already proven ours; (3) `classList.contains('cx-buybox-embed')` /
`'cx-buybox'` is asserted before anything is moved, marked or unhidden, and
the code bails out silently otherwise. Element ids were already uid-suffixed
for the same reason. `tests/liquid/lint.test.ts` §5 enforces all of it
statically — no `data-cx-*` and no `_cx_design` in any file the extension
serves to a storefront (`assets/`, `blocks/`, `snippets/`, `locales/` and the
extension TOML; source comments documenting the history are blanked first, and
the maintainer `README.md`, which Shopify never serves, is the one exempted
file — §5b pins both facts so the exemption cannot grow), and no
document-level or `closest()`/`matches()` lookup of `data-cellexia-*` that is
not class-qualified. "Document-level" means every root that reaches the whole
page — `document`, `document.body`, `document.documentElement`,
`document.head` — not just a bare `document.` receiver: matching only the
latter left `document.body.querySelector('[data-cellexia-embed]')`, the
outage's own shape one property access away, invisible to the rule. §5c also
covers `getElementById` / `getElementsBy*`, which take one bare string and
cannot be class-qualified at all: those may not name our `cx-*` namespace
(shared with that vendor's ids), and the single legitimate call —
`'shopify-section-' + sectionId`, the platform's id, used to narrow a search —
is pinned so a new one fails until a human has read it. Comments are blanked by
a scanner, not a regex, so a `//` or `#` inside a string literal cannot hide an
occurrence from the rule; §5d tests the scanner, and every widened receiver,
against exactly that. §1–§2 enforce the refined render invariants (v1.7.0,
when the `cx-preset-*` partials were extracted from the core for the
platform's Liquid size budget — a real `shopify app deploy` later verified
that Shopify's 100KB Liquid limit is enforced on the TOTAL of all `.liquid`
files in the extension, not per file, so the partials are kept for
maintainability while `tests/liquid/size-limits.test.ts` guards the total at
88KB and all shipped Liquid stays minified): (1) capture-around-render is
forbidden forever — the v1.2.x corruption came from capturing a render,
which pulls Shopify's BEGIN/END app-snippet comment markers into a string
that a later escape prints as visible page text; (2) every render sits in
direct-output markup position, where those markers land between elements as
invisible HTML comments — never inside a `{% capture %}` span and never as a
bare line inside a `{% liquid %}` block, which no `{%\s*render` pattern can
see; (3) snippets never return values — all string/value computation stays
in the consumer (`cx-buybox-core` precomputes everything and passes explicit
render arguments; a preset partial only prints), and the snippet set is
pinned to `cx-buybox-core.liquid` plus the eight preset partials so a stray
snippet fails CI. Both spellings of the tag are covered: the legacy
`{% include %}` gets the same BEGIN/END app-snippet wrapping and, unlike
`render`, shares the caller's scope, so a rule keyed on the word "render"
alone would have waved the more dangerous form through. Two suites
reproduce the collision behaviourally: `tests/embed-mount.test.ts` (mount
lifecycle, hand-built tree) and `tests/embed-hostile-neighbour.test.ts`,
which parses the REAL server-rendered embed markup into a copy of the
client's PDP — foreign `.cx.cx--self-contained[data-cx-embed]` first in the
buy column, the `cx-*` config script ids, no `/cart/add` form — runs both
real asset files over it and asserts our wrapper mounts before `.pdp__grey`,
the foreign element is byte-for-byte untouched, every `data-cellexia-*`
attribute in the document is inside our wrapper, and the theme's jQuery XHR
cart add carries `selling_plan` + `_cellexia_design` (and is byte-identical
on one-time). Its vacuity guards put the defect back — the bare pre-rename
lookup, then the same lookup with `isOwnWrapper()` neutered — and assert the
live failure modes, so the layers cannot quietly stop being load-bearing.

The buy box is not the only surface that puts markup and a `<script>` on a
storefront page. **The customer portal is served through the app proxy**, so
`portalPage()` output is injected into the *merchant's theme*: the theme's own
markup and every storefront app — including that `cx` vendor — share the
portal's document too. §5e applies the same rule there. Its script now makes
exactly **one** document-level query, `.cxs-portal[data-cellexia-portal]`
(class **and** attribute), and roots everything else at that node. Before the
1.2.3 sweep it used `document.querySelector('.cx-toast')` and
`document.querySelectorAll('.cx-portal form')` — class-only, unqualified — and
the second one *writes* (it disables submit buttons on submit), so a foreign
`.cx-portal` would have had its forms disabled by us. Identical failure mode to
v1.2.2, in a different directory, which is exactly why the extension-scoped
rules never saw it. §5e also pins the selector↔markup pairing across files: the
confirm forms are rendered by `app/routes/proxy.*.tsx`, so renaming one side
would silently unbind the handler rather than raise anything.

**Portal CSS namespace (`.cxs-*`, v1.12.1).** The third round of the same
lesson arrived in CSS, needing no JS at all: the `cx` vendor's storefront
apps (cellexia-reviews, cellexia-aov-ltv-booster) load their theme-extension
stylesheets on **every** theme page — the theme-wrapped portal included —
and those sheets style their own `.cx-preview-bar`, `.cx-btn`, `.cx-card`,
`.cx-chip`, `.cx-error`, `.cx-hp` and `.cx-muted` components. Their
`.cx-preview-bar` (`inset-block-end:0`, opaque `#0F1111`, `z-index`
2147479999, flex-centered) merged with the portal banner's `top:0` into a
full-viewport black overlay: the admin's portal preview rendered perfectly
and showed nothing but the banner text. Portal DOM classes therefore live in
`.cxs-*` (cancel flow: `.cxc-*`); the bare `.cx-` prefix is banned in portal
markup and §5e enforces the ban with comments blanked. Query parameters
(`cx_pp`, `cx_preview`) and the `cx_portal` cookie are not CSS-reachable and
keep their names. The preview banner also pins a near-max `z-index`
(2147483200): the live theme fixes its own header at `z-index` 99999, which
occluded the banner entirely at the old `z:100`.

**Storefront preview (PREVIEW token).** Magic-token action `PREVIEW`,
signature-verified but **never consumed** (TTL 7 days, generous max-use for
audit only), appended to a storefront URL as `?cx_preview=<token>`. The block
JS validates it via app proxy `GET /apps/cellexia-subs/preview/validate`, stores it
in `sessionStorage` (so PDP → cart keeps the preview on) and reveals the
widget with a "Preview — only you can see this" ribbon — in that browser
session only. Checkout needs no reveal: recurring terms show natively once a
line was added with a selling plan, and only the previewing admin ever does
that while in SETUP.

When validation **fails** (rejected token, proxy 404/5xx, network error) the
widget stays fail-closed but `buy-box.js` raises a diagnostic card gated on
`?cx_preview=` being in the page's own URL — the only gate available, since
there is no validated session to require. That makes the card an
**unauthenticated surface** (anyone can append `?cx_preview=x` to a gated
page), so its copy names no internal paths and no operator commands: it
carries the transport detail (e.g. `HTTP 404`) and routes the admin to the
admin-gated **Preview Doctor**, which names the exact cause and fix behind
authentication. `tests/preview-failure.test.ts` pins the copy and the
no-internal-detail rule.

**Portal preview.** `PortalSession.isPreview` renders the full portal UI with
a persistent "Preview mode" banner; every mutating action is intercepted with
an explanatory toast — nothing executes, no Shopify calls. Preview a real
subscriber, or one-click create a local-only demo contract
(`SubscriptionContract.isDemo = true`, fake IDs `gid://cellexia/demo/...`,
excluded from billing/reminders/analytics/Klaviyo —
`app/lib/portal/demo.server.ts`). Deletion invariant: demo contracts are the
ONLY contracts ever deleted (`resetDemoContract` — a real contract's mirror
row is history and never removed), and `SubscriberEvent.contractId` is
`onDelete: SetNull`, so a demo reset must delete the demo contract's events
along with it — an orphaned `contractId NULL` event has lost its demo
provenance forever, and contract-less surfaces (the audit page/CSV, any
future contract-less counter) have no way to filter it. Three rules (v1.9.0,
`tests/portal-preview-gate.test.ts`) keep a preview click from dead-ending on
the public setup gate: (1) a VALID `?cx_pp=` outranks the `cx_portal` cookie
in `getPortalSession` — an explicit admin-minted token beats a stale
non-preview dev-harness session (cookies never survive the proxy on a live
store, so ordering there is moot); (2) every gate site renders through
`closedPortalPage(request, locale)`, which shows the named "preview link has
expired" page whenever the gated request carries `cx_pp` (a valid token would
have bypassed the gate, so a gated one is by definition dead) — never the
nameless gate; (3) the gate page retries ONCE with a `sessionStorage`-saved
token when its own URL lost the query string (the storefront password page
redirect is the classic shedding hop) — the token is saved only by a page
that rendered a live preview bar, the retry arms only on the gate page (which
customers never see: it renders only while the store is dark), and no loop is
possible because a URL carrying `cx_pp` never retries.

**Go-live** (`goLive()`): re-classifies contract ownership (see below), then
flips the setting + metafield and logs an `admin.action` event. ACTIVE
contracts **we own** with an overdue `nextBillingDate` are detected and can be
shifted, staggered over the next 3 days (shop timezone), so going live never
triggers a burst of charges. `revertToSetup()` is the emergency exit back to
dark.

## Ownership — two subscription apps on one store

The store runs another subscription app (Joy). Shopify gives every
subscription app on a store the **same** `SUBSCRIPTION_CONTRACTS_*` webhooks
and puts every app's selling plan group on the **same** product, so "is this
ours?" is a question with real money behind it: bill a contract we do not own
and a real customer is charged twice; render a group we do not own and the
subscription sold through our widget belongs to the other app.

`app/lib/ownership/ownership.server.ts` is the single place that answers it.
Its pure vocabulary (the `OWNERSHIP_*` constants, `ContractOwnership`,
`OURS_ONLY`, `isBillableOwnership`, `normalizeOwnership`) lives in
`app/lib/ownership/shared.ts` and is re-exported by the server module
verbatim: admin route **components** (ownership filter labels, badges, guard
banners) must import the vocabulary from `shared`, because a component that
references the `.server` module drags server-only code into the client bundle
and fails `remix vite:build`. Server code keeps importing everything from
`ownership.server.ts`; `shared.ts` must never gain a server dependency.

**Contracts.** `SubscriptionContract.ownership` ∈ `OURS` | `FOREIGN` |
`UNKNOWN`, written by `syncContractFromShopify` — the one writer of contract
mirrors — from the selling plan ids on the contract's lines
(`ContractLine.sellingPlanId`) against the plans we synced
(`SellingPlanConfig.shopifyPlanIds`):

- a line carries one of our plan ids → `OURS`
- every line carries a plan and none is ours → `FOREIGN` (positive evidence)
- no plan on any line, or our own plan ids unreadable → keep an explicit prior
  verdict, else `UNKNOWN`

`UNKNOWN` is treated as not ours everywhere it matters, so the indeterminate
case fails safe. An explicit `OURS` is never downgraded to `UNKNOWN`; our own
import paths stamp `OURS` at creation (they create contracts with no selling
plan, so the classifier could only ever call them `UNKNOWN`).

**The rule every consumer follows**: spread `OURS_ONLY` into the `where`, or
call `isBillableOwnership(contract.ownership)` on a row you already loaded.
That covers billing, dunning, reminders, notifications, Klaviyo, analytics,
portal, magic links, bulk ops, inbound SMS and the admin support cockpit —
`tests/ownership-enforcement.test.ts` asserts the guards fire *and* that the
filter is still present in the source of every gating query. The Subscribers
list is the one deliberate exception (the merchant must see and claim
non-ours rows) and is pinned as such.

**Storefront.** `publishOwnGroupsMetafield()` mirrors this app's own App id
and each owned group's LIVE plan set into the shop metafield
`cellexia.plan_groups`
(`{"v":2,"groupIds":[…],"planIds":[…],"planSets":[[…]],"appId":"…"}`,
numeric ids — Liquid's form) on every plan sync, go-live and config delete.
`cx-buybox-core.liquid` renders the group that passes the two ownership
factors and **nothing at all** otherwise — no allow-list, no widget. There
is no name heuristic and no "first group on the product" fallback: a group
renders because it is proven ours, or it does not render.

**Two mandatory factors, both from that metafield (v1.6.9):**

1. **Exact plan-set equality** — the group's live selling plan ids equal one
   `planSets` entry: same members (entry-by-entry exact string equality)
   AND same count. Plan ids are the one id space storefront Liquid and the
   Admin API share (group ids are NOT: Liquid's `selling_plan_group.id` is
   an opaque per-shop identifier, which is why the original group-id
   comparison never matched in production — the v1.6.6 outage). The sets
   are read off Shopify at publish time, never off the append-only DB
   evidence (which keeps dead plan ids for billing safety and would break
   the count). `groupIds` and the any-member `planIds` union still travel
   in the metafield for the Preview Doctor and the pre-v1.6.9 extension,
   but the storefront reads neither; the inert "legacy OR" was removed
   outright.
2. **App-id match** — the group's `selling_plan_group.app_id` equals `appId`.
   The value exists on the group only because this app **stamps** it there:
   `SellingPlanGroupInput.appId` on every group create/update
   (`syncSellingPlanGroupFromConfig`), healed for pre-v1.6.9 groups by
   `stampSellingPlanGroupAppIds()` on every publish, with the outcome
   surfaced on `PublishResult.heal` (never a silent failure). Shopify
   leaves `app_id` nil otherwise, and app ids — unlike group ids — read
   identically from the Admin API and from Liquid. HONEST LIMIT: the app id
   is public and any app can stamp any string onto its OWN groups, so this
   factor forces coherence but never decides alone — which is exactly why
   factor 1 is set EQUALITY and not any-member: against a competitor that
   pre-stamped our app id onto its (single-plan) group, an any-member rule
   would collapse ownership back onto one corruptible field.

One corrupted entry is never enough. Anything that can put a plan id into
the metafield (a hand-edit in Settings → Custom data, any app holding
`write_metafields`, a bug, a bad migration) breaks an existing set's
equality and darkens the widget — fail closed — rather than rendering a
foreign group whose selling plan id would reach the JSON island, the
nameless mirror and the cart. Rendering a foreign group requires authoring
its complete, coherent set next to a matching app id: wholesale forgery of
the single trust anchor, the documented residual.

The cost is paid in the safe direction: a shop whose metafield predates
v1.6.9, whose group is not yet stamped, or whose published set went stale
shows **no** buy box until the next successful sync or publish, instead of
showing the wrong one. A missing widget sells nothing; a widget showing a
competitor's plan sells *their* subscription through our buy box and hands
them the contract. Three layers keep that window short: (1)
`publishOwnGroupsMetafield()` runs `refreshOwnPlanIdsFromShopify()` and the
appId heal off one live read before it writes, and fails the whole publish
(previous metafield stays — stale-but-valid beats fresh-but-dark) when the
live state cannot be read; (2) `goLive()` records
`published but INCOMPLETE` in its audit payload when the published value
cannot render (empty sets, failed stamps); (3) the daily alert sweep
(`OWNERSHIP_FACTORS`, riding the PLAN_GROUP_DRIFT budget) verifies both
factors against the live state, republishes automatically, and alerts only
when that did not fix it. The Preview Doctor's `allow_list` step verifies
every half (published `appId` VERBATIM — the storefront never trims — the
group-side stamp, and exact set coverage) and names the broken one.

When nothing renders **because** no owned group matched — as opposed to the
product having no selling plans at all — the snippet leaves one inert marker,
`<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden>`:
empty, `hidden`, `display:none!important`, and carrying none of the widget's
own hooks so no selector in either asset file can mistake it for a widget.
`assets/buy-box.js` turns it into the admin-only "this product has subscription
plans from another app but none from Cellexia" hint card, and only inside a
server-validated preview session (`CellexiaSubs.previewValidated`) **and** on a
page whose own URL carries `?cx_preview=` — the same double gate as the
placement-anchor diagnostic. The validated session persists in
`sessionStorage` for the widget reveal (PDP → cart), so the URL half pins every
diagnostic card to the page actually opened through a preview link. A customer
can never see it.

**Admin surfacing.** The merchant must be able to see the situation without
reading a database: `app/lib/ownership/foreign-groups.server.ts` scans the
shop's selling plan groups (via `getSellingPlanGroupSummaries`) and diffs them
against our own group ids, read-only and failure-contained (`readable:false`
rather than a false "no other app here"). It feeds **Preview & launch → Other
subscription apps** (counts per ownership value, the other app's groups and the
products they sit on, plus the *Re-check subscription ownership* action), a
**non-blocking warning row** on the go-live checklist, and a per-plan
"Shares products with another app" badge on the **Plans** page. The
**Subscribers** list shows the owner per row, filters on it (*Managed by*) and
offers **Claim as Cellexia's** in bulk (`claimContracts`, `UNKNOWN` → `OURS`
only, one `admin.action` per row). `checkForeignContracts` raises the deduped
`FOREIGN_CONTRACTS` alert (WARNING) whenever foreign or unattributed contracts
exist, so this cannot be missed before go-live.

**Upgrade path.** Migration `0003_contract_ownership` backfills existing rows
to `UNKNOWN` (the evidence columns are added by that same migration, so there
is nothing to decide with — and `OURS` would be fail-open). `reclassifyContracts()`
completes it by reading contracts back from Shopify; `goLive()` runs it before
the mode flips and **Preview & launch** exposes it as a button.

## Buy-box design pipeline

The PDP widget's design (one of eight presets — `classic`, `toggle`, `tiles`,
`inline`, `value_stack`, `planner`, `subscription_max`,
`subscription_ultra_max` — plus
layout/style/per-locale text knobs) is configured on the admin **Buy box
designer** page and stored as append-only
`WidgetDesignRevision` rows. **Publish** validates and sanitizes the config
(zod schema + `sanitizeCustomCss` in `app/lib/widget/presets.ts`), stamps
`publishedAt`, and mirrors the JSON to the shop metafield
`cellexia.buybox_design` — which `buy-box.liquid` reads null-safely, so a shop
with **no published revision renders pixel-identical to v1.0.0**
(`DEFAULT_DESIGN_CONFIG` is that rendering written out as explicit knobs; a
failed metafield write rolls the publish back so DB and metafield never
diverge silently). **Restore** copies an old revision's config into a new
revision and publishes it — every change is reversible without touching the
theme. The block's `design_source` setting is a theme-editor emergency
override that can force a preset, bypassing the published config.
**Per-market presets** (v1.6.0, `config.markets`): a top-level
`markets: { [marketHandle]: { preset } }` record (field-level `.default({})`
per the schema-evolution rule, so every pre-1.6.0 stored revision and the
live metafield keep parsing) lets the designer pick a different *preset* per
Shopify Market — everything else (text/layout/style/behavior/placement/
themeSync) inherits the base config. The Liquid resolves nil-safely:
`localization.market.handle` (older stores / the render harness may not
provide it) → `config.markets[handle].preset` when present *and* a known
preset key, else `config.preset`; the forced `design_source` override wins
over the whole config, markets included. The wrapper's
`data-cellexia-preset` (and therefore the `_cellexia_design` attribution)
carries the **resolved** preset. Market handles come from the Admin
`markets` query (`app/lib/graphql/markets.server.ts`, read-only under the
already-granted `read_markets` scope); the designer's loader degrades to an
empty list on API failure without touching saved entries.
**`subscription_max`** (v1.6.0) is the take-rate-maximal preset: the
subscription card is the whole buy box and one-time demotes to a quiet
priced link below it (`or_buy_once_quiet` / `switch_back` locale keys). It
is deliberately *not* subscription-only — one-time remains a real radio in
the same `role=radiogroup` (visually-hidden inputs, one interaction to
reach, price in the link before selection), selecting it swaps the link
into a minimal picked state via pure CSS on the wrap's `is-selected` class,
and `buy-box.js` needs no preset-specific code: the quiet link is a
`data-cellexia-option` radio like any card and the switch-back label
reaches the subscription radio through its `for` attribute. Its quiet
defaults (heading empty unless overridden, badge and frequency selector
off unless the config explicitly re-enables them) live in the Liquid's
preset-default block and the designer's `PRESET_LAYOUT_PATCH`.
**`subscription_ultra_max`** (v1.11.0) takes that posture to its end: the
card sheds ALL offer chrome (savings and reassurance also default off, each
re-enableable by an explicit config `true`; the recurring then-line always
stays — recurrence disclosure is not optional; subscription preselected
unless `behavior.preselect` is `one_time`), so the subscription price reads
as the product's plain price — and the quiet priced one-time line doubles as
a **satellite** (`.cx-buybox-satellite[data-cellexia-satellite]`, the
`OWN_SATELLITE` constant in both asset files) that `buy-box.js` relocates
BELOW the theme's whole buy area (first `.pdp__grey` walking up from the
root, else the bound `/cart/add` form, else it stays in place). The Liquid
renders it inside the widget root, so no-JS and launch-gated pages are
exactly as safe as `subscription_max`; once relocated it mirrors
`widgetHidden()` onto its own `hidden` attribute (the ancestor gate no
longer covers it), carries its own copy of `cx-buybox--no-sub`, is moved
only behind an `isOwnSatellite()` class assertion, and never outlives a
detached widget root. Every radio/wrap/price-node reference was collected
at init while the satellite was still inside the root, so the existing
state machine keeps driving it after the move.
**Theme integration** (v1.2.2, `config.themeSync`): where a theme prints the
price inside its own Add to cart button ("ADD TO CART - CHF 64.00"),
`buy-box.js` swaps that one-time money *string* for the subscription
first-order one inside the button's text nodes while subscription is selected,
and restores the theme's text on one-time / hidden / gated. Both strings come
from Liquid (root `data-cellexia-money-onetime` / `data-cellexia-money-sub`, then the JSON
island on variant/plan change), so the JS still never formats money; the swap
is a no-op unless the button literally contains the one-time string.
v1.11.0 extends the identical swap to the theme's MAIN price display
(`themeSync.syncMainPrice` / `mainPriceSelector`, both defaulting on with a
built-in list led by cellexialabs.com's `.pdp__price`; root attributes
`data-cellexia-price-sync-main` / `data-cellexia-main-selector`); struck
compare-at and per-unit strings are deliberately untouched.
**Variant tracking** (v1.6.8, hardened v1.11.0): the event-free layers under
the form/URL listeners read not only `[name="id"]` fields but elements
carrying a variant id as an attribute (`data-variant-id` / `data-val-id` /
`data-variant`, trimmed — the live pills' vocabulary), ranked by evidence:
bound form, then per tier — fields (changed first, then unanimity with the
own-section tiebreak), the theme's active-selection paint, then passive
bystander markers; a changed value competes only WITHIN its tier, so a
bystander settling late can never outrank the pill the shopper sees; an
unpicked swatch is never evidence, and only a real field inside the
widget's own section can park the widget on an un-synced variant. This is the fix for the live one-click-behind defect,
where a bystander widget's `data-variant-id` rows raced the embed's one-shot
re-read and pushed the previous variant after every pill click.
Attribution: on subscription add-to-carts the widget JS stamps the hidden line
property `_cellexia_design` = the active preset key (`_cx_design` before
v1.2.3 — the ORDERS_CREATE handler reads both names, preferring the current
one, so attribution is continuous across the upgrade); the webhook logs
one `widget.design_attributed` event (`{designKey, orderId}`) per distinct
design on the order, and `getDesignPerformance`
(`app/lib/analytics/queries.server.ts`) aggregates those into take-rate by
design for the designer's performance card.

## Analytics

<a name="analytics"></a>

`app/lib/analytics/` is a read-side derivation layer: it never writes to
Shopify and its failures are contained (Golden rule 9 — `getInsights` returns
`[]` on any error, every alert check is individually wrapped). Jobs recompute
derived tables; admin routes read them. Since v1.4.0 the module is built on
three invariants:

**1. One population.** Every aggregate spreads `COUNTABLE_CONTRACT`
(`queries.server.ts`: `{ isDemo: false, ...OURS_ONLY }`) — directly or through
the contract relation — so demo fixtures and another app's contracts can never
enter any metric, numerator or denominator. Event-based counters (skips,
saves, add-ons, refunds) are counted **through the contract relation** with the
same filter; the one deliberate exception is `checkout.subscribable` (the
take-rate denominator), which precedes any contract and is counted without a
join. Money is only summed within the shop currency — attempts/contracts in
another presentment currency are excluded, never converted at 1:1, and the
excluded amount is accumulated into
`DailyRollup.excludedForeignCurrencyCents` so the exclusion is a visible,
quantified disclosure rather than silent missing revenue.

**2. One cost model** (`costs.server.ts`). Per-line COGS resolves in this
order, first known value wins:

1. `ContractLine.unitCostCents` — synced from Shopify `inventoryItem` cost
   ("Cost per item" on the variant);
2. `ProductCadence.unitCostCentsOverride` — merchant-entered on
   **Plans → Costs & margins** (variant-level row first, then product-level);
3. `costModel.cogsFallbackPctOfPrice` × line price — an **estimate**; every
   use is accumulated into `estimatedCogsCents` so coverage can be reported
   honestly (`getCostCoverage` powers the "LTGP is partly estimated" banner
   and the Plans-page badges).

Payment fees (% + fixed per charge), merchant-side fulfillment cost and
carrier cost per shipment (flat, or ≈ what the customer was charged) come from
the `costModel` setting, edited on **Settings → Costs & profit**. Customer-paid
delivery is revenue (inside the charged amount), never a cost. Gift COGS is
booked once per `GiftGrant` (rule `unitCostCents`, falling back to the
variant's override), never per billed cycle; a grant counts when its
`addedAt` is in the window AND it either still holds status `ADDED`/`SHIPPED`
or carries `shippedAt` (stamped at the ADDED→SHIPPED flip and never cleared —
a shipped gift's cost was incurred even if the grant row is later flipped
`REMOVED`, while a gift removed before shipping costs nothing). Prepaid
charges multiply COGS and
shipment costs by deliveries-per-charge.

**VAT / sales tax** (v1.15.0, `costModel.vat`; **on by default at 8.1%
since v1.16.0** — reporting only, billing untouched): when enabled, both
surfaces subtract a flat percentage of each charge's kept money via
`resolveChargeVat` — kept × rate/100, VAT as a straight expense on revenue
(the merchant-defined model: a CHF 100 charge at 8.1% books CHF 8.10) — at
the contract country's rate (`countryRatesPct`, falling back to
`defaultRatePct`). The captured order tax (`BillingAttempt.taxCents` /
`originOrderTaxCents`, migration 0016) keeps being collected per the data
foundation but deliberately no longer drives the deduction (v1.16.0): it is
the tax-extracted-from-gross figure — net × rate/(100+rate), a smaller
number on tax-inclusive prices — which is not the model the merchant runs
their P&L on. The country resolves through `contractTaxCountry` (delivery
address → acquisition country → null), the SAME helper the country segment
dimension uses. All VAT is rate-derived and mirrored into
`estimatedVatCents` (the estimatedCogsCents disclosure pattern).
The rollup books charge-day VAT without crediting later refunds (the cohort
surface carries the refund-adjusted figure — accepted day-ledger divergence,
same family as the over-refund rule); closed rollup days keep their pre-VAT
gross profit while the cohort triangle's full recompute carries VAT across
all history from the first run after enablement. Both gross-profit surfaces
consume these same helpers, so **DailyRollup.estGrossProfitCents and
CohortCell.grossProfitCents use the identical formula by construction**:

> gross profit = revenue collected (net of refunds) − COGS − fulfillment +
> shipping per shipment − payment fees − VAT (where enabled).

Discounts are *not* subtracted (charged amounts are already net of every
discount); `discountCents` is stored alongside for reporting only.

**3. Full revenue scope, disclosed.** Cohort/rollup revenue is Σ successful
`BillingAttempt` amounts **plus the origin (checkout) payment** (v1.5.0). The
first payment never becomes a billing attempt, so it is mirrored onto the
contract instead (`originOrderTotalCents` / `DiscountCents` /
`ShippingChargedCents` / `RefundedCents` / `ProcessedAt` / `CurrencyCode`),
captured from `getOrderSummary` when the contract is mirrored and backfilled
by the daily `origin_order_backfill` job (OURS contracts with an
`originOrderId` and a null total, 200/run, oldest first). Cohort cells book
the origin payment in the month it **processed** (normally month 0), with
fees from the shared cost model on the origin total and month-0 COGS resolved
from the contract's **current** lines via `resolveLineCogs` — a documented
approximation (origin lines ≈ current lines). The rollup books origin
payments on their processed day (the recompute-from-source model covers the
normal same-day capture; a late backfill whose processed day already left the
trailing recompute/backfill window stays out of that closed rollup row, while
the cohort triangle — full recompute — always includes it). Double-count
guard: an origin order that also has a successful `BillingAttempt` counts
**once** (the attempt wins) — `originPaymentCountsOnce` in
`queries.server.ts` is the single precedence rule both surfaces share.
The same webhook path also captures the sanitized **acquisition** columns
(`acq*`) — field-by-field contract, sanitization rules and the additive-only
promise live in [docs/DATA_FOUNDATION.md](DATA_FOUNDATION.md).
`lifetimeRevenueCents` deliberately keeps its renewals-only
("billed by this app") meaning. Refunds arrive via `REFUNDS_CREATE`: recorded
idempotently per refund id on `BillingAttempt.refundedCents` (renewal orders,
decrementing `lifetimeRevenueCents`, clamped at 0) or on
`originOrderRefundedCents` (origin orders — matched by
`contract.originOrderId` when no attempt claims the order). Recording
requires **currency agreement**: REST refund transactions are denominated in
the order's payment (presentment) currency while both mirrored totals are
shopMoney figures. A refund whose currency differs from the stored one
(Shopify Markets foreign-presentment order) is **converted** to the stored
currency via Shopify's own shop-currency figure for the refund
(`getRefundShopMoney` — `refund.totalRefundedSet.shopMoney`, v1.16.0; the
conversion is disclosed on the `refund_recorded` payload as
`converted`/`presentmentAmountCents`); only when that read is unavailable is
it skipped and logged (`refund_skipped_currency_mismatch`) rather than
summed raw — the same mixed-currency exclusion rule the rollup applies to
revenue.

**Refund exclusion** (v1.16.0, `analytics.excludeRefundedPayments` — **on by
default**): payments with ANY recorded refund — partial or full, renewal or
origin — are removed from analytics revenue/gross-profit/LTGP **entirely**
(charge, COGS, fees, VAT, shipping all drop with the payment), instead of
netting: a refunded rebill is usually the surprise first renewal that got
cancelled — noise, not revenue. Four consumers move in lockstep behind the
flag (double-subtraction hazard): `runDailyRollup` (skips the payments AND
stops subtracting day-recorded `refundedCents` from `estGrossProfitCents` —
the column keeps being written as disclosure), `computeCohortRows` (and
through it every segment view), `getForecast` (weekly net revenue reads
`chargedCents` alone) and `getSegmentForecast`. Because refunds usually land
after the charge's rollup day closed, `rollup_run` runs a **refund-repair
pass** (`repairRefundAffectedRollupDays`): the charge days of every payment
with recorded refunds inside the standing 90-day backfill window —
candidates derived from STATE, oldest first, so runs are idempotent and no
day can be starved out — are re-upserted in flow-columns-only (backfill)
mode; snapshots survive. With the setting off, nightly behavior is the
pre-v1.16.0 netting, byte-identical: the rollup books refunds on the day
they were **recorded** (closed rollup days are never rewritten); cohort
cells net them against the attempt's — or origin payment's — month.
Saving the setting triggers an immediate cohort recompute PLUS a
full-history repair of every refund-affected rollup day (charge days and
refund-recorded days alike, both directions — a flip re-interprets what
those days mean), then the live trailing window — so the day ledger and
the rollup-fed forecast stay in lockstep with the cohorts after a toggle,
not just for rows written since it.

Other load-bearing details:

- **Day/label space**: `DailyRollup.date` is the synthetic UTC midnight of the
  shop-tz calendar day. Compare against it with `shopDayLabelUtc`, never a raw
  UTC day key. Metric windows use the real UTC instants of shop-tz midnights.
- **Arrival** is `firstChargeAt ?? createdAt` (imports would otherwise spike
  "new subscribers" on import day); `completedAt`/`firstChargeAt` are stamped
  from the order's real charge instant (backdating capped at 24h), and
  `rollup_run` re-upserts the trailing 2 closed days plus today every run and
  backfills up to 90 days of missing days. Backfilled days are honest about
  what a past day cannot tell us: flow columns (charged, new subscribers,
  churn) recompute from source exactly as a live run would, but the snapshot
  columns (`activeSubscribers`, `mrrCents`, `pausedSubscribers`,
  `openDunningCases`, `prepaidActive`) are *not* stamped with live-at-backfill
  counts — the row keeps them at zero and carries
  `snapshotFabricated = true`, and the forecast treats such days as
  carry-forward-filled (annotated in its accuracy reasons), never as
  observed history.
- **Involuntary churn** counts `cancelSource DUNNING` **plus** contracts that
  entered status `FAILED` (`failedAt`) — under the default exhausted action
  (PAUSE→FAILED, no `cancelledAt`) payment churn would otherwise be invisible.
  Consolidation merges (`cancelReason MERGED`) are never churn.
- **MRR** (`computeMrrCents`): Σ over ACTIVE shop-currency contracts of
  cycle total × `cyclesPerMonth` from the exact mirrored billing policy
  (`billingIntervalUnit/Count`; pre-v1.4.0 rows fall back to `intervalWeeks`
  until their next sync). One-time add-ons excluded; delivery price included.
- **Survival** (`survival.server.ts`): Kaplan-Meier life table over the
  `ordersCount` distribution — live contracts are censored at their current
  cycle, so a young book reads flat, not churned. Cause-specific voluntary /
  involuntary curves share the same at-risk sets.
- **Forecast** (`forecast.server.ts`): five pure models — naive, damped-Holt
  trend, week-of-month seasonal (refuses <16 weeks), cohort survival build-up
  (censoring-corrected per-cycle survival + recent new-subscriber run rate),
  and **blend** (v1.5.0 — the base models averaged by inverse *recorded*
  error; fold-aware since the v1.6 hindsight-leak audit: each backtest fold
  may only weight by history entries recorded no later than the fold's first
  evaluated week (`historyErrorAsOf`), so no fold is ever re-scored with
  weights fit on its own evaluation weeks and blend's backtest is honest).
  **Self-measuring selection** (v1.5.0): the nightly `risk_learning_run` tick
  records each model's TRUE out-of-sample error for the newest complete week
  — the one-step holdout APE of a forecast trained strictly on earlier weeks
  (`latestOneStepApe`, mean over MRR + actives), NOT the fold-overlapping
  walk-forward average, so consecutive recorded weeks are independent
  measurements — into the machine-written `forecastModelHistory` Setting
  (rolling 26 weeks); "auto" picks by exponentially weighted recent recorded
  error and falls back to the current backtest (lowest MAPE over MRR +
  actives) while no weeks are on record.
  Weekly history is materialized gap-free (missing rollup weeks carry
  forward, annotated — and weeks whose rows are backfill-fabricated
  snapshots, `snapshotFabricated`, are treated exactly like missing ones);
  projections anchor on the last observed snapshot;
  bands are ±1.28σ·√h widened by the accuracy grade. The grade (A–D) is
  capped by weeks of history and adjusted by active-base size, backtest
  error and volatility, with plain-language reasons rendered in the UI.
- **Self-improving churn risk** (`learning.server.ts`, nightly
  `risk_learning_run` before `churn_risk_run`): deterministic (no-RNG)
  logistic regression over historical snapshots on a fixed 28-day UTC grid
  (560-day lookback), labeled by churn within 60 days, with strictly
  time-anteceding features (no label leakage) and a time-ordered 80/20
  train/holdout split. **Import boundary**: a contract only snapshots at
  grid times ≥ its mirror row's `createdAt` — before the mirror existed
  there is no event log and no counters, so pre-install grid times for an
  imported book (arrival backdated to the origin order) would fabricate
  identical "zero orders, never engaged" rows and false churn labels from
  sync-stamped `cancelledAt`; account age still uses true arrival. **Lifecycle heuristic → shadow → promoted**: the
  learned model influences nothing until it has ≥50 positive and ≥50
  negative outcomes AND beats the heuristic's holdout AUC by ≥0.02; it is
  demoted the same way. State lives in the machine-written `riskModel`
  Setting; `risk.server.ts` refuses any stored model whose feature names
  don't exactly match `RISK_FEATURE_NAMES`, and `getRiskModelStatus()`
  powers the Overview calibration chip (mode + sample counts — the UI never
  claims "learned" without the data). Every training decision logs an
  `admin.action` (`risk_model_trained`).
- **Insights** (`insights.server.ts`): ≤5 rule-based cards (churn spike,
  dunning recovery vs 55–70%, save rate vs 20–30%, COGS coverage <80%,
  take-rate WoW moves, skip:cancel deterioration, forecast maturity); rules
  stay silent below minimum sample sizes.
- **Segments** (v1.15.0, `segments.server.ts` + `segment-views.server.ts`):
  the analytics page's filter bar — country / language / traffic source /
  product / first-order discount band / device / first-order value, AND-
  combinable, each with an explicit Unknown bucket. ONE pure predicate
  derives every dimension (country via `contractTaxCountry` — shared with
  VAT; language from the checkout locale (`acqRaw.checkoutLocale`, v1.16.0 —
  the contract locale is catalog-normalized with an "en" default) falling
  back to the contract locale; source through the v1.16.0 last-touch ladder
  `acqUtm.source` → `acqRaw.paidChannel` (ad click-id presence) → referrer
  classification of `acqReferringSite` (search/social by name, other
  external hosts as "referral"; the capture-time `acqRaw.referrerInternal`
  verdict — judged against the shop's own domains, which read time cannot
  see — keeps internal navigation out) → `acqSourceName` with "web" reading
  "direct" when a WEBHOOK-captured bundle proves no referrer
  (import-passthrough bundles never claim it — the imported-book honesty
  rule); discount band from the mirrored origin money; the first analytical
  consumers of the acquisition data foundation, read-only).
  `resolveSegmentContractIds` maps a segment to countable contract ids
  once; every filtered view then computes LIVE from source over those ids —
  cohorts/LTGP through the identical persisted-triangle engine
  (`computeCohortRows` + `summarizeLtgp`, never writing), survival/MRR/
  funnel via additive `contractIds` options, a rollup-classified weekly
  churn series, and `getSegmentForecast`: the same pure forecast models
  over a weekly history reconstructed from contracts + orders (no MRR — not
  reconstructable; grade hard-capped at B with the reconstruction caveats
  as reasons; never writes `forecastModelHistory`). Take rate stays
  store-wide under a filter (its checkout denominator precedes contracts)
  and insight cards hide. Route components import the vocabulary from
  `segments-shared.ts` only (the ownership `shared.ts` pattern — a
  `.server` import in a component breaks the client build).
- **Jobs**: `rollup_run`, `cohort_run` (full triangle recompute — delete +
  createMany, self-healing after backfills), `risk_learning_run` (model
  training/evaluation + forecast accuracy recording, before scoring),
  `churn_risk_run` (risk scores + predicted empty dates),
  `retention_90d_run` (verdicts derived as of `completedAt`+90d from status
  timestamps, so a backlog evaluated late never mislabels a save),
  `origin_order_backfill`
  (origin-payment capture for OURS contracts still missing it — 200/run,
  oldest first; permanently unfetchable orders are retired via the
  `originCaptureExhaustedAt` / `acqPickupExhaustedAt` terminal markers so the
  capped window always drains, and contained per-contract failures surface as
  the `ORIGIN_BACKFILL_FAILURES` alert), `refund_reconcile` (re-attempts the
  unmatched-refund guard events once the attempt/origin mirror exists) and
  `full_sync_reconcile` (full contract re-sync — recovers from webhooks that
  outlived Shopify's retry horizon) daily; `alerts_run` every 15 min (which
  also persists one `AvailabilitySnapshot` row per shop-day — the union of
  out-of-stock variants the renewal-horizon feed observed that day). All
  keep running in Setup mode; failed daily runs retry within 30 minutes.

## Canonical event types

`contract.created|updated|activated|paused|resumed|cancelled|failed|expired|imported|merged|frequency_changed|next_date_changed|line_swapped|line_added|line_removed|line_price_changed|quantity_changed|address_updated|payment_method_updated|price_grandfathered|price_propagated`
`cycle.skipped|unskipped|delayed|addon_added|addon_removed|addon_offer_shown|gift_added|gift_removed`
`billing.attempt_scheduled|attempt_started|attempt_succeeded|attempt_failed|attempt_challenged|attempt_amount_backfilled|order_created|order_fulfilled|order_cancelled`
`dunning.case_opened|case_superseded|retry_scheduled|retry_succeeded|retry_failed|backup_used|backup_reverted|awaiting_customer|threeds_link_sent|card_expiring_notice|recovered|exhausted`
`cancel.flow_started|reason_given|save_shown|save_accepted|final_offer_shown|final_offer_accepted|completed|aborted`
`winback.scheduled|soft_touch|perk_offered|discount_offered|discount_granted|discount_skipped|reactivated|opted_out|sunset`
`lifecycle.gift_scheduled|gift_rescheduled|milestone_reached|rewards_unlocked|incentive_announced`
`notification.sent|failed` · `portal.visit|login|login_failed|otp_sent|otp_throttled|sms_inbound|mutation_attempt` · `magic.link_used`
`admin.action` · `import.completed` · `stockout.delayed|skipped|substituted` · `alert.raised` · `shop.installed` · `widget.design_attributed` · `acquisition.captured`

Two contract-less types complete the vocabulary: `checkout.subscribable`
(the take-rate denominator — logged per checkout that *could* have chosen a
subscription, before any contract exists, and therefore counted without the
contract join every other counter spreads) and `system.plan_group_drift_check`
(an internal marker, not a subscriber event: its existence within 24h is the
budget gate for the daily Admin-API plan-drift sweep in
`alerts.server.ts`). Neither is Klaviyo-mapped.

Delivery semantics: `logEvent()` never throws (an analytics write must never
break a billing operation), which means a failed insert is a *swallowed*
loss — counted in-process and surfaced as the `EVENT_WRITE_FAILURES` alert.
Event writes that are themselves load-bearing state (dedupe markers,
rate-limit rows, budget gates, sole-source counters) should instead ride the
caller's transaction: `logEvent(input, { tx })` joins the insert to the
mutation it records, and `logEventOrThrow()` propagates the failure to the
caller.

## Route map

- `/app`, `/app/*` — embedded admin (Polaris), authenticated via `authenticate.admin`
- `/webhooks` — all webhook topics (configured in `shopify.app.toml`)
- `/proxy/*` — customer portal via app proxy (verify signature with `authenticate.public.appProxy`)
- `/magic/:token` — magic link executor (public, self-authenticating)
- `/api/jobs/run` — external cron trigger (`x-cron-secret` header)
- `/api/health` — health/monitoring endpoint

## Key Shopify API notes (Admin GraphQL 2025-01)

- Selling plans: `sellingPlanGroupCreate/Update/AddProducts`; first-order vs ongoing discount via `pricingPolicies` (fixed policy `afterCycle: 0` + recurring policy `afterCycle: 1`).
- Contract edits: `subscriptionContractUpdate` → draft → `subscriptionDraftUpdate` / `subscriptionDraftLineAdd/Update/Remove` → `subscriptionDraftCommit`.
- Status: `subscriptionContractActivate/Pause/Cancel/Fail/Expire`, `subscriptionContractSetNextBillingDate`.
- Per-cycle (never touches the contract): `subscriptionBillingCycleSkip/Unskip`, `subscriptionBillingCycleScheduleEdit`, `subscriptionBillingCycleContractEdit` (draft+commit) — used for one-time add-ons, gifts, per-cycle discounts.
- Charging: `subscriptionBillingAttemptCreate(subscriptionContractId, { idempotencyKey, originTime, billingCycleSelector })`; result arrives via `SUBSCRIPTION_BILLING_ATTEMPTS_{SUCCESS,FAILURE,CHALLENGED}` webhooks.
- Payment: `customerPaymentMethodGetUpdateUrl` (magic card-update page), `customerPaymentMethodSendUpdateEmail` (Shopify-hosted email fallback).
- Import: `subscriptionContractAtomicCreate`.
- All mutations: check `userErrors` and throw `ShopifyUserError` (defined in `app/lib/graphql/client.server.ts`).

## Testing

Vitest. Pure logic (ladders, tokens, dates, money, taxonomies, mappings) is unit-tested
without a DB; DB-touching services are covered via integration-style tests only where
they can run against a scratch database (skipped when `DATABASE_URL` is unset).
