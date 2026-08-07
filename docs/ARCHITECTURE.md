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
7. **Settings, not accidents**: any behavior choice reads `getSetting(shopId, key)` (`app/lib/settings/settings.server.ts`). Never hardcode a policy. The v1.5.0 audit finished the sweep — cancel-flow, win-back and portal behavior constants (`cancelFlow.maxSavesShown`…, `winback.reactivationBillDelayDays`…, `portal.mutationsPerHour`…) are settings with defaults equal to the old constants. A policy constant found in code is a bug, not a style choice. (Two keys — `riskModel`, `forecastModelHistory` — are machine-written model state, deliberately absent from the Settings UI.)
8. **Webhook truth**: state changes observed via webhooks always win over local assumptions; handlers are idempotent (`WebhookReceipt` dedupe on `X-Shopify-Webhook-Id`).
9. **Failures are contained**: analytics/Klaviyo/notification failures must never break billing or portal actions. Wrap and log.
10. **i18n**: user-facing strings go through `t(locale, key, vars)` (`app/lib/i18n/i18n.server.ts`), keys namespaced `portal.*`, `magic.*`, `email.*`, `sms.*`, `cancel.*`, `common.*`. `en.json` is master.
11. **Ownership**: the store runs a second subscription app, and its contracts arrive on our webhooks. Anything that bills, messages, edits, counts or exposes a contract filters on `OURS_ONLY` / `isBillableOwnership()` (`app/lib/ownership/ownership.server.ts`); the buy box renders our selling plan group or nothing. `UNKNOWN` means "not proven ours" and is treated exactly like another app's. See [Ownership](#ownership--two-subscription-apps-on-one-store).

## Module map

