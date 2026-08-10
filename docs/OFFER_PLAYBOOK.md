# OFFER PLAYBOOK — the operator's guide to the levers

What every knob in this app does to lifetime gross profit (LTGP), which defaults
we chose and why, and how to change them without hurting yourself. Read this
before touching Plans, Gifts, Cancel-flow or Win-back settings.

Related: [OPERATIONS.md](./OPERATIONS.md) (how to pull each lever),
[ARCHITECTURE.md](./ARCHITECTURE.md) (where the data lives),
[TESTING.md](./TESTING.md).

North star: **maximise lifetime gross profit and subscriber take-rate without
hurting conversion; minimise voluntary + involuntary churn.** Every
recommendation below traces to that sentence.

---

## 1. Why 20% first order / 10% ongoing (the default)

- The first-order discount's job is **acquisition into the subscription**, not
  margin. 20% is the point where the subscribe option visibly dominates one-time
  purchase on the PDP without training customers that the product "really costs"
  less. Below ~15% the take-rate lift fades; above ~25% you attract
  deal-seekers whose cycle-2 survival is poor and you compress first-order GP
  for no retention benefit.
- The ongoing 10% is the **fair-exchange price of autopay consent**. It must be
  meaningful (5% reads as rounding noise) but it is paid on *every* renewal
  forever, so each extra point is a permanent LTGP tax: on a £45 item, moving
  10%→15% costs £2.25 of gross profit per cycle across the entire base.
- Mechanically both live on the selling plan's pricing policies (fixed
  `afterCycle: 0` + recurring `afterCycle: 1`) — never discount codes, so
  renewals can never "lose" their discount or stack a code (Golden rule 3).
- Change them per plan on the **Plans** page. Test moves of ±5 points, one
  variable at a time, and judge on **cycle-3 survival × contribution margin**,
  not on take-rate alone.

## 2. Gift instead of discount — the COGS vs perceived-value math

A discount costs you its full face value in gross profit. A gift costs you its
**COGS** but is *perceived* at its **retail value**. On skincare margins that
asymmetry is enormous.

**Worked example** (typical Cellexia unit economics):

| | 10% extra discount | Travel-size serum gift |
|---|---|---|
| Renewal order value | £45.00 | £45.00 |
| Perceived customer value | £4.50 | £12.00 (retail of the mini) |
| Real cost to us | £4.50 (pure GP given up) | £2.40 (COGS) + £0 shipping (rides the parcel) |
| Perceived value per £1 of cost | £1.00 | **£5.00** |

Same retention nudge budget, five times the felt generosity — and a gift
introduces the customer to a second product (future attach/upsell), which a
percentage never does. Gifts also don't reprice the product in the customer's
head, so they don't erode willingness-to-pay the way stacked discounts do.

**When to still use a discount**: price-objection saves (`TOO_EXPENSIVE` cancel
reason — the customer literally asked for a lower price), win-back stage 2, and
anywhere the customer must see a smaller *number*. Everywhere else — surprise
retention moments, milestones, save-flow sweeteners for non-price reasons —
prefer the gift. Configure on the **Gifts** page (`GiftRule`: trigger by order
index, days subscribed, save flow or win-back; `unitCostCents` feeds the LTGP
math so analytics stay honest).

## 3. Per-SKU cadence = the real empty date

Arbitrary monthly billing is the silent churn machine: ship faster than the
customer empties the jar and you *manufacture* "too much product" cancels.
Since v1.8.0 a cadence can be expressed in **days, weeks or months** — and one
plan group can mix them — but the unit is presentation, not policy: pick every
cadence from the real days-to-empty, never from calendar tidiness. Default
cadence is **8 weeks** because that is the honest empty date of our hero SKUs.
"Every 1 month" is now expressible exactly (month cadences bill on the same
calendar day each month, clamped at month-end, instead of drifting like
4-weekly) — use it *only* for a product that genuinely empties in ~30 days,
not because the number looks tidy on a spreadsheet.

Fill this table per product and enter it on the cadence config
(`ProductCadence`; drives the recommended frequency, the buy-box default, and
win-back timing):

