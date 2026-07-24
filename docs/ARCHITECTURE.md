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
- **App proxy** — customer portal served on the store domain at `/apps/cellexia/*` → app routes `/proxy/*`
- **Klaviyo** — all lifecycle/transactional flows are driven by server-side events (outbox pattern)
- **Jobs** — DB-leased locks (`JobLock`), 60s internal tick or external cron hitting `POST /api/jobs/run`

## Golden rules (apply everywhere)

1. **Money** is integer cents + ISO `currencyCode`. Convert at API boundaries only (`app/lib/money.ts`).
2. **Shopify IDs** are stored as full GIDs.
3. **Never discount codes on renewals.** All recurring pricing comes from selling-plan pricing policies and `DiscountGrant` rows applied via billing-cycle contract edits.
4. **Idempotency**: every billing attempt carries `idempotencyKey = "{contractId}:{cycleIndex}:{attemptNumber}"`, unique in DB *and* passed to `subscriptionBillingAttemptCreate`. Double charges are impossible even if the process crashes mid-run.
5. **Timezone-safe**: all schedule math goes through `app/lib/dates.server.ts` with the shop's IANA timezone.
6. **Every mutation logs an event** via `logEvent()` (`app/lib/events/log.server.ts`) with a type from the canonical vocabulary below. The event log is the timeline, the audit trail, and the Klaviyo feed.
7. **Settings, not accidents**: any behavior choice reads `getSetting(shopId, key)` (`app/lib/settings/settings.server.ts`). Never hardcode a policy.
8. **Webhook truth**: state changes observed via webhooks always win over local assumptions; handlers are idempotent (`WebhookReceipt` dedupe on `X-Shopify-Webhook-Id`).
9. **Failures are contained**: analytics/Klaviyo/notification failures must never break billing or portal actions. Wrap and log.
10. **i18n**: user-facing strings go through `t(locale, key, vars)` (`app/lib/i18n/i18n.server.ts`), keys namespaced `portal.*`, `magic.*`, `email.*`, `sms.*`, `cancel.*`, `common.*`. `en.json` is master.

## Module map

| Module | Path | Responsibility |
|---|---|---|
| GraphQL layer | `app/lib/graphql/` | All Admin API calls: selling plans, contracts, drafts, billing cycles/attempts, payment methods, products, orders, customers. Throws `ShopifyUserError` on userErrors. |
| Contract services | `app/lib/contracts/` | Skip/unskip, delay, frequency, swap, quantity, add/remove line, one-time add-on, pause/resume, cancel, address, next-date, price propagation vs grandfather, consolidation (merge), stockout evaluation, sync-from-webhook. |
| Billing | `app/lib/billing/` | Scheduler (due contracts → pre-charge pipeline → attempt), prepaid handling, stale-attempt sweep. |
| Jobs | `app/lib/jobs/` | Registry + runner with `JobLock` leases and `JobRun` logs; `POST /api/jobs/run` for external cron. |
| Dunning | `app/lib/dunning/` | Decline-code taxonomy, retry ladder (payday-aligned), backup payment fallback, 3DS challenge links, pre-expiry notices, recovery, exhaustion. |
| Webhooks | `app/routes/webhooks.tsx` + `app/lib/webhooks/` | Consume all topics; dedupe; dispatch to services. |
| Portal | `app/routes/proxy.*` + `app/lib/portal/` | OTP login, sessions, subscription management UI (served through app proxy), contextual prompts. |
| Magic links | `app/routes/magic.$token.tsx` + `app/lib/magiclinks/` | Token verbs with zero login; URL builders (`builder.server.ts`, already implemented). |
| Cancel flow | `app/lib/cancel/` + portal routes | Reason survey → reason-matched saves → last-chance offer; `CancelSession` recording. |
| Gifts & lifecycle | `app/lib/gifts/`, `app/lib/lifecycle/` | Gift rules/grants auto add/remove; milestones; rewards unlock; early-cycle incentives. |
| Win-back | `app/lib/winback/` | Staged win-back timed to predicted empty date. |
| Klaviyo | `app/lib/klaviyo/` | Outbox flush, event mapping (`events-map.server.ts` — replace the placeholder), profile sync. |
| Notifications | `app/lib/notifications/` | Channel router (Klaviyo event or SMTP fallback), templates, `NotificationLog`. |
| Analytics | `app/lib/analytics/` | Daily rollups, cohort LTGP, survival curves, churn risk, predicted empty dates, forecasting, take rate. |
| Admin UI | `app/routes/app.*` | Polaris pages: dashboard, analytics, subscribers, dunning, alerts, audit, bulk ops, plans, gifts, cancel-flow config, settings, import. |
| Buy box | `extensions/cellexia-buy-box/` | Theme app extension for PDP. |
| Widget design | `app/lib/widget/` | Buy-box design system: preset catalog + zod config schema + customCss sanitizer + text resolution (`presets.ts`, isomorphic — the admin designer imports it client-side), revision store / publish-to-metafield / restore (`design.server.ts`). Edited from the admin **Buy box designer** page. |
| Launch & preview | `app/lib/launch/` | Install-dark launch mode (SETUP/LIVE), storefront PREVIEW tokens, go-live with overdue stagger; the gates live in jobs/notifications/Klaviyo/portal/buy box (see below). |
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
  (analytics rollups/cohorts/churn risk, `stale_attempt_sweep`,
  `klaviyo_flush`, `alerts_run`) keep running.
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
- **Buy box** (`extensions/cellexia-buy-box/blocks/buy-box.liquid`): unless the
  `cellexia.launch_status` metafield equals `"live"`, the block renders with
  `hidden data-cx-gated="true"` — invisible to every visitor.

