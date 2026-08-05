# Retention module — cancellation prevention, dunning, churn scoring

Owner: `[retention]` — `app/services/retention/*`, `app/routes/app.retention.tsx`,
`app/routes/app.dunning.tsx`, `tests/retention/*`.

Customer copy throughout uses the Continuous Treatment voice (docs/BRAND.md):
treatment plan / delivery / routine, always reassuring "Adjust, delay or
cancel online", never pressure tactics.

## 1. Cancellation flow

```
Customer clicks "Cancel my plan"
        │
        ▼
startCancellationSession(shop, contractId)
  - computes maxSaveCostCents (profit-aware ceiling, stored on the session)
  - emits CANCELLATION_STARTED, audit (CUSTOMER)
        │
        ▼
submitReason(sessionId, reason, detail?)          ← one of CANCEL_REASONS
        │
        ▼
getOffersForSession(sessionId)
  - assembles context (lines, cadence, depletion excess flag, swap candidates)
  - buildOffersForReason(reason, ctx)   [PURE]
  - offers stored on the session (offersJson), audit
        │
        ├── acceptOffer(graphql, sessionId, offerType)
        │     - executes the underlying action via core contracts
        │     - session outcome = SAVED (+ savedByOffer, saveCostCents)
        │     - emits CANCELLATION_SAVED, audit, idempotent
        │
        └── finalizeCancellation(graphql, sessionId)
              - core cancelContract(..., reason, CUSTOMER)
              - session outcome = CANCELLED
              - emits CANCELLATION_COMPLETED, audit, idempotent
```

Sessions left in `IN_PROGRESS` count as `ABANDONED` in reporting (the plan
stays live — abandoning the flow is itself a save).

### Save-offer hierarchy (cost order = `SAVE_OFFER_TYPES` order)

| # | Type | Cost to Cellexia |
|---|------|------------------|
| 1 | EDUCATION | free |
| 2 | CHANGE_DELIVERY_DATE (delay / skip / move) | free |
| 3 | CHANGE_FREQUENCY | free |
| 4 | CHANGE_QUANTITY | free |
| 5 | PRODUCT_SWAP | free |
| 6 | REMOVE_ITEM | free (smaller order) |
| 7 | TEMPORARY_PAUSE (30/60/90 d or chosen date, never indefinite) | free (deferred revenue) |
| 8 | ACCOUNT_CREDIT | margin |
| 9 | FREE_GIFT | COGS |
| 10 | TEMPORARY_DISCOUNT | margin |
| 11 | PERMANENT_DISCOUNT | never automated |

Every reason-specific list is sorted by this hierarchy and each type appears
at most once (choices such as 2/4/6/8-week delays live in `params`, and
`acceptOffer` executes the `default*` value).

### Reason → offers matrix

| CancelReason | Offers (in hierarchy order) | Explicitly excluded |
|---|---|---|
| TOO_MUCH_PRODUCT | delay 2/4/6/8 wks · slower cadence · reduce quantity · bounded pause | any discount/credit/gift |
| NOT_SEEING_IMPROVEMENT | timeline + usage education (with consultation route) · complimentary booster | immediate discounts |
| TOO_EXPENSIVE | slower cadence · reduce quantity · lower-cost swap · remove one product · account credit · **discount only last** | — |
| ONLY_WANTED_TO_TRY | no-obligation messaging · skip next · longer interval · bounded pause | discounts |
| IRRITATION | usage-reduction guidance + collect details + customer-care route · gentler swap / refund per policy | **any retention discount** |
| TRAVELLING | address change · move dates (delay / bring forward / return date) · pause until return | discounts |
| WANT_DIFFERENT_PRODUCT | product swap without cancelling | discounts |
| CIRCUMSTANCES_CHANGED / OTHER | flexibility messaging · delay · slower cadence · bounded pause | discounts |

### Profit-aware cap