| Module | Path | Responsibility |
|---|---|---|
| GraphQL layer | `app/lib/graphql/` | All Admin API calls: selling plans, contracts, drafts, billing cycles/attempts, payment methods, products, orders, customers, markets (`markets.server.ts`, read-only — powers the designer's per-market card). Throws `ShopifyUserError` on userErrors. |
| Contract services | `app/lib/contracts/` | Skip/unskip, delay, frequency, swap, quantity, add/remove line, one-time add-on, pause/resume, cancel, address, next-date, price propagation vs grandfather, consolidation (merge), stockout evaluation, sync-from-webhook. |
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
| Notifications | `app/lib/notifications/` | Channel router (Klaviyo event; without `KLAVIYO_PRIVATE_API_KEY` lifecycle email falls back to direct SMTP and SMS is SUPPRESSED — never logged SENT undelivered), templates, `NotificationLog`. |
| Analytics | `app/lib/analytics/` | Daily rollups, cohort LTGP (origin payment + renewals), the shared cost model (COGS/shipping/fees — `costs.server.ts`), censoring-corrected survival curves, churn risk with a self-training learned model (`learning.server.ts` — shadow-until-provably-better), predicted empty dates, five-model self-measuring forecasting with accuracy grades, take rate, alert scans, plain-language insights (`insights.server.ts`, imported directly — not via the barrel). See [Analytics](#analytics). |
| Acquisition capture | `app/lib/acquisition/` + webhook/sync handlers | Sanitized origin-order acquisition signals (`acq*` columns: source, UTM, geo, device, first-order shape) captured once per OURS contract; pure sanitizer (`sanitize.ts`) — never a raw IP or full user-agent; erased on GDPR redact. Contract: [docs/DATA_FOUNDATION.md](DATA_FOUNDATION.md). |
| Admin UI | `app/routes/app.*` | Polaris pages: dashboard, analytics, subscribers, dunning, alerts, audit, bulk ops, plans, gifts, cancel-flow config, settings, import. |
| Buy box | `extensions/cellexia-buy-box/` | Theme app extension for the PDP, in two install shapes over one shared core snippet: a `section`-target app block, and (v1.2.0) a `body`-target **app embed** that self-mounts and patches JS cart requests for themes whose product section takes no app blocks. |
| Widget design | `app/lib/widget/` | Buy-box design system: preset catalog + zod config schema + customCss sanitizer + text resolution (`presets.ts`, isomorphic — the admin designer imports it client-side), revision store / publish-to-metafield / restore (`design.server.ts`). Edited from the admin **Buy box designer** page. |
| Launch & preview | `app/lib/launch/` | Install-dark launch mode (SETUP/LIVE), storefront PREVIEW tokens, go-live with ownership re-classification + overdue stagger; the gates live in jobs/notifications/Klaviyo/portal/buy box (see below). |
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
  `skipNextCycle`, `unskipNextCycle`, `delayNextCycle`, `changeFrequency`,
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
  `klaviyo_flush`, `alerts_run`) keep running — they derive state or clean
  up internal records, and touch no customer.
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
when the seven `cx-preset-*` partials were extracted from the core for the
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
pinned to `cx-buybox-core.liquid` plus the seven preset partials so a stray
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
exactly **one** document-level query, `.cx-portal[data-cellexia-portal]`
(class **and** attribute), and roots everything else at that node. Before the
1.2.3 sweep it used `document.querySelector('.cx-toast')` and
`document.querySelectorAll('.cx-portal form')` — class-only, unqualified — and
the second one *writes* (it disables submit buttons on submit), so a foreign
`.cx-portal` would have had its forms disabled by us. Identical failure mode to
v1.2.2, in a different directory, which is exactly why the extension-scoped
rules never saw it. §5e also pins the selector↔markup pairing across files: the
confirm forms are rendered by `app/routes/proxy.*.tsx`, so renaming one side
would silently unbind the handler rather than raise anything.

**Storefront preview (PREVIEW token).** Magic-token action `PREVIEW`,
signature-verified but **never consumed** (TTL 7 days, generous max-use for
audit only), appended to a storefront URL as `?cx_preview=<token>`. The block
JS validates it via app proxy `GET /apps/cellexia-subs/preview/validate`, stores it
in `sessionStorage` (so PDP → cart keeps the preview on) and reveals the
widget with a "Preview — only you can see this" ribbon — in that browser
session only. Checkout needs no reveal: recurring terms show natively once a
line was added with a selling plan, and only the previewing admin ever does
that while in SETUP.

**Portal preview.** `PortalSession.isPreview` renders the full portal UI with
a persistent "Preview mode" banner; every mutating action is intercepted with
an explanatory toast — nothing executes, no Shopify calls. Preview a real
subscriber, or one-click create a local-only demo contract
(`SubscriptionContract.isDemo = true`, fake IDs `gid://cellexia/demo/...`,
excluded from billing/reminders/analytics/Klaviyo —
`app/lib/portal/demo.server.ts`).

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

**Storefront.** `publishOwnGroupsMetafield()` mirrors our group and plan ids
into the shop metafield `cellexia.plan_groups`
(`{"v":1,"groupIds":[…],"planIds":[…]}`, numeric ids — Liquid's form) on every
plan sync and on go-live. `cx-buybox-core.liquid` renders the group whose id is
on that list and **nothing at all** otherwise — no allow-list, no widget. There
is no name heuristic and no "first group on the product" fallback: a group
renders because its id is allow-listed, or it does not render.

The id is checked against **two** fields, not one: an allow-listed group is
only rendered if it also contains one of the allow-listed `planIds`. `groupIds`
alone would make the whole decision rest on a single metafield field — an
allow-list naming the other app's group id (a hand-edit in Settings → Custom
data, any app holding `write_metafields`, a bad group id persisted on a
`SellingPlanConfig`) resolved to *their* group, and everything downstream is
written on the assumption that the group it was handed is ours, so their
selling plan id reached the JSON island, the nameless mirror and the cart. The
plan ids are independent evidence — they name plans this app created — so one
forged field is not enough.

**Both factors are mandatory.** An allow-list with no `planIds` unlocks
nothing, on any product. `planIds` was briefly specified as a *veto* — absent
or empty meant the group id stood alone, so that a shop upgrading from a build
without `SellingPlanConfig.shopifyPlanIds` would not have its buy box blanked.
That was a hole rather than a kindness, because empty `planIds` is a state the
app **emits itself**: `publishOwnGroupsMetafield()` writes
`{"groupIds":["77"],"planIds":[]}` whenever `refreshOwnPlanIdsFromShopify()`
cannot read a group back from Shopify. In that state the two factors collapsed
into one, and a single corrupt or forged `groupIds` entry rendered the other
app's group in full. Requiring both restores the intended bar — forge one
field and nothing renders.

The cost is paid in the safe direction: a shop whose plan ids are unrecorded
shows **no** buy box until the next successful sync, instead of showing the
wrong one. A missing widget sells nothing; a widget showing a competitor's plan
sells *their* subscription through our buy box and hands them the contract.
`publishOwnGroupsMetafield()` still runs `refreshOwnPlanIdsFromShopify()`
before it writes — that repair is now load-bearing rather than tidy — so the
window is the first successful sync, and `goLive()` records
`published but INCOMPLETE` in its audit payload when it publishes an
allow-list that cannot render anything.

When nothing renders **because** no owned group matched — as opposed to the
product having no selling plans at all — the snippet leaves one inert marker,
`<template class="cx-buybox-nogroup" data-cellexia-no-owned-group hidden>`:
empty, `hidden`, `display:none!important`, and carrying none of the widget's
own hooks so no selector in either asset file can mistake it for a widget.
`assets/buy-box.js` turns it into the admin-only "this product has subscription
plans from another app but none from Cellexia" hint card, and only inside a
server-validated preview session (`CellexiaSubs.previewValidated`) — the same
gate as the placement-anchor diagnostic. A customer can never see it.

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

The PDP widget's design (one of seven presets — `classic`, `toggle`, `tiles`,
`inline`, `value_stack`, `planner`, `subscription_max` — plus
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
**Theme integration** (v1.2.2, `config.themeSync`): where a theme prints the
price inside its own Add to cart button ("ADD TO CART - CHF 64.00"),
`buy-box.js` swaps that one-time money *string* for the subscription
first-order one inside the button's text nodes while subscription is selected,
and restores the theme's text on one-time / hidden / gated. Both strings come
from Liquid (root `data-cellexia-money-onetime` / `data-cellexia-money-sub`, then the JSON
island on variant/plan change), so the JS still never formats money; the swap
is a no-op unless the button literally contains the one-time string.
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
another presentment currency are excluded, never converted at 1:1.

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
variant's override), never per billed cycle. Prepaid charges multiply COGS and
shipment costs by deliveries-per-charge. Both gross-profit surfaces consume
these same helpers, so **DailyRollup.estGrossProfitCents and
CohortCell.grossProfitCents use the identical formula by construction**:

> gross profit = revenue collected (net of refunds) − COGS − fulfillment +
> shipping per shipment − payment fees.

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
`contract.originOrderId` when no attempt claims the order), and netted in
analytics. Netting requires **currency agreement**: REST refund transactions
are denominated in the order's payment (presentment) currency while both
mirrored totals are shopMoney figures, so a refund whose currency differs
from the stored one (Shopify Markets foreign-presentment order) is skipped
and logged (`refund_skipped_currency_mismatch`) rather than summed raw —
the same mixed-currency exclusion rule the rollup applies to revenue. The
rollup books refunds on the day they were **recorded** (closed rollup days
are never rewritten); cohort cells net them against the attempt's — or
origin payment's — month.