**Storefront preview (PREVIEW token).** Magic-token action `PREVIEW`,
signature-verified but **never consumed** (TTL 7 days, generous max-use for
audit only), appended to a storefront URL as `?cx_preview=<token>`. The block
JS validates it via app proxy `GET /apps/cellexia/preview/validate`, stores it
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

**Go-live** (`goLive()`): flips the setting + metafield and logs an
`admin.action` event. ACTIVE contracts with an overdue `nextBillingDate` are
detected and can be shifted, staggered over the next 3 days (shop timezone),
so going live never triggers a burst of charges. `revertToSetup()` is the
emergency exit back to dark.

## Buy-box design pipeline

The PDP widget's design (one of six presets — `classic`, `toggle`, `tiles`,
`inline`, `value_stack`, `planner` — plus layout/style/per-locale text knobs)
is configured on the admin **Buy box designer** page and stored as append-only
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
Attribution: on subscription add-to-carts the widget JS stamps the hidden line
property `_cx_design` = the active preset key; the ORDERS_CREATE webhook logs
one `widget.design_attributed` event (`{designKey, orderId}`) per distinct
design on the order, and `getDesignPerformance`
(`app/lib/analytics/queries.server.ts`) aggregates those into take-rate by
design for the designer's performance card.

## Canonical event types

`contract.created|updated|activated|paused|resumed|cancelled|failed|expired|imported|merged|frequency_changed|next_date_changed|line_swapped|line_added|line_removed|line_price_changed|quantity_changed|address_updated|payment_method_updated|price_grandfathered|price_propagated`
`cycle.skipped|unskipped|delayed|addon_added|addon_removed|gift_added|gift_removed`
`billing.attempt_scheduled|attempt_started|attempt_succeeded|attempt_failed|attempt_challenged|order_created`
`dunning.case_opened|retry_scheduled|retry_succeeded|retry_failed|backup_used|awaiting_customer|threeds_link_sent|card_expiring_notice|recovered|exhausted`
`cancel.flow_started|reason_given|save_shown|save_accepted|final_offer_shown|final_offer_accepted|completed|aborted`
`winback.scheduled|soft_touch|perk_offered|discount_offered|reactivated|sunset`
`lifecycle.gift_scheduled|milestone_reached|rewards_unlocked|incentive_announced`
`notification.sent|failed` · `portal.login|otp_sent` · `magic.link_used`
`admin.action` · `import.completed` · `stockout.delayed|skipped|substituted` · `alert.raised` · `shop.installed` · `widget.design_attributed`

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
