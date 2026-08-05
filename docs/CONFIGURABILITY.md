# CONFIGURABILITY — every tunable, where to edit it, and its default

Audience: merchants' onboarding engineers and anyone asking "is this
hard-coded or a setting?". One row per tunable: the admin surface (or the
honest admission that only the settings JSON reaches it today), the storage
key, and the default with validation bounds.

Storage shorthand: `settingsJson.<key>` = `ShopSettings.settingsJson`
(per-shop JSON column, parsed defensively with `parseJson`). Column names
without a prefix are `ShopSettings` columns. Everything else names its
table. All money integer cents.

> A key marked **JSON only** has no admin field yet — it is honored by the
> code but must be set by editing the shop's `settingsJson` (or by a future
> admin field). A key marked **code constant** requires a code change.

## Storefront widgets & offers

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Widget copy & behaviour | Titles, bullets, badges, reassurance line, CTAs per widget | Admin → Widgets | `WidgetConfig.settingsJson`, merged over `DEFAULT_WIDGET_SETTINGS` (`app/services/offers/widgets.server.ts`) | Brand-voice defaults per widget type |
| Widget targeting | Which products/markets/traffic see which config | Admin → Widgets | `WidgetConfig.targetingJson` `{productIds, markets, trafficSources, returningOnly, intentBands}` + `priority`, `active` | Empty targeting = everywhere; higher `priority` wins |
| Experiments | A/B variant assignment per widget | Admin → Widgets | `Experiment` (+ `WidgetConfig.experimentId`), statuses `DRAFT`/`RUNNING`/`COMPLETED` | Assignment sticky per `subjectKey` |
| Committed-plan card | The Committed Treatment Plan card on widget A | Admin → Widgets (widget A settings) | `settingsJson` of the widget config: `committed {enabled, position, percentOff, minDeliveries, termsShort, termsFull}` | `enabled: false`, `position: 2`, `percentOff: 20`, `minDeliveries: 3`; `{n}`/`{p}` placeholders substituted client-side |
| Pre-shipment window | Days before billing when the add-on offer window opens | code constant | `WINDOW_OPEN_DAYS`/`WINDOW_CLOSE_DAYS` in `preShipment.server.ts` | 3–7 days |
| Shipment gift threshold | Order value that earns the free-gift nudge (`amountToGiftCents`) | Admin → Settings → General | `settingsJson.giftThresholdCents` | `15000` (€150.00); non-negative int; nudge only within 30 % of threshold |
| **Add-on apply window** | Days before billing when unapplied add-ons are injected into the contract (apply-add-ons job) | **JSON only** | `settingsJson.addOnApplyDays` | `3`; clamped to `[1, 14]` (`normalizeAddOnApplyDays`) |

## Plans & cadence

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Selling plans | Plan names, interval weeks, percent off | Admin → Plans (push via `pushSellingPlanConfig`; versioned) | `SellingPlanConfig.plansJson` `[{name, intervalWeeks, percentOff, shopifyPlanId, committed?, minDeliveries?}]` | Editing a plan NEVER changes existing subscribers (contracts detach at purchase) |
| Quantity → cadence defaults | Recommended delivery rhythm per quantity | Admin → Plans | `SellingPlanConfig.quantityDefaultsJson` e.g. `{"1": 4, "2": 8}` (weeks) + per-product overrides | Consumed by `cadenceDefaultForQuantity` |
| Committed plan terms | Minimum deliveries before schedule flexibility unlocks | Admin → Plans (plan entry) | `plansJson` entry `committed: true`, `minDeliveries: n` | `minDeliveries >= 2` implies committed; committed without a number defaults to **3**; largest wins across lines |
| Max cadence | Ceiling for cadence switches | code constant | `MAX_INTERVAL_WEEKS` (`app/services/subscribers/actions.ts`) | 24 weeks — enforced by CS console and retention quick actions |

## Customer policy (portal gates)

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Minimum pause/cancel window | Locks pause/cancel for the first N days of a customer's FIRST contract | Admin → Settings → General | `settingsJson.minPauseCancelWindow` `{enabled, days}` | `{enabled: false, days: 10}`; days clamped `[1, 90]`; never gates CS/system paths |
| Pause presets | The pause-duration chips (portal, CS console, save offers) | code constant | `PAUSE_OPTIONS_DAYS` (`app/types/domain.ts`) | `[30, 60, 90]` days |
| Pause-ending reminder | Lead time for the `PAUSE_ENDING` reminder before auto-resume | `ShopSettings.settingsJson` (no UI yet; default in `app/services/core/pauseResume.server.ts`) | `settingsJson.pauseReminderDays` | 3 days before `pausedUntil`, clamped `[1, 30]`; resume fires when `pausedUntil <= now` (dunning grace pauses get no reminder — they resume into the FINAL_NOTICE handoff instead) |