Other load-bearing details:

- **Day/label space**: `DailyRollup.date` is the synthetic UTC midnight of the
  shop-tz calendar day. Compare against it with `shopDayLabelUtc`, never a raw
  UTC day key. Metric windows use the real UTC instants of shop-tz midnights.
- **Arrival** is `firstChargeAt ?? createdAt` (imports would otherwise spike
  "new subscribers" on import day); `completedAt`/`firstChargeAt` are stamped
  from the order's real charge instant (backdating capped at 24h), and
  `rollup_run` re-upserts the trailing 2 closed days plus today every run and
  backfills up to 90 days of missing days.
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
  forward, annotated); projections anchor on the last observed snapshot;
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
- **Jobs**: `rollup_run`, `cohort_run` (full triangle recompute — delete +
  createMany, self-healing after backfills), `risk_learning_run` (model
  training/evaluation + forecast accuracy recording, before scoring),
  `churn_risk_run` (risk scores + predicted empty dates),
  `retention_90d_run` and `origin_order_backfill`
  (origin-payment capture for OURS contracts still missing it — 200/run,
  oldest first; permanently unfetchable orders are retired via the
  `originCaptureExhaustedAt` / `acqPickupExhaustedAt` terminal markers so the
  capped window always drains, and contained per-contract failures surface as
  the `ORIGIN_BACKFILL_FAILURES` alert) daily; `alerts_run` every 15 min. All
  keep running in Setup mode; failed daily runs retry within 30 minutes.

## Canonical event types

`contract.created|updated|activated|paused|resumed|cancelled|failed|expired|imported|merged|frequency_changed|next_date_changed|line_swapped|line_added|line_removed|line_price_changed|quantity_changed|address_updated|payment_method_updated|price_grandfathered|price_propagated`
`cycle.skipped|unskipped|delayed|addon_added|addon_removed|gift_added|gift_removed`
`billing.attempt_scheduled|attempt_started|attempt_succeeded|attempt_failed|attempt_challenged|order_created`
`dunning.case_opened|case_superseded|retry_scheduled|retry_succeeded|retry_failed|backup_used|backup_reverted|awaiting_customer|threeds_link_sent|card_expiring_notice|recovered|exhausted`
`cancel.flow_started|reason_given|save_shown|save_accepted|final_offer_shown|final_offer_accepted|completed|aborted`
`winback.scheduled|soft_touch|perk_offered|discount_offered|discount_granted|reactivated|sunset`
`lifecycle.gift_scheduled|gift_rescheduled|milestone_reached|rewards_unlocked|incentive_announced`
`notification.sent|failed` · `portal.login|otp_sent|mutation_attempt` · `magic.link_used`
`admin.action` · `import.completed` · `stockout.delayed|skipped|substituted` · `alert.raised` · `shop.installed` · `widget.design_attributed` · `acquisition.captured`

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