| Product | Size | Daily-use dose | Est. days to empty | Recommended cadence |
|---|---|---|---|---|
| (e.g. Renewal Serum) | 30 ml | 0.5 ml AM | ~60 | 8 weeks (or 2 months) |
| (e.g. Night Cream) | 50 ml | 1 g PM | ~50 | 7 weeks → offer 6 or 8 |
| (e.g. Ampoule kit) | 10 × 2 ml | 1 per day | ~10 | 10 days |
| (e.g. Cleanser) | 150 ml | 2× daily | ~75 | 10 weeks |
| … | | | | |

Rules of thumb: round the frequency **up** (slightly late beats slightly early —
a customer with a full shelf cancels; one who just ran out reorders); watch the
`FAST_SHIPPING_SKIPS` alert and the skip-ratio metric — a subscriber skipping
every other cycle is telling you their true cadence is 2× the current one; the
portal offers frequency change before they have to tell you twice.

## 4. Consolidation: one parcel = one churn decision (+ AOV)

Multi-product subscribers on separate contracts get separate charges, separate
parcels — and **separate cancel decisions**, each with its own "is this worth
it?" moment. Consolidation (`mergeGroupId`, auto-merge setting
`consolidation.autoMergeAlignedContracts`, window 3 days) aligns them into one
"routine box":

- One charge and one delivery → one churn decision per cycle instead of N.
- Higher AOV per parcel → shipping cost amortised, contribution margin per
  shipment up.
- The routine framing ("your Cellexia routine") is itself sticky — cancelling a
  *routine* is a bigger psychological step than cancelling one product.

Leave auto-merge on. When a customer adds a second product in the portal, the
app aligns it to the existing box by default.

## 5. The early-cycle churn cliff (orders 1–2) and the incentive schedule

Subscription survival curves cliff before cycle 3: the customer hasn't seen
results yet (skincare needs 6–12 weeks), the novelty is gone, and the second
charge is the first *unattended* one. Most LTGP is decided right here. Our
default schedule (settings key `lifecycle`, rules on the Gifts page):

| Moment | Lever | Why |
|---|---|---|
| Cycle 2 | **Unannounced** surprise gift in the box | Reciprocity exactly at the highest-risk charge; unannounced so it can't be gamed and reads as generosity, not payment |
| Cycles 1–2 | Early-cycle education nudges (usage, results timeline) | "Not seeing results" is a knowledge problem before it's a product problem |
| Cycle 6 | Milestone gift — **announced in advance** ("your 6th box comes with X") | A pre-announced reward creates a forward-looking reason to survive cycles 4–5 |
| Day 90 | "Rewards unlocked" perk | A retention milestone dressed as a perk |
| Day 365 | Anniversary gift | Celebrates the habit; feeds referral/word of mouth |

Principle: **spend the retention budget early and in COGS, not late and in
percent** (§2).

## 6. Save-offer ladder — ethics and the FTC click-to-cancel rule

<a name="save-ladder-ethics"></a>

The cancel flow (reason survey → reason-matched save → one final offer) exists
to solve the customer's actual problem, not to trap them:

- Too much product → offer **skip / slower frequency** (solves it exactly, costs
  nothing).
- Too expensive → smaller pack / **15% × 2 cycles** discount grant — with its
  own 90-day cooldown (`cancelFlow.reasonOfferCooldownDays`, v1.5.0) so the
  step-3 save can't be farmed by re-walking the flow each time a grant
  exhausts.
- Not seeing results → education + routine check, optional gift.
- The **final offer** (25% × 2 cycles) is strictly **opt-in** (v1.5.0): it
  renders only when the customer taps "See my final offer" on the saves or
  confirm page — it is never auto-inserted into the decline path — and it is
  shown at most **once per 180 days**, enforced against the event log, not
  just the current session. A repeatable or auto-pushed final offer trains
  cancel-threat behaviour and turns your best retention tool into a coupon
  dispenser.

Every behavior knob of the flow is a **setting**, not code: offer depths and
cooldowns, how many saves are shown (`cancelFlow.maxSavesShown`), the
frequency-delta and pause-length suggestions, session freshness — all on the
admin **Cancel flow** / **Settings** pages, so tuning the ladder never needs a
deploy.