## Treatment & milestones

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Milestone rewards | Reward per milestone type (`FIRST_MONTH`, `NINETY_DAYS`, …) | Admin → Treatment → Milestones | `settingsJson.milestoneRewards` (partial map merged over code defaults) | Code defaults in `milestones.server.ts` |
| Depletion inputs | Unit contents & default daily usage per product | Admin → Treatment | `ProductMeta.unitContents`, `ProductMeta.defaultDailyUsage` | Depletion stays informational; learned `DEPLETION_USAGE` multipliers are shown as suggestions only |
| Compatibility graph & routines | Pairing/stagger/conflict edges, routine templates | Admin → Treatment | `CompatibilityEdge`, `RoutineTemplate.stepsJson` | — |

## Cost model & analytics

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Cost model | Margin/COGS/fees for every profit figure | Admin → Analytics → Costs | `settingsJson.costModel` `{defaultGrossMarginPercent, shippingPerDeliveryCents, fulfillmentPerDeliveryCents, paymentFeePercent, paymentFeeFixedCents}` | `70` % margin, all costs `0`; percents 0–100 normalised to fractions by `getCostModel` — the single source of profit math |
| Per-product costs | Product-level margin/unit cost | Admin → Treatment (product meta) | `ProductMeta.grossMarginPercent` (FRACTION 0..1), `ProductMeta.unitCostCents` | Product data beats the default margin |
| Currency | Display currency | Admin → Settings → General | `currencyCode` column | `EUR` |

## Retention: dunning

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Retry strategies | Step ladder per decline category | code (`strategyFor`, `dunning.server.ts`) | — | Seven per-category ladders |
| **Merchant retry overrides** | Retry offset-days per decline category | Admin → Dunning (per-category text inputs) | `settingsJson.dunningOverrides` e.g. `{"INSUFFICIENT_FUNDS": [3,5,7]}` | none; validated 1..30 days, max 4 retries; precedence **merchant > learned > static** (learned = `ModelState DUNNING_RECOVERY` via `getLearnedDunningOffsets`) |
| Pre-dunning lead | Days before card expiry to warn (`CARD_EXPIRING`) | Admin → Dunning (also Settings → General) | `settingsJson.preDunningLeadDays` | `10`; non-negative int |
| High-value grace | Extra grace days for high-value contracts | Admin → Settings → General | `settingsJson.highValueGraceDays` | `7`; non-negative int |

## Retention: churn & cancellation

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Churn risk threshold | Score at/above which `HIGH_CHURN_RISK` outreach fires | Admin → Settings → General | `settingsJson.churnRiskThreshold` | `0.55` (recalibrated this build; was 0.7); must satisfy `0 < t < 1`; the subscribers-list HIGH band reads the same key |
| Save-offer budget | Cap on paid save-offer cost | code (`maxRationalSaveCostCents`, offer builders in `saveOffers.server.ts`) | — | Derived from order value/LTV |
| Cancel-session hygiene | Stale `IN_PROGRESS` sessions swept to `ABANDONED` | job `expire-cancel-sessions` (daily; also lazily on new session start) | — | — |

## Communications & portal

| Feature | What it controls | Where to edit | Key | Default & validation |
| --- | --- | --- | --- | --- |
| Klaviyo | Enable delivery + API key | Admin → Settings | `klaviyoEnabled` column; `klaviyoApiKeyEncrypted` column (AES-256-GCM at rest) | Disabled; events queue in the outbox regardless |
| Portal fonts | Brand font asset base URL | **JSON only** (env fallback) | `settingsJson.fontBaseUrl` → env | none → graceful fallback stacks (BRAND.md) |
| Autopilot | Per-plan automation consent + guardrails | Portal → Manage (customer-owned) | `SubscriptionContract.autopilotEnabled`, `guardrailsJson` `{maxChargeCents, askBeforeAdding, minIntervalWeeks, notifyDaysBefore}` | Off; parsed by `parseGuardrailsForm` |

## Jobs & ops

Cadences and invocation for every scheduled behaviour (including the new
`apply-add-ons`, `pause-resume`, `expire-cancel-sessions` and `learning`
jobs) live in [`RUNBOOK.md`](RUNBOOK.md) §6 — cadence itself is a scheduler
concern, not an app setting.
