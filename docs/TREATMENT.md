# Treatment engine — [treatment] module

Depletion, adherence, compatibility, routines, quality score, milestones and
autopilot. All customer-facing copy uses the Continuous Treatment voice
(docs/BRAND.md): treatment plan / delivery / routine, benefits that accumulate,
and always "Adjust, delay or cancel online."

## Depletion engine (`services/treatment/depletion.server.ts`)

### Formula

```
predictedRunOutAt = deliveredAt + (unitsDelivered × unitContents / dailyUsage) days
```

- `unitContents` (ml/g per unit) and `defaultDailyUsage` come from
  `ProductMeta`; per-line estimates live in `DepletionEstimate`.
- `predictRunOutDate` is pure and throws on `dailyUsage <= 0` — callers skip
  lines without a usable usage estimate.
- `unitsOnHand` is tracked in content units, anchored at the time of the last
  signal (the last `signalsJson` entry's `at`).

### Signals (`registerDepletionSignal` / pure `updateEstimateFromSignal`)

| Signal | Effect on estimate | Confidence |
| --- | --- | --- |
| `EARLY_DELAY` | daily usage ×0.85 (−15%) | −0.05 |
| `BROUGHT_FORWARD` | daily usage ×1.15 (+15%) | −0.05 |
| `REPEATED_SKIPS` | daily usage ×0.75 (−25%) | −0.05 |
| `EXTRA_ONE_TIME_PURCHASE` | daily usage ×1.20 (+20%) | −0.05 |
| `SURVEY_OVERRIDE` | sets `unitsOnHand` from the reported remaining amount; recalibrates daily usage from actual consumption when history allows | set to 0.90 |
| `DELIVERY_RECEIVED` | adds delivered content units to the decayed carry-over; advances `lastDeliveryAt` | +0.05 |

Confidence is clamped to [0.05, 0.95]. Every signal is appended to
`DepletionEstimate.signalsJson` (`[{at, signal, adjustment}]`, last 50 kept).

### Scan job (`runDepletionScanJob`, `/jobs/depletion-scan`)

Recomputes `predictedRunOutAt` for every line of every ACTIVE contract, then
compares with `nextDeliveryDate` (fallback `nextBillingDate`):

- run-out **more than 21 days after** the next delivery →
  `LIKELY_EXCESS_INVENTORY`
- run-out **more than 7 days before** the next delivery →
  `LIKELY_PRODUCT_SHORTAGE`

At most one nudge per contract per direction per 14 days.

**Estimates are informational only.** They power events, incentives and
dashboards — they never auto-change delivery frequency. Only the autopilot may
move a date, inside customer-set guardrails.

## Adherence (`services/treatment/adherence.server.ts`)

- `sendPostDeliverySurveysJob` finds contracts whose `CHARGE_COMPLETED` landed
  3–10 days ago with no survey since, creates the `AdherenceSurvey` row and
  emits the check-in with the five `ADHERENCE_QUESTIONS` in the payload.
- `recordSurveyResponse` fans answers out:
  - `PRODUCT_REMAINING` → `SURVEY_OVERRIDE` depletion signal per line
    (free-text parsed by `parseRemainingFraction`: "about half", "40%", 0.4…).
  - `DISCOMFORT` (when actually reporting discomfort) → `HIGH_CHURN_RISK`
    with `suggestedCancelReason: "IRRITATION"` so retention can intervene
    before a cancellation starts.

**Event-name note:** the `LifecycleEvent` union has no "survey sent" event, so
the check-in reuses `TREATMENT_MILESTONE` with `payload.kind =
"ADHERENCE_CHECK_IN"`. Milestone rewards use `payload.kind = "MILESTONE"`.
Branch/filter on `payload.kind`.

## Compatibility graph (`services/treatment/compatibility.server.ts`)

Directed edges (`CompatibilityEdge`, unique per shop+from+to+relation):

| Relation | Meaning | Coherence effect |
| --- | --- | --- |
| `PAIRS_WITH` | products reinforce each other | none (cross-sell signal) |
| `STAGGER` | introduce a few days apart | warning, still coherent |
| `REDUNDANT` | overlapping actives | listed, still coherent |
| `ROUTINE_STEP_BEFORE` | apply from-product before to-product | ordering constraint |
| `SENSITIVITY_CONFLICT` | never combine | **incoherent** |

`routineCoherence(productIds, edges, timeOfDay?)` is pure: topological order
over `ROUTINE_STEP_BEFORE`, tie-broken by time of day (AM < BOTH < PM) then
input order; cycles fall back to the tie-break order.

## Routines (`services/treatment/routines.server.ts`)

- `recommendRoutine(shop, {concern, currentProductIds})` picks the active
  `RoutineTemplate` for the concern, orders steps by coherence, suggests only
  steps the customer doesn't own that are subscribable and don't conflict with
  owned products, and returns stagger warnings in brand voice.
- `consolidationPlan(shop, shopifyCustomerId)` proposes merging >1 ACTIVE
  contracts into the one with the soonest `nextBillingDate` (fewest
  shipments). Execution belongs to core `mergeContracts`.

## Quality score (`services/treatment/quality.server.ts`)

`computeQualityScore(features)` is pure, 0..100, with a factor breakdown:

| Factor | Contribution |
| --- | --- |
| base | +50 |
| acquisitionSource | −10..+10 (organic/referral +10 … deal/coupon sites −10; unknown 0) |
| discountPercent | −0.6 pt per % off, floored at −20 |
| quantity | +4 per unit beyond the first, capped at +12 |
| productMarginPercent | (margin − 0.5) × 40, clamped to ±15 |
| hasPurchaseHistory | +8 |
| oneTimePurchases | +2 each, capped at +10 |
| widgetEngaged | +5 |
| firstOrderMarginCents | +1 pt per €10 contribution margin, clamped to ±10 |
| refundRiskFlag | −20 |

Derived policies:

- `deriveOnboardingTier`: ≥70 `WHITE_GLOVE`, ≥40 `STANDARD`, else `LIGHT`.
- `dunningAggressiveness`: ≥70 `GENTLE`, ≥40 `STANDARD`, else `ASSERTIVE`
  (high-quality relationships are worth patient, soft recovery; low-quality
  cohorts get a shorter sequence to cap recovery cost).

`snapshotQualityScore` persists the score to the contract and a
`ScoreSnapshot` (kind `QUALITY`) with the factor breakdown.

## Milestones (`services/treatment/milestones.server.ts`)

`runMilestoneJob` (jobs: `milestones`) detects, records (unique
contractId+type) and notifies:

| Milestone | Trigger | Default reward |
| --- | --- | --- |
| `TREATMENT_STARTED` | first successful charge | welcome note |
| `FIRST_MONTH` | 30 days since treatment start | free delivery on the next order |
| `NINETY_DAYS` | 90 days | price protection while the plan stays active |
| `SIX_DELIVERIES` | `successfulOrders ≥ 6` | early access to new formulas |
| `ONE_YEAR` | 365 days | free replacement for damaged/lost deliveries |

Rewards are **accumulating benefits, never countdowns**. Merchants override
them via `ShopSettings.settingsJson.milestoneRewards`
(`{ [MilestoneType]: {type, title, description} }`), editable on the
Milestones tab of `/app/treatment`. Events: `TREATMENT_MILESTONE` with
`payload.kind = "MILESTONE"` and the reward payload.

`runAnniversariesJob` (jobs: `anniversaries`) emits `SUBSCRIBER_ANNIVERSARY`
once per completed treatment year (7-day window after the anniversary, 30-day
duplicate guard).

## Autopilot (`services/treatment/autopilot.server.ts`)

The only treatment component allowed to move a delivery date — and only inside
`AutopilotGuardrails` the customer set (`SubscriptionContract.guardrailsJson`):

| Guardrail | Default | Effect |
| --- | --- | --- |
| `maxChargeCents` | null (no cap) | charges above the cap always require a one-tap confirm |
| `askBeforeAdding` | true | products are never added silently (offers module honours it) |
| `minIntervalWeeks` | 2 | never schedule sooner than this after the last delivery |
| `notifyDaysBefore` | 3 | never move to a date the customer can't be notified about in time |

`evaluateAutopilotAdjustment` (pure) aims the next delivery at
`predictedRunOutAt − 3 days`, needs estimate confidence ≥ 0.4, ignores moves
smaller than 4 days, and escalates moves larger than 28 days (or charges above
the cap) to a confirm request. `applyAutopilot` executes `MOVE_DATE` through
core `setNextBillingDate` under idempotency key
`autopilot:move:<contractId>:<yyyy-mm-dd>`.

### Event-name mapping (LifecycleEvent union is closed)

| Situation | Event | Payload |
| --- | --- | --- |
| Executed move (either direction) | `SHIPMENT_DELAYED` — only for actual moves | `{source: "autopilot", direction: "DELAY" \| "BRING_FORWARD", previousDate, newDate}` |
| Confirm request, proposed delay | `LIKELY_EXCESS_INVENTORY` | `{proposal: "one-tap-confirm", newDate, direction, reason}` |
| Confirm request, proposed bring-forward | `LIKELY_PRODUCT_SHORTAGE` | `{proposal: "one-tap-confirm", newDate, direction, reason}` |

## Admin UI (`routes/app.treatment.tsx`)

Tabs: **Products** (ProductMeta: unit contents, daily usage, margin, unit
cost, time of day, concern, hero rank, subscribable) · **Compatibility**
(edge list + add form) · **Routines** (template CRUD with ordered steps) ·
**Adherence** (recent responses) · **Depletion** (estimates + staff override →
`SURVEY_OVERRIDE`) · **Milestones** (recent milestones + reward JSON editor).

## Jobs owned by this module

`milestones`, `depletion-scan`, `anniversaries` (dispatched by
`routes/jobs.$job.tsx`). `sendPostDeliverySurveysJob` is exported for the
communications/job layer to schedule alongside them.