```
maxRationalSaveCostCents = floor( clamp01(pRetain) × max(0, expectedFutureContributionCents) )
```

where (heuristic in `cancellation.server.ts#estimateRetentionEconomics`,
replaceable by analytics survival curves later):

- `avgOrderValueCents` = totalRevenue / successfulOrders (fallback: current lines)
- `expectedRemainingOrders` = clamp(9 − successfulOrders, 2, 12)
- `margin` = value-weighted `ProductMeta.grossMarginPercent` (fallback 0.70)
- `expectedFutureContributionCents` = avgOrderValue × margin × remaining
- `pRetain` = clamp(0.35 − 0.2 × churnRiskScore, 0.10, 0.35)

Offers costing more than the cap are never presented. The cap is computed and
stored at session start (`CancellationSession.maxSaveCostCents`) so the flow
cannot drift mid-session.

## 2. Dunning

### Decline taxonomy

| Processor code (substring match, case-insensitive) | DeclineCategory |
|---|---|
| insufficient* | INSUFFICIENT_FUNDS |
| expired* | EXPIRED_CARD |
| lost*, stolen*, pickup* | LOST_OR_STOLEN |
| processing_error, try_again*, issuer_unavailable, timeout | PROCESSOR_ERROR |
| authentication*, sca*, three_d*, 3ds* | AUTHENTICATION_REQUIRED |
| invalid_account, account_closed, invalid/incorrect_number, no_account, permanent* | PERMANENT_FAILURE |
| card_declined, generic_decline, do_not_honor, anything else, null | GENERIC_DECLINE |

### Strategies (standard subscriber; `afterDays` relative to previous step)

| Category | Sequence (cumulative) |
|---|---|
| INSUFFICIENT_FUNDS | Email d0 → **Retry d3** → Email → **Retry d5** → Email → **Retry d7** → Email d8 → Pause d11. Retries are snapped to the day after the next likely salary date (1st/15th) when within ±3 days. |
| EXPIRED_CARD | Update email d0 → SMS d1 → **single Retry d5** (after the update window) → Email d7 → Pause d12. No blind retries. |
| GENERIC_DECLINE | Email d0 → **Retry d2** → **Retry d4** → Email → **Retry d8** → Email d10 → Pause d13 |
| LOST_OR_STOLEN | **No retries ever.** Payment-update email d0 → SMS d2 → Email d7 → Pause d10 → Cancel d40 |
| PROCESSOR_ERROR | **Retry +6h** → **Retry +24h** → Email → **Retry d4** → Pause d8 |
| AUTHENTICATION_REQUIRED | Authentication-link email d0 → **Retry d2** → Email → **Retry d5** → Pause d10 |
| PERMANENT_FAILURE | **No retries.** Email d0 → grace Email d7 → Pause d14 → Cancel d44 |

High-value subscribers (paid ≥ €250 or expected LTV ≥ €600) get one extra
grace step (email + 7 days) inserted before the first PAUSE/CANCEL.

### State machine

```
onBillingFailure ──▶ RETRYING ──(queue steps)──▶ GRACE (after PAUSE) ──▶ EXHAUSTED (after CANCEL / strategy end)
      ▲                   │
      │                   └── onBillingSuccess ──▶ RESOLVED (counters reset)
runPreDunningJob ──▶ PRE_DUNNING (card-expiry warning before the next charge)
```

- Steps are executed by `runDunningQueueJob` (job `dunning-queue`), idempotent
  per `(contract, episode, stepIndex)`; the strategy length is never exceeded
  (→ `EXHAUSTED`).
- RETRY steps call core `createBillingAttempt`; PAUSE calls core `pauseUntil`
  (+30 days); CANCEL calls core `cancelContract(..., "PAYMENT_FAILURE",
  SYSTEM)`.
- EMAIL/SMS steps emit `CHARGE_FAILED` with `{step, channel, template}` and a
  per-step dedupe key — Klaviyo flows fan out per channel.