**Compliance (FTC click-to-cancel / negative-option rule)**: cancellation must
be at least as easy as sign-up. Concretely in this app: cancel is reachable from
the portal home, **≤ 3 steps** (Cancel → reason → confirm), every save screen
has a clearly visible "No thanks, continue cancelling", **declining saves
completes the cancellation immediately** (nothing is auto-interjected), the
reason survey has a visible "I'd rather not say" bypass, nothing requires a
call or a chat, and the flow never loops. The "done" page offers a one-tap
**restart** — a cancelled customer who changes their mind is one tap from
coming back, with no discount spent. We comply by design — keep it that way:
any cancel-flow configuration you change must preserve the ≤3-step decline
path. The flow's honesty is also why it works: save rates *drop* when customers
smell a maze. Verify after any change with [TESTING.md §6](./TESTING.md#6-cancel-save-flows).

Every session is recorded (`CancelSession`: reason, saves shown, outcome,
90-day retention of saved customers) — review monthly: a save that doesn't hold
for 90 days is churn with extra steps and should be re-designed.

## 7. Target metrics

<a name="target-metrics"></a>

| Metric | Target | Definition (as computed on the Analytics tab) |
|---|---|---|
| PDP take rate | **40%+** | subscription checkouts that became contracts ÷ all checkouts of subscribable products (`takeRateNum/takeRateDen`, DailyRollup; renewal orders are excluded from the denominator since v1.4.0) |
| Save rate | **20–30%** | cancel sessions with outcome `SAVED` ÷ completed cancel sessions. Above ~40% usually means the flow is too pushy (check abandon rate); below 15% means saves don't match reasons |
| Dunning recovery | **55–70%** | failed-payment cases resolved `RECOVERED` or `CUSTOMER_FIXED` ÷ all cases resolved in the window |
| Skip:cancel ratio | **> 3:1** | skips ÷ cancellations in the window. Healthy subscribers *flex* instead of leaving; a falling ratio predicts a churn spike before it happens |
| Early survival | rising | % of cohort still active at cycle 3 |

**LTGP definitions.** Gross profit = revenue actually collected (net of
refunds) − COGS (incl. **gift** COGS) − merchant-side fulfillment &
shipping − payment fees. Discounts are *not* subtracted — collected amounts
are already net of them (the discount column is informational). LTGP per
subscriber = cumulative gross profit over the subscriber's life, **first
orders included** (v1.5.0): the first (checkout) payment is mirrored from
the origin order and booked in month 0 where captured — contracts still
awaiting the daily backfill, or with no origin order at all (imports),
contribute renewals only. The Analytics tab computes it from cohort cells
(`CohortCell`: one row per signup-month × month-offset; `cumGrossProfitCents`
is the running sum — the LTGP curve you see per cohort). COGS comes from
Shopify's "Cost per item" → your override on **Plans → Costs & margins** → a
percentage-of-price estimate (flagged); fees and per-parcel costs from
**Settings → Costs & profit**. Set real costs before trusting the numbers —
the page tells you when they are partly estimated. Judge *every* lever in this
document on cohort LTGP at months 3/6/12, never on one cycle's revenue.

## 8. A/B ideas backlog

Run one at a time; judge on take-rate × cycle-3 survival × LTGP, not clicks.

1. **Buy-box preselect on/off** (`preselectSubscription`) — preselect lifts take
   rate; verify it doesn't lift early involuntary churn (accidental subs).
2. **Badge copy** (`badgeText`): "Most popular" vs "Save 20%" vs "Best value".
3. **Savings format** (theme editor → buy-box block → `savings_format`):
   PERCENT vs ABSOLUTE vs BOTH —
   on low-priced SKUs percent reads bigger; on bundles absolute £ reads bigger.
4. **Gift vs extra % on first order** (`firstOrderGiftVariantId` vs deeper
   first-order discount) — the §2 math predicts gift wins on LTGP; prove it.
5. **Cycle-2 surprise gift on/off** by cohort — measure the cycle-2→3 survival
   delta against gift COGS.
6. **Final-offer depth** 20% vs 25% vs a gift-based final offer.
7. **Win-back discount stage timing** (offset from predicted empty date ±1 week).
8. **Reassurance copy** on/off ("Skip, pause or cancel anytime") — it usually
   *raises* take rate; confirm it doesn't raise early cancels.
9. **Channel quality, not just channel cost** (needs cohort age): every
   subscriber since v1.5.0 carries sanitized acquisition data — source, UTM,
   geo, device, first-order shape
   ([DATA_FOUNDATION.md](./DATA_FOUNDATION.md)). Once cohorts mature, judge
   acquisition channels on the LTGP of the subscribers they deliver, not on
   CAC alone — a cheap channel that churns at cycle 2 is expensive.

## 9. Choosing and testing a buy-box design

<a name="buy-box-design"></a>

The admin **Buy box designer** offers eight PDP presets. All share the same
selling-plan wiring and pricing truth (savings always computed from the real
selling-plan allocation); they differ only in persuasion architecture. "Risk"
below is risk to **overall PDP conversion**, not to take-rate — heavier
persuasion modules can lift take-rate while costing cold-traffic conversions.
(This table mirrors the metadata shown in the designer itself.)

| Preset | CRO rationale | Conversion risk |
|---|---|---|
| **classic** — Classic cards | The v1.0.0 stacked full-width option cards your current conversion rate was measured on. Both options get equal visual weight; the subscription card is accented and badged. Changing nothing is a valid CRO strategy — this is the baseline every other preset should be tested against. | minimal |
| **toggle** — Toggle tabs | One compact segmented pill ("One-time" \| "Subscribe & save {percent}") with a detail panel below. Reads like a native mobile pattern, adds almost no page height, and the savings percent is visible before any interaction. Detail shows only for the selected option — less comparison friction, but the side-by-side value story is hidden. Best for mobile-heavy traffic and long PDPs. | low |
| **tiles** — Comparison tiles | Two side-by-side tiles with explicit compare rows (per-delivery price, savings, flexibility) — the subscription's advantage is argued, not asserted. The strongest desktop pattern for considered purchases; tiles compress on small screens and the extra copy adds load for impulse buyers. | low |
| **inline** — Inline upgrade | One checkbox row under the price; the theme's buy box stays exactly as designed, so there is effectively nothing new to hurt conversion. The trade-off is symmetrical: minimal presentation does the least persuasion, so expect the smallest take-rate lift. The zero-conversion-risk option. | minimal |
| **value_stack** — Value stack | Headline price plus a check-mark benefit list (first-order discount, ongoing discount, milestone gift, cancel anytime), with one-time demoted to a quiet "or buy once for {amount}" text link. Highest expected take-rate on warm, high-consideration traffic — but demoting one-time is a real CVR risk on cold traffic that never intended to subscribe. Measure CVR, not just take-rate. | medium |
| **planner** — Routine planner | Frequency chips first (with a "Recommended" tag on the plan default) and per-delivery pricing — sells the cadence, not the discount, framing the subscription as a routine decision. Engaging for consumables with a well-understood usage rhythm, but the chips ask for a decision that can stall shoppers with no idea of their cadence. | medium |
| **subscription_max** — Subscription max (v1.6.0) | The subscription card *is* the buy box: one clear way to buy, zero decision fatigue. One-time stays real, priced and one tap away as a quiet underlined link below the card. Purely presentational — no extra perks or discounts implied. Highest take-rate posture; demoting one-time is a real CVR risk on cold traffic. See the dedicated section below. | medium |
| **subscription_ultra_max** — Subscription ultra max (v1.11.0) | Subscription max taken to its logical end: the card loses every piece of offer chrome — no border, no tint, no badge, no savings pill, no reassurance line by default — so the subscription price reads exactly like the product's price, not like a special plan being sold. The recurring cadence line stays visible (recurrence disclosure is never optional), and the priced one-time link stays one tap away — relocated below the entire buy area, where only a shopper actively looking for it will find it. Maximum posture means maximum accountability: watch PDP conversion AND refund/cancel quality, not just take-rate. See the dedicated section below. | medium |

**Recommended path.** Start with **classic** (your measured baseline) or
**toggle** (compact, low risk, mobile-native). If you will not risk a single
point of CVR while testing subscriptions, run **inline**. Save **value_stack**
and **subscription_max** for warm/retargeted traffic — email clicks, existing
customers, retargeting landers — not cold acquisition. **tiles** and
**planner** are situational: desktop-heavy traffic and cadence-obvious
consumables respectively.

### Subscription Max — the maximum take-rate posture

<a name="subscription-max"></a>

**What it is.** One calm, confident card that *is* the buy box: the
subscription price, a quiet "then {ongoing} every {frequency}" line, savings
shown quietly inline (no shouting badge — the badge is off by default in this
preset, re-enableable in Layout), and the reassurance line ("Skip, pause or
cancel anytime.") kept prominent — that line is the objection-killer that
protects conversion, don't remove it. There is no "choose your option"
framing: the heading defaults to empty (a Text-tab override still works), and
the frequency selector is hidden by default (plan default cadence applies;
re-enableable in Layout — subscribers change cadence any time in the portal).
Below the card, with generous whitespace, the one-time purchase is a single
muted underlined line — "or buy once for {amount}" — that quietly waits.
Tapping it selects one-time: the line swaps into a minimal selected state
(small check + "One-time purchase — {amount}" + a "Switch back to Subscribe &
Save" link), the cart request carries no selling plan, and the theme's
add-to-cart button price reverts. It is **purely visual**: it implies no
extra perks or discounts, and the underlying plan pricing is identical to
every other preset.

**Deliberately NOT subscription-only — and why the boundary matters.** The
one-time option stays real, selectable, priced *in the link before selection*,
and reachable in exactly **one** interaction; screen readers get the same
radio group as every other preset. Quiet ≠ hidden. That boundary is
non-negotiable for two reasons that reinforce each other. *Compliance*: a
widget that hides the one-time option (or its price) while preselecting a
recurring charge is the profile of a negative-option dark pattern — the FTC
rule and EU equivalents require consent to recurring billing to be
unambiguous, and the recurring terms + reassurance stay visible before
add-to-cart. *Conversion*: the shopper who came to buy once and can't find
how doesn't subscribe — they leave. The visible escape hatch is what lets
the confident single-card framing work on the shoppers who were persuadable
without burning the ones who weren't.

**When to use it.** Warm and retargeted traffic (email clicks, existing
customers, retargeting landers) and **markets with proven subscription
affinity** — where your Analytics already show a healthy take rate and the
question is "why is anyone still buying once?". It is the wrong opening move
on cold acquisition: like value_stack, demoting one-time is a real CVR risk
on traffic that never intended to subscribe.

**The measurement discipline — roll it out per market.** The per-market
selector (below) exists precisely so this preset can be tested without
betting the whole store:

1. Enable subscription_max in **one** market (Markets card in the designer),
   keeping your baseline preset as the default everywhere else. One change
   at a time, full traffic cycle — the §9 guardrail methodology applies
   unchanged.
2. Compare **take rate AND PDP conversion** for that market against your
   baseline: the designer's **performance card** breaks take-rate down by
   design (the `_cellexia_design` attribution names the *resolved* preset,
   so the market running subscription_max reports under its own key), and
   since v1.5.0 every new subscriber carries sanitized **acquisition
   data including country** ([DATA_FOUNDATION.md](./DATA_FOUNDATION.md) —
   on the subscriber page and as a Klaviyo profile property), so you can
   tie the subscribers the test window delivered back to the switched
   market. PDP conversion per market comes from Shopify analytics filtered
   to the market's domain.
3. A take-rate lift that costs more conversions than it earns in LTGP is a
   loss — judge on §7, cohort LTGP.
4. **Restore in one click**: clear the market's row back to "Default (use
   main design)" and publish — or restore the previous revision from
   history. No theme edit, storefront follows within minutes.

**How per-market selection works.** The designer's **Markets** card lists
every Shopify Market on the shop; each row's select picks a preset for that
market, defaulting to "Default (use main design)". **Only the preset varies
per market** — colors, text, layout and behavior are always inherited from
the main design (so subscription_max's quiet defaults — badge off, frequency
selector hidden — are *main-design layout knobs*: a market-only
subscription_max override inherits your main layout, and the widget still
suppresses badge + selector at render time unless you explicitly enabled
them). Markets without an entry, storefronts that don't report a market, and
entries pointing at deleted markets all fall back to the main preset — the
default inherits, it never breaks. The storefront resolves the market from
the domain the visitor shops on, so preview each market through its own
domain ([OPERATIONS.md §15](./OPERATIONS.md#15-runbook--buy-box-design)).

**Guardrail methodology** — how to change designs without hurting yourself:

1. **One change at a time.** A preset switch *is* a change; do not also touch
   preselect, badge copy or plan pricing in the same window, or you will not
   know which lever moved the numbers.
2. **Run a full traffic cycle** (1–2 weeks minimum, covering weekends and any
   scheduled email sends) before judging a design.
3. **Watch two numbers, not one**: PDP conversion rate (Shopify analytics)
   *and* subscription take rate — on the designer's **performance card**
   (take-rate by design, fed by the `_cellexia_design` attribution on every
   subscription add-to-cart) and the **Analytics** tab
   (`takeRateNum/takeRateDen`). A take-rate lift that costs more conversions
   than it earns in LTGP is a loss — judge per §7, on cohort LTGP.
4. **Instant rollback**: the designer's revision history restores any previous
   design in one click; the storefront follows within minutes, with no theme
   edit and no downtime in either direction.

**Hiding the frequency selector — a take-rate lever worth testing.** The
designer's **Show frequency selector** toggle (v1.2.0, Layout tab) removes
the frequency choice from every preset; add-to-carts then use each plan's
default cadence. The CRO logic: every decision at the point of conversion
costs completions, and "how often?" is the one question many first-time
buyers cannot answer — hiding it turns the buy box into a single yes/no
(subscribe or not) with your recommended cadence pre-decided. The usual cost
of removing choice is churn from a wrong cadence, but here the portal
preserves full flexibility — subscribers change frequency any time, and the
upcoming-order email arrives before every renewal — so the mismatch risk is
low. Test it like any design change (one lever, full traffic cycle, watch
CVR *and* take-rate); it pairs naturally with `toggle`/`inline`, and note it
neuters `planner` (whose whole pitch is the cadence choice — the preset
degrades to a recommended-cadence line).

**Preselection & ordering ethics.** The designer lets you combine
`preselect: subscription` with `one_time_first` ordering — meaning the
visually-first option is *not* the selected one. That combination reads as a
dark pattern and invites regulatory risk under the FTC negative-option rule
(and EU equivalents): consent to a recurring charge must be unambiguous. If
you preselect the subscription, keep it visually first, keep the full
recurring terms ("then X every Y weeks") and the reassurance line visible
before add-to-cart, and keep cancellation at ≤3 steps — see the cancel-flow
compliance note in [§6](#save-ladder-ethics).

### Subscription Ultra Max — the plain-buy-box posture

<a name="subscription-ultra-max"></a>

**What it is.** Subscription Max taken to its logical end (v1.11.0): the
card loses every piece of offer chrome — no border, no tint, no badge, no
savings pill, no reassurance line by default (each re-enableable in the
designer) — so the subscription price reads exactly like the product's
price, not like a special plan being sold. The recurring "then {price}
every {frequency}" line always stays: recurrence disclosure is never
optional. The one-time option stays real, **priced in the link before
selection** and reachable in one tap — relocated below the entire buy area
(quantity, add to cart, guarantees), where only a shopper actively looking
for it will find it. That is the compliance boundary holding: quiet ≠
hidden, exactly as in Subscription Max.

**When to use it.** Warm traffic on a hero product where subscription *is*
the intended default and one-time is the exception — typically a market
where Subscription Max already performs. It is never an opening move on
cold acquisition.

**The accountability warning.** Maximum posture means maximum
accountability: watch PDP conversion **and refund/cancel quality**, not
just take-rate — shoppers who did not understand they subscribed are
expensive (refunds, cycle-1 cancels, support load, trust). Roll it out per
market with the Subscription Max methodology above, and judge per §7 on
cohort LTGP.

## 10. Reading your analytics — the weekly review

<a name="reading-your-analytics"></a>

Fifteen minutes, once a week, same order every time. Everything below is on
the **Analytics** page (mechanics of each number:
[OPERATIONS.md §19](./OPERATIONS.md#19-analytics)).

**0. Preconditions — make the numbers real first.**

- The **"LTGP is partly estimated"** banner (Cohorts & LTGP tab) must be gone.
  If it names products, set their cost on **Plans → Costs & margins** (or
  "Cost per item" in Shopify) — until then gross profit is partly a
  percentage guess, honestly flagged but still a guess.
- **Settings → Costs & profit** holds your *real* payment-fee rate and
  per-parcel fulfillment + carrier costs. Free shipping + "same as charged"
  mode = zero shipping cost = inflated LTGP; use flat.

**1. The insight cards** (dashboard, "This week"). Each card states its
evidence and links to the lever. An empty list is good news — the rules stay
silent unless something crossed a threshold with enough data behind it.

**2. The funnel, against the §7 targets** (Overview tab, last-30-days):

| Check | Good looks like | If not |
|---|---|---|
| Take rate | ≥40%, stable or rising | Buy-box design/copy (§9), first-order offer (§1) |
| Dunning recovery | inside 55–70% | Below: dunning ladder + card-update emails. Far above 70%: fine, enjoy it |
| Save rate | inside 20–30% | Below 15%: saves don't match reasons (§6). Above ~40%: you are buying saves with margin — check offer depth |
| Skip:cancel | >3:1 | Falling toward 1:1 predicts churn: cadence too fast (§3) |
| Add-ons per charge | trending up | Portal add-on merchandising; not a weekly alarm |

**3. Cohorts & LTGP** — the scoreboard that actually matters:

- **Retention measure, read down the M1–M3 columns**: is each newer cohort at
  least matching the older ones at the same age? A newer cohort reading
  worse at M1/M2 is the earliest sign a change (price, design, traffic mix)
  hurt quality.
- **LTGP per subscriber at M3/M6** vs what you pay to acquire a subscriber.
  First orders are included where captured (v1.5.0), so this is close to
  true payback — only contracts still awaiting the origin-payment backfill
  (or imports with no origin order) read low by roughly one first order.
  If you tracked these numbers before v1.5.0: **month-0 cells jumped at the
  upgrade**. Same subscribers, same money — the first payment is finally
  being counted. Re-baseline your payback targets once, don't celebrate a
  growth spurt.
- Young cohorts show "—" at horizons they haven't aged past; that is the
  aging gate, not missing data.

**4. Survival & churn** (once enough subscribers have decided): where is the
steepest drop? The page names the order number — aim gifts, education and
save offers at that renewal (§5). Check the churn split: if involuntary
(failed payments) is a growing share, the fix is dunning, not offers. The
**risk chip** on the Overview tab tells you which scorer ranks the at-risk
list — "Heuristic" until the learned model has proven itself on your own
churn history, then "Learned model" with its accuracy and sample count.
Either way the list is ordered worst-first; there is nothing to configure
(see [OPERATIONS.md §19](./OPERATIONS.md#19-analytics)).

**5. Forecast** — read the **grade chip first**, then the number. A/B: plan
against the band. C: direction only. D: ignore the number, fix the reason
listed in "How much to trust this" (usually: not enough history yet — it
firms up around week 6). Model choice stays on **Auto** — since v1.5.0 every
week's per-model error is recorded and Auto weighs recent recorded weeks,
so its pick keeps getting better calibrated to your store on its own; the
backtest table shows why Auto picked what it picked. Overriding it manually
throws that accumulated evidence away.

Judge levers on **cohort LTGP at M3/M6/M12** (§7) — the weekly funnel numbers
are the steering wheel, not the destination.
