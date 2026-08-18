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
| Contract services | `app/lib/contracts/` | Skip/unskip, delay, frequency, swap, quantity, add/remove line, one-time add-on, pause/resume, cancel, address, next-date, price propagation vs grandfather, consolidation (merge), stockout evaluation, sync-from-webhook. **v1.28.0 seams** (all in `service.server.ts`, same `(shopDomain, contractId, …)` shape, all log events): **payment pointers** — `changePaymentMethod(shop, contractId, gid, {trigger: select \| backup \| new_method \| admin, source})` validates the gid against the customer's LIVE non-revoked methods (never the form), commits `draftUpdatePaymentMethod` inside `withContractDraft`, refreshes the mirror (brand / last4 / expiry / `paymentInstrumentType`, clears `paymentMethodRevokedAt`), logs `contract.payment_method_updated {source, trigger}`, sends `payment_method_updated` and calls `dunning.onPaymentMethodUpdated` so an open case retries at once; `setBackupPaymentMethod(shop, contractId, gid \| null, {setBy: CUSTOMER \| ADMIN \| ENGINE})` writes the same `backupPaymentMethodId` column the admin Select writes and stamps `backupSetBy/At`; `changePaymentMethodToBackup` (the engine's swap) delegates. **Pointer rules** (the engine reads "on backup" as `paymentMethodId === backupPaymentMethodId` and reverts from `DunningCase.originalPaymentMethodId`): backup = current primary → refused; selecting the backup as primary clears the backup pointer; selecting a new primary while a case is on backup nulls `originalPaymentMethodId` (explicit choice, no revert); the revoke-path promotion stays one-way but now emails the customer (`contract.backup_promoted`); typed `PaymentMethodChangeError` maps `CUSTOMER_MISMATCH / MISSING_CUSTOMER_PAYMENT_METHOD / STALE_CONTRACT / HAS_FUTURE_EDITS` to toasts. **Per-line cycle edits** (P2.5, migration 0028) — `skipLineThisCycle` / `unskipLineThisCycle` / `setLineQuantityThisCycle` are billing-cycle contract drafts (`withBillingCycleEdit`; `draft-lines.ts` resolves the draft line — after an unskip the cycle holds a re-added copy under a cycle-scoped id): a cycle can never be emptied (typed refusal), contract-level edits are refused with `ContractEditBlockedError` while `hasPendingCycleEdits`, the mirror flags `ContractLine.skippedCycleIndex` / `cycleQuantityOverride(Index)` are the estimate's input and are nulled by `clearStaleCycleOverrides` on whole-cycle skip, delay re-anchor, frequency change and settlement (a stale index is never billed from). **Delay** — `delaySchedule` (re-anchor via `setNextBillingDate`, `portal.delayReanchors`) vs `delayNextCycle` (one cycle) with `revertDelayedCycle` for Undo; the following date is schedule-aware (`billing/following-date.server.ts`). **Vacation hold** — `pauseUntil(resumeAt, reason)` (bounded by `maxPauseResumeAt` = pause.maxMonths × 30 days from `pausedAt`), `extendPause` (lock-gated), resume-on-date bills at the charge moment of `resumeAt` (the old now+3d drift is gone), `normalizePauseUntilReason` → `pausedReason`. **`sendNextOrderTomorrow`** (typed refusals: preparing, in-flight attempt, lock) → `cycle.rushed`. **`setDeliveryInstructions`** — sanitized (`portal.deliveryInstructionsMaxChars`), stored on the mirror AND as the contract custom attribute `_cellexia_delivery_instructions` (`mergeDeliveryInstructions` preserves foreign attributes; copied onto every renewal order), `contract.delivery_instructions_updated`. `swapPriceCentsFor` is the ONE swap-pricing helper (items card + SWAP save). |
| Plan lock window | `app/lib/contracts/lock.server.ts` | Per-plan `SellingPlanConfig.lockDays` (v1.13.0): blocks every CUSTOMER-initiated schedule reduction — skip, delay, frequency, next-date, pause, swap, recurring-line removal, quantity decrease, cancel — for the first N days after subscribing. Terms as subscribed under: the sync CREATE path stamps the covering plan's lockDays onto `SubscriptionContract.lockDays` once at mirror birth; the effective window is min(stamp, current setting) — raising never retro-locks, lowering/disabling releases immediately, null stamp (pre-feature/import/backfill) is permanently exempt. Resolution = line `sellingPlanId` membership in a config's append-only `shopifyPlanIds` (both id forms; NO product fallback); anchor = earliest of `firstChargeAt`/`createdAt`, window ends at shop-tz MIDNIGHT of the displayed unlock date (`addDaysTz`/`shopDayStartUtc` — golden rule 5). Enforced in the portal dispatcher, the cancel-flow choke point (`requireCancelContext`) + `completeCancel` backstop, magic-link GET describe + POST execution, and SMS keywords; additions/recoveries (add, addon, quantity increase, unskip, resume, reactivate, address, payment) and ADMIN/SYSTEM/DUNNING paths are never blocked. The guard lives in customer-facing surfaces — never in the contracts service. What the customer READS while locked is merchant-switchable (`portal.friendlyLockMessaging`, ON by default, v1.19.0): the friendly default renders a benefit-first "welcome period" progress card (day X of Y, what stays available, never naming the blocked verbs — reactance/priming hygiene) with matching toast (`?locked_until`/`locked_days` params, validated untrusted by `resolveToast`), magic-link and SMS copy, all carrying the exact unlock date; off = the original factual notice everywhere. Enforcement is byte-identical either way. |
| Billing | `app/lib/billing/` | Scheduler (due contracts → pre-charge pipeline → attempt), prepaid handling, stale-attempt sweep. **THE next-order estimate** (v1.28.0, P2.4 — `estimate.server.ts` `estimateNextCharge`): the one figure the hero, the home card, `upcoming_order` and `subscription_started` state (plan pricing from the mirror's `currentPriceCents` × cycle-edited quantities − the live `DiscountGrant` + delivery). **Scope of the money-true rule**: the estimate prices from the MIRROR — a pending price-change batch (`PROPAGATE_WITH_NOTICE`, `NOTICE_SENT`) is NOT folded in even when its `effectiveAt` precedes the next charge; it is disclosed by the portal banner only (`price-lock.server.ts` restates old→new catalog prices and deliberately never predicts the post-change total), and a reminder sent before the merchant applies the batch quotes the pre-change total. The price-change notice email is the authoritative post-change figure; batches apply only from **Bulk ops → Apply** (`applyPriceChangeBatch`, no job — see OPERATIONS §9). **Card label** (`cardLabel`): blank once `paymentMethodRevokedAt` is set (the reminder switches to its `payment_line_missing` copy, the home card's next-charge line drops the card and its chip says "Card removed"), brand capitalised (`emailCardLabel` / `displayCardBrand` — Shopify mirrors "visa"). **Reminder scope**: `runUpcomingOrderReminders` skips contracts with a dunning case in `OPEN_CASE_STATES` — the mirror's `nextBillingDate` is advanced optimistically at attempt creation and not resynced by the failure webhook, so the held order's reminder is the dunning ladder, never a "your order is on {held+interval}" email. **Preparing date** (`timing.server.ts` `preparingOrderDate`): while an attempt is in flight the mirror pointer already names the following cycle; portal surfaces print the attempt's own `scheduledFor` under "Preparing" and the mirror's date as "your following delivery". |
| Jobs | `app/lib/jobs/` | Registry + runner with `JobLock` leases and `JobRun` logs; `POST /api/jobs/run` for external cron. Registry position = run order. **v1.28.0 jobs**: `cancel_scheduled_run` (hourly, gated in SETUP — `cancel_upcoming` notice then the due cancels through `cancelContract`, each row re-read under the lock), `concierge_sla_run` (hourly, ungated — `SUPPORT_SLA_BREACH` + `SAVED_PENDING → SAVED` promotion; touches no customer), `cancel_intent_followup_run` (hourly, gated, registered AFTER `cancel_session_gc` so a session closed this tick is seen next tick). The post-exhaustion touches (`dunning/post-exhaustion.server.ts`) and the week-N check-in (`lifecycle/checkin.server.ts`) are phases INSIDE `dunning_run` / `lifecycle_run`, not new jobs — they inherit those jobs' SETUP gate. Every job that can send is `gatedInSetup` (launch-mode `EXPECTED_GATED` covers them). |
| Dunning | `app/lib/dunning/` | Decline-code taxonomy, retry ladder (payday-aligned), backup payment fallback, 3DS challenge links, pre-expiry notices, recovery, exhaustion. **Soft landing (v1.24.0)**: the `payment_failed_2`/`payment_failed_3` emails carry a one-tap "pause instead" line (`{pause_url}` — the action-link bundle's existing pause link), and pausing freezes the whole dunning clock: the sweep already skipped retries on PAUSED contracts, and the exhaustion phase now skips them too — exhausting a paused contract to FAILED would punish exactly the customer who took the off-ramp we offered. The case parks; after resume the window continues from where it stood. **Held-order money (v1.28.0)**: `held-amount.server.ts` `estimateHeldAmountCents` — the DunningCase's `amountAtRiskCents` (frozen at case-open), the `payment_failed_*` / `threeds_action` / exhausted-notice / `payment_failed_parked` amounts and the portal banner (`loadPortalDunning(contract, { heldOrderTotalCents: estimate.totalCents })`) all quote THE next-order estimate (grant / parked `cycle_discount_applied` marker / per-line edits applied — the hero, items-card and reminder figure), never the mirror's undiscounted plan sum; the plan sum is the contained fallback only when the estimate itself fails. **Card-update path (v1.28.0, P1.1 — `app/lib/payments/cardUpdate.server.ts` `resolveCardUpdatePath`)**: ONE server-side decision for every "update your card" surface (portal button, `UPDATE_CARD` magic link, dunning SMS, admin "Open secure page"): `customerPaymentMethodGetUpdateUrl` is Shop Pay only per the Admin API reference (card instruments return userError code `INVALID_INSTRUMENT` — the `code` field is now selected on the mutation) — so SHOP_PAY → hosted URL (302); CREDIT_CARD / PAYPAL → `customerPaymentMethodSendUpdateEmail` (Shopify's own "Confirm payment for your subscription" mail, valid 48 h, instrument replaced under the SAME method id) + a "manage payment methods in your account" link to `https://<primary domain>/account`; null / UNKNOWN type → try hosted, fall back on `INVALID_INSTRUMENT`; no / revoked method → unavailable. Logs `contract.card_update_link_sent {channel: hosted_url \| shopify_email, source, actor}` (contained). `SubscriptionContract.paymentInstrumentType` (0027) is mirrored wherever brand/last4 are; the `payment_update_path` self-check counts un-backfilled rows. Dev-store verification with a real card + the `/account` redirect is a launch one-way door (RELEASE_NOTES_v1.28.0). **Customer-side verbs (P1.2/1.3/1.6/1.9)**: `portal/dunning.server.ts` is the portal's ONE read model of a contract's trouble (the OPEN case, or the newest EXHAUSTED case of a FAILED contract; `dunning/states.ts` `OPEN_CASE_STATES` shared dependency-free with the SMS route) and `dunning-banner.server.ts` renders it (state line per RETRYING / AWAITING_CUSTOMER / AWAITING_3DS / EXHAUSTED; CTAs by decline category: AUTH_REQUIRED → Confirm with my bank (`/api/payment_3ds`, `portal/threeds.server.ts`: fresh `nextActionUrl` first, stored `BillingAttempt.challengeUrl` as fallback, `isTrustedShopifyRedirect`, "settled" with the real outcome when none) or Retry; UPDATE_CARD → Update card / Use another card (+ Retry when exhausted); else Retry now + Pause instead; FAILED + not hard-dead → Skip that order and continue from {date}; delay/skip are deliberately NOT banner verbs — after a failed attempt the mirror's `nextBillingDate` may point at the held cycle OR the following one, so a plain skip cannot truthfully promise "this order"). **Customer retry** (`requestCustomerRetry`, `/api/payment_retry`, `RETRY_PAYMENT`, SMS `RETRY`): reopens a FAILED contract's newest EXHAUSTED case exactly like `onPaymentMethodUpdated`, throttled per case by `DunningCase.customerRetryAt` + `dunning.customerRetryCooldownMinutes` (60), transitions to RETRYING and lets the 10-min sweep fire — time-anchored rung selection means no rung is consumed (`dunning.retry_scheduled {trigger: "customer"}`); `onPaymentMethodUpdated` now retries a RETRYING case immediately when the mirrored card actually changed; `fireRetry` takes a claim lease. **Skip-and-resume** (`skip-resume.server.ts`, `/api/payment_skip_and_resume`, `SKIP_FAILED_CYCLE`): FAILED only, card not hard-dead (`cardHardDeadReason` — revoked / expired / absent ⇒ refused, update-card is the honest path), no in-flight attempt; resolves the newest EXHAUSTED case `CUSTOMER_SKIPPED` (a fifth `DunningCase.resolution` value next to RECOVERED / CUSTOMER_FIXED / CANCELLED / EXHAUSTED: on purpose it counts as RESOLVED but NOT recovered in `dunningRecoveryRate` — no money came in, the subscriber was kept), `subscriptionBillingCycleSkip` on the held cycle (idempotent; already BILLED ⇒ refused), `subscriptionContractActivate`, next date = the first cycle date after the held one still ahead (`computeSkipResumeDate` — the banner promises the same date), `contract.activated {reason: "skip_failed_cycle"}` + `dunning.case_closed`. **Case reconciliation**: `onCycleSkipped` / `onCycleDelayed` close or defer a case whose held cycle the customer moved (`dunning.case_closed` / `dunning.retry_deferred`); the pre-expiry job includes PAUSED contracts whose card expires before `resumeAt` (moment in shop tz). **Post-exhaustion touches** (`post-exhaustion.server.ts`, a phase inside `dunning_run`, `dunning.postExhaustionTouchDays` default `[7, 21]`): `payment_failed_parked` (its own metric "Cellexia Payment Parked" — the ladder flow must not re-fire) at each offset while the contract is still FAILED with no `cancelScheduledAt` (a scheduled cancel is a decision — same reading as the intent follow-up — so no "ways to continue" chases it), the exhausted case is the newest with resolution EXHAUSTED and the decline is customer-actionable; offset i is due while `days[i] ≤ daysSince < days[i+1]` (a sweep outage never replays a missed touch); deduped in NotificationLog on `parked:{caseId}:{offsetIndex}` (SENT or SUPPRESSED); the "ways to continue" block is composed here — three exits (update card, `RETRY_PAYMENT`, `SKIP_FAILED_CYCLE`) for a chargeable card, the single honest exit for a hard-dead one (no retry/skip links minted, so a one-tap never lands on a refusal); `dunning.parked_touch` per send. Rollout: the first sweep after deploy sends ONE parked mail to every FAILED contract older than the last offset. **Other cards** (`other-cards.server.ts`): `payment_failed_2/3` `{other_cards_block}` = one `USE_METHOD` line per LIVE method other than the primary, computed at send time (revoked primary ⇒ its one other card still qualifies; expired vaulted cards never offered; capped; `portal.paymentMethodsList` off ⇒ empty). **New-method detection** — see Webhooks. |
| Webhooks | `app/routes/webhooks.tsx` + `app/lib/webhooks/` | Consume all topics; dedupe; dispatch to services. **v1.28.0 — payment-method topics as recovery**: the upsert handler's closed loop (direct hit + card actually changed → `payment_method_updated` email once per {contract, last4} / 24 h + Klaviyo "Cellexia Payment Method Updated", `dunning.onPaymentMethodUpdated` immediate retry), `revokedReason: MERGED` = "moved" (never the "your card was removed" mail), the revoke path stamps `paymentMethodRevokedAt` when no backup promotion happens and emails when it does (`contract.backup_promoted`), and **new-method detection** (`dunning/new-method.server.ts`, CUSTOMER_PAYMENT_METHODS_CREATE only — an UPDATE about an old card is a detail edit): per contract of that customer whose primary is not the new method and who is "in trouble" (open case, FAILED, revoked primary, expiring within `preExpiryNoticeDays`): auto-switch when the primary is dead and `dunning.newMethodAutoSwitch` is on (ownership-gated, expired targets never), else `new_card_detected` with `USE_METHOD` + `SET_BACKUP`; `dunning.new_method_detected` is the per-{contract, method} idempotency ledger. **Delivery tracking** (`fulfillment-tracking.server.ts`, P4.2): `orders/fulfilled` + NEW topics `fulfillments/create`, `fulfillments/update`, `fulfillment_events/create` (in `shopify.app.toml` — `npm run deploy`) + the billing-success settlement all funnel through `applyDeliveryTracking` → `BillingAttempt.trackingUrl / trackingCompany / trackingNumber / orderStatusUrl / shippedAt / deliveredAt` (migration 0028): OWNED contracts only, idempotent (a redelivery or a second topic carrying the same facts writes and logs nothing), `contract.delivery_shipped` on the first ship instant, `contract.delivery_delivered` on `fulfillment_events` "delivered" / `shipment_status: delivered`, `contract.delivery_shipment_cancelled` on a cancelled fulfillment; the portal reads the mirror only (read_orders is 60-day limited). |
| Portal | `app/routes/proxy.*` + `app/lib/portal/` | OTP login (anti-enumeration constant-time responses), sessions (signed HttpOnly cookie only; magic-link login lands via a single-use hand-off code — the token never rides a URL), subscription management UI (served through app proxy), contextual prompts, RTL-aware layout. **Growth features** (v1.20.0, `portalGrowth` settings group, each toggle ON by default; helpers + honesty rules in `growth.server.ts`): value-first list cards (captured savings + milestone proximity replace one-tap skip/delay — skip stays two taps away on Manage), the add-section upsell (opens expanded, one-time "try it" leads, ships-with framing, popularity badge only over real `cycle.addon_added` counts), the post-positive-action momentum offer (never after a skip), the schedule card's concession ladder (delay → next-slower cadence → skip, each with its concrete consequence date; skip reordered, never removed), the repeated-skip cadence nudge, and the runs-out-before-delivery prompt (move up / add one — the inverse of the standing push-it-back prompt). Every claim is computed from captured data; no growth copy ever names cancellation (pinned by `tests/portal-growth.test.ts`). **Accessibility contract** (v1.28.0, P5.3 — `layout.server.ts` + `a11y.server.ts`): colour tokens are exported (`PORTAL_TOKENS`) and interpolated into the shell stylesheet so `auditPortalContrast()` computes WCAG contrast on the shipped values — every body-text pair ≥ AA 4.5:1 (muted `#6f6a62`, amber `#7a5c2a`, rewards muted `#edf1eb`; the pre-fix `#8a837a` / `#8a6d3b` were 3.7:1 / 4.2:1); `:focus-visible` outlines on links/buttons/inputs/selects/textareas/summaries; `prefers-reduced-motion` kills transitions/animations; a skip link targets `<main id="cxs-main" tabindex="-1">`; toasts are `role=status aria-live=polite` and refusals (`TOAST_ALERT_KEYS`, stamped by `resolveToast` as `tone`) `role=alert`; the destructive Remove is an inline "Remove X? Keep / Remove" panel (`data-cellexia-confirm-arm/-panel/-keep`, no `window.confirm`); progress bars carry `role=progressbar` + `aria-value*` + a label; primary buttons ≥ 44px. `auditPortalShell()` renders the shell in-process and is the `portal_a11y` self-check (WARN on regression); `tests/portal-a11y.test.ts` pins the same. **Education hub** (v1.28.0, P4.4 — `education.server.ts`): `settings.portal.routineGuideUrl / howToUseUrl / faqUrl` (default "" = hidden; https:// or store-relative only, sanitized) drive the "Get the most from your routine" card below the items card (How to use {product} / Routine guide / FAQ + a Get-help anchor to the support card) AND the cancel flow's EDUCATION card / saved page (`educationGuideUrl`: routineGuide → howToUse → faq → no button) — the hard-coded `/pages/routine-guide` i18n value is gone. No product-metafield read (the app reads shop metafields only). **Timing & truth (v1.28.0, P2.1 / P2.4 / P2.2 / P4.6)** — `billing/timing.server.ts` is the ONE place "when does this renewal charge" is computed: `chargeMoment(d) = shopDayStartUtc(d, tz) + billing.chargeHourLocal h` (default 0 = byte-identical to the pre-1.28 sweep), `editCutoff` IS the charge moment ("you can make changes until …" can never contradict the sweep), `isChargeDue`, `isPreparingOrder` (an attempt claimed the billing day, or inside `billing.preparingWindowHours` default 6 with no attempt) → the "Preparing your order" state hides the schedule controls AND the dispatcher / magic / SMS refuse them (`preparing` refusal), printing the attempt's own `scheduledFor` and the mirror's date as "your following delivery" (`preparingOrderDate`); a failed settings read degrades to hour 0, never a blocked page. `billing/estimate.server.ts` `estimateNextCharge` is THE money source (see Billing) behind `next-delivery.server.ts` — the "Your next delivery" hero (date + cut-off, lines as they will bill: recurring, one-time add-ons "this order only", committed SCHEDULED gifts "(free)", per-line skips / one-cycle quantities, the live grant line "{k} discounted orders left", delivery, ships-to with delivery instructions, card, the DISCOUNTED total, "After that: {date}" from the schedule-aware `following-date.server.ts`, "line up with your other delivery" CTA, stock-out / price-change lines) — the home card, the items card, the cancel intro / retention summary and the reminder all print the same figures. **Delay semantics** (`schedule.server.ts` `delayModeFor`, `portal.delayReanchors` default ON): "Delay by N weeks" re-anchors the whole schedule (`delaySchedule` → `setNextBillingDate`), the explicit `mode=once` moves one cycle (`delayNextCycle`); OFF = always one cycle everywhere (portal, magic, SMS); both dates in the toast; a frequency change previews its consequence date. **Undo** (`undo.server.ts`, `/api/undo`, SMS `UNDO`) for delay / next-date / frequency: the confirming toast carries a signed expiring `UndoSpec` (bound to shop + contract + customer, TTL = `portal.magicLinkTtlDays` — the same window as the skip-undo link) and `undo` is a NORMAL guarded action that re-checks the contract against the spec: state ≠ the action's after-state → "stale"; the previous date's charge moment already passed → "past"; else a mode-faithful restore (`revertDelayedCycle` for once-delays, `setNextBillingDate` for re-anchors, cadence + previous date for frequency — both stale checks); `cycle.delay_reverted` / `portal.undo`. **Price lock** (`price-lock.server.ts`): "Member price · locked" only when `grandfatheredPricing` AND no NOTICE_SENT batch targets the contract (exactly what `sendPriceChangeNotices` / `applyPriceChangeBatch` guarantee), the "{member} instead of {one-off}" line only when EVERY recurring line mirrors a higher compare-at (catalog facts, never a charge figure), the price-change banner restates the notice email's catalog old → new prices and never predicts the post-change total. **Payment section** (`payment.server.ts` labels / states / chips / next-charge line; `payment-methods.server.ts` list with a 60 s per-customer memo shared by the page, the banner and a same-minute redirect; the "Add another payment method" block is honest — no in-app card entry exists) — see Dunning for the banner and verbs. **Flexibility (Stage D, `flex.server.ts` pure helpers mirroring the service's rules)**: items card "Not this time" / "Just for this order" stepper (`line_skip` / `line_unskip` / `line_qty_once`, undo, `portal.perLineCycleEdits`); pause form date picker + reason, PAUSED banner Resume now / extend by `portal.pauseExtendChoicesWeeks` (default `[2, 4]`, only while within pause.maxMonths of the pause START) / "Change resume date" (`pause_until` / `pause_extend` — later = `extendPause`, lock-gated; earlier = resume on that day) with copy that states the next-order day and promises the resume reminder only when `notifications/promise.server.ts` proves it will send; the run-out prompt's "already out → send my next order tomorrow" branch (`send_tomorrow`, honest charge-day copy); the supply meter "About {n} days of {product} left" (`portalGrowth.supplyMeter`, from `predictedEmptyDate`); address form Company + country select (`countries.ts`: ISO codes + `Intl.DisplayNames`) + province datalist (Shopify's required region codes — the server validates against the same tables) + delivery instructions (`delivery_instructions`). **Value (Stage E, all behind `portalGrowth.*` toggles ON by default)**: `deliveries.server.ts` "Your deliveries" (Account tab last 10 incl. a synthesized origin-order row, detail card last 5, in-transit banner, home line) reading `BillingAttempt` only — status derived, never guessed: delivered / shipped / refunded (nothing shipped + fully refunded, never "being prepared") / processing (bounded by `portal.deliveriesProcessingMaxDays` 30; in-transit by `deliveriesInTransitMaxDays` 14) / unknown (predates the mirror — "see the order page", never "processing"); `timeline.server.ts` "Week N of your routine" (ONE content source `lifecycle.resultsTimeline` for the portal card + home line, the cancel EDUCATION save's phase copy and the `routine_checkin` email; the week is arithmetic on the contract's own start; default copy is generic daily-use language, never a medical/efficacy claim, a merchant override owns its truth; the survey expectation line only for FAST horizons and never for survey-holdout contracts; the three surfaces obey the SAME pair `lifecycle.resultsTimeline.enabled` AND `portalGrowth.resultsTimeline`, and the `results_timeline` experiment arm — no exposure recorded for a treatment that shows nowhere); the rewards roadmap (every ladder rung + the day-90 reward "around {date}", gift names ONLY when a grant is committed, gift2-holdout-safe) + deliveries / gifts-received tiles; the first-cycle onboarding card (until order 2). **Cancel-intent banner** (`cancel/intent-banner.server.ts`, `cancelFlow.intentBannerDays` 14): the in-portal twin of the follow-up email — same `intentActionsFor` truth, posted through the portal's own dispatcher. **Win-back landing** `/subscription/:id/restart` — see Win-back. **Get-help card** — see Support. Portal API actions added: `payment_retry payment_3ds payment_select payment_backup payment_skip_and_resume undo line_skip line_unskip line_qty_once pause_until pause_extend pause_resume_date send_tomorrow delivery_instructions support`. |
| Magic links | `app/routes/magic.$token.tsx` + `app/lib/magiclinks/` | Token verbs with zero login; URL builders (`builder.server.ts`, already implemented). **Verb list** (`MagicAction`, `crypto/tokens.server.ts`): `SKIP_NEXT UNSKIP_NEXT DELAY_NEXT ADD_TO_NEXT UPDATE_CARD PAUSE RESUME SWAP CONFIRM_3DS APPLY_WINBACK LOGIN PREVIEW` + v1.28.0 `EXTEND_PAUSE` (pause exit ramp landing with week choices), `RETRY_PAYMENT` (customer retry — same throttle as the portal button), `USE_METHOD {paymentMethodId}` / `SET_BACKUP {paymentMethodId}` (re-validated against the customer's live methods at execution — the token is never trusted for the gid), `SKIP_FAILED_CYCLE` (held cycle + resume date re-derived at execution; a recovery on a FAILED contract, never lock-blocked — same classification as the portal's `payment_skip_and_resume`), `KEEP_SUBSCRIPTION` (clears `cancelScheduledAt` — a recovery, never lock-blocked), `SET_FREQUENCY {unit, count}` (slower only, ACTIVE only, re-derived against the plan's offered list), `CHECKIN {answer}` (logs `lifecycle.checkin_answered`, lands on the detail page through the LOGIN hand-off — `portal/handoff-next.server.ts` whitelists the only `next` a hand-off may carry). `RESUME` is minted for the first time (resume reminder + PAUSED banner). `APPLY_WINBACK {percent: 0, gift: false, restart: true}` is the signed `restart_url` (`winback/links.server.ts`, TTL `winback.restartLinkTtlDays`) — what a tap grants is re-derived at tap time (`winback/restart.server.ts`). Every schedule verb (DELAY_NEXT, SKIP_NEXT, SET_FREQUENCY, EXTEND_PAUSE …) obeys the plan lock window AND the preparing-your-order window (`isPreparingOrder`) exactly like the portal dispatcher; UPDATE_CARD goes through `resolveCardUpdatePath` (Shop Pay → hosted page, else Shopify's update email + a landing that says so); Shopify-hosted hand-offs (3DS, card page) pass `isTrustedShopifyRedirect` (`redirect.ts`, https + shopify.com / myshopify.com only). SMS keywords (`api.sms.inbound.tsx`): `SKIP DELAY STOP` + v1.28.0 `RETRY` (dispatches before the ACTIVE-only match — FAILED contracts qualify) and `UNDO` (the most recent delay / next-date / frequency change, or a skip → unskip, inside the undo window). `SKIP` / `DELAY` / `UNDO` refuse in SETUP mode (`isSetupMode`, audited `setup_mode`, portal setup copy) like every other customer mutation surface; `RETRY` gates itself in `requestCustomerRetry`, `STOP` is an opt-out. |
| Cancel flow | `app/lib/cancel/` + portal routes | Reason survey → reason-matched saves → opt-in final offer (server-side gating + cooldowns); `CancelSession` recording; hourly `cancel_session_gc` closes walked-away sessions (`cancel.aborted`). **v1.24.0 — the GIFT save** (`config.server.ts`): a dynamically picked free product on the next cycle (grant `source: "SAVE_FLOW"`), offered for `NOT_SEEING_RESULTS` (after EDUCATION), `TRYING_SOMETHING_ELSE` (first — a variety request answered exactly) and `OTHER` (after PAUSE); gated by `cancelFlow.giftSaveEnabled` + the per-customer `cancelFlow.giftSaveCooldownDays` (default 180); the card shows the product's photo + retail value and accepting grants **exactly the shown variant** (`savesShown` is the record — re-picking could resolve a different product than the one the customer said yes to; the same gates are re-checked server-side on accept). An exhausted pick (a repeat) is no save sweetener — the card is skipped. **Per-person cooldowns**: `reasonOfferOnCooldown`, `eligibleForFinalOffer` and the gift-save cooldown all scope by customer EMAIL across every contract on it (`contractIdsForCustomer`) — cancel-and-resubscribe on a fresh contract no longer resets the anti-farming clocks. **v1.28.0 — 11 save kinds** (`SAVE_KINDS`: `DELAY SKIP FREQUENCY PAUSE EXTEND_PAUSE DISCOUNT GIFT SWAP DOWNSIZE EDUCATION SUPPORT`): **DOWNSIZE** (`buildDownsizeOptions` — fewer units / smaller size / cheaper product with concrete totals from `swapPriceCentsFor`; TOO_EXPENSIVE first, TOO_MUCH_PRODUCT after SKIP; `cancelFlow.downsizeSaveEnabled`); **DELAY** ("push my next order to {predictedEmptyDate}", TOO_MUCH_PRODUCT first, `cancelFlow.delaySaveEnabled` / `delaySaveMaxDays` 42, the portal's own delay semantics); **per-line SKIP** option inside SKIP for multi-line boxes; **PAUSED cancellers** get EXTEND_PAUSE (in PAUSE's slot, never in a reason's `savesOrder`) + a paused FREQUENCY variant and never a no-op Pause save; SWAP sorted by price. **Concierge save (P3.7)**: the SUPPORT / EDUCATION cards render the Get-help form inline; `acceptSave` REFUSES those kinds without a submitted request (a mailto click / bare button is not a save — see Support), the request routes with `surface: cancel_flow`; when the charge is more than `cancelFlow.conciergeHoldMinLeadHours` (48) away the next order is held `conciergeHoldDays` (7) (`conciergeHoldPlan`); the SLA promise is `support.slaBusinessDays`; outcome `SAVED_PENDING` (session `saveAccepted`), promoted to `SAVED` + `cancel.save_confirmed` by `concierge_sla_run` when the merchant resolves the `SUPPORT_REQUEST` alert while the contract still lives, `SUPPORT_SLA_BREACH` (CRITICAL) after the SLA elapses unresolved. **Scheduled cancel (P3.8, locked contracts, `cancelFlow.scheduledCancelEnabled`)**: `scheduleCancel` stamps `cancelScheduledAt` = the lock window's unlock moment (`cancel.scheduled`); the billing sweep excludes `cancelScheduledAt <= now` from the due query (a late job never charges); `scheduled.server.ts` `runScheduledCancels` sends `cancel_upcoming` `scheduledCancelNoticeDays` (3) before with a `KEEP_SUBSCRIPTION` link (`keepLinkTtlDays` 60; NotificationLog dedupe) then completes due cancels through `cancelContract` (source CUSTOMER_PORTAL, the session's reason) — each row RE-READ under the lock so a kept subscription (`keepScheduledCancel` from portal "Cancels on {date} · Keep", the KEEP verb, admin, or a reactivate → `cancel.schedule_kept`) is never cancelled; a whole-order skip or a pause leaves it standing (the decision was to end, not to move); dunning respects it; the cancel link stays visible in the lock window when the setting is on. Prepaid remaining-deliveries copy appears only where the app controls fulfilment. **Cancel-intent follow-up (P3.6, `intent-followup.server.ts`, job `cancel_intent_followup_run`)**: ONE reason-matched email per walked-away (ABANDONED) session ≥ `cancelFlow.intentFollowupHours` (18) old and still the contract's LATEST session (a later SAVED / CANCELLED / open session or a scheduled cancel = already decided; ACTIVE / PAUSED, OURS, not demo), never inside `intentFollowupChargeBufferHours` (48) before the charge moment (or the resume day), at most one per CUSTOMER (email, across contracts) per `intentFollowupCooldownDays` (30) and never twice per session; template `cancel_intent_followup` with `intentActionsFor(reason)` one-tap saves incl. `SET_FREQUENCY` (slower only), the support form and a plain cancel link (`cancel.intent_followup_sent`); the home banner (`intent-banner.server.ts`, `intentBannerDays` 14, `cancel.intent_banner_shown`) offers the SAME actions. **Retention summary** is money-true and ladder-aware (locked price, subscriber + member savings, discounted cycles left, next ladder milestone, gifts, rewards, tenure) and reads the shared estimate. |
| Support | `app/lib/support/` (v1.28.0, P5.1) | `channels.server.ts` — `getSupportChannels(shopId)` is THE resolver every "reach a human" surface reads: `settings.support.email` → `Shop.contactEmail` → null (the email CTA is hidden, never a dead `mailto:` — the pre-v1.28.0 hard-coded `support@cellexia.com` on a domain the store does not own is gone from all 22 locales; `cancel.saves.education.consult_subject` / `cancel.saves.support.contact_subject` are subject-only keys and the href is built at render time), `replyTo` → email, `whatsapp` normalized to E.164 → `wa.me`, `chatUrl` https-only, `hoursNote`, `slaBusinessDays` (default 1), `requestsPerHour` (default 3). Contained, never throws. **Reply-To**: `mailer.server.ts` sets it on every direct send from the resolved channel (explicit `replyTo` input wins — the merchant-bound request email uses the customer's address); the auto-created Klaviyo flows carry `reply_to_email` from the same resolver AT CREATION ONLY (`createFlowForSpec`; `evaluateCoverage`/set-live never patch an existing flow's sender — a later support-email/Reply-To change, or flows created before v1.28.0, must be edited in Klaviyo or recreated; documented in KLAVIYO_SETUP.md); the From of last resort is `Cellexia <support email>` before the literal default (`verifyMailer` reports `fromFallback: "support_email"` so the Settings page can say so — a relay that verifies senders may reject it). **Get-help card** (`portal-card.server.ts`, `.cxs-support`): Account page (contract picker when several), the bottom of every subscription page, and the dunning banner's "Get help" anchor (Payment preselected) — resolved channels + a form (topic DELIVERY/PAYMENT/PLAN/OTHER, required message, optional picker of the last 5 billed cycles from the local `BillingAttempt` mirror, and for Delivery problems on an ACTIVE, unlocked, not-preparing contract "push my next order back 1 week" via the portal's own delay semantics), privacy line, SLA line. **`POST /api/support`** (`request.server.ts` `submitSupportRequest`): full guard chain + stricter insert-then-count budget → `support.requested {topic, contractId, orderRef, pushBack, pushBackApplied, message, surface, cancelReason?}` via `logEventOrThrow` (record of truth; Klaviyo "Cellexia Support Requested" through the map) → `SUPPORT_REQUEST` alert deduped per contract per day (`raiseAlert.dedupe`, context links `/app/subscribers/:id`) → email to the support inbox; alert/mail/push-back failures are contained; toast `support_sent` / `support_pushback_failed` carries `sla`. **Cancel flow truth**: the SUPPORT / EDUCATION cards render the same form inline; `acceptSave` REFUSES those kinds without a submitted message (a mailto click / bare button is not a save) and routes the request with `surface: cancel_flow` + reason/session; a failed record-of-truth write propagates so the SAVED claim reverts (never a save without its request); the cancel route runs the SAME support budget first (`supportBudgetExceeded` in `request.server.ts` — insert-then-count on the shared `portal.mutation_attempt` rows, both `portal.mutationsPerHour` and `support.requestsPerHour`, 429 page when exhausted) so the card is not an unbounded second door to the merchant inbox. The portal card's push-back carries `expected_next` and the dispatcher treats a stale value as "already applied" (record the request, never a second week). `settings.support.email/replyTo/whatsapp/chatUrl` are format-refined at save time with the resolver's own rules (a value the resolver would drop to null is rejected, never silently rerouted to `Shop.contactEmail`). `support.requested` is enqueued to Klaviyo with `dedupe: false` (person-typed; two distinct requests inside 120 s both arrive) and its properties are the payload's camelCase keys (KLAVIYO_SETUP.md). Admin: subscriber page "Support requests" card (newest 5 events); alerts page links contract-scoped alerts to the subscriber. |
| Gifts & lifecycle | `app/lib/gifts/`, `app/lib/lifecycle/` | Gift rules/grants auto add/remove; milestones; rewards unlock; early-cycle incentives. **v1.24.0 — dynamic gifts** (migration `0024_dynamic_gifts_experiments`): `GiftRule.selection` ∈ `FIXED` \| `DYNAMIC` — a DYNAMIC rule resolves the variant per customer at grant time via the picker (`app/lib/gifts/picker.server.ts`) from the `gifts` settings group (pool of variant GIDs + per-entry merchant COGS overrides, `pairings` subscribed-product → ranked gift variants, `surveyPairings` `"question:option"` → ranked variants, `maxGiftsPerCycle` default 1 — pool and pairings edited on the Gifts page, never the generic Settings renderer). Picker contract: never a product on ANY of the customer's contracts nor a previously granted variant (identity = customer email across contracts — local contract + grant rows are the only honest sources; without `read_all_orders` the API forgets orders older than 60 days); ranked by pairings, then survey answers (holdout contracts excluded — gift choice is treatment), then pool order; **deterministic, no RNG**. When nothing new remains it repeats the longest-ago gift and raises the deduped INFO `GIFT_POOL_EXHAUSTED` alert — a repeat beats a broken promise; a null pick falls back to the rule's fixed `variantId`, so a DYNAMIC rule can never grant less than a FIXED one (rollback safety: DYNAMIC rules keep a real fallback variant, so v1.23 code ignoring `selection` still grants a real product). `GiftGrant` gains `unitCostCents` (per-grant COGS stamp — the rule's cost describes the fallback variant, not the pick) and `source` (`RULE` \| `LADDER` \| `FIRST_ORDER` \| `SAVE_FLOW` \| `WINBACK` \| `REWARDS` \| `MANUAL`). **Milestone ladder**: `lifecycle.milestoneLadder` (default `[12,18,24]`) — rungs after the base milestone are granted directly by the gift engine (dynamic pick, `source: "LADDER"`, always announced, no `GiftRule` row; the base milestone rule's variant is the fallback); `lifecycle.milestone_reached` + the milestone email fire on every rung and the portal's `milestoneRemaining` counts to the NEXT rung, so the goal-gradient hook never exhausts. Anniversary (`DAYS_SUBSCRIBED`) rules gain `repeatsAnnually` — fires at every multiple of `daysSubscribed`, with a k-th-grant count guard so month-end clamping can never double-fire a multiple. **Day-90 reward is real**: `lifecycle.rewardsGiftEnabled` (default true) — `runRewardsUnlock` grants a dynamically picked free product on the next cycle (`source: "REWARDS"`, granted BEFORE the event/email) and the `rewards_unlocked` email names it; without a grant the email omits the product sentence (truth gate). **Gift teaser**: new template `gift_teaser` (metric `Cellexia Gift Teaser`), sent by the billing-success hook after order 1 only when the cycle-2 surprise will ACTUALLY happen — `lifecycle.surpriseGiftOnCycle2` on AND an active `ORDER_INDEX=2` rule AND the customer not in the `gift2_holdout` no-gift arm. **Enriched gift emails**: `gift_announcement` / `rewards_unlocked` / `winback_perk` render the actual product photo (and shelf price / arrival date where the template carries them), and `milestone_gift`'s gift sentence is truth-gated — all via composed localized line vars (`gift_image_line`/`gift_worth_line`/`gift_date_line`/`gift_line`; helper `app/lib/gifts/emailLines.server.ts`, i18n sub-keys `email.gift_common.*`, all 22 locales — markdown-lite has no conditionals, so optional content arrives as a pre-composed sentence or an empty string). **v1.28.0 — results timeline + check-in** (`lifecycle/checkin.server.ts`, a phase inside `lifecycle_run`): once per contract when the routine week reaches `lifecycle.resultsTimeline.checkinWeek` (default 4), the `routine_checkin` email (metric "Cellexia Routine Check-in") carries the phase copy for that week + the survey expectation sentence when known + two one-tap `CHECKIN` answers (great / unsure) landing on the detail page (`lifecycle.checkin_answered`, Klaviyo "Cellexia Routine Check-in Answered" — segmentation only); gates in order: `lifecycle.resultsTimeline.enabled` AND `portalGrowth.resultsTimeline`, ACTIVE / OURS / not demo, the `results_timeline` experiment arm. Content and truth rules live in `portal/timeline.server.ts` (see Portal). **Rewards roadmap truth rules** (`portal/growth.server.ts` `buildRewardsRoadmap`, `portalGrowth.rewardsRoadmap`): the base milestone, every rung of `lifecycle.milestoneLadder` and the day-N reward are listed with "around {date}" (`projectOrderDate` from the cadence — a projection, null when unknowable); a gift is NAMED only when the pick is deterministic and committed (the base rule is FIXED with a variant title, or a SCHEDULED / ADDED grant already sits on the upcoming cycle for that rung); a ladder rung says "a free product" only when the engine can actually grant one (non-empty pool or the base rule as fallback), the day-N row only with `rewardsGiftEnabled`; the cycle-2 surprise appears ONLY when the teaser email was actually sent for this contract (`teaserPromised` — holdout arms never got one, treatment arms are told nothing the teaser did not already say); REACHED rows are labelled from EVIDENCE of a grant (a REWARDS `GiftGrant`, the `lifecycle.milestone_reached` event's `giftGranted`), never from config; every read failure degrades to the generic / none label, never a bolder promise. **Welcome email** `subscription_started` (`notifications/subscription-started.server.ts`): once per genuinely new contract (origin checkout order present — imports / backfills refused BEFORE the router, no NotificationLog row) with the next charge estimate + cut-off + portal CTA + support line — see Notifications for the UNKNOWN→OURS heal. |
| Win-back | `app/lib/winback/` | Staged win-back timed to predicted empty date. **v1.28.0 — parity + one-tap restart** (P3.2 / P3.5): `links.server.ts` mints the signed single-use `restart_url` (`APPLY_WINBACK {percent: 0, gift: false, restart: true}`, TTL `winback.restartLinkTtlDays` default 60) into `cancel_confirmed`, `winback_soft` and the Klaviyo `contract.cancelled` event — dependency-light on purpose (engine, router and event map all mint without a module cycle); when the mint fails the router degrades the placeholder to `portal_url` (a literal `{restart_url}` never reaches a customer). The dead skip/delay bundle is gone from `winback_soft`. `restart.server.ts` `deriveCurrentWinbackOffer` is THE offer for every door (emailed one-tap, portal restart card, `/api/reactivate`, the welcome-back landing `/subscription/:id/restart` rendered by `welcome-back.server.ts`): CANCELLED + a `WinbackState`, offers read from the engine's own `winback.discount_offered` / `perk_offered` events since `cancelledAt` (newest first), each expiring exactly when its emailed link does (`offeredAt + sunsetOffsetDays − stageOffsetDays + linkGraceDays`), the discount re-clamped against `winback.discountPct` and the stacking cap, the gift an offer only when one can still be granted (dynamic pick, else the ORDER_INDEX=2 fallback rule) — never less than the email promised, never an offer the engine will not honour; every read failure resolves to "no offer" (plain restart, the pre-1.28 behaviour), never a blocked restart. `WinbackState.reason` (migration 0028) is snapshotted at `scheduleWinback` (shown in admin; per-reason ladders are a later release). |
| Klaviyo | `app/lib/klaviyo/` | Outbox flush (with a 24h age-out — stale moments go DEAD, never fire late), event mapping (`events-map.server.ts`), profile sync. **v1.18.0 — guided flow setup** (`flows.server.ts` + `app.emails_.setup.tsx`): one click creates every delivery flow via Klaviyo's Flows/Templates APIs (metric trigger + `cellexia_send equals "true"` string filter + one send-email rendering `{{ event.content_html }}` with the required unsubscribe footer, smart sending off), seeds unseen metrics with `cellexia_send:"false"` events (can never send), respects the merchant's own live flows (never duplicates), verifies coverage into the machine-written `klaviyoFlowSetup` setting (Emails overview card reads the cache; the daily `KLAVIYO_FLOW_COVERAGE` alert refreshes it at most once/day). `cellexia_send` is a VERDICT when present ("true" from the router's EMAIL enqueues; the provenance verdict — shared `isPersonInitiated` gate + in-app enable toggle + sender — on confirmation events, which also carry rendered `content_*`; "false" on SMS legs and seeds) and deliberately ABSENT on canonical non-confirmation events: several share a metric with a router template, and the outbox dedupe graft supersedes the flag together with the content — the graft protects only confirmation-event verdicts (keyed on the surviving row's `event_type`, never on flag presence, so legacy default-stamped rows heal across upgrades). A stamped default here once froze dual-writer metrics (milestone/rewards/hard-decline payment-failed) silent forever — `tests/outbox-graft-verdict.test.ts` pins the full matrix. **v1.25.0 — fast, reliable setup**: coverage is read with ONE paginated `GET /api/metrics/?include=flow-triggers` (metric → triggering flow ids + the flows' name/status/archived via `included`; 10/s, 150/m; 400 → fallback `GET /api/metrics/` + per-spec-metric `flow-triggers`, paced) — never a per-flow definition GET (the 3/s, 60/m endpoint that 429'd on any store with > ~50 flows, including the ~27 this setup creates, and made the whole index fatal ⇒ an EMPTY checklist); every Klaviyo call goes through a module-private retry wrapper (429 waits Retry-After, capped 30 s, ≤ 4 attempts; GET 5xx/network backs off; a POST 5xx is never re-sent — the post-run re-read resolves the ambiguity); a fatal read keeps the last cached rows (`unchecked` for never-verified specs) so the checklist never blanks. Verify and setup run as ONE-PER-SHOP background tasks (`setup-task.server.ts`: in-process `global.__cellexiaFlowTasks` + the persisted `klaviyoFlowSetup.task` record written on start / throttled ≥ 1 s / 15 s heartbeat / at end; a persisted running record silent for > 90 s = interrupted, restartable; across instances the start is gated by a per-shop `JobLock` lease `klaviyo_flow_task:<shopId>` (owner = task id, 90 s, renewed by the heartbeat, released at the end — the runner's exported `acquireLock`/`renewLock`/`releaseLock`), and a run that lost its map slot to a newer start becomes write-inert; the write chain's read is strict, so a DB blip aborts that write instead of rebuilding the record from an empty cache) started by the setup page's loader (stale cache > 10 min, measured from the last touch — failed attempts included — and never while a task runs) and actions, polled by the DB-only resource route `app.emails_.setup_.status.tsx` (`Cache-Control: no-store` via the route `headers` export, which is what single fetch puts on the wire); no verification or flow creation runs inside a web request — the page's only in-request Klaviyo call is save-key's single 15 s-bounded key probe (validate before storing), and a key saved while a run is in flight is re-verified by one automatic `refresh` when that run finishes; the daily alert sweep skips a tick while a fresh running record exists (never judges coverage mid-setup); the setup has NO per-run cap — every missing flow, one POST per ≥ 4.1 s (Create Flow is 1/s, 15/min, 100/day), 429 waits and continues inside an 8-minute run budget after which the rest report `rate_limited` and the next click continues; `onProgress({step, done, total, message})` drives the page's progress bar. |
| Notifications | `app/lib/notifications/` | Channel router (Klaviyo event; without a Klaviyo key — `klaviyo` setting or `KLAVIYO_PRIVATE_API_KEY` env fallback — lifecycle email falls back to direct SMTP and SMS is SUPPRESSED — never logged SENT undelivered), templates, `NotificationLog`. Since v1.16.0 the admin **Emails** tab (`app/routes/app.emails.tsx` + `catalog.server.ts`) owns per-template customization: the `emails` setting holds enable/disable (SUPPRESSED reason `template_disabled`; critical templates bypass) and merchant subject/body overrides, which `renderEmail` applies in BOTH delivery shapes — the ready-rendered `content_subject`/`content_html`/`content_text` Klaviyo event properties (flows render `{{ event.content_html }}`) and the direct-SMTP fallback. Rendered content and link URLs are never persisted in `NotificationLog`. **v1.17.0 — the email studio**: body copy renders through a markdown-lite formatter (`format.ts`, isomorphic — escape-before-structure, http/https/mailto href allow-list, `{cta}` semantics preserved; since v1.24.0 also `[image:Alt](url)` on its own line → a centered product image, https-only, degrading to nothing in the plain-text rendering — the enriched gift emails' photo block) inside a brand-kit shell (`emailDesign` setting, Emails → Design tab; defaults = the historical shell). Each template row also carries `sender` — `auto` (pre-1.17.0 behavior exactly), `app` (direct SMTP, delivery metric deliberately NOT enqueued so a flow cannot double-send), `klaviyo` (event only; keyless = SUPPRESSED `klaviyo_unconfigured`, never silently rerouted); SMS ignores `app`, critical templates keep their unconditional SMTP copy. The state-change confirmations (skip/delay/pause/cancel/…) default to their Klaviyo flows but become app-sent via the **confirmation bridge** (`confirmations.server.ts`, invoked by `logEvent()` beside the Klaviyo enqueue, contained, 10-min per-contract+template dedupe) when their sender is `app`. Per-template editor pages (`app.emails_.$template.tsx` — escaped flat-route name since v1.25.0 so the overview's loader is not a layout parent) provide live preview (the REAL `renderEmail` on `preview.server.ts` sample data — every template must render placeholder-free, pinned by tests; all sample links point at example.com) and a test send that never writes `NotificationLog`. The SMTP transport itself resolves settings-first (`mailTransport` setting, admin Settings → Email delivery; env vars as fallback; password encrypted via `app/lib/crypto/secrets.server.ts`), with the transport cache keyed by the resolved config so admin saves apply without a restart. **Welcome email heal (v1.28.0)**: `subscription_started` (`subscription-started.server.ts`) dedupes on SENT + SUPPRESSED rows EXCEPT `SUPPRESSED{reason: foreign_contract}` (the router's ownership gate on a mirror that landed UNKNOWN); the sync's UNKNOWN→billable heal block (`sync.server.ts`, beside the first-order tag heal) re-invokes it while the contract is at most `notifications.welcomeHealMaxDays` old (default 7, 0 = off) — late rather than lost, never a months-old "welcome". **v1.28.0 templates**: `subscription_started` (rides the CANONICAL metric "Cellexia Subscription Started" as a content-carrying leg with `cellexia_send` — a merchant's existing onboarding flow on that metric keeps working), `payment_failed_parked` ("Cellexia Payment Parked"), `new_card_detected` ("Cellexia New Card Detected"), `threeds_action_sms` (shares "Cellexia 3DS Action Required" so one SMS flow keys off it), `cancel_scheduled` / `cancel_upcoming` ("Cellexia Cancellation Scheduled" / "Cellexia Cancellation Upcoming"), `cancel_intent_followup` ("Cellexia Cancel Intent"), `routine_checkin` ("Cellexia Routine Check-in"); `payment_method_updated` is now actually sent (its FULL var set is built by `payment-method.server.ts` `paymentMethodUpdatedVars` — the body references `{change_line}` / `{next_line}` unconditionally and `t()` leaves an unknown placeholder visible, so every sender MUST build vars there; `emailCardLabel` is the compact instrument-aware label for a line inside a sentence). `upcoming_order` gains `{payment_line}`, `{card_expiry_warning}`, `{edit_cutoff_line}`, `{following_date}` / `{following_date_iso}`, "(free)" gift markers and the truthful subject "your order is on {date}"; `payment_failed_2/3` gain `{other_cards_block}`; `resume_reminder` carries `RESUME` / `EXTEND_PAUSE` links; `cancel_confirmed` / `winback_soft` carry `{restart_url}` (degraded to `portal_url` when the mint fails — a literal placeholder never ships). **Reply-To**: `mailer.server.ts` sets it on every direct send from `getSupportChannels` (an explicit `replyTo` input wins). **Hygiene**: signed magic-link tokens are NEVER persisted in `NotificationLog.payload` (neither `*_url` vars nor pre-composed blocks embedding them); `notifications/promise.server.ts` `resumeReminderPromised` lets copy promise "we'll remind you first" only when the template and channel are actually enabled. Klaviyo segmentation-only metrics (no template rides them, no `cellexia_send`): "Cellexia Support Requested" (`dedupe: false`), "Cellexia Payment Method Updated" (shared with the template), "Cellexia Product Skipped Once" / "Product Skip Undone" / "Product Quantity Once", "Cellexia Pause Extended", "Cellexia Order Rushed", "Cellexia Routine Check-in Answered". |
| Analytics | `app/lib/analytics/` | Daily rollups, cohort LTGP (origin payment + renewals), the shared cost model (COGS/shipping/fees/VAT — `costs.server.ts`), censoring-corrected survival curves, churn risk with a self-training learned model (`learning.server.ts` — shadow-until-provably-better, survey features included since v1.21.0), predicted empty dates, per-subscriber predicted LTGP at d90/d180/y1/y3/y5 (`predicted-ltgp.server.ts` — tilted conditional survival × per-cycle margin, per-horizon honesty grades, frozen day-one predictions + the machine-written `ltgpAccuracy` ledger), five-model self-measuring forecasting with accuracy grades, take rate, alert scans, plain-language insights (`insights.server.ts`, imported directly — not via the barrel), and the segment layer (`segments.server.ts` + `segment-views.server.ts` — live filtered views by country/language/source/product/discount/device/value and, since v1.26.0, buy-box design/preselect; the isomorphic vocabulary lives in `segments-shared.ts` for route components). See [Analytics](#analytics). |
| Design measurement | `app/lib/design-measurement/` + `app/routes/app.buy-box_.results.tsx` + `app/components/design-results.tsx` | v1.26.0: the per-design take-rate and retention readout. `SubscribableOrder` fact table (one PII-free row per subscribable order: design seen, preselect, market, outcome, hygiene flags) written from ORDERS_CREATE and the nightly `design_facts_backfill`; the `_cellexia_seen` storefront property and its parser (`shared.ts`); the design calendar from published revisions (`ledger.server.ts`); the country-to-market cache `MarketCountryMap` (`markets.server.ts`); the write-once `originDesign*` subscriber stamp (`facts.server.ts`, retained through CUSTOMERS_REDACT by merchant decision); the scoreboard engine (`scoreboard.server.ts`, order-level metrics, kept rates behind a maturity gate, guardrails, 10-minute cache); the Buy box designer's **Results** tab and the `designMeasurement` settings group. v1.27.0 adds the VISIT side: the storefront beacon (`buy-box-embed.js` section 4, `GET /apps/cellexia-subs/w`) lands in `app/routes/proxy.w.tsx` (signature first, then always 204; LIVE gate, bot filter, token buckets) and writes the `WidgetVisitorDay` ledger through `visits.server.ts` (one row per anonymous visitor per shop-day per design and preselect; `visitSummary`, `pruneVisits`, `recomputeVisitMarkets`); the scoreboard joins visits on the same stamp as the facts and reports conversion per 100 visits, kept subscribers per 100 visits, a conversion-based guardrail basis and a compare-against-the-reference block. See [Design measurement](#design-measurement). |
| Acquisition capture | `app/lib/acquisition/` + webhook/sync handlers | Sanitized origin-order acquisition signals (`acq*` columns: source, UTM, geo, device, first-order shape) captured once per OURS contract; pure sanitizer (`sanitize.ts`) — never a raw IP or full user-agent; erased on GDPR redact. Contract: [docs/DATA_FOUNDATION.md](DATA_FOUNDATION.md). |
| Post-purchase survey | `app/lib/survey/` + `app/routes/api.survey.tsx` + `extensions/cellexia-survey/` | v1.21.0: four one-tap questions on the Thank You / Order Status pages (checkout UI extension, subscription orders only), POSTed with a verified session token to `/api/survey`; `SurveyResponse` rows keyed by ORDER (the thank-you page races the contract webhook) and linked to countable OURS contracts by the endpoint, the contract-create webhook tail (+ catch-up) or the daily `survey_link_sweep`. The instrument (question/option keys, `shared.ts`) is FROZEN per `questionSetVersion` — never edited in place; the extension bundles a mirror pinned by `tests/survey-instrument.test.ts`. Answers feed churn-risk features, predicted LTGP and the `survey.answered` → Klaviyo metric with the deterministic intervention holdout (`surveyHoldout`, `survey.holdoutPct`). |
| Shopify tagging | `app/lib/tagging/` | v1.23.0 (`tagging` settings group, ON by default): mirrors subscription state onto Shopify tags. Customer subscriber tag = membership recompute ("≥1 live ACTIVE/PAUSED billable non-demo contract" — ownership filtered in JS, NOT in the SQL where, so the REMOVAL side keeps working after an OURS→FOREIGN reclassification instead of stranding our tag on another app's customer), hooked at the END of `syncContractFromShopify` (every transition converges there — webhook echoes, backfills and the daily `full_sync_reconcile`, which re-converges every customer) plus `cancelContract` for same-request removal; each recompute runs under a per-(shop,customer) `pg_advisory_xact_lock` so racing webhook echoes with opposite verdicts serialize instead of a stale "remove" stripping a live subscriber. The `CustomerTagState` ledger (migration 0023) records the applied value so no-change recomputes cost zero Shopify calls, renames remove the byte-exact old tag, and removals only ever take back OUR tag. Order tags: first-order at the proven-ours contract-create tail (+ catch-up branch — never ORDERS_CREATE, which races the contract webhook and cannot decide ownership; a contract that mirrored UNKNOWN gets the missed tag healed by the sync that proves it ours), repeat-order in `finishSuccessSettlement` (shared by both claim winners; idempotent across redrives via a `taggedOrderId`-keyed event guard scoped to the contract's own events). Everything is contained (never fails a webhook/settlement/cancel), suppressed in SETUP (install-dark), skips redacted identities + uninstalled shops on BOTH paths, and is forward-only for orders. Settings-save fires `reconcileAllSubscriberTags` WITHOUT awaiting it (capped sweep, one `admin.action` summary in the Audit log). Pinned by `tests/tagging.test.ts`; the module is in the ownership-enforcement static scan. |
| Experiments | `app/lib/experiments/` + `app/routes/app.experiments.tsx` | v1.24.0: deterministic customer-level test groups. The arm is a pure sha256 hash of (experimentKey, lowercased email) — no RNG, recomputable offline; the unit is the CUSTOMER (email), never the contract (a two-contract customer must not be their own control — the per-contract-cooldown lesson). First exposure at the actual decision point freezes the arm into `ExperimentAssignment` (migration 0024; unique per shop+experiment+unit, `contractId` a convenience pointer with deliberately no FK), and readouts resolve arms exclusively from those rows — "was in the test" always means "the treatment actually diverged for them". Definitions (arms, shares, setting overrides, primary metric) live in code (`index.server.ts`); the `experiments` setting stores only enabled/started/stopped per key. Registry: `gift2_holdout` (**ON by default**, 12.5% `no_gift` arm — skips the cycle-2 surprise grant AND the teaser; it must exist from subscriber #1 or the control group can never be built), `final_offer_depth` (25 vs 20, off) and `winback_discount_depth` (20 vs 15, off) — the depth experiments overlay settings at their decision points via `settingOverride()`, with the stacking clamp applied after. Disabled/stopped experiments — and every failure — resolve to the control arm and record nothing. Every exposure logs `experiment.exposed`. The admin **Experiments** page (in the nav) shows per-arm scoreboards with honest sample-size grades (`too_early` < 30/arm, `direction_only` < 200/arm, `usable` above); the final judgment stays cohort LTGP. Pinned by `tests/experiments-kernel.test.ts`. |
| Admin UI | `app/routes/app.*` | Polaris pages: dashboard, analytics, subscribers, dunning, emails (catalog + sender model + brand kit + per-template editor with live preview/test send + sent log, v1.17.0), alerts, audit, debug (live self-checks), bulk ops, plans, gifts (rules + gift pool & pairings, v1.24.0), experiments (per-arm scoreboards + sample-size grades, v1.24.0), cancel-flow config, settings, import. **v1.28.0**: subscriber page — instrument-aware payment card (type, expiry, "Payment method removed {ago}" when `paymentMethodRevokedAt`), per vaulted method **Make primary** (`changePaymentMethod` trigger `admin`), "Backup set by {customer\|admin\|engine} on {date}" chip (the admin Select and the customer toggle write the same column), the card-update action reports which path `resolveCardUpdatePath` took ("Card-update URL ready" vs "Shopify emailed the customer a secure card-update link"), scheduled-cancel badge "Cancels {date}" + **Keep** (`keepScheduledCancel`) with the cancel button relabelled "Cancel now", a **Support requests** card (newest 5 `support.requested` events), the win-back reason; Alerts page links contract-scoped alerts (`SUPPORT_REQUEST`, `SUPPORT_SLA_BREACH`) to the subscriber; Cancel-flow page exposes every new `cancelFlow.*` knob (downsize / delay save / concierge hold / scheduled cancel / intent follow-up) and the outcome filter "Pending (concierge)"; Settings gains the **Support** and **Billing timing** sections (support fields format-refined at save with the resolver's own rules). |
| Buy box | `extensions/cellexia-buy-box/` | Theme app extension for the PDP, in two install shapes over one shared core snippet: a `section`-target app block, and (v1.2.0) a `body`-target **app embed** that self-mounts and patches JS cart requests for themes whose product section takes no app blocks. Since v1.27.0 the embed script also carries the **visit beacon** (`assets/buy-box-embed.js` section 4): `view` / `engage` / `atc` image requests to `/apps/cellexia-subs/w`, per design and preselect, with a random browser-local visitor id; measurement only, fully contained, never sent in admin preview, in the theme editor (`Shopify.designMode`) or while the widget is hidden. Theme-block-only installs get no visits (the block has no beacon). |
| Widget design | `app/lib/widget/` | Buy-box design system: preset catalog + zod config schema + customCss sanitizer + text resolution (`presets.ts`, isomorphic — the admin designer imports it client-side), revision store / publish-to-metafield / restore (`design.server.ts`; since v1.26.0 revisions carry an optional merchant-given `label`, and a publish nudges the design-measurement engine: market map refresh + scoreboard cache clear, contained). Edited from the admin **Buy box designer** page. Also the storefront projections that ride beside the design: per-variant default frequencies (`variant-defaults.server.ts`, `cellexia.variant_defaults`) and, since v1.25.0, market visibility (`widget-markets.server.ts`, `cellexia.widget_markets` — the `widgetMarkets` setting's mirror, owned by Preview & launch "Where the buy box shows"; see [Launch & preview](#launch--preview)). |
| Launch & preview | `app/lib/launch/` | Install-dark launch mode (SETUP/LIVE), storefront PREVIEW tokens, go-live with ownership re-classification + overdue stagger; the gates live in jobs/notifications/Klaviyo/portal/buy box (see below). |
| Debug / self-check | `app/lib/debug/` | Live self-check engine behind the admin **Debug** page: 44 read-only checks against the deployed store (billing pipeline, dunning, portal-through-proxy, webhooks, jobs, notifications, config, data integrity), each contained doctor-style with detail + named fix. Since v1.22.0 the sweep also proves the live-store shapes local debugging cannot see: the buy box actually on a real plan product's PDP and gated exactly per launch mode (`storefront_widget`, reusing the Preview Doctor's markers), ACTIVE contracts the billing sweep can never select (`renewal_readiness` — null `nextBillingDate`), dunning-ladder steps the exhaust cutoff makes unreachable (`dunning_config`), JobLock leases no code path could have written (`job_locks`, threshold imported from the runner's `LOCK_LEASE_MS`), the Klaviyo key live-probed against Klaviyo (`klaviyo_key_live` — `probeKlaviyoKey`'s `transient` flag keeps network blips WARN), the cached flow-coverage verdict surfaced every tick (`klaviyo_flow_coverage`, reads `klaviyoFlowSetup` — never spends the daily API budget), every email template rendered through the REAL `renderEmail` with the merchant's stored overrides + design (`email_templates` — a throw is a send-time failure, a stray `{placeholder}` reaches the customer), stored credentials still decryptable (`stored_secrets` — the silent APP_SIGNING_SECRET-rotation fallback made visible), and contract-scoped events that lost their contract link (`event_provenance`). v1.24.0 adds `gift_promises` — the configuration drift behind the gift truth gates (the engines gate their sends silently at runtime; a promise quietly suppressed for everyone — surprise setting with no ORDER_INDEX=2 rule, an empty pool that dynamic rules / the day-90 reward / the gift save / the ladder depend on — surfaces here as a WARN instead of nowhere). v1.25.0 adds `widget_markets` — the market-visibility setting ⇄ `cellexia.widget_markets` metafield agreement (`widgetMarketsDiverged`) plus an audit of the saved handles against the live market list (`auditSelectedHandles`: WARN on a deleted/disabled market, FAIL when none is live = hidden everywhere; unreadable list = note) — and teaches `storefront_widget` to read the market-hidden marker before judging the launch gate AND to FAIL the inverse drift (widget rendered on the primary market the setting excludes = extension not deployed / stale metafield). v1.26.0 adds `design_facts` (Data integrity): the whole-history count of `checkout.subscribable` events against the `SubscribableOrder` fact table (whole history on purpose: the event is stamped when the webhook lands while the row carries the order's `processed_at`, so any windowed comparison produces false gaps at the edge), WARN when facts lag (the nightly `design_facts_backfill` is the fix), with a seen-coverage note over the last 30 days' rows. v1.27.0 adds `widget_visits` (Data integrity): PASS while the store is not LIVE, PASS when any `WidgetVisitorDay` row was touched in the last 7 days or when no order with widget exposure landed in that window, WARN when a LIVE store has exposure orders in the last 7 days and zero visit rows (extension not deployed, app embed disabled, or the beacon blocked; conversion per design cannot be computed until visits arrive). v1.28.0 adds `portal_a11y` (Customer portal): a static in-process render of the portal shell asserting the accessibility contract (token contrast ≥ AA, focus-visible, reduced motion, skip link, live-region toasts, inline confirms) — WARN on regression, never FAIL (the portal still works); `payment_update_path` (Dunning): live ACTIVE / PAUSED / FAILED contracts with a payment method but no mirrored `paymentInstrumentType` (0027 rows not yet refreshed by a webhook / sync) — WARN with the count, because their "Update card" surfaces still probe the Shop-Pay-only hosted page before falling back to Shopify's update email, PASS when every live contract is decided without probing (revoked primaries noted); `delivery_tracking` (Data integrity): renewal orders fulfilled in the last 14 days (`fulfilledAt`, written by `orders/fulfilled` which predates the mirror) with neither a tracking url / number nor a delivered stamp — WARN "fulfillment topics not deployed" when no fulfillment-topic receipt landed in the window, WARN "no tracking attached" when they did (the store ships without tracking), PASS otherwise. Runs every 30 min (`selfcheck_run`, ungated), persists to the machine-written `selfCheck` setting, keeps the deduped CRITICAL `SELF_CHECK_FAILED` alert in sync (raised while broken, auto-resolved on recovery). |
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
  `onBillingAttemptChallenged(attemptId, redirectUrl?)` — `~/lib/dunning/engine.server.ts`;
  since v1.28.0 also `onPaymentMethodUpdated(contractId)`, `requestCustomerRetry`,
  `onCycleSkipped` / `onCycleDelayed` (case reconciliation)
- Contract services added in v1.28.0 (same file, same shape): `changePaymentMethod`,
  `setBackupPaymentMethod`, `skipLineThisCycle`, `unskipLineThisCycle`,
  `setLineQuantityThisCycle`, `delaySchedule`, `revertDelayedCycle`, `pauseUntil`,
  `extendPause`, `sendNextOrderTomorrow`, `setDeliveryInstructions`, `swapPriceCentsFor`
- Charge timing (v1.28.0): `resolveChargeTiming(shopId)`, `chargeMomentUtc` / `chargeMomentUtcSync`,
  `editCutoff` / `editCutoffSync`, `dueBeforeUtc`, `isChargeDue`, `isPreparingOrder`, `preparingOrderDate` — `~/lib/billing/timing.server`
  (the sweep, the portal, magic/SMS and the reminder read the same instant)
- Next-order estimate (v1.28.0): `estimateNextCharge(...)` — `~/lib/billing/estimate.server`
  (THE money figure for every next-order surface; the reminder is built on it)
- Card-update path (v1.28.0): `resolveCardUpdatePath(...)` — `~/lib/payments/cardUpdate.server`
  (every "update your card" surface — portal, magic, SMS, admin — decides through it)
- Support channels (v1.28.0): `getSupportChannels(shopId)` — `~/lib/support/channels.server`
  (every "reach a human" line and every Reply-To resolves through it; never throws)
- Win-back offer (v1.28.0): `deriveCurrentWinbackOffer` — `~/lib/winback/restart.server`;
  `buildRestartUrl` (link minting) — `~/lib/winback/links.server`
- Gifts: `ensureGiftsForUpcomingCycle(contractId, cycleIndex)` — `~/lib/gifts/engine.server.ts`
- Gift picker (v1.24.0): `pickGiftForContract(opts): Promise<PickedGift | null>` —
  `~/lib/gifts/picker.server` (gift engine, lifecycle rewards, cancel-flow GIFT
  save and win-back perk all call it; null means "use the fixed fallback",
  never throws)
- Experiments (v1.24.0): `assignedArm`, `settingOverride`, `surpriseGiftArmFor`
  — `~/lib/experiments/index.server` (call only at the decision point where
  treatment actually diverges; failures resolve to the control arm)

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
  `pre_expiry_notices`, `lifecycle_run`, and since v1.28.0
  `cancel_scheduled_run`, `cancel_intent_followup_run` — the post-exhaustion
  touches and the week-N check-in ride inside `dunning_run` / `lifecycle_run`
  and share their gate) log a SUCCESS `JobRun` with stats
  `{skipped:"setup_mode"}` without touching a contract. Ungated jobs
  (analytics rollups/cohorts/churn risk, `risk_learning_run`,
  `predicted_ltgp_run`, `survey_link_sweep`, `origin_order_backfill`,
  `design_facts_backfill` (v1.26.0, daily: rebuilds missing
  `SubscribableOrder` design facts from the event feed, joins them to
  contracts, stamps `originDesign*`, refreshes the country-to-market map;
  since v1.27.0 also maps visit rows to markets and prunes the visit ledger
  past 400 days),
  `cancel_session_gc`, `concierge_sla_run` (v1.28.0: alerts + session
  outcome promotion, no customer contact), `stale_attempt_sweep`,
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
(own-variant matches only; anything else passes through byte-identical). Since
v1.26.0 the same patch also stamps the exposure property `_cellexia_seen`
(`<preset>|s|o|u`, see [Design measurement](#design-measurement)) on every
add of OUR product's variants while the widget is visible: a one-time add
carries `_cellexia_seen` only, a subscription add carries `selling_plan`,
`_cellexia_design` and `_cellexia_seen`; foreign variants and foreign-plan
lines stay byte-identical, and a hidden or gated widget stamps nothing. If
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
on one-time). Since v1.26.0 that last clause reads: a one-time add of our
product carries `_cellexia_seen` and nothing else, a subscription add carries
all three, and foreign lines stay byte-identical in both modes. Its vacuity guards put the defect back — the bare pre-rename
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

**Market visibility (v1.25.0).** "The app is live, but the buy box only shows
in these Shopify Markets." A per-market filter ORTHOGONAL to the launch mode:
the settings key `widgetMarkets` (`{ mode: "all" | "selected", handles }`,
default `all`; a SEPARATE key on purpose — every `launch` field is required,
so a new field there would make existing LIVE rows fail to parse and fall
back to SETUP) mirrored into the shop metafield `cellexia.widget_markets`
(`json`, `{"v":1,"mode":…,"handles":[…]}`; module
`app/lib/widget/widget-markets.server.ts`). Owned by the **Preview & launch**
card "Where the buy box shows" (never the generic Settings page). The Liquid
(top of `cx-buybox-core.liquid`, BEFORE ownership) reads the metafield and
shows the widget for anything but byte-exact `mode == 'selected'`; under
`selected` it shows only where `handles contains localization.market.handle`
— plain Liquid array `contains`: EXACT element equality, no trim, no case
folding, blank/absent handle fails closed. So ABSENT ⇔ every market and
neither install nor go-live syncs it. An excluded market renders ONLY an
inert hidden `<template … data-cellexia-market-hidden
data-cellexia-diag-market="<handle>">` — no widget markup, no JSON island, no
`data-cellexia-gated` (a gated widget would be revealed by any admin preview
link and would trip the self-check's "still gated" FAIL), and deliberately
NOT `data-cellexia-no-owned-group` (so the "plans from another app" storefront
diagnostic can never fire on a market the merchant hid); market-hidden wins
over both no-owned-group and the launch gate, and the metafield-absent render
is byte-identical to v1.24.0. Save contract = goLive's: setting first, then
metafield, ROLLBACK + friendly error when the write fails; `selected` with
zero handles is refused (hidden everywhere is never what a merchant meant —
that is Revert to setup), handles are validated against the live `markets`
list, and every save logs `admin.action` / `widget_markets_saved` (with
`previous`). Detection: `widgetMarketsDiverged()` mirrors the Liquid rule
(absent ⇔ all; `selected` lists as exact-string sets; unparsable/wrong-shape
= drift) behind the page's re-sync banner and the `widget_markets` self-check;
the Preview Doctor's `storefront_markup` reports a market-hidden page as WARN
tagged `code: "market_hidden"` (WARN never blocks the preview; the primary
domain it probes may simply be an excluded market) whose WORDING is judged
against the setting like the self-check's — excluded by the merchant → "by
your market setting … add it under Where the buy box shows"; allowed by the
setting → "the storefront hides the buy box … but your setting allows it —
Re-sync" (drift); unreadable setting → neutral. The `preview-storefront`
action treats that tag like the other un-vetted opens: the tab still opens,
the WARN detail is returned as the toast, `previewedStorefront` is NOT ticked
and the `storefront_preview_created` event records `marketHidden: true` (a
market-hidden page raises no storefront diagnostic — no gated root, no
no-group marker, so `previewBoot()` never validates the token). The
`storefront_widget` self-check judges the marker against the setting
(excluded → PASS, allowed → FAIL "re-save") AND the inverse: a primary-domain
page that renders the widget (`data-cellexia-buybox` /
`data-cellexia-no-owned-group` — both only render once the Liquid's market
gate passed) while the setting excludes the primary market (`listMarkets`,
`primary`) FAILs "extension probably not deployed / metafield stale" — the
only detector for a ZIP applied without `npm run deploy` (setting ⇄ metafield
still agree; the rendered widget carries no version or market stamp). Draft
markets: `listMarkets` now returns `enabled` (Admin API `Market.enabled`;
missing → true) and keeps disabled markets flagged rather than dropped; the
picker badges them "Disabled — no visitors" and `auditSelectedHandles()`
(isomorphic) splits a saved list into live / disabled / missing — the
`widget_markets` self-check WARNs on any disabled/missing handle and FAILs
when no saved handle is a live market (hidden everywhere with setting and
metafield in agreement); an unreadable market list is a note, never a
verdict. Subscription-only products (`requires_selling_plan`) are hidden in
an excluded market like any other — deliberately unbuyable there (no
`selling_plan` reaches the theme form); the card copy and OPERATIONS §14 say
so, and `tests/liquid/market-visibility.test.ts` pins that render. The
designer only reads the setting (Preview market select "— hidden" + banner,
"Disabled" badge on draft markets). Pinned by
`tests/liquid/market-visibility.test.ts`, `tests/widget-markets.test.ts`,
`tests/preview-doctor.test.ts` and `tests/selfcheck.test.ts`.

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
empty list on API failure without touching saved entries. Per-market
*visibility* is a different, orthogonal rule — the Preview & launch setting
`widgetMarkets` / metafield `cellexia.widget_markets` (v1.25.0, see
[Launch & preview](#launch--preview) "Market visibility"): a market entry
here still saves for an excluded market and applies the moment it is added
back; the designer's Preview market select merely labels such markets
"— hidden".
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
design on the order. `getDesignPerformance`
(`app/lib/analytics/queries.server.ts`) still aggregates those into a share
of attributed subscription orders per design, but since v1.26.0 the designer
no longer shows it: the bottom "Design performance" card is gone and the
**Results** tab (next section) reads take rate, kept rates and LTGP per
design from the `SubscribableOrder` fact table instead. **Design names**
(v1.26.0): the publish dialog takes an optional name, stored as
`WidgetDesignRevision.label` (`normalizeDesignLabel`, 80 chars, whitespace
collapsed); `restoreRevision` carries the source's label onto the copy so a
restored design keeps reading under one name in the history and the Results
tab. A successful publish also fires two contained, fire-and-forget hooks
(`afterPublishHooks` in `design.server.ts`): `refreshMarketCountryMap` and
`invalidateScoreboardCache`, because a publish is exactly what changes the
design calendar the readouts resolve against.

## Design measurement (v1.26.0, visits v1.27.0)

<a name="design-measurement"></a>

`app/lib/design-measurement/` answers one merchant question the event feed
never could: **per buy-box design, and per "was subscription preselected",
what share of subscribable orders subscribed, and did those subscribers
stay?** Before v1.26.0 the only per-design signal was `_cellexia_design`,
stamped on subscription adds alone, so a design had a numerator and no
denominator. v1.27.0 adds the second denominator: **exposed visits**, so the
same rows also answer "how many orders and subscriptions per 100 visitors
who saw this design". The module is read-side derivation plus two fact
tables (orders and visits); every entry point is contained by its caller
(Golden rule 9), nothing here touches billing, and every write is
idempotent.

**The `_cellexia_seen` carrier.** Both storefront writers (`buy-box.js` for
theme forms, `buy-box-embed.js` for formless AJAX themes) stamp a second
hidden line property `properties[_cellexia_seen]` = `<preset>|<p>` with `p`
in `s` (subscription preselected on the rendered widget), `o` (one-time
preselected) or `u` (unknown), on EVERY add-to-cart of our product's variants
while the widget is visible, one-time and subscription alike; `_cellexia_design`
keeps its exact old meaning (subscription adds only). Foreign variants and
foreign-plan lines are never touched, an existing non-empty seen value is
never overwritten, and the launch/market write gate applies unchanged (a
hidden widget stamps nothing). `getState()` exposes `preselect` and the
`cx:buybox:change` detail carries it. `shared.ts` (isomorphic, no server
imports) owns the property name (`SEEN_PROPERTY`), the parser
(`parseSeenValue`, sanitizing the key to `/^[a-z0-9_]{1,40}$/` because a
line property is buyer-writable input) and the display formatters. The
ORDERS_CREATE handler lifts the raw value off every line (`seenPropertyOf`)
and adds the distinct values as `seen: [...]` to the `checkout.subscribable`
payload (additive; it is what lets the nightly backfill rebuild a fact from
the event alone).

**`SubscribableOrder`, the fact table** (migration 0025; column contract in
[DATA_FOUNDATION.md Part 4](DATA_FOUNDATION.md#part-4)). One PII-free row per
subscribable storefront order, keyed `(shopId, orderId)`, written by
`recordSubscribableOrder` (`facts.server.ts`) from ORDERS_CREATE for every
`containsSubscribable` order (the dedupe of the `checkout.subscribable`
event is a decision now, not an early return, so a redelivery repairs a
missing fact) and by the nightly backfill from the event feed. The row
carries what the shopper saw (`designKey`, `designPreselect`,
`designRevisionId`, `designSource`, `calendarDesignKey`), the outcome
(`subscribed`, `contractId`, `subscribedAt`, `hasSellingPlanLine`), the
context the readouts split on (`marketHandle`, `countryCode`,
`currencyCode`, `deviceType`, `sourceName`, `orderTotalCents`, `units`) and
the hygiene flags a per-design readout must disclose: `promo` (any discount
code or discount application), `mixed` (several designs stamped, or our
product bought both as subscription and one-time in one order), `transition`
(a publish within 24h before the order, `isTransition`), `staff` (checkout
email in `designMeasurement.excludeEmails`, computed at write time,
re-stamped right away when the Results tab saves the email list
(`recomputeStaffFlags`) and again nightly; the email itself is never
stored), `ownership` of the
plan lines (`ours` / `foreign` / `mixed` / `none`, from `getOwnPlanIdEvidence`;
when our own plan-id set is known to be incomplete an unmatched plan is not
declared foreign) and `exposure` (any widget-stamped property on any line).
**Resolution ladder** (`chooseDesign`, best evidence first, recorded in
`designSource`): `seen` (`_cellexia_seen` on any of our lines; the
subscription line of OUR plan wins when lines disagree) → `design_prop`
(`_cellexia_design` only: pre-v1.26.0 extension or a lost seen value;
preselect borrowed from the calendar when it names the same design) →
`calendar` (no widget property at all: the design the ledger says was live
for the order's market at `processedAt`) → `none`. The calendar rung is
withheld when exposure was structurally impossible (`calendarRungAllowed`):
the store was in SETUP, or the order's market is excluded by `widgetMarkets`
(an unknown market fails open); such rows stay `none` and land in the
scoreboard's no-exposure bucket, while `calendarDesignKey` still records
what the ledger would have said, for the agreement audit. On UPDATE the
writer never touches `subscribed` / `contractId` / `subscribedAt`: those
belong to `linkContractDesign`.

**The write-once subscriber stamp.** `linkContractDesign(shopId, contractId)`
joins fact and contract for a COUNTABLE contract (`isDemo:false`, ownership
OURS) that has an `originOrderId`: it marks the fact `subscribed=true` /
`contractId` / `subscribedAt` (`firstChargeAt ?? createdAt`) and stamps the
contract's `originDesignKey` / `originDesignPreselect` /
`originDesignRevisionId` / `originDesignSource` / `originDesignStampedAt`
exactly once (an `updateMany ... where originDesignStampedAt: null`, so two
racing callers cannot both win). It is called from the contract-create tail,
the UPDATE catch-up branch, ORDERS_CREATE when the contract mirror already
exists (the webhook race), and the nightly backfill; all four contained.
When no fact row exists the stamp falls back to `widget.design_attributed`
events, then the calendar, then `none`, but only once the contract is older
than `LINK_NO_FACT_GRACE_MS` (48h), so a contract webhook that lands seconds
before its order webhook does not burn the write-once slot on a guess.
`originDesign*` are **deliberately outside the `acq*` family and retained
through `CUSTOMERS_REDACT`** (merchant decision v1.26.0: a design label is a
property of the checkout, not of the person, and LTGP by design must survive
a redact); the anonymizer carries a comment saying so, and
[DATA_FOUNDATION.md](DATA_FOUNDATION.md) records the exception.

**The design calendar** (`ledger.server.ts`) is derived, never stored: from
the published `WidgetDesignRevision` rows (`publishedAt` not null, oldest
first) it answers "which design was live at instant T for market M" with the
storefront's own rule, `config.markets[handle]?.preset ?? config.preset`,
and reads the preselect from `config.behavior.preselect` (`subscription` →
`sub`, `one_time` → `one`, `inherit` → `sub` for `subscription_ultra_max`
whose frame forces the subscription first, else unknown). `getDesignCalendar`
renders one period per market (or default) per contiguous stretch, newest
first, capped at 200; consecutive publishes that leave a market's preset,
preselect and label unchanged merge into one period, and a relabelled
republish opens a new one on purpose (naming a design is how the merchant
marks a new test). `isTransition` flags orders within 24h after a publish.
Orders carry a country, not a market, so **`MarketCountryMap`**
(`markets.server.ts`) caches Shopify's Market regions (Admin API 2025-01
`markets { handle enabled primary regions { ... on MarketRegionCountry { code } } }`;
enabled markets only, primary first, a country in two markets keeps the
first); refreshed after every publish and by the nightly job, contained, and
an empty answer never wipes a working map. A missing entry degrades to
`marketHandle = null` (the default design), never to an error.

**The visit ledger (v1.27.0).** `WidgetVisitorDay` (migration 0026, column
contract in [DATA_FOUNDATION.md Part 4](DATA_FOUNDATION.md#part-4)) holds
one row per anonymous visitor per shop-timezone day per (design key,
preselect), unique on `(shopId, day, vid, designKey, designPreselect)`, with
a `views` count and three booleans (`engaged`, `addedToCart`,
`addedSubscription`) plus the context the scoreboard splits on
(`countryCode`, `marketHandle`, `deviceType`). It is written by the
**storefront beacon** in `buy-box-embed.js` (section 4 of the file; the
theme block has no beacon, so a theme-block-only install records no
visits): a `GET /apps/cellexia-subs/w?…` image request (`new Image().src`;
the original `fetch(keepalive, no-cors)` only when `Image` is missing; never
awaited, every entry point wrapped) fired at most once per page load per
(design|preselect) for each of three events: `e=view` once a widget root
(`.cx-buybox[data-cellexia-buybox]`) has been at least half in the viewport
for a full second (IntersectionObserver at threshold 0.5 with a 1,000 ms
dwell timer; without IO, 1,500 ms after boot if `getState()` is non-null),
`e=engage` on the first pointerdown / click / keydown / change inside a root
or the ultra-max satellite (document-level capture listeners), and `e=atc`
from the fetch / XHR cart-request patch whenever the intercepted `/cart/add`
body targets one of our variants, whether the patch injected the stamps or
found them already there (`bodyTargetsOurs`: a theme that serialises an
already-stamped product form and sends it without a submit event; a foreign
variant never counts; `m=s` when the subscription option is selected, else
`m=o`) and from a capture-phase `submit` on a `/cart/add` form carrying an
enabled `properties[_cellexia_seen]` input (theme-form installs; `m` from
the widget's mode). Common params: `d` (design), `p` (`s|o|u`), `v`
(variant id), `c` (`Shopify.country`, ISO-2 or empty), `cur`
(`Shopify.currency.active` or empty), `dv` (`m|t|d`: width < 768 mobile,
< 1024 or coarse pointer tablet, else desktop), `vid` (visitor id), `pv`
(8-char page-view id), `t` (`Date.now()`). The visitor id is 16 URL-safe
characters from `crypto.getRandomValues` (else `Math.random`; a browser-local
anonymous id, not an experiment assignment, so the kernel's no-RNG rule does
not apply), kept in `localStorage["cellexia_vid"]`, then `sessionStorage`,
then per page, validated on read against `/^[A-Za-z0-9_-]{8,32}$/`. The
beacon is skipped entirely (no observer, no listeners) when the page URL
carries `cx_preview=` (admin preview) or when `Shopify.designMode === true`
(the theme editor's preview frame: the merchant clicking through designs is
not a shopper, and without this gate every editing session would add
zero-order visits to exactly the design being edited), and per event
whenever `getState()` is null (widget hidden, gated, absent); the cart
stamps keep working in all three cases. It carries no personal data, sets no
cookie and needs no consent gate (merchant decision, v1.27.0). Byte budget:
the beacon added about 20 KB to the embed (73,998 bytes at v1.27.0 against
the 114,688 ceiling enforced by `tests/liquid/size-limits.test.ts`).

The route `app/routes/proxy.w.tsx` (`/apps/cellexia-subs/w` through the app
proxy, i.e. `/proxy/w`) runs `authenticate.public.appProxy` FIRST and
outside the containment (an unsigned request gets the library's rejection
like every proxy route); everything after that is in a try/catch and the
only answer is **204 No Content, `Cache-Control: no-store`**, never a 4xx
or 5xx to a shopper's browser. Gates in order: `parseVisitBeacon`
(`e` in view|engage|atc, `d` through `sanitizeDesignKey`, `p` in s|o|u
mapped to `sub|one|u`, `vid` against the id grammar; `c` must be
`/^[A-Z]{2}$/` else null, `dv` mapped to mobile|tablet|desktop else null,
`m` read on atc only; `v`, `cur`, `pv`, `t` are transport-only and ignored);
a bot filter on the forwarded User-Agent (`VISIT_BOT_UA_RE`, three groups:
generic crawler words `bot|robot|crawler|crawl|spider|slurp|preview` only as
whole tokens, so "Robot Framework" is a bot but the phone "CUBOT" and
"Robotics" are not; tool prefixes `headless|lighthouse|pingdom|facebookexternalhit`
where a product name continues; and a named-crawler list, googlebot,
bingbot, yandexbot, baiduspider, duckduckbot, applebot, semrush, ahrefs,
petalbot, slackbot, twitterbot, discordbot, linkedinbot, telegrambot,
whatsapp, bytespider, gptbot, claudebot, ccbot, amazonbot, mj12bot, dotbot,
seznambot, ia_archiver; a bare `yandex` is deliberately NOT listed because
YandexSearch is a shopper's mobile browser); two in-module token buckets, per `shop:vid` (60 per minute) and per shop
(3,000 per minute), continuous refill, idle keys swept each minute,
per-instance state (N instances multiply the effective limit; a defence
against a runaway tab, not a security boundary); then the shop
(`requireShop(session.shop)` when the proxy names one, else
`getPrimaryShop()`) and the launch mode, which must be LIVE (verdict cached
in-module for 60 s per shop); then `marketHandleForCountry` and
`recordVisit`. `recordVisit` (`visits.server.ts`) upserts on the unique
key with `day = visitDayKey(now, shop.ianaTimezone)`: `view` increments
`views` (created with 1), `engage` sets `engaged`, `atc` sets `addedToCart`
and, for `m=s`, `addedSubscription`; `engage` and `atc` create the row with
`views 0` when no view landed first (beacon order is not guaranteed), every
event refreshes `lastSeenAt`, and the identity columns (country, market,
device) are written on create only. Readers: `visitSummary(shopId, {since,
until, marketHandle, tz})` groups by (designKey, designPreselect, day) into
`visits` (row count = distinct visitors), `views` (sum), `engaged`,
`addedToCart`, `addedSubscription` (rows where true); `lastVisitAt` (top-1
by `lastSeenAt`); and two unscoped presence readers over the same shop-tz
day range, `hasVisits(shopId, {since, until, tz})` (one indexed probe on
`(shopId, day)`, any market, any design: the scoreboard's "recorded" fact)
and `firstVisitDay(...)` (earliest day key with a row). Indexes: the unique
key, `(shopId, day)`, `(shopId, designKey, day)` and `(shopId, lastSeenAt)`
(the last one carries `lastVisitAt` and the self-check's since-count without
sorting the ledger). Maintenance from `design_facts_backfill`: `recomputeVisitMarkets` (rows
with a country and a null market, oldest first, capped 5,000 per run,
skipped when the market map is empty; run inside the flags step, contained
on its own) and `pruneVisits` (rows whose day key is older than
`VISIT_RETENTION_DAYS` = 400, computed in the shop timezone; its own last
step, `prune_visits`). Nothing on the visit path invalidates the scoreboard
cache: a beacon per page view would defeat it, and the readout may be up to
10 minutes stale by contract.

**The scoreboard engine** (`scoreboard.server.ts`, pure types and the one
statistic in `types.ts`) is what the Results tab reads. Population: the
shop's fact rows in range (a trailing 30/90/365-day window that never
reaches behind `designMeasurement.startedAt`, or everything since that date)
with `staff = false`; foreign-only rows (`ownership: "foreign"`) are excluded
and counted in `excludedForeignOnly`; rows with no exposure and
`designSource: "none"` form one synthetic **no_exposure** row so bypass volume
stays visible; rows with exposure but no resolvable design (or a design key
colliding with a reserved synthetic key) form the synthetic **unknown** row.
Grouping is by variant (`design|preselect`), by design or by revision.
Per row, order-level metrics: `takeRatePct` = subscribed ÷ orders; kept
30/60/90 behind a **maturity gate** (only orders with `processedAt + N days
≤ now` enter horizon N; a subscriber is kept when its contract's churn end,
`churnEndOf` shared with the cohort engine, is null or after that instant;
the rate's denominator is the mature subscribed orders); quick cancels at
14 days; one-time share; LTGP per subscriber at M3/M6/M12 through the
IDENTICAL cohort engine (`computeCohortRows` + `summarizeLtgp` over the row's
contract ids); AOV; a sample grade (`too_early` < 30 orders,
`direction_only` < 200, else `usable`); ISO weeks in the shop timezone; and
the hygiene counts. **Guardrail rule** (`computeGuardrailVerdicts`): the
reference is the real row with the most orders; only whole weeks with orders
qualify (the current week and a leading partial week never do); the
reference must have two qualifying weeks averaging at least
`guardrailMinOrdersPerWeek`, else every verdict is `insufficient`; a row is
`breach` when its mean weekly orders sit more than `guardrailMaxOrderDropPct`
below the reference AND at least two of its weeks each breach, `watch` above
half the tolerance, else `ok`. `probabilityBetterThan` (Beta(1,1) priors,
numeric integration) is the "chance it beats the reference" the client
computes. Cache: a module Map keyed by `(shopId, rangeDays, marketHandle,
groupBy)`, TTL 10 minutes, `fresh` bypasses; `invalidateScoreboardCache(shopId)`
is called after fact writes, after a publish and after a settings save
(never by the visit path).

**Visits, conversion, comparison and the guardrail basis (v1.27.0).** The
engine reads `visitSummary` through a lazy, contained import (`loadVisits`:
a missing module, a thrown read or a shape surprise all yield null and can
never blank the order-side readout) over the same range and market as the
facts, and joins each summary row onto a scoreboard row **by the same stamp
the facts carry**: `designKey|preselect` for variant grouping (a stored
`u` joins the `unknown` preselect), `designKey` for design grouping, and
for revision grouping the ledger revision live on that day for the queried
market (`revisionForVisitDay`: candidates are the revision live at day start
plus every revision published during the day; the last one whose design for
the market equals the visit's design key wins, else the one live at day
end; when the ledger cannot be loaded, revision rows read visits null).
Reserved design keys join nothing; synthetic rows (no_exposure, unknown)
always have `visits: null`. "Recorded" is an UNSCOPED presence fact: the
shop has at least one visit row in the day range, in any market and for any
design (`hasVisits`; falls back to the unscoped summary when that reader is
unavailable), so a market filter whose visits are still unmapped (country
not in the market map yet) reads zeros with `totals.visitsRecorded: true`,
never "not recorded". `VariantRow.visits` is `null` for every row when the
shop is not recorded (beacon not deployed, app embed disabled) or the scoped
read failed, and the UI says "visits not recorded yet"; once recorded, a
real row with no matching visits reads zeros. A design with visits but no
order yet still gets a row (0 orders, N visits) so a freshly published
design shows as live and seen. Rows sort by orders, then visits, then key;
the weekly axis starts at `since`, else at the earliest fact OR visit.
**Time alignment**: the beacon usually goes live after the first order, so
the conversion numerators are NOT the row's whole-range orders. Facts are
tallied per shop-tz day inside each bucket, and only the days in the
shop-wide covered-day set (days with at least one visit row for the shop,
any design, any market: the same set behind `visitCoverageDays`, from the
unscoped summary on market-scoped queries) are summed into
`ordersCounted`, `subscribedCounted` and `keptCounted`; take rate and the
kept rates keep counting every order. Per row `conversion`
(`ConversionBlock`; the per-100 rates keep 2 decimals because 0.26 vs 0.34
kept subscribers per 100 visits is a 31% difference one decimal would erase,
the two share percentages keep 1; null when the denominator is 0 or visits
are null): `ordersPer100Visits` = ordersCounted ÷ visits,
`subscriptionsPer100Visits` = subscribedCounted ÷ visits, `addToCartPct`
(visitor-days that added ÷ visits), `subscriptionPickPct` (addedSubscription
÷ addedToCart) and `keptSubscribersPer100VisitsD30` = keptCounted ÷
`maturedVisits`, where BOTH sides mature on the same day rule (the whole
shop-tz day is at least 30 days old: day end + 30 days ≤ now; `keptCounted`
is the subscribed orders of covered, matured days whose contract was still
live 30 days after the order, which differs from `held.d30.heldSubscribed`,
matured by the order instant, and `maturedVisits` is the row's visits on
matured days), the one number that combines conversion and net take rate.
The counted numerators, `maturedVisits` and `firstVisitDay` (first covered
day in range) ride along so the UI can print "N counted since <day>" and
recompute the digits from raw counts. Weekly buckets gain `visits`
(visitor-days whose day key falls in the ISO week). Totals gain `visits`
(market-scoped like the rows), `visitsRecorded` (the unscoped presence
fact), `visitsUnscoped` (visitor-days across every market; null when that
read was unavailable), `visitCoverageDays` (shop-wide days with at least one
visit row ÷ days in range, plus the two counts `visitDaysCovered` /
`visitDaysInRange`) and `lastVisitAt`. **Guardrail basis**:
`computeGuardrailVerdicts` runs the identical rule twice; the `orders` basis
(weekly raw orders, the v1.26.0 rule; a week qualifies with orders > 0) is
always present per real row, and the `conversion` basis (weekly orders per
100 visits, 2 decimals in the wording) is present, listed first and read by
the UI as the primary verdict, only when the reference is judgeable on
orders AND both the reference and the row have at least two whole weeks
with visits > 0. On the conversion basis a week qualifies on VISITS, not
orders: a whole week with traffic and zero orders contributes 0 per 100 (it
is the collapse the guardrail exists to catch); the floor stays on the
reference's weekly ORDERS for both bases. `GuardrailVerdict.basis` says
which. **Comparison** (`computeComparison`, pure, still shipped as
`scoreboard.comparison` although the v1.27.0 Results tab computes its own
card client-side, see below): every real non-reference row against the
reference (the real row with most orders): deltas row minus reference in
points from the UNROUNDED ratios of the raw counts, rounded once to 2
decimals (`conversionPts` and `subscriptionConversionPts` from the
time-aligned `ordersCounted` / `subscribedCounted` over visits,
`takeRatePts`, `kept30Pts`, `keptPer100VisitsD30` from keptCounted over
maturedVisits) and `chance` from `probabilityBetterThan` over the same raw
counts, null when either side lacks a denominator; `[]` with fewer than two
real rows.

**Admin surface.** The Buy box designer's fifth tab, **Results**
(`app/components/design-results.tsx`, client-only, mounts lazily and fetches
through `useFetcher`), talks to the resource route
`app/routes/app.buy-box_.results.tsx` (escaped flat name: URL
`/app/buy-box/results`, NOT nested under the designer, so neither loader
re-runs for the other; `Cache-Control: no-store`). GET takes `range`
(30|90|365|all), `market`, `group` (variant|design|revision) and `fresh`;
POST intents `save-measurement-settings` and `save-sessions` write the
**`designMeasurement` settings group** (`startedAt`, `excludeEmails`,
`guardrailMaxOrderDropPct` default 10, `guardrailMinOrdersPerWeek` default
20, `weeklySessions` keyed by ISO week; edited only from this tab, never from
the generic Settings page), log `admin.action`
`design_measurement_settings_saved` and clear the cache. The tab shows the
scoreboard with a reference chooser, guardrail verdicts and the editable
thresholds, a weekly table with optional typed-in product-page sessions
(conversion per week), a data-quality card (seen coverage, calendar
agreement, exclusions), the design calendar and a "how to read this" guide
with sample-size guidance. v1.27.0 (payload shape unchanged; everything
rides inside `scoreboard`): the table gains **Visits**, **Conversion (orders
per 100 visits)**, **Subscription conversion (per 100 visits)** and **Kept
subscribers per 100 visits (30d)** columns whose cells degrade to words, not
blanks ("no visits yet" when the shop has recorded no visits in range, "no
visits" on a row when the shop records visits but none carried that stamp,
"not available for this view" for a row visits cannot attach to, "not yet"
until a visit day has matured), with the per-100 rates recomputed
client-side from the raw counts (`ordersCounted` over visits) to two real
decimals and a second line "N counted since <day>" under Conversion when
the row's first visit day is later than the range start; two banners above
the table, "Visits are not recorded yet" (info) turning into "No visits
recorded although orders arrived" (warning) when the store is LIVE and
exposure orders exist in range while `totals.visitsRecorded` is false, and
"No visits in this selection" (info) when the shop records visits but none
matched the chosen market and range; ONE reference on the screen: the
"Compare against" Select (default: the real row with most orders) drives
both the "Chance it beats the reference" column and the **Compare against
the reference** card, both computed in the browser from the raw counts on
the rows (`compareAgainstReference`: deltas in points plus "N% chance
better" for conversion, take rate and kept 30d) behind ONE gate, "too
early" while either design has under 30 orders (the server's
`scoreboard.comparison`, always against the most-orders row, is not read by
the tab: an earlier draft that used it left two references on one screen);
the guardrail keeps its fixed baseline (the row with most orders) and is
worded "the guardrail baseline", never "the reference", with a Basis column
(conversion where present, weekly orders otherwise); visits and orders per
100 visits per design on the weekly table; the sessions table relabelled
"Optional cross-check: Shopify sessions"; and data-quality tiles for visits
recorded, days with visits and last visit. The **`design_facts` self-check** (Data
integrity) compares the whole-history count of `checkout.subscribable`
events with the fact-row count (no window: the two sides do not share a
clock, the event is stamped at webhook time and the row at the order's
`processed_at`): PASS when facts cover the events (or both are 0), WARN when
facts lag (remediation: the nightly `design_facts_backfill`), plus a
seen-coverage note over the last 30 days' rows. The **`widget_visits`
self-check** (v1.27.0, Data integrity) is the server-side signature of a
silent beacon: PASS while the store is not LIVE, PASS when any visit row
was touched in the last 7 days or no exposure order landed in that window,
WARN when a LIVE store has exposure orders in the last 7 days and zero visit
rows (remediation: deploy the v1.27.0 extension, enable the app embed, look
for `/apps/cellexia-subs/w?e=view` in the network tab).

**Segments** gained the `design` and `preselect` dimensions from the
subscriber stamp (see [Analytics](#analytics)); take rate by design is
deliberately NOT a segment view (its denominator is orders, not contracts)
and lives only here.

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
join. A second, written exception since v1.26.0: the design scorecard
(Buy box designer → Results) is an ORDER-level readout over the
`SubscribableOrder` fact table with its own denominator (subscribable orders,
staff and foreign-only rows excluded), disclosed as such on the tab; its
subscriber-side figures (kept rates, LTGP) still spread `COUNTABLE_CONTRACT`
through the contract lookup, and the contract-based `takeRatePct` of the
analytics page stays null under filters rather than borrowing that
denominator. Money is only summed within the shop currency — attempts/contracts in
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

**VAT / sales tax** (v1.15.0, `costModel.vat`; **on by default since
v1.16.0, default rate 20% since v1.21.0** — 8.1% from v1.16.0 to v1.20.x,
and a shop that explicitly saved the setting keeps its stored rate;
reporting only, billing untouched): when enabled, both
surfaces subtract a flat percentage of each charge's kept money via
`resolveChargeVat` — kept × rate/100, VAT as a straight expense on revenue
(the merchant-defined model: a £100 charge at 20% books £20.00) — at
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
  combinable, each with an explicit Unknown bucket. Since v1.26.0 two more
  dimensions make nine: **buy-box design** (`design`, URL param `design`,
  from `SubscriptionContract.originDesignKey`, validated against the
  preset-key shape) and **preselected option** (`preselect`, values `sub` /
  `one` / `unknown`, from `originDesignPreselect`); both read the write-once
  stamp described under [Design measurement](#design-measurement) and never
  resolve the ladder themselves. The filter bar renders five selects per row
  on large screens. ONE pure predicate
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
  store-wide under a filter (its checkout denominator precedes contracts;
  `takeRatePct` reads null while any filter is active) and insight cards
  hide; take rate BY design lives in Buy box designer → Results, whose
  denominator is orders. Route components import the vocabulary from
  `segments-shared.ts` only (the ownership `shared.ts` pattern — a
  `.server` import in a component breaks the client build).
- **Jobs**: `rollup_run`, `cohort_run` (full triangle recompute — delete +
  createMany, self-healing after backfills), `risk_learning_run` (model
  training/evaluation + forecast accuracy recording, before scoring),
  `churn_risk_run` (risk scores + predicted empty dates),
  `predicted_ltgp_run` (per-contract predicted LTGP after churn_risk_run, then
  the accuracy pass against matured day-one predictions),
  `survey_link_sweep` (straggler survey→contract links + stale
  partial-answer emissions),
  `retention_90d_run` (verdicts derived as of `completedAt`+90d from status
  timestamps, so a backlog evaluated late never mislabels a save),
  `origin_order_backfill`
  (origin-payment capture for OURS contracts still missing it — 200/run,
  oldest first; permanently unfetchable orders are retired via the
  `originCaptureExhaustedAt` / `acqPickupExhaustedAt` terminal markers so the
  capped window always drains, and contained per-contract failures surface as
  the `ORIGIN_BACKFILL_FAILURES` alert), `design_facts_backfill` (v1.26.0,
  six contained steps since v1.27.0: refresh `MarketCountryMap` FIRST (every later step
  resolves the calendar per market), rebuild missing `SubscribableOrder`
  rows from `checkout.subscribable` events plus the order's
  `acquisition.captured` stash and `widget.design_attributed` events (the
  feed is walked newest to oldest by cursor, 500 per page, at most 40 pages,
  until 2,000 missing rows are found, so an old backlog drains over
  consecutive nights), link unlinked facts to countable contracts (walked
  from the contract side), stamp unstamped contracts, then recompute
  `staff` / `transition` / `marketHandle` over the rows since
  `designMeasurement.startedAt` (all rows when unset, capped 5,000; a row
  whose calendar-sourced design was resolved against an empty market map is
  re-resolved for its real market; the same step maps `WidgetVisitorDay`
  rows that carry a country but no market yet, `recomputeVisitMarkets`,
  capped 5,000, contained on its own), then `prune_visits` LAST (drop visit
  rows older than 400 days in the shop timezone; its own step so retention
  housekeeping never costs a repair step; stats `visitMarketsRecomputed`,
  `visitsPruned`)), `refund_reconcile` (re-attempts the
  unmatched-refund guard events once the attempt/origin mirror exists) and
  `full_sync_reconcile` (full contract re-sync — recovers from webhooks that
  outlived Shopify's retry horizon) daily; `alerts_run` every 15 min (which
  also persists one `AvailabilitySnapshot` row per shop-day — the union of
  out-of-stock variants the renewal-horizon feed observed that day). All
  keep running in Setup mode; failed daily runs retry within 30 minutes.

## Portal churn pack (v1.28.0) — reference

The release is documented seam by seam in the module map above; this
section is the flat reference the Settings page, the migration files and
the tests point at.

**Settings added (all with defaults; behaviour = settings, golden rule 7).**
`billing.chargeHourLocal` 0 (0–23; the sweep, the portal, magic/SMS and the
reminder read `timing.server.ts`), `billing.preparingWindowHours` 6;
`dunning.customerRetryCooldownMinutes` 60, `dunning.postExhaustionTouchDays`
`[7, 21]` (`[]` = no touches), `dunning.newMethodDetection` true,
`dunning.newMethodAutoSwitch` true; `portal.dunningBannerEventHours` 6,
`portal.delayReanchors` true, `portal.perLineCycleEdits` true,
`portal.paymentMethodsList` true, `portal.pauseExtendChoicesWeeks` `[2, 4]`,
`portal.deliveryInstructionsMaxChars` 250, `portal.deliveriesProcessingMaxDays`
30, `portal.deliveriesInTransitMaxDays` 14, `portal.routineGuideUrl` /
`howToUseUrl` / `faqUrl` "" (empty = hidden; https or store-relative);
`portalGrowth.supplyMeter` / `resultsTimeline` / `rewardsRoadmap` /
`onboardingCard` / `deliveriesList` true; `lifecycle.resultsTimeline`
`{enabled: true, checkinWeek: 4, expectationLine: true, phases: [0–4, 4–8,
8–12, 12+ weeks — title/body "" = the i18n default for that position]}`;
`notifications.welcomeHealMaxDays` 7 (0 = off); `cancelFlow.downsizeSaveEnabled`
true, `delaySaveEnabled` true, `delaySaveMaxDays` 42, `conciergeHoldDays` 7,
`conciergeHoldMinLeadHours` 48, `scheduledCancelEnabled` true,
`scheduledCancelNoticeDays` 3, `keepLinkTtlDays` 60, `intentFollowupEnabled`
true, `intentFollowupHours` 18, `intentFollowupChargeBufferHours` 48,
`intentFollowupCooldownDays` 30, `intentBannerDays` 14;
`winback.restartLinkTtlDays` 60; `support` group — `email`, `replyTo`,
`whatsapp` (E.164), `chatUrl` (https), `hoursNote`, `slaBusinessDays` 1,
`requestsPerHour` 3 (format-refined at save with the resolver's own rules).

**Templates added.** `subscription_started`, `payment_failed_parked`,
`new_card_detected`, `threeds_action_sms`, `cancel_scheduled`,
`cancel_upcoming`, `cancel_intent_followup`, `routine_checkin`
(`payment_method_updated` is now actually sent). Klaviyo metrics: see the
Notifications row; the auto-created flows pick the new templates up through
the ordinary coverage checklist (KLAVIYO_SETUP.md).

**Magic verbs added.** `RETRY_PAYMENT`, `USE_METHOD`, `SET_BACKUP`,
`SKIP_FAILED_CYCLE`, `EXTEND_PAUSE`, `KEEP_SUBSCRIPTION`, `SET_FREQUENCY`,
`CHECKIN`; `RESUME` minted for the first time. SMS keywords added: `RETRY`,
`UNDO`.

**Jobs added.** `cancel_scheduled_run` (hourly, gated), `concierge_sla_run`
(hourly, ungated), `cancel_intent_followup_run` (hourly, gated); the
post-exhaustion touches and the week-N check-in are phases of `dunning_run` /
`lifecycle_run`. **Alerts added.** `SUPPORT_REQUEST` (WARNING, one per
contract per shop-day, `saveRequest: true` for concierge saves),
`SUPPORT_SLA_BREACH` (CRITICAL). **Self-checks added.** `payment_update_path`,
`delivery_tracking`, `portal_a11y` (44 in total). **Webhook topics added.**
`fulfillments/create`, `fulfillments/update`, `fulfillment_events/create`.

**Columns added — ownership.** Migration `0027_portal_payments`:
`SubscriptionContract.paymentInstrumentType` and `paymentMethodRevokedAt` are
MIRROR columns (Shopify wins: refreshed by the sync CREATE/UPDATE path from
`customerPaymentMethod`, by the payment-method webhooks and by every service
that changes the pointer; null type = not yet backfilled — the
`payment_update_path` self-check counts them, the nightly sync heals them);
`backupSetBy` / `backupSetAt`, `DunningCase.customerRetryAt` and
`BillingAttempt.challengeUrl` are LOCAL (app-owned provenance / throttle /
fallback state — the sync never touches them). Migration
`0028_flexibility_deliveries`: `ContractLine.skippedCycleIndex` /
`cycleQuantityOverride` / `cycleQuantityOverrideIndex` are LOCAL mirrors of a
committed billing-cycle draft, read by `estimateNextCharge` and nulled by
`clearStaleCycleOverrides` (settlement, whole-cycle skip, re-anchor,
frequency change) — a value below the upcoming cycle index is stale by
definition and never billed from; `SubscriptionContract.deliveryInstructions`
is LOCAL and projected onto Shopify as the `_cellexia_delivery_instructions`
custom attribute (`mergeDeliveryInstructions` preserves foreign attributes
and only rewrites the note where the app owns it); `cancelScheduledAt` is
LOCAL (the sweep's due query and the dunning sweep exclude past values;
cleared by `cancelContract`, KEEP, reactivate); `BillingAttempt.trackingUrl`
/ `trackingCompany` / `trackingNumber` / `orderStatusUrl` / `shippedAt` /
`deliveredAt` are a MIRROR of the fulfillment webhooks (first-wins milestone
stamps under guarded conditional updates, `orderStatusUrl` overwritten when
it changes, un-shipped on a cancelled fulfillment) — `fulfilledAt` (0016)
keeps the analytics meaning; `WinbackState.reason` is LOCAL (snapshotted at
`scheduleWinback`). Every column is nullable; v1.27 code runs unchanged.

## Canonical event types

`contract.created|updated|activated|paused|resumed|cancelled|failed|expired|imported|merged|frequency_changed|next_date_changed|line_swapped|line_added|line_removed|line_price_changed|quantity_changed|address_updated|payment_method_updated|price_grandfathered|price_propagated|backup_payment_set|backup_payment_cleared|backup_promoted|card_update_link_sent|pause_extended|delivery_instructions_updated|delivery_shipped|delivery_delivered|delivery_shipment_cancelled`
`cycle.skipped|unskipped|delayed|delay_reverted|rushed|line_skipped|line_unskipped|line_quantity_set|addon_added|addon_removed|addon_offer_shown|gift_added|gift_removed`
`billing.attempt_scheduled|attempt_started|attempt_succeeded|attempt_failed|attempt_challenged|attempt_amount_backfilled|order_created|order_fulfilled|order_cancelled`
`dunning.case_opened|case_superseded|retry_scheduled|retry_succeeded|retry_failed|backup_used|backup_reverted|awaiting_customer|threeds_link_sent|card_expiring_notice|recovered|exhausted|case_closed|retry_deferred|new_method_detected|parked_touch`
`cancel.flow_started|reason_given|save_shown|save_accepted|save_confirmed|final_offer_shown|final_offer_accepted|completed|aborted|scheduled|schedule_kept|intent_followup_sent|intent_banner_shown`
`winback.scheduled|soft_touch|perk_offered|perk_skipped|discount_offered|discount_granted|discount_skipped|reactivated|opted_out|sunset`
`lifecycle.gift_scheduled|gift_rescheduled|milestone_reached|rewards_unlocked|incentive_announced|checkin_answered`
`notification.sent|failed` · `portal.visit|login|login_failed|otp_sent|otp_throttled|sms_inbound|mutation_attempt|dunning_banner_shown|payment_update_clicked|payment_retry|payment_3ds|payment_select|payment_backup_set|payment_skip_resume|undo` · `magic.link_used`
`admin.action` · `import.completed` · `stockout.delayed|skipped|substituted` · `alert.raised` · `shop.installed` · `widget.design_attributed` · `acquisition.captured` · `survey.answered` · `experiment.exposed` · `support.requested`

v1.28.0 additions (portal churn pack): `contract.backup_payment_set|backup_payment_cleared|backup_promoted` (backup pointer provenance — `setBy` on the payload), `contract.card_update_link_sent {channel, source, actor}`, `contract.pause_extended`, `contract.delivery_instructions_updated`, `contract.delivery_shipped|delivery_delivered|delivery_shipment_cancelled` (analytics only, no Klaviyo — Klaviyo owns shipping mail), `cycle.delay_reverted` (Undo), `cycle.rushed` (send tomorrow), `cycle.line_skipped|line_unskipped|line_quantity_set` (per-line cycle edits), `dunning.case_closed|retry_deferred` (case reconciliation after a customer skip / delay), `dunning.new_method_detected` (the idempotency ledger of new-method detection), `dunning.parked_touch`, `cancel.save_confirmed` (SAVED_PENDING → SAVED), `cancel.scheduled|schedule_kept`, `cancel.intent_followup_sent|intent_banner_shown`, `lifecycle.checkin_answered`, `portal.dunning_banner_shown` (once per case per `portal.dunningBannerEventHours`), `portal.payment_update_clicked|payment_retry|payment_3ds|payment_select|payment_backup_set|payment_skip_resume|undo`, `support.requested {topic, contractId, orderRef, pushBack, pushBackApplied, message, surface, cancelReason?}` (written with `logEventOrThrow` — the record of truth of a support request). Existing types with new payload fields: `contract.paused {until}`, `contract.activated {reason: "skip_failed_cycle"}`, `cycle.skipped {initiator: CUSTOMER, reason: skip_failed_cycle}`, `dunning.retry_scheduled {trigger: "customer" | "payment_method_updated"}`, `contract.payment_method_updated {source, trigger}`, `contract.cancelled` (Klaviyo props gain `restart_url`), `cycle.delayed {mode: once | reanchor, followingBillingDate}`.

Two contract-less types complete the vocabulary: `checkout.subscribable`
(the take-rate denominator — logged per checkout that *could* have chosen a
subscription, before any contract exists, and therefore counted without the
contract join every other counter spreads; since v1.26.0 its payload also
carries `seen: [...]`, the distinct `_cellexia_seen` values on the order, and
the same order set is mirrored as a `SubscribableOrder` fact row) and `system.plan_group_drift_check`
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
- `/apps/cellexia-subs/w` (storefront URL; lands as `/proxy/w`, `proxy.w.tsx`): the buy-box visit beacon (v1.27.0). GET only, `authenticate.public.appProxy` first, then always `204 No Content` with `Cache-Control: no-store`; invalid params, bots, rate-limited visitors or shops and a store that is not LIVE are dropped silently. Writes `WidgetVisitorDay`; see [Design measurement](#design-measurement)
- `/proxy/subscription/:id/restart` (storefront `/apps/cellexia-subs/subscription/:id/restart`, `proxy.subscription.$id.restart.tsx`, v1.28.0): the welcome-back landing for a CANCELLED contract — preserved benefits + the server-derived current win-back offer + one Restart button posting `/api/reactivate`; a `MERGED` (auto-consolidated) source is not restartable anywhere — the landing redirects to the detail page, `/api/reactivate` and `reactivateFromWinback` refuse, the home / detail Restart is hidden (its lines live in the primary contract)
- `/proxy/api/:action` v1.28.0 verbs: `payment_retry payment_3ds payment_select payment_backup payment_skip_and_resume undo line_skip line_unskip line_qty_once pause_until pause_extend pause_resume_date send_tomorrow delivery_instructions support` — same guard chain (HMAC → session → CSRF → preview read-only → setup gate → rate limit → ownership → status gate → lock window → preparing window → zod); the lock-window step applies to the reducing verbs only (`line_skip`, a `line_qty_once` decrease, `pause_until`, `pause_extend`, plus the pre-1.28 skip / delay / frequency / pause set) — `payment_skip_and_resume` (and its magic twin `SKIP_FAILED_CYCLE`) is classified a RECOVERY like `KEEP_SUBSCRIPTION`: it only ever runs on a FAILED contract (whole-order skip is ACTIVE-only, so no same-cycle inconsistency) and lock-blocking it would leave the customer FAILED at zero revenue, so it is deliberately not lock-gated
- `/magic/:token` — magic link executor (public, self-authenticating)
- `/api/jobs/run` — external cron trigger (`x-cron-secret` header)
- `/api/survey` — post-purchase survey writes from the checkout UI extension (Shopify session token, CORS-handled)
- `/api/health` — health/monitoring endpoint
- `/app/emails`, `/app/emails/setup`, `/app/emails/:template` — Emails overview (`app.emails.tsx`, a LEAF route since v1.25.0), Klaviyo delivery setup (`app.emails_.setup.tsx`) and per-template editor (`app.emails_.$template.tsx`) — escaped flat-route names: same URLs, no nesting under the overview's loader; `/app/emails/setup/status` (`app.emails_.setup_.status.tsx`) is the DB-only polling endpoint for the background verify/setup task
- `/app/buy-box/results`: resource route (`app.buy-box_.results.tsx`, escaped: not nested under the designer's loader) feeding the Buy box designer's Results tab (v1.26.0): GET the design scoreboard (`range`, `market`, `group`, `fresh`), POST the `designMeasurement` settings intents; `Cache-Control: no-store`

## Key Shopify API notes (Admin GraphQL 2025-01)

- Selling plans: `sellingPlanGroupCreate/Update/AddProducts`; first-order vs ongoing discount via `pricingPolicies` (fixed policy `afterCycle: 0` + recurring policy `afterCycle: 1`).
- Contract edits: `subscriptionContractUpdate` → draft → `subscriptionDraftUpdate` / `subscriptionDraftLineAdd/Update/Remove` → `subscriptionDraftCommit`.
- Status: `subscriptionContractActivate/Pause/Cancel/Fail/Expire`, `subscriptionContractSetNextBillingDate`.
- Per-cycle (never touches the contract): `subscriptionBillingCycleSkip/Unskip`, `subscriptionBillingCycleScheduleEdit`, `subscriptionBillingCycleContractEdit` (draft+commit) — used for one-time add-ons, gifts, per-cycle discounts.
- Charging: `subscriptionBillingAttemptCreate(subscriptionContractId, { idempotencyKey, originTime, billingCycleSelector })`; result arrives via `SUBSCRIPTION_BILLING_ATTEMPTS_{SUCCESS,FAILURE,CHALLENGED}` webhooks.
- Payment: `customerPaymentMethodGetUpdateUrl` (hosted card-update page — **Shop Pay only** per the reference; card instruments return userError code `INVALID_INSTRUMENT`, which the mutation now selects), `customerPaymentMethodSendUpdateEmail` (Shopify's own update email, valid 48 h, replaces the instrument under the same id — the default for CREDIT_CARD / PAYPAL since v1.28.0), `customer.paymentMethods(first: 25, showRevoked)` (list), `subscriptionDraftUpdate({paymentMethodId})` (switch to another vaulted method of the SAME customer — `CUSTOMER_MISMATCH` otherwise). Adding a brand-new instrument from the app is impossible (`CreditCardCreate` needs a PCI environment + Shopify mTLS; `RemoteCreate` is for non-Shopify-Payments gateways) — new instruments are vaulted only by a checkout, the hosted replace flow or the account page, which is why the portal's "Add another payment method" block links out instead of collecting a card. `customerPaymentMethodRevoke` needs `write_customer_payment_methods` (not in scope) — no "remove" in the portal.
- Import: `subscriptionContractAtomicCreate`.
- All mutations: check `userErrors` and throw `ShopifyUserError` (defined in `app/lib/graphql/client.server.ts`).

## Testing

Vitest. Pure logic (ladders, tokens, dates, money, taxonomies, mappings) is unit-tested
without a DB; DB-touching services are covered via integration-style tests only where
they can run against a scratch database (skipped when `DATABASE_URL` is unset).