- The initial customer-facing CHARGE_FAILED for a failure comes from core's
  webhook handler; `onBillingFailure` only maintains state + schedule (portal
  banner reads `DunningState` directly).
- Pre-dunning (`runPreDunningJob`, job `pre-dunning`): cards expiring before
  `nextBillingDate + ShopSettings.settingsJson.preDunningLeadDays` (default
  10) trigger `CARD_EXPIRING` ("Your next treatment delivery is scheduled for
  {nextBillingDateHuman}. The card ending in {cardLastDigits} expires this
  month.") plus Shopify's
  secure payment-update email — once per contract per card expiry month.

## 3. Churn scoring

`computeChurnRisk(features)` is a pure weighted logistic model over
normalised features (each factor's signed contribution is returned for
explainability):

| Feature | Direction | Weight |
|---|---|---|
| emailEngagementScore | protective | −1.10 |
| portalVisits30d | protective | −0.45 |
| delays90d | risk | +0.90 |
| skips90d | risk | +1.15 |
| failedCharges90d | risk | +1.00 |
| supportTickets90d | risk | +0.70 |
| low avgProductRating | risk | +1.05 |
| refunds180d | risk | +1.20 |
| inferredExcessDays | risk | +1.00 |
| AOV decline | risk | +0.65 |
| baseline (bias) | — | −1.25 |

`runChurnScanJob` (job `churn-scan`) scores every active contract, writes a
`ScoreSnapshot` (kind `CHURN_RISK`), denormalises to
`SubscriptionContract.churnRiskScore`, and above the threshold
(`settingsJson.churnRiskThreshold`, default 0.7) emits `HIGH_CHURN_RISK` at
most once per contract per week. The payload includes the cheapest matching
proactive intervention (always structural, never a discount) — e.g. excess
inventory → "move your next delivery back four weeks?".

## 4. Admin surfaces

- `/app/retention`: cancellation report (reason × outcome, save rate, average
  save cost), top churn-risk contracts with factor breakdown and one-click
  proactive actions (delay 4 weeks / pause 30 days / slow cadence, executed
  through core contracts and audited), pause-design note, hierarchy reference.
- `/app/dunning`: recovery queue (phase, category, next retry, history tail),
  recovery performance by category and retry step, pre-dunning lead-days
  setting, per-category strategy reference.

## 5. Policy gates

`app/services/retention/policy.server.ts` decides whether the **customer**
may pause or cancel right now. Two policies exist; both apply ONLY to
customer-facing surfaces (the portal). The CS console and system flows
(dunning pause/cancel, reconciliation) are **never gated** — a human agent
and the dunning engine can always act.

### Minimum pause/cancel window

- Config: `ShopSettings.settingsJson.minPauseCancelWindow =
  {"enabled": false, "days": 10}` — **OFF by default**; `days` clamped to
  [1, 90].
- Applies only to a customer's **first-ever** contract. A returning
  subscriber — any prior contract for the same (shop, customer), active or
  cancelled — is never window-locked.
- Anchor = `treatmentStartedAt ?? createdAt`; the contract is locked while
  `now < anchor + days` (the unlock instant itself is already unlocked).
- Gates **both** pausing and cancelling (`getPauseGate`, `getCancelGate`).

### Commitment (Committed Treatment Plan)

- Config: plan entries in `SellingPlanConfig.plansJson` carry
  `{"committed": true, "minDeliveries": n}`. An entry with
  `minDeliveries >= 2` counts as committed even without the flag; a
  committed entry without a number defaults to **3** deliveries.
- A contract is committed when any line's `sellingPlanId` matches a
  committed entry's `shopifyPlanId` (GID and bare-id forms compare equal);
  with several matched lines the **largest** `minDeliveries` wins.
  Unmatched plan ids never lock (defensive: a line we cannot attribute
  cannot create an obligation).
- The commitment is `met` once `successfulOrders >= minDeliveries`. Until
  then the customer-facing schedule is **fully fixed**: cancel, pause,
  delay, skip, date changes and cadence switches are all gated
  (`getCancelGate`, `getPauseGate`, `getScheduleGate`), and the autopilot
  never moves dates on an unmet commitment. Quantities, variants,
  add-products, address and payment changes stay available. CS console and
  system/dunning paths are never gated.

### Evaluation order & fail-open

- `getCancelGate` and `getPauseGate` check COMMITMENT first (the stronger,
  longer constraint), then the WINDOW; `getScheduleGate` is
  commitment-only (the first-plan window never gates the schedule).
  `reason` names the binding constraint (`"COMMITMENT"` | `"WINDOW"` |
  `null`), `unlocksAt` is set for window locks, and `commitment` is
  attached for portal display ("delivery 2 of 3").
- **Fail open**: the gate functions never throw. A missing contract,
  malformed JSON or a query failure logs a `logger.warn` and returns
  `allowed: true` — a broken policy must never trap a customer inside a
  plan. (The worst failure mode is a customer cancelling one delivery
  early; the alternative — an uncancellable plan — is unacceptable.)

### Legal & platform notes

- Minimum-commitment terms and cancellation windows are consumer-law
  sensitive. Merchants must confirm both against consumer law in every
  market they sell into — notably EU distance-selling / withdrawal rights
  (14-day right of withdrawal) — and **disclose the terms at checkout**
  (the committed card's `termsShort`/`termsFull` widget copy exists for
  exactly this).
- Shopify selling plans can also declare `minCycles`; pushing committed
  plans with `minCycles = minDeliveries` enforces the commitment at the
  contract level inside Shopify itself, in addition to these app-side
  gates.

## Add-on fulfilment lifecycle

An `AddOnItem` is a **promise** ("arrives with your next delivery"), not a
delivery. The fulfilment engine
(`app/services/offers/addOnFulfillment.server.ts`) is what turns the
promise into a charged, shipped reality — without it, add-ons are
decorative rows that never bill and never ship.

### Stages

1. **Promise** — the portal, storefront proxy or a retention save offer
   creates the `AddOnItem` (mode `NEXT_ONLY` / `N_DELIVERIES` /
   `RECURRING`; retention gifts use the `RETENTION_GIFT` source
   convention). Nothing has changed on the Shopify contract yet.
2. **Apply** — `runApplyAddOnsJob` (jobs key `apply-add-ons`, daily) finds
   ACTIVE contracts billing within the apply window
   (`settingsJson.addOnApplyDays`, default 3 days, clamped 1–14; past-due
   billing dates count as in-window because the charge is imminent) and
   injects every unapplied add-on as a real `ContractLine` via core
   `addLineToContract`. Pricing per mode:
   - `RECURRING` → subscriber price via `planAdjustedPriceCents`
     (contract's `initialDiscountPercent`, falling back to the matched
     selling-plan entry's `percentOff`) — a permanent line keeps the plan
     discount, never full retail;
   - `NEXT_ONLY` / `N_DELIVERIES` → the stored one-time `priceCents`;
   - `RETENTION_GIFT` source → **0 cents**, whatever the mode — a promised
     gift is never charged.
   After application, `RECURRING` rows are **deleted** (they became
   permanent plan lines; the audit trail keeps attribution); limited modes
   are stamped `appliedAt` + `appliedLineId` and their
   `remainingDeliveries` normalised (`NEXT_ONLY` → 1).
3. **Charge & ship** — the next billing cycle now genuinely includes the
   line; forecast/`expectedNextOrderValueCents` revenue stops being
   phantom.
4. **Consume** — after each successful charge,
   `consumeAddOnsAfterCharge(shop, contractId, attemptId, chargeAt?)`
   decrements applied `N_DELIVERIES` counters and, when a count is
   exhausted (and always for `NEXT_ONLY`), removes the line via core
   `removeLineFromContract` (SYSTEM actor — emits `PRODUCT_REMOVED`,
   re-syncs the mirror) and finalizes the `AddOnItem`. `chargeAt` (the
   charged order's `createdAt`) skips add-ons applied AFTER the order was
   built — they ship (and are consumed) with the next charge.

### Guarantees

- **Idempotent**: each application runs inside
  `withIdempotency("addon-apply:<addOnId>:<cycleISO>")`, and an
  `ADD_ON_APPLY_INTENT` audit marker written BEFORE the Shopify commit
  lets a re-run recognise a line a partially failed run already committed
  instead of adding a duplicate; consumption is keyed per charge on the
  local billing-attempt id (`addon-consume:<contractId>:<attemptId>`), so
  re-run jobs and redelivered webhooks replay instead of double-adding or
  double-decrementing, while distinct charges never share a key.
- **Fail-soft**: one bad contract never blocks the apply job (logged,
  counted, skipped); consumption **never throws** — billing-success
  processing survives any add-on housekeeping failure. A line removal that
  fails after its count is zeroed is swept and retried on the next charge.
- **Audited**: `ADD_ON_APPLIED`, `ADD_ON_CONSUMED`, `ADD_ON_COMPLETED` per
  row, `ADD_ON_APPLY_JOB` per shop run. Applied add-ons emit
  `PRODUCT_ADDED` with `payload.addOn: true` so analytics can separate
  applied add-ons from customer-initiated adds.

## Auto-resume semantics (pauses are never indefinite)

Shopify's `subscriptionContractPause` is indefinite — Shopify never
resumes a contract by itself. Every pause the app creates (portal pause,
one-click retention pause, `TEMPORARY_PAUSE` save offer, dunning grace
pause) therefore stores its promise in `pausedUntil`, and the
`pause-resume` job (jobs key `pause-resume`, hourly;
`runPauseResumeJob` in `app/services/core/pauseResume.server.ts`) keeps
that promise:

- **Reminder** — contracts whose `pausedUntil` falls within the reminder
  lead (3 days, `settingsJson.pauseReminderDays`-overridable) get
  `PAUSE_ENDING` via `emitLifecycleEvent` with dedupe key
  `pause-ending:<contractId>:<pausedUntil ISO>` (payload `resumeDate`),
  driving the existing Klaviyo "Pause ending" template — the reminder the
  portal copy has always promised. Dunning grace pauses are excluded:
  their cycle is still unpaid, so a cheerful "deliveries resume" email
  would contradict the final notice sent at resume time.
- **Resume** — contracts with `pausedUntil <= now` are resumed via core
  `resumeContract` (idempotent; clears `pausedUntil`, emits
  `PAUSE_ENDED`, resolves live dunning state). The next billing attempt
  either succeeds or opens a fresh dunning episode via `onBillingFailure`.
- **Dunning grace handoff** — when the expiring pause belongs to a live
  dunning grace episode (`graceUntil` set, phase
  `GRACE`/`FINAL_NOTICE`/`EXHAUSTED`), the contract is still resumed but
  the episode is re-opened as `FINAL_NOTICE`: the customer receives the
  promised `CHARGE_FAILED` final-notice email
  (`dunning-grace-final-notice`), never a serene "welcome back" into a
  broken card. The next billing outcome resolves the episode or opens a
  fresh one.
- **Orphan detection** — `PAUSED` contracts with no `pausedUntil` (a
  half-committed pause, or one made externally in the Shopify admin /
  native portal) can never auto-resume; the job warn-logs them every run
  and appends one `PAUSE_ORPHAN_DETECTED` audit row per contract so CS
  can resolve them.
- Paused contracts stay visible to retention: the churn scan scores
  `PAUSED` contracts (outreach gated until the pause window has passed),
  so the paused cohort never disappears from monitoring while it decides
  whether to come back.
