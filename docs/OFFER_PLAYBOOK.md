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
Default cadence is **8 weeks** because that is the honest empty date of our
hero SKUs — not because a calendar month is tidy.

Fill this table per product and enter it on the cadence config
(`ProductCadence`; drives the recommended frequency, the buy-box default, and
win-back timing):

| Product | Size | Daily-use dose | Est. days to empty | Recommended weeks |
|---|---|---|---|---|
| (e.g. Renewal Serum) | 30 ml | 0.5 ml AM | ~60 | 8 |
| (e.g. Night Cream) | 50 ml | 1 g PM | ~50 | 7 → offer 6 or 8 |
| (e.g. Cleanser) | 150 ml | 2× daily | ~75 | 10 |
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
- Too expensive → smaller pack / **15% × 2 cycles** discount grant.
- Not seeing results → education + routine check, optional gift.
- Final chance, only after everything is declined: **25% × 2 cycles**, once per
  180 days (cooldown enforced — a repeatable final offer trains cancel-threat
  behaviour and turns your best retention tool into a coupon dispenser).

**Compliance (FTC click-to-cancel / negative-option rule)**: cancellation must
be at least as easy as sign-up. Concretely in this app: cancel is reachable from
the portal home, **≤ 3 steps** (Cancel → reason → confirm), every save screen
has a clearly visible "No thanks, continue cancelling", nothing requires a call
or a chat, and the flow never loops. We comply by design — keep it that way:
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
| PDP take rate | **40%+** | subscription checkouts ÷ all checkouts of subscribable products (`takeRateNum/takeRateDen`, DailyRollup) |
| Save rate | **20–30%** | cancel sessions with outcome `SAVED` ÷ completed cancel sessions. Above ~40% usually means the flow is too pushy (check abandon rate); below 15% means saves don't match reasons |
| Dunning recovery | **55–70%** | recovered cases ÷ opened cases (money-weighted view: `recoveredCents` ÷ failed cents) |
| Skip:cancel ratio | **> 3:1** | skips ÷ voluntary cancels per period. Healthy subscribers *flex* instead of leaving; a falling ratio predicts a churn spike before it happens |
| Early survival | rising | % of cohort still active at cycle 3 |

**LTGP definitions.** Gross profit = revenue − discounts − COGS (incl. **gift**
COGS) − shipping cost − payment fees. LTGP per subscriber = cumulative gross
profit over the subscriber's life. The Analytics tab computes it from cohort
cells (`CohortCell`: one row per signup-month × month-offset;
`cumGrossProfitCents` is the running sum — the LTGP curve you see per cohort).
Judge *every* lever in this document on cohort LTGP at months 3/6/12, never on
one cycle's revenue.

## 8. A/B ideas backlog

Run one at a time; judge on take-rate × cycle-3 survival × LTGP, not clicks.

1. **Buy-box preselect on/off** (`preselectSubscription`) — preselect lifts take
   rate; verify it doesn't lift early involuntary churn (accidental subs).
2. **Badge copy** (`badgeText`): "Most popular" vs "Save 20%" vs "Best value".
3. **Savings format** (`buyBox.savingsFormat`): PERCENT vs ABSOLUTE vs BOTH —
   on low-priced SKUs percent reads bigger; on bundles absolute £ reads bigger.
4. **Gift vs extra % on first order** (`firstOrderGiftVariantId` vs deeper
   first-order discount) — the §2 math predicts gift wins on LTGP; prove it.
5. **Cycle-2 surprise gift on/off** by cohort — measure the cycle-2→3 survival
   delta against gift COGS.
6. **Final-offer depth** 20% vs 25% vs a gift-based final offer.
7. **Win-back discount stage timing** (offset from predicted empty date ±1 week).
8. **Reassurance copy** on/off ("Skip, pause or cancel anytime") — it usually
   *raises* take rate; confirm it doesn't raise early cancels.

## 9. Choosing and testing a buy-box design

<a name="buy-box-design"></a>

The admin **Buy box designer** offers six PDP presets. All share the same
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

**Recommended path.** Start with **classic** (your measured baseline) or
**toggle** (compact, low risk, mobile-native). If you will not risk a single
point of CVR while testing subscriptions, run **inline**. Save **value_stack**
for warm/retargeted traffic — email clicks, existing customers, retargeting
landers — not cold acquisition. **tiles** and **planner** are situational:
desktop-heavy traffic and cadence-obvious consumables respectively.

**Guardrail methodology** — how to change designs without hurting yourself:

1. **One change at a time.** A preset switch *is* a change; do not also touch
   preselect, badge copy or plan pricing in the same window, or you will not
   know which lever moved the numbers.
2. **Run a full traffic cycle** (1–2 weeks minimum, covering weekends and any
   scheduled email sends) before judging a design.
3. **Watch two numbers, not one**: PDP conversion rate (Shopify analytics)
   *and* subscription take rate — on the designer's **performance card**
   (take-rate by design, fed by the `_cx_design` attribution on every
   subscription add-to-cart) and the **Analytics** tab
   (`takeRateNum/takeRateDen`). A take-rate lift that costs more conversions
   than it earns in LTGP is a loss — judge per §7, on cohort LTGP.
4. **Instant rollback**: the designer's revision history restores any previous
   design in one click; the storefront follows within minutes, with no theme
   edit and no downtime in either direction.

**Preselection & ordering ethics.** The designer lets you combine
`preselect: subscription` with `one_time_first` ordering — meaning the
visually-first option is *not* the selected one. That combination reads as a
dark pattern and invites regulatory risk under the FTC negative-option rule
(and EU equivalents): consent to a recurring charge must be unambiguous. If
you preselect the subscription, keep it visually first, keep the full
recurring terms ("then X every Y weeks") and the reassurance line visible
before add-to-cart, and keep cancellation at ≤3 steps — see the cancel-flow
compliance note in [§6](#save-ladder-ethics).
